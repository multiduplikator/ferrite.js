// Unit test for the PURE audio SAB ring math (src/audio-ring.ts) — the single source of truth the PCM
// producer (decode worker) AND the AudioWorklet consumer both obey, so they can never drift on capacity,
// wrap, or the master-clock formula. DOM-free, browser-free (the same headless discipline as the cadence
// helpers). Ported 1:1 from the reference player's audio-ring test module.
//
// Run:  node --experimental-strip-types tests/audio_ring.mjs   (node ≥22)

import assert from 'node:assert/strict';
import {
  RING_CHANNELS, RING_CTRL_SLOTS, UNDERRUN_RESUME_SECS, AUDIO_PREFILL_SECS,
  ringFramesFor, ringSabBytes, readable, writable, pos, playedMs, mediaClockMs, quantumPlan,
  underrunStep, underrunResumeFrames,
} from '../src/audio-ring.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('audio-ring pure math (producer ⇄ worklet single source of truth):');

test('capacity + bytes: frames-for-seconds (ceil, floored ≥1) and SAB byte size', () => {
  assert.equal(ringFramesFor(1.0, 48_000), 48_000);
  assert.equal(ringFramesFor(1.5, 44_100), 66_150);
  assert.equal(ringFramesFor(0.0, 48_000), 1); // floored to ≥1 frame
  assert.equal(ringSabBytes(100), (RING_CTRL_SLOTS + 100 * RING_CHANNELS) * 4); // control + interleaved-stereo f32, ×4
});

test('readable/writable are complementary and clamp (never negative / never lap)', () => {
  const cap = 1000;
  assert.equal(readable(0, 0), 0);
  assert.equal(writable(0, 0, cap), cap);
  assert.equal(readable(300, 100), 200);
  assert.equal(writable(300, 100, cap), cap - 200);
  assert.equal(readable(cap, 0), cap);       // full ring
  assert.equal(writable(cap, 0, cap), 0);
  assert.equal(readable(100, 300), 0);       // defensive: read never exceeds write
  assert.equal(writable(100, 300, cap), cap);
});

test('pos wraps a monotonic cursor by capacity', () => {
  const cap = 8;
  assert.equal(pos(0, cap), 0);
  assert.equal(pos(7, cap), 7);
  assert.equal(pos(8, cap), 0); // wrap
  assert.equal(pos(20, cap), 4);
});

test('playedMs: monotonic, anchored, rate-0 defensive', () => {
  assert.ok(near(playedMs(1000.0, 48_000, 48_000), 2000.0)); // +1 s of played frames
  assert.ok(near(playedMs(0.0, 24_000, 48_000), 500.0));
  assert.ok(playedMs(0.0, 100, 48_000) < playedMs(0.0, 101, 48_000)); // monotonic in read
  assert.equal(playedMs(500.0, 999, 0), 500.0); // rate 0 → just the base
});

test('mediaClockMs tracks media PTS through drain + underrun free-run', () => {
  const rate = 48_000;
  const base = -10_000.0; // rebased so elapsed = 0 at the anchor (media PTS 10_000 ms, read==edge)
  assert.ok(near(mediaClockMs(base, 10_000.0, 0, 0, rate), 0.0));
  const edgePts = 11_000.0, edgeFrame = 48_000;
  const read = edgeFrame - 24_000; // 0.5 s of output behind the edge → media 10_500 → elapsed 500 ms
  assert.ok(near(mediaClockMs(base, edgePts, edgeFrame, read, rate), 500.0));
  const read2 = edgeFrame - 4_800; // drain to 0.1 s behind → media 10_900 → 900 ms (advanced 400 ms while edge held)
  assert.ok(near(mediaClockMs(base, edgePts, edgeFrame, read2, rate), 900.0));
  const read3 = edgeFrame + 4_800; // underrun free-run 0.1 s past the edge → extrapolates → 1100 ms
  assert.ok(near(mediaClockMs(base, edgePts, edgeFrame, read3, rate), 1100.0));
  assert.equal(mediaClockMs(base, 10_000.0, 5, 9, 0), 0.0); // rate 0 → base + edge
});

test('quantumPlan: full/partial/empty quantum → copy count + underran flag', () => {
  assert.deepEqual(quantumPlan(200, 128), { copy: 128, underran: false });
  assert.deepEqual(quantumPlan(128, 128), { copy: 128, underran: false });
  assert.deepEqual(quantumPlan(50, 128), { copy: 50, underran: true });   // partial → silence-fill rest
  assert.deepEqual(quantumPlan(0, 128), { copy: 0, underran: true });     // empty
});

