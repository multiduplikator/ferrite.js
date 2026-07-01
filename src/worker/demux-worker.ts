// DEMUX worker (the DEMUX realm — ingest/source/demux split out of the combined worker).
//
// WHY (decode isolation): the demux worker in the mpv-style 4-worker topology OWNS the SOURCE (live ingest /
// VOD Range) + the engine DEMUX + the stream LIFECYCLE (connect / read / Welford cadence / reconnect / EOF /
// silence-watchdog, live + VOD). It NEVER decodes and holds NO decoders — instead it ROUTES each demuxed
// encoded access unit (AU) into one of TWO SAB packet rings (video ring = stream 0 → the VIDEO worker; audio
// ring = stream 1 → the AUDIO worker) via PacketRingProducer.writeAu, and RELAYS the resolved codec id +
// extradata to the decode workers as a `codecParams` control message (DemuxToMain → MAIN → the respective
// worker) on change. Because the rings + workers are separate, a slow software-HEVC video decode can never
// block audio decode (the whole point of the split).
//
// This is the producer side of BOTH rings. The Stage-4 audio packet-ring producer MOVED here from worker.ts
// (worker.ts is now VIDEO-DECODE-ONLY and consumes the Stage-5-new video ring). The read-ahead gate now paces
// BOTH rings on bufferedMs (mpv demuxer-readahead-secs) — UNBOUNDED is now safe (video has its own ring + its
// own consumer worker), so the Stage-4 250ms bounded audio cap is GONE: read while EITHER stream is hungry,
// pause while NEITHER is. The readahead TARGET is a per-call parameter (LIVE_READAHEAD_MS=4000 for the live
// pump, VOD_READAHEAD_MS=1000 for the VOD loop; VIDEO_RING_CEIL_BYTES=28 MiB, AUDIO_RING_CEIL_BYTES=448 KiB).
//
// Lifecycle: `demuxInit` loads the engine ONCE (ferritePool=0, small MEM_DEMUX realm); `demuxLoad` starts a
// pipeline tagged with a `gen`; `demuxUnload` tears it down but keeps the engine; another `demuxLoad` reuses
// it. Stale ingest/pump/vod loops self-cancel via `alive(myGen)`. Ported from the reference player.

import { Ferrite, loadFerrite, MEM_DEMUX_INIT, MEM_DEMUX_MAX } from './ferrite-bindings';
import { HttpSource } from './http-source';
import {
  adaptiveLowWater, adaptiveReadAhead, reconnectDelayMs,
  LOW_WATER_DEFAULT_FLOOR, LOW_WATER_DEFAULT_CEILING,
  LIVE_READAHEAD_MS, VOD_READAHEAD_MS, VIDEO_RING_CEIL_BYTES, AUDIO_RING_CEIL_BYTES,
  RECONNECT_MAX_ERROR_RETRY, RECONNECT_MAX_TIMEOUT_RETRY,
  RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS, CONNECT_TIMEOUT_MS,
  EOF_BOUNDARY_MIN_BYTES, EOF_BOUNDARY_MIN_MS,
} from '../policy';
import type { MainToDemux, DemuxToMain } from '../protocol';
import { DEMUX_STREAM_VIDEO, DEMUX_STREAM_AUDIO } from '../protocol';
import { PacketRingProducer } from './packet-ring-io';
import type { FerriteFailureKind } from '../errors';
import { LiveSourcePort, SourceHttpError, SourceConnectTimeout } from '../source/port';
import { deriveCapabilities, type SourceCapabilities } from '../source/capabilities';
import { classifyError, type ErrorCause, type ClassifyContext } from '../controller/error-controller';
import { classifyIngestCause, silenceWatchdogArmed, classifyCleanBoundary } from '../controller/ingest-classify';

// ---- Stream constants (owned by the demux side; ported from demux.rs) ----
const STARTUP_BYTES = 256 * 1024;       // buffer before the first demux_open
const MAX_BUFFERED = 16 * 1024 * 1024;  // demux ring safety cap (sheds oldest on overflow)
const OPEN_DEADLINE_TRIES = 530;        // ~8s @ 15ms: full startup window buffered + still no open → FormatError
const READY_SETTLE_MS = 12000;          // destroy wedge-breaker: max wait for a hung loadFerrite
// VOD: sliding-window ceiling for the HttpSource forward range transport (iOS-aware, keyed off the platform
// flag directly — the demux realm has no credit pool, so it can't key off creditCap == RING_CAP like the old
// combined worker; same intent: keep the iPad rolling buffer inside the <300 MB budget).
const VOD_WINDOW_BYTES_DESKTOP = 16 * 1024 * 1024;
const VOD_WINDOW_BYTES_IOS = 8 * 1024 * 1024;

// mpv `demuxer-readahead-secs`: the demux fills EACH stream to a DURATION of forward read-ahead, then stops.
// Measured in TIME so audio and video stay balanced at the same file position across any bitrate (a byte
// target would be N× more time for low-bitrate audio than high-bitrate 4K video → the demux over-reads one
// and DROPS the other). LIVE uses a seconds-deep cushion (mpv streaming-cache override), VOD the mpv local-
// file 1 s floor; the byte CEILINGS are a hard safety so the time target can never push a fixed ring past its
// cap. All four depth consts (LIVE_READAHEAD_MS / VOD_READAHEAD_MS / VIDEO_RING_CEIL_BYTES /
// AUDIO_RING_CEIL_BYTES) + the matching SAB sizes live in policy.ts (centralized, with unit-tested CEIL<SAB /
// depth-fit invariants). The readahead TARGET is threaded as a PARAMETER (the live pump passes
// LIVE_READAHEAD_MS, the VOD loop VOD_READAHEAD_MS). This UNBOUNDED gate replaces the Stage-4 250ms bounded
// audio cap (now safe — video has its own ring + its own consumer worker; pausing the demux can't HoL video).

