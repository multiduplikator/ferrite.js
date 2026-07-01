// THE LEAK GATE — engine-side tier (headless node). The baseline tier of the live/VOD pipeline rebuild.
//
// PIPELINE_ARCHITECTURE.md §5: "an automated load→play→…→stop ×N in the SAME session that asserts the
// baseline snapshot (held=0, heap≈initial, frames=0, workers/connections=baseline) returns each cycle
// ±ε. If cycle 10 ≠ cycle 1 → leak, caught immediately. The 'no restart-to-clear' guarantee made into
// a test." This is the engine-side half (fast, repeatable, CI-able); the browser half is the demo's
// "Leak-test" button (real-GPU play→stop ×N → getStats() baseline assert).
//
// What it does: loads the engine ONCE (one long-lived realm — the whole point is in-session reuse, NOT
// restart-to-clear), then runs N cycles of  demux→decode-the-fixture→hold/release(bounded ring)→STOP
// (free decoder + demux + release every held frame). After each STOP it snapshots the baseline through
// the SAME StatsBus instrument the browser uses, and reports per-cycle drift vs cycle 1.
//
// The fixture is the KNOWN-CLEAN overlap-bench source (assets/fixture_lab_2160_10_50.ts) — the proven
// leak-free path (~0.62 GiB peak, returns to baseline). That IS the correct baseline; live/VOD
// sources arrive in later increments.
//
// Run:  ~/emsdk/node/*/bin/node --experimental-strip-types tests/leakgate.mjs
// Env:
//   FERRITE_ASSETS  dir with ferrite.{mjs,wasm}                 (default ../assets)
//   FERRITE_FIXTURE path to the .ts fixture                     (default ../assets/fixture_lab_2160_10_50.ts)
//   CYCLES          how many load→…→stop cycles in one session  (default 6)
//   RING            in-flight held-frame budget (backpressure)  (default 12, = facade RING_CAP)
//   THREADS         decode pthread pool                         (default 8)
//   DEBUG           '0' silences the instrument (proves zero-cost gate)  (default on)
//   BUILDLOG        path to append the ~1 Hz records to         (default ../buildlog.jsonl)

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadFerrite } from '../src/worker/ferrite-bindings.ts';
import { StatsBus, consoleSink } from '../src/instrument/bus.ts';
import { PlaybackController } from '../src/controller/playback.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.FERRITE_ASSETS
  ? path.resolve(process.cwd(), process.env.FERRITE_ASSETS)
  : path.join(HERE, '..', 'assets');
const FIXTURE = process.env.FERRITE_FIXTURE
  ? path.resolve(process.cwd(), process.env.FERRITE_FIXTURE)
  : path.join(HERE, '..', 'assets', 'fixture_lab_2160_10_50.ts');
const CYCLES = +(process.env.CYCLES || 6);
const RING = +(process.env.RING || 12);
const THREADS = +(process.env.THREADS || 8);
const DEBUG = process.env.DEBUG !== '0';
const BUILDLOG = process.env.BUILDLOG
  ? path.resolve(process.cwd(), process.env.BUILDLOG)
  : path.join(HERE, '..', 'buildlog.jsonl');

const MiB = 1024 * 1024;

if (!existsSync(FIXTURE)) {
  console.error(`fixture not found: ${FIXTURE}\nSet FERRITE_FIXTURE or place the known-clean clip there.`);
  process.exit(1);
}

// --- live instrument state (the provider reads this; the cycle loop writes it) -------------------
const live = {
  heapBytes: 0,
  heldFrames: 0,     // EXACT in node: current pending-token count
  demuxRingDepth: 0,
  credits: RING,
  producedTotal: 0,  // cumulative frames decoded (for the present/decode-fps delta)
  cycle: 0,
};
let lastProduced = 0;
let lastFpsT = performance.now();

