// Ingest-side classify SEAM. Three PURE, side-effect-free decisions the live-ingest loop +
// the upstream-silence watchdog make. They live HERE (not inline in the DOM-bound worker) so the exact
// logic the worker runs is unit-testable headlessly — the decode worker can't be imported in node (it
// assigns `self.onmessage` at module load). The DOM-bound worker computes the booleans (instanceof,
// performance.now) and calls these; a test calls them with the same inputs and gets the same answer, so a
// regression in any of these three load-bearing decisions is caught without a browser.
//
// All three were a SINGLE concurrency bug: the adaptive silence watchdog runs CONCURRENTLY with the
// ingest reconnect loop, so during a backoff sleep a stale watchdog trip could race in and (a) defeat the
// classify-by-TYPE corruption guard and (b) inflate the stall counter. These functions encode the fix:
//   classifyIngestCause   — classify the THROW by TYPE FIRST; the silence flag is the LAST resort.
//   silenceWatchdogArmed  — the watchdog only accrues idle while an attempt is ACTIVELY streaming.
//   classifyCleanBoundary — a clean live close is a seamless 0ms reconnect only if it was meaningful.

import type { ErrorCause } from './error-controller';

/**
 * Map a thrown ingest error to an {@link ErrorCause} — classify by TYPE FIRST (FIX 1, the corruption
 * guard). An INTERNAL/transport TYPE (a RangeError = the cross-realm stale-HEAPU8 hazard; an HTTP status;
 * a connect timeout) MUST win over the `silenceTripped` flag, because the adaptive silence watchdog can
 * trip during the reconnect backoff window and leave the flag stale. If the flag were checked first, a
 * RangeError on the next attempt would misclassify as `upstream-silence` → reconnect → the persistent
 * demuxer resumes mid-gap → a corruption flood. So a TYPE always beats the flag; `upstream-silence` only
 * wins when nothing more specific threw. The caller consumes (clears) the flag REGARDLESS of the branch
 * taken, so a raced-in trip can never leak into the following attempt's classification.
 */
export function classifyIngestCause(t: {
  isRangeError: boolean;
  isHttpStatus: boolean;
  isConnectTimeout: boolean;
  silenceTripped: boolean;
}): ErrorCause {
  if (t.isRangeError) return 'range-error';
  if (t.isHttpStatus) return 'http-status';
  if (t.isConnectTimeout) return 'connect-timeout';
  if (t.silenceTripped) return 'upstream-silence';
  return 'network-drop';
}

/**
 * Should the upstream-silence watchdog accrue idle / be allowed to trip right now? (FIX 2 — the race
 * root cause.) The watchdog must fire ONLY while an attempt is ACTIVELY streaming and expected to deliver
 * bytes — never during the reconnect backoff window. `currentSource` alone can't gate this: the
 * per-attempt `finally` that nulls it runs AFTER the catch's backoff await, so a dead port lingers as
 * `hasSource` through the whole sleep. The `streaming` sentinel (set on connect, cleared the instant
 * open() returns/throws) is the true "actively reading" signal. Also idle while paused, after a clean
 * feedDone, and before the first byte (`lastByteAtMs===0`, i.e. onConnect hasn't stamped yet).
 */
export function silenceWatchdogArmed(s: {
  paused: boolean;
  feedDone: boolean;
  hasSource: boolean;
  streaming: boolean;
  lastByteAtMs: number;
}): boolean {
  return !s.paused && !s.feedDone && s.hasSource && s.streaming && s.lastByteAtMs !== 0;
}

/**
 * Classify a CLEAN live body close (FIX 3 — bound the seamless retry). A clean close that DELIVERED a
 * meaningful amount (≥ `minBytes`, ~one PES/GOP) OR that lasted long enough (≥ `minMs`) is a routine
 * connection boundary → `eof-boundary` → an immediate 0ms seamless reconnect (the healthy live case).
 * But a single delivered byte must NOT latch that: a trickle-then-close server (a few bytes, immediate
 * close) would hot-loop at 0ms (unbudgeted). Such a close — and a zero-byte close — classifies
 * `empty-body` → a budgeted, backed-off reconnect that the retry budget can eventually fail fatal.
 */
export function classifyCleanBoundary(t: {
  bytes: number;
  durationMs: number;
  minBytes: number;
  minMs: number;
}): Extract<ErrorCause, 'eof-boundary' | 'empty-body'> {
  const meaningful = t.bytes >= t.minBytes || t.durationMs >= t.minMs;
  return t.bytes > 0 && meaningful ? 'eof-boundary' : 'empty-body';
}
