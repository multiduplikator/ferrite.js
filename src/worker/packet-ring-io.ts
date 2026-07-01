// SAB I/O for the packet ring — the PRODUCER (demux+video worker) and CONSUMER (audio worker) halves that
// move encoded AUs across the worker boundary. All index/framing math comes from src/packet-ring.ts (the
// single source of truth, unit-tested headless in tests/packet_ring.mjs); this module is only the Atomics +
// Uint8Array two-span wrap copies. TypeScript twin of the reference player's packet-ring IO.
//
// SPSC, lock-free: the producer owns PR_WRITE / PR_GEN / PR_DROPS / PR_EOF and ADDS to PR_FILL; the consumer
// owns PR_READ and SUBS from PR_FILL. The PR_FILL add/sub pair is the only RMW and Atomics.add/sub are
// atomic, so no CAS — exactly the audio ring's discipline (src/audio-ring.ts).

import {
  PKT_FLAG_KEY, PKT_FLAG_RASL, PKT_NAL_FLAGS_SHIFT, PR_CTRL_SLOTS, PR_DROPS, PR_EOF, PR_FILL, PR_GEN,
  PR_HEADER_BYTES, PR_READ, PR_READ_PTS_MS, PR_WRITE, PR_WRITE_PTS_MS,
  advance, canWrite, packHeader, prReadable, prSabBytes, recordBytes, unpackHeader, wrapSpans,
} from '../packet-ring';

/** Allocate a fresh packet-ring SAB sized for `capBytes` of data + zero the control region. Called on MAIN
 *  (so it can read depth for telemetry), then handed BY REFERENCE to the producer + consumer workers. */
export function allocPacketRing(capBytes: number): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(prSabBytes(capBytes));
  const ctrl = new Int32Array(sab, 0, PR_CTRL_SLOTS);
  for (let i = 0; i < PR_CTRL_SLOTS; i++) Atomics.store(ctrl, i, 0);
  return sab;
}

/** Producer half — the demux worker writes encoded AUs. Sole writer of PR_WRITE/PR_GEN/PR_DROPS/PR_EOF; adds
 *  to PR_FILL. */
export class PacketRingProducer {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private cap: number;
  private epoch = 0;
  private hdr = new Uint8Array(PR_HEADER_BYTES); // reused header scratch (no per-AU alloc)
  private hdrDv: DataView;

