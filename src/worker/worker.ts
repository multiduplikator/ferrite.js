// Decode worker (Stage A): ONLY decodes. Ingests the stream, demuxes, and runs the ffmpeg
// video/audio decoders, posting decoded frames + PCM to the main thread, which owns present
// (rAF + WebGL2), audio playout, and the master clock.
//
// Flow control: decode is gated on credits granted by the main thread (one per free ring
// slot). No present/pacing logic here — that was the 19fps setTimeout bottleneck.
//
// TIERS: ferrite ALWAYS demuxes (mpegts/PES/seam stays here); only VIDEO decode forks.
//  - SOFTWARE tier — the validated default: ffmpeg vdec → YUV planes → `frame` msg.
//  - WEBCODECS tier — hardware `VideoDecoder` (created HERE in the worker): each demuxed video AU is
//    wrapped as an EncodedVideoChunk (key/delta from ferrite's is_key tag), and the decoder's output
//    VideoFrames are TRANSFERRED to main (`vframe` msg) where they join the SAME present ring/clock.
// Audio is ALWAYS ffmpeg-decoded here (PCM → `audio` msg), both tiers. Tier is chosen per video
// codec once the demuxer reveals it: prefer WebCodecs when the host wants it AND the runtime has a
// VideoDecoder AND the codec family's HW support (probed ONCE at init + cached) AND the stream is
// progressive; otherwise the software tier — so an unsupported codec (e.g. HEVC on a no-HW-HEVC box) falls
// back cleanly, never a dead screen. Mid-stream codec change recreates the decoder keyframe-aligned (mirrors
// the SW vdecNew).
//
// Lifecycle: `init` loads the engine ONCE; `load` starts a stream pipeline tagged with a
// `gen`; `unload` tears the pipeline down but keeps the engine; another `load` reuses it.
// Stale ingest/pump/stats loops from a prior `gen` self-cancel (see `alive()`), so an
// unload→load reuse can never let an orphaned loop touch a freed demux.

import { Ferrite, loadFerrite } from './ferrite-bindings';
import { HttpSource } from './http-source';
import { videoCodecInfo, vodVideoConfig, webCodecsEligible } from './codec';
import {
  adaptiveLowWater, adaptiveReadAhead, reconnectDelayMs,
  LOW_WATER_DEFAULT_FLOOR, LOW_WATER_DEFAULT_CEILING,
  RECONNECT_MAX_ERROR_RETRY, RECONNECT_MAX_TIMEOUT_RETRY,
  RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS, CONNECT_TIMEOUT_MS,
  EOF_BOUNDARY_MIN_BYTES, EOF_BOUNDARY_MIN_MS,
} from '../policy';
import type { MainToWorker, WorkerToMain, DecodeToPresent, PresentToDecode } from '../protocol';
import type { FerriteFailureKind } from '../errors';
import type { Tier } from '../types';
import { LiveSourcePort, SourceHttpError, SourceConnectTimeout } from '../source/port';
import { deriveCapabilities, type SourceCapabilities } from '../source/capabilities';
import { classifyError, type ErrorCause, type ClassifyContext } from '../controller/error-controller';
import { classifyIngestCause, silenceWatchdogArmed, classifyCleanBoundary } from '../controller/ingest-classify';
import { wcShouldWaitFeed, wcParkWatchdog, wcKeyframeGate, wcStallAction, wcCapabilityCached, WC_PROBE_CODECS } from './wc-guard';
import type { WcFamily } from './wc-guard';

// Mirror the reference player's stream constants.
const STARTUP_BYTES = 256 * 1024;       // buffer before first demux_open
const MAX_BUFFERED = 16 * 1024 * 1024;  // demux ring safety cap (sheds oldest on overflow)
// VOD: sliding-window ceiling for the HttpSource forward range transport (src/worker/http-source.ts).
// iOS-aware (8 MiB iOS / 16 MiB desktop, keyed off creditCap = RING_CAP) so the rolling buffer stays inside the iPad
// <300 MB budget; the actual buffer is compacted to ~one chunk, this is only the ceiling. Replaces the
// rejected sync-XHR-per-window model (one HTTP connection per 4 MiB = the upstream-proxy connection churn);
// HttpSource keeps ONE long-lived forward fetch, reopening only on a seek out of the window.
const VOD_WINDOW_BYTES_DESKTOP = 16 * 1024 * 1024;
const VOD_WINDOW_BYTES_IOS = 8 * 1024 * 1024;

// ---- adaptive demux-ring low-water (policy.ts adaptiveLowWater) --------
// Replaces the FIXED 2 MiB low-water / 4 MiB read-ahead. The low-water relaxes to the largest video
// PES observed (tight buffer = low live latency on SD/HD) but never below the floor or above the
// ceiling (the 4K-HEVC full-PES correctness floor), preserving PES-completeness on EVERY stream.
let lwFloor = LOW_WATER_DEFAULT_FLOOR;       // config stashInitialSize (resolved)
let lwCeiling = LOW_WATER_DEFAULT_CEILING;   // config stashMaxSize (= the 4K full-PES floor)
let lwAdaptive = true;                       // config stashAdaptive (off ⇒ fixed ceiling, the pre-adaptive behaviour)
let liveLowWater = lwCeiling;                // current low-water (held at ceiling until warmed)
let liveReadAhead = lwCeiling * 2;           // current read-ahead (2× the low-water, capped)
let peakVideoPes = 0;                        // running MAX video PES size (monotonic; never resets)
let warmedUp = false;                        // first video keyframe seen → adaptive sizing engages
const OPEN_DEADLINE_TRIES = 530;        // ~8s @ 15ms: with ≥STARTUP_BYTES buffered and still no
                                        // open, the container is unparseable → FormatError (not a hang).
const READY_SETTLE_MS = 12000;          // destroy wedge-breaker: max wait for a hung loadFerrite
                                        // before forcing teardown. Generous (cold engine init can
                                        // take several seconds); the normal path returns as soon as
                                        // `ready` settles, not after this. Main's shutdown timeout
                                        // MUST exceed this + the pool reap (see index.ts).
// Spawn-race-safe pool reap (destroy): a pthread worker still completing its async spawn/replenish when
// the first terminateAllThreads() runs is in neither PThread set → orphans (~1/8 when stop races warmup).
// Keep re-reaping as in-flight spawns LAND, until the pool stays empty for a quiet window or a deadline.
const REAP_POLL_MS = 60;        // re-reap poll cadence
const REAP_QUIET_MS = 350;      // pool must read 0 this long (no new straggler) before we stop
const REAP_MIN_WATCH_MS = 500;  // always watch at least this long (covers a straggler's spawn latency)
const REAP_DEADLINE_MS = 4000;  // hard backstop on the reap-watch loop
// SINGLE SOURCE OF TRUTH for the software in-flight bound. main sends its RING_CAP on `init`
// (index.ts) and we cap credits at it, so the worker can NEVER decode past main's present-ring
// capacity (defends backpressure even if a batch release / re-load over-grants) and the bound can
// NEVER drift from RING_CAP again. (Was a hardcoded 48 here that stayed 48 when RING_CAP dropped to
// 12 for the frame-pinning fix → decode ran ~48 frames ahead, pinning ~1.2 GB of 4K-10bit
// AVFrames → the 2 GiB heap-ceiling trap.) Set on `init` (always before any `load`); 0 until then.
let creditCap = 0;

