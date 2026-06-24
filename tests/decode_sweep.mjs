// Software decode-throughput sweep: pure demux+decode[+deint] fps for every codec/res/bit-depth,
// 8 threads, true wall-clock. (Decode fps is per-frame cost, so fps-variant-independent — one
// clip per config. A browser bench measures play_fps/present separately.)
//
// Run:  ~/emsdk/node/*/bin/node decode_sweep.mjs
// Env:
//   FERRITE_ENGINE   path to the engine .mjs (default ../assets/ferrite.mjs)
//   FERRITE_FIXTURES dir holding the .ts clips (default ./fixtures) — regenerate with fixtures/gen_clips.sh
//
// The FERRITE_ENGINE override is how the build-equivalence gate compares two independently-built
// engines (e.g. this repo's build vs another tree's) on the same fixtures.
import fs from 'fs';
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
const rd32 = (p) => new Int32Array(m.HEAPU8.buffer, p, 1)[0];

function decodeAll(clip, deint) {
  const ts = fs.readFileSync(path.join(FIXTURES, clip));
  const tptr = m._malloc(ts.length); m.HEAPU8.set(ts, tptr);
  const cptr = m._malloc(8);
  const d = m._ferrite_demux_new(tptr, ts.length, cptr, cptr + 4);
  const v = m._ferrite_vdec_new(rd32(cptr), 8);
  if (deint) m._ferrite_vdec_set_deint(v, deint);
  let frames = 0, w = 0, h = 0;
  const t0 = performance.now();
  for (let g = 0; g < 4_000_000; g++) {
    const s = m._ferrite_demux_step(d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(d) === 0) {
        let tries = 0;
        while (true) {
          const r = m._ferrite_vdec_push(v, m._ferrite_demux_pkt_data(d), m._ferrite_demux_pkt_size(d), BigInt(m._ferrite_demux_pkt_pts_us(d)));
          while (m._ferrite_vdec_step(v) === 1) { frames++; w = m._ferrite_vdec_w(v); h = m._ferrite_vdec_h(v); }
          if (r !== 0 || tries >= 16) break; tries++;
        }
      }
    } else if (s === 0) { m._ferrite_vdec_push(v, 0, 0, 0n); while (m._ferrite_vdec_step(v) === 1) frames++; break; }
    else break;
  }
  const ms = performance.now() - t0;
  m._ferrite_vdec_free(v); m._ferrite_demux_free(d); m._free(cptr); m._free(tptr);
  return { frames, w, h, fps: frames / ms * 1000 };
}

const configs = [
  ['HEVC 1080p 8-bit', 'hevc_1080_50.ts', 0],
  ['HEVC 1080p 10-bit', 'hevc_1080_10_50.ts', 0],
  ['HEVC 2160p 8-bit', 'hevc_2160_50.ts', 0],
  ['HEVC 2160p 10-bit', 'hevc_2160_10_50.ts', 0],
  ['H.264 1080p', 'h264_1080_50.ts', 0],
  ['H.264 2160p', 'h264_2160_50.ts', 0],
  ['MPEG-2 1080p', 'mpeg2_1080_25.ts', 0],
  ['MPEG-2 1080i · off', 'mpeg2_1080i_25.ts', 0],
  ['MPEG-2 1080i · yadif', 'mpeg2_1080i_25.ts', 2],
  ['MPEG-2 1080i · bwdif', 'mpeg2_1080i_25.ts', 3],
  ['H.264 1080i · off', 'h264_1080i_25.ts', 0],
  ['H.264 1080i · yadif', 'h264_1080i_25.ts', 2],
  ['H.264 1080i · bwdif', 'h264_1080i_25.ts', 3],
];
// Only run configs whose clip exists (so a partial fixture set still produces a useful sweep).
const present = configs.filter(([, clip]) => fs.existsSync(path.join(FIXTURES, clip)));
if (present.length === 0) {
  console.error(`No fixtures found in ${FIXTURES}. Generate them: (cd fixtures && bash gen_clips.sh)`);
  process.exit(1);
}
decodeAll(present[0][1], 0); // warm up
console.log(`engine:   ${ENGINE}`);
console.log(`fixtures: ${FIXTURES}`);
console.log('Software decode throughput — 8 threads, true wall-clock (demux+decode[+deint]):');
console.log('  ' + 'config'.padEnd(24) + 'frames  resolution   decode-fps');
for (const [label, clip, deint] of present) {
  const r = decodeAll(clip, deint);
  console.log('  ' + label.padEnd(24) + String(r.frames).padStart(4) + 'f  ' + (r.w + 'x' + r.h).padEnd(11) + String(r.fps.toFixed(0)).padStart(6));
}
