// SourcePort — the ingest SEAM. The controller speaks only to ports;
// the Live impl is `fetch` + `ReadableStream`. ONE port.open() call IS one connection attempt's full
// lifecycle: connect (with a connect-timeout), stream bytes to a sink while a backpressure gate allows
// it, and abort SYNCHRONOUSLY on teardown via an AbortController. Reconnect/backoff POLICY lives a level
// up (the worker; the error controller later) — a SourcePort knows nothing about retries.
//
// This is a faithful extraction of the decode worker's proven inner fetch+read loop (worker.ts `ingest`)
// so the seam is REAL (the worker uses it), not decorative — and it is DOM-free / Node-API-free, so it
// runs UNCHANGED in the decode worker AND in a headless node test against `/faux-live`.
//
// VOD (pull: Range-AVIO via SAB+Atomics io-worker) is implemented elsewhere; only the Live (push) impl exists here.

import type { ResponseFacts } from './capabilities';

export type SourceMode = 'live' | 'vod';

/** Why open() returned. `eof` = the body ended cleanly (live: a connection boundary → caller may
 *  reconnect; VOD: real end). `gone` = teardown/supersede flipped `alive()` mid-stream (caller stops,
 *  no error). Genuine failures THROW (see the typed errors) so the caller can classify them. */
export type SourceEndReason = 'eof' | 'gone';

export interface SourceResult {
  reason: SourceEndReason;
  /** Bytes delivered to the sink during THIS attempt (0 ⇒ an empty body — caller may treat as a fault). */
  bytes: number;
  /** True once response headers arrived 2xx and the body started (vs a connect that never landed). */
  connected: boolean;
  /** HTTP status (0 if no response). */
  status: number;
}

export interface SourceOpenOptions {
  /** Sink for each network chunk (the decode worker copies it into the demux ring). */
  onBytes: (chunk: Uint8Array) => void;
  /** Fired ONCE the body connects (2xx + body, before the first read) — lets the caller mark "ever
   *  connected" at the same instant the old inline loop did, so a connect-then-immediate-error (zero
   *  bytes) still classifies as a live drop (reconnect) rather than an initial-connect fault. The second
   *  arg carries the FIRST-response header facts (Accept-Ranges/206, Content-Length) so the caller can
   *  refine its SourceCapabilities descriptor WITHOUT a second round-trip (the response is already in
   *  hand). Optional + backward-compatible: callers that read only `status` ignore it. */
  onConnect?: (status: number, facts: ResponseFacts) => void;
  /** Backpressure gate: return false to PAUSE reading (the controller's feedGate=close OR the demux ring
   *  is over its watermark). Polled every `pollMs` while closed. Omitted ⇒ always read. */
  shouldRead?: () => boolean;
  /** Cooperative cancel: return false to abandon (a load/unload/destroy flipped the worker `gen`). The
   *  loop checks it across every await so a teardown during a backpressure wait stops promptly. */
  alive?: () => boolean;
  /** Poll interval (ms) while the backpressure gate is closed. */
  pollMs?: number;
  /** Abort the CONNECT if response headers don't arrive within this many ms (not the body read — a live
   *  stream legitimately trickles). A connect-timeout throws `SourceConnectTimeout`. */
  connectTimeoutMs?: number;
  /** Injectable fetch (defaults to the global) — lets a test stub the network. */
  fetchImpl?: typeof fetch;
}

/** A non-2xx HTTP response. Carries the status so the caller can map initial-connect vs live-drop. */
export class SourceHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super('HTTP ' + status); this.name = 'SourceHttpError'; this.status = status; }
}
/** The connect-timeout fired (headers never arrived in time). The caller counts it on its timeout budget. */
export class SourceConnectTimeout extends Error {
  constructor() { super('connect timeout'); this.name = 'SourceConnectTimeout'; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface SourcePort {
  readonly mode: SourceMode;
  /** Stream ONE connection's worth of bytes. Resolves on clean end / teardown; THROWS on a fault. */
  open(opts: SourceOpenOptions): Promise<SourceResult>;
  /** Abort the in-flight connection synchronously (teardown). Idempotent; safe before/after open(). */
  abort(): void;
}

export class LiveSourcePort implements SourcePort {
  readonly mode: SourceMode = 'live';
  private ac: AbortController | null = null; // the CURRENT attempt's controller (for synchronous abort)
  private readonly url: string;

  constructor(url: string) { this.url = url; }

  abort(): void {
    // Abort while the worker is still alive so the socket FINs at once (the upstream/bridge drops
    // the subscriber promptly) instead of waiting for the next read() or a Worker.terminate().
    this.ac?.abort();
    this.ac = null;
  }

  async open(opts: SourceOpenOptions): Promise<SourceResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const alive = opts.alive ?? (() => true);
    const pollMs = opts.pollMs ?? 8;
    const ac = new AbortController();
    this.ac = ac;
    let connected = false;
    let bytes = 0;
    let status = 0;
    let timedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Per-attempt CONNECT timeout (hls.js ConnectingTimeout): abort if headers don't arrive in time.
      let tid: ReturnType<typeof setTimeout> | 0 = 0;
      if (opts.connectTimeoutMs && opts.connectTimeoutMs > 0) {
        tid = setTimeout(() => { timedOut = true; ac.abort(); }, opts.connectTimeoutMs);
      }
      let res: Response;
      try { res = await fetchImpl(this.url, { signal: ac.signal }); }
      finally { if (tid) clearTimeout(tid); }
      if (!alive()) return { reason: 'gone', bytes, connected, status };
      status = res.status;
      if (!res.ok) throw new SourceHttpError(res.status);
      if (!res.body) throw new Error('no response body');
      connected = true;
      // First-response header facts → the caller's SourceCapabilities refine (no extra round-trip). A
      // live MPEG-TS push is chunked 200 with no Accept-Ranges ⇒ both false (the byte-identical default);
      // a timeshift origin that serves ranges (Accept-Ranges: bytes / a 206) ⇒ seekable. `headers` is
      // read defensively (a real Response always has it; a reduced test stub may not — absent ⇒ the live
      // default of no-ranges/unbounded, which is exactly the byte-identical fallthrough).
      const h = res.headers;
      const facts: ResponseFacts = {
        acceptRanges: status === 206 || (h?.get?.('Accept-Ranges') ?? '').toLowerCase().includes('bytes'),
        hasContentLength: h?.has?.('Content-Length') ?? false,
      };
      opts.onConnect?.(status, facts);
      reader = res.body.getReader();
      for (;;) {
        // Backpressure: hold while the gate is closed (controller paused OR demux over-buffered). The
        // fetch body itself backpressures the network because we stop pulling.
        while (opts.shouldRead && !opts.shouldRead() && alive()) await sleep(pollMs);
        if (!alive()) return { reason: 'gone', bytes, connected, status };
        const { done, value } = await reader.read();
        if (!alive()) return { reason: 'gone', bytes, connected, status };
        if (done) break;
        if (value && value.length) { opts.onBytes(value); bytes += value.length; }
      }
      return { reason: 'eof', bytes, connected, status };
    } catch (err) {
      if (timedOut) throw new SourceConnectTimeout();
      throw err; // SourceHttpError, a RangeError from the sink, or a raw fetch/read error — caller classifies
    } finally {
      // Close THIS attempt's connection on every exit (clean end, teardown, throw): cancel the reader +
      // abort the fetch so the network connection is released PROMPTLY (the upstream drops the subscriber)
      // rather than left to a passive GC release.
      reader?.cancel().catch(() => {});
      ac.abort();
      if (this.ac === ac) this.ac = null;
    }
  }
}