// --- the StatsBus (the SAME instrument the browser leak gate uses) -------------------------------
// PRIMARY sink: append the folded record to buildlog.jsonl (the server-log file the assistant reads).
// In node there is no dev server to POST to, so we append directly — the record format is identical.
const fileSink = (rec) => { try { appendFileSync(BUILDLOG, JSON.stringify({ rx: new Date().toISOString(), ...rec }) + '\n'); } catch { /* ignore */ } };
const bus = new StatsBus({ debug: DEBUG, env: 'node', sinks: [fileSink, consoleSink] });
bus.addProvider(() => {
  const nowT = performance.now();
  const dt = (nowT - lastFpsT) / 1000;
  const fps = dt > 0 ? Math.round((live.producedTotal - lastProduced) / dt) : 0;
  lastProduced = live.producedTotal; lastFpsT = nowT;
  return {
    heapBytes: live.heapBytes,
    heldFrames: live.heldFrames,
    demuxRingDepth: live.demuxRingDepth,
    presentRingDepth: live.heldFrames, // node has no present worker; the held set IS the in-flight ring
    credits: live.credits,
    decodeFps: fps,
    presentFps: 0,        // STUBBED: no present tier in the headless engine gate
    audioDrift: 0,        // STUBBED
    playbackRate: 1,      // VOD/file decode: no live-sync nudge
    latencyToLive: 0,     // STUBBED (no live ingest)
    // stalls / reconnects are cumulative inc()-counters (0 on the clean path)
    openVideoFrames: 0,   // software tier: no WebCodecs frames
    // The engine's pthread pool (decode workers) for THIS engine-side gate — alive for the whole session.
    // NB (Stage 5): this gate drives ONE loadFerrite + a demux→decode loop directly in node; it does NOT spawn
    // the facade's Worker realms (now FOUR: demux/video/present/audio), so the Stage-5 split (the new DEMUX
    // realm + the video packet ring) does NOT change this baseline — `workers` here is the engine pthread pool
    // (= THREADS), not a count of facade Worker instances (getStats().workers === 4 in the browser). The new
    // realm's reap is covered by the browser Leak-test button (full-realm) + the facade's shutdownDemux
    // handshake (index.ts), not this headless gate. The gate exercises the SAME engine FFIs (demux/vdec) the
    // split workers use; the new ferrite_vdec_new_with_extradata FFI is NOT exercised here (the gate uses
    // vdecNew/vdecNewFromDemux directly), so the gate runs unchanged against the CURRENT assets/ferrite.wasm —
    // a rebuild is needed only for the browser facade's VOD video path to apply the relayed avcC/hvcC.
    workers: THREADS,
    audioContexts: 0,     // no audio playout in the engine gate
    connections: 0,       // STUBBED (file fixture, no live ingest)
  };
});

// --- load the engine ONCE (long-lived realm; in-session reuse is the whole point) ----------------
const baseUrl = pathToFileURL(path.join(ASSETS, '/')).href;
const F = await loadFerrite(baseUrl, THREADS + 2);
const fbuf = new Uint8Array(readFileSync(FIXTURE));
live.heapBytes = F.memory.buffer.byteLength;

console.log(`leakgate (engine-side): fixture=${path.basename(FIXTURE)} (${(fbuf.length / MiB).toFixed(1)} MiB)  cycles=${CYCLES}  ring=${RING}  threads=${THREADS}  debug=${DEBUG}`);
console.log(`initial heap = ${(live.heapBytes / MiB).toFixed(0)} MiB`);

bus.start(1000); // the ONE ~1 Hz aggregator

