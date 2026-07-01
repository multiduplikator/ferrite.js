// AUDIO worker (audio decode isolated; the audio packet ring is now filled by the DEMUX worker).
//
// WHY (decode isolation): the audio decode worker in the mpv-style topology runs on its OWN thread with its
// OWN ferrite instance (a small realm, ferritePool=1), so heavy software video decode in the VIDEO worker can
// never block it — the structural fix for the whole stutter bug class. It CONSUMES the AUDIO PACKET RING the
// DEMUX worker fills (the producer moved there from the combined worker) (PacketRingConsumer), builds the audio decoder from the relayed
// CodecParams (audioNew for live ADTS; the ASC extradata for VOD AAC), runs audioPush→audioStep (the engine
// downmixes 6→2 + resamples to the ctx rate), and BECOMES THE PCM RING PRODUCER: it writes decoded
// interleaved-stereo PCM straight into the PCM ring SAB the persistent worklet (on MAIN) consumes — no PCM
// postMessage, no MAIN hop. It also publishes the media-PTS clock edge map + continuity rebase, folds
// loudness (RMS), and posts ~2 Hz audio telemetry + the circuit-breaker degrade + the mpv cache-pause
// rebuffer signal to MAIN. Ported from the reference player's audio-decode worker (the whole worker).
//
// Realm split: MAIN keeps the AudioContext/worklet/GainNode/volume/mute/RW_PLAYING authority/PCM+clock SAB
// alloc + the AGC makeup gain (DOM-bound). RW_PLAYING is MAIN's SOLE writer; the worker NEVER stores it (a
// chunk decoded in the async window between MAIN's pause 0-store and the worker receiving setPaused would
// re-arm output → audio + the master clock advance THROUGH the pause).
//
// The producer functions (writePcmChunk / publishClockAnchor / measureLoudness / pcmHasRoom / resetEpoch /
// rebufferTick / postAudioStats) MOVED here VERBATIM from worker.ts (they previously lived there). The one upgrade:
// rebufferTick's cache-pause ENTER now gates on the REAL signal — `audioConsumer.readable() === 0` (no audio
// packets left to decode) — closing the Stage-2 `feedDone` approximation (audio_decode.rs's packets_empty).

import { Ferrite, loadFerrite, MEM_AUDIO_INIT, MEM_AUDIO_MAX } from './ferrite-bindings';
import type { MainToAudio, AudioToMain } from '../protocol';
import {
  RING_CHANNELS, RING_CTRL_SLOTS, RW_BASE_MS, RW_EDGE_FRAME, RW_EDGE_PTS_MS, RW_EPOCH_SEQ,
  RW_GEN, RW_OVERWRITES, RW_RATE, RW_READ, RW_WRITE,
} from '../audio-ring';
import {
  LOUDNESS_TAU_SECS, LOUDNESS_SILENCE_GATE_MS, PEAK_DECAY_TAU_SECS,
  CACHE_PAUSE_ENTER_SECS, CACHE_PAUSE_RESUME_SECS, REBUFFER_TICK_MS,
} from '../audio-constants';
import { PacketRingConsumer } from './packet-ring-io';

// ---- constants (ported from audio_decode.rs) ----
const STATS_INTERVAL_MS = 500;       // ~2 Hz stats post
const PUMP_IDLE_MS = 4;              // pump sleep when the audio ring is momentarily empty / PCM full
const SEEK_BLOCK_MAX_TICKS = 250;   // ~2s @8ms: wedge-breaker for the seek-block (epoch-already-consumed race)
const READY_SETTLE_MS = 12000;      // destroy wedge-breaker: max wait for a hung loadFerrite
// Audio circuit-breaker: consecutive audio packets that decode to ZERO frames before we give up on the audio
// track (e.g. an EAC3/Atmos variant the WASM decoder can't handle) and post `audioDegraded`.
const AUDIO_DECODE_FAIL_LIMIT = 30;

const post = (m: AudioToMain): void => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (m: string): void => post({ type: 'log', message: m });

let F: Ferrite | null = null;
let wasmBaseUrl = '/';
let isIOS = false;        // stored for parity / future platform forks (the audio realm has none today)
let isAppleWebKit = false;
let debug = false;
const dlog = (m: string): void => { if (debug) log(m); };

let adec = 0;
let stop = false;
let closing = false;     // 'audioDestroy' received → terminal; gates load/run
let gen = 0;             // current load generation; loops capture it and self-cancel when it changes
let paused = false;
let isLive = true;       // mid-stream PTS-JUMP rebase is LIVE-ONLY (VOD audio PTS is monotonic)
let buffering = false;   // mpv cache-pause: the worker has signalled MAIN that the PCM output starved
// VOD seek-block (mpv SEEK_BLOCK): set by audioSeekFlush, cleared when the demux packet-ring seek epoch is
// observed. While true the pump decodes NOTHING — so no still-buffered PRE-seek packet can play or anchor
// C_ACLOCK. The packet-ring epoch flip then arms the rebase and the first POST-seek chunk re-anchors.
let seeking = false;
let seekingTicks = 0;    // wedge-breaker: bounded iterations the pump will block on `seeking` (epoch-race safety)

