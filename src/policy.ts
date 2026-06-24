// Pure player policy.
//
// DOM-free + side-effect-free, so it node-imports (erasable TS) and is unit-tested in
// facade_test.mjs. Three policies live here:
//   adaptive demux-ring low-water + read-ahead   (adaptive_low_water / adaptive_read_ahead)
//   live latency-sync playback rate + target      (live_sync_rate / live_sync_target)
//   early-EOF reconnect backoff                   (hls.js FragmentLoadPolicy)
//
// The reference consts are inlined as defaults in config.ts (the declared knobs); these fns take the
// resolved values as PARAMETERS so the Config knobs actually drive them (the reference policy
// hardcodes consts because its engine has no per-instance config surface).

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
// live latency-sync.
//
// The adaptive low-water minimised the STRUCTURAL floor (the demux ring). Live latency-sync chases the
// VARIABLE latency that accumulates ABOVE it over a long live session — bursty-CDN delivery + post-stall
// refills push extra already-decoded media into the playout reservoir (audio scheduled ahead of the play
// cursor), so the playhead drifts behind the live edge. It speeds the master (audio) clock up by a small, bounded factor while
// the reservoir is above target; BOTH present tiers pace to that same audio master clock, so wiring the
// rate at the single audio master latency-syncs both tiers with no per-tier code.
//
// Policy mirrors hls.js latency-controller (NOT mpegts.js's discrete 3-state chaser):
//   * a CONTINUOUS SIGMOID rate curve (gentle near 1.0, saturating at the ceiling),
//   * a DEAD-BAND around target (no nudge for tiny errors → anti-hunting),
//   * a forward-buffer GATE (never speed up into an underrun),
//   * relax-target-on-stall (each stall raises the target → stop chasing into repeated underruns).
// ferrite owns WebAudio (no free <video>.playbackRate pitch correction) → applied as
// AudioBufferSourceNode.playbackRate; the ceiling is kept LOW (1.05× ≈ +85 cents, sub-audible).
// ---------------------------------------------------------------------------

/** Per-stall target relaxation (s): each underrun raises the target so we converge to a SAFER latency
 *  on a jittery source instead of chasing back into the same stall (hls.js liveSyncOnStallIncrease).
 *  the stall-relax constant. */
export const LIVE_SYNC_STALL_RELAX_SECS = 0.3;
/** Rate quantisation step (LIVE_SYNC_RATE_QUANTUM = 100 → 0.01 steps). */
const LIVE_SYNC_RATE_QUANTUM = 100;

/**
 * Target latency relaxed by the observed stall count. Each stall raises the
 * target by [`LIVE_SYNC_STALL_RELAX_SECS`], capped at `maxTarget` (the config `liveSyncMaxLatency`).
 */
export function liveSyncTarget(stallCount: number, base: number, maxTarget: number): number {
  return Math.min(base + stallCount * LIVE_SYNC_STALL_RELAX_SECS, maxTarget);
}

/**
 * The live-sync playback rate for the master clock, in `[1.0, maxRate]`.
 *
 * `latency` = how far behind the live edge we are (master-clock buffer ahead of the play cursor, s).
 * `fwdBuffer` = the COMMITTED forward buffer protecting against underrun (s). `forceUnity` pins the
 * rate to 1.0 for the caller-owned edge cases (seam until re-anchored, pause/resume resync, hidden tab,
 * non-live, startup). Returns exactly 1.0 (never below) → only ever speeds playback up toward the live
 * edge, never slows it down.
 *
 * Anti-hunting: a nudge requires BOTH `latency − target > deadband` AND `fwdBuffer > gate`. The curve is
 * `2 / (1 + e^(−k·distance))` (1.0 at distance 0, → 2 as distance → ∞), quantised + clamped to the
 * ceiling — monotonic non-decreasing in `latency`.
 */
export function liveSyncRate(
  latency: number,
  target: number,
  fwdBuffer: number,
  forceUnity: boolean,
  maxRate: number,
  deadband: number,
  gate: number,
  sigmoidK: number,
): number {
  if (forceUnity || !Number.isFinite(latency)) return 1.0;
  const distance = latency - target;
  if (distance <= deadband || fwdBuffer <= gate) return 1.0;
  const max = clamp(maxRate, 1.0, 2.0);
  const sigmoid = 2.0 / (1.0 + Math.exp(-sigmoidK * distance));
  const rate = Math.round(sigmoid * LIVE_SYNC_RATE_QUANTUM) / LIVE_SYNC_RATE_QUANTUM;
  return clamp(rate, 1.0, max);
}

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
/** Per-attempt CONNECT timeout (ms) → a ConnectingTimeout counted on the timeout budget. */
export const CONNECT_TIMEOUT_MS = 8000;
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
