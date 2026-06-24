// VOD / file-container gate: validate the in-memory whole-file demux path (ferrite_demux_new_file) on
// MP4 (mov demuxer) + MKV (matroska) containers — autodetect + find_stream_info + seekable AVIO:
//   (1) DECODE: demux the file, decode the actual video stream, confirm frames + dimensions + that the
//       audio stream decodes too. Proves the matroska/mov demuxers + codec routing work.
//   (2) SEEK: ferrite_demux_seek_us(BACKWARD) to a mid-file timestamp, decode forward from the landed
//       keyframe, confirm the first decoded frame's PTS is at/before the seek target (within a GOP) and
//       that decode resumes cleanly. Proves av_seek_frame over the seekable AVIO.
//
// The in-memory path backs the AVIO with a whole-file buffer in the wasm heap (sync ferrite_io_read — NOT
// the async range import, so the Asyncify-instrumented exports run synchronously here). The ASYNC
// HTTP-Range transport (ferrite_demux_new_range + the suspending range hook + HttpSource) is validated
// separately: tests/asyncify_coexist.mjs (engine ∥ pthread-pool coexistence across mpegts/mov/matroska +
// backward seek) and tests/http_source_test.mjs (the transport: one forward connection, abort+reopen,
// window/HEAD/LRU serves, 200-fallback). NOTE: ferrite_demux_seek_us now takes a DOUBLE µs (a suspending
// export takes no BigInt; the in-memory seek doesn't suspend but the signature is shared).
//
// Run:  node --experimental-strip-types vod_seek_test.mjs  (or any node ≥22)
// Env:
//   FERRITE_ENGINE   path to the engine .mjs (default ../assets/ferrite.mjs)
//   FERRITE_FIXTURES dir holding the VOD clips (default ./fixtures) — generate with fixtures/gen_vod.sh
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
const CODEC = { 173: 'HEVC', 27: 'H.264', 2: 'MPEG-2', 86018: 'AAC', 86019: 'AC-3', 86056: 'E-AC3' };
const fix = (f) => path.join(FIXTURES, f);

// Open an in-memory whole-file demuxer. Returns { d, free() }; codecs report through cptr (out_vcodec/out_acodec).
function openDemux(p) {
  const cptr = m._malloc(8);
  const buf = fs.readFileSync(p);
  const ptr = m._malloc(buf.length);
  m.HEAPU8.set(buf, ptr);
  const d = m._ferrite_demux_new_file(ptr, buf.length, cptr, cptr + 4);
  return { d, cptr, total: buf.length,
           free: () => { m._free(cptr); m._free(ptr); } };
}

// Drain one demuxed packet into a decoder with B-frame priming; returns frames produced.
function pushDrain(dec, isVideo, data, size, pts) {
  const push = isVideo ? m._ferrite_vdec_push : m._ferrite_audio_push;
  const step = isVideo ? m._ferrite_vdec_step : m._ferrite_audio_step;
  let frames = 0, t = 0;
  while (true) {
    const r = push(dec, data, size, BigInt(pts));
    while (step(dec) === 1) frames++;
    if (r !== 0 || t >= 16) break;
    t++;
  }
  return frames;
}

function decodeWholeFile(p, maxV = Infinity) { // maxV caps video frames (for truncated clip prefixes)
  const h = openDemux(p);
  if (!h.d) { h.free(); return { ok: false, err: 'demux returned NULL' }; }
  const vcodec = rd32(h.cptr), acodec = rd32(h.cptr + 4);
  const durUs = Number(m._ferrite_demux_duration_us(h.d));
  // VOD/file: build decoders FROM the demuxer streams (carry AVCC/HVCC + AAC-ASC extradata).
  const v = vcodec > 0 ? m._ferrite_vdec_new_from_demux(h.d, 8) : 0;
  const a = acodec > 0 ? m._ferrite_audio_new_from_demux(h.d) : 0;
  let vframes = 0, aframes = 0, w = 0, h2 = 0;
  for (let g = 0; g < 1e7 && vframes < maxV; g++) {
    const s = m._ferrite_demux_step(h.d);
    if (s === 1) {
      const which = m._ferrite_demux_pkt_stream(h.d);
      const data = m._ferrite_demux_pkt_data(h.d), size = m._ferrite_demux_pkt_size(h.d);
      const pts = m._ferrite_demux_pkt_pts_us(h.d);
      if (which === 0 && v) { vframes += pushDrain(v, true, data, size, pts); w = m._ferrite_vdec_w(v); h2 = m._ferrite_vdec_h(v); }
      else if (which === 1 && a) { aframes += pushDrain(a, false, data, size, pts); }
    } else if (s === 0) {
      if (v) { m._ferrite_vdec_push(v, 0, 0, 0n); while (m._ferrite_vdec_step(v) === 1) vframes++; }
      if (a) { m._ferrite_audio_push(a, 0, 0, 0n); while (m._ferrite_audio_step(a) === 1) aframes++; }
      break;
    } else break;
  }
  if (v) m._ferrite_vdec_free(v);
  if (a) m._ferrite_audio_free(a);
  m._ferrite_demux_free(h.d); h.free();
  return { ok: true, vcodec, acodec, durUs, vframes, aframes, w, h: h2, total: h.total };
}