const post = (m: WorkerToMain, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

// Split-realm present: decoded VIDEO frames go straight to the PRESENT worker over this MessageChannel
// port (NOT to main), and retired software heap slots come back over it by token (release). Set on `init`.
let presentPort: MessagePort | null = null;
const postFrame = (m: DecodeToPresent, transfer: Transferable[] = []) => presentPort?.postMessage(m, transfer);

let F: Ferrite | null = null;
let threads = 8;
let wasmBaseUrl = '/';
// Platform tells (detected main-side, forwarded on init). Stored for Apple-WebKit-specific
// robustness + telemetry segmentation; the main thread owns the iOS present-ring cap.
let isIOS = false;
let isAppleWebKit = false;

let demux = 0;
let vdec = 0;
let adec = 0;
let stop = false;
let closing = false;    // 'destroy' received → terminal; never cleared (gates load/run so a queued
                        // load can't resurrect a pipeline after we've terminated the thread pool)
let gen = 0;            // current load generation; loops capture it and self-cancel when it changes
// LIVE/VOD UNIFICATION (Tier 1): the SINGLE source-policy descriptor for this load. Computed at `load`
// from the declared intent (deriveCapabilities(msg.isLive)) and REFINED once from the first response's
// headers (live: ingest onConnect; VOD: HttpSource.open), then posted to main as `caps`. Every worker-
// side live/VOD fork reads a field of THIS — `declaredLive` (transport/ingest + decoder-init, decided
// before any response), `hasLiveEdge` (reconnect/await-keyframe/EOF-meaning), never a scattered bool.
let caps: SourceCapabilities = deriveCapabilities(true);
let capsPosted = false; // post the refined descriptor to main ONCE per load (idempotent; reset per load)
let preferWebCodecs = true; // host preference (per load); gates the hardware tier
let credits = 0;       // decode budget granted by main; 1 per free ring slot (SOFTWARE tier only)
let postedCount = 0;   // frames posted (cumulative; for decode-fps + decodedFrames stats)
let feedBytes = 0;     // bytes ingested (cumulative; for ingest-rate stat)
let feedDone = false;  // network stream ended → let stepping drain below the low-water
let paused = false;    // live pause: drain+discard to track the live edge; VOD pause: hold position
let awaitKeyframe = false; // after a resume / WebCodecs (re)configure: skip video until the next IDR
let lastDeintFailed = false;
// Has the live demux resolved the video param sets (VPS/SPS/PPS → codecpar extradata) so the SW
// decoder is built FROM the demux (with extradata) rather than bare? Until it has, H.264/HEVC pre-keyframe
// packets are HELD (a param-set-less decoder can't decode them and floods "PPS id out of range").
let swHasExtradata = false;
let heldVideoPkts = 0; // video packets held awaiting param-set resolution (bounded escape valve)
// ~12 s @ 50 fps — far beyond any real GOP, so the hold only gives up on a stream that signals param
// sets exclusively out-of-band (no in-band SPS/VPS AND no flagged keyframe), reverting to legacy feed.
const HOLD_FALLBACK_PKTS = 600;
let pendingSeekMs = -1; // VOD: a pending seek target (ms); -1 = none. Coalesced (last wins).
// VOD: the live HttpSource (single forward range fetch). Module-scope so teardown (stopPipeline) can
// abort() the in-flight fetch synchronously — the same prompt-FIN guarantee as the live currentSource.
let vodSource: HttpSource | null = null;
// The CURRENT live-ingest fetch's AbortController, hoisted to module scope so a teardown
// (unload/destroy → stopPipeline) can abort the in-flight `/proxy` fetch SYNCHRONOUSLY rather than
// waiting for the next `reader.read()` to resolve (the only thing the per-attempt `alive()` check
// reacts to) or for main's eventual `Worker.terminate()`. Without this, a fast destroy handshake
// (which the faster destroy handshake / Tier-1a sped up to reap the pthread pool) preempts the ingest loop's own per-attempt
// `finally` abort before the next byte arrives, leaving the socket for terminate() to close — and a
// terminate()'d worker's fetch is not guaranteed to FIN promptly, so the demo proxy keeps draining the
// bridge and the subscriber lingers / accumulates ("1 stream → 2 subscribers"). Aborting here fires
// while the worker is still alive, so the fetch closes at once → serve.mjs `res.on('close')` → upstream
// abort → the bridge drops the subscriber within ms. Set per attempt in `ingest`, cleared on its exit.
// The connect+read+abort is now the LiveSourcePort (src/source/port.ts); `currentSource` is THIS
// attempt's port so stopPipeline() can `.abort()` it synchronously (the same prompt-FIN guarantee).
let currentSource: LiveSourcePort | null = null;

// ---- recovery: the single error controller's counters + the adaptive upstream-silence watchdog ----
// Cumulative LIVE reconnect attempts + ingest stall-watchdog firings this load (surfaced on getStats() +
// the stats bus, un-stubbing the previously-zero counters). Reset per load in run(), zeroed on teardown.
let reconnectsTotal = 0;
let stallsTotal = 0;
// The adaptive upstream-silence watchdog (a mean+2σ silence→reopen threshold). DETECTION
// lives here; the ACTION is the error controller's (classifyError('upstream-silence') → reconnect). It
// guards the case the reconnect/backoff loop CANNOT see: the socket stays OPEN but stops delivering bytes
// (a wedged upstream) — `reader.read()` just never resolves, so no throw, no clean end. The watchdog
// notices the silence and ABORTS the source, which surfaces in ingest's catch as `silenceTripped` → an
// `upstream-silence` cause (→ reconnect) rather than being misread as a plain network drop.
let lastByteAtMs = 0;       // performance.now() of the last received chunk (0 = no bytes yet this attempt)
let silenceTripped = false; // the watchdog aborted the source for silence → ingest classifies it as such
// FIX 2 — the "actively streaming" sentinel that gates the watchdog OUT of the reconnect backoff window.
// `currentSource` can't gate this: the per-attempt `finally` that nulls it runs only AFTER the catch's
// backoff await, so a dead port lingers through the whole sleep — long enough for the watchdog to accrue
// idle on a drained demux, spuriously TRIP (stale silenceTripped + stallsTotal++), and (pre-FIX-1) race
// that flag into the next attempt's classify. `streaming` is true ONLY between onConnect and the instant
// open() returns/throws, so the watchdog never fires while no attempt is reading. Reset per load + here.
let streaming = false;
// Welford stats over inter-byte GAPS (ms) → an adaptive threshold = clamp(mean + 2σ, floor, ceiling). A
// bursty CDN with a wide cadence gets a wider threshold (no false reopen); the floor stops over-eagerness
// and the ceiling bounds the worst-case detection latency. Reset per load.
let cadMean = 0, cadM2 = 0, cadN = 0;
const SILENCE_FLOOR_MS = 3000;   // never reopen for a gap under this (a slow GOP cadence is normal)
const SILENCE_CEILING_MS = 12000; // hard cap on the silence detection window (and the pre-warmup default)
const SILENCE_WARMUP_SAMPLES = 8; // hold the ceiling until the cadence is characterised (no startup false-trip)
function silenceThresholdMs(): number {
  if (cadN < SILENCE_WARMUP_SAMPLES) return SILENCE_CEILING_MS;
  const std = Math.sqrt(Math.max(0, cadM2 / cadN));
  return Math.min(SILENCE_CEILING_MS, Math.max(SILENCE_FLOOR_MS, cadMean + 2 * std));
}

// ---- WebCodecs (hardware video) tier state -------------------------------------
let tier: Tier = 'software';        // active video tier for the CURRENT codec (reported to main)
let useWc = false;                  // route video AUs to the hardware VideoDecoder (else ffmpeg vdec)
let vdecWc: VideoDecoder | null = null; // the hardware decoder (created/closed in the worker)
let wcCodec = '';                   // current WebCodecs codec string (for self-heal reconfigure)
// VOD-WC: the VideoDecoder `description` (avcC/hvcC config record) for a LENGTH-PREFIXED VOD container
// (MP4/MKV) — null for Annex-B (LIVE mpegts, or a .ts VOD). Persisted at module scope so every (re)create
// — initial setup, a stall-watchdog recreate, a self-heal rebuild, a VOD seek flush — reconfigures with the
// SAME description (the stream's format never changes mid-timeline). Reset to null on a fresh load / a
// WC→software fallback. WebCodecs keys the bitstream format off this presence (Chrome): set ⇒ length-prefixed.
let wcDescription: Uint8Array | null = null;
let wcHealthy = false;              // a VideoFrame has decoded since the last (re)configure
let lastWcPtsUs = 0;                // last fed video PTS (µs) — estimate a mid-stream NOPTS packet
let lastRealWcPtsUs = -1;           // last REAL (demuxed) video PTS (µs); derives the frame interval
let wcFrameIntervalUs = 1_000_000 / 50; // observed inter-frame interval (µs), 50 fps seed (see feedWc/U4)
let annW = 0, annH = 0;             // last announced video dims (software fills these; WC fills from frames)
let curVcodec = 0, curAcodec = 0;   // current demux codec ids (drive (re)create + tier decisions)

// ---- LIVE-WC guards — the WC analogs of the software no-drop + param-set-hold + recovery
// guards the hardware path was missing (over-feed → decode q 314 → stall → reconnect loop → audio dead).
// Decisions live in the pure `./wc-guard` helpers; this is the state they read.
let wcInFlight = 0;                 // (a) TELEMETRY ONLY: decoded VideoFrames posted to present, NOT yet released. NOTHING gates on this (the deadlock source) — `release.vf` keeps it honest for the buildlog
let wcGateParked = false;           // (a) gate state for the buildlog: is the pump currently parked in the feed-wait? (a permanent 1 = a latch — the regression signature)
let wcParkWatchdogs = 0;            // (a-belt) cumulative feed-park-watchdog force-unparks — must stay 0 with the decodeQueueSize-only gate (non-zero = a future gate re-latched)
let lastWcOutputAtMs = 0;          // (c) wall ms of the last decoded WC frame (or the last (re)create) — stall detector
let wcStallRecreates = 0;          // (c) consecutive stall-recreates without recovery → fall back to software at the budget
let lastWcRecreateAtMs = 0;        // (c) when the last WC (re)create happened — the post-recreate forgiveness window
const WC_DECODE_QUEUE_MAX = 6;     // (a) encoded-input ceiling — keeps decodeQueueSize single-digit (the 314 fix)
const WC_PARK_WATCHDOG_MS = 2000;  // (a-belt) max a feed-park may persist with the encoded queue NOT full before we force re-evaluate (an invisible-latch breaker; never fires with the decodeQueueSize-only gate)
// (c) no-output-while-queued window before a stall recreate. Also bounds the worst-case audio gap during a
// stall (the feed-backpressure parks the pump until this fires → ~this much audio reservoir drains, once,
// non-cumulatively). 1500ms debounces a legitimate decode hiccup / GC pause (which recovers on its own,
// so a needless recreate + its resync are avoided) while keeping the audio gap near the live reservoir
// depth. The owner browser bank tunes this against real audio continuity.
const WC_STALL_MS = 1500;
const WC_STALL_MAX_RECREATES = 3;  // (c) failed recreates before the software fallback
const WC_STALL_FORGIVE_MS = 3000;  // (c) sustained healthy output after a recreate → forgive the recreate counter

function hasVideoDecoder(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';
}

/** Probe whether THIS runtime's hardware decodes `codec` (the async VideoDecoder.isConfigSupported).
 *  Called ONCE per representative family at init to fill `wcCapCache` — NEVER on the per-play tier path
 *  (that's a synchronous `wcCapabilityCached` lookup). A BARE codec string is probed (no `description`): a
 *  length-prefixed VOD config the bare probe over-accepts is caught authoritatively by createWcDecoder's
 *  configure() throw → fallbackToSoftware (the real gate; isConfigSupported was always advisory). */
async function wcConfigSupported(codec: string): Promise<boolean> {
  try {
    const VD = (globalThis as { VideoDecoder?: { isConfigSupported?: (c: VideoDecoderConfig) => Promise<{ supported?: boolean }> } }).VideoDecoder;
    if (!VD?.isConfigSupported) return false;
    const res = await VD.isConfigSupported({ codec });
    return !!res?.supported;
  } catch {
    return false;
  }
}

// WebCodecs CAPABILITY CACHE. Filled ONCE at init by `probeWcCapabilities()`; read
// per-play via `wcCapabilityCached`. An empty/unprobed cache → every lookup false → software (safe default).
const wcCapCache: Partial<Record<WcFamily, boolean>> = {};
let wcCapProbed = false;

/** Probe the representative codec families' HW support ONCE and cache the results. No-op without a
 *  VideoDecoder runtime (cache stays empty → every per-play lookup falls back to software). Independent of
 *  the engine, so it runs alongside the engine load. */
async function probeWcCapabilities(): Promise<void> {
  if (wcCapProbed) return;
  wcCapProbed = true;
  if (!hasVideoDecoder()) return; // no WC runtime → leave the cache empty → software for every stream
  for (const fam of Object.keys(WC_PROBE_CODECS) as WcFamily[]) {
    wcCapCache[fam] = await wcConfigSupported(WC_PROBE_CODECS[fam]);
  }
}

/** One-line breadcrumb of the probed capability cache (init log). */
function wcCapSummary(): string {
  if (!wcCapProbed || !hasVideoDecoder()) return 'no VideoDecoder';
  return (Object.keys(WC_PROBE_CODECS) as WcFamily[]).map((f) => f + '=' + (wcCapCache[f] ? '1' : '0')).join(' ');
}

// TRUE zero-copy present via frame-pinning (supersedes the earlier pack-slot ring). The decode
// worker HOLDS a ref on the decoder's output frame (ferrite_vdec_hold → token) and posts the frame's
// three plane heap offsets + byte strides + bit depth to the present worker, which uploads them STRAIGHT
// to WebGL2 integer textures — the GPU de-strides (UNPACK_ROW_LENGTH) + bit-scales (no 10→8 CPU
// downshift). That downshift was ~100% of the per-frame present cost on 10-bit 4K (the ~30 fps cap); now
// the only per-frame copy is the unavoidable GPU upload → the pipeline goes decode-bound. NO JS .set /
// SAB copy, NO pack, NO pre-allocated heap slots.
//
// Lifetime: a held frame stays valid (refcounted) until the present worker retires it and posts
// {release, token}; only then does the decode worker unref it (the decoder may reuse that buffer). The
// held table is bounded ENGINE-side (HELD_CAP=64) — far above the SW present ring (SW_RING_CAP = RING_CAP+4
// = 16) + transit headroom, so the decode worker always has a free held slot while the present worker
// holds its full ring (no deadlock);
// hold returns 0 when the table is full → DROP this frame (backpressure, never blocks). Plane pointers
// survive a pthread heap grow (only views detach — re-viewed fresh present-side).
// DECODE-RELIEF LEVERS (skip-non-ref / skip-loop): the engine decode-skip toggles, settable mid-stream
// from main (`setSkips`). The worker REMEMBERS them and re-applies (ferrite_vdec_set_skips) after every
// (re)create so the choice persists across a codec change / WC→SW fallback / VOD seek. A fresh decoder
// context defaults to no-skip; applySkips() then sets it to the current state (so it never carries stale
// engine state — "both fields reset on a fresh load" + the user's choice re-applied).
let leverSkipNonref = false; // skip-non-ref: AVDISCARD_NONREF — ~half the decoded frames + decode work (MANUAL)
let leverSkipLoop = false;   // skip-loop: AVDISCARD_ALL on the loop filter — cheaper decode, all frames kept, softer (MANUAL)
// The AUTO skip state, fanned out by the PRESENT worker when its graceful-degradation trigger
// latches (over the decode↔present port). Kept SEPARATE from the manual levers and OR-folded in applySkips:
// the EFFECTIVE skip is manual OR auto, so a manual force is never stomped by auto and vice-versa (same
// MAX-degrade semantics as the present-cap's `manualHalf ? HALF : autoTier`). Cleared on a fresh load (run/stopPipeline)
// + retracted by the present worker's reset() — so a healthy new stream never inherits prior degradation.
let autoSkipNonref = false;
let autoSkipLoop = false;
// Software deinterlace mode (0=off, 1=auto, 3=bwdif); set via the `setDeint` message, default auto.
// Re-applied (ferrite_vdec_set_deint) at every software-decoder (re)create; the WC/HW tier ignores it.
let deintMode = 1;
/** Apply the EFFECTIVE skip lever state (manual OR auto) to a software video decoder (no-op for the WC
 *  tier / a null vdec). Read by avcodec PER FRAME, so this takes effect mid-stream with no re-init. */
function applySkips(v: number): void {
  if (F && v) F.vdecSetSkips(v, (leverSkipNonref || autoSkipNonref) ? 1 : 0, (leverSkipLoop || autoSkipLoop) ? 1 : 0);
}

// TRUE content frame period (µs) from the demux VIDEO PACKET PTS — sent to the present worker so its
// tier-2 PTS-cap targets content×tier. This is NON-REF-SKIP-INDEPENDENT: skip_frame discards DECODER OUTPUT, not
// demux packets, so the packet cadence stays the real content rate even when non-ref-skip halves decoded frames →
// the cap shows all of those wider-spaced frames (no double-decimation). Packets arrive in DECODE (DTS)
// order, so consecutive PTS deltas are non-monotonic with B-frames; we keep a small window of recent
// packet PTS, sort it, and take the median ADJACENT difference (≈ the frame period, robust to reorder +
// GOP/seam jumps). 0 until ≥8 packets (the present worker falls back to its arrival median until then).
let contentPeriodUs = 0;
const vidPktPts: number[] = [];
function feedVidPktPeriod(ptsUs: number): void {
  if (ptsUs < 0) return;
  vidPktPts.push(ptsUs);
  if (vidPktPts.length > 48) vidPktPts.shift();
  if (vidPktPts.length >= 8) {
    const s = vidPktPts.slice().sort((a, b) => a - b);
    const diffs: number[] = [];
    for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d > 0 && d < 200_000) diffs.push(d); } // 0<Δ<200ms = a frame gap
    if (diffs.length) { diffs.sort((a, b) => a - b); contentPeriodUs = diffs[diffs.length >> 1]; }
  }
}

let frameDrops = 0; // DIAG: frames dropped because the held table was full (present fell far behind)
// Counter channel: the AUTHORITATIVE in-flight held-frame count (SW tier). The engine's held table
// is the real owner; this mirrors it on the worker side (++ on a successful hold/post, -- on release) so
// the ~1 Hz stats post can hand main a TRUE held count — replacing the earlier present-ring-depth proxy. WC
// frames are TRANSFERRED to the present worker (it owns/closes them), so they don't count here.
let heldFrames = 0;
/** Hold the decoder's current frame and emit a `frame` message (token + Y/U/V heap offsets + byte
 *  strides + bit depth). Returns false (the held table was full → frame dropped) so the caller can
 *  account the drop; true on success (one credit consumed). NO copy — the present worker reads the
 *  planes straight from the live heap and releases the token when it retires the frame. */
function holdAndPostFrame(w: number, h: number, cw: number, ch: number): boolean {
  if (!F || !vdec) return false;
  const token = F.vdecHold(vdec);
  if (token === 0) { frameDrops++; return false; }
  const bitDepth = F.vdecBitdepth(vdec);
  const colorspace = F.vdecColorspace(vdec); // AVColorSpace (matrix_coefficients) — software YUV→RGB selection
  const colorRange = F.vdecColorRange(vdec); // AVColorRange (limited/full)
  const colorTrc = F.vdecColorTrc(vdec);     // AVColorTransferCharacteristic (PQ=16/HLG=18 → HDR tone-map)
  const ptrs: [number, number, number] = [F.vdecHeldPlane(token, 0), F.vdecHeldPlane(token, 1), F.vdecHeldPlane(token, 2)];
  const lns: [number, number, number] = [F.vdecHeldLinesize(token, 0), F.vdecHeldLinesize(token, 1), F.vdecHeldLinesize(token, 2)];
  postFrame({ type: 'frame', gen, ptsUs: F.vdecPts(vdec), w, h, cw, ch, bitDepth, colorspace, colorRange, colorTrc, token, ptrs, lns, contentPeriodUs, demuxRingBytes: demux ? F.demuxBuffered(demux) : 0 });
  postedCount++;
  credits--;
  heldFrames++; // authoritative in-flight held count (released by the present worker's `release`)
  return true;
}
/** The present worker released a retired frame: unref the held AVFrame (the decoder may reuse its
 *  buffer) and grant one decode credit. Single-release is structurally guaranteed (each frame leaves the
 *  present ring exactly once); vdecRelease is itself idempotent engine-side. */
function releaseFrame(token: number): void {
  if (!F) return;
  F.vdecRelease(token);
  credits = Math.min(credits + 1, creditCap);
  if (heldFrames > 0) heldFrames--; // mirror the release into the authoritative held count
}

let ready: Promise<boolean>;
let resolveReady: (ok: boolean) => void;
ready = new Promise((r) => (resolveReady = r));

const log = (m: string) => post({ type: 'log', message: m });

/** A loop tagged with `myGen` is alive only while it is the current load and not stopped. */
const alive = (myGen: number): boolean => !stop && myGen === gen;

/** Emit a fatal error AND stop the pipeline (halt ingest/pump/stats + abort the fetch). */
function failFatal(kind: FerriteFailureKind, code: number, msg: string): void {
  stop = true;
  post({ type: 'error', kind, code, msg, fatal: true });
}

/** Free the current demux + decoders (no flag/stop changes). Used before a (re)load alloc + on teardown. */
function freeDecoders(): void {
  freeWc();
  if (F) {
    if (vdec) F.vdecFree(vdec);
    if (adec) F.audioFree(adec);
    if (vodSource) {
      // VOD: the range demux may be mid-Asyncify-suspend (awaiting a read); freeing it now would resume the
      // rewind into freed memory. Instead abort the source — that resolves the pending read → the suspend
      // unwinds → runVod's `finally` frees the (captured) demux safely + nulls vodSource. Do NOT touch the
      // demux or the hook here (a reload may already have installed a new pair). vdec/adec are NOT on the
      // suspended stack and runVod's `!alive` guard stops it touching them, so freeing them here is safe.
      vodSource.abort();
      vdec = adec = 0;
      return;
    }
    if (demux) F.demuxFree(demux); // LIVE demux never suspends → free synchronously as before
    F.setRangeReader(null);        // drop any stale VOD range hook
  }
  vdec = adec = demux = 0;
}

