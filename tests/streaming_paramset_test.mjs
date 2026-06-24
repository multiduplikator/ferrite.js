// Live-streaming param-set resolution gate. The live mpegts demuxer
// (ferrite_demux_new_streaming) opens WITHOUT find_stream_info, so historically the SW decoder was built
// bare (codec_id only, no extradata) and had to glean VPS/SPS/PPS from the in-band stream — which, for a
// mid-GOP join or a stream whose param sets are sparse, floods "[hevc] PPS id out of range" and starves
// decode. The fix pulls the in-band param sets into codecpar->extradata with the extract_extradata BSF
// (ferrite_demux_v_extradata*) so the decoder is built FROM the demux (with the param sets), matching the
// probing/VOD path. This gate exercises the LIVE streaming demux end-to-end (no browser) and asserts:
//   (1) the param sets are extracted (extradata_size > 0) for H.264 / HEVC / MPEG-2;
//   (2) a join AT a keyframe (feed from byte 0) decodes 100% of video packets with ZERO PPS errors and
//       NEVER feeds the decoder a packet before the param sets are resolved (fed-bare-before-extradata=0);
//   (3) a MID-GOP join also never feeds the decoder before resolution (the H.264/HEVC pre-keyframe HOLD),
//       so there is no DECODER-side PPS flood (only bounded demux-parser join noise until the next IDR).
// decode_sweep (probing) + vod_seek (file/range) stay the other paths' gates; this is the live path's.
//
// Run:  ~/emsdk/node/*/bin/node streaming_paramset_test.mjs
// Env:  FERRITE_ENGINE (default ../assets/ferrite.mjs), FERRITE_FIXTURES (default ./fixtures)
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.FERRITE_ENGINE ? path.resolve(process.cwd(), process.env.FERRITE_ENGINE) : path.join(HERE, '..', 'assets', 'ferrite.mjs');
const FIXTURES = process.env.FERRITE_FIXTURES ? path.resolve(process.cwd(), process.env.FERRITE_FIXTURES) : path.join(HERE, 'fixtures');

const memory = new WebAssembly.Memory({ initial: 268435456 / 65536, maximum: 32768, shared: true });
let ppsErr = 0;
const Engine = (await import(ENGINE)).default;
const m = await Engine({
  wasmMemory: memory,
  printErr: (s) => { if (s.includes('PPS id out of range') || s.includes('non-existing PPS') || s.includes('non-existing SPS')) ppsErr++; },
  print: () => {},
});
// liveHeap: a decode-pthread heap grow detaches a cached HEAPU8 view (growable shared memory).
const heap = () => (m.HEAPU8.buffer !== memory.buffer ? (m.HEAPU8 = new Uint8Array(memory.buffer)) : m.HEAPU8);
const H264 = 27, HEVC = 173;
const CODEC = { 173: 'HEVC', 27: 'H.264', 2: 'MPEG-2' };

const STARTUP_BYTES = 256 * 1024;
const CHUNK = 64 * 1024;

