// Unit test for the PURE graceful-degradation helpers (the tier-2 FLOOR-FIX + the trigger).
// DOM-free, browser-free — the same reason cadenceStats/nextHold were factored out: the PTS-CAP decimation
// (capAdvance: self-flooring, never below the decode rate, no L1+L2 double-decimation) + its shift/release
// ACCOUNTING (no stranded/double-released slots) and the degrade TRIGGER hysteresis (no flap, never degrade
// a healthy stream) are unit-testable headless, away from the OffscreenCanvas/WebGL present worker.
//
// Proves:
//   capAdvance   — tier 1 always consumes 1 (full-rate path UNCHANGED); tier 2 caps by PTS DECIMATION:
//                  dense frames (decode ≥ target) → skip to the target interval (the bandwidth relief),
//                  SPARSE frames (decode < target, or a drained ring) → skip NOTHING (the FLOOR — present
//                  never below decode); the TRUE content period keeps L1+L2 from decimating twice; never
//                  empties the ring (always leaves ≥1 front); 0 when starved (<2).
//   accounting   — driving a ring through repeated advances releases EVERY frame EXACTLY once (no strand,
//                  no double-free) and never advances past the queue; the displayed front is a hand-off and
//                  only the intermediate frames are decimation skips.
//   demuxRingPressure— the (now WEAK-hint) decode-bound signal: ring ABOVE the latency floor OR CLIMBED ≥ the
//                  growth delta over the trend window; drained → false.
//   ladderStep   — the GRADUATED, AXIS-SEPARATED ladder (rung 0→1 L2 →2 +L3 →3 +L1): a present-side decode-
//                  bound detector climbs ONE rung per settle window; rung2→3 is gated on contentFps ≥ 48 (so a
//                  25fps stream caps at L2+L3, never the nonsense 12.5 halving); de-escalates in strict reverse
//                  (L1→L3→L2) on sustained headroom, with slow asymmetric hysteresis (no flap); a capable
//                  stream / present-stall (ring pinned full) NEVER degrades; the effective target halves at rung 3.
//
// Run:  bun tests/degrade_cadence.mjs   (or node --experimental-strip-types, node ≥22)

import assert from 'node:assert/strict';
import {
  capAdvance, ladderStep, rungDecimation, demuxRingPressure,
  CADENCE_TIER_FULL, CADENCE_TIER_HALF,
  RUNG_NONE, RUNG_L2, RUNG_L2_L3, RUNG_L2_L3_L1, RUNG_MAX,
  LADDER_CLIMB_MS, LADDER_DROP_MS, LADDER_L1_MIN_FPS,
  DEGRADE_RING_BYTES, DEGRADE_RING_GROWTH_BYTES,
} from '../src/worker/present-cadence.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('PTS-cap decimation (tier-2 floor-fix) + graceful-degradation trigger:');

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
  // frames are all shown. If the cap had used the L2-decimated arrival rate (40 ms) the target would be
  // 80 ms and it would halve again to 12.5 — this asserts it does NOT.
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
  // conservation: every released PTS is < producedPts, and released+remaining == produced count.
  assert.equal(released.length + remaining, producedPts / fps(50), 'released + still-queued == total produced');
  assert.ok(Math.abs(handoffs - skips) <= 1, `hand-offs (${handoffs}) ≈ skips (${skips}) — clean every-other decimation`);
});

test('ACCOUNTING (tier 2, SPARSE steady refill = decode-bound): shows ALL, ZERO skips (the floor holds in steady state)', () => {
  // Decode delivers 15 fps (sparse, > target apart). Even with a refill the cap must NEVER skip → present = decode.
  const { skips, handoffs, released } = drainAndAccount(8, fps(15), P50, CADENCE_TIER_HALF, 8, 500);
  assert.equal(skips, 0, 'sparse ring → no decimation ever (floor: present never below decode)');
  assert.equal(handoffs, released.length, 'every shown frame is a hand-off (nothing skipped)');
});

// ---- demuxRingPressure: the decode-bound (audio-risk) gate ----

