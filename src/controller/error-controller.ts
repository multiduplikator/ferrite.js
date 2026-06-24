// The ERROR CONTROLLER — the single classify→action authority.
// DOM-free, side-effect-free, reducer-style: `classifyError(cause, ctx) → ErrorAction`. No I/O,
// no globals (the hls.js ErrorController model: one classification, one resolved action, an
// explicit escalation ladder).
//
// THE PRINCIPLE: classify by error TYPE, NOT by where it threw. The
// decision was previously scattered — `if (err instanceof RangeError)` in ingest, `if (everConnected && isLive)` in
// three catch arms, `failFatal` calls all over, the WebCodecs self-heal in handleWcError. Now
// EVERY error routes through this ONE ladder so the policy lives in one testable place:
//
//   INTERNAL / programmer errors  → FATAL, NEVER reconnect.   (range-error, decode-internal,
//                                    codec-unsupported, demux, worker)
//   TRANSIENT network/EOF/silence → reconnect(backoff) on a live stream that already connected;
//                                    fatal on VOD or an initial-connect fault.
//   recoverable decode GLITCH     → recreateDecoder (rebuild + await keyframe, keep playing).
//   clean live boundary           → retry (immediate, seamless, no budget hit).
//
// THE corruption guard: a RangeError is the cross-realm stale-HEAPU8 hazard
// (a malloc'd pointer in a grown SAB throws `offset is out of bounds`). Misreading it as a network drop →
// a bogus reconnect that resumes the PERSISTENT demuxer mid-gap → a corruption flood. So `range-error`
// (and every internal cause) classifies FATAL here, structurally — it can never resolve to a reconnect.

import type { FerriteFailureKind } from '../errors';

/**
 * The error CAUSE, by TYPE. This is what the detection sites (ingest catch, the silence watchdog, the
 * stall watchdog, handleWcError) report — they keep their DETECTION; the ACTION is resolved HERE.
 */
export type ErrorCause =
  // ---- TRANSIENT (network / live ingest) ----
  | 'eof-boundary'      // live body ended having DELIVERED bytes — a clean connection boundary (not a fault)
  | 'empty-body'        // live body ended having delivered ZERO bytes (a server returning empty 200s → guard the hot-loop)
  | 'network-drop'      // fetch/read threw mid-stream (connection reset / abort)
  | 'http-status'       // a non-2xx response
  | 'connect-timeout'   // response headers never arrived within the connect deadline
  | 'upstream-silence'  // the adaptive silence watchdog fired (no bytes for mean+2σ while the socket stayed open)
  // ---- recoverable DECODE glitch / stall ----
  | 'decode-glitch'     // a transient decoder error AFTER healthy frames (WebCodecs self-heal)
  | 'decode-stall'      // the decode-stall watchdog: input queue rising while frames-out = 0
  // ---- INTERNAL / programmer errors (ALWAYS fatal) ----
  | 'range-error'       // a RangeError — the stale-HEAPU8 hazard; NEVER a network drop (the corruption guard)
  | 'decode-internal'   // a hard decoder error (get_buffer collapse / the demux/decode step returned an error)
  | 'codec-unsupported' // no decode tier can handle this codec (and no software fallback applies)
  | 'demux'             // container/PSI parse failure (unparseable stream)
  | 'worker';           // an opaque worker-script crash

export type ErrorActionKind = 'retry' | 'reconnect' | 'recreateDecoder' | 'fatal';

export interface ErrorAction {
  kind: ErrorActionKind;
  /** 'reconnect': which retry budget this draws on. hls.js FragmentLoadPolicy counts errors (6) and
   *  timeouts (4) on SEPARATE budgets — so a flaky connect-timeout source can't burn the error budget. */
  budget?: 'error' | 'timeout';
  /** 'fatal': the ferrite failure kind the FACADE maps to the verbatim mpegts (type, details, info) vocab
   *  (errors.ts). Classification stays DOM-free; the substring-contract mapping happens at the facade. */
  failure?: FerriteFailureKind;
  /** A human breadcrumb (logged, never parsed). */
  reason: string;
}

