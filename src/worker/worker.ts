// VIDEO-DECODE worker (the VIDEO decode realm — video-only).
//
// WHY (decode isolation): the video decode worker in the mpv-style 4-worker topology ONLY DECODES VIDEO. It no
// longer owns the source or the demuxer (that is the DEMUX worker, demux-worker.ts) NOR audio decode (that is
// the AUDIO worker, audio-worker.ts — audio runs on its own worker + ferrite instance so heavy software-HEVC
// video decode can never block it). It CONSUMES ONLY the VIDEO SAB packet ring the demux fills
// (PacketRingConsumer, stream 0), runs the ffmpeg software video decoder (or the WebCodecs HW tier), and posts
// decoded frames to the PRESENT worker (zero-copy frame-pinning). The per-frame video credit-wait stays here.
//
// THE KEY STRUCTURAL CHANGE (Fix A across the worker boundary): the video decoder is built from the relayed
// CodecParams (codec id + extradata + profile/level/SAR) — MAIN forwards the DEMUX worker's codecParams. The
// VIDEO worker has NO demux, so it can't read codecpar/extradata locally. Live mpegts ships the Annex-B param
// sets as `extradata` → the Fix-A WC config record (wcBuildConfig → hvcC/avcC) + the length-prefixed reframe
// (wcReframeAu) are built from THOSE relayed bytes (not a local demuxVExtradata). VOD ships the avcC/hvcC
// record (byte0==1) → used as the description as-is. The SW build uses vdecNewWithExtradata(codec, threads, ed).
//
// TIERS: prefer WebCodecs when the host wants it AND the runtime has a VideoDecoder AND the codec family's HW
// support (probed ONCE at init + cached) AND the stream is progressive; otherwise the software tier — so an
// unsupported codec (HEVC on a no-HW-HEVC box) falls back cleanly, never a dead screen. Mid-stream codec change
// recreates the decoder keyframe-aligned (the demux re-ships codecParams on a PMT codec change).
//
// Flow control: on the live path the pump WAITS per-frame for a present credit (so a slow video frame never
// starves the present ring — and audio rides a separate ring AND a separate worker entirely now). Lifecycle:
// `init` loads the engine ONCE; `load` resets per-load state; `unload` frees the decoders but keeps the engine;
// `destroy` reaps the pthread pool. Stale loops self-cancel via alive(myGen). Ported from the reference player.

import { Ferrite, loadFerrite } from './ferrite-bindings';
import { videoCodecInfo, webCodecsEligible } from './codec';
import type { MainToWorker, WorkerToMain, DecodeToPresent, PresentToDecode } from '../protocol';
import { DEMUX_STREAM_VIDEO } from '../protocol';
import { PacketRingConsumer } from './packet-ring-io';
import type { FerriteFailureKind } from '../errors';
import type { Tier } from '../types';
import { classifyError, type ClassifyContext } from '../controller/error-controller';
import { wcShouldWaitFeed, wcParkWatchdog, wcKeyframeGate, wcStallAction, wcCapabilityCached, WC_PROBE_CODECS } from './wc-guard';
import type { WcFamily } from './wc-guard';

const READY_SETTLE_MS = 12000;          // destroy wedge-breaker: max wait for a hung loadFerrite
// Spawn-race-safe pool reap (destroy): a pthread worker still completing its async spawn/replenish when the
// first terminateAllThreads() runs is in neither PThread set → orphans. Keep re-reaping as in-flight spawns
// LAND, until the pool stays empty for a quiet window or a deadline.
const REAP_POLL_MS = 60;        // re-reap poll cadence
const REAP_QUIET_MS = 350;      // pool must read 0 this long (no new straggler) before we stop
const REAP_MIN_WATCH_MS = 500;  // always watch at least this long (covers a straggler's spawn latency)
const REAP_DEADLINE_MS = 4000;  // hard backstop on the reap-watch loop
// PUMP idle sleep when the video ring is momentarily empty / parked.
const PUMP_IDLE_MS = 4;
// SINGLE SOURCE OF TRUTH for the software in-flight bound. Main sends its RING_CAP on `init` and we cap credits
// at it, so the worker can NEVER decode past main's present-ring capacity. Set on `init`; 0 until then.
let creditCap = 0;

const post = (m: WorkerToMain, transfer: Transferable[] = []): void =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Split-realm present: decoded VIDEO frames go straight to the PRESENT worker over this MessageChannel port
// (NOT to main), and retired software heap slots come back over it by token (release). Set on `init`.
let presentPort: MessagePort | null = null;
const postFrame = (m: DecodeToPresent, transfer: Transferable[] = []): void => { presentPort?.postMessage(m, transfer); };

let F: Ferrite | null = null;
let threads = 8;
let fastDecode = false; // AV_CODEC_FLAG2_FAST (non-compliant SW speedups) — from init; applied before SW vdec creation
let wasmBaseUrl = '/';
let isIOS = false;
let isAppleWebKit = false;
let debug = false;
const dlog = (m: string): void => { if (debug) log(m); };

let vdec = 0;
let stop = false;
let closing = false;    // 'destroy' received → terminal; gates load/run
let gen = 0;            // current load generation; loops capture it and self-cancel when it changes
// Mirrors the demux caps (sent on `load` via isLive) — gates the live pause-resume IDR arm + the live WC strict
// path. The demux worker owns the full SourceCapabilities descriptor; the VIDEO worker reads only the live-edge bit.
let hasLiveEdge = true;
let preferWebCodecs = true; // host preference (per load); gates the hardware tier
let credits = 0;       // decode budget granted by main; 1 per free ring slot (SOFTWARE tier only)
let postedCount = 0;   // frames posted (cumulative; for decode-fps + decodedFrames stats)
let paused = false;    // live pause: skip until the next IDR on resume; VOD: hold
let awaitKeyframe = false; // after a resume / WebCodecs (re)configure / reconnect: skip video until the next IDR
// Fix-B rung-4: Live drop-to-keyframe latch (SOFTWARE tier). Set by the present worker's PresentToDecode
// 'dropToKeyframe' when the present-side ladder maxed out and the decoder is hopelessly behind. While set, the
// SW branch SKIPS delta AUs to the next IDR, then FLUSHES the DPB (vdecFlush) before decoding that IDR so the
// decoder doesn't predict from the discarded refs → bounded corruption = one GOP. DISTINCT from awaitKeyframe;
// self-clears on the IDR; also cleared at epoch flip / keyframeResync / resume / teardown / WC→SW fallback.
let chainBrokenUntilKeyframe = false;
let droppedToKeyAus = 0; // delta AUs skipped by the drop-to-keyframe latch (cumulative telemetry)
let lastDeintFailed = false;
// Universal RASL-skip latch. Armed when an await-keyframe release lands on an IRAP key (the keying IDR/CRA);
// while armed, RASL leading pictures (NAL 8/9) are DROPPED before decode — they reference the pre-IRAP GOP,
// are undecodable from the random-access point (NoRaslOutputFlag=1), and a VideoToolbox decoder throws
// BadDataErr on them (Chrome / FFmpeg-SW discard them internally → the drop is a harmless no-op). Cleared on
// the first non-RASL AU (a trailing picture OR a decodable RADL — both clear it; RADL MUST be kept).
let skipRaslUntilNonrasl = false;
let raslDrops = 0; // telemetry: RASL leading pictures dropped by the latch (cumulative)
let eofDrained = false; // one-shot: the SW decoder tail was flushed at end-of-segment (re-armed on a fresh epoch)
let stallsTotal = 0;   // WC self-heal recreates (the only "stall" counter left in the decode realm)

