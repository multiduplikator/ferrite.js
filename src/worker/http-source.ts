// HttpSource — the VOD/Series single-forward-connection range transport (Asyncify).
//
// Replaces the rejected sync-XHR-per-window model (worker.ts makeRangeReader: one HTTP connection per
// 4 MiB read = the upstream-proxy connection churn that eventually fails a Range). This is the VLC /
// libav.js shape: ONE long-lived `fetch` + `ReadableStream.getReader()` read FORWARD
// incrementally into a small sliding window, reopening (abort + new `Range: bytes=pos-`) ONLY on a seek
// out of the window. A forward decode scan = exactly ONE upstream session; a committed seek = one reopen.
//
// It backs the engine's async range hook: Module.__ferriteRangeReadAsync(handle, pos, len) → Promise of
// the bytes at [pos, pos+len) (≤ len; a SHORT array at EOF, EMPTY past EOF, null on a hard error). The C
// bridge (ferrite_js_range_read, EM_ASYNC_JS) awaits this and writes the bytes to a FRESH HEAPU8 AFTER the
// await — so this module deals ONLY in plain JS Uint8Arrays (no wasm heap; the growable-memory discipline
// lives on the C side). The engine's AVIO reads strictly forward in 256 KiB chunks during decode, seeking
// (pure arithmetic in ferrite_io_seek_range) only for find_stream_info probes and av_seek_frame.
//
// Memory: the sliding window is a SMALL rolling buffer (a back-margin for AVIO re-reads + the current
// lookahead), compacted as it's consumed and capped at `windowBytes` (iOS-aware 8 MiB / desktop 16 MiB —
// not hundreds of MiB), so steady decode holds ~one chunk, well inside the iPad <300 MB budget. Two caches
// cut reopen churn during open/seek: a PERSISTENT HEAD cache (the ftyp/moov/EBML header bytes, re-read by
// find_stream_info after every seek) and a bounded metadata LRU (the small scattered moov-sample-table /
// matroska-cue reads). Teardown: abort() cancels the in-flight fetch synchronously.

export interface HttpSourceOptions {
  /** Injectable fetch (tests pass a shim; defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Sliding-window ceiling in bytes (iOS-aware; default 16 MiB). The buffer is compacted to stay under it. */
  windowBytes?: number;
  /** Persistent header cache size (ftyp/moov/EBML); default 2 MiB. */
  headCacheBytes?: number;
  /** READ-STALL deadline in ms: abort+resume a forward read that delivers NO bytes for this long (a
   *  stalled-but-connected origin). Resets on every received chunk — a slow-but-flowing VOD never trips it.
   *  Default 12 s (the spec's VOD_READ_TIMEOUT). 0 disables (legacy no-timeout behaviour). */
  readStallTimeoutMs?: number;
  /** CONNECT (header-arrival) deadline in ms: abort the fetch if response headers don't arrive within
   *  this long — an origin that accepts the connection then never sends headers (the connect-phase analog
   *  of `readStallTimeoutMs`; E-6). Armed ONLY during the header-await and cleared the instant the response
   *  resolves — the per-chunk read-stall timer owns the body read thereafter (no overlap). Covers the
   *  initial open AND the read-stall resume reopens (it lives in the one shared fetch). Default 8 s
   *  (mirrors the live CONNECT_TIMEOUT_MS). 0 disables. */
  connectTimeoutMs?: number;
  /** Optional breadcrumb logger (worker `log`). */
  log?: (msg: string) => void;
}

