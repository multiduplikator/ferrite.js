// ferrite-player — public entry, mpegts.js-shaped drop-in.
//
// THE DROP-IN CONTRACT: a host binds an
// almost-empty mpegts surface — `Ferrite.isSupported()`, `Ferrite.createPlayer({type,isLive,
// url})`, `player.attachCanvas(canvas)` (the ONE divergence from mpegts's attachMediaElement),
// `player.on(Events.ERROR, (type,details,info)=>…)`, then `load/play/pause/unload/
// detachMediaElement/destroy`. A typical host reads NO mediaInfo/statisticsInfo and subscribes to
// NO event but ERROR — so the ERROR vocabulary (verbatim mpegts strings, errors.ts) is the
// whole ballgame; Config/MediaInfo/StatisticsInfo are declared for parity + the optional controls.
//
// SPLIT-REALM architecture: main is a THIN facade.
//   - a DECODE worker decodes and posts video frames straight to…
//   - a PRESENT worker, which owns the transferred OffscreenCanvas + WebGL2 + the rAF present loop +
//     the ring/eviction + the present clock (no decode/UI contention → it holds target fps), and
//   - MAIN keeps AUDIO playout (AudioContext) — audio IS the master clock — plus events/errors/stats.
// Because present and audio are no longer colocated, main publishes its monotonic audio playout
// elapsed into a small SharedArrayBuffer + Atomics so the present worker (a different realm) can read
// it as its `media_now`. That cross-realm clock is the ONLY coupling; everything else is messages.

import type { FerriteStats, MediaDataSource, MediaInfo, StatisticsInfo, Tier, WorkerMediaInfo, WorkerStats } from './types';
import { Events, codecName } from './types';
import { type FerriteConfig, mergeConfig, resolveThreadCount } from './config';
import { ErrorTypes, ErrorDetails, LoaderErrors, mapFerriteError, type FerriteError } from './errors';
import type { MainToWorker, WorkerToMain, MainToPresent, PresentToMain } from './protocol';
import { CLOCK_SLOTS, C_ACLOCK, C_AUDIO } from './protocol';
import {
  liveSyncRate, liveSyncTarget, LIVE_SYNC_STALL_RELAX_SECS,
  LOW_WATER_DEFAULT_FLOOR, wcRingCapForPlatform, WC_RING_CAP_DEFAULT,
} from './policy';
import { currentPlatform, type PlatformInfo } from './platform';
import { PlaybackController, type PlaybackCommand } from './controller/playback';
import { deriveCapabilities, type SourceCapabilities } from './source/capabilities';

export const version = '1.3.1';

type Listener = (...args: any[]) => void;

const RING_CAP = 12; // frames the worker may run ahead (~240ms @ 50fps); also the SOFTWARE credit pool.
// With GPU frame-pinning each in-flight SW frame holds a REAL decoder AVFrame (av_frame_ref shares
// the decoder buffer pool) — at 10-bit 4K that's ~25 MB EACH. The old 48/52-deep ring (sized for cheap 8-bit
// pack COPIES) pinned ~1.3 GB of decoder frames → exhausted the pool + hit the 2 GiB heap ceiling →
// get_buffer() failed → POC/RPS decode collapse. Keep the pinned ring shallow: ~12 ahead leaves the decoder
// its DPB/thread frames. Enough present lookahead for jitter; the WC tier keeps its own (cheap VideoFrame) cap.
// Software present-ring cap (the present worker accepts up to RING_CAP+RING_HEADROOM). Named so the
// tier-agnostic getStats() can report the in-flight depth against the RIGHT ceiling per tier. These are
// the DEFAULTS; the ?ring knob (config swPresentRingCap) re-resolves the per-instance ringCap/swRingCap
// in the constructor.
const RING_HEADROOM = 4; // present-worker accept headroom over the in-flight cap (in-transit frames)
const SW_RING_CAP = RING_CAP + RING_HEADROOM;
// iOS SOFTWARE in-flight cap. In-order credit-coupled decode bounds the in-flight HELD-frame count at the
// credit pool (≈ ringCap), and the present worker holds up to swRingCap heap-backed frames. A 4K-10bit
// AVFrame is ~25 MB, so the desktop SW_RING_CAP=16 (~400 MB) is fine on desktop but blows the iPad <300 MB
// budget under a ?flood burst; iOS gets a tighter pool (RING_CAP_IOS+HEADROOM=10 → ~250 MB worst case)
// while still holding ~120 ms of cushion @ 50 fps. WC tier is unaffected (wcRingCap).
const RING_CAP_IOS = 6;
// Graceful-shutdown timeout: how long main waits for the DECODE worker's `destroyed` ack (it has freed
// the pipeline + reaped the pthread pool) before terminate()ing the coordinator regardless. MUST
// exceed the worker's READY_SETTLE_MS (12s) + the pool reap. The present worker (no engine) acks at once.
const WORKER_SHUTDOWN_TIMEOUT_MS = 15000;

// Live-sync cadence (the reference player applies these per audio TICK ~12ms; this player schedules per audio
// CHUNK ~0.25-0.5s, so the same intent maps to a SMALL chunk count). hold = force rate 1.0 after a
// resume/underrun so latency-sync never fights the resync; decay = drop one stall after this many
// smooth chunks so a single old underrun doesn't relax the target forever.
const LIVE_SYNC_RESUME_HOLD_CHUNKS = 4;   // ~1-2 s of chunks (~80 ticks ≈ 1 s)
const LIVE_SYNC_STALL_DECAY_CHUNKS = 30;  // ~7-15 s of chunks (~1250 ticks ≈ 15 s)

// How often main republishes the audio master clock into the clock SAB. The reference player's audio
// drain re-arms every ~12ms; the present worker reads at rAF (~16ms) and low-pass-smooths it, so a
// 10ms publish keeps the SAB sample fresh enough that the PLL never starves. Cheap (reads currentTime
// + pops a tiny FIFO). Frozen automatically while paused (a suspended AudioContext freezes currentTime).
const CLOCK_PUBLISH_MS = 10;

/** Static capability gate (mpegts.isSupported parity). Capability ONLY — NOT crossOriginIsolated:
 *  isolation is a deployment condition, and the contract wants load() to surface an explicit
 *  unsupported-codec ERROR when it's off (degrade-gracefully), not a silent false here. */
export function isSupported(): boolean {
  const gl = (() => {
    try {
      const ctx = document.createElement('canvas').getContext('webgl2');
      ctx?.getExtension('WEBGL_lose_context')?.loseContext(); // don't leak a probe context toward the limit
      return !!ctx;
    } catch { return false; }
  })();
  return gl && typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
}

/** mpegts.getFeatureList parity — what this browser/deployment can actually do. */
export function getFeatureList(): Record<string, boolean> {
  return {
    ferriteSoftwareDecode: true,
    webgl2: isSupported(),
    webAudio: typeof AudioContext !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: !!(globalThis as any).crossOriginIsolated,
    webCodecs: typeof (globalThis as any).VideoDecoder !== 'undefined',
  };
}

export class FerritePlayer {
  private cfg: FerriteConfig;
  private url: string;
  private _type: string;
  // The caller's DECLARED intent (createPlayer({isLive})) — the PRIMARY input that FEEDS the descriptor
  // (deriveCapabilities) + the worker `load` message. Policy is read from `_caps`, NOT this bool.
  private _isLive: boolean;
  // LIVE/VOD UNIFICATION (Tier 1): the SINGLE source-policy descriptor. Computed intent-only at construct/
  // load (so the known-path forks behave correctly IMMEDIATELY, before the worker reports), then REFINED
  // when the worker posts `caps` (the first-response headers). Every main-side live/VOD fork reads a field
  // of this — seek()/seekbar/duration (seekable), live-edge catch-up + live-sync (hasLiveEdge), the
  // controller transport mode (declaredLive) — never `_isLive` directly.
  private _caps: SourceCapabilities;

  private worker: Worker | null = null;          // DECODE worker
  private present: Worker | null = null;          // PRESENT worker (owns the OffscreenCanvas)
  private listeners = new Map<string, Set<Listener>>();
  private platform: PlatformInfo = currentPlatform(); // detected once (main has maxTouchPoints)
  private threads = 8;                                 // host-adaptive resolved in the constructor
  private wcRingCap = WC_RING_CAP_DEFAULT;             // re-resolved per platform in the constructor
  // ?ring knob: the resolved SOFTWARE in-flight/credit cap + the present-worker accept cap.
  // Defaults = today's RING_CAP/SW_RING_CAP; re-resolved from the config in the constructor.
  private ringCap = RING_CAP;
  private swRingCap = SW_RING_CAP;
  private cfgLogged = false; // one-shot resolved-knob breadcrumb (emitted on the first load())
  private notIsolated = false; // attachCanvas skipped the workers (no crossOriginIsolated)
  private engineDead = false;  // the worker reported an engine-load failure — load() can't proceed
  private loadGen = 0;         // monotonic load generation (load/unload tag, mirrored in the worker)

