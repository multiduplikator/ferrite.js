// Unit test for the PURE present-cadence windowing math (the measurement fix). DOM-free, browser-free
// — this is the whole point of factoring `cadenceStats`/`cadenceSelfCheck` out of the present worker
// (which needs OffscreenCanvas/WebGL/`self`): the TRUE 1s-window math is unit-testable headless.
//
// Proves: synthetic even-20ms draws over a 1s window → p95≈20ms, stutters=0, fps≈50; ONE injected 100ms
// gap → EXACTLY 1 stutter; a seam-flagged gap is NOT a stutter (counted as a seamGap instead); fps spans
// the covered window; the self-check is silent on a clean cadence and fires when the math is wrong.
//
// Run:  node --experimental-strip-types tests/present_cadence.mjs   (or any node ≥22)

import assert from 'node:assert/strict';
import {
  cadenceStats, cadenceSelfCheck, median, nextHold, isStaleLoadGen, CADENCE_WINDOW_MS, DEFAULT_CONTENT_FPS,
  pllCorrectionPerFrame, pllCorrectionPerTick, preAudioClockAdvance, isClockDiscontinuity,
  shouldLateDrop, shouldAheadHold, checkFramedropEngage, VO_LATE_DROP_FRAMES, PRESENT_FLOOR_MS, SYNC_AHEAD_TOL_US,
} from '../src/worker/present-cadence.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// Run the Bresenham accumulator over N frames and collect the hold pattern + final error (mirrors the
// present worker's per-advance seedHold: err carries forward, content/vsync fixed).
function runCadence(contentMs, vsyncMs, frames) {
  let err = 0; const holds = [];
  for (let i = 0; i < frames; i++) { const r = nextHold(contentMs, err, vsyncMs); err = r.err; holds.push(r.hold); }
  return { holds, err };
}

// Build a rolling buffer of distinct-draw samples from a list of inter-draw intervals (ms). The first
// draw has no predecessor (interval null), mirroring a fresh measurement; the rest carry their interval.
// `seamAt` (optional set of interval indices) flags those draws as seam gaps.
function buildSamples(intervals, seamAt = new Set()) {
  const samples = [{ at: 0, interval: null, seam: false }];
  let at = 0;
  for (let i = 0; i < intervals.length; i++) {
    at += intervals[i];
    const seam = seamAt.has(i);
    samples.push({ at, interval: seam ? null : intervals[i], seam });
  }
  return samples;
}

console.log('present-cadence windowing:');

test('constants: 1s window + 50fps default content rate', () => {
  assert.equal(CADENCE_WINDOW_MS, 1000);
  assert.equal(DEFAULT_CONTENT_FPS, 50);
});

test('median is the robust period estimator (resists a dropped-frame 2× outlier)', () => {
  assert.equal(median([20, 20, 20, 40, 20]), 20); // a single 40ms (dropped-frame) outlier doesn't move it
  assert.equal(median([]), 0);
  assert.equal(median([20, 20, 20, 20]), 20);
});

test('SELF-CHECK CASE: synthetic even-20ms draws over 1s → p95≈20, stutters=0, fps≈50', () => {
  // ~50 intervals of exactly 20ms (51 draws spanning 1000ms) — a perfectly even 50fps cadence.
  const intervals = Array.from({ length: 50 }, () => 20);
  const m = cadenceStats(buildSamples(intervals), 1000 / DEFAULT_CONTENT_FPS);
  assert.equal(m.meanMs, 20, 'mean is exactly 20ms');
  assert.equal(m.p95Ms, 20, 'p95 of an even 20ms cadence is 20ms');
  assert.equal(m.maxMs, 20, 'max is 20ms');
  assert.equal(m.stutters, 0, 'an even cadence has zero stutters');
  assert.equal(m.seamGaps, 0, 'no seam gaps');
  assert.equal(m.fps, 50, 'draw rate over the window is 50fps');
  // The window-math self-check must be SILENT on this clean cadence.
  assert.equal(cadenceSelfCheck(m, 20), null, 'self-check passes (silent) on a clean 50fps window');
});

