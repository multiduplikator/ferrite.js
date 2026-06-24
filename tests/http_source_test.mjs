// HttpSource transport gate — the VLC-parity single-forward-connection range reader (src/worker/http-source.ts).
// Drives it with an injectable fetch SHIM (a deterministic in-memory file + connection counter) so the
// transport correctness is tested in isolation, no engine/network. Asserts the contract's invariants:
//   - ONE forward connection for a sequential forward scan (the connection-churn fix)
//   - abort + reopen on a backward seek (exactly one new connection)
//   - window-serve: a read already in the live window does NO network
//   - HEAD cache: the header re-read after a seek hits the persistent cache (no reopen)
//   - metadata LRU: a repeated scattered seek-read hits the LRU (no reopen)
//   - 200-fallback: server ignores Range → degraded forward-only, still correct bytes
//   - short read at EOF / empty past EOF / total from Content-Range
//   - byte correctness on EVERY served read; abort() makes reads return null
//
// Run:  node --experimental-strip-types tests/http_source_test.mjs
import assert from 'node:assert/strict';
import { HttpSource } from '../src/worker/http-source.ts';

// Deterministic synthetic file: byte i = (i * 2654435761) & 0xff (so any slice is content-verifiable).
const FILE_SIZE = 5 * 1024 * 1024 + 12345; // odd size → exercises the tail / short-read
function fileByte(i) { return (Math.imul(i, 2654435761) >>> 24) & 0xff; }
const FILE = new Uint8Array(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i++) FILE[i] = fileByte(i);

function expectedSlice(pos, len) {
  const end = Math.min(pos + len, FILE_SIZE);
  return FILE.subarray(Math.max(0, pos), Math.max(0, end));
}

// A fetch shim. mode 'range' → 206 + Content-Range; mode '200' → 200 + Content-Length (ignores Range).
// Streams the served slice in CHUNK pieces so the reader yields multiple reads (exercises the pump loop).
// Counts opens (`.opens`), honours the AbortController signal (subsequent reads return done).
function makeFetch(mode = 'range', chunk = 64 * 1024) {
  const shim = (url, opts = {}) => {
    shim.opens++;
    const signal = opts.signal;
    const range = (opts.headers && (opts.headers.Range || opts.headers.range)) || 'bytes=0-';
    const start = mode === '200' ? 0 : parseInt(/bytes=(\d+)-/.exec(range)[1], 10);
    let pos = start;
    const body = new ReadableStream({
      pull(controller) {
        if (signal && signal.aborted) { controller.close(); return; }
        if (pos >= FILE_SIZE) { controller.close(); return; }
        const end = Math.min(pos + chunk, FILE_SIZE);
        controller.enqueue(FILE.slice(pos, end));
        pos = end;
      },
    });
    const headers = mode === '200'
      ? { 'Content-Length': String(FILE_SIZE) }
      : { 'Content-Range': `bytes ${start}-${FILE_SIZE - 1}/${FILE_SIZE}`, 'Content-Length': String(FILE_SIZE - start) };
    return Promise.resolve({
      status: mode === '200' ? 200 : 206,
      ok: true,
      headers: { get: (k) => headers[k] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())] ?? null },
      body,
    });
  };
  shim.opens = 0;
  return shim;
}

// 206 headers helper (Content-Range from the requested start) — shared by the stall shims.
function range206Headers(start) {
  const headers = { 'Content-Range': `bytes ${start}-${FILE_SIZE - 1}/${FILE_SIZE}`, 'Content-Length': String(FILE_SIZE - start) };
  return { get: (k) => headers[k] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase())] ?? null };
}
function reqStart(opts) {
  const range = (opts.headers && (opts.headers.Range || opts.headers.range)) || 'bytes=0-';
  return parseInt(/bytes=(\d+)-/.exec(range)[1], 10);
}