// ---- adaptive demux-ring low-water (policy.ts adaptiveLowWater) ----
let lwFloor = LOW_WATER_DEFAULT_FLOOR;       // config stashInitialSize (resolved)
let lwCeiling = LOW_WATER_DEFAULT_CEILING;   // config stashMaxSize (= the 4K full-PES floor)
let lwAdaptive = true;                       // config stashAdaptive (off ⇒ fixed ceiling)
let liveLowWater = lwCeiling;                // current low-water (held at ceiling until warmed)
let liveReadAhead = lwCeiling * 2;           // current read-ahead (2× the low-water, capped)
let peakVideoPes = 0;                        // running MAX video PES size (monotonic)
let warmedUp = false;                        // first video keyframe seen → adaptive sizing engages

const post = (m: DemuxToMain, transfer: Transferable[] = []): void =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (m: string): void => post({ type: 'log', message: m });

let F: Ferrite | null = null;
let wasmBaseUrl = '/';
// Platform tells (detected main-side, forwarded on init). Stored for telemetry segmentation + the VOD window fork.
let isIOS = false;
let isAppleWebKit = false;
let debug = false;
const dlog = (m: string): void => { if (debug) log(m); };

let demux = 0;
let stop = false;
let closing = false;    // 'demuxDestroy' received → terminal; gates load/run
let gen = 0;            // current load generation; loops capture it and self-cancel when it changes
// The SINGLE source-policy descriptor (live/VOD) for this load — computed intent-only at `demuxLoad`, refined
// once from the first response's headers (live: ingest onConnect; VOD: HttpSource.open), then posted as `caps`.
let caps: SourceCapabilities = deriveCapabilities(true);
let capsPosted = false; // post the refined descriptor to main ONCE per load (idempotent; reset per load)
let preferWebCodecs = true; // host preference (per load; forwarded to the VIDEO worker at codec-params time)

let feedBytes = 0;     // bytes ingested (cumulative; telemetry mirror)
let feedDone = false;  // network stream ended → let stepping drain below the low-water
let paused = false;    // live pause: drain+discard to track the live edge; VOD pause: hold position
let pendingSeekMs = -1; // VOD: a pending seek target (ms); -1 = none. Coalesced (last wins).
let seekTraceV = false; // [seek] one-shot: log the first VIDEO au routed after a seek
let seekTraceA = false; // [seek] one-shot: log the first AUDIO au routed after a seek

// resolved codec params (so we relay codecParams only on change)
let curVcodec = 0;
let curAcodec = 0;
let vExtradataShipped = false; // shipped the resolved video extradata for the current vcodec

// recovery counters + adaptive-silence watchdog state (DETECTION here; the ACTION is the error controller's).
let everConnected = false; // only reconnect AFTER a stream has started (initial fail = fatal)
let errorRetries = 0;
let timeoutRetries = 0;
let reconnectsTotal = 0;
let stallsTotal = 0;
let lastByteAtMs = 0;       // performance.now() of the last chunk (0 = none yet this attempt)
let silenceTripped = false; // the watchdog aborted the source → ingest classifies it as such
let streaming = false;     // true ONLY between onConnect and open()'s return — the watchdog's "reading" gate
let cadMean = 0, cadM2 = 0, cadN = 0; // Welford over inter-byte gaps (ms)
const SILENCE_FLOOR_MS = 3000;   // never reopen for a gap under this (a slow GOP cadence is normal)
const SILENCE_CEILING_MS = 12000; // hard cap on the detection window (and the pre-warmup default)
const SILENCE_WARMUP_SAMPLES = 8; // hold the ceiling until the cadence is characterised
function silenceThresholdMs(): number {
  if (cadN < SILENCE_WARMUP_SAMPLES) return SILENCE_CEILING_MS;
  const std = Math.sqrt(Math.max(0, cadM2 / cadN));
  return Math.min(SILENCE_CEILING_MS, Math.max(SILENCE_FLOOR_MS, cadMean + 2 * std));
}

// The CURRENT live-ingest port (so teardown aborts it synchronously — the prompt-FIN guarantee).
let currentSource: LiveSourcePort | null = null;
// VOD: the live HttpSource (single forward range fetch). Module-scope so teardown aborts the in-flight fetch
// synchronously, unwinding any Asyncify range-read suspend so runVod's `finally` can free its demux safely.
let vodSource: HttpSource | null = null;

// ===================== THE TWO SAB PACKET RING PRODUCERS (sole writer each) =====================
// The demux ROUTES by stream id: video (stream 0) → videoRing; audio (stream 1) → audioRing. SPSC discipline:
// this worker is the SOLE writer (writeAu / resetEpoch / signalEof); the VIDEO/AUDIO workers are the sole
// readers. A fresh load bumps PR_GEN on BOTH (the consumers drop the stale segment); stream end signals PR_EOF
// on BOTH (the consumers drain then park). The video ring is the Stage-5 new pipe (the audio ring producer
// MOVED here from worker.ts in this stage).
let videoRing: PacketRingProducer | null = null;
let audioRing: PacketRingProducer | null = null;

let ready: Promise<boolean>;
let resolveReady: (ok: boolean) => void;
ready = new Promise((r) => (resolveReady = r));

/** A loop tagged with `myGen` is alive only while it is the current load and not stopped. */
const alive = (myGen: number): boolean => !stop && myGen === gen;

/** Emit a fatal error AND halt the pipeline (ingest/pump/vod stop at the next `alive()`). */
function failFatal(kind: FerriteFailureKind, code: number, msg: string): void {
  stop = true;
  post({ type: 'error', kind, code, msg, fatal: true });
}

/** The classification context for the CURRENT pipeline (live-edge + ever-connected). One accessor so every
 *  detection site classifies against the SAME context. */
function classifyCtx(): ClassifyContext {
  return { hasLiveEdge: caps.hasLiveEdge, everConnected };
}

/** Post the resolved SourceCapabilities to main ONCE per load (idempotent — onConnect fires on every
 *  reconnect, but the headers don't change). */
function announceCaps(): void {
  if (capsPosted) return;
  capsPosted = true;
  post({ type: 'caps', caps });
}

// ===================== codec-param handoff (id + extradata → the decode workers, via MAIN) =====================

/** Ship the AUDIO codec id (+ extradata) to MAIN → the AUDIO worker when it first resolves / changes. Live
 *  mpegts audio is self-describing (codec id only; empty extradata → the audio worker's bare audioNew); VOD
 *  AAC also needs the out-of-band ASC (demuxAExtradata; empty for live). `extradata` is TRANSFERRED (a fresh
 *  detached copy — a per-realm heap pointer is meaningless across workers). Mirrors demux.rs ship_audio_params. */
