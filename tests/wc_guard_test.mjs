// Unit test for the PURE LIVE-WC guard helpers (src/worker/wc-guard.ts) — the WebCodecs analogs of the
// software no-drop + param-set guards the hardware path was missing. The failure mode they prevent:
// over-feed → decode q 314 → stall → reconnect loop → audio dead. WebCodecs itself is browser-only, so only these
// DECISIONS are headless-testable; the VideoDecoder.decode/close + the watchdog timer are the browser bank.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/wc_guard_test.mjs

import assert from 'node:assert/strict';
import { wcShouldWaitFeed, wcParkWatchdog, wcKeyframeGate, wcStallAction, wcFamilyOf, wcCapabilityCached, WC_PROBE_CODECS } from '../src/worker/wc-guard.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// ---- (a) FEED BACKPRESSURE — wcShouldWaitFeed(decodeQueueSize, queueMax) -------------------------------
// DEADLOCK FIX: the gate now depends SOLELY on the decoder's own self-draining decodeQueueSize.
// The prior version ALSO parked on a cross-worker present-ring in-flight count (`wcInFlight >= ringCap`); that
// ack was never emitted on the steady-state draw path → wcInFlight climbed to the cap → the gate LATCHED SHUT
// with an empty decode queue (invisible to the stall watchdog's queue>0 guard) → permanent deadlock.
console.log('wc-guard (a) feed backpressure (decodeQueueSize-only):');
const QMAX = 6;

test('healthy: queue under the ceiling → FEED (do not wait)', () => {
  assert.equal(wcShouldWaitFeed(0, QMAX), false);
  assert.equal(wcShouldWaitFeed(2, QMAX), false);
  assert.equal(wcShouldWaitFeed(QMAX - 1, QMAX), false); // just under → feed
});

test('encoded queue at/over the ceiling → WAIT (back-pressure; the decode-q→314 fix)', () => {
  assert.equal(wcShouldWaitFeed(QMAX, QMAX), true);     // == ceiling holds
  assert.equal(wcShouldWaitFeed(QMAX + 5, QMAX), true); // over the ceiling holds
});

test('DEADLOCK REGRESSION: the gate ignores any present-ring/in-flight state — a drained queue ALWAYS feeds', () => {
  // This is the EXACT case the prior review missed: the present worker never sends release.vf, so a
  // cross-worker in-flight count would climb without bound. The gate must NOT see it — with the encoded
  // queue at 0 (or any value < QMAX) the pump MUST feed no matter how large any other counter has grown.
  // (No `presentInFlight` argument exists anymore; the only inputs are the two below.) Self-releasing by
  // construction: when the decoder decodes a chunk, decodeQueueSize drops < QMAX and the gate re-opens.
  for (const q of [0, 1, QMAX - 1]) {
    assert.equal(wcShouldWaitFeed(q, QMAX), false, `q=${q} (< ceiling) must feed regardless of any ack state`);
  }
  // And the deadlock signature itself — parked at queue 0 — can NEVER be produced by this gate:
  assert.equal(wcShouldWaitFeed(0, QMAX), false);
});

test('the gate is monotonic in the ONE input: once at the ceiling, a still-growing queue keeps waiting', () => {
  for (let q = QMAX; q <= QMAX + 10; q++) assert.equal(wcShouldWaitFeed(q, QMAX), true);
});

// ---- (a-belt) PARK WATCHDOG — wcParkWatchdog(parkedMs, decodeQueueSize, queueMax, watchdogMs) ----------
// Defense-in-depth so no FUTURE gate can ever latch invisibly again: force the pump to re-evaluate if a park
// outlives the window while the encoded queue is NOT actually full (a park on a non-self-releasing signal).
console.log('wc-guard (a-belt) feed-park watchdog:');
const WDOG = 2000;

test('a fresh / short park does NOT trip the watchdog (within the window)', () => {
  assert.equal(wcParkWatchdog(0, 0, QMAX, WDOG), false);
  assert.equal(wcParkWatchdog(WDOG - 1, 0, QMAX, WDOG), false);
});

