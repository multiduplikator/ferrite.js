// Unit test for the PURE VOD-WebCodecs tier-selection decision (src/worker/codec.ts vodVideoConfig) + the
// seek await-keyframe ARMING semantics (src/worker/wc-guard.ts wcKeyframeGate, in the VOD-seek context).
//
// VOD differs from LIVE in the bitstream FORMAT: a remote MP4/MKV delivers LENGTH-PREFIXED (AVCC/HVCC) NALs
// with the param sets in an avcC/hvcC config record (codecpar->extradata) — whereas live mpegts is Annex-B
// with in-band SPS. WebCodecs keys the format off `description` presence, so VOD-WC MUST pass the config
// record as the description (the length-prefixed path); a .ts-container VOD (Annex-B, like live) passes none.
// WebCodecs itself is browser-only → only these DECISIONS are headless-testable; the VideoDecoder.configure/
// decode + the present ring are the owner browser bank.
//
// The avcC/hvcC byte arrays below are the REAL extradata the engine's find_stream_info resolves for the VOD
// fixtures (tests/fixtures/vod_h264_aac.mp4 + vod_hevc_aac.mkv) — captured once via ferrite_demux_v_extradata
// so this test stays pure (no engine/fixtures needed to run).
//
// Run:  node --experimental-strip-types tests/vod_wc_test.mjs

import assert from 'node:assert/strict';
import { vodVideoConfig, webCodecsEligible } from '../src/worker/codec.ts';
import { wcKeyframeGate } from '../src/worker/wc-guard.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// REAL fixture extradata (resolved by the engine demuxer's find_stream_info; H.264 High@4.2, HEVC Main@L123).
const AVCC = new Uint8Array([1,100,0,42,255,225,0,27,103,100,0,42,172,217,64,120,2,39,229,192,68,0,0,3,0,4,0,0,3,1,144,60,96,198,88,1,0,6,104,234,227,203,34,192,253,248,248,0]);
const HVCC = new Uint8Array([1,1,96,0,0,0,144,0,0,0,0,0,123,240,0,252,253,248,248,0,0,15,3,32,0,1,0,24,64,1,12,1,255,255,1,96,0,0,3,0,144,0,0,3,0,0,3,0,123,149,152,9,33,0,1,0,42,66,1,1,1,96,0,0,3,0,144,0,0,3,0,0,3,0,123,160,3,192,128,16,229,150,86,105,36,202,240,22,128,128,0,0,3,0,128,0,0,25,4,34,0,1,0,7,68,1,193,114,180,98,64]);
const H264 = 27, HEVC = 173, MPEG2 = 2;
const EMPTY = new Uint8Array(0);

// ---- vodVideoConfig: H.264 (AVCC config record → exact string from avcC[1..3] + description) -------------
console.log('vodVideoConfig — H.264:');

test('MP4/MKV avcC config record → avc1.PPCCLL from the record + description = the record (length-prefixed)', () => {
  const c = vodVideoConfig(H264, 100, 42, AVCC);
  // avcC[1]=0x64(profile), [2]=0x00(constraint flags), [3]=0x2a(level) → avc1.64002a (High@4.2).
  assert.equal(c.codec, 'avc1.64002a');
  assert.equal(c.interlaced, false);
  assert.ok(c.description, 'a config record must yield a WebCodecs description');
  assert.equal(c.description, AVCC, 'the description IS the extradata (length-prefixed path)');
});

test('the avc1 string is derived from the RECORD bytes, not the demuxer profile/level args (precise)', () => {
  // Pass deliberately-wrong profile/level args — the avcC path must ignore them and use the record bytes.
  const c = vodVideoConfig(H264, -99, -99, AVCC);
  assert.equal(c.codec, 'avc1.64002a');
});

