// Unit test for the PURE graceful-degradation helpers (the tier-2 FLOOR-FIX + the graduated ladder).
// DOM-free, browser-free — the same reason cadenceStats/nextHold were factored out: the PTS-CAP decimation
// (capAdvance: self-flooring, never below the decode rate, no L1+L2 double-decimation), the demux-pressure
// hint, and the GRADUATED, AXIS-SEPARATED degrade ladder (the climb/de-escalate state machine governed by
// mpv check_framedrop's forward-headroom signal) are unit-testable headless, away from the present worker.
//
// Mirrors the Rust `cadence.rs` #[test] cells (player-core/src/cadence.rs `mod tests`):
//   capAdvance   — tier 1 always a single hand-off; tier 2 caps a DENSE ring to every-other (the draw relief)
//                  but NEVER below the decode rate (a SPARSE ring shows all); never empties the ring; 0 starved.
//   demuxRingPressure — high absolute OR a sufficient climb from the window min ⇒ pressure; drained → false.
//   ladderStep   — the QUALITY-FIRST ladder (rung 0→1 skip-non-ref →2 +present-cap HALVE →3 +skip-deblock):
//                  rung-1 IS mpv check_framedrop (the forward-headroom signal, debounced); the heavier rungs
//                  climb ONE per settle window while STILL behind AND under; rung2→3 gated on contentFps ≥ 48
//                  (slow content caps at rung 2 = skip-deblock); de-escalates in strict reverse on the
//                  un-maskable `!fd` re-probe (fast) or throughput headroom (slow); a present-stall never trips
//                  it; the un-halve is anti-flap-gated on decodeFps; the latch breaks via forward headroom.
//   rung4Severe  — the drop-to-keyframe severe-deficit predicate (only at RUNG_MAX, past the severe frac).
//
// Run:  node --experimental-strip-types tests/degrade_cadence.mjs   (node ≥22)

import assert from 'node:assert/strict';
import {
  capAdvance, ladderStep, rungDecimation, demuxRingPressure, rung4Severe,
  CADENCE_TIER_FULL, CADENCE_TIER_HALF,
  RUNG_NONE, RUNG_L2, RUNG_L2_L1, RUNG_L2_L1_L3, RUNG_MAX,
  LADDER_CLIMB_MS, LADDER_DROP_MS, LADDER_RECOVER_MS, LADDER_L1_MIN_FPS, LADDER_MIN_CONTENT_FPS,
  CHECK_FRAMEDROP_SUSTAIN_MS,
  DEGRADE_RING_BYTES, DEGRADE_RING_GROWTH_BYTES,
} from '../src/worker/present-cadence.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('PTS-cap decimation (tier-2 floor-fix) + graduated graceful-degradation ladder:');

const US = 1000;                       // µs per ms
const P50 = 20 * US;                   // true content period for 50 fps content (20 ms)
// Build a ring of `count` frames spaced `spacingUs` apart (ascending PTS from 0) — index 0 is the front.
const ringAt = (count, spacingUs) => Array.from({ length: count }, (_, i) => ({ ptsUs: i * spacingUs }));
const fps = (perSec) => Math.round(1e6 / perSec); // µs spacing for a given fps

// ---- capAdvance: the PTS-cap per-step ring consumption (the floor-fix core) ----

test('tier 1 (full rate) always consumes exactly 1 when a next frame exists, 0 when starved (UNCHANGED path)', () => {
  assert.equal(capAdvance(ringAt(0, P50), 0, P50, CADENCE_TIER_FULL), 0, 'empty → starved');
  assert.equal(capAdvance(ringAt(1, P50), 0, P50, CADENCE_TIER_FULL), 0, 'a single front, no successor → hold');
  assert.equal(capAdvance(ringAt(2, P50), 0, P50, CADENCE_TIER_FULL), 1, 'retire the front, advance to the next');
  assert.equal(capAdvance(ringAt(24, P50), 0, P50, CADENCE_TIER_FULL), 1, 'full rate never skips regardless of depth');
});

