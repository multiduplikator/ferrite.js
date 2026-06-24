// Unit test for the PURE vsync estimator (mpv-style display-refresh measurement from rAF intervals).
// DOM-free / rAF-free — the whole point of factoring it out of the present worker is a headless gate.
//
// Proves: the robust median ignores missed-vsync 2×/3× outliers; the warmup window is skipped; out-of-band
// pause/background gaps never enter the ring; a steady 75 Hz stream ADOPTS the measured ~13.33 ms once it
// has enough low-jitter samples; a sub-threshold sample count / out-of-range interval / bimodal beat does
// NOT adopt (falls back to the nominal 60 Hz); the jitter + measured-Hz telemetry are sane.
//
// Run:  node --experimental-strip-types tests/vsync_estimator.mjs   (or any node ≥22)

import assert from 'node:assert/strict';
import {
  VsyncEstimator, median, normalizedJitter, withinTolFraction, evaluateGate,
  SKIP_SAMPLES, MIN_SAMPLES, NOMINAL_INTERVAL_MS, VSYNC_MIN_MS, VSYNC_MAX_MS, MAX_DT_MS,
  RING_CAP, RECENT_N,
} from '../src/worker/vsync-estimator.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const HZ75 = 1000 / 75; // 13.333… ms

console.log('vsync-estimator:');

test('median is robust to a missed-vsync 2×/3× outlier', () => {
  assert.equal(median([13.33, 13.33, 13.33, 26.66, 13.33]), 13.33);
  assert.equal(median([]), 0);
});

test('normalizedJitter: even stream → 0; spread → >0', () => {
  assert.equal(normalizedJitter([HZ75, HZ75, HZ75], HZ75), 0);
  assert.ok(normalizedJitter([10, 13, 16, 20], median([10, 13, 16, 20])) > 0);
  assert.equal(normalizedJitter([], 13), 0);
});

test('withinTolFraction counts samples inside ±tol of center', () => {
  assert.equal(withinTolFraction([10, 10, 10, 10], 10, 0.25), 1);
  assert.equal(withinTolFraction([10, 10, 20, 20], 10, 0.25), 0.5);
  assert.equal(withinTolFraction([], 10, 0.25), 0);
});

test('NOMINAL fallback before adoption (too few samples)', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < 30; i++) est.push(HZ75); // < MIN_SAMPLES after the warmup skip
  assert.equal(est.isAdopted, false, 'not enough samples → not adopted');
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS, 'falls back to the nominal 60 Hz interval');
});

test('warmup window (first SKIP_SAMPLES) is dropped', () => {
  const est = new VsyncEstimator();
  // Feed SKIP_SAMPLES garbage then nothing — none should reach the ring → still nominal, hz 0.
  for (let i = 0; i < SKIP_SAMPLES; i++) est.push(999 > MAX_DT_MS ? HZ75 : HZ75); // SKIP_SAMPLES valid dts
  assert.equal(est.measuredHz, 0, 'the warmup dts were skipped → empty ring');
});

test('steady 75 Hz ADOPTS the measured ~13.33 ms after enough samples', () => {
  const est = new VsyncEstimator();
  const N = SKIP_SAMPLES + MIN_SAMPLES + 20;
  for (let i = 0; i < N; i++) est.push(HZ75);
  assert.equal(est.isAdopted, true, 'a steady low-jitter stream adopts');
  assert.ok(near(est.intervalMs, HZ75), `interval ≈ 13.33 ms (got ${est.intervalMs})`);
  assert.ok(near(est.measuredHz, 75, 0.5), `measured ≈ 75 Hz (got ${est.measuredHz})`);
  assert.ok(est.jitter <= 0.001, 'an even stream has ~0 jitter');
});

test('occasional missed vsync (2× dt) does NOT corrupt the adopted interval', () => {
  const est = new VsyncEstimator();
  const N = SKIP_SAMPLES + MIN_SAMPLES + 40;
  for (let i = 0; i < N; i++) est.push(i % 20 === 0 ? 2 * HZ75 : HZ75); // ~5 % missed vsyncs
  assert.equal(est.isAdopted, true, 'a few outliers still allow adoption (90 % within tol)');
  assert.ok(near(est.intervalMs, HZ75), `median ignores the 2× outliers (got ${est.intervalMs})`);
});

test('out-of-band gaps (pause / background / dt≤0) never enter the ring', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES; i++) est.push(HZ75); // burn the warmup
  est.push(500);   // a pause/background gap (> MAX_DT_MS) → dropped
  est.push(0);     // first-tick dt=0 → dropped
  est.push(-5);    // nonsense → dropped
  assert.equal(est.measuredHz, 0, 'no in-band sample reached the ring after the warmup');
});

test('a bimodal 30/60-style beat does NOT adopt (gate rejects an unstable refresh)', () => {
  const est = new VsyncEstimator();
  const N = SKIP_SAMPLES + MIN_SAMPLES + 40;
  for (let i = 0; i < N; i++) est.push(i % 2 === 0 ? HZ75 : 33.33); // alternating 13.33 / 33.33 ms
  assert.equal(est.isAdopted, false, 'a wide bimodal spread fails the tol/jitter gate');
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS, 'falls back to nominal while unstable');
});

