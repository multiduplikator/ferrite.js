// Message protocol for the split-realm pipeline.
//
// Architecture (full 4-worker parity — DEMUX/ingest split out of the combined worker into
// its OWN realm): there are FOUR workers plus the main thread.
//   - DEMUX worker   (demux-worker.ts)   — owns the SOURCE (live ingest / VOD Range) + the engine DEMUX +
//                                          the stream LIFECYCLE (connect/read/cadence/reconnect/EOF/silence-
//                                          watchdog, live + VOD). It NEVER decodes: it ROUTES each demuxed
//                                          encoded AU into one of TWO SAB packet rings (video ring = stream 0
//                                          → the VIDEO worker; audio ring = stream 1 → the AUDIO worker), and
//                                          RELAYS the resolved codec id + extradata to MAIN as CodecParams
//                                          (DemuxToMain) → the respective decode worker. Posts caps / duration
//                                          / ended / reconnecting / recovered / keyframe-resync / log / error
//                                          to MAIN. ferritePool=0, small MEM_DEMUX realm. (See MainToDemux/
//                                          DemuxToMain.) Because the rings + workers are separate, a slow
//                                          software-HEVC video decode can never block audio decode.
//   - DECODE worker  (worker.ts)         — VIDEO-DECODE-ONLY. CONSUMES the VIDEO packet ring the demux fills
//                                          (PacketRingConsumer, stream 0), builds the video decoder from the
//                                          relayed CodecParams (Fix-A live WC strict-form config record +
//                                          reframe; the SW build), runs the ffmpeg/WebCodecs VIDEO decoder,
//                                          and posts decoded VIDEO frames straight to the PRESENT worker over a
//                                          MessageChannel (bypassing main). Keeps the decode-tier memory.
//   - AUDIO worker   (audio-worker.ts)   — its OWN ferrite realm. Consumes the audio packet ring
//                                          (the DEMUX worker fills it now), decodes audio, and is the PCM-ring
//                                          PRODUCER (writes decoded interleaved-stereo PCM straight into the
//                                          PCM ring SAB the worklet on MAIN consumes) + publishes the media-PTS
//                                          clock edge map + loudness fold + the mpv cache-pause rebuffer
//                                          signal. See MainToAudio/AudioToMain.
//   - PRESENT worker (present-worker.ts) — owns the transferred OffscreenCanvas + WebGL2 + the rAF
//                                          present loop + the ring/eviction + the present clock. Reads
//                                          the audio master clock from a SharedArrayBuffer that main
//                                          publishes. Recycles software plane buffers back to the
//                                          decode worker over the same MessageChannel.
//   - MAIN (index.ts)                    — the thin facade: events, errors, stats, and
//                                          AUDIO playout (AudioContext). Audio stays on main and IS the
//                                          master clock; main publishes its monotonic elapsed playout
//                                          into the clock SAB so the present worker (a different realm)
//                                          can read it via Atomics. This is the only reason the SAB
//                                          exists — present and audio are no longer colocated.
//
// Flow control (software tier): main grants the decode worker "credits" (one per free ring slot). The
// decode worker decodes only while credits remain; the PRESENT worker returns a credit (the recycled
// plane buffers) each time it retires a frame. This bounds frames-in-flight to the ring cap.
import type { WorkerMediaInfo, WorkerStats } from './types';
import type { FerriteFailureKind } from './errors';
import type { SourceCapabilities } from './source/capabilities';

// ---------------------------------------------------------------------------
// Clock SAB — main writes, the present worker reads (Atomics). An Int32Array control header.
// Mirrors the reference player's A_ACLOCK/A_RATE: the present worker derives `media_now =
// pts_anchor + A_ACLOCK` (A_ACLOCK is the RELATIVE audio playout elapsed, so the video anchor is the
// present worker's own first frame — the anchor-to-own-first-frame property is preserved).
// ---------------------------------------------------------------------------
/** Int32 slots in the clock SAB — exactly the three below (C_ACLOCK, C_AUDIO, C_OUTPUT_LATENCY_MS), sized
 *  to what is actually published. */
export const CLOCK_SLOTS = 3;
/** Media-PTS master clock, MILLISECONDS (i32 → wrap-safe ≈24.8 days). The AudioWorklet is the SOLE writer
 *  (off-main, every render quantum, from the PCM ring's seqlock edge map — see src/worker/audio-worklet.ts
 *  + src/audio-ring.ts mediaClockMs). It HOLDS at the last real played PTS through an underrun (the worklet
 *  underrun-HOLD; mpv `ao_get_delay`→0 pin) instead of racing forward through silence. The present worker
 *  reads it. */
export const C_ACLOCK = 0;
/** 1 while audio is the live master clock (≈ the reference player's `A_RATE > 0` has-audio gate), else 0
 *  (paused / startup grace / video-only). The AudioWorklet writes it; the present worker reads it. */