let curAcodec = 0;
let pendingAcodec = 0;          // relayed codec id (decoder built lazily from it)
let pendingAextradata: Uint8Array | null = null; // VOD ASC (empty/null for live ADTS) — DEFERRED build
let audioOutRate = 0;           // engine audio OUTPUT rate (= ctx rate); 0 = passthrough
let drcMode = 0;                // AC3/EAC3 DRC: 0=line, 1=RF/heavy, 2=loudness
let audioDecodeFails = 0;       // circuit-breaker (consecutive zero-frame decodes)

// ===================== PCM RING PRODUCER (moved verbatim from worker.ts) =====================
// This worker BECOMES the PCM-ring PRODUCER: decoded interleaved-stereo PCM is written STRAIGHT into the PCM
// ring SAB (src/audio-ring.ts) the persistent AudioWorklet (on MAIN) consumes — no postMessage, no PCM
// transfer, no MAIN hop. It also publishes the media-PTS clock edge map + continuity rebase, folds loudness
// (RMS), and posts ~2 Hz audio telemetry + the mpv cache-pause rebuffer signal to MAIN.
let pcmCtrl: Int32Array | null = null;   // PCM ring control region (the RW_* atomics) — null until audioSetPcmRing
let pcmData: Float32Array | null = null; // PCM ring interleaved-stereo data region
let pcmCap = 0;                          // PCM ring capacity in FRAMES (per channel)
let pcmGen = 0;                          // producer EPOCH — bumped on a (non-coalesced) resetEpoch
let sampleRate = 0;                      // RW_RATE value (from MAIN, = ctx.sampleRate); clock denominator
let clockSeq = 0;                        // seqlock counter over {RW_BASE_MS, RW_EDGE_*} (odd = mid-publish)
let freshAnchor = true;                  // re-anchored with no chunk produced since → a second resetEpoch
                                         // COALESCES its RW_GEN bump instead of dropping fresh audio
let audioActive = false;                 // a real PCM chunk has been written into the ring this epoch
let audioEdgePtsUs = 0;                  // edge map: the engine media PTS (µs) at audioEdgeFrame
let audioEdgeFrame = 0;                  // edge map: the write-cursor (frames) the published edge PTS belongs to
let audioClockRebase = true;            // next chunk rebases the elapsed origin (fresh ring / re-anchor / disc)
// loudness / peak (the AGC fold — runs where the PCM lives).
let audioLoudnessMs = 0;                 // integrated mean-square (EWMA)
let audioLoudnessDb = 0;                 // RMS-dBFS loudness proxy (10·log10(meanSq))
let audioPeak = 0;                       // windowed peak |sample| (decaying) — the peak-aware makeup cap
let audioSrcScratch = new Float32Array(0); // reusable fold scratch (no per-chunk alloc)
let nonstereoWarned = false;             // one-shot guard for the stereo-invariant warning
// telemetry rows (posted ~2 Hz on the stats cadence).
let audioDrops = 0;                      // chunks dropped (full ring / non-stereo invariant)
let audioScheduledAhead = 0;             // buffered audio ahead of the read cursor (s) — the live-latency proxy
let audioSrcChannels = 0;                // decoded SOURCE channels pre-downmix (6 for EAC3 5.1) — overlay "6→2ch"
let audioStreamRate = 0;                 // decoded source sample rate (Hz) — overlay "48.0→ctx48.0k"
let lastAudioStatsAt = 0;               // last audioStats post (performance.now ms) — ~2 Hz time-gate

let audioConsumer: PacketRingConsumer | null = null; // the demux-filled audio AU ring (sole reader)

/** Apply the current audio output options (resample rate + DRC mode) to the live audio decoder. */
function applyAudioOpts(a: number): void {
  if (F && a) { F.audioSetOutRate(a, audioOutRate); F.audioSetDrc(a, drcMode); }
}

/** Build the audio decoder from the relayed `pendingAcodec` on the first audio AU / a codec change. Live
 *  ADTS/AC3/EAC3/MP2 is self-describing (codec id only → bare audioNew, which audioNewWithExtradata falls
 *  back to on empty extradata); VOD MP4/MKV AAC carries the AudioSpecificConfig out-of-band
 *  (pendingAextradata) → audioNewWithExtradata. Ported from audio_decode.rs::ensure_audio_decoder. */
function ensureAudioDecoder(): void {
  if (!F) return;
  const ac = pendingAcodec;
  if (ac > 0 && ac !== curAcodec) {
    if (adec) F.audioFree(adec);
    const ed = pendingAextradata ?? new Uint8Array(0);
    adec = F.audioNewWithExtradata(ac, ed);
    if (adec) { curAcodec = ac; applyAudioOpts(adec); }
  }
}