// ---- WebCodecs (hardware video) tier state ----
let tier: Tier = 'software';        // active video tier for the CURRENT codec (reported to main)
let useWc = false;                  // route video AUs to the hardware VideoDecoder (else ffmpeg vdec)
let vdecWc: VideoDecoder | null = null; // the hardware decoder (created/closed in the worker)
let wcCodec = '';                   // current WebCodecs codec string (for self-heal reconfigure)
// The VideoDecoder `description` (avcC/hvcC config record). VOD: the shipped extradata IS the record (byte0==1).
// LIVE: built from the relayed Annex-B param sets via FFmpeg (wcBuildConfig). null until resolved.
let wcDescription: Uint8Array | null = null;
// Fix A — live WebCodecs strict form: when wcDescription is set on a LIVE stream, the Annex-B AUs are reframed
// to length-prefixed before feed. false for VOD (already length-prefixed) + any live path with no description yet.
let wcReframe = false;
// LIVE: the in-band VPS/SPS/PPS can land AFTER the WC decoder was built with NO description (the relayed
// CodecParams arrives with empty extradata first, then a non-empty re-ship). On the re-ship, recreate the WC
// decoder WITH the FFmpeg-built description on the next keyframe so live reaches the strict form. Cleared by
// setupVideoDecoder. VOD never needs this (its config record ships up front).
let pendingVReconfig = false;
let wcHealthy = false;              // a VideoFrame has decoded since the last (re)configure
let lastWcPtsUs = 0;                // last fed video PTS (µs) — estimate a mid-stream NOPTS packet
let lastRealWcPtsUs = -1;           // last REAL (demuxed) video PTS (µs); derives the frame interval
let wcFrameIntervalUs = 1_000_000 / 50; // observed inter-frame interval (µs), 50 fps seed
let annW = 0, annH = 0;             // last announced video dims (software fills these; WC fills from frames)
let curVcodec = 0;                  // current VIDEO codec id (drives (re)create + tier decisions)

// codec params relayed from the DEMUX worker (the decoder is (re)built lazily from these — the VIDEO worker has
// NO demux). pendingVextradata = the copied bytes from CodecParams (live: Annex-B param sets; VOD: avcC/hvcC).
let pendingVcodec = 0;
let pendingVprofile = 0;
let pendingVlevel = 0;
let pendingVextradata: Uint8Array | null = null;
let pendingVsarNum = 1, pendingVsarDen = 1; // demuxer-resolved SAR (the WC tier has no decoder to read it off)

// ---- LIVE-WC guards (the WC analogs of the software no-drop + recovery guards). Decisions live in ./wc-guard. ----
let wcInFlight = 0;                 // TELEMETRY ONLY: decoded VideoFrames posted to present, NOT yet released
let wcGateParked = false;           // gate state for the buildlog: is the pump parked in the feed-wait?
let wcParkWatchdogs = 0;            // cumulative feed-park-watchdog force-unparks — must stay 0
let lastWcOutputAtMs = 0;          // wall ms of the last decoded WC frame (or the last (re)create) — stall detector
let wcStallRecreates = 0;          // consecutive stall-recreates without recovery → software at the budget
let lastWcRecreateAtMs = 0;        // when the last WC (re)create happened — the post-recreate forgiveness window
const WC_DECODE_QUEUE_MAX = 6;     // encoded-input ceiling — keeps decodeQueueSize single-digit
const WC_PARK_WATCHDOG_MS = 2000;  // max a feed-park may persist with the queue NOT full before we force re-evaluate
const WC_STALL_MS = 1500;          // no-output-while-queued window before a stall recreate
const WC_STALL_MAX_RECREATES = 3;  // failed recreates before the software fallback
const WC_STALL_FORGIVE_MS = 3000;  // sustained healthy output after a recreate → forgive the recreate counter
const WC_CHRONIC_RECREATES = 4;    // non-resetting per-load total → force software (just above the consecutive max)
let wcTotalRecreates = 0;          // NON-resetting per-load total → chronic-stall software fallback

function hasVideoDecoder(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';
}

/** Probe whether THIS runtime's hardware decodes `codec` (the async VideoDecoder.isConfigSupported). Called
 *  ONCE per representative family at init to fill wcCapCache — NEVER on the per-play tier path. */
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

const wcCapCache: Partial<Record<WcFamily, boolean>> = {};
let wcCapProbed = false;

/** Probe the representative codec families' HW support ONCE and cache the results. No-op without a VideoDecoder
 *  runtime. Independent of the engine → runs alongside the engine load. */
async function probeWcCapabilities(): Promise<void> {
  if (wcCapProbed) return;
  wcCapProbed = true;
  if (!hasVideoDecoder()) return;
  for (const fam of Object.keys(WC_PROBE_CODECS) as WcFamily[]) {
    wcCapCache[fam] = await wcConfigSupported(WC_PROBE_CODECS[fam]);
  }
}

function wcCapSummary(): string {
  if (!wcCapProbed || !hasVideoDecoder()) return 'no VideoDecoder';
  return (Object.keys(WC_PROBE_CODECS) as WcFamily[]).map((f) => f + '=' + (wcCapCache[f] ? '1' : '0')).join(' ');
}

// DECODE-RELIEF LEVERS (skip-non-ref / skip-loop): manual + auto (OR-folded in applySkips).
let leverSkipNonref = false;
let leverSkipLoop = false;
let autoSkipNonref = false;
let autoSkipLoop = false;
// Software deinterlace mode (0=off, 1=auto, 3=bwdif); re-applied on every SW (re)create. WC ignores it.
let deintMode = 1;

/** Apply the EFFECTIVE skip lever state (manual OR auto) to a software video decoder (no-op for WC / null vdec). */
function applySkips(v: number): void {
  if (F && v) F.vdecSetSkips(v, (leverSkipNonref || autoSkipNonref) ? 1 : 0, (leverSkipLoop || autoSkipLoop) ? 1 : 0);
}

// TRUE content frame period (µs) from the VIDEO PACKET PTS — sent to the present worker so its tier-2 PTS-cap
// targets content×tier. Median adjacent diff over a bounded window (robust to B-frame reorder + GOP/seam jumps).
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
let heldFrames = 0; // AUTHORITATIVE in-flight held-frame count (SW tier)