export const C_AUDIO = 1;
/** AudioContext.outputLatency in MILLISECONDS — the device/buffer delay between the worklet pulling a frame
 *  and it being audible. MAIN publishes it (a native TS property on AudioContext; 0 where unsupported or the
 *  ctx is still suspended → no compensation); the worklet AND audioHeardPtsAbsMs SUBTRACT it so the master
 *  clock reflects the TRUE AUDIBLE position, mpv's `written_pts − ao_get_delay`. The `(edge_frame − read)/rate`
 *  term already captures the ring occupancy; this adds the OUT-OF-RING device latency that only MAIN can read.
 *  MAIN is the sole writer; the worklet reads it. */
export const C_OUTPUT_LATENCY_MS = 2;

// ---------------------------------------------------------------------------
// Stream-id constants for the packet rings (the demux routes by demux_pkt_stream). Kept next to the codec-
// param handoff so the wire never disagrees with the demux router. Mirrors the reference player's demux-stream constants.
// ---------------------------------------------------------------------------
export const DEMUX_STREAM_VIDEO = 0;
export const DEMUX_STREAM_AUDIO = 1;

// ---------------------------------------------------------------------------
// Main → DEMUX worker. `DemuxInit` shares the two packet-ring SABs (audio + video) BY REFERENCE —
// exactly like the clock SAB to present (NOT transferred, so MAIN can still read ring depth for telemetry).
// The lifecycle subset (load/unload/seek/setPaused/destroy) mirrors the demux-relevant half of the old
// MainToWorker; the decode-only knobs (credit/setSkips/setDeint) do NOT route here. Mirrors the reference player's Main→Demux channel.
// ---------------------------------------------------------------------------
export type MainToDemux =
  // One-time init: the two packet rings (audio + video, PRODUCER end — shared by reference) + the adaptive
  // low-water config + platform tells. No engine threads (the demux is single-threaded → ferritePool=0).
  // `audioPacketRing`/`videoPacketRing` are the PRODUCER ends of the encoded-AU SABs (src/packet-ring.ts):
  // the demux routes each demuxed AU into them (write_au), the AUDIO/VIDEO workers consume them.
  | { type: 'demuxInit'; wasmBaseUrl: string; lowWaterFloor: number; lowWaterCeiling: number; lowWaterAdaptive: boolean; isIOS: boolean; isAppleWebKit: boolean; debug: boolean; audioPacketRing: SharedArrayBuffer; videoPacketRing: SharedArrayBuffer }
  // `gen` tags this load so stale ingest/pump/vod loops from a prior load self-cancel (unload→load reuse).
  // `isLive` is the caller's DECLARED intent (createPlayer({isLive})) — it FEEDS the demux SourceCapabilities
  // descriptor (deriveCapabilities), refined from the first response's headers and posted back as `caps`.
  // `preferWebCodecs` is forwarded to the VIDEO worker at codec-params time (the demux holds no decoder).
  | { type: 'demuxLoad'; gen: number; url: string; isLive: boolean; preferWebCodecs: boolean }
  // Live pause: discard packets at the live edge; on resume the demux relays a keyframeResync to the VIDEO
  // worker. VOD pause HOLDS position.
  | { type: 'demuxSetPaused'; paused: boolean }
  // VOD seek (range-streamed file only; ignored live): demux_seek_us to targetMs (backward → keyframe
  // at/before) + bump the ring epochs. The demux coalesces rapid scrubs (last target wins).
  | { type: 'demuxSeek'; targetMs: number }
  // Stop the current pipeline (free the demux + source) but keep the engine. `gen` invalidates in-flight loops.
  | { type: 'demuxUnload'; gen: number }
  | { type: 'demuxDestroy' };