/** PCM ring PRODUCER: write one decoded interleaved-stereo chunk into the PCM ring for the persistent worklet
 *  (on MAIN) to consume. Ported from audio_decode.rs::write_pcm_chunk (← facade::play_audio): pulls
 *  channels/samples/rate/pts from the engine, folds loudness, drops-to-live when the worklet's clock free-ran
 *  past us during an underrun, drops the chunk on a full ring, copies the interleaved samples in up to two
 *  contiguous spans (wrap at cap), advances RW_WRITE, then publishes the media-PTS edge map + continuity
 *  rebase under the seqlock. The worker must NOT write RW_PLAYING (MAIN owns it). */
function writePcmChunk(a: number): void {
  if (!F || paused) return;
  const channels = F.audioChannels(a);
  const rate = F.audioRate(a);
  const samples = F.audioSamples(a); // per channel
  if (channels === 0 || samples === 0) return;
  audioSrcChannels = F.audioSrcChannels(a); // pre-downmix source channels (telemetry); output is always stereo
  audioStreamRate = rate;

  // Copy interleaved PCM out of the engine heap into a fresh, aligned Float32Array (survives a heap grow).
  const interleaved = F.audioCopy(F.audioInterleavedPtr(a), samples * channels);
  const ptsUs = Number(F.audioPtsUs(a));
  const sr = rate;
  const total = interleaved.length;
  const frames = (total / channels) | 0;
  if (frames === 0) return;

  // Loudness fold — over the PCM copied into reused scratch (no per-channel alloc). measureLoudness reads
  // audioSrcScratch[0..total].
  if (audioSrcScratch.length < total) audioSrcScratch = new Float32Array(total);
  audioSrcScratch.set(interleaved.subarray(0, total));
  const chunkSecs = sr > 0 ? frames / sr : 0;
  measureLoudness(total, chunkSecs);

  // ---- ring producer ----
  const ctrl = pcmCtrl, data = pcmData;
  if (!ctrl || !data) return;
  const cap = pcmCap;
  if (cap <= 0) return;
  if (channels !== RING_CHANNELS) {
    // The ring is stereo-only (the engine guarantees a stereo downmix), so this should NEVER fire — a
    // non-stereo chunk would mis-stride the interleave. Make the invariant violation OBSERVABLE (one warn +
    // a counter) rather than a SILENT drop that would manifest as total silence with no diagnostic if a
    // future engine change broke the stereo guarantee.
    audioDrops++;
    if (!nonstereoWarned) {
      nonstereoWarned = true;
      log('[audio] INVARIANT: engine emitted ' + channels + '-ch (expected stereo) — chunk dropped');
    }
    return;
  }
  const read = Atomics.load(ctrl, RW_READ);
  let write = Atomics.load(ctrl, RW_WRITE);
  // Drop-to-live: if the worklet's clock free-ran past the producer during an underrun (read > write), skip
  // the gap it already played through instead of writing behind the live edge.
  if (write < read) write = read;
  const writable = cap - (write - read); // write >= read here → 0..=cap
  if (frames > writable) {
    // Ring full: the consumer is behind (latency pinned at the ring ceiling) — this chunk WOULD lap unread
    // data. DROP it (a brief gap is far cheaper than corrupting the read window).
    audioDrops++;
    Atomics.add(ctrl, RW_OVERWRITES, 1);
    audioScheduledAhead = sr > 0 ? cap / sr : 0; // pinned at the ring ceiling (the live-latency proxy)
    return;
  }
  // Copy the interleaved samples into the ring in up to two contiguous spans (wrap at cap).
  const ch = RING_CHANNELS;
  const startPos = ((write % cap) + cap) % cap; // frame
  const firstFrames = Math.min(cap - startPos, frames);
  data.set(interleaved.subarray(0, firstFrames * ch), startPos * ch);
  if (firstFrames < frames) {
    data.set(interleaved.subarray(firstFrames * ch, frames * ch), 0);
  }
  Atomics.store(ctrl, RW_WRITE, write + frames);
  // RW_PLAYING is MAIN's SOLE writer: MAIN arms =1 on play()/ensureAudio (when not paused) and 0s on
  // pause/unload/degrade. The worker must NOT store 1 here — a chunk decoded in the async window between
  // MAIN's synchronous pause/unload 0-store and the worker receiving setPaused would re-arm output → audio +
  // the master clock advance THROUGH the pause (A/V time-jump on resume; a stuck 1 on a torn-down ring at
  // unload). The worklet gates output on RW_PLAYING==0; MAIN owns it.
  freshAnchor = false; // produced a chunk → the next resetEpoch is a real re-anchor (not a coalesced no-op)
  audioActive = true;
  audioScheduledAhead = sr > 0 ? Math.max(0, write + frames - read) / sr : 0;
  // Anchor the ring write edge to the engine's real media PTS (chunk START boundary).
  if (Number.isFinite(ptsUs) && ptsUs >= 0 && sr > 0) {
    const edgeFrame = write;
    const edgePtsMs = ptsUs / 1000;
    // Detect a fresh ring / re-anchor / PTS discontinuity. The explicit rebase (fresh ring / seek) applies to
    // BOTH live and VOD. The mid-stream PTS-JUMP detection is LIVE ONLY (loop / ad splice / reconnect): VOD
    // audio PTS is monotonic + contiguous, so a jump there is a glitch, not a seam — rebasing base=0 on it
    // resets C_ACLOCK and desyncs the master clock (the VOD regression).
    const d = ptsUs - audioEdgePtsUs;
    const disc = audioClockRebase
      || (isLive && audioEdgeFrame > 0 && !(d >= 0 && d <= 500_000));
    audioEdgePtsUs = ptsUs;
    audioEdgeFrame = edgeFrame;
    let baseToPublish: number | null;
    if (disc) {
      // DIRECT-CLOCK model: C_ACLOCK is the ABSOLUTE heard media PTS (base=0 ⇒ C_ACLOCK = edgePts −
      // buffered), so at a discontinuity it RESETS to the new content's PTS — matching the video frames (also
      // absolute), which the present re-anchors to via its SEAM detection. The OLD elapsed-continuous rebase
      // kept C_ACLOCK counting ACROSS the seam while the video reset → a whole-clip A/V divergence.
      audioClockRebase = false;
      baseToPublish = 0;
    } else {
      baseToPublish = null; // steady chunk: only the edge moves; base unchanged (consistent under the seqlock)
    }
    // publish base + the edge pair as ONE seqlock-guarded group (no torn tuple).
    publishClockAnchor(ctrl, baseToPublish, edgeFrame, Math.round(edgePtsMs));
  }
}