test('INJECTED-GAP CASE: one 100ms gap among 20ms draws → EXACTLY 1 stutter', () => {
  // 49 even 20ms intervals + one 100ms gap (>2×20ms threshold) = exactly one visible stutter.
  const intervals = Array.from({ length: 50 }, (_, i) => (i === 25 ? 100 : 20));
  const m = cadenceStats(buildSamples(intervals), 1000 / DEFAULT_CONTENT_FPS);
  assert.equal(m.stutters, 1, 'the single 100ms gap is exactly one stutter');
  assert.equal(m.maxMs, 100, 'the worst interval is the 100ms gap');
  assert.equal(m.seamGaps, 0, 'an in-stream gap is a stutter, not a seam gap');
  // p95 over 50 intervals (nearest-rank ceil(0.95*50)=48th) is still a 20ms steady interval.
  assert.equal(m.p95Ms, 20, 'a single outlier does not move the p95 of a 50-sample window');
});

test('a seam-flagged gap is NOT a stutter — it is counted as a seamGap', () => {
  // Same 100ms gap, but flagged as a seam (reconnect/re-anchor freeze): dropped from stutter stats.
  const intervals = Array.from({ length: 50 }, (_, i) => (i === 25 ? 100 : 20));
  const m = cadenceStats(buildSamples(intervals, new Set([25])), 1000 / DEFAULT_CONTENT_FPS);
  assert.equal(m.stutters, 0, 'a seam freeze never masquerades as a steady-state stutter');
  assert.equal(m.seamGaps, 1, 'the freeze is visible as exactly one seam gap');
  assert.equal(m.maxMs, 20, 'the seam interval is excluded from the steady-state max too');
});

test('fps is the draw rate over the covered span (robust to a partial startup window)', () => {
  // Only 5 even-20ms intervals so far (6 draws spanning 100ms) → still reports 50fps, not 6.
  const m = cadenceStats(buildSamples([20, 20, 20, 20, 20]), 20);
  assert.equal(m.fps, 50, 'rate over the covered span, not a raw count of a partial window');
  assert.equal(m.meanMs, 20);
});

test('empty / single-draw buffers fold to zeros (no NaN)', () => {
  const z = cadenceStats([], 20);
  assert.deepEqual(z, { fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, stutters: 0, seamGaps: 0 });
  const one = cadenceStats([{ at: 0, interval: null, seam: false }], 20);
  assert.deepEqual(one, { fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, stutters: 0, seamGaps: 0 });
});

test('self-check FIRES when the window math is wrong (p95 blown at a clean fps/mean)', () => {
  // A hand-built metric that LOOKS like 50fps/20ms-mean but has an impossible p95/stutters — the kind of
  // contradiction a windowing bug would produce. The self-check must flag it.
  const bogus = { fps: 50, meanMs: 20, p95Ms: 90, maxMs: 120, stutters: 4, seamGaps: 0 };
  const problem = cadenceSelfCheck(bogus, 20);
  assert.ok(problem && /self-check FAILED/.test(problem), 'a contradictory window is flagged');
});

test('self-check stays silent OUTSIDE its defined regime (not a 50fps clip)', () => {
  // 25fps cadence (40ms intervals): the invariant is defined relative to the period, so a clean 25fps
  // window also passes; and a genuinely stuttery non-content-rate window is not asserted on.
  const m = cadenceStats(buildSamples(Array.from({ length: 25 }, () => 40)), 40);
  assert.equal(m.fps, 25);
  assert.equal(cadenceSelfCheck(m, 40), null, 'a clean 25fps window passes its own period-relative check');
  // fps far from the period-implied rate → outside regime → silent (returns null), never a false alarm.
  const offRegime = { fps: 12, meanMs: 20, p95Ms: 200, maxMs: 400, stutters: 9, seamGaps: 0 };
  assert.equal(cadenceSelfCheck(offRegime, 20), null, 'outside the steady-near-content-rate regime → silent');
});

// ---- Bresenham display cadence (mpv video.c:835-843) — the 50-on-75 anti-judder core ----