function shipAudioParams(ac: number): void {
  if (!F || ac <= 0 || ac === curAcodec) return;
  curAcodec = ac;
  // Live ADTS: no out-of-band ASC (codec id is enough, 0-len → the audio worker's bare audioNew). VOD MP4/MKV
  // AAC: the real AudioSpecificConfig from codecpar → audioNewWithExtradata.
  const extradata = F.demuxAExtradata(demux); // empty for live ADTS; the ASC for VOD AAC (detached copy)
  post({ type: 'codecParams', stream: DEMUX_STREAM_AUDIO, codecId: ac, profile: 0, level: 0, sarNum: 1, sarDen: 1, extradata },
       [extradata.buffer]);
  dlog('audio codec ' + ac + ' → codecParams (audio ring)');
}

/** Ship the VIDEO codec id + extradata (profile/level/SAR for the WC tier) to MAIN → the VIDEO worker when it
 *  first resolves / changes, and re-ship once the live in-band param sets land (extradata becomes non-empty —
 *  a clean sparse-4K-HEVC join). The VIDEO worker builds its decoder + the Fix-A WC config record from this.
 *  `extradata` is TRANSFERRED (a fresh detached copy — a SAB-backed heap view can't postMessage-transfer, and
 *  a per-realm pointer is meaningless across workers). Mirrors demux.rs ship_video_params. */
function shipVideoParams(vc: number): void {
  if (!F || vc <= 0) return;
  const changed = vc !== curVcodec;
  if (changed) {
    if (curVcodec > 0) F.demuxResetVExtradata(demux); // re-arm capture on a mid-stream change
    curVcodec = vc;
    vExtradataShipped = false;
  }
  const edSize = F.demuxVExtradataSize(demux);
  // Ship on the codec change (bare, possibly empty extradata) AND again once the extradata lands (a clean
  // sparse-4K-HEVC join) — the VIDEO worker upgrades its decoder when the non-empty set arrives.
  const wantShip = changed || (!vExtradataShipped && edSize > 0);
  if (!wantShip) return;
  if (edSize > 0) vExtradataShipped = true;
  // demuxVExtradata returns a SAB-backed heap VIEW (.subarray) — which CANNOT be postMessage-transferred (the
  // transfer below would throw + silently DROP the whole codecParams message). The `.slice()` here is the
  // LOAD-BEARING detach: it copies into a plain, transferable ArrayBuffer (and owns the bytes, so a heap grow
  // / next demux step can't move them out from under the in-flight transfer). DO NOT remove the .slice().
  const extradata = F.demuxVExtradata(demux).slice();
  const profile = F.demuxVProfile(demux);
  const level = F.demuxVLevel(demux);
  // SAR via a one-shot keyframe decode in the demuxer (the WC tier has no FFmpeg decoder to read a frame SAR
  // off; the live mpegts probe leaves codecpar SAR unset). All-codec, incl. HEVC. 1:1 when square / absent.
  const sarNum = Math.max(1, F.demuxVSarNum(demux));
  const sarDen = Math.max(1, F.demuxVSarDen(demux));
  post({ type: 'codecParams', stream: DEMUX_STREAM_VIDEO, codecId: vc, profile, level, sarNum, sarDen, extradata },
       [extradata.buffer]);
  dlog('video codec ' + vc + ' → codecParams (video ring; extradata ' + edSize + 'B; SAR ' + sarNum + ':' + sarDen + ')');
}

// ===================== ring routing (the AU hot path) =====================

/** Route one demuxed VIDEO AU into the video ring. Lossy under back-pressure: a full ring drops this AU and
 *  counts it (PR_DROPS); `isKey` rides the record header so the consumer's future GOP logic can drop oldest-
 *  to-keyframe. The read-ahead gate paces the demux so the ring is below capacity here; a drop is only a
 *  genuine overflow. Copies the AU bytes out of the engine heap (auCopy) — the demux is stepped again before
 *  the VIDEO worker reads, so the ring must own the bytes. Mirrors demux.rs route_video_au. */
function routeVideoAu(ptr: number, size: number, isKey: boolean, nalFlags: number, ptsUs: bigint): void {
  if (!F || !videoRing) return;
  const au = F.auCopy(ptr, size);
  if (!videoRing.writeAu(ptsUs, isKey, nalFlags, au)) videoRing.bumpDrops();
  if (seekTraceV) {
    seekTraceV = false;
    dlog('[seek] demux 1st post-seek VIDEO au pts=' + (ptsUs >= 0n ? (Number(ptsUs) / 1e6).toFixed(1) : 'nopts') + 's key=' + isKey);
  }
}

/** Route one demuxed AUDIO AU into the audio ring. ADTS carries no key flag → mark every audio AU a random-
 *  access point (isKey=true, matching demux.rs). Audio is LOSSLESS in practice (the read-ahead gate keeps the
 *  ring far below its cap), so a full-ring drop here is a genuine overflow (the audio worker wedged) — count
 *  it (PR_DROPS) rather than HoL-block the demux (the bug that starved video). Mirrors demux.rs route_audio_au. */
function routeAudioAu(ptr: number, size: number, ptsUs: bigint): void {
  if (!F || !audioRing) return;
  const au = F.auCopy(ptr, size);
  if (!audioRing.writeAu(ptsUs, true, 0, au)) {
    audioRing.bumpDrops();
    dlog('[clk] AUDIO PACKET DROPPED (ring full) @pts=' + (ptsUs >= 0n ? (Number(ptsUs) / 1e6).toFixed(2) : 'nopts') + 's — PTS gap incoming');
  }
  if (seekTraceA) {
    seekTraceA = false;
    dlog('[seek] demux 1st post-seek AUDIO au pts=' + (ptsUs >= 0n ? (Number(ptsUs) / 1e6).toFixed(1) : 'nopts') + 's');
  }
}

/** New load epoch on BOTH rings: the consumers drop the stale segment, cursors reset. */
function resetRingEpochs(): void {
  videoRing?.resetEpoch();
  audioRing?.resetEpoch();
}

