// Present worker (split-realm present).
//
// Owns the transferred OffscreenCanvas + WebGL2 (GlRenderer) + the rAF present loop + the frame ring +
// eviction + the present clock. Decoded VIDEO frames arrive straight from the DECODE worker over a
// MessageChannel (bypassing main); software heap slots are released back by token over the same channel. The
// AUDIO master clock lives on MAIN (AudioContext) and is published into a SharedArrayBuffer that this
// worker reads via Atomics — the ONLY cross-realm coupling, and the reason the SAB exists (present and
// audio are no longer colocated, so a direct AudioContext.currentTime read isn't possible here).
//
// This is the ~2× win the rung targets: the decode→present handoff, the WebGL draw, the rAF present
// loop, and the present clock no longer fight the main thread (audio + UI). The clock/eviction/seam
// logic drives the tier-agnostic ring (software YUV planes AND a WebCodecs VideoFrame share
// the same ring/clock — only how a retired frame is RELEASED differs).

import { GlRenderer } from '../render/gl';
import { C_ACLOCK, C_AUDIO } from '../protocol';
import type { DecodeToPresent, MainToPresent, PresentToMain } from '../protocol';
import {
  cadenceStats, cadenceSelfCheck, median, nextHold, isStaleLoadGen, CADENCE_WINDOW_MS, DEFAULT_CONTENT_FPS,
  capAdvance, CADENCE_TIER_FULL, CADENCE_TIER_HALF, DEGRADE_REASON_NONE,
  DEGRADE_REASON_UNDER_DELIVERY, DEGRADE_REASON_MANUAL, DEGRADE_RING_TREND_MS,
  ladderStep, demuxRingPressure,
  RUNG_NONE, RUNG_L2, RUNG_L2_L3, RUNG_L2_L3_L1,
  type CadenceSample, type LadderState,
} from './present-cadence';
import { VsyncEstimator } from './vsync-estimator';