// ---------------------------------------------------------------------------
// DEMUX worker → main. Carries the caps/duration/ended/reconnecting/recovered/keyframeResync,
// the codec params (video + audio, relayed by MAIN to the respective decode worker), log/error/ready/
// destroyed. Mirrors the reference player's Demux→Main channel. The codec-params `extradata` is TRANSFERRED (copied bytes — a
// per-realm heap pointer is meaningless across workers).
// ---------------------------------------------------------------------------
export type DemuxToMain =
  // Ready handshake — the demux worker's onmessage is installed; MAIN flushes the held demuxInit/demuxLoad.
  | { type: 'demuxWorkerReady' }
  // The resolved SourceCapabilities descriptor (seekable/bounded/hasLiveEdge/declaredLive), computed ONCE per
  // load from the declared intent + the FIRST response's headers (no extra round-trip). Drives the main-side
  // live/VOD forks: seek() (seekable), the duration getter/seekbar (seekable), the live-edge catch-up
  // (hasLiveEdge). Posted after the first connect (live) / HttpSource.open (VOD).
  | { type: 'caps'; caps: SourceCapabilities }
  // VOD: the container duration in ms (0 = unknown), reported once after the demuxer opens — drives the
  // facade `duration` getter + the scrub bar. Live never sends this (duration stays Infinity).
  | { type: 'duration'; durationMs: number }
  // Codec id + extradata for one stream (DEMUX_STREAM_VIDEO/_AUDIO), relayed by MAIN to the VIDEO/AUDIO worker.
  // The decode worker builds its decoder from it. Video carries profile/level/SAR (the WC tier needs them; no
  // FFmpeg decoder there to read a frame SAR off); `extradata` is the Annex-B param sets (live) / avcC/hvcC /
  // ASC (VOD), TRANSFERRED (copied bytes). Audio: codec id + the ASC extradata (empty for self-describing live
  // ADTS); profile/level/SAR are meaningless and 0/1.
  | { type: 'codecParams'; stream: number; codecId: number; profile: number; level: number; sarNum: number; sarDen: number; extradata: Uint8Array }
  // Arm the next-IDR resync on the VIDEO path (relayed by MAIN after a reconnect / resume / seek). Sets the
  // VIDEO worker's await_keyframe.
  | { type: 'keyframeResync' }
  | { type: 'log'; message: string }
  // Clean end of the source (VOD finished, or a non-live stream closed) → host LOADING_COMPLETE.
  | { type: 'ended' }
  // a live stream dropped recoverably (network drop / upstream-silence) and the demux is re-opening with
  // backoff. Drives the facade controller Playing/Buffering → Reconnecting. `attempt` is the 1-based attempt.
  | { type: 'reconnecting'; attempt: number }
  // a live stream that dropped has RECONNECTED and bytes are flowing again → host RECOVERED_EARLY_EOF.
  | { type: 'recovered' }
  // Shutdown handshake ack: the demux worker has freed its source + demux (ferritePool=0 → no pool to reap);
  // main may now terminate it. Main also has a timeout fallback if this never arrives.
  | { type: 'destroyed' }
  // A failure, pre-classified into a ferrite failure KIND. The facade maps the kind onto the verbatim mpegts
  // (type, details, info) strings (errors.ts).
  | { type: 'error'; kind: FerriteFailureKind; code: number; msg: string; fatal: boolean };

// ---------------------------------------------------------------------------
// Main → DECODE (VIDEO) worker (decode-only). The ingest/source/seek/url forks moved to MainToDemux;
// this is the decode-only set (Init with the VIDEO packet ring + presentPort + ringCap; Load(gen) for the
// epoch; SetSkips/SetDeint/SetPaused; CodecParams(video, relayed); KeyframeResync; Credit; Destroy).
// ---------------------------------------------------------------------------
export type MainToWorker =
  // One-time engine/config init. Carries the decode↔present `presentPort` (TRANSFERRED) + the VIDEO packet
  // ring CONSUMER end (videoPacketRing, shared by reference — MAIN reads its depth for telemetry). `ringCap`
  // is main's RING_CAP — the SINGLE SOURCE OF TRUTH for the software in-flight (credit) bound. `isIOS`/
  // `isAppleWebKit` are detected ONCE on the main thread + forwarded. `fastDecode` arms AV_CODEC_FLAG2_FAST.
  | { type: 'init'; wasmBaseUrl: string; threads: number; isIOS: boolean; isAppleWebKit: boolean; fastDecode: boolean; debug: boolean; presentPort: MessagePort; ringCap: number; videoPacketRing: SharedArrayBuffer }
  // `gen` is the load epoch (matches the demux ring's PR_GEN). `isLive`/`preferWebCodecs` mirror the demux's
  // (the VIDEO worker reads hasLiveEdge for the live WC strict path + the pause-resume IDR arm). No url/seek
  // (the DEMUX worker owns the source).
  | { type: 'load'; gen: number; isLive: boolean; preferWebCodecs: boolean }
  // Codec id + extradata for the VIDEO stream, relayed by MAIN from the DEMUX worker's codecParams. The VIDEO
  // worker builds its decoder from it (the Annex-B extradata → the Fix-A WC config record + the SW build).
  // `extradata` is TRANSFERRED (copied bytes). MAIN guards on `stream === DEMUX_STREAM_VIDEO` (audio goes to
  // the audio worker), but the field is carried so a stray relay is a no-op rather than a mis-built decoder.
  | { type: 'codecParams'; stream: number; codecId: number; profile: number; level: number; sarNum: number; sarDen: number; extradata: Uint8Array }
  // Arm the next-IDR resync on the VIDEO path (relayed by MAIN after a reconnect / resume / seek). Sets await_keyframe.
  | { type: 'keyframeResync' }
  // Live pause: on resume the worker awaits the next keyframe so decode restarts clean (VOD holds position).
  | { type: 'setPaused'; paused: boolean }
  | { type: 'credit'; n: number } // grant N decode credits (initial seed only; recycle replenishes over the port)
  // Stop the current decode pipeline (free decoders) but keep the engine. `gen` invalidates in-flight loops.
  | { type: 'unload'; gen: number }
  // Levers 2 & 3: the engine decode-relief skip toggles, settable mid-stream (read per-frame → honoured
  // mid-stream). `skipNonref` discards non-reference frames; `skipLoop` skips the in-loop deblock.
  | { type: 'setSkips'; skipNonref: boolean; skipLoop: boolean }
  // Runtime deinterlace-mode override (0=off, 1=auto, 3=bwdif), settable mid-stream. Software tier only.
  | { type: 'setDeint'; mode: number }
  | { type: 'destroy' };