/** Signal end-of-segment on BOTH rings (the consumers drain the remainder then park). */
function signalRingEof(): void {
  videoRing?.signalEof();
  audioRing?.signalEof();
}

// ===================== read-ahead gate (mpv demuxer-readahead, BOTH rings) =====================
// Pause reading once BOTH streams have `readAheadMs` buffered, so the demux never over-reads and fills a packet
// ring. Read while EITHER stream is hungry (below its time read-ahead AND below its byte ceiling); never block
// one ring on the other (mpv read_packet `read_more |= !ds->reader_head`). A byte FLOOR per ring covers the
// warmup window before any pts span exists (buffered_ms reads 0 = hungry until the first valid pts). `hasAudio`
// gates the audio half so a video-only stream never waits on an absent audio ring. The read-ahead TARGET is a
// PARAMETER: the live pump passes LIVE_READAHEAD_MS (a seconds-deep cushion), the VOD loop VOD_READAHEAD_MS
// (the mpv local-file floor). Mirrors demux.rs (the live + VOD loops inline this check with their own const).
function readAheadHungry(hasAudio: boolean, readAheadMs: number): boolean {
  const vMs = videoRing ? videoRing.bufferedMs() : Infinity;
  const vBytes = videoRing ? videoRing.buffered() : Infinity;
  const aMs = audioRing ? audioRing.bufferedMs() : Infinity;
  const aBytes = audioRing ? audioRing.buffered() : Infinity;
  const vHungry = !!videoRing && vMs < readAheadMs && vBytes < VIDEO_RING_CEIL_BYTES;
  const aHungry = hasAudio && !!audioRing && aMs < readAheadMs && aBytes < AUDIO_RING_CEIL_BYTES;
  return vHungry || aHungry;
}

// ===================== teardown helpers =====================

/** Free the current demux but keep the engine `F` loaded. (No decoders to free — the decode workers own
 *  theirs.) VOD: abort the source instead of freeing a maybe-suspended demux (the Asyncify ownership rule —
 *  runVod's `finally` frees the captured demux once the suspend unwinds). Mirrors demux.rs free_demux. */
function freeDemux(): void {
  if (F) {
    if (vodSource) {
      // VOD: the range demux may be mid-Asyncify-suspend (awaiting a read); freeing it now would resume the
      // rewind into freed memory. Abort the source → resolves the pending read → the suspend unwinds → runVod's
      // `finally` frees the (captured) demux + nulls vodSource. Do NOT touch the demux/hook here.
      vodSource.abort();
      demux = 0;
      return;
    }
    if (demux) F.demuxFree(demux); // LIVE demux never suspends → free synchronously
    F.setRangeReader(null);        // drop any stale VOD range hook
  }
  demux = 0;
}

/** Free the current pipeline (demux + source) but keep the engine `F` loaded. Mirrors demux.rs stop_pipeline. */
function stopPipeline(): void {
  stop = true;
  if (currentSource) { currentSource.abort(); currentSource = null; }
  freeDemux();
  paused = false;
  curVcodec = 0;
  curAcodec = 0;
  vExtradataShipped = false;
  // A torn-down pipeline resolves a fresh codec next load. Signal BOTH rings EOF so the VIDEO + AUDIO workers
  // drain their tails + park (MAIN separately posts unload/audioUnload to free their decoders + the run()
  // resetEpoch re-anchors the next load). The ring SABs are per-session (MAIN re-uses them).
  signalRingEof();
}

// ===================== message dispatch =====================

self.onmessage = (e: MessageEvent<MainToDemux>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'demuxInit':
      wasmBaseUrl = msg.wasmBaseUrl;
      lwFloor = msg.lowWaterFloor;
      lwCeiling = msg.lowWaterCeiling;
      lwAdaptive = msg.lowWaterAdaptive;
      liveLowWater = lwCeiling;
      liveReadAhead = lwCeiling * 2;
      isIOS = msg.isIOS;
      isAppleWebKit = msg.isAppleWebKit;
      debug = msg.debug;
      void isAppleWebKit; // stored for telemetry segmentation; the demux fork keys off isIOS only
      // The two SAB packet-ring PRODUCERS: the demux routes each AU into them; the VIDEO/AUDIO
      // workers consume. Shared by reference (MAIN handed the same SABs to those workers as the consumers);
      // this worker is the sole writer of each (writeAu / resetEpoch / signalEof).
      videoRing = new PacketRingProducer(msg.videoPacketRing);
      audioRing = new PacketRingProducer(msg.audioPacketRing);
      dlog('packet ring producers attached (video + audio)');
      log('loading engine (demux)…');
      void handleInitLoad();
      break;
    case 'demuxLoad':
      void handleLoad(msg.gen, msg.isLive, msg.preferWebCodecs, msg.url);
      break;
    case 'demuxSetPaused':
      if (msg.paused) {
        paused = true;
      } else if (paused) {
        paused = false;
        // LIVE pause discards packets → resume restarts on a fresh IDR: relay a keyframeResync to the VIDEO
        // worker (it arms its own await_keyframe). VOD holds position.
        if (caps.hasLiveEdge) post({ type: 'keyframeResync' });
      }
      break;
    case 'demuxSeek':
      pendingSeekMs = msg.targetMs; // VOD only; coalesced (last wins). Live never sends this.
      break;
    case 'demuxUnload':
      // Tear down the current pipeline but keep the engine. `gen` already moved on the next load; bumping
      // past msg.gen here cancels in-flight loops even with no follow-up load.
      gen = msg.gen;
      stopPipeline();
      break;
    case 'demuxDestroy':
      void handleDestroy();
      break;
  }
};
// Module workers buffer messages posted before the top-level eval installs onmessage, so the init is never
// dropped. Still post the ready handshake so MAIN can flush its deferred demuxInit/demuxLoad in order once
// this realm's onmessage is live. Mirrors demux.rs start_demux.
post({ type: 'demuxWorkerReady' });

// ===================== async lifecycle =====================

async function handleInitLoad(): Promise<void> {
  try {
    // ferritePool=0 → the demux is single-threaded (no decode pthreads); +2 keeps the same call shape as the
    // decode/audio bootstraps (coordinator headroom). Compressed read-ahead only → 32-MiB start, 96-MiB cap.
    F = await loadFerrite(wasmBaseUrl, 0 + 2, MEM_DEMUX_INIT, MEM_DEMUX_MAX);
    resolveReady(true);
    dlog('engine ready (demux)');
  } catch (err) {
    failFatal('engine-load', -1, 'engine load failed (demux): ' + err);
    resolveReady(false);
  }
}