  // ---- cross-realm master clock: main publishes the audio playout elapsed here; the present worker
  //      reads it via Atomics. Created only when crossOriginIsolated (SAB requires it). ----
  private clockSab: SharedArrayBuffer | null = null;
  private clock: Int32Array | null = null;
  private clockTimer: ReturnType<typeof setInterval> | 0 = 0;

  // ---- present telemetry mirrored from the present worker (for getStats()/the overlay) ----
  private presentRing = 0;
  private presentRingCap = SW_RING_CAP;
  private presentFps = 0; // authoritative present rate from the present worker's pstats
  // present-cadence (smoothness) mirrored from the present worker's pstats (over its window).
  private presentIntervalMs = 0;
  private presentIntervalP95Ms = 0;
  private presentIntervalMaxMs = 0;
  private presentStutters = 0;
  private presentSeamGaps = 0; // reset/re-anchor freezes in the window (reconnect/seam — distinct from stutter)
  // Clock/draw instrument mirrored from the present worker's pstats (MEASURE-ONLY — the "why ~46 not 50" probe).
  private clockAdvanceFps = 0;     // content-frames the media clock crossed/sec (50 healthy; <50 = clock ran slow = real pace)
  private clockRateRatio = 0;      // media-clock advance ÷ wall (×realtime; 1.0 = locked)
  private clockResidualMs = 0;     // PLL correction load (|audioTarget − mediaUs|, ms; ~0 = locked)
  private rafFps = 0;              // total rAF ticks/sec in the present worker (draw headroom)
  private presentDropsPerSec = 0;  // ring frames evicted-without-display per sec (lost to the ring vs paced by the clock)
  // Display-cadence instrument mirrored from the present worker's pstats (the mpv-style Bresenham fix).
  private vsyncIntervalMs = 0;     // measured display refresh interval (ms) the cadence runs against
  private displayHz = 0;           // measured refresh in Hz once adopted (0 = nominal fallback / warmup)
  private cadenceHoldMean = 0;     // mean hold count (vsyncs/frame); 50-on-75 → ~1.5 = a clean 1,2 cadence
  private cadenceHold2Frac = 0;    // fraction of recent holds that were 2 vsyncs (~0.5 for the 1,2 beat)
  private cadenceErrorMs = 0;      // |sigma-delta accumulator| (ms) — bounded when healthy
  private syncResyncsPerSec = 0;   // VLC-style hard-resyncs/sec (cadence desynced > ~120 ms from audio)
  // Graceful-degradation cadence tier mirrored from the present worker's pstats (the bandwidth-bound fix).
  private cadenceTier = 1;          // EFFECTIVE present-cap tier: 1 = full rate; 2 = half (every other frame) — at rung 3 only
  private cadenceDrawRate = 0;      // effective draw target (fps) = content rate ÷ tier
  private cadenceDegradeReason = 0; // 0 = none; 1 = an auto ladder rung engaged; 2 = manual override
  private cadenceRung = 0;          // graduated auto-degrade rung: 0 none · 1 skip-non-ref · 2 +skip-loop · 3 +present-cap
  // ---- decode-relief LEVERS — the player's resolved lever state (the owner toggles them live
  //      via setLevers()). The present-cap (present=half) drives the PRESENT worker's manual cap; the skips drive the DECODE
  //      worker's engine skip setter. Tracked here so getStats() can tag every telemetry record by combo. ----
  private leverPresentHalf = false; // present-cap — manual present=half cap
  private leverSkipNonref = false;  // skip-non-ref — engine skip_frame = AVDISCARD_NONREF
  private leverSkipLoop = false;    // skip-loop — engine skip_loop_filter = AVDISCARD_ALL

  private bgPaused = false;     // auto-paused because the tab is hidden (vs a manual pause)
  private visHandler: (() => void) | null = null;
  private destroyed = false;

  // ---- the PURE PlaybackController is the facade's TEARDOWN AUTHORITY. Teardown is a STATE
  //      (Closing→Closed), not flag-soup: destroy()/detach dispatch `userDestroy`→`drained`, the reducer
  //      emits the RAII teardown commands in order (pipeline→present→audio→engine), and `execCommand`
  //      runs each on its single owner. Coarse lifecycle events (load/opened/lowWater/pause/play) are fed
  //      in for fidelity — they don't change teardown (Closing is identical from EVERY state),
  //      but they make the state machine honest + observable. Playback COMMANDS are no-ops in the executor:
  //      the facade's existing methods ARE the imperative side; the controller drives only teardown. ----
  private controller = new PlaybackController((cmd) => this.execCommand(cmd));
  private firstFrameSeen = false; // gate the one-shot `lowWater` dispatch (first present → playing)

  // ---- media-facade state ----
  private _paused = true;
  private _currentMs = 0;
  private _durationMs = 0;     // VOD container duration (0 = live/unknown) — drives duration + the scrub bar
  private _volume = 1;
  private _muted = false;
  private _tier: Tier = 'software';
  private _workerInfo: WorkerMediaInfo | null = null;
  private _stats: StatisticsInfo = { playerType: 'FerritePlayer', url: '', tier: 'software', decodedFrames: 0, droppedFrames: 0, speed: 0 };
  private _workerStats: WorkerStats | null = null; // last raw per-interval worker telemetry (feeds getStats)
  private _lastError: FerriteError | null = null;

  // ---- audio (master clock) ----
  private audioCtx: AudioContext | null = null;
  private audioGain: GainNode | null = null;
  private audioNextStart = 0;
  private audioActive = false;

  // ---- live latency-sync (the reference player's start_audio_playout) ----
  // CLOSED-LOOP media clock: a small FIFO of in-flight scheduled segments {ws: ctx wall_start, media:
  // media seconds, rate}, each valued at ITS OWN rate so a rate-heterogeneous queue is never revalued
  // at a single scalar (which would step the clock at every rate change). `mediaBase` = media of
  // segments already fully played (popped). elapsed = mediaBase + (ctx.now − ws_front)·rate_front. The
  // FIFO + mediaBase stay MONOTONIC across an underrun (the underrun re-anchors the SCHEDULE cursor, not
  // the clock) so the published A_ACLOCK never jumps backward under the present worker — see playAudio.
  private segQ: { ws: number; media: number; rate: number }[] = [];
  private mediaBase = 0;
  private liveSyncStalls = 0;       // underruns observed → relax the target (stall_count)
  private liveSyncSmoothChunks = 0; // smooth chunks since the last stall → decays the stall count
  private liveSyncHoldChunks = 0;   // chunks left forcing rate=1.0 (post resume/underrun resync)
  private liveSyncLastRate = 1;     // throttle the debug breadcrumb to rate CHANGES
  // Audio-health instrument (the clock is audio-locked → a sparse/underrunning audio track stutters the
  // clock). UNCAPPED + liveSync-independent, unlike liveSyncStalls (which clamps as a target-relax signal).
  private audioUnderruns = 0;       // cumulative audio playout underruns (scheduled audio fell behind ctx.currentTime)
  private audioGapSecs = 0;         // cumulative inserted silence across those underruns (s) — the audible playout gap
  // Tier-1 Step 1: cumulative audio chunks DROPPED because the scheduled-ahead reservoir was already at
  // the liveSyncMaxLatency cap (the symmetric upper bound to policy.ts's lower-target relax). Caps the
  // reservoir + the in-flight node count so the main thread can't be buried under a growing node queue.
  private audioDrops = 0;
  // Tier-0 Step 0: publishClock cadence instrument — proves the main-thread stall. The setInterval is
  // armed for CLOCK_PUBLISH_MS (10ms); a tick GAP ≫ 10ms means main was BLOCKED (couldn't fire the
  // timer) → the SAB clock froze → present starved. Reported ~1/s via Events.LOG → /pumplog.
  private cpLastAt = 0;             // perf.now() of the previous publishClock tick (0 = not yet seen)
  private cpMaxGap = 0;             // max inter-tick gap (ms) since the last report
  private cpReportAt = 0;           // perf.now() of the last [clock] report
  // latency-to-live proxy (s): the scheduled-ahead audio reservoir — exactly the signal the
  // live-sync rate chaser treats as "how far behind the live edge we are." Updated per audio chunk.
  private liveLatencySecs = 0;