// ---------------------------------------------------------------------------
// DECODE (VIDEO) worker → main (decode-only). Video frames go to the present worker over the port,
// NOT here. The demux now owns caps/duration/ended/reconnecting/recovered/codecParams → those are DemuxToMain.
// ---------------------------------------------------------------------------
export type WorkerToMain =
  | { type: 'ready'; info: WorkerMediaInfo }
  | { type: 'log'; message: string }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'deintFailed'; failed: boolean } // avfilter deint graph won't build for this geometry
  // Shutdown handshake ack: the worker has freed its decoders AND terminated the pthread pool
  // (Module.PThread.terminateAllThreads()); main may now worker.terminate() the coordinator with no orphans.
  | { type: 'destroyed' }
  // A failure, pre-classified into a ferrite failure KIND (e.g. a decode fault / engine-load failure).
  | { type: 'error'; kind: FerriteFailureKind; code: number; msg: string; fatal: boolean };

// ---------------------------------------------------------------------------
// Main → AUDIO worker (the audio decode realm split). Mirrors the reference player's Main→Audio channel. The audio
// worker owns its OWN ferrite engine + the PCM-ring producer slots; MAIN keeps the AudioContext/worklet/
// GainNode/RW_PLAYING authority + the AGC makeup gain. Kept minimal — all scalar/SAB, no per-chunk traffic.
// ---------------------------------------------------------------------------
export type MainToAudio =
  // One-time init: engine-load params + the AUDIO PACKET RING (consumer side — the demux-filled encoded-AU
  // SAB). The PCM ring (producer side) crosses LATER in audioSetPcmRing (MAIN sizes it off ctx.sampleRate,
  // which only exists once the AudioContext does) — exactly the decode worker's init+rings split. The clock
  // SAB is NOT passed (audio never touches it; the worklet on MAIN is its sole writer).
  | { type: 'audioInit'; wasmBaseUrl: string; isIOS: boolean; isAppleWebKit: boolean; debug: boolean; audioPacketRing: SharedArrayBuffer }
  // The PCM ring SAB (producer) + frame cap + RW_RATE (ctx.sampleRate). Sent once the AudioContext exists
  // (ensureAudio); shared by reference (MAIN + the worklet also hold it). The worker writes the producer
  // slots (RW_WRITE/RW_BASE_MS/RW_EDGE_*/RW_GEN) directly.
  | { type: 'audioSetPcmRing'; pcmRing: SharedArrayBuffer; pcmRingCap: number; sampleRate: number }
  // Per-load: re-measure loudness from scratch (a fresh stream re-levels per channel) + run() the pump.
  | { type: 'audioLoad'; gen: number; isLive: boolean }
  // Tear down the current audio pipeline (free the decoder) but keep the engine loaded; a follow-up
  // audioLoad reuses it. `gen` invalidates in-flight loops from the unloaded run.
  | { type: 'audioUnload'; gen: number }
  | { type: 'audioSetPaused'; paused: boolean }
  // Re-anchor the PCM ring (live restart / channel switch): the worker bumps RW_GEN + re-anchors the media
  // clock; the next decoded chunk carries the rebase.
  | { type: 'audioResetEpoch' }
  // VOD seek: flush the PCM ring (silence) + enter seek-block WITHOUT arming the rebase (so a still-buffered
  // PRE-seek packet can't anchor C_ACLOCK to the old position). The worker decodes nothing until it observes
  // the demux packet-ring seek epoch, then the FIRST post-seek chunk re-anchors. mpv SEEK_BLOCK.
  | { type: 'audioSeekFlush' }
  // AudioContext output rate (Hz): the engine resamples to it in one stateful swresample pass AND the worker
  // stores it in RW_RATE (the clock denominator). 0 = passthrough.
  | { type: 'audioSetOutRate'; rate: number }
  // Audio dynamics ("Dyna") mode (0=line, 1=RF/heavy, 2=night), settable mid-stream; re-applied on every
  // audio-decoder (re)create.
  | { type: 'setDrc'; mode: number }
  // Resolved audio codec id (+ extradata), relayed by MAIN from the decode worker's audioCodecParams. The
  // worker builds its decoder lazily from it (audioNew for live ADTS; the ASC extradata for VOD AAC).
  // `extradata` is TRANSFERRED (copied bytes); empty for live ADTS.
  | { type: 'audioCodecParams'; codecId: number; extradata: Uint8Array }
  | { type: 'audioDestroy' };