test('demuxRingPressure: drained ring (healthy / VOD-range) → NO pressure; above the latency floor → pressure', () => {
  assert.equal(demuxRingPressure(780_000, 700_000), false, 'drained ≈0.78 MB, no growth → no pressure');
  assert.equal(demuxRingPressure(0, 0), false, 'VOD-range / empty ring → no pressure');
  assert.equal(demuxRingPressure(DEGRADE_RING_BYTES, DEGRADE_RING_BYTES), true, 'at the absolute latency floor → pressure (sustained high)');
  assert.equal(demuxRingPressure(2_700_000, 2_700_000), true, 'the proven decode-bound ≈2.7 MB (audio starves) → pressure');
});

test('demuxRingPressure: a CLIMBING ring (decode not draining) trips on the growth delta before the absolute floor', () => {
  // climbed 0.4 → 0.4+growth: under the absolute floor but the delta alone is pressure.
  const min = 400_000;
  assert.equal(demuxRingPressure(min + DEGRADE_RING_GROWTH_BYTES - 1, min), false, 'just under the growth delta → not yet');
  assert.equal(demuxRingPressure(min + DEGRADE_RING_GROWTH_BYTES, min), true, 'climbed ≥ the growth delta from the window min → pressure');
});

// ---- ladderStep: the graduated, axis-separated escalate/de-escalate ladder ----

const WIN = 250;                         // the ~4Hz pstats post window (ms)
const climbWins = Math.ceil(LADDER_CLIMB_MS / WIN); // windows of sustained under to climb ONE rung
const dropWins = Math.ceil(LADDER_DROP_MS / WIN);   // windows of sustained headroom to drop ONE rung
const RUNG0 = { rung: RUNG_NONE, climbMs: 0, dropMs: 0 };

// Base measurement window — a CAPABLE 50fps stream (present at rate, clock realtime, ring full, no pressure).
const capable = {
  cadenceActive: true, paused: false, haveContentPeriod: true,
  presentFps: 49, contentFps: 50, clockRateRatio: 1.0,
  ringLow: false, ringHealthy: true, presentRingFull: false, demuxPressure: false, dWallMs: WIN,
};
// A genuinely DECODE-BOUND 50fps window WITH A LOW DEMUX RING (the #2 case: media/wall 0.77×, present 32/50,
// demux ring stayed low because the read-gate paced ingest). The present-side detector must catch this with
// NO demux-pressure help — clockRateRatio<0.95 + the present ring draining carry it.
const decodeBound50 = {
  ...capable, presentFps: 32, clockRateRatio: 0.77, ringLow: true, ringHealthy: false, demuxPressure: false,
};

// The ACTIVE display decimation a window sees: the manual present-cap (forced 2) OR — manual off — the rung's
// own L1 (2 at rung 3). The present worker passes exactly this (activeTier) so a manually-halved display isn't
// read as a permanent deficit. Tests omit `decimation` to track the rung (manual off); set it to force manual.
const decimFor = (inp, rung) => (inp.decimation != null ? inp.decimation : rungDecimation(rung));

// Drive `state` through `n` windows of a FIXED input (decimation tracks the rung unless the input forces it).
function run(state, inp, n) {
  let s = state;
  for (let i = 0; i < n; i++) s = ladderStep(s, { ...inp, decimation: decimFor(inp, s.rung) });
  return s;
}
// Drive through `n` windows where the input is recomputed from the CURRENT rung (recovery / re-probe cases).
// Records every rung transition so we can assert the escalate/de-escalate ORDER (and the no-flap property).
function runDyn(state, inpFor, n) {
  let s = state;
  const path = [s.rung];
  for (let i = 0; i < n; i++) {
    const inp = inpFor(s.rung);
    s = ladderStep(s, { ...inp, decimation: decimFor(inp, s.rung) });
    if (s.rung !== path[path.length - 1]) path.push(s.rung);
  }
  return { state: s, path };
}

test('(vi) rungDecimation: the EFFECTIVE present target halves ONLY at rung 3 (L1 engaged there alone)', () => {
  assert.equal(rungDecimation(RUNG_NONE), 1, 'rung 0 → full rate');
  assert.equal(rungDecimation(RUNG_L2), 1, 'rung 1 (L2) → no display decimation');
  assert.equal(rungDecimation(RUNG_L2_L3), 1, 'rung 2 (L2+L3) → no display decimation');
  assert.equal(rungDecimation(RUNG_L2_L3_L1), 2, 'rung 3 (L2+L3+L1) → display halved');
});

