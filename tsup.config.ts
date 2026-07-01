import { defineConfig } from 'tsup';

// Self-contained ESM entries:
//   index          — the public facade (createPlayer / FerritePlayer)
//   worker         — the VIDEO decode worker, spawned by index via `new URL('./worker.js', import.meta.url)`
//   demux-worker   — the DEMUX worker (Stage 5: own ferrite realm — ingest/source/demux + both ring producers),
//                    spawned by index via `new URL('./demux-worker.js', import.meta.url)`
//   present-worker — the PRESENT worker (split-realm OffscreenCanvas + WebGL2 + rAF + ring/clock),
//                    spawned by index via `new URL('./present-worker.js', import.meta.url)`
//   audio-worker   — the AUDIO worker (Stage 4: own ferrite realm — audio decode + PCM-ring producer),
//                    spawned by index via `new URL('./audio-worker.js', import.meta.url)`
//   controls       — the optional framework-free controls + debug overlay (`ferrite.js/controls`)
//
// splitting:false keeps every entry standalone — critical for the workers, which are loaded as module
// Workers and must NOT depend on a shared chunk they can't import in that context. The worker's runtime
// `import(`${wasmBaseUrl}ferrite.mjs`)` is intentionally left unbundled (dynamic, host-served engine);
// esbuild keeps it as a runtime import. `.d.ts` is emitted only for the consumer-facing entries.
//
// THE DEBUG BUILD SWITCH. `FERRITE_DEBUG=1 tsup` (npm run demo / build:debug) builds the dev bundle:
// DEBUG=true (full instrumentation, minification off → diff-readable). A plain `tsup` (the published
// build) leaves it false → every `if (DEBUG)` diagnostic branch is dead-code-eliminated, so the shipped
// library carries zero diagnostic cost. (See src/debug.ts.) The same four entries build in both modes;
// only the DEBUG define + minifier differ. (The stats bus + pure controller live under src/ and are
// imported directly by the node tests — tests/leakgate.mjs, tests/controller.mjs — so they need no
// standalone dist entry.)
const DEBUG = process.env.FERRITE_DEBUG === '1' || process.env.FERRITE_DEBUG === 'true';

// The library entries — the public surface (`.` / `./controls`) plus the two Workers they spawn.
const libEntry = {
  index: 'src/index.ts',
  worker: 'src/worker/worker.ts',
  'demux-worker': 'src/worker/demux-worker.ts',
  'present-worker': 'src/worker/present-worker.ts',
  'audio-worker': 'src/worker/audio-worker.ts',
  controls: 'src/controls/index.ts',
};

export default defineConfig({
  entry: libEntry,
  // Substitute the ambient `DEBUG` identifier (src/debug.d.ts) with its build-time literal. esbuild's
  // syntax minifier (below, prod only) then folds every `if (DEBUG)` and eliminates the dead branch.
  define: { DEBUG: JSON.stringify(DEBUG) },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  clean: true,
  sourcemap: true,
  // The published build turns on esbuild's FULL minifier (whitespace + identifier mangling + syntax
  // minification). The syntax pass is what realises the DEBUG gate — it folds `DEBUG` to its literal and
  // dead-code-eliminates every `if (DEBUG)` diagnostic branch + its strings — and whitespace/identifier
  // mangling then shrinks the shipped bundle (the size pass). The dev/demo build keeps minification OFF
  // entirely so the instrumented bundle stays diff-readable.
  esbuildOptions(options) {
    options.minify = !DEBUG;
  },
  dts: {
    entry: {
      index: 'src/index.ts',
      controls: 'src/controls/index.ts',
    },
  },
});