// ---------------------------------------------------------------------------
// AUDIO worker → main. Mirrors the reference player's Audio→Main channel. All scalar (no transferables) — the PCM + the producer
// ring slots are written DIRECTLY into the shared PCM ring SAB, never posted.
// ---------------------------------------------------------------------------
export type AudioToMain =
  // Ready handshake — the audio worker's onmessage is installed; MAIN flushes the held audioInit/SetPcmRing.
  | { type: 'audioWorkerReady' }
  // ~2 Hz audio telemetry (loudness + the audio rows MAIN merges into getStats() + drives the makeup-gain).
  // The RMS/peak FOLD runs where the PCM lives (the audio worker); MAIN keeps only the DOM-bound GainNode.
  | { type: 'audioStats'; active: boolean; loudnessDb: number; peak: number; drops: number; scheduledAhead: number;
      srcChannels: number; streamRate: number }
  // mpv cache-pause: the audio output genuinely STARVED (PCM ring critically low AND the audio packet ring is
  // empty — nothing left to decode) → buffering:true; or REFILLED past the resume cushion → buffering:false.
  // MAIN freezes/resumes the clock (RW_PLAYING) + the present so playback rebuffers instead of free-running.
  | { type: 'audioRebuffer'; buffering: boolean }
  // Circuit-breaker: N consecutive audio decode failures (a codec the WASM decoder can't handle) → the worker
  // freed the audio decoder; MAIN flips RW_PLAYING=0 (the worklet releases the master clock) → silent-audio,
  // video continues.
  | { type: 'audioDegraded' }
  | { type: 'log'; message: string }
  // Shutdown handshake ack: the audio worker freed its decoder + reaped its (small) pthread pool; MAIN may
  // now terminate it.
  | { type: 'destroyed' };

