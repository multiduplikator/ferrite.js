// Packet SAB ring — the lock-free single-producer/single-consumer pipe that carries ENCODED access units
// (AUs) from the DEMUX worker to a decode worker (one instance for audio, one for video). The whole point
// of the split: with audio and video on separate rings + separate worker threads, a slow software-HEVC
// video decode can never block audio decode. TypeScript twin of the reference player's packet ring.
//
// PURE index/framing math — headless-testable — and the single source of truth BOTH the producer (DEMUX)
// and the consumer (decode worker) obey, so they can never drift on layout, wrap, or the record header.
// Mirrors the audio-ring design (plain Atomics, no CAS, two-span wrap copy).
//
// ## Layout (one SharedArrayBuffer)
// `[ control: PR_CTRL_SLOTS × i32 (Atomics) ][ data: cap bytes (the byte ring) ]`
// The data region is a byte ring of length-framed records. Per record:
// `header [ ptsUs:i64 (8B) | len:u32 (4B) | flags:u32 (4B) ] = 16 B` then `len` payload bytes. A record
// (header and/or payload) may straddle the wrap; copies split into up to two contiguous spans (wrapSpans).
// `flags` bit 0 = keyframe (PKT_FLAG_KEY); bits 1..4 = the HEVC NAL class (PKT_FLAG_IDR/CRA/RASL/IRAP,
// seated from the engine bitfield via PKT_NAL_FLAGS_SHIFT — they drive the universal RASL-skip latch).
//
// ## Cursors (overflow-free)
// PR_WRITE/PR_READ are byte POSITIONS in [0, cap) (NOT monotonic — no i64-overflow class). A separate
// PR_FILL byte counter is updated by BOTH sides via Atomics add (producer, on write) / sub (consumer, on
// read); readable = fill, writable = cap − fill. SPSC: only DEMUX advances PR_WRITE/PR_FILL(+), only the
// consumer advances PR_READ/PR_FILL(−) — so plain Atomics suffice (the add/sub on PR_FILL is the one RMW).

/** Record header size in bytes: `ptsUs:i64 | len:u32 | flags:u32`. */
export const PR_HEADER_BYTES = 16;

/** `flags` bit 0 — this AU begins a keyframe / GOP (decoder-safe random-access point). Used by the video
 *  ring's whole-GOP drop policy (drop oldest up to, not including, the next keyframe). */
export const PKT_FLAG_KEY = 1;

// HEVC NAL-class flags — the engine `demux_pkt_nal_flags` bitfield (b0 idr / b1 cra / b2 rasl / b3 irap; 0 for
// audio or non-HEVC) seated past PKT_FLAG_KEY at ring bits 1..4 via PKT_NAL_FLAGS_SHIFT. They drive the
// universal RASL-skip latch: drop a RASL leading picture after a random-access IRAP — it references the pre-
// IRAP GOP (undecodable from the random-access point; VideoToolbox throws BadDataErr, Chrome/SW discard it
// internally). The four bits are distinct and none collides with PKT_FLAG_KEY (bit 0) — the latch reads them
// alongside the key bit out of the same packed `flags` field.
/** Shift applied to the engine `demux_pkt_nal_flags` bitfield so b0 lands at ring bit 1 (past PKT_FLAG_KEY). */
export const PKT_NAL_FLAGS_SHIFT = 1;
export const PKT_FLAG_IDR = 1 << 1;  // HEVC IDR (NAL 19/20) — closed-GOP, no associated RASL
export const PKT_FLAG_CRA = 1 << 2;  // HEVC CRA (NAL 21) — open-GOP random-access, may carry RASL/RADL
export const PKT_FLAG_RASL = 1 << 3; // HEVC RASL leading picture (NAL 8/9) — undecodable from the IRAP
export const PKT_FLAG_IRAP = 1 << 4; // HEVC IRAP (NAL 16..23) — IDR/BLA/CRA + reserved VCL

// Control-region slot indices (Int32 atomics).
export const PR_WRITE = 0;        // DEMUX: write byte position in [0,cap)
export const PR_READ = 1;         // consumer: read byte position in [0,cap)
export const PR_FILL = 2;         // both (add/sub): bytes buffered. readable=fill, writable=cap−fill
export const PR_GEN = 3;          // DEMUX: load epoch — consumer jumps read→write + zeroes fill on a stale epoch
export const PR_DROPS = 4;        // DEMUX: records dropped (full-ring / whole-GOP drop) — telemetry
export const PR_EOF = 5;          // DEMUX: end-of-segment — consumer drains the remainder then parks
export const PR_WAKE = 6;         // both: Atomics.wait/notify futex word for the demux re-arm (hysteresis)
// TIME-based read-ahead (mpv demuxer-readahead-secs): the demux paces each stream to a DURATION target, not
// a byte count, so audio and video stay balanced at the same file position across any bitrate. buffered_ms =
// writePts − readPts (the forward-buffered DURATION).
export const PR_WRITE_PTS_MS = 7; // DEMUX: pts (ms) of the most recently written record
export const PR_READ_PTS_MS = 8;  // consumer: pts (ms) of the most recently read record
export const PR_CTRL_SLOTS = 9;

/** Total bytes for the SAB: control region (i32) + the `cap`-byte data ring. */
export function prSabBytes(capBytes: number): number {
  return PR_CTRL_SLOTS * 4 + capBytes;
}

/** Bytes available to READ (consumer): the fill counter, clamped non-negative. */
export function prReadable(fill: number): number {
  return Math.max(0, fill);
}

/** Free bytes the producer may write: `cap − fill`, clamped non-negative. */
export function prWritable(fill: number, cap: number): number {
  return Math.max(0, cap - prReadable(fill));
}

/** Total framed size of a record with `payloadLen` payload bytes (header + payload). */
export function recordBytes(payloadLen: number): number {
  return PR_HEADER_BYTES + payloadLen;
}

/** Can a record with `payloadLen` payload bytes be written without lapping the consumer? */
export function canWrite(fill: number, cap: number, payloadLen: number): boolean {
  return recordBytes(payloadLen) <= prWritable(fill, cap);
}

/** Split a `len`-byte run starting at byte position `pos` in a `cap`-byte ring into up to two contiguous
 *  spans `[first, second]` where `first` runs from `pos` to the end (or `len` if it fits) and `second` wraps
 *  to position 0. `first + second === len`. `pos` must be in `[0, cap)`. */
export function wrapSpans(pos: number, len: number, cap: number): [number, number] {
  const first = Math.min(len, cap - pos);
  return [first, len - first];
}

/** Advance a byte position by `n` in a `cap`-byte ring (wraps). */
export function advance(pos: number, n: number, cap: number): number {
  return (pos + n) % cap;
}

/** Pack a record header into a 16-byte DataView (little-endian), matching the consumer's DataView reads.
 *  `ptsUs` is i64 (BigInt) so the AV_NOPTS sentinel (i64::MIN) survives. */
export function packHeader(dv: DataView, off: number, ptsUs: bigint, len: number, flags: number): void {
  dv.setBigInt64(off, ptsUs, true);
  dv.setUint32(off + 8, len, true);
  dv.setUint32(off + 12, flags, true);
}

/** Unpack a record header from a 16-byte DataView → `{ ptsUs, len, flags }`. */
export function unpackHeader(dv: DataView, off: number): { ptsUs: bigint; len: number; flags: number } {
  return {
    ptsUs: dv.getBigInt64(off, true),
    len: dv.getUint32(off + 8, true),
    flags: dv.getUint32(off + 12, true),
  };
}