  constructor(sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, PR_CTRL_SLOTS);
    this.data = new Uint8Array(sab, PR_CTRL_SLOTS * 4);
    this.cap = this.data.length;
    this.hdrDv = new DataView(this.hdr.buffer);
  }

  /** New load epoch: bump PR_GEN (the consumer drops the stale segment), reset cursors + fill + EOF. */
  resetEpoch(): void {
    Atomics.store(this.ctrl, PR_WRITE, 0);
    Atomics.store(this.ctrl, PR_READ, 0);
    Atomics.store(this.ctrl, PR_FILL, 0);
    Atomics.store(this.ctrl, PR_EOF, 0);
    Atomics.store(this.ctrl, PR_WRITE_PTS_MS, 0);
    Atomics.store(this.ctrl, PR_READ_PTS_MS, 0);
    this.epoch = (this.epoch + 1) | 0;
    Atomics.store(this.ctrl, PR_GEN, this.epoch);
  }

  /** Mark end-of-segment: the consumer drains the remainder then parks (until the next epoch). */
  signalEof(): void { Atomics.store(this.ctrl, PR_EOF, 1); }

  /** Bytes currently buffered for the consumer (forward read-ahead). The demux paces on this the mpv way. */
  buffered(): number { return prReadable(Atomics.load(this.ctrl, PR_FILL)); }

  /** Forward-buffered DURATION (ms): pts span between the newest written and the newest read record. Clamped
   *  ≥0; 0 before any valid pts (reads as "hungry" so the demux fills the stream). */
  bufferedMs(): number {
    return Math.max(0, Atomics.load(this.ctrl, PR_WRITE_PTS_MS) - Atomics.load(this.ctrl, PR_READ_PTS_MS));
  }

  bumpDrops(): void { Atomics.add(this.ctrl, PR_DROPS, 1); }

  /** Would a record with `payloadLen` payload bytes fit without lapping the consumer? (The read-ahead gate
   *  uses this to BACKPRESSURE before writeAu would have to drop.) */
  canWriteAu(payloadLen: number): boolean { return canWrite(Atomics.load(this.ctrl, PR_FILL), this.cap, payloadLen); }

  /** Write one record (header + payload) into the ring. Returns false WITHOUT writing if it would lap the
   *  consumer — the caller decides drop-and-count (bumpDrops) vs back-pressure. `payload` is the engine AU
   *  bytes (e.g. auCopy output); copied into the ring (the per-AU copy cost). `ptsUs` is the engine PTS in µs
   *  as a BigInt (the NOPTS sentinel i64::MIN survives the header). `nalFlags` is the engine
   *  `demux_pkt_nal_flags` bitfield (b0 idr / b1 cra / b2 rasl / b3 irap; 0 for audio or non-HEVC) — seated
   *  past PKT_FLAG_KEY at ring bits 1..4 so the consumer can run the RASL-skip. */
  writeAu(ptsUs: bigint, isKey: boolean, nalFlags: number, payload: Uint8Array): boolean {
    const payloadLen = payload.length;
    const fill = Atomics.load(this.ctrl, PR_FILL);
    if (!canWrite(fill, this.cap, payloadLen)) return false;
    let write = Atomics.load(this.ctrl, PR_WRITE);
    packHeader(this.hdrDv, 0, ptsUs, payloadLen, (isKey ? PKT_FLAG_KEY : 0) | (nalFlags << PKT_NAL_FLAGS_SHIFT));
    write = this.putBytes(this.hdr, PR_HEADER_BYTES, write);
    write = this.putBytes(payload, payloadLen, write);
    // Publish: advance the cursor THEN the fill, so a consumer that sees the new fill always finds the bytes
    // already written (the audio-ring publish order).
    Atomics.store(this.ctrl, PR_WRITE, write);
    Atomics.add(this.ctrl, PR_FILL, recordBytes(payloadLen));
    // Publish the write-edge pts (ms) for the time-based read-ahead measure. Skip NOPTS (<0) so a missing pts
    // never corrupts the span (keep the last valid edge). The header carries the i64 sentinel for the
    // consumer; the PTS_MS slot is an i32 — only published for a real pts.
    if (ptsUs >= 0n) Atomics.store(this.ctrl, PR_WRITE_PTS_MS, Number(ptsUs / 1000n));
    return true;
  }

  /** Copy `len` bytes of `src` into the data ring at byte position `write`, splitting at the wrap. Returns
   *  the new position. */
  private putBytes(src: Uint8Array, len: number, write: number): number {
    const [first, second] = wrapSpans(write, len, this.cap);
    this.data.set(src.subarray(0, first), write);
    if (second > 0) this.data.set(src.subarray(first, len), 0);
    return advance(write, len, this.cap);
  }
}

/** Consumer half — the audio worker reads encoded AUs. Sole writer of PR_READ; subs from PR_FILL. */
export class PacketRingConsumer {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private cap: number;
  private epoch: number;
  private hdr = new Uint8Array(PR_HEADER_BYTES); // reused header scratch
  private hdrDv: DataView;