// ---------------------------------------------------------------------------
// DECODE worker → PRESENT worker (over the MessageChannel port).
// ---------------------------------------------------------------------------
export type DecodeToPresent =
  // the engine's growable shared WebAssembly.Memory, forwarded ONCE after the engine loads
  // (the present worker has no engine, so the decode worker hands it the live-heap handle). The present
  // worker reads decoded planes straight from `memory.buffer` — re-viewed FRESH per upload (a pthread
  // grow replaces the buffer; the liveHeap rule). Posted before any `frame`.
  | { type: 'engineMemory'; memory: WebAssembly.Memory }
  // One decoded video frame from the SOFTWARE tier — TRUE ZERO-COPY (frame-pinning). The decode
  // worker HELD a ref on the decoder's output AVFrame (ferrite_vdec_hold → `token`), so its three planes
  // stay valid at their NATIVE byte-stride AND native bit depth. `ptrs` are the Y/U/V heap offsets,
  // `lns` their strides in BYTES; `bitDepth` (8/10/12) picks the present worker's integer texture format
  // (R8UI vs R16UI) + the shader bit-scale. The present worker uploads STRAIGHT from the live heap (de-
  // stride via UNPACK_ROW_LENGTH, bit-scale on the GPU — no CPU copy, no 10→8 downshift), then posts
  // {release, token} so the decode worker unrefs the frame. The held frame stays valid until released
  // (present reads + releases serially, so the decoder never reuses a buffer a live frame still points at).
  // `contentPeriodUs` is the TRUE content frame period (µs) derived from the demux VIDEO
  // PACKET PTS — non-ref-skip INDEPENDENT (a non-ref-skipping decoder outputs fewer frames, but the packet
  // cadence is unchanged), so the present worker's tier-2 PTS-cap targets `content × tier` and the present-cap + non-ref-skip never
  // decimate twice. 0 until enough packets are seen (the present worker falls back to its arrival median).
  // `demuxRingBytes` is the demux ring depth (unread bytes) at post time — a LATENCY signal:
  // when decode falls behind ingest the ring GROWS (decode can't drain it), and because the ring carries the
  // AUDIO packets too, a growing ring is what actually starves audio. On the graduated ladder it is now a
  // WEAK HINT into the present-side decode-bound detector (not a required gate); it rides each frame.
  // `colorspace` (AVColorSpace matrix_coefficients) + `colorRange` (AVColorRange) condition the present
  // worker's software YUV→RGB matrix (601/709/2020) + limited/full range — constant per stream; ride each frame.
  // `gen` is the load generation that produced this frame. `frame`/`vframe` and the present-ring `reset`
  // travel on DIFFERENT channels (decode→present port vs main→present), so they have NO mutual ordering:
  // a frame the OLD load left in flight on the port can be processed AFTER the reset and land in the fresh
  // ring (a brief flash of the prior stream). The present worker DROPS any frame whose gen is older than
  // its current (reset-set) gen — see isStaleLoadGen. The decode loop only posts while it is the current
  // load (alive() ⇒ gen===myGen), and gen is monotonic, so a CURRENT frame can never carry a stale gen.
  // `sarNum`/`sarDen` = the single demux-resolved pixel aspect (anamorphic). The present worker sizes the
  // canvas BACKING to display_w = coded_w × SAR (texture stays at coded dims, the sampler stretches), so a
  // non-square-pixel stream renders the right shape. Rides each frame (constant per stream; cheap two ints,
  // same idiom as colorspace) so there is no ordering race with a one-time message. 1:1 = square pixels.
  | { type: 'frame'; gen: number; ptsUs: number; w: number; h: number; cw: number; ch: number; bitDepth: number; colorspace: number; colorRange: number; colorTrc: number; sarNum: number; sarDen: number; token: number; ptrs: [number, number, number]; lns: [number, number, number]; contentPeriodUs: number; demuxRingBytes: number }
  // One decoded video frame from the WEBCODECS (hardware) tier. The VideoFrame is TRANSFERRED (it is
  // Transferable over a MessagePort) — the present worker OWNS it and MUST `.close()` it once uploaded/
  // evicted, or the decoder's output pool starves. `ptsUs` mirrors the frame's own `.timestamp`.
  // `sarNum`/`sarDen` — the single demux-resolved pixel aspect (see `frame`). The WebCodecs tier has no
  // FFmpeg decoder to read a frame SAR off, so this engine-resolved value un-squishes anamorphic on the HW
  // path: the present worker sizes the backing width to codedWidth × SAR (the texture stays at coded dims).
  // (WebCodecs display GEOMETRY — to neutralize HW decoders, e.g. Edge's HEVC path, that stamp bogus
  // VideoFrame display/visibleRect dims — is derived present-side from the frame's OWN coded dims, so it
  // needs no plumbing here.)
  | { type: 'vframe'; gen: number; ptsUs: number; frame: VideoFrame; sarNum: number; sarDen: number; contentPeriodUs: number; demuxRingBytes: number }
  // codec-change seam safety (iOS only): a LIVE WebCodecs decoder was just freed mid-stream. Any
  // of its VideoFrames still in the present ring are backed (on iOS/VideoToolbox) by the now-freed
  // decoder pool, so the present worker must CLOSE them before a draw could touch a dead pool. `gen`
  // tags the load that posted it so the present worker IGNORES a stale one (startup/reload race).
  | { type: 'dropVideoFrames'; gen: number };

// ---------------------------------------------------------------------------
// PRESENT worker → DECODE worker (over the same port).
// ---------------------------------------------------------------------------
export type PresentToDecode =
  // retired SOFTWARE frames handed back by token. The decode worker calls ferrite_vdec_release
  // (unref the held AVFrame → the decoder may reuse its buffer) and grants itself one decode credit per
  // frame. Batched to amortise the port round-trip.
  //
  // `vf` (LIVE-WC fix) = how many WebCodecs VideoFrames were RETIRED/closed in this same batch. WC frames
  // are TRANSFERRED (no token), so a heap-slot credit makes no sense. The decode worker uses the count to
  // keep its `wcInFlight` TELEMETRY accurate (the WC analog of `heldFrames`) — the present worker decrements
  // one per drawn/dropped/closed VideoFrame. NB: `wcInFlight` is telemetry only — the feed gate is
  // decodeQueueSize-only (deadlock fix); it does NOT block on this cross-worker count. The
  // steady-state draw path MUST route through postReleases so this `vf` count is actually carried (the
  // regression was a draw path that posted tokens-only → wcInFlight never decremented). 0 on a SW batch.
  | { type: 'release'; tokens: number[]; vf?: number }
  // the AUTO graceful-degradation fan-out for the decode-worker skips. The present worker owns the degrade
  // decision (it measures present-fps + the demux-ring latency); when it latches the degraded tier it
  // fans the engine skips out to the decode worker HERE (skipNonref, skipLoop), so all three
  // levers engage atomically with the present-cap (already present-worker-local). Sent ON at the
  // 1→2 latch and OFF on the present worker's reset() (a fresh timeline re-arms the trigger). The decode
  // worker OR-folds these with the MANUAL skips so a manual force is never stomped (manual precedence).
  | { type: 'autoSkips'; skipNonref: boolean; skipLoop: boolean }
  // Fix-B rung-4: the present-side ladder maxed out (all safe levers on) and the SOFTWARE decoder is STILL
  // severely behind the content rate → break the decode chain to the next IDR. The decode worker skips every
  // delta AU until the next keyframe, then flushes the DPB (vdecFlush) before decoding it, so the drops are
  // GOP-clean instead of corrupt mid-GOP. SOFTWARE + LIVE only — the decode worker self-gates on
  // `!useWc && hasLiveEdge`; VOD backpressures (never drops content) and the WC tier is owned by the
  // wc-stall watchdog. The present worker only ever FIRES it (sustained-severe + re-armed); the latch lives
  // in the decode worker and self-clears at the next IDR (+ epoch flip / resync / resume / teardown).
  | { type: 'dropToKeyframe' };