test('(iv) a CAPABLE stream (≥0.95× realtime, present ≥85% of target) NEVER degrades — stays rung 0', () => {
  const s = run(RUNG0, capable, 60);
  assert.equal(s.rung, RUNG_NONE, '60 capable windows → still rung 0 (no false degrade)');
  assert.equal(s.climbMs, 0, 'no climb streak accrues on a capable stream');
});

test('present just AT 85% of target with a realtime clock does NOT degrade (conservative boundary)', () => {
  // present = exactly 0.85×50 = 42.5 → not < 42.5; and clock realtime + ring full → cantKeepUp false anyway.
  const atThresh = { ...capable, presentFps: 50 * 0.85 };
  assert.equal(run(RUNG0, atThresh, climbWins + 8).rung, RUNG_NONE, 'at the boundary the stream is not under-delivering');
});

test('(i) contentFps 50 + decode-bound with a LOW demux ring → climbs all the way to rung 3 (L2+L3+L1)', () => {
  // Climbs 0→1→2→3, one rung per ~2.5s settle window, on the present-side detector ALONE (no demux pressure).
  const s = run(RUNG0, decodeBound50, climbWins * 3 + 8);
  assert.equal(s.rung, RUNG_L2_L3_L1, 'a genuinely decode-bound 50fps stream reaches the top rung (all three levers)');
});

test('(i) the climb is GRADUATED — one rung per settle window, never a jump', () => {
  // After exactly climbWins windows we are at rung 1 (not 2/3); the ladder must not fan multiple rungs at once.
  assert.equal(run(RUNG0, decodeBound50, climbWins).rung, RUNG_L2, 'one settle window → exactly rung 1 (L2)');
  assert.equal(run(RUNG0, decodeBound50, climbWins).rung <= RUNG_L2, true, 'never skips a rung');
  assert.equal(run(RUNG0, decodeBound50, climbWins * 2).rung, RUNG_L2_L3, 'two settle windows → exactly rung 2 (L2+L3)');
  assert.equal(run({ rung: RUNG_L2_L3_L1, climbMs: 0, dropMs: 0 }, decodeBound50, climbWins * 2).rung, RUNG_L2_L3_L1,
    'already at the top → stays (cannot climb past rung 3)');
});

test('(ii) contentFps 25 + decode-bound → climbs to rung 2 (L2+L3) and STOPS — never engages L1', () => {
  // 4K25: the only present-cap is 25→12.5 (nonsense). The rung2→3 gate (contentFps ≥ 48) must cap it at L2+L3.
  const db25 = { ...decodeBound50, contentFps: 25, presentFps: 15, clockRateRatio: 0.6 };
  const s = run(RUNG0, db25, climbWins * 4 + 20); // run well past where a 50fps stream would have hit rung 3
  assert.equal(s.rung, RUNG_L2_L3, '4K25 tops out at rung 2 (L2+L3) — the decode axis only');
  assert.notEqual(s.rung, RUNG_L2_L3_L1, 'L1 (the nonsense 12.5 halving) is NEVER engaged below 48 fps');
});

test('(iii) a present-stall (ring PINNED FULL, no-drop back-pressure) → rung 0, never degrades', () => {
  // A sustained PRESENT stall (GC/compositor/main-block) parks decode on the full ring → demux climbs + present
  // fps drops on a CAPABLE stream. presentRingFull marks the climb present-caused → the detector must ignore it.
  const stalled = {
    ...decodeBound50, presentRingFull: true, ringLow: false, ringHealthy: false, demuxPressure: true,
  };
  const s = run(RUNG0, stalled, climbWins * 3 + 12);
  assert.equal(s.rung, RUNG_NONE, 'a pinned-full present ring is present-caused → never a decode-deficit climb');
  assert.equal(s.climbMs, 0, 'the guard zeroes the climb streak every window (no creeping climb)');
});

test('guards: paused / cadence-inactive / no-content-period never climb even with a low present fps', () => {
  for (const variant of [
    { ...decodeBound50, paused: true },
    { ...decodeBound50, cadenceActive: false },
    { ...decodeBound50, haveContentPeriod: false },
  ]) {
    assert.equal(run(RUNG0, variant, climbWins * 3 + 8).rung, RUNG_NONE,
      `variant ${JSON.stringify(Object.keys(variant).filter((k) => variant[k] === true || variant[k] === false))} must not climb`);
  }
});

