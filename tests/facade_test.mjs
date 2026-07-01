// Node self-validation for the DOM-free facade pieces (config.ts + errors.ts + types.ts +
// worker/codec.ts + policy.ts) — no browser needed.
//
// What this proves WITHOUT a browser:
//  1. ERASABILITY — node's --experimental-strip-types import THROWS on a TS enum / parameter
//     property. A clean import of these modules is the erasable-TS proof for them.
//  2. CONFIG — mergeConfig defaults (ferrite divergences: rate 1.05, target 0.6) + validation
//     (the hls.js graft: liveSyncMaxLatency > target; floor ≤ ceiling; threads ≥ 1).
//  3. ERROR MAPPING — every ferrite failure kind maps to the verbatim mpegts.js (type, details)
//     strings AND buckets correctly through a faithful replica of an mpegts.js error classifier
//     (the lowercased substring matcher that mpegts.js consumers use).
//  4. CODEC — H.264 SPS parse → avc1.PPCCLL + interlace flag; HEVC codec strings; the WebCodecs
//     tier-eligibility truth table.
//  5. POLICY — adaptive low-water, live latency-sync, and the reconnect backoff (pure fns).
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types facade_test.mjs
//
// NOTE: index.ts / worker.ts / render/gl.ts touch DOM (Worker, document, WebGL) so they can't
// be node-imported; their lifecycle correctness is the browser smoke test.

import { mergeConfig, validateConfig, defaultConfig } from '../src/config.ts';
import { ErrorTypes, ErrorDetails, mapFerriteError } from '../src/errors.ts';
import { Events } from '../src/types.ts';
import {
  h264SpsFromAu, avc1CodecString, hevcCodecString, videoCodecInfo, webCodecsEligible,
} from '../src/worker/codec.ts';
import {
  adaptiveLowWater, adaptiveReadAhead, reconnectDelayMs,
  LOW_WATER_DEFAULT_FLOOR, LOW_WATER_DEFAULT_CEILING,
  RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS,
  wcRingCapForPlatform, WC_RING_CAP_DEFAULT, WC_RING_CAP_IOS,
} from '../src/policy.ts';
import { detectPlatform } from '../src/platform.ts';

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); };
};
const throws = (fn, msg) => {
  try { fn(); fail++; console.error(`✗ ${msg} (expected throw)`); }
  catch { pass++; }
};

// ---- 1. Faithful replica of an mpegts.js error classifier (lowercased substring match) ---------
// Mirrors the normalize (details+message+info, lowercased) + the decision order consumers use.
function classify({ type, details, info }) {
  const t = String(type ?? '').toLowerCase();
  const d = String(details ?? '').toLowerCase();
  const matchStr = `${details ?? ''} ${JSON.stringify(info ?? '')}`.toLowerCase();
  const isEarlyEof = d.replace(/[^a-z0-9]/g, '').includes('earlyeof');
  const isNetwork = /network|loaderror|timeout|status/.test(t + ' ' + d);
  const accessKeys = ['cors', 'cross-origin', 'cross origin', 'access-control', 'access control',
    'content security policy', 'mixed content', 'private network access', 'err_blocked', 'err_cleartext',
    'not allowed to load local resource'];
  const isBrowserAccess = accessKeys.some((k) => matchStr.includes(k));
  if (isEarlyEof) return 'media-decode-error';
  if (isNetwork) return isBrowserAccess ? 'browser-access-error' : 'network-error';
  if (d.includes('codec')) return 'unsupported-codec';
  if (d.includes('format') || d.includes('mse')) return 'unsupported-container';
  if (t.includes('media')) return 'media-decode-error';
  return 'unknown-playback-error';
}

// ---- 2. config ----------------------------------------------------------------------------
const def = mergeConfig();
eq(def.stashAdaptive, true, 'stashAdaptive on (adaptive low-water)');
eq(def.threads, 'auto', "default threads 'auto' (host-adaptive; resolved at the DOM boundary)");
const ov = mergeConfig({ threads: 16, isLive: true });
eq(ov.threads, 16, 'override threads');
throws(() => mergeConfig({ threads: 0 }), 'threads < 1 rejected');
throws(() => mergeConfig({ stashInitialSize: 9_000_000, stashMaxSize: 2_000_000 }), 'floor > ceiling rejected');
throws(() => validateConfig({ ...defaultConfig, wasmBaseUrl: '' }), 'empty wasmBaseUrl rejected');
// stashInitialSize undefined is allowed (engine default)
eq(mergeConfig({ stashInitialSize: undefined }).stashInitialSize, undefined, 'undefined stashInitialSize allowed');

