// Unit test for the PURE PlaybackController reducer. DOM-free, browser-free — this is the whole
// point of the pure reducer (spec §1): the state machine is unit-testable without a browser, and ports
// straight to Rust. Exercises the transitions AND the load-racing-destroy invariant (a stale
// `opened` after a destroy must NOT resurrect a torn-down pipeline).
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/controller.mjs   (or any node ≥22)

import assert from 'node:assert/strict';
import { reduce, initialState, PlaybackController } from '../src/controller/playback.ts';

let passed = 0;
const cmds = (r) => r.commands.map((c) => c.type);
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// Helper: thread a sequence of events through reduce(), returning the final state + the LAST result.
function drive(events, s = initialState()) {
  let last = { state: s, commands: [] };
  for (const e of events) last = reduce(last.state, e);
  return last;
}

console.log('PlaybackController reducer:');

test('initial state is idle/live', () => {
  const s = initialState();
  assert.equal(s.name, 'idle');
  assert.equal(s.mode, 'live');
});

test('idle --load--> opening emits openSource + presentReset + feedGate(open)', () => {
  const r = reduce(initialState(), { type: 'load', mode: 'live', url: '/faux-live' });
  assert.equal(r.state.name, 'opening');
  assert.equal(r.state.url, '/faux-live');
  assert.deepEqual(cmds(r), ['openSource', 'presentReset', 'feedGate']);
  assert.equal(r.commands[0].url, '/faux-live');
  assert.equal(r.commands[2].open, true);
});

test('full happy path idle→opening→buffering→playing', () => {
  const r = drive([
    { type: 'load', mode: 'live', url: 'u' },
    { type: 'opened' },
    { type: 'lowWater' },
  ]);
  assert.equal(r.state.name, 'playing');
  assert.deepEqual(cmds(r), ['feedGate', 'emit']); // lowWater → feedGate(open) + emit('playing')
});

test('opened → buffering emits startDecode', () => {
  const r = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }]);
  assert.equal(r.state.name, 'buffering');
  assert.deepEqual(cmds(r), ['startDecode']);
});

test('playing ⇄ paused (pause closes the gate, live resume re-anchors)', () => {
  let s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const pause = reduce(s, { type: 'userPause' });
  assert.equal(pause.state.name, 'paused');
  assert.deepEqual(cmds(pause), ['feedGate']);
  assert.equal(pause.commands[0].open, false);
  const play = reduce(pause.state, { type: 'userPlay' });
  assert.equal(play.state.name, 'playing');
  assert.deepEqual(cmds(play), ['presentReset', 'feedGate']); // live resume seeks the edge first
});

test('vod resume continues in place (no presentReset)', () => {
  let s = drive([{ type: 'load', mode: 'vod', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const play = reduce(reduce(s, { type: 'userPause' }).state, { type: 'userPlay' });
  assert.deepEqual(cmds(play), ['feedGate']); // VOD: just re-open the gate
});

test('bytesIn folds into observability without a transition', () => {
  let s = reduce(initialState(), { type: 'load', mode: 'live', url: 'u' }).state;
  const r = reduce(s, { type: 'bytesIn', n: 4096 });
  assert.equal(r.state.name, 'opening');
  assert.equal(r.state.bytesIn, 4096);
  assert.equal(r.commands.length, 0);
});

test('fatal error from buffering → closing emits the RAII teardown sequence', () => {
  let s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }]).state;
  const r = reduce(s, { type: 'error', fatal: true });
  assert.equal(r.state.name, 'closing');
  // The ordered teardown set: feedGate(close) → pipeline → present → audio → emit('destroying').
  assert.deepEqual(cmds(r), ['feedGate', 'teardown', 'teardown', 'teardown', 'emit']);
  assert.equal(r.commands[0].open, false);
  assert.deepEqual(r.commands.filter((c) => c.type === 'teardown').map((c) => c.phase), ['pipeline', 'present', 'audio']);
})

test('teardown order is identical from EVERY non-terminal state (TOTAL)', () => {
  // idle, opening, buffering, playing, paused → the SAME ordered teardown on userDestroy.
  const states = [
    initialState(),
    drive([{ type: 'load', mode: 'live', url: 'u' }]).state,                                            // opening
    drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }]).state,                        // buffering
    drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state,  // playing
    drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }, { type: 'userPause' }]).state, // paused
  ];
  for (const s of states) {
    const r = reduce(s, { type: 'userDestroy' });
    assert.equal(r.state.name, 'closing', `destroy from ${s.name}`);
    assert.deepEqual(r.commands.filter((c) => c.type === 'teardown').map((c) => c.phase), ['pipeline', 'present', 'audio'], `teardown order from ${s.name}`);
  }
})

test('double-destroy is idempotent (second userDestroy in closing is inert)', () => {
  let r = reduce(initialState(), { type: 'load', mode: 'live', url: 'u' });
  r = reduce(r.state, { type: 'userDestroy' });
  assert.equal(r.state.name, 'closing');
  const again = reduce(r.state, { type: 'userDestroy' });
  assert.equal(again.state.name, 'closing');
  assert.equal(again.commands.length, 0, 'a second destroy emits NO new teardown commands');
})