/** Hold the decoder's current frame and emit a `frame` message (token + Y/U/V heap offsets + strides + bit
 *  depth). Returns false (held table full → frame dropped); true on success (one credit consumed). NO copy. */
function holdAndPostFrame(w: number, h: number, cw: number, ch: number): boolean {
  if (!F || !vdec) return false;
  const token = F.vdecHold(vdec);
  if (token === 0) { frameDrops++; return false; }
  resolveVsar(); // software: a frame is decoded → vdecSar (bitstream VUI) is authoritative (no-op once resolved)
  const bitDepth = F.vdecBitdepth(vdec);
  const colorspace = F.vdecColorspace(vdec);
  const colorRange = F.vdecColorRange(vdec);
  const colorTrc = F.vdecColorTrc(vdec);
  const ptrs: [number, number, number] = [F.vdecHeldPlane(token, 0), F.vdecHeldPlane(token, 1), F.vdecHeldPlane(token, 2)];
  const lns: [number, number, number] = [F.vdecHeldLinesize(token, 0), F.vdecHeldLinesize(token, 1), F.vdecHeldLinesize(token, 2)];
  // The demux ring depth is read by MAIN now (the present overlay's demux_ring_bytes is MAIN-sourced post-split);
  // report 0 here.
  postFrame({ type: 'frame', gen, ptsUs: F.vdecPts(vdec), w, h, cw, ch, bitDepth, colorspace, colorRange, colorTrc, sarNum: vsarNum, sarDen: vsarDen, token, ptrs, lns, contentPeriodUs, demuxRingBytes: 0 });
  postedCount++;
  credits--;
  heldFrames++;
  return true;
}

/** The present worker released a retired frame: unref the held AVFrame + grant one decode credit. */
function releaseFrame(token: number): void {
  if (!F) return;
  F.vdecRelease(token);
  credits = Math.min(credits + 1, creditCap);
  if (heldFrames > 0) heldFrames--;
}

let ready: Promise<boolean>;
let resolveReady: (ok: boolean) => void;
ready = new Promise((r) => (resolveReady = r));

const log = (m: string): void => post({ type: 'log', message: m });

/** A loop tagged with `myGen` is alive only while it is the current load and not stopped. */
const alive = (myGen: number): boolean => !stop && myGen === gen;

/** Emit a fatal error AND stop the pipeline (halt the pump). */
function failFatal(kind: FerriteFailureKind, code: number, msg: string): void {
  stop = true;
  post({ type: 'error', kind, code, msg, fatal: true });
}

/** Free the current video decoder (no flag/stop changes). The demux is owned by the DEMUX worker now and the
 *  audio decoder by the AUDIO worker — there is no demux/adec here. */
function freeDecoders(): void {
  vsarNum = 1; vsarDen = 1; vsarResolved = false; // re-resolve the anamorphic SAR for the next stream
  freeWc();
  if (F && vdec) F.vdecFree(vdec);
  vdec = 0;
}

/** Close the hardware VideoDecoder (idempotent). Drain (reset) before close so no late output() strands a
 *  VideoFrame after teardown. On a LIVE mid-stream free (codec change / fallback / self-heal) tell the present
 *  worker (iOS only) to close this decoder's frames before a draw could touch the now-freed pool. */
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
  if (hadLive) {
    if (isIOS) postFrame({ type: 'dropVideoFrames', gen });
    else dlog('freeWc: live WC decoder freed mid-stream (codec change / self-heal) — ring kept (desktop)');
  }
}

/** Build a fresh hardware decoder whose output VideoFrames are TRANSFERRED to the present worker. */
function createWcDecoder(codec: string): void {
  freeWc();
  const dec = new VideoDecoder({
    output: (frame: VideoFrame) => {
      if (stop || closing || !useWc) { try { frame.close(); } catch { /* already closed */ } return; }
      wcHealthy = true;
      postedCount++;
      const nowMs = performance.now();
      lastWcOutputAtMs = nowMs;
      if (wcStallRecreates > 0 && nowMs - lastWcRecreateAtMs > WC_STALL_FORGIVE_MS) wcStallRecreates = 0;
      wcInFlight++;
      const ptsUs = frame.timestamp;
      // SAR was resolved at codec-params time (the relayed pendingVsar) — the WC tier has no local decoder to
      // read a frame SAR off, so it rides the cached value. (Display GEOMETRY is derived present-side.)
      postFrame({ type: 'vframe', gen, ptsUs, frame, sarNum: vsarNum, sarDen: vsarDen, contentPeriodUs, demuxRingBytes: 0 }, [frame]);
    },
    error: (e: DOMException) => handleWcError('' + e),
  });
  try {
    const config: VideoDecoderConfig = { codec };
    if (wcDescription) config.description = wcDescription;
    dec.configure(config);
  } catch (err) {
    log('vdec configure failed (' + codec + '): ' + err);
    vdecWc = dec;
    fallbackToSoftware();
    return;
  }
  vdecWc = dec;
  wcCodec = codec;
  wcHealthy = false;
  lastRealWcPtsUs = -1;
  awaitKeyframe = true; // WebCodecs MUST start on a keyframe after every (re)configure
  lastWcOutputAtMs = performance.now();
  lastWcRecreateAtMs = lastWcOutputAtMs;
}

/** A hardware decode error. Pre-first-frame ⇒ the tier choice was wrong ⇒ software. After healthy frames ⇒ a
 *  transient: route through the ONE error controller (decode-glitch → recreate). */
function handleWcError(msg: string): void {
  log('webcodecs decode error: ' + msg);
  if (!useWc) return;
  if (!wcHealthy) { fallbackToSoftware(); return; }
  const action = classifyError('decode-glitch', classifyCtx());
  if (action.kind === 'recreateDecoder' && wcCodec) {
    createWcDecoder(wcCodec);
  } else if (action.kind === 'fatal') {
    failFatal(action.failure ?? 'decode', -1, 'webcodecs: ' + (action.reason));
  }
}

/** The classification context for the CURRENT pipeline. The demux owns the caps now → the VIDEO worker reports
 *  the live-edge flag it was told (everConnected=true: a CodecParams/AU reaching the decode realm means it
 *  connected). One accessor so every detection site classifies against the SAME context. */
function classifyCtx(): ClassifyContext {
  return { hasLiveEdge, everConnected: true };
}

/** Switch the CURRENT video codec from the hardware tier to ffmpeg software, in place. Used when WebCodecs
 *  fails before producing a frame. VOD (length-prefixed) MUST build WITH the relayed avcC/hvcC extradata; live
 *  Annex-B builds bare (in-band SPS). */