// A SILENT origin: replies 206 (headers fine) but its body delivers NO bytes EVER — `reader.read()` would
// hang forever. Honours the AbortController (errors the body so the in-flight read rejects, exactly like a
// real fetch on abort). `firstBytes` (optional) lets it deliver one prefix chunk before going silent — to
// prove a resume picks up from the RIGHT offset and the kept window is byte-correct across the stall.
function makeSilentFetch({ firstBytes = 0, flowAfterOpen = -1 } = {}) {
  const shim = (url, opts = {}) => {
    const openIdx = shim.opens++;
    const signal = opts.signal;
    const start = reqStart(opts);
    let pos = start, sentPrefix = false, aborted = false, onAbort;
    const flow = flowAfterOpen >= 0 && openIdx >= flowAfterOpen; // this connection streams normally to EOF
    const body = new ReadableStream({
      start(controller) {
        if (signal) {
          if (signal.aborted) { aborted = true; controller.error(new DOMException('aborted', 'AbortError')); return; }
          onAbort = () => { aborted = true; try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* already closed */ } };
          signal.addEventListener('abort', onAbort);
        }
      },
      pull(controller) {
        if (aborted) return;
        if (flow) { // healthy connection: stream the rest of the file in 64 KiB chunks, then close
          if (pos >= FILE_SIZE) { try { controller.close(); } catch { /* closed */ } return; }
          const end = Math.min(pos + 64 * 1024, FILE_SIZE);
          try { controller.enqueue(FILE.slice(pos, end)); } catch { return; } pos = end; return;
        }
        if (firstBytes > 0 && !sentPrefix) { // one prefix chunk, then silence
          sentPrefix = true;
          const end = Math.min(start + firstBytes, FILE_SIZE);
          try { controller.enqueue(FILE.slice(start, end)); } catch { return; } pos = end; return;
        }
        return new Promise(() => {}); // never resolves → reader.read() stays pending (the stall), no busy-loop
      },
      cancel() { aborted = true; if (signal && onAbort) signal.removeEventListener('abort', onAbort); },
    });
    return Promise.resolve({ status: 206, ok: true, headers: range206Headers(start), body });
  };
  shim.opens = 0;
  return shim;
}

// A slow-but-FLOWING origin: 206, delivers a chunk every `gapMs` (a legitimately slow large VOD). As long
// as gapMs < the read-stall deadline, NOTHING should trip — proves it's a read-stall timer, not total-time.
function makeTrickleFetch(gapMs, chunk = 64 * 1024) {
  const shim = (url, opts = {}) => {
    shim.opens++;
    const signal = opts.signal;
    const start = reqStart(opts);
    let pos = start, aborted = false, onAbort;
    const body = new ReadableStream({
      start(controller) {
        if (signal) { onAbort = () => { aborted = true; try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } }; signal.addEventListener('abort', onAbort); }
      },
      pull(controller) {
        return new Promise((resolve) => setTimeout(() => {
          if (aborted) { resolve(); return; }
          if (pos >= FILE_SIZE) { try { controller.close(); } catch { /* closed */ } resolve(); return; }
          const end = Math.min(pos + chunk, FILE_SIZE);
          try { controller.enqueue(FILE.slice(pos, end)); pos = end; } catch { /* cancelled mid-flight */ }
          resolve();
        }, gapMs));
      },
      cancel() { aborted = true; if (signal && onAbort) signal.removeEventListener('abort', onAbort); },
    });
    return Promise.resolve({ status: 206, ok: true, headers: range206Headers(start), body });
  };
  shim.opens = 0;
  return shim;
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
// Verify a served read returns EXACTLY the expected bytes (or a valid short read covering its prefix).
async function readEq(src, pos, len, { short = false } = {}) {
  const got = await src.read(pos, len);
  assert.ok(got !== null, `read(${pos},${len}) returned null`);
  const exp = expectedSlice(pos, len);
  if (!short) assert.equal(got.length, exp.length, `read(${pos},${len}) length ${got.length} != ${exp.length}`);
  assert.ok(got.length > 0 || exp.length === 0, `read(${pos},${len}) unexpectedly empty`);
  for (let i = 0; i < got.length; i++) assert.equal(got[i], exp[i], `byte mismatch at ${pos}+${i}`);
  return got;
}

console.log('HttpSource transport gate (injected fetch shim):');

await test('total from Content-Range; first open = 1 connection', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 256 * 1024 });
  const total = await src.open();
  assert.equal(total, FILE_SIZE, 'total');
  assert.equal(src.total, FILE_SIZE);
  assert.equal(f.opens, 1, 'exactly one open after open()');
  src.abort();
});