test('underrunStep: the mpv underrun-HOLD state machine (latch, pin, resume)', () => {
  const hw = 18_000; // 0.375 s @ 48k (a test high-water; the real one is underrunResumeFrames)
  // Healthy (not held, full quantum) → copy + advance the full quantum, no hold/underrun.
  assert.deepEqual(underrunStep(200, 128, false, hw), { copy: 128, advance: 128, nowHeld: false, underran: false });
  // First shortfall LATCHES the hold and advances by REAL frames only (advance != quantum).
  assert.deepEqual(underrunStep(50, 128, false, hw), { copy: 50, advance: 50, nowHeld: true, underran: true });
  // Fully dry first quantum → copy 0, advance 0 (clock can't move), latch + count.
  assert.deepEqual(underrunStep(0, 128, false, hw), { copy: 0, advance: 0, nowHeld: true, underran: true });
  // Held, still below high-water → HOLD: 0 copy, 0 advance (clock pinned), NO double-count.
  assert.deepEqual(underrunStep(5_000, 128, true, hw), { copy: 0, advance: 0, nowHeld: true, underran: false });
  // Held, refilled past high-water → RESUME output.
  assert.deepEqual(underrunStep(20_000, 128, true, hw), { copy: 128, advance: 128, nowHeld: false, underran: false });
  // Resume boundary is inclusive (>= high-water).
  assert.ok(!underrunStep(hw, 128, true, hw).nowHeld);
  assert.ok(underrunStep(hw - 1, 128, true, hw).nowHeld); // one below → still held
  // Equivalence with quantumPlan on the !held path (copy + underran match).
  for (const r of [0, 50, 128, 200]) {
    const s = underrunStep(r, 128, false, hw);
    assert.deepEqual({ copy: s.copy, underran: s.underran }, quantumPlan(r, 128));
  }
});

test('underrunStep pins the clock across held quanta, advances by real frames on resume', () => {
  // Prove the mpv contract in pure math: across HELD quanta the read cursor doesn't move, so the clock is
  // IDENTICAL each call; on resume it advances by exactly the real frames played.
  const rate = 48_000, base = -10_000.0, edgePts = 11_000.0, edgeFrame = 48_000;
  const hw = underrunResumeFrames(rate);
  let read = edgeFrame - 600; // some position behind the edge
  const clock0 = mediaClockMs(base, edgePts, edgeFrame, read, rate);
  // Enter a hold (shortfall), then several held quanta with the ring still low.
  let held = false;
  const fst = underrunStep(120, 256, held, hw); // 120<256 → shortfall, advance 120
  read += fst.advance; held = fst.nowHeld;
  const clockAfterFirst = mediaClockMs(base, edgePts, edgeFrame, read, rate);
  for (let i = 0; i < 10; i++) {
    const s = underrunStep(1_000, 256, held, hw); // 1000 < hw → stays held, advance 0
    assert.equal(s.advance, 0);
    read += s.advance; held = s.nowHeld;
    // clock is FROZEN across every held quantum
    assert.ok(near(mediaClockMs(base, edgePts, edgeFrame, read, rate), clockAfterFirst, 1e-9));
  }
  assert.ok(held, 'still held below the high-water');
  // Refill past the high-water → resume; the clock advances again by exactly copy/rate·1000 ms.
  const resume = underrunStep(hw + 5_000, 256, held, hw);
  assert.ok(!resume.nowHeld);
  const before = mediaClockMs(base, edgePts, edgeFrame, read, rate);
  read += resume.advance;
  const after = mediaClockMs(base, edgePts, edgeFrame, read, rate);
  assert.ok(near(after - before, resume.advance * 1000 / rate, 1e-9));
  void clock0; // (anchor reference)
});

test('underrunResumeFrames matches UNDERRUN_RESUME_SECS · rate', () => {
  assert.equal(underrunResumeFrames(48_000), ringFramesFor(UNDERRUN_RESUME_SECS, 48_000));
  assert.equal(underrunResumeFrames(48_000), Math.trunc(0.30 * 48_000));
});

test('audio-buffer target invariants: 0 < PREFILL ≤ RESUME < 0.375', () => {
  // Startup prefill ≤ the underrun resume high-water; both well under the producer's ~0.375 s fill ceiling
  // (0.5 s cap − 0.125 s pcmHasRoom margin) so both are promptly reachable.
  assert.equal(AUDIO_PREFILL_SECS, 0.20);
  assert.ok(AUDIO_PREFILL_SECS > 0.0);
  assert.ok(AUDIO_PREFILL_SECS <= UNDERRUN_RESUME_SECS);
  assert.ok(UNDERRUN_RESUME_SECS < 0.375);
});

console.log(`\naudio-ring: ${passed} passed`);
