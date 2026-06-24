// Engine decode-relief LEVERS test: ferrite_vdec_set_skips — L2 (skip_frame =
// AVDISCARD_NONREF, ~half the decoded frames) + L3 (skip_loop_filter = AVDISCARD_ALL, all frames kept,
// cheaper). The contract that MATTERS for the player: the fields are read by avcodec PER FRAME, so a
// toggle is honoured MID-STREAM with NO re-init (no flush / keyframe wait), and a fresh decoder context
// starts at the default (no skip). Headless against the real engine (no browser/worker needed).
//
// Proves:
//   L2 from start   — skip_nonref decodes STRICTLY FEWER frames than the default (non-ref frames discarded),
//                     and still > 0 (reference frames intact → a live picture).
//   L3 from start    — skip_loopfilter keeps ALL frames (count == default; deblocking is a smoothing pass,
//                     not a frame dropper) and never errors.
//   MID-STREAM toggle— decoding the FIRST half at the default then flipping skip_nonref ON drops the
//                     post-toggle frame:packet ratio well below the pre-toggle ratio (the engine honoured
//                     the change with no re-init) — the count lands strictly between all-on and all-off.
//   reset on reload  — a fresh vdec (new context) defaults to no-skip: a default decode after a skip decode
//                     recovers the FULL frame count (no stale skip state carried in the engine).
//
// Run:  node tests/engine_skip_levers.mjs   (uses the emsdk node; engine = ../assets/ferrite.mjs)
//   FERRITE_ENGINE / FERRITE_FIXTURES override the engine .mjs / the fixtures dir (as decode_sweep.mjs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.FERRITE_ENGINE
  ? path.resolve(process.cwd(), process.env.FERRITE_ENGINE)
  : path.join(HERE, '..', 'assets', 'ferrite.mjs');
const FIXTURES = process.env.FERRITE_FIXTURES
  ? path.resolve(process.cwd(), process.env.FERRITE_FIXTURES)
  : path.join(HERE, 'fixtures');

const Engine = (await import(ENGINE)).default;
const m = await Engine();

// Verify the new export is actually present in this engine build (catches a stale assets/ferrite.mjs).
assert.equal(typeof m._ferrite_vdec_set_skips, 'function', 'engine missing ferrite_vdec_set_skips — rebuild the engine (engine/build-engine.sh)');

// Decode a whole-file clip. `skips` = {nonref, loop} applied at start; `toggleAt` (frames) flips
// skip_nonref ON mid-stream (NO re-init). Returns frame/packet totals + the pre/post-toggle split.
function decode(clip, { nonref = 0, loop = 0, toggleAt = 0 } = {}) {
  const ts = fs.readFileSync(path.join(FIXTURES, clip));
  const tptr = m._malloc(ts.length); m.HEAPU8.set(ts, tptr);
  const cptr = m._malloc(8);
  const d = m._ferrite_demux_new(tptr, ts.length, cptr, cptr + 4);
  const vcodec = new Int32Array(m.HEAPU8.buffer, cptr, 1)[0];
  const v = m._ferrite_vdec_new(vcodec, 8);
  if (!toggleAt) m._ferrite_vdec_set_skips(v, nonref, loop); // start state (default 0/0 when not toggling)
  let frames = 0, vpkts = 0, toggled = false;
  let framesBefore = 0, pktsBefore = 0;
  for (let g = 0; g < 4_000_000; g++) {
    const s = m._ferrite_demux_step(d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(d) === 0) {
        vpkts++;
        m._ferrite_vdec_push(v, m._ferrite_demux_pkt_data(d), m._ferrite_demux_pkt_size(d), BigInt(m._ferrite_demux_pkt_pts_us(d)));
        while (m._ferrite_vdec_step(v) === 1) frames++;
        if (toggleAt && !toggled && frames >= toggleAt) {
          framesBefore = frames; pktsBefore = vpkts;
          m._ferrite_vdec_set_skips(v, 1, 0); // MID-STREAM: skip non-ref from here on (no flush/re-init)
          toggled = true;
        }
      }
    } else if (s === 0) { m._ferrite_vdec_push(v, 0, 0, 0n); while (m._ferrite_vdec_step(v) === 1) frames++; break; }
    else break;
  }
  m._ferrite_vdec_free(v); m._ferrite_demux_free(d); m._free(cptr); m._free(tptr);
  return { frames, vpkts, vcodec, framesBefore, pktsBefore, framesAfter: frames - framesBefore, pktsAfter: vpkts - pktsBefore };
}