/** Close the hardware VideoDecoder (idempotent). Frames already TRANSFERRED to main are owned +
 *  closed there; closing the decoder releases its internal output pool. Sync — must run before the
 *  pthread reap on teardown (it doesn't touch the pool, but keeps decoder/pool teardown ordered).
 *
 *  Drain before close: reset() SYNCHRONOUSLY aborts the decoder's queued work and DISCARDS any
 *  decoded-but-not-yet-output frames, so no late output() callback can fire AFTER teardown and strand a
 *  VideoFrame we'd no longer track. (The output() guard `stop||closing||!useWc` is the belt; reset() is
 *  the suspenders — and on iOS/VideoToolbox a reset-then-close leaves the WC subsystem cleaner than a
 *  bare close, which is the wedged-decoder-poisons-next-stream symptom we're chasing.) We do NOT await
 *  flush() — a flush can hang on a wedged decoder and would block the destroy handshake; reset() is sync.
 *
 *  When we free a LIVE decoder mid-stream (codec change / fallback / self-heal rebuild), tell
 *  main to close this decoder's frames still in the present ring before it could draw one from the
 *  now-freed pool. Suppressed during teardown (stop/closing) — main closes the whole ring itself then. */
function freeWc(): void {
  const hadLive = !!vdecWc && !stop && !closing;
  if (vdecWc) {
    try {
      if (vdecWc.state !== 'closed') {
        try { vdecWc.reset(); } catch { /* reset unsupported / already unconfigured — close still frees */ }
        vdecWc.close();
      }
    } catch (err) { log('vdec close: ' + err); }
    vdecWc = null;
  }
  wcCodec = '';
  wcHealthy = false;
  // Drop the present ring only on iOS. The drop-frames signal exists because iOS/VideoToolbox backs a VideoFrame
  // by the DECODER's surface pool, so drawing one after the decoder is freed is UB. On desktop the
  // VideoFrame is an independent object that stays drawable after close(), so clearing the ring on
  // every freeWc was pure cost — and freeWc fires on each mid-stream SELF-HEAL rebuild (handleWcError
  // when wcHealthy), so an H.264 stream that throws the odd transient decode error cleared + re-filled
  // the ring repeatedly → visible "frames mixed"/jitter (the desktop-jitter report). Gate the ring-clear to iOS
  // (keeps the real iOS pool-UB safety) and only LOG it elsewhere — the log is the instrument: if it
  // prints during the desktop jitter, the self-heal storm is the cause (its deeper fix = the
  // config-ladder / fallback work). The decode-error storm itself is unchanged here.
  if (hadLive) {
    if (isIOS) postFrame({ type: 'dropVideoFrames', gen }); // gen-tagged so the present worker drops a stale one (startup/reload race)
    else log('freeWc: live WC decoder freed mid-stream (codec change / self-heal) — ring kept (desktop)');
  }
}

/** Build a fresh hardware decoder whose output VideoFrames are TRANSFERRED to main (it owns + closes
 *  them — `transfer: [frame]` neuters our handle). Configured for `codec`; the caller awaits the next
 *  keyframe (`awaitKeyframe`) before feeding. On a decode error the decoder closes; the error handler
 *  rebuilds or (before the first frame) falls back to software. */
function createWcDecoder(codec: string): void {
  freeWc();
  const dec = new VideoDecoder({
    output: (frame: VideoFrame) => {
      // Drop a frame that arrives after teardown/codec-switch rather than touch a dead pipeline.
      if (stop || closing || !useWc) { try { frame.close(); } catch { /* already closed */ } return; }
      wcHealthy = true; // a frame decoded → healthy: the tier choice held
      postedCount++;
      // (c) output PROGRESS: stamp the last-output time (the stall watchdog measures no-output-while-queued
      // against this) and FORGIVE the recreate budget once the decoder has run healthy for FORGIVE_MS after
      // a (re)create — so a one-off glitch that self-heals doesn't accrue toward the software fallback.
      const nowMs = performance.now();
      lastWcOutputAtMs = nowMs;
      if (wcStallRecreates > 0 && nowMs - lastWcRecreateAtMs > WC_STALL_FORGIVE_MS) wcStallRecreates = 0;
      // (a) one more VideoFrame is in flight in the present ring (decremented by the present worker's
      // `release.vf` ack) — the WC analog of `heldFrames`, read by the feed-backpressure gate.
      wcInFlight++;
      const ptsUs = frame.timestamp;
      postFrame({ type: 'vframe', gen, ptsUs, frame, contentPeriodUs, demuxRingBytes: F && demux ? F.demuxBuffered(demux) : 0 }, [frame]);
    },
    error: (e: DOMException) => handleWcError('' + e),
  });
  try {
    // VOD-WC: a length-prefixed container (MP4/MKV) needs the avcC/hvcC `description` so the decoder reads
    // nal_length_size + the out-of-band param sets; LIVE/Annex-B passes none (wcDescription null). The
    // description's bitstream-format selection is what makes length-prefixed VOD packets decode (vs Annex-B).
    const config: VideoDecoderConfig = { codec };
    if (wcDescription) config.description = wcDescription;
    dec.configure(config);
  } catch (err) {
    // A string isConfigSupported accepted can still throw here on some HW → software fallback.
    log('vdec configure failed (' + codec + '): ' + err);
    vdecWc = dec;
    fallbackToSoftware();
    return;
  }
  vdecWc = dec;
  wcCodec = codec;
  wcHealthy = false;
  lastRealWcPtsUs = -1; // don't derive the frame interval across a (re)configure boundary (U4)
  awaitKeyframe = true; // WebCodecs MUST start on a keyframe after every (re)configure
  // (c) the stall watchdog measures no-output FROM this (re)create, so a fresh decoder gets its full grace
  // window before it could be declared stalled (and the just-fed encoded queue was reset to empty here).
  lastWcOutputAtMs = performance.now();
  lastWcRecreateAtMs = lastWcOutputAtMs;
}

/** A hardware decode error. Before the first decoded frame ⇒ the tier choice was wrong (isConfig
 *  Supported lied / HW rejected) ⇒ fall back to software for a CLEAN picture (never a dead screen).
 *  After frames have decoded ⇒ a transient: rebuild + await the next keyframe (mirrors the reference
 *  player's self-heal). Runs from the decoder's async error callback — safe: JS callbacks don't interleave the
 *  pump loop's synchronous spans, and the pump re-reads `useWc`/`vdecWc` each iteration. */
function handleWcError(msg: string): void {
  log('webcodecs decode error: ' + msg);
  if (!useWc) return; // already switched away
  if (!wcHealthy) {
    // Pre-first-frame: isConfigSupported lied / the HW rejected the stream → fall back to software for a
    // CLEAN picture (never a dead screen). This is a TIER choice, not the error controller's ladder — a
    // recoverable codec-tier downgrade, distinct from a fatal codec-unsupported (no tier works at all).
    fallbackToSoftware();
    return;
  }
  // After healthy frames → a transient glitch. Route the ACTION through the ONE error controller: a
  // `decode-glitch` classifies to `recreateDecoder` — rebuild + await the next IDR, keep playing (no
  // teardown, no reconnect storm). Same self-heal as before, but the DECISION now lives in classifyError.
  const action = classifyError('decode-glitch', classifyCtx());
  if (action.kind === 'recreateDecoder' && wcCodec) {
    createWcDecoder(wcCodec); // rebuild; awaitKeyframe restarts on the next IDR
  } else if (action.kind === 'fatal') {
    failFatal(action.failure ?? 'decode', -1, 'webcodecs: ' + (action.reason));
  }
}

/** The classification context for the CURRENT pipeline (live + ever-connected). The error controller
 *  reads it to gate transient→reconnect vs initial-connect→fatal; lifted into one accessor so every
 *  detection site classifies against the SAME context. */
function classifyCtx(everConnected = true): ClassifyContext {
  return { hasLiveEdge: caps.hasLiveEdge, everConnected };
}

/** Post the resolved SourceCapabilities to main ONCE per load (idempotent — onConnect fires on every
 *  reconnect, but the headers don't change). Main reads it for the seek()/seekbar/catch-up forks. */
function announceCaps(): void {
  if (capsPosted) return;
  capsPosted = true;
  post({ type: 'caps', caps });
}

/** Switch the CURRENT video codec from the hardware tier to ffmpeg software, in place (the demux
 *  keeps flowing; software syncs from the next packets). Used when WebCodecs fails before producing
 *  a frame. No decode gap beyond one keyframe interval. */
function fallbackToSoftware(): void {
  log('webcodecs unavailable for this stream → software tier');
  freeWc();
  wcDescription = null; // leaving the WC tier → drop the VOD config-record description
  if (F && curVcodec > 0) {
    if (vdec) F.vdecFree(vdec);
    // VOD: build FROM the demux — find_stream_info already resolved the extradata, and a VOD MP4/MKV's
    // LENGTH-PREFIXED NALs are undecodable by a bare decoder (no nal_length_size / param sets). LIVE: built
    // bare here; the pump upgrades it to _from_demux (with the in-band param sets) once they land.
    vdec = (!caps.declaredLive && demux) ? (F.vdecNewFromDemux(demux, threads) || F.vdecNew(curVcodec, threads))
                                         : F.vdecNew(curVcodec, threads);
    if (vdec) { F.vdecSetDeint(vdec, deintMode); applySkips(vdec); } // re-apply the skips after the WC→SW fallback recreate
    swHasExtradata = false; heldVideoPkts = 0; // re-evaluate against the demux's resolved extradata
  }
  useWc = false;
  tier = 'software';
  awaitKeyframe = false; // ffmpeg withholds output until its own IDR; no explicit gate needed
  announce();
}

/** Tell main the active tier + codecs + dims (drives statisticsInfo.tier + mediaInfo). */
function announce(): void {
  // DISPLAY aspect (anamorphic): SAR from the current frame so the facade computes DAR = width·SAR/height.
  post({ type: 'ready', info: { videoCodec: curVcodec, audioCodec: curAcodec, width: annW, height: annH,
    sarNum: (F && vdec) ? F.vdecSarNum(vdec) : 1, sarDen: (F && vdec) ? F.vdecSarDen(vdec) : 1, tier } });
}

/** Wrap one demuxed video AU as an EncodedVideoChunk and feed the hardware decoder. `ptsUs<0` (no
 *  PTS) is estimated from the last PTS + one frame interval so the chunk timestamp — hence the present
 *  clock — stays a monotonic media timeline (NOPTS handling).
 *
 *  NO feed-side backpressure gate (matches the reference player's au handler, which has
 *  none): the earlier `decodeQueueSize > WC_MAX_QUEUE` shed-a-GOP was INVENTED alongside the (now
 *  ported-out) burst-dump present — the same mistake. WebCodecs is bounded by (a) the demux ingest
 *  watermark (the adaptive liveLowWater+liveReadAhead), which paces feed to ~realtime for a live stream, and (b) the
 *  PRESENT-side WC ring drop-oldest (main's platform-aware wcRingCap). HW decode ≥ realtime keeps the encoded-input queue small. */
function feedWc(au: Uint8Array, isKey: boolean, ptsUs: number): void {
  if (!vdecWc || vdecWc.state !== 'configured') return;
  let ts: number;
  if (ptsUs >= 0) {
    // Real demux PTS → track the observed inter-frame interval (the actual cadence). The reference
    // player uses the container-probe fps, but the ferrite engine exposes no fps accessor, so derive it from
    // consecutive real PTS (U4) — VFR-correct and needs no engine relink. These PTS are in DECODE
    // order, so with B-frames a delta can be negative or span a reorder gap; the `d > 0 && d < 1_000_000`
    // guard drops the negatives and seam/discontinuity jumps. A reorder-inflated positive delta can
    // bias the interval high, but it only feeds the NOPTS estimate below — which is rare (mpegts video
    // always carries a PTS) and bounded — so the bias is immaterial.
    if (lastRealWcPtsUs >= 0) {
      const d = ptsUs - lastRealWcPtsUs;
      if (d > 0 && d < 1_000_000) wcFrameIntervalUs = d;
    }
    lastRealWcPtsUs = ptsUs;
    ts = ptsUs;
  } else {
    // Mid-stream NOPTS (rare; mpegts video always carries a PTS) → last fed PTS + observed interval.
    ts = lastWcPtsUs + wcFrameIntervalUs;
  }
  lastWcPtsUs = ts;
  try {
    vdecWc.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: ts, data: au }));
  } catch (err) {
    handleWcError('' + err);
  }
}

/**
 * Decide the video tier for a (new) codec and (re)create the right decoder. Called when the demuxer
 * first reveals a video codec AND on a mid-stream codec change (cross-codec failover seam). `au` is
 * the current keyframe access unit (for the exact H.264 SPS codec string + interlace flag).
 */
