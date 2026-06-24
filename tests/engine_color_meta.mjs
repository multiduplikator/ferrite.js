// RENDER-QUALITY engine-exposure gate: ferrite_vdec_colorspace + ferrite_vdec_color_range. Proves the new
// per-frame metadata exports (a) exist in the matched-pair engine (catches a stale assets/ferrite.mjs),
// (b) return VALID AVColorSpace/AVColorRange enum values, (c) are STABLE across a stream (constant per
// stream → the present worker can read them off any frame), and (d) feed the pure JS selection
// (src/render/color.ts) to the correct matrix family. The shader OUTPUT is the browser owner-bank.
//
// Run:  node --experimental-strip-types tests/engine_color_meta.mjs
//   FERRITE_ENGINE / FERRITE_FIXTURES override the engine .mjs / the fixtures dir (as decode_sweep.mjs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectColorConditioning } from '../src/render/color.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.FERRITE_ENGINE
  ? path.resolve(process.cwd(), process.env.FERRITE_ENGINE)
  : path.join(HERE, '..', 'assets', 'ferrite.mjs');
const FIXTURES = process.env.FERRITE_FIXTURES
  ? path.resolve(process.cwd(), process.env.FERRITE_FIXTURES)
  : path.join(HERE, 'fixtures');

const Engine = (await import(ENGINE)).default;
const m = await Engine();

// The matched-pair guard: the new exports must be present (else assets/ferrite.{mjs,wasm} is stale).
assert.equal(typeof m._ferrite_vdec_colorspace, 'function', 'engine missing ferrite_vdec_colorspace — rebuild (engine/build-engine.sh)');
assert.equal(typeof m._ferrite_vdec_color_range, 'function', 'engine missing ferrite_vdec_color_range — rebuild (engine/build-engine.sh)');

// Decode a clip; collect colorspace/color_range/bitdepth/dims per frame. Returns the per-frame samples.
function decode(clip, maxFrames = 30) {
  const ts = fs.readFileSync(path.join(FIXTURES, clip));
  const tptr = m._malloc(ts.length); m.HEAPU8.set(ts, tptr);
  const cptr = m._malloc(8);
  const d = m._ferrite_demux_new(tptr, ts.length, cptr, cptr + 4);
  const vcodec = new Int32Array(m.HEAPU8.buffer, cptr, 1)[0];
  const v = m._ferrite_vdec_new(vcodec, 4);
  const samples = [];
  let w = 0, h = 0;
  for (let g = 0; g < 2_000_000 && samples.length < maxFrames; g++) {
    const s = m._ferrite_demux_step(d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(d) === 0) {
        m._ferrite_vdec_push(v, m._ferrite_demux_pkt_data(d), m._ferrite_demux_pkt_size(d), BigInt(m._ferrite_demux_pkt_pts_us(d)));
        while (m._ferrite_vdec_step(v) === 1) {
          w = m._ferrite_vdec_w(v); h = m._ferrite_vdec_h(v);
          samples.push({ cs: m._ferrite_vdec_colorspace(v), cr: m._ferrite_vdec_color_range(v), bd: m._ferrite_vdec_bitdepth(v), w, h });
        }
      }
    } else { break; }
  }
  m._ferrite_vdec_free(v); m._ferrite_demux_free(d); m._free(cptr); m._free(tptr);
  return samples;
}

// A null vdec (no frame) must not crash → returns the safe UNSPECIFIED/UNSPECIFIED defaults.
assert.equal(m._ferrite_vdec_colorspace(0), 2, 'null vdec → AVCOL_SPC_UNSPECIFIED');
assert.equal(m._ferrite_vdec_color_range(0), 0, 'null vdec → AVCOL_RANGE_UNSPECIFIED');

const candidates = ['h264_1080_50.ts', 'hevc_2160_10_50.ts', 'mpeg2_1080_25.ts', 'hevc_1080_50.ts'];
const clips = candidates.filter((c) => fs.existsSync(path.join(FIXTURES, c)));
assert.ok(clips.length, `no test fixture found in ${FIXTURES} (need one of ${candidates.join(', ')})`);

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log(`render-quality engine colour metadata — fixtures: ${clips.join(', ')}`);

for (const clip of clips) {
  const s = decode(clip);
  assert.ok(s.length > 4, `${clip}: expected frames, got ${s.length}`);
  const f0 = s[0];
  console.log(`  ${clip}: ${s.length}f colorspace=${f0.cs} color_range=${f0.cr} bitdepth=${f0.bd} ${f0.w}x${f0.h}`);

  test(`${clip}: colorspace + color_range are VALID enum values`, () => {
    // AVColorSpace 0..14 (current ffmpeg); AVColorRange 0..2. Reject garbage (uninitialised reads).
    assert.ok(f0.cs >= 0 && f0.cs <= 14, `colorspace ${f0.cs} out of range`);
    assert.ok(f0.cr >= 0 && f0.cr <= 2, `color_range ${f0.cr} out of range`);
  });

  test(`${clip}: metadata is STABLE across the stream (constant per stream)`, () => {
    for (const f of s) {
      assert.equal(f.cs, f0.cs, 'colorspace drifted mid-stream');
      assert.equal(f.cr, f0.cr, 'color_range drifted mid-stream');
    }
  });

  test(`${clip}: the engine readout drives selectColorConditioning to a sane matrix + range`, () => {
    const c = selectColorConditioning(f0.cs, f0.cr, f0.w, f0.h);
    assert.ok(['601', '709', '2020'].includes(c.matrix), `matrix ${c.matrix}`);
    assert.ok(['limited', 'full'].includes(c.range), `range ${c.range}`);
    // a real HD/4K frame with UNSPECIFIED colorspace must resolve to 709 via the resolution fallback
    if (f0.cs === 2 && (f0.w >= 1280 || f0.h > 576)) assert.equal(c.matrix, '709', 'HD/4K unspecified → 709');
    // chroma coefficients are finite & non-zero (a real matrix, not a degenerate all-zero)
    for (const k of ['cRv', 'cGu', 'cGv', 'cBu', 'yScale']) assert.ok(Number.isFinite(c[k]) && c[k] !== 0, `${k}=${c[k]}`);
  });
}

console.log(`\nengine-color-meta: ${passed} passed`);