await test('sequential forward scan = ONE connection (no churn) + correct bytes', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 2 << 20, headCacheBytes: 512 * 1024 });
  await src.open();
  // Mimic the engine's 256 KiB forward AVIO reads across the whole file.
  for (let pos = 0; pos < FILE_SIZE; pos += 256 * 1024) await readEq(src, pos, 256 * 1024, { short: pos + 256 * 1024 > FILE_SIZE });
  assert.equal(f.opens, 1, `forward scan opened ${f.opens} connections (want 1)`);
  assert.ok(src.getStats().windowServes > 10, 'window served the forward reads');
  src.abort();
});

await test('window-serve: re-read inside the live window does NO network', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 4 << 20, headCacheBytes: 0 });
  await src.open();
  await readEq(src, 1 << 20, 256 * 1024); // pull a window around 1 MiB
  const opensAfter = f.opens, fetchedAfter = src.getStats().bytesFetched;
  await readEq(src, 1 << 20, 128 * 1024);                 // same region
  await readEq(src, (1 << 20) + 100 * 1024, 64 * 1024);   // overlapping, still buffered
  assert.equal(f.opens, opensAfter, 'no reopen for in-window re-read');
  assert.equal(src.getStats().bytesFetched, fetchedAfter, 'no extra bytes fetched for in-window re-read');
  src.abort();
});

await test('backward seek = exactly ONE abort+reopen', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  // Sequential forward scan to ~1.5 MiB (each step ≤ the 2 MiB skip-gap → stays ONE connection).
  for (let pos = 0; pos < (3 << 19); pos += 256 * 1024) await readEq(src, pos, 256 * 1024);
  assert.equal(f.opens, 1, `forward scan stayed one connection (got ${f.opens})`);
  await readEq(src, 256 * 1024, 256 * 1024); // seek BACK → reopen
  assert.equal(f.opens, 2, `backward seek opened ${f.opens} (want 2)`);
  assert.equal(src.getStats().reopens, 1, 'one reopen counted');
  src.abort();
});

await test('HEAD cache: header re-read after a seek hits cache (no reopen)', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 1 << 20 });
  await src.open();
  await readEq(src, 0, 512 * 1024);       // read the "header" → primes head cache
  await readEq(src, 4 << 20, 256 * 1024); // seek far forward (reopen)
  const opensAfter = f.opens, headBefore = src.getStats().headHits;
  await readEq(src, 0, 256 * 1024);       // find_stream_info re-reads the header
  await readEq(src, 128 * 1024, 64 * 1024);
  assert.equal(f.opens, opensAfter, 'header re-read did NOT reopen');
  assert.ok(src.getStats().headHits > headBefore, 'header re-read hit the HEAD cache');
  src.abort();
});

await test('metadata LRU: repeated scattered seek-read hits the LRU (no 2nd reopen)', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 512 * 1024, headCacheBytes: 0 });
  await src.open();
  const META = 256 * 1024;
  const target = 10 * META; // aligned scattered offset (a moov-sample-table / cue read)
  await readEq(src, target, META);   // scattered read (reopen from 0) → caches `target` in the LRU
  await readEq(src, 0, META);        // move the window back to 0 (reopen) → `target` no longer buffered
  const opensAfter = f.opens, lruBefore = src.getStats().lruHits;
  await readEq(src, target, META);   // SAME scattered read → LRU hit BEFORE any connection logic → no reopen
  assert.equal(f.opens, opensAfter, `repeated scattered read reopened (opens ${f.opens} != ${opensAfter})`);
  assert.ok(src.getStats().lruHits > lruBefore, 'repeated scattered read hit the LRU');
  src.abort();
});

await test('short read at EOF + empty past EOF', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  const nearEof = FILE_SIZE - 1000;
  const got = await readEq(src, nearEof, 256 * 1024, { short: true }); // asks 256K, only 1000 left
  assert.equal(got.length, 1000, `EOF short read length ${got.length} != 1000`);
  const past = await src.read(FILE_SIZE + 10, 4096);
  assert.ok(past !== null && past.length === 0, 'read past EOF returns empty');
  src.abort();
});