// Drive the LIVE streaming demux exactly as worker.ts pump() does: build the decoder FROM the demux once
// the param sets resolve (else bare), recreate on resolution, and HOLD H.264/HEVC packets until resolved.
function runStreaming(ts, offset) {
  ppsErr = 0;
  const d = m._ferrite_demux_new_streaming();
  let pos = offset;
  const feed = (from, to) => { const sl = ts.subarray(from, to); const p = m._malloc(sl.length); heap().set(sl, p); m._ferrite_demux_feed(d, p, sl.length); m._free(p); };
  feed(offset, Math.min(offset + STARTUP_BYTES, ts.length)); pos = Math.min(offset + STARTUP_BYTES, ts.length);
  let opened = false;
  for (let t = 0; t < 600 && !opened; t++) { if (m._ferrite_demux_open(d) === 0) opened = true; else { feed(pos, Math.min(pos + CHUNK, ts.length)); pos = Math.min(pos + CHUNK, ts.length); } }
  if (!opened) { m._ferrite_demux_free(d); return { ok: false, err: 'open failed' }; }

  let vcodec = m._ferrite_demux_vcodec(d), v = 0, hasExtradata = false, edSize = 0;
  let frames = 0, vpkts = 0, w = 0, h = 0, fedBare = 0;
  const makeVdec = () => {
    if (v) m._ferrite_vdec_free(v);
    edSize = m._ferrite_demux_v_extradata_size(d);
    v = edSize > 0 ? m._ferrite_vdec_new_from_demux(d, 8) : m._ferrite_vdec_new(vcodec, 8);
    hasExtradata = edSize > 0;
  };
  for (let g = 0; g < 1e7; g++) {
    if (pos < ts.length) { feed(pos, Math.min(pos + CHUNK, ts.length)); pos = Math.min(pos + CHUNK, ts.length); }
    else m._ferrite_demux_eof(d);
    const s = m._ferrite_demux_step(d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(d) === 0) {
        vpkts++;
        if (vcodec <= 0) vcodec = m._ferrite_demux_vcodec(d);
        if (vcodec > 0 && !v) makeVdec();
        if (v && !hasExtradata && m._ferrite_demux_v_extradata_size(d) > 0) makeVdec(); // upgrade to _from_demux
        const isKey = m._ferrite_demux_pkt_is_key(d) === 1;
        const hold = (vcodec === H264 || vcodec === HEVC) && !hasExtradata && !isKey;
        if (v && !hold) {
          if (!hasExtradata) fedBare++;
          m._ferrite_vdec_push(v, m._ferrite_demux_pkt_data(d), m._ferrite_demux_pkt_size(d), BigInt(m._ferrite_demux_pkt_pts_us(d)));
          while (m._ferrite_vdec_step(v) === 1) { frames++; w = m._ferrite_vdec_w(v); h = m._ferrite_vdec_h(v); }
        }
      }
    } else if (s === 2) { if (pos >= ts.length) { if (v) { m._ferrite_vdec_push(v, 0, 0, 0n); while (m._ferrite_vdec_step(v) === 1) frames++; } break; } }
    else if (s === 0) { if (v) { m._ferrite_vdec_push(v, 0, 0, 0n); while (m._ferrite_vdec_step(v) === 1) frames++; } break; }
    else break;
  }
  if (v) m._ferrite_vdec_free(v);
  m._ferrite_demux_free(d);
  return { ok: true, vcodec, edSize, frames, vpkts, w, h, fedBare, pps: ppsErr };
}

const FILES = ['h264_1080_50.ts', 'hevc_1080_50.ts', 'hevc_2160_50.ts', 'mpeg2_1080_25.ts'].filter((f) => fs.existsSync(path.join(FIXTURES, f)));
if (FILES.length === 0) { console.error(`No fixtures in ${FIXTURES}. Generate: (cd fixtures && bash gen_clips.sh)`); process.exit(1); }

console.log(`engine:   ${ENGINE}`);
console.log(`fixtures: ${FIXTURES}\n`);
let bad = 0;
for (const f of FILES) {
  const ts = fs.readFileSync(path.join(FIXTURES, f));
  // (a) Join AT byte 0 (a keyframe boundary, the production-common live-connect case).
  const z = runStreaming(ts, 0);
  // (b) Mid-stream join ~1/3 in (188-aligned) — a mid-GOP join; the decoder must still never be fed
  //     a param-set-less packet (the hold), so no decoder-side PPS flood.
  const midOff = Math.floor(ts.length / 3 / 188) * 188;
  const mid = runStreaming(ts, midOff);
  const name = CODEC[z.vcodec] || z.vcodec;

  const isH = z.vcodec === H264 || z.vcodec === HEVC; // only H.264/HEVC HOLD pre-keyframe packets
  const zOk = z.ok && z.frames > 0 && z.w > 0 && z.h > 0 && z.edSize > 0 && z.fedBare === 0 && z.pps === 0 && z.frames === z.vpkts;
  // Mid-GOP: extradata still resolves + decode recovers. H.264/HEVC additionally must HOLD (never feed a
  // param-set-less packet → no decoder-side PPS flood); MPEG-2 has no hold (it self-conceals; no flood).
  const midOk = mid.ok && mid.edSize > 0 && mid.frames > 0 && (isH ? mid.fedBare === 0 : mid.pps === 0);
  if (!zOk || !midOk) bad++;
  console.log(`${f.padEnd(20)} v=${String(name).padEnd(6)} ${z.w}x${z.h}`);
  console.log(`   byte-0 join : ${z.frames}/${z.vpkts}f  extradata=${z.edSize}B  fed-bare=${z.fedBare}  pps=${z.pps}  ${zOk ? '✓' : '✗ (want full decode, extradata>0, fed-bare=0, pps=0)'}`);
  console.log(`   mid-GOP join: ${mid.frames}/${mid.vpkts}f  extradata=${mid.edSize}B  fed-bare=${mid.fedBare}  (parser join-noise pps=${mid.pps})  ${midOk ? '✓' : '✗ (want extradata>0, fed-bare=0, frames>0)'}`);
}
console.log(bad === 0
  ? '\nALL OK — live streaming demux resolves in-band param sets (extradata), builds the decoder FROM the demux, and never feeds it a param-set-less packet (no decoder-side PPS flood).'
  : `\n${bad} FAILED.`);
process.exit(bad ? 1 : 0);