test('REGRESSION: a long park with a NON-FULL queue (queue 0) → FORCE UNPARK (the invisible-latch breaker)', () => {
  // The deadlock: the pump parked at decodeQueueSize 0 forever. Had this belt existed it would
  // have force-recovered after the window instead of wedging silently — the watchdog the review missed.
  assert.equal(wcParkWatchdog(WDOG, 0, QMAX, WDOG), true);
  assert.equal(wcParkWatchdog(WDOG + 5000, QMAX - 1, QMAX, WDOG), true); // still under the ceiling → still a latch
});

test('a long park with a GENUINELY FULL queue is NOT broken (real backpressure / the stall watchdog owns it)', () => {
  assert.equal(wcParkWatchdog(WDOG + 5000, QMAX, QMAX, WDOG), false);     // queue full ⇒ legitimate, not a latch
  assert.equal(wcParkWatchdog(WDOG + 5000, QMAX + 3, QMAX, WDOG), false);
});

test('under the decodeQueueSize-only gate the belt is provably dead code (it can only park at queue>=QMAX)', () => {
  // The gate parks IFF decodeQueueSize >= QMAX. The watchdog fires IFF parkedMs>=window AND queue < QMAX.
  // Those conditions are disjoint → with this gate the belt never fires. Assert the contract across the range.
  for (let q = 0; q <= QMAX + 4; q++) {
    const parked = wcShouldWaitFeed(q, QMAX);             // would the gate hold here?
    const wdog = wcParkWatchdog(WDOG, q, QMAX, WDOG);     // would the belt fire here?
    assert.ok(!(parked && wdog), `q=${q}: the gate-park and the belt-fire conditions must be disjoint`);
  }
});

// ---- (b) AWAIT-KEYFRAME HOLD — wcKeyframeGate(awaitingKeyframe, isKey) ---------------------------------
console.log('wc-guard (b) await-keyframe HOLD:');

test('steady state (not awaiting): feed every AU, key or delta', () => {
  assert.deepEqual(wcKeyframeGate(false, false), { feed: true, awaitingKeyframe: false });
  assert.deepEqual(wcKeyframeGate(false, true), { feed: true, awaitingKeyframe: false });
});

test('awaiting + delta → HOLD (drop it, stay awaiting) — never feed a delta to a fresh/flushed decoder', () => {
  assert.deepEqual(wcKeyframeGate(true, false), { feed: false, awaitingKeyframe: true });
});

test('awaiting + keyframe → feed the IDR and CLEAR the hold', () => {
  assert.deepEqual(wcKeyframeGate(true, true), { feed: true, awaitingKeyframe: false });
});

test('a delta-storm after a (re)create is fully held until the IDR (param-set-guard parity)', () => {
  let awaiting = true; // armed by createWcDecoder / reconnect / resume
  let fed = 0, heldDeltas = 0;
  // 4 reference-less deltas (the "Could not find ref" / permastall feed) then the IDR then more deltas
  for (const isKey of [false, false, false, false, true, false, false]) {
    const g = wcKeyframeGate(awaiting, isKey);
    awaiting = g.awaitingKeyframe;
    if (g.feed) fed++; else heldDeltas++;
  }
  assert.equal(heldDeltas, 4); // the pre-IDR deltas were all HELD (not fed to the fresh decoder)
  assert.equal(fed, 3);        // the IDR + the 2 trailing deltas
  assert.equal(awaiting, false);
});

// ---- (c) DECODE-STALL ROUTING — wcStallAction(...) ----------------------------------------------------
console.log('wc-guard (c) decode-stall recovery routing:');
const base = { configured: true, decodeQueueSize: 4, msSinceOutput: 5000, awaitingKeyframe: false, stallMs: 2000, recreates: 0, maxRecreates: 3 };

test('no decoder / unconfigured → none', () => {
  assert.equal(wcStallAction({ ...base, configured: false }), 'none');
});

test('legitimately awaiting the first keyframe → none (output not expected yet — NOT a stall)', () => {
  assert.equal(wcStallAction({ ...base, awaitingKeyframe: true }), 'none');
});

