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

/** The Bresenham display-cadence step (mpv video.c:835-843), factored out PURE so the present worker's
 *  hold logic is unit-testable headless (pure arithmetic). Given
 *  the content frame period, the carried fractional-vsync error, and the measured vsync interval (all ms),
 *  returns how many WHOLE vsyncs to hold this frame (≥1) and the new carried error. The error is a sigma-
 *  delta integrator: the leftover phase is carried forward, so a 1.5-vsync-per-frame stream (50-on-75)
 *  emits a deterministic 1,2,1,2 cadence with ZERO long-term drift, robust to clock jitter. */
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

// ---- the GRADUATED, AXIS-SEPARATED graceful-degradation LADDER (replaces the atomic shouldDegrade latch) -
// The present-cap and the decode skips are INDEPENDENT axes:
//   • skip-non-ref / skip-deblock relieve the DECODER (CPU per frame) — sane whenever the decoder
//     is the bottleneck, AT ANY frame-rate.
//   • the present-cap (halve the display 50→25) relieves the PRESENTER (draw bandwidth) — only sane when the
//     halved rate stays watchable (content ≥ ~48 fps; 25→12.5 is nonsense).
// So the levers stack as a rung ∈ {0,1,2,3}: rung0 none · rung1 skip-non-ref · rung2 +skip-deblock · rung3 +present-cap. Climb ONE
// rung per settle window while decode-bound; rung2→3 is GATED on contentFps ≥ LADDER_L1_MIN_FPS (else cap at
// rung2 — never engage the nonsense halving). De-escalate in STRICT REVERSE (present-cap→skip-deblock→skip-non-ref = decrement the rung)
// on sustained HEADROOM, with ASYMMETRIC (slower) hysteresis so it never flaps. Dropping the skips before the present-cap would
// starve the now-doubled target → order matters (the rung encodes it: 3→2 drops the present-cap, 2→1 drops skip-deblock, 1→0 drops skip-non-ref).
export const RUNG_NONE = 0;     // no levers (the full-rate path)
export const RUNG_L2 = 1;       // skip non-ref (decode relief)
export const RUNG_L2_L3 = 2;    // + skip deblock (decode relief)
export const RUNG_L2_L3_L1 = 3; // + present-cap halve (draw relief; gated on content ≥ LADDER_L1_MIN_FPS)
export const RUNG_MAX = RUNG_L2_L3_L1;

export const LADDER_CLIMB_MS = 2500;       // settle/measure window between climbs (the climb-sustain horizon)
export const LADDER_DROP_MS = 9000;        // de-escalation hysteresis — ASYMMETRIC (slower) so it doesn't flap
export const LADDER_FPS_UNDER_FRAC = 0.85; // present below this × the EFFECTIVE target ⇒ under-delivering
export const LADDER_FPS_OVER_FRAC = 0.90;  // present at/above this × the EFFECTIVE target ⇒ headroom (for a drop)
export const LADDER_RATE_UNDER = 0.95;     // media/wall (clockRateRatio) below this ⇒ the stream can't keep up
export const LADDER_RATE_OVER = 1.0;       // media/wall at/above this ⇒ realtime (a headroom requirement)
export const LADDER_L1_MIN_FPS = 48;       // rung2→3 gate: only halve content fast enough that 25 stays watchable

/** The display decimation the ladder's present-cap WOULD apply at a rung: 2 only at the top rung (present-cap
 *  engaged), else 1. The caller passes the EFFECTIVE decimation (this folds in the MANUAL present-cap override
 *  too — see LadderInput.decimation); this helper is the AUTO-only value, used where manual is off. */
export function rungDecimation(rung: number): number {
  return rung >= RUNG_L2_L3_L1 ? 2 : 1;
}

export interface LadderInput {
  cadenceActive: boolean; paused: boolean; haveContentPeriod: boolean;
  presentFps: number;          // measured distinct-draw rate over the trailing 1 s window (the DISPLAYED rate)
  contentFps: number;          // TRUE content rate (from the non-ref-skip-independent packet period)
  decimation: number;          // the ACTIVE display decimation IN EFFECT this window (manual OR the rung's present-cap):
                               //   the EFFECTIVE present target = contentFps / decimation. MUST be manual-aware
                               //   so a manually-halved display (present ≈ 25-on-50) is compared apples-to-apples
                               //   and never reads as a permanent deficit; at rung 3 (auto present-cap) it is 2 as well.
  clockRateRatio: number;      // media/wall (×realtime); ≤0 ⇒ no valid clock measurement this window
  ringLow: boolean;            // present ring DRAINING (low-water ≤ ~cap/4) — decode can't keep it full
  ringHealthy: boolean;        // present ring stayed comfortably full (low-water ≥ ~cap/2) — room to drop a lever
  presentRingFull: boolean;    // present ring PINNED at ~cap all window ⇒ a present-side stall back-pressured decode
  demuxPressure: boolean;      // WEAK hint: the demux ring is high/growing (decode behind ingest)
  dWallMs: number;             // wall-ms this window (the streak accumulator increment)
}

