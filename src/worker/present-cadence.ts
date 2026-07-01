// Present-cadence instrument (MEASURE-ONLY; no pacing/clock change) — the PURE windowing math, factored
// out of the present worker so it is unit-testable headless (no OffscreenCanvas / WebGL / `self`). The
// present worker stamps performance.now() on each DISTINCT front-frame draw into a rolling ~1s buffer of
// CadenceSamples; this module folds that buffer into the present-cadence metrics over the FULL 1s window.
//
// WHY A TRUE 1s WINDOW: the earlier instrument computed the distribution over the ~250ms slice since the
// last pstats post and CLEARED it each post, so the ~1Hz stats bus read a 250-500ms snapshot sampled at
// 1Hz → aliased + noisy, and 3 of every 4 windows were discarded. A rolling 1s buffer (~50 intervals at
// 50fps) gives a meaningful p95 and a metric that covers the whole second the bus reads (no aliasing).

/** The present-cadence rolling window length (ms). ~50 intervals at 50fps → a meaningful p95. */
export const CADENCE_WINDOW_MS = 1000;

/** Fallback content frame rate (fps) for the stutter threshold until ≥2 PTS deltas are known. */
export const DEFAULT_CONTENT_FPS = 50;

/** One distinct front-frame draw. `at` = performance.now() of the draw; `interval` = ms since the
 *  previous distinct draw (null = no valid predecessor: the first draw of a fresh measurement); `seam`
 *  = this draw's interval crossed a reset/re-anchor freeze (reconnect/seek/failover). A seam draw is
 *  EXCLUDED from the steady-state interval stats (so a freeze never masquerades as a stutter) but is
 *  COUNTED in seamGaps so reconnect freezes stay visible but distinct from steady-state stutter. */
export interface CadenceSample { at: number; interval: number | null; seam: boolean }

export interface CadenceMetrics {
  fps: number;       // distinct-draw rate over the span the window covers (frames/sec)
  meanMs: number;    // mean steady-state inter-draw interval (ms) — the present cadence
  p95Ms: number;     // 95th-percentile steady-state interval (ms) — tail jitter
  maxMs: number;     // worst steady-state interval (ms) in the window
  stutters: number;  // steady-state intervals > 2× the content frame period (visible gaps)
  seamGaps: number;  // reset/re-anchor freezes in the window (reconnect/seam, NOT steady-state stutter)
}

/** Nearest-rank p95 of an ascending-sorted array. Returns 0 for empty. */
function p95Of(sorted: number[]): number {
  const m = sorted.length;
  if (m === 0) return 0;
  return sorted[Math.min(m - 1, Math.ceil(0.95 * m) - 1)];
}

/** Median of a numeric array — the robust content frame PERIOD estimator (resists a dropped-frame 2×
 *  outlier). Returns 0 for empty. Does not mutate the input. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return (s.length & 1) ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Present-ring generation guard (pure, factored here with the other headless-testable present helpers).
 *  A decoded frame and the present-ring `reset` travel on DIFFERENT channels (decode→present port vs
 *  main→present) with no mutual ordering, so a frame the OLD load left in flight can reach the present
 *  worker AFTER the reset has installed the new generation. Such a frame is STALE and must not enter the
 *  fresh ring (it would flash the prior stream). It is stale iff its load generation is strictly older
 *  than the present worker's current (reset-set) generation. Generations are monotonic (++loadGen) and the
 *  decode loop only posts while it is the current load, so a CURRENT frame can never be older than current
 *  ⇒ this never drops a live frame (steady state: frameGen === curGen ⇒ false). */
export function isStaleLoadGen(frameGen: number, curGen: number): boolean {
  return frameGen < curGen;
}

/** The Bresenham display-cadence step (mpv), factored out PURE so the present worker's hold logic is
 *  unit-testable headless (pure arithmetic). Given the content frame period, the carried fractional-vsync
 *  error, and the measured vsync interval (all ms), returns how many WHOLE vsyncs to hold this frame (≥1) and
 *  the new carried error. The error is a sigma-delta integrator: the leftover phase is carried forward, so a
 *  1.5-vsync-per-frame stream (50-on-75) emits a deterministic 2,1,2,1 cadence with ZERO long-term drift,
 *  robust to clock jitter. (`Math.round` half-away-from-zero matches Rust `round` for the strictly-positive
 *  ratio here, so the Rust + TS twins agree exactly.) */
export function nextHold(contentMs: number, errMs: number, vsyncMs: number): { hold: number; err: number } {
  const ratio = (contentMs + errMs) / vsyncMs;
  const hold = Math.max(Math.round(ratio), 1); // ≥1: never a zero-vsync (dropped) hold
  return { hold, err: errMs + contentMs - hold * vsyncMs };
}

// ---- graceful-degradation cadence tier (present-every-Nth-frame on a bandwidth-bound client) ----------
// On a memory-bandwidth-bound client (low-power integrated GPU sharing the system bus), concurrent 4K-10-bit
// software decode + WebGL draw saturate the bus and present can't sustain the content rate. The fix is to
// CUT CONCURRENT MEMORY TRAFFIC by drawing fewer frames: present every `tier`-th decoded frame and hold the
// drawn frame `tier×` longer (Bresenham with content_dur × tier). 50 fps on 75 Hz → tier 2 = 25 fps = a
// clean hold-3; decode keeps producing every frame (only the draw/upload rate halves — that's the bus
// relief). This is the mpv/VLC behaviour of dropping to a clean display divisor under load. These helpers
// are PURE float/int arithmetic (headless-testable, no platform deps).