test('tier 2 CAP: dense frames (decode = full 50 fps) → every-other (the intended draw-bandwidth relief)', () => {
  // 50 fps content, 50 fps decode (20 ms apart), tier-2 target = 2×20 = 40 ms → show 0, 40, 80… (every other).
  assert.equal(capAdvance(ringAt(5, fps(50)), 0, P50, CADENCE_TIER_HALF), 2, 'retire front + skip the 20ms frame → show the 40ms one');
  assert.equal(capAdvance(ringAt(24, fps(50)), 0, P50, CADENCE_TIER_HALF), 2, 'a deep dense ring advances exactly 2 (target = 40ms)');
});

test('tier 2 FLOOR: decode 15 fps (frames already > target apart) → shows ALL (never below the decode rate)', () => {
  // The OLD BUG: every-other halved an already-starved 15 fps to ~7.5. Frames are 66ms apart > the 40ms
  // target, so the cap skips NOTHING → present = decode = 15 fps.
  const ring = ringAt(5, fps(15));
  assert.equal(capAdvance(ring, ring[0].ptsUs, P50, CADENCE_TIER_HALF), 1, 'sparse ring → no skip → floor at decode rate');
});

test('tier 2 FLOOR: decode 25 fps (= the tier target) → shows ALL (boundary frame AT target is shown)', () => {
  // 40 ms apart == the 40 ms target. Strict `< target` ⇒ the boundary frame is SHOWN, not skipped → 25 fps.
  const ring = ringAt(5, fps(25));
  assert.equal(capAdvance(ring, ring[0].ptsUs, P50, CADENCE_TIER_HALF), 1, 'a frame exactly at the target interval is shown (no skip)');
});

test('NO DOUBLE-DECIMATION (L1+L2): L2 spaces decode at 25 fps, TRUE period stays 20 ms → cap shows all 25', () => {
  // With L2 (skip non-ref) the decoder OUTPUTS ~25 fps (40 ms apart), but the cap target uses the TRUE
  // content period (20 ms, from demux PACKET PTS — L2-independent) → target 40 ms → the 40ms-spaced L2
  // frames are all shown. If the cap had used the L2-decimated arrival rate the target would be 80 ms and it
  // would halve again to 12.5 — this asserts it does NOT.
  const ring = ringAt(6, fps(25)); // L2 output spacing
  assert.equal(capAdvance(ring, ring[0].ptsUs, P50, CADENCE_TIER_HALF), 1, 'L1+L2 → show every L2 frame (no second halving)');
});

test('a drained ring never decimates: tier 2 at ring length 2 retires 1 only (the floor at shallow depth)', () => {
  assert.equal(capAdvance(ringAt(2, fps(50)), 0, P50, CADENCE_TIER_HALF), 1, 'len 2 → retire 1, never skip (≥1 front kept)');
  assert.equal(capAdvance(ringAt(1, fps(50)), 0, P50, CADENCE_TIER_HALF), 0, 'len 1 → starved');
});

test('a never-empties invariant: tier 2 (dense ring) never consumes the whole ring (always leaves ≥1 front)', () => {
  for (let len = 2; len <= 50; len++) {
    const adv = capAdvance(ringAt(len, fps(50)), 0, P50, CADENCE_TIER_HALF);
    assert.ok(len - adv >= 1, `len=${len} adv=${adv} leaves ≥1 front`);
  }
});

test('defensive: a non-positive period falls back to a plain hand-off (no divide-by-period skip)', () => {
  assert.equal(capAdvance(ringAt(5, fps(50)), 0, 0, CADENCE_TIER_HALF), 1, 'period 0 → full-rate hand-off');
});

// ---- accounting balance: drive a ring through advances, mirror the present worker's shift+release ----