await test('200-fallback: degraded forward-only, correct bytes, backward reopens-from-0', async () => {
  const f = makeFetch('200');
  const src = new HttpSource('http://x/v.mkv', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 256 * 1024 });
  const total = await src.open();
  assert.equal(total, FILE_SIZE, 'total from Content-Length');
  assert.equal(src.degraded, true, 'degraded flagged on 200');
  await readEq(src, 0, 256 * 1024);
  await readEq(src, 2 << 20, 256 * 1024);   // forward (skip-pump from the stream)
  const opensBeforeBack = f.opens;
  await readEq(src, 512 * 1024, 256 * 1024); // backward in degraded → reopen-from-0 + skip
  assert.ok(f.opens > opensBeforeBack, 'degraded backward reopened');
  src.abort();
});

await test('returned bytes survive the post-serve compaction (no view aliasing) — review HIGH #1', async () => {
  // Small window + small chunks → the post-serve compact() copyWithin fires WHILE forward-scanning. If
  // read() returned a subarray VIEW into the window buffer, the shift would corrupt already-returned bytes
  // (the engine bridge copies them AFTER read() resolves). Two checks: (a) every forward read is byte-exact;
  // (b) a returned buffer held across MANY later reads stays intact (proves it's detached).
  const f = makeFetch('range', 17 * 1024); // 17 KiB chunks (odd → straddles read boundaries)
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  const held = []; // (pos, returnedArray) captured early, verified at the end
  for (let pos = 0; pos < 3 << 20; pos += 64 * 1024) {
    const got = await readEq(src, pos, 64 * 1024); // immediate byte check (catches same-call aliasing)
    if (pos < 512 * 1024) held.push([pos, got]); // hold the first few across all later reads + compactions
  }
  assert.equal(f.opens, 1, 'forward scan stayed one connection');
  for (const [pos, got] of held) {
    const exp = expectedSlice(pos, 64 * 1024);
    for (let i = 0; i < got.length; i++) assert.equal(got[i], exp[i], `held buffer @${pos}+${i} corrupted by a later compaction`);
  }
  src.abort();
});

await test('abort(): reads return null, fetch signal aborted', async () => {
  let abortedSignal = false;
  const f = makeFetch('range');
  const wrapped = (url, opts) => { opts?.signal?.addEventListener?.('abort', () => { abortedSignal = true; }); return f(url, opts); };
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: wrapped, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  await readEq(src, 0, 64 * 1024);
  src.abort();
  assert.equal(await src.read(0, 64 * 1024), null, 'read after abort returns null');
  assert.equal(abortedSignal, true, 'fetch AbortController signal fired');
});

// ---- VOD fetch-progress telemetry (the long-press overlay's transport row) ----
await test('getStats(): total / position / windowBytes track the transport (the fetch-progress overlay row)', async () => {
  const f = makeFetch('range');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 0 });
  const total = await src.open();
  assert.equal(total, FILE_SIZE, 'open() learns the size from Content-Range');
  assert.equal(src.getStats().total, FILE_SIZE, 'getStats().total = the file size (progress denominator)');
  // A read advances the position (the decode read head → the overlay %).
  await readEq(src, 1_000_000, 64 * 1024);
  assert.equal(src.getStats().position, 1_000_000, 'position = the last served range-read offset');
  assert.ok(src.getStats().windowBytes > 0, 'windowBytes reflects the live rolling buffer depth');
  assert.equal(src.getStats().degraded, false, '206 server → not degraded');
  src.abort();
});

await test('getStats(): degraded=1 on an HTTP-200 (Range-ignored) server (the overlay deg flag)', async () => {
  const f = makeFetch('200');
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  await readEq(src, 0, 64 * 1024);
  assert.equal(src.getStats().degraded, true, '200 → degraded forward-only (the overlay shows deg(200))');
  src.abort();
});

// ---- READ-STALL timeout (the Asyncify stall-breaker, E-1) ----
const STALL_MS = 40; // small deadline so the stall tests run fast

