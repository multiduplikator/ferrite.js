// Message protocol for the split-realm pipeline.
//
// Architecture (split-realm present): there are TWO
// workers plus the main thread.
//   - DECODE worker  (worker.ts)         — ingest + demux + ffmpeg/WebCodecs decode ONLY. Posts
//                                          decoded VIDEO frames straight to the PRESENT worker over a
//                                          MessageChannel (bypassing main), and audio PCM / stats /
//                                          lifecycle to main.
//   - PRESENT worker (present-worker.ts) — owns the transferred OffscreenCanvas + WebGL2 + the rAF
//                                          present loop + the ring/eviction + the present clock. Reads
//                                          the audio master clock from a SharedArrayBuffer that main
//                                          publishes. Recycles software plane buffers back to the
//                                          decode worker over the same MessageChannel.
//   - MAIN (index.ts)                    — the thin facade: events, errors, stats, liveSync knobs, and
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
/** Int32 slots in the clock SAB — exactly the two below (C_ACLOCK, C_AUDIO). No A_RATE/rate-publish
 *  residue exists, so there is nothing to reserve; sized to what is actually published (was an
 *  over-allocated 8). */
export const CLOCK_SLOTS = 2;
/** Audio playout elapsed since the audio epoch, MILLISECONDS (i32 → wrap-safe ≈24.8 days, vs µs which
 *  saturated i32 at ≈35.8 min). MONOTONIC within an audio epoch (an underrun re-anchors the SCHEDULE,
 *  not this clock — see index.ts publishClock). main writes; the present worker reads. */
export const C_ACLOCK = 0;
/** 1 while audio is the live master clock (≈ the reference player's `A_RATE > 0` has-audio gate), else
 *  0 (startup grace / video-only). main writes; the present worker reads. */
export const C_AUDIO = 1;

// ---------------------------------------------------------------------------
// Main → DECODE worker.
// ---------------------------------------------------------------------------
export type MainToWorker =
  // `lowWater*` carry the adaptive-low-water config (resolved from FerriteConfig): the FLOOR the
  // demux ring relaxes toward on low-bitrate streams, the CEILING (= the 4K-HEVC full-PES correctness
  // floor) it never exceeds, and whether adaptive sizing is on (off ⇒ the fixed ceiling, the pre-adaptive default).
  // `isIOS`/`isAppleWebKit` are detected ONCE on the main thread (a WorkerNavigator has no
  // maxTouchPoints, so the worker can't redo iPadOS-as-desktop detection) and forwarded here.
  // `presentPort` is THIS worker's end of the decode↔present MessageChannel — decoded frames are
  // transferred over it (NOT to main) and recycled plane buffers come back over it.
  // `ringCap` is main's RING_CAP — the SINGLE SOURCE OF TRUTH for the software in-flight bound. The
  // worker caps its decode credits at this value so it can NEVER decode past main's present-ring
  // capacity (was a hardcoded MAX_CREDITS=48 in the worker that drifted when RING_CAP dropped to 12).
  // (The present-ring ACCEPT cap — RING_CAP+RING_HEADROOM — is NOT carried here: the decode worker gates
  // on `ringCap` credits 1:1 (no-drop, contiguous ring); the accept cap + the WC present-ring cap live in
  // the PRESENT worker, delivered over `present-init`. (The WC feed gate is `decodeQueueSize`-only —
  // deadlock fix.))
  | { type: 'init'; wasmBaseUrl: string; threads: number; lowWaterFloor: number; lowWaterCeiling: number; lowWaterAdaptive: boolean; isIOS: boolean; isAppleWebKit: boolean; presentPort: MessagePort; ringCap: number }
  // `gen` tags this load so stale ingest/pump loops from a prior load self-cancel (unload→load
  // reuse). `isLive` is the caller's DECLARED intent (createPlayer({isLive})) — it FEEDS the worker's
  // SourceCapabilities descriptor (deriveCapabilities), which the worker then refines from the first
  // response's headers and posts back as `caps`. `preferWebCodecs` lets the worker pick the hardware
  // tier when the demuxed codec is VideoDecoder.isConfigSupported(); software fallback per-codec when not.
  | { type: 'load'; gen: number; url: string; isLive: boolean; preferWebCodecs: boolean }
  // Live pause: while paused the worker keeps the network flowing and DISCARDS packets
  // (tracking the live edge); on resume it awaits the next keyframe so decode restarts clean.
  // VOD pause HOLDS position (no discard); resume continues from the same byte offset.
  | { type: 'setPaused'; paused: boolean }
  // VOD seek (range-streamed file only; ignored live): av_seek_frame to targetMs (backward → the
  // keyframe at/before) + flush the decoders, then stream fresh frames from there. The worker
  // coalesces rapid scrubs (last target wins).
  | { type: 'seek'; targetMs: number }
  | { type: 'credit'; n: number } // grant N decode credits (initial seed only; recycle replenishes over the port)
  // Stop the current stream pipeline (free demux/decoders) but keep the engine loaded so a
  // subsequent `load` can reuse it. `gen` invalidates in-flight loops from the unloaded run.
  | { type: 'unload'; gen: number }
  // Levers 2 & 3: the engine decode-relief skip toggles, settable mid-stream. The
  // worker remembers them and re-applies (ferrite_vdec_set_skips) after every (re)create so the choice
  // persists across a codec change / WC→SW fallback / VOD seek. `skipNonref` discards non-reference
  // frames (~half the decoded frames + decode work); `skipLoop` skips the in-loop deblock (all
  // frames kept, slightly softer). Both off = the banked full decode.
  | { type: 'setSkips'; skipNonref: boolean; skipLoop: boolean }
  // Runtime deinterlace-mode override (0=off, 1=auto, 3=bwdif), settable mid-stream. The worker
  // remembers it and re-applies (ferrite_vdec_set_deint) after every (re)create. Software tier only —
  // the WebCodecs/HW tier deinterlaces in hardware.
  | { type: 'setDeint'; mode: number }
  // Audio dynamics ("Dyna") mode (0=line, 1=RF/heavy, 2=night), settable mid-stream. The worker remembers
  // it and re-applies (ferrite_audio_set_drc) after every audio-decoder (re)create. Both tiers (audio is
  // always software-decoded). Night = the engine's universal feed-forward compressor (codec-independent).
  | { type: 'setDrc'; mode: number }
  // The AudioContext output sample rate, forwarded from main once audio is set up: the engine resamples
  // to it in one stateful swresample pass (replacing Web Audio's per-chunk resample). 0 = passthrough.
  | { type: 'setAudioOutRate'; rate: number }
  | { type: 'destroy' };