  constructor(sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, PR_CTRL_SLOTS);
    this.data = new Uint8Array(sab, PR_CTRL_SLOTS * 4);
    this.cap = this.data.length;
    this.epoch = Atomics.load(this.ctrl, PR_GEN);
    this.hdrDv = new DataView(this.hdr.buffer);
  }

  /** Adopt the producer's CURRENT load epoch WITHOUT dropping data. Call ONCE when this consumer starts
   *  draining a fresh load (its pump begins, after the decode engine is ready). The consumer object is built
   *  at worker `init` — BEFORE the demux bumps PR_GEN for the load — so its construction-time epoch is stale;
   *  without this, the first checkEpoch would see the bump and jump read→write to the LIVE EDGE, discarding the
   *  buffered aligned start the demux read ahead while this worker's engine loaded (which desyncs video from
   *  the audio master clock → the present PLL slews to catch up = the startup rush). The demux reset PR_READ to
   *  0 on the load, so reading resumes from the buffered start. Mirrors the reference player constructing its
   *  packet-ring consumer on the post-ready SetRings (so it reads the already-bumped epoch). */
  resyncEpoch(): void { this.epoch = Atomics.load(this.ctrl, PR_GEN); }

  /** Drop a stale producer epoch (a new load / VOD seek): jump read→write + zero our view of fill. Call
   *  before a read batch. Returns true if the epoch changed (the caller should flush its decoder). */
  checkEpoch(): boolean {
    const epoch = Atomics.load(this.ctrl, PR_GEN);
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      const write = Atomics.load(this.ctrl, PR_WRITE);
      Atomics.store(this.ctrl, PR_READ, write);
      Atomics.store(this.ctrl, PR_FILL, 0);
      // Adopt the producer's write-edge pts as our read pts so the buffered-ms span reads ~0 (drained) for
      // the new epoch instead of a stale huge span.
      Atomics.store(this.ctrl, PR_READ_PTS_MS, Atomics.load(this.ctrl, PR_WRITE_PTS_MS));
      return true;
    }
    return false;
  }

  eof(): boolean { return Atomics.load(this.ctrl, PR_EOF) !== 0; }

  /** Bytes available to read (the fill counter). 0 = no encoded packets to decode (the real cache-pause
   *  ENTER signal). */
  readable(): number { return prReadable(Atomics.load(this.ctrl, PR_FILL)); }

  /** Read one record. Returns `{ ptsUs (BigInt), isKey, isRasl, au }` or null if the ring has no complete
   *  record. `isRasl` is the HEVC RASL-leading-picture bit (video ring; always false on the audio ring) for
   *  the decode worker's RASL-skip latch. The payload is a fresh Uint8Array (copied out of the ring). */
  readAu(): { ptsUs: bigint; isKey: boolean; isRasl: boolean; au: Uint8Array } | null {
    const fill = Atomics.load(this.ctrl, PR_FILL);
    if (prReadable(fill) < PR_HEADER_BYTES) return null;
    let read = Atomics.load(this.ctrl, PR_READ);
    read = this.getBytes(this.hdr, PR_HEADER_BYTES, read);
    const { ptsUs, len, flags } = unpackHeader(this.hdrDv, 0);
    const au = new Uint8Array(len);
    read = this.getBytes(au, len, read);
    Atomics.store(this.ctrl, PR_READ, read);
    Atomics.sub(this.ctrl, PR_FILL, recordBytes(len));
    // Publish the read-edge pts (ms) for the demux's time-based read-ahead measure.
    if (ptsUs >= 0n) Atomics.store(this.ctrl, PR_READ_PTS_MS, Number(ptsUs / 1000n));
    return { ptsUs, isKey: (flags & PKT_FLAG_KEY) !== 0, isRasl: (flags & PKT_FLAG_RASL) !== 0, au };
  }

  /** Copy `len` bytes from the data ring at byte position `read` into `dst`, splitting at the wrap. Returns
   *  the new position. */
  private getBytes(dst: Uint8Array, len: number, read: number): number {
    const [first, second] = wrapSpans(read, len, this.cap);
    dst.set(this.data.subarray(read, read + first), 0);
    if (second > 0) dst.set(this.data.subarray(0, second), first);
    return advance(read, len, this.cap);
  }
}