/** Seqlock-publish the clock-anchor tuple {RW_BASE_MS?, RW_EDGE_FRAME, RW_EDGE_PTS_MS}: bump RW_EPOCH_SEQ
 *  ODD, store the slots, bump EVEN — so the worklet (and MAIN's av_diff) never compose a torn tuple (a new
 *  edge with a stale base at a disc/reset seam → a spiked clock). This worker is the SOLE producer → plain
 *  stores on the seq suffice. `baseMs = null` leaves RW_BASE_MS unchanged. */
function publishClockAnchor(ctrl: Int32Array, baseMs: number | null, edgeFrame: number, edgePtsMs: number): void {
  clockSeq = (clockSeq + 1) | 0; // → odd: mid-publish
  Atomics.store(ctrl, RW_EPOCH_SEQ, clockSeq);
  if (baseMs !== null) Atomics.store(ctrl, RW_BASE_MS, baseMs);
  Atomics.store(ctrl, RW_EDGE_FRAME, edgeFrame);
  Atomics.store(ctrl, RW_EDGE_PTS_MS, edgePtsMs);
  clockSeq = (clockSeq + 1) | 0; // → even: a consistent snapshot is visible
  Atomics.store(ctrl, RW_EPOCH_SEQ, clockSeq);
}

/** Integrate this chunk's loudness — ported from audio_decode.rs::measure_loudness. Mean-square over the
 *  scratch PCM → a long time-constant EWMA → an RMS-dBFS loudness proxy. Silence-gated. Also relaxes the
 *  windowed peak so a single transient eases over ~PEAK_DECAY_TAU_SECS. */
function measureLoudness(total: number, chunkSecs: number): void {
  if (total === 0 || chunkSecs <= 0) return;
  let sumSq = 0, peak = 0;
  for (let i = 0; i < total; i++) {
    const s = audioSrcScratch[i];
    sumSq += s * s;
    const av = Math.abs(s);
    if (av > peak) peak = av;
  }
  // Windowed peak (decays so one transient relaxes over ~PEAK_DECAY_TAU_SECS) — the makeup-gain cap reads
  // this so a +boost can never push the loudest recent sample past full scale (mpv ReplayGain
  // `gain = min(gain, 1/peak)`). Updated even on near-silent chunks so the peak can decay.
  const decay = Math.exp(-chunkSecs / PEAK_DECAY_TAU_SECS);
  audioPeak = Math.max(peak, audioPeak * decay);
  const meanSq = sumSq / total;
  if (meanSq < LOUDNESS_SILENCE_GATE_MS) return; // near-silent — hold the last loudness (peak already updated)
  const alpha = Math.min(chunkSecs / LOUDNESS_TAU_SECS, 1);
  audioLoudnessMs = audioLoudnessMs <= 0 ? meanSq /* seed */ : audioLoudnessMs + alpha * (meanSq - audioLoudnessMs);
  audioLoudnessDb = 10 * Math.log10(audioLoudnessMs);
}

