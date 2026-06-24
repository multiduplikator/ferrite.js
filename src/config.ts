// ferrite-player Config — mpegts.js vocabulary + ferrite-extension knobs.
//
// SCOPE NOTE: a typical host reads NONE of these — they are facade-internal config. They are
// declared + validated + stored, and wired into the decode loop / master clock:
//   adaptive low-water       → `stashInitialSize` floor + `stashMaxSize` ceiling + `stashAdaptive`
//                              → posted on `init`; the worker sizes liveLowWater/liveReadAhead.
//   live latency-sync        → `liveSync` + `liveSyncTargetLatency`/`liveSyncMaxLatency` +
//                              `liveSyncPlaybackRate` (1.05, NOT liveBufferLatencyChasing) + the
//                              ferrite-ext anti-hunt knobs (deadband/gate/sigmoid) → applied at the
//                              AudioBufferSourceNode.playbackRate master clock (index.ts playAudio).
// `liveBufferLatencyChasing` stays declared-OFF (the rejected discrete chaser). The pure policy fns
// (policy.ts) read these knobs as parameters.
//
// DOM-free and portable. Defaults mirror mpegts.js v1.8.0
// (src/config.js:19-61) EXCEPT where ferrite intentionally diverges (noted inline).

export interface FerriteConfig {
  // --- ferrite engine (no mpegts equivalent) ---
  /** Base URL serving ferrite.mjs + ferrite.wasm (same-origin, COOP/COEP). */
  wasmBaseUrl: string;
  /** Override the decode-worker URL. Defaults to the `worker.js` shipped beside this module
   *  (resolved via `import.meta.url`). Set this only for an unusual asset layout or a strict CSP. */
  workerUrl?: string | URL;
  /** Override the present-worker URL (the split-realm OffscreenCanvas presenter). Defaults to the
   *  `present-worker.js` shipped beside this module. Set only for an unusual asset layout / strict CSP. */
  presentWorkerUrl?: string | URL;
  /** SW FFmpeg decoder thread count (frame+slice threads). `'auto'` (the default) is the
   *  host-adaptive resolution `clamp(navigator.hardwareConcurrency − 2, 2, 8)` — resolved at the
   *  player-creation boundary (index.ts, where `navigator` is reliable) via {@link resolveThreadCount}.
   *  A numeric value is an EXPLICIT override and is honoured verbatim (a consumer's choice wins). */
  threads: number | 'auto';
  /** Prefer hardware WebCodecs for codecs it supports. */
  preferWebCodecs: boolean;
  /** Override the WebCodecs present-ring cap (in-flight VideoFrame budget).
   *  undefined ⇒ platform default (iOS tight ~24 to bound pinned GPU surfaces, desktop deep ~120 for
   *  burst smoothing). Set to tune the iPad-wedge triage; floored at 4. Software tier is unaffected. */
  wcPresentRingCap?: number;

  // --- SMOOTHNESS ISOLATION KNOBS (pure experiment; every default = current behaviour) -------------
  // A/B which mechanism causes the buffer-empties-→-stutter on the SOFTWARE tier (held drains to 1 →
  // present starves). NO production change unless a knob is set. Resolved once + logged on load().
  /** `?ring=N` — the SOFTWARE in-flight / credit-pool cap (= the present-ring cushion depth, the memory
   *  bound). undefined ⇒ the resolved platform default (RING_CAP=12 desktop, RING_CAP_IOS=6 on iOS to keep
   *  the held heap-backed frames inside the iPad budget under a ?flood burst). The present worker accepts
   *  this + a small transit headroom. Floored at 1 (kept comfortably under the engine HELD_CAP=64 so a hold
   *  never starves). WC-tier unaffected (it has wcPresentRingCap). */
  swPresentRingCap?: number;

  // --- mpegts stash / buffer (adaptive low-water) ---
  /** mpegts: keep the pre-demux stash on. Ferrite's pre-demux low-water IS the stash. */
  enableStashBuffer: boolean;
  /** Low-water FLOOR in bytes (adaptive sizing rises toward `stashMaxSize`). undefined ⇒ engine default. */
  stashInitialSize: number | undefined;
  /** ferrite-ext: adaptive low-water CEILING in bytes (the 4K-HEVC full-PES correctness floor). */
  stashMaxSize: number;
  /** ferrite-ext: size the low-water to observed PES/throughput between floor and ceiling. */
  stashAdaptive: boolean;