const DEFAULT_WINDOW_BYTES = 16 * 1024 * 1024;
const DEFAULT_HEAD_CACHE_BYTES = 2 * 1024 * 1024;
// READ-STALL breaker (the Asyncify deadlock guard). A forward read that gets a 206/200 then NO bytes would
// suspend the demux thread forever (no throw, no EOF — `reader.read()` just never resolves). We bound the
// no-bytes wait, abort the dead fetch (so Asyncify RESUMES), and resume the Range from the current offset.
const DEFAULT_READ_STALL_MS = 12_000;       // matches the spec's VOD_READ_TIMEOUT assumption
// CONNECT-TIMEOUT breaker (E-6, the connect-phase analog of the read-stall breaker). An origin that
// accepts the connection then NEVER sends response headers would suspend the demux open forever (the
// `await fetch()` never resolves — no throw, no headers). We bound the header-await, abort the dead fetch
// (so the suspended Asyncify open/resume RESUMES), and let it propagate to a clean VOD fatal. The
// connect-phase twin of the live SourcePort connect-timeout (policy.ts CONNECT_TIMEOUT_MS).
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;   // = the live CONNECT_TIMEOUT_MS (policy.ts:185)
const MAX_READ_STALL_RESUMES = 3;           // bounded resumes WITHOUT progress → then a hard error (fatal). A
                                            // received chunk resets the count (it's a read-stall, not a budget).
const GAP_REOPEN_BYTES = 2 * 1024 * 1024;   // forward seek-gap larger than this → reopen (cheaper than skip-read)
const BACK_MARGIN_BYTES = 256 * 1024;       // keep this much consumed prefix for AVIO short-read re-reads
const META_CHUNK = 256 * 1024;              // metadata-LRU granularity (covers the engine's 256 KiB AVIO reads)
const META_LRU_MAX = 96;                    // ~24 MiB ceiling of cached scattered reads

/** Internal sentinel: a forward read delivered no bytes within the read-stall deadline (the fetch was
 *  aborted). Caught in `pumpChunk` → resume-from-offset (bounded) → escalate to a hard error if exhausted. */
class ReadStallError extends Error {
  constructor() { super('VOD read stall'); this.name = 'ReadStallError'; }
}

interface SourceStats {
  connections: number;  // fetch opens (forward scan = 1; +1 per committed seek reopen)
  reopens: number;      // abort + reopen events (subset of connections, excludes the initial open)
  readStalls: number;   // read-stall trips (no bytes for the deadline → abort + resume-from-offset)
  windowServes: number; // reads satisfied from the live forward window
  headHits: number;     // reads satisfied from the persistent header cache
  lruHits: number;      // reads satisfied from the metadata LRU
  bytesFetched: number; // total bytes pulled from the network
  degraded: boolean;    // server ignored Range (HTTP 200 whole-stream)
  // ---- VOD fetch-progress telemetry (the long-press overlay's transport row; tier-agnostic triage) ----
  total: number;        // total file size in bytes (0 = unknown / sizeless degraded 200)
  position: number;     // byte offset of the LAST served range read (≈ the decode read head → a progress %)
  windowBytes: number;  // current live sliding-window depth in bytes (the rolling buffer; bounds memory)
}

export class HttpSource {
  private url: string;
  private fetchImpl: typeof fetch;
  private windowBytes: number;
  private headCacheBytes: number;
  private log: (msg: string) => void;

  private _total = 0;        // file size (0 = unknown until open / degraded with no Content-Length)
  private _degraded = false; // 200-fallback: server ignored Range → single forward stream from 0

  // The live forward connection.
  private ctl: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private eofStream = false;  // the current connection's body is exhausted

  // Sliding window: `buf[0..bufLen)` holds contiguous bytes starting at absolute offset `windowStart`.
  // The next byte the connection will deliver is at `windowStart + bufLen` (= connPos).
  private buf: Uint8Array = new Uint8Array(0);
  private bufLen = 0;
  private windowStart = 0;

  // Persistent header cache (primed from the first forward pump at offset 0).
  private headBuf: Uint8Array | null = null;
  private headLen = 0;

  // Metadata LRU: META_CHUNK-aligned scattered reads (insertion-order Map = LRU).
  private lru = new Map<number, Uint8Array>();

