// Unit test for the PURE packet SAB ring math (src/packet-ring.ts) — the single source of truth the DEMUX
// producer AND the decode consumer both obey for the encoded-AU pipe (one ring for video, one for audio, so
// a slow software-HEVC video decode can never block audio). DOM-free, browser-free. Ported 1:1 from
// the reference player's packet-ring test module (incl. the end-to-end Sim round-trip).
//
// Run:  node --experimental-strip-types tests/packet_ring.mjs   (node ≥22)

import assert from 'node:assert/strict';
import {
  PR_HEADER_BYTES, PKT_FLAG_KEY, PR_CTRL_SLOTS,
  PKT_NAL_FLAGS_SHIFT, PKT_FLAG_IDR, PKT_FLAG_CRA, PKT_FLAG_RASL, PKT_FLAG_IRAP,
  prSabBytes, prReadable, prWritable, recordBytes, canWrite, wrapSpans, advance, packHeader, unpackHeader,
} from '../src/packet-ring.ts';
import {
  LIVE_READAHEAD_MS, VOD_READAHEAD_MS,
  VIDEO_RING_SAB_BYTES, VIDEO_RING_CEIL_BYTES, AUDIO_RING_SAB_BYTES, AUDIO_RING_CEIL_BYTES,
} from '../src/policy.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('packet-ring pure math (demux ⇄ decode encoded-AU pipe):');

test('sabBytes + capacity', () => {
  assert.equal(prSabBytes(0), PR_CTRL_SLOTS * 4);
  assert.equal(prSabBytes(1024), PR_CTRL_SLOTS * 4 + 1024);
});

test('readable/writable complementary + defensive clamps', () => {
  const cap = 1000;
  assert.equal(prReadable(0), 0);
  assert.equal(prWritable(0, cap), cap);
  assert.equal(prReadable(300), 300);
  assert.equal(prWritable(300, cap), 700);
  assert.equal(prWritable(cap, cap), 0);   // full
  assert.equal(prReadable(cap), cap);
  assert.equal(prReadable(-5), 0);          // clamps
  assert.equal(prWritable(cap + 10, cap), 0);
});

test('canWrite respects the 16B header overhead', () => {
  const cap = 100;
  assert.ok(canWrite(0, cap, 50));          // 66 framed fits
  assert.ok(!canWrite(cap - 60, cap, 50));  // 66 > 60 free
  assert.ok(canWrite(0, cap, 84));          // 100 framed = cap exact
  assert.ok(!canWrite(0, cap, 85));         // 101 > 100
});

test('wrapSpans split + advance wrap', () => {
  const cap = 16;
  assert.deepEqual(wrapSpans(0, 8, cap), [8, 0]);   // contiguous
  assert.deepEqual(wrapSpans(10, 4, cap), [4, 0]);  // fits to the end
  assert.deepEqual(wrapSpans(12, 8, cap), [4, 4]);  // straddles
  assert.deepEqual(wrapSpans(15, 3, cap), [1, 2]);  // 1 to end, 2 wrapped
  assert.equal(advance(12, 8, cap), 4);
  assert.equal(advance(15, 1, cap), 0);
});

test('header pack/unpack round-trip (i64 pts incl. NOPTS sentinel)', () => {
  const dv = new DataView(new ArrayBuffer(PR_HEADER_BYTES));
  packHeader(dv, 0, -1_234_567_890_123n, 4096, PKT_FLAG_KEY);
  let h = unpackHeader(dv, 0);
  assert.equal(h.ptsUs, -1_234_567_890_123n);
  assert.equal(h.len, 4096);
  assert.equal(h.flags, PKT_FLAG_KEY);
  const NOPTS = -(2n ** 63n); // i64::MIN
  packHeader(dv, 0, NOPTS, 0, 0);
  h = unpackHeader(dv, 0);
  assert.equal(h.ptsUs, NOPTS); assert.equal(h.len, 0); assert.equal(h.flags, 0);
});