/** The cleanest cadence tier: 1 = full rate (every frame), 2 = half (every other frame). Only 1 and 2 are
 *  used today (the iGPU client needs a single halving); the math below generalises to any integer ≥1. */
export const CADENCE_TIER_FULL = 1;
export const CADENCE_TIER_HALF = 2;

/** Degrade reason codes (numeric so they ride the numeric stats bus). */
export const DEGRADE_REASON_NONE = 0;
export const DEGRADE_REASON_UNDER_DELIVERY = 1; // an AUTO ladder rung is engaged (decode-bound → levers active)
export const DEGRADE_REASON_MANUAL = 2;         // Lever 1 forced ON via the manual present=half override

// The demux-ring LATENCY thresholds (the signal that actually breaks audio: the demux ring
// carries the audio packets, so when decode falls behind ingest the ring GROWS and audio starves). The
// proven decode-bound real fixture climbs the ring to ≈2.7 MB (audio starves) where a healthy / degraded
// stream sits at ≈0.78 MB (drained). On the GRADUATED ladder this is no longer a REQUIRED gate (the
// present-side detector below owns "decode-bound"); it survives only as a WEAK OR-ed hint that strengthens
// the "can't keep up" signal (ring ABOVE the latency floor OR CLIMBED by the growth delta = decode not
// draining ingest). A drained ring (healthy / VOD-range) is no pressure.
export const DEGRADE_RING_BYTES = 1_500_000;        // demux ring above this ⇒ high latency (decode behind ingest)
export const DEGRADE_RING_GROWTH_BYTES = 1_000_000; // …or climbed ≥ this over the trend window ⇒ growing (decode not draining)
// The growth BASELINE (window-min) horizon — kept LONGER than the ladder's climb-settle window so a pre-
// climb low stays in the window for the whole climb streak (a ring that climbs once then plateaus below the
// absolute floor must not lose its baseline right before the climb → growth→0 → the hint vanishes).
export const DEGRADE_RING_TREND_MS = 6000;

/** PTS-CAP decimation (the tier-2 floor-fix). How many ring frames a single present
 *  STEP consumes at the given tier, by PTS DECIMATION rather than the old unconditional every-other skip —
 *  PURE, so the floor property + the shift/release accounting are unit-testable headless. Inputs: the ring
 *  frames (ascending PTS from index 0; index 0 is the displayed front being retired = the last SHOWN
 *  frame), that front's PTS `shownPtsUs`, the TRUE content frame period `periodUs` (µs — non-ref-skip-
 *  INDEPENDENT, measured from demux PACKET PTS so a non-ref-skip decimated decoder doesn't double it), and the tier.
 *   - ringLen < 2 → 0 (STARVED: no successor → hold the current front, re-evaluate next tick).
 *   - tier ≤ 1   → 1 (full-rate hand-off; the banked path, UNCHANGED).
 *   - tier ≥ 2   → 1 (retire the displayed front, a hand-off) PLUS each FOLLOWING frame whose PTS is
 *     < `tier × periodUs` ahead of `shownPtsUs` is SKIPPED — but always leaving ≥1 front (never empties
 *     the ring). The next frame ≥ that target interval ahead is the one shown.
 *  SELF-FLOORING: this reframes the present-cap lever as a present-rate CAP, not an unconditional halving. When the
 *  queued frames are already ≥ the target interval apart (decode delivering BELOW the tier's target rate
 *  → sparse PTS, or a drained ring), NOTHING is skipped — so the degraded tier NEVER presents fewer frames
 *  than decode delivers (decode=50 ⇒ every-other ⇒ 25; decode=15 ⇒ frames >target apart ⇒ all 15 shown).
 *  And because the target uses the TRUE content period, present-cap + non-ref-skip don't decimate twice: non-ref-skip already spaces the
 *  decoded frames at ~target, so the cap shows all of them. */
export function capAdvance(ring: { ptsUs: number }[], shownPtsUs: number, periodUs: number, tier: number): number {
  const len = ring.length;
  if (len < 2) return 0;                    // STARVED: hold, re-evaluate next tick
  if (tier <= 1 || periodUs <= 0) return 1; // full-rate hand-off (tier 1 unchanged; defensive on a bad period)
  const targetUs = tier * periodUs;         // the degraded display interval (tier 2 → 2× content = 25fps on 50)
  let adv = 1;                              // retire the displayed front (a hand-off, not a drop)
  // Skip following frames packed CLOSER than the target interval to the last shown — leaving ≥1 front.
  while (adv < len - 1 && (ring[adv].ptsUs - shownPtsUs) < targetUs) adv++;
  return adv;
}

/** Demux-ring "decode is falling behind ingest" PRESSURE — PURE. True when the demux ring sits
 *  ABOVE the absolute latency floor (sustained high), OR has CLIMBED by ≥ the growth delta from its window
 *  minimum (climbing-but-not-yet-high). The demux ring carries the audio packets, so this is the signal that
 *  actually starves audio. On the graduated ladder it is a WEAK OR-ed HINT into the "can't keep up" signal
 *  (not a required gate — the present-side detector owns decode-bound). Drained / VOD-range ring ⇒ false. */