// Simulate the runCadence advance: each present STEP shifts capAdvance(ring,shown,period,tier) frames off the
// ring; i=0 is the displayed front (a hand-off), i>0 are intentional decimation skips. Every shifted frame is
// "released" exactly once. shown = ring[0].ptsUs (the front being retired). Assert: no double-release, no
// strand, monotonic PTS consumption.
function drainAndAccount(count, spacingUs, periodUs, tier, refillTo = 0, steps = 2000) {
  let ring = ringAt(count, spacingUs);
  let nextPts = count * spacingUs;
  const released = [];
  let handoffs = 0, skips = 0;
  for (let s = 0; s < steps; s++) {
    const shown = ring.length ? ring[0].ptsUs : -1;
    const adv = capAdvance(ring, shown, periodUs, tier);
    if (adv === 0) break; // genuinely starved / drained
    for (let i = 0; i < adv; i++) {
      const f = ring.shift();
      released.push(f.ptsUs);
      if (i === 0) handoffs++; else skips++;
    }
    while (refillTo > 0 && ring.length < refillTo) { ring.push({ ptsUs: nextPts }); nextPts += spacingUs; }
  }
  return { released, handoffs, skips, remaining: ring.length, producedPts: nextPts };
}

test('ACCOUNTING (tier 1, drain): every frame released exactly once, none stranded, none double-freed', () => {
  const { released, remaining } = drainAndAccount(24, fps(50), P50, CADENCE_TIER_FULL);
  assert.equal(new Set(released).size, released.length, 'no frame released twice');
  assert.equal(released.length, 23, 'all but the last front are retired (tier 1, ring of 24)');
  assert.equal(remaining, 1, 'the final front is held (no successor), never stranded');
  assert.deepEqual(released, Array.from({ length: 23 }, (_, i) => i * fps(50)), 'consumed in strict PTS order');
});

test('ACCOUNTING (tier 2, dense drain): retire + skip balance, no double-free, leaves exactly 1 front', () => {
  const { released, handoffs, skips, remaining } = drainAndAccount(24, fps(50), P50, CADENCE_TIER_HALF);
  assert.equal(new Set(released).size, released.length, 'no double-release under decimation');
  assert.equal(released.length + remaining, 24, 'released + remaining == the whole ring (nothing lost)');
  assert.equal(remaining, 1, 'never empties the ring');
  assert.equal(handoffs + skips, released.length, 'every released frame is a hand-off or a skip');
  assert.ok(skips > 0, 'tier 2 on a dense ring actually decimated');
});

test('ACCOUNTING (tier 2, steady dense refill): ~half displayed, the rest decimation skips, all released once', () => {
  const { released, handoffs, skips, remaining, producedPts } = drainAndAccount(24, fps(50), P50, CADENCE_TIER_HALF, 24, 500);
  assert.equal(new Set(released).size, released.length, 'no double-release across 500 steps');
  assert.equal(released.length + remaining, producedPts / fps(50), 'released + still-queued == total produced');
  assert.ok(Math.abs(handoffs - skips) <= 1, `hand-offs (${handoffs}) ≈ skips (${skips}) — clean every-other decimation`);
});

test('ACCOUNTING (tier 2, SPARSE steady refill = decode-bound): shows ALL, ZERO skips (the floor holds in steady state)', () => {
  const { skips, handoffs, released } = drainAndAccount(8, fps(15), P50, CADENCE_TIER_HALF, 8, 500);
  assert.equal(skips, 0, 'sparse ring → no decimation ever (floor: present never below decode)');
  assert.equal(handoffs, released.length, 'every shown frame is a hand-off (nothing skipped)');
});

// ---- demuxRingPressure: the decode-bound (audio-risk) WEAK hint ----

