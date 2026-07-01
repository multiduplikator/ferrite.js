// The persistent AudioWorkletProcessor (audio SAB-ring consumer) + its blob-URL builder. TS twin of
// the reference player's audio worklet.
//
// AudioWorklet runs in the AudioWorkletGlobalScope — a separate realm with no module system — so the
// processor is a small JS shim loaded from a `blob:` URL (exactly as the reference player does it; there it's because
// wasm can't compile into that realm, here it's because the worklet can't import TS). It is the CONSUMER
// half of the `audio-ring` contract; the decode worker is the producer. The protocol constants are
// INTERPOLATED from `audio-ring.ts` / `protocol.ts` into the source string at build time, so the two halves
// can NEVER drift on slot indices, channel count, or the clock formula (only the exported consts are
// interpolated — never hand-typed literals — so a const change propagates here automatically; see
// tests/audio_ring.mjs and the worklet-source test).
//
// Per render quantum the processor: drops a stale producer epoch (jump read→write on a RW_GEN change);
// emits silence + holds the cursor while paused (RW_PLAYING==0); else runs the mpv underrun-HOLD state
// machine (audio-ring's `underrunStep`, mirrored here in JS): copies the readable frames from the
// interleaved-stereo ring into the output (silence-filling any shortfall) and advances RW_READ by the REAL
// frames played ONLY — so on a shortfall the played-frames clock HOLDS at the last real PTS through the gap
// (mpv's `ao_get_delay → 0` pin) instead of racing ahead through silence. A shortfall LATCHES a hold; output
// resumes only once the ring refills past the high-water (UNDERRUN_RESUME_SECS, mpv's `mp_async_queue`-full
// resume). It counts ONE RW_UNDERRUNS per episode (the latching edge), and writes the media-PTS master clock
// `base + edgePts − (edgeFrame − read)/rate·1000` straight into the present worker's clock SAB
// (C_ACLOCK/C_AUDIO). `held` is cleared on a fresh epoch + on pause→play.

import {
  RING_CHANNELS, RING_CTRL_SLOTS, RW_BASE_MS, RW_EDGE_FRAME, RW_EDGE_PTS_MS, RW_EPOCH_SEQ,
  RW_GEN, RW_PLAYING, RW_RATE, RW_READ, RW_UNDERRUNS, RW_WRITE, UNDERRUN_RESUME_SECS,
} from '../audio-ring';
import { C_ACLOCK, C_AUDIO, C_OUTPUT_LATENCY_MS } from '../protocol';

/** The registered processor name — referenced by `new AudioWorkletNode(ctx, PROCESSOR_NAME, …)`. */
export const PROCESSOR_NAME = 'ferrite-audio';

