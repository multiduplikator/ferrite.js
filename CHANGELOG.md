# Changelog

All notable changes to **ferrite.js** are documented here. The project follows
[Semantic Versioning](https://semver.org).

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
