# ferrite.js

A **canvas + WebAssembly** video player for the browser, shaped as a **drop-in replacement for
[mpegts.js](https://github.com/xqq/mpegts.js)** and **geared for IPTV** — live MPEG-TS channels and
VOD movies/series (MP4/MKV) as delivered by IPTV providers (Xtream / M3U / Stalker). It decodes with
a software FFmpeg-WASM path **and** a hardware WebCodecs path, rendering to a `<canvas>` with
WebAudio — so it plays codecs the browser's `<video>` element can't, most notably **HEVC where there
is no hardware decoder**.

```
URL ─▶ fetch ─▶ [worker] demux (mpegts/PES) ─▶ decode ─┬─ software: FFmpeg-WASM ─▶ YUV planes ─┐
                                                        └─ hardware: WebCodecs   ─▶ VideoFrame ─┴─▶ WebGL2 <canvas>
                                            audio: FFmpeg-WASM ─▶ PCM ─▶ WebAudio (master clock)
```

## Why this exists — the no-HW-HEVC niche

`<video>` + mpegts.js/MSE can only play what the browser's media stack supports. On a machine with
**no hardware HEVC decoder** (and increasingly that is the default in browsers/PWAs), HEVC simply
won't play — `addSourceBuffer('video/mp4; codecs="hvc1"')` is rejected. ferrite.js carries its own
FFmpeg decoder compiled to WebAssembly and decodes HEVC **in software**, on worker threads, fast
enough for live 4K. Where the browser *does* have a hardware decoder for a codec (e.g. H.264), it
uses WebCodecs instead for near-zero CPU. That two-tier behaviour is automatic and per-stream.

This is a genuine gap mpegts.js cannot fill (it is bound to MSE/`<video>`), which is the whole reason
ferrite.js diverges from a literal drop-in in exactly one place (see below).

## Two decode tiers

| Tier | Path | When |
|---|---|---|
| **software** | FFmpeg → WASM (pthreads) → YUV → WebGL2 | always available; the only HEVC path on a no-HW box; interlaced / MPEG-2 |
| **webcodecs** | `VideoDecoder` → `VideoFrame` → WebGL2 | when the browser hardware-decodes the stream's exact codec (e.g. H.264) |

Tier selection happens once the demuxer reveals the codec; it falls back to software cleanly (an
unsupported codec, or a HW reject before the first frame, never produces a dead screen). The active
tier is reported on `player.tier` / `statisticsInfo.tier`.

## Supported formats

Geared for IPTV delivery — live MPEG-TS channels and VOD (movies/series) streamed over HTTP, in the
common Xtream/M3U/Stalker shapes. The bundled engine is a **scoped FFmpeg subset**:

| | |
|---|---|
| **Containers** | MPEG-TS, MP4 / MOV, Matroska / WebM — **probed by content**, not the URL extension (IPTV `.mp4` URLs are frequently MKV) |
| **Video** | H.264 / AVC · H.265 / HEVC · MPEG-2 — 8- and 10-bit, with software deinterlacing (bwdif) |
| **Audio** | AAC · AC-3 · E-AC-3 (Dolby Digital / Digital Plus) · MP2 · MP3 |

Audio is **always** decoded in software (it is the master clock that paces video); video uses the
hardware WebCodecs tier when the browser can decode the stream's exact codec, otherwise software.
Codecs outside this set surface a clean `unsupported-codec` error rather than a dead screen.

## Install

```bash
npm install ferrite.js
```

The package ships the prebuilt engine in `assets/ferrite.{mjs,wasm}` (~2 MB wasm). **Copy those two
files to a path your app serves** and point the player at it with `wasmBaseUrl` (they must be served
same-origin under COOP/COEP — see below). For example, with Vite, copy them into `public/assets/` and
set `wasmBaseUrl: '/assets/'`.

## Usage — the mpegts.js shape

```ts
import Ferrite, { Events } from 'ferrite.js';

const player = Ferrite.createPlayer(
  { type: 'mpegts', isLive: true, url: 'https://…/stream.ts' },
  { wasmBaseUrl: '/assets/', liveSync: true },
);

player.attachCanvas(document.querySelector('canvas'));   // ← the one divergence (see below)
player.on(Events.ERROR, (type, details, info) => console.error(type, details, info));
player.load();
await player.play();

// teardown (same call sequence as mpegts.js):
player.pause();
player.unload();
player.detachMediaElement();
player.destroy();
```

The static namespace mirrors mpegts.js: `createPlayer`, `isSupported`, `getFeatureList`, `version`,
`Events`, `ErrorTypes`, `ErrorDetails`, `LoaderErrors`. The player methods mpegts.js consumers expect
— `load` / `play` / `pause` / `unload` / `detachMediaElement` / `destroy` / `on` / `off` — are all
present, and `on(Events.ERROR, …)` fires `(type, details, info)` with the **verbatim mpegts.js
`ErrorTypes` / `ErrorDetails` strings**, so an existing mpegts.js error classifier works unchanged.

### The one divergence: `attachCanvas` instead of `attachMediaElement`

ferrite.js owns a `<canvas>` + WebAudio, not a `<video>`/MSE pipeline, so it cannot attach to a
`<video>` element. Use **`player.attachCanvas(canvas)`**. `attachMediaElement()` is kept as a guard
that throws loudly if you wire it like mpegts.js by habit. `play` / `pause` / `currentTime` /
`volume` / `muted` live on the player (there is no `<video>` to delegate to).

## Optional built-in controls + debug overlay

Because there is no `<video>`, there are no native controls. ferrite.js ships an **opt-in,
framework-free** control bar + diagnostic overlay you can attach in one call:

```ts
import { attachControls } from 'ferrite.js/controls';

const controls = attachControls(player, canvas);   // auto-hiding bar + long-press debug overlay
// ... later
controls.destroy();
```

- **Controls bar** (auto-hides after idle): play/pause, mute, volume, an **audio-dynamics ("Dyna")**
  selector (Line / RF / Night), a **deinterlace ("Deint")** selector (Off / Auto / Bwdif, shown on the
  software tier only), fullscreen, a **LIVE** badge for live, and a **scrub bar + time** for VOD.
- **Debug overlay** — *long-press the video* to toggle (off by default). Rows include `isolated`,
  `tier`, `format`, `status`, `clock`, decode/present cadence, buffers, and audio-sync. It is the
  perfect **first-run diagnostic on a device with no devtools**
  (e.g. an iPad PWA): if it shows **`isolated: NO (no SharedArrayBuffer)`**, your page is not
  cross-origin isolated and the decoder cannot run — fix COOP/COEP (below).

`attachControls(player, target, options?)` accepts either the `<canvas>` (it wraps it in a positioned
shell) or a container that already holds the canvas. Options: `autoHide`, `idleHideMs`, `longPressMs`,
`debugOverlay`, `persistVolume`, `volumeStorageKey`.

## ⚠ Requirement: a cross-origin-isolated secure context (COOP/COEP)

ferrite.js uses **SharedArrayBuffer** (worker decode threads + the WebCodecs path), which the browser
only exposes when the page is **cross-origin isolated** AND in a **secure context** (HTTPS or
`localhost`). You **must** serve the page with:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy:  require-corp        # or: credentialless
```

and the engine assets same-origin with `Cross-Origin-Resource-Policy: same-origin`. Without isolation,
`crossOriginIsolated === false`, there is no SharedArrayBuffer, and `load()` surfaces an explicit
`unsupported-codec` error instead of dying silently. The debug overlay's **`isolated: NO`** row is the
fastest way to confirm this in the field.

Notes:
- `COEP: require-corp` blocks cross-origin subresources without CORP headers (e.g. channel logos from
  arbitrary providers). Use **`COEP: credentialless`** (Chromium) or proxy those subresources
  same-origin if that bites.
- Plain HTTP on a LAN IP is **not** a secure context — `crossOriginIsolated` will be false even with
  the headers set. Use HTTPS or `localhost` (e.g. an SSH tunnel).
- The video stream itself should be fetched same-origin (proxy cross-origin streams), since COEP
  applies to the worker's `fetch`.

## Configuration highlights

`createPlayer(dataSource, config?)` — key `config` fields (see `FerriteConfig` for the full set):

| field | default | meaning |
|---|---|---|
| `wasmBaseUrl` | `'/'` | base URL serving `ferrite.mjs` + `ferrite.wasm` |
| `threads` | `8` | software decoder pthread pool size |
| `preferWebCodecs` | `true` | use the hardware tier when the codec is supported |
| `fastDecode` | `false` | allow non-spec-compliant **software** decode speedups (mpv `--vd-lavc-fast`) — steadies cadence on decode-bound 4K, slight quality tradeoff |
| `liveSync` | `false` | enable live latency-sync via playback-rate (set `true` for live) |
| `liveSyncTargetLatency` | `0.6` | target latency (s) the player converges toward |
| `liveSyncPlaybackRate` | `1.05` | max catch-up rate (sub-audible pitch; *not* mpegts's 1.2) |
| `stashAdaptive` / `stashInitialSize` / `stashMaxSize` | `true` / floor / 2 MiB | adaptive pre-demux buffer (low latency on SD/HD, full-PES floor for 4K) |
| `workerUrl` | (auto) | override the decode-worker URL (see "Bundlers" below) |

### Bundlers

The decode worker is spawned with the literal `new Worker(new URL('./worker.js', import.meta.url),
{ type: 'module' })` form, which webpack, Vite, and esbuild detect and bundle automatically — so the
zero-config path works for most setups. If your toolchain can't trace it (an unusual asset pipeline, a
strict CSP, or a bundler that doesn't support module workers), copy `dist/worker.js` to a path you
serve and pass `config.workerUrl` pointing at it.

Live tuning (adaptive low-water + sigmoid playback-rate latency-sync with a dead-band/gate to avoid
hunting) is derived from a battle-tested reference player; the defaults are good for IPTV.

## Demo

```bash
npm install
npm run build      # tsup → dist/ (ESM + .d.ts)
npm run demo       # → http://localhost:8650/
```

The demo server sets COOP/COEP/CORP and exposes `/proxy?url=<stream>` to pull a cross-origin stream
same-origin. Open the page (the header shows **● isolated**), paste an MPEG-TS URL (prefix
cross-origin URLs with `/proxy?url=`), and press Play. Hover for controls; long-press the video for
the debug overlay.

## Building from source / rebuilding the engine

The TypeScript player builds with [tsup](https://tsup.egoist.dev):

```bash
npm run build       # dist/index.js, dist/worker.js, dist/controls.js + .d.ts
npm run typecheck   # tsc --noEmit
```

The WebAssembly **engine** (`assets/ferrite.{mjs,wasm}`) is shipped **prebuilt** so npm consumers
never have to build it. Its C source + self-contained build script live in this repo under
[`engine/`](./engine), so you can rebuild it standalone (needs [emsdk](https://emscripten.org)):

```bash
cd engine && bash build-engine.sh         # → assets/ferrite.{mjs,wasm} (matched pair, in place)
```

The build downloads a pristine FFmpeg (version pinned in `engine/ffmpeg-version`), cross-compiles the
decode subset to wasm, links `ferrite.c`, and writes the matched `.mjs`+`.wasm` pair directly into
`assets/`. The engine is a threaded FFmpeg subset (mpegts/matroska/mov demux; HEVC/H.264/MPEG-2 video +
AAC/AC-3/E-AC-3/MP2/MP3 audio; bwdif deinterlacer), `-pthread` + SIMD, **growable shared memory**
(256 MiB → 2 GiB), exporting `HEAPU8` + `PThread`. See [`engine/README.md`](./engine/README.md) for
the full build details, and [`tests/README.md`](./tests/README.md) for the node verification gates.

## API surface

- `createPlayer(dataSource, config?) → FerritePlayer`
- `isSupported() → boolean`, `getFeatureList() → Record<string, boolean>` (incl. `crossOriginIsolated`)
- `Events` — `ERROR`, `MEDIA_INFO`, `STATISTICS_INFO`, `LOADING_COMPLETE`, `RECOVERED_EARLY_EOF`,
  `DESTROYING`, plus ferrite extensions (`TIME_UPDATE`, `LOG`, `DEINT_FAILED`)
- `ErrorTypes` / `ErrorDetails` / `LoaderErrors` — verbatim mpegts.js strings
- `FerritePlayer` — `attachCanvas`, `attachAudio`, `load`, `play`, `pause`, `seek`, `unload`,
  `detachMediaElement`, `destroy`, `recover`, `on`/`off`, plus ferrite extensions `setDeint(mode)`
  (0 off / 1 auto / 3 bwdif, software tier) and `setDrc(mode)` (audio dynamics: 0 line / 1 RF / 2 night);
  props `paused`, `currentTime`, `duration`, `volume`, `muted`, `tier`, `videoWidth`/`videoHeight`,
  `mediaInfo`, `statisticsInfo`
- `initHostAudio() → AudioContext | null`, `hostAudioCtx() → AudioContext | null` — optional shared,
  gesture-unlocked, app-lifetime AudioContext for embedders (see "Audio on iOS" below)
- `ferrite.js/controls` — `attachControls(player, target, options?) → { destroy() }`

### Audio on iOS (optional `attachAudio`)

Audio playout runs off the main thread in an AudioWorklet, and the standalone player owns its own
AudioContext — audio starts on the first user gesture and recovers by itself after interruptions (a
call, Siri, an output-route change), so **no setup is required** for the common case.

If your app mounts several players (e.g. a channel zapper) or wants audio to survive across player
teardown, create **one** shared, gesture-unlocked context at app start and inject it:

```ts
import Ferrite, { initHostAudio } from 'ferrite.js';

const audioCtx = initHostAudio();          // once, at load — armed to unlock on the first tap
// ...for each player:
player.attachAudio(audioCtx);              // before play(); the player never creates/closes it
```

Without `attachAudio()`, the player owns a per-stream context itself (resumed on `play()`, closed on
teardown). The host-owned context is app-lifetime and the player only attaches its per-stream nodes to
it.

## License

**MIT** for the player (everything under `src/`, the engine glue, build scripts, tests, demo, and the
generated `assets/ferrite.mjs` loader). The vendored engine binary `assets/ferrite.wasm` is a derivative
of FFmpeg and is licensed **LGPL-2.1-or-later** — it is built from a purpose-built FFmpeg 8.1.1 decode
subset configured *without* `--enable-gpl`/`--enable-nonfree` (no GPL or non-free components). The full
LGPL text is in [`engine/COPYING.LGPLv2.1`](./engine/COPYING.LGPLv2.1), and `engine/` ships the complete
source + build script so the engine can be rebuilt/relinked against a modified FFmpeg (LGPL §6). See
[`LICENSE`](./LICENSE) for the full terms.

> **Patent note:** the bundled decoders (HEVC/H.264/MPEG-2, AAC/AC-3/E-AC-3/MP2/MP3) implement
> formats that may be patent-encumbered in some jurisdictions. That is separate from the copyright
> license and is the redistributor's responsibility to evaluate.