// --- one load→decode→stop cycle ------------------------------------------------------------------
// Async with a periodic event-loop yield: decode here is a tight SYNCHRONOUS CPU loop, so without a
// yield node's setInterval aggregator would be starved and the ~1 Hz records would never land mid-cycle
// (only the per-cycle baseline would). Yielding ~every 64 demux steps lets the ONE aggregator fire; the
// decode pthread pool keeps working across the yield (separate threads), so throughput is unaffected.
const STARTUP = 256 * 1024, CHUNK = 64 * 1024;
const yieldToLoop = () => new Promise((r) => setImmediate(r));
async function decodeCycle() {
  const d = F.demuxNewStreaming();
  F.demuxSetMaxBuffered(d, 16 * MiB);
  let pos = 0;
  const feed = (a, b) => F.demuxFeed(d, fbuf.subarray(a, b));
  feed(0, Math.min(STARTUP, fbuf.length)); pos = Math.min(STARTUP, fbuf.length);

  let opened = false;
  for (let t = 0; t < 800 && !opened; t++) {
    if (F.demuxOpen(d) === 0) opened = true;
    else { feed(pos, Math.min(pos + CHUNK, fbuf.length)); pos = Math.min(pos + CHUNK, fbuf.length); }
  }
  if (!opened) { F.demuxFree(d); throw new Error('demux failed to open'); }

  let vcodec = F.demuxVcodec(d), v = 0, ed = false, produced = 0, maxHeld = 0;
  const held = []; // pending hold-tokens (the in-flight ring); released oldest-first at the cap
  const releaseOldest = () => { if (held.length) { F.vdecRelease(held.shift()); live.credits++; } };
  const onFrame = () => {
    const w = F.vdecW(v), cw = F.vdecCw(v);
    if (w <= 0 || cw <= 0) return;
    if (held.length >= RING) releaseOldest();            // backpressure: bound frames-in-flight
    const tok = F.vdecHold(v);
    if (!tok) return;                                    // held table full → drop (never blocks)
    held.push(tok); live.heldFrames = held.length; live.credits = RING - held.length;
    if (held.length > maxHeld) maxHeld = held.length;
    produced++; live.producedTotal++;
    // touch the held planes so the upload path (offset math) is exercised like the present worker would
    F.vdecHeldPlane(tok, 0); F.vdecHeldLinesize(tok, 0);
    if (F.memory.buffer.byteLength > live.heapBytes) live.heapBytes = F.memory.buffer.byteLength;
  };

  for (let g = 0; g < 1e7; g++) {
    if ((g & 63) === 0) await yieldToLoop(); // let the ~1 Hz aggregator fire (see note above)
    if (pos < fbuf.length) { feed(pos, Math.min(pos + CHUNK, fbuf.length)); pos = Math.min(pos + CHUNK, fbuf.length); }
    else F.demuxEof(d);
    live.demuxRingDepth = F.demuxBuffered(d);
    const s = F.demuxStep(d);
    if (s === 1) {
      if (F.demuxPktStream(d) === 0) {
        if (vcodec <= 0) vcodec = F.demuxVcodec(d);
        if (vcodec > 0 && !v) { const es = F.demuxVExtradataSize(d); v = es > 0 ? F.vdecNewFromDemux(d, THREADS) : F.vdecNew(vcodec, THREADS); ed = es > 0; }
        if (v && !ed && F.demuxVExtradataSize(d) > 0) { F.vdecFree(v); v = F.vdecNewFromDemux(d, THREADS); ed = true; }
        const isKey = F.demuxPktIsKey(d) === 1;
        if ((vcodec === 27 || vcodec === 173) && !ed && !isKey) continue;
        if (v) {
          F.vdecPush(v, F.demuxPktDataPtr(d), F.demuxPktSize(d), F.demuxPktPtsUs(d));
          while (F.vdecStep(v) === 1) onFrame();
        }
      }
    } else if (s === 2) {
      if (pos >= fbuf.length) { if (v) { F.vdecPush(v, 0, 0, 0n); while (F.vdecStep(v) === 1) onFrame(); } break; }
    } else break;
  }

  // ---- STOP: deterministic teardown (free decoder → free demux → release every held frame) ----
  if (v) F.vdecFree(v);
  F.demuxFree(d);
  for (const tok of held) F.vdecRelease(tok); // belt: release our tokens explicitly…
  F.vdecReleaseAll();                          // …and flush the engine's held table to empty
  held.length = 0;
  live.heldFrames = 0; live.credits = RING; live.demuxRingDepth = 0;
  live.heapBytes = F.memory.buffer.byteLength; // post-teardown heap (the baseline number)
  return { produced, maxHeld };
}