test('50-on-75: the Bresenham cadence emits a clean alternating 2,1 with zero long-term drift', () => {
  const vsync = 1000 / 75; // 13.333… ms
  const content = 1000 / 50; // 20 ms  (ratio = 1.5 vsyncs/frame)
  const { holds, err } = runCadence(content, vsync, 100);
  // every hold is 1 or 2, and they strictly alternate (2,1,2,1,…) — the deterministic 50-on-75 beat.
  assert.ok(holds.every((h) => h === 1 || h === 2), 'holds are only 1 or 2 vsyncs');
  for (let i = 1; i < holds.length; i++) assert.notEqual(holds[i], holds[i - 1], 'holds strictly alternate');
  // ratio 1.5 → Math.round(1.5)=2 → the leading phase is 2,1,2,1 (matches the reference player exactly).
  assert.deepEqual(holds.slice(0, 4), [2, 1, 2, 1], 'leading phase 2,1,2,1');
  // mean hold = 1.5 vsyncs/frame; total vsyncs ≈ 1.5×frames (zero drift).
  const sum = holds.reduce((a, b) => a + b, 0);
  assert.equal(sum, 150, '100 frames span exactly 150 vsyncs (1.5 each — no accumulated drift)');
  assert.ok(Math.abs(err) <= vsync, `the carried error stays bounded by one vsync (|err|=${err.toFixed(2)})`);
});

test('60-on-60 (1:1): every frame holds exactly 1 vsync, error stays 0', () => {
  const v = 1000 / 60; const { holds, err } = runCadence(v, v, 50);
  assert.ok(holds.every((h) => h === 1), 'a 1:1 ratio holds 1 vsync per frame');
  assert.ok(Math.abs(err) < 1e-9, 'no fractional remainder to carry');
});

test('24-on-60 (2.5): the classic 3,2 pulldown cadence, zero long-term drift', () => {
  const vsync = 1000 / 60; const content = 1000 / 24; // ratio 2.5
  const { holds, err } = runCadence(content, vsync, 100);
  assert.ok(holds.every((h) => h === 2 || h === 3), 'holds are 2 or 3 (3:2 pulldown)');
  for (let i = 1; i < holds.length; i++) assert.notEqual(holds[i], holds[i - 1], 'must alternate 3,2');
  // f64: ratio 41.667/16.667 rounds to 2.4999998 → first hold 2 → the phase leads 2,3,2,3.
  assert.deepEqual(holds.slice(0, 4), [2, 3, 2, 3], 'leading phase 2,3,2,3');
  const sum = holds.reduce((a, b) => a + b, 0);
  assert.equal(sum, 250, '100 frames at 2.5 vsyncs each span exactly 250 vsyncs');
  assert.ok(Math.abs(err) <= vsync, 'carried error bounded');
});

test('25-on-75 (exactly 3): an integer divisor → constant hold-3, zero carried error', () => {
  const vsync = 1000 / 75; const content = 1000 / 25; // ratio exactly 3
  const { holds, err } = runCadence(content, vsync, 100);
  assert.ok(holds.every((h) => h === 3), 'integer ratio → constant 3');
  assert.ok(Math.abs(err) < 1e-9, 'no carried error on an integer divisor');
});

test('50-on-100 (exactly 2): an integer divisor → constant hold-2, zero carried error', () => {
  const vsync = 1000 / 100; const content = 1000 / 50; // ratio exactly 2
  const { holds, err } = runCadence(content, vsync, 100);
  assert.ok(holds.every((h) => h === 2), 'integer ratio → constant 2');
  assert.ok(Math.abs(err) < 1e-9, 'no carried error');
});

test('no long-run drift: 10 000 frames keep the carried error bounded by one vsync (sigma-delta stable)', () => {
  const vsync = 1000 / 75; const content = 1000 / 50;
  const { holds, err } = runCadence(content, vsync, 10_000);
  assert.ok(Math.abs(err) <= vsync, `error stays bounded over a long run (|err|=${err.toFixed(2)})`);
  const sum = holds.reduce((a, b) => a + b, 0);
  const ideal = 10_000 * content / vsync;
  assert.ok(Math.abs(sum - ideal) <= 1, `long-run sum ${sum} vs ideal ${ideal}`);
});

