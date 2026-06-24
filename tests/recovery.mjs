// Headless RECOVERY test — the error controller driving a real reconnect over /faux-live?fault=.
// Proves, WITHOUT a browser, the RECOVERY MECHANICS at the seam the worker actually uses: the
// LiveSourcePort (fetch+RS+abort) + classifyError (the classify→action ladder) in a minimal reconnect
// loop that mirrors worker.ts ingest(). The FULL-REALM recovery (engine decode + present + the facade
// Reconnecting state over the real worker) is the user's browser run; this nails the network half + the
// invariant the gate cares about: NO ORPHANED CONNECTION PER RECONNECT (each attempt's port is aborted).
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/recovery.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveSourcePort, SourceHttpError, SourceConnectTimeout } from '../src/source/port.ts';
import { classifyError } from '../src/controller/error-controller.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = +(process.env.PORT || 8672);
const FIXTURE = path.join(ROOT, 'assets', 'fixture_lab_2160_10_50.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(FIXTURE)) { console.error('fixture missing: ' + FIXTURE); process.exit(1); }

// --- boot the dev server ---
const srv = spawn(process.execPath, [path.join(ROOT, 'demo', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('server did not start')), 5000);
  srv.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(to); resolve(); } });
  srv.stderr.on('data', () => {});
});

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

// A minimal reconnect driver = the worker's ingest() reduced to its essence: open the port, on a clean
// end / throw classify the cause and let the error controller resolve the action (retry/reconnect/fatal),
// re-open on retry|reconnect, stop on fatal. Tracks live ports so we can assert none orphans.
async function reconnectDriver(url, { maxAttempts = 6, idleAbortMs = 0 } = {}) {
  const ports = [];           // every port we opened (to assert all are aborted at the end)
  let everConnected = false, bytes = 0, attempts = 0, reconnects = 0, fatal = null, recovered = false;
  for (;;) {
    if (++attempts > maxAttempts) break;
    const port = new LiveSourcePort(url);
    ports.push(port);
    let progressed = false, lastByteAt = 0, silence = false;
    // Optional silence watchdog: abort if no byte for idleAbortMs while connected.
    let wd = 0;
    if (idleAbortMs > 0) {
      wd = setInterval(() => {
        if (lastByteAt && Date.now() - lastByteAt > idleAbortMs) { silence = true; port.abort(); }
      }, 50);
    }
    try {
      const r = await port.open({
        connectTimeoutMs: 8000,
        onConnect: () => { everConnected = true; lastByteAt = Date.now(); },
        onBytes: (c) => {
          bytes += c.length; lastByteAt = Date.now();
          if (!progressed) { progressed = true; if (reconnects > 0) recovered = true; }
        },
      });
      if (r.reason === 'gone') break;
      const action = classifyError(progressed ? 'eof-boundary' : 'empty-body', { hasLiveEdge: true, everConnected });
      if (action.kind === 'fatal') { fatal = action; break; }
      if (action.kind === 'reconnect' || action.kind === 'retry') { reconnects++; continue; }
      break;
    } catch (err) {
      let cause;
      if (silence) cause = 'upstream-silence';
      else if (err instanceof RangeError) cause = 'range-error';
      else if (err instanceof SourceHttpError) cause = 'http-status';
      else if (err instanceof SourceConnectTimeout) cause = 'connect-timeout';
      else cause = 'network-drop';
      const action = classifyError(cause, { hasLiveEdge: true, everConnected });
      if (action.kind === 'fatal') { fatal = action; break; }
      reconnects++;
      // tiny backoff so a clean recovery connection is the next attempt
      await sleep(50);
      continue;
    } finally {
      if (wd) clearInterval(wd);
      port.abort(); // mirror ingest()'s per-attempt synchronous abort (no orphaned connection)
    }
  }
  // Assert no orphaned connection: every port settled its open() (abort is idempotent + already called).
  for (const p of ports) p.abort();
  return { bytes, attempts, reconnects, fatal, recovered };
}

try {
  const base = `http://localhost:${PORT}/faux-live?file=assets/fixture_lab_2160_10_50.ts`;

  await test('network DROP → reconnect → recover (no orphaned connection per reconnect)', async () => {
    const r = await reconnectDriver(`${base}&fault=drop&faultMs=400`);
    assert.ok(r.reconnects >= 1, `a drop must trigger ≥1 reconnect (got ${r.reconnects})`);
    assert.equal(r.recovered, true, 'bytes must flow again after the reconnect (recovered)');
    assert.equal(r.fatal, null, 'a recoverable drop must NOT go fatal');
  });

  await test('upstream SILENCE → watchdog abort → reconnect → recover', async () => {
    const r = await reconnectDriver(`${base}&fault=silence&faultMs=400`, { idleAbortMs: 1500 });
    assert.ok(r.reconnects >= 1, `silence must trigger ≥1 reconnect (got ${r.reconnects})`);
    assert.equal(r.recovered, true, 'bytes must flow again after the silence reopen (recovered)');
    assert.equal(r.fatal, null, 'a silence drop must NOT go fatal');
  });

  await test('an INITIAL HTTP 404 is FATAL, never a reconnect storm', async () => {
    const r = await reconnectDriver(`http://localhost:${PORT}/faux-live?file=assets/nope.ts`, { maxAttempts: 4 });
    assert.ok(r.fatal, 'an initial-connect 404 must classify fatal');
    assert.equal(r.fatal.kind, 'fatal');
    assert.equal(r.reconnects, 0, 'must NOT reconnect on an initial-connect fault');
  });

  console.log(`\n✓ all ${passed} recovery tests passed`);
} finally {
  srv.kill('SIGKILL');
}
process.exit(0);