function fallbackToSoftware(): void {
  log('webcodecs unavailable for this stream → software tier');
  freeWc();
  wcDescription = null;
  wcReframe = false; pendingVReconfig = false;
  if (F && curVcodec > 0) {
    if (vdec) F.vdecFree(vdec);
    const ed = pendingVextradata ?? new Uint8Array(0); // WITH the relayed param sets (live Annex-B / VOD avcC/hvcC); bare only if none captured yet
    F.setFastDecode(fastDecode); // AV_CODEC_FLAG2_FAST applies at open — set before creation
    vdec = F.vdecNewWithExtradata(curVcodec, threads, ed);
    if (vdec) { F.vdecSetDeint(vdec, deintMode); applySkips(vdec); }
    skipRaslUntilNonrasl = false;
  }
  useWc = false;
  tier = 'software';
  awaitKeyframe = true; // a fresh SW decoder must start on an IDR
  // A WC→SW fallback builds a brand-new SW decoder that starts on an IDR — clear any Fix-B drop-to-keyframe latch.
  chainBrokenUntilKeyframe = false;
  announce();
}

// ANAMORPHIC SAR: ONE pixel-aspect for BOTH tiers. The WebCodecs tier has no FFmpeg decoder to read a frame SAR
// off → it rides the demuxer-resolved value (relayed CodecParams pendingVsar). Software prefers its own decoded-
// frame SAR (vdecSar, bitstream VUI) once a frame exists, falling back to the relayed value. Cached per stream.
let vsarNum = 1, vsarDen = 1, vsarResolved = false;
function resolveVsar(): void {
  if (vsarResolved || !F) return;
  let n = vdec ? F.vdecSarNum(vdec) : 0;          // software: decoded-frame SAR, authoritative once a frame exists
  let d = vdec ? F.vdecSarDen(vdec) : 0;
  if (!(n > 0 && d > 0)) { n = pendingVsarNum; d = pendingVsarDen; } // the relayed demuxer SAR (WC / pre-first-frame)
  if (n > 0 && d > 0) { vsarNum = n; vsarDen = d; vsarResolved = true; }
}

/** Tell main the active tier + codecs + dims (drives statisticsInfo.tier + mediaInfo + the DAR). */
function announce(): void {
  resolveVsar();
  // MAIN merges the audio codec (it relays the audio CodecParams to the audio worker) → audioCodec: 0 here.
  post({ type: 'ready', info: { videoCodec: curVcodec, audioCodec: 0, width: annW, height: annH,
    sarNum: vsarNum, sarDen: vsarDen, tier } });
}

/** Wrap one video AU as an EncodedVideoChunk and feed the hardware decoder. NOPTS (ptsUs<0) is estimated from
 *  the last fed PTS + the observed frame interval. NO feed-side backpressure gate (the pump's decode-queue park
 *  + the present-ring drop-oldest bound it). */