// ---- 3. Events verbatim (standard names must match mpegts) ---------------------------------
eq(Events.ERROR, 'error', 'Events.ERROR verbatim');
eq(Events.MEDIA_INFO, 'media_info', 'Events.MEDIA_INFO verbatim');
eq(Events.STATISTICS_INFO, 'statistics_info', 'Events.STATISTICS_INFO verbatim');
eq(Events.LOADING_COMPLETE, 'loading_complete', 'Events.LOADING_COMPLETE verbatim');
eq(Events.DESTROYING, 'destroying', 'Events.DESTROYING verbatim');

// ---- 4. error mapping → verbatim strings + correct host bucket -----------------------------
const cases = [
  ['not-isolated',   503, ErrorTypes.MEDIA_ERROR,   ErrorDetails.MEDIA_CODEC_UNSUPPORTED,            'unsupported-codec'],
  ['engine-load',     -1, ErrorTypes.MEDIA_ERROR,   'EngineInitFailed',                              'media-decode-error'],
  ['network-status', 404, ErrorTypes.NETWORK_ERROR, ErrorDetails.NETWORK_STATUS_CODE_INVALID,        'network-error'],
  ['network',         -1, ErrorTypes.NETWORK_ERROR, ErrorDetails.NETWORK_EXCEPTION,                  'network-error'],
  ['early-eof',       -1, ErrorTypes.NETWORK_ERROR, ErrorDetails.NETWORK_UNRECOVERABLE_EARLY_EOF,    'media-decode-error'],
  ['demux',           -1, ErrorTypes.MEDIA_ERROR,   ErrorDetails.MEDIA_FORMAT_ERROR,                 'unsupported-container'],
  ['decode',          -1, ErrorTypes.MEDIA_ERROR,   'DecodeError',                                   'media-decode-error'],
  ['worker',          -1, ErrorTypes.OTHER_ERROR,   'WorkerException',                               'unknown-playback-error'],
];
for (const [kind, code, wantType, wantDetails, wantBucket] of cases) {
  const e = mapFerriteError(kind, code, `msg for ${kind}`);
  eq(e.type, wantType, `${kind} → type`);
  eq(e.details, wantDetails, `${kind} → details`);
  eq(e.info.code, code, `${kind} → info.code`);
  eq(typeof e.info.msg, 'string', `${kind} → info.msg present`);
  eq(classify({ type: e.type, details: e.details, info: e.info }), wantBucket, `${kind} → host bucket`);
}
// Adversarial: a network-ish worker MESSAGE must NOT flip the bucket (classifier keys the
// network row on type+details only; the msg rides in info).
{
  const e = mapFerriteError('worker', -1, 'network timeout status failure');
  eq(classify({ type: e.type, details: e.details, info: e.info }), 'unknown-playback-error',
    'worker error with network-ish message still buckets to unknown');
}
// Verbatim string spot-checks (these MUST equal mpegts.js literals).
eq(ErrorTypes.NETWORK_ERROR, 'NetworkError', 'ErrorTypes.NETWORK_ERROR verbatim');
eq(ErrorTypes.MEDIA_ERROR, 'MediaError', 'ErrorTypes.MEDIA_ERROR verbatim');
eq(ErrorDetails.NETWORK_UNRECOVERABLE_EARLY_EOF, 'UnrecoverableEarlyEof', 'UnrecoverableEarlyEof verbatim');
eq(ErrorDetails.MEDIA_CODEC_UNSUPPORTED, 'CodecUnsupported', 'CodecUnsupported verbatim');
eq(ErrorDetails.MEDIA_FORMAT_ERROR, 'FormatError', 'FormatError verbatim');