export function demuxRingPressure(bytes: number, minBytes: number): boolean {
  return bytes >= DEGRADE_RING_BYTES || (bytes - minBytes) >= DEGRADE_RING_GROWTH_BYTES;
}

// ---- the GRADUATED, AXIS-SEPARATED graceful-degradation LADDER ----------------------------------------
// On a memory-bandwidth-bound client (low-power integrated GPU sharing the system bus), concurrent
// 4K-10-bit software decode + WebGL draw saturate the bus and present can't sustain the content rate. The
// ladder relieves it on TWO INDEPENDENT axes, climbing one rung per settle window while decode-bound and
// de-escalating in strict reverse on headroom:
//   • skip-non-ref / skip-deblock relieve the DECODER (CPU per frame) — sane whenever the
//     decoder is the bottleneck, AT ANY frame-rate.
//   • present-cap (halve the display 50→25) relieves the PRESENTER (draw bandwidth) — only sane when
//     the halved rate stays watchable (content ≥ ~48 fps; 25→12.5 is nonsense).
// So the levers stack as a rung ∈ {0,1,2,3}: rung0 none · rung1 skip-non-ref · rung2 + present-cap · rung3
// + skip-deblock. Climb ONE rung per settle window while decode-bound; rung2→3 is GATED on
// contentFps ≥ LADDER_L1_MIN_FPS (else cap at rung2 — never engage the nonsense halving). De-escalate in
// STRICT REVERSE (present-cap → skip-deblock → skip-non-ref = decrement the rung) on sustained HEADROOM,
// with ASYMMETRIC (slower) hysteresis so it never flaps.
//
// Rungs ∈ {0,1,2,3}. QUALITY-FIRST order: engage the quality-NEUTRAL present-cap (L1, smooth half-rate, full
// spatial fidelity) BEFORE the spatial-degrading skip-deblock (L3). The climb is L2 → L1 → L3:
//   r1 = skip-non-ref (mpv's runtime tool: drop B-frames at the decoder — the cheapest real relief)
//   r2 = + present-cap HALVE (draw an even 25 fps; full spatial quality — gated on content ≥ LADDER_L1_MIN_FPS)
//   r3 = + skip-deblock (the ONLY spatial-quality loss — a true last resort)
// For SLOW content (< LADDER_L1_MIN_FPS) the halve is unwatchable, so r2 maps to skip-deblock instead and the
// rung caps there (the present-side lever mapping is content-aware). De-escalation is the strict reverse
// (3→2 restores deblock, 2→1 un-halves, 1→0 restores B-frames); un-halving DOUBLES the target, so it is gated
// on `decodeFps` showing the box can actually sustain the un-halved rate (anti-flap, see ladderStep).
export const RUNG_NONE = 0;        // no levers (the full-rate path)
export const RUNG_L2 = 1;          // skip non-ref (decode relief)
export const RUNG_L2_L1 = 2;       // + present-cap halve (draw relief, quality-neutral; slow content → skip-deblock)
export const RUNG_L2_L1_L3 = 3;    // + skip deblock (the spatial-quality last resort)
export const RUNG_MAX = RUNG_L2_L1_L3;

export const LADDER_CLIMB_MS = 2500;       // settle/measure window between climbs (the climb-sustain horizon)
export const LADDER_DROP_MS = 9000;        // throughput-headroom de-escalation hysteresis — slow (anti-flap)
// De-escalation re-probe when check_framedrop reports the decoder COMFORTABLY AHEAD (the skip-INDEPENDENT
// forward-headroom signal — see ladderStep). Faster than LADDER_DROP_MS because it's a direct capability
// read the relief levers can't mask: step one rung down, re-measure the higher demand, repeat. The masked
// throughput headroom can never de-escalate skip-non-ref/half-cadence (they depress decodeFps/presentFps);
// forward-headroom can't be masked, so it is what de-escalates a maxed-out ladder.
export const LADDER_RECOVER_MS = 1500;
export const LADDER_FPS_UNDER_FRAC = 0.85; // present below this × the EFFECTIVE target ⇒ under-delivering
export const LADDER_FPS_OVER_FRAC = 0.90;  // present at/above this × the EFFECTIVE target ⇒ headroom (for a drop)
export const LADDER_RATE_UNDER = 0.95;     // media/wall (clockRateRatio) below this ⇒ the stream can't keep up
export const LADDER_RATE_OVER = 1.0;       // media/wall at/above this ⇒ realtime (a headroom requirement)
export const LADDER_L1_MIN_FPS = 48;       // present-cap gate: only halve content fast enough that 25 stays watchable
// mpv check_framedrop disables itself for fps ≤ 20 (a crappy heuristic on jittery low fps). Mirror it: the
// ladder never engages relief on genuinely-slow content (a decode deficit there is a deeper problem, not judder).
export const LADDER_MIN_CONTENT_FPS = 20;  // mpv's fps≤20 framedrop guard — never degrade genuinely-low-fps content