function feedWc(au: Uint8Array, isKey: boolean, ptsUs: number): void {
  if (!vdecWc || vdecWc.state !== 'configured') return;
  let ts: number;
  if (ptsUs >= 0) {
    if (lastRealWcPtsUs >= 0) {
      const d = ptsUs - lastRealWcPtsUs;
      if (d > 0 && d < 1_000_000) wcFrameIntervalUs = d;
    }
    lastRealWcPtsUs = ptsUs;
    ts = ptsUs;
  } else {
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
 * Decide the video tier for a (new) codec and (re)create the right decoder. Called when the DEMUX worker
 * relays a video codec id (first or a mid-stream change), keyed off the RELAYED CodecParams (the VIDEO worker
 * has no demux). `au` is the current keyframe access unit (the exact H.264/HEVC SPS codec string + interlace
 * flag) when one is available. Ported from decode.rs setup_video_decoder.
 */
function setupVideoDecoder(vc: number, au: Uint8Array | null): void {
  if (!F) return;
  curVcodec = vc;
  skipRaslUntilNonrasl = false;
  pendingVReconfig = false; // (re)building now with whatever param sets have arrived
  const info = videoCodecInfo(vc, pendingVprofile, pendingVlevel, au);
  // SOFTWARE extradata: build the decoder WITH the relayed param sets — VOD (MP4/MKV) carries them OUT-OF-BAND
  // (avcC/hvcC) + length-prefixed NALs; live mpegts relays the captured in-band Annex-B VPS/SPS/PPS. Feeding
  // them up front lets the first IDR decode even on sparse-param streams that don't re-carry params per-IDR
  // (mirrors decode.rs). The binding falls back to bare when none have been captured yet.
  const swExtradata = pendingVextradata ?? new Uint8Array(0);
  // WebCodecs `description` (config record). VOD: the relayed extradata IS already an avcC/hvcC record
  // (byte0==1) → use as-is. LIVE: the relayed extradata is the Annex-B param sets → build the record via
  // FFmpeg's OWN mov-muxer writers (wcBuildConfig). Either way the WC tier lands on the IDENTICAL strict form
  // (out-of-band config record + length-prefixed AUs), so live converges onto VOD's proven path (the Fix-A
  // Apple/iPad HEVC fix, uniform for H.264). null until param sets land. THE KEY CHANGE: this extradata is the
  // RELAYED CodecParams `pendingVextradata`, not a local demuxVExtradata (the VIDEO worker has no demux).
  let wcDesc: Uint8Array | null = null;
  {
    const ed = pendingVextradata ?? new Uint8Array(0);
    if (ed.length > 0) {
      if (ed[0] === 1) wcDesc = ed.slice();              // already an avcC/hvcC config record (VOD container)
      else { const built = F.wcBuildConfig(ed, vc); if (built.length > 0) wcDesc = built; } // Annex-B (live) → hvcC/avcC
    }
  }
  // A WC description ⇒ OUT-OF-BAND param sets → the codec string MUST use `hvc1.` (not the in-band `hev1.`
  // videoCodecInfo emits) or Safari/Chrome reject the (hev1 + hvcC) combo → WC fails → software → black.
  if (wcDesc && info.codec.startsWith('hev1')) info.codec = info.codec.replace('hev1', 'hvc1');
  // Tier gate: sync eligibility (prefer + HW + mapped codec + PROGRESSIVE) AND the cached capability.
  let wantWc = webCodecsEligible(preferWebCodecs, hasVideoDecoder(), info);
  if (wantWc) wantWc = wcCapabilityCached(info.codec, wcCapCache);

  if (wantWc) {
    if (vdec) { F.vdecFree(vdec); vdec = 0; }
    useWc = true;
    tier = 'webcodecs';
    // A description ⇒ length-prefixed AUs. For LIVE the AUs are Annex-B, so reframe at feed time.
    wcReframe = hasLiveEdge && wcDesc !== null;
    wcDescription = wcDesc;
    createWcDecoder(info.codec); // sets awaitKeyframe; may itself fall back on a configure throw
    if (useWc) log('video codec ' + vc + " → WebCodecs '" + info.codec + "'" +
      (wcReframe ? ' (live strict: hvcC/avcC + length-prefixed)' : ''));
  } else {
    freeWc();
    wcReframe = false;
    if (vdec) F.vdecFree(vdec);
    // Build WITH the relayed param sets (live Annex-B VPS/SPS/PPS or VOD avcC/hvcC); the binding falls back to
    // bare on empty extradata (none captured yet).
    F.setFastDecode(fastDecode); // AV_CODEC_FLAG2_FAST applies at open — set before creation
    vdec = F.vdecNewWithExtradata(vc, threads, swExtradata);
    if (vdec) { F.vdecSetDeint(vdec, deintMode); applySkips(vdec); }
    useWc = false;
    tier = 'software';
    awaitKeyframe = true; // a fresh SW decoder starts on an IDR
    log('video codec ' + vc + ' → software' + (info.interlaced ? ' (interlaced)' : ''));
  }
  announce();
  // (SAR rides each `frame`/`vframe` to the present worker via sarNum/sarDen — ferrite has no separate SAR
  // message; the present worker sizes the canvas backing from those per-frame fields.)
}

self.onmessage = (e: MessageEvent<MainToWorker>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      threads = msg.threads;
      wasmBaseUrl = msg.wasmBaseUrl;
      creditCap = msg.ringCap; // single-source the software in-flight bound from main's RING_CAP
      isIOS = msg.isIOS;
      isAppleWebKit = msg.isAppleWebKit;
      fastDecode = msg.fastDecode;
      debug = msg.debug;
      void isAppleWebKit;
      // The VIDEO packet ring CONSUMER: the demux fills it; this worker drains video AUs from it.
      videoConsumer = new PacketRingConsumer(msg.videoPacketRing);
      dlog('credit cap = ' + creditCap + ' (= main RING_CAP); video packet ring attached');
      // Wire the decode↔present channel: released heap-slot tokens arrive over it; frames flow the other way.
      presentPort = msg.presentPort;
      presentPort.onmessage = (pe: MessageEvent<PresentToDecode>): void => {
        const d = pe.data;
        if (d.type === 'release') {
          for (const t of d.tokens) releaseFrame(t);
          if (d.vf) wcInFlight = Math.max(0, wcInFlight - d.vf);
        } else if (d.type === 'autoSkips') {
          autoSkipNonref = d.skipNonref;
          autoSkipLoop = d.skipLoop;
          if (!useWc && vdec) applySkips(vdec);
        } else if (d.type === 'dropToKeyframe') {
          if (!useWc && hasLiveEdge && !chainBrokenUntilKeyframe) {
            chainBrokenUntilKeyframe = true;
            log('[degrade] rung-4: chain broken — skip deltas to the next IDR, then flush');
          }
        }
      };
      log('platform: ' + (isIOS ? 'iOS' : isAppleWebKit ? 'appleWebKit' : 'other'));
      log('loading engine (video)…');
      const wcProbe = probeWcCapabilities();
      void (async () => {
        try {
          F = await loadFerrite(wasmBaseUrl, threads + 2); // decode-tier memory (MEM_DECODE default)
          postFrame({ type: 'engineMemory', memory: F.memory });
          await wcProbe;
          log('engine ready (video); wc cap: ' + wcCapSummary());
          resolveReady(true);
        } catch (err) {
          failFatal('engine-load', -1, 'engine load failed: ' + err);
          resolveReady(false);
        }
      })();
      break;
    }
    case 'load': {
      if (closing) return;
      const myGen = msg.gen;
      gen = msg.gen;
      hasLiveEdge = msg.isLive; // the demux owns the full caps; the VIDEO worker reads only the live-edge bit
      preferWebCodecs = msg.preferWebCodecs;
      void (async () => {
        if (!(await ready)) return;        // engine dead — engine-load error already posted
        if (closing || myGen !== gen) return; // destroyed, or superseded by a newer load/unload
        void run(myGen);
      })();
      break;
    }
    case 'codecParams':
      // MAIN relays only the VIDEO CodecParams here (audio goes to the AUDIO worker); guard on the stream id
      // so a stray audio relay is a no-op rather than a mis-built video decoder.
      if (msg.stream === DEMUX_STREAM_VIDEO) {
        pendingVcodec = msg.codecId;
        pendingVprofile = msg.profile;
        pendingVlevel = msg.level;
        pendingVsarNum = Math.max(1, msg.sarNum);
        pendingVsarDen = Math.max(1, msg.sarDen);
        pendingVextradata = msg.extradata.length > 0 ? msg.extradata : null;
        // LIVE: the in-band VPS/SPS/PPS can land AFTER the WC decoder was built (the codec id resolved before
        // the first keyframe → the first relay had empty extradata). Recreate the WC decoder with the hvcC/avcC
        // description on the next keyframe so the live path reaches the strict form. VOD ships the record up front.
        if (hasLiveEdge && useWc && wcDescription === null && pendingVextradata !== null) {
          pendingVReconfig = true;
        }
      }
      break;
    case 'keyframeResync':
      // A fresh segment (reconnect / resume / seek) restarts on an IDR → any in-flight drop-to-keyframe latch
      // is moot (await_keyframe now owns the IDR wait).
      awaitKeyframe = true;
      chainBrokenUntilKeyframe = false;
      break;
    case 'setPaused':
      if (msg.paused) {
        paused = true;
      } else if (paused) {
        paused = false;
        if (hasLiveEdge) awaitKeyframe = true; // LIVE resume restarts on a fresh IDR; VOD holds position
        chainBrokenUntilKeyframe = false;
      }
      break;
    case 'credit':
      credits = Math.min(credits + msg.n, creditCap);
      break;
    case 'setSkips':
      leverSkipNonref = msg.skipNonref;
      leverSkipLoop = msg.skipLoop;
      if (!useWc && vdec) applySkips(vdec);
      break;
    case 'setDeint':
      deintMode = msg.mode;
      if (F && !useWc && vdec) F.vdecSetDeint(vdec, deintMode);
      break;
    case 'unload':
      gen = msg.gen;
      stopPipeline();
      break;
    case 'destroy':
      void handleDestroy();
      break;
  }
};

// ===================== the VIDEO packet ring CONSUMER =====================
// The pump pulls video AUs from this ring (the demux fills it). It honors the PR_GEN epoch (→ keyframeResync /
// await-keyframe), PR_EOF (drain + park), and PR_FILL accounting. SPSC: this worker is the SOLE reader.
let videoConsumer: PacketRingConsumer | null = null;

