// Node verification for the GROWABLE shared-memory engine build (no browser needed).
//
// Proves the ALLOW_MEMORY_GROWTH build is safe at the FFI layer:
//   1. the engine starts at the small INITIAL_MEMORY (256 MiB), not a fixed 2 GiB;
//   2. allocating past the initial size GROWS the heap (no OOM at 256 MiB);
//   3. after a grow the SharedArrayBuffer is REPLACED, and Module.HEAPU8 is reassigned to the new
//      buffer — so a FRESH read (`F.heap`, as the bindings do) sees the current memory and data
//      written before the grow is preserved (no view-staleness corruption);
//   4. it never exceeds the 2 GiB MAXIMUM_MEMORY ceiling.
//
// Run:  ~/emsdk/node/*/bin/node growth_test.mjs
// Env:  FERRITE_ASSETS  dir holding ferrite.{mjs,wasm} (default ../assets)

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFerrite } from '../src/worker/ferrite-bindings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.FERRITE_ASSETS
  ? path.resolve(process.cwd(), process.env.FERRITE_ASSETS)
  : path.join(HERE, '..', 'assets');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓ ' + m); } else { fail++; console.error('✗ ' + m); } };
const MiB = 1024 * 1024;

// loadFerrite imports `${wasmBaseUrl}ferrite.mjs` relative to the bindings module; under node give it
// an absolute file:// base (the browser passes '/'). locateFile then resolves the .wasm beside it.
const baseUrl = pathToFileURL(path.join(ASSETS, '/')).href;
const F = await loadFerrite(baseUrl, 8);
const heapLen = () => F.heap.byteLength;

const initial = heapLen();
console.log(`assets:  ${ASSETS}`);
console.log(`initial heap = ${(initial / MiB).toFixed(0)} MiB`);
ok(initial <= 512 * MiB, `starts SMALL (≤512 MiB), not a fixed 2 GiB (got ${(initial / MiB).toFixed(0)} MiB)`);
ok(initial >= 256 * MiB - MiB, `at least the configured 256 MiB initial`);

// Allocate in chunks past the initial size to FORCE at least one grow. Write a sentinel into each
// block, keep the pointers, then read every sentinel back THROUGH A FRESH HEAPU8 (F.heap getter) to
// prove data survives the buffer replacement.
const CHUNK = 64 * MiB;
const NCHUNKS = 6; // 384 MiB of live allocations → must grow past the 256 MiB initial
const ptrs = [];
for (let i = 0; i < NCHUNKS; i++) {
  const p = F.malloc(CHUNK);
  ok(p !== 0, `malloc #${i} (64 MiB) succeeded (grow, not OOM)`);
  // Sentinel: first + last byte of the block carry the block index.
  const h = F.heap; // FRESH view after the malloc that may have grown
  h[p] = (i + 1) & 0xff;
  h[p + CHUNK - 1] = (0xa0 + i) & 0xff;
  ptrs.push(p);
}

const grown = heapLen();
console.log(`grown heap = ${(grown / MiB).toFixed(0)} MiB`);
ok(grown > initial, `heap GREW past the initial (${(initial / MiB).toFixed(0)} → ${(grown / MiB).toFixed(0)} MiB)`);
ok(grown <= 2048 * MiB, `never exceeds the 2 GiB MAXIMUM_MEMORY ceiling`);

// Verify every sentinel through a FRESH read — the whole point: pre-grow writes are intact and the
// reassigned Module.HEAPU8 addresses the current buffer (no staleness).
let intact = true;
for (let i = 0; i < NCHUNKS; i++) {
  const h = F.heap; // fresh each time, exactly as ferrite-bindings does
  if (h[ptrs[i]] !== ((i + 1) & 0xff) || h[ptrs[i] + CHUNK - 1] !== ((0xa0 + i) & 0xff)) intact = false;
}
ok(intact, 'all pre-grow sentinels read back correctly through a fresh HEAPU8 (no view-staleness)');

for (const p of ptrs) F.free(p);

console.log(`\ngrowth_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