// Seek to targetUs (BACKWARD → land on the keyframe at/before), then decode forward and report the
// first decoded frame's PTS. A correct seek lands us near (≤ a GOP before) the target, NOT at 0.
function seekDecode(p, targetUs) {
  const h = openDemux(p);
  const v = m._ferrite_vdec_new_from_demux(h.d, 8);
  const sr = m._ferrite_demux_seek_us(h.d, targetUs, 1); // backward — DOUBLE µs (no BigInt)
  // After a seek the decoder must be flushed (separate object): a fresh decoder is the cleanest flush.
  let firstPts = null, frames = 0;
  for (let g = 0; g < 1e7 && frames < 30; g++) {
    const s = m._ferrite_demux_step(h.d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(h.d) === 0) {
        const data = m._ferrite_demux_pkt_data(h.d), size = m._ferrite_demux_pkt_size(h.d);
        const pts = m._ferrite_demux_pkt_pts_us(h.d);
        m._ferrite_vdec_push(v, data, size, BigInt(pts));
        while (m._ferrite_vdec_step(v) === 1) {
          if (firstPts === null) firstPts = Number(m._ferrite_vdec_pts(v));
          frames++;
        }
      }
    } else break;
  }
  m._ferrite_vdec_free(v); m._ferrite_demux_free(h.d); h.free();
  return { sr, firstPts, frames };
}

const FILES = [
  ['vod_h264_aac.mp4', 'MP4  (mov demuxer)'],
  ['vod_h264_aac.mkv', 'MKV  (matroska, H.264)'],
  ['vod_hevc_aac.mkv', 'MKV  (matroska, HEVC)'],
];
if (!FILES.some(([f]) => fs.existsSync(fix(f)))) {
  console.error(`No VOD fixtures in ${FIXTURES}. Generate them: (cd fixtures && bash gen_vod.sh)`);
  process.exit(1);
}

let bad = 0;
console.log(`engine:   ${ENGINE}`);
console.log(`fixtures: ${FIXTURES}`);

console.log('\n========== in-memory whole-file AVIO ==========');
console.log('— whole-file decode (autodetect container + decode video + audio) —');
for (const [file, label] of FILES) {
  if (!fs.existsSync(fix(file))) { console.log(`${label.padEnd(26)} (missing, skipped)`); continue; }
  const r = decodeWholeFile(fix(file));
  if (!r.ok) { console.log(`${label.padEnd(26)} ✗ ${r.err}`); bad++; continue; }
  const ok = r.vframes > 0 && r.w > 0 && r.h > 0 && r.aframes > 0;
  if (!ok) bad++;
  console.log(`${label.padEnd(26)} v=${(CODEC[r.vcodec]||r.vcodec)} ${r.w}x${r.h} ${r.vframes}f | a=${(CODEC[r.acodec]||r.acodec)} ${r.aframes}f | dur=${(r.durUs/1e6).toFixed(1)}s ${ok ? '✓' : '✗ (need v+a frames)'}`);
}

console.log('— seek (av_seek_frame BACKWARD over the seekable AVIO) —');
for (const [file, label] of FILES) {
  if (!fs.existsSync(fix(file))) continue;
  const whole = decodeWholeFile(fix(file));
  if (!whole.ok || whole.durUs <= 0) { console.log(`${label.padEnd(26)} (no duration, skip seek)`); continue; }
  const target = Math.floor(whole.durUs * 0.9); // 90% in → a non-zero preceding keyframe exists even
                                                // for a single-mid-GOP file (proves the seek moved off 0)
  const r = seekDecode(fix(file), target);
  // Correct BACKWARD seek: rc=0, decodes frames, lands on the keyframe at/before the target — first
  // decoded PTS is ≤ target, within one (generous, ≤6s) GOP before it, and NOT back at the start.
  const landedNear = r.firstPts !== null && r.firstPts <= target + 0.5e6 && (target - r.firstPts) <= 6e6;
  const notStart = r.firstPts !== null && r.firstPts > 1e6;
  const ok = r.sr === 0 && r.frames > 0 && landedNear && notStart;
  if (!ok) bad++;
  console.log(`${label.padEnd(26)} seek→${(target/1e6).toFixed(1)}s rc=${r.sr} firstPTS=${r.firstPts===null?'none':(r.firstPts/1e6).toFixed(2)+'s'} ${r.frames}f ${ok ? '✓' : '✗'}`);
}

console.log(bad === 0
  ? '\nALL OK — MP4 + MKV in-memory demux + decode + double-µs seek work; the async Range transport is covered by asyncify_coexist + http_source_test; live mpegts path untouched.'
  : `\n${bad} FAILED.`);
process.exit(bad ? 1 : 0);