async function run(myGen: number): Promise<void> {
  if (closing || !F) return;
  stop = false;
  // Seed the full ring budget HERE (ordering-independent vs a separate 'credit' post).
  credits = creditCap;
  postedCount = 0;
  paused = false;
  awaitKeyframe = false;
  chainBrokenUntilKeyframe = false; droppedToKeyAus = 0;
  lastDeintFailed = false;
  tier = 'software';
  useWc = false;
  wcInFlight = 0;
  wcGateParked = false;
  wcStallRecreates = 0; wcTotalRecreates = 0;
  lastWcOutputAtMs = 0;
  lastWcRecreateAtMs = 0;
  wcDescription = null;
  wcReframe = false; pendingVReconfig = false;
  lastWcPtsUs = 0;
  lastRealWcPtsUs = -1;
  wcFrameIntervalUs = 1_000_000 / 50;
  annW = 0; annH = 0;
  curVcodec = 0;
  skipRaslUntilNonrasl = false;
  vsarNum = 1; vsarDen = 1; vsarResolved = false;
  freeDecoders(); // release any decoder orphaned by a prior errored/superseded run
  F.vdecReleaseAll(); // reclaim any held frames still in transit from the prior load (main reset the present worker)
  frameDrops = 0;
  heldFrames = 0;
  contentPeriodUs = 0; vidPktPts.length = 0;
  autoSkipNonref = false; autoSkipLoop = false;
  stallsTotal = 0;
  void wcStallWatchdog(myGen); // LIVE/VOD-WC: HW decoder-stall self-heal (recreate, NOT a source reconnect)
  void statsLoop(myGen);
  await pump(myGen);
}

async function handleDestroy(): Promise<void> {
  if (closing) return;
  closing = true;
  stop = true;
  await Promise.race([ready.catch(() => false), sleep(READY_SETTLE_MS)]);
  stopPipeline();
  if (F) {
    try { F.shutdownThreads(); } catch (err) { log('thread shutdown: ' + err); }
  } else {
    log('destroy: engine never settled — forced teardown, pthread pool may orphan');
  }
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
  // Post the FINAL authoritative post-reap stats BEFORE the `destroyed` ack so main records the OBSERVED state.
  post({
    type: 'stats',
    stats: {
      tier, decodeFps: 0, decodedFrames: postedCount, droppedFrames: useWc ? 0 : frameDrops,
      bufferedBytes: 0, ingestKBps: 0, credits: 0, decodeQueueSize: 0,
      wcInFlight: 0, wcGateParked: 0, wcParkRecoveries: wcParkWatchdogs, wcRecreates: wcStallRecreates,
      heapBytes: F ? F.memory.buffer.byteLength : 0,
      heldFrames,
      connections: 0, // MAIN-sourced (DEMUX owns the source)
      reconnects: 0, stalls: stallsTotal, // MAIN-sourced reconnects (DEMUX owns the source); stalls = WC self-heal
      skipNonref: (!useWc && (leverSkipNonref || autoSkipNonref)) ? 1 : 0, skipLoop: (!useWc && (leverSkipLoop || autoSkipLoop)) ? 1 : 0,
      vodTotalBytes: 0, vodPositionBytes: 0, vodWindowBytes: 0, vodConnections: 0, vodReopens: 0, vodDegraded: 0,
    },
  });
  post({ type: 'destroyed' });
}

// --- the WebCodecs decoder-STALL watchdog (LIVE/VOD-WC self-heal) ---------------------------------
// DETECTION here; the ACTION is the ONE error controller's (decode-stall → recreateDecoder). A stall = encoded
// INPUT queued yet OUTPUT frozen while NOT legitimately awaiting the first keyframe. The remedy is to RESET the
// decoder (recreate + await IDR). After WC_STALL_MAX_RECREATES (or WC_CHRONIC_RECREATES total) → software.
async function wcStallWatchdog(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(500);
    if (!alive(myGen)) return;
    if (paused || !useWc || !vdecWc || vdecWc.state !== 'configured') continue;
    const action = wcStallAction({
      configured: true,
      decodeQueueSize: vdecWc.decodeQueueSize,
      msSinceOutput: performance.now() - lastWcOutputAtMs,
      awaitingKeyframe: awaitKeyframe,
      stallMs: WC_STALL_MS,
      recreates: wcStallRecreates,
      maxRecreates: WC_STALL_MAX_RECREATES,
    });
    if (action === 'none') continue;
    const q = vdecWc.decodeQueueSize | 0;
    const idle = (performance.now() - lastWcOutputAtMs) | 0;
    if (action === 'recreate') {
      const act = classifyError('decode-stall', classifyCtx());
      if (act.kind === 'recreateDecoder' && wcCodec) {
        const codec = wcCodec;
        wcStallRecreates++;
        wcTotalRecreates++;
        stallsTotal++;
        if (wcTotalRecreates >= WC_CHRONIC_RECREATES) {
          // CHRONIC stall → software ("every stream must play"). The forgive window resets the CONSECUTIVE
          // counter on each brief burst, so a bursts-then-stalls stream never reaches the consecutive Fallback
          // and loops on WC; the non-resetting per-load total forces software after enough churn.
          log('webcodecs chronically stalling (' + wcTotalRecreates + ' total recreates this load) → software tier');
          fallbackToSoftware();
        } else {
          log('webcodecs decode stall (q=' + q + ', no output ' + idle + 'ms) → recreate + await keyframe (' + wcStallRecreates + '/' + WC_STALL_MAX_RECREATES + ')');
          createWcDecoder(codec);
        }
      }
    } else { // 'fallback'
      stallsTotal++;
      log('webcodecs decode stall unrecovered after ' + wcStallRecreates + ' recreates (q=' + q + ', no output ' + idle + 'ms) → software tier');
      fallbackToSoftware();
    }
  }
}

// ===================== pump (video ring → decode → present) =====================