test('50-on-60 (1.2): mostly-1 with a periodic 2, bounded error', () => {
  const vsync = 1000 / 60; const content = 1000 / 50; // ratio 1.2
  const { holds, err } = runCadence(content, vsync, 100);
  assert.ok(holds.every((h) => h === 1 || h === 2), 'holds are 1 or 2');
  const sum = holds.reduce((a, b) => a + b, 0);
  assert.equal(sum, 120, '100 frames at 1.2 vsyncs each span exactly 120 vsyncs');
  assert.ok(Math.abs(err) <= vsync, 'error bounded by one vsync');
});

test('hold is clamped to ≥1 (a faster-than-refresh frame never gets a zero/dropped hold)', () => {
  // content shorter than a vsync (e.g. 120fps content on 60Hz) → ratio<1 → round could be 0; clamp to 1.
  const r = nextHold(1000 / 120, 0, 1000 / 60); // ratio 0.5 → round 0 → clamp 1
  assert.equal(r.hold, 1, 'never a zero-vsync hold');
});

// --- present-ring generation guard (the load→load stale-frame [VERIFY]) -------------------------------
// The present-ring `reset` (main channel) and decoded frames (decode→present port) are unordered, so a
// frame the OLD load left in flight can reach the present worker after the reset installed the new
// generation. isStaleLoadGen is what makes the present worker DROP it instead of flashing the prior
// stream — without dropping a single live frame on the normal path.

test('stale guard: an older-generation frame is stale (dropped, never enters the fresh ring)', () => {
  assert.equal(isStaleLoadGen(1, 2), true, 'gen 1 frame after a reload to gen 2 is stale');
  assert.equal(isStaleLoadGen(0, 5), true, 'a pre-first-reset (gen 0) frame is stale once gen advances');
});

test('stale guard: a current-generation frame is NOT stale (steady state never drops a live frame)', () => {
  assert.equal(isStaleLoadGen(2, 2), false, 'gen===curGen (the steady-state path) is kept');
  assert.equal(isStaleLoadGen(7, 7), false, 'every in-stream frame carries the current gen ⇒ kept');
});

test('stale guard: a not-yet-installed (future) generation is NOT dropped (reset arrives next, flushes)', () => {
  // A frame can briefly carry a gen NEWER than the present worker's if its frames out-race the reset; it
  // must not be dropped here (the imminent reset flushes the ring) — only strictly-OLDER frames are stale.
  assert.equal(isStaleLoadGen(3, 2), false, 'a newer gen is not stale (handled by the reset, not the guard)');
});

// ---- master-clock PLL (mpv adjust_sync) — the clamped per-frame / per-tick correction ----------------

test('PLL clamp bounds the per-frame correction to frame_period·{0.1,0.4}; a 0.5s residual is a tiny nudge', () => {
  const fp = 20_000; // 50 fps content period (µs)
  // Small residual (< 0.3 s): gain 0.1, clamp ±frame*0.1 = ±2000 µs. 50 ms residual → change=5000, clamped 2000.
  assert.ok(Math.abs(pllCorrectionPerFrame(50_000, fp) - 2_000) < 1e-9, 'near-band 50ms residual → clamp 2000');
  // Tiny residual stays in the linear (gain) region: 10 ms → change=1000 < clamp 2000 → 1000.
  assert.ok(Math.abs(pllCorrectionPerFrame(10_000, fp) - 1_000) < 1e-9, 'tiny residual stays linear');
  // Large residual (≥ 0.3 s): factor 0.4, clamp ±frame*0.4 = ±8000 µs. 0.5 s → change=50000, clamped 8000.
  assert.ok(Math.abs(pllCorrectionPerFrame(500_000, fp) - 8_000) < 1e-9, 'far-band 0.5s residual → clamp 8000 (not 200000)');
  // Symmetric for a negative (video ahead) residual.
  assert.ok(Math.abs(pllCorrectionPerFrame(-500_000, fp) + 8_000) < 1e-9, 'symmetric on a negative residual');
  // Bad period → no correction (defensive).
  assert.equal(pllCorrectionPerFrame(500_000, 0), 0, 'framePeriod ≤ 0 → 0');
  // per-tick 0.5 s residual at 13.33 ms ticks ≪ 200 ms.
  const perTick = pllCorrectionPerTick(500_000, fp, 13_333);
  assert.ok(perTick < 200_000, 'per-tick correction stays small');
  assert.ok(perTick <= 8_000 + 1e-6, "per-tick can't exceed the per-frame clamp");
  // Proration: a full content-frame's worth of ticks accumulates ~the per-frame budget (not more).
  assert.ok(Math.abs(pllCorrectionPerTick(500_000, fp, fp) - 8_000) < 1e-9, 'dt==frame → full per-frame budget');
  assert.ok(pllCorrectionPerTick(500_000, fp, fp * 2) <= 8_000 + 1e-6, 'dt>frame capped at the 1.0 share');
  assert.equal(pllCorrectionPerTick(500_000, 0, 13_333), 0, 'framePeriod ≤ 0 → 0 (per-tick too)');
});

