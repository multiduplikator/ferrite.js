// Pure player policy.
//
// DOM-free + side-effect-free, so it node-imports (erasable TS) and is unit-tested in
// facade_test.mjs. Four policies live here:
//   adaptive demux-ring low-water + read-ahead   (adaptive_low_water / adaptive_read_ahead)
//   compressed packet-ring readahead depth        (LIVE/VOD_READAHEAD_MS + the ring SAB/ceiling consts)
//   iOS-aware WebCodecs present-ring cap          (wc_ring_cap_for_platform)
//   early-EOF reconnect backoff                   (hls.js FragmentLoadPolicy)
//
// The reference consts are inlined as defaults in config.ts (the declared knobs); these fns take the
// resolved values as PARAMETERS so the Config knobs actually drive them (the reference policy
// hardcodes consts because its engine has no per-instance config surface). (We do NOT chase live
// latency by changing playback rate — exactly like mpv; there is no playback-rate-chaser policy.)

// ---------------------------------------------------------------------------
// adaptive demux-ring low-water.
//
// The decode worker must hold ≥ one COMPLETE video PES in the demux ring before each demux_step or
// mpegts flushes a truncated frame on the underrun (keyframe→freeze, ref→blocking). The historical
// fix was a FIXED 2 MiB low-water sized for the worst-case 4K full-PES — but 2 MiB of standing buffer
// is ≈0.8 s @ 20 Mbps yet ≈8 s @ 2 Mbps, so the fixed floor injects seconds of needless live latency
// on SD/HD. The adaptive low-water sizes to the largest video PES ACTUALLY observed, so SD/HD run a
// tight buffer (low live latency) while 4K keeps the full-PES correctness floor.
// ---------------------------------------------------------------------------

/** Smallest low-water we ever gate at (the low-water floor) — covers a small SD PES + TS
 *  framing. Used as the config `stashInitialSize` default (undefined ⇒ this). */
export const LOW_WATER_DEFAULT_FLOOR = 256 * 1024;
/** Low-water CEILING / historical fixed value (the low-water ceiling). The config `stashMaxSize`
 *  default; the adaptive low-water never exceeds it, so 4K behaviour is identical to the pre-adaptive fixed low-water. */
export const LOW_WATER_DEFAULT_CEILING = 2 * 1024 * 1024;
/** Headroom over the largest observed PES (×2 → tolerates a PES up to twice the running peak, e.g. a
 *  scene-cut keyframe, without underrunning). The PES factor. */
const LOW_WATER_PES_FACTOR = 2;
/** Additive slack on top of the factored peak (TS packetization overhead + margin). The margin. */
const LOW_WATER_PES_MARGIN = 64 * 1024;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Size the demux-ring low-water to the largest video PES seen so far.
 *
 * Until the first video keyframe (`warmedUp === false`) hold the full `ceiling`: the first keyframe is
 * the largest PES of its GOP and a startup underrun would lose it (and the decoder needs that IDR), so
 * warmup is the safe default = the pre-adaptive fixed behaviour. Once warmed, `peakPes·FACTOR + MARGIN` gives
 * 2× headroom over the largest observed PES, clamped into `[floor, ceiling]`.
 *
 * INVARIANT (PES-completeness): for any `peak ≤ ceiling` the result is `≥ peak`, so a PES of the
 * observed-peak size always fits in the ring before stepping → the gate never admits a partial-PES
 * step. A PES suddenly exceeding 2× the running peak (rare: scene cut / resolution-up seam) can
 * underrun ONCE and lose a single frame; the caller's running-max `peak` then self-heals on the next
 * keyframe — no worse than the brief disruption of the seam itself. This is the 4K-HEVC PES floor.
 */
export function adaptiveLowWater(peakPes: number, warmedUp: boolean, floor: number, ceiling: number): number {
  if (!warmedUp) return ceiling;
  return clamp(peakPes * LOW_WATER_PES_FACTOR + LOW_WATER_PES_MARGIN, floor, ceiling);
}