test('Annex-B extradata (.ts VOD) → parse the in-band SPS → exact string, NO description (Annex-B path)', () => {
  // Build an Annex-B extradata from the avcC SPS NAL (avcC[8..8+27]) with a 4-byte start code prefix — the
  // shape a .ts-container VOD presents. h264SpsFromAu parses it like the live path.
  const spsLen = (AVCC[6] << 8) | AVCC[7]; // 27
  const annexb = new Uint8Array([0, 0, 0, 1, ...AVCC.subarray(8, 8 + spsLen)]);
  const c = vodVideoConfig(H264, -99, -99, annexb);
  assert.equal(c.codec, 'avc1.64002a', 'same exact string, parsed from the in-band SPS');
  assert.equal(c.description, null, 'Annex-B passes NO description (the live/in-band path)');
  assert.equal(c.interlaced, false, 'frame_mbs_only ⇒ progressive');
});

test('avcC of a PROGRESSIVE stream → interlaced=false (the real fixture SPS has frame_mbs_only=1)', () => {
  // The fixture avcC embeds a progressive SPS; the avcC-SPS interlace parse must read frame_mbs_only=1.
  const c = vodVideoConfig(H264, 100, 42, AVCC);
  assert.equal(c.interlaced, false);
});

// The review's MEDIUM: an interlaced H.264 MP4 (avcC) must NOT route to WebCodecs (it can't deinterlace) —
// the avcC EMBEDS the SPS, so vodVideoConfig now parses frame_mbs_only out of it (mirroring the live path).
// SPS_1080I is the REAL SPS NAL the engine demuxer reports for tests/fixtures/h264_1080i_25.ts (frame_mbs_only=0).
const SPS_1080I = [103,100,0,40,172,217,64,120,4,79,222,2,32,0,0,3,0,32,0,0,6,67,226,197,178,192,0];

test('INTERLACED avcC (embedded SPS frame_mbs_only=0) → interlaced=true → NOT WC-eligible → software (deinterlaces)', () => {
  // A minimal avcC wrapping the interlaced SPS: ver,prof,compat,level,0xff,0xe1(numSPS=1),spsLen(BE),SPS,numPPS=0.
  const L = SPS_1080I.length;
  const avcc = new Uint8Array([1, SPS_1080I[1], SPS_1080I[2], SPS_1080I[3], 0xff, 0xe1, (L >> 8) & 0xff, L & 0xff, ...SPS_1080I, 0x00]);
  const c = vodVideoConfig(H264, 100, 40, avcc);
  assert.equal(c.interlaced, true, 'the avcC-embedded interlaced SPS is detected (the review MEDIUM fix)');
  assert.equal(webCodecsEligible(true, true, c), false, 'interlaced → excluded from WC → software deinterlaces it');
});

test('INTERLACED Annex-B extradata (.ts VOD) → interlaced=true → software (the live-path parity)', () => {
  const annexb = new Uint8Array([0, 0, 0, 1, ...SPS_1080I]);
  const c = vodVideoConfig(H264, -99, -99, annexb);
  assert.equal(c.interlaced, true);
  assert.equal(webCodecsEligible(true, true, c), false);
});

test('no/empty extradata → generic High@4.0 fallback, NO description', () => {
  const c = vodVideoConfig(H264, -99, -99, EMPTY);
  assert.equal(c.codec, 'avc1.640028');
  assert.equal(c.description, null);
});

// ---- vodVideoConfig: HEVC (hvcC config record; tenBit from the RELIABLE VOD demuxer profile) -------------
console.log('vodVideoConfig — HEVC:');

test('MKV/MP4 hvcC config record (Main, profile 1) → hvc1.1.6.L<level>.B0 + description', () => {
  const c = vodVideoConfig(HEVC, 1, 123, HVCC);
  assert.equal(c.codec, 'hvc1.1.6.L123.B0', 'hvc1 fourcc (length-prefixed convention) + 8-bit Main + L123');
  assert.equal(c.description, HVCC);
  assert.equal(c.interlaced, false);
});

test('HEVC profile 2 (Main 10) → hvc1.2.4.* (the 10-bit string a Main10 HW decoder accepts)', () => {
  const c = vodVideoConfig(HEVC, 2, 150, HVCC);
  assert.equal(c.codec, 'hvc1.2.4.L150.B0');
});