// ---------------------------------------------------------------------------
// DECODE worker → main. (Video frames do NOT go here — they go to the present worker over the port.)
// ---------------------------------------------------------------------------
export type WorkerToMain =
  | { type: 'ready'; info: WorkerMediaInfo }
  // The resolved SourceCapabilities descriptor, computed ONCE per load from
  // the declared intent + the FIRST response's headers (no extra round-trip). Drives the main-side
  // live/VOD forks: seek() (seekable), the duration getter/seekbar (seekable), the live-edge catch-up +
  // live-sync (hasLiveEdge). Posted after the first connect (live) / HttpSource.open (VOD).
  | { type: 'caps'; caps: SourceCapabilities }
  | { type: 'log'; message: string }
  | { type: 'audio'; sampleRate: number; channels: number; ptsUs: number; pcm: Float32Array }
  // VOD: the container duration in ms (0 = unknown), reported once after the demuxer opens — drives the
  // facade `duration` getter + the scrub bar. Live never sends this (duration stays Infinity).
  | { type: 'duration'; durationMs: number }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'deintFailed'; failed: boolean } // avfilter deint graph won't build for this geometry
  // Clean end of the source (VOD finished, or a non-live stream closed) → host LOADING_COMPLETE.
  | { type: 'ended' }
  // a live stream dropped recoverably (network drop / upstream-silence) and the worker is
  // re-opening with backoff. Drives the facade controller Playing/Buffering → Reconnecting. `attempt`
  // is the 1-based backoff attempt (0 = an immediate seamless boundary reconnect is NOT posted — only a
  // real backoff drop flips the facade state, so a clean boundary stays Playing).
  | { type: 'reconnecting'; attempt: number }
  // a live stream that dropped has RECONNECTED and bytes are flowing again → host
  // RECOVERED_EARLY_EOF (and the facade clears the recoverable EarlyEof it surfaced during retries).
  | { type: 'recovered' }
  // Shutdown handshake ack: the worker has freed demux/decoders AND terminated the pthread pool
  // (Module.PThread.terminateAllThreads()); main may now worker.terminate() the coordinator with
  // no orphaned decode Workers. Main also has a timeout fallback if this never arrives.
  | { type: 'destroyed' }
  // A failure, pre-classified into a ferrite failure KIND. The facade maps the kind onto the
  // verbatim mpegts (type, details, info) strings (errors.ts).
  | { type: 'error'; kind: FerriteFailureKind; code: number; msg: string; fatal: boolean };

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
  | { type: 'autoSkips'; skipNonref: boolean; skipLoop: boolean };

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
  // Flush the ring (recycling software buffers back to the decode worker) + re-arm the present clock so
  // the next frame re-anchors a fresh timeline. `gen` lets a `dropVideoFrames` race be filtered. Sent
  // on (re)load / unload / seek / live-resume — exactly where main used to recycleRing()+resetClock().
  | { type: 'reset'; gen: number }
  // Lever 1: the MANUAL present=half override. `present:true` forces the tier-2
  // present-rate cap independent of the auto-degrade trigger; `false` returns to adaptive (auto only).
  // A session toggle — it survives a reset()/(re)load (unlike the auto tier, which re-arms per timeline).
  | { type: 'setLever'; present: boolean }
  | { type: 'destroy' };

// ---------------------------------------------------------------------------
// PRESENT worker → main.
// ---------------------------------------------------------------------------
export type PresentToMain =
  // The freshly-drawn front frame's PTS (ms) → facade currentTime + TIME_UPDATE. Throttled.
  | { type: 'time'; ms: number }
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
  //                          (present-cap; skip-non-ref/skip-loop = the decode-worker skips). The active levers are read off it.
  | { type: 'pstats'; ring: number; cap: number; presentFps: number; presentIntervalMs: number; presentIntervalP95Ms: number; presentIntervalMaxMs: number; presentStutters: number; presentSeamGaps: number; clockAdvanceFps: number; clockRateRatio: number; clockResidualMs: number; rafFps: number; presentDropsPerSec: number; vsyncIntervalMs: number; displayHz: number; cadenceHoldMean: number; cadenceHold2Frac: number; cadenceErrorMs: number; syncResyncsPerSec: number; cadenceTier: number; cadenceDrawRate: number; cadenceDegradeReason: number; cadenceRung: number }
  // Graceful-shutdown ack (the present worker has no engine/pool, so it acks immediately). FIX2:
  // carries `framesClosed` — the count of WebCodecs VideoFrames it actually close()d while emptying its
  // ring. Receiving the ack CONFIRMS the ring is empty (openVideoFrames → 0), so main records the OBSERVED
  // post-teardown state from the owner rather than zeroing a mirror itself (which couldn't ever fail).
  | { type: 'destroyed'; framesClosed: number }
  | { type: 'error'; message: string };