// Pick a fixture that exists AND whose codec actually carries non-reference frames (so L2 has something to
// skip). Try H.264/HEVC clips in turn; assert at least one is present.
const candidates = ['h264_1080_50.ts', 'h264_2160_50.ts', 'hevc_1080_50.ts', 'hevc_2160_50.ts', 'hevc_1080_10_50.ts'];
const clip = candidates.find((c) => fs.existsSync(path.join(FIXTURES, c)));
assert.ok(clip, `no test fixture found in ${FIXTURES} (need one of ${candidates.join(', ')}) — (cd tests/fixtures && bash gen_clips.sh)`);

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log(`engine decode-relief levers (ferrite_vdec_set_skips) — fixture ${clip}:`);

const base = decode(clip);                       // L0: default, no skip
const l2 = decode(clip, { nonref: 1 });          // L2: skip non-ref from start
const l3 = decode(clip, { loop: 1 });            // L3: skip loop filter from start
const reload = decode(clip);                     // fresh context after the skip decodes (reset-on-reload)

console.log(`  base=${base.frames}f l2(nonref)=${l2.frames}f l3(loop)=${l3.frames}f reload=${reload.frames}f (vpkts≈${base.vpkts})`);

test('default decode produces frames (sanity)', () => {
  assert.ok(base.frames > 4, `expected a real frame count, got ${base.frames}`);
});

test('L2 (skip non-ref) decodes STRICTLY FEWER frames than default, but still > 0 (a live picture)', () => {
  assert.ok(l2.frames > 0, 'reference frames must still decode (no dead screen)');
  assert.ok(l2.frames < base.frames, `skip_nonref must drop non-ref frames: l2=${l2.frames} vs base=${base.frames}`);
});

test('L3 (skip loop filter) keeps ALL frames (deblock is a smoothing pass, not a frame dropper)', () => {
  assert.equal(l3.frames, base.frames, `skip_loop_filter must keep every frame: l3=${l3.frames} vs base=${base.frames}`);
});

test('MID-STREAM toggle is honoured with NO re-init: the post-toggle frame:packet ratio drops sharply', () => {
  const toggleAt = Math.max(4, Math.floor(base.frames / 3)); // flip a third of the way in
  const t = decode(clip, { toggleAt });
  assert.ok(t.toggleAt !== 0 || t.framesAfter >= 0, 'sanity'); // (toggleAt is internal; keep the run honest)
  const ratioBefore = t.framesBefore / Math.max(1, t.pktsBefore);
  const ratioAfter = t.framesAfter / Math.max(1, t.pktsAfter);
  assert.ok(t.pktsAfter > 2, `need packets after the toggle to measure (got ${t.pktsAfter})`);
  assert.ok(ratioAfter < ratioBefore * 0.85, `mid-stream skip must reduce the output ratio: before=${ratioBefore.toFixed(2)} after=${ratioAfter.toFixed(2)}`);
  // And the toggled run lands strictly between all-skipped and all-default (it decimated only the 2nd half).
  assert.ok(t.frames > l2.frames && t.frames < base.frames, `toggled total ${t.frames} between l2 ${l2.frames} and base ${base.frames}`);
});

test('reset on a fresh load: a default decode after skip decodes recovers the FULL frame count (no stale state)', () => {
  assert.equal(reload.frames, base.frames, `a fresh vdec context must default to no-skip: reload=${reload.frames} vs base=${base.frames}`);
});

console.log(`\nengine-skip-levers: ${passed} passed`);
