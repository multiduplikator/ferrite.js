// Audio SAB ring-buffer protocol — the lock-free single-producer/single-consumer ring between the audio
// PCM PRODUCER (the decode worker, engine-decoded interleaved-stereo PCM) and the persistent
// AudioWorkletProcessor (consumer: pulls one render quantum per process() call and drives the played-frames
// master clock). This is the TypeScript twin of the reference player's audio ring — PURE index/position math,
// headless-testable, and the single source of truth BOTH the producer AND the JS worklet obey, so they can
// never drift on capacity, wrap, or the clock formula. It replaces the per-chunk AudioBufferSourceNode
// scheduling + segQ/publishClock re-anchor path (the source of the reservoir oscillation + the live freeze).
//
// ## Layout (one SharedArrayBuffer)
// `[ control: RING_CTRL_SLOTS × i32 (Atomics) ][ data: cap × RING_CHANNELS × f32 ]`
// The data region is interleaved stereo (L,R,L,R…). Cursors are monotonic FRAME counts (per-channel); the
// buffer position is `cursor mod cap`. SPSC: only the producer writes RW_WRITE/RW_BASE_MS/edge slots, only
// the worklet writes RW_READ/RW_UNDERRUNS — so plain Atomics loads/stores suffice (no CAS).
//
// ## Master clock — clock HOLDS on underrun, resumes on refill (mpv)
// RW_READ advances ONLY by the real PCM frames actually played. On a shortfall quantum the worklet emits
// silence for the remainder but advances RW_READ by `copy` (the REAL frames only), LATCHES an underrun, and
// HOLDS the read cursor — and thus the clock derived from it — at the last real played PTS until the ring
// refills past a high-water (UNDERRUN_RESUME_SECS). This mirrors mpv: `written_audio_pts − ao_get_delay`
// pins as `ao_get_delay → 0` (real buffered samples only; silence is never counted), and the AO resumes
// only on `mp_async_queue_is_full`, never on the first refilled sample. The decision logic is `underrunStep`
// here (headless-tested) and faithfully re-implemented in the worklet JS. The clock STOPS through a gap — it
// does NOT race ahead through silence (a wall-clock free-run would let the clock sail past slow-arriving
// frames); the present worker's clamped PLL then gently holds video at the held position.

/** Engine audio output is stereo (downmix). Interleaved L,R. */
export const RING_CHANNELS = 2;

// Control-region slot indices (Int32 atomics).
export const RW_WRITE = 0;      // PRODUCER: monotonic frames written (producer cursor)
export const RW_READ = 1;       // WORKLET: monotonic frames consumed (= played frames; the clock)
export const RW_UNDERRUNS = 2;  // WORKLET: render quanta that found the ring empty
export const RW_BASE_MS = 3;    // PRODUCER: media base (first chunk PTS, ms) — clock anchor
export const RW_PLAYING = 4;    // MAIN: 1 = worklet should output; 0 = emit silence + hold the cursor
export const RW_RATE = 5;       // MAIN: output sample rate (Hz) — clock denominator, set at init
export const RW_GEN = 6;        // MAIN/PRODUCER: load generation — worklet drops a stale producer epoch
export const RW_OVERWRITES = 7; // PRODUCER: writes that lapped an unread consumer (producer overrun)
// media-PTS clock: the producer publishes the engine's real media PTS at a ring write boundary so the worklet
// drives the master clock from MEDIA time (not wall frame-count read/rate). This keeps lip-sync correct as
// the ring drains.
export const RW_EDGE_FRAME = 8;   // PRODUCER: a write-cursor boundary (frames) the published edge PTS belongs to
export const RW_EDGE_PTS_MS = 9;  // PRODUCER: media PTS (ms) at RW_EDGE_FRAME (the engine's frame→pts)
// SEQLOCK over the clock-anchor tuple {RW_BASE_MS, RW_EDGE_FRAME, RW_EDGE_PTS_MS}: the worklet reads those 3
// slots as independent loads while the producer stores them independently — a reader interleaving a
// mid-publish could compose a torn tuple (new edge + stale base at a disc/reset rebase → a spiked clock at
// the very seam the rebase exists to smooth). The producer bumps this seq to ODD before the group and EVEN
// after; readers retry while it's odd or moved. Single producer → plain load/store on the writer side.
export const RW_EPOCH_SEQ = 10;
export const RING_CTRL_SLOTS = 11;

/** Ring capacity in FRAMES (per channel) for `seconds` of headroom at `sampleRate`. A deeper ring (≈0.5–1 s)
 *  rides through live ingest hiccups the old drop-capped reservoir could not. */
export function ringFramesFor(seconds: number, sampleRate: number): number {
  return Math.max(1, Math.ceil(seconds * sampleRate));
}

/** Total bytes for the SAB: control region + interleaved f32 data. (i32 and f32 are both 4 bytes.) */
export function ringSabBytes(capFrames: number): number {
  return (RING_CTRL_SLOTS + capFrames * RING_CHANNELS) * 4;
}

/** Frames available to READ (consumer): `write - read`, never negative. */
export function readable(write: number, read: number): number {
  return Math.max(0, write - read);
}

/** Free FRAMES the producer may write without lapping the consumer: `cap - (write - read)`. */
export function writable(write: number, read: number, cap: number): number {
  return Math.max(0, cap - readable(write, read));
}

/** Buffer (modulo) frame position for a monotonic cursor. Cursors are non-negative by construction. */
export function pos(cursor: number, cap: number): number {
  return ((cursor % cap) + cap) % cap;
}