  // --- mpegts live ---
  /** Live stream (no seekable end). Gates live latency-sync + the early-EOF-vs-clean-end decision. */
  isLive: boolean;

  // --- live latency-sync via playback-rate (hls.js latency-controller flavor) ---
  /** master enable (continuous-rate sync). Set true for live. */
  liveSync: boolean;
  /** TARGET latency (s). Ferrite default 0.6 (mpegts default 0.8). */
  liveSyncTargetLatency: number;
  /** relax ceiling (s) — the liveSyncOnStallIncrease cap. MUST be > target (validated). */
  liveSyncMaxLatency: number;
  /** MAX_RATE. Ferrite uses 1.05 for sub-audible pitch (mpegts default 1.2 — overridden). */
  liveSyncPlaybackRate: number;

  // --- mpegts liveBufferLatencyChasing: the DISCRETE seek-to-edge chaser. ---
  // The continuous-rate sync deliberately does NOT use this (it's the 3-state jump that hunts/stutters).
  // Declared for spec parity; left OFF. Continuous-rate (liveSync*) is used instead.
  liveBufferLatencyChasing: boolean;
  liveBufferLatencyChasingOnPaused: boolean;
  liveBufferLatencyMaxLatency: number;
  liveBufferLatencyMinRemain: number;

  // --- ferrite-ext live latency-sync anti-hunt machinery (no mpegts equivalent) ---
  /** Dead-band (s): no rate nudge while |latency−target| ≤ this. Raise if it hunts. */
  liveSyncDeadbandSecs: number;
  /** Gate (s): only speed up while forward-buffer > this (underrun guard). */
  liveSyncGateSecs: number;
  /** Sigmoid steepness for the rate curve `2/(1+e^(−k·d))`. */
  liveSyncSigmoidSteepness: number;
}

/** Defaults. mpegts-derived where applicable; ferrite divergences flagged in the interface. */
export const defaultConfig: FerriteConfig = {
  wasmBaseUrl: '/',
  threads: 'auto', // host-adaptive clamp(hardwareConcurrency − 2, 2, 8); see resolveThreadCount
  preferWebCodecs: true,
  wcPresentRingCap: undefined, // platform default (iOS tight / desktop deep)

  // SW present/decode coupling is in-order credit-coupled (no-drop → a CONTIGUOUS present ring → continuous
  // video; the freerun decouple was retired). swPresentRingCap ⇒ the iOS-aware RING_CAP (resolved in the constructor).
  swPresentRingCap: undefined, // ⇒ RING_CAP (12 desktop / 6 iOS), the in-flight memory bound

  enableStashBuffer: true,
  stashInitialSize: undefined,
  stashMaxSize: 2 * 1024 * 1024, // = engine LOW_WATER (4K-HEVC full-PES floor)
  stashAdaptive: true,

  isLive: false,

  liveSync: false,
  liveSyncTargetLatency: 0.6,
  liveSyncMaxLatency: 1.2,
  liveSyncPlaybackRate: 1.05,

  liveBufferLatencyChasing: false,
  liveBufferLatencyChasingOnPaused: false,
  liveBufferLatencyMaxLatency: 1.5,
  liveBufferLatencyMinRemain: 0.5,

  liveSyncDeadbandSecs: 0.05,
  liveSyncGateSecs: 0.5,
  liveSyncSigmoidSteepness: 0.75,
};

/**
 * Merge a user partial over the defaults and validate. Throws on an incoherent config so a
 * mis-wire is loud (mirrors hls.js `mergeConfig` + assertions). Returns a complete config.
 */