async function pump(myGen: number): Promise<void> {
  if (!F) return;
  const f = F;
  // Adopt the demux's CURRENT load epoch before the first checkEpoch below. videoConsumer was built at `init`
  // (before the demux bumped PR_GEN for this load), so without this its first checkEpoch would jump read→write
  // to the LIVE EDGE — discarding the buffered aligned start the demux read ahead while this worker's engine
  // loaded, desyncing video from the audio master clock (audio drains early and keeps the start) → the present
  // PLL then slews video to catch up (the startup "rush"). Mirrors the reference player building its consumer
  // on the post-engine-ready SetRings. Per-load (the pump restarts on each fresh gen); seek/reconnect epoch
  // changes still fire checkEpoch normally.
  videoConsumer?.resyncEpoch();
  let pWaitMs = 0, pLogT = 0, pLogFrames = 0, pDecMs = 0; // DIAG
  while (alive(myGen)) {
    if (DEBUG) { const _n = performance.now(); if (pLogT === 0) pLogT = _n; if (_n - pLogT >= 1000) { log(`[pump] wait=${pWaitMs | 0} dec=${pDecMs | 0} /${(_n - pLogT) | 0}ms frames=${postedCount - pLogFrames} heap=${(f.memory.buffer.byteLength / 1048576) | 0}M`); pWaitMs = 0; pDecMs = 0; pLogT = _n; pLogFrames = postedCount; } }

    // Drop a stale producer epoch (a fresh load / VOD seek): the demux bumped PR_GEN → flush + await the next
    // IDR (the demux also relays a keyframeResync, but the epoch is the authoritative drop signal here).
    if (videoConsumer && videoConsumer.checkEpoch()) {
      dlog('[seek] video packet-ring epoch changed (demux load/seek) → flush + await keyframe');
      awaitKeyframe = true;
      chainBrokenUntilKeyframe = false;
      eofDrained = false; // a fresh epoch (post-seek replay) re-arms the one-shot EOF tail drain
      if (!useWc && vdec) F.vdecFlush(vdec); // drop the stale DPB so the post-epoch IDR decodes clean
    }
    // Live pause: do NOT decode; the demux discards at the live edge. Drain+drop any pre-pause AUs left in the
    // ring so resume restarts on a fresh IDR (no stale picture).
    if (paused) {
      while (videoConsumer && videoConsumer.readAu()) { /* discard at the live edge */ }
      await sleep(20);
      continue;
    }
    // EOF: the demux signalled end-of-segment and the ring fully drained → drain the SW decoder tail then park
    // (kept alive so a seek can replay). The demux owns `ended` → MAIN; the worker just parks.
    if (videoConsumer && videoConsumer.eof() && videoConsumer.readable() === 0) {
      if (!eofDrained) { if (vdec) { F.vdecPush(vdec, 0, 0, 0n); drainVdecFrames(); } eofDrained = true; } // drain the tail ONCE, then just park
      await sleep(PUMP_IDLE_MS);
      continue;
    }
    const rec = videoConsumer ? videoConsumer.readAu() : null;
    if (!rec) { await sleep(PUMP_IDLE_MS); continue; } // ring momentarily empty
    const ptsUs = rec.ptsUs >= 0n ? Number(rec.ptsUs) : -1;
    const isKey = rec.isKey;
    const isRasl = rec.isRasl;
    feedVidPktPeriod(ptsUs); // TRUE content period (non-ref-skip-independent) → present cap

    // Universal RASL-skip. Runs BEFORE the tier split so a RASL leading picture never reaches either decoder
    // while the latch is armed (armed when an await-keyframe release landed on an IRAP key — see the WC/SW
    // gates below). The keying IRAP itself is never RASL, so it is never dropped here. A non-RASL AU (trailing
    // picture or a decodable RADL) clears the latch.
    if (skipRaslUntilNonrasl) {
      if (isRasl) {
        raslDrops = (raslDrops + 1) >>> 0;
        dlog(`[rasl] drop leading picture pts=${(ptsUs / 1e6).toFixed(1)}s (post-IRAP RASL, NoRaslOutputFlag=1; total ${raslDrops})`);
        continue; // dropped; keep draining the ring
      }
      skipRaslUntilNonrasl = false; // first non-RASL AU (trailing / RADL) → latch done
    }

    // (Re)pick the decoder on the first relayed codec / a mid-stream codec change. Tier selection lives HERE
    // (it depends on the relayed codec id + the keyframe AU's SPS).
    if (pendingVcodec > 0 && pendingVcodec !== curVcodec) {
      setupVideoDecoder(pendingVcodec, isKey ? rec.au : null);
      if (!alive(myGen)) return;
    }
    // Fix A — LIVE: the in-band param sets landed AFTER the WC decoder was built with no description (the
    // codecParams re-ship set pendingVReconfig). Recreate WITH the hvcC/avcC description on a KEYFRAME.
    if (pendingVReconfig && isKey && curVcodec > 0) {
      setupVideoDecoder(curVcodec, rec.au); // rebuilds with the now-built description; clears pendingVReconfig
      if (!alive(myGen)) return;
    }

    if (useWc) {
      if (vdecWc) {
        // (a) FEED BACKPRESSURE — HOLD (don't feed) while the decoder's OWN encoded input queue is at its
        // ceiling, so the VideoDecoder can NEVER over-fill. Gating SOLELY on decodeQueueSize (a signal the HW
        // decoder ITSELF drains) means the gate re-opens the instant a chunk decodes → it CANNOT deadlock.
        // NOTE (intentional twin-divergence — see present-worker.ts "deadlock removed at the gate"): ferrite
        // does NOT add the reference player's present-full arm (`wcInFlight >= creditCap`). ferrite's run-ahead is already
        // bounded by the demux's ~1 s packet-ring read-ahead + decodeQueueSize + the present-side drop-oldest
        // belt, and wcInFlight is decremented on the normal present draw (the LIVE-WC FIX), so a parked decoder
        // sits at the live edge with the sync-guard inert — there is no flood to pace against. The reference player keeps
        // its present_full gate as belt-and-suspenders; both are safe. wcInFlight
        // stays telemetry-only here. A stall-watchdog recreate during the sleep can swap vdecWc / re-arm
        // awaitKeyframe → re-read after.
        { const _w0 = performance.now(); wcGateParked = true;
          while (alive(myGen) && !paused && useWc && vdecWc &&
                 wcShouldWaitFeed(vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX)) {
            if (wcParkWatchdog(performance.now() - _w0, vdecWc.decodeQueueSize, WC_DECODE_QUEUE_MAX, WC_PARK_WATCHDOG_MS)) {
              wcParkWatchdogs++;
              log(`[wc] feed-park watchdog: parked ${(performance.now() - _w0) | 0}ms with q=${vdecWc.decodeQueueSize}<${WC_DECODE_QUEUE_MAX} (inflight=${wcInFlight}) → force re-evaluate`);
              break;
            }
            await sleep(4);
          }
          wcGateParked = false; pWaitMs += performance.now() - _w0; }
        if (!alive(myGen)) return;
        // (b) AWAIT-KEYFRAME HOLD — never feed a delta to a fresh / flushed decoder. Re-evaluated AFTER the wait
        // against the CURRENT decoder so a mid-wait recreate can't slip a reference-less delta through.
        if (!paused && useWc && vdecWc) {
          // Compute the gate, clear awaitKeyframe, AND arm the RASL-skip reading awaitKeyframe PRE-clear: if a
          // resume just released on an IRAP key, arm the RASL-skip so the keying CRA's own trailing RASL is
          // dropped (reading awaitKeyframe post-clear would see false → never arm → BadDataErr on all-CRA).
          const wasAwaiting = awaitKeyframe;
          const g = wcKeyframeGate(awaitKeyframe, isKey);
          if (wasAwaiting && !g.awaitingKeyframe) skipRaslUntilNonrasl = true; // resumed on an IRAP key → drop its trailing RASL
          awaitKeyframe = g.awaitingKeyframe;
          if (g.feed) {
            if (wcReframe) {
              // Fix A — live strict path: reframe the Annex-B AU → length-prefixed right before feeding (the
              // decoder is configured WITH a description → expects length-prefixed NALs). Drop a corrupt/empty
              // reframe (recovery resumes at the next keyframe). VOD's AUs are already length-prefixed.
              const reframed = F.wcReframeAu(rec.au, curVcodec);
              if (reframed.length > 0) feedWc(reframed, isKey, ptsUs);
            } else {
              feedWc(rec.au, isKey, ptsUs);
            }
          }
        }
      }
    } else if (vdec) {
      // SOFTWARE tier (the validated ffmpeg path).
      // Fix-B rung-4 drop-to-keyframe latch: skip every delta until the next IDR, then FLUSH the DPB before
      // decoding it (so the decoder doesn't predict from discarded references). Bounded loss = one GOP.
      if (chainBrokenUntilKeyframe) {
        if (!isKey) { droppedToKeyAus++; continue; }
        F.vdecFlush(vdec);
        chainBrokenUntilKeyframe = false;
        log(`[degrade] rung-4: IDR reached → flush + resume (${droppedToKeyAus} delta AUs skipped to keyframe this load)`);
      }
      // Skip video until the next IDR — after a resume/reconnect/epoch OR a cold live join. The decoder carries
      // its param sets (extradata for VOD; live gleans the in-band SPS), so the first IDR decodes cleanly;
      // pre-IDR delta AUs reference frames we don't have, so they are dropped here (mpv-faithful: wait for the
      // keyframe, never feed a pre-IDR delta — no "give up and feed garbage" fallback, which only corrupts).
      if (awaitKeyframe) {
        if (!isKey) continue;
        awaitKeyframe = false;
        // Arm the RASL-skip (tier parity with the WC gate): resumed on an IRAP key → drop its trailing RASL. On
        // SW this only pre-empts what FFmpeg's hevcdec would discard internally (NoRaslOutput) — a harmless
        // no-op that keeps both tiers in lockstep.
        skipRaslUntilNonrasl = true;
      }
      // Push the encoded AU bytes (copy-in form — the AU is a JS Uint8Array out of the ring, not engine heap).
      { const _t = performance.now(); F.vdecPushAu(vdec, rec.au, rec.ptsUs); pDecMs += performance.now() - _t; }
      const df = F.vdecDeintFailed(vdec) === 1;
      if (df !== lastDeintFailed) { lastDeintFailed = df; post({ type: 'deintFailed', failed: df }); }
      for (;;) {
        { const _t = performance.now(); const _m = F.vdecStep(vdec) === 1; pDecMs += performance.now() - _t; if (!_m) break; }
        const w = F.vdecW(vdec), h = F.vdecH(vdec), cw = F.vdecCw(vdec), ch = F.vdecCh(vdec);
        if (w <= 0 || h <= 0 || cw <= 0 || ch <= 0) continue;
        if (w !== annW || h !== annH) { annW = w; annH = h; announce(); }
        // Gate the hold+post on the PRESENT CREDIT budget (= RING_CAP). WAIT for a free slot so the video
        // sequence stays CONTIGUOUS (dropping would punch a PTS hole → the present freezes). The wait is ~one
        // frame-time; the present releases a slot per drawn frame.
        while (alive(myGen) && !paused && credits <= 0) { const _w = performance.now(); await sleep(4); pWaitMs += performance.now() - _w; }
        if (!alive(myGen) || paused) break;
        if (!holdAndPostFrame(w, h, cw, ch)) continue;
      }
    }
  }
}