// ---------------------------------------------------------------------------
// Main → PRESENT worker.
// ---------------------------------------------------------------------------
export type MainToPresent =
  // One-shot init: the transferred OffscreenCanvas (main can no longer draw on it), this worker's end
  // of the decode↔present channel, the clock SAB to read the audio master clock from, and the per-tier
  // present-ring caps (software fixed, WebCodecs platform-aware).
  | { type: 'present-init'; canvas: OffscreenCanvas; port: MessagePort; clock: SharedArrayBuffer; wcRingCap: number; swRingCap: number }
  // Pause/resume the present CLOCK (mirrors the reference player's worker playpause → freeze eviction).
  | { type: 'setPaused'; paused: boolean }
  // mpv cache-pause: freeze/resume the present clock (hold the frame) while the audio output rebuffers —
  // DISTINCT from setPaused (user intent). The present freezes on EITHER, so a rebuffer refill never
  // un-freezes a user pause (and a user resume never un-freezes an active rebuffer). Driven by the decode
  // worker's audioRebuffer → main → here.
  | { type: 'setBuffering'; buffering: boolean }
  // Flush the ring (recycling software buffers back to the decode worker) + re-arm the present clock so
  // the next frame re-anchors a fresh timeline. `gen` lets a `dropVideoFrames` race be filtered. Sent
  // on (re)load / unload / seek / live-resume — exactly where main used to recycleRing()+resetClock().
  // `hasLiveEdge` carries the timeline's realtime-rigid liveness (gates the Fix-B rung-4 trigger). `isLive`
  // (the declared intent) gates the present clock's discontinuity machinery — the live-only clock-disc-snap,
  // the SEAM re-anchor, and the vod_audio_stall hold (VOD has none: a monotonic timeline). `seekTargetMs` ≥ 0
  // (a VOD seek) arms the mpv last_seek_pts HOLD — park the clock at the target until a genuine post-seek
  // audio anchor lands, so present never locks onto the transient C_ACLOCK during the cross-worker re-anchor;
  // -1 on a (re)load / unload / live-resume (no hold).
  | { type: 'reset'; gen: number; hasLiveEdge: boolean; isLive: boolean; seekTargetMs: number }
  // Lever 1: the MANUAL present=half override. `present:true` forces the tier-2
  // present-rate cap independent of the auto-degrade trigger; `false` returns to adaptive (auto only).
  // A session toggle — it survives a reset()/(re)load (unlike the auto tier, which re-arms per timeline).
  | { type: 'setLever'; present: boolean }
  | { type: 'destroy' };