// --- TEARDOWN-RACE STRESS MATRIX (engine-side tier) -----------------------------------------
// The baseline gate proves a CLEAN cycle returns to baseline. This proves teardown is DETERMINISTIC and
// TOTAL under races: a destroy landing at ANY lifecycle point (before the first frame, mid-buffering,
// mid-playing), a double-destroy, and a fatal-error-while-closing must ALL free every engine resource
// (held table → 0, demux freed, heap flat). The teardown runs through the SAME pure PlaybackController
// (userDestroy→drained); its `teardown('pipeline')` command is the ONE owner that frees the engine
// pipeline — exactly as the facade's executor does in the browser. Mirrors spec §4 #3 (RAII teardown).
const HEAP_EPS = 1; // MiB; the wasm heap is grow-only, so post-warmup teardowns must not move it.
const STARTUP_S = 256 * 1024, CHUNK_S = 64 * 1024;

/** A minimal engine-stream owner: open the demux, decode up to N frames into a bounded in-flight ring,
 *  and tear it ALL down (free decoder+demux, release every held token, flush the engine held table). */
function makeStream() {
  let d = 0, v = 0, vcodec = 0, ed = false, pos = 0, opened = false;
  const held = [];
  return {
    get held() { return held; },
    open() {
      d = F.demuxNewStreaming();
      F.demuxSetMaxBuffered(d, 16 * MiB);
      pos = Math.min(STARTUP_S, fbuf.length);
      F.demuxFeed(d, fbuf.subarray(0, pos));
      for (let t = 0; t < 800 && !opened; t++) {
        if (F.demuxOpen(d) === 0) opened = true;
        else { const e = Math.min(pos + CHUNK_S, fbuf.length); F.demuxFeed(d, fbuf.subarray(pos, e)); pos = e; }
      }
      if (!opened) throw new Error('demux failed to open');
      vcodec = F.demuxVcodec(d);
    },
    decodeSome(maxFrames) {
      let produced = 0;
      for (let g = 0; g < 1e6 && produced < maxFrames; g++) {
        if (pos < fbuf.length) { const e = Math.min(pos + CHUNK_S, fbuf.length); F.demuxFeed(d, fbuf.subarray(pos, e)); pos = e; }
        else F.demuxEof(d);
        const s = F.demuxStep(d);
        if (s === 1) {
          if (F.demuxPktStream(d) === 0) {
            if (vcodec <= 0) vcodec = F.demuxVcodec(d);
            if (vcodec > 0 && !v) { const es = F.demuxVExtradataSize(d); v = es > 0 ? F.vdecNewFromDemux(d, THREADS) : F.vdecNew(vcodec, THREADS); ed = es > 0; }
            if (v && !ed && F.demuxVExtradataSize(d) > 0) { F.vdecFree(v); v = F.vdecNewFromDemux(d, THREADS); ed = true; }
            const isKey = F.demuxPktIsKey(d) === 1;
            if ((vcodec === 27 || vcodec === 173) && !ed && !isKey) continue;
            if (v) {
              F.vdecPush(v, F.demuxPktDataPtr(d), F.demuxPktSize(d), F.demuxPktPtsUs(d));
              while (F.vdecStep(v) === 1) {
                const w = F.vdecW(v), cw = F.vdecCw(v);
                if (w <= 0 || cw <= 0) continue;
                if (held.length >= RING) F.vdecRelease(held.shift()); // bound the in-flight ring
                const tok = F.vdecHold(v);
                if (!tok) continue;
                held.push(tok); produced++;
                F.vdecHeldPlane(tok, 0); F.vdecHeldLinesize(tok, 0);
              }
            }
          }
        } else if (s === 2) { if (pos >= fbuf.length) break; } else break;
      }
      return produced;
    },
    teardown() {                                  // the ONE owner: frees the whole engine pipeline (RAII)
      if (v) F.vdecFree(v); v = 0;                 // free decoder (joins frame-threads)
      if (d) F.demuxFree(d); d = 0;                // free demux
      for (const tok of held) F.vdecRelease(tok);  // release every held token…
      F.vdecReleaseAll();                          // …and flush the engine's held table to empty
      held.length = 0;
    },
  };
}