test('HEVC Annex-B extradata (.ts VOD) → hev1.* (in-band form), NO description', () => {
  const annexb = new Uint8Array([0, 0, 0, 1, 0x40, 0x01]); // a non-config-record (start-code) extradata
  const c = vodVideoConfig(HEVC, 1, 120, annexb);
  assert.equal(c.codec, 'hev1.1.6.L120.B0');
  assert.equal(c.description, null);
});

// ---- vodVideoConfig: unmapped codec → software (the HEVC-on-no-HW + MPEG-2 path) -------------------------
console.log('vodVideoConfig — software fallback (unmapped codec):');

test('MPEG-2 (no WebCodecs string) → codec "" + no description → the software tier decodes it', () => {
  const c = vodVideoConfig(MPEG2, 4, 8, EMPTY);
  assert.equal(c.codec, '');
  assert.equal(c.description, null);
});

// ---- tier eligibility integration: the SAME gate live uses, fed the VOD config -------------------------
console.log('VOD tier eligibility (webCodecsEligible over the VOD config):');

test('H.264 avcC + prefer + hasVideoDecoder → ELIGIBLE for WebCodecs', () => {
  const c = vodVideoConfig(H264, 100, 42, AVCC);
  assert.equal(webCodecsEligible(true, true, c), true);
});

test('!preferWebCodecs → NOT eligible (host opted out) → software', () => {
  const c = vodVideoConfig(H264, 100, 42, AVCC);
  assert.equal(webCodecsEligible(false, true, c), false);
});

test('no VideoDecoder in the runtime → NOT eligible → software', () => {
  const c = vodVideoConfig(H264, 100, 42, AVCC);
  assert.equal(webCodecsEligible(true, false, c), false);
});

test('MPEG-2 (unmapped) → NOT eligible regardless of preference → software', () => {
  const c = vodVideoConfig(MPEG2, 4, 8, EMPTY);
  assert.equal(webCodecsEligible(true, true, c), false);
});

// ---- VOD-SEEK await-keyframe arming (wcKeyframeGate, the seek context) ---------------------------------
// On a VOD-WC seek, doVodSeek recreates the VideoDecoder (createWcDecoder ARMS awaitKeyframe=true). The PURE
// consequence — the only headless-testable part — is that, with the gate armed, every DELTA is HELD and only
// the first KEYFRAME after the seek is fed (so no reference-less delta hits the freshly-flushed decoder; the
// stream lands ON a keyframe). av_seek_frame(BACKWARD) guarantees the next demuxed AU is that IDR.
console.log('VOD-seek await-keyframe arming (wcKeyframeGate):');

test('post-seek: armed gate HOLDS deltas until the first IDR, then feeds it and clears', () => {
  let armed = true; // createWcDecoder set awaitKeyframe = true on the seek flush
  // The demuxer (post backward-seek) emits the keyframe first, but model a defensive delta-then-key just in
  // case: every delta is DROPPED while armed; the first key is FED and disarms.
  const deltaBeforeKey = wcKeyframeGate(armed, false);
  assert.equal(deltaBeforeKey.feed, false, 'a delta before the post-seek keyframe must NOT be fed');
  assert.equal(deltaBeforeKey.awaitingKeyframe, true, 'still holding');
  armed = deltaBeforeKey.awaitingKeyframe;

  const key = wcKeyframeGate(armed, true);
  assert.equal(key.feed, true, 'the post-seek IDR is fed');
  assert.equal(key.awaitingKeyframe, false, 'the hold clears on the IDR');
  armed = key.awaitingKeyframe;

  const nextDelta = wcKeyframeGate(armed, false);
  assert.equal(nextDelta.feed, true, 'steady state after the seek → every AU feeds');
});

test('post-seek with av_seek_frame(BACKWARD): the FIRST AU is the IDR → fed immediately, no frames lost', () => {
  // The realistic VOD-seek case: backward-seek lands ON a keyframe, so the very first AU clears the gate.
  const first = wcKeyframeGate(true, true);
  assert.equal(first.feed, true);
  assert.equal(first.awaitingKeyframe, false);
});

console.log(`\nvod_wc: ${passed} passed`);