/** BACKPRESSURE: does the PCM ring have room for another decoded chunk? The audio worker must NOT decode
 *  ahead of the worklet's REALTIME consumption. The decode split removed the old single-pump video credit-
 *  wait that paced the whole pipeline, so an unpaced/bursty demux flood would otherwise make this worker
 *  decode far ahead → writePcmChunk drops on the full ring → the sparse chunks it does land have an edge_pts
 *  far ahead of their edge_frame → the media-PTS master clock RACES → the picture collapses. Pacing the
 *  decode to the ring's drain rate keeps edge_pts/edge_frame contiguous (clock = 1×). ~0.125 s headroom so a
 *  single decoded chunk never trips the drop path. Ported from audio_decode.rs::pcm_has_room. */
function pcmHasRoom(): boolean {
  const ctrl = pcmCtrl;
  if (!ctrl) return false;
  const cap = pcmCap;
  if (cap <= 0) return false;
  const write = Atomics.load(ctrl, RW_WRITE);
  const read = Atomics.load(ctrl, RW_READ);
  const margin = Math.max((sampleRate / 8) | 0, 4096); // ~0.125 s at the ctx rate
  return Math.max(0, write - read) + margin < cap;
}

/** Bump RW_GEN + flush the PCM ring; optionally arm the media-clock rebase. Producer-owned (this worker does
 *  the SAB writes). Ported from audio_decode.rs::reset_epoch. `armRebase=true` (fresh load / live restart /
 *  channel switch / the post-seek packet-ring epoch) lets the NEXT decoded chunk re-anchor C_ACLOCK;
 *  `armRebase=false` (audioSeekFlush) flushes WITHOUT arming, so a still-buffered PRE-seek chunk can't anchor
 *  to the old position — the post-seek epoch arms it instead. COALESCES the RW_GEN bump while freshAnchor (no
 *  chunk produced since the last anchor) so back-to-back resets collapse to ONE worklet read=write jump (else
 *  every channel switch drops a few freshly-decoded chunks → an audible startup transient). */
function resetEpoch(armRebase: boolean): void {
  // The arming is always safe to repeat (the first chunk's `disc` rebase reads these).
  audioActive = false;
  audioEdgePtsUs = 0;
  audioEdgeFrame = 0;
  if (armRebase) audioClockRebase = true;
  if (freshAnchor) {
    dlog('[seek] audio resetEpoch COALESCED (freshAnchor → no RW_GEN bump)');
    return; // COALESCE: freshly anchored, no chunk produced since → no RW_GEN bump (collapse the resets)
  }
  const ctrl = pcmCtrl;
  if (ctrl) {
    // Re-anchor the media-PTS clock to ~0 at the live edge: set the edge frame to the current write (where
    // the worklet jumps read on the gen change) with base/edgePts 0 → the next quantum evaluates
    // `0 + 0 − (write − write)/rate = 0` (the same clean ~0 start as a fresh ring). The tuple goes through
    // the seqlock; RW_GEN (the worklet's read=write jump) bumps AFTER it.
    const write = Atomics.load(ctrl, RW_WRITE);
    publishClockAnchor(ctrl, 0, write, 0);
    pcmGen = (pcmGen + 1) | 0;
    Atomics.store(ctrl, RW_GEN, pcmGen);
    dlog('[seek] audio resetEpoch BUMPED RW_GEN=' + pcmGen + ' @write=' + write +
         ' (clock→0, rebase=' + (armRebase ? 'armed' : 'NOT armed (seek-block)') + ')');
  }
  freshAnchor = true;
}

/** mpv cache-pause monitor tick (ported from audio_decode.rs::rebuffer_tick). The PCM ring depth (s) — the
 *  heard reservoir — plus whether the audio packet ring is empty (nothing left to decode) → ENTER buffering
 *  on real starvation, EXIT once the buffer is rebuilt past the resume cushion. Transitions are posted to
 *  MAIN, which freezes/resumes the clock (RW_PLAYING) + the present. No-op while paused / not producing.
 *
 *  REAL packet-empty gate (closes the Stage-2 `feedDone` approximation): here we DO have the audio packet
 *  ring, so ENTER gates on `audioConsumer.readable() === 0` — the actual "no encoded packets to decode"
 *  signal — exactly like audio_decode.rs. mpv gates on a REAL underrun + low cache, not merely low cache:
 *  the empty packet ring is the "low cache" half and the near-empty PCM is the "real underrun" half, so a
 *  bursty-CDN cadence (packets still arriving) won't false-trip. */
function rebufferTick(): void {
  if (paused || !audioActive) return;
  const ctrl = pcmCtrl;
  if (!ctrl) return;
  const rate = sampleRate;
  if (rate <= 0) return;
  const write = Atomics.load(ctrl, RW_WRITE);
  const read = Atomics.load(ctrl, RW_READ);
  const depthSecs = Math.max(0, write - read) / rate;
  if (!buffering) {
    // ENTER: PCM critically low AND no encoded packets to decode = genuinely out of data.
    const packetsEmpty = !audioConsumer || audioConsumer.readable() === 0;
    if (depthSecs < CACHE_PAUSE_ENTER_SECS && packetsEmpty) {
      buffering = true;
      post({ type: 'audioRebuffer', buffering: true });
    }
  } else if (depthSecs >= CACHE_PAUSE_RESUME_SECS) {
    // EXIT: the worker rebuilt the buffer past the resume cushion → resume from the frozen position.
    buffering = false;
    post({ type: 'audioRebuffer', buffering: false });
  }
}