export interface LadderState { rung: number; climbMs: number; dropMs: number }

/** The graduated-ladder state machine (PURE, headless-testable). Given the current rung + the climb/drop
 *  streaks and this window's measurement, decide the next rung + streaks. CLIMB one rung after
 *  LADDER_CLIMB_MS of CONTINUOUS decode-bound under-delivery (any non-under window resets the climb streak);
 *  rung2→3 is gated on contentFps ≥ LADDER_L1_MIN_FPS. DE-ESCALATE one rung after LADDER_DROP_MS of
 *  CONTINUOUS headroom (any non-headroom window resets the drop streak) — strictly present-cap→skip-deblock→skip-non-ref via the rung
 *  decrement. NEVER degrades a capable stream (under needs present below the effective target AND the stream
 *  genuinely can't keep up), and a PRESENT-side stall (presentRingFull, no-drop base) can never trip it. */
export function ladderStep(s: LadderState, inp: LadderInput): LadderState {
  const measurable =
    inp.cadenceActive && !inp.paused && inp.haveContentPeriod &&
    inp.contentFps > 0 && inp.presentFps > 0;
  const haveClock = inp.clockRateRatio > 0;            // a window that re-anchored the clock reports 0 ⇒ unknown
  const decim = inp.decimation > 0 ? inp.decimation : 1;
  const target = inp.contentFps / decim;              // the EFFECTIVE present (display) target this window
  // DECODE-BOUND: present below the effective target AND the stream genuinely can't keep up (media clock
  // sub-realtime OR the present ring draining OR — weak hint — the demux ring under pressure), and NOT a
  // present-side stall (a pinned-full ring = back-pressured decode, NOT a decode deficit → never degrade).
  const cantKeepUp =
    (haveClock && inp.clockRateRatio < LADDER_RATE_UNDER) || inp.ringLow || inp.demuxPressure;
  const under =
    measurable && !inp.presentRingFull &&
    inp.presentFps < target * LADDER_FPS_UNDER_FRAC && cantKeepUp;
  // HEADROOM (gates a de-escalation): present AT/ABOVE the effective target, the clock realtime, the ring
  // healthy, and no demux pressure — the stream has room to give a lever back. Requiring a VALID realtime
  // clock pins a genuinely decode-bound stream at its rung (its media/wall stays <1.0 → never headroom →
  // never re-probes), so only a truly recovered stream de-escalates.
  const headroom =
    measurable && haveClock &&
    inp.presentFps >= target * LADDER_FPS_OVER_FRAC &&
    inp.clockRateRatio >= LADDER_RATE_OVER && inp.ringHealthy && !inp.demuxPressure;
  const dW = Math.max(0, inp.dWallMs);
  if (under && s.rung < RUNG_MAX) {
    const climbMs = s.climbMs + dW;
    if (climbMs >= LADDER_CLIMB_MS) {
      // rung2→3 is GATED: only engage the present-cap when content is fast enough that halving stays watchable. If blocked
      // we cap at rung2 (re-zero the streak so it re-measures, never creeps), so 4K25 tops out at skip-non-ref+skip-deblock.
      const blockedByL1Gate = s.rung === RUNG_L2_L3 && inp.contentFps < LADDER_L1_MIN_FPS;
      const rung = blockedByL1Gate ? s.rung : s.rung + 1;
      return { rung, climbMs: 0, dropMs: 0 }; // fresh settle window at the new rung
    }
    return { rung: s.rung, climbMs, dropMs: 0 };
  }
  if (headroom && s.rung > RUNG_NONE) {
    const dropMs = s.dropMs + dW;
    if (dropMs >= LADDER_DROP_MS) return { rung: s.rung - 1, climbMs: 0, dropMs: 0 }; // drop ONE lever (present-cap→skip-deblock→skip-non-ref)
    return { rung: s.rung, climbMs: 0, dropMs };
  }
  // Neither sustained-under nor sustained-headroom (an ambiguous window, or at a rail): HOLD the rung and
  // reset both streaks — the continuous-sustain requirement means an ambiguous window breaks the streak, so
  // the ladder never creeps a rung up or down on transient noise.
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
