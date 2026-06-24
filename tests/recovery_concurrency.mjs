// Headless WORKER-LEVEL CONCURRENCY test — the missing coverage for the silence-watchdog ⟂
// ingest-reconnect RACE. The decode worker can't be imported in node (it assigns `self.onmessage` at
// module load), so this drives the EXACT load-bearing decisions the worker runs — the REAL
// `classifyIngestCause` / `silenceWatchdogArmed` / `classifyCleanBoundary` (src/controller/ingest-classify),
// the REAL `classifyError` ladder, and the REAL `LiveSourcePort` (fetch+RS+abort) over a STUBBED fetch —
// wired in a faithful reconnect loop + a CONCURRENTLY-running silence watchdog (a setInterval, exactly as
// the worker runs silenceWatchdog() alongside ingest()). The stub gives deterministic control over the
// race the browser can't reproduce on demand.
//
// THE RACE (one bug, two symptoms): during a reconnect backoff `await sleep(delay)` the per-attempt
// `finally` that nulls `currentSource` has NOT run yet (it runs AFTER the await), so the dead port lingers.
// Pre-FIX the watchdog stayed armed on it, accrued idle on the drained demux, TRIPPED (stale
// silenceTripped + stallsTotal++), and — because the OLD catch checked `if (silenceTripped)` BEFORE
// `instanceof RangeError` — a RangeError on the NEXT attempt misclassified `upstream-silence` → reconnect,
// defeating the load-bearing `range-error → FATAL, NEVER reconnect` corruption guard (the demuxer would
// resume mid-gap → corruption flood).
//   FIX 1 (classifyIngestCause): classify by TYPE FIRST → a RangeError is fatal even if a trip raced in.
//   FIX 2 (silenceWatchdogArmed): the `streaming` sentinel gates the watchdog OUT of the backoff window,
//          so no spurious trip / stall-inflation happens at all.
//   FIX 3 (classifyCleanBoundary): a trickle-then-close is a BUDGETED reconnect, not a 0ms hot-loop.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/recovery_concurrency.mjs

import assert from 'node:assert/strict';
import { LiveSourcePort, SourceHttpError, SourceConnectTimeout } from '../src/source/port.ts';
import { classifyError } from '../src/controller/error-controller.ts';
import { classifyIngestCause, silenceWatchdogArmed, classifyCleanBoundary } from '../src/controller/ingest-classify.ts';
import { EOF_BOUNDARY_MIN_BYTES, EOF_BOUNDARY_MIN_MS } from '../src/policy.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

// --- a STUB fetch: each call serves the next attempt's `plan` (a ReadableStream we script) -------------
// plan: { status?, chunks?, chunkBytes?, chunkDelayMs?, end: 'eof'|'drop' }. The LiveSourcePort sees a
// minimal Response shape ({ ok, status, body }) — exactly what open() touches.
function makeStubFetch(plans) {
  let i = -1;
  return async (_url, init) => {
    i++;
    const plan = plans[Math.min(i, plans.length - 1)];
    const status = plan.status ?? 200;
    if (status !== 200 && status !== 206) return { ok: false, status, body: null };
    // PULL-based: deliver ONE chunk per read so the reader drains every chunk BEFORE the end signal
    // (controller.error() discards still-queued chunks — an enqueue-then-error start() would lose them).
    const n = plan.chunks ?? 1;
    let k = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (init?.signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
        if (k < n) { controller.enqueue(new Uint8Array(plan.chunkBytes ?? 1880)); k++; if (plan.chunkDelayMs) await sleep(plan.chunkDelayMs); return; }
        if (plan.end === 'drop') controller.error(new Error('ECONNRESET (mid-stream network drop)'));
        else controller.close(); // clean body end (live boundary / VOD EOF)
      },
    });
    return { ok: true, status, body };
  };
}

