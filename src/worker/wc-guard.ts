// Pure, DOM-free decision helpers for the WebCodecs (hardware) LIVE video path. WebCodecs itself is
// browser-only (no headless VideoDecoder), so the DECISIONS are extracted here to be unit-testable on
// node. The worker keeps the I/O (VideoDecoder.
// decode/close, the watchdog timer, auCopy); these functions only DECIDE.
//
// THE BUG these guard against: the WC live path had NEITHER guard
// the software no-drop path has → the VideoDecoder over-filled (decode q → 314 ≈ 6.5 s backlog), STALLED
// (decodeFps 30→0), and a SOURCE reconnect loop (the WRONG remedy for a decoder stall) destroyed audio.
// These three mirror the software guards, one-for-one:
//
//   (a) wcShouldWaitFeed — back-pressure the demux when the decoder's OWN encoded queue is high
//       (`decodeQueueSize >= queueMax`), NEVER drop/shed (the shed-at-the-feed mistake). Gating on the in-worker,
//       self-draining queue (NOT a cross-worker in-flight ack) bounds the encoded queue + the video
//       latency AND cannot deadlock. wcParkWatchdog is the belt against a future re-latch.
//   (b) wcKeyframeGate — the WC analog of the software HOLD-pre-keyframe: never feed a delta to a fresh /
//       flushed decoder; HOLD until the next IDR.
//   (c) wcStallAction — a decoder stall (input queued, output frozen) → RECREATE the decoder (+ await
//       keyframe), NOT a source reconnect; fall back to software after N failed recreates.

/**
 * (a) FEED BACKPRESSURE. Should the pump WAIT (back-pressure the demux) instead of feeding the next AU?
 * Gate SOLELY on the ENCODED input queue (`VideoDecoder.decodeQueueSize`) ≥ `queueMax`: the decoder is
 * behind the feed (the decode-q→314 precursor); cap it small (single digits) so encoded latency stays tiny.
 *
 * WHY ONLY decodeQueueSize (deadlock fix). The earlier design ALSO parked on a present-ring
 * in-flight count (`wcInFlight >= wcRingCap`) tracked via a cross-worker `release.vf` ack. That ack is NOT
 * emitted on the steady-state draw path → `wcInFlight` climbed monotonically to the cap, the gate LATCHED
 * SHUT after ~1 s, the decode queue drained to 0, and a zero-queue park is INVISIBLE to the stall watchdog
 * (its `queue>0` guard) → permanent deadlock. The lesson: a feed gate must depend ONLY on a signal the
 * DECODER ITSELF drains. `decodeQueueSize` is exactly that — the instant the HW decoder decodes a chunk the
 * count drops and the gate re-opens, so this CANNOT deadlock (no cross-worker ack in the decision).
 *
 * The present ring stays bounded INDIRECTLY: the feed is held ≤ `queueMax` encoded-AUs ahead → the decoder
 * runs only ~that far ahead → the present ring tracks it. The present worker keeps its own drop-oldest as a
 * BELT for a transient burst (e.g. the startup reservoir draining faster than present draws); WAIT, never
 * shed at the feed (shedding is wrong here). `wcInFlight` is RETAINED purely as telemetry — nothing
 * blocks on it (see `wcParkWatchdog` for the defense-in-depth against any future gate re-latching).
 */
export function wcShouldWaitFeed(decodeQueueSize: number, queueMax: number): boolean {
  return decodeQueueSize >= queueMax;
}

/**
 * (a-belt) PARK WATCHDOG — defense-in-depth so no feed gate can EVER latch invisibly again. A feed-park that
 * outlives `watchdogMs` while the encoded queue is NOT actually at its ceiling (`decodeQueueSize < queueMax`)
 * is a park on some signal OTHER than the self-draining queue — exactly the deadlock class (the
 * pump parked on a cross-worker ack that never came, with an empty queue, blind to the stall watchdog).
 * Returning true forces the pump to break the wait and re-evaluate. With the decodeQueueSize-only gate this
 * can NEVER fire (the gate self-releases the moment the queue drains below `queueMax`), but it makes any
 * FUTURE gate change provably unable to wedge the pump for more than `watchdogMs`. A genuine queue-FULL park
 * (`decodeQueueSize >= queueMax`) is intentionally NOT broken here — that is the real backpressure / the
 * stall watchdog's domain (queue>0).
 */
export function wcParkWatchdog(parkedMs: number, decodeQueueSize: number, queueMax: number, watchdogMs: number): boolean {
  return parkedMs >= watchdogMs && decodeQueueSize < queueMax;
}

/**
 * (b) AWAIT-KEYFRAME HOLD state machine. Given the current HOLD state and whether THIS AU is a keyframe,
 * decide whether to FEED it and what the next HOLD state is. After every (re)create / flush / reconnect /
 * pause-resume the caller arms `awaitingKeyframe = true`; we then DROP deltas until the first IDR, feed
 * the IDR, and clear the HOLD. Never feeds a delta to a fresh / flushed decoder (the "Could not find ref"
 * / permastall trap — feeding reference-less deltas produces no output while the queue grows).
 */