/** Drain the SOFTWARE video decoder, posting each frame (used on a clean EOF drain; the loop above already
 *  gated on credits). Re-announces on a resolution change. */
function drainVdecFrames(): void {
  if (!F || !vdec) return;
  while (F.vdecStep(vdec) === 1) {
    const w = F.vdecW(vdec), h = F.vdecH(vdec), cw = F.vdecCw(vdec), ch = F.vdecCh(vdec);
    if (w <= 0 || h <= 0 || cw <= 0 || ch <= 0) continue;
    if (w !== annW || h !== annH) { annW = w; annH = h; announce(); }
    holdAndPostFrame(w, h, cw, ch);
  }
}

// ===================== stats loop =====================
const STATS_INTERVAL_MS = 500;

async function statsLoop(myGen: number): Promise<void> {
  let lastFrames = postedCount, lastT = performance.now();
  while (alive(myGen)) {
    await sleep(STATS_INTERVAL_MS);
    if (!alive(myGen)) return;
    const now = performance.now();
    const dt = now - lastT;
    const fps = ((postedCount - lastFrames) * 1000) / dt;
    lastFrames = postedCount; lastT = now;
    post({
      type: 'stats',
      stats: {
        tier,
        decodeFps: Math.round(fps),
        decodedFrames: postedCount,
        droppedFrames: useWc ? 0 : frameDrops,
        bufferedBytes: 0,  // MAIN reads the packet-ring depth directly (telemetry)
        ingestKBps: 0,     // MAIN-sourced (DEMUX owns the source)
        credits: useWc ? 0 : Math.max(0, credits),
        decodeQueueSize: (vdecWc && vdecWc.state === 'configured') ? vdecWc.decodeQueueSize : 0,
        wcInFlight: useWc ? wcInFlight : 0,
        wcGateParked: (useWc && wcGateParked) ? 1 : 0,
        wcParkRecoveries: wcParkWatchdogs,
        wcRecreates: wcStallRecreates,
        heapBytes: F ? F.memory.buffer.byteLength : 0,
        heldFrames: useWc ? 0 : heldFrames,
        connections: 0, // MAIN-sourced (DEMUX owns the source)
        reconnects: 0,  // MAIN-sourced (DEMUX owns the source)
        stalls: stallsTotal,
        skipNonref: (!useWc && (leverSkipNonref || autoSkipNonref)) ? 1 : 0,
        skipLoop: (!useWc && (leverSkipLoop || autoSkipLoop)) ? 1 : 0,
        vodTotalBytes: 0, vodPositionBytes: 0, vodWindowBytes: 0, vodConnections: 0, vodReopens: 0, vodDegraded: 0,
      },
    });
  }
}

/** Free the current decoders but keep the engine `F` loaded. */
function stopPipeline(): void {
  stop = true;
  freeDecoders();
  if (F) F.vdecReleaseAll(); // reclaim any held frames in transit (main reset the present worker on unload)
  credits = 0;
  heldFrames = 0;
  wcInFlight = 0;
  paused = false;
  awaitKeyframe = false;
  chainBrokenUntilKeyframe = false; droppedToKeyAus = 0;
  lastDeintFailed = false;
  useWc = false;
  tier = 'software';
  curVcodec = 0;
  pendingVcodec = 0;
  pendingVextradata = null;
  pendingVReconfig = false;
  wcDescription = null;
  wcReframe = false;
  skipRaslUntilNonrasl = false;
  autoSkipNonref = false; autoSkipLoop = false;
}