test('empty input queue → none (nothing queued ⇒ no output expected ⇒ not stalled)', () => {
  assert.equal(wcStallAction({ ...base, decodeQueueSize: 0 }), 'none');
});

test('queued + output within the grace window → none (transient, not yet a stall)', () => {
  assert.equal(wcStallAction({ ...base, msSinceOutput: 1999 }), 'none');
});

test('queued + no output past stallMs, budget left → RECREATE (decoder reset, NOT a source reconnect)', () => {
  assert.equal(wcStallAction({ ...base, msSinceOutput: 2001, recreates: 0 }), 'recreate');
  assert.equal(wcStallAction({ ...base, recreates: 2, maxRecreates: 3 }), 'recreate'); // last one under budget
});

test('recreate budget exhausted → FALLBACK (software tier; the HW tier cannot sustain this stream)', () => {
  assert.equal(wcStallAction({ ...base, recreates: 3, maxRecreates: 3 }), 'fallback');
  assert.equal(wcStallAction({ ...base, recreates: 4, maxRecreates: 3 }), 'fallback');
});

test('the recovery never returns "reconnect" — a decoder stall is NEVER routed to the source (THE bug)', () => {
  for (const r of [0, 1, 2, 3, 4]) {
    const a = wcStallAction({ ...base, recreates: r });
    assert.ok(a === 'recreate' || a === 'fallback' || a === 'none', `recreates=${r} → ${a} (never a reconnect)`);
  }
});

test('escalation ladder: recreate ×N then fallback (a self-heal that keeps failing degrades gracefully)', () => {
  const seq = [];
  for (let r = 0; r <= 3; r++) seq.push(wcStallAction({ ...base, recreates: r, maxRecreates: 3 }));
  assert.deepEqual(seq, ['recreate', 'recreate', 'recreate', 'fallback']);
});

// ---- DEADLOCK SIMULATION — the exact browser regression, modeled as a feed loop --------------------------
// Models the pump feeding a self-draining decoder while the present-ring in-flight ack (release.vf) NEVER
// arrives — the precise deadlock condition. Asserts the NEW gate keeps making progress (never latches),
// and documents that the OLD ring-gate WOULD have latched on the same trace (fail-before / pass-after).
console.log('wc-guard DEADLOCK simulation (release.vf never arrives):');

// One simulated tick: the HW decoder drains up to `decodeRate` chunks from its encoded queue (→ frames that
// pile into a present ring that is NEVER drained, so inFlight only grows). The pump feeds one AU iff the gate
// is open. Returns how many of `ticks` ticks actually fed — a latched pump feeds ~0; a healthy pump keeps up.
function simulate(gateOpen, { ticks = 500, decodeRate = 1 } = {}) {
  let decodeQueueSize = 0, inFlight = 0, fed = 0, parkedAtQueueZero = 0;
  for (let t = 0; t < ticks; t++) {
    // decoder self-drains its encoded queue → frames become in-flight (present never releases them)
    const decoded = Math.min(decodeRate, decodeQueueSize);
    decodeQueueSize -= decoded; inFlight += decoded; // inFlight climbs forever (the broken ack)
    if (gateOpen(decodeQueueSize, inFlight)) { decodeQueueSize++; fed++; }
    else if (decodeQueueSize === 0) parkedAtQueueZero++; // the deadlock signature: parked with an empty queue
  }
  return { fed, inFlight, parkedAtQueueZero };
}

test('NEW gate (decodeQueueSize-only): pump keeps feeding for the full run despite inFlight → ∞', () => {
  const r = simulate((q /* inFlight ignored */) => !wcShouldWaitFeed(q, QMAX));
  // A healthy decode-bound feed: the pump feeds on roughly every tick the decoder drained a slot. The KEY
  // assertion is liveness — it NEVER stops feeding (no latch), even though inFlight grew without bound.
  assert.ok(r.fed > 400, `pump must keep feeding (fed=${r.fed}/500) — no latch`);
  assert.equal(r.parkedAtQueueZero, 0, 'the pump must NEVER park with an empty decode queue (the deadlock signature)');
  assert.ok(r.inFlight > 100, `precondition: the broken ack let inFlight climb unbounded (was ${r.inFlight})`);
});