  constructor(dataSource: MediaDataSource, config?: Partial<FerriteConfig>) {
    this.cfg = mergeConfig(config);
    this._type = dataSource.type ?? 'mpegts';
    this.url = dataSource.url ?? '';
    this._isLive = dataSource.isLive ?? this.cfg.isLive;
    this.cfg.isLive = this._isLive; // keep the stored config coherent with the resolved value
    this._caps = deriveCapabilities(this._isLive); // intent-only until the worker refines from the first response
    // host-adaptive decode threads: resolve the 'auto' default against THIS host's core count here at
    // the player-creation boundary, where navigator.hardwareConcurrency is reliable (a WorkerNavigator
    // also has it, but main is the single resolution point — like platform detection). An explicit numeric
    // `threads` passes through unchanged. Store the resolved number back so the config + getStats stay
    // coherent (mirrors the isLive write above); the decode worker's pool follows it as threads + 2.
    this.threads = resolveThreadCount(this.cfg.threads, (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency);
    this.cfg.threads = this.threads;
    this.wcRingCap = wcRingCapForPlatform(this.platform.isIOS, this.cfg.wcPresentRingCap);
    // The live SW path is in-order credit-coupled decode (no-drop → a contiguous present ring → continuous
    // video; the freerun decouple was retired — its present-side drop-oldest punched PTS holes → freeze-jump
    // on real streams). The in-flight/credit cap (= the present cushion depth) is the memory bound and is
    // iOS-aware to keep held frames inside the iPad budget under ?flood. ?ring (swPresentRingCap) overrides
    // the depth.
    this.ringCap = this.cfg.swPresentRingCap ?? (this.platform.isIOS ? RING_CAP_IOS : RING_CAP);
    this.swRingCap = this.ringCap + RING_HEADROOM;
    this.presentRingCap = this.swRingCap;
  }

  static isSupported = isSupported;

  // ---- controller lifecycle --------------------------------------------------

  /** mpegts attachMediaElement → attachCanvas divergence: ferrite renders to <canvas>. The canvas
   *  control is TRANSFERRED to the present worker (transferControlToOffscreen) — main never gets a
   *  rendering context on it. */
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.destroyed) throw new Error('ferrite: player destroyed — create a new instance');
    if (this.worker || this.present) throw new Error('ferrite: attachCanvas called twice');

    // degrade-gracefully: without crossOriginIsolated there is no SharedArrayBuffer, so the engine
    // can't instantiate AND the cross-realm clock can't exist. Don't spawn doomed workers; load() emits
    // the explicit unsupported-codec ERROR.
    if (!(globalThis as any).crossOriginIsolated) {
      this.notIsolated = true;
      return;
    }

    // Hand the canvas to the present worker. transferControlToOffscreen requires that main has NOT
    // obtained a rendering context on it (we never do — the worker owns WebGL2). A canvas can be
    // transferred ONCE in its lifetime, so a replay through a fresh player over the SAME element throws —
    // surface that clearly (the host must pass a FRESH <canvas>; the demo recreates it on each play)
    // rather than leaking the raw DOMException.
    let off: OffscreenCanvas;
    try {
      off = canvas.transferControlToOffscreen();
    } catch {
      throw new Error('ferrite: this <canvas> was already transferred to an OffscreenCanvas — attachCanvas needs a FRESH <canvas> element (a transferred canvas cannot be reused across players)');
    }

    // The cross-realm master clock (audio elapsed). SAB is available (we're crossOriginIsolated).
    this.clockSab = new SharedArrayBuffer(CLOCK_SLOTS * 4);
    this.clock = new Int32Array(this.clockSab);

    // The decode↔present channel: frames go decode→present over it, recycled buffers come back.
    const chan = new MessageChannel();

    // Spawn the PRESENT worker and hand it the OffscreenCanvas + its channel end + the clock SAB + the
    // per-tier ring caps. The `new Worker(new URL('./present-worker.js', import.meta.url), …)` form is
    // kept LITERAL so bundlers detect/copy/rewrite the worker chunk (a hoisted URL defeats it).
    this.present = this.cfg.presentWorkerUrl
      ? new Worker(this.cfg.presentWorkerUrl, { type: 'module' })
      : new Worker(new URL('./present-worker.js', import.meta.url), { type: 'module' });
    this.present.onmessage = (e: MessageEvent<PresentToMain>) => this.onPresentMessage(e.data);
    this.present.onerror = (e: ErrorEvent) =>
      this.handleFatal(mapFerriteError('worker', -1, `present-worker: ${e.message} @ ${e.filename}:${e.lineno}`, true));
    this.postPresent(
      { type: 'present-init', canvas: off, port: chan.port1, clock: this.clockSab, wcRingCap: this.wcRingCap, swRingCap: this.swRingCap },
      [off, chan.port1],
    );

    // Spawn the DECODE worker and hand it the OTHER channel end (transferred). Frames flow over it to
    // the present worker; recycled plane buffers come back over it.
    this.worker = this.cfg.workerUrl
      ? new Worker(this.cfg.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e: ErrorEvent) =>
      this.handleFatal(mapFerriteError('worker', -1, `worker: ${e.message} @ ${e.filename}:${e.lineno}`, true));
    this.worker.onmessageerror = () =>
      this.handleFatal(mapFerriteError('worker', -1, 'worker: message deserialization failed', true));
    this.post({
      type: 'init', wasmBaseUrl: this.cfg.wasmBaseUrl, threads: this.threads,
      lowWaterFloor: this.cfg.stashInitialSize ?? LOW_WATER_DEFAULT_FLOOR,
      lowWaterCeiling: this.cfg.stashMaxSize,
      lowWaterAdaptive: this.cfg.stashAdaptive,
      isIOS: this.platform.isIOS,
      isAppleWebKit: this.platform.isAppleWebKit,
      presentPort: chan.port2,
      ringCap: this.ringCap, // single source of truth for the worker's software in-flight (credit) bound (?ring)
    }, [chan.port2]);

    // Publish the audio master clock into the SAB on a steady cadence (the present worker reads it).
    this.clockTimer = setInterval(() => this.publishClock(), CLOCK_PUBLISH_MS);

