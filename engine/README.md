# ferrite engine — the in-browser decode core

`assets/ferrite.{mjs,wasm}` is the threaded FFmpeg WASM engine the player worker imports to decode
MPEG-TS / Matroska / MP4 (HEVC / H.264 / MPEG-2 video + AAC / AC-3 / E-AC-3 / MP2 / MP3 audio) and
run the avfilter deinterlacer — all via FFmpeg `avcodec`. It is a **separate emcc artifact** (not
built by tsup): `ferrite.c` (the demux + `ferrite_vdec` video + `ferrite_audio` audio reactor) is
linked against a purpose-built FFmpeg subset and emitted as an ES6 module (`MODULARIZE`,
`EXPORT_ES6`, `-pthread`, SIMD, **growable shared memory**).

ferrite.js ships the **prebuilt** engine in `../assets/` so npm consumers never have to build it.
The C **source** lives here in `engine/` so the engine can be rebuilt and developed standalone — no
external repo needed. (Source in the repo, prebuilt in the published package.)

## Self-contained build

`build-engine.sh` builds everything from source — **no external dependencies**. It downloads a
pristine FFmpeg tarball (version read from `engine/ffmpeg-version`), cross-compiles the decode subset
to wasm via emscripten, links `ferrite.c`, and writes the matched `ferrite.{mjs,wasm}` pair
**directly into `../assets/`** (the vendored, npm-published engine — so the two files are always
produced together and never drift):

- demuxers: `mpegts` (live) + `matroska` (.mkv/.webm) & `mov` (.mp4/.mov/.m4a) for VOD
- decoders: `hevc`, `h264`, `mpeg2video`, `aac`, `ac3`, `eac3`, `mp2`, `mp3`
- parsers: `hevc`, `h264`, `mpegvideo`, `aac`, `ac3`, `mpegaudio`
- bsf: `hevc_metadata`, `h264_metadata`, `extract_extradata`
- filters: `bwdif`, `format`, `aresample`; `swresample`
- **no** swscale, **no** muxers (demux-only)

```bash
cd engine && bash build-engine.sh      # → ../assets/ferrite.{mjs,wasm}
rm -rf engine/build                    # clean rebuild
```

**Opt level (lever): `FERRITE_OPT=Oz|Os|O2|O3`, default `-O3`.** A single env var sets the opt level
for the whole engine (FFmpeg `.a`'s + `ferrite.o` + link); it is folded into the config hash, so
changing it forces a clean FFmpeg re-extract+rebuild (no stale `.a` reuse):

```bash
FERRITE_OPT=Oz bash build-engine.sh    # smallest wasm
FERRITE_OPT=O3 bash build-engine.sh    # most decode headroom (current default)
```

It is a size ↔ software-decode-headroom trade: 4K-HEVC software decode is the moat, and the smaller
opt levels still clear realtime by a wide margin, so the bigger levels buy decode *headroom* at a real
wasm-size cost. Measured size × decode-fps table (the joint-decision surface) is captured by the
build-size sweep — pick the level there.

**Threading:** standard emscripten pthreads (`-pthread`, per-instance `PTHREAD_POOL_SIZE`). The
engine runs **cross-origin isolated** (SharedArrayBuffer present) → real Worker-backed threads →
parallel decode. This is mandatory for realtime 4K HEVC *software* decode (the only HEVC path where
there is no hardware decoder). Served without cross-origin isolation the wasm fails to instantiate by
design (COI is the caps gate); it does not silently degrade.

**Growable memory:** the engine starts at 256 MiB and grows on demand to a 2 GiB ceiling
(`ALLOW_MEMORY_GROWTH`). A grow REPLACES the `SharedArrayBuffer`, so every FFI consumer MUST read
`HEAPU8` **fresh per access** (never cache the view across an allocating call). The worker bindings
(`src/worker/ferrite-bindings.ts`) already do this.

## Prerequisites (external)

- **emsdk** active — the script sources `~/emsdk/emsdk_env.sh` (or `$EMSDK_ROOT/emsdk_env.sh`). Pin
  the same emcc version locally and in CI so the wasm is reproducible (current: emcc 6.0.0).
- Network at first build to fetch the FFmpeg tarball (cached in `.ffmpeg-cache/` after). For
  offline/CI, pre-stage it and set `FERRITE_FFMPEG_TARBALL=/path/to/ffmpeg-<ver>.tar.xz`.

## Files

| file | role |
|---|---|
| `ferrite.c` / `ferrite.h` | the FFmpeg reactor (demux + video/audio decode + deint) |
| `build-engine.sh` | self-contained production build → `../assets/ferrite.{mjs,wasm}` |
| `build-engine-asan.sh` | ASan-instrumented engine for the node memory gates → `ferrite_asan.{mjs,wasm}` |
| `ferrite.exports` | emcc `EXPORTED_FUNCTIONS` list (the `ferrite_*` entrypoints) |
| `ffmpeg-version` | pinned FFmpeg version (engine-local single source of truth) |

`build/` (FFmpeg source + wasm libs) and `ferrite_asan.{mjs,wasm}` are gitignored. The published
`assets/ferrite.{mjs,wasm}` are committed (the prebuilt npm artifact).

> NOTE: the subset enables the `hevc` decoder, which is load-bearing beyond HEVC playback — it defines
> `CONFIG_HEVC_SEI`, which resolves a film-grain symbol the h264 SEI path references on the pristine
> FFmpeg source. Don't drop the `hevc` decoder without re-checking that link.

## Test harnesses

The node gates in `../tests/` exercise this engine without a browser (decode-throughput sweep,
growable-memory verification, the streaming-ring leak check, and the DOM-free facade/policy/error
unit tests). See `../tests/README.md`.