async function handleLoad(myGen: number, isLive: boolean, prefer: boolean, url: string): Promise<void> {
  if (closing) return;
  // Assign generation SYNCHRONOUSLY (before any await) so a load racing unload/another load can't resurrect a
  // stale gen after `await ready`. Re-check after the await.
  gen = myGen;
  caps = deriveCapabilities(isLive); // intent-only until the first response refines it
  capsPosted = false;
  preferWebCodecs = prefer;
  void preferWebCodecs; // forwarded to the VIDEO worker via codecParams relay (MAIN owns the relay)
  if (!(await ready)) return;          // engine dead — engine-load error already posted
  if (closing || myGen !== gen) return; // destroyed, or superseded by a newer load/unload
  void run(myGen, url);
}

async function run(myGen: number, url: string): Promise<void> {
  if (closing || !F) return;
  // Fresh per-load state (so an unload→load reuse starts clean).
  stop = false;
  feedBytes = 0;
  feedDone = false;
  paused = false;
  pendingSeekMs = -1;
  curVcodec = 0; curAcodec = 0; vExtradataShipped = false;
  peakVideoPes = 0;
  warmedUp = false;
  liveLowWater = lwCeiling;
  liveReadAhead = lwCeiling * 2;
  freeDemux(); // release any pipeline orphaned by a prior errored/superseded run (no leak on reload)
  reconnectsTotal = 0; stallsTotal = 0;
  everConnected = false; errorRetries = 0; timeoutRetries = 0;
  lastByteAtMs = 0; silenceTripped = false; cadMean = 0; cadM2 = 0; cadN = 0;
  streaming = false; // no attempt is reading yet (set true on the first onConnect)
  vodSource = null;
  resetRingEpochs(); // fresh load epoch → the decode workers drop the stale segment
  if (!caps.declaredLive) {
    await runVod(myGen, url);
    return;
  }
  demux = F.demuxNewStreaming();
  F.demuxSetMaxBuffered(demux, MAX_BUFFERED);
  log('connecting…');
  void ingest(myGen, url);
  void silenceWatchdog(myGen); // adaptive upstream-silence reopen (live-only)
  await pump(myGen);
}

async function handleDestroy(): Promise<void> {
  if (closing) return;
  closing = true;
  stop = true; // halt ingest/pump/vod at their next `alive()` check before we free anything
  // Wait for engine init to SETTLE (or the wedge-breaker deadline) before tearing down.
  await Promise.race([ready.catch(() => false), sleep(READY_SETTLE_MS)]);
  stopPipeline();
  // The demux holds ferritePool=0 → no pthread pool to reap (that is the VIDEO/AUDIO workers' job). Just ack.
  post({ type: 'destroyed' });
}

// ===================== VOD: range-streamed file playback =====================
//
// Native ffmpeg/VLC stream+seek a remote container via libavformat's http protocol (Range on seek); WASM ffmpeg
// can't (no sockets), so the engine's range AVIO pulls bytes ON DEMAND through a JS hook. Under Asyncify that
// hook is ASYNC: the demux SUSPENDS during a read (the (empty) decode pool keeps running); runVod/doVodSeek
// await the suspending demux wrappers. Playback starts after the HEADER parse (not a full download). The decode
// workers pace via ring back-pressure, so the demux is NOT credit-gated here (the per-decoder credit-wait lives
// in the VIDEO worker). Mirrors demux.rs run_vod / vod_demux_loop / do_vod_seek.

/** demux_seek_us to tgtUs (backward → keyframe at/before) + bump BOTH ring epochs (the decode workers drop the
 *  stale segment + re-anchor; MAIN re-anchors the present clock + posts audioSeekFlush). The demuxer-less
 *  decoder recreate lives in the decode workers (they see the epoch bump + a keyframeResync); here we own only
 *  the demux_seek_us half. Mirrors demux.rs do_vod_seek. */
async function doVodSeek(myGen: number, tgtUs: number): Promise<void> {
  if (!F || !demux) return;
  const r = await F.demuxSeekUs(demux, tgtUs, 1); // SUSPENDS (reads index/probes); double µs
  if (!alive(myGen)) return;
  // ALWAYS bump the ring epochs — even on a failed seek (r<0, position unchanged): the consumers' seek-block
  // (audio `seeking`, video `await_keyframe`) is released ONLY by the epoch flip, so skipping it on failure
  // would wedge the audio decoder forever. On failure we re-sync to the current (unchanged) position.
  if (r < 0) log('VOD seek rc=' + r + ' (target ' + (tgtUs / 1e6).toFixed(1) + 's) — re-syncing rings to current position');
  else dlog('[seek] demux doVodSeek rc=' + r + ' target=' + (tgtUs / 1e6).toFixed(1) + 's → ring epoch bump');
  resetRingEpochs();       // consumers drop the stale segment + flush their decoders
  seekTraceV = true; seekTraceA = true; // [seek] log the first post-seek au routed on each stream
  post({ type: 'keyframeResync' }); // VIDEO awaits the next IDR after the seek
}