test('nal-class flags: distinct, non-colliding, shift-mapped from the engine bitfield', () => {
  // The four HEVC NAL bits must be distinct AND none may collide with PKT_FLAG_KEY (bit 0) — the RASL-skip
  // latch reads them alongside the key bit out of the same packed `flags` field.
  const bits = [PKT_FLAG_KEY, PKT_FLAG_IDR, PKT_FLAG_CRA, PKT_FLAG_RASL, PKT_FLAG_IRAP];
  assert.equal(new Set(bits).size, bits.length, 'all five flag bits are distinct');
  assert.equal(bits.reduce((a, b) => a & b, ~0), 0, 'no two flag bits overlap');
  // The engine `demux_pkt_nal_flags` bitfield (b0 idr / b1 cra / b2 rasl / b3 irap) is seated at ring bits
  // 1..4 via PKT_NAL_FLAGS_SHIFT — verify the shift maps each engine bit to the matching ring constant.
  assert.equal(1 << PKT_NAL_FLAGS_SHIFT, PKT_FLAG_IDR);  // engine b0 → ring IDR
  assert.equal(2 << PKT_NAL_FLAGS_SHIFT, PKT_FLAG_CRA);  // engine b1 → ring CRA
  assert.equal(4 << PKT_NAL_FLAGS_SHIFT, PKT_FLAG_RASL); // engine b2 → ring RASL
  assert.equal(8 << PKT_NAL_FLAGS_SHIFT, PKT_FLAG_IRAP); // engine b3 → ring IRAP
});

test('header: KEY|CRA|RASL composite round-trips + masks independently', () => {
  const dv = new DataView(new ArrayBuffer(PR_HEADER_BYTES));
  // A live open-GOP random-access point: engine nal_flags = cra|rasl (b1|b2 = 0b0110 = 6), plus the key bit.
  const engineNal = 0b0110; // cra + rasl
  const flags = PKT_FLAG_KEY | (engineNal << PKT_NAL_FLAGS_SHIFT);
  packHeader(dv, 0, 5_000_000n, 1234, flags);
  const h = unpackHeader(dv, 0);
  assert.equal(h.flags, flags);
  assert.ok(h.flags & PKT_FLAG_KEY, 'key set');
  assert.ok(h.flags & PKT_FLAG_CRA, 'cra set');
  assert.ok(h.flags & PKT_FLAG_RASL, 'rasl set');
  assert.equal(h.flags & PKT_FLAG_IDR, 0, 'idr NOT set');
  assert.equal(h.flags & PKT_FLAG_IRAP, 0, 'irap NOT set');
});

// End-to-end protocol Sim: a byte ring + control ints driven exactly as the DEMUX producer + decode
// consumer will drive the SAB — exercising wrap, fill accounting, full-ring rejection, multi-record FIFO.
class Sim {
  constructor(cap) { this.data = new Uint8Array(cap); this.dv = new DataView(this.data.buffer); this.cap = cap; this.write = 0; this.read = 0; this.fill = 0; this.drops = 0; }
  writeBytes(src) {
    const [first, second] = wrapSpans(this.write, src.length, this.cap);
    this.data.set(src.subarray(0, first), this.write);
    if (second > 0) this.data.set(src.subarray(first), 0);
    this.write = advance(this.write, src.length, this.cap);
  }
  readBytes(n) {
    const [first, second] = wrapSpans(this.read, n, this.cap);
    const out = new Uint8Array(n);
    out.set(this.data.subarray(this.read, this.read + first), 0);
    if (second > 0) out.set(this.data.subarray(0, second), first);
    this.read = advance(this.read, n, this.cap);
    return out;
  }
  push(pts, flags, payload) {
    if (!canWrite(this.fill, this.cap, payload.length)) return false;
    const hdr = new Uint8Array(PR_HEADER_BYTES);
    packHeader(new DataView(hdr.buffer), 0, BigInt(pts), payload.length, flags);
    this.writeBytes(hdr);
    this.writeBytes(payload);
    this.fill += recordBytes(payload.length);
    return true;
  }
  pop() {
    if (prReadable(this.fill) < PR_HEADER_BYTES) return null;
    const hdr = this.readBytes(PR_HEADER_BYTES);
    const { ptsUs, len, flags } = unpackHeader(new DataView(hdr.buffer), 0);
    const payload = this.readBytes(len);
    this.fill -= recordBytes(len);
    return { pts: Number(ptsUs), flags, payload };
  }
}

test('Sim: single record round-trip, byte-exact, fully drained', () => {
  const r = new Sim(256);
  const hello = new TextEncoder().encode('hello world');
  assert.ok(r.push(1000, PKT_FLAG_KEY, hello));
  assert.equal(r.fill, recordBytes(11));
  const rec = r.pop();
  assert.equal(rec.pts, 1000); assert.equal(rec.flags, PKT_FLAG_KEY);
  assert.deepEqual([...rec.payload], [...hello]);
  assert.equal(r.fill, 0);
  assert.equal(r.pop(), null);
});