test('demuxRingPressure: drained ring (healthy / VOD-range) → NO pressure; above the latency floor → pressure', () => {
  assert.equal(demuxRingPressure(780_000, 700_000), false, 'drained ≈0.78 MB, no growth → no pressure');
  assert.equal(demuxRingPressure(0, 0), false, 'VOD-range / empty ring → no pressure');
  assert.equal(demuxRingPressure(DEGRADE_RING_BYTES, DEGRADE_RING_BYTES), true, 'at the absolute latency floor → pressure (sustained high)');
  assert.equal(demuxRingPressure(2_700_000, 2_700_000), true, 'the proven decode-bound ≈2.7 MB (audio starves) → pressure');
});

test('demuxRingPressure: a CLIMBING ring (decode not draining) trips on the growth delta before the absolute floor', () => {
  const min = 400_000;
  assert.equal(demuxRingPressure(min + DEGRADE_RING_GROWTH_BYTES - 1, min), false, 'just under the growth delta → not yet');
  assert.equal(demuxRingPressure(min + DEGRADE_RING_GROWTH_BYTES, min), true, 'climbed ≥ the growth delta from the window min → pressure');
});

// ---- ladderStep: the graduated, axis-separated escalate/de-escalate ladder ----
//
// The LadderInput builders mirror the Rust test helpers (under_input / headroom_input / ambiguous_input).
// `decimation` tracks the active present-cap (content-aware: 2 only at rung ≥ RUNG_L2_L1 for fast content);
// the present worker passes exactly this so a halved display isn't read as a permanent deficit. `decimLower`
// is the decimation one rung down (gates the un-halve). `forwardHeadroomUs` is mpv check_framedrop's signal.

// A genuine decode-bound under-delivery window: present well below the effective target, the media clock
// sub-realtime, the present ring draining, AND the decoder behind the master clock (fd engages).
const underInput = (contentFps, decimation, dWall) => {
  const target = contentFps / decimation;
  const fp = 1e6 / contentFps;
  return {
    cadenceActive: true, paused: false, haveContentPeriod: true,
    presentFps: target * 0.5,           // well under the 0.85 under-fraction
    contentFps, decimation,
    decodeFps: contentFps * 0.5,        // decoder under-delivering (decode-bound)
    decimLower: 1.0,
    clockRateRatio: 0.90,               // < LADDER_RATE_UNDER ⇒ can't keep up
    ringLow: true, ringHealthy: false, presentRingFull: false, demuxPressure: false,
    forwardHeadroomUs: -fp,             // decoder behind the master clock ⇒ check_framedrop engages
    framePeriodUs: fp, dWallMs: dWall,
  };
};

// A genuine headroom window: present at the effective target, clock realtime, ring healthy, AND the decoder
// comfortably ahead (forward headroom 5 frames → check_framedrop releases).
const headroomInput = (contentFps, decimation, dWall) => {
  const target = contentFps / decimation;
  const fp = 1e6 / contentFps;
  return {
    cadenceActive: true, paused: false, haveContentPeriod: true,
    presentFps: target,                 // ≥ the 0.90 over-fraction
    contentFps, decimation,
    decodeFps: contentFps,              // fully recovered → sustains the un-halved rate
    decimLower: 1.0,
    clockRateRatio: 1.0,                // ≥ LADDER_RATE_OVER ⇒ realtime
    ringLow: false, ringHealthy: true, presentRingFull: false, demuxPressure: false,
    forwardHeadroomUs: 5.0 * fp,        // decoder comfortably ahead ⇒ check_framedrop releases
    framePeriodUs: fp, dWallMs: dWall,
  };
};

// An AMBIGUOUS window — neither under (the stream keeps up: clock realtime, ring not draining) nor headroom
// (present is low). Must reset BOTH streaks so the ladder never creeps on transient noise.
const ambiguousInput = (contentFps, decimation, dWall) => {
  const fp = 1e6 / contentFps;
  return {
    cadenceActive: true, paused: false, haveContentPeriod: true,
    presentFps: contentFps / decimation * 0.5, // low → not headroom
    contentFps, decimation,
    decodeFps: contentFps,              // decode FINE → the low present is a present-side, not a decode, deficit
    decimLower: 1.0,
    clockRateRatio: 1.0,                // realtime + ring not low ⇒ NOT can't-keep-up ⇒ not under
    ringLow: false, ringHealthy: false, presentRingFull: false, demuxPressure: false,
    forwardHeadroomUs: 5.0 * fp,        // decode is fine ⇒ no check_framedrop engage
    framePeriodUs: fp, dWallMs: dWall,
  };
};