// --- Axis 2, rung 1 = mpv check_framedrop (the `--framedrop=yes` decoder skip-non-ref) ---
// Faithful to mpv's "skip non-reference frames when the decoder isn't staying ahead of the audio clock",
// but measured by the present ring's FORWARD HEADROOM (newest-decoded pts − master clock) instead of the
// displayed frame: Axis-1 VO late-drop keeps the FRONT near the clock, which would MASK a front-based
// av_diff, so the un-masked decoder-vs-clock signal is the headroom at the ring BACK. Hysteretic so it
// doesn't toggle each window around the boundary.
export const CHECK_FRAMEDROP_ENGAGE_FRAMES = 1.0;  // < 1 frame of future buffered ⇒ decoder behind ⇒ skip
export const CHECK_FRAMEDROP_RELEASE_FRAMES = 3.0; // ≥ 3 frames ahead ⇒ comfortable ⇒ release
// ENGAGE DEBOUNCE: forward-headroom must stay below the engage threshold this long before rung-1 (skip-non-ref)
// actually engages. mpv's check_framedrop is instant but PROPORTIONAL (drops a couple of frames); the
// skip here is a COARSE binary (≈50→20 fps), so engaging it on a single slow frame / transient ring-drain flaps
// visibly — the coarse lever is a FORCED deviation that needs the sustain debounce. A capable decoder's variance
// never SUSTAINS a deficit, so it never climbs; a genuinely decode-bound client does sustain it and engages after
// the settle. Release stays FAST (LADDER_RECOVER_MS) — slow-to-engage, fast-to-recover is the asymmetry that kills
// the flap without ever latching. 2.5 s: a capable box's transient stalls (CPU spike / a hard ~1-2 s GOP) recover
// well within this and never engage; only a GENUINELY decode-bound client sustains a deficit past it.
export const CHECK_FRAMEDROP_SUSTAIN_MS = 2500.0;

// --- Axis 1 = mpv VO late-drop (render_frame), the always-on present-side display drop ---
/** A front frame this many CONTENT periods behind the master clock is "late" → dropped. mpv drops at ~1
 *  frame on its vsync-precise clock; the browser's cross-realm SAB clock + rAF sampling jitter needs a small
 *  multiple (FORCED deviation: clock jitter) so normal jitter doesn't trigger spurious drops. */
export const VO_LATE_DROP_FRAMES = 2.0;
/** mpv's "rather degrade to 10 fps than freeze forever" floor (now − prev_vsync < 100 ms): never let
 *  more than this elapse (wall ms) without an actual present — above it, SHOW the late frame, don't drop. */
export const PRESENT_FLOOR_MS = 100.0;

/** mpv check_framedrop: should the SW decoder skip non-reference frames? Governed by the present ring's
 *  FORWARD HEADROOM (`newestDecodedPts − now`, µs) — how far the decoder is staying ahead of the master clock.
 *  Engage below 1 frame of headroom (decoder at/behind); release above 3 frames (comfortable). `currently` =
 *  skip already engaged (the hysteresis state). Returns whether skip should be on. */
export function checkFramedropEngage(currently: boolean, forwardHeadroomUs: number, framePeriodUs: number): boolean {
  if (framePeriodUs <= 0) return currently;
  const bound = currently ? CHECK_FRAMEDROP_RELEASE_FRAMES : CHECK_FRAMEDROP_ENGAGE_FRAMES;
  return forwardHeadroomUs < bound * framePeriodUs;
}

/** mpv VO late-drop (render_frame): should the present worker DROP the current front frame because its
 *  display window has passed the master clock? `frontBehindUs` = now − frontPts (>0 ⇒ late). Drops only
 *  while the "never freeze" floor holds (`msSincePresent < PRESENT_FLOOR_MS`) and a next frame exists to
 *  advance to. Keeps the audio clock authoritative; degrades to ≥1 present / PRESENT_FLOOR_MS, never freezes. */
export function shouldLateDrop(
  frontBehindUs: number, framePeriodUs: number, msSincePresent: number, paused: boolean, ringLen: number,
): boolean {
  if (paused || ringLen < 2 || framePeriodUs <= 0) return false;
  return frontBehindUs > VO_LATE_DROP_FRAMES * framePeriodUs && msSincePresent < PRESENT_FLOOR_MS;
}

/** mpv display-sync AHEAD-correction — the mirror of `shouldLateDrop`. HOLD the current front (repeat it this
 *  tick) when it runs AHEAD of the audio master, so the audio-mastered clock catches up and the offset bleeds
 *  off in whole-vsync steps — converging to < 1 vsync instead of latching at the old 120 ms ahead-guard
 *  (which held ONLY above 120 ms, so an ahead offset stuck at ~120 ms). You can never present a future frame
 *  early, so the correction is a HOLD, not a draw. `frontAheadUs` = frontPts − now (>0 ⇒ ahead). Gated by
 *  mpv `handle_display_sync_frame`'s tolerance (`|av_diff| >= 20 ms AND >= 1 vsync`, on the DISPLAY vsync) and,
 *  like `shouldLateDrop`, by the `PRESENT_FLOOR_MS` "never freeze forever" floor — so a large residual (e.g. a
 *  VOD backlog the LIVE-only disc-snap doesn't catch) holds at most ~100 ms before showing the frame + letting
 *  the PLL finish. Single-tick (closed-loop, re-evaluated per tick against the live clock) — a deliberate
 *  jitter-safe deviation from mpv's open-loop one-shot `num_vsyncs += drop_repeat`. */
export const SYNC_AHEAD_TOL_US = 20_000; // mpv display-sync ahead dead-band (20 ms)
export function shouldAheadHold(
  frontAheadUs: number, vsyncUs: number, msSincePresent: number, paused: boolean, ringLen: number,
): boolean {
  if (paused || ringLen < 1 || vsyncUs <= 0) return false;
  return frontAheadUs > SYNC_AHEAD_TOL_US && frontAheadUs > vsyncUs && msSincePresent < PRESENT_FLOOR_MS;
}