/**
 * Read-ahead derived from the live low-water: keep the reader queue at 2×
 * the ring target (the historical 2 MiB : 4 MiB ratio at the ceiling) so shrinking the low-water also
 * shrinks the in-flight queued bytes — otherwise the saved latency just migrates into the queue.
 * Always `> lowWater` (so the reader can fill the ring past the gate) and `≤ ceiling`.
 */
export function adaptiveReadAhead(lowWater: number, ceiling: number): number {
  return Math.min(lowWater * 2, ceiling);
}

// ---------------------------------------------------------------------------
// compressed packet-ring readahead depth (mpv demuxer-readahead / streaming cache).
//
// mpv parks the live-latency resilience in the COMPRESSED demuxer read-ahead, NOT in decoded buffers: the
// vd/ad decoded async queues are off by default (`use_queue=false`), so the only deep buffer is the
// demuxer's parsed-packet read-ahead. For a streaming source mpv sets
// `min_secs = max(1.0, cache-secs=3600s)` bounded by `demuxer-max-bytes = 150 MiB` (mpv demux.c)
// — i.e. "buffer as many seconds as fit in 150 MiB". The decoded side stays tiny (~0.2 s AO buffer;
// a 2–3 frame VO window, mpv video.c get_req_frames).
//
// Ferrite's packet rings ARE that parsed-packet read-ahead. A shallow (~1 s) depth would let the audio
// packet ring empty on any decode/present dip under the player-serve real-time backpressure, satisfying
// the cache-pause AND-gate (decoded PCM < 0.06 s && packets_empty) → audio freezes. A seconds-deep cushion
// keeps the ring NON-empty through a dip so the audio decoder rides it and cache-pause never trips. It adds
// NO heard-audio latency: the cushion sits AHEAD in the demux and is decoded just-in-time — the decoded PCM
// depth (AUDIO_RING_SECONDS) alone sets latency.
//
// FORCED DEVIATION from mpv's single shared 150 MiB pool: the split-realm SPSC SAB design has one ring PER
// stream (no cross-stream donation across worker realms), and a browser tab's SAB RAM is tighter than a
// desktop heap. So each pool is bounded independently (video ~4 s/32 MiB, audio ~4 s/512 KiB) rather than
// sharing 150 MiB. 4 s is deep enough to absorb the dips a 1 s cushion cannot.
// (iOS memory headroom for the larger video SAB is a separate validation item.)
// ---------------------------------------------------------------------------

/** LIVE packet-ring read-ahead — a seconds-deep cushion (mpv streaming-cache override) so a decode/present
 *  dip can never empty a ring and trip the audio cache-pause. */
export const LIVE_READAHEAD_MS = 4000;
/** VOD packet-ring read-ahead — mpv local-file `demuxer-readahead-secs = 1.0` floor (the VOD path is
 *  Range-seekable, so it re-pulls rather than starves; kept at the mpv local default for now). */
export const VOD_READAHEAD_MS = 1000;
/** Video packet-ring SAB allocation (bytes). Holds a multi-MB 4K-HEVC IDR PES + ~4 s of compressed
 *  read-ahead; sized above the fill ceiling so the non-blocking route can never overflow the ring. */
export const VIDEO_RING_SAB_BYTES = 32 * 1024 * 1024;
/** Video packet-ring fill ceiling — must stay below the SAB (≥ one 4K IDR PES of headroom). */
export const VIDEO_RING_CEIL_BYTES = 28 * 1024 * 1024;
/** Audio packet-ring SAB allocation (bytes). Audio AUs are KBs; 512 KiB holds several seconds of EAC3 5.1. */
export const AUDIO_RING_SAB_BYTES = 512 * 1024;
/** Audio packet-ring fill ceiling — must stay below the SAB. */
export const AUDIO_RING_CEIL_BYTES = 448 * 1024;

// ---------------------------------------------------------------------------
// iOS-aware WebCodecs present-ring cap (in-flight VideoFrame budget).
//
// The WebCodecs (hardware) tier has no credit model: its async decoder emits frames in BURSTS, so the
// main-thread present ring needs a deep cushion to pace smoothly (a later change raised it 52→120). But every
// un-presented VideoFrame in that ring PINS a GPU surface / decoder-pool slot, and iOS/iPadOS-WebKit
// (VideoToolbox) caps that budget FAR harder than desktop Chrome. 120 pinned surfaces is fine on
// desktop, plausibly fatal on iOS — "fast burst then freeze," then the wedged decoder poisons the next
// stream (project_player_field_issues #3/#4). So the cap is platform-aware: a tight ring on iOS bounds
// the pinned-surface count (~0.5 s @ 50 fps cushion) while desktop keeps the deep burst cushion. A host
// can override either via config (wcPresentRingCap) to tune during the iPad triage pass.
// ---------------------------------------------------------------------------

