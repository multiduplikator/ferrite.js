// SourceCapabilities derivation (LIVE/VOD UNIFICATION — TIER 1). Proves the SINGLE source-policy
// descriptor: `deriveCapabilities(declaredLive, facts?)` — the intent-only defaults (byte-identical to the
// retired `isLive` bool on the known live/VOD paths) and the first-response-header refine (the edge cases:
// non-Range VOD → seekable=false → seekbar hidden; seekable-live/timeshift → seekable=true → seekbar
// shown). Also drives the REAL LiveSourcePort against a counting stub fetch to prove the descriptor is
// resolved from headers ALREADY in hand — exactly ONE network request, no probe/HEAD/Range-0-0 sniff.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/capabilities.mjs

import assert from 'node:assert/strict';
import { deriveCapabilities } from '../src/source/capabilities.ts';
import { LiveSourcePort } from '../src/source/port.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

console.log('SourceCapabilities — derivation + the no-extra-request seam:');

// ---- intent-only (no response yet): the byte-identical known-path defaults ---------------------------
await test('intent-only LIVE → {seekable:false, bounded:false, hasLiveEdge:true} (the old isLive=true path)', () => {
  assert.deepEqual(deriveCapabilities(true), { seekable: false, bounded: false, hasLiveEdge: true, declaredLive: true });
});
await test('intent-only VOD → {seekable:true, bounded:true, hasLiveEdge:false} (the old isLive=false path)', () => {
  assert.deepEqual(deriveCapabilities(false), { seekable: true, bounded: true, hasLiveEdge: false, declaredLive: false });
});

// ---- refined from the first-response headers (the descriptor's whole point) ---------------------------
await test('LIVE + no-Range chunked 200 → {false,false,true} (known live: byte-identical)', () => {
  const c = deriveCapabilities(true, { acceptRanges: false, hasContentLength: false });
  assert.deepEqual(c, { seekable: false, bounded: false, hasLiveEdge: true, declaredLive: true });
});
await test('VOD + Range/206 + Content-Length → {true,true,false} (known VOD: byte-identical)', () => {
  const c = deriveCapabilities(false, { acceptRanges: true, hasContentLength: true });
  assert.deepEqual(c, { seekable: true, bounded: true, hasLiveEdge: false, declaredLive: false });
});
await test('VOD + no Accept-Ranges (degraded 200) → seekable:false (EDGE: seekbar hidden, play still works)', () => {
  const c = deriveCapabilities(false, { acceptRanges: false, hasContentLength: true });
  assert.equal(c.seekable, false, 'a non-Range VOD must be non-seekable');
  assert.equal(c.hasLiveEdge, false, 'a declared-VOD source NEVER has a live edge (never reconnect-storms)');
  // The duration getter gates on `seekable` → Infinity here → the controls hide the scrub bar (the bonus).
});
await test('seekable LIVE (timeshift: Accept-Ranges on a live source) → seekable:true (EDGE: seekbar shown)', () => {
  const c = deriveCapabilities(true, { acceptRanges: true, hasContentLength: false });
  assert.equal(c.seekable, true, 'a timeshift live origin advertising ranges is seekable');
  assert.equal(c.hasLiveEdge, true, 'still a live edge (unbounded) — catch-up/reconnect/await-keyframe stay armed');
});

// ---- the formula invariant: hasLiveEdge ≡ declaredLive && !bounded -----------------------------------
await test('hasLiveEdge ≡ declaredLive && !bounded across the full matrix', () => {
  for (const declaredLive of [true, false]) {
    for (const acceptRanges of [true, false]) {
      for (const hasContentLength of [true, false]) {
        const c = deriveCapabilities(declaredLive, { acceptRanges, hasContentLength });
        assert.equal(c.seekable, acceptRanges, 'seekable mirrors Accept-Ranges/206');
        assert.equal(c.bounded, hasContentLength, 'bounded mirrors a known Content-Length');
        assert.equal(c.hasLiveEdge, declaredLive && !hasContentLength, 'hasLiveEdge = declaredLive && !bounded');
        assert.equal(c.declaredLive, declaredLive, 'declaredLive is preserved verbatim');
      }
    }
  }
});

// ---- the SEAM: the REAL port resolves the descriptor from headers in hand, ONE request, no probe ------
// A counting stub fetch with a Headers-shaped response. The port reads Accept-Ranges/Content-Length off
// the FIRST response (already fetched for the body) and hands them to onConnect — no second round-trip.
function makeCountingFetch({ status = 200, acceptRanges = false, contentLength = null, chunks = 3 } = {}) {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const headers = new Map();
    if (acceptRanges) headers.set('accept-ranges', 'bytes');
    if (contentLength != null) headers.set('content-length', String(contentLength));
    let k = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (init?.signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
        if (k < chunks) { controller.enqueue(new Uint8Array(1880)); k++; return; }
        controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300, status, body,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null, has: (k) => headers.has(String(k).toLowerCase()) },
    };
  };
  return { fetchImpl, calls: () => calls };
}

await test('the live push seam: ONE fetch, facts {acceptRanges:false, hasContentLength:false} → known-live caps', async () => {
  const { fetchImpl, calls } = makeCountingFetch({ status: 200, acceptRanges: false, contentLength: null });
  let facts = null, connects = 0;
  const port = new LiveSourcePort('stub://faux-live');
  const r = await port.open({ fetchImpl, onConnect: (_s, f) => { connects++; facts = f; }, onBytes: () => {} });
  assert.equal(r.reason, 'eof');
  assert.equal(calls(), 1, 'the descriptor must come from the response ALREADY fetched — NO second request');
  assert.equal(connects, 1, 'onConnect fires exactly once for the one connection');
  assert.deepEqual(facts, { acceptRanges: false, hasContentLength: false });
  assert.deepEqual(deriveCapabilities(true, facts), { seekable: false, bounded: false, hasLiveEdge: true, declaredLive: true });
});

await test('a timeshift origin (Accept-Ranges: bytes, unbounded) → seekable:true AND keeps its live edge, no extra request', async () => {
  // A timeshift live source advertises ranges (seek into the past) but is UNBOUNDED (no Content-Length —
  // the live edge keeps growing). seekable:true (seekbar shown) + hasLiveEdge:true (catch-up/reconnect stay armed).
  const { fetchImpl, calls } = makeCountingFetch({ status: 200, acceptRanges: true, contentLength: null });
  let facts = null;
  const port = new LiveSourcePort('stub://timeshift');
  await port.open({ fetchImpl, onConnect: (_s, f) => { facts = f; }, onBytes: () => {} });
  assert.equal(calls(), 1, 'no probe — Accept-Ranges read off the same response');
  assert.deepEqual(facts, { acceptRanges: true, hasContentLength: false });
  const c = deriveCapabilities(true, facts);
  assert.equal(c.seekable, true, 'a timeshift origin advertising ranges is seekable');
  assert.equal(c.hasLiveEdge, true, 'unbounded ⇒ still a live edge (catch-up/reconnect/await-keyframe stay armed)');
});

await test('a 206 partial response is seekable even without an Accept-Ranges header', async () => {
  const { fetchImpl } = makeCountingFetch({ status: 206, acceptRanges: false, contentLength: 4096 });
  let facts = null;
  const port = new LiveSourcePort('stub://partial');
  await port.open({ fetchImpl, onConnect: (_s, f) => { facts = f; }, onBytes: () => {} });
  assert.equal(facts.acceptRanges, true, 'a 206 alone proves range support');
  assert.equal(facts.hasContentLength, true);
});

console.log(`\n✓ all ${passed} capabilities tests passed`);