test('fatal error arriving WHILE closing is inert (T7)', () => {
  let r = reduce(initialState(), { type: 'load', mode: 'live', url: 'u' });
  r = reduce(r.state, { type: 'opened' });
  r = reduce(r.state, { type: 'userDestroy' }); // → closing
  const fatal = reduce(r.state, { type: 'error', fatal: true });
  assert.equal(fatal.state.name, 'closing', 'a fatal error in closing must not restart teardown');
  assert.equal(fatal.commands.length, 0);
  const done = reduce(fatal.state, { type: 'drained' });
  assert.equal(done.state.name, 'closed');
});

test('non-fatal error is inert in the base reducer (the error controller refines)', () => {
  let s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const r = reduce(s, { type: 'error', fatal: false });
  assert.equal(r.state.name, 'playing');
  assert.equal(r.commands.length, 0);
});

test('destroy from playing → closing → closed (drained reaps engine)', () => {
  let s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const close = reduce(s, { type: 'userDestroy' });
  assert.equal(close.state.name, 'closing');
  const done = reduce(close.state, { type: 'drained' });
  assert.equal(done.state.name, 'closed');
  assert.deepEqual(cmds(done), ['teardown']);
  assert.equal(done.commands[0].phase, 'engine');
});

// THE invariant: a load racing a destroy. Destroy lands while Opening; a stale `opened`/`lowWater` then
// arrives (the in-flight source finally connected) — it must be IGNORED, never resurrecting the pipeline.
test('LOAD RACING DESTROY: stale opened/lowWater after destroy cannot resurrect', () => {
  let r = reduce(initialState(), { type: 'load', mode: 'live', url: 'u' }); // → opening
  r = reduce(r.state, { type: 'userDestroy' });                            // → closing
  assert.equal(r.state.name, 'closing');
  // The racing source's late events land AFTER the destroy:
  r = reduce(r.state, { type: 'opened' });
  assert.equal(r.state.name, 'closing', 'stale opened must not move back to buffering');
  assert.equal(r.commands.length, 0);
  r = reduce(r.state, { type: 'lowWater' });
  assert.equal(r.state.name, 'closing', 'stale lowWater must not start playing');
  assert.equal(r.commands.length, 0);
  // Only `drained` advances.
  r = reduce(r.state, { type: 'drained' });
  assert.equal(r.state.name, 'closed');
});

test('closed is terminal — every event is inert', () => {
  let s = drive([
    { type: 'load', mode: 'live', url: 'u' }, { type: 'userDestroy' }, { type: 'drained' },
  ]).state;
  assert.equal(s.name, 'closed');
  for (const e of [{ type: 'load', mode: 'live', url: 'x' }, { type: 'opened' }, { type: 'userPlay' }]) {
    const r = reduce(s, e);
    assert.equal(r.state.name, 'closed');
    assert.equal(r.commands.length, 0);
  }
});

test('reducer is PURE — the input state is never mutated', () => {
  const s = initialState();
  const frozen = Object.freeze({ ...s });
  reduce(s, { type: 'load', mode: 'live', url: 'u' }); // would throw if it mutated a frozen input
  assert.deepEqual(s, frozen);
});

test('PlaybackController driver runs commands through an executor in order', () => {
  const seen = [];
  const ctrl = new PlaybackController((cmd, state) => seen.push(cmd.type + '@' + state.name));
  ctrl.dispatch({ type: 'load', mode: 'live', url: 'u' });
  ctrl.dispatch({ type: 'opened' });
  ctrl.dispatch({ type: 'lowWater' });
  assert.equal(ctrl.name, 'playing');
  assert.deepEqual(seen, [
    'openSource@opening', 'presentReset@opening', 'feedGate@opening',
    'startDecode@buffering',
    'feedGate@playing', 'emit@playing',
  ]);
});

// the WIRING (not just the reducer): the PlaybackController DRIVER must RUN the RAII teardown
// commands through its executor on a FATAL error, exactly as the facade's handleFatal() relies on. The
// reducer-level "fatal → teardown sequence" is covered above; this proves the driver actually dispatches
// them to the executor (the failure mode FIX1 fixes: the trigger existed but nothing drove it).
test('DRIVER: a fatal error runs the RAII teardown through the executor (FIX1 wiring)', () => {
  const seen = [];
  const ctrl = new PlaybackController((cmd) => seen.push(cmd.type === 'teardown' ? `teardown:${cmd.phase}` : cmd.type));
  ctrl.dispatch({ type: 'load', mode: 'live', url: 'u' });
  ctrl.dispatch({ type: 'opened' });
  seen.length = 0; // ignore the load/opened commands — assert only the teardown that the fatal triggers
  ctrl.dispatch({ type: 'error', fatal: true }); // → closing: the ordered teardown set runs through the executor
  ctrl.dispatch({ type: 'drained' });            // → closed:  teardown(engine)
  assert.equal(ctrl.name, 'closed');
  assert.deepEqual(seen, ['feedGate', 'teardown:pipeline', 'teardown:present', 'teardown:audio', 'emit', 'teardown:engine']);
});