// --- the DRIVER: worker.ts ingest() + silenceWatchdog() reduced to their essence, using the REAL units. -
// `gateOnStreaming=false` reproduces the PRE-FIX-2 watchdog (ignores `streaming`) so a trip CAN race into
// the backoff; `true` uses the real `silenceWatchdogArmed` (FIX 2). `rangeErrorAtAttempt` makes that
// attempt's SINK throw a RangeError on its first byte (the stale-HEAPU8 hazard), before any byte counts.
async function ingestDriver(url, opts) {
  const {
    gateOnStreaming, rangeErrorAtAttempt = 0,
    silenceThresholdMs = 150, watchdogTickMs = 20, backoffMs = 450, maxAttempts = 6,
  } = opts;
  const fetchImpl = makeStubFetch(opts.plans);
  const now = () => performance.now();

  // shared state — mirrors the worker's module-level ingest/watchdog state
  let currentSource = null, streaming = false, silenceTripped = false, lastByteAtMs = 0;
  let cadN = 0, cadMean = 0, cadM2 = 0, cadNPeak = 0; // cadNPeak: cadN resets per connect, so track the warmed peak
  const paused = false, feedDone = false;
  let stallsTotal = 0, reconnectsTotal = 0, seamlessRetries = 0, budgetedReconnects = 0;
  let everConnected = false, fatal = null, attempt = 0, trips = 0;

  // The CONCURRENT silence watchdog (mirrors silenceWatchdog()), running alongside the reconnect loop.
  const wd = setInterval(() => {
    const src = currentSource;
    const armed = gateOnStreaming
      ? silenceWatchdogArmed({ paused, feedDone, hasSource: !!src, streaming, lastByteAtMs })
      : (!paused && !feedDone && !!src && lastByteAtMs !== 0); // PRE-FIX-2: arm regardless of `streaming`
    if (!src || !armed) return;
    if (now() - lastByteAtMs > silenceThresholdMs) {
      stallsTotal++; trips++; silenceTripped = true;
      lastByteAtMs = now();   // suppress an immediate re-trip while the reopen is in flight
      src.abort();            // → ingest catch: cause 'upstream-silence'
    }
  }, watchdogTickMs);

  try {
    for (;;) {
      if (++attempt > maxAttempts) break;
      const source = new LiveSourcePort(url);
      currentSource = source;
      let connectedAtMs = 0;
      const myAttempt = attempt;
      try {
        const r = await source.open({
          fetchImpl,
          connectTimeoutMs: 8000,
          onConnect: () => {
            everConnected = true;
            connectedAtMs = lastByteAtMs = now();
            streaming = true;                  // FIX 2: actively reading now
            cadMean = 0; cadM2 = 0; cadN = 0;  // FIX 2: reset cadence per connect
          },
          onBytes: () => {
            if (myAttempt === rangeErrorAtAttempt) throw new RangeError('offset is out of bounds'); // stale-HEAPU8
            const t = now();
            if (lastByteAtMs > 0) { const g = t - lastByteAtMs; cadN++; const d = g - cadMean; cadMean += d / cadN; cadM2 += d * (g - cadMean); if (cadN > cadNPeak) cadNPeak = cadN; }
            lastByteAtMs = t;
          },
        });
        streaming = false; // FIX 2: open() returned → gate the watchdog out of any backoff below
        if (r.reason === 'gone') break;
        const cause = classifyCleanBoundary({
          bytes: r.bytes, durationMs: connectedAtMs > 0 ? now() - connectedAtMs : 0,
          minBytes: EOF_BOUNDARY_MIN_BYTES, minMs: EOF_BOUNDARY_MIN_MS,
        });
        const action = classifyError(cause, { hasLiveEdge: true, everConnected });
        if (action.kind === 'fatal') { fatal = action; break; }
        reconnectsTotal++;
        if (action.kind === 'retry') { seamlessRetries++; continue; }          // 0ms seamless boundary
        if (action.kind === 'reconnect') { budgetedReconnects++; await sleep(backoffMs); continue; } // budgeted
        break;
      } catch (err) {
        streaming = false; // FIX 2: open() threw → watchdog must not trip during the backoff that follows
        const cause = classifyIngestCause({
          isRangeError: err instanceof RangeError,
          isHttpStatus: err instanceof SourceHttpError,
          isConnectTimeout: err instanceof SourceConnectTimeout,
          silenceTripped,
        });
        silenceTripped = false; // consume regardless of branch
        const action = classifyError(cause, { hasLiveEdge: true, everConnected });
        if (action.kind === 'fatal') { fatal = action; break; }
        reconnectsTotal++; budgetedReconnects++;
        await sleep(backoffMs); // the backoff WINDOW — the watchdog runs concurrently here (the race site)
        continue;
      } finally {
        if (currentSource === source) currentSource = null; // (runs AFTER the backoff await — the lingering-port bug)
      }
    }
  } finally {
    clearInterval(wd);
  }
  return { fatal, stallsTotal, reconnectsTotal, seamlessRetries, budgetedReconnects, trips, cadN: cadNPeak, everConnected };
}

