// LiveSourcePort end-to-end test against the REAL /faux-live route. Proves the ingest seam
// (fetch + ReadableStream + backpressure gate + synchronous abort) over actual HTTP — the same code the
// decode worker runs — without a browser. Spawns demo/serve.mjs, drives the port, asserts.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/source.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveSourcePort } from '../src/source/port.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = +(process.env.PORT || 8671);
const FIXTURE = path.join(ROOT, 'assets', 'fixture_lab_2160_10_50.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(FIXTURE)) { console.error('fixture missing: ' + FIXTURE); process.exit(1); }
const fixtureSize = statSync(FIXTURE).size;
const URL = `http://localhost:${PORT}/faux-live?file=assets/fixture_lab_2160_10_50.ts`;

// --- boot the dev server ---
const srv = spawn(process.execPath, [path.join(ROOT, 'demo', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('server did not start')), 5000);
  srv.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(to); resolve(); } });
  srv.stderr.on('data', () => {}); // dist/ warning etc.
});

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

try {
  console.log(`LiveSourcePort vs /faux-live (fixture ${(fixtureSize / 1048576).toFixed(1)} MiB):`);

  await test('full live-push ingest: streams the whole chunked body to EOF', async () => {
    let bytes = 0, chunks = 0;
    const port = new LiveSourcePort(URL);
    const r = await port.open({ onBytes: (c) => { bytes += c.length; chunks++; } });
    assert.equal(r.reason, 'eof');
    assert.equal(r.connected, true);
    assert.equal(r.status, 200);
    assert.equal(r.bytes, bytes);
    assert.equal(bytes, fixtureSize, 'ingested byte count must equal the fixture size');
    assert.ok(chunks > 1, 'a chunked body must arrive in multiple reads (push, not one blob)');
  });

  await test('backpressure: shouldRead=false holds reads, then drains fully when reopened', async () => {
    let bytes = 0, gateOpen = false;
    const port = new LiveSourcePort(URL);
    setTimeout(() => { gateOpen = true; }, 250); // gate is shut for the first 250ms
    const t0 = Date.now();
    const r = await port.open({ onBytes: (c) => { bytes += c.length; }, shouldRead: () => gateOpen, pollMs: 10 });
    assert.equal(r.reason, 'eof');
    assert.equal(bytes, fixtureSize, 'a closed-then-open gate must still deliver every byte');
    assert.ok(Date.now() - t0 >= 240, 'the gate must actually have stalled the read loop');
  });

  await test('synchronous abort() settles the in-flight open() promptly (teardown)', async () => {
    let bytes = 0;
    const port = new LiveSourcePort(URL);
    // Abort shortly after the first bytes arrive; the worker pairs this with alive()→false.
    let aborted = false;
    const p = port.open({ onBytes: (c) => { bytes += c.length; }, alive: () => !aborted });
    await sleep(30);
    aborted = true; port.abort();
    const settled = await Promise.race([
      p.then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
      sleep(2000).then(() => ({ timeout: true })),
    ]);
    assert.ok(!settled.timeout, 'abort() must not leave open() hanging');
    assert.ok(bytes < fixtureSize, 'abort must cut the stream before the full body arrived');
  });

  await test('HTTP error surfaces as SourceHttpError with the status', async () => {
    const port = new LiveSourcePort(`http://localhost:${PORT}/faux-live?file=assets/does-not-exist.ts`);
    await assert.rejects(() => port.open({ onBytes: () => {} }), (e) => e.name === 'SourceHttpError' && e.status === 404);
  });

  console.log(`\n✓ all ${passed} source-port tests passed`);
} finally {
  srv.kill('SIGKILL');
}
process.exit(0);