// --- master-clock corrections — mpv adjust_sync + restart alignment ---
// The present clock (mediaUs) is audio-mastered: it advances on wall dt each rAF tick then is nudged toward
// the audio clock. These pure helpers make that nudge FAITHFUL to mpv: a clamped per-frame correction, never
// an uncapped slew that could jump the clock far in a single tick.
export const CLOCK_PLL_GAIN = 0.10;                 // mpv adjust_sync `change = av_delay * 0.1` — the GAIN
export const CLOCK_PLL_NEAR_FACTOR = 0.10;          // |residual| < 0.3 s ⇒ clamp factor 0.1
export const CLOCK_PLL_FAR_FACTOR = 0.40;           // |residual| ≥ 0.3 s ⇒ clamp factor 0.4
export const CLOCK_PLL_FAR_THRESHOLD_US = 300_000;  // mpv's 0.3 s near/far boundary

/** mpv adjust_sync per-FRAME clock correction: `change = residual·0.1`, CLAMPED to
 *  `±(framePeriod · factor)` where `factor = |residual| < 0.3 s ? 0.1 : 0.4`. mpv's
 *  `default_max_pts_correction` defaults to −1, so the clamp is always `frame_time · factor` — at most 10 %
 *  (small error) / 40 % (large) of ONE content frame period per frame. Returns the clamped µs correction. */
export function pllCorrectionPerFrame(residualUs: number, framePeriodUs: number): number {
  if (framePeriodUs <= 0) return 0;
  const change = residualUs * CLOCK_PLL_GAIN;
  const factor = Math.abs(residualUs) < CLOCK_PLL_FAR_THRESHOLD_US ? CLOCK_PLL_NEAR_FACTOR : CLOCK_PLL_FAR_FACTOR;
  const maxChange = framePeriodUs * factor;
  return Math.min(maxChange, Math.max(-maxChange, change)); // clamp(change, -maxChange, maxChange)
}

/** Per-rAF-TICK correction: mpv's per-FRAME budget prorated to this tick's share of one content frame, so the
 *  total correction accumulated over one content-frame's worth of ticks equals mpv's exact per-frame cap.
 *  FORCED translation: Ferrite's present clock is sampled/corrected every rAF tick (decoupled from the content
 *  frame rate, e.g. 75 Hz vs 50 fps), whereas mpv corrects once per drawn frame — proration matches the budget. */
export function pllCorrectionPerTick(residualUs: number, framePeriodUs: number, tickDtUs: number): number {
  if (framePeriodUs <= 0) return 0;
  return pllCorrectionPerFrame(residualUs, framePeriodUs) * Math.min(1, Math.max(0, tickDtUs / framePeriodUs));
}

/** PRE-AUDIO startup clock advance (mpv restart alignment).
 *  While an audio stream exists but isn't yet audible, mpv does NOT advance the master on a WALL clock — the
 *  clock is the FIRST FRAME's pts, advanced by the frame schedule. Faithful continuous analog: wall-pace
 *  `mediaUs` but CLAMP it to the newest decoded frame pts (`newestPtsUs`) so it can never sail past real
 *  frames (a wall-clock free-run would race ahead of slow-arriving frames → black-canvas-with-audio),
 *  and never run backward (`max(mediaUs)` guard). It MUST keep advancing (never hard-freeze) so the front
 *  retires, currentMs climbs, and the audio-start gate (`currentMs >= apts`) can fire — a hard hold would
 *  deadlock the gate. A genuinely audio-less stream self-paces to the decode rate (bounded by the ring). */
export function preAudioClockAdvance(mediaUs: number, dtMs: number, newestPtsUs: number): number {
  return Math.min(mediaUs + dtMs * 1000, Math.max(newestPtsUs, mediaUs));
}

/** Classify a LIVE master-clock residual as a true PTS-epoch discontinuity (loop / splice / reconnect)
 *  vs normal drift. mpv hard-resyncs (reset_playback_state) only on a ≥5 s A/V step (tolerance=5 s for
 *  ts_resets_possible streams = live MPEG-TS); everything below is absorbed by the clamped PLL. VOD never
 *  snaps (monotonic timeline). `isLive` stands in for mpv's `ts_resets_possible`. */
export function isClockDiscontinuity(isLive: boolean, residualUs: number, snapThresholdUs: number): boolean {
  return isLive && Math.abs(residualUs) > snapThresholdUs;
}

// ---- rung-4: Live drop-to-keyframe (BEYOND the safe ladder) ----------------------------------
// When the ladder maxes out (all safe levers on) and the SOFTWARE decoder STILL can't reach the content
// rate, the only remaining relief is to shed a whole GOP's worth of corrupt mid-GOP load: skip deltas to
// the next IDR + flush. The PRESENT worker owns the trigger (it sees the rung + decodeFps + clock); the
// DECODE worker owns the action/latch (it sees isKey + owns vdecFlush). LIVE + audio-master + SOFTWARE
// only — VOD backpressures (never drops content), the WC tier is owned by the wc-stall watchdog. The
// trigger fires only when rung === RUNG_MAX AND the decode deficit is SEVERE and SUSTAINED, thrash-damped
// by a minimum re-arm interval so it can't fire every GOP (a periodic multi-second freeze).
export const RUNG4_SEVERE_FRAC = 0.5;  // fire only when decodeFps < contentFps × this (well past the safe levers)
export const RUNG4_SUSTAIN_MS = 2000;  // continuous severe-deficit time before the first fire (≥ the climb window)
export const RUNG4_REARM_MS = 3000;    // minimum interval between fires — can't drop-to-keyframe every GOP

