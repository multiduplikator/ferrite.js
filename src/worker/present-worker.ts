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
  ladderStep, demuxRingPressure, rungDecimation,
  RUNG_NONE, RUNG_L2, RUNG_L2_L1, RUNG_L2_L1_L3, LADDER_L1_MIN_FPS,
  shouldLateDrop, shouldAheadHold, preAudioClockAdvance, isClockDiscontinuity, pllCorrectionPerTick,
  rung4Severe, RUNG4_SUSTAIN_MS, RUNG4_REARM_MS, RUNG4_SEVERE_FRAC,
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
// Clock-lock tuning (mpv adjust_sync / last_seek_pts). The audio master clock C_ACLOCK is now the ABSOLUTE
// media PTS (worklet-written), so the present clock locks to it directly + slews via the CLAMPED adjust_sync
// PLL (pllCorrectionPerTick, player_core::cadence). The near/far gain consts live there.
const CLOCK_DISC_SNAP_US = 5_000_000;        // LIVE-only: residual >5s = a discontinuity (loop/splice) → snap, don't
                                             // slew (mpv reset_playback_state threshold; the clamped PLL absorbs sub-5s steps)
const SEEK_LOCK_WINDOW_US = 5_000_000;       // VOD seek-hold: a post-seek C_ACLOCK within this of the target releases the hold
const SEEK_HOLD_MAX_TICKS = 240;             // ~4s @60fps backstop: release the seek-hold even if no anchor lands
const DISC_FLUSH_KEEP_US = 3_000_000;        // after a disc-snap, evict ring frames more than this from the snapped clock

// A ring frame — a tagged union so BOTH decode tiers share the ring/eviction/seam/clock. Only the
// per-frame payload + how it is RELEASED differ: a software 'yuv' frame names a HELD decoder frame
// (token) whose Y|U|V planes live at heap offsets `ptrs` (native byte strides `lns`, bit depth `bitDepth`)
// in the engine's shared heap — released back to the decode worker by token (which unrefs the held frame
// + grants a credit); a 'vf' frame's VideoFrame is CLOSED (frees the HW output pool). The yuv frame
// is TRUE ZERO-COPY — the GL upload reads the native-stride/native-bit-depth planes straight from the heap.
/** Display (DAR-correct) width from a base width × sample aspect (anamorphic). The canvas BACKING is sized
 *  to this; the texture stays at its source dims, so the GPU sampler stretches non-square pixels. 1:1 /
 *  unknown SAR returns the base width. (Mirrors gl.ts displayW — the present worker computes the WC tier's
 *  SAR-applied backing width here and hands it to drawFrame.) */
function displayW(baseW: number, sarNum: number, sarDen: number): number {
  if (sarNum > 0 && sarDen > 0 && sarNum !== sarDen) return Math.round(baseW * sarNum / sarDen);
  return baseW;
}

/** Re-wrap a hardware VideoFrame so its display dims equal its visible (`w`×`h`) dims — neutralizing a HW
 *  decoder that stamps a bogus displayWidth/Height/visibleRect (Edge's HEVC path reports a constant 1280×720
 *  for every frame). texImage2D(VideoFrame) sizes the texture from the frame's display dims, so without this
 *  the texture is built at the wrong size and mismaps onto the viewport (Chrome reports display == visible, so
 *  it never needs this). Returns a NEW frame over the SAME underlying media (corrected metadata, NO pixel
 *  copy) that the caller MUST close after uploading; null if construction fails (caller uploads the original). */
function rewrapDisplay(frame: VideoFrame, w: number, h: number): VideoFrame | null {
  try {
    return new VideoFrame(frame, {
      visibleRect: { x: 0, y: 0, width: w, height: h },
      displayWidth: w,
      displayHeight: h,
    });
  } catch { return null; }
}