async function runVod(myGen: number, url: string): Promise<void> {
  if (!F) return;
  const f = F; // stable handle for the closures (module `F` loses narrowing inside them)
  // iOS gets the tighter VOD range window (keyed off the platform flag — the demux realm has no credit pool).
  const windowBytes = isIOS ? VOD_WINDOW_BYTES_IOS : VOD_WINDOW_BYTES_DESKTOP;
  // mySource/myDemux are CAPTURED so this run's `finally` cleans up exactly its OWN pair even if a reload
  // already installed a newer pair. The Asyncify ownership rule: teardown only mySource.abort()s; the suspend
  // unwinds → THIS finally frees the demux.
  const mySource = new HttpSource(url, { windowBytes, log, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  vodSource = mySource;
  let myDemux = 0;
  try {
    let total = 0;
    try { total = await mySource.open(); }
    catch (err) { if (alive(myGen)) failFatal('network', -1, 'VOD open failed: ' + err); return; }
    if (!alive(myGen)) return;                                  // teardown during the open suspend
    if (total <= 0) { failFatal('network', -1, 'VOD: server reported no size (Range unsupported?)'); return; }
    // REFINE the descriptor from the first response (HttpSource already parsed it — no extra round-trip).
    caps = deriveCapabilities(caps.declaredLive, { acceptRanges: !mySource.degraded, hasContentLength: total > 0 });
    announceCaps();
    // Install the ASYNC range hook BEFORE demuxNewRange (open/find_stream_info read immediately); it follows
    // the module vodSource so a reload re-points it. demuxNewRange SUSPENDS through find_stream_info.
    f.setRangeReader((pos, len) => (vodSource ? vodSource.read(pos, len) : Promise.resolve(null)));
    myDemux = await f.demuxNewRange(1, total);
    demux = myDemux;
    if (!alive(myGen)) return;                                  // teardown during the find_stream_info suspend
    if (!myDemux) { failFatal('demux', -1, 'could not open VOD container (Range/format?)'); return; }
    // Resolve + relay the codec params to the decode workers (id + extradata; VOD needs the out-of-band sets).
    // The demux holds no decoders — VIDEO/AUDIO build theirs from these messages.
    const vc = f.demuxVcodec(myDemux);
    const ac = f.demuxAcodec(myDemux);
    if (vc <= 0 && ac <= 0) { failFatal('decode', -1, 'VOD: no decodable stream'); return; }
    if (vc > 0) shipVideoParams(vc);
    if (ac > 0) shipAudioParams(ac);
    // Duration → main (drives the scrub bar). 0 = unknown.
    const durUs = Number(f.demuxDurationUs(myDemux));
    post({ type: 'duration', durationMs: durUs > 0 ? Math.round(durUs / 1000) : 0 });
    log('VOD streaming (' + (durUs > 0 ? (durUs / 1e6).toFixed(0) + 's' : 'unknown dur') + ', ' + (total / 1048576).toFixed(1) + ' MiB)');

    // Decode loop. Finite EOF PARKS (kept alive so a seek can replay); pause HOLDS position; a seek takes priority.
    let ended = false;
    while (alive(myGen)) {
      // A seek request takes priority: demux_seek_us (backward → keyframe) + ring epoch bump.
      if (pendingSeekMs >= 0) {
        const tgtUs = Math.max(0, Math.round(pendingSeekMs * 1000));
        pendingSeekMs = -1;
        await doVodSeek(myGen, tgtUs); // SUSPENDS (reads the index through the range AVIO)
        if (!alive(myGen)) break;
        ended = false;
        continue;
      }
      if (paused || ended) { await sleep(40); continue; } // park (seek/resume re-activates the loop)
      // mpv bounded read-ahead (mirrors the live ingest path): pause reading once BOTH streams have their
      // VOD_READAHEAD_MS buffered, so the demux never over-reads + fills a ring (a full audio ring DROPS → PTS
      // gaps → the master clock races — the VOD regression on a fast LAN source). Read while EITHER is hungry.
      const hasAudio = ac > 0;
      if (!readAheadHungry(hasAudio, VOD_READAHEAD_MS)) { await sleep(8); continue; }
      const step = await f.demuxStepVod(myDemux); // SUSPENDS: pulls bytes via the async range AVIO
      if (!alive(myGen)) break; // teardown during the suspend unwound here → the finally frees demux
      feedBytes = mySource.getStats().bytesFetched;
      if (step === 0) {
        // Clean EOF → signal BOTH rings (the decode workers drain then park; a seek can replay).
        signalRingEof();
        if (!ended) { ended = true; post({ type: 'ended' }); }
        continue;
      }
      if (step < 0) {
        if (mySource.stalledOut) {
          const act = classifyError('upstream-silence', classifyCtx()); // VOD ⇒ hasLiveEdge=false ⇒ fatal
          failFatal(act.failure ?? 'network', step, 'VOD upstream silent (read stalled) → ' + act.reason);
        } else {
          failFatal('decode', step, 'VOD demux step error');
        }
        break;
      }
      if (step !== 1) { await sleep(4); continue; } // range mode never returns EAGAIN; defensive
      routeCurrentPkt(f, myDemux);
    }
  } finally {
    // Own the VOD source + demux teardown. By here the Asyncify suspend (if any) has unwound, so freeing the
    // demux is safe. Guard the module mirrors so a newer reload's pair is never touched.
    mySource.abort();
    if (vodSource === mySource) vodSource = null;
    if (F && myDemux) { F.demuxFree(myDemux); if (demux === myDemux) demux = 0; }
    if (vodSource === null && F) F.setRangeReader(null);
  }
}

/** Route the CURRENT VOD demux packet into the matching ring (video = stream 0, audio = stream 1). Resolves +
 *  relays the codec params on the first/changed codec (VOD ships them up front in runVod; defensive here). */
function routeCurrentPkt(f: Ferrite, d: number): void {
  const stream = f.demuxPktStream(d);
  const ptr = f.demuxPktDataPtr(d);
  const size = f.demuxPktSize(d);
  const pts = f.demuxPktPtsUs(d);
  if (stream === 0) {
    const vc = f.demuxVcodec(d);
    if (vc > 0 && vc !== curVcodec) shipVideoParams(vc);
    const isKey = f.demuxPktIsKey(d) === 1;
    routeVideoAu(ptr, size, isKey, f.demuxPktNalFlags(d), pts);
  } else if (stream === 1) {
    const ac = f.demuxAcodec(d);
    if (ac > 0 && ac !== curAcodec) shipAudioParams(ac);
    routeAudioAu(ptr, size, pts);
  }
}

// ===================== ingest (live) =====================
//
// Reconnect (mpegts.js io-controller + hls.js backoff). For a LIVE stream the fetch body ending is NORMAL: a
// CLEAN end that delivered bytes reconnects IMMEDIATELY (seamless, no error, no budget hit); a GENUINE failure
// (throw / connect timeout / non-2xx / empty body) backs off + counts against a budget, fatal only when the
// budget is EXHAUSTED. The demux + the rings persist across reconnects (no per-attempt alloc). Ported verbatim
// from worker.ts ingest (it lived there before the split); only the routing target changed (rings, not inline
// decode). EVERY await re-checks alive(myGen). Mirrors demux.rs ingest.
async function ingest(myGen: number, url: string): Promise<void> {
  if (!F) return;
  const f = F; // stable handle for the onBytes/shouldRead closures

  // Re-request immediately after a CLEAN connection boundary (`retry`): no backoff, no budget hit, NO
  // reconnecting post. Relay a keyframeResync so the VIDEO worker restarts on a fresh IDR.
  const retryNow = (): void => {
    post({ type: 'keyframeResync' });
    reconnectsTotal++;
    log('stream ended — reconnecting (seamless boundary)');
  };

  // A GENUINE failure (`reconnect`): count it (per budget), POST reconnecting, back off, relay a keyframe
  // resync. Returns true to retry, false (after the FATAL early-eof — budget spent).
  const scheduleReconnect = async (isTimeout: boolean): Promise<boolean> => {
    const count = isTimeout ? ++timeoutRetries : ++errorRetries;
    const cap = isTimeout ? RECONNECT_MAX_TIMEOUT_RETRY : RECONNECT_MAX_ERROR_RETRY;
    if (count > cap) {
      feedDone = true; // let the pump drain below low-water and finish
      failFatal('early-eof', -1, 'Fetch stream meet Early-EOF (reconnect exhausted)');
      return false;
    }
    post({ type: 'keyframeResync' });
    reconnectsTotal++;
    post({ type: 'reconnecting', attempt: count });
    const delay = reconnectDelayMs(count - 1, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS);
    log('reconnecting in ' + delay + 'ms (' + (isTimeout ? 'timeout ' : '') + count + '/' + cap + ')');
    await sleep(delay);
    return alive(myGen);
  };

  // EXECUTE the error controller's resolved action. true = re-open, false = stop.
  const applyAction = async (cause: ErrorCause, code: number, msg: string): Promise<boolean> => {
    const action = classifyError(cause, classifyCtx());
    switch (action.kind) {
      case 'retry': retryNow(); return true;
      case 'reconnect': return scheduleReconnect(action.budget === 'timeout');
      case 'recreateDecoder': return true; // ingest never produces a decode-glitch; defensive
      case 'fatal':
        feedDone = true;
        failFatal(action.failure ?? 'network', code, msg);
        return false;
    }
  };

  for (;;) {
    if (!alive(myGen)) return;
    const source = new LiveSourcePort(url);
    currentSource = source;
    let progressed = false; // bytes delivered THIS attempt
    let connectedAtMs = 0;  // performance.now() at onConnect → the eof-boundary duration floor
    try {
      const r = await source.open({
        shouldRead: () => f.demuxBuffered(demux) <= liveLowWater + liveReadAhead,
        alive: () => alive(myGen),
        pollMs: 8,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        onConnect: (status, facts) => {
          everConnected = true;
          connectedAtMs = lastByteAtMs = performance.now();
          caps = deriveCapabilities(caps.declaredLive, facts);
          announceCaps();
          streaming = true; // armed: this attempt is actively reading
          cadMean = 0; cadM2 = 0; cadN = 0;
          log('streaming (HTTP ' + status + ')');
        },
        onBytes: (value) => {
          f.demuxFeed(demux, value);
          feedBytes += value.length;
          const nowMs = performance.now();
          if (lastByteAtMs > 0) {
            const gap = nowMs - lastByteAtMs;
            cadN++; const d = gap - cadMean; cadMean += d / cadN; cadM2 += d * (gap - cadMean);
          }
          lastByteAtMs = nowMs;
          if (!progressed) {
            progressed = true;
            if (errorRetries || timeoutRetries) {
              errorRetries = 0; timeoutRetries = 0;
              post({ type: 'recovered' });
            }
          }
        },
      });
      streaming = false; // open() returned → no longer reading
      if (!alive(myGen)) return;
      if (r.reason === 'gone') return; // teardown/supersede flipped alive() mid-stream
      if (!caps.hasLiveEdge) { f.demuxEof(demux); feedDone = true; return; } // VOD clean EOF — let the pump finish
      if (url.includes('noloop')) {
        // DEMO knob: a faux-live fixture is a finite file; the live reconnect would re-stream it from the top →
        // a PTS reset (the loop "seam"). With `noloop` we end on clean EOF (the VOD finish path).
        f.demuxEof(demux);
        feedDone = true;
        log('faux-live noloop: clean EOF → end (no reconnect)');
        return;
      }
      const boundary = classifyCleanBoundary({
        bytes: r.bytes,
        durationMs: connectedAtMs > 0 ? performance.now() - connectedAtMs : 0,
        minBytes: EOF_BOUNDARY_MIN_BYTES, minMs: EOF_BOUNDARY_MIN_MS,
      });
      if (!(await applyAction(boundary, -1, 'Fetch stream meet Early-EOF'))) return;
      // loop → re-open
    } catch (err) {
      streaming = false; // open() threw → no longer reading; the watchdog must NOT trip during the backoff
      if (!alive(myGen)) return;
      const errName = err instanceof Error ? err.name : typeof err;
      const cause: ErrorCause = classifyIngestCause({
        isRangeError: err instanceof RangeError,
        isHttpStatus: err instanceof SourceHttpError,
        isConnectTimeout: err instanceof SourceConnectTimeout,
        silenceTripped,
      });
      silenceTripped = false; // consume regardless of which branch classifyIngestCause took
      const status = err instanceof SourceHttpError ? err.status : -1;
      const msg = cause === 'range-error' ? 'ingest internal error: ' + err
        : cause === 'http-status' ? 'HTTP ' + status
        : 'ingest: ' + err;
      log('ingest ' + cause + ' (' + errName + ') → ' + classifyError(cause, classifyCtx()).kind);
      if (!(await applyAction(cause, status, msg))) return;
      // loop → re-open
    } finally {
      if (currentSource === source) currentSource = null;
    }
  }
}

// ===================== silence watchdog (live) =====================
// DETECTION here; the ACTION is the error controller's. Covers the failure the reconnect loop CANNOT see: the
// socket stays OPEN but stops delivering bytes (reader.read() never resolves). The watchdog notices the silence
// and ABORTS the source → ingest's catch classifies `upstream-silence` → reconnect. Ported from worker.ts.
async function silenceWatchdog(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(500);
    if (!alive(myGen)) return;
    const src = currentSource;
    if (!src || !silenceWatchdogArmed({ paused, feedDone, hasSource: true, streaming, lastByteAtMs })) continue;
    // Distinguish "upstream went silent" from "WE stopped reading on purpose": when the demux ring is over the
    // watermark the backpressure gate (shouldRead) holds the read loop — reset the silence timer so the
    // watchdog accrues idle ONLY while the gate is open (we're actually trying to read).
    if (F && demux && F.demuxBuffered(demux) > liveLowWater + liveReadAhead) { lastByteAtMs = performance.now(); continue; }
    const idle = performance.now() - lastByteAtMs;
    if (idle > silenceThresholdMs()) {
      stallsTotal++;
      silenceTripped = true;
      lastByteAtMs = performance.now(); // suppress an immediate re-trip while the reopen is in flight
      log('upstream silent ' + (idle | 0) + 'ms > ' + (silenceThresholdMs() | 0) + 'ms (mean+2σ) → reopen');
      src.abort(); // → ingest catch: cause 'upstream-silence' → reconnect
    }
  }
}

// ===================== pump (demux → ring route) =====================

/** Terminal end-of-pipeline. VOD end is clean → `ended`. A LIVE hard-EOF reaching here means the reconnect
 *  path was bypassed → defensively surface the fatal early-eof. Mirrors demux.rs finish_stream. */
function finishStream(): void {
  if (caps.hasLiveEdge) {
    log('finishStream: unexpected live demux EOF (reconnect path bypassed) → fatal early-eof');
    failFatal('early-eof', -1, 'Fetch stream meet Early-EOF');
  } else {
    stop = true;
    signalRingEof();
    post({ type: 'ended' });
  }
}

async function pump(myGen: number): Promise<void> {
  if (!F) return;
  const f = F;
  // Buffer a startup window before the first open.
  while (alive(myGen) && f.demuxBuffered(demux) < STARTUP_BYTES) await sleep(15);
  // Bounded open: a valid MPEG-TS opens within the first KBs.
  let openTries = 0;
  while (alive(myGen) && f.demuxOpen(demux) !== 0) {
    if (++openTries > OPEN_DEADLINE_TRIES) { failFatal('demux', -1, 'could not open container (not MPEG-TS?)'); return; }
    await sleep(15);
  }
  if (!alive(myGen)) return;
  log('demux opened');

  while (alive(myGen)) {
    // Live pause: drain+discard buffered packets to stay at the live edge (no route, no posts).
    if (paused) {
      let s = 1;
      while (s === 1 && alive(myGen)) s = f.demuxStep(demux);
      await sleep(20);
      continue;
    }
    // Low-water: ensure a COMPLETE PES is buffered before stepping. NO credit block — the demux routes to the
    // rings and never waits on a decoder (the per-decoder back-pressure lives in the workers). Pre-warmup (before
    // the first keyframe on the adaptive path) gate on the small lwFloor so SD/HD playback starts the instant
    // the first key AU lands, rather than pre-buffering the full ceiling (mirrors demux.rs).
    const lowWaterGate = (lwAdaptive && !warmedUp) ? lwFloor : liveLowWater;
    while (alive(myGen) && !feedDone && f.demuxBuffered(demux) < lowWaterGate) await sleep(4);
    if (!alive(myGen)) return;

    // Resolve + relay the audio codec params on the first audio codec + any change.
    const ac = f.demuxAcodec(demux);
    if (ac > 0 && ac !== curAcodec) shipAudioParams(ac);

    // mpv read-ahead gate (demux.c read_packet): read while a stream is below its time read-ahead (LIVE uses
    // the seconds-deep LIVE_READAHEAD_MS cushion); otherwise stop reading until a ring drains. A STARVED stream
    // FORCES a read even when the other is full, so the demux can NEVER head-of-line-starve one stream by
    // waiting on the other (the bug that froze video). The UNBOUNDED wait is now safe (video has its own ring +
    // its own consumer worker — pausing here can't HoL video). Break on pause.
    const hasAudio = ac > 0;
    while (alive(myGen) && !paused && !readAheadHungry(hasAudio, LIVE_READAHEAD_MS)) await sleep(4);
    if (!alive(myGen)) return;
    if (paused) continue;

    const step = f.demuxStep(demux);
    if (step === 2) { if (feedDone) { finishStream(); break; } await sleep(8); continue; }
    if (step === 0) { finishStream(); break; }
    if (step < 0) { failFatal('decode', step, 'demux step error'); break; }

    const stream = f.demuxPktStream(demux);
    const ptr = f.demuxPktDataPtr(demux);
    const size = f.demuxPktSize(demux);
    const pts = f.demuxPktPtsUs(demux);

    if (stream === 0) {
      const isKey = f.demuxPktIsKey(demux) === 1;
      // Adaptive low-water from the running-max video PES (warmed on the first keyframe).
      if (lwAdaptive) {
        if (size > peakVideoPes) peakVideoPes = size;
        if (isKey) warmedUp = true;
        liveLowWater = adaptiveLowWater(peakVideoPes, warmedUp, lwFloor, lwCeiling);
        liveReadAhead = adaptiveReadAhead(liveLowWater, lwCeiling * 2);
      }
      // Relay the video codec params on the first codec, a change, OR once the in-band param sets land
      // (extradata becomes non-empty — the clean sparse-4K-HEVC join). shipVideoParams handles the
      // change/re-ship decision; we also poke it once extradata size goes non-empty for the current codec.
      const vc = f.demuxVcodec(demux);
      if (vc > 0) shipVideoParams(vc);
      else if (curVcodec > 0 && !vExtradataShipped && f.demuxVExtradataSize(demux) > 0) shipVideoParams(curVcodec);
      // Route the encoded video AU into the video ring (non-blocking; the read-ahead gate paces the demux).
      routeVideoAu(ptr, size, isKey, f.demuxPktNalFlags(demux), pts);
    } else if (stream === 1) {
      // Route the encoded audio AU into the audio ring (non-blocking; the read-ahead gate paces the demux).
      routeAudioAu(ptr, size, pts);
    }
  }
}
