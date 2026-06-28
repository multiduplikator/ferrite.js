// ferrite-player — public types (mpegts.js vocabulary). Framework-agnostic; this file +
// config.ts + errors.ts are portable into a host application. No DOM-framework imports.

/** Which decode path is actually driving frames. */
export type Tier = 'webcodecs' | 'software' | 'unsupported';

/**
 * mpegts `Events`. A typical host subscribes to ONLY `ERROR` (host handler is
 * `(type, details, info) => classifyMpegTsPlaybackIssue(...)`). The rest are emitted for
 * spec parity + the optional controls (host may ignore them). ERASABLE const object
 * (NOT a TS enum). Standard names match mpegts.js verbatim; ferrite-ext names are prefixed.
 */
export const Events = {
  // --- mpegts standard ---
  ERROR: 'error',
  MEDIA_INFO: 'media_info',
  STATISTICS_INFO: 'statistics_info',
  LOADING_COMPLETE: 'loading_complete',
  RECOVERED_EARLY_EOF: 'recovered_early_eof',
  METADATA_ARRIVED: 'metadata_arrived',
  DESTROYING: 'destroying',
  // --- ferrite extensions (host may ignore; the optional controls consume them) ---
  TIME_UPDATE: 'ferrite_time_update', // → a host component's timeUpdate output
  LOG: 'ferrite_log', // lifecycle breadcrumbs (diagnostics)
  DEINT_FAILED: 'ferrite_deint_failed', // deinterlace graph wouldn't build ("deint n/a")
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/** mpegts `MediaDataSource` (the first arg to createPlayer). Ferrite reads type/isLive/url. */
export interface MediaDataSource {
  type: string; // 'mpegts' (the only live cut)
  isLive?: boolean;
  url?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  cors?: boolean;
  withCredentials?: boolean;
}

/**
 * mpegts-style `MediaInfo` (the facade's `player.mediaInfo`). Minimal today — the host reads
 * none of it; populated for the optional controls UI + future VOD/seek. `videoCodec`/`audioCodec`
 * are FFmpeg codec NAMES (mpegts shape); the raw AVCodecID is kept under `*CodecId`.
 */
export interface MediaInfo {
  mimeType: string;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  videoCodecId: number;
  audioCodecId: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * mpegts-style `StatisticsInfo` (the facade's `player.statisticsInfo`). Minimal today; the
 * host reads none of it. Populated from the worker's decode loop for the diagnostics view.
 */
export interface StatisticsInfo {
  playerType: 'FerritePlayer';
  url: string;
  tier: Tier;
  decodedFrames: number; // cumulative
  droppedFrames: number;
  speed: number; // ingest KB/s
}

// --- internal worker-protocol media info (numeric codecs; NOT the public MediaInfo) -------
export interface WorkerMediaInfo {
  videoCodec: number; // FFmpeg AVCodecID
  audioCodec: number;
  width: number;
  height: number;
  /** Display-aspect SAR (DAR = width·sarNum/sarDen). 1:1 for square-pixel content. */
  sarNum?: number;
  sarDen?: number;
  /** Active decode tier the worker chose for this codec (software ↔ webcodecs). Drives the
   *  facade's `_tier`/statisticsInfo.tier early — before the first per-second stats sample. */
  tier: Tier;
}

/** Per-second decode telemetry from the worker. */
export interface WorkerStats {
  tier: Tier;
  decodeFps: number; // decoded frames/sec (rate)
  decodedFrames: number; // cumulative decoded frames
  droppedFrames: number;
  bufferedBytes: number; // unread bytes in the demux ring (boundedness proof)
  ingestKBps: number; // network ingest rate (KB/s)
  // ---- tier-specific decode-backlog depth (the lead iPad triage signal) ----
  credits: number; // SOFTWARE tier: decode budget remaining (free present-ring slots). 0/irrelevant on WC.
  decodeQueueSize: number; // WEBCODECS tier: VideoDecoder.decodeQueueSize (encoded-input backlog). 0 on SW.
  // LIVE-WC feed-gate diagnostics. wcInFlight = present-ring VideoFrames posted-but-not-released
  // (TELEMETRY ONLY — does NOT gate the feed; a monotonic climb would be the old release.vf ack-leak). 0 on SW.
  wcInFlight: number;
  // Gate state: 1 = the pump is currently parked in the feed-wait, 0 = feeding. A STUCK 1 = a latch (the
  // deadlock signature). With the decodeQueueSize-only gate it is only transiently 1. 0 on SW.
  wcGateParked: number;
  // Belt tripwire: cumulative feed-park-watchdog force-unparks. MUST stay 0 — a non-zero value means a feed
  // gate parked on a non-self-releasing signal (the deadlock class) and the belt had to break it.
  wcParkRecoveries: number;
  // Cumulative WebCodecs decode-stall recreates this session (a few are fine; a climbing count means the
  // HW tier is struggling → it falls back to software at the recreate budget).
  wcRecreates: number;
  // ---- worker→aggregator counter channel (AUTHORITATIVE; engine lives in this worker) ----
  // The growable shared wasm heap size in BYTES (memory.buffer.byteLength) — the REAL engine heap, which
  // main can't read (it's in the decode worker). Replaces the leak gate's main-thread JS-heap proxy.
  heapBytes: number;
  // In-flight HELD decoder frames (SW tier) — the engine's held AVFrame table mirrored worker-side.
  // The authoritative held count; replaces the present-ring-depth proxy the browser gate used initially.
  heldFrames: number;
  // teardown counter: open upstream/Range connections owned by THIS worker (1 while a live ingest
  // attempt holds a fetch, else 0). The decode worker owns the connection, so this is authoritative —
  // it returns to 0 the instant stopPipeline()/destroy aborts the source. Surfaced so the leak gate can
  // assert connections→0 on teardown from real state (not a harness guess).
  connections: number;
  // ---- recovery counters (un-stubbed from the bus; the error controller's recovery path) ----
  // Cumulative LIVE reconnect attempts this load (backoff reconnects + immediate seamless boundaries).
  reconnects: number;
  // Cumulative ingest STALL watchdog firings this load (the adaptive upstream-silence mean+2σ trips).
  stalls: number;
  // ---- EFFECTIVE decode-relief skips (manual OR auto-degrade) — so main can tag the buildlog
  //      `levers` with the AUTO-engaged skip-non-ref/skip-loop, not just the manual checkboxes. 0 = off, 1 = on. ----
  skipNonref: number; // skip-non-ref effective (manual OR auto graceful-degradation)
  skipLoop: number;   // skip-loop effective (manual OR auto graceful-degradation)
  // ---- VOD fetch-progress (HttpSource forward-range transport; 0 on live). The tier-agnostic overlay's
  //      transport row — useful for BOTH software-VOD and WC-VOD triage (a stuck position / climbing
  //      connection count / 200-fallback all read here). ----
  vodTotalBytes: number;    // total file size (0 = unknown / sizeless 200)
  vodPositionBytes: number; // byte offset of the last served range read (the decode read head → progress %)
  vodWindowBytes: number;   // current sliding-window depth (bytes) — the bounded rolling buffer
  vodConnections: number;   // upstream fetch opens (1 forward scan + 1 per committed seek reopen)
  vodReopens: number;       // abort+reopen events (a far seek out of the window; churn = a bug)
  vodDegraded: number;      // 1 = server ignored Range (HTTP 200 forward-only), else 0
}

/**
 * Structured player telemetry (`player.getStats()`). The SINGLE source the long-press
 * debug overlay renders from, and a clean stats surface for any host. Tier-agnostic by design: the
 * SAME fields read on BOTH decode tiers (software present-from-worker-ring + WebCodecs present-from-
 * main-thread-VideoFrame-ring), with the tier-specific decode-backlog exposed where it genuinely
 * differs (`credits` on software, `decodeQueueSize` on WebCodecs). Combines main-thread present/clock/
 * audio-sync state (read LIVE) with the worker's per-interval decode telemetry (`WorkerStats`).
 */
export interface FerriteStats {
  tier: Tier; // which path is driving frames
  isolated: boolean; // crossOriginIsolated (SharedArrayBuffer available → software decode possible)
  currentTime: number; // present clock (s)
  // present-side in-flight: frames decoded+buffered but NOT yet shown. The LEAD iPad-wedge signal —
  // on WebCodecs these are un-presented VideoFrames pinning the HW output pool; climbing toward the
  // cap before a freeze is the in-flight-budget hypothesis. Same concept on software (worker plane ring).
  presentQueue: number; // ring.length
  presentQueueCap: number; // the tier's ring cap (software ~52; WebCodecs ~120 desktop / ~24 iOS)
  // decode-side (from the worker)
  decodeFps: number;
  presentFps: number; // AUTHORITATIVE present rate from the present worker (frames drawn/sec)
  // ---- present-cadence (SMOOTHNESS) — from the present worker's draw path, over the pstats window ----
  presentIntervalMs: number;     // mean inter-draw interval (ms) — the present cadence
  presentIntervalP95Ms: number;  // 95th-percentile inter-draw interval (ms) — tail jitter
  presentIntervalMaxMs: number;  // worst inter-draw interval (ms) in the window
  presentStutters: number;       // steady-state intervals > 2× the content frame period (visible gaps) in the window
  presentSeamGaps: number;       // reset/re-anchor freezes in the window (reconnect/seam — distinct from steady-state stutter)
  // ---- clock/draw instrument (MEASURE-ONLY) — WHY distinct draws can pace below the content rate ----
  clockAdvanceFps: number;       // content-frames the audio-master MEDIA CLOCK crossed/sec (50 healthy; <50 = clock ran slow = the REAL present pace)
  clockRateRatio: number;        // media-clock advance ÷ wall elapsed (×realtime; 1.0 = locked, <1 = slow)
  clockResidualMs: number;       // |audioTarget − smoothed mediaUs| at the last audio-locked sample (PLL correction load; ~0 = locked)
  rafFps: number;                // TOTAL rAF ticks/sec in the present worker (the present callback rate ≈ display Hz; draw headroom)
  presentDropsPerSec: number;    // ring frames EVICTED WITHOUT being displayed, per sec (lost to the ring vs paced by the clock)
  // ---- display-cadence instrument (the mpv-style Bresenham num_vsyncs fix for 50-on-75 judder) ----
  vsyncIntervalMs: number;       // MEASURED display refresh interval (ms) the cadence runs against (≈13.3 @ 75 Hz; nominal until adopted)
  displayHz: number;             // measured refresh in Hz once adopted (0 = nominal fallback / warmup)
  cadenceHoldMean: number;       // mean hold count over recent frames (vsyncs/frame); 50-on-75 → ~1.5 = a clean 1,2 cadence
  cadenceHold2Frac: number;      // fraction of recent holds that were 2 vsyncs (~0.5 for the 50-on-75 1,2 beat)
  cadenceErrorMs: number;        // |sigma-delta accumulator| (ms) — bounded (≲ half a vsync) when healthy
  syncResyncsPerSec: number;     // VLC-style hard-resyncs/sec (cadence desynced > ~120 ms from audio); ≈0 on a clean clip
  // ---- graceful-degradation cadence tier (present-every-Nth-frame on a memory-bandwidth-bound client) ----
  cadenceTier: number;           // EFFECTIVE present-cap tier: 1 = full rate; 2 = half (every other frame, hold 2× longer) — at rung 3 only
  cadenceDrawRate: number;       // effective DRAW target (fps) = content rate ÷ tier (≈25 at tier 2)
  cadenceDegradeReason: number;  // 0 = none; 1 = an auto ladder rung engaged; 2 = manual present-cap override
  cadenceRung: number;           // graduated auto-degrade rung: 0 none · 1 skip-non-ref · 2 +skip-loop · 3 +present-cap
  // ---- decode-relief LEVERS (the combinatorial perf/quality trade) — the player's resolved
  //      lever state so perf (benchlog) + smoothness (buildlog) records line up unambiguously by combo. ----
  levers: {
    present: number;    // present-cap — the manual present=half cap is ON (1) / OFF (0)
    skipNonref: number; // skip-non-ref — engine skip_frame = AVDISCARD_NONREF (1) / OFF (0)
    skipLoop: number;   // skip-loop — engine skip_loop_filter = AVDISCARD_ALL (1) / OFF (0)
  };
  framesPresented: number; // cumulative frames posted to present
  droppedFrames: number;
  // ---- worker-fed AUTHORITATIVE counters (engine heap + held live in the decode worker) ----
  heapBytes: number; // the real growable wasm heap size in bytes (replaces the main-thread JS-heap proxy)
  heldFrames: number; // in-flight held decoder frames (SW) — the engine's held table, mirrored worker-side
  decodeQueueSize: number; // WebCodecs VideoDecoder backlog (0 on software)
  // LIVE-WC feed-gate diagnostics. wcInFlight = present-ring VideoFrames not yet
  // released (telemetry only — does not gate). wcGateParked = 1 if the pump is parked in the feed-wait (a
  // stuck 1 = a latch). Both 0 on software. Surfaced so the next browser run is diagnosable (we were blind).
  wcInFlight: number;
  wcGateParked: number;
  wcParkRecoveries: number; // belt tripwire: cumulative feed-park force-unparks (MUST stay 0; non-zero = a gate re-latched)
  wcRecreates: number; // cumulative WebCodecs decode-stall recreates (→ software fallback at the budget)
  credits: number; // software decode credits remaining (0 on WebCodecs, which self-throttles)
  // ingest (distinguishes a NETWORK stall from a DECODE stall)
  bufferedBytes: number;
  ingestKBps: number;
  // ---- VOD fetch-progress (HttpSource forward-range transport; 0 on live) — the overlay transport row ----
  vodTotalBytes: number;    // total file size (0 = unknown / live)
  vodPositionBytes: number; // last served range-read offset (the decode read head → progress %)
  vodWindowBytes: number;   // current sliding-window depth (bytes) — the bounded rolling buffer
  vodConnections: number;   // upstream fetch opens (1 forward scan + 1 per committed seek; churn = a bug)
  vodReopens: number;       // abort+reopen events (a far seek out of the window)
  vodDegraded: number;      // 1 = server ignored Range (HTTP 200 forward-only), else 0
  // audio-sync
  syncedToAudio: boolean; // the audio master clock is driving present (vs the video-only wall fallback)
  audioQueue: number; // in-flight scheduled audio segments (segQ depth — the audio FIFO depth)
  audioUnderruns: number; // cumulative audio playout underruns (scheduled audio fell behind → the clock stutters)
  audioGapSecs: number;   // cumulative inserted silence (s) across those underruns — the audible playout gap
  audioDrops: number;     // cumulative audio chunks dropped at the reservoir cap (the reservoir bound)
  speed: number; // current live-sync playback rate (1.0 = no sync nudge)
  liveSyncStalls: number; // audio underruns counted (relaxes the latency target)
  // ---- recovery counters (the single error controller's recovery path; un-stubbed from the bus) ----
  reconnects: number;     // cumulative LIVE reconnect attempts (network-drop/upstream-silence → reopen)
  stalls: number;         // cumulative ingest stall-watchdog firings (adaptive upstream-silence mean+2σ)
  latencyToLive: number;  // current latency-to-live proxy (s) — the scheduled-ahead audio reservoir
  // ---- AUTHORITATIVE teardown counters ----
  // The leak gate asserts "every resource → 0 on destroy" from REAL state, not a harness assumption. TWO
  // provenances (FIX2): workers/audioContexts are read LIVE from main's own resource handles (→ 0 the
  // instant the owner method nulls them); connections/heldFrames/heapBytes are OWNER-CONFIRMED by the decode
  // worker's FINAL post-reap stats and openVideoFrames by the present worker's `destroyed` ack. The
  // owner-confirmed ones arrive asynchronously with the destroy handshake — so a residual (an un-aborted
  // connection / un-released held frame / un-closed VideoFrame) surfaces non-zero and the gate FAILS.
  workers: number;         // live Worker instances: decode (1) + present (1) ⇒ 2 active, 0 after teardown
  audioContexts: number;   // live AudioContext instances (the master clock): 1 active, 0 after teardown
  connections: number;     // open upstream/Range connections (decode worker's final stats): 0 after abort
  openVideoFrames: number; // un-closed WebCodecs VideoFrames pinning the HW pool (0 on the software tier)
}

// --- a tiny AVCodecID → name map (host ignores; display only) ---------------------
const CODEC_NAMES: Record<number, string> = {
  2: 'mpeg2video',
  27: 'avc1', // H.264
  173: 'hvc1', // HEVC
  86016: 'mp2',
  86018: 'mp4a', // AAC
  86019: 'ac-3',
  86056: 'ec-3', // E-AC-3
};

export function codecName(id: number): string {
  return CODEC_NAMES[id] ?? (id > 0 ? 'codec-' + id : '');
}