await test('read-stall: origin accepts then sends NO bytes → bounded resumes → read()→null (fatal, not a hang)', async () => {
  const f = makeSilentFetch();
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, readStallTimeoutMs: STALL_MS, windowBytes: 1 << 20, headCacheBytes: 0 });
  const total = await src.open();               // open() reads only headers (206) → succeeds even on a silent body
  assert.equal(total, FILE_SIZE, 'open() learned the size from the 206 (body stall is later)');
  assert.equal(f.opens, 1, 'one connection after open()');
  const got = await src.read(0, 64 * 1024);     // pumps → stalls → 3 resumes → exhausted → null (BOUNDED, no hang)
  assert.equal(got, null, 'exhausted read-stall returns null (bounded failure, not an infinite suspend)');
  assert.equal(src.stalledOut, true, 'stalledOut latched → the worker classifies this as upstream-silence (network)');
  assert.equal(src.getStats().readStalls, 4, 'read-stall fired 4× (3 resumes + the exhausting trip)');
  assert.equal(f.opens, 4, 'bounded reopens: 1 initial + 3 resumes, then it gives up (NOT infinite)');
  src.abort();
});

await test('read-stall: a prefix then silence → resume picks up from the RIGHT offset, kept window byte-correct', async () => {
  // 1st connection delivers a 200 KiB prefix then goes silent; the 2nd connection (the resume) streams to
  // EOF. The read must complete with byte-exact data ACROSS the stall boundary (resume offset = connPos).
  const f = makeSilentFetch({ firstBytes: 200 * 1024, flowAfterOpen: 1 });
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, readStallTimeoutMs: STALL_MS, windowBytes: 4 << 20, headCacheBytes: 0 });
  await src.open();
  const got = await readEq(src, 0, 512 * 1024); // 512 KiB spans the prefix (200K) + the post-resume stream
  assert.equal(got.length, 512 * 1024, 'the read completed across the stall via a resume');
  assert.equal(src.getStats().readStalls, 1, 'exactly one stall trip → one resume');
  assert.equal(f.opens, 2, 'one resume reopen (the prefix connection + the streaming resume)');
  assert.equal(src.getStats().reopens, 1, 'the resume counted as a reopen');
  assert.equal(src.stalledOut, false, 'recovered → not latched fatal');
  // Continue the forward scan on the resumed connection — still byte-exact, still ONE more connection.
  await readEq(src, 512 * 1024, 256 * 1024);
  assert.equal(f.opens, 2, 'the forward scan continued on the resumed connection (no extra churn)');
  src.abort();
});

await test('slow-but-flowing VOD (chunks UNDER the deadline) → plays through with ZERO spurious stalls', async () => {
  const f = makeTrickleFetch(STALL_MS / 4); // a chunk every 10ms, deadline 40ms → 4× margin, never trips
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, readStallTimeoutMs: STALL_MS, windowBytes: 2 << 20, headCacheBytes: 0 });
  await src.open();
  for (let pos = 0; pos < 768 * 1024; pos += 256 * 1024) await readEq(src, pos, 256 * 1024); // forward scan
  assert.equal(src.getStats().readStalls, 0, 'a slow-but-flowing source NEVER trips the read-stall timer');
  assert.equal(f.opens, 1, 'one forward connection (no resume churn on a healthy slow stream)');
  assert.ok(src.getStats().bytesFetched >= 768 * 1024, 'bytes flowed through');
  src.abort();
});

await test('teardown mid-read: abort() returns null and does NOT false-trip the read-stall timer', async () => {
  const f = makeSilentFetch();
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, readStallTimeoutMs: 5000, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  const readP = src.read(0, 64 * 1024);  // hangs on the silent body (deadline is 5s, far away)
  setTimeout(() => src.abort(), 20);     // teardown while the read is in flight — the intentional abort
  const got = await readP;
  assert.equal(got, null, 'teardown mid-read returns null (the abort contract), NOT a stall error');
  assert.equal(src.getStats().readStalls, 0, 'the teardown abort did NOT fire the read-stall timer (no false positive)');
  assert.equal(src.stalledOut, false, 'a clean teardown is not a stall-out');
  assert.equal(await src.read(0, 64 * 1024), null, 'reads after abort stay null');
});