export function wcKeyframeGate(awaitingKeyframe: boolean, isKey: boolean): { feed: boolean; awaitingKeyframe: boolean } {
  if (!awaitingKeyframe) return { feed: true, awaitingKeyframe: false }; // steady state — feed every AU
  if (isKey) return { feed: true, awaitingKeyframe: false };             // the IDR we were holding for
  return { feed: false, awaitingKeyframe: true };                        // still holding — drop this delta
}

// ---- (d) CAPABILITY PRE-DETECTION ------------------------------------------------------------------------
// We previously re-probed `VideoDecoder.isConfigSupported` PER PLAY (an async hop on the tier path).
// The fix: probe the representative codec
// FAMILIES once at init, cache the result keyed on family, and per-play map the stream's family → cache (a
// pure, synchronous lookup; NO async probe on the critical path). HW WebCodecs support is a property of the
// codec FAMILY + bit-depth, not the exact profile/level — so one representative string per family suffices.
//
// CARVE-OUT: interlacing is NOT part of this cache. It is read per-stream from the SPS (`frame_mbs_only`)
// and is the software-deint route — gated per-stream by `webCodecsEligible` UPSTREAM of this lookup, never
// predetected. Only the async capability probe is what gets cached; the per-play codec/profile/bit-depth
// reads stay synchronous-from-demux. A bare codec string is probed (no `description`): a length-prefixed
// VOD config the bare probe over-accepts is caught authoritatively by the decoder's configure() throw →
// software fallback (the real gate; isConfigSupported was always advisory).

/** The WebCodecs capability families the init probe pre-detects. */
export type WcFamily = 'h264' | 'hevc-main' | 'hevc-main10';

/** A representative codec string per family — probed ONCE at init to fill the capability cache. */
export const WC_PROBE_CODECS: Record<WcFamily, string> = {
  'h264': 'avc1.640028',        // H.264 High@4.0 — covers the common H.264 profiles
  'hevc-main': 'hev1.1.6.L153.B0',   // HEVC Main, 8-bit
  'hevc-main10': 'hev1.2.4.L153.B0', // HEVC Main10, 10-bit
};

/** Map a resolved WC codec string to its capability family, or null when it has no WC family (e.g. MPEG-2
 *  → '' ). Keys on family + bit-depth (HEVC profile byte: `.2` = Main10/10-bit, `.1` = Main/8-bit), NOT the
 *  exact level. Interlacing is deliberately NOT considered here — it's gated per-stream upstream. */
export function wcFamilyOf(codec: string): WcFamily | null {
  if (codec.startsWith('avc1.') || codec.startsWith('avc3.')) return 'h264';
  if (codec.startsWith('hev1.2') || codec.startsWith('hvc1.2')) return 'hevc-main10';
  if (codec.startsWith('hev1.1') || codec.startsWith('hvc1.1')) return 'hevc-main';
  return null;
}

/** Resolve the cached capability for a stream codec string (the per-play tier lookup — pure, synchronous,
 *  no probe). An unmapped family OR an unprobed/missing cache entry → false → fall back to software; NEVER
 *  assume supported for an unknown codec. */
export function wcCapabilityCached(codec: string, cache: Partial<Record<WcFamily, boolean>>): boolean {
  const fam = wcFamilyOf(codec);
  return fam !== null && cache[fam] === true;
}

export type WcStallAction = 'none' | 'recreate' | 'fallback';

/**
 * (c) DECODE-STALL RECOVERY ROUTING. A WC decoder stall = INPUT is queued (`decodeQueueSize > 0`) yet
 * OUTPUT is frozen (no frame for ≥ `stallMs`) while we are NOT legitimately holding for the first keyframe
 * (`awaitingKeyframe`). The remedy is to RESET THE DECODER (recreate + await keyframe), NOT to reconnect
 * the SOURCE — a source reconnect never clears the wedged decoder and its churn destroys audio (THE bug).
 * After `maxRecreates` failed recreates the hardware tier genuinely can't sustain this stream → fall back
 * to software (mirrors the `webCodecsEligible` fallback) rather than wedge forever.
 */
export function wcStallAction(args: {
  configured: boolean;        // a decoder exists and is configured
  decodeQueueSize: number;    // encoded input queued (waiting to decode)
  msSinceOutput: number;      // wall ms since the last decoded frame (or since the decoder was (re)created)
  awaitingKeyframe: boolean;  // legitimately holding for the first IDR → output isn't expected yet
  stallMs: number;            // the no-output threshold
  recreates: number;          // stall-recreates already attempted without recovery
  maxRecreates: number;       // budget before falling back to software
}): WcStallAction {
  const { configured, decodeQueueSize, msSinceOutput, awaitingKeyframe, stallMs, recreates, maxRecreates } = args;
  if (!configured || awaitingKeyframe) return 'none'; // no decoder, or legitimately pre-roll → not a stall
  if (decodeQueueSize <= 0) return 'none';            // nothing queued → no output expected → not stalled
  if (msSinceOutput < stallMs) return 'none';         // within the grace window
  return recreates >= maxRecreates ? 'fallback' : 'recreate';
}