/** PURE rung-4 trigger predicate: at the top rung AND the software decoder is severely behind the content
 *  rate. (The SUSTAIN/REARM timing + the live/audio/software gating live in the present worker, which owns
 *  the streak state and the tier signal; this captures the headless-testable "severe deficit at RUNG_MAX"
 *  core.) `decodeFps`/`contentFps` ≤ 0 ⇒ unknown ⇒ false (never fire on a missing measurement). */
export function rung4Severe(rung: number, decodeFps: number, contentFps: number): boolean {
  return rung === RUNG_MAX
    && contentFps > 0
    && decodeFps > 0
    && decodeFps < contentFps * RUNG4_SEVERE_FRAC;
}

/** The display decimation the ladder's present-cap WOULD apply at a rung: the quality-first lever map puts
 *  the present-cap HALVE at rung ≥ RUNG_L2_L1 (rung 2) — but ONLY for fast content (≥ LADDER_L1_MIN_FPS), since
 *  halving slow content (25→12.5) is unwatchable, so on slow content that rung maps to skip-deblock and decim
 *  stays 1. Content-aware: mirrors the present worker's `half = l1ok && rung >= RUNG_L2_L1` lever map. The
 *  caller passes the EFFECTIVE decimation (which folds in the MANUAL present-cap override too — see
 *  LadderInput.decimation); this helper is the AUTO-only value, used where manual is off. */
export function rungDecimation(rung: number, contentFps: number): number {
  return rung >= RUNG_L2_L1 && contentFps >= LADDER_L1_MIN_FPS ? 2 : 1;
}

/** One window's measurement, fed to ladderStep. */
export interface LadderInput {
  cadenceActive: boolean; paused: boolean; haveContentPeriod: boolean;
  presentFps: number;          // measured distinct-draw rate over the trailing 1 s window (the DISPLAYED rate)
  contentFps: number;          // TRUE content rate (from the non-ref-skip-independent packet period)
  decimation: number;          // the ACTIVE display decimation IN EFFECT this window (manual OR the rung's present-cap):
                               //   the EFFECTIVE present target = contentFps / decimation. Manual-aware so a halved
                               //   display isn't read as a permanent deficit.
  decodeFps: number;           // TRUE decode DELIVERY rate (distinct intake frames/wall) — UNCAPPED by the present-cap,
                               //   unlike presentFps. The decode-bound signal: when audio holds the clock at realtime
                               //   the deficit is invisible to clockRateRatio, but decodeFps < contentFps still proves
                               //   the decoder can't keep up. Also gates un-halving (a half rung caps presentFps). ≤0 ⇒ unknown.
  decimLower: number;          // the display decimation that WOULD apply one rung DOWN (so the post-de-escalation
                               //   target = contentFps / decimLower; gates un-halving on real capacity).
  clockRateRatio: number;      // media/wall (×realtime); ≤0 ⇒ no valid clock measurement this window
  ringLow: boolean;            // present ring DRAINING (low-water ≤ ~cap/4) — decode can't keep it full
  ringHealthy: boolean;        // present ring stayed comfortably full (low-water ≥ ~cap/2) — room to drop a lever
  presentRingFull: boolean;    // present ring PINNED at ~cap all window ⇒ a present-side stall back-pressured decode
  demuxPressure: boolean;      // WEAK hint: the demux ring is high/growing (decode behind ingest)
  forwardHeadroomUs: number;   // FORWARD HEADROOM (µs): newest-decoded frame pts − master clock — mpv check_framedrop's
                               //   signal (how far the decoder is staying ahead). Governs the NONE↔rung-1 (skip-non-ref)
                               //   boundary; unmasked by Axis-1.
  framePeriodUs: number;       // content frame period (µs) — the unit for the check_framedrop headroom thresholds.
  dWallMs: number;             // wall-ms this window (the streak accumulator increment)
}

/** The ladder streak state carried across windows. */
export interface LadderState { rung: number; climbMs: number; dropMs: number }

/** The graduated-ladder state machine (PURE). CLIMB one rung after LADDER_CLIMB_MS of CONTINUOUS decode-bound
 *  under-delivery (any non-under window resets the climb streak); rung2→3 is gated on contentFps ≥
 *  LADDER_L1_MIN_FPS. DE-ESCALATE one rung after LADDER_DROP_MS of CONTINUOUS headroom (any non-headroom window
 *  resets the drop streak) — strictly present-cap → skip-deblock → skip-non-ref via the rung decrement. NEVER
 *  degrades a capable stream, and a PRESENT-side stall (presentRingFull) can never trip it. */