async function setupVideoDecoder(vc: number, au: Uint8Array): Promise<void> {
  if (!F) return;
  const prevVcodec = curVcodec;
  curVcodec = vc;
  // A fresh codec must resolve its OWN param sets. On a mid-stream codec change, drop the previous
  // codec's captured extradata so the live demux re-extracts (else vdecNewFromDemux would copy stale
  // extradata onto the new decoder). The SW decoder is built bare here and upgraded to _from_demux in the
  // pump the moment the param sets are resolved.
  swHasExtradata = false; heldVideoPkts = 0;
  if (prevVcodec > 0 && prevVcodec !== vc) F.demuxResetVExtradata(demux);
  const info = videoCodecInfo(vc, F.demuxVProfile(demux), F.demuxVLevel(demux), au);
  // Tier gate: the sync eligibility (prefer + HW + mapped codec + PROGRESSIVE — interlace is read per-stream
  // from this AU's SPS, never cached) AND the cached capability lookup (no async probe on this path).
  let wantWc = webCodecsEligible(preferWebCodecs, hasVideoDecoder(), info);
  if (wantWc) wantWc = wcCapabilityCached(info.codec, wcCapCache);

  if (wantWc) {
    if (vdec) { F.vdecFree(vdec); vdec = 0; }
    useWc = true;
    tier = 'webcodecs';
    wcDescription = null; // LIVE mpegts is Annex-B with in-band SPS — no config-record description (VOD sets it)
    createWcDecoder(info.codec); // sets awaitKeyframe; may itself fall back on a configure throw
    if (useWc) log('video codec ' + vc + " → WebCodecs '" + info.codec + "'");
  } else {
    freeWc();
    if (vdec) F.vdecFree(vdec);
    vdec = F.vdecNew(vc, threads);
    if (vdec) { F.vdecSetDeint(vdec, deintMode); applySkips(vdec); } // re-apply the skips on a (re)created software decoder
    useWc = false;
    tier = 'software';
    awaitKeyframe = false;
    log('video codec ' + vc + ' → software' + (info.interlaced ? ' (interlaced)' : ''));
  }
  announce();
}

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      threads = msg.threads;
      wasmBaseUrl = msg.wasmBaseUrl;
      // Single-source the software in-flight bound from main's RING_CAP — never a hardcoded constant
      // here (that drifted: 48 vs RING_CAP=12). This caps both the run() seed and every credit grant.
      creditCap = msg.ringCap;
      // (The WC present-ring cap is NOT carried on `init`: the decode worker's WC feed gate is
      // decodeQueueSize-only (deadlock fix); only the PRESENT worker needs it, via present-init.)
      log('credit cap = ' + creditCap + ' (= main RING_CAP)'); // breadcrumb: confirms the in-flight bound
      // Wire the decode↔present channel: released heap-slot tokens arrive over it (each = one freed
      // ring slot → a decode credit). Frames flow the other way (postFrame). Set once per session.
      presentPort = msg.presentPort;
      presentPort.onmessage = (pe: MessageEvent<PresentToDecode>): void => {
        const d = pe.data;
        if (d.type === 'release') {
          // The present worker retired these frames → unref each held AVFrame (the decoder may reuse
          // its buffer) and replenish one decode credit per frame.
          for (const t of d.tokens) releaseFrame(t);
          // (a) LIVE-WC: the same batch reports how many WebCodecs VideoFrames it retired (drawn/dropped/
          // closed) → decrement the present-ring in-flight TELEMETRY count. The feed gate no longer reads
          // this (the deadlock source); keeping it accurate makes the buildlog diagnostic honest.
          if (d.vf) wcInFlight = Math.max(0, wcInFlight - d.vf);
        } else if (d.type === 'autoSkips') {
          // The present worker's graceful-degradation trigger latched (skipNonref/skipLoop true)
          // or re-armed on reset (false). Update the AUTO skip state + apply LIVE to the current software
          // decoder (mid-stream, no re-init). OR-folded with the manual levers in applySkips (manual wins).
          autoSkipNonref = d.skipNonref;
          autoSkipLoop = d.skipLoop;
          if (!useWc && vdec) applySkips(vdec);
        }
      };
      // Adaptive low-water config (resolved from FerriteConfig stashInitialSize/stashMaxSize/stashAdaptive).
      lwFloor = msg.lowWaterFloor;
      lwCeiling = msg.lowWaterCeiling;
      lwAdaptive = msg.lowWaterAdaptive;
      liveLowWater = lwCeiling;
      liveReadAhead = lwCeiling * 2;
      isIOS = msg.isIOS;
      isAppleWebKit = msg.isAppleWebKit;
      log('platform: ' + (isIOS ? 'iOS' : isAppleWebKit ? 'appleWebKit' : 'other')); // triage breadcrumb
      log('loading engine…');
      // Pre-probe the WC capability families HERE (independent of the engine) so
      // the per-play tier path is a pure cache lookup, never an async isConfigSupported. Runs concurrently
      // with the (slower) engine load below; awaited before `ready` resolves → before any `load` reads it.
      const wcProbe = probeWcCapabilities();
      try {
        F = await loadFerrite(wasmBaseUrl, threads + 2); // ferritePool = decode-threads + 2 (the documented design: headroom for audio/demux/coordinator over the frame-decode threads). `threads` is the host-adaptive count resolved on main (clamp(hardwareConcurrency−2,2,8), ≤8 → pool ≤10), forwarded via init. The earlier `threads` (no +2) was a wiring bug.
        // Hand the present worker the engine's live shared heap so it can upload decoded planes
        // with no copy. Posted BEFORE any `frame` (the engine just loaded; the pipeline hasn't started).
        postFrame({ type: 'engineMemory', memory: F.memory });
        await wcProbe; // cache filled before `ready` resolves (the load above dominates → already done)
        log('engine ready; wc cap: ' + wcCapSummary());
        resolveReady(true);
      } catch (err) {
        failFatal('engine-load', -1, 'engine load failed: ' + err);
        resolveReady(false);
      }
      break;
    case 'load': {
      if (closing) return;               // destroyed/closing → never start a new pipeline
      // Assign generation SYNCHRONOUSLY (before any await) so a load racing unload/another load
      // can't resurrect a stale gen after `await ready`. Re-check after the await.
      const myGen = msg.gen;
      gen = msg.gen;
      // Intent-only derivation at the open boundary (the transport/decoder-init forks fire before any
      // response); REFINED from the first response's headers in ingest.onConnect / runVod (HttpSource).
      caps = deriveCapabilities(msg.isLive);
      capsPosted = false;
      preferWebCodecs = msg.preferWebCodecs;
      const loadUrl = msg.url;
      if (!(await ready)) return;        // engine dead — engine-load error already posted
      if (closing || myGen !== gen) return; // destroyed, or superseded by a newer load/unload
      void run(myGen, loadUrl);
      break;
    }
    case 'setPaused':
      if (msg.paused) {
        paused = true;
      } else if (paused) {
        paused = false;
        // LIVE pause DISCARDS packets (tracks the live edge) → resume MUST restart on a fresh IDR. VOD pause
        // HOLDS position (the decoder keeps its references), so resume continues seamlessly — and arming the
        // keyframe gate there would (now that VOD-WC honours awaitKeyframe via wcKeyframeGate) drop every AU
        // until the next GOP = a visible resume freeze. So arm it on LIVE only; VOD keeps its current state
        // (false in steady play; still-true if paused mid-post-seek-IDR-wait → correctly preserved).
        if (caps.hasLiveEdge) awaitKeyframe = true;
      }
      break;
    case 'seek':
      pendingSeekMs = msg.targetMs; // VOD only; coalesced (last wins). Live never sends this.
      break;
    case 'credit':
      credits = Math.min(credits + msg.n, creditCap);
      break;
    case 'setSkips':
      // Levers 2 & 3: remember the choice + apply it LIVE to the current software decoder
      // (read per-frame → honoured mid-stream with no re-init). The WC tier has no ctx skip fields; the
      // toggle takes effect there only if/when the codec falls back to software (applySkips on create).
      leverSkipNonref = msg.skipNonref;
      leverSkipLoop = msg.skipLoop;
      if (!useWc && vdec) applySkips(vdec);
      break;
    case 'setDeint':
      // Remember the mode + apply it LIVE to the current software decoder (the WC/HW tier
      // deinterlaces in hardware — no avfilter graph). Re-applied on every SW (re)create below.
      deintMode = msg.mode;
      if (F && !useWc && vdec) F.vdecSetDeint(vdec, deintMode);
      break;
    case 'unload':
      // Tear down the current pipeline but keep the engine. `gen` already moved on the next
      // load; bumping past `msg.gen` here cancels in-flight loops even with no follow-up load.
      gen = msg.gen;
      stopPipeline();
      break;
    case 'destroy':
      void handleDestroy();
      break;
  }
};

async function run(myGen: number, url: string): Promise<void> {
  if (closing || !F) return; // a 'destroy' that landed during the load's `await ready` wins
  // Fresh per-load state (so an unload→load reuse starts clean, not with stale flags).
  stop = false;
  // Seed the full ring budget HERE, not via a separate 'credit' post from load(): that post
  // can be processed during `await ready` (before this run() body), and this reset would then
  // wipe it → pump deadlocks at `credits<=0` with a full backpressured ring (black screen).
  // Seeding in run() is ordering-independent. Recycle replenishes as frames evict. The seed is the
  // creditCap (= main's RING_CAP, set on init which always precedes load) — never the old hardcoded 48.
  credits = creditCap;
  postedCount = 0;
  feedBytes = 0;
  feedDone = false;
  paused = false;
  awaitKeyframe = false;
  lastDeintFailed = false;
  pendingSeekMs = -1;
  // Reset per-load video-tier state (the prior load may have run a different tier/codec).
  tier = 'software';
  useWc = false;
  // LIVE-WC: fresh stream → reset the present-ring in-flight + stall-recovery state (the prior load's WC
  // decoder/ring is gone; the present worker is reset() by main on (re)load so no stale `vf` ack survives).
  wcInFlight = 0;
  wcGateParked = false;
  wcStallRecreates = 0;
  lastWcOutputAtMs = 0;
  lastWcRecreateAtMs = 0;
  wcDescription = null; // fresh stream → re-derived by the VOD setup (null for live/Annex-B)
  lastWcPtsUs = 0;
  lastRealWcPtsUs = -1;
  wcFrameIntervalUs = 1_000_000 / 50; // re-seed; re-derived from the first real PTS pair
  annW = 0; annH = 0;
  curVcodec = 0; curAcodec = 0;
  swHasExtradata = false; heldVideoPkts = 0; // fresh stream resolves its own param sets
  // Reset the adaptive low-water to the warmup ceiling for the fresh stream (the prior load's
  // PES sizes don't carry over). It relaxes again once this stream's first keyframe lands.
  peakVideoPes = 0;
  warmedUp = false;
  liveLowWater = lwCeiling;
  liveReadAhead = lwCeiling * 2;
  freeDecoders(); // release any pipeline orphaned by a prior errored/superseded run (no leak on reload)
  F.vdecReleaseAll(); // reclaim any held frames still in transit from the prior load (main has
                      // already reset the present worker for this `gen`, so none are being uploaded).
  frameDrops = 0;
  heldFrames = 0; // fresh load: the held table was just flushed (vdecReleaseAll)
  // Fresh stream → restart the TRUE content-period estimator (the prior stream's frame rate doesn't carry
  // over). The MANUAL skip lever state persists (a session control) and is re-applied on each decoder
  // create; the AUTO skip state does NOT — a fresh timeline is a fresh degrade decision, so
  // clear it here so a healthy new stream never inherits prior degradation (the synthetic-stays-tier-1 +
  // leak-gate "engine skips reset on reload" invariants). The present worker re-detects + re-fans if needed.
  contentPeriodUs = 0; vidPktPts.length = 0;
  autoSkipNonref = false; autoSkipLoop = false;
  // Reset the recovery counters + the adaptive-silence cadence stats for the fresh stream.
  reconnectsTotal = 0; stallsTotal = 0;
  lastByteAtMs = 0; silenceTripped = false; cadMean = 0; cadM2 = 0; cadN = 0;
  streaming = false; // FIX 2: no attempt is reading yet (set true on the first onConnect)
  if (!caps.declaredLive) {
    // VOD: range-streamed file playback (no ingest loop / demux ring — the engine's range AVIO pulls
    // bytes on demand). statsLoop runs alongside for decode-fps; the seek/decode loop owns the rest.
    // VOD-WC: the decoder-stall watchdog is live here too (a VOD HW decoder can still wedge → recreate +
    // await keyframe, NOT a reconnect — VOD has none). It self-gates on useWc/vdecWc so it is inert on the
    // software-VOD tier. NO silence watchdog (VOD is a finite file, never an upstream-silence reopen).
    void wcStallWatchdog(myGen);
    void statsLoop(myGen);
    await runVod(myGen, url);
    return;
  }
  demux = F.demuxNewStreaming();
  F.demuxSetMaxBuffered(demux, MAX_BUFFERED);
  log('connecting…');
  void ingest(myGen, url);
  void silenceWatchdog(myGen); // adaptive upstream-silence reopen (live-only)
  void wcStallWatchdog(myGen); // LIVE-WC: HW decoder-stall self-heal (recreate, NOT a source reconnect)
  void statsLoop(myGen);
  await pump(myGen);
}

// --- VOD: range-streamed file playback ---------------------------------------------
//
// The fix for the whole-file-prefetch black screen. Native ffmpeg/VLC stream+seek a remote container
// via libavformat's http protocol (Range on seek); WASM ffmpeg can't (no sockets), so the engine's
// range AVIO pulls bytes ON DEMAND through a JS hook. Under Asyncify that hook is ASYNC: the engine's
// ferrite_js_range_read (EM_ASYNC_JS) AWAITS Module.__ferriteRangeReadAsync, which HttpSource backs with
// ONE long-lived forward fetch (src/worker/http-source.ts) — VLC parity, NOT the rejected sync-XHR-per-
// window churn. The demux SUSPENDS during a read (the pthread decode pool keeps running); runVod/doVodSeek
// await the suspending demux wrappers. Playback starts after the HEADER parse (not a full download) and
// seeking reopens a Range fetch instead of buffering to the seek point. No demux ring / no low-water
// (those are for the incrementally-fed live path); decode is paced by the same software credit
// backpressure as live. SOFTWARE tier only — VOD-WebCodecs parity is a separate follow-up.

// The sync-XHR-per-window range reader (makeRangeReader) + the standalone probeSize round-trip are GONE,
// replaced by HttpSource (one long-lived forward fetch, src/worker/http-source.ts) wired through the ASYNC
// engine hook in runVod. HttpSource.open() learns the size from the first response's Content-Range, so no
// separate probe is needed.

/** Drain the SOFTWARE video decoder, posting each frame (re-announcing on a resolution change). Each
 *  posted frame consumes a decode credit (replenished by the present worker's release). Mirrors the live
 *  pump's software-video block (kept separate so the validated live path is untouched). Zero-copy:
 *  hold the frame + post its plane offsets — no de-stride, no downshift, no JS copy. VOD hard-blocks on
 *  credits (runVod), so in-flight ≤ creditCap (= RING_CAP) < HELD_CAP and a hold always succeeds (drop is defensive). */
function drainVdecFrames(): void {
  if (!F || !vdec) return;
  while (F.vdecStep(vdec) === 1) {
    const w = F.vdecW(vdec), h = F.vdecH(vdec), cw = F.vdecCw(vdec), ch = F.vdecCh(vdec);
    if (w <= 0 || h <= 0 || cw <= 0 || ch <= 0) continue;
    if (w !== annW || h !== annH) { annW = w; annH = h; announce(); }
    holdAndPostFrame(w, h, cw, ch);
  }
}

/** Drain the audio decoder, posting each PCM chunk. Identical to the live pump's audio block. */
function drainAdecFrames(): void {
  if (!F || !adec) return;
  while (F.audioStep(adec) === 1) {
    const chn = F.audioChannels(adec);
    const samples = F.audioSamples(adec);
    const rate = F.audioRate(adec);
    const pcm = F.audioCopy(F.audioInterleavedPtr(adec), samples * chn);
    post({ type: 'audio', sampleRate: rate, channels: chn, ptsUs: Number(F.audioPtsUs(adec)), pcm }, [pcm.buffer]);
  }
}

/** av_seek_frame to tgtUs (backward → keyframe at/before) + flush BOTH decoders (a fresh decoder is the
 *  cleanest flush — the demux and decoders are separate objects). Main drops its stale ring + re-anchors
 *  the present clock on receiving the seek, so the new frames present from the seek target. */
async function doVodSeek(tgtUs: number): Promise<void> {
  if (!F || !demux) return;
  const r = await F.demuxSeekUs(demux, tgtUs, 1); // SUSPENDS (reads index/probes); double µs, no BigInt
  if (!F || !demux) return; // teardown could have freed the demux during the suspend
  if (r < 0) { log('VOD seek rc=' + r + ' (target ' + (tgtUs / 1e6).toFixed(1) + 's)'); return; }
  // Recreate (= cleanest flush) the video decoder. A re-alloc returning 0 (e.g. OOM under heap pressure)
  // would silently strand the stream decoder-less → surface it fatally rather than play on degraded.
  if (useWc) {
    // VOD-WC SEEK: flush by recreating the VideoDecoder (reuses wcCodec + wcDescription) — createWcDecoder
    // ARMS awaitKeyframe, so no delta-before-keyframe slips through after the seek. av_seek_frame(BACKWARD)
    // landed on the keyframe at/before the target, so the next demuxed AU is an IDR → the keyframe gate
    // feeds it → playback lands ON a keyframe. The present clock is re-anchored MAIN-side (resetPresent on
    // seek). Audio stays software → recreate adec below. No source/reconnect machinery (VOD is a finite file).
    const codec = wcCodec;
    if (vdecWc && codec) createWcDecoder(codec); // freeWc + reconfigure (same description); re-arms the stall timer
  } else if (vdec) {
    F.vdecFree(vdec); vdec = F.vdecNewFromDemux(demux, threads);
    if (!vdec) { failFatal('decode', -1, 'VOD seek: video decoder re-alloc failed'); return; }
    F.vdecSetDeint(vdec, deintMode); applySkips(vdec); // re-apply the skips after the VOD-seek decoder flush/recreate
  }
  if (adec) {
    F.audioFree(adec); adec = F.audioNewFromDemux(demux);
    if (!adec) { failFatal('decode', -1, 'VOD seek: audio decoder re-alloc failed'); return; }
  }
}

