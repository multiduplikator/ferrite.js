// Phase A/B engine gate (v1.3.2 audio overhaul + anamorphic SAR) — exercises the NEW engine exports
// directly against a real decoded stream:
//   (A1) STEREO DOWNMIX  — ferrite_audio_channels() is always 2 (the engine folds surround→stereo before
//        the PCM crosses to Web Audio), and ferrite_audio_src_channels() reports the pre-downmix count.
//   (A2) CTX-RATE RESAMPLE — ferrite_audio_set_out_rate(R) makes ferrite_audio_rate()==R and the per-chunk
//        sample count scale by ~R/srcRate (one stateful swresample pass, not Web Audio's per-chunk resample).
//   (A3) DYNA / NIGHT     — ferrite_audio_set_drc(2) runs the universal compressor: output stays bounded to
//        ±1 (hard clip-guard) and DIFFERS from Line (mode 0) — i.e. the gain stage actually engaged.
//   (B)  ANAMORPHIC SAR   — ferrite_demux_v_sar_num/den() resolve a pixel aspect via the one-shot keyframe
//        decode (≥1; 1:1 for the square-pixel fixtures — the getter runs all-codec without a crash).
//
// Browser-only (not covered here): the AudioWorklet played-frames clock, the visual anamorphic un-squish,
// and audible Night peak-taming — see the demo. Runtime here is the engine contract.
//
// Run:  node --experimental-strip-types audio_overhaul.mjs   (or any node ≥22)
// Env:  FERRITE_ENGINE (default ../assets/ferrite.mjs), FERRITE_FIXTURES (default ./fixtures)
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
const fix = (f) => path.join(FIXTURES, f);

const Engine = (await import(ENGINE)).default;
const m = await Engine();

let bad = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) bad++; };

function openDemux(p) {
  const cptr = m._malloc(8);
  const buf = fs.readFileSync(p);
  const ptr = m._malloc(buf.length);
  m.HEAPU8.set(buf, ptr);
  const d = m._ferrite_demux_new_file(ptr, buf.length, cptr, cptr + 4);
  return { d, cptr, free: () => { m._free(cptr); m._free(ptr); } };
}

// Decode the audio stream, optionally setting out-rate + DRC first. Returns aggregate metrics + the first
// chunk's interleaved-float PCM peak (max |sample|) so callers can compare DRC modes / check the clip guard.
function decodeAudio(p, { outRate = 0, drc = 0 } = {}) {
  const h = openDemux(p);
  const a = m._ferrite_audio_new_from_demux(h.d);
  if (!a) { h.free(); return null; }
  if (outRate) m._ferrite_audio_set_out_rate(a, outRate);
  m._ferrite_audio_set_drc(a, drc);
  let chunks = 0, samples = 0, channels = 0, srcChannels = 0, rate = 0, peak = 0;
  const grab = () => {
    while (m._ferrite_audio_step(a) === 1) {
      chunks++;
      channels = m._ferrite_audio_channels(a);
      srcChannels = m._ferrite_audio_src_channels(a);
      rate = m._ferrite_audio_rate(a);
      const n = m._ferrite_audio_samples(a) * channels;
      samples += m._ferrite_audio_samples(a);
      const fptr = m._ferrite_audio_interleaved(a);
      const pcm = new Float32Array(m.HEAPU8.buffer.slice(fptr, fptr + n * 4));
      for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    }
  };
  for (let g = 0; g < 1e7 && chunks < 60; g++) {
    const s = m._ferrite_demux_step(h.d);
    if (s === 1) {
      if (m._ferrite_demux_pkt_stream(h.d) === 1) {
        m._ferrite_audio_push(a, m._ferrite_demux_pkt_data(h.d), m._ferrite_demux_pkt_size(h.d), m._ferrite_demux_pkt_pts_us(h.d));
        grab();
      }
    } else if (s === 0) { m._ferrite_audio_push(a, 0, 0, 0n); grab(); break; }
    else break;
  }
  m._ferrite_audio_free(a); m._ferrite_demux_free(h.d); h.free();
  return { chunks, samples, channels, srcChannels, rate, peak };
}

function sarOf(p) {
  const h = openDemux(p);
  // Advance to the first video packet so the engine has a keyframe to one-shot-decode the SAR from.
  for (let g = 0; g < 1e6; g++) { const s = m._ferrite_demux_step(h.d); if (s !== 1) break; if (m._ferrite_demux_pkt_stream(h.d) === 0) break; }
  const n = m._ferrite_demux_v_sar_num(h.d), d = m._ferrite_demux_v_sar_den(h.d);
  m._ferrite_demux_free(h.d); h.free();
  return { n, d };
}

const AUDIO_FILES = ['vod_h264_aac.mp4', 'vod_h264_aac.mkv', 'vod_hevc_aac.mkv'].filter((f) => fs.existsSync(fix(f)));
if (!AUDIO_FILES.length) {
  console.error(`No VOD fixtures in ${FIXTURES}. Generate them: (cd fixtures && bash gen_vod.sh)`);
  process.exit(1);
}
console.log(`engine:   ${ENGINE}`);
console.log(`fixtures: ${FIXTURES}`);

const file = AUDIO_FILES[0];
console.log(`\n— A1: stereo downmix + source-channel telemetry (${file}) —`);
const base = decodeAudio(fix(file));
ok(base && base.chunks > 0 && base.samples > 0, `decoded ${base?.chunks} chunks / ${base?.samples} samples`);
ok(base && base.channels === 2, `output channels = ${base?.channels} (engine downmix → stereo)`);
ok(base && base.srcChannels >= 1, `source channels = ${base?.srcChannels} (pre-downmix telemetry)`);

console.log('\n— A2: resample to a requested output rate (one stateful swr pass) —');
const target = base.rate === 44100 ? 48000 : 44100; // pick a rate that differs from the source
const res = decodeAudio(fix(file), { outRate: target });
ok(res && res.rate === target, `set_out_rate(${target}) → audio_rate() = ${res?.rate}`);
// Output sample count scales by the rate ratio (within a few % for swr buffering/rounding).
const ratio = res.samples / base.samples, expect = target / base.rate;
ok(Math.abs(ratio - expect) / expect < 0.05, `sample-count ratio ${ratio.toFixed(3)} ≈ rate ratio ${expect.toFixed(3)}`);

console.log('\n— A3: Dyna / Night universal compressor (mode 2) —');
const night = decodeAudio(fix(file), { drc: 2 });
ok(night && night.chunks > 0, `Night decoded ${night?.chunks} chunks`);
ok(night && night.peak <= 1.0 + 1e-6, `Night output bounded to ±1 (clip-guard); peak = ${night?.peak.toFixed(4)}`);
ok(night && Math.abs(night.peak - base.peak) > 1e-4, `Night peak ${night?.peak.toFixed(4)} differs from Line ${base.peak.toFixed(4)} (gain stage engaged)`);

console.log('\n— B: anamorphic SAR getter (one-shot keyframe decode, all-codec) —');
for (const f of AUDIO_FILES) {
  const { n, d } = sarOf(fix(f));
  ok(n >= 1 && d >= 1, `${f.padEnd(20)} SAR ${n}:${d} (≥1; 1:1 = square pixels — getter ran without crash)`);
}

console.log(bad === 0
  ? '\nALL OK — engine stereo downmix + ctx-rate resample + Dyna/Night + all-codec SAR getter work.'
  : `\n${bad} FAILED.`);
process.exit(bad ? 1 : 0);
