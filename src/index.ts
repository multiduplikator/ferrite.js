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
import type { MainToWorker, WorkerToMain, MainToPresent, PresentToMain, MainToAudio, AudioToMain, MainToDemux, DemuxToMain } from './protocol';
import { CLOCK_SLOTS, C_AUDIO, C_OUTPUT_LATENCY_MS, DEMUX_STREAM_VIDEO, DEMUX_STREAM_AUDIO } from './protocol';
import { VIDEO_RING_SAB_BYTES } from './policy';
import { allocPacketRing } from './worker/packet-ring-io';
import { PR_CTRL_SLOTS, PR_DROPS } from './packet-ring';
import {
  LOW_WATER_DEFAULT_FLOOR, wcRingCapForPlatform, WC_RING_CAP_DEFAULT,
} from './policy';
import {
  RING_CTRL_SLOTS, RING_CHANNELS,
  RW_WRITE, RW_READ, RW_UNDERRUNS, RW_OVERWRITES, RW_BASE_MS, RW_PLAYING, RW_RATE, RW_GEN,
  RW_EDGE_FRAME, RW_EDGE_PTS_MS, RW_EPOCH_SEQ,
  ringFramesFor, ringSabBytes, AUDIO_PREFILL_SECS,
} from './audio-ring';
import { PROCESSOR_NAME, workletUrl } from './worker/audio-worklet';
import { currentPlatform, type PlatformInfo } from './platform';
import { PlaybackController, type PlaybackCommand } from './controller/playback';
import { deriveCapabilities, type SourceCapabilities } from './source/capabilities';

export const version = '1.3.4';

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

// ---- audio playout: the off-main PCM-ring + AudioWorklet contract -------------------------
// The per-chunk createBufferSource scheduler (segQ/audioNextStart/publishClock setInterval) is RETIRED.
// The decode worker now writes engine-resampled interleaved-stereo PCM STRAIGHT into a shared ring (audio-
// ring.ts); a persistent AudioWorkletProcessor (audio-worklet.ts) pulls one render quantum per process()
// call AND is the SOLE writer of the cross-realm master clock SAB (C_ACLOCK/C_AUDIO) — so MAIN never
// runs a main-thread clock timer (the freeze bug: a long task starved the setInterval → the SAB froze →
// present starved). MAIN's only audio jobs now are: own the AudioContext lifecycle/recovery, size + seed
// the ring SAB, gate RW_PLAYING (play/pause/rebuffer), and drive the DOM-bound makeup GainNode from the
// worker's ~2 Hz loudness stats.
const AUDIO_RING_SECONDS = 0.5; // ring headroom (frames at the ctx output rate); rides ingest hiccups.
// AUDIO PACKET RING: the encoded-AU SAB the demux+video worker fills + the AUDIO worker consumes.
// 512 KiB matches the reference player's AUDIO_RING_BYTES — far more than the demux read-ahead ever buffers
// (~1 s of AAC ≈ tens of KiB), with the demux read-ahead gate keeping it well below the cap so a drop is only
// a genuine overflow (the audio worker wedged). Allocated on MAIN (so MAIN could read depth for telemetry),
// handed by reference to the producer (decode worker init) + the consumer (audio worker audioInit).
const AUDIO_PACKET_RING_BYTES = 512 * 1024;
// VIDEO PACKET RING: the encoded-AU SAB the DEMUX worker fills (stream 0) + the VIDEO worker
// consumes. Sized from policy.ts VIDEO_RING_SAB_BYTES (32 MiB) — deep enough to HOLD the LIVE demux read-ahead
// (LIVE_READAHEAD_MS=4000) at 4K-HEVC bitrates, with the demux's per-ring byte ceiling (VIDEO_RING_CEIL_BYTES=
// 28 MiB) below the cap so a drop is only a genuine overflow. Allocated on MAIN (so MAIN can read depth for
// telemetry), handed by reference to the producer (demux worker demuxInit) + the consumer (video worker init).
const VIDEO_PACKET_RING_BYTES = VIDEO_RING_SAB_BYTES;
// Live resume-edge re-arm gate: a resume that reaches `running` PROMPTLY after play() is a normal start
// (desktop's lenient activation, or a gesture-created ctx) — play()'s own epoch + the worker's fresh-anchor
// coalesce already handle it, so re-arming would needlessly drop the startup buffer. Only a DELAYED resume
// (iOS missed the activation window → a later gesture; or an interrupted/suspended recovery seconds later)
// indicates a stale backlog that must be SNAPPED to the live head (the 0ed29715 gate).
const AUDIO_REARM_MIN_DELAY_MS = 500;
// AudioContext interrupted-state recovery (OWN ctx only; a host ctx is recovered by the host over its full
// lifetime — see host-audio.ts). iOS freezes the master clock on the non-standard `interrupted` state
// (phone call/Siri/route change) and Chromium can drop to `suspended` mid-stream; either freezes the whole
// pipeline (audio IS the clock). Re-resume on a backoff, capped so a persistent interruption doesn't spin.
const AUDIO_RECOVERY_MAX_ATTEMPTS = 8;
const AUDIO_RECOVERY_BACKOFF_MIN_MS = 250;
const AUDIO_RECOVERY_BACKOFF_MAX_MS = 5000;