/** Played-frames → media time in ms: `baseMs + readFrames / rate · 1000`. WALL-elapsed playout (each output
 *  frame = 1/rate s). Superseded by `mediaClockMs` for the master clock — kept for tests / reference. */
export function playedMs(baseMs: number, readFrames: number, sampleRate: number): number {
  if (sampleRate === 0) return baseMs;
  return baseMs + readFrames * 1000 / sampleRate;
}

/** media-PTS master clock (ms): `baseMs + edgePtsMs − (edgeFrame − read)/rate·1000`. Anchored to the
 *  engine's real media PTS at the ring write edge, so the heard audio's media position is reconstructed by
 *  walking back the `edgeFrame − read` output frames between the edge and the read cursor. Advances at MEDIA
 *  rate as the buffered audio plays out (keeps video lip-synced). With the underrun-HOLD (`underrunStep`) the
 *  read cursor advances ONLY by the real frames played, so on a shortfall it never passes the buffered write
 *  edge — the clock HOLDS at the last real position through a gap (mpv's `ao_get_delay→0` pin) instead of
 *  extrapolating forward. */
export function mediaClockMs(
  baseMs: number, edgePtsMs: number, edgeFrame: number, readFrames: number, sampleRate: number,
): number {
  if (sampleRate === 0) return baseMs + edgePtsMs;
  return baseMs + edgePtsMs - (edgeFrame - readFrames) * 1000 / sampleRate;
}

/** How many frames a render quantum of `quantum` should copy, given what's readable, and whether this
 *  quantum underran (ring empty → emit silence for the remainder, count one underrun). NOTE: superseded for
 *  the consumer path by `underrunStep` (which adds the HOLD state machine); kept as the stateless `!held`
 *  copy/underran helper + asserted equivalent in tests. */
export function quantumPlan(readableFrames: number, quantum: number): { copy: number; underran: boolean } {
  const copy = Math.min(Math.max(readableFrames, 0), quantum);
  return { copy, underran: copy < quantum };
}

/** Worklet underrun HIGH-WATER: refill the PCM ring to this much DECODED audio before resuming output after
 *  an underrun (mpv's `mp_async_queue_is_full` resume). Set BELOW the producer's steady-state fill ceiling
 *  (`pcmHasRoom` stops at cap − ~0.125 s ≈ 0.375 s at the 0.5 s cap) so the refill is always REACHABLE with a
 *  clear hysteresis margin — resuming exactly at the ceiling would have zero margin. */
export const UNDERRUN_RESUME_SECS = 0.30;

/** The high-water in FRAMES for `sampleRate` (= `ringFramesFor(UNDERRUN_RESUME_SECS, rate)`). */
export function underrunResumeFrames(sampleRate: number): number {
  return ringFramesFor(UNDERRUN_RESUME_SECS, sampleRate);
}

/** STARTUP PREFILL target (mpv STATUS_READY = the AO buffer filled to `audio_buffer`, mpv default 0.2 s).
 *  The audioStartAo gate withholds output until the decoded PCM ring has filled to this much, so audio starts
 *  with a cushion instead of a thin silence-then-first-chunk start that would immediately trip the
 *  underrun-HOLD. ≤ UNDERRUN_RESUME_SECS and well under the ~0.375 s producer fill ceiling, so it is promptly
 *  reachable at startup (video plays meanwhile — the gate withholds only audio). */
export const AUDIO_PREFILL_SECS = 0.20;

/** One render-quantum decision for the worklet consumer (the underrun HOLD state machine). `held` is the
 *  worklet's carried "in an underrun hold" flag. Returns what to play and how far to advance RW_READ:
 *  - `copy`     — real PCM frames to copy into the output (silence-fill `quantum − copy`).
 *  - `advance`  — frames to add to RW_READ. CRUCIAL: this is `copy` (real frames ONLY), never the full
 *    `quantum`, so the read-derived clock HOLDS at the last real PTS through the silence (mpv's pin) instead
 *    of racing forward through the gap. `0` while held below the high-water (clock frozen).
 *  - `nowHeld`  — the carried flag for next quantum.
 *  - `underran` — count ONE underrun this quantum (per-EPISODE: true only on the latching edge, not every
 *    held quantum), for telemetry.
 *
 *  Contract (mirrors mpv): a shortfall LATCHES the hold + advances by real frames only; while held the clock
 *  is pinned (advance 0) until `readable >= resumeFrames`, then output resumes. The worklet MUST clear `held`
 *  on a fresh epoch (RW_GEN change) / pause→play edge so a stale hold can't suppress the first quantum. */
export interface UnderrunStep {
  copy: number;
  advance: number;
  nowHeld: boolean;
  underran: boolean;
}

export function underrunStep(
  readableFrames: number,
  quantum: number,
  held: boolean,
  resumeFrames: number,
): UnderrunStep {
  if (held) {
    // HELD: pin the read cursor (clock frozen) until the ring refills past the high-water; then resume.
    if (readableFrames >= resumeFrames) {
      const copy = Math.min(Math.max(readableFrames, 0), quantum);
      return { copy, advance: copy, nowHeld: false, underran: false };
    } else {
      return {
        copy: 0,
        advance: 0, // clock pinned
        nowHeld: true,
        underran: false, // already counted on the latching edge — no per-quantum double-count
      };
    }
  } else {
    const copy = Math.min(Math.max(readableFrames, 0), quantum);
    const shortfall = copy < quantum;
    return {
      copy,
      advance: copy, // real frames only — silence does NOT advance the clock (the mpv pin)
      nowHeld: shortfall, // latch the hold on a shortfall
      underran: shortfall,
    };
  }
}
