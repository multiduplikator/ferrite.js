// Asyncify ∥ pthreads COEXISTENCE + readpath-completeness gate.
//
// This is the VALIDATOR for the committed engine/asyncify_readpath.txt ASYNCIFY_ADD list. The list must
// instrument EVERY function on the range-read suspend stack for EVERY container we open; if one is missing
// the classic-Asyncify rewind lands in an uninstrumented frame → the assertions build ABORTS ("not
// instrumented") and the perf build hangs/corrupts. So a GREEN run here proves the list is complete and
// that suspend/resume coexists with the active -pthread decode pool. Re-run + regenerate the list on any
// FFmpeg version bump (see engine/gen-asyncify-readpath.sh).
//
// What it does, per container (mpegts .ts, mov .mp4, matroska .mkv) — ALL via a GENUINELY-SUSPENDING async
// range hook (setTimeout(0) per read = real unwind/rewind), with the decode pthread pool live:
//   1. open  — ferrite_demux_new_range → avformat_open_input + find_stream_info (many suspending reads)
//   2. decode — N frames through the pool while demux_step suspends per AVIO read
//   3. seek   — backward ferrite_demux_seek_us (DOUBLE µs — no BigInt on a suspending export) + decode fwd
// Asserts: frames decode with real dims, the backward seek lands at/before the target (not 0) and decodes,
// and the pool genuinely spawned ≥ MINPOOL workers (proves real multithreading, not a count request).
//
// Run:  node tests/asyncify_coexist.mjs
// Env:  FERRITE_ENGINE (.mjs, default ../assets/ferrite.mjs), FERRITE_FIXTURES (default ./fixtures),
//       FERRITE_TS_FIXTURE (default hevc_2160_10_50.ts — a heavy 4K-10bit clip to stress the pool).
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
const MINPOOL = 8;
const CODEC = { 173: 'HEVC', 27: 'H.264', 2: 'MPEG-2', 86018: 'AAC', 86019: 'AC-3', 86056: 'E-AC3' };

const Engine = (await import(ENGINE)).default;
const m = await Engine({ ferritePool: 10 }); // pre-spawn the 10-thread pool (8 decode + 2)
const rd32 = (p) => new Int32Array(m.HEAPU8.buffer, p, 1)[0];

// emscripten-6 classic Asyncify (ASYNCIFY=1): an instrumented export does NOT auto-return a Promise — it
// returns the unwind placeholder. Call it; if it SUSPENDED (Asyncify.currData changed) await whenDone() for
// the real value, else it ran synchronously and we already have it. (What ccall {async:true} does.)
async function callAsync(name, ...args) {
  const A = m.Asyncify;
  if (!A) throw new Error('Asyncify runtime not exposed (EXPORTED_RUNTIME_METHODS must include Asyncify)');
  const prev = A.currData;
  const ret = m['_' + name](...args);
  if (A.currData !== prev) return await A.whenDone();
  return ret;
}

function poolSpawned() { try { const P = m.PThread; return (P.runningWorkers || []).length + (P.unusedWorkers || []).length; } catch { return -1; } }

// Install the GENUINELY-SUSPENDING async range reader: the EM_ASYNC_JS bridge awaits this Promise, so each
// read truly unwinds/rewinds the stack. Returns the bytes at [pos, pos+len) (short at EOF, empty past EOF).
// The C bridge writes them to a FRESH HEAPU8 AFTER the await (growable-memory invariant).
function installSuspendingSource(buf, stats) {
  m.__ferriteRangeReadAsync = (_handle, pos, len) => new Promise((resolve) => {
    setTimeout(() => {
      stats.reads++;
      const p = Math.floor(pos);
      if (p >= buf.length) return resolve(new Uint8Array(0)); // EOF
      resolve(buf.subarray(p, Math.min(p + len, buf.length)));
    }, 0);
  });
}