export interface ClassifyContext {
  /** A live EDGE to reconnect to (SourceCapabilities.hasLiveEdge = declaredLive && !bounded)? A bounded
   *  source (VOD, or a finite "live" body) NEVER reconnects — it seeks / EOFs instead, so a transient
   *  cause there is fatal. (Was `isLive`; renamed for the descriptor — reconnect keys on the live edge,
   *  not the raw intent bool, so a bounded declared-live stream correctly does NOT reconnect-storm.) */
  hasLiveEdge: boolean;
  /** Has the source EVER connected this load? An initial-connect fault is fatal (the stream never
   *  started); only a mid-stream drop on a live stream reconnects. Preserves the worker's everConnected
   *  gate, lifted verbatim into the classifier. */
  everConnected: boolean;
}

const fatal = (failure: FerriteFailureKind, reason: string): ErrorAction => ({ kind: 'fatal', failure, reason });
const reconnect = (budget: 'error' | 'timeout', reason: string): ErrorAction => ({ kind: 'reconnect', budget, reason });
const recreate = (reason: string): ErrorAction => ({ kind: 'recreateDecoder', reason });
const retry = (reason: string): ErrorAction => ({ kind: 'retry', reason });

/** A transient network cause reconnects ONLY on a live stream that already connected; otherwise it is a
 *  fatal initial-connect / VOD fault. The ONE place this gate lives (was duplicated across the catch arms). */
function transient(ctx: ClassifyContext, budget: 'error' | 'timeout', failure: FerriteFailureKind, reason: string): ErrorAction {
  return (ctx.hasLiveEdge && ctx.everConnected) ? reconnect(budget, reason) : fatal(failure, 'initial/VOD: ' + reason);
}

/**
 * THE single classify→action ladder. Pure: `(cause, ctx) → action`. The facade/worker then EXECUTES the
 * action (retry / scheduleReconnect+backoff / createWcDecoder / failFatal→teardown) — this only decides.
 */
export function classifyError(cause: ErrorCause, ctx: ClassifyContext): ErrorAction {
  switch (cause) {
    // ---- INTERNAL / programmer errors → ALWAYS fatal, NEVER reconnect (the corruption guard) ----
    case 'range-error':
      return fatal('worker', 'internal RangeError (stale HEAPU8 / our own glue threw) — NOT a network drop');
    case 'decode-internal':
      return fatal('decode', 'hard decoder error (get_buffer collapse / step error)');
    case 'codec-unsupported':
      return fatal('decode', 'no decode tier supports this codec');
    case 'demux':
      return fatal('demux', 'container/PSI parse failure');
    case 'worker':
      return fatal('worker', 'opaque worker crash');

    // ---- recoverable DECODE glitch / stall → rebuild the decoder, keep playing (no teardown, no reconnect) ----
    case 'decode-glitch':
      return recreate('transient decode error after healthy frames → recreate + await keyframe');
    case 'decode-stall':
      return recreate('decode stall (queue rising, frames-out 0) → recreate + await keyframe');

    // ---- clean live boundary → reconnect IMMEDIATELY (seamless, no error, no budget hit) ----
    case 'eof-boundary':
      return ctx.hasLiveEdge ? retry('clean live boundary (bytes delivered) → immediate seamless reconnect')
                             : fatal('early-eof', 'unexpected EOF boundary on a non-live stream');

    // ---- TRANSIENT network → reconnect(backoff) on a connected live stream, else fatal ----
    case 'connect-timeout':
      return transient(ctx, 'timeout', 'network', 'connect timeout');
    case 'http-status':
      return transient(ctx, 'error', 'network-status', 'HTTP error');
    case 'empty-body':
      return transient(ctx, 'error', 'network', 'body delivered zero bytes');
    case 'network-drop':
      return transient(ctx, 'error', 'network', 'connection dropped mid-stream');
    case 'upstream-silence':
      return transient(ctx, 'error', 'network', 'upstream silent (no bytes for mean+2σ) → reopen');
  }
}