// ---- loudness AGC (the reference player's RMS-dBFS → makeup-gain leveller) ----------------------------
// The RMS/peak FOLD now runs in the decode worker (where the PCM lives); MAIN keeps only the DOM-bound
// GainNode makeup, driven by the worker's reported loudnessDb/peak (update_loudness_gain/apply_audio_gain).
// Steady-state live audio-buffer target (s) surfaced as getStats().targetLatency (the a.sync overlay row's
// reference; the reservoir is bounded by drop-to-live, not chased by playback rate — mpv-faithful).
const LIVE_TARGET_LATENCY_SECS = 0.375;
const AGC_TARGET_DB = -18;       // RMS-dBFS target the long-term loudness is nudged toward
const AGC_MAX_BOOST_DB = 6;      // asymmetric: lift a quiet source by at most +6 dB
const AGC_MAX_CUT_DB = 9;        // attenuate a hot source by at most −9 dB
const AGC_RAMP_TC_S = 0.25;      // setTargetAtTime ramp → smooth gain changes (no zipper noise)
const AGC_GAIN_EPS_DB = 0.1;     // skip re-ramping the GainNode for a sub-0.1 dB change (zipper/churn)

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
  // The SINGLE source-policy descriptor (live/VOD). Computed intent-only at construct/
  // load (so the known-path forks behave correctly IMMEDIATELY, before the worker reports), then REFINED
  // when the worker posts `caps` (the first-response headers). Every main-side live/VOD fork reads a field
  // of this — seek()/seekbar/duration (seekable), live-edge catch-up (hasLiveEdge), the
  // controller transport mode (declaredLive) — never `_isLive` directly.
  private _caps: SourceCapabilities;

  private worker: Worker | null = null;          // VIDEO decode worker (video-only — consumes the video packet ring)
  private present: Worker | null = null;          // PRESENT worker (owns the OffscreenCanvas)
  private audio: Worker | null = null;           // AUDIO worker (own ferrite realm — audio decode + PCM producer)
  private demux: Worker | null = null;           // DEMUX worker (own ferrite realm — ingest/source/demux + both ring producers)
  // Deferred demux outbox: the demux worker posts `demuxWorkerReady` once its onmessage is live; we hold
  // demuxInit / demuxLoad / etc. until then so they arrive in order (mirrors the audio outbox + the reference player's
  // pending_demux_init). Module workers buffer anyway, but the ready gate keeps the ORDER explicit + robust.
  private demuxReady = false;
  private demuxOutbox: MainToDemux[] = [];
  // Deferred audio outbox: blob-vs-module aside, the audio worker posts `audioWorkerReady` once its onmessage
  // is live; we hold audioSetPcmRing / audioCodecParams / audioLoad / etc. until then so they arrive in order
  // after its audioInit (mirrors the reference player's pending_audio_init + audio_outbox flush). Module workers buffer
  // anyway, but the ready gate keeps the ORDER (audioInit must precede SetPcmRing) explicit + robust.
  private audioReady = false;
  private audioOutbox: MainToAudio[] = [];
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

  // ---- cross-realm master clock: the AudioWorklet (off main) is the SOLE writer of the audio playout
  //      elapsed here; the present worker reads it via Atomics. MAIN no longer writes C_ACLOCK/C_AUDIO and
  //      no longer runs a main-thread publish timer (that setInterval was the freeze bug). Created only
  //      when crossOriginIsolated (SAB requires it). ----
  private clockSab: SharedArrayBuffer | null = null;
  private clock: Int32Array | null = null;

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
  private cadenceDropToKey = 0;     // Fix-B rung-4 fires this load (Live drop-to-keyframe); 0 on a healthy stream
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
  // mpv audio_start_ao: while pending, audio output is WITHHELD (RW_PLAYING gated via internalPaused) until the
  // video clock reaches the audio first-sample PTS — so audio never leads video at startup. Armed on play()
  // (= !firstFrameSeen), released by maybeStartAudioAo() from play()/the present time tick/decode ready.
  private audioSyncPending = false;
  private outputLatencyMs = 0; // AudioContext.outputLatency (ms) — published to C_OUTPUT_LATENCY_MS + folded into apts

  // ---- media-facade state ----
  private _paused = true;
  private _currentMs = 0;
  // Single-domain lip-sync (ms): the present worker computes av_diff (master clock − displayed PTS) at the
  // SAME draw instant (both clocks live there) and ships it on the `time` message — so getStats() never
  // subtracts a stale _currentMs from a fresh audio read (mpv update_av_diff). NaN until the first time post.
  private presentAvDiffMs = Number.NaN;
  private _durationMs = 0;     // VOD container duration (0 = live/unknown) — drives duration + the scrub bar
  private _volume = 1;
  private _muted = false;
  private _tier: Tier = 'software';
  private _workerInfo: WorkerMediaInfo | null = null;
  private _stats: StatisticsInfo = { playerType: 'FerritePlayer', url: '', tier: 'software', decodedFrames: 0, droppedFrames: 0, speed: 0 };
  private _workerStats: WorkerStats | null = null; // last raw per-interval worker telemetry (feeds getStats)
  private _lastError: FerriteError | null = null;

  // ---- audio (the off-main PCM-ring + AudioWorklet master clock) ----
  // The AudioContext: either a HOST-injected, app-lifetime, gesture-unlocked, recovered ctx (attachAudio)
  // or — standalone — an OWN per-stream ctx the player creates/resumes/closes itself. `audioCtxIsHost`
  // keys every own-vs-host fork (resume/suspend/close + statechange recovery): the host ctx is NEVER
  // closed/suspended/handler-touched by the player (it outlives this player + may feed other consumers).
  private audioCtx: AudioContext | null = null;
  private hostAudioCtx: AudioContext | null = null; // injected via attachAudio() before play()
  private audioCtxIsHost = false;
  private audioGain: GainNode | null = null;
  // Bluetooth/OS-route keepalive: a hidden, near-silent looping <audio> started across a pause/unload (OWN
  // ctx only) so the BT/system audio session stays awake — without it the first audio after a pause eats the
  // ~200 ms BT re-wake gap (a clipped resume). A HOST ctx is app-lifetime + the host owns its route, so the
  // keepalive is own-ctx-only; stopKeepalive is a harmless no-op when no element was created.
  private keepaliveEl: HTMLAudioElement | null = null;
  private keepaliveUrl: string | null = null;
  private audioActive = false; // mirrors the worker's audioStats.active (audio is the live master clock)

  // ---- the PCM ring SAB (producer = decode worker, consumer = the AudioWorklet) ----
  // MAIN allocates + SEEDS it (it can read the control slots for telemetry — underruns/depth), then hands
  // the producer side to the decode worker (audioSetPcmRing) and the same SAB to the worklet (processor-
  // Options.ring). MAIN never writes the data region nor the producer cursors; it owns only RW_PLAYING.
  private audioRingSab: SharedArrayBuffer | null = null;
  private audioRingCtrl: Int32Array | null = null;  // the control header (Atomics) — telemetry + RW_PLAYING
  private videoPktCtrl: Int32Array | null = null;   // the video packet-ring control view — PR_DROPS telemetry
  private audioPktCtrl: Int32Array | null = null;   // the audio packet-ring control view — PR_DROPS telemetry
  private audioRingData: Float32Array | null = null; // interleaved-stereo data (worklet+worker own it; held for parity)
  private audioRingCap = 0;        // ring capacity in FRAMES (per channel)
  private audioRingGen = 0;        // load generation seeded into RW_GEN — the worklet drops a stale producer epoch
  private audioRingInstance = 0;   // monotonic ensure_audio counter — the spawnWorklet validity guard keys on it
  private audioWorklet: AudioWorkletNode | null = null;

  // ---- AudioContext interruption recovery (OWN ctx only) ----
  private audioResumeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private audioRecoveryAttempts = 0;
  private audioStatechangeHandler: (() => void) | null = null;
  // HOST ctx only: an addEventListener('statechange') listener (NOT ctx.onstatechange — the host owns that
  // property for its recovery ladder). Observes the host ctx's cold suspended→running edge so a stale PCM
  // backlog (worklet.process didn't run while suspended) is dropped via the same live re-arm the own-ctx path
  // uses. Removed on teardown (the host ctx outlives the player).
  private hostAudioStatechangeHandler: (() => void) | null = null;
  private audioPlayAtMs = 0; // perf.now() at the last live play() — gates the resume-edge re-arm (AUDIO_REARM_MIN_DELAY_MS)

  // ---- audio telemetry mirrored from the decode worker's ~2 Hz `audioStats` (feeds getStats + the AGC) ----
  private audioLoudnessDb = 0;  // reported RMS-dBFS loudness proxy — drives the makeup gain
  private audioPeak = 0;        // reported windowed peak |sample| — caps the makeup boost so it can't re-clip
  private audioDrops = 0;       // cumulative audio chunks the worker dropped at the ring cap (the reservoir bound)
  private audioSrcChannels = 0; // decoded SOURCE channels pre-downmix (6 for EAC3 5.1) — overlay "6→2ch"
  private audioStreamRate = 0;  // decoded source sample rate (Hz) — overlay "48.0→ctx48.0k"
  private liveLatencySecs = 0;  // latency-to-live proxy (s) — the worker's scheduledAhead reservoir signal
  private buffering = false;    // mpv cache-pause: the audio output starved → freeze the clock + present
  // ---- loudness AGC makeup state (DOM-bound GainNode; the RMS/peak FOLD runs in the worker now) ----
  // The GainNode composes volume × mute × the loudness makeup. `agcGainDb` is the current makeup in dB
  // (0 = unity until the first real measurement). update_loudness_gain recomputes it from the worker's
  // loudnessDb/peak; applyGain folds it into the node with a click-free ramp.
  private agcGainDb = 0;       // current makeup (dB); 0 = unity (unseeded / no-audio)
  private agcMakeup = 1;       // current makeup multiplier (linear), composed into the gain

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
    // video; a decoupled present-side drop-oldest was tried and rejected — it punched PTS holes → freeze-jump
    // on real streams). The in-flight/credit cap (= the present cushion depth) is the memory bound and is
    // iOS-aware to keep held frames inside the iPad budget under ?flood. ?ring (swPresentRingCap) overrides
    // the depth.
    this.ringCap = this.cfg.swPresentRingCap ?? (this.platform.isIOS ? RING_CAP_IOS : RING_CAP);
    this.swRingCap = this.ringCap + RING_HEADROOM;
    this.presentRingCap = this.swRingCap;
  }

  static isSupported = isSupported;

  // ---- controller lifecycle --------------------------------------------------

  /** Inject a HOST-OWNED, app-lifetime AudioContext (created + gesture-unlocked + recovered by the host —
   *  see host-audio.ts). The player attaches its per-stream nodes to it and NEVER creates/resumes/closes
   *  it. Call BEFORE play() (and before ensureAudio); harmless to call repeatedly. Without it, the player
   *  owns a per-stream context itself (the standalone path), which it resumes on play() + closes on
   *  teardown. (Mirrors the reference player's attach_audio.) */
  attachAudio(ctx: AudioContext): void {
    this.hostAudioCtx = ctx;
  }

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

    // The two PACKET RINGS: alloc on MAIN, hand the SAME SABs BY REFERENCE — the DEMUX worker is the
    // sole PRODUCER of each (on demuxInit), the AUDIO/VIDEO workers the sole CONSUMERS (on audioInit/init).
    // Like the clock SAB (NOT transferred — MAIN reads ring depth for telemetry).
    const audioPacketRing = allocPacketRing(AUDIO_PACKET_RING_BYTES);
    const videoPacketRing = allocPacketRing(VIDEO_PACKET_RING_BYTES);
    // Keep a control-region view of each packet ring so getStats() can read the demux's PR_DROPS counter
    // (the decode-bound diagnostic: a slow software decoder backs up its ring → the demux drops the oldest).
    this.videoPktCtrl = new Int32Array(videoPacketRing, 0, PR_CTRL_SLOTS);
    this.audioPktCtrl = new Int32Array(audioPacketRing, 0, PR_CTRL_SLOTS);

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

    // Spawn the VIDEO DECODE worker and hand it the OTHER channel end (transferred) + the VIDEO packet ring
    // CONSUMER end (shared by reference). Frames flow over the port to the present worker; recycled plane
    // buffers come back over it.
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
      isIOS: this.platform.isIOS,
      isAppleWebKit: this.platform.isAppleWebKit,
      fastDecode: this.cfg.fastDecode,
      debug: DEBUG,
      presentPort: chan.port2,
      ringCap: this.ringCap, // single source of truth for the worker's software in-flight (credit) bound (?ring)
      videoPacketRing, // the consumer end of the video AU ring (shared by reference; the demux worker is sole writer)
    }, [chan.port2]); // only the port is TRANSFERRED; the SABs (clock, videoPacketRing) are shared by reference

    // Spawn the DEMUX worker (its own ferrite realm — ingest/source/demux + BOTH ring producers). It
    // owns the source URL/isLive/seek/paused (MainToDemux). The `new Worker(new URL('./demux-worker.js', …))`
    // form is kept LITERAL so bundlers detect/copy/rewrite the worker chunk; cfg.demuxWorkerUrl overrides it.
    this.demux = this.cfg.demuxWorkerUrl
      ? new Worker(this.cfg.demuxWorkerUrl, { type: 'module' })
      : new Worker(new URL('./demux-worker.js', import.meta.url), { type: 'module' });
    this.demux.onmessage = (e: MessageEvent<DemuxToMain>) => this.onDemuxMessage(e.data);
    this.demux.onerror = (e: ErrorEvent) =>
      this.handleFatal(mapFerriteError('worker', -1, `demux-worker: ${e.message} @ ${e.filename}:${e.lineno}`, true));
    // demuxInit (engine params + BOTH ring producer ends + the adaptive low-water config). Posted immediately —
    // module workers buffer pre-onmessage posts; the demuxReady gate below sequences the follow-up demuxLoad.
    this.demuxReady = false;
    this.demuxOutbox.length = 0;
    this.postDemux({
      type: 'demuxInit', wasmBaseUrl: this.cfg.wasmBaseUrl,
      lowWaterFloor: this.cfg.stashInitialSize ?? LOW_WATER_DEFAULT_FLOOR,
      lowWaterCeiling: this.cfg.stashMaxSize,
      lowWaterAdaptive: this.cfg.stashAdaptive,
      isIOS: this.platform.isIOS,
      isAppleWebKit: this.platform.isAppleWebKit,
      debug: DEBUG,
      audioPacketRing, videoPacketRing, // both PRODUCER ends (shared by reference; this worker is sole writer of each)
    }, /* init= */ true);

    // Spawn the AUDIO worker (its own ferrite realm — audio decode + the PCM-ring producer). The
    // `new Worker(new URL('./audio-worker.js', import.meta.url), …)` form is kept LITERAL so bundlers
    // detect/copy/rewrite the worker chunk (a hoisted URL defeats it); cfg.audioWorkerUrl overrides it.
    this.audio = this.cfg.audioWorkerUrl
      ? new Worker(this.cfg.audioWorkerUrl, { type: 'module' })
      : new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
    this.audio.onmessage = (e: MessageEvent<AudioToMain>) => this.onAudioMessage(e.data);
    this.audio.onerror = (e: ErrorEvent) =>
      this.handleFatal(mapFerriteError('worker', -1, `audio-worker: ${e.message} @ ${e.filename}:${e.lineno}`, true));
    // audioInit (engine params + the audio packet ring consumer end). The PCM ring follows in audioSetPcmRing
    // once ensureAudio() allocs it (it sizes off ctx.sampleRate). Posted immediately — module workers buffer
    // pre-onmessage posts; the audioReady gate below sequences the FOLLOW-UP posts (SetPcmRing/load/codec).
    this.audioReady = false;
    this.audioOutbox.length = 0;
    this.postAudio({
      type: 'audioInit', wasmBaseUrl: this.cfg.wasmBaseUrl,
      isIOS: this.platform.isIOS, isAppleWebKit: this.platform.isAppleWebKit, debug: DEBUG,
      audioPacketRing,
    }, /* init= */ true);

    // (No main-thread clock publisher: the AudioWorklet is the SOLE writer of the clock SAB — it runs on
    // the audio render thread and never starves on a main-thread long task. This retired the setInterval
    // freeze bug.)

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
    // Create the AudioContext NOW (starts suspended; play() resumes it on the gesture) so its rate is known
    // and setAudioOutRate is outboxed BEFORE the audio worker's load below → the worker stores the engine
    // output rate before it opens the audio decoder, so the first chunks of the FIRST stream don't decode at
    // passthrough + get browser-resampled on a non-48k device (the opening-chunk rate race). Idempotent; also
    // means the first-load resetAudioEpoch below operates on a live ring. (Mirrors the reference player's load().)
    this.ensureAudio();
    // Diagnostic: log the RESOLVED knob config once (the defaults = today's behaviour).
    if (DEBUG && !this.cfgLogged) {
      this.cfgLogged = true;
      this.emit(Events.LOG, `smoothness knobs resolved: ringCap=${this.ringCap} swRingCap=${this.swRingCap}`);
    }
    // Reloading over a prior stream: re-arm the audio epoch + tell the present worker to flush its ring
    // and re-anchor so the new pipeline presents cleanly (no brief flash of the old timeline).
    const gen = ++this.loadGen;
    this.firstFrameSeen = false;
    this.audioSyncPending = false; // fresh load: play() re-arms the mpv audio_start_ao gate
    // Drive the controller into a live (non-terminal) state so a destroy racing this load transitions
    // through Closing identically (TOTAL). `load` only moves an idle controller; a reload from a live
    // state is inert in the reducer (harmless) — teardown is the same from any state anyway.
    // Re-derive the descriptor intent-only for THIS load (the worker refines + posts `caps` once the first
    // response lands); the controller transport mode keys on the declared intent (known before any response).
    this._caps = deriveCapabilities(this._isLive);
    this.controller.dispatch({ type: 'load', mode: this._caps.declaredLive ? 'live' : 'vod', url: this.url });
    this.resetAudioEpoch(false); // (re)load → ResetEpoch (the worker bumps RW_GEN + re-anchors the new pipeline)
    // Per-stream loudness reset: a reload over a live pipeline (e.g. recover(), no teardown) must re-level from
    // unity, not inherit the prior stream's AGC gain. (Mirrors the reference player's load().)
    this.agcGainDb = 0; this.agcMakeup = 1; this.audioLoudnessDb = 0; this.audioPeak = 0; this.applyGain();
    this.resetPresent(gen);
    this._durationMs = 0; // re-probed by the demux worker for VOD (stays 0 = Infinity for live)
    // the DEMUX worker owns the SOURCE (url/isLive/seek/paused) → demuxLoad. The VIDEO worker is
    // decode-only → its `load` carries only the epoch + isLive (the live-edge bit) + preferWebCodecs (no url).
    this.postDemux({ type: 'demuxLoad', gen, url: this.url, isLive: this._isLive, preferWebCodecs: this.cfg.preferWebCodecs });
    this.post({ type: 'load', gen, isLive: this._isLive, preferWebCodecs: this.cfg.preferWebCodecs });
    this.post({ type: 'credit', n: this.ringCap }); // seed the decode budget (software tier; ?ring depth)
    // Per-load the AUDIO worker re-levels loudness from scratch + runs its pump. The demux relays the resolved
    // codec params (codecParams) once it opens — the audio worker holds the codec until then.
    this.postAudio({ type: 'audioLoad', gen, isLive: this._isLive });
  }

  /** Stop the current stream pipeline but keep the workers/engine + canvas attached (mpegts unload). */
  unload(): void {
    if (this.destroyed || !this.worker) return;
    const gen = ++this.loadGen;
    this.postDemux({ type: 'demuxUnload', gen }); // tear down the source + demux (keep the engine)
    this.post({ type: 'unload', gen });           // tear down the video decoder (keep the engine)
    this.postAudio({ type: 'audioUnload', gen }); // tear down the audio decoder (keep the engine)
    this.setRingPlaying(false); // disarm output NOW (synchronous) so a chunk decoded in the unload window
    // can't keep the worklet draining against a stale clock anchor.
    this.resetAudioEpoch(false); // live restart/load → ResetEpoch (the worker bumps RW_GEN + re-anchors)
    this.resetPresent(gen);
    // OWN ctx only: hold the route + suspend across the unload (parity with pause()). A HOST ctx stays
    // running (the worklet is gated above; the host owns its route).
    if (!this.audioCtxIsHost) { this.startKeepalive(); this.audioCtx?.suspend().catch(() => {}); }
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
    if (cmd.type === 'emit' && cmd.event === 'ended') {
      // EOF effect: the controller reached Eof → pause + tell the host exactly once (so paused() then agrees).
      this._paused = true;
      this.emit(Events.LOADING_COMPLETE);
      return;
    }
    if (cmd.type !== 'teardown') return;
    switch (cmd.phase) {
      case 'pipeline': this.teardownPipeline(); break; // DECODE worker: abort source → free decoders → release held → reap pool → terminate
      case 'present':  this.teardownPresent();  break; // PRESENT worker: close ALL VideoFrames + dispose GL → terminate
      case 'audio':    this.teardownAudio();    break; // MAIN: disconnect the worklet + own-ctx close (host ctx node-only)
      case 'engine':   this.teardownEngine();   break; // MAIN (on Closed): finalize the baseline (engine died with the decode worker)
    }
  }

  /** OWNER: the DECODE worker. Graceful shutdown: it reaps its pooled decode Workers (each pinning a 2 GB
   *  SAB wasm instance) and aborts the in-flight source connection + releases all held frames BEFORE
   *  terminate() — the proven internal RAII order (worker.ts handleDestroy). Idempotent (null worker). */
  private teardownPipeline(): void {
    // FOUR realms. The DEMUX + AUDIO workers are decode realms too (their own ferrite engine), so reap
    // them in the SAME pipeline phase as the VIDEO worker — all before the AudioContext closes (the audio
    // phase). The DEMUX worker owns the SOURCE, so abort it FIRST so the in-flight `/proxy` fetch FINs promptly.
    const dx = this.demux;
    if (dx) { this.demux = null; this.demuxReady = false; this.demuxOutbox.length = 0; this.shutdownDemux(dx); }
    const a = this.audio;
    if (a) { this.audio = null; this.audioReady = false; this.audioOutbox.length = 0; this.shutdownAudio(a); }
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

  /** OWNER: MAIN. Tear down the audio playout. The AudioWorklet (audio decode is the decode worker; the
   *  clock is the worklet) is disconnected; an in-flight addModule future is discarded on resolve by the
   *  spawnWorklet validity guard (audioCtx now null / a fresh ensureAudio bumps the ring instance). An OWN
   *  per-stream ctx is closed (handler off + close); a HOST ctx is NEVER closed — node-only teardown — and
   *  its statechange handler is left untouched (the host owns it across the ctx's full lifetime; closing it
   *  would kill the next stream's audio + break the host's recovery). Keyed on audioCtxIsHost (the ACTIVE
   *  ctx), so a mis-ordered attach that left us on an OWN ctx still closes that own ctx (no orphan/leak).
   *  Idempotent (already-closed ctx / null refs). */
  private teardownAudio(): void {
    if (this.audioResumeTimer) { clearTimeout(this.audioResumeTimer); this.audioResumeTimer = 0; }
    this.audioRecoveryAttempts = 0;
    this.audioWorklet?.disconnect();
    this.audioWorklet = null;
    // Disconnect the per-stream gain explicitly: on a HOST ctx, ctx.close() won't run to release it, so a
    // connected node would leak (+ keep its AGC ramp) on the shared context. Harmless on the own-ctx path.
    this.audioGain?.disconnect();
    this.audioGain = null;
    this.audioRingCtrl = null;
    this.audioRingData = null;
    this.audioRingSab = null;
    this.audioRingCap = 0;
    const ctx = this.audioCtx;
    this.audioCtx = null;
    if (ctx) {
      if (this.audioCtxIsHost) {
        // HOST ctx: NEVER close it; leave the host's ctx.onstatechange (its recovery) alone. But DO remove OUR
        // addEventListener('statechange') running-edge observer — the ctx outlives the player, so a stale
        // closure would keep firing (+ re-arm) on the next stream's cold start.
        if (this.hostAudioStatechangeHandler) ctx.removeEventListener('statechange', this.hostAudioStatechangeHandler);
      } else {
        ctx.onstatechange = null;
        ctx.close().catch(() => {});
      }
    }
    this.hostAudioStatechangeHandler = null;
    this.audioCtxIsHost = false;
    this.audioStatechangeHandler = null;
    this.audioActive = false;
    this.agcGainDb = 0; this.agcMakeup = 1; this.audioLoudnessDb = 0; this.audioPeak = 0; // fresh leveller for the next load
    // Stop + release the BT keepalive element and revoke its object URL (no leak across teardown).
    if (this.keepaliveEl) { try { this.keepaliveEl.pause(); } catch { /* detached */ } this.keepaliveEl = null; }
    if (this.keepaliveUrl) { try { URL.revokeObjectURL(this.keepaliveUrl); } catch { /* already revoked */ } this.keepaliveUrl = null; }
    this.clock = null;
    this.clockSab = null;
  }

  /** Build a 0.5 s, 8 kHz, mono, 8-bit-PCM silence WAV as a blob: URL — the BT/OS-route keepalive source.
   *  8-bit unsigned PCM silence = 0x80. Tiny (≈4 KB); inaudible at volume 0.0001 but enough to hold the
   *  audio session. Returns null if the Blob/URL APIs are unavailable (non-fatal). */
  private makeSilentWavUrl(): string | null {
    try {
      const SR = 8000, N = SR / 2; // 0.5 s
      const buf = new Uint8Array(44 + N);
      const dv = new DataView(buf.buffer);
      const wr = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
      wr(0, 'RIFF'); dv.setUint32(4, 36 + N, true); wr(8, 'WAVE'); wr(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); // PCM, mono
      dv.setUint32(24, SR, true); dv.setUint32(28, SR, true); // sample rate, byte rate (8-bit mono)
      dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);   // block align, bits/sample
      wr(36, 'data'); dv.setUint32(40, N, true);
      buf.fill(0x80, 44); // 8-bit unsigned PCM silence
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    } catch { return null; }
  }

  /** Lazily build the hidden silent looping <audio> that holds the BT/OS audio route awake. */
  private ensureKeepalive(): HTMLAudioElement | null {
    if (!this.keepaliveEl) {
      const url = this.makeSilentWavUrl();
      if (!url) return null;
      try {
        const el = new Audio();
        el.src = url; el.loop = true; el.preload = 'auto'; el.volume = 0.0001; // inaudible but holds the session
        this.keepaliveUrl = url;
        this.keepaliveEl = el;
      } catch { try { URL.revokeObjectURL(url); } catch { /* ignore */ } return null; }
    }
    return this.keepaliveEl;
  }

  /** Hold the audio route across a pause/unload (OWN ctx only). Autoplay policy may block play() without a
   *  gesture — harmless (the user already interacted to start playback); the promise is fire-and-forget. */
  private startKeepalive(): void {
    const el = this.ensureKeepalive();
    if (el) el.play().catch(() => { /* autoplay-blocked / detached — non-fatal */ });
  }

  /** The main context is taking the audio session back (play/seek) → release the keepalive. No-op when no
   *  element was created (the host-ctx path never starts it). */
  private stopKeepalive(): void {
    if (this.keepaliveEl) { try { this.keepaliveEl.pause(); this.keepaliveEl.currentTime = 0; } catch { /* detached */ } }
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
    this.cadenceTier = 1; this.cadenceDrawRate = 0; this.cadenceDegradeReason = 0; this.cadenceRung = 0; this.cadenceDropToKey = 0;
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

  /** Drive the AUDIO worker's destroy handshake then terminate it. It frees its decoder + reaps its (small)
   *  pthread pool BEFORE acking `destroyed` (the same RAII order as the decode worker), so main can terminate
   *  with no orphaned threads. A timeout guarantees an unresponsive worker is still terminated. */
  private shutdownAudio(a: Worker): void {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      a.onmessage = null;
      a.onerror = null;
      a.terminate();
    };
    a.onmessage = (e: MessageEvent<AudioToMain>) => { if (e.data?.type === 'destroyed') finish(); };
    a.onerror = finish; // worker crashed → nothing left to reap, just terminate
    timer = setTimeout(finish, WORKER_SHUTDOWN_TIMEOUT_MS); // must exceed the worker's READY_SETTLE_MS + reap
    try { a.postMessage({ type: 'audioDestroy' } as MainToAudio); } catch { finish(); }
  }

  /** Drive the DEMUX worker's destroy handshake then terminate it. It aborts its source + frees its demux
   *  BEFORE acking `destroyed` (ferritePool=0 → no pthread pool to reap). A timeout guarantees an unresponsive
   *  worker is still terminated. */
  private shutdownDemux(dx: Worker): void {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      dx.onmessage = null;
      dx.onerror = null;
      dx.terminate();
    };
    dx.onmessage = (e: MessageEvent<DemuxToMain>) => { if (e.data?.type === 'destroyed') finish(); };
    dx.onerror = finish; // worker crashed → nothing left to reap, just terminate
    timer = setTimeout(finish, WORKER_SHUTDOWN_TIMEOUT_MS); // must exceed the worker's READY_SETTLE_MS
    try { dx.postMessage({ type: 'demuxDestroy' } as MainToDemux); } catch { finish(); }
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
    this.audioPlayAtMs = performance.now(); // resume-edge re-arm delay gate (AUDIO_REARM_MIN_DELAY_MS)
    this.audioSyncPending = !this.firstFrameSeen; // arm the mpv audio_start_ao gate (cleared once video reaches apts)
    this.ensureAudio();
    if (this._caps.hasLiveEdge) {
      // LIVE resync to the edge: re-arm the audio epoch (the worker snaps the ring to the live head) +
      // tell the present worker to drop the stale ring + re-anchor. (No-ops on the initial play.)
      this.resetAudioEpoch(false);
      this.resetPresent(this.loadGen);
    }
    // OWN ctx only: resume it here. A HOST ctx is resumed by the host on a real user gesture (the player
    // never resumes it — see attachAudio). The worklet is un-gated below regardless via setRingPlaying.
    if (!this.audioCtxIsHost && this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this.stopKeepalive(); // the main context is taking the audio session back
    this._paused = false;
    // Release audio NOW only if the gate's conditions are already met (video-only/audio-only escape, or the video
    // clock has already passed the audio start); else it stays WITHHELD, re-checked from the present Time tick +
    // decode Ready. A RESUME (audioSyncPending was false) un-gates immediately, unless something else withholds.
    if (this.audioSyncPending) this.maybeStartAudioAo();
    else this.setRingPlaying(!this.internalPaused());
    this.postDemux({ type: 'demuxSetPaused', paused: false }); // un-gate the source (the demux owns it now)
    this.post({ type: 'setPaused', paused: false });           // the video worker re-arms the resume IDR
    this.postAudio({ type: 'audioSetPaused', paused: false }); // un-gate the audio producer (writePcmChunk)
    this.postPresent({ type: 'setPaused', paused: false });
    return Promise.resolve();
  }

  pause(): void {
    if (this.destroyed) return;
    this.controller.dispatch({ type: 'userPause' }); // playing → paused (inert from other states)
    this.bgPaused = false; // a manual pause takes ownership (the visHandler re-sets it if it called us)
    this._paused = true;
    this.audioSyncPending = false; // a deliberate pause cancels a pending audio_start_ao sync; a later play re-arms
    // Flip RW_PLAYING=0 BEFORE suspending: the worklet then emits silence + HOLDS the read cursor (clock
    // frozen) and releases C_AUDIO on its next quantum — so the present worker stops seeing the audio clock
    // advance the instant we pause, not after the suspend lands.
    this.setRingPlaying(false);
    this.postDemux({ type: 'demuxSetPaused', paused: true }); // the demux tracks the live edge, discards
    this.post({ type: 'setPaused', paused: true });           // the video worker skips until the next IDR on resume
    this.postAudio({ type: 'audioSetPaused', paused: true }); // gate the audio producer (writePcmChunk no-ops)
    this.postPresent({ type: 'setPaused', paused: true }); // present worker freezes the clock + eviction
    // OWN ctx only: hold the BT/OS route + suspend across the pause. A HOST ctx is shared + app-lifetime →
    // leave it running (the worklet is already gated above via RW_PLAYING); suspending it would fight the
    // host's recovery and silence any other consumer of the shared context.
    if (!this.audioCtxIsHost) { this.startKeepalive(); this.audioCtx?.suspend().catch(() => {}); }
  }

  /** Seek to `seconds` — only on a SEEKABLE source (Range/206). Ignored on a non-seekable source (a live
   *  push with no ranges, or a declared-VOD origin that ignored Range → degraded 200). */
  seek(seconds: number): void {
    if (this.destroyed || !this.worker) return;
    if (!this._caps.seekable) { this.emit(Events.LOG, 'seek() ignored on a non-seekable source'); return; }
    let t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const dur = this._durationMs > 0 ? this._durationMs / 1000 : null;
    if (dur !== null) t = Math.min(t, Math.max(0, dur - 0.1)); // clamp inside the file
    // VOD seek: flush + seek-block the audio ring (NO early rebase) so a still-buffered pre-seek packet
    // can't anchor C_ACLOCK to the old position — the first post-seek chunk arms the rebase. (seek=true.)
    this.resetAudioEpoch(true);
    this.resetPresent(this.loadGen, t * 1000); // VOD seek → arm the present seek-hold at the target (mpv last_seek_pts)
    this._currentMs = t * 1000;
    this.postDemux({ type: 'demuxSeek', targetMs: t * 1000 }); // the demux owns the source + seek transport
    // Ensure the clock + audio can advance from the new position (resume; covers replay-after-end).
    this.bgPaused = false;
    this.ensureAudio();
    // OWN ctx only: the host resumes a host ctx on a gesture; the player never resumes it.
    if (!this.audioCtxIsHost && this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this.stopKeepalive(); // the main context is taking the audio session back
    this._paused = false;
    this.setRingPlaying(true); // a seek while paused (RW_PLAYING=0) leaves the worklet not draining → the
    // audio decoder backpressures and never produces the post-seek chunk that re-anchors C_ACLOCK.
    this.postDemux({ type: 'demuxSetPaused', paused: false }); // un-gate the source so it demuxes the post-seek segment
    this.post({ type: 'setPaused', paused: false });
    this.postAudio({ type: 'audioSetPaused', paused: false }); // un-gate the audio producer so it decodes the post-seek chunk
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
      cadenceDropToKey: this.cadenceDropToKey,
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
      // syncedToAudio: the worklet (sole clock writer) flags C_AUDIO=1 while audio is the live master clock
      // (it releases it to 0 on pause/underrun/no-audio) — read it straight from the clock SAB, AND require
      // the worker's audioActive (a stale C_AUDIO can't claim sync after the worker degraded to video-only).
      syncedToAudio: this.audioActive && !!this.clock && Atomics.load(this.clock, C_AUDIO) > 0,
      // audioQueue: the in-flight audio reservoir depth (frames buffered in the ring = write − read), the
      // off-main analog of the retired segQ FIFO depth.
      audioQueue: this.audioRingReadableFrames(),
      // Audio health (the clock is audio-locked → underruns/sparse audio stutter the present clock).
      // audioUnderruns now comes from the worklet's RW_UNDERRUNS slot (render quanta that found the ring
      // empty); audioGapSecs is retired (the free-running worklet skips the gap rather than inserting timed
      // silence, so there is no per-underrun gap-seconds tally) → 0; audioDrops is the worker's reservoir-cap
      // drop count from audioStats.
      audioUnderruns: this.audioRingCtrl ? Atomics.load(this.audioRingCtrl, RW_UNDERRUNS) : 0,
      audioGapSecs: 0,
      audioDrops: this.audioDrops,
      // Decode-bound diagnostics: PR_DROPS from each packet ring (the demux dropped the oldest AU because the
      // consumer fell behind — a slow software video decode backs up its ring), + the A/V lip-sync error.
      videoRingDrops: this.videoPktCtrl ? Atomics.load(this.videoPktCtrl, PR_DROPS) : 0,
      audioRingDrops: this.audioPktCtrl ? Atomics.load(this.audioPktCtrl, PR_DROPS) : 0,
      avDiffMs: this.avDiffMs(),
      buffering: this.buffering ? 1 : 0, // mpv cache-pause: 1 while the audio output is rebuffering (clock frozen)
      // speed: audio plays at 1.0× (the live-sync playbackRate chaser is retired; latency is bounded by the
      // ring drop-to-live, not by stretching audio), so the master clock runs at realtime.
      speed: 1,
      // recovery counters (un-stubbed): reconnects/stalls are the decode worker's authoritative
      // tallies (the error controller's recovery path); latencyToLive is the worker's reservoir proxy.
      reconnects: ws?.reconnects ?? 0,
      stalls: ws?.stalls ?? 0,
      latencyToLive: this.liveLatencySecs,
      audioScheduledAhead: this.liveLatencySecs, // reservoir depth (s) audio is scheduled ahead of ctx time
      // Audio-path overlay telemetry (a.buf / a.sync rows): source→output downmix, stream-vs-ctx sample rate,
      // the applied makeup gain + measured loudness, and the live buffer target the reservoir converges toward.
      audioSrcChannels: this.audioSrcChannels,
      audioOutChannels: RING_CHANNELS,
      audioStreamRate: this.audioStreamRate,
      audioCtxRate: this.audioCtx?.sampleRate ?? 0,
      audioGainDb: this.agcGainDb,
      audioLoudnessDb: this.audioLoudnessDb,
      targetLatency: LIVE_TARGET_LATENCY_SECS,
      // AUTHORITATIVE teardown counters. TWO provenances (FIX 2):
      //  - workers/audioContexts are read LIVE from main's own resource handles → 0 the instant the owner
      //    method nulls them synchronously (no async confirmation needed; main owns these directly).
      //  - connections/heldFrames/heapBytes come from the decode worker's FINAL post-reap stats and
      //    openVideoFrames from the present worker's `destroyed` ack (which zeroes presentRing). These are
      //    OWNER-CONFIRMED, not main-zeroed — so a residual connection / held frame / open VideoFrame
      //    surfaces here non-zero and the leak gate FAILS (the assertions are no longer vacuous).
      workers: (this.worker ? 1 : 0) + (this.present ? 1 : 0) + (this.audio ? 1 : 0) + (this.demux ? 1 : 0),
      audioContexts: this.audioCtx ? 1 : 0,
      connections: ws?.connections ?? 0, // decode worker owns the connection; confirmed 0 in its final stats
      // Un-closed WebCodecs VideoFrames pin the HW output pool — they live in the present ring on the WC
      // tier; on software the ring holds heap-slot tokens (no VideoFrames), so this is genuinely 0. The
      // present worker's destroyed-ack confirms the ring emptied (presentRing → 0) after it close()d them.
      openVideoFrames: this._tier === 'webcodecs' ? this.presentRing : 0,
      // Controller playback-state name (idle/opening/buffering/playing/paused/reconnecting/closing/closed).
      // A STABLE string a host maps to its own UI status (e.g. loading vs active vs ended) without polling
      // events — surfaced so the host never gets stuck on "loading" when playback is actually progressing.
      // Normalize the controller's internal 'eof' to the stable host string 'ended' (the host never sees the
      // internal name); every other state passes through (the host maps loading/active/ended itself).
      state: this.controller.name === 'eof' ? 'ended' : this.controller.name,
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

  /** Audio dynamics ("Dyna") mode, settable mid-playback: 0 = Line (full dynamics / authored codec DRC),
   *  1 = RF (AC-3/E-AC-3 heavy/RF compression — small speakers / loud rooms), 2 = Night (the engine's
   *  universal feed-forward compressor that tames loud peaks for ANY codec on BOTH tiers — late-night
   *  quiet listening). Drives the DECODE worker's audio decoder (`ferrite_audio_set_drc`, read per-frame).
   *  No-op after destroy(); silently no-ops against an engine wasm that predates the setter. */
  setDrc(mode: number): void {
    if (this.destroyed) return;
    this.postAudio({ type: 'setDrc', mode }); // audio is decoded in the audio worker
  }

  get volume(): number { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }
  get muted(): boolean { return this._muted; }
  set muted(m: boolean) {
    this._muted = m;
    this.applyGain();
  }

  /** Fold volume × mute × the loudness makeup into the master gain, ramped via setTargetAtTime (click-free).
   *  One place so volume, mute, and the AGC compose instead of clobbering each other. `tc` = the ramp time
   *  constant (short for a user volume/mute snap, longer for the makeup glide). The makeup is unity until the
   *  worker reports a real loudness, so this is a no-op leveller for the first stats. (Mirrors the reference player's
   *  apply_audio_gain.) */
  private applyGain(tc = 0): void {
    const g = this.audioGain;
    if (!g) return;
    this.agcMakeup = this.agcGainDb !== 0 ? Math.pow(10, this.agcGainDb / 20) : 1;
    const target = this._muted ? 0 : this._volume * this.agcMakeup;
    if (tc > 0 && this.audioCtx) g.gain.setTargetAtTime(target, this.audioCtx.currentTime, tc);
    else g.gain.value = target;
  }

  /** AGC makeup gain (MAIN side — the GainNode is DOM/AudioContext-bound, so it stays here while the RMS/peak
   *  FOLD runs in the decode worker where the PCM lives). Driven by the worker's reported loudnessDb/peak
   *  (~2 Hz): normalize toward AGC_TARGET_DB, asymmetrically clamped, peak-capped (mpv ReplayGain clip-
   *  prevention: cap the boost at −20·log10(peak) dB so the loudest recent sample can't be pushed past the
   *  ±1 WebAudio hard-clip). `measured` gates unity until the first real measurement so a fresh stream never
   *  starts at a stale gain. Re-applies the GainNode only on a ≥0.1 dB move (no per-tick zipper/churn).
   *  (Mirrors the reference player's update_loudness_gain.) */
  private updateLoudnessGain(measured: boolean): void {
    let newDb: number;
    if (!measured) {
      newDb = 0; // not yet measured → unity makeup
    } else {
      const peakCapDb = this.audioPeak > 0 ? -20 * Math.log10(this.audioPeak) : Infinity;
      const upper = Math.max(-AGC_MAX_CUT_DB, Math.min(AGC_MAX_BOOST_DB, peakCapDb));
      newDb = Math.max(-AGC_MAX_CUT_DB, Math.min(upper, AGC_TARGET_DB - this.audioLoudnessDb));
    }
    if (Math.abs(newDb - this.agcGainDb) < AGC_GAIN_EPS_DB) return; // negligible — don't reschedule a ramp
    this.agcGainDb = newDb;
    this.applyGain(AGC_RAMP_TC_S);
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
  private resetPresent(gen: number, seekTargetMs = -1): void {
    this.postPresent({ type: 'reset', gen, hasLiveEdge: this._caps.hasLiveEdge, isLive: this._isLive, seekTargetMs });
  }

  /** internal_paused (mpv get_internal_paused): the SINGLE source RW_PLAYING=1 composes from, so the gating
   *  booleans can't disagree across call sites — a USER pause, a cache-pause (`buffering`), OR a still-pending
   *  mpv audio_start_ao sync each withholds output. */
  private internalPaused(): boolean {
    return this._paused || this.buffering || this.audioSyncPending;
  }

  /** Decoded-PCM ring depth in SECONDS ((write − read) / rate) — the mpv "AO buffer fill" the startup prefill
   *  gate reasons about. 0 if the ring/rate isn't up yet (so the gate simply keeps waiting). */
  private pcmDepthSecs(): number {
    const c = this.audioRingCtrl;
    if (!c) return 0;
    const rate = Atomics.load(c, RW_RATE);
    if (rate <= 0) return 0;
    return Math.max(0, Atomics.load(c, RW_WRITE) - Atomics.load(c, RW_READ)) / rate;
  }

  /** Absolute heard-audio PTS (ms) at the worklet read cursor — the `apts` mpv audio_start_ao (playing_audio_pts)
   *  reasons about. Read straight from the PCM ring's seqlock edge map the AUDIO worker publishes, minus the
   *  device outputLatency, so it is the TRUE AUDIBLE position. `published` = RW_EPOCH_SEQ != 0 (NOT edge_frame<=0
   *  — the FIRST chunk anchors at edge_frame==0, so an edge_frame guard would wrongly reject it). NaN until an
   *  edge is published. */
  private audioHeardPtsAbsMs(): number {
    const c = this.audioRingCtrl;
    if (!c) return Number.NaN;
    const rate = Atomics.load(c, RW_RATE);
    let base = 0, edgeFrame = 0, edgePts = 0, published = false;
    for (let t = 0; t < 4; t++) {
      const s1 = Atomics.load(c, RW_EPOCH_SEQ);
      if (s1 & 1) continue; // mid-publish
      const b = Atomics.load(c, RW_BASE_MS), ef = Atomics.load(c, RW_EDGE_FRAME), ep = Atomics.load(c, RW_EDGE_PTS_MS);
      if (Atomics.load(c, RW_EPOCH_SEQ) === s1) { base = b; edgeFrame = ef; edgePts = ep; published = s1 !== 0; break; }
    }
    if (rate <= 0 || !published) return Number.NaN;
    const read = Atomics.load(c, RW_READ);
    // base + edge_pts − (edge_frame − read)/rate·1000 (the audio_ring formula) − outputLatency.
    return base + edgePts - (edgeFrame - read) * 1000 / rate - this.outputLatencyMs;
  }

  /** Read AudioContext.outputLatency (the out-of-ring device-buffer delay) and publish it, in ms, to the clock
   *  SAB's C_OUTPUT_LATENCY_MS slot AND cache it for the audio_start_ao gate — so the master clock reflects the
   *  TRUE AUDIBLE position (mpv ao_get_delay). 0/absent until the ctx is `running` / on platforms without it →
   *  0 ms ⇒ NO compensation. Call when the ctx (re)reaches running. */
  private publishOutputLatency(): void {
    const lat = this.audioCtx ? (this.audioCtx as unknown as { outputLatency?: number }).outputLatency : undefined;
    const secs = typeof lat === 'number' && Number.isFinite(lat) && lat > 0 ? lat : 0;
    this.outputLatencyMs = secs * 1000;
    if (this.clockSab) Atomics.store(new Int32Array(this.clockSab), C_OUTPUT_LATENCY_MS, Math.round(this.outputLatencyMs));
  }

  /** mpv audio_start_ao + get_sync_pts — release the WITHHELD audio output once mpv's conditions are met, so
   *  audio never leads video. Audio starts when: there is no audio to withhold (video-only) or no video to sync
   *  to (audio-only), OR the video clock has reached the audio first-sample PTS (current_ms >= apts) AND the PCM
   *  ring has PREFILLED to mpv's STATUS_READY cushion (AUDIO_PREFILL_SECS). No timeout — the wait ends on a real
   *  video event, never a wall-clock cap. Idempotent; called from play(), the present time tick, and decode ready. */
  private maybeStartAudioAo(): void {
    if (!this.audioSyncPending || this._paused) return;
    // mpv get_sync_pts: sync_to_video only if there IS a video stream. Codec unknown (no `ready` yet) ⇒ assume
    // both present + keep waiting — the ready handler re-checks the instant it is known.
    const hasVideo = !this._workerInfo || this._workerInfo.videoCodec > 0;
    const hasAudio = !this._workerInfo || this._workerInfo.audioCodec > 0;
    let start: boolean;
    if (!hasAudio || !hasVideo) {
      start = true; // no audio to WITHHOLD (video-only), or no video to sync to (audio-only) → start now
    } else if (!this.firstFrameSeen) {
      start = false; // video present but no frame/clock yet (mpv video_status < STATUS_READY → wait)
    } else {
      const apts = this.audioHeardPtsAbsMs();
      start = Number.isFinite(apts) && this._currentMs >= apts && this.pcmDepthSecs() >= AUDIO_PREFILL_SECS;
    }
    if (start) {
      this.audioSyncPending = false;
      this.publishOutputLatency(); // audio output begins ⇒ the ctx is running ⇒ outputLatency valid (host-ctx path too)
      this.setRingPlaying(true);
    }
  }

  /** Flip the ring's RW_PLAYING flag (1 = the worklet outputs + advances the clock; 0 = silence + hold the
   *  cursor + release C_AUDIO). MAIN owns this slot; set 0 BEFORE the present worker should stop seeing the
   *  audio clock advance. (Mirrors the reference player's set_ring_playing.) */
  private setRingPlaying(on: boolean): void {
    if (this.audioRingCtrl) Atomics.store(this.audioRingCtrl, RW_PLAYING, on ? 1 : 0);
  }

  /** Frames buffered in the PCM ring (producer write − consumer read), the in-flight audio reservoir depth
   *  for getStats(). Never negative. 0 with no ring. */
  private audioRingReadableFrames(): number {
    const c = this.audioRingCtrl;
    if (!c) return 0;
    return Math.max(0, Atomics.load(c, RW_WRITE) - Atomics.load(c, RW_READ));
  }

  /** A/V lip-sync error (ms): the single-domain av_diff the PRESENT worker computed (master clock − displayed
   *  PTS) at one draw instant and shipped on the `time` message — NOT a cross-realm subtraction of a fresh
   *  audio read from a stale _currentMs. ~0 when lip-synced; the readout that confirms pacing. 0 to the host
   *  until the first time post. (mpv update_av_diff.) */
  private avDiffMs(): number {
    // Only meaningful while audio is the master clock — a video-only / audio-degraded stream has no lip-sync
    // reference, so report 0 rather than a stale present-side number (matches the reference player's av_diff_ms).
    return this.audioActive && Number.isFinite(this.presentAvDiffMs) ? Math.round(this.presentAvDiffMs) : 0;
  }

  /** Re-anchor MAIN's audio bookkeeping + signal the decode worker. `seek=true` (VOD seek) posts
   *  audioSeekFlush (flush + seek-block, NO early rebase) so a still-buffered pre-seek packet can't anchor
   *  C_ACLOCK to the old position; `seek=false` (live restart / load / unload) posts audioResetEpoch.
   *
   *  The PCM ring re-anchor (bump RW_GEN + re-map the media-PTS clock edge) is now done BY THE DECODE
   *  WORKER (it owns RW_GEN/RW_BASE_MS/RW_EDGE_* — the producer slots; single-writer discipline). MAIN only
   *  signals the intent. The clock SAB (C_ACLOCK/C_AUDIO) is NOT touched here either — the worklet is its
   *  SOLE writer (no two-writer race). MAIN keeps RW_GEN in lockstep ONLY for the worklet's processorOptions
   *  .gen it seeds on a FRESH ring (ensureAudio); a re-anchor reuses the ring, so the worker's bump is what
   *  the worklet observes. (Mirrors the reference player's reset_audio_epoch.) */
  private resetAudioEpoch(seek: boolean): void {
    // A live restart / seek starts fresh — clear any cache-pause freeze (the worker also resets its flag).
    if (this.buffering) {
      this.buffering = false;
      this.postPresent({ type: 'setPaused', paused: false });
    }
    this.audioActive = false;
    this.presentAvDiffMs = Number.NaN; // fresh timeline: don't carry the prior stream's lip-sync value into getStats
    this.liveLatencySecs = 0;
    this._workerStats = null;
    if (seek) this.postAudio({ type: 'audioSeekFlush' }); // the PCM-ring producer is the audio worker
    else this.postAudio({ type: 'audioResetEpoch' });
  }

  // ---- worker messages (DECODE worker) ---------------------------------------

  private onWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        // The VIDEO worker resolved its tier/codec/dims. MAIN merges the audio codec separately (it relays the
        // audio codecParams from the demux to the audio worker), so msg.info.audioCodec is 0 here — preserve
        // the existing audioCodec if MAIN already knows it (from a prior audio relay), else keep 0.
        this._workerInfo = { ...msg.info, audioCodec: msg.info.audioCodec || (this._workerInfo?.audioCodec ?? 0) };
        this._tier = msg.info.tier; // tier known before the first per-second stats sample
        this.controller.dispatch({ type: 'opened' }); // opening → buffering (fidelity; no teardown effect)
        this.emit(Events.MEDIA_INFO, this.mediaInfo);
        this.maybeStartAudioAo(); // codecs now known → an audio-only stream can release the audio_start_ao gate
        break;
      case 'log':
        this.emit(Events.LOG, msg.message);
        break;
      case 'deintFailed':
        this.emit(Events.DEINT_FAILED, msg.failed);
        break;
      case 'stats':
        this.updateStats(msg.stats);
        this.emit(Events.STATISTICS_INFO, this._stats);
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

  // ---- worker messages (DEMUX worker) -------------------------------

  /** Post to the DEMUX worker. `init` (demuxInit) goes immediately; everything else is HELD in the demux
   *  outbox until the worker posts `demuxWorkerReady`, then flushed IN ORDER — so demuxLoad never races ahead
   *  of demuxInit (the engine-load + ring-attach order the worker needs). Mirrors postAudio / the audio outbox. */
  private postDemux(msg: MainToDemux, init = false): void {
    if (!this.demux) return;
    if (init || this.demuxReady) this.demux.postMessage(msg);
    else this.demuxOutbox.push(msg); // held until demuxWorkerReady
  }

  /** Flush the deferred demux outbox once the worker is ready (preserves post order after demuxInit). */
  private flushDemuxOutbox(): void {
    this.demuxReady = true;
    const pending = this.demuxOutbox;
    this.demuxOutbox = [];
    for (const m of pending) this.demux?.postMessage(m);
  }

  /** DemuxToMain dispatch. The DEMUX worker owns the source + demux, so caps/duration/ended/
   *  reconnecting/recovered + the codec-param relay + the ready handshake come from it now (no longer the
   *  decode worker). MAIN RELAYS codecParams to the VIDEO worker (stream 0) and the AUDIO worker (stream 1),
   *  and keyframeResync to the VIDEO worker. */
  private onDemuxMessage(msg: DemuxToMain): void {
    switch (msg.type) {
      case 'demuxWorkerReady':
        // The worker's onmessage is live → flush the held demuxInit-follow-ups (demuxLoad, etc.) in order.
        this.flushDemuxOutbox();
        break;
      case 'caps':
        // The demux resolved the descriptor from the first response's headers. REFINE main's intent-only copy
        // so the seek()/duration/seekbar forks key on the observed capabilities. Re-emit MEDIA_INFO so a
        // controls layer re-renders the scrub-vs-live decision against the refined duration.
        this._caps = msg.caps;
        if (this.mediaInfo) this.emit(Events.MEDIA_INFO, this.mediaInfo);
        break;
      case 'duration':
        // VOD container duration (ms). Drives the `duration` getter + the scrub bar; emit MEDIA_INFO so a
        // controls layer re-renders.
        this._durationMs = msg.durationMs;
        if (this.mediaInfo) this.emit(Events.MEDIA_INFO, this.mediaInfo);
        break;
      case 'codecParams':
        // RELAY the resolved codec id + extradata to the right decode worker (the demux has no decoders). The
        // extradata is TRANSFERRED forward (copied bytes; the receiving worker takes ownership). Video → the
        // VIDEO worker (it builds the SW decoder + the Fix-A WC config record from these); audio → the AUDIO
        // worker. Re-issue with a FRESH copy per hop (the inbound buffer is consumed by the first transfer).
        if (msg.stream === DEMUX_STREAM_VIDEO) {
          this.post({ type: 'codecParams', stream: msg.stream, codecId: msg.codecId, profile: msg.profile, level: msg.level, sarNum: msg.sarNum, sarDen: msg.sarDen, extradata: msg.extradata }, msg.extradata.byteLength > 0 ? [msg.extradata.buffer] : []);
          // Mirror the resolved video codec into mediaInfo even before the VIDEO worker's `ready` lands.
          if (this._workerInfo && msg.codecId > 0 && this._workerInfo.videoCodec !== msg.codecId) {
            this._workerInfo = { ...this._workerInfo, videoCodec: msg.codecId };
            this.emit(Events.MEDIA_INFO, this.mediaInfo);
          }
        } else if (msg.stream === DEMUX_STREAM_AUDIO) {
          this.postAudio({ type: 'audioCodecParams', codecId: msg.codecId, extradata: msg.extradata }); // held in the audio outbox until audioWorkerReady; transferred there
          // Merge the audio codec into mediaInfo (the demux is the only audio-codec source post-split).
          if (this._workerInfo && msg.codecId > 0 && this._workerInfo.audioCodec !== msg.codecId) {
            this._workerInfo = { ...this._workerInfo, audioCodec: msg.codecId };
            this.emit(Events.MEDIA_INFO, this.mediaInfo);
          }
        }
        break;
      case 'keyframeResync':
        // The demux armed a next-IDR resync (reconnect / resume / seek) → relay to the VIDEO worker (it arms
        // its own await_keyframe). The AUDIO worker re-anchors via the ring epoch (no relay needed).
        this.post({ type: 'keyframeResync' });
        break;
      case 'log':
        this.emit(Events.LOG, msg.message);
        break;
      case 'ended':
        // Route end-of-stream through the controller (→ Eof state; the host is told exactly once even if a
        // decode-side ended ever joins). The emit('ended') command runs the imperative effect (pause +
        // LOADING_COMPLETE) so paused() agrees with the controller.
        this.controller.dispatch({ type: 'eof' });
        break;
      case 'reconnecting':
        // A recoverable live drop is re-opening with backoff → drive the controller into Reconnecting. Re-arm
        // the first-frame latch so the post-recovery pre-roll re-fires `lowWater`. Stays internal (a LOG
        // breadcrumb) — Events.ERROR is reserved for the FATAL exhausted case.
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
        if (msg.fatal) this.handleFatal(err);
        else this.emitError(err);
        break;
      }
      // 'destroyed' is consumed by shutdownDemux's repointed handler.
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
        this.presentAvDiffMs = msg.avDiffMs;  // single-domain lip-sync, computed in the present worker at the draw instant
        this.maybeStartAudioAo();             // the video clock advanced → re-check the mpv audio_start_ao release
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
        this.cadenceDropToKey = msg.cadenceDropToKey;
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

  // ---- audio playout (PCM ring + AudioWorklet) -------------------------------

  /** Set up the audio pipeline: pick the host-injected ctx (attachAudio) or OWN a per-stream one, build the
   *  makeup GainNode, allocate + SEED the PCM ring SAB (sized for AUDIO_RING_SECONDS at the ctx output rate),
   *  hand the producer side to the decode worker (audioSetPcmRing) + forward the output rate (setAudioOutRate),
   *  register interruption recovery (OWN ctx only), and spawn the persistent AudioWorklet that consumes the
   *  ring + drives the master clock. Idempotent (returns if a ctx already exists). (Mirrors the reference player's
   *  ensure_audio.) */
  private ensureAudio(): void {
    if (this.audioCtx) return;
    // HOST-OWNED path: attach to the injected app-lifetime ctx (the host created + unlocks + recovers it; we
    // never create/resume/close it). Otherwise OWN a per-stream ctx (the standalone fallback). Node
    // construction below is legal on a SUSPENDED context — only resume() needs the gesture, which the host
    // (or, on the own path, play()) does.
    const hostOwned = !!this.hostAudioCtx;
    let ctx: AudioContext;
    if (this.hostAudioCtx) {
      ctx = this.hostAudioCtx;
    } else {
      // latencyHint:'interactive' — shortest read-ahead on the audio thread → tighter live-edge + faster
      // recovery after a re-anchor. Fall back to a default ctx if the option is rejected.
      try { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      catch { try { ctx = new AudioContext(); } catch { return; } }
    }
    this.audioCtxIsHost = hostOwned;
    this.audioCtx = ctx;
    this.audioGain = ctx.createGain();
    this.audioGain.connect(ctx.destination);
    this.applyGain(); // volume × mute × makeup (makeup starts at unity until the worker reports loudness)

    const outRate = ctx.sampleRate;
    // Build the PCM ring SAB the decode worker (producer) + the worklet (consumer) share, sized for
    // AUDIO_RING_SECONDS at the OUTPUT rate (the worker engine-resamples to it). The data region is
    // interleaved stereo (RING_CHANNELS). Built synchronously so the worker can fill it during the (~1
    // quantum) async addModule window; the worklet drains it once it starts. MAIN holds the control view
    // (telemetry + RW_PLAYING) but NEVER writes the data region nor the producer cursors.
    const cap = ringFramesFor(AUDIO_RING_SECONDS, outRate);
    const sab = new SharedArrayBuffer(ringSabBytes(cap));
    const ctrl = new Int32Array(sab, 0, RING_CTRL_SLOTS);
    const data = new Float32Array(sab, RING_CTRL_SLOTS * 4);
    this.audioRingGen = (this.audioRingGen + 1) | 0;
    Atomics.store(ctrl, RW_WRITE, 0);
    Atomics.store(ctrl, RW_READ, 0);
    Atomics.store(ctrl, RW_UNDERRUNS, 0);
    Atomics.store(ctrl, RW_OVERWRITES, 0);
    Atomics.store(ctrl, RW_BASE_MS, 0);
    Atomics.store(ctrl, RW_PLAYING, this.internalPaused() ? 0 : 1); // composite: paused OR buffering OR audio_start_ao-pending all withhold
    Atomics.store(ctrl, RW_RATE, Math.round(outRate));
    Atomics.store(ctrl, RW_GEN, this.audioRingGen);
    Atomics.store(ctrl, RW_EDGE_FRAME, 0); // media-PTS clock map (the decode worker publishes it per chunk)
    Atomics.store(ctrl, RW_EDGE_PTS_MS, 0);
    this.audioRingCap = cap;
    this.audioRingCtrl = ctrl;
    this.audioRingData = data;
    this.audioRingSab = sab;
    // Hand the producer side to the AUDIO worker — it writes the ring directly (replacing the retired
    // playAudio MAIN-hop) + owns RW_WRITE/RW_BASE_MS/RW_EDGE_* (the producer slots). Held in the audio outbox
    // until audioWorkerReady so it lands after audioInit (the engine-load order the worker needs).
    this.postAudio({ type: 'audioSetPcmRing', pcmRing: sab, pcmRingCap: cap, sampleRate: outRate });
    // Forward the ctx output rate so the engine resamples to it in ONE stateful swresample pass (the engine
    // also downmixes surround → stereo), replacing Web Audio's per-chunk resample. (audioSetPcmRing already
    // carries the rate; this keeps it fresh on a rate change.)
    this.postAudio({ type: 'audioSetOutRate', rate: Math.round(outRate) });

    // Interruption recovery: the master clock IS the AudioContext, so a frozen ctx freezes the whole
    // pipeline. Watch statechange + re-resume on a backoff — ONLY for an OWN (per-stream) ctx. A HOST ctx is
    // recovered by the host over the ctx's full lifetime (our per-stream player is torn down each load, so a
    // per-player handler would leave the long-lived ctx uncovered in the gap). Don't touch the host ctx's
    // onstatechange.
    if (!hostOwned) {
      const handler = (): void => this.onAudioStatechange();
      this.audioStatechangeHandler = handler;
      ctx.onstatechange = handler;
    } else if (!this.hostAudioStatechangeHandler) {
      // HOST ctx: the host owns ctx.onstatechange (its recovery ladder — host-audio.ts), so we must NOT
      // clobber it. Add a SEPARATE 'statechange' listener (coexists with the property handler) to catch the
      // COLD suspended→running edge: run 1's Play is the first gesture that unlocks the app-lifetime ctx WITH
      // latency; during that window the worklet's process() doesn't run, so the PCM ring backlogs seconds of
      // audio while video free-runs. On the running edge we drop the backlog via the SAME live re-arm the
      // own-ctx path uses, so C_ACLOCK joins at the live head instead of draining seconds behind (the rush).
      const handler = (): void => this.onHostAudioStatechange();
      this.hostAudioStatechangeHandler = handler;
      ctx.addEventListener('statechange', handler);
    }

    // Spawn the worklet asynchronously (addModule is a Promise); the ring is already live, so producer
    // writes during this window are simply drained once the node starts. Bump the ring INSTANCE — the
    // spawnWorklet validity guard keys on it (a fresh ensureAudio during an in-flight await drops the node).
    this.audioRingInstance = (this.audioRingInstance + 1) | 0;
    if (this.clockSab) {
      void this.spawnWorklet(ctx, sab, this.clockSab, cap, this.audioRingGen, this.audioRingInstance);
    }
    if (DEBUG) {
      // breadcrumb: the resolved audio ring (the off-main scheduler's bound). audioRingSab/audioRingData are
      // held for parity (the worklet+worker own the data region); audioRingCap is the frame bound.
      const bytes = this.audioRingSab?.byteLength ?? 0;
      this.emit(Events.LOG, `[audio] ring cap=${this.audioRingCap}fr (${bytes}B, data=${this.audioRingData?.length ?? 0}f32) rate=${Math.round(outRate)} host=${hostOwned}`);
    }
  }

  /** Async: `await audioWorklet.addModule(blob)` → build the AudioWorkletNode → connect node → gain. The ring
   *  SAB + clock SAB + cap + gen reach the processor via processorOptions. Guarded against teardown / a fresh
   *  ensureAudio during the await via the captured `instance` (a superseded epoch drops the node). (Mirrors
   *  the reference player's spawn_worklet.) */
  private async spawnWorklet(
    ctx: AudioContext, ring: SharedArrayBuffer, clock: SharedArrayBuffer,
    cap: number, gen: number, instance: number,
  ): Promise<void> {
    const url = workletUrl();
    // addModule is NOT idempotent: a 2nd addModule of the SAME processor name on the SAME ctx rejects
    // (already-registered). A HOST ctx is REUSED across streams + a prior (torn-down) player's in-flight
    // addModule isn't cancelled, so two tasks can race on one ctx. Latch the addModule PROMISE on the ctx
    // (set BEFORE the await): the first task issues addModule + stores its promise; any concurrent/later task
    // awaits the SAME promise instead of issuing a second addModule. Then each stream just constructs a fresh
    // node (the canonical MDN/Chrome pattern). An OWN per-stream ctx is fresh → no latch → registers once.
    const LATCH = '__ferriteWorkletModule';
    const aw = ctx.audioWorklet;
    const existing: Promise<void> | undefined = (ctx as any)[LATCH];
    let moduleOk: boolean;
    if (existing) {
      moduleOk = await existing.then(() => true, () => false);
    } else {
      try {
        const p = aw.addModule(url);
        (ctx as any)[LATCH] = p; // latch BEFORE the await
        moduleOk = await p.then(() => true, () => false);
        if (!moduleOk) (ctx as any)[LATCH] = undefined; // genuine load failure → clear so a retry can re-add
      } catch { moduleOk = false; }
    }
    URL.revokeObjectURL(url); // module compiled (or failed) → the blob URL is done
    if (!moduleOk) return;
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ring, clock, cap, gen },
    });
    // Validity guard: only a teardown (ctx gone) or a fresh ensureAudio (new ring INSTANCE) during the await
    // invalidates this node. A live re-anchor bumps the gen but NOT the instance, so the node stays valid (its
    // ring is the same SAB). A dead instance → discard (its ctx is closing).
    if (this.destroyed || this.audioRingInstance !== instance || !this.audioCtx) {
      node.disconnect();
      return;
    }
    if (this.audioGain) node.connect(this.audioGain);
    this.audioWorklet = node;
  }

  /** Raw AudioContext `state` string — read via property access because the non-standard iOS `interrupted`
   *  state isn't in TS's AudioContextState union (a typed read would lose it). */
  private static audioCtxStateStr(ctx: AudioContext): string {
    return (ctx as unknown as { state: string }).state ?? '';
  }

  /** AudioContext statechange handler (OWN ctx only). `running` clears the recovery state; an `interrupted`
   *  or an unexpected `suspended` while we intend to play kicks the backoff-paced resume. A deliberate
   *  pause()/unload() sets `_paused`, so we never fight an intentional suspend. (Mirrors on_audio_statechange.) */
  private onAudioStatechange(): void {
    const ctx = this.audioCtx;
    // Guard a stale handler that fires after teardown nulled the ctx (or after we cleared the handler ref):
    // only an own ctx with a registered handler drives recovery.
    if (!ctx || !this.audioStatechangeHandler) return;
    const st = FerritePlayer.audioCtxStateStr(ctx);
    if (st === 'running') {
      this.audioRecoveryAttempts = 0; // recovered → the next interruption starts a fresh ladder
      if (this.audioResumeTimer) { clearTimeout(this.audioResumeTimer); this.audioResumeTimer = 0; }
      this.publishOutputLatency(); // outputLatency is valid once running (0 while suspended) → publish now
      this.maybeStartAudioAo();    // a delayed running edge may now satisfy the audio_start_ao gate
      // RESUME EDGE (live): the ctx reached `running` again. If the resume was DELAYED past
      // AUDIO_REARM_MIN_DELAY_MS (iOS missed the activation window → a later gesture; or an interrupted/
      // suspended recovery), a stale backlog accumulated while suspended — re-arm the audio epoch so the
      // worker SNAPS the ring to the live head instead of draining from the frozen read cursor against a
      // stale anchor. A PROMPT resume (normal desktop start) is skipped — play()'s own epoch + the worker's
      // fresh-anchor coalesce already handle it (so we don't drop the startup buffer).
      if (!this._paused && !this.destroyed && this._caps.hasLiveEdge
          && performance.now() - this.audioPlayAtMs > AUDIO_REARM_MIN_DELAY_MS) {
        this.resetAudioEpoch(false);
      }
    } else if (!this._paused && (st === 'interrupted' || st === 'suspended')) {
      // Do NOT reset attempts here: an interruption that flaps (interrupted→suspended→interrupted without
      // ever reaching `running`) is ONE ongoing failure. Resetting per-event would peg the backoff at the
      // floor + never reach the give-up cap. Only `running` clears the ladder.
      this.scheduleAudioResume();
    }
  }

  /** HOST ctx statechange observer (added via addEventListener in ensureAudio, so it does NOT clobber the
   *  host's ctx.onstatechange recovery — host-audio.ts). The player NEVER resumes/recovers a host ctx (the
   *  host does), so this handles ONLY the COLD running edge: the first Play unlocks the app-lifetime ctx with
   *  latency, and while it was suspended the worklet's process() didn't drain the PCM ring → a multi-second
   *  stale backlog. On the running edge, re-arm the audio epoch (worker bumps RW_GEN → the worklet snaps
   *  read=write, dropping the backlog) so C_ACLOCK joins at the live head instead of draining seconds behind
   *  the free-run video (the clamped PLL then sees a small residual, not a multi-second slew = the rush).
   *  Gated IDENTICALLY to the own-ctx running-edge re-arm above: live-edge only, not paused/destroyed, and a
   *  DELAYED resume only (a prompt warm-ctx running edge — run 2 — is skipped, so the aligned startup buffer
   *  is never dropped). */
  private onHostAudioStatechange(): void {
    const ctx = this.audioCtx;
    if (!ctx || !this.audioCtxIsHost) return; // only while attached to a host ctx
    if (FerritePlayer.audioCtxStateStr(ctx) !== 'running') return;
    if (!this._paused && !this.destroyed && this._caps.hasLiveEdge
        && performance.now() - this.audioPlayAtMs > AUDIO_REARM_MIN_DELAY_MS) {
      this.resetAudioEpoch(false);
    }
  }

  /** Arm a one-shot backoff timer to retry resume() (OWN ctx). No-op if one is pending (don't stack) or the
   *  cap is hit. (Mirrors schedule_audio_resume.) */
  private scheduleAudioResume(): void {
    if (this.audioResumeTimer || this.audioRecoveryAttempts >= AUDIO_RECOVERY_MAX_ATTEMPTS) return;
    const delay = Math.min(
      AUDIO_RECOVERY_BACKOFF_MIN_MS << Math.min(this.audioRecoveryAttempts, 5),
      AUDIO_RECOVERY_BACKOFF_MAX_MS,
    );
    this.audioResumeTimer = setTimeout(() => this.tryResumeAudio(), delay);
  }

  /** Backoff timer fired: attempt one resume(). On a still-frozen ctx, grow the backoff + re-arm (to the
   *  cap). A successful resume fires statechange→running, which resets + cancels via onAudioStatechange.
   *  resume()'s promise is fire-and-forget — iOS rejects it while still interrupted, the next tick retries.
   *  (Mirrors try_resume_audio.) */
  private tryResumeAudio(): void {
    this.audioResumeTimer = 0; // this timer fired
    const ctx = this.audioCtx;
    if (!ctx) return;
    if (this._paused) { this.audioRecoveryAttempts = 0; return; }
    if (FerritePlayer.audioCtxStateStr(ctx) === 'running') { this.audioRecoveryAttempts = 0; return; }
    ctx.resume().catch(() => {});
    this.audioRecoveryAttempts++;
    this.scheduleAudioResume();
  }

  /** mpv cache-pause: the decode worker reported the audio output starved (buffering=true) or refilled
   *  (false). Freeze/resume the clock (RW_PLAYING) + the present so playback rebuffers from the frozen
   *  position instead of free-running/skipping. NEVER override a user pause: the present freezes on
   *  `buffering || paused` (a DISTINCT setBuffering flag, not setPaused), so a rebuffer refill can't un-freeze
   *  a user pause and a user resume can't un-freeze an active rebuffer; and while paused RW_PLAYING is already
   *  0 and stays 0 (the !_paused gate). (Mirrors the AudioToMain::Rebuffer branch + MainToPresent::SetBuffering.) */
  private onAudioRebuffer(buffering: boolean): void {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    this.postPresent({ type: 'setBuffering', buffering }); // freeze/resume the present clock — orthogonal to user pause
    if (buffering) this.setRingPlaying(false);                  // freeze (always honoured)
    else if (!this.internalPaused()) this.setRingPlaying(true); // resume only when nothing else withholds (not user-paused, not audio_start_ao-pending)
    this.emit(Events.LOG, buffering ? 'rebuffering (audio output starved)…' : 'rebuffered — resuming');
  }

  private post(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }
  private postPresent(msg: MainToPresent, transfer: Transferable[] = []): void {
    this.present?.postMessage(msg, transfer);
  }
  /** Post to the AUDIO worker. `init` (audioInit) goes immediately; everything else is HELD in the audio
   *  outbox until the worker posts `audioWorkerReady`, then flushed IN ORDER — so audioSetPcmRing / a relayed
   *  audioCodecParams / audioLoad never race ahead of audioInit (the engine-load order the worker needs).
   *  `audioCodecParams.extradata` is TRANSFERRED (copied bytes). Mirrors the reference player's pending_audio_init + flush. */
  private postAudio(msg: MainToAudio, init = false): void {
    if (!this.audio) return;
    if (init || this.audioReady) {
      const transfer = msg.type === 'audioCodecParams' && msg.extradata.byteLength > 0 ? [msg.extradata.buffer] : [];
      this.audio.postMessage(msg, transfer);
    } else {
      this.audioOutbox.push(msg); // held until audioWorkerReady
    }
  }

  /** Flush the deferred audio outbox once the worker is ready (preserves post order after audioInit). */
  private flushAudioOutbox(): void {
    this.audioReady = true;
    const pending = this.audioOutbox;
    this.audioOutbox = [];
    for (const m of pending) {
      const transfer = m.type === 'audioCodecParams' && m.extradata.byteLength > 0 ? [m.extradata.buffer] : [];
      this.audio?.postMessage(m, transfer);
    }
  }

  // ---- worker messages (AUDIO worker) ----------------------------------------

  /** AudioToMain dispatch. The audio telemetry (audioStats → makeup gain + getStats) + the mpv
   *  cache-pause rebuffer signal + the ready handshake + the circuit-breaker degrade now come from the AUDIO
   *  worker, where the PCM lives — no longer the decode worker. */
  private onAudioMessage(msg: AudioToMain): void {
    switch (msg.type) {
      case 'audioWorkerReady':
        // The worker's onmessage is live → flush the held audioSetPcmRing / audioCodecParams / audioLoad in order.
        this.flushAudioOutbox();
        break;
      case 'audioStats':
        // ~2 Hz audio telemetry (the RMS/peak FOLD runs where the PCM lives). Mirror it into getStats() +
        // drive the DOM-bound makeup GainNode from the reported loudness/peak.
        this.audioActive = msg.active;
        this.audioLoudnessDb = msg.loudnessDb;
        this.audioPeak = msg.peak;
        this.audioDrops = msg.drops;
        this.audioSrcChannels = msg.srcChannels;
        this.audioStreamRate = msg.streamRate;
        this.liveLatencySecs = msg.scheduledAhead; // latency-to-live proxy (the reservoir depth)
        this.updateLoudnessGain(msg.loudnessDb !== 0); // measured gate → unity until the first real sample
        break;
      case 'audioRebuffer':
        this.onAudioRebuffer(msg.buffering);
        break;
      case 'audioDegraded':
        // Circuit-breaker: the audio worker freed its decoder (a codec the WASM decoder can't handle) →
        // silent-audio, video continues. Release the master clock (the worklet stops advancing C_AUDIO) so
        // the present clock falls back to video-paced, and surface it.
        this.audioActive = false;
        this.setRingPlaying(false);
        this.emit(Events.LOG, 'audio degraded to silent (decoder unsupported) — video continues');
        break;
      case 'log':
        this.emit(Events.LOG, msg.message);
        break;
      // 'destroyed' is consumed by shutdownAudio's repointed handler.
    }
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
// OPTIONAL host-audio glue: a host creates ONE app-lifetime, gesture-unlocked, recovered AudioContext and
// injects it into each player via player.attachAudio(). The standalone player works WITHOUT this (own-ctx
// path). See src/host-audio.ts.
export { initHostAudio, hostAudioCtx } from './host-audio';