async function runVod(myGen: number, url: string): Promise<void> {
  if (!F) return;
  // 1. Open ONE long-lived forward range fetch (HttpSource). open() learns the total size from the first
  //    206 Content-Range (or a 200 Content-Length in the degraded fallback) — no separate probe round-trip.
  // iOS-tight VOD window keyed off the resolved in-flight cap (creditCap = main's RING_CAP): iOS resolves
  // RING_CAP_IOS=6, desktop RING_CAP=12 (?ring overrides). ≤8 ⇒ iOS — byte-equivalent to the former
  // swRingCap≤12 test (swRingCap was creditCap + RING_HEADROOM(4), so swRingCap≤12 ⟺ creditCap≤8).
  const windowBytes = creditCap <= 8 ? VOD_WINDOW_BYTES_IOS : VOD_WINDOW_BYTES_DESKTOP;
  // mySource/myDemux are CAPTURED so this run's `finally` cleans up exactly its OWN source + demux even if a
  // reload already installed a newer pair into the module-scope mirrors. CRITICAL ownership rule for the
  // Asyncify teardown: the VOD demux may be mid-suspend (awaiting a range read) at teardown; freeing it then
  // would resume the rewind into freed memory. So teardown (stopPipeline/freeDecoders/reload) only
  // mySource.abort()s — that resolves the pending read → the suspend unwinds → THIS finally frees the demux.
  // E-6: VOD connect-timeout = the live const (one source of truth), so VOD mirrors live's 8 s header-await
  // guard. The read-stall timeout keeps HttpSource's own default (DEFAULT_READ_STALL_MS).
  const mySource = new HttpSource(url, { windowBytes, log, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  vodSource = mySource;
  let myDemux = 0;
  try {
    let total = 0;
    try { total = await mySource.open(); }
    catch (err) { if (alive(myGen)) failFatal('network', -1, 'VOD open failed: ' + err); return; }
    if (!alive(myGen)) return;                                  // teardown during the open suspend
    if (total <= 0) { failFatal('network', -1, 'VOD: server reported no size (Range unsupported?)'); return; }
    // REFINE the descriptor from the first response (HttpSource already parsed it — no extra round-trip):
    // a 206 with a Content-Range total ⇒ seekable + bounded (the known VOD path); a server that ignored
    // Range (degraded 200) ⇒ seekable=false (the edge case — seekbar hidden on main, forward play still
    // works). declaredLive stays false ⇒ hasLiveEdge=false. Post once so main's seek()/seekbar fork reads it.
    caps = deriveCapabilities(caps.declaredLive, { acceptRanges: !mySource.degraded, hasContentLength: total > 0 });
    announceCaps();

    // 2. Install the ASYNC range hook (the engine's EM_ASYNC_JS bridge awaits it; it follows the module
    //    vodSource so a reload re-points it). demuxNewRange SUSPENDS through find_stream_info (header parse
    //    only — NOT a whole-file download).
    F.setRangeReader((pos, len) => (vodSource ? vodSource.read(pos, len) : Promise.resolve(null)));
    myDemux = await F.demuxNewRange(1, total);
    demux = myDemux;
    if (!alive(myGen)) return;                                  // teardown during the find_stream_info suspend
    if (!myDemux) { failFatal('demux', -1, 'could not open VOD container (Range/format?)'); return; }

    // 3. Build decoders FROM the demuxer streams (length-prefixed MP4/MKV NALs + raw AAC need the
    //    extradata that _from_demux / the WC `description` carries). Audio is ALWAYS software/WebAudio.
    const vc = F.demuxVcodec(myDemux);
    const ac = F.demuxAcodec(myDemux);
    if (ac > 0) { adec = F.audioNewFromDemux(myDemux); if (adec) curAcodec = ac; }
    // VOD VIDEO TIER SELECTION (VOD-WC parity) — the SAME gate live uses (webCodecsEligible + the cached WC
    // capability), but VOD reads the demuxer's RESOLVED profile/level + the container extradata (avcC/hvcC)
    // rather than the in-band SPS, and configures the VideoDecoder with that extradata as `description` (the
    // length-prefixed path). HW where supported (H.264 on the test client); software fallback otherwise — a
    // no-HW-HEVC box → cache miss → vdecNewFromDemux, and a length-prefixed config the bare-codec cache
    // over-accepts is caught by createWcDecoder's configure() throw → fallbackToSoftware (→ vdecNewFromDemux).
    if (vc > 0) {
      curVcodec = vc;
      const ed = F.demuxVExtradata(myDemux).slice(); // detached avcC/hvcC (or Annex-B for a .ts VOD; empty if none)
      const info = vodVideoConfig(vc, F.demuxVProfile(myDemux), F.demuxVLevel(myDemux), ed);
      let wantWc = webCodecsEligible(preferWebCodecs, hasVideoDecoder(), info);
      if (wantWc) wantWc = wcCapabilityCached(info.codec, wcCapCache); // cached lookup, no async probe here
      if (wantWc) {
        useWc = true;
        tier = 'webcodecs';
        wcDescription = info.description; // avcC/hvcC for MP4/MKV; null for a .ts (Annex-B) VOD
        createWcDecoder(info.codec);      // arms awaitKeyframe; may itself fall back on a configure throw
        if (useWc) log('VOD video codec ' + vc + " → WebCodecs '" + info.codec + "'" + (info.description ? ' (config-record desc)' : ''));
      } else {
        vdec = F.vdecNewFromDemux(myDemux, threads);
        if (vdec) { F.vdecSetDeint(vdec, deintMode); applySkips(vdec); }
        useWc = false;
        tier = 'software';
        log('VOD video codec ' + vc + ' → software');
      }
    } else {
      tier = 'software';
      useWc = false;
    }
    if (!vdec && !vdecWc && !adec) { failFatal('decode', -1, 'VOD: no decodable stream'); return; }
    // announce() (the `ready` msg) MUST precede the `duration` msg: main populates _workerInfo from
    // `ready`, and only then can the duration handler's MEDIA_INFO emit carry a non-null payload. Posting
    // duration first fired MEDIA_INFO with mediaInfo===null → a consumer reading .videoCodec crashed (bug #1).
    announce();

    // 4. Duration → main (drives the scrub bar). 0 = unknown (rare; scrub stays hidden). After announce
    //    so the duration handler's MEDIA_INFO emit sees the populated codec/dims.
    const durUs = Number(F.demuxDurationUs(myDemux));
    post({ type: 'duration', durationMs: durUs > 0 ? Math.round(durUs / 1000) : 0 });
    log('VOD streaming (' + (durUs > 0 ? (durUs / 1e6).toFixed(0) + 's' : 'unknown dur') + ', ' + (total / 1048576).toFixed(1) + ' MiB)');

    // 5. Decode loop. Finite EOF PARKS (kept alive so a seek can replay); pause HOLDS position.
    let ended = false;
    while (alive(myGen)) {
      // A seek request takes priority: av_seek_frame + decoder flush, then resume decoding from there.
      if (pendingSeekMs >= 0) {
        const tgtUs = Math.max(0, Math.round(pendingSeekMs * 1000));
        pendingSeekMs = -1;
        await doVodSeek(tgtUs); // SUSPENDS (av_seek_frame reads the index through the range AVIO)
        if (!alive(myGen)) break;
        ended = false;
        continue;
      }
      if (paused || ended) { await sleep(40); continue; } // park (seek/resume re-activates the loop)
      // SOFTWARE backpressure: don't decode past what main can present (slot release replenishes credits).
      // WC-VOD doesn't use credits (the present ring drop-oldest + the decodeQueueSize feed gate bound it),
      // so this is a no-op there (`!useWc` makes that explicit — WC never decrements credits anyway).
      while (alive(myGen) && !useWc && credits <= 0 && !paused && pendingSeekMs < 0) await sleep(4);
      if (!alive(myGen)) break;
      if (paused || pendingSeekMs >= 0) continue;

      const step = await F.demuxStepVod(myDemux); // SUSPENDS: pulls bytes via the async range AVIO (HttpSource)
      if (!alive(myGen)) break; // teardown during the suspend unwound here (stop ⇒ !alive) — the finally frees demux
      feedBytes = mySource.getStats().bytesFetched; // mirror cumulative network bytes → statsLoop ingest KB/s
      if (step === 0) {                // clean EOF → drain the decoders + park
        // VOD-WC: flush the VideoDecoder's reorder buffer so the final B-frames emit (the analog of the
        // software null-push drain). Fire-and-forget — the frames arrive via the output cb; the decoder is
        // healthy at a clean EOF so flush() won't hang, and a stale flush after a teardown is harmless
        // (output() drops frames once stop/closing). Guarded by `ended` so it fires once.
        if (vdec) { F.vdecPush(vdec, 0, 0, 0n); drainVdecFrames(); }
        else if (useWc && vdecWc && vdecWc.state === 'configured' && !ended) { vdecWc.flush().catch(() => { /* aborted/teardown */ }); }
        if (adec) { F.audioPush(adec, 0, 0, 0n); drainAdecFrames(); }
        if (!ended) { ended = true; post({ type: 'ended' }); }
        continue;
      }
      if (step < 0) {
        // A negative step is a hard AVIO/demux error. Distinguish the read-stall exhaustion (the origin
        // accepted the Range then went silent; HttpSource bounded-resumed, then gave up → read()→EIO) from a
        // genuine container/decode fault: route the former through the ONE error controller as upstream
        // silence (a `network` fatal, mirroring the LIVE silence watchdog) so the failure is honest. VOD is
        // finite → the controller resolves silence to fatal (no reconnect), which is the bounded, observable
        // end-state the spec wants — NOT an infinite hang.
        if (mySource.stalledOut) {
          const act = classifyError('upstream-silence', classifyCtx()); // VOD ⇒ hasLiveEdge=false ⇒ fatal (no reconnect)
          failFatal(act.failure ?? 'network', step, 'VOD upstream silent (read stalled, bounded resumes exhausted) → ' + act.reason);
        } else {
          failFatal('decode', step, 'VOD demux step error');
        }
        break;
      }
      if (step !== 1) { await sleep(4); continue; } // range mode never returns EAGAIN (the read blocks); defensive

      const stream = F.demuxPktStream(myDemux);
      const ptr = F.demuxPktDataPtr(myDemux);
      const size = F.demuxPktSize(myDemux);
      const pts = F.demuxPktPtsUs(myDemux);
      if (stream === 0) {
        feedVidPktPeriod(pts >= 0n ? Number(pts) : -1); // VOD: TRUE content period (non-ref-skip-independent) → present cap
        if (useWc && vdecWc) {
          // VOD-WC: route the demuxed AU into the hardware VideoDecoder via the SAME guards as live —
          // reused verbatim from wc-guard.ts (the helpers are VOD-safe; the decodeQueueSize-only feed gate
          // has NO live-edge assumption). Copy the AU up front (robust contract — the demux is NOT stepped
          // during the wait, so ptr stays valid, but capturing the bytes now is the rule).
          const au = F.auCopy(ptr, size);
          const isKey = F.demuxPktIsKey(myDemux) === 1;
          // (a) FEED BACKPRESSURE — WAIT (never shed) while the decoder's OWN encoded queue is at its
          // ceiling, so the VideoDecoder can never over-fill (the decode-q→314 stall). Gating SOLELY on the
          // self-draining decodeQueueSize cannot deadlock. Break on teardown / a pending
          // seek (don't delay it) / pause. The park watchdog is the invisible-latch belt (must stay dead).
          { const _w0 = performance.now(); wcGateParked = true;
            while (alive(myGen) && !paused && pendingSeekMs < 0 && useWc && vdecWc &&
                   wcShouldWaitFeed(vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX)) {
              if (wcParkWatchdog(performance.now() - _w0, vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX, WC_PARK_WATCHDOG_MS)) {
                wcParkWatchdogs++;
                log(`[wc-vod] feed-park watchdog: parked ${(performance.now() - _w0) | 0}ms with q=${vdecWc.decodeQueueSize}<${WC_DECODE_QUEUE_MAX} → force re-evaluate (a gate latched on a non-self-releasing signal)`);
                break;
              }
              await sleep(4);
            }
            wcGateParked = false; }
          if (!alive(myGen)) break;
          // (b) AWAIT-KEYFRAME — never feed a delta to a fresh / flushed / post-seek decoder. Re-evaluated
          // AFTER the wait against the CURRENT decoder so a mid-wait stall-recreate can't slip a delta through.
          if (!paused && pendingSeekMs < 0 && useWc && vdecWc) {
            const g = wcKeyframeGate(awaitKeyframe, isKey);
            awaitKeyframe = g.awaitingKeyframe;
            if (g.feed) feedWc(au, isKey, pts >= 0n ? Number(pts) : -1);
          }
        } else if (vdec) {
          F.vdecPush(vdec, ptr, size, pts); // no keyframe gate: the decoder withholds output until its IDR
          const df = F.vdecDeintFailed(vdec) === 1;
          if (df !== lastDeintFailed) { lastDeintFailed = df; post({ type: 'deintFailed', failed: df }); }
          drainVdecFrames();
        }
      } else if (stream === 1 && adec) {
        F.audioPush(adec, ptr, size, pts);
        drainAdecFrames();
      }
    }
  } finally {
    // Own the VOD source + demux teardown. By here the Asyncify suspend (if any) has unwound (the loop's
    // `await` resolved before we reach the finally), so freeing the demux is safe. Guard the module mirrors
    // so a newer reload's source/demux is never touched (free only OUR captured pair).
    mySource.abort();
    if (vodSource === mySource) vodSource = null;
    if (F && myDemux) { F.demuxFree(myDemux); if (demux === myDemux) demux = 0; }
    if (vodSource === null && F) F.setRangeReader(null); // hook now resolves null anyway; drop it on full teardown
  }
}

// --- ingest: stream network bytes into the demux ring, with LIVE reconnect ----------------------
//
// Reconnect (mpegts.js io-controller "reconnect from last byte" + hls.js FragmentLoadPolicy
// backoff). For a LIVE stream, the fetch body ending is NORMAL: live IPTV servers/CDNs (and an
// upstream server) serve a bounded HTTP response and expect the client to re-request — so an ended body that
// HAD delivered bytes is a routine connection boundary, NOT an error. We re-fetch and RESUME feeding
// the SAME demux/decoders (never freed across the gap), so the resume is handled downstream as a
// normal failover SEAM (the live edge moved → a PTS discontinuity the present-side detector re-anchors).
//
// Two paths:
//  - CLEAN end that delivered bytes → reconnect IMMEDIATELY (0 ms), seamless, NO error, NO budget hit
//    (this is the common boundary; surfacing it as an ERROR / waiting a backoff would be wrong).
//  - GENUINE failure (thrown error, connect timeout, HTTP non-2xx, or an end that delivered ZERO bytes
//    → guards a hot-loop) → exponential backoff + a 6-error / 4-timeout budget; only when the budget is
//    EXHAUSTED do we emit the fatal UnrecoverableEarlyEof. During retries we only LOG a breadcrumb
//    (Events.ERROR is reserved for the fatal case so a self-healing blip never looks like an error).
// On bytes resuming after real failures we post `recovered` (→ host RECOVERED_EARLY_EOF).
//
// Memory/race safety: the demux + decoders persist across reconnects (no per-attempt alloc), only the
// fetch Response/reader is recreated. The per-attempt `finally` cancels the reader + aborts the fetch
// on EVERY exit (reconnect, teardown, throw), so the old connection is closed promptly instead of left
// to a passive GC release — that promptness is what lets the upstream drop the subscriber. EVERY
// await re-checks `alive(myGen)`, so a load/unload/destroy during a backoff sleep aborts the reconnect
// (the new load runs under a fresh gen). We do NOT call demuxEof during a live drop, so the pump just
// waits (step==2, !feedDone) for the resumed bytes instead of finishing.
async function ingest(myGen: number, url: string): Promise<void> {
  if (!F) return;
  const f = F; // stable handle for the onBytes/shouldRead closures (module `F` loses narrowing inside them)
  let everConnected = false; // only reconnect AFTER a stream has actually started (initial fail = fatal)
  let errorRetries = 0;
  let timeoutRetries = 0;

  // Re-request immediately after a CLEAN connection boundary (`retry` action — the body ended but had
  // delivered bytes). No backoff, no budget hit, NO `reconnecting` post (seamless → the facade stays
  // Playing). Counts as a reconnect for the bus. Bounded against a 0-byte hot-loop: an empty body
  // classifies to `reconnect` (backoff+budget), not `retry`.
  const retryNow = (): void => {
    awaitKeyframe = true; // resume decode on the next IDR after the discontinuity (both tiers)
    reconnectsTotal++;
    log('stream ended — reconnecting (seamless boundary)');
  };

  // A GENUINE failure (`reconnect` action): count it (per budget), POST `reconnecting` (→ facade
  // Reconnecting state), back off, arm a keyframe resync. Returns true to retry, or false (after the
  // FATAL UnrecoverableEarlyEof — backoff EXHAUSTED → fatal → teardown) when the budget is spent. Emits
  // NO Events.ERROR during retries — only the `reconnecting` lifecycle post + a log breadcrumb.
  const scheduleReconnect = async (isTimeout: boolean): Promise<boolean> => {
    const count = isTimeout ? ++timeoutRetries : ++errorRetries;
    const cap = isTimeout ? RECONNECT_MAX_TIMEOUT_RETRY : RECONNECT_MAX_ERROR_RETRY;
    if (count > cap) {
      feedDone = true; // let the pump drain below low-water and finish; failFatal halts everything
      failFatal('early-eof', -1, 'Fetch stream meet Early-EOF (reconnect exhausted)');
      return false;
    }
    awaitKeyframe = true; // resume decode on the next IDR after the discontinuity (both tiers)
    reconnectsTotal++;
    post({ type: 'reconnecting', attempt: count }); // → facade controller: Playing/Buffering → Reconnecting
    const delay = reconnectDelayMs(count - 1, RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS);
    log(`reconnecting in ${delay}ms (${isTimeout ? 'timeout ' : ''}${count}/${cap})`);
    await sleep(delay);
    return alive(myGen);
  };

  // EXECUTE the error controller's resolved action. The classify→action ladder (classifyError) decides
  // retry/reconnect/fatal BY TYPE; this only runs the decision. Returns true to re-open, false to stop.
  const applyAction = async (cause: ErrorCause, code: number, msg: string): Promise<boolean> => {
    const action = classifyError(cause, { hasLiveEdge: caps.hasLiveEdge, everConnected });
    switch (action.kind) {
      case 'retry':
        retryNow();
        return true;
      case 'reconnect':
        return scheduleReconnect(action.budget === 'timeout');
      case 'recreateDecoder':
        return true; // ingest never produces a decode-glitch; defensive (the WC path owns recreate)
      case 'fatal':
        feedDone = true;
        failFatal(action.failure ?? 'network', code, msg);
        return false;
    }
  };

  for (;;) {
    if (!alive(myGen)) return;
    // ONE attempt = ONE LiveSourcePort.open(). The port owns the fetch + connect-timeout + the
    // backpressure read loop + the synchronous-abort `finally`; we keep `currentSource` so a teardown
    // (stopPipeline) can `.abort()` THIS attempt while the worker is still alive (prompt-FIN).
    const source = new LiveSourcePort(url);
    currentSource = source;
    let progressed = false; // bytes delivered THIS attempt → a clean end is a seamless reconnect, not a fault
    let connectedAtMs = 0;  // FIX 3: performance.now() at onConnect → the eof-boundary duration floor
    try {
      const r = await source.open({
        // Bound the ring: read only while UNDER the adaptive low-water + read-ahead window; the
        // fetch body backpressures the network when we stop pulling.
        shouldRead: () => f.demuxBuffered(demux) <= liveLowWater + liveReadAhead,
        alive: () => alive(myGen),
        pollMs: 8,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        onConnect: (status, facts) => {
          everConnected = true;
          connectedAtMs = lastByteAtMs = performance.now();
          // REFINE the descriptor from the first response's headers (no extra round-trip — the response is
          // in hand). A live MPEG-TS push is chunked 200 / no Accept-Ranges ⇒ seekable=false, bounded=false,
          // hasLiveEdge=true (byte-identical to the old isLive=true path). A timeshift origin that serves
          // ranges ⇒ seekable=true (seekbar shown). Idempotent across reconnects; posted to main ONCE.
          caps = deriveCapabilities(caps.declaredLive, facts);
          announceCaps();
          // FIX 2: this attempt is now ACTIVELY reading → arm the silence watchdog. Reset the Welford
          // cadence so the prior connection's burstiness doesn't carry over (the threshold re-warms to
          // the ceiling over the next SILENCE_WARMUP_SAMPLES bytes of THIS connection).
          streaming = true;
          cadMean = 0; cadM2 = 0; cadN = 0;
          log('streaming (HTTP ' + status + ')');
        },
        onBytes: (value) => {
          f.demuxFeed(demux, value);
          feedBytes += value.length;
          // Feed the adaptive upstream-silence watchdog: track the inter-byte cadence (Welford) so its
          // reopen threshold adapts to THIS source's burstiness (mean+2σ), and stamp the arrival time.
          const nowMs = performance.now();
          if (lastByteAtMs > 0) {
            const gap = nowMs - lastByteAtMs;
            cadN++; const d = gap - cadMean; cadMean += d / cadN; cadM2 += d * (gap - cadMean);
          }
          lastByteAtMs = nowMs;
          if (!progressed) {
            progressed = true;
            // Bytes flowing again after a reconnect → recovered; reset the budget + notify.
            if (errorRetries || timeoutRetries) {
              errorRetries = 0; timeoutRetries = 0;
              post({ type: 'recovered' }); // → facade controller: Reconnecting → Buffering → Playing
            }
          }
        },
      });
      streaming = false; // FIX 2: open() returned → no longer actively reading (gate the watchdog out of any backoff below)
      if (!alive(myGen)) return;
      if (r.reason === 'gone') return; // teardown/supersede flipped alive() mid-stream
      // Body ended cleanly. VOD = clean EOF → let the pump finish. LIVE → the error controller classifies
      // the boundary BY TYPE: a MEANINGFUL delivery = `eof-boundary` (→ retry, seamless); a trickle/empty
      // close = `empty-body` (→ reconnect with backoff+budget) so neither an empty-200 NOR a trickle-then-
      // close server can hot-loop at 0ms (FIX 3 — a single delivered byte must not latch a seamless retry).
      if (!caps.hasLiveEdge) { f.demuxEof(demux); feedDone = true; return; }
      const boundary = classifyCleanBoundary({
        bytes: r.bytes,
        durationMs: connectedAtMs > 0 ? performance.now() - connectedAtMs : 0,
        minBytes: EOF_BOUNDARY_MIN_BYTES, minMs: EOF_BOUNDARY_MIN_MS,
      });
      if (!(await applyAction(boundary, -1, 'Fetch stream meet Early-EOF'))) return;
      // loop → re-open
    } catch (err) {
      streaming = false; // FIX 2: open() threw → no longer reading; the watchdog must NOT trip during the backoff that follows
      if (!alive(myGen)) return;
      // ALWAYS log the error name first: a non-network error must never hide silently behind a reconnect.
      const errName = err instanceof Error ? err.name : typeof err;
      // Classify the THROW by TYPE FIRST, then let the ONE error controller resolve the action (FIX 1):
      //  - a RangeError is OUR OWN glue (the cross-realm stale-HEAPU8 `offset is out of bounds`) → ALWAYS
      //    `range-error` → FATAL, never a reconnect (the documented false-reconnect→mid-gap-corruption
      //    guard: misreading it as a live drop resumes the persistent demuxer mid-gap → a corruption flood),
      //  - SourceHttpError → `http-status`, SourceConnectTimeout → `connect-timeout`,
      //  - only if no INTERNAL/transport TYPE threw does the silence flag win → `upstream-silence`, else `network-drop`.
      // TYPE beats the flag because the silence watchdog can trip during the backoff window and leave
      // `silenceTripped` stale; checking the flag first would let a raced-in trip downgrade a fatal
      // RangeError to a reconnect. We consume the flag REGARDLESS of the branch so it can never leak forward.
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
      log('ingest ' + cause + ' (' + errName + ') → ' + classifyError(cause, { hasLiveEdge: caps.hasLiveEdge, everConnected }).kind);
      if (!(await applyAction(cause, status, msg))) return;
      // loop → re-open
    } finally {
      // The port's own `finally` already cancelled the reader + aborted the fetch; just drop our handle
      // so stopPipeline never aborts a stale port.
      if (currentSource === source) currentSource = null;
    }
  }
}

// --- the adaptive upstream-silence watchdog (a mean+2σ silence→reopen threshold) ----------------------
// DETECTION lives here; the ACTION is the error controller's. It covers the failure the reconnect/backoff
// loop CANNOT see on its own: the socket stays OPEN but the upstream stops sending bytes, so `reader.read()`
// never resolves — no throw, no clean end, the pump just waits forever (step==2, !feedDone). The watchdog
// notices the silence (no byte for clamp(mean+2σ, floor, ceiling)) and ABORTS the current source; the
// in-flight read then rejects, surfacing in ingest's catch as `silenceTripped` → an `upstream-silence`
// cause → the controller's `reconnect` action. Live-only; idle while paused / drained / not yet connected.
async function silenceWatchdog(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(500);
    if (!alive(myGen)) return;
    // Only arm while an attempt is ACTIVELY streaming (FIX 2): not while paused, not after a clean
    // feedDone, not before the first byte (lastByteAtMs===0), and — critically — only while `streaming`
    // (between onConnect and open()'s return), so a dead port lingering through the reconnect backoff
    // (its `finally`-null runs only after the backoff await) can never make the watchdog accrue idle,
    // set a stale silenceTripped, or inflate stallsTotal during a sleep.
    const src = currentSource; // capture for the abort below (and so TS narrows it non-null past the guard)
    if (!src || !silenceWatchdogArmed({ paused, feedDone, hasSource: true, streaming, lastByteAtMs })) continue;
    // CRITICAL: distinguish "upstream went silent" from "WE stopped reading on purpose." When the demux
    // ring is over the watermark the backpressure gate (shouldRead) holds the read loop — no bytes arrive
    // because we CHOSE not to pull, not because the upstream is silent. Reset the silence timer so the
    // watchdog accrues idle ONLY while the gate is open (we're actually trying to read). Without this a
    // brief present stall (ring full for >3 s) would false-trip a needless reconnect.
    if (F && demux && F.demuxBuffered(demux) > liveLowWater + liveReadAhead) { lastByteAtMs = performance.now(); continue; }
    const idle = performance.now() - lastByteAtMs;
    if (idle > silenceThresholdMs()) {
      stallsTotal++;
      silenceTripped = true;
      lastByteAtMs = performance.now(); // suppress an immediate re-trip while the reopen is in flight
      log(`upstream silent ${idle | 0}ms > ${silenceThresholdMs() | 0}ms (mean+2σ) → reopen`);
      src.abort(); // → ingest catch: cause 'upstream-silence' → reconnect
    }
  }
}

// --- the WebCodecs decoder-STALL watchdog (LIVE-WC fix) --------------------------------------------
// DETECTION lives here; the ACTION is the ONE error controller's (classifyError('decode-stall') →
// recreateDecoder). It covers the failure the SILENCE watchdog CANNOT see + must NOT remedy: the HW
// VideoDecoder wedges (input queued, output frozen) while bytes keep flowing — an upstream-silence
// reconnect would loop forever without ever clearing the wedged decoder (and its churn destroys audio =
// THE diagnosed bug). The remedy is a DECODER reset (recreate + await keyframe), keeping the SOURCE
// connected; only after WC_STALL_MAX_RECREATES unrecovered resets does the HW tier give up → software.
// Live-only; idle while paused / on the software tier / before a decoder exists.
async function wcStallWatchdog(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(500);
    if (!alive(myGen)) return;
    if (paused || !useWc || !vdecWc || vdecWc.state !== 'configured') continue;
    const action = wcStallAction({
      configured: true,
      decodeQueueSize: vdecWc.decodeQueueSize,
      msSinceOutput: performance.now() - lastWcOutputAtMs,
      awaitingKeyframe: awaitKeyframe, // legitimately holding for the first IDR → output isn't expected yet
      stallMs: WC_STALL_MS,
      recreates: wcStallRecreates,
      maxRecreates: WC_STALL_MAX_RECREATES,
    });
    if (action === 'none') continue;
    const q = vdecWc.decodeQueueSize | 0;
    const idle = (performance.now() - lastWcOutputAtMs) | 0;
    if (action === 'recreate') {
      // Route the decision through the ONE error controller: a decode-stall classifies to recreateDecoder
      // — reset the wedged decoder + await the next IDR, keep the SOURCE connected (NOT a reconnect). The
      // codec string is captured BEFORE createWcDecoder (its freeWc clears wcCodec). Count the stall only
      // when we actually ACT (the guard below can no-op if the codec string is somehow lost).
      const act = classifyError('decode-stall', classifyCtx());
      if (act.kind === 'recreateDecoder' && wcCodec) {
        const codec = wcCodec;
        wcStallRecreates++;
        stallsTotal++; // a decode-stall firing (distinct from the upstream-silence stall; logged distinctly, surfaced on getStats)
        log(`webcodecs decode stall (q=${q}, no output ${idle}ms) → recreate + await keyframe (${wcStallRecreates}/${WC_STALL_MAX_RECREATES})`);
        createWcDecoder(codec); // resets the encoded queue, arms awaitKeyframe + the stall timer
      }
    } else { // 'fallback' — the HW tier can't sustain this stream after the recreate budget → software
      stallsTotal++;
      log(`webcodecs decode stall unrecovered after ${wcStallRecreates} recreates (q=${q}, no output ${idle}ms) → software tier`);
      fallbackToSoftware();
    }
  }
}