    // Background-tab pause: a hidden tab keeps burning the decode thread-pool + the present worker's
    // rAF (Chromium does not throttle worker rAF), so auto-pause when hidden, auto-resume when shown —
    // but never override a manual pause.
    // FIX 3: a detach→re-attach reuse cycle re-runs attachCanvas() while a prior listener may still be
    // registered (only destroy() removes it). Remove the previous ref before re-adding so the listener
    // is idempotent and a stale closure can't be orphaned on the document.
    if (this.visHandler) document.removeEventListener('visibilitychange', this.visHandler);
    this.visHandler = () => {
      if (document.hidden) {
        if (!this._paused) { this.pause(); this.bgPaused = true; }
      } else if (this.bgPaused) {
        this.bgPaused = false;
        void this.play();
      }
    };
    document.addEventListener('visibilitychange', this.visHandler);
  }

  /** mpegts alias kept so a `<video>` mis-wire is loud rather than silently dead. */
  attachMediaElement(_el: unknown): never {
    throw new Error('ferrite: use attachCanvas(canvas) — ferrite renders to <canvas>, not a <video> element');
  }

  /** Start the stream pipeline. URL/isLive come from the createPlayer dataSource. */
  load(): void {
    if (this.destroyed) return;
    if (!this.worker) throw new Error('ferrite: call attachCanvas() before load()');
    if (this.notIsolated) {
      this.emitError(mapFerriteError('not-isolated', -1,
        'crossOriginIsolated is false (COOP/COEP not set) — software decode unavailable', true));
      return;
    }
    if (this.engineDead) {
      this.emitError(mapFerriteError('engine-load', -1, 'engine failed to load earlier', true));
      return;
    }
    if (!this.url) { this.emitError(mapFerriteError('network', -1, 'no stream url', true)); return; }
    // Diagnostic: log the RESOLVED knob config once (the defaults = today's behaviour).
    if (DEBUG && !this.cfgLogged) {
      this.cfgLogged = true;
      this.emit(Events.LOG, `smoothness knobs resolved: ringCap=${this.ringCap} swRingCap=${this.swRingCap} liveSync=${this.cfg.liveSync}`);
    }
    // Reloading over a prior stream: re-arm the audio epoch + tell the present worker to flush its ring
    // and re-anchor so the new pipeline presents cleanly (no brief flash of the old timeline).
    const gen = ++this.loadGen;
    this.firstFrameSeen = false;
    // Drive the controller into a live (non-terminal) state so a destroy racing this load transitions
    // through Closing identically (TOTAL). `load` only moves an idle controller; a reload from a live
    // state is inert in the reducer (harmless) — teardown is the same from any state anyway.
    // Re-derive the descriptor intent-only for THIS load (the worker refines + posts `caps` once the first
    // response lands); the controller transport mode keys on the declared intent (known before any response).
    this._caps = deriveCapabilities(this._isLive);
    this.controller.dispatch({ type: 'load', mode: this._caps.declaredLive ? 'live' : 'vod', url: this.url });
    this.resetAudioEpoch();
    this.resetPresent(gen);
    this._durationMs = 0; // re-probed by the worker for VOD (stays 0 = Infinity for live)
    this.post({ type: 'load', gen, url: this.url, isLive: this._isLive, preferWebCodecs: this.cfg.preferWebCodecs });
    this.post({ type: 'credit', n: this.ringCap }); // seed the decode budget (software tier; ?ring depth)
  }

  /** Stop the current stream pipeline but keep the workers/engine + canvas attached (mpegts unload). */
  unload(): void {
    if (this.destroyed || !this.worker) return;
    const gen = ++this.loadGen;
    this.post({ type: 'unload', gen });
    this.resetAudioEpoch();
    this.resetPresent(gen);
    this.audioCtx?.suspend().catch(() => {});
    this._paused = true;
  }

  /** mpegts detachMediaElement: release the canvas/workers. attachCanvas can be called again.
   *  teardown is now a CONTROLLER STATE — this drives the pure reducer's Closing→Closed, whose
   *  ordered teardown commands `execCommand` runs on each resource's single owner (the proven RAII
   *  free→reap→terminate sequence). Idempotent (a second call finds the controller idle + handles null);
   *  NON-terminal — after Closed it re-seeds a fresh idle controller so attachCanvas()+load() start clean. */
  detachMediaElement(): void {
    this.runTeardown();
    // detach is reusable: re-seed a fresh idle controller (destroy() sets `destroyed` to bar reuse).
    this.controller = new PlaybackController((cmd) => this.execCommand(cmd));
    this.firstFrameSeen = false;
  }

  /** Drive the controller's Closing→Closed transition. The reducer emits the teardown commands IN RAII
   *  ORDER (pipeline→present→audio, then engine on drained); each runs on its single owner via
   *  `execCommand`. TOTAL from ANY state; double-call is idempotent (a second `userDestroy` from
   *  closing/closed is inert in the reducer, and every owner method handles an already-released resource). */
  private runTeardown(): void {
    this.controller.dispatch({ type: 'userDestroy' }); // → closing: teardown(pipeline) → present → audio → emit
    this.controller.dispatch({ type: 'drained' });     // → closed:  teardown(engine) — finalize the baseline
  }

  /** FIX 1: route a FATAL (unrecoverable) error through the controller's teardown. The reducer ALWAYS
   *  defined error{fatal} as a Closing trigger (playback.ts), but earlier NO facade path dispatched
   *  it — every fatal site only called emitError(), so on a fatal error the 2 workers + AudioContext +
   *  the clock publisher leaked until destroy(). This surfaces the error to the host FIRST (the mpegts
   *  ERROR contract), then drives Closing→Closed so the RAII teardown commands run on each owner — the
   *  same ordered free→reap→terminate as runTeardown(), via the reducer's error branch.
   *
   *  FATAL-ONLY: non-fatal errors stay emitError-only (recover() re-loads from the live edge and relies
   *  on the workers/engine/AudioContext SURVIVING). Fatal = unrecoverable = teardown, so recover()-after-
   *  fatal is intentionally unsupported (this.worker is null → recover() is a no-op). Re-entrancy is
   *  handled by the reducer: a fatal arriving during Closing/Closed is inert (no double teardown), and a
   *  host ERROR listener that calls destroy() synchronously just advances the SAME total transition; the
   *  owner teardown methods are all idempotent regardless. */
  private handleFatal(err: FerriteError): void {
    this.emitError(err);
    this.controller.dispatch({ type: 'error', fatal: true }); // → closing: teardown(pipeline)→present→audio→emit
    this.controller.dispatch({ type: 'drained' });            // → closed:  teardown(engine)
  }

  /** The teardown executor: maps the reducer's ordered teardown commands onto each resource's ONE owner.
   *  Playback commands are no-ops here (the facade's load/play/pause methods ARE the imperative side);
   *  the controller drives only teardown at the facade. Running off the command stream is what
   *  makes the ORDER authoritative (encoded in the reducer) instead of scattered across this file. */
  private execCommand(cmd: PlaybackCommand): void {
    if (cmd.type !== 'teardown') return;
    switch (cmd.phase) {
      case 'pipeline': this.teardownPipeline(); break; // DECODE worker: abort source → free decoders → release held → reap pool → terminate
      case 'present':  this.teardownPresent();  break; // PRESENT worker: close ALL VideoFrames + dispose GL → terminate
      case 'audio':    this.teardownAudio();    break; // MAIN: close the AudioContext (master clock) + stop the clock publisher
      case 'engine':   this.teardownEngine();   break; // MAIN (on Closed): finalize the baseline (engine died with the decode worker)
    }
  }

  /** OWNER: the DECODE worker. Graceful shutdown: it reaps its pooled decode Workers (each pinning a 2 GB
   *  SAB wasm instance) and aborts the in-flight source connection + releases all held frames BEFORE
   *  terminate() — the proven internal RAII order (worker.ts handleDestroy). Idempotent (null worker). */
  private teardownPipeline(): void {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    this.shutdownWorker(w);
  }

  /** OWNER: the PRESENT worker. It owns no engine/pool but DOES hold VideoFrames; ask it to close them +
   *  dispose GL, then terminate on its `destroyed` ack (or a short timeout). Idempotent (null present). */
  private teardownPresent(): void {
    const p = this.present;
    if (!p) return;
    this.present = null;
    this.shutdownPresent(p);
  }

  /** OWNER: MAIN. Stop the clock publisher + close the master-clock AudioContext, drop the clock SAB.
   *  Idempotent (already-closed AudioContext / null refs). */
  private teardownAudio(): void {
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = 0; }
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.audioGain = null;
    this.audioActive = false;
    this.clock = null;
    this.clockSab = null;
  }

  /** OWNER: MAIN, on Closed. The engine memory is freed when the decode worker terminates. FIX 2: this no
   *  longer ZEROES the teardown counters — that was the vacuous "main-zeroed" baseline (getStats could
   *  never report a residual, so the leak gate's assertions couldn't fail). The authoritative post-teardown
   *  values are now OWNER-CONFIRMED asynchronously: the decode worker posts its FINAL post-reap stats
   *  (connections/heldFrames/heapBytes) just before its `destroyed` ack, and the present worker confirms its
   *  ring is empty in ITS ack (→ presentRing/openVideoFrames=0). Both are recorded by the shutdown handlers.
   *  Here we only reset the present-rate observability + the per-instance capability flags (so a fresh
   *  attachCanvas can retry). If a worker WEDGES and never acks, its last live counters stay non-zero → the
   *  leak gate FAILS, which is correct (an un-reaped resource is a real leak). */
  private teardownEngine(): void {
    this.presentFps = 0;
    this.presentIntervalMs = this.presentIntervalP95Ms = this.presentIntervalMaxMs = this.presentStutters = this.presentSeamGaps = 0;
    this.clockAdvanceFps = this.clockRateRatio = this.clockResidualMs = this.rafFps = this.presentDropsPerSec = 0;
    this.vsyncIntervalMs = this.displayHz = this.cadenceHoldMean = this.cadenceHold2Frac = this.cadenceErrorMs = this.syncResyncsPerSec = 0;
    this.cadenceTier = 1; this.cadenceDrawRate = 0; this.cadenceDegradeReason = 0; this.cadenceRung = 0;
    this.presentRingCap = this.swRingCap; // the resolved per-instance cap (knobs survive a detach/re-load)
    this.notIsolated = false;
    this.engineDead = false;      // a fresh attachCanvas spawns new workers that may load fine
  }

  /**
   * Drive the decode worker's destroy handshake then terminate it. Re-points its message handler to
   * listen ONLY for the `destroyed` ack. A timeout guarantees an unresponsive worker is still
   * terminated. `finish()` is once-only.
   */
  private shutdownWorker(w: Worker): void {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    };
    // FIX 2: the decode worker posts its FINAL authoritative post-reap stats (connections=0/heldFrames=0/
    // heapBytes) RIGHT BEFORE the `destroyed` ack. Record them (don't null the cache) so getStats() reports
    // OBSERVED post-teardown state — a residual connection / held frame would land here non-zero and fail
    // the gate. Messages arrive in post order, so the final stats are recorded before finish() terminates.
    w.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const d = e.data;
      if (d?.type === 'stats') this._workerStats = d.stats; // confirmed post-reap counters (authoritative)
      else if (d?.type === 'destroyed') finish();
    };
    w.onerror = finish;        // worker crashed → nothing left to reap, just terminate
    w.onmessageerror = finish;
    timer = setTimeout(finish, WORKER_SHUTDOWN_TIMEOUT_MS);
    try { w.postMessage({ type: 'destroy' } as MainToWorker); } catch { finish(); }
  }

  /** Tear down the present worker: ask it to close its held VideoFrames + dispose GL, then terminate
   *  on its `destroyed` ack (or a short timeout — it has no pool to reap, so the ack is immediate). */
  private shutdownPresent(p: Worker): void {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      p.onmessage = null;
      p.onerror = null;
      p.terminate();
    };
    // FIX 2: the present worker's `destroyed` ack carries `framesClosed` — the count of VideoFrames it
    // actually close()d while emptying its ring. Receiving it CONFIRMS the ring is empty, so we zero the
    // present mirror HERE (owner-confirmed), not in teardownEngine (which was a vacuous main-side zero).
    // If the present worker wedges and only the timeout fires, the mirror stays at its last value → the
    // gate reports a residual openVideoFrames and FAILS, which is correct.
    p.onmessage = (e: MessageEvent<PresentToMain>) => {
      const d = e.data;
      if (d?.type === 'destroyed') {
        // The ack CONFIRMS the present ring was emptied → zero the mirror here (owner-confirmed
        // openVideoFrames → 0), and breadcrumb how many WC VideoFrames the worker actually close()d.
        if (d.framesClosed) this.emit(Events.LOG, `present: reaped ${d.framesClosed} VideoFrame(s) on teardown`);
        this.presentRing = 0;
        finish();
      }
    };
    p.onerror = finish;
    timer = setTimeout(finish, 2000);
    try { p.postMessage({ type: 'destroy' } as MainToPresent); } catch { finish(); }
  }

  /** Full teardown. The HOST owns lifecycle policy; the player has NO internal idle-pause watchdog. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit(Events.DESTROYING);
    if (this.visHandler) { document.removeEventListener('visibilitychange', this.visHandler); this.visHandler = null; }
    this.detachMediaElement();
    this.listeners.clear();
  }

  /** hls.js graft: recover from the last error by re-loading the stream from the live edge. */
  recover(): void {
    if (this.destroyed || !this.worker || !this._lastError) return;
    this._lastError = null;
    this._paused = false;
    this.load();
  }

  // ---- media facade ----------------------------------------------------------

  play(): Promise<void> {
    if (this.destroyed || !this.worker) return Promise.resolve();
    this.controller.dispatch({ type: 'userPlay' });  // paused → playing (inert from other states)
    this.bgPaused = false; // a manual play takes ownership of the play/pause state
    this.ensureAudio();
    if (this._caps.hasLiveEdge) {
      // LIVE resync to the edge: re-arm the audio epoch, tell the present worker to drop the stale ring
      // + re-anchor, and tell the decode worker to await the next keyframe. (No-ops on the initial play.)
      this.resetAudioEpoch();
      this.resetPresent(this.loadGen);
      this.liveSyncHoldChunks = LIVE_SYNC_RESUME_HOLD_CHUNKS;
    }
    // VOD: resume in place — the present worker keeps its decoded-ahead ring + clock.
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this._paused = false;
    this.post({ type: 'setPaused', paused: false });
    this.postPresent({ type: 'setPaused', paused: false });
    return Promise.resolve();
  }

  pause(): void {
    if (this.destroyed) return;
    this.controller.dispatch({ type: 'userPause' }); // playing → paused (inert from other states)
    this.bgPaused = false; // a manual pause takes ownership (the visHandler re-sets it if it called us)
    this._paused = true;
    this.post({ type: 'setPaused', paused: true });       // worker tracks live edge, discards
    this.postPresent({ type: 'setPaused', paused: true }); // present worker freezes the clock + eviction
    this.audioCtx?.suspend().catch(() => {});              // freezes the master clock
  }

  /** Seek to `seconds` — only on a SEEKABLE source (Range/206). Ignored on a non-seekable source (a live
   *  push with no ranges, or a declared-VOD origin that ignored Range → degraded 200). */
  seek(seconds: number): void {
    if (this.destroyed || !this.worker) return;
    if (!this._caps.seekable) { this.emit(Events.LOG, 'seek() ignored on a non-seekable source'); return; }
    let t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const dur = this._durationMs > 0 ? this._durationMs / 1000 : null;
    if (dur !== null) t = Math.min(t, Math.max(0, dur - 0.1)); // clamp inside the file
    this.resetAudioEpoch();
    this.resetPresent(this.loadGen);
    this._currentMs = t * 1000;
    this.post({ type: 'seek', targetMs: t * 1000 });
    // Ensure the clock + audio can advance from the new position (resume; covers replay-after-end).
    this.bgPaused = false;
    this.ensureAudio();
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this._paused = false;
    this.post({ type: 'setPaused', paused: false });
    this.postPresent({ type: 'setPaused', paused: false });
    this.emit(Events.TIME_UPDATE, t);
  }

  get type(): string { return this._type; }
  get paused(): boolean { return this._paused; }
  get currentTime(): number { return this._currentMs / 1000; }
  set currentTime(s: number) { this.seek(s); }
  get duration(): number {
    // Finite (⇒ the controls show the scrub bar) ONLY on a seekable source with a known duration. A live
    // edge / a non-seekable VOD (degraded 200) ⇒ Infinity ⇒ the LIVE pill, seekbar hidden (mpegts parity).
    return (this._caps.seekable && this._durationMs > 0) ? this._durationMs / 1000 : Infinity;
  }
  get videoWidth(): number {
    // DISPLAY width = coded width × SAR (anamorphic-correct DAR). The worker forwards SAR per `ready`
    // (defaults 1:1). 1440×1080 SAR 4:3 → 1920 → DAR 16:9; square-pixel content returns the coded width.
    const i = this._workerInfo;
    if (!i) return 0;
    const sn = i.sarNum ?? 1, sd = i.sarDen ?? 1;
    return sn > 0 && sd > 0 ? Math.round(i.width * sn / sd) : i.width;
  }
  get videoHeight(): number { return this._workerInfo?.height ?? 0; }
  get tier(): Tier { return this._tier; }
  get mediaInfo(): MediaInfo | null {
    const i = this._workerInfo;
    if (!i) return null;
    return {
      mimeType: 'video/mp2t',
      width: i.width,
      height: i.height,
      videoCodec: codecName(i.videoCodec),
      audioCodec: codecName(i.audioCodec),
      videoCodecId: i.videoCodec,
      audioCodecId: i.audioCodec,
      hasVideo: i.videoCodec > 0,
      hasAudio: i.audioCodec > 0,
    };
  }
  get statisticsInfo(): StatisticsInfo { return this._stats; }

  /** Structured telemetry — the SINGLE source the long-press debug overlay renders from.
   *  Tier-agnostic. Present-ring depth comes from the present worker's throttled `pstats`. */
  getStats(): FerriteStats {
    const ws = this._workerStats;
    return {
      tier: this._tier,
      isolated: !!(globalThis as any).crossOriginIsolated,
      currentTime: this._currentMs / 1000,
      presentQueue: this.presentRing,
      presentQueueCap: this.presentRingCap,
      decodeFps: ws?.decodeFps ?? 0,
      presentFps: this.presentFps, // authoritative present rate (present worker), not derived on main
      // present-cadence (smoothness) — the present worker's measured draw-interval distribution.
      presentIntervalMs: this.presentIntervalMs,
      presentIntervalP95Ms: this.presentIntervalP95Ms,
      presentIntervalMaxMs: this.presentIntervalMaxMs,
      presentStutters: this.presentStutters,
      presentSeamGaps: this.presentSeamGaps,
      // Clock/draw instrument — WHY distinct draws can pace below the content rate on a seam-free source.
      clockAdvanceFps: this.clockAdvanceFps,
      clockRateRatio: this.clockRateRatio,
      clockResidualMs: this.clockResidualMs,
      rafFps: this.rafFps,
      presentDropsPerSec: this.presentDropsPerSec,
      // display-cadence instrument (the mpv-style Bresenham num_vsyncs fix)
      vsyncIntervalMs: this.vsyncIntervalMs,
      displayHz: this.displayHz,
      cadenceHoldMean: this.cadenceHoldMean,
      cadenceHold2Frac: this.cadenceHold2Frac,
      cadenceErrorMs: this.cadenceErrorMs,
      syncResyncsPerSec: this.syncResyncsPerSec,
      // graceful-degradation cadence tier (present-every-Nth-frame on a memory-bandwidth-bound client)
      cadenceTier: this.cadenceTier,
      cadenceDrawRate: this.cadenceDrawRate,
      cadenceDegradeReason: this.cadenceDegradeReason,
      cadenceRung: this.cadenceRung,
      // levers: the EFFECTIVE combo (manual OR auto graceful-degradation), so perf (benchlog) +
      // smoothness (buildlog) line up by combo AND the buildlog shows present-cap+skip-non-ref+skip-loop flipping on together at the
      // auto-degrade moment. present-cap effective = the manual present=half OR the present worker's auto-latched tier
      // 2 (cadenceTier mirrors the EFFECTIVE tier from pstats). skip-non-ref/skip-loop effective come from the decode worker's
      // stats (manual OR auto-fanned skips). A degraded stream reads {present:1, skipNonref:1, skipLoop:1}.
      levers: {
        present: (this.leverPresentHalf || this.cadenceTier === 2) ? 1 : 0, // 2 = the auto/manual half-rate tier
        skipNonref: ws?.skipNonref ?? (this.leverSkipNonref ? 1 : 0),
        skipLoop: ws?.skipLoop ?? (this.leverSkipLoop ? 1 : 0),
      },
      framesPresented: ws?.decodedFrames ?? 0,
      droppedFrames: ws?.droppedFrames ?? 0,
      // AUTHORITATIVE worker-fed counters (replace the leak gate's main-thread proxies):
      heapBytes: ws?.heapBytes ?? 0,   // the real growable wasm heap (lives in the decode worker)
      heldFrames: ws?.heldFrames ?? 0, // in-flight held decoder frames (engine table, mirrored worker-side)
      decodeQueueSize: ws?.decodeQueueSize ?? 0,
      wcInFlight: ws?.wcInFlight ?? 0,     // LIVE-WC feed-gate telemetry: present-ring in-flight (not a gate)
      wcGateParked: ws?.wcGateParked ?? 0, // LIVE-WC feed-gate telemetry: pump parked in the feed-wait (stuck 1 = latch)
      wcParkRecoveries: ws?.wcParkRecoveries ?? 0, // belt tripwire: cumulative force-unparks (MUST stay 0)
      wcRecreates: ws?.wcRecreates ?? 0, // cumulative WC decode-stall recreates (→ software fallback at the budget)
      credits: ws?.credits ?? 0,
      bufferedBytes: ws?.bufferedBytes ?? 0,
      ingestKBps: ws?.ingestKBps ?? 0,
      // VOD fetch-progress (HttpSource forward-range transport; 0 on live) — the overlay's transport row.
      vodTotalBytes: ws?.vodTotalBytes ?? 0,
      vodPositionBytes: ws?.vodPositionBytes ?? 0,
      vodWindowBytes: ws?.vodWindowBytes ?? 0,
      vodConnections: ws?.vodConnections ?? 0,
      vodReopens: ws?.vodReopens ?? 0,
      vodDegraded: ws?.vodDegraded ?? 0,
      syncedToAudio: this.audioActive,
      audioQueue: this.segQ.length,
      // Audio health (the clock is audio-locked → underruns/sparse audio stutter the present clock).
      audioUnderruns: this.audioUnderruns,
      audioGapSecs: this.audioGapSecs,
      audioDrops: this.audioDrops,
      speed: this.liveSyncLastRate,
      liveSyncStalls: this.liveSyncStalls,
      // recovery counters (un-stubbed): reconnects/stalls are the decode worker's authoritative
      // tallies (the error controller's recovery path); latencyToLive is main's reservoir proxy.
      reconnects: ws?.reconnects ?? 0,
      stalls: ws?.stalls ?? 0,
      latencyToLive: this.liveLatencySecs,
      // AUTHORITATIVE teardown counters. TWO provenances (FIX 2):
      //  - workers/audioContexts are read LIVE from main's own resource handles → 0 the instant the owner
      //    method nulls them synchronously (no async confirmation needed; main owns these directly).
      //  - connections/heldFrames/heapBytes come from the decode worker's FINAL post-reap stats and
      //    openVideoFrames from the present worker's `destroyed` ack (which zeroes presentRing). These are
      //    OWNER-CONFIRMED, not main-zeroed — so a residual connection / held frame / open VideoFrame
      //    surfaces here non-zero and the leak gate FAILS (the assertions are no longer vacuous).
      workers: (this.worker ? 1 : 0) + (this.present ? 1 : 0),
      audioContexts: this.audioCtx ? 1 : 0,
      connections: ws?.connections ?? 0, // decode worker owns the connection; confirmed 0 in its final stats
      // Un-closed WebCodecs VideoFrames pin the HW output pool — they live in the present ring on the WC
      // tier; on software the ring holds heap-slot tokens (no VideoFrames), so this is genuinely 0. The
      // present worker's destroyed-ack confirms the ring emptied (presentRing → 0) after it close()d them.
      openVideoFrames: this._tier === 'webcodecs' ? this.presentRing : 0,
    };
  }

  /** decode-relief LEVERS — toggle any subset LIVE (settable mid-playback, no reload). Only the
   *  keys provided change; the rest hold. `present` drives the PRESENT worker's manual present=half cap;
   *  `skipNonref` + `skipLoop` drive the DECODE worker's engine skip setter (read per-frame →
   *  honoured mid-stream). The owner flips combos and watches the real fixture; getStats().levers tags every
   *  telemetry record so the perf table + the visual line up by combo. No-op after destroy(). */
  setLevers(levers: { present?: boolean; skipNonref?: boolean; skipLoop?: boolean }): void {
    if (this.destroyed) return;
    if (levers.present !== undefined && levers.present !== this.leverPresentHalf) {
      this.leverPresentHalf = levers.present;
      this.postPresent({ type: 'setLever', present: this.leverPresentHalf });
    }
    let skipsChanged = false;
    if (levers.skipNonref !== undefined && levers.skipNonref !== this.leverSkipNonref) { this.leverSkipNonref = levers.skipNonref; skipsChanged = true; }
    if (levers.skipLoop !== undefined && levers.skipLoop !== this.leverSkipLoop) { this.leverSkipLoop = levers.skipLoop; skipsChanged = true; }
    if (skipsChanged) this.post({ type: 'setSkips', skipNonref: this.leverSkipNonref, skipLoop: this.leverSkipLoop });
  }

  /** Runtime deinterlace-mode override (0=off, 1=auto, 3=bwdif), settable mid-playback. Drives the
   *  DECODE worker's software deinterlacer (read per-frame → honoured mid-stream). No-op on the
   *  WebCodecs/HW tier (it deinterlaces in hardware) and after destroy(). */
  setDeint(mode: number): void {
    if (this.destroyed) return;
    this.post({ type: 'setDeint', mode });
  }

  get volume(): number { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.audioGain) this.audioGain.gain.value = this._muted ? 0 : this._volume;
  }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    if (this.audioGain) this.audioGain.gain.value = m ? 0 : this._volume;
  }

  // ---- typed event bus (mpegts on/off; listeners receive variadic args) -------

  on(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  off(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  private emit(type: string, ...args: any[]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`ferrite: listener for '${type}' threw (isolated)`, err);
      }
    }
  }

  /** Emit ERROR in the verbatim mpegts (type, details, info) positional shape the host expects. */
  private emitError(e: FerriteError): void {
    this._lastError = e;
    this.emit(Events.ERROR, e.type, e.details, e.info);
  }

  // ---- present-clock re-arm helpers ------------------------------------------

  /** Tell the present worker to flush its ring (recycle software buffers / close VideoFrames) and
   *  re-anchor a fresh timeline. Sent on (re)load / unload / seek / live-resume — exactly where main
   *  used to recycleRing()+resetClock() when present was colocated. */
  private resetPresent(gen: number): void {
    this.postPresent({ type: 'reset', gen });
  }

  /** Re-arm the audio epoch (master clock): drop the in-flight segment FIFO + media accounting, reset
   *  the latency-sync state, and ZERO the published clock so the present worker holds until the new
   *  audio re-seeds it. */
  private resetAudioEpoch(): void {
    this.audioActive = false;
    this.audioNextStart = 0;
    this.segQ = [];
    this.mediaBase = 0;
    this.liveSyncStalls = 0;
    this.liveSyncSmoothChunks = 0;
    this.liveSyncHoldChunks = 0;
    this.liveSyncLastRate = 1;
    this.liveLatencySecs = 0;
    this._workerStats = null;
    // Re-seed the Step-0 stall instrument: a new audio epoch (re-attach/seek/resume) must NOT count the
    // teardown/seek pause as an inter-tick gap. Zeroing cpLastAt makes the next publishClock tick re-seed
    // the report window instead of measuring a bogus multi-second gap. audioDrops is NOT reset here — like
    // audioUnderruns it is a cumulative cross-epoch health counter.
    this.cpLastAt = 0;
    this.cpMaxGap = 0;
    if (this.clock) { Atomics.store(this.clock, C_AUDIO, 0); Atomics.store(this.clock, C_ACLOCK, 0); }
  }

  // ---- worker messages (DECODE worker) ---------------------------------------

  private onWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        this._workerInfo = msg.info;
        this._tier = msg.info.tier; // tier known before the first per-second stats sample
        this.controller.dispatch({ type: 'opened' }); // opening → buffering (fidelity; no teardown effect)
        this.emit(Events.MEDIA_INFO, this.mediaInfo);
        break;
      case 'caps':
        // The worker resolved the descriptor from the first response's headers (LIVE/VOD UNIFICATION
        // Tier 1). REFINE main's intent-only copy so the seek()/duration/seekbar forks key on the observed
        // capabilities (e.g. a degraded-200 VOD flips seekable→false → seekbar hides). Re-emit MEDIA_INFO
        // so a controls layer re-renders the scrub-vs-live decision against the refined duration.
        this._caps = msg.caps;
        if (this.mediaInfo) this.emit(Events.MEDIA_INFO, this.mediaInfo);
        break;
      case 'log':
        this.emit(Events.LOG, msg.message);
        break;
      case 'deintFailed':
        this.emit(Events.DEINT_FAILED, msg.failed);
        break;
      case 'audio':
        this.playAudio(msg.pcm, msg.channels, msg.sampleRate, msg.ptsUs);
        break;
      case 'duration':
        // VOD container duration (ms). Drives the `duration` getter + the scrub bar; emit MEDIA_INFO so
        // a controls layer re-renders. The worker posts `ready` (→ _workerInfo) BEFORE this.
        this._durationMs = msg.durationMs;
        if (this.mediaInfo) this.emit(Events.MEDIA_INFO, this.mediaInfo);
        break;
      case 'stats':
        this.updateStats(msg.stats);
        this.emit(Events.STATISTICS_INFO, this._stats);
        break;
      case 'ended':
        this._paused = true;
        this.emit(Events.LOADING_COMPLETE);
        break;
      case 'reconnecting':
        // a recoverable live drop is re-opening with backoff → drive the controller into
        // Reconnecting (Playing/Buffering → Reconnecting). Re-arm the first-frame latch so the post-
        // recovery pre-roll re-fires `lowWater` (Reconnecting → Buffering → Playing). Stays internal
        // (a LOG breadcrumb) — Events.ERROR is reserved for the FATAL exhausted case (errors.ts).
        this.controller.dispatch({ type: 'reconnect' });
        this.firstFrameSeen = false;
        this.emit(Events.LOG, `reconnecting (attempt ${msg.attempt})`);
        break;
      case 'recovered':
        if (this._lastError && !this._lastError.info.fatal) this._lastError = null;
        this.controller.dispatch({ type: 'recovered' }); // Reconnecting → Buffering (next frame → Playing)
        this.emit(Events.RECOVERED_EARLY_EOF);
        break;
      case 'error': {
        if (msg.fatal) this._paused = true;
        if (msg.kind === 'engine-load') this.engineDead = true; // terminal for this instance
        const err = mapFerriteError(msg.kind, msg.code, msg.msg, msg.fatal);
        // FIX 1: a FATAL worker error (decode failure, exhausted reconnect, engine-load failure) drives the
        // controller's teardown so the 2 workers + AudioContext + clock publisher don't leak; a NON-fatal
        // one stays emitError-only so recover() can re-load over the surviving resources.
        if (msg.fatal) this.handleFatal(err);
        else this.emitError(err);
        break;
      }
    }
  }

  // ---- worker messages (PRESENT worker) --------------------------------------

  private onPresentMessage(msg: PresentToMain): void {
    switch (msg.type) {
      case 'plog': // DIAGNOSTIC: present-worker per-tick view → Events.LOG → /pumplog
        if (DEBUG) this.emit(Events.LOG, msg.m);
        break;
      case 'time':
        // The drawn front frame's PTS (ms) drives the facade clock + TIME_UPDATE (throttled worker-side).
        // First drawn frame ⇒ the pre-roll reached the watermark: buffering → playing (one-shot fidelity).
        if (!this.firstFrameSeen) { this.firstFrameSeen = true; this.controller.dispatch({ type: 'lowWater' }); }
        this._currentMs = msg.ms;
        this.emit(Events.TIME_UPDATE, msg.ms / 1000);
        break;
      case 'vdims':
        // WebCodecs frame dims (the demuxer reports WC dims as 0) → keep videoWidth/Height accurate.
        if (this._workerInfo && (this._workerInfo.width !== msg.w || this._workerInfo.height !== msg.h)) {
          this._workerInfo = { ...this._workerInfo, width: msg.w, height: msg.h };
          this.emit(Events.MEDIA_INFO, this.mediaInfo);
        }
        break;
      case 'pstats':
        this.presentRing = msg.ring;
        this.presentRingCap = msg.cap;
        this.presentFps = msg.presentFps;
        // mirror the present-cadence (smoothness) measured in the present worker's draw path.
        this.presentIntervalMs = msg.presentIntervalMs;
        this.presentIntervalP95Ms = msg.presentIntervalP95Ms;
        this.presentIntervalMaxMs = msg.presentIntervalMaxMs;
        this.presentStutters = msg.presentStutters;
        this.presentSeamGaps = msg.presentSeamGaps;
        // Clock/draw instrument (why distinct draws can pace below the content rate on a seam-free clip).
        this.clockAdvanceFps = msg.clockAdvanceFps;
        this.clockRateRatio = msg.clockRateRatio;
        this.clockResidualMs = msg.clockResidualMs;
        this.rafFps = msg.rafFps;
        this.presentDropsPerSec = msg.presentDropsPerSec;
        // display-cadence instrument (the mpv-style Bresenham num_vsyncs fix)
        this.vsyncIntervalMs = msg.vsyncIntervalMs;
        this.displayHz = msg.displayHz;
        this.cadenceHoldMean = msg.cadenceHoldMean;
        this.cadenceHold2Frac = msg.cadenceHold2Frac;
        this.cadenceErrorMs = msg.cadenceErrorMs;
        this.syncResyncsPerSec = msg.syncResyncsPerSec;
        // graceful-degradation cadence tier (present-every-Nth-frame on a memory-bandwidth-bound client)
        this.cadenceTier = msg.cadenceTier;
        this.cadenceDrawRate = msg.cadenceDrawRate;
        this.cadenceDegradeReason = msg.cadenceDegradeReason;
        this.cadenceRung = msg.cadenceRung;
        break;
      case 'error':
        // FIX 1: a present-worker error (incl. present-init / WebGL2-unavailable failure) is fatal — route
        // it through teardown so the decode worker + AudioContext are reaped too, not just surfaced.
        this.handleFatal(mapFerriteError('worker', -1, msg.message, true));
        break;
      // 'destroyed' is consumed by shutdownPresent's repointed handler.
    }
  }

  private updateStats(s: WorkerStats): void {
    this._tier = s.tier;
    this._workerStats = s;
    this._stats = {
      playerType: 'FerritePlayer',
      url: this.url,
      tier: s.tier,
      decodedFrames: s.decodedFrames,
      droppedFrames: s.droppedFrames,
      speed: s.ingestKBps,
    };
  }

  // ---- audio playout + master-clock publish ----------------------------------

  private ensureAudio(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext();
    this.audioGain = this.audioCtx.createGain();
    this.audioGain.gain.value = this._muted ? 0 : this._volume;
    this.audioGain.connect(this.audioCtx.destination);
  }

  /** Publish the audio playout elapsed into the clock SAB (the present worker's `media_now` source).
   *  Closed-loop from the in-flight segment FIFO (each segment at its own rate); MONOTONIC across an
   *  underrun. Frozen while the context is suspended (paused) → the present clock holds. */
  private publishClock(): void {
    const clk = this.clock;
    if (!clk) return;
    // ---- DIAGNOSTIC: measure the inter-tick gap (proves a main-thread stall; observe-only) ----
    // Cheap: one perf.now() + a compare + a ~1/s emit. A gap ≫ CLOCK_PUBLISH_MS means main was blocked
    // and the timer queued behind a long task → the SAB clock could not be refreshed → present froze.
    // segQ/ahead growing alongside the gap ⇒ the reservoir blocker; a gap WITHOUT growth ⇒ GC.
    if (DEBUG) {
      const perfNow = performance.now();
      if (this.cpLastAt > 0) {
        const gap = perfNow - this.cpLastAt;
        if (gap > this.cpMaxGap) this.cpMaxGap = gap;
      } else {
        this.cpReportAt = perfNow; // first tick: seed the report window (no gap yet)
      }
      this.cpLastAt = perfNow;
      if (perfNow - this.cpReportAt >= 1000) {
        this.emit(Events.LOG, `[clock] maxGap=${this.cpMaxGap | 0}ms segQ=${this.segQ.length} ahead=${this.liveLatencySecs.toFixed(2)}s drops=${this.audioDrops}`);
        this.cpMaxGap = 0;
        this.cpReportAt = perfNow;
      }
    }
    const ctx = this.audioCtx;
    if (!ctx || !this.audioActive) { Atomics.store(clk, C_AUDIO, 0); return; }
    if (ctx.state === 'suspended') return; // frozen current_time → leave the last published value
    const now = ctx.currentTime;
    // Pop every segment fully in the past, accruing its media into mediaBase (each at its own rate).
    const q = this.segQ;
    while (q.length && now >= q[0].ws + q[0].media / q[0].rate) { this.mediaBase += q[0].media; q.shift(); }
    const elapsed = q.length
      ? this.mediaBase + Math.max(0, now - q[0].ws) * q[0].rate
      // Nothing scheduled ahead (underrun/EOF tail): COAST on the wall clock from where audio left off
      // so the present clock keeps moving instead of dead-stalling.
      : this.mediaBase + Math.max(0, now - this.audioNextStart);
    const lat = (ctx as unknown as { outputLatency?: number }).outputLatency ?? 0;
    const elapsedSecs = Math.max(0, elapsed - lat);
    Atomics.store(clk, C_ACLOCK, Math.round(elapsedSecs * 1000)); // MILLISECONDS (wrap-safe i32)
    Atomics.store(clk, C_AUDIO, 1);
  }

  // ptsUs is unused: audio scheduling is wall-clock-driven (audioNextStart), not PTS-driven.
  private playAudio(interleaved: Float32Array, channels: number, sampleRate: number, _ptsUs: number): void {
    if (!this.audioCtx || !this.audioGain || this._paused) return;
    // ---- Tier-1 Step 1: bound the audio reservoir (drop, don't queue) ----
    // The decode-vs-realtime surplus schedules chunks ever-further into the future → the reservoir
    // (scheduledAhead) climbs to ~2.5s, deepening the live AudioBufferSourceNode queue + GC churn that
    // stalls main and starves the clock publisher (the freeze). If the cursor is already past the
    // liveSyncMaxLatency cap, DROP this chunk: a sub-frame live audio gap is far cheaper than a 2s
    // present freeze (mpv/VLC bound the device buffer / hard-resync past a threshold; this is the
    // symmetric UPPER bound to policy.ts's lower-target relax). Critically the drop does NOT touch
    // segQ/mediaBase/audioNextStart — the published A_ACLOCK stays MONOTONIC (no backward jump/judder).
    const scheduledAhead = this.audioActive ? Math.max(0, this.audioNextStart - this.audioCtx.currentTime) : 0;
    if (this.audioActive && scheduledAhead > this.cfg.liveSyncMaxLatency) {
      this.audioDrops++;
      this.liveLatencySecs = scheduledAhead; // telemetry only (no clock state) — keeps [clock] ahead=/latencyToLive honest during the drain burst so Step 0 SEES the reservoir pinned at the cap
      return; // before any buffer/source allocation and without advancing the schedule cursor
    }
    const frames = interleaved.length / channels;
    if (frames <= 0) return;
    const buf = this.audioCtx.createBuffer(channels, frames, sampleRate);
    for (let c = 0; c < channels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) ch[i] = interleaved[i * channels + c];
    }
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.audioGain);
    // Tier-1 Step 2: no per-node `src.onended = () => src.disconnect()`. A finished AudioBufferSourceNode
    // releases its playing-reference and is GC-eligible even while still connected (WebAudio spec), so the
    // closure + disconnect were needless per-chunk churn (a retained closure + a graph mutation per chunk)
    // feeding exactly the GC pressure that stalls main. Let the finished node fall out of scope.
    const ctx = this.audioCtx;

    // ---- live latency-sync: this chunk's master-clock playback rate ----
    if (this.liveSyncHoldChunks > 0) this.liveSyncHoldChunks--;
    let rate = 1;
    if (this.cfg.liveSync && this._caps.hasLiveEdge) {
      const scheduledAhead = Math.max(0, this.audioNextStart - ctx.currentTime);
      this.liveLatencySecs = scheduledAhead; // latency-to-live proxy (the reservoir signal)
      const target = liveSyncTarget(this.liveSyncStalls, this.cfg.liveSyncTargetLatency, this.cfg.liveSyncMaxLatency);
      const forceUnity = !this.audioActive || this.liveSyncHoldChunks > 0;
      rate = liveSyncRate(
        scheduledAhead, target, scheduledAhead, forceUnity,
        this.cfg.liveSyncPlaybackRate, this.cfg.liveSyncDeadbandSecs,
        this.cfg.liveSyncGateSecs, this.cfg.liveSyncSigmoidSteepness,
      );
      this.liveSyncSmoothChunks++;
      if (this.liveSyncSmoothChunks >= LIVE_SYNC_STALL_DECAY_CHUNKS && this.liveSyncStalls > 0) {
        this.liveSyncStalls--; this.liveSyncSmoothChunks = 0;
      }
      if (DEBUG && Math.abs(rate - this.liveSyncLastRate) > 1e-4) {
        this.liveSyncLastRate = rate;
        console.debug(`FERRITE live-sync: rate=${rate.toFixed(3)} buf=${scheduledAhead.toFixed(3)}s target=${target.toFixed(3)}s stalls=${this.liveSyncStalls}`);
      }
    }

    let start: number;
    if (!this.audioActive) {
      // First chunk after a (re)anchor: lead by 0.15 s so the master clock + the first frames have a
      // cushion before audio is audible. Until ctx reaches it, the published elapsed is 0 → the present
      // worker holds on its video anchor. This SEEDS the fresh audio epoch (segQ/mediaBase were zeroed
      // by resetAudioEpoch).
      start = ctx.currentTime + 0.15;
      this.audioActive = true;
    } else {
      start = this.audioNextStart;
      if (start < ctx.currentTime) {
        // Audio-health instrument: count the underrun + the silence it inserts (the cursor fell `behind`
        // s and we additionally lead by 0.05 s). The clock is audio-locked, so this IS a present stutter.
        this.audioUnderruns++;
        this.audioGapSecs += (ctx.currentTime - start) + 0.05;
        // Underrun: scheduled audio fell behind. Reschedule with a small gap and re-anchor the SCHEDULE
        // cursor (next_start) — but DON'T touch segQ/mediaBase: the published A_ACLOCK stays MONOTONIC,
        // so the present worker never sees a backward clock jump (the reference player's model — its
        // present worker owns the video anchor and re-anchors only on PTS-seam detection, never on an
        // audio underrun). Count the stall (relax the target) + pin rate 1.0 for a hold window.
        start = ctx.currentTime + 0.05;
        const maxStalls = Math.max(0,
          Math.ceil((this.cfg.liveSyncMaxLatency - this.cfg.liveSyncTargetLatency) / LIVE_SYNC_STALL_RELAX_SECS));
        this.liveSyncStalls = Math.min(this.liveSyncStalls + 1, maxStalls);
        this.liveSyncSmoothChunks = 0;
        this.liveSyncHoldChunks = LIVE_SYNC_RESUME_HOLD_CHUNKS;
      }
    }
    if (rate !== 1) src.playbackRate.value = rate;
    src.start(start);
    // The buffer is buf.duration MEDIA seconds but plays in …/rate WALL seconds (faster), so advance
    // the wall cursor by the shorter playout duration + record the segment for the closed-loop clock.
    this.audioNextStart = start + buf.duration / rate;
    this.segQ.push({ ws: start, media: buf.duration, rate });
  }

  private post(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }
  private postPresent(msg: MainToPresent, transfer: Transferable[] = []): void {
    this.present?.postMessage(msg, transfer);
  }
}

/** mpegts.createPlayer parity — the host's single construction entry point. */
export function createPlayer(dataSource: MediaDataSource, config?: Partial<FerriteConfig>): FerritePlayer {
  return new FerritePlayer(dataSource, config);
}

// The mpegts-shaped namespace (default export).
const Ferrite = {
  createPlayer,
  isSupported,
  getFeatureList,
  version,
  Events,
  ErrorTypes,
  ErrorDetails,
  LoaderErrors,
};
export default Ferrite;

export { Events, ErrorTypes, ErrorDetails, LoaderErrors, mergeConfig };
export type { FerriteConfig, FerriteStats, MediaDataSource, MediaInfo, StatisticsInfo, Tier, FerriteError };