type RingFrame =
  | { kind: 'yuv'; ptsUs: number; w: number; h: number; cw: number; ch: number; bitDepth: number; colorspace: number; colorRange: number; colorTrc: number; sarNum: number; sarDen: number; token: number; ptrs: [number, number, number]; lns: [number, number, number] }
  | { kind: 'vf'; ptsUs: number; frame: VideoFrame; sarNum: number; sarDen: number };

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
  private buffering = false; // mpv cache-pause: freeze the clock (hold the frame) while the audio output rebuffers
  private isLive = false;    // set per-load via the reset msg — gates the discontinuity machinery (clock-disc-snap,
                             // the SEAM re-anchor, the vod_audio_stall hold). VOD has none of it (monotonic timeline).
  private discFlushPending = false; // a live disc-snap just reset the clock → tick() evicts stale old-origin ring frames
  // VOD seek-hold (mpv last_seek_pts): park the clock at the seek target until a genuine post-seek audio anchor
  // lands, so present never locks onto the transient/stale C_ACLOCK during the cross-worker audio re-anchor.
  private seekHold = false;
  private seekTargetUs = 0;
  private seekHoldTicks = 0;
  private gen = 0;                 // current load gen (filters a stale dropVideoFrames)
  private destroyed = false;

  // ---- present clock (faithful port of WorkerPresenter::tick) ----
  private lastTs = 0;
  private lastDrawnPts = -1;
  private anchored = false;        // the media clock has captured its first-frame PTS anchor
  private mediaAnchorPtsUs = 0;    // pts_anchor_us — first presented frame's PTS (relative epoch)
  private mediaUs = 0;             // smoothed media clock (µs): rAF-advanced, PLL-locked to the audio sample
  private audioLocked = false;     // the media clock has been INITIALISED from the audio epoch
  private audioDriving = false;    // this tick the media clock came from the AUDIO master (not wall/frame-pace)

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
  private syncResyncs = 0;              // cumulative VO late-drop re-seeds (the front fell behind the audio clock)
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
  private lastPushPtsUs = -1;           // last decoded-frame PTS pushed (content-period estimator, decimation-independent)
  // The DEMUX-RING latency signal the auto-degrade trigger runs on (the real "decode behind
  // ingest → audio starves" signal, routed from the decode worker on each frame). `demuxRingBytes` is the
  // latest depth; `demuxRingTrend` is a small ~DEGRADE_RING_TREND_MS window of (at, bytes) samples (one per
  // pstats post) whose MIN gives the growth delta. `autoSkipsEngaged` tracks whether we have fanned the decode skips
  // out to the decode worker, so reset() can cleanly retract them (a fresh timeline re-arms the trigger).
  private demuxRingBytes = 0;
  private demuxRingTrend: { at: number; bytes: number }[] = [];
  private autoSkipsEngaged = false;
  // ---- Fix-B rung-4: Live drop-to-keyframe (SOFTWARE tier only) ----
  // `pushes` = cumulative DECODE-INTAKE frames (each pushYuv/pushVf), uncapped by the present-cap — over a
  // window it gives the TRUE decode-delivery rate even when audio holds the clock at realtime (the judder
  // case). `lastFrameWasSw` tracks the current tier (software frame ⇒ true, WC frame ⇒ false) — rung-4 is
  // SOFTWARE-only (the WC tier is owned by the wc-stall watchdog). The sustain/re-arm/fires state gates the
  // PresentToDecode 'dropToKeyframe' fire to a sustained-severe deficit, thrash-damped by a min re-arm.
  private pushes = 0;            // cumulative decode-intake frames (the decode-delivery rate baseline)
  private wPushes = 0;           // `pushes` at the last pstats post (the per-window decodeFps delta baseline)
  private hasLiveEdge = false;   // realtime-rigid timeline (set per-load via the reset msg) — rung-4 is live-only
  private lastFrameWasSw = false; // current tier (set per intake: software frame ⇒ true, WC frame ⇒ false)
  private rung4SustainMs = 0;    // continuous severe-deficit time at RUNG_MAX (resets on any non-severe window)
  private rung4LastFireTs = 0;   // ts of the last drop-to-keyframe fire (arms the re-arm interval); 0 = none
  private rung4Fires = 0;        // drop-to-keyframe fires this load (monotonic telemetry → cadenceDropToKey)

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
    this.pushes++; this.lastFrameWasSw = true; // software tier (gates the Fix-B rung-4 drop-to-keyframe)
    this.feedContentPeriod(m.ptsUs);
    const frame: RingFrame = { kind: 'yuv', ptsUs: m.ptsUs, w: m.w, h: m.h, cw: m.cw, ch: m.ch, bitDepth: m.bitDepth, colorspace: m.colorspace, colorRange: m.colorRange, colorTrc: m.colorTrc, sarNum: m.sarNum, sarDen: m.sarDen, token: m.token, ptrs: m.ptrs, lns: m.lns };
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
    this.pushes++; this.lastFrameWasSw = false; // WebCodecs (HW) tier — rung-4 is owned by the wc-stall watchdog
    this.feedContentPeriod(m.ptsUs);
    const frame: RingFrame = { kind: 'vf', ptsUs: m.ptsUs, frame: m.frame, sarNum: m.sarNum, sarDen: m.sarDen };
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
    // mpv cache-pause: while the audio output is rebuffering (MAIN set RW_PLAYING=0 → the worklet released
    // C_AUDIO=0), FREEZE the clock at its current position (hold the frame) instead of free-running on the
    // wall clock via the no-audio branch below. Distinct from `paused` (user intent): freeze on EITHER.
    if (this.buffering) return this.mediaUs;
    // VOD seek hold (mpv last_seek_pts): keep the clock parked at the target — showing the post-seek keyframe
    // video — until C_ACLOCK reflects a genuine post-seek audio anchor (near the target). Ignores the
    // transient/stale C_ACLOCK the audio producer briefly publishes during the cross-worker re-anchor. A
    // backstop tick cap releases the hold even if no anchor lands (failed seek), so it can't freeze forever.
    if (this.seekHold) {
      this.seekHoldTicks++;
      const rawUs = Atomics.load(this.clock, C_ACLOCK) * 1000;
      const hasAudioNow = Atomics.load(this.clock, C_AUDIO) > 0;
      const postSeekAnchor = hasAudioNow && rawUs > 0 && Math.abs(rawUs - this.seekTargetUs) < SEEK_LOCK_WINDOW_US;
      if (postSeekAnchor || this.seekHoldTicks > SEEK_HOLD_MAX_TICKS) {
        this.seekHold = false;
        this.audioLocked = false; // re-lock to the now-valid audio clock on the fall-through below
        // Drop mediaUs to the real clock so the fall-through max() locks to reality, not the held target —
        // matters on a FAILED seek (audio sits unchanged; else the held-high target forces a backward slew).
        if (rawUs > 0) this.mediaUs = rawUs;
      } else {
        this.mediaUs = this.seekTargetUs; // hold at target; show the post-seek keyframe frames
        return this.seekTargetUs;
      }
    }
    const hasAudio = Atomics.load(this.clock, C_AUDIO) > 0;
    const rawUs = hasAudio ? Atomics.load(this.clock, C_ACLOCK) * 1000 : 0; // ms → µs
    // VIDEO leads at startup, audio JOINS aligned, exactly like mpv (handle_playback_restart: the first video
    // frame establishes the clock; the AO joins). Ferrite can't delay the autonomous AudioWorklet the way mpv
    // delays its AO, so the symmetry is built on the PRESENT side: video free-runs from frame 1 (NO hold), and
    // the first audio lock is a BOUNDED, NEVER-FORWARD-SKIP, disc-snap-immune settle that converges the startup
    // A/V offset via the PLL. Snapping media_us to the audio epoch would drop every already-buffered video frame
    // → a frozen frame with running audio at startup (worst on HEVC where HW decode latency lets audio lead).
    if (hasAudio && rawUs > 0) {
      // --- audio is AUDIBLE: it drives / joins the master clock ---
      this.audioDriving = true;
      // C_ACLOCK is the ABSOLUTE played-audio PTS (base + edgePts − buffered) on the SAME timeline as the video
      // frame PTS — use it DIRECTLY (adding the video anchor double-counts the origin → a fixed ~first-PTS A/V
      // offset; absolute video frames already line up at av≈0).
      const target = rawUs;
      if (!this.audioLocked) {
        // JOIN. With the mpv audio_start_ao gate on MAIN, audio output is released only once the video clock has
        // reached the audio first-sample PTS, so the clock is already aligned here — keep media_us where video
        // put it (NEVER jump). Only seed from the audio epoch if video produced nothing (audio-only / audio-first).
        if (this.mediaUs <= 0) this.mediaUs = target;
        this.audioLocked = true;
      } else if (!this.paused) {
        this.mediaUs += dt * 1000;                          // smooth rAF advance (dt ms → µs)
        this.clockResidualUs = target - this.mediaUs;       // instrument: the PLL error BEFORE the correction
        if (isClockDiscontinuity(this.isLive, this.clockResidualUs, CLOCK_DISC_SNAP_US)) {
          // DISCONTINUITY (loop / reconnect / ad splice) — LIVE ONLY. The audio clock RESET to the new content's
          // PTS, a large step → SNAP, don't slew (slewing strands the clock for seconds → freeze then rush). On
          // VOD the timeline is monotonic + contiguous, so a >5s residual is a transient excursion, not a
          // discontinuity — snapping there desyncs + floods credits; VOD always slews via the PLL.
          this.mediaUs = target;
          this.lastDrawnPts = -1; // force a fresh front draw at the new origin
          this.cadenceErrorMs = 0;
          this.holdRemaining = 0;
          this.discFlushPending = true; // tick() drops the stale pre-seam frames from the ring
        } else {
          // mpv adjust_sync: nudge the clock toward the audio position by a correction CLAMPED to a fraction of
          // one content frame period (±frame·{0.1,0.4}), prorated to this rAF tick's share of a frame. The
          // audio_start_ao gate keeps the JOIN aligned, so the steady-state residual is small jitter the
          // near-gain de-jitters; a genuine sub-5s step (e.g. a 4s splice) slews over many frames, exactly mpv.
          const framePeriodUs = this.decodeContentPeriodUs > 0 ? this.decodeContentPeriodUs : this.contentDurMs() * 1000;
          this.mediaUs += pllCorrectionPerTick(this.clockResidualUs, framePeriodUs, dt * 1000);
        }
      }
      return this.mediaUs;
    }
    // --- no AUDIBLE audio yet: the clock is FRAME-PACED, not a wall free-run (mpv restart alignment) ---
    // mpv never advances the master on a wall clock independent of frames. A wall free-run would race media_us
    // ahead of slow-arriving frames → audio released (the audio_start_ao gate, current_ms>=apts) over a still-
    // BLACK canvas. Instead: wall-pace but CLAMP to the newest decoded frame (preAudioClockAdvance) so the clock
    // can't sail past real frames — yet it KEEPS advancing (never a hard freeze, which would deadlock the
    // audio_start_ao gate: the front must retire so current_ms climbs to apts). Three cases, one path: (1) audio
    // present but not yet heard at startup; (2) a genuinely video-only stream; (3) audio dropped MID-STREAM —
    // live chases the edge (clamped), VOD HOLDS (rebuffer catches it).
    this.audioDriving = false;
    const vodAudioStall = !this.isLive && this.audioLocked;
    if (this.mediaUs <= 0) {
      this.mediaUs = this.mediaAnchorPtsUs; // seed on the first video frame's PTS
    } else if (!this.paused && !vodAudioStall) {
      const newest = this.ring.length ? this.ring[this.ring.length - 1].ptsUs : this.mediaUs;
      this.mediaUs = preAudioClockAdvance(this.mediaUs, dt, newest);
    }
    return this.mediaUs;
  }

  // ---- present loop ----------------------------------------------------------

  private tick(ts: number): void {
    this.rafId = g.requestAnimationFrame(this.boundTick);
    this.rafTicks++; // instrument: TOTAL present-loop callbacks (rafFps = the draw headroom vs distinct draws)
    const dt = this.lastTs === 0 ? 0 : ts - this.lastTs;
    this.lastTs = ts;
    this.vsync.push(dt); // feed the display-refresh estimator (it guards dt≤0 / pause-gap internally)
    this.ringLowWater = Math.min(this.ringLowWater, this.ring.length); // present-ring draining signal (feeds the degrade ladder's ring-low gate)
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
    // The Bresenham display cadence runs on the CONTIGUOUS present ring. (An earlier gapped ring — decode
    // dropping frames at the live edge, punching PTS holes the cadence stranded on — was the cause of a
    // reintroduced freeze; it is fixed by the no-drop credit coupling in worker.ts, so the cadence works as designed.)
    // Engages once the real refresh is measured-stable (mpv gates display-resample on vsync confidence the
    // same way); until adopted the proven audio-timed retire-by-pts path runs, so the warmup is unchanged.
    const cadenceMode = this.vsTick.adopted;
    // If the cadence ever DISENGAGES (the measured refresh left the sane band / collapsed — e.g. a mid-
    // playback monitor/refresh change), drop cadenceActive so the legacy path runs and a later re-engage
    // re-seeds the hold cleanly (no stale holdRemaining carried across the legacy interlude).
    if (!cadenceMode) this.cadenceActive = false;

    const released: number[] = [];
    // A live disc-snap (mediaUsNow) just reset the clock to the new content's origin → evict any ring frame
    // still on the OLD origin (far from `now`); otherwise the present HOLDs on a stale far-future frame (the
    // freeze the real-fixture loop showed). Keep frames near the new origin (already-decoded new content) so
    // the recovery is a brief gap, not a re-decode stall.
    if (this.discFlushPending) {
      this.discFlushPending = false;
      while (this.ring.length && Math.abs(this.ring[0].ptsUs - now) > DISC_FLUSH_KEEP_US) {
        this.dropped++;
        this.releaseFrame(this.ring.shift()!, released);
      }
      this.lastDrawnPts = -1;
      if (this.ring.length === 0) { this.postReleases(released); return; }
    }
    // SEAM detection (LIVE ONLY): a PTS discontinuity between adjacent ring frames is a failover/splice
    // → re-anchor the clock epoch onto the new timeline (instead of flushing it as "ancient"). In legacy
    // mode this loop ALSO retires every frame whose ptsUs ≤ now (the old behaviour); in cadence mode it
    // only handles seams and the Bresenham step below drives retirement (so we never advance >1 frame/tick).
    while (this.ring.length >= 2) {
      const gap = this.ring[1].ptsUs - this.ring[0].ptsUs;
      // LIVE ONLY: a large ring PTS gap on live = a loop/splice/reconnect boundary the clock must jump to.
      // VOD is monotonic + contiguous (a seek resets the ring epoch separately), so a gap there is not a
      // discontinuity to re-anchor on — overriding the audio clock with the ring PTS would desync.
      if (this.isLive && (gap > SEAM_FWD_US || gap < -SEAM_BACK_US)) {
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
    if (this.paused || this.buffering) return; // frozen front (user pause OR rebuffer) — no advance/countdown

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

    // AXIS 1 — mpv VO late-drop (render_frame). When an audio master is live, DROP front frames whose display
    // window has passed the master clock so the DISPLAYED video tracks the audio clock — keeping the audio clock
    // authoritative (mpv's "drop video, never freeze the clock"). mpv's ONLY two guards (faithful): don't drop
    // when paused, and the "rather degrade to ~10 fps than freeze forever" floor — never let > PRESENT_FLOOR_MS
    // pass without an actual present (above it, SHOW the late frame). NO sustain/cooldown/under-delivery
    // suppression: the DECODE-LOAD relief is Axis 2 (the degrade ladder), so Axis 1 is free to hold sync
    // per-frame without self-inflicted churn (shouldLateDrop, player_core::cadence).
    if (this.audioDriving && this.lastDrawnPts >= 0) {
      const framePeriodUs = this.contentDurMs() * 1000;
      // wall ms since the last ACTUAL present (lastDrawAt is stamped only on a new-frame draw) = mpv's
      // `now - prev_vsync`. Constant across the drop loop below (dropping never draws), so the floor forces
      // exactly one present per PRESENT_FLOOR_MS.
      const msSincePresent = this.lastDrawAt > 0 ? ts - this.lastDrawAt : 0;
      let droppedAny = false;
      while (shouldLateDrop(now - this.ring[0].ptsUs, framePeriodUs, msSincePresent, this.paused, this.ring.length)) {
        const old = this.ring.shift()!; // shouldLateDrop guards ring.length >= 2
        if (old.ptsUs !== this.lastDrawnPts) this.dropped++;
        this.releaseFrame(old, released);
        droppedAny = true;
      }
      if (droppedAny) {
        // The new front is the frame nearest the clock — re-seed the Bresenham cadence onto it.
        this.lastDrawnPts = -1;
        this.cadenceErrorMs = 0;
        this.holdRemaining = 0;
        this.syncResyncs++;
      }
      // AHEAD: the front runs ahead of the audio master → HOLD this tick (repeat the current front) so
      // media_us catches up, converging the offset to < 1 vsync instead of latching at the old 120 ms
      // ahead-guard. mpv display-sync tolerance (>= 20 ms AND >= 1 vsync); bounded by PRESENT_FLOOR_MS like
      // the behind-side late-drop so a large VOD residual can't freeze the frame. (shouldAheadHold =
      // the mirror of shouldLateDrop.)
      if (shouldAheadHold(
        this.ring[0].ptsUs - now, // frontAheadUs (>0 ⇒ the front is ahead of the clock)
        this.vsTick.intervalMs * 1000,
        msSincePresent,
        this.paused,
        this.ring.length,
      )) return;
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
        this.renderer.draw(y, yRow, u, uRow, v, vRow, f.w, f.h, f.cw, f.ch, f.bitDepth, f.colorspace, f.colorRange, f.colorTrc, f.sarNum, f.sarDen);
      } else {
        const y = new Uint8Array(buf, f.ptrs[0], yRow * f.h);
        const u = new Uint8Array(buf, f.ptrs[1], uRow * f.ch);
        const v = new Uint8Array(buf, f.ptrs[2], vRow * f.ch);
        this.renderer.draw(y, yRow, u, uRow, v, vRow, f.w, f.h, f.cw, f.ch, f.bitDepth, f.colorspace, f.colorRange, f.colorTrc, f.sarNum, f.sarDen);
      }
    } else {
      // WC GEOMETRY: BROWSER-PRIMARY, CODED-VERIFIED. The caller owns the VideoFrame; it is closed on RETIRE,
      // not here. texImage2D(VideoFrame) sizes the GL texture from the frame's DISPLAY dims. An honest browser
      // reports them correctly (conformance-cropped, container-aware) → we trust them and do nothing (no
      // per-frame alloc). A broken HW decoder can lie about display/visibleRect (Edge's HEVC path stamps a
      // constant bogus 1280×720), but it still reports codedWidth/Height correctly — so the frame's OWN coded
      // buffer is a fresh, per-frame ground truth (no caching → no staleness across a mid-stream resolution change).
      //
      // Detect the lie on the SAR-IMMUNE HEIGHT axis ONLY: a real conformance crop is < 1 coding-tree-unit
      // (≤63px; HEVC CTU 64, H.264 MB 16), so a height disagreement > 64px is structurally impossible for a crop
      // → the decoder is lying. Width is deliberately NOT compared — it's SAR-ambiguous (some browsers pre-apply
      // SAR to displayWidth, some report square-pixel), and the backing width is codedW × SAR regardless, so the
      // texture maps onto it correctly either way (the quad samples 0..1). Override = size off coded + re-wrap
      // the upload to coded; else keep the browser's true cropped height (e.g. 1080, not the padded coded 1088).
      const MAX_CONFORMANCE_CROP = 64; // 1 CTU — the structural ceiling on a legitimate crop, NOT a tuned threshold.
      const codedW = f.frame.codedWidth, codedH = f.frame.codedHeight;
      const bh = f.frame.displayHeight;
      const lying = bh === 0 || Math.abs(codedH - bh) > MAX_CONFORMANCE_CROP;
      const dispH = lying ? codedH : bh;
      // Vdims carries the SQUARE-PIXEL width (main's videoWidth getter applies SAR); the GL backing applies SAR
      // itself via displayW. Both resolve to the same on-screen display width.
      if (codedW !== this.vfW || dispH !== this.vfH) {
        this.vfW = codedW; this.vfH = dispH;
        post({ type: 'vdims', w: codedW, h: dispH });
        // One-shot breadcrumb (per dims change) only when overriding a lying decoder — silent on honest browsers.
        if (lying && DEBUG) post({ type: 'plog', m: `[wc] HW display height ${bh} != coded ${codedH} → override+re-wrap (coded ${codedW}x${codedH})` });
      }
      // Re-wrap ONLY when overriding a lying decoder, so texImage2D uploads the full coded frame instead of the
      // bogus display region (a cheap metadata view over the SAME media — no pixel copy). Honest browsers skip
      // this entirely → no per-frame alloc. LIMITATION (rare, low severity, no fix): if a lying decoder's coded
      // buffer is padded, the override uploads the padding rows — the true crop is unknowable (visibleRect is
      // also bogus). Still strictly better than the 1280×720 mismap.
      const corrected = lying ? rewrapDisplay(f.frame, codedW, codedH) : null;
      // Backing: SAR-applied display width × the display height.
      this.renderer.drawFrame(corrected ?? f.frame, displayW(codedW, f.sarNum, f.sarDen), dispH);
      if (corrected) corrected.close(); // free the temp wrapper; the original stays in the ring for RETIRE
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
    // Throttled currentTime → main, carrying the SAME-INSTANT A/V difference (master clock − this just-drawn
    // frame's PTS). Both reads are live here (lastNowUs = this tick's clock, f.ptsUs = the frame we just drew),
    // so MAIN gets a consistent lip-sync reading instead of subtracting a stale current_ms from a fresh audio
    // clock (mpv update_av_diff: a_pos − video_pts, one call).
    if (ts - this.lastTimePost >= TIME_POST_MS) {
      this.lastTimePost = ts;
      post({ type: 'time', ms: f.ptsUs / 1000, avDiffMs: (this.lastNowUs - f.ptsUs) / 1000 });
    }
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
      // GRACEFUL-DEGRADATION LADDER (graduated, axis-separated; PURE decision in ladderStep). Axis-2 of the
      // two-axis decode-bound handling: rung-1 (skip-non-ref) IS mpv check_framedrop, gated on the INSTANTANEOUS
      // forward headroom at the ring BACK (unmasked by the Axis-1 VO late-drop); the heavier rungs (+present-cap
      // HALVE for fast content / +skip-deblock) climb on a SUSTAINED throughput deficit and de-escalate in strict
      // reverse on sustained headroom. A capable stream stays at rung0; a present-side stall (ring pinned full)
      // can never trip it.
      const contentRate = contentPeriodMs > 0 ? 1000 / contentPeriodMs : 0;
      // Present-ring watermarks (this post window): LOW = draining (decode can't keep the ring full); HEALTHY
      // = stayed comfortably full (room to give a lever back); FULL = pinned at ~cap (a present-side stall).
      // The dead-band between LOW and HEALTHY prevents the ladder flapping on a ring hovering near the line.
      const ringCap = f.kind === 'vf' ? this.wcRingCap : this.swRingCap;
      const lowRing = this.ringLowWater <= Math.max(3, ringCap >> 2);
      const ringHealthy = this.ringLowWater >= Math.max(4, ringCap >> 1);
      const presentRingFull = this.ringLowWater >= ringCap - 1;
      const activeTier = this.activeTier();
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
        // decodeFps = TRUE decode-DELIVERY rate (distinct intake frames / wall) — UNCAPPED by the present-cap,
        // so it exposes a decode deficit even when audio holds the clock at realtime (the judder case).
        const decodeFps = (this.pushes - this.wPushes) * 1000 / dWall;
        // The present-cap tier that WOULD apply one rung down (so the ladder can gate un-halving on real
        // capacity). Content-aware: halve only at rung ≥ 2 for fast content (mirrors the lever map below).
        const l1Ok = contentRate >= LADDER_L1_MIN_FPS;
        const decimLower = rungDecimation(this.degradeRung - 1, contentRate);
        const prevRung = this.degradeRung;
        const prevTier = this.cadenceTier;
        // Axis-2 rung-1 (mpv check_framedrop) signal: how far the NEWEST decoded frame (the ring BACK) is AHEAD
        // of the master clock. Measured at the back, NOT the displayed front, so the Axis-1 late-drop (which
        // keeps the front near the clock) can't mask a genuine decoder deficit. Empty ring ⇒ 0 (decoder not
        // ahead → eligible to engage; the cadenceActive/content gates suppress startup/seek).
        const framePeriodUs = contentPeriodMs * 1000;
        const forwardHeadroomUs = this.ring.length ? this.ring[this.ring.length - 1].ptsUs - this.lastNowUs : 0;
        const next: LadderState = ladderStep(
          { rung: this.degradeRung, climbMs: this.ladderClimbMs, dropMs: this.ladderDropMs },
          {
            cadenceActive: this.cadenceActive, paused: this.paused, haveContentPeriod,
            presentFps: m.fps, contentFps: contentRate,
            // decimation = the ACTIVE display tier (manual present-cap OR the rung's present-cap) so a manually-
            // halved display isn't read as a permanent decode deficit; at rung 3 this equals the rung's cap anyway.
            decimation: activeTier > 0 ? activeTier : 1,
            decodeFps, decimLower,
            clockRateRatio,
            ringLow: lowRing, ringHealthy, presentRingFull, demuxPressure,
            forwardHeadroomUs, framePeriodUs, dWallMs: dWall,
          },
        );
        this.degradeRung = next.rung; this.ladderClimbMs = next.climbMs; this.ladderDropMs = next.dropMs;
        // QUALITY-FIRST, content-aware lever map (mirrors the rung doc in present-cadence.ts):
        //   fast content (≥48 fps): r1=skip-non-ref, r2=+present-cap HALVE (quality-neutral), r3=+skip-deblock
        //   slow content (<48 fps): r1=skip-non-ref, r2=+skip-deblock (halve unwatchable; capped at r2 by the gate)
        const half = l1Ok && this.degradeRung >= RUNG_L2_L1;
        const skipNonref = this.degradeRung >= RUNG_L2;
        const skipLoop = l1Ok ? this.degradeRung >= RUNG_L2_L1_L3 : this.degradeRung >= RUNG_L2_L1;
        this.cadenceTier = half ? CADENCE_TIER_HALF : CADENCE_TIER_FULL;
        if (this.degradeRung !== prevRung) {
          // Rung changed → FAN OUT the new skip state to the decode worker (the decode worker OR-folds with the
          // manual skips → manual precedence). One message carries both fields, so a climb AND a de-escalation
          // update them in the right order automatically.
          this.autoSkipsEngaged = this.degradeRung > RUNG_NONE;
          this.port.postMessage({ type: 'autoSkips', skipNonref, skipLoop });
          // Re-seed the Bresenham accumulator ONLY when the present-cap tier actually flipped — a clean phase at
          // the new displayed period. Skip-only rung changes leave the display cadence untouched.
          if (this.cadenceTier !== prevTier) { this.cadenceErrorMs = 0; this.holdRemaining = 0; }
        }

        // ---- Fix-B rung-4: Live drop-to-keyframe (SOFTWARE tier only) ----
        // The ladder has maxed out (all safe levers on) and the SOFTWARE decoder is STILL severely below
        // the content rate (decodeFps < contentFps × RUNG4_SEVERE_FRAC). The safe levers can't close the
        // gap, so the demux/present would otherwise shed frames blind → corrupt mid-GOP. Instead tell the
        // decode worker to skip deltas to the next IDR + flush (GOP-clean drops). The decode worker owns
        // the action + latch (it sees isKey + owns vdecFlush) and SELF-GATES on SW + live edge; here we
        // gate on the present-visible signals: LIVE + audio-master (the realtime pressure that climbs the
        // rung to MAX) + the SOFTWARE tier + a sustained-severe deficit, thrash-damped by a min re-arm
        // interval so it can't fire every GOP. VOD never reaches RUNG_MAX under no-pressure slow-mo, and
        // backpressures anyway; the WC tier is owned by the wc-stall watchdog (a rung-4 here would disarm it).
        const hasAudioMaster = Atomics.load(this.clock, C_AUDIO) > 0;
        const rung4Armed = this.hasLiveEdge
          && hasAudioMaster
          && this.lastFrameWasSw
          && rung4Severe(this.degradeRung, decodeFps, contentRate);
        if (rung4Armed) {
          this.rung4SustainMs += dWall;
          const rearmed = this.rung4LastFireTs <= 0 || (ts - this.rung4LastFireTs) >= RUNG4_REARM_MS;
          if (this.rung4SustainMs >= RUNG4_SUSTAIN_MS && rearmed) {
            this.rung4LastFireTs = ts;
            this.rung4SustainMs = 0; // fresh sustain window after a fire
            this.rung4Fires++;
            if (DEBUG) post({ type: 'plog', m: `[degrade] rung-4 drop-to-keyframe fire #${this.rung4Fires} (decodeFps=${decodeFps.toFixed(0)} < ${contentRate.toFixed(0)}×${RUNG4_SEVERE_FRAC})` });
            this.port.postMessage({ type: 'dropToKeyframe' });
          }
        } else {
          this.rung4SustainMs = 0; // any non-severe window breaks the continuous streak
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
      this.wPushes = this.pushes; // Fix-B rung-4: re-anchor the decode-delivery (decodeFps) window baseline
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
        cadenceDropToKey: this.rung4Fires, // Fix-B rung-4 fires this load (Live drop-to-keyframe); 0 on a healthy stream
      });
    }
  }

  // ---- control (from main) ---------------------------------------------------

  setPaused(paused: boolean): void { this.paused = paused; }

  /** mpv cache-pause freeze (the audio output starved/refilled — DISTINCT from a user pause). While set, the
   *  clock holds at its current position (mediaUsNow short-circuit) so playback rebuffers from here instead
   *  of free-running. MAIN owns RW_PLAYING; this only holds the present clock + frame. */
  setBuffering(buffering: boolean): void { this.buffering = buffering; }

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
  reset(gen: number, hasLiveEdge: boolean, isLive: boolean, seekTargetMs: number): void {
    this.gen = gen;
    this.hasLiveEdge = hasLiveEdge; // Fix-B rung-4 is live-only — set per-load from the source capabilities
    this.isLive = isLive;           // gates the clock-disc-snap / SEAM re-anchor / vod_audio_stall machinery
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
    this.discFlushPending = false;
    // VOD seek (mpv last_seek_pts): seekTargetMs ≥ 0 → hold the clock at the target until a genuine post-seek
    // audio anchor lands (mediaUsNow's seek-hold). Otherwise (a (re)load / live-resume) no hold.
    if (seekTargetMs >= 0) {
      this.seekHold = true;
      this.seekTargetUs = seekTargetMs * 1000;
      this.mediaUs = this.seekTargetUs; // report/hold the target until post-seek content arrives
      this.seekHoldTicks = 0;
    } else {
      this.seekHold = false;
    }
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
    this.buffering = false; // a fresh timeline clears any rebuffer-freeze (MAIN re-establishes it if still starved)
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
    // Fix-B rung-4 state — fresh per timeline (the fires counter is per-load telemetry; the drop-to-keyframe
    // latch itself lives in the decode worker, which self-clears it on its own fresh-load/resume paths). The
    // decodeFps window baseline re-anchors so the cross-reset wall gap can't read as a bogus decode deficit.
    this.rung4SustainMs = 0;
    this.rung4LastFireTs = 0;
    this.rung4Fires = 0;
    this.wPushes = this.pushes;
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
    case 'setBuffering':
      presenter?.setBuffering(msg.buffering);
      break;
    case 'setPaused':
      presenter?.setPaused(msg.paused);
      break;
    case 'setLever':
      presenter?.setManualHalf(msg.present); // Lever 1 manual present=half override
      break;
    case 'reset':
      presenter?.reset(msg.gen, msg.hasLiveEdge, msg.isLive, msg.seekTargetMs);
      break;
    case 'destroy': {
      const framesClosed = presenter?.destroy() ?? 0; // count of VideoFrames it close()d emptying the ring
      presenter = null;
      post({ type: 'destroyed', framesClosed }); // no engine/pool here → ack immediately (owner-confirmed)
      break;
    }
  }
};