  private aborted = false;
  private _lastReadPos = 0; // byte offset of the last served read() — the decode read head (fetch-progress %)
  // READ-STALL state. `readStallMs` = the no-bytes deadline; `stallResumes` = consecutive resumes WITHOUT
  // progress (reset on any received chunk); `_stalledOut` latches when the bounded resumes are exhausted OR
  // a connect-timeout fires (E-6) so the worker can classify the resulting hard read failure as
  // upstream-silence (network), not decode. `connectMs` = the header-arrival deadline (the connect-phase twin).
  private readStallMs: number;
  private connectMs: number;
  private stallResumes = 0;
  private _stalledOut = false;
  private stats: SourceStats = {
    connections: 0, reopens: 0, readStalls: 0, windowServes: 0, headHits: 0, lruHits: 0, bytesFetched: 0, degraded: false,
    total: 0, position: 0, windowBytes: 0,
  };

  constructor(url: string, opts: HttpSourceOptions = {}) {
    this.url = url;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.windowBytes = Math.max(1 << 20, opts.windowBytes ?? DEFAULT_WINDOW_BYTES);
    this.headCacheBytes = Math.max(0, opts.headCacheBytes ?? DEFAULT_HEAD_CACHE_BYTES);
    this.readStallMs = Math.max(0, opts.readStallTimeoutMs ?? DEFAULT_READ_STALL_MS);
    this.connectMs = Math.max(0, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    this.log = opts.log ?? (() => {});
  }

  get total(): number { return this._total; }
  get degraded(): boolean { return this._degraded; }
  /** True once a read failed because the bounded read-stall resumes were exhausted OR a connect-timeout
   *  fired (E-6) — the origin went silent (at the read phase or the connect/header phase) and never
   *  recovered. The worker reads this on a hard demux-step error to classify it as upstream silence (a
   *  `network` fatal, mirroring the live silence watchdog) rather than a decode fault. */
  get stalledOut(): boolean { return this._stalledOut; }
  getStats(): Readonly<SourceStats> {
    // Snapshot the live transport state alongside the cumulative counters (fetch-progress overlay row).
    return { ...this.stats, degraded: this._degraded, total: this._total, position: this._lastReadPos, windowBytes: this.bufLen };
  }

  private get connPos(): number { return this.windowStart + this.bufLen; }

  /** Open the first connection (Range: bytes=0-), learn the total size (Content-Range / 200 Content-Length),
   *  and leave the reader live at offset 0 for the first find_stream_info reads. Returns the total (0 = unknown).
   *  Throws on a hard HTTP/network error (the caller fails the load fatally). */
  async open(): Promise<number> {
    await this.openConnection(0, /*first=*/true);
    return this._total;
  }

  /** Open (or reopen) the forward connection at absolute byte `pos`. On the first open, parse the total +
   *  detect the 200-fallback. In degraded mode the server ignores Range and always streams from 0, so the
   *  connection actually starts at 0 and the caller skip-pumps to `pos`. */
  private async openConnection(pos: number, first = false): Promise<void> {
    if (this.aborted) throw new Error('HttpSource aborted');
    // Tear down any previous connection synchronously (prompt upstream FIN — kills the old session so the
    // origin sees exactly one live request, the connection-churn fix).
    this.closeConnection();

    const startAt = this._degraded ? 0 : pos; // degraded: server only serves from 0
    const res = await this.fetchRange(startAt);

    if (first) {
      // Size from Content-Range "bytes start-end/total" (206); fall back to a 200's Content-Length.
      if (res.status === 206) {
        const cr = res.headers.get('Content-Range');
        const mm = cr && cr.match(/\/\s*(\d+)\s*$/);
        if (mm) this._total = parseInt(mm[1], 10);
      } else {
        // 200: server ignored Range → whole-stream forward-only. One-time log; seeks reopen-from-0 + skip.
        this._degraded = true;
        this.stats.degraded = true;
        const cl = res.headers.get('Content-Length');
        if (cl) this._total = parseInt(cl, 10);
        this.log('VOD: server ignored Range (HTTP 200) — single forward stream, seeks degraded');
      }
      if (!Number.isFinite(this._total) || this._total < 0) this._total = 0;
    } else if (res.status === 200 && !this._degraded) {
      // A reopen that came back 200 (server flipped behaviour) — treat as degraded from here on.
      this._degraded = true;
      this.stats.degraded = true;
      this.log('VOD: reopen returned HTTP 200 — degraded forward-only from now');
    }

    if (!res.body) throw new Error('VOD response has no body');
    this.reader = res.body.getReader();
    this.eofStream = false;
    const begin = this._degraded ? 0 : startAt;
    this.windowStart = begin;
    this.bufLen = 0;
    this.buf = this.buf.length ? this.buf : new Uint8Array(1 << 20); // reuse capacity across reopens
    this.stats.connections++;
    if (!first) this.stats.reopens++;
  }

  private closeConnection(): void {
    const r = this.reader, c = this.ctl;
    this.reader = null; this.ctl = null;
    // cancel() RETURNS A PROMISE that REJECTS if the stream was already errored (e.g. the read-stall abort
    // errored the body just before this) — swallow it so it never surfaces as an unhandled rejection.
    if (r) { try { const p = r.cancel(); if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ }); } catch { /* ignore */ } }
    if (c) { try { c.abort(); } catch { /* ignore */ } }
  }

  /** Issue the forward `Range: bytes=startAt-` fetch under a fresh AbortController, bounded by a
   *  connect-timeout (E-6, header-arrival only), and validate the status (206/200 only). Shared by the
   *  initial open, a seek reopen, and a read-stall resume — the ONE fetch primitive, so BOTH the open and
   *  every resume reopen inherit the connect-timeout (no parallel transport). */
  private async fetchRange(startAt: number): Promise<Response> {
    this.ctl = new AbortController();
    // CONNECT-TIMEOUT (E-6): bound the header-await ONLY. If the response doesn't resolve within
    // `connectMs`, abort the in-flight fetch (so a suspended Asyncify open/resume RESUMES — not merely
    // abandoned) and reject. Cleared the instant the response resolves: the body read is then owned by the
    // per-chunk read-stall timer (`readWithStallTimeout`), so there is no overlap and no double-arm.
    let connectTimedOut = false;
    let tid: ReturnType<typeof setTimeout> | undefined;
    if (this.connectMs > 0) {
      tid = setTimeout(() => {
        connectTimedOut = true;
        try { this.ctl?.abort(); } catch { /* ignore */ } // abort the dead connect → the await below rejects
      }, this.connectMs);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${startAt}-` }, signal: this.ctl.signal });
    } catch (err) {
      // ABORTED-FIRST guard: a teardown abort during connect is NOT a connect-stall — return the abort
      // contract, not a connect-timeout misfire (checked before connectTimedOut so teardown always wins).
      if (this.aborted) throw new Error('HttpSource aborted');
      if (connectTimedOut) {
        // Headers never arrived → upstream silent at the connect phase. Latch `_stalledOut` so the worker
        // classifies the resulting hard failure as upstream-silence (network), mirroring read-stall
        // exhaustion — NOT a decode fault. (On the initial open the worker's open-catch fails network directly.)
        this._stalledOut = true;
        throw new Error(`VOD connect timeout: no response headers in ${this.connectMs}ms @${startAt}`);
      }
      throw new Error('VOD fetch failed: ' + (err as Error)?.message);
    } finally {
      if (tid !== undefined) clearTimeout(tid); // response resolved (or threw) → connect phase over; hand off to the read-stall timer
    }
    if (res.status !== 206 && res.status !== 200) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new Error('VOD HTTP ' + res.status);
    }
    return res;
  }

  /** Race ONE `reader.read()` against the read-stall deadline. On the deadline: ABORT the in-flight fetch
   *  (so the suspended Asyncify read RESUMES — not merely abandoned) and reject with `ReadStallError`. The
   *  timer is scoped to this single read and cleared in `finally`, so it can NEVER outlive the await to
   *  misfire on a later seek/teardown (reads are serialized — one suspending AVIO read at a time). */
  private readWithStallTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    const readP = reader.read();
    if (this.readStallMs <= 0) return readP; // disabled → legacy no-timeout behaviour
    readP.catch(() => { /* the stall path aborts the fetch → this rejects (AbortError) AFTER the race; swallow */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject FIRST so the race deterministically settles on the stall (aborting the fetch also rejects
        // `readP` with AbortError; rejecting before the abort guarantees ReadStallError wins, not AbortError).
        reject(new ReadStallError());
        try { this.ctl?.abort(); } catch { /* ignore */ } // then abort the dead fetch → Asyncify resumes
      }, this.readStallMs);
    });
    return Promise.race([readP, stall]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  /** Read-stall recovery: the buffered window `[windowStart, connPos)` is still valid, so reopen a fresh
   *  forward fetch at `connPos` and KEEP the window — the new 206 body delivers from there, appended
   *  contiguously (the natural Range resume; VOD is Range-based, so resume is a reopen, not a restart).
   *  Reuses `fetchRange` (the same open machinery as a seek reopen — no VOD-only recovery path). A degraded
   *  (Range-ignored, HTTP-200) origin can't resume mid-file → fall back to the normal reopen-from-0 + the
   *  read-loop's skip-pump re-covers (rare; correctness over churn). */
  private async resumeAfterStall(): Promise<void> {
    if (this.aborted) return;
    const resumeAt = this.connPos;
    if (this._degraded) { await this.openConnection(resumeAt); return; } // openConnection resets+skip-pumps from 0
    this.closeConnection();
    const res = await this.fetchRange(resumeAt);
    if (this.aborted) { try { await res.body?.cancel(); } catch { /* ignore */ } return; }
    if (res.status === 200) {
      // Origin flipped to whole-stream on the resume → a 200 streams from 0, so the kept window can't
      // continue. Mark degraded and reopen-from-0 + skip (openConnection resets the window in degraded mode).
      this._degraded = true; this.stats.degraded = true;
      this.log('VOD resume returned HTTP 200 — degraded forward-only from now');
      await this.openConnection(resumeAt);
      return;
    }
    if (!res.body) throw new Error('VOD resume response has no body');
    this.reader = res.body.getReader();
    this.eofStream = false;
    // PRESERVE windowStart/bufLen: the new 206 body delivers from resumeAt = connPos, appended contiguously.
    this.stats.connections++;
    this.stats.reopens++;
  }

  /** Pull ONE chunk from the live reader, append it to the window (advancing connPos), prime the head
   *  cache while near offset 0. Returns false at end-of-stream. */
  private async pumpChunk(): Promise<boolean> {
    if (!this.reader || this.eofStream) return false;
    let r: ReadableStreamReadResult<Uint8Array>;
    try { r = await this.readWithStallTimeout(this.reader); }
    catch (err) {
      if (this.aborted) return false; // teardown/seek abort — NOT a stall (checked first so a raced trip can't leak)
      if (err instanceof ReadStallError) {
        // No bytes for the deadline → the fetch was aborted. Resume the Range from the current offset
        // (bounded). A received chunk resets `stallResumes` (read-stall, not a total-download budget); only
        // CONSECUTIVE no-progress resumes exhaust → a hard read failure the worker classifies as silence.
        this.stats.readStalls++;
        if (++this.stallResumes > MAX_READ_STALL_RESUMES) {
          this._stalledOut = true;
          throw new Error(`VOD read stall: upstream silent after ${MAX_READ_STALL_RESUMES} resumes @${this.connPos}`);
        }
        this.log(`VOD read stall @${this.connPos} (no bytes ${this.readStallMs}ms) → resume Range from offset (${this.stallResumes}/${MAX_READ_STALL_RESUMES})`);
        try { await this.resumeAfterStall(); }
        catch (e) { this._stalledOut = true; throw e; } // a refused/failed resume = a hard upstream failure → fatal network
        if (this.aborted) return false;
        return true; // pump again on the fresh connection
      }
      throw new Error('VOD read failed: ' + (err as Error)?.message);
    }
    if (this.aborted) return false;
    if (r.done) { this.eofStream = true; return false; }
    const chunk = r.value;
    if (!chunk || chunk.length === 0) return true; // empty chunk — keep reading
    this.stallResumes = 0; // bytes flowed → reset the read-stall resume budget (it's per no-progress stall)
    this.stats.bytesFetched += chunk.length;
    this.appendChunk(chunk);
    this.primeHead();
    return true;
  }

  /** Append `chunk` at connPos, growing the window buffer (bounded — caller compacts first). */
  private appendChunk(chunk: Uint8Array): void {
    const need = this.bufLen + chunk.length;
    if (need > this.buf.length) {
      // Grow geometrically, but never below `need`. (The window is kept small by compaction; this only
      // fires on a transient burst where a single read's lookahead + back-margin exceeds the current cap.)
      let cap = this.buf.length || (1 << 20);
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.bufLen), 0);
      this.buf = next;
    }
    this.buf.set(chunk, this.bufLen);
    this.bufLen += chunk.length;
  }

  /** Copy freshly-pumped bytes into the persistent header cache while the connection is near offset 0. */
  private primeHead(): void {
    if (this.headLen >= this.headCacheBytes || this.windowStart !== 0) return;
    const have = this.connPos; // contiguous bytes [0, connPos) are in the window
    const want = Math.min(this.headCacheBytes, have);
    if (want <= this.headLen) return;
    if (!this.headBuf) this.headBuf = new Uint8Array(this.headCacheBytes);
    this.headBuf.set(this.buf.subarray(this.headLen, want), this.headLen);
    this.headLen = want;
  }

  /** Drop the consumed window prefix below `keepFrom` (minus a back-margin), keeping the buffer small. */
  private compact(keepFrom: number): void {
    const target = Math.max(this.windowStart, keepFrom - BACK_MARGIN_BYTES);
    const drop = target - this.windowStart;
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.windowStart += drop;
  }

  private lruGet(pos: number): Uint8Array | null {
    const key = Math.floor(pos / META_CHUNK) * META_CHUNK;
    const e = this.lru.get(key);
    if (!e) return null;
    const off = pos - key;
    if (off < 0 || off >= e.length) return null;
    this.lru.delete(key); this.lru.set(key, e); // refresh LRU recency
    return e.subarray(off);
  }

  private lruPut(start: number, data: Uint8Array): void {
    const key = Math.floor(start / META_CHUNK) * META_CHUNK;
    if (key !== start) return;          // only cache chunk-aligned reads (keeps the LRU simple + hit-friendly)
    if (data.length === 0) return;
    this.lru.delete(key); this.lru.set(key, data.slice()); // detached copy (the window buffer is reused)
    while (this.lru.size > META_LRU_MAX) this.lru.delete(this.lru.keys().next().value as number);
  }

  /**
   * The async range hook: return the bytes at [pos, pos+len) — ≤ len of them (a SHORT array at EOF, an
   * EMPTY array at/after EOF, null on a hard error). Serialized by the engine (one suspending AVIO read at
   * a time), so no internal locking is needed.
   */
  async read(pos: number, len: number): Promise<Uint8Array | null> {
    if (this.aborted) return null;
    if (len <= 0) return new Uint8Array(0);
    this._stalledOut = false; // cleared per read; only an exhausted read-stall resume latches it (for classification)
    pos = Math.floor(pos);
    this._lastReadPos = pos; // fetch-progress: the decode read head (overlay % + far-seek triage)
    if (this._total > 0 && pos >= this._total) return new Uint8Array(0);     // at/after EOF
    const effLen = this._total > 0 ? Math.min(len, this._total - pos) : len; // never over-request the tail

    // 1. HEAD cache (header re-reads after a seek — find_stream_info / av_seek_frame).
    if (this.headBuf && pos < this.headLen) {
      this.stats.headHits++;
      return this.headBuf.subarray(pos, Math.min(pos + effLen, this.headLen));
    }
    // 2. Metadata LRU (repeated scattered seek reads).
    const lru = this.lruGet(pos);
    if (lru) {
      this.stats.lruHits++;
      return lru.subarray(0, Math.min(effLen, lru.length));
    }

    try {
      // 3. Position the forward connection so the window can cover `pos`.
      const haveLiveWindow = this.reader != null || this.bufLen > 0;
      const inWindow = haveLiveWindow && pos >= this.windowStart && pos < this.connPos;
      const forwardGap = haveLiveWindow && pos >= this.connPos && (pos - this.connPos) <= GAP_REOPEN_BYTES
        && this.reader != null && !this.eofStream;

      let reopened = false;
      if (!inWindow && !forwardGap) {
        // Backward, far-forward, degraded-backward, or no connection → reopen.
        await this.openConnection(pos);
        reopened = true;
      } else if (this._degraded && pos < this.windowStart) {
        // Degraded backward: the stream only goes forward from 0 → reopen-from-0 + skip-forward.
        await this.openConnection(pos); // openConnection sets windowStart=0 in degraded mode
        reopened = true;
      }

      // In degraded mode a (re)open starts at 0; skip-pump forward to `pos`, compacting the discard.
      if (this._degraded && this.windowStart < pos && this.connPos <= pos) {
        while (this.connPos < pos && !this.eofStream) {
          if (!(await this.pumpChunk())) break;
          if (this.aborted) return null;
          this.compact(this.connPos); // discard everything before the live edge (we're skipping)
        }
        this.compact(pos);
      } else if (pos > this.connPos) {
        // Small forward gap (in-file seek): pump forward, discarding the gap bytes via compaction.
        while (this.connPos < pos && !this.eofStream) {
          if (!(await this.pumpChunk())) break;
          if (this.aborted) return null;
          this.compact(this.connPos);
        }
      }

      // 4. Pump until the window covers [pos, pos+effLen) (or EOF / connection end).
      while (this.connPos < pos + effLen && !this.eofStream) {
        if (!(await this.pumpChunk())) break;
        if (this.aborted) return null;
      }
      if (this.aborted) return null; // a teardown that aborted the in-flight read (pumpChunk broke out) → null, not empty

      if (pos < this.windowStart || pos > this.connPos) return new Uint8Array(0); // couldn't cover (EOF/gap)
      const off = pos - this.windowStart;
      const avail = this.bufLen - off;
      if (avail <= 0) return new Uint8Array(0); // EOF (stream ended before `pos`)
      const n = Math.min(effLen, avail);
      // DETACHED copy, NOT a subarray view: the compaction below (and the next read's pump) mutate
      // `this.buf` in place (copyWithin), which would shift the bytes UNDER a returned view before the C
      // bridge copies them out (the bridge reads `out` AFTER this read()'s Promise resolves). A copy taken
      // BEFORE any mutation is the only thing that stays correct. The copy is ≤ the AVIO read (≤256 KiB) —
      // negligible, and the bridge copies into the wasm heap regardless. (Adversarial review HIGH #1.)
      const out = this.buf.slice(off, off + n);
      this.stats.windowServes++;

      // Cache a chunk-aligned scattered read (served right after a reopen for a small read) so a repeated
      // seek to the same moov/cue region is free instead of churning another connection.
      if (reopened && n === effLen && len <= META_CHUNK) this.lruPut(pos, out);

      // Compact the consumed prefix, keeping a back-margin for AVIO re-reads.
      if ((pos - this.windowStart) > (this.windowBytes >> 2)) this.compact(pos);
      return out;
    } catch (err) {
      if (this.aborted) return null;
      this.log('VOD read error @' + pos + ': ' + (err as Error)?.message);
      return null; // → AVERROR(EIO)
    }
  }

  /** Teardown: abort the in-flight fetch synchronously and drop all buffers (idempotent). */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.closeConnection();
    this.buf = new Uint8Array(0); this.bufLen = 0;
    this.headBuf = null; this.headLen = 0;
    this.lru.clear();
  }
}
