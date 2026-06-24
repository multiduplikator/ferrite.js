# AGENTS.md

Guidance for AI agents and contributors working on **ferrite.js** — a canvas + WebAssembly video
player shaped as a drop-in replacement for [mpegts.js](https://github.com/xqq/mpegts.js), **geared
for IPTV** (live MPEG-TS channels + VOD movies/series over HTTP, in Xtream/M3U/Stalker shapes). It
decodes via a software FFmpeg-WASM path **and** a hardware WebCodecs path, rendering to a `<canvas>`
with WebAudio, for the no-hardware-HEVC niche.

**Supported formats** (the engine is a scoped FFmpeg subset — `engine/build-engine.sh`):
- Containers: MPEG-TS, MP4/MOV, Matroska/WebM — **probed by content**, not the URL extension.
- Video: H.264, H.265/HEVC, MPEG-2 (8/10-bit, bwdif deinterlace).
- Audio: AAC, AC-3, E-AC-3, MP2, MP3 — always software-decoded (audio is the master clock).

## Architecture — split-realm

The player runs across three realms; main is a **thin facade**.

- `src/index.ts` — the public, mpegts.js-shaped facade (`createPlayer`, `attachCanvas`, `load`,
  `play`/`pause`, `seek`, `on(Events.*)`). Lives on the **main thread**: coordinator + the
  `AudioContext` (audio is the **master clock**) + events/errors/stats. Spawns the two workers.
- `src/worker/worker.ts` — the **decode** worker: the FFmpeg-WASM engine, demux + decode, posts
  video frames to the present worker over a `MessageChannel`.
- `src/worker/present-worker.ts` — the **present** worker: owns the transferred `OffscreenCanvas` +
  WebGL2 + the rAF present loop + the frame ring/eviction + the present clock.
- **Cross-realm clock**: main publishes audio-playout elapsed into a `SharedArrayBuffer`; the present
  worker reads it via `Atomics` as its `media_now`. This is the only shared-memory coupling and is
  why the player needs `crossOriginIsolated`.
- `src/source/capabilities.ts` — the live/VOD `SourceCapabilities` descriptor (seekable / bounded /
  hasLiveEdge / declaredLive), derived from intent + first-response headers.
- `src/controls/` — optional, framework-free controls bar + long-press debug overlay
  (`ferrite.js/controls`). The library works headless without it.
- `engine/` — the C engine (`ferrite.c`/`ferrite.h`) compiled to `assets/ferrite.{mjs,wasm}`.

## Build & run

- `npm run build` — **release** bundle via tsup. Four standalone entries: `index`, `worker`,
  `present-worker`, `controls`. Minified, with `DEBUG` folded to `false` so every `if (DEBUG)`
  diagnostic branch is dead-code-eliminated (zero diagnostic cost shipped).
- `npm run build:debug` / `npm run dev` — `FERRITE_DEBUG=1`: unminified, full instrumentation.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run demo` — debug build + `node demo/serve.mjs` (serves with COOP/COEP so the page is
  cross-origin isolated). Open the printed URL.

The TS build does **not** build the wasm engine. `assets/ferrite.{mjs,wasm}` are prebuilt and
committed. To rebuild the engine you need [emscripten](https://emscripten.org): run
`engine/build-engine.sh` (default `-O2`, stripped release). It fetches/caches FFmpeg, compiles the
scoped decoder/demuxer set + `ferrite.c`, and emits the artifacts. The `engine/` `.c`/`.h` + build
scripts + LGPL notice are the only engine sources tracked; the build tree is gitignored.

## Tests

Plain Node test files under `tests/` (no runner). Run one directly, e.g.
`node tests/leakgate.mjs`. They import from `src/` and, where decode is exercised, need media
fixtures — regenerate with `tests/fixtures/gen_clips.sh` (needs ffmpeg with libx265/libx264). See
`tests/README.md`.

## Conventions

- TypeScript strict, ESM only. Keep diagnostics behind `if (DEBUG)` so they strip in release.
- The workers must stay **self-contained** (tsup `splitting: false`) — a module Worker can't import a
  shared chunk. The engine is loaded at runtime via the host-served `wasmBaseUrl`, not bundled.
- Commit style: Conventional Commits (`feat:`, `fix:`, `chore:`, `build:`, …).
- **This is a public repository.** Keep the codebase self-contained: no references to other repos,
  internal/private projects, build hosts, or personal identities — in code, comments, or commit
  messages. Design lineage is referred to generically as "the reference player." Authorship uses the
  project pseudonym **multiduplikator**.

## Gotchas

- **Isolation**: needs `crossOriginIsolated` (COOP `same-origin` + COEP `require-corp`/
  `credentialless`) for `SharedArrayBuffer`. Without it, `load()` emits an explicit
  unsupported-codec error and degrades gracefully — it does not throw.
- **Worker URLs from a bundler**: the facade spawns workers via
  `new Worker(new URL('./worker.js', import.meta.url))`. Some app bundlers don't rewrite this when it
  originates inside `node_modules`; pass `workerUrl` / `presentWorkerUrl` in the config to point at
  same-origin copies of `dist/{worker,present-worker}.js`.
- **WebCodecs vs software**: HEVC over WebCodecs is platform-dependent. The software (FFmpeg-WASM)
  tier is the fallback and the reason this library exists.