/** Run ONE stress case: drive the controller to `phase`, then destroy and assert return-to-baseline. */
function stressCase(name, phase, baselineHeap) {
  const stream = makeStream();
  let tornDown = 0;
  const exec = (cmd) => {
    if (cmd.type === 'openSource') stream.open();                          // opening: demux opened, no decoder
    else if (cmd.type === 'startDecode') {                                 // buffering/playing: fill the ring
      if (phase === 'buffering') stream.decodeSome(4);
      else if (phase === 'playing') stream.decodeSome(RING);               // saturate the in-flight ring
    } else if (cmd.type === 'teardown' && cmd.phase === 'pipeline') { stream.teardown(); tornDown++; }
  };
  const ctrl = new PlaybackController(exec);
  ctrl.dispatch({ type: 'load', mode: 'live', url: FIXTURE });             // → opening (open)
  if (phase !== 'opening') {
    ctrl.dispatch({ type: 'opened' });                                     // → buffering (decode)
    if (phase === 'playing') ctrl.dispatch({ type: 'lowWater' });          // → playing
  }
  const heldAtDestroy = stream.held.length;
  if (name.startsWith('T8')) {
    // a FATAL error WITHOUT a destroy() must drive teardown ALL ON ITS OWN — the reducer's
    // error{fatal} trigger that nothing dispatched before. No userDestroy here; the fatal event is
    // the sole driver of Closing→teardown('pipeline')→Closed. Proves the wiring frees the engine pipeline.
    ctrl.dispatch({ type: 'error', fatal: true });                         // → closing (teardown pipeline)
  } else {
    ctrl.dispatch({ type: 'userDestroy' });                                // → closing (teardown pipeline)
    if (name.startsWith('T4')) ctrl.dispatch({ type: 'userDestroy' });     // double-destroy: must be inert
    if (name.startsWith('T7')) ctrl.dispatch({ type: 'error', fatal: true }); // fatal-in-closing: must be inert
  }
  ctrl.dispatch({ type: 'drained' });                                      // → closed
  const heap = F.memory.buffer.byteLength;
  const dHeap = (heap - baselineHeap) / MiB;
  const ok = ctrl.name === 'closed' && stream.held.length === 0 && tornDown === 1 && Math.abs(dHeap) <= HEAP_EPS;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(22)} heldAtDestroy=${String(heldAtDestroy).padStart(2)} → held=${stream.held.length} teardowns=${tornDown} ctrl=${ctrl.name} Δheap=${dHeap.toFixed(1)}MiB`);
  return ok;
}

function runStressMatrix(baselineHeap) {
  console.log('\n=== TEARDOWN-RACE STRESS MATRIX (engine-side) ===');
  const cases = [
    ['T1 destroy@opening', 'opening'],
    ['T2 destroy@buffering', 'buffering'],
    ['T3 destroy@playing', 'playing'],
    ['T4 double-destroy', 'playing'],
    ['T7 fatal-in-closing', 'playing'],
    ['T8 fatal→teardown', 'playing'], // FIX1: fatal error WITHOUT destroy() must reap the pipeline on its own
  ];
  let allOk = true;
  for (const [name, phase] of cases) allOk = stressCase(name, phase, baselineHeap) && allOk;
  // After the whole matrix, the engine held table must be empty (no token leaked across cases).
  console.log(`\nstress matrix: ${allOk ? '✓ every case returned to baseline (held=0, heap flat, teardown ran once)' : '✗ DRIFT — see cases above'}`);
  console.log('(T5 rapid play/stop & T6 reconnect-racing-destroy are FULL-REALM races → the demo Leak-test button)');
  return allOk;
}

// --- the PURE PlaybackController drives each cycle's lifecycle ----------------------------
// The reducer is DOM-free, so the SAME controller the browser gate drives runs here in node. The
// executor maps its commands onto the engine-gate phases/actions: openSource/startDecode are
// breadcrumbs (the decode itself is decodeCycle), teardown('pipeline') is decodeCycle's STOP (already
// performed inside it), teardown('engine') is the end-of-session pool reap. We assert the controller
// reaches `closed` every cycle — load→play→stop expressed as TOTAL transitions, not ad-hoc flags.
const ctrlExec = (cmd) => {
  if (cmd.type === 'openSource') bus.setPhase('load');
  else if (cmd.type === 'startDecode') bus.setPhase('decode');
  else if (cmd.type === 'teardown' && cmd.phase === 'pipeline') bus.setPhase('stop');
  // feedGate/presentReset/emit/teardown(engine) are no-ops for the engine-side gate (no live ingest here).
};

// --- run the gate --------------------------------------------------------------------------------
const baselines = [];
for (let c = 1; c <= CYCLES; c++) {
  live.cycle = c; bus.setCycle(c);
  const ctrl = new PlaybackController(ctrlExec);
  ctrl.dispatch({ type: 'load', mode: 'live', url: FIXTURE }); // → opening (openSource)
  ctrl.dispatch({ type: 'opened' });                          // → buffering (startDecode)
  ctrl.dispatch({ type: 'lowWater' });                        // → playing
  const t0 = performance.now();
  const { produced, maxHeld } = await decodeCycle();          // the actual demux→decode→hold→STOP
  const ms = performance.now() - t0;
  ctrl.dispatch({ type: 'userDestroy' });                     // → closing (teardown pipeline)
  ctrl.dispatch({ type: 'drained' });                         // → closed
  if (ctrl.name !== 'closed') { console.error(`cycle ${c}: controller did not reach closed (got ${ctrl.name})`); process.exit(1); }

  // Baseline snapshot at the cycle boundary (post-STOP). Push it through the SAME sinks (gated: when the
  // instrument is silenced the sinks stay silent — only the harness's own summary below prints).
  bus.setPhase('baseline');
  const snap = bus.snapshot();
  if (bus.enabled) { fileSink(snap); consoleSink(snap); }
  baselines.push(snap);
  console.log(`cycle ${c}/${CYCLES}: produced=${produced} maxHeld=${maxHeld} decFps=${Math.round(produced / ms * 1000)} | BASELINE held=${snap.heldFrames} heap=${(snap.heapBytes / MiB).toFixed(0)}MiB demuxRing=${snap.demuxRingDepth} openVF=${snap.openVideoFrames}`);
}

bus.stop();

// --- drift report (cycle N vs cycle 1) -----------------------------------------------------------
const b1 = baselines[0];
let leak = false;
console.log('\n=== LEAK-GATE BASELINE DRIFT (vs cycle 1) ===');
console.log('cycle |   heap MiB |  Δheap MiB | held | demuxRing');
for (let i = 0; i < baselines.length; i++) {
  const b = baselines[i];
  const dHeap = (b.heapBytes - b1.heapBytes) / MiB;
  if (b.heldFrames !== 0 || b.demuxRingDepth !== 0 || Math.abs(dHeap) > 1) leak = true;
  console.log(`  ${String(i + 1).padStart(2)}  | ${(b.heapBytes / MiB).toFixed(0).padStart(9)} | ${dHeap.toFixed(1).padStart(9)} | ${String(b.heldFrames).padStart(4)} | ${String(b.demuxRingDepth).padStart(9)}`);
}
const heapSpread = (Math.max(...baselines.map((b) => b.heapBytes)) - Math.min(...baselines.map((b) => b.heapBytes))) / MiB;
console.log(`\nheap spread across cycles = ${heapSpread.toFixed(1)} MiB`);
console.log(`held=0 every cycle:        ${baselines.every((b) => b.heldFrames === 0) ? 'YES' : 'NO'}`);
console.log(`demux-ring=0 every cycle:  ${baselines.every((b) => b.demuxRingDepth === 0) ? 'YES' : 'NO'}`);
console.log(`\nRESULT: ${leak ? '⚠ DRIFT DETECTED — see per-cycle table above (instrument working; investigate)' : '✓ returns to baseline every cycle (no in-session leak on the known-clean path)'}`);

// Run the teardown-race stress matrix against the SAME long-lived realm (heap now at its grow-only
// working size = the baseline every torn-down case must hold flat).
const stressOk = runStressMatrix(F.memory.buffer.byteLength);

console.log(`buildlog: ${BUILDLOG}`);

// Reap the pthread pool so node exits cleanly.
F.shutdownThreads();
process.exit((leak || !stressOk) ? 1 : 0);