/** Desktop WebCodecs present-ring cap (the deep burst cushion for the async HW decoder). */
export const WC_RING_CAP_DEFAULT = 120;
/** iOS/iPadOS WebCodecs present-ring cap — tight, to bound pinned GPU surfaces / decoder-pool slots
 *  (the leading iPad-wedge cause). ~0.5 s of cushion at 50 fps; drop-oldest-while-playing keeps it at
 *  the live edge. Deliberately conservative: under-cushioning on iOS is a recoverable stutter, over-
 *  pinning is the unrecoverable freeze+poison we are fixing. */
export const WC_RING_CAP_IOS = 24;

/**
 * Resolve the WebCodecs present-ring cap for the platform. A host `override` (config.wcPresentRingCap)
 * wins when set (floored at 4 so the ring can never collapse to nothing); otherwise iOS gets the tight
 * cap and every other platform the deep desktop cushion.
 */
export function wcRingCapForPlatform(isIOS: boolean, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(4, Math.floor(override));
  }
  return isIOS ? WC_RING_CAP_IOS : WC_RING_CAP_DEFAULT;
}

// ---------------------------------------------------------------------------
// early-EOF reconnect backoff (hls.js FragmentLoadPolicy).
//
// The reference player relies on its own server's reconnect (it fetches from its own server, which
// already reconnects upstream) so it has NO equivalent; this is implemented fresh from mpegts.js's
// io-controller "reconnect from last byte" mechanism + hls.js's backoff curve. A live truncation /
// dropped connection reconnects with exponential backoff and resumes (the demux/decode treat the gap
// as a seam); only when the budget is exhausted do we surface the fatal UnrecoverableEarlyEof.
// ---------------------------------------------------------------------------

/** hls.js FragmentLoadPolicy errorRetry.maxNumRetry. */
export const RECONNECT_MAX_ERROR_RETRY = 6;
/** hls.js FragmentLoadPolicy timeoutRetry.maxNumRetry (timeouts counted separately from errors). */
export const RECONNECT_MAX_TIMEOUT_RETRY = 4;
/** hls.js retryDelayMs (first backoff). */
export const RECONNECT_DELAY_MS = 1000;
/** hls.js maxRetryDelayMs (backoff ceiling). */
export const RECONNECT_MAX_DELAY_MS = 8000;
/** Per-attempt CONNECT timeout (ms) → a ConnectingTimeout counted on the timeout budget. 16 s: a portal
 *  stream (upstream provisioning / MAC rotation) can take 10-15 s to deliver its first byte, and a shorter
 *  deadline aborts a stream that would have come up. */
export const CONNECT_TIMEOUT_MS = 16000;
/** FIX 3 — eof-boundary floor (bytes). A clean live close that delivered at least this much (~one
 *  PES/GOP) is a real connection boundary → seamless 0ms retry. Below it (a trickle-then-close), the
 *  close is treated as `empty-body` → a BUDGETED reconnect, so a degenerate server can't hot-loop. */
export const EOF_BOUNDARY_MIN_BYTES = 64 * 1024;
/** FIX 3 — eof-boundary floor (ms). OR-ed with the byte floor: a close after a connection that LASTED
 *  at least this long also counts as a real boundary even if its last attempt delivered few bytes. */
export const EOF_BOUNDARY_MIN_MS = 1000;

/**
 * Exponential backoff delay (ms) for reconnect `attempt` (0-based), capped at `max` (hls.js
 * getRetryDelay exponential form). attempt 0→base, 1→2·base, … saturating at `max`:
 * with the defaults: 1000, 2000, 4000, 8000, 8000, 8000.
 */
export function reconnectDelayMs(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, attempt), max);
}