// ---------------------------------------------------------------------------
// PRESENT worker → main.
// ---------------------------------------------------------------------------
export type PresentToMain =
  // The freshly-drawn front frame's PTS (ms) → facade currentTime + TIME_UPDATE. Throttled. `avDiffMs` is
  // the SINGLE-DOMAIN lip-sync error (master clock − displayed front PTS) computed in the present worker at
  // the SAME draw instant (both clocks live), so MAIN never subtracts a stale `current_ms` from a fresh audio
  // read (mpv update_av_diff). getStats() surfaces it; MAIN no longer derives av_diff cross-realm.
  | { type: 'time'; ms: number; avDiffMs: number }
  | { type: 'plog'; m: string } // DIAGNOSTIC: present-worker per-tick view → main emits Events.LOG → /pumplog
  // A WebCodecs VideoFrame's display dims changed (the worker fills WC dims, which the demuxer reports
  // as 0) → main updates mediaInfo videoWidth/Height + re-emits MEDIA_INFO.
  | { type: 'vdims'; w: number; h: number }
  // Present-ring depth vs its cap + the AUTHORITATIVE present rate (frames actually drawn/sec), for
  // getStats()/the overlay + the counter channel. Throttled (piggybacks the ~4 Hz pstats post).
  // Also carries the present-cadence (smoothness) measured over the TRUE trailing-1s rolling
  // window — presentFps (draw rate over the window) + mean/p95/max inter-draw interval (ms) + a stutter
  // count (steady-state intervals > 2× the content frame period) + seamGaps (reset/re-anchor freezes,
  // counted separately so a reconnect freeze stays visible but distinct from steady-state stutter).
  //
  // CLOCK/DRAW instrument (MEASURE-ONLY; no pacing/clock change) — pins WHY distinct draws can pace below
  // the content rate on a seam-free source. All measured over the SAME post window:
  //   clockAdvanceFps     — content-frames the MEDIA CLOCK crossed per wall-second (50 = healthy; 46 = the
  //                         audio-master clock genuinely ran slow → the REAL present pace, not a draw loss).
  //   clockRateRatio      — media-clock advance ÷ wall elapsed (×realtime; 1.0 = locked, <1 = clock slow).
  //   clockResidualMs     — |audioTarget − smoothed mediaUs| at the last audio-locked sample (the PLL
  //                         correction load; ~0 = locked, large = the SAB audio sample is dragging the clock).
  //   rafFps              — TOTAL rAF ticks/sec (the present callback rate ≈ display Hz; the draw headroom).
  //   presentDropsPerSec  — ring frames EVICTED WITHOUT being displayed, per sec (lost to the ring drop-
  //                         oldest / clock catch-up). drops≈0 + distinct≈46 ⇒ the clock paced to 46 (real);
  //                         drops≈4 ⇒ 4 frames lost to the ring (a different fault than a slow clock).
  //
  // DISPLAY-CADENCE instrument (the mpv-style Bresenham fix; same post window) — the anti-judder core:
  //   vsyncIntervalMs   — the MEASURED display refresh interval the cadence runs against (≈13.3 ms @ 75 Hz;
  //                       the nominal 60 Hz fallback until the rAF estimator adopts the real refresh).
  //   displayHz         — measured refresh in Hz once adopted (0 = still on the nominal fallback / warmup).
  //   cadenceHoldMean   — mean hold count over recent frames (vsyncs/frame); 50-on-75 → ~1.5 = a clean
  //                       alternating 1,2 cadence (the deterministic anti-judder pattern).
  //   cadenceHold2Frac  — fraction of recent holds that were 2 vsyncs (~0.5 for the 50-on-75 1,2 beat).
  //   cadenceErrorMs    — |sigma-delta accumulator| (ms); BOUNDED (≲ half a vsync) when the cadence is
  //                       healthy — an unbounded climb would flag a broken accumulator.
  //   syncResyncsPerSec — VLC-style hard-resyncs/sec (cadence desynced > ~120 ms from audio); ≈0 on a
  //                       clean clip — a non-zero rate flags A/V drift or guard thrash.
  //
  // GRACEFUL-DEGRADATION ladder (the bandwidth/decode-bound-client fix; same post window):
  //   cadenceTier          — the EFFECTIVE present-cap tier: 1 = full rate, 2 = half (present every other
  //                          frame, hold it 2× longer). Engaged only at the top ladder rung (rung 3).
  //   cadenceDrawRate      — the effective DRAW target (fps) = content rate ÷ effective tier (≈25 at tier 2).
  //   cadenceDegradeReason — 0 = none; 1 = an auto ladder rung is engaged; 2 = manual present-cap override.
  //   cadenceRung          — the graduated auto-degrade rung: 0 none · 1 skip-non-ref · 2 +skip-loop · 3 +present-cap
  //   cadenceDropToKey     — Fix-B rung-4 fires this load (Live drop-to-keyframe); 0 on a healthy stream.
  //                          (present-cap; skip-non-ref/skip-loop = the decode-worker skips). The active levers are read off it.
  | { type: 'pstats'; ring: number; cap: number; presentFps: number; presentIntervalMs: number; presentIntervalP95Ms: number; presentIntervalMaxMs: number; presentStutters: number; presentSeamGaps: number; clockAdvanceFps: number; clockRateRatio: number; clockResidualMs: number; rafFps: number; presentDropsPerSec: number; vsyncIntervalMs: number; displayHz: number; cadenceHoldMean: number; cadenceHold2Frac: number; cadenceErrorMs: number; syncResyncsPerSec: number; cadenceTier: number; cadenceDrawRate: number; cadenceDegradeReason: number; cadenceRung: number; cadenceDropToKey: number }
  // Graceful-shutdown ack (the present worker has no engine/pool, so it acks immediately). FIX2:
  // carries `framesClosed` — the count of WebCodecs VideoFrames it actually close()d while emptying its
  // ring. Receiving the ack CONFIRMS the ring is empty (openVideoFrames → 0), so main records the OBSERVED
  // post-teardown state from the owner rather than zeroing a mirror itself (which couldn't ever fail).
  | { type: 'destroyed'; framesClosed: number }
  | { type: 'error'; message: string };