test('DRIVER: a NON-fatal error runs NOTHING through the executor (recover() keeps the resources)', () => {
  const seen = [];
  const ctrl = new PlaybackController((cmd) => seen.push(cmd.type));
  ctrl.dispatch({ type: 'load', mode: 'live', url: 'u' });
  ctrl.dispatch({ type: 'opened' });
  ctrl.dispatch({ type: 'lowWater' });
  assert.equal(ctrl.name, 'playing');
  seen.length = 0;
  ctrl.dispatch({ type: 'error', fatal: false });
  assert.equal(ctrl.name, 'playing', 'a non-fatal error must NOT change state');
  assert.equal(seen.length, 0, 'a non-fatal error must emit NO teardown commands');
});

// ============================================================================================
// the live-only Reconnecting state + recovery transitions (spec §1).
// ============================================================================================
console.log('\nReconnecting(Live) transitions:');

test('playing --reconnect(live)--> reconnecting emits the reconnect command', () => {
  const s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const r = reduce(s, { type: 'reconnect' });
  assert.equal(r.state.name, 'reconnecting');
  assert.deepEqual(cmds(r), ['reconnect']);
});

test('buffering --reconnect(live)--> reconnecting (a drop during pre-roll)', () => {
  const s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }]).state;
  const r = reduce(s, { type: 'reconnect' });
  assert.equal(r.state.name, 'reconnecting');
});

test('FULL recovery loop: playing → reconnecting → buffering → playing', () => {
  const s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const recon = reduce(s, { type: 'reconnect' });
  assert.equal(recon.state.name, 'reconnecting');
  const buf = reduce(recon.state, { type: 'recovered' });
  assert.equal(buf.state.name, 'buffering');
  assert.deepEqual(cmds(buf), ['feedGate']); // re-open the gate; next frame re-anchors
  assert.equal(buf.commands[0].open, true);
  const play = reduce(buf.state, { type: 'lowWater' });
  assert.equal(play.state.name, 'playing');
});

test('VOD NEVER enters Reconnecting (reconnect is inert in vod)', () => {
  const s = drive([{ type: 'load', mode: 'vod', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const r = reduce(s, { type: 'reconnect' });
  assert.equal(r.state.name, 'playing', 'a reconnect on a VOD stream must not move to reconnecting');
  assert.equal(r.commands.length, 0);
});

test('recreateDecoder keeps playing in place (no teardown, no state change)', () => {
  const s = drive([{ type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }]).state;
  const r = reduce(s, { type: 'recreateDecoder' });
  assert.equal(r.state.name, 'playing');
  assert.deepEqual(cmds(r), ['recreateDecoder']);
});

test('TEARDOWN FROM RECONNECTING is TOTAL (userDestroy → closing, RAII order)', () => {
  const s = drive([
    { type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }, { type: 'reconnect' },
  ]).state;
  assert.equal(s.name, 'reconnecting');
  const r = reduce(s, { type: 'userDestroy' });
  assert.equal(r.state.name, 'closing');
  assert.deepEqual(r.commands.filter((c) => c.type === 'teardown').map((c) => c.phase), ['pipeline', 'present', 'audio']);
  assert.equal(reduce(r.state, { type: 'drained' }).state.name, 'closed');
});

test('BACKOFF EXHAUSTED: a FATAL error from reconnecting → closing → teardown', () => {
  const s = drive([
    { type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }, { type: 'reconnect' },
  ]).state;
  assert.equal(s.name, 'reconnecting');
  const r = reduce(s, { type: 'error', fatal: true }); // worker emitted early-eof (reconnect budget spent)
  assert.equal(r.state.name, 'closing', 'backoff-exhausted fatal from reconnecting must tear down');
  assert.deepEqual(cmds(r), ['feedGate', 'teardown', 'teardown', 'teardown', 'emit']);
});

test('a user pause during reconnecting → paused', () => {
  const s = drive([
    { type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }, { type: 'reconnect' },
  ]).state;
  const r = reduce(s, { type: 'userPause' });
  assert.equal(r.state.name, 'paused');
  assert.equal(r.commands[0].open, false);
});

test('a redundant reconnect while reconnecting is inert (no new commands)', () => {
  const s = drive([
    { type: 'load', mode: 'live', url: 'u' }, { type: 'opened' }, { type: 'lowWater' }, { type: 'reconnect' },
  ]).state;
  const r = reduce(s, { type: 'reconnect' });
  assert.equal(r.state.name, 'reconnecting');
  assert.equal(r.commands.length, 0);
});

console.log(`\n✓ all ${passed} controller tests passed`);