// ---- 5. WebCodecs tier: SPS parse + codec strings + tier eligibility (codec.ts) ------------
// Build an Annex-B SPS access unit to exercise the parser.
class BitWriter {
  constructor() { this.out = []; this.cur = 0; this.nbits = 0; }
  bit(b) { this.cur |= (b & 1) << (7 - this.nbits); if (++this.nbits === 8) { this.out.push(this.cur); this.cur = 0; this.nbits = 0; } }
  ue(v) { const code = v + 1; const bits = 32 - Math.clz32(code); for (let i = 0; i < bits - 1; i++) this.bit(0); for (let i = bits - 1; i >= 0; i--) this.bit((code >> i) & 1); }
  finish() { this.bit(1); if (this.nbits) this.out.push(this.cur); return this.out; }
}
function buildSps(profile, constraints, level, frameMbsOnly) {
  const w = new BitWriter();
  w.ue(0); // sps_id
  const high = [100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile);
  if (high) { w.ue(1); w.ue(0); w.ue(0); w.bit(0); w.bit(0); } // chroma 4:2:0, bit depths, no scaling
  w.ue(4); // log2_max_frame_num_minus4
  w.ue(0); // pic_order_cnt_type
  w.ue(4); // log2_max_pic_order_cnt_lsb_minus4
  w.ue(4); // max_num_ref_frames
  w.bit(0); // gaps_in_frame_num
  w.ue(119); // pic_width_in_mbs_minus1 (1920)
  w.ue(67); // pic_height_in_map_units_minus1
  w.bit(frameMbsOnly ? 1 : 0);
  return new Uint8Array([0, 0, 0, 1, 0x67, profile, constraints, level, ...w.finish()]);
}

// SPS parse → exact avc1.PPCCLL + interlace flag.
{
  const s = h264SpsFromAu(buildSps(100, 0x00, 40, true));
  eq(s?.profileIdc, 100, 'sps profile_idc');
  eq(s?.levelIdc, 40, 'sps level_idc');
  eq(s?.frameMbsOnly, true, 'sps progressive');
  eq(avc1CodecString(s.profileIdc, s.constraintFlags, s.levelIdc), 'avc1.640028', 'avc1 string High@4.0');
}
{
  const s = h264SpsFromAu(buildSps(100, 0x00, 51, false));
  eq(s?.frameMbsOnly, false, 'interlaced SPS frame_mbs_only=0');
  eq(avc1CodecString(s.profileIdc, s.constraintFlags, s.levelIdc), 'avc1.640033', 'avc1 string High@5.1');
}
{
  const s = h264SpsFromAu(buildSps(77, 0x40, 31, true));
  eq(avc1CodecString(s.profileIdc, s.constraintFlags, s.levelIdc), 'avc1.4d401f', 'avc1 Main@3.1 with constraints');
}
eq(h264SpsFromAu(new Uint8Array([0, 0, 1, 0x09, 0xf0])), null, 'no SPS → null');

// HEVC codec strings.
eq(hevcCodecString(false, 153), 'hev1.1.6.L153.B0', 'hevc Main L5.1');
eq(hevcCodecString(true, 156), 'hev1.2.4.L156.B0', 'hevc Main10 L5.2');
eq(hevcCodecString(false, -99), 'hev1.1.6.L153.B0', 'hevc unknown level → L153 fallback');

// videoCodecInfo: H.264 from SPS, HEVC from profile/level, MPEG-2 → no WC string.
{
  const i = videoCodecInfo(27, -99, -99, buildSps(100, 0x00, 40, true));
  eq(i.codec, 'avc1.640028', 'h264 info codec from SPS'); eq(i.interlaced, false, 'h264 info progressive');
}
{
  const i = videoCodecInfo(27, -99, -99, buildSps(100, 0x00, 51, false));
  eq(i.interlaced, true, 'h264 info interlaced flagged');
}
eq(videoCodecInfo(27, -99, -99, null).codec, 'avc1.640028', 'h264 no-AU → generic High@4.0');
eq(videoCodecInfo(173, 1, 153, null).codec, 'hev1.1.6.L153.B0', 'hevc info Main');
eq(videoCodecInfo(173, 2, 153, null).codec, 'hev1.2.4.L153.B0', 'hevc info Main10 (profile 2)');
eq(videoCodecInfo(2, -99, -99, null).codec, '', 'mpeg2 → no WebCodecs string (software)');

// webCodecsEligible truth table (the SYNC half of the tier gate).
eq(webCodecsEligible(true, true, { codec: 'avc1.640028', interlaced: false }), true, 'eligible: prefer+VD+codec+progressive');
eq(webCodecsEligible(false, true, { codec: 'avc1.640028', interlaced: false }), false, 'not eligible: host did not prefer WC');
eq(webCodecsEligible(true, false, { codec: 'avc1.640028', interlaced: false }), false, 'not eligible: no VideoDecoder');
eq(webCodecsEligible(true, true, { codec: '', interlaced: false }), false, 'not eligible: no WC codec string (e.g. MPEG-2)');
eq(webCodecsEligible(true, true, { codec: 'avc1.640033', interlaced: true }), false, 'not eligible: interlaced → software deinterlace');