/** Terminal end-of-pipeline (called by the pump). VOD end is clean → `ended`. A LIVE early-EOF is
 *  normally handled by ingest's reconnect loop (which never calls demuxEof during a drop, so the pump
 *  waits rather than finishing); reaching the live branch here means the demux reported a hard EOF
 *  the reconnect path didn't cover → defensively surface the fatal UnrecoverableEarlyEof. */
function finishStream(): void {
  if (caps.hasLiveEdge) {
    // Unexpected with the reconnect path (ingest reconnects live drops without demuxEof) → log so a real regression
    // surfaces here rather than silently emitting a fatal early-eof.
    log('finishStream: unexpected live demux EOF (reconnect path bypassed) → fatal early-eof');
    failFatal('early-eof', -1, 'Fetch stream meet Early-EOF');
  } else {
    stop = true;
    post({ type: 'ended' });
  }
}

// --- pump: open demux, lazily create decoders, route packets, post frames -------
async function pump(myGen: number): Promise<void> {
  if (!F) return;
  let pWaitMs = 0, pLogT = 0, pLogFrames = 0, pDecMs = 0, pCpMs = 0; // DIAG: wait vs decode vs hold+post
  let pPackMs = 0, pDropBase = 0; // DIAG: hold+post cost (no per-sample loop → ≈0). Success = pack≈0, drop≈0, frames→50+, heap≈300M.
  while (alive(myGen) && F.demuxBuffered(demux) < STARTUP_BYTES) await sleep(15);
  // Bounded open: a valid MPEG-TS opens within the first KBs; if it never opens with a full
  // startup window buffered, the container is unparseable → FormatError (not an infinite hang).
  let openTries = 0;
  while (alive(myGen) && F.demuxOpen(demux) !== 0) {
    if (++openTries > OPEN_DEADLINE_TRIES) { failFatal('demux', -1, 'could not open container (not MPEG-TS?)'); return; }
    await sleep(15);
  }
  if (!alive(myGen)) return;
  log('demux opened');

  while (alive(myGen)) {
    // DIAG: once/sec, report how much of the wall window the pump spent WAITING (low-water gate +
    // EAGAIN sleep) vs producing frames. wait≈window ⇒ the gate/ingest throttles; wait≈0 ⇒ elsewhere.
    if (DEBUG) { const _n = performance.now(); if (pLogT === 0) { pLogT = _n; pDropBase = frameDrops; } if (_n - pLogT >= 1000) { log(`[pump] wait=${pWaitMs | 0} dec=${pDecMs | 0} hold+post=${pCpMs | 0} (hold=${pPackMs | 0} drop=${frameDrops - pDropBase}) /${(_n - pLogT) | 0}ms frames=${postedCount - pLogFrames} heap=${(F.memory.buffer.byteLength / 1048576) | 0}M`); pWaitMs = 0; pDecMs = 0; pCpMs = 0; pPackMs = 0; pDropBase = frameDrops; pLogT = _n; pLogFrames = postedCount; } }
    // Live pause: drain+discard all buffered packets to stay at the live edge and keep
    // the network flowing (no decode, no posts). Truncation is irrelevant — we discard.
    if (paused) {
      let s = 1;
      while (s === 1 && alive(myGen)) s = F.demuxStep(demux);
      await sleep(20);
      continue;
    }
    // NO hard credit block on the LIVE path. The old `while (credits<=0) await sleep(4)`
    // stopped the ENTIRE pump — including pulling AUDIO packets — whenever main fell briefly behind on
    // present (e.g. a 62 ms rAF on 4K SW), so audio demux starved and the audio pipeline glitched
    // on/off. Live decode is already throttled to ~real time by the ingest (the CDN delivers at ~1×)
    // + the low-water gate below, so it can't run away; when main IS transiently behind, main now
    // DROPS-OLDEST on its software ring (mirroring the WebCodecs tier) instead of the worker blocking,
    // keeping video at the live edge AND audio flowing. Credits stay as heap-slot accounting
    // (slot release replenishes them); VOD keeps its own hard credit block (runVod) since
    // the range reader has no 1× pacing. (Dropping video frames rather than blocking
    // decode protects audio from video-decode starvation.)
    // Low-water: ensure a full window is buffered so each demux step gets a COMPLETE PES
    // (a 4K HEVC PES is multiple MB); stepping on a partial PES → truncated NALUs → blocking.
    // The gate tracks the ADAPTIVE low-water — the PES-completeness floor is preserved by
    // `adaptiveLowWater`'s `lw ≥ peak` invariant, so a tighter buffer never admits a partial PES.
    { const _w0 = performance.now(); while (alive(myGen) && !feedDone && F.demuxBuffered(demux) < liveLowWater) await sleep(4); pWaitMs += performance.now() - _w0; }
    if (!alive(myGen)) return;

    // Audio decoder: (re)create on the first audio codec + any change (both tiers decode audio here).
    const ac = F.demuxAcodec(demux);
    if (ac > 0 && ac !== curAcodec) {
      if (adec) F.audioFree(adec);
      adec = F.audioNew(ac);
      if (adec) { curAcodec = ac; announce(); }
    }

    const step = F.demuxStep(demux);
    if (step === 2) { if (feedDone) { finishStream(); break; } const _s0 = performance.now(); await sleep(8); pWaitMs += performance.now() - _s0; continue; }
    if (step === 0) { finishStream(); break; }
    if (step < 0) { failFatal('decode', step, 'demux step error'); break; }

    const stream = F.demuxPktStream(demux);
    const ptr = F.demuxPktDataPtr(demux);
    const size = F.demuxPktSize(demux);
    const pts = F.demuxPktPtsUs(demux);

    if (stream === 0) {
      feedVidPktPeriod(pts >= 0n ? Number(pts) : -1); // TRUE content period (non-ref-skip-independent) → present cap
      const isKey = F.demuxPktIsKey(demux) === 1;
      // Track the largest video PES (running MAX, monotonic) + warm on the first keyframe (the
      // GOP's largest PES); recompute the adaptive low-water / read-ahead so a low-bitrate stream
      // relaxes to a tight buffer while 4K keeps its full-PES floor. `size` is
      // this packet's PES size. Skipped when stashAdaptive is off (fixed ceiling = the pre-adaptive behaviour).
      if (lwAdaptive) {
        if (size > peakVideoPes) peakVideoPes = size;
        if (isKey) warmedUp = true;
        liveLowWater = adaptiveLowWater(peakVideoPes, warmedUp, lwFloor, lwCeiling);
        liveReadAhead = adaptiveReadAhead(liveLowWater, lwCeiling * 2);
      }
      const vc = F.demuxVcodec(demux);
      let au: Uint8Array | null = null;
      // Pick/recreate the video decoder on the first codec AND on a mid-stream codec change (an
      // upstream cross-codec failover bumps the PMT version → new codec_id). The seam is keyframe-
      // aligned upstream, so the fresh decoder gets an IDR first. Tier selection lives HERE because
      // it depends on the demuxed codec (+ the WC demux worker's SPS branch).
      if (vc > 0 && vc !== curVcodec) {
        au = F.auCopy(ptr, size); // copy now: the packet buffer is valid here; await follows
        await setupVideoDecoder(vc, au);
        if (!alive(myGen)) return; // defensive: bail if teardown/supersede landed around the setup turn
      }

      if (useWc) {
        // WebCodecs HW tier: start (and resume / restart-after-reconfig) on a keyframe, then wrap each AU
        // as an EncodedVideoChunk. Output VideoFrames are transferred to main (output cb).
        if (vdecWc) {
          // Copy the AU up front (the demux is NOT stepped during the wait below → ptr stays valid, but
          // capturing the bytes now is the robust contract).
          if (!au) au = F.auCopy(ptr, size);
          // (a) FEED BACKPRESSURE — HOLD the demux (don't feed) while the decoder's OWN encoded input queue
          // (decodeQueueSize) is at its ceiling, so the VideoDecoder can NEVER over-fill (the decode-q→314
          // stall). Gating SOLELY on decodeQueueSize — a signal the HW DECODER ITSELF drains — means the
          // gate re-opens the instant a chunk decodes, so it CANNOT deadlock (the earlier regression was a
          // park on a cross-worker wcInFlight ack that never arrived → permanent latch; that ack is gone from
          // the decision). The present ring stays bounded indirectly (feed ≤ N encoded-AUs ahead → decode ~N
          // ahead → ring ~N) with the present-side drop-oldest as the burst BELT. WAIT, never shed (the
          // shed-a-GOP mistake). For NORMAL/transient backpressure audio is unaffected (the wait clears in a frame-time
          // as the HW decoder drains, and the reservoir covers the sub-frame pauses). A genuine decoder STALL
          // (queue stays FULL, output frozen) parks the pump until the stall watchdog recreates (≤ WC_STALL_MS):
          // the buffered demux keeps video CONTIGUOUS across the recovery (gap ≪ SEAM_FWD, no freeze) so the
          // only cost is a BOUNDED, NON-CUMULATIVE audio gap (≈ WC_STALL_MS) — vs the diagnosed UNBOUNDED
          // reconnect-loop audio destruction. A stall-watchdog recreate during the sleep can swap vdecWc /
          // re-arm awaitKeyframe, so everything is RE-READ after.
          // (a-belt) wcParkWatchdog: defense-in-depth — break + log if the park ever outlives WC_PARK_WATCHDOG_MS
          // with the queue NOT actually full (an invisible latch, the deadlock class). Provably dead code under
          // the decodeQueueSize-only gate (it self-releases the instant the queue drains), but it guarantees no
          // FUTURE gate can wedge the pump for more than the window without it being LOGGED + force-recovered.
          { const _w0 = performance.now(); wcGateParked = true;
            while (alive(myGen) && !paused && useWc && vdecWc &&
                   wcShouldWaitFeed(vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX)) {
              if (wcParkWatchdog(performance.now() - _w0, vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX, WC_PARK_WATCHDOG_MS)) {
                wcParkWatchdogs++;
                log(`[wc] feed-park watchdog: parked ${(performance.now() - _w0) | 0}ms with q=${vdecWc.decodeQueueSize}<${WC_DECODE_QUEUE_MAX} (inflight=${wcInFlight}) → force re-evaluate (a gate latched on a non-self-releasing signal)`);
                break;
              }
              await sleep(4);
            }
            wcGateParked = false;
            pWaitMs += performance.now() - _w0; }
          if (!alive(myGen)) return;
          // (b) AWAIT-KEYFRAME HOLD — never feed a delta to a fresh / flushed decoder (after (re)create /
          // reconnect / resume awaitKeyframe is armed). Re-evaluated AFTER the wait against the CURRENT
          // decoder so a mid-wait recreate can't slip a reference-less delta through.
          if (!paused && useWc && vdecWc) {
            const g = wcKeyframeGate(awaitKeyframe, isKey);
            awaitKeyframe = g.awaitingKeyframe;
            if (g.feed) feedWc(au, isKey, pts >= 0n ? Number(pts) : -1);
          }
        }
      } else if (vdec) {
        // SOFTWARE tier (the validated ffmpeg path).
        // The moment the live demux resolves the in-band param sets (codecpar extradata), rebuild
        // the decoder FROM the demux so it has VPS/SPS/PPS up front (a fresh decoder = cleanest flush),
        // matching the probing/VOD path. This is what makes a 4K-HEVC stream whose param sets are sparse
        // decode cleanly instead of flooding "[hevc] PPS id out of range" / starving to ~18 fps.
        if (!swHasExtradata && F.demuxVExtradataSize(demux) > 0) {
          swHasExtradata = true; // attempt once; never thrash per-packet if the re-alloc fails
          F.vdecFree(vdec);
          vdec = F.vdecNewFromDemux(demux, threads) || F.vdecNew(curVcodec, threads); // bare fallback (in-band)
          if (!vdec) { failFatal('decode', -1, 'live: video decoder re-alloc failed'); break; }
          F.vdecSetDeint(vdec, deintMode); applySkips(vdec); // re-apply the skips after the extradata rebuild
          // A fresh decoder must start on an IDR. At initial play the extradata lands WITH the first
          // keyframe so this clears on the same packet; but on a mid-GOP WC→software fallback (extradata
          // already captured at startup) the trigger is a DELTA — without this gate the fresh decoder
          // would be fed a reference-less delta → "Could not find ref with POC" flood (the param-set symptom,
          // relocated). awaitKeyframe (checked just below) drops packets until the next IDR.
          awaitKeyframe = true;
        }
        // For H.264/HEVC, HOLD packets until the param sets are resolved (extradata captured OR a flagged
        // keyframe): feeding pre-keyframe deltas to a param-set-less decoder produces no frames (no
        // reference) but floods "PPS id out of range". This is the live mid-GOP join window; other codecs
        // (no extractable param sets) are unaffected and feed immediately (legacy behaviour preserved).
        // Bounded escape valve: if neither in-band param sets NOR a flagged keyframe arrive within a
        // generous window (a stream signalling param sets only out-of-band), stop holding and revert to
        // the legacy feed-everything path (noisy but alive) rather than a permanent black SW tier.
        if ((curVcodec === 27 || curVcodec === 173) && !swHasExtradata && !isKey) {
          if (++heldVideoPkts <= HOLD_FALLBACK_PKTS) continue;
        }
        // After a live-pause resume, skip packets until the next IDR so decode restarts clean
        // near the live edge (the pause discarded everything before this).
        if (awaitKeyframe) {
          if (!isKey) continue;
          awaitKeyframe = false;
        }
        // No further keyframe gate on initial play: push every packet and let the decoder sync —
        // FFmpeg withholds output until its first IDR, avoiding the long sparse-4K-IDR wait.
        { const _t = performance.now(); F.vdecPush(vdec, ptr, size, pts); pDecMs += performance.now() - _t; }
        // Surface deinterlace-graph build failures to the UI ("deint n/a").
        const df = F.vdecDeintFailed(vdec) === 1;
        if (df !== lastDeintFailed) { lastDeintFailed = df; post({ type: 'deintFailed', failed: df }); }
        for (;;) {
          { const _t = performance.now(); const _m = F.vdecStep(vdec) === 1; pDecMs += performance.now() - _t; if (!_m) break; }
          const w = F.vdecW(vdec), h = F.vdecH(vdec), cw = F.vdecCw(vdec), ch = F.vdecCh(vdec);
          // Guard malformed/not-yet-sized geometry (e.g. fresh decoder, monochrome 4:0:0) —
          // a 0-dim plane would upload a 0×0 chroma texture → garbage color / OOB reads.
          if (w <= 0 || h <= 0 || cw <= 0 || ch <= 0) continue;
          // Announce on first frame AND re-announce on a mid-stream resolution change so the
          // facade's videoWidth/Height (and /diag res) stay accurate across a failover seam.
          if (w !== annW || h !== annH) {
            annW = w; annH = h;
            announce();
          }
          // Zero-copy: HOLD the frame (refcount its native-stride/native-bit-depth planes) and post
          // the plane heap offsets — NO de-stride, NO 10→8 downshift, NO JS copy (the GPU does it). If
          // the held table is full (present far behind), DROP this frame rather than block (protect the
          // audio demux; mirrors drop-oldest). pPackMs is now the hold+accessor cost (≈0 — no per-sample loop).
          // Gate the hold+post on the PRESENT CREDIT budget (= RING_CAP=12), the CORRECT
          // in-flight bound — not the engine HELD_CAP=64 floor that let ~45–64 pinned 4K-10bit AVFrames
          // (≈1.5 GB) accumulate when the source ran faster than 1×. When credits are exhausted (present is
          // backpressured) DROP this video frame instead of holding+posting it — same drop-not-block
          // philosophy as the no-hard-credit-block live path, just the tighter (correct) threshold: the pump never blocks (audio keeps
          // flowing) and in-flight is capped at creditCap, not HELD_CAP. Count it as a drop for accounting
          // (holdAndPostFrame is NOT called, so the held-table-full drop counter is not double-incremented).
          // ROOT-CAUSE FIX: do NOT drop the frame — dropping punches a PTS HOLE into the present ring
          // (decode jumps to the live edge, leaving a 1-2s gap), and the present then FREEZES at every hole
          // (the catastrophic stall-jump-stall). Instead WAIT for the present to free a slot so the video
          // sequence stays CONTIGUOUS. The wait is ~one frame-time (the present releases a slot per drawn
          // frame); audio keeps flowing because the inner loop drains ≤2 frames then returns to the outer
          // demux loop where audio packets interleave, and the audio reservoir covers the sub-frame pauses.
          while (alive(myGen) && !paused && credits <= 0) {
            const _w = performance.now(); await sleep(4); pWaitMs += performance.now() - _w;
          }
          if (!alive(myGen) || paused) break;
          const _cp0 = performance.now();
          const ok = holdAndPostFrame(w, h, cw, ch); // postedCount++/credits-- inside on success
          pPackMs += performance.now() - _cp0;
          pCpMs += performance.now() - _cp0;
          if (!ok) continue;
        }
      }
    } else if (stream === 1 && adec) {
      F.audioPush(adec, ptr, size, pts);
      while (F.audioStep(adec) === 1) {
        const chn = F.audioChannels(adec);
        const samples = F.audioSamples(adec);
        const rate = F.audioRate(adec);
        const pcm = F.audioCopy(F.audioInterleavedPtr(adec), samples * chn);
        post({ type: 'audio', sampleRate: rate, channels: chn, ptsUs: Number(F.audioPtsUs(adec)), pcm }, [pcm.buffer]);
      }
    }
  }
}

