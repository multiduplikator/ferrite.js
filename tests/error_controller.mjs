// Unit test for the PURE error controller — the single classify→action authority (spec §4 #5).
// DOM-free, browser-free: `classifyError(cause, ctx) → action`, the same pure ladder the worker routes its
// ingest catch + silence/stall watchdogs + handleWcError through, and that ports straight to Rust.
//
// Covers the RECOVERY MATRIX classification (headless half; the full-realm reconnect over /faux-live?fault=
// is the browser run):
//   network drop      → reconnect          (live, ever-connected)
//   upstream silence  → reconnect          (the adaptive-silence watchdog's cause)
//   decode glitch     → recreateDecoder    (transient, keep playing)
//   internal RangeError → FATAL, NEVER reconnect  (the corruption guard)
// + the everConnected / hasLiveEdge gating, the fatal failure-kind → mpegts vocab mapping, and exhaustiveness.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/error_controller.mjs

import assert from 'node:assert/strict';
import { classifyError } from '../src/controller/error-controller.ts';
import { mapFerriteError } from '../src/errors.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
// ClassifyContext keys on `hasLiveEdge` (SourceCapabilities = declaredLive && !bounded), not a raw intent
// bool — reconnect needs a live edge to chase. Known live ⇒ hasLiveEdge=true; VOD/bounded ⇒ false.
const LIVE = { hasLiveEdge: true, everConnected: true };    // a connected live stream (the reconnect-eligible case)
const INITIAL = { hasLiveEdge: true, everConnected: false };// a live stream that never connected (initial fault)
const VOD = { hasLiveEdge: false, everConnected: true };    // VOD/bounded never reconnects

console.log('error controller — classify→action ladder:');

// ---- THE RECOVERY MATRIX (headless classification) ------------------------------------------
test('network-drop (live, connected) → reconnect (error budget)', () => {
  const a = classifyError('network-drop', LIVE);
  assert.equal(a.kind, 'reconnect');
  assert.equal(a.budget, 'error');
});

test('upstream-silence (live, connected) → reconnect', () => {
  const a = classifyError('upstream-silence', LIVE);
  assert.equal(a.kind, 'reconnect');
  assert.equal(a.budget, 'error');
});

test('decode-glitch → recreateDecoder (keep playing, no teardown, no reconnect)', () => {
  const a = classifyError('decode-glitch', LIVE);
  assert.equal(a.kind, 'recreateDecoder');
});

test('range-error → FATAL, NEVER reconnect (the corruption guard) — even on a connected live stream', () => {
  const a = classifyError('range-error', LIVE);
  assert.equal(a.kind, 'fatal');
  assert.equal(a.failure, 'worker');
  // The whole point: an internal error can NEVER resolve to a reconnect, regardless of context.
  for (const ctx of [LIVE, INITIAL, VOD]) assert.equal(classifyError('range-error', ctx).kind, 'fatal');
});

// ---- internal / programmer errors → ALWAYS fatal --------------------------------------------
test('internal causes are all fatal (decode-internal, codec-unsupported, demux, worker)', () => {
  for (const cause of ['decode-internal', 'codec-unsupported', 'demux', 'worker']) {
    for (const ctx of [LIVE, INITIAL, VOD]) {
      assert.equal(classifyError(cause, ctx).kind, 'fatal', `${cause} must be fatal in every context`);
    }
  }
});

// ---- decode-stall → recreateDecoder ---------------------------------------------------------
test('decode-stall → recreateDecoder (the decode-stall watchdog action)', () => {
  assert.equal(classifyError('decode-stall', LIVE).kind, 'recreateDecoder');
});

// ---- clean live boundary → retry (seamless) -------------------------------------------------
test('eof-boundary (live) → retry (immediate seamless reconnect, no budget)', () => {
  assert.equal(classifyError('eof-boundary', LIVE).kind, 'retry');
});
test('eof-boundary (vod) → fatal (unexpected EOF on non-live)', () => {
  assert.equal(classifyError('eof-boundary', VOD).kind, 'fatal');
});

// ---- transient network: reconnect only when live AND ever-connected --------------------------
test('transient network causes reconnect on a connected live stream', () => {
  assert.equal(classifyError('http-status', LIVE).kind, 'reconnect');
  assert.equal(classifyError('empty-body', LIVE).kind, 'reconnect');
  assert.equal(classifyError('connect-timeout', LIVE).kind, 'reconnect');
  assert.equal(classifyError('connect-timeout', LIVE).budget, 'timeout'); // counted on the SEPARATE timeout budget
});

test('an INITIAL-connect fault (never connected) is FATAL, not a reconnect', () => {
  for (const cause of ['network-drop', 'http-status', 'connect-timeout', 'empty-body', 'upstream-silence']) {
    assert.equal(classifyError(cause, INITIAL).kind, 'fatal', `${cause} on initial connect → fatal`);
  }
});

test('a transient cause on VOD is FATAL (VOD never reconnects)', () => {
  for (const cause of ['network-drop', 'http-status', 'connect-timeout']) {
    assert.equal(classifyError(cause, VOD).kind, 'fatal', `${cause} on VOD → fatal`);
  }
});

// ---- the fatal failure kind maps to the verbatim mpegts vocab at the facade ------------------
test('every fatal action carries a failure kind that maps to a real mpegts (type, details)', () => {
  const causes = ['range-error', 'decode-internal', 'codec-unsupported', 'demux', 'worker'];
  for (const cause of causes) {
    const a = classifyError(cause, INITIAL);
    assert.equal(a.kind, 'fatal');
    assert.ok(a.failure, `${cause} → failure kind present`);
    const mapped = mapFerriteError(a.failure, -1, 'x'); // must not throw → a valid kind
    assert.ok(mapped.type && mapped.details, `${cause} → maps to mpegts (${mapped.type}/${mapped.details})`);
  }
  // The early-eof boundary on VOD also maps cleanly.
  const eof = classifyError('eof-boundary', VOD);
  assert.equal(mapFerriteError(eof.failure, -1, 'x').details, 'UnrecoverableEarlyEof');
});

// ---- purity / exhaustiveness ----------------------------------------------------------------
test('every action carries a non-empty human reason (breadcrumb)', () => {
  const all = ['eof-boundary', 'empty-body', 'network-drop', 'http-status', 'connect-timeout',
    'upstream-silence', 'decode-glitch', 'decode-stall', 'range-error', 'decode-internal',
    'codec-unsupported', 'demux', 'worker'];
  for (const cause of all) {
    const a = classifyError(cause, LIVE);
    assert.ok(typeof a.reason === 'string' && a.reason.length > 0, `${cause} → reason`);
    assert.ok(['retry', 'reconnect', 'recreateDecoder', 'fatal'].includes(a.kind), `${cause} → valid action kind`);
  }
});

console.log(`\n✓ all ${passed} error-controller tests passed`);