/** Post the ~2 Hz audio telemetry to MAIN (folds into getStats() + drives the makeup-gain). `scheduledAhead`
 *  rides as the buffered-audio depth. Time-gated so it can be called from the per-chunk drain and the stats
 *  loop without flooding. Mirrors audio_decode.rs::post_stats. */
function postAudioStats(force = false): void {
  const now = performance.now();
  if (!force && now - lastAudioStatsAt < STATS_INTERVAL_MS) return;
  lastAudioStatsAt = now;
  post({ type: 'audioStats', active: audioActive, loudnessDb: audioLoudnessDb, peak: audioPeak,
         drops: audioDrops, scheduledAhead: audioScheduledAhead,
         srcChannels: audioSrcChannels, streamRate: audioStreamRate });
}

/** Reset the producer's per-load loudness/peak/telemetry. Called on a fresh load / per-decoder reset
 *  alongside resetEpoch(true). Mirrors audio_decode.rs's free_decoder + run() loudness reset (a fresh stream
 *  re-levels per channel). */
function resetAudioProducerState(): void {
  audioLoudnessMs = 0;
  audioLoudnessDb = 0;
  audioPeak = 0;
  audioDrops = 0;
  audioScheduledAhead = 0;
  buffering = false;
  nonstereoWarned = false;
}

// ===================== decoder drain + circuit-breaker =====================

/** Drain the audio decoder, writing each PCM chunk into the PCM ring (the producer). Circuit-breaker:
 *  AUDIO_DECODE_FAIL_LIMIT consecutive AUs that decode to zero frames → trip → silent-audio (video
 *  continues). Ported from audio_decode.rs::drain_audio. */
function drainAudio(): void {
  if (!F || !adec) return;
  let produced = false;
  while (F.audioStep(adec) === 1) {
    produced = true;
    writePcmChunk(adec);
  }
  if (produced) {
    audioDecodeFails = 0;
  } else {
    audioDecodeFails++;
    if (audioDecodeFails >= AUDIO_DECODE_FAIL_LIMIT) tripAudioBreaker();
  }
}

/** Circuit-breaker tripped: free the audio decoder + tell MAIN to degrade to silent-audio. */
function tripAudioBreaker(): void {
  if (F && adec) { F.audioFree(adec); adec = 0; }
  audioActive = false;
  log('audio circuit-breaker: ' + AUDIO_DECODE_FAIL_LIMIT +
      ' consecutive decode failures → silent-audio (video continues)');
  post({ type: 'audioDegraded' });
}

/** Free the audio decoder + reset the per-load fail/degrade/buffering state (no flag/stop changes). */
function freeDecoder(): void {
  audioDecodeFails = 0;
  buffering = false; // a fresh decoder/load → clear the cache-pause state (MAIN re-establishes it)
  audioPeak = 0;
  nonstereoWarned = false;
  if (F && adec) F.audioFree(adec);
  adec = 0;
}

/** Free the audio decoder + reset per-load state, keep the engine `F` loaded. */
function stopPipeline(): void {
  stop = true;
  freeDecoder();
  paused = false;
  curAcodec = 0;
  pendingAcodec = 0;
  pendingAextradata = null;
  audioActive = false;
  seeking = false; // a new load/unload supersedes any in-flight seek-block
}

// ===================== readiness (engine load) =====================

let ready: Promise<boolean>;
let resolveReady: (ok: boolean) => void;
ready = new Promise((r) => (resolveReady = r));

/** A loop tagged with `myGen` is alive only while it is the current load and not stopped. */
const alive = (myGen: number): boolean => !stop && myGen === gen;

// ===================== message dispatch =====================