// ---- CONNECT timeout (the header-arrival stall-breaker, E-6) ----
// A CONNECT-stalling origin: opens at index >= `stallFrom` accept the TCP/HTTP connection but NEVER resolve
// their header Promise (the `await fetch()` hangs forever) — the connect-phase analog of the silent body.
// They reject with AbortError when the connect-timeout (or a teardown) aborts the controller. Opens BEFORE
// `stallFrom` resolve 206 headers (optionally after `connectDelayMs`, to model a slow-but-OK connect) and
// stream a body per `body`: 'normal' → to EOF; 'prefixSilent' → `prefixBytes` then go silent (a READ-stall,
// to drive the E-1 resume into a connect-stalling reopen).
const CONNECT_MS = 80; // small connect deadline so the connect tests run fast
function makeConnectFetch({ stallFrom = 0, body = 'normal', prefixBytes = 200 * 1024, connectDelayMs = 0 } = {}) {
  const shim = (url, opts = {}) => {
    const openIdx = shim.opens++;
    const signal = opts.signal;
    const start = reqStart(opts);
    if (openIdx >= stallFrom) {
      // CONNECT-STALL: never resolve the header Promise; reject only when aborted (connect-timeout/teardown).
      return new Promise((_, reject) => {
        if (!signal) return; // no signal → a true forever-hang (unused here; all callers pass a signal)
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort);
      });
    }
    // This open CONNECTS: build the streaming body, then resolve the headers (optionally after a delay).
    let pos = start, sentPrefix = false, aborted = false, onAbort;
    const stream = new ReadableStream({
      start(controller) {
        if (signal) { onAbort = () => { aborted = true; try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } }; signal.addEventListener('abort', onAbort); }
      },
      pull(controller) {
        if (aborted) return;
        if (body === 'prefixSilent') {
          if (!sentPrefix) { sentPrefix = true; const end = Math.min(start + prefixBytes, FILE_SIZE); try { controller.enqueue(FILE.slice(start, end)); } catch { return; } pos = end; return; }
          return new Promise(() => {}); // silence after the prefix → a READ-stall (drives the E-1 resume)
        }
        if (pos >= FILE_SIZE) { try { controller.close(); } catch { /* closed */ } return; }
        const end = Math.min(pos + 64 * 1024, FILE_SIZE);
        try { controller.enqueue(FILE.slice(pos, end)); } catch { return; } pos = end;
      },
      cancel() { aborted = true; if (signal && onAbort) signal.removeEventListener('abort', onAbort); },
    });
    const resp = { status: 206, ok: true, headers: range206Headers(start), body: stream };
    return connectDelayMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(resp), connectDelayMs)) : Promise.resolve(resp);
  };
  shim.opens = 0;
  return shim;
}

await test('connect-stall: origin accepts but sends NO headers → connect-timeout fires → fatal (bounded, not a hang)', async () => {
  const f = makeConnectFetch({ stallFrom: 0 }); // the very first connect hangs at the header-await
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, connectTimeoutMs: CONNECT_MS, windowBytes: 1 << 20, headCacheBytes: 0 });
  const t0 = Date.now();
  await assert.rejects(src.open(), /connect timeout/i, 'open() rejects with a connect-timeout (does NOT hang forever)');
  const dt = Date.now() - t0;
  assert.ok(dt >= CONNECT_MS - 20 && dt < CONNECT_MS + 1000, `open() returned bounded (~${CONNECT_MS}ms), got ${dt}ms`);
  assert.equal(f.opens, 1, 'one connect attempt — the connect-timeout did NOT spin up a parallel recovery');
  assert.equal(src.stalledOut, true, 'stalledOut latched → the worker classifies the open failure as upstream-silence (network)');
  src.abort();
});

await test('slow-but-connects (headers just under the deadline) → ZERO false connect-timeout, plays through', async () => {
  const f = makeConnectFetch({ stallFrom: Infinity, connectDelayMs: CONNECT_MS / 2 }); // connects at ~half the deadline
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, connectTimeoutMs: CONNECT_MS, windowBytes: 2 << 20, headCacheBytes: 0 });
  const total = await src.open();
  assert.equal(total, FILE_SIZE, 'a slow-but-in-time connect succeeds (no false connect-timeout)');
  for (let pos = 0; pos < 768 * 1024; pos += 256 * 1024) await readEq(src, pos, 256 * 1024); // plays through
  assert.equal(f.opens, 1, 'one forward connection (no connect-timeout churn)');
  assert.equal(src.stalledOut, false, 'a healthy connect never latches stalledOut');
  src.abort();
});