console.log('worker-level concurrency — silence-watchdog ⟂ ingest-reconnect race:');

// ---- FIX 1 (pure): classify the THROW by TYPE first — the corruption guard survives a raced-in trip ----
await test('FIX 1  RangeError WINS over a raced-in silence trip → range-error → FATAL (never reconnect)', () => {
  // The exact race state: the watchdog tripped during the backoff (silenceTripped=true) AND the next
  // attempt threw a RangeError. TYPE must win.
  const cause = classifyIngestCause({ isRangeError: true, isHttpStatus: false, isConnectTimeout: false, silenceTripped: true });
  assert.equal(cause, 'range-error');
  const action = classifyError(cause, { hasLiveEdge: true, everConnected: true });
  assert.equal(action.kind, 'fatal');
  assert.equal(action.failure, 'worker');
  // The OLD flag-first ordering would have produced this — the regression we are guarding against:
  const oldBuggy = true /* silenceTripped */ ? 'upstream-silence' : 'range-error';
  assert.equal(classifyError(oldBuggy, { hasLiveEdge: true, everConnected: true }).kind, 'reconnect',
    'sanity: the old flag-first order WOULD have reconnected (defeating the guard) — TYPE-first prevents it');
});

await test('FIX 1  HTTP/connect-timeout TYPES also beat the silence flag; flag wins only with no TYPE', () => {
  assert.equal(classifyIngestCause({ isRangeError: false, isHttpStatus: true, isConnectTimeout: false, silenceTripped: true }), 'http-status');
  assert.equal(classifyIngestCause({ isRangeError: false, isHttpStatus: false, isConnectTimeout: true, silenceTripped: true }), 'connect-timeout');
  assert.equal(classifyIngestCause({ isRangeError: false, isHttpStatus: false, isConnectTimeout: false, silenceTripped: true }), 'upstream-silence');
  assert.equal(classifyIngestCause({ isRangeError: false, isHttpStatus: false, isConnectTimeout: false, silenceTripped: false }), 'network-drop');
});

// ---- FIX 2 (pure): the streaming sentinel gates the watchdog out of the backoff window ----------------
await test('FIX 2  silenceWatchdogArmed is FALSE while !streaming (the backoff window), TRUE while streaming', () => {
  const base = { paused: false, feedDone: false, hasSource: true, lastByteAtMs: 1 };
  assert.equal(silenceWatchdogArmed({ ...base, streaming: true }), true);
  assert.equal(silenceWatchdogArmed({ ...base, streaming: false }), false, 'a lingering dead port during backoff must NOT arm the watchdog');
  assert.equal(silenceWatchdogArmed({ ...base, streaming: true, paused: true }), false);
  assert.equal(silenceWatchdogArmed({ ...base, streaming: true, feedDone: true }), false);
  assert.equal(silenceWatchdogArmed({ ...base, streaming: true, hasSource: false }), false);
  assert.equal(silenceWatchdogArmed({ ...base, streaming: true, lastByteAtMs: 0 }), false);
});

// ---- FIX 3 (pure): a clean boundary is seamless only when meaningful; a trickle is budgeted -----------
await test('FIX 3  classifyCleanBoundary: trickle/empty → empty-body (budgeted); meaningful → eof-boundary (seamless)', () => {
  const F = { minBytes: EOF_BOUNDARY_MIN_BYTES, minMs: EOF_BOUNDARY_MIN_MS };
  assert.equal(classifyCleanBoundary({ bytes: 0, durationMs: 5, ...F }), 'empty-body');
  assert.equal(classifyCleanBoundary({ bytes: 10, durationMs: 5, ...F }), 'empty-body', 'a single-byte trickle must NOT latch a seamless retry');
  assert.equal(classifyCleanBoundary({ bytes: 200 * 1024, durationMs: 5, ...F }), 'eof-boundary', 'a full segment is a seamless boundary');
  assert.equal(classifyCleanBoundary({ bytes: 10, durationMs: 2000, ...F }), 'eof-boundary', 'a long-lived connection is a real boundary even on few bytes');
  // …and the resolved actions: empty-body backoff-reconnects, eof-boundary retries 0ms.
  assert.equal(classifyError('empty-body', { hasLiveEdge: true, everConnected: true }).kind, 'reconnect');
  assert.equal(classifyError('eof-boundary', { hasLiveEdge: true, everConnected: true }).kind, 'retry');
});

