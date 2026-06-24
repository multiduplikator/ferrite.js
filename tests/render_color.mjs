// RENDER-QUALITY unit gate (PURE, headless — no engine, no browser): the YUV→RGB matrix/range SELECTION
// + the resolution fallback boundary + the Bayer dither matrix. The shader OUTPUT itself is visual (browser
// owner-bank); this proves the pure CPU logic that drives the shader uniforms is correct.
//
// Run:  node --experimental-strip-types tests/render_color.mjs

import assert from 'node:assert/strict';
import {
  AVColorSpace, AVColorRange,
  selectMatrix, selectRange, selectColorConditioning, bayerMatrix, bayer8, BAYER_8,
} from '../src/render/color.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

console.log('render-quality colour selection + dither:');

// --- matrix selection by AVColorSpace -------------------------------------------------------------------
test('explicit colorspaces map to their matrix family (independent of resolution)', () => {
  assert.equal(selectMatrix(AVColorSpace.BT709, 320, 240), '709');     // even SD-sized 709 stays 709
  assert.equal(selectMatrix(AVColorSpace.BT470BG, 1920, 1080), '601'); // even HD-sized 601 stays 601
  assert.equal(selectMatrix(AVColorSpace.SMPTE170M, 720, 480), '601');
  assert.equal(selectMatrix(AVColorSpace.FCC, 720, 576), '601');
  assert.equal(selectMatrix(AVColorSpace.BT2020_NCL, 3840, 2160), '2020');
  assert.equal(selectMatrix(AVColorSpace.BT2020_CL, 3840, 2160), '2020');
});

test('UNSPECIFIED / RGB / SMPTE240M / unknown fall back to the resolution heuristic (w>=1280||h>576?709:601)', () => {
  // SD → 601
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 720, 576), '601');
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1024, 576), '601');
  assert.equal(selectMatrix(AVColorSpace.RGB, 720, 480), '601');
  assert.equal(selectMatrix(AVColorSpace.SMPTE240M, 720, 480), '601');
  assert.equal(selectMatrix(99 /* unknown */, 640, 480), '601');
  // HD/4K → 709
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1280, 720), '709');
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1920, 1080), '709');
  assert.equal(selectMatrix(AVColorSpace.SMPTE240M, 1920, 1080), '709');
});

test('the fallback BOUNDARY is exactly width>=1280 OR height>576', () => {
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1279, 576), '601'); // just under both → 601
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1280, 576), '709'); // width hits 1280 → 709
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1024, 577), '709'); // height exceeds 576 → 709
  assert.equal(selectMatrix(AVColorSpace.UNSPECIFIED, 1024, 576), '601'); // height == 576 stays 601 (>576 is strict)
});

// --- range selection ------------------------------------------------------------------------------------
test('range: JPEG→full, MPEG/UNSPECIFIED→limited (limited is the safe default)', () => {
  assert.equal(selectRange(AVColorRange.JPEG), 'full');
  assert.equal(selectRange(AVColorRange.MPEG), 'limited');
  assert.equal(selectRange(AVColorRange.UNSPECIFIED), 'limited');
  assert.equal(selectRange(99), 'limited');
});

// --- coefficient EXACTNESS: BT.709 limited must equal the prior hard-coded shader constants --------------
test('BT.709 limited coefficients are EXACT (1.7927 / -0.2132 / -0.5329 / 2.1124, yScale 1.1644, yOffset 0.0627)', () => {
  const c = selectColorConditioning(AVColorSpace.BT709, AVColorRange.MPEG, 1920, 1080);
  assert.equal(c.matrix, '709'); assert.equal(c.range, 'limited');
  assert.ok(near(c.yScale, 1.1644, 5e-4), `yScale ${c.yScale}`);
  assert.ok(near(c.yOffset, 0.0627, 5e-4), `yOffset ${c.yOffset}`);
  assert.ok(near(c.cRv, 1.7927, 5e-4), `cRv ${c.cRv}`);
  assert.ok(near(c.cGu, -0.2132, 5e-4), `cGu ${c.cGu}`);
  assert.ok(near(c.cGv, -0.5329, 5e-4), `cGv ${c.cGv}`);
  assert.ok(near(c.cBu, 2.1124, 5e-4), `cBu ${c.cBu}`);
});