test('evaluateGate rejects an out-of-range median', () => {
  const tooFast = Array.from({ length: MIN_SAMPLES + 10 }, () => VSYNC_MIN_MS / 2); // > 400 Hz
  const tooSlow = Array.from({ length: MIN_SAMPLES + 10 }, () => VSYNC_MAX_MS * 2); // < 20 Hz
  assert.equal(evaluateGate(tooFast).adopt, false, 'faster than 400 Hz is rejected');
  assert.equal(evaluateGate(tooSlow).adopt, false, 'slower than 20 Hz is rejected');
});

test('latch hysteresis: a degraded refresh DISENGAGES, then re-adopts when it stabilizes', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES + MIN_SAMPLES + 20; i++) est.push(HZ75);
  assert.equal(est.isAdopted, true, 'adopts a steady 75 Hz');
  // Flood the ring with a wide in-band spread (median stays in [2.5,50]ms but tightness collapses) —
  // a genuine refresh breakdown, not mere jitter → the latch must DROP back to nominal.
  for (let i = 0; i < 260; i++) est.push(i % 2 === 0 ? 5 : 45);
  assert.equal(est.isAdopted, false, 'a collapsed cluster (tolFrac < floor) disengages the cadence');
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS, 'falls back to nominal while degraded');
  // Refill with a steady refresh (enough to flush the 256-deep ring of bad samples) → re-adopt.
  for (let i = 0; i < 260; i++) est.push(HZ75);
  assert.equal(est.isAdopted, true, 're-adopts once the refresh is stable again');
});

test('reset() re-arms to the nominal fallback', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES + MIN_SAMPLES + 20; i++) est.push(HZ75);
  assert.equal(est.isAdopted, true);
  est.reset();
  assert.equal(est.isAdopted, false, 'reset clears the latch + ring');
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS);
});

// --- multi-monitor mixed-refresh regime tracking ---
const HZ60 = 1000 / 60;   // 16.667 ms
const HZ144 = 1000 / 144; // 6.944 ms

test('below MIN_SAMPLES but a tight recent cluster reports the REAL rate (not nominal)', () => {
  // The multi-monitor fix #3: a 100/144 Hz primary must not be stuck on 60 Hz before adoption.
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES + MIN_SAMPLES - 1; i++) est.push(HZ75);
  assert.equal(est.isAdopted, false, 'still below MIN_SAMPLES → not adopted');
  assert.ok(near(est.intervalMs, HZ75), `tight pre-adoption cluster reports the real rate: ${est.intervalMs}`);
});

test('true cold start (< RECENT_N samples) falls back to nominal', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES; i++) est.push(HZ144);       // burn warmup
  for (let i = 0; i < RECENT_N - 1; i++) est.push(HZ144);       // one short of a trustworthy window
  assert.equal(est.isAdopted, false);
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS, 'cold start → nominal');
});

test('regime change 60→144 Hz re-acquires fast (the multi-monitor bug)', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES + MIN_SAMPLES + 20; i++) est.push(HZ60);
  assert.equal(est.isAdopted, true, 'adopt 60 Hz first');
  assert.ok(near(est.intervalMs, HZ60));
  // Drag to the 144 Hz monitor: one recent window of the new rate must re-acquire it.
  for (let i = 0; i < RECENT_N; i++) est.push(HZ144);
  assert.ok(near(est.intervalMs, HZ144), `re-acquire 144 Hz within RECENT_N frames: ${est.intervalMs}`);
  // Fully re-adopts once a whole ring of the new rate flushes the stale 60 Hz samples.
  for (let i = 0; i < RING_CAP + 20; i++) est.push(HZ144);
  assert.equal(est.isAdopted, true, 're-adopts at the new rate');
  assert.ok(near(est.intervalMs, HZ144));
});

test('bimodal straddle (alternating monitor rates) stays nominal — no regime thrash', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES; i++) est.push(HZ60);
  for (let i = 0; i < MIN_SAMPLES + RECENT_N + 40; i++) est.push(i % 2 === 0 ? HZ144 : HZ60);
  assert.equal(est.isAdopted, false, 'a bimodal straddle never adopts');
  assert.equal(est.intervalMs, NOMINAL_INTERVAL_MS, 'bimodal → nominal floor (no spurious re-acquire)');
});

test('stable 144 Hz + jitter never regime-drops (no regression)', () => {
  const est = new VsyncEstimator();
  for (let i = 0; i < SKIP_SAMPLES + MIN_SAMPLES + 20; i++) est.push(HZ144);
  assert.equal(est.isAdopted, true);
  for (let i = 0; i < RING_CAP * 2; i++) {
    est.push(i % 2 === 0 ? HZ144 * 0.97 : HZ144 * 1.03);
    assert.equal(est.isAdopted, true, 'stable 144 Hz + jitter must stay adopted (no thrash)');
  }
});

console.log(`\nvsync-estimator: ${passed} passed`);