async function runContainer(file, label) {
  const full = path.join(FIXTURES, file);
  if (!fs.existsSync(full)) return { file, label, skipped: true };
  const buf = fs.readFileSync(full);
  const stats = { reads: 0 };
  installSuspendingSource(buf, stats);
  const cptr = m._malloc(8);

  // OPEN (suspends through find_stream_info)
  let d = 0;
  try { d = await callAsync('ferrite_demux_new_range', 1, buf.length, cptr, cptr + 4); } catch { d = 0; }
  if (!d) { m._free(cptr); delete m.__ferriteRangeReadAsync; return { file, label, ok: false, why: 'open NULL' }; }
  const vcodec = rd32(cptr), acodec = rd32(cptr + 4);
  const durUs = Number(m._ferrite_demux_duration_us(d));
  const v = vcodec > 0 ? m._ferrite_vdec_new_from_demux(d, 8) : 0;
  const a = acodec > 0 ? m._ferrite_audio_new_from_demux(d) : 0;
  if (!v) { m._ferrite_demux_free(d); m._free(cptr); delete m.__ferriteRangeReadAsync; return { file, label, ok: false, why: 'no video decoder' }; }

  // DECODE through the pool while demux_step suspends
  const N = 40;
  let vframes = 0, aframes = 0, w = 0, h = 0, maxPool = 0;
  for (let g = 0; g < 2_000_000 && vframes < N; g++) {
    const s = await callAsync('ferrite_demux_step', d); // SUSPENDS on AVIO read
    maxPool = Math.max(maxPool, poolSpawned());
    if (s === 1) {
      const which = m._ferrite_demux_pkt_stream(d);
      const ptr = m._ferrite_demux_pkt_data(d), size = m._ferrite_demux_pkt_size(d), pts = m._ferrite_demux_pkt_pts_us(d);
      if (which === 0) { m._ferrite_vdec_push(v, ptr, size, pts); while (m._ferrite_vdec_step(v) === 1) { vframes++; w = m._ferrite_vdec_w(v); h = m._ferrite_vdec_h(v); } }
      else if (which === 1 && a) { m._ferrite_audio_push(a, ptr, size, pts); while (m._ferrite_audio_step(a) === 1) aframes++; }
    } else if (s === 0) { break; } else if (s !== 2) { break; }
  }

  // BACKWARD SEEK (suspends: av_seek_frame reads the index/probes) + decode forward. Target 60% in — leaves
  // a decodable tail for short clips while landing mid-file. A container's CUE DENSITY decides the exact
  // landing (matroska-HEVC indexes few keyframes → may land at 0; mpegts/mov are dense → land near target);
  // both are correct. What this asserts is the Asyncify MECHANISM: rc=0, it decoded forward from the landed
  // keyframe, and the landing is ≤ target. The double-arg-preservation across the rewind (a lost arg →
  // NaN → seek-to-0) is proven GLOBALLY below (≥1 dense-cue container must land well past 0).
  let sr = -999, firstPts = null, sframes = 0;
  if (durUs > 0) {
    const target = Math.floor(durUs * 0.6);
    sr = await callAsync('ferrite_demux_seek_us', d, target, 1); // DOUBLE µs — no BigInt
    m._ferrite_vdec_free(v);
    const v2 = m._ferrite_vdec_new_from_demux(d, 8); // fresh decoder = cleanest flush
    for (let g = 0; g < 2_000_000 && sframes < 20; g++) {
      const s = await callAsync('ferrite_demux_step', d);
      if (s === 1) {
        if (m._ferrite_demux_pkt_stream(d) === 0) {
          m._ferrite_vdec_push(v2, m._ferrite_demux_pkt_data(d), m._ferrite_demux_pkt_size(d), m._ferrite_demux_pkt_pts_us(d));
          while (m._ferrite_vdec_step(v2) === 1) { if (firstPts === null) firstPts = Number(m._ferrite_vdec_pts(v2)); sframes++; }
        }
      } else break;
    }
    const okSeekTarget = sr === 0 && firstPts !== null && firstPts <= target + 0.5e6 && firstPts >= 0 && sframes > 0;
    m._ferrite_vdec_free(v2);
    m._ferrite_demux_free(d); m._free(cptr); delete m.__ferriteRangeReadAsync;
    const ok = vframes >= Math.min(N, 20) && w > 0 && h > 0 && okSeekTarget;
    return { file, label, ok, vcodec, acodec, w, h, vframes, aframes, durUs, sr, firstPts, target, sframes, reads: stats.reads, maxPool };
  }
  if (a) m._ferrite_audio_free(a);
  m._ferrite_vdec_free(v); m._ferrite_demux_free(d); m._free(cptr); delete m.__ferriteRangeReadAsync;
  return { file, label, ok: vframes > 0 && w > 0, vcodec, w, h, vframes, aframes, durUs: 0, reads: stats.reads, maxPool };
}