const LS = (rung, climbMs = 0, dropMs = 0) => ({ rung, climbMs, dropMs });

test('rungDecimation: the EFFECTIVE present target halves at rung ≥ 2 (present-cap) for FAST content only', () => {
  // Quality-first order: the present-cap HALVE engages at rung 2 (RUNG_L2_L1) — but only for content fast
  // enough that 25 stays watchable (≥ LADDER_L1_MIN_FPS); slow content maps that rung to skip-deblock (decim 1).
  assert.equal(rungDecimation(RUNG_NONE, 50), 1, 'rung 0 → full rate');
  assert.equal(rungDecimation(RUNG_L2, 50), 1, 'rung 1 (skip-non-ref) → no display decimation');
  assert.equal(rungDecimation(RUNG_L2_L1, 50), 2, 'rung 2 (+present-cap) on fast content → display halved');
  assert.equal(rungDecimation(RUNG_L2_L1_L3, 50), 2, 'rung 3 (+skip-deblock) stays halved');
  assert.equal(rungDecimation(RUNG_L2_L1, 25), 1, 'rung 2 on SLOW content → no halve (maps to skip-deblock)');
});

// rung-1 (check_framedrop) engages after a SUSTAINED forward-headroom deficit (CHECK_FRAMEDROP_SUSTAIN_MS
// debounce); the heavier rungs then climb one per LADDER_CLIMB_MS.
test('ladder climbs one rung per window: NONE→L2 debounced, then one heavy rung per settle window', () => {
  let s = LS(RUNG_NONE);
  const win = 500;
  const perRung = Math.trunc(LADDER_CLIMB_MS / win);                 // 5 windows
  const engage = Math.ceil(CHECK_FRAMEDROP_SUSTAIN_MS / win);        // 5 windows
  // RUNG_NONE → RUNG_L2 (check_framedrop) is debounced over CHECK_FRAMEDROP_SUSTAIN_MS.
  for (let i = 0; i < engage - 1; i++) {
    s = ladderStep(s, underInput(50, 1, win));
    assert.equal(s.rung, RUNG_NONE, 'rung-1 not engaged before the sustain');
  }
  s = ladderStep(s, underInput(50, 1, win));
  assert.equal(s.rung, RUNG_L2, 'check_framedrop engages rung-1 after the sustain');
  // The HEAVY rungs climb one per LADDER_CLIMB_MS of sustained throughput deficit.
  for (let expectRung = RUNG_L2 + 1; expectRung <= RUNG_MAX; expectRung++) {
    for (let i = 0; i < perRung - 1; i++) {
      s = ladderStep(s, underInput(50, 1, win));
      assert.equal(s.rung, expectRung - 1, 'must not climb early');
    }
    s = ladderStep(s, underInput(50, 1, win));
    assert.equal(s.rung, expectRung, 'one heavy rung per settle window');
    assert.equal(s.climbMs, 0, 'fresh settle window at the new rung');
  }
  // At RUNG_MAX it can climb no further (decimation 2 at the top rung).
  for (let i = 0; i < perRung * 2; i++) s = ladderStep(s, underInput(50, 2, win));
  assert.equal(s.rung, RUNG_MAX, 'saturates at RUNG_MAX');
});