// ---- THE HEADLINE INTEGRATION: real port + concurrent watchdog, the full race ------------------------
const URL = 'stub://faux-live';
// warm 8 chunks (cadN≥8) then DROP → reconnect → backoff; attempt 2 throws a RangeError before any byte.
const racePlans = [
  { chunks: 8, chunkBytes: 1880, end: 'drop' }, // attempt 1: warm cadence, then a mid-stream drop
  { chunks: 3, chunkBytes: 1880, end: 'eof' },  // attempt 2: connects, but the SINK throws RangeError on byte 1
];

await test('RACE reproduced (watchdog trips during the backoff sleep) → RangeError next still goes FATAL, not reconnect', async () => {
  const r = await ingestDriver(URL, { plans: racePlans, gateOnStreaming: false, rangeErrorAtAttempt: 2, silenceThresholdMs: 150, backoffMs: 450 });
  assert.ok(r.cadN >= 8, `cadence must be warmed (cadN≥8), got ${r.cadN}`);
  assert.ok(r.trips >= 1, 'pre-FIX-2 the watchdog DOES trip during the backoff (the race) — reproduced');
  assert.ok(r.fatal, 'the RangeError attempt must terminate the loop');
  assert.equal(r.fatal.kind, 'fatal');
  assert.equal(r.fatal.failure, 'worker', 'classify-by-TYPE-first → range-error → fatal(worker), NOT upstream-silence→reconnect');
});

await test('FIX 2 in force (streaming gate on) → NO spurious trip during the backoff → stalls NOT inflated', async () => {
  const r = await ingestDriver(URL, { plans: racePlans, gateOnStreaming: true, rangeErrorAtAttempt: 2, silenceThresholdMs: 150, backoffMs: 450 });
  assert.equal(r.stallsTotal, 0, 'the streaming sentinel must keep the watchdog from accruing idle during backoff (stalls=0)');
  assert.equal(r.trips, 0, 'no watchdog trip at all while no attempt is actively reading');
  assert.ok(r.fatal && r.fatal.failure === 'worker', 'the RangeError attempt is still fatal');
});

await test('FIX 3  trickle-then-close server → BUDGETED reconnects (backoff), never a 0ms hot-loop', async () => {
  const t0 = performance.now();
  const r = await ingestDriver(URL, { plans: [{ chunks: 1, chunkBytes: 10, end: 'eof' }], gateOnStreaming: true, maxAttempts: 4, backoffMs: 120 });
  const elapsed = performance.now() - t0;
  assert.equal(r.seamlessRetries, 0, 'a trickle close must NOT classify as a seamless eof-boundary');
  assert.ok(r.budgetedReconnects >= 3, `each trickle close must take the budgeted reconnect path (got ${r.budgetedReconnects})`);
  assert.ok(elapsed >= 3 * 120 - 40, `budgeted reconnects must actually back off (elapsed ${elapsed | 0}ms), not hot-loop at 0ms`);
});

await test('a HEALTHY boundary (full segment then clean close) → seamless 0ms retry (no backoff)', async () => {
  const r = await ingestDriver(URL, {
    // attempt 1 delivers ≥64 KiB then closes → eof-boundary → retry; attempt 2 same; stop via maxAttempts.
    plans: [{ chunks: 40, chunkBytes: 2000, end: 'eof' }], gateOnStreaming: true, maxAttempts: 3, backoffMs: 120,
  });
  assert.ok(r.seamlessRetries >= 2, `a full-segment boundary must retry seamlessly (got ${r.seamlessRetries})`);
  assert.equal(r.budgetedReconnects, 0, 'a healthy boundary must never take the budgeted backoff path');
});

console.log(`\n✓ all ${passed} concurrency tests passed`);
process.exit(0);