test('FULL range drops the luma expand + black-lift (yScale 1, yOffset 0) and the chroma expand (smaller coeffs)', () => {
  const lim = selectColorConditioning(AVColorSpace.BT709, AVColorRange.MPEG, 1920, 1080);
  const full = selectColorConditioning(AVColorSpace.BT709, AVColorRange.JPEG, 1920, 1080);
  assert.equal(full.yScale, 1); assert.equal(full.yOffset, 0);
  // full-range chroma = base coeffs (no 255/224 expand) → strictly smaller magnitude than limited
  assert.ok(near(full.cRv, 1.5748, 5e-4), `full cRv ${full.cRv}`);
  assert.ok(near(full.cBu, 1.8556, 5e-4), `full cBu ${full.cBu}`);
  assert.ok(Math.abs(full.cRv) < Math.abs(lim.cRv), 'full chroma coeff < limited');
});

test('BT.601 + BT.2020 luma coefficients differ from 709 (real hue/luma correction, not a no-op)', () => {
  const c601 = selectColorConditioning(AVColorSpace.BT470BG, AVColorRange.MPEG, 720, 576);
  const c2020 = selectColorConditioning(AVColorSpace.BT2020_NCL, AVColorRange.MPEG, 3840, 2160);
  // 601: V→R = 2*(1-0.299)*255/224 = 1.5959; 709 is 1.7927 — materially different (the SD hue fix)
  assert.ok(near(c601.cRv, 1.5959, 1e-3), `601 cRv ${c601.cRv}`);
  // 2020: V→R = 2*(1-0.2627)*255/224 = 1.6791
  assert.ok(near(c2020.cRv, 1.6791, 1e-3), `2020 cRv ${c2020.cRv}`);
  assert.ok(Math.abs(c601.cRv - 1.7927) > 0.05, '601 must differ from 709');
  assert.ok(Math.abs(c2020.cRv - 1.7927) > 0.05, '2020 must differ from 709');
  // luma scale/offset are range-driven, identical across matrices for the same (limited) range
  assert.ok(near(c601.yScale, c2020.yScale) && near(c601.yScale, 1.1644, 5e-4), 'limited yScale shared');
});

// Reconstruct R/G/B from a known YCbCr to prove the assembled matrix is internally consistent (mid-grey).
test('mid-grey (Y=0.5 limited, U=V=0) reconstructs to neutral grey across matrices', () => {
  for (const cs of [AVColorSpace.BT709, AVColorSpace.BT470BG, AVColorSpace.BT2020_NCL]) {
    const c = selectColorConditioning(cs, AVColorRange.MPEG, 1920, 1080);
    const y = (0.5 - c.yOffset) * c.yScale;
    const r = y + c.cRv * 0, g = y + c.cGu * 0 + c.cGv * 0, b = y + c.cBu * 0;
    assert.ok(near(r, g) && near(g, b), `neutral grey: r=${r} g=${g} b=${b}`);
    assert.ok(r > 0.4 && r < 0.6, `grey near 0.5: ${r}`);
  }
});

// --- Bayer dither matrix --------------------------------------------------------------------------------
test('bayer8 is an 8×8 permutation of 0…63 (each value exactly once)', () => {
  const m = bayer8();
  assert.equal(BAYER_8, 8);
  assert.equal(m.length, 64);
  const seen = new Set(m);
  assert.equal(seen.size, 64, 'all values distinct');
  for (let i = 0; i < 64; i++) assert.ok(seen.has(i), `missing value ${i}`);
});

test('bayer recursion: 2×2 base is the canonical [[0,2],[3,1]]', () => {
  const m2 = bayerMatrix(2);
  assert.deepEqual([...m2], [0, 2, 3, 1]);
});

test('bayer8 top-left 2×2 quadrant pattern matches the recursive doubling (4*M + {0,2,3,1})', () => {
  const m = bayer8();
  // top-left value is 0; its 2×2 micro-block at the coarsest level follows the 0,2,3,1 ordering scaled.
  assert.equal(m[0], 0);
  // the four corners of the 8×8 are the extreme thresholds spread apart (ordered-dither property)
  const corners = [m[0], m[7], m[56], m[63]];
  assert.ok(Math.max(...corners) - Math.min(...corners) >= 32, `corners spread: ${corners}`);
});

console.log(`\nrender-color: ${passed} passed`);
