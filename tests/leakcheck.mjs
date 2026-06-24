// Fast streaming-ring leak repro: feed a sample on a loop, drain via demux_step (NO decode —
// the ring's grow/compact behavior is independent of decoding). If the ring compacts, total fed
// far exceeds 2 GiB with a flat heap; if it leaks, malloc OOMs near ~2 GiB.
//
// This guards the ferrite.c streaming-ring end-overflow compaction: a continuous player (unlike a
// short preview) drains the ring while `pos` marches forward, so compaction must fire on
// `len + n > cap`, not `unread + n > cap`. A regression here OOMs a long-running stream.
//
// Run:  ~/emsdk/node/*/bin/node leakcheck.mjs
// Env:
//   FERRITE_ENGINE  path to the engine .mjs (default ../assets/ferrite.mjs)
//   FERRITE_SAMPLE  path to a sample .ts (default fixtures/hevc_2160_25.ts)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.FERRITE_ENGINE
  ? path.resolve(process.cwd(), process.env.FERRITE_ENGINE)
  : path.join(HERE, '..', 'assets', 'ferrite.mjs');
const SAMPLE = process.env.FERRITE_SAMPLE
  ? path.resolve(process.cwd(), process.env.FERRITE_SAMPLE)
  : path.join(HERE, 'fixtures', 'hevc_2160_25.ts');

if (!existsSync(SAMPLE)) {
  console.error(`sample not found: ${SAMPLE}\nGenerate fixtures (cd fixtures && bash gen_clips.sh) or set FERRITE_SAMPLE.`);
  process.exit(1);
}

const initFerrite = (await import(ENGINE)).default;
const M = await initFerrite({ ferritePool: 2 });
const buf = readFileSync(SAMPLE);
const d = M._ferrite_demux_new_streaming();
M._ferrite_demux_set_max_buffered(d, 16 * 1024 * 1024);

const CH = 65536;
let off = 0;
const feed = (u8) => { const p = M._malloc(u8.length); M.HEAPU8.set(u8, p); M._ferrite_demux_feed(d, p, u8.length); M._free(p); };
while (M._ferrite_demux_buffered(d) < 256 * 1024) { feed(buf.subarray(off, off + CH)); off += CH; }
M._ferrite_demux_open(d);

let totalFed = off, lastMark = 0;
const TARGET = 3 * 1024 * 1024 * 1024;
try {
  while (totalFed < TARGET) {
    while (M._ferrite_demux_buffered(d) < 4 * 1024 * 1024) {
      if (off + CH > buf.length) off = 0;
      feed(buf.subarray(off, off + CH)); off += CH; totalFed += CH;
    }
    // drain (consume the ring) without decoding
    for (let i = 0; i < 500; i++) { const s = M._ferrite_demux_step(d); if (s === 2 || s === 0) break; }
    const mark = Math.floor(totalFed / (128 * 1024 * 1024));
    if (mark !== lastMark) { lastMark = mark; console.log('fed', (totalFed / 1048576).toFixed(0), 'MiB; unread', (M._ferrite_demux_buffered(d) / 1024).toFixed(0), 'KiB'); }
  }
  console.log('RESULT: fed', (totalFed / 1048576).toFixed(0), 'MiB, NO OOM → ring compacts (no leak)');
} catch (e) {
  console.log('RESULT: OOM at', (totalFed / 1048576).toFixed(0), 'MiB →', String(e).split('\n')[0]);
  process.exit(1);
}
process.exit(0);
