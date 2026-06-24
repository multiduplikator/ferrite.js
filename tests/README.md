# ferrite.js test harnesses (node, no browser)

These node gates exercise the **engine** (`assets/ferrite.{mjs,wasm}`) and the **DOM-free facade**
(`src/{config,errors,types,policy}.ts`, `src/worker/codec.ts`) without a browser. The DOM-bound parts
(`src/index.ts`, `src/worker/worker.ts`, `src/render/gl.ts` — they touch `Worker`/`document`/WebGL)
are covered by the in-browser demo (`npm run demo`).

Use the emsdk-bundled node (it has the flags + a current V8): `~/emsdk/node/*/bin/node`.

| harness | proves | run |
|---|---|---|
| `facade_test.mjs` | erasable TS; Config defaults+validation; verbatim mpegts.js error mapping + host bucketing; H.264/HEVC codec strings + WebCodecs tier gate; adaptive low-water / live latency-sync / reconnect policy | `node --experimental-strip-types facade_test.mjs` |
| `decode_sweep.mjs` | software decode throughput (frames + fps) per codec/res/bit-depth/deint over the fixture clips | `node decode_sweep.mjs` |
| `growth_test.mjs` | growable shared memory: starts at 256 MiB, grows to ≤2 GiB, pre-grow data intact through a fresh `HEAPU8` | `node --experimental-strip-types growth_test.mjs` |
| `leakcheck.mjs` | the streaming-ring compaction (no OOM feeding >2 GiB through a 16 MiB cap) | `node leakcheck.mjs` |
| `vod_seek_test.mjs` | VOD file containers: MP4/MKV autodetect + decode (video+audio) + `av_seek_frame` BACKWARD over the seekable AVIO, in BOTH the in-memory and HTTP-Range-streamed (`ferrite_demux_new_range` + the sync read hook) modes | `node vod_seek_test.mjs` |
| `streaming_paramset_test.mjs` | LIVE streaming demux (`ferrite_demux_new_streaming`): the in-band param-set resolution — `extract_extradata` → `codecpar` extradata → decoder built `_from_demux`; byte-0 (keyframe) join decodes clean with 0 PPS errors + never feeds a param-set-less packet; mid-GOP join still resolves + holds (no decoder-side PPS flood). Reuses the `decode_sweep` mpegts fixtures | `node streaming_paramset_test.mjs` |
| `controller.mjs` | the PURE `PlaybackController` reducer: lifecycle + teardown-as-state (TOTAL from every state) + **Reconnecting(Live)** transitions (drop→reconnecting→buffering→playing, VOD-never-reconnects, teardown-from-reconnecting, backoff-exhausted→fatal) | `node --experimental-strip-types tests/controller.mjs` |
| `error_controller.mjs` | **the single error controller** — `classifyError(cause, ctx)` classify→action ladder: the recovery matrix (drop/silence→reconnect, decode-glitch→recreateDecoder, RangeError→FATAL-never-reconnect), the everConnected/isLive gating, fatal→mpegts vocab | `node --experimental-strip-types tests/error_controller.mjs` |
| `recovery.mjs` | **headless recovery** — the error controller driving a real reconnect over `/faux-live?fault=drop`/`silence`: drop + silence recover, an initial 404 is fatal (no reconnect storm), NO orphaned connection per reconnect. Full-realm recovery (engine+present+facade Reconnecting) is the browser run | `node --experimental-strip-types tests/recovery.mjs` |
| `recovery_concurrency.mjs` | **the silence-watchdog ⟂ ingest-reconnect RACE** — drives the REAL `classifyIngestCause`/`silenceWatchdogArmed`/`classifyCleanBoundary` (`src/controller/ingest-classify`) + `LiveSourcePort` (stub fetch) + a concurrent watchdog: a warmed-cadence drop→backoff lets the watchdog trip during the sleep, and a RangeError on the next attempt still classifies **range-error→FATAL** (TYPE beats the stale flag — the corruption guard); the `streaming` sentinel keeps stalls from inflating; a trickle-then-close is a budgeted reconnect, not a 0ms hot-loop | `node --experimental-strip-types tests/recovery_concurrency.mjs` |
| `leakgate.mjs` | **THE LEAK GATE (engine-side tier)** — `load→decode→stop ×N` in ONE long-lived engine realm over the known-clean overlap fixture; snapshots the baseline (held=0, heap≈steady, demux-ring=0) each cycle through the `src/instrument` stats bus and reports per-cycle drift. The "no restart-to-clear" guarantee as a test. Emits the ~1 Hz record + per-cycle baseline to `buildlog.jsonl`. `DEBUG=0` proves the instrument is silenceable. Browser tier: `demo/leakgate.html` | `node --experimental-strip-types tests/leakgate.mjs` |

## Fixtures

`decode_sweep.mjs` / `leakcheck.mjs` read clips from `fixtures/` (gitignored — generated, not
committed). Generate them once:

```bash
cd fixtures && bash gen_clips.sh      # mpegts clips for decode_sweep/leakcheck (libx265+libx264, ~minutes, ~600 MB)
cd fixtures && bash gen_vod.sh        # MP4/MKV clips for vod_seek_test (short, seekable)
```

`decode_sweep.mjs` runs only the configs whose clip is present, so a partial set still works.

## Comparing two independently-built engines (build-equivalence gate)

ferrite.js builds its own engine from `engine/`. To confirm a rebuild (or a second tree's build) is
functionally + perf equivalent to the shipped one, point `FERRITE_ENGINE` at each `.mjs` and compare
the frame counts (must be identical), decode errors (must be zero), and fps (within run-to-run noise):

```bash
FERRITE_ENGINE=../assets/ferrite.mjs        node decode_sweep.mjs
FERRITE_ENGINE=/path/to/other/ferrite.mjs   node decode_sweep.mjs
```

Byte-identity of the two `.wasm` is **not** required (emsdk env may differ); functional + perf
equivalence is.

## ASan engine

For a memory-error pass over `ferrite.c` (streaming ring / plane handling / demux), build the
ASan-instrumented engine and point a harness at it:

```bash
cd ../engine && bash build-engine.sh && bash build-engine-asan.sh   # → engine/ferrite_asan.{mjs,wasm}
FERRITE_ENGINE=../engine/ferrite_asan.mjs ~/emsdk/node/*/bin/node leakcheck.mjs
```