export function ladderStep(s: LadderState, inp: LadderInput): LadderState {
  const measurable =
    inp.cadenceActive && !inp.paused && inp.haveContentPeriod &&
    inp.contentFps > 0 && inp.presentFps > 0;
  const haveClock = inp.clockRateRatio > 0;            // a window that re-anchored the clock reports 0 ⇒ unknown
  const decim = inp.decimation > 0 ? inp.decimation : 1;
  const target = inp.contentFps / decim;              // the EFFECTIVE present (display) target this window
  // DECODE-BOUND when the decoder itself can't produce the content rate. The clock-based signals miss the
  // case where audio holds the clock at realtime and the present quietly delivers fewer UNIQUE frames (judder):
  // there clockRateRatio≈1, the ring isn't draining, and yet decodeFps < contentFps. So treat a sustained
  // decode-delivery deficit as a can't-keep-up signal in its own right (uses CONTENT fps — decodeFps is uncapped
  // by the present-cap, unlike presentFps).
  const decodeBound = inp.decodeFps > 0 && inp.decodeFps < inp.contentFps * LADDER_FPS_UNDER_FRAC;
  // DECODE-BOUND: present below the effective target AND the stream genuinely can't keep up (media clock
  // sub-realtime OR the present ring draining OR the decoder under-delivering OR — weak hint — the demux ring
  // under pressure), and NOT a present-side stall (a pinned-full ring = back-pressured decode → never degrade).
  const cantKeepUp =
    (haveClock && inp.clockRateRatio < LADDER_RATE_UNDER) || inp.ringLow || inp.demuxPressure || decodeBound;
  const under =
    measurable && inp.contentFps > LADDER_MIN_CONTENT_FPS && // mpv's fps≤20 framedrop guard
    !inp.presentRingFull &&
    inp.presentFps < target * LADDER_FPS_UNDER_FRAC && cantKeepUp;
  // HEADROOM (gates a de-escalation): present AT/ABOVE the effective target, the clock realtime, the ring
  // healthy, and no demux pressure. Requiring a VALID realtime clock pins a genuinely decode-bound stream
  // at its rung (its media/wall stays <1.0 → never headroom → never re-probes); only a recovered stream
  // de-escalates. ANTI-FLAP: de-escalating may DOUBLE the target (un-halving the present-cap), and at a half
  // rung presentFps is capped so it can't reveal the headroom for the un-halved rate — so additionally
  // require decodeFps to cover the post-de-escalation target (contentFps / decimLower). Unknown decodeFps
  // (≤0) falls back to the presentFps-only test (banked behaviour).
  const decimLower = Math.max(1, inp.decimLower);
  const deescalateSustainable =
    inp.decodeFps <= 0 || inp.decodeFps >= (inp.contentFps / decimLower) * LADDER_FPS_OVER_FRAC;
  const headroom =
    measurable && haveClock &&
    inp.presentFps >= target * LADDER_FPS_OVER_FRAC &&
    inp.clockRateRatio >= LADDER_RATE_OVER && inp.ringHealthy && !inp.demuxPressure && deescalateSustainable;
  const dW = Math.max(0, inp.dWallMs);

  // RUNG 1 (RUNG_L2 = skip-non-ref) IS mpv check_framedrop (the `--framedrop=yes` decoder skip), governed by
  // the INSTANTANEOUS forward headroom (decoder-vs-clock), NOT the windowed throughput. This is the faithful
  // mpv BASE of the ladder; the heavier rungs above are the beyond-mpv relief on a SUSTAINED throughput deficit.
  const fd =
    inp.haveContentPeriod &&
    inp.contentFps > LADDER_MIN_CONTENT_FPS && // mpv's fps≤20 framedrop guard
    !inp.presentRingFull && // a back-pressured-decode stall never engages relief
    checkFramedropEngage(s.rung >= RUNG_L2, inp.forwardHeadroomUs, inp.framePeriodUs);

  // --- At RUNG_NONE: engage rung-1 (mpv check_framedrop) only once the forward-headroom deficit is SUSTAINED
  //     for CHECK_FRAMEDROP_SUSTAIN_MS. Debounced because the coarse binary skip would otherwise FLAP on
  //     transient decode jitter (a capable decoder's variance never sustains a deficit, so it never climbs;
  //     a genuinely decode-bound client does). The streak resets the instant the decoder is no longer behind.
  //     The heavier rungs are reached only after L2, so they stay structurally gated behind it.
  if (s.rung === RUNG_NONE) {
    if (measurable && fd) {
      const climbMs = s.climbMs + dW;
      if (climbMs >= CHECK_FRAMEDROP_SUSTAIN_MS) return { rung: RUNG_L2, climbMs: 0, dropMs: 0 };
      return { rung: RUNG_NONE, climbMs, dropMs: 0 };
    }
    return { rung: RUNG_NONE, climbMs: 0, dropMs: 0 };
  }

  // --- CLIMB (beyond-mpv heavy rungs) only while the decoder is STILL behind (`fd`) AND a SUSTAINED
  //     throughput deficit persists. One rung per LADDER_CLIMB_MS; rung2→3 gated on content ≥ L1_MIN_FPS.
  //     Gating the climb on `fd` (not just `under`) stops a MASKED throughput deficit (decodeFps depressed
  //     by an already-engaged skip) from climbing further once the decoder is actually ahead.
  if (fd && under && s.rung < RUNG_MAX) {
    const climbMs = s.climbMs + dW;
    if (climbMs >= LADDER_CLIMB_MS) {
      // present-cap GATE: for slow content the lever map puts skip-deblock at rung 2 (not the unwatchable
      // halve) and rung 3 adds nothing — so cap there. (Fast content engages the halve at rung 2 and reaches
      // skip-deblock at rung 3 ungated.) Re-zero the streak so it re-measures, never creeps.
      const blockedByL1Gate = s.rung === RUNG_L2_L1 && inp.contentFps < LADDER_L1_MIN_FPS;
      const rung = blockedByL1Gate ? s.rung : s.rung + 1;
      return { rung, climbMs: 0, dropMs: 0 }; // fresh settle window at the new rung
    }
    return { rung: s.rung, climbMs, dropMs: 0 };
  }

  // --- DE-ESCALATE one rung (toward RUNG_NONE) when the decoder is caught up. PRIMARY signal: check_framedrop
  //     "caught up" (`!fd`) — the SKIP-INDEPENDENT forward-headroom the relief levers CANNOT mask, which is
  //     what BREAKS THE LATCH (skip-non-ref/half-cadence depress decodeFps/presentFps, so the throughput
  //     `headroom` below could never de-escalate and the ladder stuck at the top rung). SECONDARY: genuine
  //     throughput `headroom`. Re-probe ONE rung at a time (ahead at this rung doesn't prove ahead at the
  //     next-lower rung's higher demand); if a step overshoots, `fd` re-engages and the ladder re-climbs.
  //     Fast settle (LADDER_RECOVER_MS) on the direct `!fd` read; slow (LADDER_DROP_MS) on throughput headroom.
  if (!fd || headroom) {
    const dropMs = s.dropMs + dW;
    const settle = !fd ? LADDER_RECOVER_MS : LADDER_DROP_MS;
    if (dropMs >= settle) return { rung: s.rung - 1, climbMs: 0, dropMs: 0 }; // s.rung > RUNG_NONE here
    return { rung: s.rung, climbMs: 0, dropMs };
  }

  // HOLD: the decoder is behind (`fd`) but there is no SUSTAINED throughput deficit to climb on (or we are at
  //     RUNG_MAX). Reset BOTH streaks — a non-sustained window never creeps the rung up or down on noise.
  return { rung: s.rung, climbMs: 0, dropMs: 0 };
}

