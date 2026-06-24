// SourceCapabilities — the SINGLE source-policy descriptor (LIVE/VOD UNIFICATION, Tier 1). The player is
// ONE engine (decode/present/clock/tier/degrade shared); the live/VOD split is a thin policy band that
// used to live as ~8 scattered `isLive` forks across the worker, controller, and facade. This descriptor
// REPLACES that scattered bool: it is computed ONCE at open from TWO zero-cost inputs and the 8 forks read
// its fields. NO probe, NO HEAD, NO Range-0-0 sniff, NO transport change — and a plain struct + pure
// function (no DOM / no platform deps), so it is headless-testable.
//
// The two inputs:
//   1. the caller's DECLARED intent — `createPlayer({isLive})` (free + authoritative; the portal catalog
//      already classified live-vs-VOD). This is the PRIMARY input and is known at the open boundary.
//   2. the headers of the FIRST response we ALREADY fetch (no extra round-trip) — Accept-Ranges/a 206
//      ⇒ seekable, a known Content-Length/total ⇒ bounded. This REFINES the intent-only defaults once the
//      response is in hand (live onConnect / VOD HttpSource.open).
//
// Known-path parity is the bar: a live MPEG-TS channel (no Range ⇒ seekable=false, unbounded ⇒
// hasLiveEdge=true) and a VOD file (Range ⇒ seekable=true, bounded ⇒ hasLiveEdge=false) behave EXACTLY as
// the old bool did. The only NEW behaviour is the edge cases now handled correctly (the bonus): a
// declared-VOD source with no Accept-Ranges ⇒ seekable=false (seekbar hidden, recovery still works); a
// declared-live source that serves ranges (timeshift) ⇒ seekable=true (seekbar shown).

/** The source-policy descriptor — computed ONCE at open, read by every live/VOD fork. Plain struct. */
export interface SourceCapabilities {
  /** Range/seek support — from `Accept-Ranges: bytes` OR a 206 on the first response (absent ⇒ false).
   *  Drives seek(), the seekbar/duration, recovery-by-offset. */
  seekable: boolean;
  /** Finite length — a known Content-Length/total on a non-chunked response. Drives EOF = clean-end
   *  (bounded) vs early-EOF/reconnect. */
  bounded: boolean;
  /** A live edge to chase/reconnect-to — `declaredLive && !bounded`. Drives catch-up/live latency-sync,
   *  reconnect-on-drop, await-keyframe on resume, and the silence watchdog's reconnect semantics. */
  hasLiveEdge: boolean;
  /** The caller's DECLARED intent (createPlayer({isLive})). The transport/ingest choice (push vs the
   *  Range-AVIO pull) and the decoder-init build-from-demux fork key on this — they must be decided at the
   *  open boundary BEFORE any response is in hand, so they cannot wait for the header refine. */
  declaredLive: boolean;
}

/** The first-response header facts the descriptor refines from — a tiny DOM-free subset (no Response /
 *  Headers object crosses this seam). Omitted ⇒ intent-only derivation. */
export interface ResponseFacts {
  /** `Accept-Ranges: bytes` present OR the response was a 206 partial. */
  acceptRanges: boolean;
  /** A finite content length / total size is known (Content-Length on a non-chunked body, or a 206's
   *  Content-Range total). */
  hasContentLength: boolean;
}

/**
 * Derive the descriptor from the declared intent (primary) refined by the first-response headers (when in
 * hand). Pure — the SAME function runs on main (intent-only, at load, for immediate known-path behaviour)
 * and in the worker (refined, once the first response lands).
 *
 * Intent-only (no facts yet): live ⇒ {seekable:false, bounded:false, hasLiveEdge:true}; VOD ⇒
 * {seekable:true, bounded:true, hasLiveEdge:false} — the byte-identical defaults for the known paths.
 * With facts: seekable/bounded come from the headers; hasLiveEdge = declaredLive && !bounded.
 */
export function deriveCapabilities(declaredLive: boolean, facts?: ResponseFacts | null): SourceCapabilities {
  const seekable = facts ? facts.acceptRanges : !declaredLive;
  const bounded = facts ? facts.hasContentLength : !declaredLive;
  const hasLiveEdge = declaredLive && !bounded;
  return { seekable, bounded, hasLiveEdge, declaredLive };
}