// ---- 6. low-water / latency-sync / reconnect pure policy (policy.ts) --------------------------------------------
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`✗ ${msg}`); } };
const approx = (got, want, eps, msg) => ok(Math.abs(got - want) <= eps, `${msg} (got ${got}, want ≈${want})`);
const F = LOW_WATER_DEFAULT_FLOOR, C = LOW_WATER_DEFAULT_CEILING; // 256 KiB, 2 MiB
const KiB = 1024;

// --- adaptive low-water ---
// Warmup holds the ceiling regardless of any peak seen (== pre-adaptive fixed behaviour).
eq(adaptiveLowWater(0, false, F, C), C, 'low-water warmup holds ceiling (peak 0)');
eq(adaptiveLowWater(5 * 1024 * KiB, false, F, C), C, 'low-water warmup holds ceiling (huge peak)');
// Clamp to floor / ceiling once warmed.
eq(adaptiveLowWater(KiB, true, F, C), F, 'low-water tiny PES clamps up to floor');
eq(adaptiveLowWater(10 * 1024 * KiB, true, F, C), C, 'low-water huge PES clamps down to ceiling');
eq(adaptiveLowWater(C, true, F, C), C, 'low-water PES at ceiling resolves to ceiling');
// PES-completeness invariant: for any peak ≤ ceiling, lw ≥ peak (never a partial-PES step) + in band.
for (const peak of [0, 1, F, 300 * KiB, 512 * KiB, 1024 * KiB, C - 1, C]) {
  const lw = adaptiveLowWater(peak, true, F, C);
  ok(lw >= peak, `low-water PES-completeness: lw ${lw} ≥ peak ${peak}`);
  ok(lw >= F && lw <= C, `low-water lw ${lw} within [floor, ceiling]`);
}
// Band: SD < HD < 4K(=ceiling), with the exact FACTOR·peak + MARGIN form (factor 2, margin 64 KiB).
const sd = adaptiveLowWater(150 * KiB, true, F, C);
eq(sd, 150 * KiB * 2 + 64 * KiB, 'low-water SD band = peak·2 + 64KiB');
ok(sd > F && sd < C, 'low-water SD relaxes below ceiling above floor');
const hd = adaptiveLowWater(400 * KiB, true, F, C);
ok(hd > sd && hd < C, 'low-water HD > SD, < ceiling');
eq(adaptiveLowWater(1024 * KiB, true, F, C), C, 'low-water 4K (1 MiB PES) saturates to ceiling');
// Monotonic non-decreasing in peak (caller tracks a running max → never thrashes down).
let prevLw = 0;
for (let kb = 0; kb <= 2200; kb += 64) { const lw = adaptiveLowWater(kb * KiB, true, F, C); ok(lw >= prevLw, `low-water monotonic at ${kb}KiB`); prevLw = lw; }
// Read-ahead tracks the low-water: always > lw, ≤ ceiling (= 2× the low-water ceiling).
const RA_C = C * 2;
for (const lw of [F, 364 * KiB, 1024 * KiB, C]) {
  const ra = adaptiveReadAhead(lw, RA_C);
  ok(ra > lw, `low-water read-ahead ${ra} > low-water ${lw}`);
  ok(ra <= RA_C, `low-water read-ahead ${ra} ≤ ceiling ${RA_C}`);
}
eq(adaptiveReadAhead(C, RA_C), RA_C, 'low-water read-ahead at ceiling = 2× low-water ceiling');