/** The processor JS source, with the audio-ring/protocol constants baked in (single source of truth). */
function workletSource(): string {
  return `'use strict';
const CTRL=${RING_CTRL_SLOTS}, CH=${RING_CHANNELS};
const RW_WRITE=${RW_WRITE}, RW_READ=${RW_READ}, RW_UNDERRUNS=${RW_UNDERRUNS}, RW_BASE_MS=${RW_BASE_MS}, RW_PLAYING=${RW_PLAYING}, RW_RATE=${RW_RATE}, RW_GEN=${RW_GEN}, RW_EDGE_FRAME=${RW_EDGE_FRAME}, RW_EDGE_PTS_MS=${RW_EDGE_PTS_MS}, RW_EPOCH_SEQ=${RW_EPOCH_SEQ};
const C_ACLOCK=${C_ACLOCK}, C_AUDIO=${C_AUDIO}, C_OUTPUT_LATENCY_MS=${C_OUTPUT_LATENCY_MS}, RESUME_SECS=${UNDERRUN_RESUME_SECS};
class FerriteAudio extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const po = o.processorOptions;
    this.ctrl = new Int32Array(po.ring, 0, CTRL);
    this.data = new Float32Array(po.ring, CTRL*4);
    this.clock = new Int32Array(po.clock);
    this.cap = po.cap;
    this.gen = po.gen;
    this.lastBase = 0; this.lastEdgeFrame = 0; this.lastEdgePts = 0;
    this.held = false;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const q = out[0].length;
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const ctrl = this.ctrl, data = this.data, cap = this.cap;
    // New producer epoch (live re-anchor / fresh load): drop stale audio — jump read up to the producer
    // cursor — and adopt the generation.
    const gen = Atomics.load(ctrl, RW_GEN);
    if (gen !== this.gen) {
      this.gen = gen;
      Atomics.store(ctrl, RW_READ, Atomics.load(ctrl, RW_WRITE));
      this.held = false;
    }
    // Paused / degraded / not yet producing: silence + HOLD the cursor (clock frozen). Release the audio
    // master clock (C_AUDIO=0) so the present worker free-runs on video. The worklet is the SOLE writer of
    // the clock SAB — MAIN never writes C_ACLOCK/C_AUDIO — so there is no two-writer race; pause/AudioDegraded
    // just flip RW_PLAYING and the worklet does the rest.
    if (Atomics.load(ctrl, RW_PLAYING) === 0) {
      L.fill(0); if (R !== L) R.fill(0);
      Atomics.store(this.clock, C_AUDIO, 0);
      this.held = false;
      return true;
    }
    const write = Atomics.load(ctrl, RW_WRITE);
    let read = Atomics.load(ctrl, RW_READ);
    const rate = Atomics.load(ctrl, RW_RATE);
    const readable = Math.max(0, write - read);
    // mpv underrun-HOLD (audio-ring's underrunStep, mirrored here): advance read by the REAL frames played
    // ONLY (never the full quantum) so the read-derived clock HOLDS at the last real PTS through a gap instead
    // of racing ahead through silence. A shortfall LATCHES a hold — but only once audio has actually been
    // produced (write>0; a no-audio stream / pre-roll never latches) — and output resumes only once the ring
    // refills past the high-water (mpv's mp_async_queue-full resume).
    const resumeFrames = rate > 0 ? Math.ceil(RESUME_SECS * rate) : 0;
    let copy, advance, underran = false;
    if (this.held) {
      if (readable >= resumeFrames) { copy = Math.min(readable, q); advance = copy; this.held = false; }
      else { copy = 0; advance = 0; } // HOLD: pin read (clock frozen) until refilled past high-water
    } else {
      copy = Math.min(readable, q);
      advance = copy; // real frames only — silence never advances the clock (the mpv pin)
      if (copy < q && write > 0) { this.held = true; underran = true; } // latch the hold + count once
    }
    // Interleaved L,R data; copy the readable run in two contiguous spans (no per-sample modulo).
    const startPos = ((read % cap) + cap) % cap;
    const first = Math.min(copy, cap - startPos);
    for (let i = 0; i < first; i++) { const b = (startPos + i) * CH; L[i] = data[b]; R[i] = data[b + 1]; }
    for (let i = first; i < copy; i++) { const b = (i - first) * CH; L[i] = data[b]; R[i] = data[b + 1]; }
    for (let i = copy; i < q; i++) { L[i] = 0; R[i] = 0; }
    read += advance;
    Atomics.store(ctrl, RW_READ, read);
    // ONE underrun per EPISODE (the latching edge only, not every held quantum); gated on write>0 so a
    // no-audio stream / pre-roll silence never inflates the count.
    if (underran) Atomics.add(ctrl, RW_UNDERRUNS, 1);
    // media-PTS master clock → C_ACLOCK (elapsed playout ms): base + edgePts - (edgeFrame - read)/rate*1000,
    // walking back the output frames between the write edge and the read cursor so as the buffered audio
    // drains the clock advances at MEDIA rate (heard pts), not wall → video stays lip-synced. With the
    // underrun-HOLD, read advances only by real frames, so on a shortfall the clock HOLDS at the last real
    // position instead of extrapolating past the edge.
    if (rate > 0) {
      // seqlock: read the {base, edgeFrame, edgePts} clock-anchor tuple as a CONSISTENT snapshot (the
      // producer is a different thread). Retry while the seq is odd (mid-publish) or moved across the read;
      // bounded — fall back to the last good tuple (effectively never).
      let base = this.lastBase, edgeFrame = this.lastEdgeFrame, edgePts = this.lastEdgePts;
      for (let t = 0; t < 4; t++) {
        const s1 = Atomics.load(ctrl, RW_EPOCH_SEQ);
        if (s1 & 1) continue;
        const b = Atomics.load(ctrl, RW_BASE_MS);
        const ef = Atomics.load(ctrl, RW_EDGE_FRAME);
        const ep = Atomics.load(ctrl, RW_EDGE_PTS_MS);
        if (Atomics.load(ctrl, RW_EPOCH_SEQ) === s1) {
          base = b; edgeFrame = ef; edgePts = ep;
          this.lastBase = b; this.lastEdgeFrame = ef; this.lastEdgePts = ep;
          break;
        }
      }
      // raw = heard PTS at the read cursor; subtract AudioContext.outputLatency (the out-of-ring device
      // buffer) so C_ACLOCK = TRUE AUDIBLE position (mpv written − ao_get_delay). Clamp ≥ 0 so a small-PTS
      // start (VOD from 0) can't push the clock negative; C_AUDIO stays on raw so the has-audio flag still
      // flips the instant audio is producing, latency notwithstanding.
      const raw = base + edgePts - (edgeFrame - read) * 1000 / rate;
      const lat = Atomics.load(this.clock, C_OUTPUT_LATENCY_MS);
      Atomics.store(this.clock, C_ACLOCK, Math.round(Math.max(0, raw - lat)));
      Atomics.store(this.clock, C_AUDIO, raw > 0 ? 1 : 0);
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', FerriteAudio);
`;
}

/** Build a `blob:` object URL for the processor module. Caller must `URL.revokeObjectURL` it once
 *  `audioWorklet.addModule()` has resolved (the module is compiled by then). */
export function workletUrl(): string {
  const blob = new Blob([workletSource()], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

/** Exposed for the headless test: the interpolated source must carry the real exported constants (so the
 *  producer and consumer can't drift). Not used at runtime. */
export const __workletSourceForTest = workletSource;