// Stats cadence: halved from 1 Hz so transient stalls/queue spikes are visible — the overlay
// samples at 4 Hz but a 1 Hz worker post let real stalls slip between frames. fps is still computed
// over the actual dt, so a tighter window only sharpens the time resolution (≈25 frames/500ms @ 50fps
// → ±2fps), it doesn't add noise. The main-thread signals (present ring, audio seg-queue, sync rate,
// clock) are read LIVE by getStats() at the overlay's own cadence, so only the worker-sourced rows lag.
const STATS_INTERVAL_MS = 500;

async function statsLoop(myGen: number): Promise<void> {
  let lastFrames = postedCount, lastBytes = feedBytes, lastT = performance.now();
  while (alive(myGen)) {
    await sleep(STATS_INTERVAL_MS);
    if (!alive(myGen)) return;
    const now = performance.now();
    const dt = now - lastT;
    const fps = ((postedCount - lastFrames) * 1000) / dt;
    const kbps = ((feedBytes - lastBytes) / 1024) * (1000 / dt);
    lastFrames = postedCount; lastBytes = feedBytes; lastT = now;
    post({
      type: 'stats',
      stats: {
        tier,
        decodeFps: Math.round(fps),
        decodedFrames: postedCount,
        // SOFTWARE: frames the decoder produced but the present worker couldn't accept (held table full
        // → present fell behind). WEBCODECS present-drops happen present-side; 0 here. Cumulative.
        droppedFrames: useWc ? 0 : frameDrops,
        bufferedBytes: F ? F.demuxBuffered(demux) : 0,
        ingestKBps: Math.round(kbps),
        // tier-specific decode-backlog depth. SOFTWARE: the credit budget remaining (free ring
        // slots — low credits = main can't present fast enough → backpressure). WEBCODECS: the hardware
        // decoder's encoded-input queue (climbing = decode falling behind feed → the iPad-wedge precursor).
        credits: useWc ? 0 : Math.max(0, credits), // live SW no longer blocks on credits → can dip <0; clamp the readout
        decodeQueueSize: (vdecWc && vdecWc.state === 'configured') ? vdecWc.decodeQueueSize : 0,
        // LIVE-WC feed-gate diagnostics (we were BLIND to the deadlock). wcInFlight = present-ring
        // VideoFrames not yet released (TELEMETRY ONLY now; a monotonic climb here would be the old ack-leak,
        // but it no longer gates the feed). wcGateParked = is the pump currently in the feed-wait (a STUCK 1 =
        // a latch). On SW both are 0. With the decodeQueueSize-only gate, decodeQueueSize stays single-digit
        // AND wcGateParked is only transiently 1 — a parked pump with decodeQueueSize 0 can no longer happen.
        wcInFlight: useWc ? wcInFlight : 0,
        wcGateParked: (useWc && wcGateParked) ? 1 : 0,
        wcParkRecoveries: wcParkWatchdogs, // belt tripwire: MUST stay 0 — non-zero = a feed gate re-latched on a non-self-releasing signal (the deadlock class recurred)
        wcRecreates: wcStallRecreates, // cumulative WC decode-stall recreates (→ software fallback at the budget)
        // Counter channel (AUTHORITATIVE): the real wasm heap + the in-flight held count, piggybacked
        // on this same ~2 Hz stats post (NOT per-frame) — main can't read either (the engine is here).
        heapBytes: F ? F.memory.buffer.byteLength : 0,
        heldFrames: useWc ? 0 : heldFrames,
        // Teardown counter: the decode worker OWNS the live-ingest connection, so this is the
        // authoritative open-connection count. stopPipeline() nulls currentSource → this reports 0.
        connections: currentSource ? 1 : 0,
        // Recovery counters (authoritative; the error controller's recovery path lives here).
        reconnects: reconnectsTotal,
        stalls: stallsTotal,
        // The EFFECTIVE engine skips (manual OR auto-degrade) so the buildlog `levers` tag shows
        // the skips flipping on with the present-cap at the auto-degrade moment, not just the manual checkbox state. Gated on
        // the SOFTWARE tier: skip_frame/skip_loop_filter are ffmpeg-decoder fields (applySkips is a no-op on
        // the WC tier), so reporting them only when !useWc keeps the telemetry honest — it never claims a
        // decode-relief the hardware tier isn't actually performing (a WC→SW fallback flips this to 1 when
        // applySkips then takes effect).
        skipNonref: (!useWc && (leverSkipNonref || autoSkipNonref)) ? 1 : 0,
        skipLoop: (!useWc && (leverSkipLoop || autoSkipLoop)) ? 1 : 0,
        ...vodFetchStats(), // VOD fetch-progress (HttpSource transport; all 0 on live)
      },
    });
  }
}