test('demux pressure is a WEAK HINT only: a drained-ring window with a healthy clock + full ring never climbs', () => {
  // No clock deficit, ring not draining, no demux pressure → cantKeepUp false even though present dipped → no climb.
  const dip = { ...capable, presentFps: 30, clockRateRatio: 1.0, ringLow: false, ringHealthy: true, demuxPressure: false };
  assert.equal(run(RUNG0, dip, climbWins * 3 + 8).rung, RUNG_NONE, 'a present dip with no can\'t-keep-up evidence is not decode-bound');
});

test('demux pressure ALONE can carry "can\'t keep up" when the clock window is invalid (0)', () => {
  // clockRateRatio 0 (a re-anchored/seam window = no valid clock) → the demux-ring hint + a draining ring still
  // let a genuine decode deficit climb (the hint strengthens cantKeepUp; it is never a *required* gate).
  const noClock = { ...decodeBound50, clockRateRatio: 0, demuxPressure: true };
  assert.equal(run(RUNG0, noClock, climbWins + 2).rung, RUNG_L2, 'a draining ring + demux pressure climbs without a clock reading');
});

test('(vii) a stream right at contentFps ≈ 48 does not oscillate across the rung-2↔3 gate', () => {
  // 48 is the L1-eligibility boundary. contentFps < 48 caps at rung 2; ≥ 48 may reach rung 3. Since contentFps
  // is a STABLE stream property (the median packet period), the gate decision is deterministic — no flapping.
  const db47 = { ...decodeBound50, contentFps: 47, presentFps: 30, clockRateRatio: 0.7 };
  const db48 = { ...decodeBound50, contentFps: 48, presentFps: 30, clockRateRatio: 0.7 };
  assert.ok(47 < LADDER_L1_MIN_FPS && 48 >= LADDER_L1_MIN_FPS, 'the gate is at 48 fps');
  assert.equal(run(RUNG0, db47, climbWins * 4 + 20).rung, RUNG_L2_L3, '47 fps caps at rung 2 (just under the gate)');
  // 48 fps: climb, then HOLD — at rung 3 the still-decode-bound input is neither under (present 30 vs target
  // 24×0.85=20.4) nor headroom (clock 0.7<1.0) → it settles at 3 with NO bounce back to 2.
  const { state, path } = runDyn(RUNG0, () => db48, climbWins * 4 + 40);
  assert.equal(state.rung, RUNG_L2_L3_L1, '48 fps reaches rung 3 (at the gate, halving is allowed)');
  for (let i = 1; i < path.length; i++) assert.ok(path[i] > path[i - 1], `monotonic climb, no flap (path ${path})`);
});

test('(v) RECOVERY de-escalates rung 3 → 0 in strict L1→L3→L2 order, slowly, without flapping', () => {
  // The stream recovered (now capable). The present reads content/decimation: at rung 3 (L1 caps display) it
  // reads 25 = the halved target → headroom; dropping L1 (3→2) doubles the target to 50, which the recovered
  // decoder now meets → headroom continues → 2→1 (drop L3) → 1→0 (drop L2). Each drop needs LADDER_DROP_MS of
  // sustained headroom (asymmetric/slow), so it cannot flap.
  const recovered = (rung) => ({
    ...capable, presentFps: 50 / rungDecimation(rung), contentFps: 50, clockRateRatio: 1.0,
    ringLow: false, ringHealthy: true, presentRingFull: false, demuxPressure: false,
  });
  const start = { rung: RUNG_L2_L3_L1, climbMs: 0, dropMs: 0 };
  const { state, path } = runDyn(start, recovered, dropWins * 3 + 12);
  assert.equal(state.rung, RUNG_NONE, 'a fully recovered stream de-escalates all the way to rung 0');
  assert.deepEqual(path, [RUNG_L2_L3_L1, RUNG_L2_L3, RUNG_L2, RUNG_NONE],
    'strict reverse order L1→L3→L2 (3→2→1→0), one rung at a time, no skipped/re-climbed rung');
});