test('an ambiguous window resets the HEAVY-climb streak — no creep on transient noise', () => {
  let s = LS(RUNG_NONE);
  const win = 500;
  // Engage rung-1 (debounced), then accumulate the heavy-climb streak.
  for (let i = 0; i < Math.ceil(CHECK_FRAMEDROP_SUSTAIN_MS / win); i++) s = ladderStep(s, underInput(50, 1, win));
  assert.equal(s.rung, RUNG_L2, 'rung-1 engaged');
  for (let i = 0; i < 4; i++) s = ladderStep(s, underInput(50, 1, win));
  assert.equal(s.rung, RUNG_L2);
  assert.ok(s.climbMs > 0, 'heavy-climb streak accumulated');
  // One ambiguous window breaks the streak.
  s = ladderStep(s, ambiguousInput(50, 1, win));
  assert.equal(s.climbMs, 0, 'ambiguous window resets the climb streak');
  assert.equal(s.rung, RUNG_L2);
  // Now it needs a FULL fresh 2500 ms to climb to L2_L1 (4 more wouldn't, proving no creep).
  for (let i = 0; i < 4; i++) {
    s = ladderStep(s, underInput(50, 1, win));
    assert.equal(s.rung, RUNG_L2, 'still below the heavy-climb threshold after the reset');
  }
  s = ladderStep(s, underInput(50, 1, win));
  assert.equal(s.rung, RUNG_L2_L1, 'climbs only after a full fresh settle window');
});

test('present-cap GATE: contentFps < 48 caps at rung 2 (skip-non-ref + skip-deblock) — never the 25→12.5 halve', () => {
  let s = LS(RUNG_NONE);
  const win = 500;
  // 25 fps content: climbs through skip-non-ref and + (slow-content) skip-deblock but is BLOCKED at rung2→3.
  for (let i = 0; i < 200; i++) s = ladderStep(s, underInput(25, 1, win));
  assert.equal(s.rung, RUNG_L2_L1, 'slow content tops out at rung 2 (present-cap gated off)');
});

test('de-escalation: sustained headroom drops strictly present-cap → skip-deblock → skip-non-ref, asymmetrically', () => {
  const win = 1000;
  // headroomInput is comfortably ahead (forward_headroom = 5 frames → !fd), so de-escalation rides the FAST
  // forward-headroom re-probe (LADDER_RECOVER_MS), not the slow throughput path.
  const dropWindows = Math.ceil(LADDER_RECOVER_MS / win); // 2 windows
  let s = LS(RUNG_MAX);
  for (let expectRung = RUNG_MAX - 1; expectRung >= RUNG_NONE; expectRung--) {
    // present-cap (halve) is engaged at rung ≥ 2 in the quality-first order; decimation 2 there, else 1.
    const decim = s.rung >= RUNG_L2_L1 ? 2 : 1;
    for (let i = 0; i < dropWindows - 1; i++) {
      s = ladderStep(s, headroomInput(50, decim, win));
      assert.equal(s.rung, expectRung + 1, 'must not drop before the re-probe settle');
    }
    s = ladderStep(s, headroomInput(50, decim, win));
    assert.equal(s.rung, expectRung, 'drops exactly one lever in strict reverse');
  }
  assert.equal(s.rung, RUNG_NONE, 'fully de-escalated to the full-rate path');
});

test('decode-bound climb at a REALTIME clock: the masked-realtime case climbs on decodeFps alone', () => {
  // 50 fps content, decoder only manages 26 fps, BUT clock realtime + ring NOT low + no demux pressure — the
  // ONLY decode-deficit signal is decodeFps < contentFps (the clock-based cantKeepUp never trips here).
  let s = LS(RUNG_NONE);
  const win = 500;
  const inp = { ...ambiguousInput(50, 1, win) };
  inp.presentFps = 26;                 // present delivering the decoder's ~26 unique fps (judder)
  inp.decodeFps = 26;                  // the real deficit, invisible to the clock
  inp.forwardHeadroomUs = -inp.framePeriodUs; // …and visible to check_framedrop (decoder behind)
  // rung-1 (check_framedrop) engages on the SUSTAINED behind-the-clock signal (debounced) …
  for (let i = 0; i < Math.ceil(CHECK_FRAMEDROP_SUSTAIN_MS / win); i++) s = ladderStep(s, inp);
  assert.equal(s.rung, RUNG_L2, 'check_framedrop engages on the sustained decode deficit');
  // … and the HEAVY ladder STILL climbs at a realtime clock via the decodeFps deficit.
  for (let i = 0; i < Math.trunc(LADDER_CLIMB_MS / win); i++) s = ladderStep(s, inp);
  assert.equal(s.rung, RUNG_L2_L1, 'a decode deficit at a realtime clock still climbs the heavy ladder');
});