/** VOD fetch-progress telemetry from the HttpSource forward-range transport (all 0 on live, where
 *  vodSource is null). Surfaced through WorkerStats → FerriteStats → the tier-agnostic overlay's transport
 *  row — useful for BOTH software-VOD and WC-VOD triage (a stuck position / climbing connection count /
 *  200-fallback all read here). Both tiers stream via the SAME HttpSource, so this is tier-independent. */
function vodFetchStats(): {
  vodTotalBytes: number; vodPositionBytes: number; vodWindowBytes: number;
  vodConnections: number; vodReopens: number; vodDegraded: number;
} {
  const s = vodSource?.getStats();
  return s
    ? { vodTotalBytes: s.total, vodPositionBytes: s.position, vodWindowBytes: s.windowBytes,
        vodConnections: s.connections, vodReopens: s.reopens, vodDegraded: s.degraded ? 1 : 0 }
    : { vodTotalBytes: 0, vodPositionBytes: 0, vodWindowBytes: 0, vodConnections: 0, vodReopens: 0, vodDegraded: 0 };
}

/** Free the current stream pipeline (demux + decoders) but keep the engine `F` loaded. */
function stopPipeline(): void {
  stop = true;
  // Abort the in-flight live-ingest fetch NOW (synchronously), before freeing the demux or
  // waiting on the next read. This runs on `unload` (the first message of the demo's Stop sequence,
  // well before main terminate()s the worker), so the `/proxy` socket closes at once → serve.mjs sees
  // the client disconnect → it aborts its upstream fetch → the bridge drops the subscriber promptly.
  // The aborted read() rejects → ingest's catch returns immediately (alive() is now false → no
  // reconnect) → the port's `finally` re-aborts (idempotent). VOD uses vodSource (not currentSource):
  // freeDecoders() below aborts it, unwinding any in-flight range-read suspend so runVod can free its demux.
  if (currentSource) { currentSource.abort(); currentSource = null; }
  freeDecoders(); // live: frees demux + decoders; VOD: frees decoders + aborts vodSource (demux freed by runVod's finally)
  if (F) F.vdecReleaseAll(); // reclaim any held frames in transit (main reset the present worker on unload)
  credits = 0;
  heldFrames = 0; // teardown: held table flushed → in-flight count returns to baseline
  wcInFlight = 0; // LIVE-WC: present ring is reset by main on teardown → in-flight WC frames return to baseline
  paused = false;
  awaitKeyframe = false;
  lastDeintFailed = false;
  useWc = false;
  tier = 'software';
  curVcodec = 0; curAcodec = 0;
  swHasExtradata = false; heldVideoPkts = 0;
  autoSkipNonref = false; autoSkipLoop = false; // teardown clears the auto-degrade skips (manual persists)
}

/**
 * Destroy handshake (fixes the pthread-pool orphan leak). The OLD path was just
 * `worker.terminate()` from main, which kills only THIS coordinator Worker — the 8 pooled
 * decode Workers it spawned are closure-private to the emscripten runtime and orphan, each
 * pinning a 2 GB SharedArrayBuffer wasm instance (resource creep across Stop/Play cycles).
 *
 * Now: free the demux/decoders (joins any frame-threaded decoder workers back into the pool on
 * the still-live runtime — MUST precede the terminate), then PThread.terminateAllThreads() to
 * reap the pool, then ack `destroyed` so main can terminate the coordinator with no orphans.
 *
 * Race safety:
 *  - `closing` latch makes it idempotent (double-destroy) and gates load/run (destroy-during-load).
 *  - We await `ready` (bounded) before terminating so a pool still spawning during engine init is
 *    fully up before we reap it — otherwise a thread spawned AFTER terminateAllThreads would
 *    itself orphan (destroy-before-engine-ready).
 *  - Main has its own timeout fallback: if this never acks (wedged worker / engine that never
 *    settles), main terminate()s the coordinator anyway. Worst case = the original behavior.
 */
async function handleDestroy(): Promise<void> {
  if (closing) return;
  closing = true;
  stop = true; // halt ingest/pump/stats at their next `alive()` check before we free anything
  // Wait for engine init to SETTLE before reaping — emscripten spawns the pool DURING
  // loadFerrite(), so reaping early would miss workers still being spawned (they'd re-orphan).
  // `ready` always settles (both `init` paths call resolveReady), and it resolves the instant
  // loadFerrite returns (fast when already loaded; a few seconds on a cold start) — so this is
  // NOT a fixed delay, it's "proceed as soon as F exists". READY_SETTLE_MS is ONLY a wedge-breaker
  // for a genuinely hung instantiate (a fetch of ferrite.mjs that never returns); it MUST exceed
  // realistic cold-init, and main's WORKER_SHUTDOWN_TIMEOUT_MS MUST exceed it + the reap.
  await Promise.race([ready.catch(() => false), sleep(READY_SETTLE_MS)]);
  stopPipeline();          // free demux + decoders on the live runtime (joins decoder threads)
  if (F) {
    try { F.shutdownThreads(); } catch (err) { log('thread shutdown: ' + err); } // reap the pool
  } else {
    // F still null ⇒ loadFerrite never returned within READY_SETTLE_MS. We have no handle to
    // reach PThread, so a pool half-spawned inside the hung instantiate may orphan when main
    // terminate()s. Unavoidable without the handle; surface it rather than silently no-op.
    log('destroy: engine never settled — forced teardown, pthread pool may orphan');
  }
  // Spawn-race-safe re-reap: terminateAllThreads() above reaps only workers already registered; one still
  // finishing its async spawn/replenish is invisible (in neither PThread set) and would orphan. Poll the
  // pool size and re-reap each time a straggler LANDS (count > 0), until the pool stays empty for
  // REAP_QUIET_MS (min REAP_MIN_WATCH_MS, to cover a late-appearing spawn) or REAP_DEADLINE_MS.
  if (F) {
    const start = performance.now();
    let quietSince = start;
    for (;;) {
      await sleep(REAP_POLL_MS);
      const now = performance.now();
      if (F.pthreadPoolCount() > 0) { try { F.shutdownThreads(); } catch (err) { log('thread shutdown: ' + err); } quietSince = now; }
      const watched = now - start;
      if (watched >= REAP_DEADLINE_MS || (watched >= REAP_MIN_WATCH_MS && now - quietSince >= REAP_QUIET_MS)) break;
    }
  }
  // Post the FINAL authoritative teardown counters BEFORE the `destroyed` ack so main records
  // the OBSERVED post-reap state (not a main-side zero that could never fail the gate). These are read
  // from real worker state AFTER stopPipeline(): currentSource was aborted+nulled → connections=0; the
  // held table was flushed (vdecReleaseAll) → heldFrames=0; heapBytes is the genuine post-reap heap. A bug
  // that left the source attached or a frame held would surface here non-zero → the leak gate FAILS.
  // Messages keep post order, so main consumes these before it acts on `destroyed`.
  post({
    type: 'stats',
    stats: {
      tier, decodeFps: 0, decodedFrames: postedCount, droppedFrames: useWc ? 0 : frameDrops,
      bufferedBytes: 0, ingestKBps: 0, credits: 0, decodeQueueSize: 0,
      wcInFlight: 0, wcGateParked: 0, wcParkRecoveries: wcParkWatchdogs, wcRecreates: wcStallRecreates, // teardown: in-flight→baseline, pump stopped→not parked; the cumulative belt-tripwire + recreate count survive for the final record
      heapBytes: F ? F.memory.buffer.byteLength : 0,
      heldFrames,                          // authoritative: stopPipeline() flushed the held table → 0
      connections: currentSource ? 1 : 0,  // authoritative: stopPipeline() aborted+nulled the source → 0
      reconnects: reconnectsTotal, stalls: stallsTotal, // final recovery tallies (cumulative for the load)
      skipNonref: (!useWc && (leverSkipNonref || autoSkipNonref)) ? 1 : 0, skipLoop: (!useWc && (leverSkipLoop || autoSkipLoop)) ? 1 : 0, // D3: stopPipeline() cleared auto; SW-tier-only effective
      ...vodFetchStats(), // VOD fetch-progress (last snapshot; telemetry only — NOT a leak-gate counter, which uses `connections` from the live currentSource)
    },
  });
  post({ type: 'destroyed' });
}