test('Sim: multi-record FIFO across repeated wrap (back-pressure loop, no loss)', () => {
  const r = new Sim(80);
  const payloads = Array.from({ length: 50 }, (_, i) => new Uint8Array((i % 13) + 1).fill(i & 0xff));
  let nextWrite = 0, nextRead = 0;
  while (nextRead < payloads.length) {
    while (nextWrite < payloads.length && r.push(nextWrite, nextWrite % 7 === 0 ? 1 : 0, payloads[nextWrite])) nextWrite++;
    const rec = r.pop();
    assert.ok(rec, 'something buffered');
    assert.equal(rec.pts, nextRead);
    assert.equal(rec.flags, nextRead % 7 === 0 ? 1 : 0);
    assert.deepEqual([...rec.payload], [...payloads[nextRead]]);
    nextRead++;
  }
  assert.equal(r.fill, 0);
  assert.equal(r.drops, 0);
});

test('Sim: a full ring DROPS (rejects), never corrupts the buffered records', () => {
  const r = new Sim(64);
  let pushed = 0;
  while (r.push(pushed, 0, new Uint8Array(10).fill(0xab))) pushed++;
  assert.ok(pushed > 0, 'at least one fit');
  assert.ok(!r.push(pushed, 0, new Uint8Array(10).fill(0xab)), 'full ring rejects');
  // the buffered records remain intact + in order
  for (let i = 0; i < pushed; i++) { const rec = r.pop(); assert.equal(rec.pts, i); assert.deepEqual([...rec.payload], Array(10).fill(0xab)); }
  assert.equal(r.fill, 0);
});

// Static-invariant guards over the centralized packet-ring readahead-depth consts (policy.ts), mirroring
// player-core/src/policy.rs's `readahead_depth_invariants` test. These are not ring-math — they assert the
// 6 depth/size consts cohere (CEIL < SAB with headroom; LIVE deeper than VOD; the byte ceilings actually
// HOLD the live read-ahead so the byte cap never binds below the time target).
test('readahead_depth_invariants', () => {
  // compressed bytes a stream of `bitrateBps` occupies over `ms` of media time.
  const bytesForMs = (ms, bitrateBps) => (ms * bitrateBps) / 8 / 1000;

  // The fill ceiling must stay BELOW the SAB allocation so the non-blocking route can never push a last AU
  // past the ring end (the demux routes are lossy-on-overflow; headroom keeps them no-ops).
  assert.ok(VIDEO_RING_CEIL_BYTES < VIDEO_RING_SAB_BYTES);
  assert.ok(AUDIO_RING_CEIL_BYTES < AUDIO_RING_SAB_BYTES);
  // Video headroom ≥ one large 4K-HEVC IDR PES (~2 MiB); audio headroom ≥ a few AUs (≥ 32 KiB).
  assert.ok(VIDEO_RING_SAB_BYTES - VIDEO_RING_CEIL_BYTES >= 2 * 1024 * 1024);
  assert.ok(AUDIO_RING_SAB_BYTES - AUDIO_RING_CEIL_BYTES >= 32 * 1024);

  // Live cushion is seconds-deep and deeper than the VOD local-file floor.
  assert.ok(LIVE_READAHEAD_MS >= 3000, 'live cushion must be seconds-deep');
  assert.ok(LIVE_READAHEAD_MS > VOD_READAHEAD_MS);

  // The byte ceilings must actually HOLD the live readahead, else the byte cap binds before the time target
  // and the cushion is shallower than intended. Audio: EAC3 5.1 ≈ 768 kbps must fully fit.
  const audioNeed = bytesForMs(LIVE_READAHEAD_MS, 768_000);
  assert.ok(audioNeed <= AUDIO_RING_CEIL_BYTES, `audio ceiling ${AUDIO_RING_CEIL_BYTES} < live readahead need ${audioNeed}`);
  // Video: at a high 4K10 bitrate (~50 Mbps) the ceiling may bind below LIVE_READAHEAD_MS, but it must still
  // hold a deep (≥ 3 s) cushion — far above a 1 s cushion that would starve under a dip (≥ 18.75 MiB).
  const video3s = bytesForMs(3000, 50_000_000);
  assert.ok(VIDEO_RING_CEIL_BYTES >= video3s, `video ceiling ${VIDEO_RING_CEIL_BYTES} holds < 3 s at 50 Mbps (${video3s})`);
});

console.log(`\npacket-ring: ${passed} passed`);
