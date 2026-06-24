// mpegts.js-compatible error vocabulary + the ferrite→mpegts mapping.
//
// WHY this file exists: a typical host's `classifyMpegTsPlaybackIssue` (its ERROR handler)
// does a LOWERCASED SUBSTRING match on `type` + `details` + `info` — NOT enum equality.
// So as long as the facade emits the VERBATIM mpegts `ErrorTypes`/`ErrorDetails` strings,
// the host buckets ferrite's failures unchanged. This module is DOM-free and portable.
//
// String values mirror mpegts.js v1.8.0:
//   ErrorTypes   — src/player/player-errors.js:22-26
//   LoaderErrors — src/io/loader.js
//   ErrorDetails — player-errors.js:28-39 + demux-errors.js

/** mpegts `ErrorTypes` — the FIRST argument of the host's ERROR callback. */
export const ErrorTypes = {
  NETWORK_ERROR: 'NetworkError',
  MEDIA_ERROR: 'MediaError',
  OTHER_ERROR: 'OtherError',
} as const;

/** mpegts `LoaderErrors` — exposed on the namespace for parity (host reads it via ErrorDetails). */
export const LoaderErrors = {
  OK: 'OK',
  EXCEPTION: 'Exception',
  HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid',
  CONNECTING_TIMEOUT: 'ConnectingTimeout',
  EARLY_EOF: 'EarlyEof',
  UNRECOVERABLE_EARLY_EOF: 'UnrecoverableEarlyEof',
} as const;

/** mpegts `ErrorDetails` — the SECOND argument of the host's ERROR callback. */
export const ErrorDetails = {
  NETWORK_EXCEPTION: LoaderErrors.EXCEPTION,
  NETWORK_STATUS_CODE_INVALID: LoaderErrors.HTTP_STATUS_CODE_INVALID,
  NETWORK_TIMEOUT: LoaderErrors.CONNECTING_TIMEOUT,
  NETWORK_UNRECOVERABLE_EARLY_EOF: LoaderErrors.UNRECOVERABLE_EARLY_EOF,
  // RECOVERABLE early-EOF: emitted non-fatal DURING reconnect retries (vs the fatal
  // UnrecoverableEarlyEof emitted only once the retry budget is exhausted).
  NETWORK_EARLY_EOF: LoaderErrors.EARLY_EOF,
  MEDIA_MSE_ERROR: 'MediaMSEError',
  MEDIA_FORMAT_ERROR: 'FormatError',
  MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported',
  MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported',
} as const;

export type ErrorType = (typeof ErrorTypes)[keyof typeof ErrorTypes];

/** The THIRD argument of the host's ERROR callback — `{code, msg}` (stringified by the host). */
export interface ErrorInfo {
  code: number;
  msg: string;
  /** hls.js graft: recoverable? (facade-internal; host JSON.stringifies info, extra field is harmless). */
  fatal: boolean;
}

/** What the facade emits on `Events.ERROR`, in `(type, details, info)` positional form. */
export interface FerriteError {
  type: ErrorType;
  details: string;
  info: ErrorInfo;
}

/**
 * Internal ferrite failure modes (worker → facade). The facade maps these onto the verbatim
 * mpegts strings so the host classifier (substring match) buckets them as intended:
 *   not-isolated   → unsupported-codec      (no SharedArrayBuffer → can't run the decoder)
 *   engine-load    → media-decode-error     (wasm/engine init failed)
 *   network-status → network-error          (HTTP non-2xx)
 *   network        → network-error          (fetch threw / connection dropped)
 *   early-eof-recoverable → media-decode-error (live drop, NON-fatal, mid-reconnect; row 1 earlyeof)
 *   early-eof      → media-decode-error      (live stream truncated, reconnect exhausted; row 1 earlyeof)
 *   demux          → unsupported-container   (container/PSI parse failure)
 *   decode         → media-decode-error      (decoder produced a hard error)
 *   worker         → unknown-playback-error  (worker script crash — genuinely opaque)
 */
export type FerriteFailureKind =
  | 'not-isolated'
  | 'engine-load'
  | 'network-status'
  | 'network'
  | 'early-eof-recoverable'
  | 'early-eof'
  | 'demux'
  | 'decode'
  | 'worker';

/**
 * Map a ferrite failure to the mpegts `(type, details, info)` triple the host classifier
 * understands. `code` is an HTTP status for `network-status`, else a small internal code.
 *
 * The bucket each row lands in (per the classifier decision order) is asserted in
 * facade_test.mjs against a faithful replica of `classifyMpegTsPlaybackIssue`.
 */
export function mapFerriteError(
  kind: FerriteFailureKind,
  code: number,
  msg: string,
  fatal = true,
): FerriteError {
  const T = ErrorTypes;
  const D = ErrorDetails;
  switch (kind) {
    case 'not-isolated':
      // No crossOriginIsolated → no SharedArrayBuffer → the software decoder cannot run.
      // Emit unsupported-codec so the host offers the external-player fallback with a real
      // message (degrade gracefully when no secure context is available).
      return err(T.MEDIA_ERROR, D.MEDIA_CODEC_UNSUPPORTED, code, msg, fatal);
    case 'engine-load':
      // wasm/engine init failed for some other reason → generic decode-path death.
      // 'EngineInitFailed' carries no classifier keyword → falls to type-includes-'media'.
      return err(T.MEDIA_ERROR, 'EngineInitFailed', code, msg, fatal);
    case 'network-status':
      return err(T.NETWORK_ERROR, D.NETWORK_STATUS_CODE_INVALID, code, msg, fatal);
    case 'network':
      return err(T.NETWORK_ERROR, D.NETWORK_EXCEPTION, code, msg, fatal);
    case 'early-eof-recoverable':
      // A recoverable EarlyEof (NON-fatal). CURRENTLY UNUSED as an emitted ERROR: the worker routes
      // in-flight reconnects through a `log` breadcrumb + the `recovered` message instead, so a
      // self-healing live-connection blip never surfaces as an Events.ERROR (and never trips a host
      // classifier). Kept as a valid mpegts-vocab mapping for future host-signalling if wanted.
      return err(T.NETWORK_ERROR, D.NETWORK_EARLY_EOF, code, msg, fatal);
    case 'early-eof':
      // Reconnect budget EXHAUSTED → Unrecoverable, fatal. (recover() can still re-load from the edge.)
      return err(T.NETWORK_ERROR, D.NETWORK_UNRECOVERABLE_EARLY_EOF, code, msg, fatal);
    case 'demux':
      return err(T.MEDIA_ERROR, D.MEDIA_FORMAT_ERROR, code, msg, fatal);
    case 'decode':
      // 'DecodeError' carries no classifier keyword → type-includes-'media' → media-decode-error.
      return err(T.MEDIA_ERROR, 'DecodeError', code, msg, fatal);
    case 'worker':
      // Keyword-free details so the classifier deterministically falls to row 6 (unknown):
      // 'WorkerException' has no earlyeof/network/codec/format/mse substring, and OtherError
      // has no 'media'. (Do NOT reuse NETWORK_EXCEPTION — it would mis-bucket on a network-ish
      // worker message.)
      return err(T.OTHER_ERROR, 'WorkerException', code, msg, fatal);
  }
}

function err(type: ErrorType, details: string, code: number, msg: string, fatal: boolean): FerriteError {
  return { type, details, info: { code, msg, fatal } };
}