test('FAIL-BEFORE proof: the OLD ring-gate LATCHES on the identical trace (parks at queue 0 forever)', () => {
  // The exact prior gate: `decodeQueueSize >= QMAX || inFlight >= RING`. On the same never-released ring it
  // latches the instant inFlight reaches RING and then parks with an empty queue every remaining tick.
  const RING = 16;
  const oldGate = (q, inFlight) => !(q >= QMAX || inFlight >= RING);
  const r = simulate(oldGate);
  assert.ok(r.parkedAtQueueZero > 100, `the old gate must latch (parked-at-queue-0 ticks=${r.parkedAtQueueZero}) — this is the bug`);
  assert.ok(r.fed < RING + 5, `the old gate feeds only until the ring fills then stops (fed=${r.fed})`);
});

// ---- (d) CAPABILITY PRE-DETECTION — wcFamilyOf + wcCapabilityCached ---------------------------------
// The per-play tier path maps a stream's codec string → a cached family result (NO async probe). Interlace is
// NOT here (gated per-stream upstream); the only knob this models is family+bit-depth → cache hit/miss.
console.log('wc-guard (d) capability cache:');

test('wcFamilyOf maps the real codec strings to family + bit-depth', () => {
  // The exact strings videoCodecInfo / vodVideoConfig emit.
  assert.equal(wcFamilyOf('avc1.640028'), 'h264');
  assert.equal(wcFamilyOf('avc1.4d401f'), 'h264');          // H.264 Main@3.1
  assert.equal(wcFamilyOf('avc3.640028'), 'h264');          // Annex-B avc3 variant
  assert.equal(wcFamilyOf('hev1.1.6.L93.B0'), 'hevc-main');   // Main, 8-bit
  assert.equal(wcFamilyOf('hvc1.1.6.L120.B0'), 'hevc-main');  // hvc1 (config-record) form
  assert.equal(wcFamilyOf('hev1.2.4.L153.B0'), 'hevc-main10');// Main10, 10-bit
  assert.equal(wcFamilyOf('hvc1.2.4.L150.B0'), 'hevc-main10');
});

test('wcFamilyOf returns null for an unmapped/empty codec (→ software, never WC)', () => {
  assert.equal(wcFamilyOf(''), null);        // MPEG-2 & friends map to '' in videoCodecInfo
  assert.equal(wcFamilyOf('mp4a.40.2'), null);
  assert.equal(wcFamilyOf('vp09.00.10.08'), null);
});

test('the probe family strings round-trip back to their own family', () => {
  assert.equal(wcFamilyOf(WC_PROBE_CODECS['h264']), 'h264');
  assert.equal(wcFamilyOf(WC_PROBE_CODECS['hevc-main']), 'hevc-main');
  assert.equal(wcFamilyOf(WC_PROBE_CODECS['hevc-main10']), 'hevc-main10');
});

test('wcCapabilityCached: a cached-true family → supported; cached-false → software', () => {
  const cache = { 'h264': true, 'hevc-main': true, 'hevc-main10': false }; // typical desktop: no HW HEVC Main10
  assert.equal(wcCapabilityCached('avc1.640028', cache), true);
  assert.equal(wcCapabilityCached('hev1.1.6.L93.B0', cache), true);
  assert.equal(wcCapabilityCached('hev1.2.4.L153.B0', cache), false); // Main10 not supported → software
});

test('wcCapabilityCached NEVER assumes supported for an unknown/unprobed codec (safe fallback)', () => {
  const full = { 'h264': true, 'hevc-main': true, 'hevc-main10': true };
  assert.equal(wcCapabilityCached('', full), false);            // unmapped family → false even if all true
  assert.equal(wcCapabilityCached('mp4a.40.2', full), false);
  // Unprobed/empty cache (no VideoDecoder runtime, or probe not yet run) → every lookup false → software.
  assert.equal(wcCapabilityCached('avc1.640028', {}), false);
  assert.equal(wcCapabilityCached('hev1.1.6.L93.B0', { 'h264': true }), false); // family present-but-unprobed
});

console.log(`\n✓ all ${passed} wc-guard tests passed`);