// ---- pre-audio startup advance (mpv restart alignment) ----------------------------------------------

test('preAudioClockAdvance: wall-paced but clamped to the newest decoded frame, never rewinds', () => {
  // wanted +100 ms (1.0→1.1 s) but newest is only 1.02 s → pinned at newest (no wall overrun → no black-canvas).
  assert.ok(Math.abs(preAudioClockAdvance(1_000_000, 100, 1_020_000) - 1_020_000) < 1e-9, 'clamped to newest pts');
  // headroom: +10 ms well under newest → normal advance.
  assert.ok(Math.abs(preAudioClockAdvance(1_000_000, 10, 5_000_000) - 1_010_000) < 1e-9, 'headroom → normal advance');
  // stale/non-monotonic newest below mediaUs → never rewind (max(mediaUs) guard holds).
  assert.ok(Math.abs(preAudioClockAdvance(2_000_000, 100, 1_500_000) - 2_000_000) < 1e-9, 'never below mediaUs');
  // single frame (media==newest) → pin at frame 1 until a 2nd arrives.
  assert.ok(Math.abs(preAudioClockAdvance(1_000_000, 16.7, 1_000_000) - 1_000_000) < 1e-9, 'pin at the single frame');
  // zero dt → unchanged.
  assert.equal(preAudioClockAdvance(1_234, 0, 9_999), 1_234, 'dt 0 → unchanged');
});

// ---- live PTS-epoch discontinuity classification (mpv ts_resets_possible) ----------------------------

test('isClockDiscontinuity: live ≥5s = epoch reset (snap); below = slew; VOD never snaps', () => {
  const snap = 5_000_000; // 5 s
  assert.equal(isClockDiscontinuity(false, 10_000_000, snap), false, 'VOD never snaps (even a 10 s slew)');
  assert.equal(isClockDiscontinuity(true, 4_000_000, snap), false, 'live 4 s splice → PLL absorbs (no snap)');
  assert.equal(isClockDiscontinuity(true, 6_000_000, snap), true, 'live 6 s → snap');
  assert.equal(isClockDiscontinuity(true, -3_600_000_000, snap), true, 'live loop (backward 3600 s) → snap');
  assert.equal(isClockDiscontinuity(true, 4_999_000, snap), false, 'just under → no snap');
  assert.equal(isClockDiscontinuity(true, 5_001_000, snap), true, 'just over → snap');
});

// ---- mpv VO late-drop (Axis 1) ----------------------------------------------------------------------

test('shouldLateDrop: drop a >2-frame-late front, but never paused / no-successor / past the freeze floor', () => {
  const fp = 20_000; // 50 fps frame period
  const late = (VO_LATE_DROP_FRAMES + 0.5) * fp;  // comfortably past the late threshold
  const early = (VO_LATE_DROP_FRAMES - 0.5) * fp; // not yet late enough
  assert.equal(shouldLateDrop(late, fp, 10, false, 3), true, 'late + within the floor + a successor → drop');
  assert.equal(shouldLateDrop(early, fp, 10, false, 3), false, 'not late enough → keep');
  assert.equal(shouldLateDrop(late, fp, PRESENT_FLOOR_MS + 1, false, 3), false, 'floor breached → show it, don\'t freeze');
  assert.equal(shouldLateDrop(late, fp, 10, true, 3), false, 'paused → never drop');
  assert.equal(shouldLateDrop(late, fp, 10, false, 1), false, 'no successor → never drop (would blank the screen)');
});