self.onmessage = (e: MessageEvent<MainToAudio>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'audioInit':
      wasmBaseUrl = msg.wasmBaseUrl;
      isIOS = msg.isIOS;
      isAppleWebKit = msg.isAppleWebKit;
      debug = msg.debug;
      void isAppleWebKit; void isIOS; // stored for parity; the audio realm has no platform fork today
      audioConsumer = new PacketRingConsumer(msg.audioPacketRing);
      dlog('audio packet ring attached');
      // ferritePool=1 → audio decode is single-pthread-light (keeps audio off the video pool). The small
      // realm (16 MiB init / 32 MiB cap) never grows into the decode tier. +2 keeps the same call shape as
      // the siblings (audio + downmix + resample headroom over the 1 decode pthread).
      void handleInitLoad();
      break;
    case 'audioSetPcmRing': {
      // PCM ring producer views: MAIN alloc'd + seeded the SAB; we write the producer slots directly.
      // RW_RATE comes from MAIN (it owns ctx.sampleRate) — store it once here.
      const sab = msg.pcmRing;
      const ctrl = new Int32Array(sab, 0, RING_CTRL_SLOTS);
      pcmData = new Float32Array(sab, RING_CTRL_SLOTS * 4);
      pcmCap = msg.pcmRingCap;
      sampleRate = Math.round(msg.sampleRate);
      audioOutRate = sampleRate; // engine resamples to the ctx rate (= the ring rate)
      Atomics.store(ctrl, RW_RATE, sampleRate);
      pcmGen = Atomics.load(ctrl, RW_GEN); // adopt the gen MAIN seeded (the worklet matches it)
      pcmCtrl = ctrl;
      audioClockRebase = true;
      // Re-apply opts now the engine output rate is known (the decoder may already exist on a re-anchor).
      if (adec) applyAudioOpts(adec);
      dlog('PCM ring attached');
      break;
    }
    case 'audioCodecParams':
      pendingAcodec = msg.codecId;
      pendingAextradata = msg.extradata.length > 0 ? msg.extradata : null;
      break;
    case 'audioLoad':
      void handleLoad(msg.gen, msg.isLive);
      break;
    case 'audioSetPaused':
      paused = msg.paused;
      break;
    case 'audioResetEpoch':
      resetEpoch(true);
      break;
    case 'audioSeekFlush':
      dlog('[seek] audio audioSeekFlush → flush PCM + seek-block (no rebase until post-seek epoch)');
      resetEpoch(false); // flush the ring to silence; do NOT arm the rebase
      seeking = true;    // block decode until the demux packet-ring seek epoch lands
      seekingTicks = 0;
      break;
    case 'audioSetOutRate':
      audioOutRate = Math.round(msg.rate);
      sampleRate = Math.round(msg.rate);
      if (pcmCtrl) Atomics.store(pcmCtrl, RW_RATE, sampleRate);
      if (adec) applyAudioOpts(adec);
      break;
    case 'setDrc':
      drcMode = msg.mode;
      if (adec) applyAudioOpts(adec);
      break;
    case 'audioUnload':
      gen = msg.gen;
      stopPipeline();
      break;
    case 'audioDestroy':
      void handleDestroy();
      break;
  }
};
// Module workers buffer messages posted before the top-level eval installs onmessage, so the init is never
// dropped (no blob-worker pre-onmessage drop). Still post the ready handshake so MAIN can flush its deferred
// audioSetPcmRing / audioLoad in order once this realm's onmessage is live. Mirrors audio_decode.rs.
post({ type: 'audioWorkerReady' });

// ===================== async lifecycle =====================

async function handleInitLoad(): Promise<void> {
  try {
    // ferritePool=1 → audio decode is single-pthread-light; +2 keeps the same call shape as the decode
    // worker's bootstrap. The audio realm is sized small (16 MiB init / 32 MiB cap) — audio decode + downmix
    // + resample is ≈16 MiB even at 7.1/96 kHz.
    F = await loadFerrite(wasmBaseUrl, 1 + 2, MEM_AUDIO_INIT, MEM_AUDIO_MAX);
    resolveReady(true);
    dlog('engine ready (audio)');
  } catch (err) {
    stop = true;
    log('engine load failed (audio): ' + err);
    resolveReady(false);
  }
}

async function handleLoad(myGen: number, live: boolean): Promise<void> {
  if (closing) return;
  gen = myGen;
  isLive = live;
  if (!(await ready)) return;             // engine dead — engine-load error already posted
  if (closing || myGen !== gen) return;   // destroyed, or superseded by a newer load/unload
  await run(myGen);
}

async function run(myGen: number): Promise<void> {
  if (!F || closing) return;
  // Fresh per-load state (an unload→load reuse starts clean). Loudness re-measures from scratch.
  stop = false;
  paused = false;
  audioActive = false;
  seeking = false; // a fresh load is not mid-seek
  curAcodec = 0;   // re-apply the pending codec on the next AU
  // NB: do NOT reset pendingAcodec — the demux relays audioCodecParams asynchronously and one may LAND BEFORE
  // this run() executes (run awaits engine-ready). The demux re-ships on its own load.
  freeDecoder();
  resetAudioProducerState();
  audioEdgePtsUs = 0;
  audioEdgeFrame = 0;
  audioClockRebase = true;
  lastAudioStatsAt = 0;
  resetEpoch(true); // arm the rebase so the first decoded chunk re-anchors C_ACLOCK (coalesces on freshAnchor)
  dlog('audio decoding…');
  void statsLoop(myGen);
  void rebufferLoop(myGen);
  await pump(myGen);
}

async function handleDestroy(): Promise<void> {
  if (closing) return;
  closing = true;
  stop = true;
  // Wait for engine init to SETTLE (or the wedge-breaker deadline) before tearing down.
  await Promise.race([ready.catch(() => false), sleep(READY_SETTLE_MS)]);
  stopPipeline();
  // ferritePool=1 → reap the (small) audio pthread pool, mirroring the decode worker's reap shape. The audio
  // pool is tiny; a short watch is enough (no spawn-race straggler class like the video pool).
  if (F) {
    try { F.shutdownThreads(); } catch (err) { log('thread shutdown: ' + err); }
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      if (F.pthreadPoolCount() === 0) break;
      try { F.shutdownThreads(); } catch (err) { log('thread shutdown: ' + err); }
    }
  } else {
    log('destroy: audio engine never settled — forced teardown, pthread pool may orphan');
  }
  post({ type: 'destroyed' });
}