/** Fold a rolling ~1s cadence buffer into the present-cadence metrics. PURE — no clock/IO/mutation.
 *  `periodMs` is the content frame period (the stutter threshold is 2×). The interval distribution
 *  (mean/p95/max/stutters) is over STEADY-STATE intervals ONLY (interval != null && !seam); `fps` is the
 *  distinct-draw rate over the actual covered span — robust to a partial window at startup, and it DOES
 *  span seam gaps (so a reconnect second genuinely shows fewer frames reaching the screen). */
export function cadenceStats(samples: CadenceSample[], periodMs: number): CadenceMetrics {
  const n = samples.length;
  // n draws span [first.at, last.at] → (n-1) inter-draw intervals over that span.
  const span = n > 1 ? samples[n - 1].at - samples[0].at : 0;
  const fps = span > 0 ? Math.round(((n - 1) * 1000) / span) : 0;
  const iv: number[] = [];
  let seamGaps = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (s.seam) { seamGaps++; continue; }          // a freeze gap — counted separately, never a stutter
    if (s.interval !== null) iv.push(s.interval);  // a steady-state inter-draw interval
  }
  let meanMs = 0, p95Ms = 0, maxMs = 0, stutters = 0;
  const m = iv.length;
  if (m > 0) {
    const sorted = iv.slice().sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < m; i++) sum += iv[i];
    meanMs = sum / m;
    maxMs = sorted[m - 1];
    p95Ms = p95Of(sorted);
    const threshMs = 2 * periodMs;
    for (let i = 0; i < m; i++) if (iv[i] > threshMs) stutters++;
  }
  return { fps, meanMs, p95Ms, maxMs, stutters, seamGaps };
}

/** Window-math SELF-CHECK (#4): in the regime the invariant is defined for — a steady cadence near the
 *  content rate (intervals ~periodMs) — the p95 must be ~periodMs (≈20-25ms at a 20ms period) and
 *  stutters 0. Returns a diagnostic string if VIOLATED, else null. Outside that regime (startup, a
 *  genuine stutter storm, a non-50fps clip) it returns null — it asserts the math, not the playback.
 *  Cheap + PURE; the present worker calls it at the ~4Hz pstats post (NOT per frame), logging only on a
 *  violation, so a correct window is silent. */
export function cadenceSelfCheck(m: CadenceMetrics, periodMs: number): string | null {
  if (periodMs <= 0) return null;
  // Only assert for a steady, near-content-rate cadence (fps within ±10% of the period's implied rate
  // AND a mean within ±25% of the period) — i.e. exactly the "presentFps≈50, intervals ~20ms" case.
  const rate = 1000 / periodMs;
  if (m.fps < rate * 0.9 || m.fps > rate * 1.1) return null;
  if (m.meanMs < periodMs * 0.75 || m.meanMs > periodMs * 1.25) return null;
  const p95Tol = periodMs * 1.25 + 5; // ~20ms period → p95 should sit ≲30ms
  if (m.p95Ms <= p95Tol && m.stutters === 0) return null;
  return `cadence self-check FAILED: fps=${m.fps} mean=${m.meanMs.toFixed(1)}ms p95=${m.p95Ms.toFixed(1)}ms ` +
    `stutters=${m.stutters} — at a steady ${periodMs.toFixed(1)}ms cadence expected p95≲${p95Tol.toFixed(0)}ms, stutters=0`;
}