// --- reconnect backoff (policy.ts reconnectDelayMs) ---
eq(reconnectDelayMs(0, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 1000, 'reconnect attempt 0 → base 1000ms');
eq(reconnectDelayMs(1, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 2000, 'reconnect attempt 1 → 2000ms (exp)');
eq(reconnectDelayMs(2, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 4000, 'reconnect attempt 2 → 4000ms');
eq(reconnectDelayMs(3, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 8000, 'reconnect attempt 3 → 8000ms (ceiling)');
eq(reconnectDelayMs(10, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 8000, 'reconnect large attempt → capped at max');
eq(reconnectDelayMs(-1, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS), 1000, 'reconnect negative attempt → base (guarded)');

// Config wiring spot-check: the low-water knobs the worker/clock read have the ferrite defaults.
eq(defaultConfig.stashMaxSize, C, 'config stashMaxSize default = low-water ceiling');

// ---- 7. platform detection (iOS/iPadOS/Apple-WebKit, conservative) ---------------------
// UA strings cover: iPhone Safari, iPhone Chrome (CriOS), iPad legacy UA, iPadOS-13+ desktop UA,
// desktop Safari (Mac), desktop Chrome (Mac), Windows Chrome, Android Chrome.
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  ipadLegacy:   'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  ipadOSDesktop:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', // iPadOS 13+ masquerade
  macSafari:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macChrome:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  winChrome:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  androidChrome:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
};
// iOS family (the tight-VideoFrame-budget signal) — every iOS browser is WebKit.
eq(detectPlatform(UA.iphoneSafari, 'iPhone', 5).isIOS, true, 'T1.7 iPhone Safari → iOS');
eq(detectPlatform(UA.iphoneChrome, 'iPhone', 5).isIOS, true, 'T1.7 iPhone Chrome (CriOS) → iOS');
eq(detectPlatform(UA.ipadLegacy, 'iPad', 5).isIOS, true, 'T1.7 iPad legacy UA → iOS');
// iPadOS 13+ reports as Macintosh; the ONLY tell is multitouch on a "Mac".
eq(detectPlatform(UA.ipadOSDesktop, 'MacIntel', 5).isIOS, true, 'T1.7 iPadOS-as-desktop (Mac + touch) → iOS');
eq(detectPlatform(UA.ipadOSDesktop, 'MacIntel', 0).isIOS, false, 'T1.7 Mac WITHOUT touch (real Mac) → not iOS');
// Apple-WebKit engine (broader): iOS + desktop Safari; NOT Chromium/Firefox on non-iOS.
eq(detectPlatform(UA.iphoneSafari, 'iPhone', 5).isAppleWebKit, true, 'T1.7 iPhone → AppleWebKit');
eq(detectPlatform(UA.macSafari, 'MacIntel', 0).isAppleWebKit, true, 'T1.7 desktop Safari → AppleWebKit');
eq(detectPlatform(UA.macSafari, 'MacIntel', 0).isIOS, false, 'T1.7 desktop Safari → not iOS');
eq(detectPlatform(UA.macChrome, 'MacIntel', 0).isAppleWebKit, false, 'T1.7 Mac Chrome → not AppleWebKit (Chromium)');
eq(detectPlatform(UA.macChrome, 'MacIntel', 0).isIOS, false, 'T1.7 Mac Chrome → not iOS');
eq(detectPlatform(UA.winChrome, 'Win32', 0).isIOS, false, 'T1.7 Windows Chrome → not iOS');
eq(detectPlatform(UA.winChrome, 'Win32', 0).isAppleWebKit, false, 'T1.7 Windows Chrome → not AppleWebKit');
eq(detectPlatform(UA.androidChrome, '', 5).isIOS, false, 'T1.7 Android Chrome (touch, not Mac) → not iOS');
eq(detectPlatform(UA.androidChrome, '', 5).isAppleWebKit, false, 'T1.7 Android Chrome → not AppleWebKit');
// Empty/garbage UA must not throw + defaults to non-Apple.
eq(detectPlatform('', '', 0).isIOS, false, 'T1.7 empty UA → not iOS (no throw)');

// ---- 8. iOS-aware WebCodecs present-ring cap (policy.wcRingCapForPlatform) -------------
eq(wcRingCapForPlatform(false), WC_RING_CAP_DEFAULT, 'T1.2 desktop → deep cap (120)');
eq(wcRingCapForPlatform(true), WC_RING_CAP_IOS, 'T1.2 iOS → tight cap (24)');
ok(WC_RING_CAP_IOS < WC_RING_CAP_DEFAULT, 'T1.2 iOS cap is tighter than desktop');
ok(WC_RING_CAP_IOS >= 4, 'T1.2 iOS cap keeps a usable cushion');
// Host override wins on either platform, floored at 4, integer.
eq(wcRingCapForPlatform(true, 60), 60, 'T1.2 override wins on iOS');
eq(wcRingCapForPlatform(false, 16), 16, 'T1.2 override wins on desktop');
eq(wcRingCapForPlatform(true, 1), 4, 'T1.2 override floored at 4');
eq(wcRingCapForPlatform(true, 12.7), 12, 'T1.2 override floored to an integer');
eq(wcRingCapForPlatform(true, 0), WC_RING_CAP_IOS, 'T1.2 override 0 ignored → platform default');
eq(wcRingCapForPlatform(false, Number.NaN), WC_RING_CAP_DEFAULT, 'T1.2 override NaN ignored → platform default');

console.log(`\nfacade_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