test('anti-flap: at a half rung the capped present LOOKS like headroom, but decodeFps gates the un-halve → HOLD', () => {
  let s = LS(RUNG_L2_L1); // skip-non-ref + present-cap halve engaged
  for (let i = 0; i < 40; i++) {
    // Looks like throughput headroom at the HALVED target (present=25=target), clock realtime…
    const inp = { ...headroomInput(50, 2, 1000) };
    // …but the decoder is pinned at the box ceiling: it only JUST keeps up with the halved demand, so its
    // FORWARD HEADROOM is small (check_framedrop stays engaged, fd) — un-halving would face a 50 fps it can't
    // meet. A genuinely-bound decoder is NOT comfortably ahead, so the `!fd` de-escalation must NOT fire.
    inp.decodeFps = 26;
    inp.forwardHeadroomUs = 0.5 * inp.framePeriodUs; // just keeping up ⇒ fd stays engaged
    inp.decimLower = 1.0;
    s = ladderStep(s, inp);
  }
  assert.equal(s.rung, RUNG_L2_L1, 'holds the half rung — never un-halves into a rate the decoder can\'t meet');
});

test('a PINNED-FULL present ring (present-side stall) NEVER trips the ladder, even under decode-bound-looking input', () => {
  let s = LS(RUNG_NONE);
  for (let i = 0; i < 200; i++) {
    const inp = { ...underInput(50, 1, 500), presentRingFull: true };
    s = ladderStep(s, inp);
  }
  assert.equal(s.rung, RUNG_NONE, 'a present-side stall never degrades');
});

test('rung-4 severe-deficit predicate: fires ONLY at RUNG_MAX past the severe frac, never on a lower rung / unknowns', () => {
  assert.equal(rung4Severe(RUNG_MAX, 12.5, 50), true, '¼-realtime at RUNG_MAX is severe');
  assert.equal(rung4Severe(RUNG_MAX, 40, 50), false, '0.8× is within reach of the safe levers');
  assert.equal(rung4Severe(RUNG_MAX, 25, 50), false, '0.5× exactly is not severe (strict <)');
  assert.equal(rung4Severe(RUNG_L2_L1, 5, 50), false, 'a lower rung never fires rung-4');
  assert.equal(rung4Severe(RUNG_NONE, 1, 50), false, 'rung 0 never fires rung-4');
  assert.equal(rung4Severe(RUNG_MAX, 0, 50), false, 'decodeFps ≤ 0 (unknown) never fires');
  assert.equal(rung4Severe(RUNG_MAX, 12.5, 0), false, 'contentFps ≤ 0 (unknown) never fires');
});

test('rung-1 RELEASE: at RUNG_L2 with the decoder comfortably ahead (!fd) and no deficit → drops L2→NONE (fast)', () => {
  const win = 1000;
  const dropWindows = Math.ceil(LADDER_RECOVER_MS / win); // 2 windows
  let s = LS(RUNG_L2);
  // headroomInput has the decoder comfortably ahead (forward_headroom = 5 frames → check_framedrop release).
  for (let i = 0; i < dropWindows - 1; i++) {
    s = ladderStep(s, headroomInput(50, 1, win));
    assert.equal(s.rung, RUNG_L2, 'holds rung-1 until the re-probe settle elapses');
  }
  s = ladderStep(s, headroomInput(50, 1, win));
  assert.equal(s.rung, RUNG_NONE, 'releases skip-non-ref once comfortably caught up');
});

