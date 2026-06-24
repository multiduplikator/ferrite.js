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

test('50-on-75: the Bresenham cadence emits a clean alternating 1,2 with zero long-term drift', () => {
  const vsync = 1000 / 75; // 13.333… ms
  const content = 1000 / 50; // 20 ms  (ratio = 1.5 vsyncs/frame)
  const { holds, err } = runCadence(content, vsync, 100);
  // every hold is 1 or 2, and they strictly alternate (1,2,1,2,…) — the deterministic 50-on-75 beat.
  assert.ok(holds.every((h) => h === 1 || h === 2), 'holds are only 1 or 2 vsyncs');
  for (let i = 1; i < holds.length; i++) assert.notEqual(holds[i], holds[i - 1], 'holds strictly alternate');
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
  const { holds } = runCadence(content, vsync, 100);
  assert.ok(holds.every((h) => h === 2 || h === 3), 'holds are 2 or 3 (3:2 pulldown)');
  const sum = holds.reduce((a, b) => a + b, 0);
  assert.equal(sum, 250, '100 frames at 2.5 vsyncs each span exactly 250 vsyncs');
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

console.log(`\npresent-cadence: ${passed} passed`);