test('(v) de-escalation is SLOW (asymmetric hysteresis): a single non-headroom window resets the drop streak', () => {
  // Sit at rung 3 with headroom for almost dropWins, inject ONE ambiguous window → the drop streak resets and
  // it must re-accumulate a FULL dropWins before dropping (so transient capable blips can't drop a needed lever).
  const headroom3 = { ...capable, presentFps: 25, contentFps: 50, clockRateRatio: 1.0 }; // rung-3 healthy (target 25)
  const ambiguous = { ...headroom3, clockRateRatio: 0.97 };                              // not headroom (clock < 1.0), not under
  let s = run({ rung: RUNG_L2_L3_L1, climbMs: 0, dropMs: 0 }, headroom3, dropWins - 1);
  assert.equal(s.rung, RUNG_L2_L3_L1, 'not yet dropped (one window short)');
  assert.ok(s.dropMs > 0, 'drop streak accumulating');
  s = ladderStep(s, ambiguous);
  assert.equal(s.dropMs, 0, 'the ambiguous window zeroed the drop streak');
  s = run(s, headroom3, dropWins - 1);
  assert.equal(s.rung, RUNG_L2_L3_L1, 'still at rung 3 — it must re-sustain a FULL drop window');
});

test('MANUAL Lever-1 (present-half) does NOT confound the ladder: a CAPABLE stream stays rung 0', () => {
  // Review Finding 1: when manual present-half caps the display, present reads ~25 on 50fps content. The ladder
  // MUST measure against the manual-aware target (contentFps ÷ active decimation = 25), so present 25 ≈ target
  // is NOT under — even with a can't-keep-up hint. Else manual L1 would falsely climb to L2+L3 decode skips.
  const manualHalfCapable = {
    cadenceActive: true, paused: false, haveContentPeriod: true,
    presentFps: 25, contentFps: 50, decimation: 2, // manual present-half forces decimation 2
    clockRateRatio: 1.0, ringLow: true, ringHealthy: false, presentRingFull: false, demuxPressure: true, dWallMs: WIN,
  };
  const s = run(RUNG0, manualHalfCapable, climbWins * 3 + 12);
  assert.equal(s.rung, RUNG_NONE, 'manual L1 halving the display must NOT trip the auto decode-skip ladder');
});

test('(v) de-escalation tolerates cap rounding: a recovered rung-3 stream measuring 24 (cap 25) still drops L1', () => {
  // Review Finding 2: the Bresenham cap-2 cadence + window rounding can settle the displayed rate at 24 fps
  // (one frame under the 25 cap) on a fully recovered stream. The over-frac (0.90) must accept 24/25 = 0.96 as
  // headroom, else the highest/most-visible rung would pin forever. (media/wall ≥1.0 + ring healthy = recovered.)
  const recovered24 = { ...capable, presentFps: 24, contentFps: 50, decimation: 2, clockRateRatio: 1.0, ringHealthy: true };
  const s = run({ rung: RUNG_L2_L3_L1, climbMs: 0, dropMs: 0 }, recovered24, dropWins + 4);
  assert.equal(s.rung, RUNG_L2_L3, 'a recovered stream at 24-on-25 de-escalates L1 (rounding tolerance)');
});

test('a genuinely decode-bound stream PINS at its rung (no re-probe): media/wall < 1.0 → never headroom', () => {
  // At rung 3 the real-4K10@50 sits decode-bound: present ~24 (≈ target 25) but media/wall stays < 1.0. That
  // fails the headroom clock gate, so it never starts a de-escalation → no rung-2↔3 oscillation at the ceiling.
  const ceiling3 = { ...capable, presentFps: 24, contentFps: 50, clockRateRatio: 0.9, ringLow: false, ringHealthy: true };
  const s = run({ rung: RUNG_L2_L3_L1, climbMs: 0, dropMs: 0 }, ceiling3, dropWins * 2);
  assert.equal(s.rung, RUNG_L2_L3_L1, 'a still-decode-bound top rung holds — no premature L1 drop / re-probe');
  assert.equal(s.dropMs, 0, 'no drop streak accrues while media/wall stays sub-realtime');
});

console.log(`\ndegrade-cadence: ${passed} passed`);