export function mergeConfig(user?: Partial<FerriteConfig>): FerriteConfig {
  const cfg: FerriteConfig = { ...defaultConfig, ...(user ?? {}) };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: FerriteConfig): void {
  const fail = (m: string): never => {
    throw new Error('ferrite config: ' + m);
  };
  if (cfg.threads !== 'auto' && (!Number.isFinite(cfg.threads) || cfg.threads < 1))
    fail("threads must be ≥ 1 or 'auto'");
  if (cfg.wcPresentRingCap !== undefined && (!Number.isFinite(cfg.wcPresentRingCap) || cfg.wcPresentRingCap < 1))
    fail('wcPresentRingCap must be ≥ 1 or undefined');
  // Smoothness knob: the SW in-flight cap + a transit headroom must stay under the engine HELD_CAP (64),
  // else holds starve. ≥1, and a generous upper bound keeps the experiment off the 4K-10bit heap ceiling.
  if (cfg.swPresentRingCap !== undefined && (!Number.isFinite(cfg.swPresentRingCap) || cfg.swPresentRingCap < 1 || cfg.swPresentRingCap > 56))
    fail('swPresentRingCap must be in 1..56 or undefined');
  if (typeof cfg.wasmBaseUrl !== 'string' || cfg.wasmBaseUrl.length === 0) fail('wasmBaseUrl must be a non-empty string');
  if (cfg.stashInitialSize !== undefined && (!Number.isFinite(cfg.stashInitialSize) || cfg.stashInitialSize < 0))
    fail('stashInitialSize must be ≥ 0 or undefined');
  if (!Number.isFinite(cfg.stashMaxSize) || cfg.stashMaxSize <= 0) fail('stashMaxSize must be > 0');
  if (cfg.stashInitialSize !== undefined && cfg.stashInitialSize > cfg.stashMaxSize)
    fail('stashInitialSize (floor) must be ≤ stashMaxSize (ceiling)');
  // hls.js graft: the relax ceiling must sit above the target, else latency-sync is incoherent.
  if (cfg.liveSyncMaxLatency <= cfg.liveSyncTargetLatency)
    fail('liveSyncMaxLatency must be > liveSyncTargetLatency');
  if (cfg.liveSyncPlaybackRate < 1.0) fail('liveSyncPlaybackRate must be ≥ 1.0');
  if (cfg.liveSyncTargetLatency < 0) fail('liveSyncTargetLatency must be ≥ 0');
  if (cfg.liveSyncDeadbandSecs < 0) fail('liveSyncDeadbandSecs must be ≥ 0');
  if (cfg.liveSyncGateSecs < 0) fail('liveSyncGateSecs must be ≥ 0');
}

// --- host-adaptive decode threads --------------------------------------------------------------
// The shipped default is `clamp(navigator.hardwareConcurrency − 2, 2, 8)` (was a fixed 8). Pure win:
// identical on a capable host (caps at 8), and a 4-core gets 2 — no oversubscription, and every class
// lands at/past the decode knee (t6–8) on the 256 MiB heap floor. The −2 reserves a core for the main
// thread (audio/clock) + the present worker so decode never starves the realms it depends on.
export const THREAD_COUNT_MIN = 2; // never fewer than 2 decode threads (the clamp floor)
export const THREAD_COUNT_MAX = 8; // the decode knee plateaus by t8; more buys nothing
// hardwareConcurrency is present on every crossOriginIsolated browser ferrite can run in, so this is a
// rare edge (non-browser / ancient UA). Treat an undetectable host as a low-end quad-core → 2 threads:
// the conservative choice that can't oversubscribe an unknown machine. (Coincides with the 4-core row.)
export const FALLBACK_HARDWARE_CONCURRENCY = 4;

/**
 * Resolve the configured `threads` to a concrete decode-thread count. PURE + DOM-free (it takes the
 * host's core count as an argument) so it node-imports + unit-tests; index.ts reads
 * `navigator.hardwareConcurrency` at the player-creation boundary and passes it in (mirrors how
 * platform.ts splits `detectPlatform` from `currentPlatform`).
 *
 *  - a numeric `requested` is an EXPLICIT override → returned verbatim (a consumer's choice wins);
 *  - `'auto'` → `clamp(hardwareConcurrency − 2, MIN, MAX)`, with a safe fallback when hc is
 *    undefined/non-finite/≤0.
 */
export function resolveThreadCount(requested: number | 'auto', hardwareConcurrency: number | undefined): number {
  if (requested !== 'auto') return requested; // honour an explicit override unchanged
  const cores = typeof hardwareConcurrency === 'number' && Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : FALLBACK_HARDWARE_CONCURRENCY;
  return Math.min(THREAD_COUNT_MAX, Math.max(THREAD_COUNT_MIN, cores - 2));
}