test('forward-headroom BREAKS THE LATCH: a maxed ladder with masked throughput but a decoder ahead de-escalates to NONE', () => {
  // At the TOP rung the relief levers MASK the throughput signals (skip-non-ref + half-cadence depress decodeFps
  // AND presentFps, so the throughput `headroom` can NEVER fire); the decoder is actually comfortably AHEAD
  // (large forward headroom). The masked-throughput de-escalation can never move from here; forward headroom must.
  const win = 1000;
  const fp = 1e6 / 50;
  let s = LS(RUNG_MAX);
  for (let i = 0; i < 40; i++) {
    const inp = { ...underInput(50, 2, win) }; // "looks bound" by throughput (present/decodeFps depressed)
    inp.presentFps = 20;
    inp.decodeFps = 20;
    inp.forwardHeadroomUs = 8.0 * fp;          // … but the decoder is comfortably ahead (the un-maskable truth)
    s = ladderStep(s, inp);
  }
  assert.equal(s.rung, RUNG_NONE, 'forward headroom de-escalates the latched ladder to the full-rate path');
});

test('rung-1 is HELD inside the [1,3]-frame hysteresis band with no sustained deficit (skip-non-ref must not flap)', () => {
  let s = LS(RUNG_L2);
  const fp = 1e6 / 50;
  for (let i = 0; i < 40; i++) {
    // Decoder marginally ahead (2 frames) → inside the [1,3]-frame band → check_framedrop stays engaged;
    // present is below target (NO throughput headroom) and the stream keeps up (NOT under) → neither a climb
    // nor a de-escalation fires.
    const inp = { ...ambiguousInput(50, 1, 1000) };
    inp.forwardHeadroomUs = 2.0 * fp; // in the [1,3]-frame band → fd holds engaged
    s = ladderStep(s, inp);
  }
  assert.equal(s.rung, RUNG_L2, 'holds skip-non-ref while the decoder is marginally ahead (no flap)');
});

test('min-content-fps guard: genuinely low-fps content (≤20) NEVER degrades, however decode-bound', () => {
  const win = 500;
  let s = LS(RUNG_NONE);
  for (let i = 0; i < 200; i++) s = ladderStep(s, underInput(LADDER_MIN_CONTENT_FPS - 2, 1, win));
  assert.equal(s.rung, RUNG_NONE, 'mpv fps≤20 framedrop guard: never degrade low-fps content');
});

test('guards: paused / cadence-inactive / no-content-period never climb even with a low present fps', () => {
  const win = 500;
  for (const patch of [{ paused: true }, { cadenceActive: false }, { haveContentPeriod: false }]) {
    let s = LS(RUNG_NONE);
    for (let i = 0; i < 200; i++) s = ladderStep(s, { ...underInput(50, 1, win), ...patch });
    assert.equal(s.rung, RUNG_NONE, `${JSON.stringify(patch)} must not climb`);
  }
});

test('demux pressure ALONE carries "can\'t keep up" when the clock window is invalid (0) — climbs to L2', () => {
  // clockRateRatio 0 (a re-anchored/seam window = no valid clock) → the demux-ring hint + a draining ring + the
  // decoder behind still let a genuine decode deficit engage rung-1 (the hint strengthens cantKeepUp).
  const win = 500;
  let s = LS(RUNG_NONE);
  const inp = { ...underInput(50, 1, win), clockRateRatio: 0, demuxPressure: true };
  for (let i = 0; i < Math.ceil(CHECK_FRAMEDROP_SUSTAIN_MS / win); i++) s = ladderStep(s, inp);
  assert.equal(s.rung, RUNG_L2, 'a draining ring + demux pressure climbs without a clock reading');
});

console.log(`\ndegrade-cadence: ${passed} passed`);