// ---- mpv display-sync ahead-hold (Axis 1, the mirror of late-drop) ----------------------------------

test('shouldAheadHold: hold a >20ms-AND->1-vsync-ahead front, but never paused / empty-ring / past the floor', () => {
  const vs = 13_333; // 75 Hz display vsync (µs)
  // ahead past BOTH arms (25ms > 20ms AND > 13.3ms vsync) + within the floor → hold.
  assert.equal(shouldAheadHold(25_000, vs, 10, false, 3), true, 'ahead past both arms + within floor → hold');
  // ring_len === 1 still holds — the hold only needs ring[0] (the ONE divergence from shouldLateDrop's `< 2`).
  assert.equal(shouldAheadHold(25_000, vs, 10, false, 1), true, 'single-frame ring still holds (locks the `< 1` boundary)');
  // the old 120 ms ahead-guard latch point now corrects.
  assert.equal(shouldAheadHold(120_000, vs, 10, false, 3), true, 'the old ~120ms latch now bleeds off');
  // AND-gate arm 1: clears the vsync but not the 20 ms floor → false.
  assert.equal(shouldAheadHold(18_000, vs, 10, false, 3), false, '18ms clears the vsync but fails the 20ms tol → no hold');
  // AND-gate arm 2: 22 ms clears 20 ms but not a 40 Hz (25 ms) vsync → false.
  assert.equal(shouldAheadHold(22_000, 25_000, 10, false, 3), false, '22ms clears 20ms but fails a 25ms vsync → no hold');
  // strict `>`: exactly the 20 ms tolerance → false.
  assert.equal(shouldAheadHold(SYNC_AHEAD_TOL_US, vs, 10, false, 3), false, 'exactly 20ms is not > 20ms → no hold');
  assert.equal(shouldAheadHold(25_000, vs, PRESENT_FLOOR_MS + 1, false, 3), false, 'floor breached → show it, don\'t freeze');
  assert.equal(shouldAheadHold(25_000, vs, 10, true, 3), false, 'paused → never hold');
  assert.equal(shouldAheadHold(25_000, vs, 10, false, 0), false, 'empty ring → nothing to hold');
  assert.equal(shouldAheadHold(25_000, 0, 10, false, 3), false, 'degenerate vsync (0) → no hold');
});

// ---- mpv check_framedrop (Axis-2 rung-1) hysteresis -------------------------------------------------

test('checkFramedropEngage: engage <1 frame headroom, release >3 frames, HOLD in the [1,3]-frame band', () => {
  const fp = 20_000; // 50 fps frame period
  // not engaged: engages only when headroom < 1 frame.
  assert.equal(checkFramedropEngage(false, 1.5 * fp, fp), false, 'ahead → no engage');
  assert.equal(checkFramedropEngage(false, 0.5 * fp, fp), true, 'behind → engage');
  assert.equal(checkFramedropEngage(false, -fp, fp), true, 'well behind → engage');
  // engaged: stays engaged through the band, releases only above 3 frames.
  assert.equal(checkFramedropEngage(true, 2.0 * fp, fp), true, 'in band → stay engaged');
  assert.equal(checkFramedropEngage(true, 2.9 * fp, fp), true, 'just under 3 frames → stay');
  assert.equal(checkFramedropEngage(true, 3.1 * fp, fp), false, 'comfortably ahead → release');
  // unknown frame period → preserve the current state (no spurious toggle).
  assert.equal(checkFramedropEngage(true, 0, 0), true, 'unknown period → keep engaged state');
  assert.equal(checkFramedropEngage(false, -1, 0), false, 'unknown period → keep released state');
});

console.log(`\npresent-cadence: ${passed} passed`);