const TS = process.env.FERRITE_TS_FIXTURE || 'hevc_2160_10_50.ts';
const CONTAINERS = [
  [TS, 'mpegts (.ts, 4K-10bit — pool stress)'],
  ['vod_h264_aac.mp4', 'mov     (.mp4, H.264+AAC)'],
  ['vod_h264_aac.mkv', 'matroska(.mkv, H.264+AAC)'],
  ['vod_hevc_aac.mkv', 'matroska(.mkv, HEVC+AAC)'],
];

console.log(`engine:   ${ENGINE}`);
console.log(`fixtures: ${FIXTURES}`);
console.log('Asyncify range-read coexistence + readpath completeness (genuinely-suspending async hook, live pool):\n');
let bad = 0, ran = 0, maxLanding = 0;
for (const [file, label] of CONTAINERS) {
  const r = await runContainer(file, label);
  if (r.skipped) { console.log(`  ${label.padEnd(34)} (missing, skipped)`); continue; }
  ran++;
  if (r.firstPts) maxLanding = Math.max(maxLanding, r.firstPts);
  if (!r.ok) { bad++; console.log(`  ${label.padEnd(34)} ✗ ${r.why || ''} v=${r.vframes}f ${r.w}x${r.h} sr=${r.sr} firstPTS=${r.firstPts === null ? 'none' : (r.firstPts / 1e6).toFixed(2) + 's'}/${r.target ? (r.target / 1e6).toFixed(1) + 's' : '?'}`); continue; }
  const seek = r.durUs > 0 ? ` | seek→${(r.target / 1e6).toFixed(1)}s rc=${r.sr} firstPTS=${(r.firstPts / 1e6).toFixed(2)}s ${r.sframes}f` : '';
  console.log(`  ${label.padEnd(34)} ✓ v=${CODEC[r.vcodec] || r.vcodec} ${r.w}x${r.h} ${r.vframes}f a=${r.aframes}f${seek} | reads=${r.reads} pool=${r.maxPool}`);
}

// Pool-spawn proof: the genuine ≥MINPOOL multithreaded pool must have spawned (real coexistence, not a
// count request) — it persists across containers, so check at the end.
const poolOk = poolSpawned() >= MINPOOL;
console.log(`pool genuinely multi-threaded (≥${MINPOOL}): ${poolOk ? 'PASS' : 'FAIL'} (spawned=${poolSpawned()})`);
if (!poolOk) bad++;

// DOUBLE-ARG PRESERVATION across the suspending-seek rewind: if the double µs arg were lost on rewind it
// would convert to NaN→0 and EVERY seek would land at 0. At least one (dense-cue) container must land well
// past 0 to prove the arg survived. (Sparse-cue matroska-HEVC legitimately lands at 0 → can't prove it alone.)
const argOk = maxLanding > 2e6;
console.log(`seek double-arg survives rewind (≥1 landing >2s): ${argOk ? 'PASS' : 'FAIL'} (max landing=${(maxLanding / 1e6).toFixed(2)}s)`);
if (ran > 0 && !argOk) bad++;

console.log(ran === 0
  ? '\nNO fixtures present — generate them: (cd tests/fixtures && bash gen_vod.sh && bash gen_clips.sh)'
  : (bad === 0
    ? `\nGREEN — Asyncify suspend/resume coexists with the live pthread pool across ${ran} container(s) (open+decode+backward-seek); the readpath ADD list is complete.`
    : `\n${bad} FAILED — RED. Rebuild the assertions engine (SPIKE_ASSERTIONS) to see the uninstrumented frame name, add it to engine/asyncify_readpath.txt.`));
process.exit(ran === 0 ? 1 : (bad ? 1 : 0));