// Worker rAF is available in Chromium ONLY for a transferred on-screen OffscreenCanvas, and the
// WebWorker lib doesn't type it — bind off the global.
const g = self as unknown as {
  requestAnimationFrame: (cb: (ts: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  postMessage: (m: PresentToMain, transfer?: Transferable[]) => void;
};
const post = (m: PresentToMain, transfer: Transferable[] = []): void => g.postMessage(m, transfer);

// Seam detection (mirrors the adjacency-keyed detector): a large PTS step between adjacent ring frames
// is a failover/splice seam → re-anchor the clock instead of waiting/dumping.
const SEAM_BACK_US = 500_000;   // PTS backward jump > 0.5s ⇒ discontinuity
const SEAM_FWD_US = 3_000_000;  // PTS forward jump  > 3s   ⇒ discontinuity
const NO_AUDIO_GRACE_TICKS = 60; // ~1s holding the first frame for audio before video-only free-run
// SYNC GUARD (VLC-style hard-resync, dec.c ±3× band analogue): once the Bresenham cadence is driving
// presentation, the audio master no longer picks frames — so a slow drift between the cadence and the
// audio clock can accumulate. If the front frame falls more than this BEHIND media_now (the cadence has
// desynced LATE from audio), skip the ring forward to the frame nearest media_now and re-anchor the
// cadence. 120 ms ≈ 6 frames @ 50fps — far above normal ±½-vsync cadence jitter, so on a clean clip it
// never fires (no thrash); it only bounds a genuine A/V divergence (full audio-bending is deferred).
const SYNC_GUARD_US = 120_000;
// SYNC-GUARD HYSTERESIS (the thrash fix). A throughput-limited client (decode < content rate) leaves the
// front STEADILY behind the audio clock — without hysteresis the guard hard-resyncs every tick (~35×/s),
// dropping frames it shouldn't and making throughput WORSE in a feedback loop. So the behind-resync now
// fires ONLY for a GENUINE discontinuity: the desync must be (a) SUSTAINED for several ticks (not a single-
// tick excursion), (b) outside a post-resync COOLDOWN, and (c) NOT during measured under-delivery (that is
// throughput-behind → handled by the graceful-degradation tier + drop-oldest, NEVER by churning the guard).
const SYNC_SUSTAIN_TICKS = 4;   // the front must be > guard behind for this many consecutive ticks before a resync
const SYNC_COOLDOWN_MS = 1000;  // after a hard-resync, suppress further resyncs for ≥1 s (VLC resyncs rarely, not 35×/s)
// LADDER: the GRADUATED, AXIS-SEPARATED degrade ladder REPLACES the atomic present-cap+skip-non-ref+skip-loop
// latch. The present-cap and the decode skips are independent axes: the
// ladder climbs rung0→1(skip-non-ref)→2(+skip-loop)→3(+present-cap) one step per settle window while a PRESENT-SIDE detector reads the
// stream as decode-bound, and de-escalates in strict reverse (present-cap→skip-loop→skip-non-ref) on sustained headroom. rung2→3 is
// gated on contentFps ≥ LADDER_L1_MIN_FPS so a low-fps stream (4K25) tops out at skip-non-ref+skip-loop and NEVER suffers the
// nonsense 25→12.5 halving. The detector measures present against the EFFECTIVE target (contentFps ÷
// decimation, decimation=2 once the present-cap is on) so it settles + de-escalates correctly at the top rung. A CAPABLE
// stream keeps up (present at target, media/wall ≥1.0, ring drained) → stays at rung0; a present-side stall
// (ring pinned full) can never trip it (no-drop back-pressure ≠ a decode deficit). Per-timeline (re-armed on
// reset). The manual Lever-1 override (setManualHalf) is unaffected. AUTO_DEGRADE gates the whole ladder.
const AUTO_DEGRADE: boolean = true;
const TIME_POST_MS = 120;       // throttle the currentTime → main posts
const PSTATS_POST_MS = 250;     // pstats post cadence — each post now reports the TRUE trailing-1s cadence
                                // window (CADENCE_WINDOW_MS), so the ~1Hz bus always reads a full-1s metric.

/** Lock the media clock to the audio epoch on the FIRST audible sample, preserving continuity (port of
 *  caps.rs::audio_lock_clock). If the video-only wall fallback already ran the clock PAST the audio
 *  epoch (late audio), keep it and re-base the anchor so the audio elapsed continues forward — no
 *  ~1s backward snap; otherwise snap forward to the audio epoch with the anchor unchanged. */
function audioLockClock(mediaUs: number, ptsAnchorUs: number, rawUs: number): [number, number] {
  const target = ptsAnchorUs + rawUs;
  if (mediaUs > target) return [mediaUs, mediaUs - rawUs]; // late audio → continuity re-base
  return [target, ptsAnchorUs];                            // normal start → snap forward
}

// A ring frame — a tagged union so BOTH decode tiers share the ring/eviction/seam/clock. Only the
// per-frame payload + how it is RELEASED differ: a software 'yuv' frame names a HELD decoder frame
// (token) whose Y|U|V planes live at heap offsets `ptrs` (native byte strides `lns`, bit depth `bitDepth`)
// in the engine's shared heap — released back to the decode worker by token (which unrefs the held frame
// + grants a credit); a 'vf' frame's VideoFrame is CLOSED (frees the HW output pool). The yuv frame
// is TRUE ZERO-COPY — the GL upload reads the native-stride/native-bit-depth planes straight from the heap.
type RingFrame =
  | { kind: 'yuv'; ptsUs: number; w: number; h: number; cw: number; ch: number; bitDepth: number; colorspace: number; colorRange: number; colorTrc: number; token: number; ptrs: [number, number, number]; lns: [number, number, number] }
  | { kind: 'vf'; ptsUs: number; frame: VideoFrame };

class Presenter {
  private renderer: GlRenderer;
  private port: MessagePort;       // back to the decode worker (release evicted heap slots by token)
  private clock: Int32Array;       // control header of the clock SAB → the audio master clock (read-only)
  private wcRingCap: number;
  private swRingCap: number;

  private ring: RingFrame[] = [];
  // The engine's growable shared heap (forwarded by the decode worker after the engine loads).
  // Software 'yuv' planes are read STRAIGHT from `engineMemory.buffer` at GL-upload time — re-viewed
  // FRESH per upload, since a pthread heap grow REPLACES the buffer (the liveHeap rule). Null until the
  // `engineMemory` message lands (always before the first `frame`).
  private engineMemory: WebAssembly.Memory | null = null;
  private rafId = 0;
  private paused = false;
  private gen = 0;                 // current load gen (filters a stale dropVideoFrames)
  private destroyed = false;

  // ---- present clock (faithful port of WorkerPresenter::tick) ----
  private lastTs = 0;
  private lastDrawnPts = -1;
  private anchored = false;        // the media clock has captured its first-frame PTS anchor
  private mediaAnchorPtsUs = 0;    // pts_anchor_us — first presented frame's PTS (relative epoch)
  private mediaUs = 0;             // smoothed media clock (µs): rAF-advanced, PLL-locked to the audio sample
  private audioLocked = false;     // the media clock has been INITIALISED from the audio epoch
  private audioDriving = false;    // this tick the media clock came from the AUDIO master (not wall/grace)
  private graceTicks = 0;          // ticks holding the first frame for audio (startup/resume)

  // ---- mpv-style DISPLAY CADENCE (Bresenham num_vsyncs; replaces "retire all frames whose ptsUs ≤ now"
  //      once the display refresh is measured-stable) — the 50-on-75 anti-judder core (mpv video.c:835-843).
  //      We MEASURE the real refresh from rAF (vsync), then HOLD each front frame an integer number of
  //      vsyncs, carrying the fractional remainder forward so 50-on-75 emits a deterministic 1,2,1,2
  //      cadence with zero long-term drift — robust to the audio-clock jitter that tipped the old
  //      retire-by-pts logic across the 1.5-vsync boundary. The accumulator is pure float arithmetic. ----
  private vsync = new VsyncEstimator(); // measures the display refresh interval from rAF dt
  private cadenceActive = false;        // the Bresenham cadence is driving (only once vsync is adopted)
  private cadenceErrorMs = 0;           // sigma-delta fractional-vsync accumulator (mpv display_sync_error)
  private holdRemaining = 0;            // vsyncs left to hold the current front before advancing
  private cadenceHolds: number[] = [];  // recent hold counts (telemetry: the 1,2 pattern); cap 64
  private syncResyncs = 0;              // cumulative SYNC GUARD hard-resyncs (cadence desynced from audio)
  private syncBehindTicks = 0;          // consecutive ticks the front has been > SYNC_GUARD_US behind audio (hysteresis)
  private lastResyncTs = 0;             // wall ts (ms) of the last hard-resync (cooldown anchor; 0 = none yet)
  private vsTick = { intervalMs: 0, adopted: false, hz: 0, jitter: 0 }; // vsync snapshot cached once/tick
  // ---- graceful-degradation LADDER (graduated, axis-separated — replaces the atomic present-cap+skip-non-ref+skip-loop latch) -------
  // A PRESENT-SIDE decode-bound detector climbs a rung ∈ {0,1,2,3} (0 none · 1 skip-non-ref · 2 +skip-loop · 3 +present-cap)
  // one step per settle window, and de-escalates in strict reverse on sustained headroom (ladderStep, PURE).
  // `cadenceTier` is DERIVED from the rung: the present-cap (tier 2) engages only at the top rung
  // (rung 3), else tier 1 (full draw rate). The decode skips are fanned out to the decode worker as the rung crosses
  // their boundaries. NEVER degrades a capable stream; per-timeline (re-armed only on reset()).
  private degradeRung = RUNG_NONE;      // the current ladder rung (0..3) — the AUTHORITATIVE auto-degrade state
  private ladderClimbMs = 0;            // accumulated wall-ms of CONTINUOUS decode-bound under-delivery (resets on any non-under window)
  private ladderDropMs = 0;             // accumulated wall-ms of CONTINUOUS headroom (resets on any non-headroom window) — slow de-escalation
  private cadenceTier = CADENCE_TIER_FULL; // DERIVED: 2 (present every other frame) iff rung ≥ 3, else 1 — drives capAdvance (present-cap)
  // present-cap MANUAL override: forces the present-rate cap (tier 2) independent of the
  // ladder. Manual-on ⇒ the cap is active regardless of the rung; manual-off ⇒ the rung's derived tier.
  // Both drive the SAME cap mechanism (capAdvance); activeTier() folds them so one code path presents.
  private manualHalf = false;
  private cadenceDegradeReason = DEGRADE_REASON_NONE; // why we degraded (telemetry; 0 = not degraded)
  // The TRUE content frame period (µs) sent by the DECODE worker from demux PACKET PTS — non-ref-skip
  // INDEPENDENT (a non-ref-skipping decoder outputs fewer frames, but the packet cadence is unchanged), so
  // the cap target stays content×tier and the present-cap + non-ref-skip never decimate twice. 0 until the first frame; the cadence
  // falls back to the present-side arrival-median (contentDurMs) when it is unset (WC tier / pre-warmup).
  private decodeContentPeriodUs = 0;
  private degradeSkips = 0;             // cumulative frames INTENTIONALLY skipped (decimated) by the degraded tier
  private ringLowWater = Infinity;      // min ring.length observed since the last pstats post (draining signal)
  private underDelivering = false;      // live (per-post) under-delivery signal — also suppresses the behind-resync
  private lastPushPtsUs = -1;           // last decoded-frame PTS pushed (content-period estimator, decimation-independent)
  // The DEMUX-RING latency signal the auto-degrade trigger runs on (the real "decode behind
  // ingest → audio starves" signal, routed from the decode worker on each frame). `demuxRingBytes` is the
  // latest depth; `demuxRingTrend` is a small ~DEGRADE_RING_TREND_MS window of (at, bytes) samples (one per
  // pstats post) whose MIN gives the growth delta. `autoSkipsEngaged` tracks whether we have fanned the decode skips
  // out to the decode worker, so reset() can cleanly retract them (a fresh timeline re-arms the trigger).
  private demuxRingBytes = 0;
  private demuxRingTrend: { at: number; bytes: number }[] = [];
  private autoSkipsEngaged = false;

  private vfW = 0;                 // last announced WebCodecs frame dims (the demuxer reports WC dims as 0)
  private vfH = 0;
  private lastTimePost = 0;
  private lastPstatsPost = 0;
  private framesDrawn = 0;        // cumulative distinct front-frame draws (the authoritative present count)
  // ---- present-cadence instrument (MEASURE-ONLY; no pacing/clock change) ----
  // Each DISTINCT front-frame draw stamps performance.now() into a ROLLING ~1s buffer; the inter-draw
  // interval IS the present cadence (how evenly NEW frames reach the screen). At each pstats post the
  // FULL trailing-1s buffer (~50 intervals @ 50fps → a meaningful p95) is folded into mean/p95/max + a
  // stutter count via the pure `cadenceStats` (so the ~1Hz bus reads a true 1s window, not a 250ms
  // snapshot). The content frame period (the stutter threshold) is the MEDIAN PTS delta of recently
  // drawn frames (robust to a dropped-frame 2× outlier; seams filtered), falling back to
  // 1000/DEFAULT_CONTENT_FPS until ≥2 deltas exist. NO per-frame logging — cheap floats + one shift().
  private lastDrawAt = 0;                  // performance.now() of the previous distinct draw (0 = none yet)
  private cadence: CadenceSample[] = [];   // rolling ~1s of distinct-draw samples (evicted by `at`)
  private cadencePtsDeltas: number[] = []; // recent positive non-seam PTS deltas (ms) → the content period
  private seamPending = false;             // next draw's interval crosses a re-anchor freeze → flag a seam gap
  // ---- clock/draw instrument (MEASURE-ONLY) — cumulative counters + per-post window anchors. The post
  //      reports rates over [wTs, ts]: rAF ticks/s, drops/s, and the media-clock advance (how many content
  //      frames the audio-master clock crossed per wall-second — the REAL present pace on a seam-free clip). ----
  private rafTicks = 0;          // cumulative rAF callbacks (the total present-loop tick count)
  private dropped = 0;           // cumulative ring frames evicted WITHOUT being displayed (lost to the ring)
  private lastNowUs = 0;         // last media-clock value computed in tick() (µs) — for clock-advance windowing
  private clockResidualUs = 0;   // last PLL residual (audioTarget − smoothed mediaUs, µs) at an audio-locked tick
  private wTs = 0;               // wall ts at the last pstats post (0 ⇒ re-anchor; report rates as 0)
  private wRaf = 0;              // rafTicks at the last post
  private wDropped = 0;          // dropped at the last post
  private wNowUs = 0;            // lastNowUs at the last post
  private wClockBroke = false;   // a seam/reset re-anchored the clock within this window ⇒ clock-advance invalid
  private wSyncResyncs = 0;      // syncResyncs at the last post (SYNC GUARD fires/sec — thrash detector)
  // LIVE-WC: WebCodecs VideoFrames retired (drawn/dropped/closed) since the last `release` post. A WC frame
  // has no token (it is TRANSFERRED, closed in place), but the decode worker needs the COUNT to drive its
  // present-ring feed-backpressure (`wcInFlight` — the WC analog of `heldFrames`). Accumulated by
  // releaseFrame, flushed with the next release post (or its own) via postReleases.
  private vfReleased = 0;
  private boundTick: (ts: number) => void;

  constructor(canvas: OffscreenCanvas, port: MessagePort, clock: SharedArrayBuffer, wcRingCap: number, swRingCap: number) {
    this.renderer = new GlRenderer(canvas); // throws if WebGL2 is unavailable in the worker
    this.port = port;
    this.clock = new Int32Array(clock);
    this.wcRingCap = wcRingCap;
    this.swRingCap = swRingCap;
    this.boundTick = (ts: number): void => this.tick(ts);
    this.port.onmessage = (e: MessageEvent<DecodeToPresent>): void => this.onPortMessage(e.data);
    this.rafId = g.requestAnimationFrame(this.boundTick);
  }

  // ---- frames from the decode worker -----------------------------------------

  private onPortMessage(msg: DecodeToPresent): void {
    if (this.destroyed) {
      // Drain in-flight frames cleanly so a transferred VideoFrame can't strand the decoder pool.
      if (msg.type === 'vframe') { try { msg.frame.close(); } catch { /* closed */ } }
      return;
    }
    switch (msg.type) {
      case 'engineMemory':
        this.engineMemory = msg.memory; // the live shared heap — software frames upload straight from it
        break;
      case 'frame':
        // A frame the OLD load left in flight on the port (this channel is unordered w.r.t. the
        // main-channel `reset`) must NOT enter the fresh ring — release its heap slot, don't enqueue.
        if (isStaleLoadGen(msg.gen, this.gen)) { this.postReleases([msg.token]); break; }
        this.pushYuv(msg);
        break;
      case 'vframe':
        // Same stale-frame guard for the WebCodecs tier — close + ack the VideoFrame (it was counted in
        // the decode worker's wcInFlight when posted), then drop it rather than flash the prior stream.
        if (isStaleLoadGen(msg.gen, this.gen)) { try { msg.frame.close(); } catch { /* already closed */ } this.vfReleased++; this.postReleases([]); break; }
        this.pushVf(msg);
        break;
      case 'dropVideoFrames':
        // (iOS): a live WC decoder was freed mid-stream — close + drop its frames before a draw
        // could touch a dead pool. Ignore a STALE one (superseded load) so it can't wipe the new ring.
        if (msg.gen === this.gen && this.ring.length) {
          const released: number[] = [];
          for (const f of this.ring) this.releaseFrame(f, released);
          this.ring = [];
          this.postReleases(released); // LIVE-WC: also carries the vf-closed count back to the decode worker
          this.lastDrawnPts = -1;
        }
        break;
    }
  }

  /** Feed the content-period estimator from DECODE-ARRIVAL PTS deltas (every decoded frame, regardless of
   *  which frames the cadence later draws) — so contentDurMs() is the TRUE content frame period even when
   *  the degraded tier decimates draws (a drawn-PTS delta would read 2× in tier 2 and corrupt the cadence).
   *  Seam-sized / non-monotonic deltas (>1s or ≤0) are dropped; the median resists the rest. */
  private feedContentPeriod(ptsUs: number): void {
    if (this.lastPushPtsUs >= 0) {
      const dms = (ptsUs - this.lastPushPtsUs) / 1000;
      if (dms > 0 && dms < 1000) {
        this.cadencePtsDeltas.push(dms);
        if (this.cadencePtsDeltas.length > 64) this.cadencePtsDeltas.shift();
      }
    }
    this.lastPushPtsUs = ptsUs;
  }

  private pushYuv(m: Extract<DecodeToPresent, { type: 'frame' }>): void {
    if (m.contentPeriodUs > 0) this.decodeContentPeriodUs = m.contentPeriodUs; // TRUE (non-ref-skip-independent) period for the cap
    this.demuxRingBytes = m.demuxRingBytes; // the demux-ring latency signal the degrade trigger runs on
    this.feedContentPeriod(m.ptsUs);
    const frame: RingFrame = { kind: 'yuv', ptsUs: m.ptsUs, w: m.w, h: m.h, cw: m.cw, ch: m.ch, bitDepth: m.bitDepth, colorspace: m.colorspace, colorRange: m.colorRange, colorTrc: m.colorTrc, token: m.token, ptrs: m.ptrs, lns: m.lns };
    if (this.ring.length < this.swRingCap) {
      this.ring.push(frame);
    } else if (!this.paused) {
      // Ring full while PLAYING — drop the OLDEST, keep the incoming one (hold the ring at the live
      // edge; mirrors the WebCodecs drop-oldest). Release the evicted slot back to the decode pool.
      const released: number[] = [];
      const old = this.ring.shift();
      if (old) { if (old.ptsUs !== this.lastDrawnPts) this.dropped++; this.releaseFrame(old, released); } // evicted-without-display ⇒ a real drop
      this.ring.push(frame);
      this.postReleases(released); // LIVE-WC: also carries the vf-closed count back to the decode worker
    } else {
      // PAUSED + full: dropping the oldest would advance the FROZEN front → drop the INCOMING + release it.
      this.postReleases([m.token]);
    }
  }

  private pushVf(m: Extract<DecodeToPresent, { type: 'vframe' }>): void {
    if (m.contentPeriodUs > 0) this.decodeContentPeriodUs = m.contentPeriodUs; // TRUE (non-ref-skip-independent) period for the cap
    this.demuxRingBytes = m.demuxRingBytes; // the demux-ring latency signal the degrade trigger runs on
    this.feedContentPeriod(m.ptsUs);
    const frame: RingFrame = { kind: 'vf', ptsUs: m.ptsUs, frame: m.frame };
    if (this.ring.length < this.wcRingCap) {
      this.ring.push(frame);
    } else if (!this.paused) {
      const old = this.ring.shift();
      if (old) { if (old.ptsUs !== this.lastDrawnPts) this.dropped++; const r: number[] = []; this.releaseFrame(old, r); this.postReleases(r); } // LIVE-WC: vf close acked via postReleases
      this.ring.push(frame);
    } else {
      // PAUSED + full: dropping the oldest would advance the FROZEN front → drop the INCOMING + ack it
      // (this VideoFrame was counted in the decode worker's wcInFlight when posted; closing it without the
      // ack would wedge the WC feed gate).
      try { m.frame.close(); } catch { /* already closed */ } this.vfReleased++; this.postReleases([]);
    }
  }

  // ---- ring/clock helpers ----------------------------------------------------

  /** Release a retired frame: a software heap SLOT goes back to the decode worker by token (a credit);
   *  a WebCodecs VideoFrame is CLOSED in place (frees the hardware output pool). The caller batches the
   *  collected tokens into one `release` post. */
  private releaseFrame(f: RingFrame, released: number[]): void {
    if (f.kind === 'yuv') released.push(f.token);
    else { try { f.frame.close(); } catch { /* already closed */ } this.vfReleased++; } // LIVE-WC: count the retired VideoFrame
  }

  /** Post a batch of retired-frame releases back to the decode worker: software heap-slot tokens AND the
   *  count of WebCodecs VideoFrames closed since the last post (`vf`). The decode worker grants a credit
   *  per token and decrements its `wcInFlight` by `vf` (the WC feed-backpressure counter). Posts only when
   *  there is something to report (a token OR a closed VideoFrame), so a pure-software batch is unchanged. */
  private postReleases(released: number[]): void {
    if (released.length || this.vfReleased) {
      this.port.postMessage({ type: 'release', tokens: released, vf: this.vfReleased });
      this.vfReleased = 0;
    }
  }

  /** Master clock in µs (port of WorkerPresenter::tick's media_now computation). The video anchor +
   *  the audio PLAYOUT elapsed (read from the SAB) when audio is live, else the wall clock from the
   *  same anchor; a 1st-order PLL smooths the SAB-sampled audio clock (the reference player needs this
   *  because A_ACLOCK is sampled jittery on main and read at rAF here). */
  private mediaUsNow(dt: number): number {
    this.audioDriving = false; // recomputed below; the SYNC GUARD only re-syncs to a live AUDIO master
    const hasAudio = Atomics.load(this.clock, C_AUDIO) > 0;
    if (hasAudio) {
      this.graceTicks = 0; // audio present → never declare video-only
      const rawUs = Atomics.load(this.clock, C_ACLOCK) * 1000; // ms → µs
      if (rawUs <= 0) { this.mediaUs = 0; return this.mediaAnchorPtsUs; } // audio not audible yet → HOLD on the anchor
      this.audioDriving = true; // a live, audible audio master clock is driving media_now
      const target = this.mediaAnchorPtsUs + rawUs;
      if (!this.audioLocked) {
        const [m, a] = audioLockClock(this.mediaUs, this.mediaAnchorPtsUs, rawUs);
        this.mediaUs = m; this.mediaAnchorPtsUs = a; this.audioLocked = true;
      } else if (!this.paused) {
        this.mediaUs += dt * 1000;                          // smooth rAF advance (dt ms → µs)
        this.clockResidualUs = target - this.mediaUs;       // instrument: the PLL error BEFORE the correction
        this.mediaUs += this.clockResidualUs * 0.10;        // lock to the audio sample (PLL)
      }
      return this.mediaUs;
    }
    if (this.graceTicks > NO_AUDIO_GRACE_TICKS) {
      // Grace elapsed with no audio → genuinely video-only: advance by a PAUSE-AWARE dt accumulate.
      if (this.mediaUs <= 0) this.mediaUs = this.mediaAnchorPtsUs;
      else if (!this.paused) this.mediaUs += dt * 1000;
      return this.mediaUs;
    }
    // Within the grace: HOLD on the anchor waiting for the audio clock to start.
    if (!this.paused) this.graceTicks++;
    this.mediaUs = 0;
    return this.mediaAnchorPtsUs;
  }

  // ---- present loop ----------------------------------------------------------

  private tick(ts: number): void {
    this.rafId = g.requestAnimationFrame(this.boundTick);
    this.rafTicks++; // instrument: TOTAL present-loop callbacks (rafFps = the draw headroom vs distinct draws)
    const dt = this.lastTs === 0 ? 0 : ts - this.lastTs;
    this.lastTs = ts;
    this.vsync.push(dt); // feed the display-refresh estimator (it guards dt≤0 / pause-gap internally)
    this.ringLowWater = Math.min(this.ringLowWater, this.ring.length); // present-ring draining signal (feeds underDelivering / sync-guard suppression)
    if (this.ring.length === 0) return;

    // Anchor the media clock to the FIRST frame's PTS (relative epoch — TS PTS clocks start non-zero).
    if (!this.anchored) {
      if (this.paused) { this.drawFront(); return; } // hold the first frame until we play
      this.anchored = true;
      this.mediaAnchorPtsUs = this.ring[0].ptsUs;
    }

    let now = this.mediaUsNow(dt);
    this.lastNowUs = now; // instrument: the media-clock value this tick (clock-advance windowing)

    // Pacing mode: engage the Bresenham display cadence ONLY once the real refresh is measured-stable
    // (mpv gates display-resample on vsync confidence the same way) — until then the proven audio-timed
    // retire-by-pts path runs, so the ~1.7 s warmup behaves EXACTLY as before (no fast-advance/starve
    // from holding integer vsyncs against a wrong nominal interval). The estimator latches once adopted,
    // so this flips true ~once and stays.
    this.vsTick = this.vsync.read(); // ONE snapshot per tick (seedHold + the telemetry post reuse it)
    // Step 2 (this dispatch): RE-ENABLED. The freeze the cadence reintroduced was the GAPPED ring — decode
    // dropped frames at the live edge, punching PTS holes the cadence stranded on. That root cause is fixed
    // (worker.ts no-drop, 458c2e4): the ring is now CONTIGUOUS, so the Bresenham cadence works as designed.
    // Engages once the real refresh is measured-stable (mpv gates display-resample on vsync confidence the
    // same way); until adopted the proven audio-timed retire-by-pts path runs, so the warmup is unchanged.
    const cadenceMode = this.vsTick.adopted;
    // If the cadence ever DISENGAGES (the measured refresh left the sane band / collapsed — e.g. a mid-
    // playback monitor/refresh change), drop cadenceActive so the legacy path runs and a later re-engage
    // re-seeds the hold cleanly (no stale holdRemaining carried across the legacy interlude).
    if (!cadenceMode) this.cadenceActive = false;

    const released: number[] = [];
    // SEAM detection (BOTH modes): a PTS discontinuity between adjacent ring frames is a failover/splice
    // → re-anchor the clock epoch onto the new timeline (instead of flushing it as "ancient"). In legacy
    // mode this loop ALSO retires every frame whose ptsUs ≤ now (the old behaviour); in cadence mode it
    // only handles seams and the Bresenham step below drives retirement (so we never advance >1 frame/tick).
    while (this.ring.length >= 2) {
      const gap = this.ring[1].ptsUs - this.ring[0].ptsUs;
      if (gap > SEAM_FWD_US || gap < -SEAM_BACK_US) {
        const newPts = this.ring[1].ptsUs;
        if (Atomics.load(this.clock, C_AUDIO) > 0) {
          // Anchor the new video PTS to the (continuous) audio elapsed: media_now re-derives to newPts.
          const rawUs = Atomics.load(this.clock, C_ACLOCK) * 1000;
          this.mediaAnchorPtsUs = newPts - rawUs;
          this.mediaUs = newPts;
        } else {
          this.mediaAnchorPtsUs = newPts;
          this.mediaUs = newPts;
        }
        this.releaseFrame(this.ring.shift()!, released);
        this.lastDrawnPts = -1; // force a redraw of the new-epoch front (PTS can collide with the old timeline)
        // Cadence: a seam re-anchor (failover/splice) FREEZES the present across the discontinuity — the
        // next draw's inter-draw wall time spans that freeze, so flag it (dropped from stutter stats,
        // counted as a seamGap) instead of letting a reconnect gap masquerade as a steady-state stutter.
        this.seamPending = true;
        this.wClockBroke = true; // a re-anchor invalidates clock-advance over any window spanning it
        // Bresenham: a seam re-anchors the timeline → RESET the fractional accumulator + hold so the
        // cadence re-seeds from the new front (lastDrawnPts=-1 above triggers the re-seed). Otherwise a
        // carried error from the old timeline would mis-phase the first post-seam holds.
        this.cadenceErrorMs = 0;
        this.holdRemaining = 0;
        now = this.mediaUsNow(dt);
        this.lastNowUs = now;
        continue;
      }
      if (!cadenceMode && this.ring[1].ptsUs <= now) {
        // LEGACY (warmup) retire-by-pts: catch the front up to the clock. If the front never became the
        // displayed front it was evicted-without-display (a real present drop), not a normal hand-off.
        if (this.ring[0].ptsUs !== this.lastDrawnPts) this.dropped++;
        this.releaseFrame(this.ring.shift()!, released);
      } else break;
    }

    if (cadenceMode) this.runCadence(now, ts, released); // SYNC GUARD + Bresenham num_vsyncs advance

    // LIVE-WC FIX: route the steady-state draw releases through postReleases so the batch also
    // carries the `vf` count (retired VideoFrames closed this draw). The old `if (released.length) post(...)`
    // sent ONLY software tokens and was skipped entirely for WC (a retired VideoFrame pushes NO token), so the
    // decode worker's `wcInFlight` never decremented on the normal present path — the telemetry climbed without
    // bound. (wcInFlight no longer gates the feed, so this is now a telemetry-accuracy fix, not a deadlock fix;
    // the deadlock is removed at the gate.) Software is unchanged: postReleases posts iff tokens OR vfReleased.
    this.postReleases(released);
    this.drawFront(ts);
  }

  /** TRUE content frame period (ms). PREFERS the decode worker's PACKET-PTS period (decodeContentPeriodUs)
   *  — non-ref-skip independent, so a non-ref-skipping decoder (which outputs fewer, wider-spaced frames)
   *  does NOT inflate the cap target → the present-cap + non-ref-skip never decimate twice. Falls back to the present-side median of
   *  DECODE-ARRIVAL PTS deltas (robust to a dropped-frame 2× outlier; seams filtered) when the packet period
   *  is unset (WC tier / pre-warmup), then to the default until ≥2 deltas. Decimation-independent either way. */
  private contentDurMs(): number {
    if (this.decodeContentPeriodUs > 0) return this.decodeContentPeriodUs / 1000;
    return this.cadencePtsDeltas.length >= 2 ? median(this.cadencePtsDeltas) : 1000 / DEFAULT_CONTENT_FPS;
  }

  /** The EFFECTIVE cadence tier this tick = the manual Lever-1 override (forces tier 2) OR the auto-latched
   *  tier, whichever degrades more. Both drive the SAME cap (capAdvance) so there is one present path. */
  private activeTier(): number {
    return this.manualHalf ? CADENCE_TIER_HALF : this.cadenceTier;
  }

  /** The DISPLAYED-frame period (ms) the Bresenham cadence holds against = content period × the ACTIVE tier.
   *  Tier 1 ⇒ the content period (full rate); tier 2 ⇒ 2× (we draw every other frame and hold it twice as
   *  long → a clean half-rate divisor of the refresh). Drives the hold count, the stutter threshold, and
   *  the self-check; the TRUE content period (contentDurMs) drives the clock-advance instrument. */
  private presentPeriodMs(): number {
    return this.contentDurMs() * this.activeTier();
  }

  /** Seed the Bresenham hold for the CURRENT front (mpv video.c:835-843): hold it round(ratio) whole
   *  vsyncs, carrying the fractional remainder forward so 50-on-75 emits a deterministic 1,2,1,2 cadence
   *  with zero long-term drift. Called on the first draw of a measurement and on each advance/re-seed. */
  private seedHold(): void {
    const vsyncMs = this.vsTick.intervalMs;                // measured (adopted) display interval, ms (cached this tick)
    const { hold, err } = nextHold(this.presentPeriodMs(), this.cadenceErrorMs, vsyncMs);
    this.cadenceErrorMs = err;                             // sigma-delta: carry the leftover phase error
    this.holdRemaining = hold;
    this.cadenceHolds.push(hold);                          // telemetry: the recent 1,2 pattern
    if (this.cadenceHolds.length > 64) this.cadenceHolds.shift();
  }

  /** The Bresenham display-cadence step (only when cadenceMode). Holds the current front for its seeded
   *  vsync count, advancing to the next frame exactly when the count expires — so the audio clock no
   *  longer picks frames per rAF; the measured display cadence does. A VLC-style SYNC GUARD first bounds
   *  any slow A/V divergence (the audio master is still the rate reference for re-sync). */
  private runCadence(now: number, ts: number, released: number[]): void {
    if (this.paused) { this.syncBehindTicks = 0; return; } // frozen front — no advance, no countdown, no desync

    // Transition legacy→cadence (vsync just adopted). The current front was already on-screen for an
    // unknown number of legacy ticks, so DON'T seed it a full fresh hold (that would add its legacy age +
    // a whole new hold → a one-shot extra-vsync judder at adoption). Instead start the accumulator at zero
    // and advance promptly (holdRemaining=1) — the next advance runs the first REAL seedHold from a clean
    // phase. If nothing is drawn yet (lastDrawnPts<0) fall through — the first-draw seed below handles it.
    if (!this.cadenceActive) {
      this.cadenceActive = true;
      this.cadenceErrorMs = 0;
      if (this.lastDrawnPts >= 0) { this.holdRemaining = 1; return; }
    }

    // SYNC GUARD (VLC-style, both directions): once the cadence drives frames, drift from the audio master
    // can build. Bound |front.ptsUs − media_now| to SYNC_GUARD_US. Gated on a live audio master + an
    // already-drawn front, so it can't thrash when we're merely a fraction of a vsync off.
    if (this.audioDriving && this.lastDrawnPts >= 0) {
      const drift = this.ring[0].ptsUs - now; // <0 ⇒ front behind audio (late); >0 ⇒ ahead (early)
      if (drift < -SYNC_GUARD_US) {
        // BEHIND. HYSTERESIS (the thrash fix): a throughput-limited client sits PERMANENTLY behind, so a
        // per-tick resync churns (35×/s) and makes throughput worse. Only hard-resync on a GENUINE
        // discontinuity: the desync must be SUSTAINED (≥ SYNC_SUSTAIN_TICKS), OUTSIDE the post-resync
        // cooldown, and NOT during measured under-delivery (that is throughput-behind → owned by the
        // graceful-degradation tier + drop-oldest, never by the guard). Otherwise we let the cadence
        // present the queued frames in order (accept a little latency) — drop-oldest bounds memory.
        this.syncBehindTicks++;
        const cooling = this.lastResyncTs > 0 && (ts - this.lastResyncTs) < SYNC_COOLDOWN_MS;
        const genuine = this.syncBehindTicks >= SYNC_SUSTAIN_TICKS && !cooling && !this.underDelivering;
        if (genuine && this.ring.length >= 2) {
          // Skip the ring forward to the frame nearest now (a hard-resync), releasing the skipped slots as
          // drops. Only when a nearer frame exists (best>0) — else there's nothing to skip to.
          let best = 0, bestDist = Math.abs(this.ring[0].ptsUs - now);
          for (let i = 1; i < this.ring.length; i++) {
            const d = Math.abs(this.ring[i].ptsUs - now);
            if (d < bestDist) { bestDist = d; best = i; }
          }
          if (best > 0) {
            for (let i = 0; i < best; i++) {
              const f = this.ring[i];
              if (f.ptsUs !== this.lastDrawnPts) this.dropped++; // skipped-without-display ⇒ a real drop
              this.releaseFrame(f, released);
            }
            this.ring.splice(0, best);
            this.lastDrawnPts = -1;   // force a redraw of the resynced front
            this.cadenceErrorMs = 0;  // re-anchor the accumulator onto the new phase
            this.holdRemaining = 0;
            this.syncResyncs++;       // telemetry: a hard-resync fired (should be ~0 on a clean/steady clip)
            this.lastResyncTs = ts;   // arm the cooldown
            this.syncBehindTicks = 0; // re-arm the sustain counter
          }
        }
      } else {
        this.syncBehindTicks = 0; // recovered (or within band) → re-arm the sustain requirement
        if (drift > SYNC_GUARD_US) {
          // AHEAD: the cadence outran the audio clock (e.g. an audio flat-spot / underrun froze media_now).
          // We CAN'T skip backward (older frames are already released), so HOLD the current front this tick —
          // don't advance — until media_now catches up. Bounds A/V drift on the early side without thrash.
          return;
        }
      }
    } else {
      this.syncBehindTicks = 0; // no live audio master to measure against → no desync accrual
    }

    // Bresenham advance: first draw seeds; otherwise count down one vsync and advance when it expires.
    if (this.lastDrawnPts < 0) {
      this.seedHold(); // first frame of a fresh measurement (or post seam/sync-guard) → draw + seed
    } else {
      this.holdRemaining--;
      if (this.holdRemaining <= 0) {
        // capAdvance = how many ring frames this present STEP consumes at the ACTIVE tier, by PTS-CAP
        // decimation (PURE, tested headless): 0 = STARVED (no next frame → hold, re-evaluate next tick);
        // 1 = retire the displayed front (a normal hand-off, NOT a drop); >1 = retire the front AND skip the
        // intermediate frame(s) WHOSE PTS is within (tier × content period) of the last shown — the degraded-
        // tier decimation, SELF-FLOORING (sparse/drained ring ⇒ no skip ⇒ present never below decode). The
        // displayed front (ring[0]) IS the last shown frame; the skipped frames are released here, never
        // stranded. The TRUE content period (contentDurUs) keeps the present-cap + non-ref-skip from decimating twice.
        const shownPtsUs = this.ring[0].ptsUs; // the displayed front we're retiring = the last shown frame
        const adv = capAdvance(this.ring, shownPtsUs, this.contentDurMs() * 1000, this.activeTier());
        if (adv >= 1) {
          for (let i = 0; i < adv; i++) {
            const f = this.ring.shift()!;
            if (i > 0 && f.ptsUs !== this.lastDrawnPts) this.degradeSkips++; // intentional decimation (NOT a fault drop)
            this.releaseFrame(f, released);
          }
          this.seedHold(); // seed the NEW front's hold (presentPeriodMs = content × active tier)
        } else {
          // STARVED (decode-bound): hold expired but no next frame. Clamp to 0 so we re-evaluate every tick
          // instead of running the count negative; the cadence resumes the instant a frame arrives.
          this.holdRemaining = 0;
        }
      }
    }
  }

  /** Draw the current front frame (if it changed) on the tier-tagged kind. */
  private drawFront(ts = 0): void {
    const f = this.ring[0];
    if (!f || f.ptsUs === this.lastDrawnPts) return;
    if (f.kind === 'yuv') {
      // TRUE zero-copy: view the HELD frame's Y|U|V planes FRESH over the live heap (a pthread grow
      // replaces the SAB → re-read engineMemory.buffer every upload) at their NATIVE byte stride + bit
      // depth, and upload STRAIGHT from them (the GPU de-strides via UNPACK_ROW_LENGTH + bit-scales). The
      // held frame stays valid (the decoder won't reuse it until this frame is released on retire), and
      // GL keeps its own texture copy after upload — so the later release is safe.
      const mem = this.engineMemory;
      if (!mem) return; // heap not handed over yet (engineMemory always precedes the first frame)
      const buf = mem.buffer;
      const bps = f.bitDepth > 8 ? 2 : 1;            // bytes per sample (8-bit → R8UI, 10/12-bit → R16UI)
      const yRow = f.lns[0] / bps, uRow = f.lns[1] / bps, vRow = f.lns[2] / bps; // stride in SAMPLES
      // Each plane view spans its full strided height (rowSamples × planeHeight): Y is h rows, U/V ch rows.
      if (bps === 2) {
        const y = new Uint16Array(buf, f.ptrs[0], yRow * f.h);
        const u = new Uint16Array(buf, f.ptrs[1], uRow * f.ch);
        const v = new Uint16Array(buf, f.ptrs[2], vRow * f.ch);
        this.renderer.draw(y, yRow, u, uRow, v, vRow, f.w, f.h, f.cw, f.ch, f.bitDepth, f.colorspace, f.colorRange, f.colorTrc);
      } else {
        const y = new Uint8Array(buf, f.ptrs[0], yRow * f.h);
        const u = new Uint8Array(buf, f.ptrs[1], uRow * f.ch);
        const v = new Uint8Array(buf, f.ptrs[2], vRow * f.ch);
        this.renderer.draw(y, yRow, u, uRow, v, vRow, f.w, f.h, f.cw, f.ch, f.bitDepth, f.colorspace, f.colorRange, f.colorTrc);
      }
    } else {
      // WC dims → main (the demuxer reports WC dims as 0; videoWidth/Height + format readout need these).
      const w = f.frame.displayWidth, h = f.frame.displayHeight;
      if (w !== this.vfW || h !== this.vfH) { this.vfW = w; this.vfH = h; post({ type: 'vdims', w, h }); }
      this.renderer.drawFrame(f.frame);
    }
    this.lastDrawnPts = f.ptsUs;
    this.framesDrawn++; // a distinct front frame was drawn → the authoritative present count
    // present-cadence: stamp this draw into the rolling ~1s buffer. The interval since the previous
    // distinct draw is a STEADY-STATE sample — UNLESS this is the first draw of a fresh measurement
    // (lastDrawAt 0) or it crosses a reset/seam freeze (seamPending), either of which makes the wall gap
    // meaningless as a present interval. A seam draw is flagged so it's dropped from the stutter stats
    // but still counted as a seamGap (reconnect/failover freezes stay visible but distinct).
    const drawAt = performance.now();
    let interval: number | null = null;
    let seam = false;
    if (this.seamPending) {
      seam = true;            // crossed a seam re-anchor freeze → drop the cross-gap interval, count the gap
      this.seamPending = false;
    } else if (this.lastDrawAt > 0) {
      interval = drawAt - this.lastDrawAt; // a genuine steady-state inter-draw interval (ms)
    }
    this.lastDrawAt = drawAt;
    this.cadence.push({ at: drawAt, interval, seam });
    // Evict everything older than the rolling 1s window (keeps the buffer ~50 entries @ 50fps).
    const cutoff = drawAt - CADENCE_WINDOW_MS;
    while (this.cadence.length && this.cadence[0].at < cutoff) this.cadence.shift();
    // (The content-period estimator is fed from DECODE ARRIVALS, not drawn frames — see feedContentPeriod —
    //  so the degraded tier's decimation can't corrupt it.)
    // Throttled currentTime → main (drives facade currentTime + TIME_UPDATE).
    if (ts - this.lastTimePost >= TIME_POST_MS) { this.lastTimePost = ts; post({ type: 'time', ms: f.ptsUs / 1000 }); }
    if (ts - this.lastPstatsPost >= PSTATS_POST_MS) {
      this.lastPstatsPost = ts;
      // DIAGNOSTIC per-tick present view (→ /pumplog): is media_now inside the ring's PTS span [front,back]?
      // now<front ⇒ clock BEHIND the ring (drop-oldest stranded the clock's frame); now>back ⇒ clock AHEAD
      // (decode starved); drawn vs now ⇒ are we showing the clock's frame; jumps in front/back/now ⇒ loop.
      if (DEBUG) post({ type: 'plog', m: `[present] now=${(this.lastNowUs / 1000) | 0} front=${this.ring.length ? (this.ring[0].ptsUs / 1000) | 0 : -1} back=${this.ring.length ? (this.ring[this.ring.length - 1].ptsUs / 1000) | 0 : -1} drawn=${this.lastDrawnPts >= 0 ? (this.lastDrawnPts / 1000) | 0 : -1} ring=${this.ring.length} audio=${this.audioDriving ? 1 : 0} anc=${this.anchored ? 1 : 0}` });
      // Cadence over the TRUE trailing-1s rolling buffer (NOT the 250ms post slice): presentFps =
      // the draw rate over the span the window covers; mean/p95/max/stutters over the steady-state
      // intervals; seamGaps for the re-anchor freezes. The content frame period (stutter threshold base)
      // is the MEDIAN drawn-PTS delta (robust), falling back until ≥2 deltas exist.
      // We HAVE a content period once either the decode worker's packet period landed OR the present-side
      // arrival estimator has ≥2 deltas; contentPeriodMs is the TRUE period (contentDurMs prefers the
      // non-ref-skip-independent packet period), so the stutter threshold + degrade math track real content, not the
      // non-ref-skip-decimated arrival rate.
      const haveContentPeriod = this.decodeContentPeriodUs > 0 || this.cadencePtsDeltas.length >= 2;
      const contentPeriodMs = this.contentDurMs();
      // EFFECTIVE tier = what is ACTUALLY drawn = the ACTIVE tier (manual Lever-1 override OR auto-latched).
      // The decimation only happens in runCadence (the Bresenham cadence); during a rare mid-playback vsync
      // DISENGAGE (cadenceActive false) the legacy retire-by-pts path draws every frame regardless — so report
      // + measure tier 1 in that interlude (the latch/override survives and resumes when the cadence re-engages).
      // Keeps the telemetry honest (cadenceTier/cadenceDrawRate match the real draw rate) and the threshold right.
      const effectiveTier = this.cadenceActive ? this.activeTier() : 1;
      // The DISPLAYED-frame period = content × effectiveTier (tier 2 draws every other frame and holds it
      // twice as long), so the stutter threshold + self-check track the ACTUAL inter-draw cadence (≈40 ms in
      // tier 2), while the clock-advance instrument below uses the TRUE content period (the clock crosses
      // every frame).
      const presentPeriodMs = contentPeriodMs * effectiveTier;
      const m = cadenceStats(this.cadence, presentPeriodMs);
      // #4 self-check: at a steady ~displayed-rate cadence p95 must be ~presentPeriodMs and stutters 0 — log
      // ONLY on a violation (window-math bug); a correct window is silent. Throttled to this ~4Hz post path.
      if (DEBUG) {
        const problem = cadenceSelfCheck(m, presentPeriodMs);
        if (problem) console.warn('[present] ' + problem);
      }
      const r1 = (x: number): number => Math.round(x * 10) / 10; // 0.1ms resolution keeps the post tiny
      const r2 = (x: number): number => Math.round(x * 100) / 100;
      // CLOCK/DRAW instrument over [wTs, ts]. rAF + drop rates from the cumulative counters; the media-
      // clock advance (clockAdvanceFps / clockRateRatio) from how far lastNowUs moved per wall-ms — the
      // AUTHORITATIVE answer to "why distinct draws pace to ~46": if the clock crossed only 46 content
      // frames/sec then 46 distinct draws is the clock pacing (real), not a draw/ring loss. Skipped (0)
      // for a window that spanned a re-anchor (wClockBroke) — a seam jump would read as a fake huge advance.
      const dWall = this.wTs > 0 ? ts - this.wTs : 0;
      let clockAdvanceFps = 0, clockRateRatio = 0, rafFps = 0, presentDropsPerSec = 0;
      if (dWall > 0) {
        rafFps = Math.round(((this.rafTicks - this.wRaf) * 1000) / dWall);
        presentDropsPerSec = r1(((this.dropped - this.wDropped) * 1000) / dWall);
        if (!this.wClockBroke) {
          const dMediaUs = this.lastNowUs - this.wNowUs;
          if (dMediaUs >= 0) {
            clockRateRatio = r2((dMediaUs / 1000) / dWall);        // media-ms ÷ wall-ms (×realtime; 1.0 locked)
            clockAdvanceFps = Math.round(dMediaUs / (contentPeriodMs * dWall)); // content-frames the clock crossed/sec
          }
        }
      }
      // GRACEFUL-DEGRADATION LADDER (graduated, axis-separated; PURE decision in ladderStep). A PRESENT-SIDE
      // decode-bound detector climbs one rung per settle window (rung0→1 skip-non-ref →2 +skip-loop →3 +present-cap, rung2→3 gated on
      // contentFps ≥ LADDER_L1_MIN_FPS) and de-escalates in strict reverse (present-cap→skip-loop→skip-non-ref) on sustained headroom.
      // A capable stream keeps up (present at the effective target, media/wall ≥1.0, ring drained) → stays at
      // rung0; a present-side stall (ring pinned full) can never trip it. `underDelivering` is the LIVE
      // present-side signal that suppresses the sync-guard behind-resync (throughput-behind ≠ a discontinuity).
      const contentRate = contentPeriodMs > 0 ? 1000 / contentPeriodMs : 0;
      // Present-ring watermarks (this post window): LOW = draining (decode can't keep the ring full); HEALTHY
      // = stayed comfortably full (room to give a lever back); FULL = pinned at ~cap (a present-side stall).
      // The dead-band between LOW and HEALTHY prevents the ladder flapping on a ring hovering near the line.
      const ringCap = f.kind === 'vf' ? this.wcRingCap : this.swRingCap;
      const lowRing = this.ringLowWater <= Math.max(3, ringCap >> 2);
      const ringHealthy = this.ringLowWater >= Math.max(4, ringCap >> 1);
      const presentRingFull = this.ringLowWater >= ringCap - 1;
      // `underDelivering` = present below 85 % of the ACTIVE tier's target (content rate ÷ active tier) while
      // the present ring drains — the live throughput-behind signal that also suppresses the sync-guard
      // behind-resync. The tier-adjusted target means a HEALTHY degraded stream (25 fps at the halved tier)
      // does NOT read as under-delivering (else it would wrongly suppress the guard / re-flag forever).
      const activeTier = this.activeTier();
      const effectiveTarget = activeTier > 0 ? contentRate / activeTier : contentRate;
      this.underDelivering =
        this.cadenceActive && !this.paused && haveContentPeriod &&
        effectiveTarget > 0 && m.fps > 0 && m.fps < effectiveTarget * 0.85 && lowRing;
      if (AUTO_DEGRADE && dWall > 0) {
        // Maintain the demux-ring TREND (one sample per post) → its window MIN is the growth-delta baseline.
        // On the ladder the demux ring is only a WEAK HINT (the present-side detector owns decode-bound), so
        // a missing/late demux signal can't block a genuine degrade — it only strengthens "can't keep up".
        this.demuxRingTrend.push({ at: ts, bytes: this.demuxRingBytes });
        const trendCutoff = ts - DEGRADE_RING_TREND_MS;
        while (this.demuxRingTrend.length && this.demuxRingTrend[0].at < trendCutoff) this.demuxRingTrend.shift();
        let demuxRingMin = this.demuxRingBytes;
        for (const s of this.demuxRingTrend) if (s.bytes < demuxRingMin) demuxRingMin = s.bytes;
        const demuxPressure = demuxRingPressure(this.demuxRingBytes, demuxRingMin);
        const prevRung = this.degradeRung;
        const prevTier = this.cadenceTier;
        const next: LadderState = ladderStep(
          { rung: this.degradeRung, climbMs: this.ladderClimbMs, dropMs: this.ladderDropMs },
          {
            cadenceActive: this.cadenceActive, paused: this.paused, haveContentPeriod,
            presentFps: m.fps, contentFps: contentRate,
            // decimation = the ACTIVE display tier (manual present-cap OR the rung's present-cap) so a manually-halved
            // display isn't read as a permanent decode deficit; at rung 3 this equals the rung's present-cap anyway.
            decimation: activeTier > 0 ? activeTier : 1,
            clockRateRatio,
            ringLow: lowRing, ringHealthy, presentRingFull, demuxPressure, dWallMs: dWall,
          },
        );
        this.degradeRung = next.rung; this.ladderClimbMs = next.climbMs; this.ladderDropMs = next.dropMs;
        // DERIVE the present-cap tier from the rung: tier 2 (halve the display) only at the top rung.
        this.cadenceTier = this.degradeRung >= RUNG_L2_L3_L1 ? CADENCE_TIER_HALF : CADENCE_TIER_FULL;
        if (this.degradeRung !== prevRung) {
          // Rung changed → FAN OUT the new skip state to the decode worker (skipNonref at rung ≥ 1, skipLoop
          // at rung ≥ 2; the decode worker OR-folds with the manual skips → manual precedence). One message
          // carries both fields, so a climb AND a de-escalation update them in the right order automatically.
          this.autoSkipsEngaged = this.degradeRung > RUNG_NONE;
          this.port.postMessage({
            type: 'autoSkips',
            skipNonref: this.degradeRung >= RUNG_L2,
            skipLoop: this.degradeRung >= RUNG_L2_L3,
          });
          // Re-seed the Bresenham accumulator ONLY when the present-cap tier actually flipped — a clean
          // phase at the new displayed period (no carried error). Skip-only rung changes leave the display
          // cadence untouched, so they need no re-seed.
          if (this.cadenceTier !== prevTier) { this.cadenceErrorMs = 0; this.holdRemaining = 0; }
        }
      }
      // Degrade REASON (telemetry): the manual present-cap override wins (it forces the cap regardless of the
      // ladder); else ANY engaged auto rung (≥1, i.e. the skips and/or the present-cap) reads UNDER_DELIVERY; else not degraded.
      this.cadenceDegradeReason = this.manualHalf ? DEGRADE_REASON_MANUAL
        : this.degradeRung > RUNG_NONE ? DEGRADE_REASON_UNDER_DELIVERY
        : DEGRADE_REASON_NONE;
      this.ringLowWater = Infinity; // re-arm the per-window draining watermark
      // Effective DRAW rate actually being targeted = content rate ÷ effectiveTier (the bus reads this + the
      // effective tier, so both reflect what reaches the screen, not just the latched intent).
      const cadenceDrawRate = Math.round(contentRate / effectiveTier);
      // DISPLAY-CADENCE instrument (the Bresenham fix): the measured vsync interval (ms) + refresh (Hz)
      // the cadence runs against; the recent hold pattern as a MEAN vsyncs/frame (50-on-75 → ~1.5, i.e. a
      // clean alternating 1,2) plus the fraction of 2-holds; the |cadence_error| magnitude (bounded, ~≤
      // half a vsync if the accumulator is healthy); and the SYNC-GUARD hard-resync rate (≈0 on a clean
      // clip — a non-zero rate flags A/V desync/thrash). 0/inactive until the refresh is adopted.
      const v = this.vsync.read();
      const holdN = this.cadenceHolds.length;
      let holdSum = 0, hold2 = 0;
      for (let i = 0; i < holdN; i++) { holdSum += this.cadenceHolds[i]; if (this.cadenceHolds[i] >= 2) hold2++; }
      const cadenceHoldMean = holdN ? r2(holdSum / holdN) : 0;
      const cadenceHold2Frac = holdN ? r2(hold2 / holdN) : 0;
      const syncResyncsPerSec = dWall > 0 ? r1(((this.syncResyncs - this.wSyncResyncs) * 1000) / dWall) : 0;
      // Re-anchor the window for the next post (rates are per-window deltas; clock-broke clears here).
      this.wTs = ts; this.wRaf = this.rafTicks; this.wDropped = this.dropped; this.wNowUs = this.lastNowUs; this.wClockBroke = false;
      this.wSyncResyncs = this.syncResyncs;
      // DIAGNOSTIC: the present-cadence + clock telemetry bundle (feeds getStats() / the debug overlay).
      // Observe-only — the auto-degrade ladder above owns the playback decisions; this is pure readout.
      if (DEBUG) post({
        type: 'pstats', ring: this.ring.length, cap: f.kind === 'vf' ? this.wcRingCap : this.swRingCap, presentFps: m.fps,
        presentIntervalMs: r1(m.meanMs), presentIntervalP95Ms: r1(m.p95Ms), presentIntervalMaxMs: r1(m.maxMs),
        presentStutters: m.stutters, presentSeamGaps: m.seamGaps,
        clockAdvanceFps, clockRateRatio, clockResidualMs: r1(this.clockResidualUs / 1000), rafFps, presentDropsPerSec,
        vsyncIntervalMs: r2(v.intervalMs), displayHz: v.adopted ? Math.round(v.hz) : 0,
        cadenceHoldMean, cadenceHold2Frac, cadenceErrorMs: r2(Math.abs(this.cadenceErrorMs)), syncResyncsPerSec,
        cadenceTier: effectiveTier, cadenceDrawRate, cadenceDegradeReason: this.cadenceDegradeReason,
        cadenceRung: this.degradeRung, // the graduated auto-degrade rung (0 none·1 skip-non-ref·2 +skip-loop·3 +present-cap)
      });
    }
  }

  // ---- control (from main) ---------------------------------------------------

  setPaused(paused: boolean): void { this.paused = paused; }

  /** Lever 1 MANUAL override: force the tier-2 present-rate cap ON/OFF independent of
   *  the auto-degrade trigger. A toggle change flips the ACTIVE tier, so re-seed the Bresenham accumulator
   *  + hold at the new displayed period (no carried phase error from the prior tier) — exactly as the auto
   *  1→2 transition does. A session control: it is NOT cleared by reset() (unlike the auto tier). */
  setManualHalf(on: boolean): void {
    if (this.manualHalf === on) return;
    this.manualHalf = on;
    this.cadenceErrorMs = 0;
    this.holdRemaining = 0;
  }

  /** Flush the ring (release software slots / close VideoFrames) + re-arm the present clock so the
   *  next frame re-anchors a fresh timeline. Sent on (re)load / unload / seek / live-resume. */
  reset(gen: number): void {
    this.gen = gen;
    if (this.ring.length) {
      const released: number[] = [];
      for (const f of this.ring) this.releaseFrame(f, released);
      this.ring = [];
      this.postReleases(released); // LIVE-WC: also carries the vf-closed count back to the decode worker
    }
    this.lastTs = 0;
    this.lastDrawnPts = -1;
    this.anchored = false;
    this.mediaAnchorPtsUs = 0;
    this.mediaUs = 0;
    this.audioLocked = false;
    this.graceTicks = 0;
    this.vfW = 0; this.vfH = 0;
    // Cadence: a (re)load/seek/live-resume starts a fresh measurement → clear the rolling buffer +
    // PTS-delta window and drop the prior-draw stamp so the cross-reset wall gap is NOT counted as a
    // present interval (the next draw has no predecessor → interval null) and an old period can't leak
    // through. A deliberate reset is a clean slate, not a seam gap (those are the mid-stream re-anchors).
    this.lastDrawAt = 0;
    this.cadence = [];
    this.cadencePtsDeltas = [];
    this.lastPushPtsUs = -1; // fresh timeline → the content-period estimator restarts from the next arrival
    this.decodeContentPeriodUs = 0; // re-derived from the new stream's first packet period (the manual override persists)
    this.seamPending = false;
    // Display cadence: a (re)load/seek/live-resume is a fresh timeline → clear the Bresenham state so the
    // next anchored front re-seeds from zero phase. The vsync ESTIMATOR is intentionally NOT reset — the
    // display refresh doesn't change across a media seam, so the cadence re-engages immediately (no fresh
    // ~1.7 s warmup), and a never-stranded holdRemaining can't leak a stale count into the new clip.
    this.cadenceActive = false;
    this.cadenceErrorMs = 0;
    this.holdRemaining = 0;
    this.cadenceHolds = [];
    this.audioDriving = false;
    // SYNC-GUARD hysteresis: a fresh timeline → re-arm the sustain counter + cooldown (no stale desync /
    // cooldown leaking across the re-anchor; the first post-reset behind-excursion must re-qualify).
    this.syncBehindTicks = 0;
    this.lastResyncTs = 0;
    // GRACEFUL-DEGRADATION: a (re)load/seek/live-resume is a fresh decision point → RE-ARM the ladder to
    // rung 0 and let it re-detect (so a degraded rung never strands onto a healthy new clip, and the "never
    // degrade a healthy stream" invariant holds per-timeline). Within a CONTINUOUS stream (across seams,
    // which don't call reset()) the rung persists — no flapping. A true (re)load recreates the worker.
    this.degradeRung = RUNG_NONE;
    this.ladderClimbMs = 0;
    this.ladderDropMs = 0;
    this.cadenceTier = CADENCE_TIER_FULL;
    this.cadenceDegradeReason = DEGRADE_REASON_NONE;
    this.ringLowWater = Infinity;
    this.underDelivering = false;
    // Re-arm the demux-ring trigger for the fresh timeline AND retract the auto-engaged decode
    // skips on the decode worker (if we had fanned them out) so a degraded tier never strands onto a
    // healthy new clip. The decode worker ALSO self-clears its auto skips on a fresh load (run()); this
    // covers seek / live-resume, where the decode worker is not reloaded. The MANUAL skips are untouched
    // (the decode worker OR-folds them; this only retracts the AUTO bit). Idempotent (off when not engaged).
    this.demuxRingBytes = 0;
    this.demuxRingTrend = [];
    if (this.autoSkipsEngaged) {
      this.autoSkipsEngaged = false;
      this.port.postMessage({ type: 'autoSkips', skipNonref: false, skipLoop: false });
    }
    // Clock/draw instrument: re-anchor the post window so the cross-reset wall gap isn't read as a
    // present interval, and invalidate clock-advance for the window spanning the re-anchor.
    this.lastNowUs = 0;
    this.clockResidualUs = 0;
    this.wTs = 0; this.wNowUs = 0; this.wClockBroke = true;
  }

  /** Tear down: stop the rAF loop, CLOSE every WebCodecs VideoFrame still in the ring (frees the HW output
   *  pool), dispose GL, detach the port. Returns `framesClosed` (the count it actually closed)
   *  so main's `destroyed` ack confirms the ring emptied — the OWNER-CONFIRMED openVideoFrames → 0 (a
   *  software 'yuv' frame holds a heap-slot token, not a VideoFrame, so it isn't counted here). */
  destroy(): number {
    if (this.destroyed) return 0;
    this.destroyed = true;
    if (this.rafId) g.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    let framesClosed = 0;
    for (const f of this.ring) if (f.kind === 'vf') { try { f.frame.close(); framesClosed++; } catch { /* closed */ } }
    this.ring = [];
    this.renderer.dispose();
    this.port.onmessage = null;
    return framesClosed;
  }
}

let presenter: Presenter | null = null;

self.onmessage = (e: MessageEvent<MainToPresent>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'present-init':
      try {
        presenter = new Presenter(msg.canvas, msg.port, msg.clock, msg.wcRingCap, msg.swRingCap);
      } catch (err) {
        post({ type: 'error', message: 'present-init: ' + (err instanceof Error ? err.message : String(err)) });
      }
      break;
    case 'setPaused':
      presenter?.setPaused(msg.paused);
      break;
    case 'setLever':
      presenter?.setManualHalf(msg.present); // Lever 1 manual present=half override
      break;
    case 'reset':
      presenter?.reset(msg.gen);
      break;
    case 'destroy': {
      const framesClosed = presenter?.destroy() ?? 0; // count of VideoFrames it close()d emptying the ring
      presenter = null;
      post({ type: 'destroyed', framesClosed }); // no engine/pool here → ack immediately (owner-confirmed)
      break;
    }
  }
};