await test('connect-timeout does NOT fire once the body is streaming (handed off to the read-stall timer)', async () => {
  // Headers resolve immediately, then the body TRICKLES over a span LONGER than the connect deadline. If the
  // connect-timeout wrongly stayed armed past the header-await it would abort mid-stream; it must not.
  const f = makeTrickleFetch(CONNECT_MS / 2); // a chunk every 40ms; total stream time ≫ the 80ms connect deadline
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, connectTimeoutMs: CONNECT_MS, readStallTimeoutMs: 4 * CONNECT_MS, windowBytes: 2 << 20, headCacheBytes: 0 });
  await src.open();
  for (let pos = 0; pos < 512 * 1024; pos += 256 * 1024) await readEq(src, pos, 256 * 1024); // streams across many connect-deadlines
  assert.equal(f.opens, 1, 'the connect-timeout was cleared on the header-await → no mid-stream abort');
  assert.equal(src.getStats().readStalls, 0, 'the read-stall timer (not the connect-timeout) owns the body, and it did not trip either');
  assert.equal(src.stalledOut, false, 'a streaming body never trips the connect-timeout');
  src.abort();
});

await test('teardown during connect → read() returns null (the abort contract), NOT a connect-timeout misfire', async () => {
  const f = makeConnectFetch({ stallFrom: 1 }); // open #0 connects; the reopen (#1) connect-stalls
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, connectTimeoutMs: CONNECT_MS, windowBytes: 1 << 20, headCacheBytes: 0 });
  await src.open();
  await readEq(src, 0, 64 * 1024);                 // window read on the healthy first connection
  const readP = src.read(4 << 20, 64 * 1024);      // far-forward seek → reopen #1 → hangs at the connect
  setTimeout(() => src.abort(), CONNECT_MS / 2);   // teardown BEFORE the connect-timeout would fire
  const got = await readP;
  assert.equal(got, null, 'teardown mid-connect returns null (abort contract), NOT a connect-timeout error');
  assert.equal(src.stalledOut, false, 'a clean teardown during connect is not a stall-out (no false connect-timeout)');
  assert.equal(await src.read(0, 64 * 1024), null, 'reads after abort stay null');
});

await test('resume reopen connect-stalls (E-1 path) → the connect-timeout fires there too → fatal, no hang', async () => {
  // open #0 delivers a 200 KiB prefix then goes silent (a READ-stall) → the E-1 resume reopens (#1), and THAT
  // reopen connect-stalls. The connect-timeout must fire on the resume just as it does on the initial open.
  const f = makeConnectFetch({ stallFrom: 1, body: 'prefixSilent', prefixBytes: 200 * 1024 });
  const src = new HttpSource('http://x/v.mp4', { fetchImpl: f, connectTimeoutMs: CONNECT_MS, readStallTimeoutMs: 40, windowBytes: 4 << 20, headCacheBytes: 0 });
  await src.open();
  const got = await src.read(0, 512 * 1024); // pumps the prefix → read-stall → resume reopen → connect-stall → null
  assert.equal(got, null, 'a connect-stalling resume returns null (bounded), NOT an infinite suspend');
  assert.equal(src.stalledOut, true, 'stalledOut latched on the resume connect-timeout → upstream-silence (network) fatal');
  assert.equal(f.opens, 2, 'one initial open + one resume reopen (the reopen connect-stalled, no further churn)');
  src.abort();
});

console.log(failed === 0
  ? '\nALL OK — HttpSource: one forward connection, abort+reopen on seek, window/HEAD/LRU serves, 200-fallback, EOF short read, read-stall resume→bounded-fatal, slow-flow no-false-trip, connect-timeout→bounded-fatal (open + resume), connect-handoff-to-read-stall, teardown-safe, abortable, fetch-progress telemetry.'
  : `\n${failed} FAILED.`);
process.exit(failed ? 1 : 0);