// ===================== pump (audio ring → decode → PCM ring) =====================

async function pump(myGen: number): Promise<void> {
  if (!F) return;
  // Adopt the demux's CURRENT load epoch before the first checkEpoch below — audioConsumer was built at `init`
  // (before the demux bumped PR_GEN for this load), so its construction-time epoch is stale. Same fix as the
  // video pump: without it, the first checkEpoch would jump read→write to the LIVE EDGE, discarding the buffered
  // aligned start the demux read ahead, desyncing the audio clock. In practice audio rarely reached that state
  // (its engine loads fast, so its pump gets here before the demux over-fills the audio ring → any stale-epoch
  // jump was small), but the latent race is identical to video's, so we adopt the epoch here too for parity +
  // robustness. Per-load (the pump restarts on each gen); seek/reconnect epoch changes still fire checkEpoch.
  audioConsumer?.resyncEpoch();
  while (alive(myGen)) {
    // Drop a stale producer epoch (a fresh load / VOD seek): jump read→write + re-anchor the PCM clock.
    if (audioConsumer && audioConsumer.checkEpoch()) {
      dlog('[seek] audio packet-ring epoch changed (demux seek) → resetEpoch + unblock');
      resetEpoch(true);  // post-seek packets are now guaranteed → arm the rebase
      seeking = false;   // the seek epoch landed: resume decoding (the first chunk re-anchors)
    }
    // mpv SEEK_BLOCK: between audioSeekFlush and the demux seek epoch the audio ring still holds PRE-seek
    // packets — decode NONE of them (they'd play stale audio + falsely anchor C_ACLOCK). Park until the epoch
    // flip above clears `seeking`. WEDGE-BREAKER: if the demux bumped the epoch and the pump's checkEpoch
    // CONSUMED it BEFORE the (separately-posted) audioSeekFlush landed, the epoch can't flip again and the
    // block would never clear. Bound the block: after SEEK_BLOCK_MAX_TICKS, unblock and proceed — correctness
    // is safe (present seek-hold holds the clock at the target, and a post-seek chunk re-anchors C_ACLOCK via
    // its absolute edge_pts on the base=0 ring); worst case is a brief pre-seek audio blip on a >2s seek.
    if (seeking) {
      seekingTicks++;
      if (seekingTicks > SEEK_BLOCK_MAX_TICKS) {
        log('[seek] audio seek-block wedge-breaker fired (epoch-race) → unblock');
        seeking = false;
      } else {
        await sleep(8);
        continue;
      }
    }

    let idle = true;
    let backpressured = false;
    for (;;) {
      if (!alive(myGen)) return;
      if (paused) break;
      // BACKPRESSURE: stop decoding when the PCM ring is full — let the worklet drain it first. This paces
      // the audio decode to realtime so the producer never decodes ahead of the worklet (which would desync
      // edge_pts from edge_frame → the clock races, the picture collapses). See pcmHasRoom.
      if (!pcmHasRoom()) { backpressured = true; break; }
      const rec = audioConsumer ? audioConsumer.readAu() : null;
      if (!rec) break;
      idle = false;
      ensureAudioDecoder();
      if (adec) {
        F.audioPushAu(adec, rec.au, rec.ptsUs);
        drainAudio();
      }
    }

    // EOF: when the audio ring signals EOF and has fully drained, flush the decoder tail then finish.
    if (audioConsumer && audioConsumer.eof() && audioConsumer.readable() === 0) {
      if (adec) { F.audioPushAu(adec, new Uint8Array(0), 0n); drainAudio(); }
      stop = true;
      break;
    }

    if (idle || backpressured) {
      await sleep(PUMP_IDLE_MS); // ring empty OR PCM full (backpressure) — yield to the worklet
    }
  }
}

// ===================== stats + rebuffer loops =====================

async function statsLoop(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(STATS_INTERVAL_MS);
    if (!alive(myGen)) return;
    postAudioStats(true); // forced heartbeat (a quiet/audio-less stream still needs a periodic active=false)
  }
}

/** mpv cache-pause monitor (20 Hz): watch the PCM ring depth + packet availability and signal MAIN to
 *  freeze/resume the clock on real audio-output starvation. Separate from the 2 Hz stats loop so detection is
 *  prompt (the 0.5 s buffer drains fast). Ported from audio_decode.rs::rebuffer_loop. */
async function rebufferLoop(myGen: number): Promise<void> {
  while (alive(myGen)) {
    await sleep(REBUFFER_TICK_MS);
    if (!alive(myGen)) return;
    rebufferTick();
  }
}
