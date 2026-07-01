# Changelog

All notable changes to **ferrite.js** are documented here. The project follows
[Semantic Versioning](https://semver.org).

## 1.3.4

### Audio
- **The audio path now runs entirely off the main thread — playback no longer stutters or freezes when the
  page or video decode is busy.** Audio decode runs in its own worker, and audio playout + the master clock
  now live in an AudioWorklet driven by a shared-memory ring instead of a main-thread timer. The clock can
  no longer stall when the main thread is busy (the old cause of brief picture freezes under load), and a
  heavy software decode (e.g. 4K HEVC without hardware) can never block audio. Lip-sync, the 5.1→stereo
  downmix, the loudness leveler, and the Dyna control are all preserved.
- **On iOS/iPad, audio now starts automatically on the first tap** — no manual pause/resume — and recovers
  by itself after interruptions (a call, Siri, switching output). The embedding app can hand the player a
  shared, gesture-unlocked AudioContext via the new `attachAudio()`; standalone use still works as before.

### Video
- **Live HEVC and H.264 now decode on the hardware (WebCodecs) path on Apple devices (iPad/iPhone/Safari).**
  Live streams carry their parameter sets in-band, which Apple's hardware decoder handles unreliably; the
  engine now feeds live the same strict form video-on-demand already used (an out-of-band hvcC/avcC config
  record + length-prefixed access units), built with FFmpeg's own functions. Clients without HEVC hardware
  still fall back cleanly to software.
- **Smoother playback on clients that can't keep up with a heavy software decode** (e.g. 4K HEVC 10-bit
  with no hardware HEVC). When even the safe quality levers can't reach realtime on a live stream, the
  player now sheds load one whole group-of-pictures at a time — skipping to the next keyframe and resuming
  cleanly — instead of dropping frames blindly mid-sequence (which corrupted the picture or could stall the
  decode). The loss is bounded to a single GOP and a keyframe is always shown, so the picture never freezes.
  Live + software only; on-demand playback keeps every frame.

### Performance & memory
- **Lower memory use, and reliable startup on memory-constrained devices (iPad/iPhone).** The player now
  runs as four right-sized worker realms (demux, video decode, audio decode, presentation) instead of every
  realm reserving the full 4K/HEVC video budget — so startup no longer fails with `EngineInitFailed` on a
  tight memory device. Reserved address space drops from ~2 GiB to ~1.6 GiB and peak usage at 4K from
  ~1.4 GiB to ~1 GiB.

### Reliability & fidelity
- **Picture and sound return to tight lip-sync after a pause/resume — and on the hardware (WebCodecs) path —
  instead of sticking at a fixed offset.** When the video ran ahead of the audio master clock (typically after
  a live pause/resume re-anchor, or on the several-frames-deep WebCodecs pipeline), the offset used to latch at
  ~120 ms and never close. The presenter now holds the current frame while it leads the clock by more than one
  display refresh (mpv's display-sync tolerance), so the offset bleeds off in whole-vsync steps and converges
  to within one frame — the mirror of the existing behind-side frame drop, and bounded so it can never freeze.
- **More resilient live start on slow origins.** The per-attempt connect timeout is now 16 s (was 8 s), so a
  portal/upstream that takes 10-15 s to deliver its first byte is no longer aborted before it comes up.
- **Cleaner live HEVC/H.264 start on the software path.** The software decoder is now built with the stream's
  captured parameter sets up front, so the first keyframe decodes even on streams that carry their parameter
  sets sparsely (rather than re-sending them with every keyframe). Open-GOP HEVC leading pictures that can't
  be decoded from a random-access point are now skipped cleanly instead of producing a corrupt first GOP.
- **New `fastDecode` option** (default off): opt into non-spec-compliant software-decode speedups
  (mpv `--vd-lavc-fast`) to steady the cadence on decode-bound 4K without hardware.

## 1.3.2

### Audio
- **The audio path was overhauled — smoother and steadier, especially when video decode loads the
  device.** Surround sources (e.g. 5.1) are downmixed to stereo and resampled to the AudioContext rate
  in a single engine pass (replacing Web Audio's per-chunk downmix/resample), and a loudness leveler
  evens out sources with wildly different volume. Audio remains the master clock; the reservoir is
  bounded so a heavy software decode no longer starves it.
- **New "Dyna" audio-dynamics control (Line / RF / Night).** *Line* plays the full dynamic range, *RF*
  uses AC-3 / E-AC-3 heavy compression (small speakers / loud rooms), and *Night* is a built-in
  feed-forward compressor that tames loud peaks for **any** codec on **both** the hardware and software
  tiers (quiet late-night listening). Exposed via `player.setDrc(0|1|2)` and the controls bar.

### Video
- **Anamorphic (non-square-pixel) sources now render with the correct shape on the hardware (WebCodecs)
  path too**, not only in software. The pixel aspect is resolved from the first decoded keyframe and
  applied on both tiers, in a window and fullscreen.
- **Correct HEVC sizing on browsers that report bogus `VideoFrame` dimensions** (e.g. Edge's hardware
  HEVC path stamps a constant 1280×720). The display height is verified against the frame's own coded
  height and the upload is corrected only when a decoder is demonstrably misreporting — every honest
  browser/stream stays on the zero-overhead path.

### Demo / tooling
- **The demo's capability-matrix fixtures are now self-contained**: `demo/gen_matrix.sh` generates the
  full `cap_*` clip set (containers × codecs × resolutions × scan × audio, plus anamorphic and
  10-bit HLG + 5.1) locally with `ffmpeg`. The demo server streams them as faux-live (TS) or
  range-served VOD (MP4/MKV).

## 1.3.1

- Repository moved to GitHub.
- Restored the display-refresh row in the debug overlay.

## 1.3.0

Initial **Ferrite** release — a canvas + WebAssembly player that decodes live MPEG-TS and VOD
(MP4/MKV) **entirely in the browser**, as a drop-in-shaped replacement for mpegts.js geared for IPTV.

- **HEVC, H.264 and MPEG-2 in software** via a purpose-built FFmpeg-WASM engine (multi-threaded
  decode), for devices with no hardware HEVC — with an automatic **WebCodecs** hardware tier when the
  browser can decode the codec, and a clean fallback to software (never a dead black screen).
- **Movies & series (VOD)** stream as MP4/MKV without pre-loading the whole file: playback starts once
  the header is read, and seeking fetches only the targeted range (scrub bar + total duration when the
  source allows seeking).
- **Picture quality:** correct colors (matrix/range from the stream metadata), HDR tone-mapping
  (PQ/HLG, BT.2020 → BT.709), native 10-/12-bit decode rendered on the GPU, dithering against banding,
  and correct aspect for anamorphic sources.
- **Smooth playback:** audio is the master clock and video is paced to it; the output adapts to any
  display refresh rate, with a gentle latency sync that holds the live edge and graceful degradation
  under sustained load.
- **Deinterlacing** (Off / Auto / Bwdif) for interlaced sources (e.g. 1080i).
- **Robust against dropouts:** reconnect with backoff, an adaptive watchdog for stalled connections,
  self-healing of a wedged hardware decoder, and a clean teardown that frees the thread pool and GPU
  resources (no resource growth across play/stop cycles).
- **Controls:** an opt-in, framework-free auto-hiding control bar + a long-press diagnostic overlay,
  useful on devices without a developer console.
- Requires a **cross-origin-isolated secure context** (HTTPS or `localhost`) for SharedArrayBuffer.
