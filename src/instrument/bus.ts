// ferrite.js — the stats bus.
//
// THE INSTRUMENT-FIRST CONTRACT: ONE gated stats bus, multiple sinks.
// Subsystems increment cheap plain-integer counters; a SINGLE aggregator folds them into ONE record
// ~1×/sec and pushes it to every sink. The same bus feeds every sink, so the numbers never diverge.
//
// Hard rules encoded here:
//   - NEVER per-frame logging. Counters are cheap integer ops in the hot path; the aggregator is the
//     ONLY thing that builds a record or touches a sink, and it runs ~1 Hz.
//   - ONE `debug` flag. debug=false ⇒ start() never arms the timer, inc()/addProvider() are no-ops,
//     no record is ever built and no sink is ever called ⇒ ZERO cost.
//   - DOM-free / Node-API-free. This module runs UNCHANGED in a browser realm and headless node, so the
//     leak gate is the same instrument in both tiers. Sinks that need fs/Worker live in the harnesses.
//
// It does NOT touch the decode/present hot loops (counters are plain integer increments; the aggregator is
// the only thing that builds a record). A counter with no live source on a given path is reported as 0.

/** The counters. Every value is a plain number; the aggregator snapshots them. */
export interface StatsCounters {
  /** Frames the decode worker holds a ref on (held-AVFrame table). EXACT in the node gate
   *  (hold/release balance is tracked there); in the browser it is proxied by the present-ring depth. */
  heldFrames: number;
  /** Live engine heap size in bytes (the growable shared WebAssembly.Memory). NODE-only: in the browser
   *  the engine lives in the decode worker and main cannot read its heap — reported 0 there. */
  heapBytes: number;
  /** Unread bytes in the demux ring (boundedness proof; WorkerStats.bufferedBytes). */
  demuxRingDepth: number;
  /** Present-ring depth — frames decoded+buffered but not yet shown (FerriteStats.presentQueue). */
  presentRingDepth: number;
  /** Software decode credits in flight (free present-ring slots; FerriteStats.credits). */
  credits: number;
  /** Decoded frames/sec (rate). */
  decodeFps: number;
  /** Presented frames/sec (rate) — derived from the framesPresented delta over the aggregation window. */
  presentFps: number;
  /** Present-cadence (SMOOTHNESS), from the present worker's draw path: mean inter-draw interval (ms). */
  presentIntervalMs: number;
  /** 95th-percentile inter-draw interval (ms) — tail jitter. */
  presentIntervalP95Ms: number;
  /** Worst inter-draw interval (ms) in the window. */
  presentIntervalMaxMs: number;
  /** Present stutters — steady-state intervals > 2× the content frame period (visible gaps). */
  presentStutters: number;
  /** Present seam gaps — reset/re-anchor freezes in the window (reconnect/seam; distinct from stutter). */
  presentSeamGaps: number;
  /** Clock/draw instrument: content-frames the audio-master media clock crossed/sec (50 healthy; <50 = clock ran slow = the real present pace). */
  clockAdvanceFps: number;
  /** Clock/draw instrument: media-clock advance ÷ wall elapsed (×realtime; 1.0 = locked). */
  clockRateRatio: number;
  /** Clock/draw instrument: PLL correction load (|audioTarget − mediaUs|, ms; ~0 = locked). */
  clockResidualMs: number;
  /** Clock/draw instrument: total rAF ticks/sec in the present worker (draw headroom vs distinct draws). */
  rafFps: number;
  /** Clock/draw instrument: ring frames evicted-without-display per sec (lost to the ring vs paced by the clock). */
  presentDropsPerSec: number;
  // --- DISPLAY-CADENCE instrument (the mpv-style Bresenham num_vsyncs fix for 50-on-75 judder) ----------
  // IMPLEMENTED here: (1) measure the real refresh from rAF (vsync-estimator.ts, jitter-gated); (2) the
  // Bresenham hold-count cadence in present-worker.ts. deferred (NOT built): the 2nd-order DLL replacing
  // the P-only PLL, bounded audio drift ±0.125 %, getOutputTimestamp()/AudioWorklet A_ACLOCK sampling.
  /** Cadence: the MEASURED display refresh interval (ms) the cadence runs against (≈13.3 @ 75 Hz; nominal until adopted). */
  vsyncIntervalMs: number;
  /** Cadence: measured refresh in Hz once adopted (0 = still on the nominal fallback / warmup). */
  displayHz: number;
  /** Cadence: mean hold count over recent frames (vsyncs/frame); 50-on-75 → ~1.5 = a clean alternating 1,2. */
  cadenceHoldMean: number;
  /** Cadence: fraction of recent holds that were 2 vsyncs (~0.5 for the 50-on-75 1,2 beat). */
  cadenceHold2Frac: number;
  /** Cadence: |sigma-delta accumulator| (ms) — bounded (≲ half a vsync) when healthy. */
  cadenceErrorMs: number;
  /** Cadence: VLC-style hard-resyncs/sec (cadence desynced > ~120 ms from audio); ≈0 on a clean clip. */
  syncResyncsPerSec: number;
  // --- GRACEFUL-DEGRADATION cadence tier (present-every-Nth-frame on a memory-bandwidth-bound client) -----
  /** Cadence tier: 1 = full rate (every frame), 2 = half (present every other frame, hold it 2× longer). */
  cadenceTier: number;
  /** Effective DRAW rate (fps) the tier targets = content rate ÷ tier (≈25 at tier 2 on 50fps content). */
  cadenceDrawRate: number;
  /** Why the tier degraded (0 = none; 1 = an auto ladder rung engaged; 2 = manual Lever-1 override). */
  cadenceDegradeReason: number;
  /** Graduated auto-degrade rung: 0 none · 1 skip-non-ref · 2 +skip-loop · 3 +present-cap (the active levers read off it). */
  cadenceRung: number;
  /** Audio health: in-flight scheduled audio segments (the audio FIFO depth; FerriteStats.audioQueue). */
  audioFifoDepth: number;
  /** Audio health: cumulative audio playout underruns (the clock is audio-locked → these stutter present). */
  audioUnderruns: number;
  /** Audio health: cumulative inserted silence (s) across underruns — the audible playout gap. */
  audioGapSecs: number;
  /** Audio drift (s) — STUBBED 0 (no numeric drift surfaced by the current pipeline). */
  audioDrift: number;
  /** Master-clock playback rate (1.0 = no live-sync nudge; FerriteStats.speed). */
  playbackRate: number;
  /** Latency-to-live (s) — STUBBED 0 (no live ingest yet). */
  latencyToLive: number;
  /** Audio underruns counted (cumulative; FerriteStats.liveSyncStalls). */
  stalls: number;
  /** Live reconnects (cumulative) — STUBBED 0 (no live ingest / reconnect path yet). */
  reconnects: number;
  /** Open (un-closed) WebCodecs VideoFrames. Genuinely 0 on the software fixture path (no WC frames). */
  openVideoFrames: number;
  /** Live Worker instances owned by the player (decode + present ⇒ 2 active, 0 after teardown). */
  workers: number;
  /** Live AudioContext instances (1 active, 0 after teardown). */
  audioContexts: number;
  /** Open upstream/Range connections — STUBBED 0 (file fixture; no live ingest). */
  connections: number;
}

/** Which realm/harness produced a record. 'realplayer' is the demo's live player run — its
 *  startup→stabilization curve + steady-state cadence, tagged distinctly from the node/browser gates. */
export type BusEnv = 'node' | 'browser' | 'realplayer';

/** A folded record: the counters at emit time + the bus metadata. This is one line of buildlog.jsonl. */
export interface StatsRecord extends StatsCounters {
  /** ISO timestamp, stamped by the sink-side at emit (kept out of the bus so it stays Date.now-free). */
  t: string;
  /** Which realm produced the record. */
  env: BusEnv;
  /** Monotonic record sequence within this bus session. */
  seq: number;
  /** Leak-gate cycle this record belongs to (0 = not inside a gate). */
  cycle: number;
  /** Coarse lifecycle phase: 'idle' | 'load' | 'decode' | 'stop' | 'baseline' | … (harness-set). */
  phase: string;
}

/** A sink consumes folded records. Sinks must be cheap + non-throwing (the bus isolates throws). */
export type Sink = (rec: StatsRecord) => void;

/** A provider contributes live counter values at snapshot time (e.g. read from player.getStats()).
 *  Returns a partial — only the keys it knows. Providers run ONLY inside the ~1 Hz aggregator. */
export type Provider = () => Partial<StatsCounters>;

function zeroCounters(): StatsCounters {
  return {
    heldFrames: 0, heapBytes: 0, demuxRingDepth: 0, presentRingDepth: 0, credits: 0,
    decodeFps: 0, presentFps: 0,
    presentIntervalMs: 0, presentIntervalP95Ms: 0, presentIntervalMaxMs: 0, presentStutters: 0, presentSeamGaps: 0,
    clockAdvanceFps: 0, clockRateRatio: 0, clockResidualMs: 0, rafFps: 0, presentDropsPerSec: 0,
    vsyncIntervalMs: 0, displayHz: 0, cadenceHoldMean: 0, cadenceHold2Frac: 0, cadenceErrorMs: 0, syncResyncsPerSec: 0,
    cadenceTier: 0, cadenceDrawRate: 0, cadenceDegradeReason: 0, cadenceRung: 0,
    audioFifoDepth: 0, audioUnderruns: 0, audioGapSecs: 0,
    audioDrift: 0, playbackRate: 0, latencyToLive: 0,
    stalls: 0, reconnects: 0, openVideoFrames: 0, workers: 0, audioContexts: 0, connections: 0,
  };
}

/** The canonical counter key list, for harness reports / schema checks. */
export const COUNTER_KEYS = Object.keys(zeroCounters()) as (keyof StatsCounters)[];

export interface StatsBusOptions {
  /** THE single gate. false ⇒ the bus is a zero-cost no-op (no timer, no records, no sinks). */
  debug?: boolean;
  env?: BusEnv;
  sinks?: Sink[];
  /** Stamps record.t. Defaults to a real clock; injectable so the bus stays deterministic for tests. */
  now?: () => string;
}

export class StatsBus {
  readonly enabled: boolean;
  readonly env: BusEnv;
  /** Harness-settable context folded into every record. */
  cycle = 0;
  phase = 'idle';

  private providers: Provider[] = [];
  private sinks: Sink[];
  private cumulative: StatsCounters = zeroCounters(); // bumped by inc() (stalls/reconnects/…)
  private timer: ReturnType<typeof setInterval> | 0 = 0;
  private seq = 0;
  private now: () => string;

  constructor(opts: StatsBusOptions = {}) {
    this.enabled = !!opts.debug;
    this.env = opts.env ?? (typeof document === 'undefined' ? 'node' : 'browser');
    this.sinks = opts.sinks ? opts.sinks.slice() : [];
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Bump a cumulative counter (stalls, reconnects, …) from a hot path. No-op when disabled. */
  inc(key: keyof StatsCounters, n = 1): void {
    if (!this.enabled) return;
    this.cumulative[key] += n;
  }

  /** Register a live-value provider (folded at snapshot time). No-op when disabled. */
  addProvider(fn: Provider): void {
    if (!this.enabled) return;
    this.providers.push(fn);
  }

  /** Register a sink. (Sinks may be added pre-start; harmless when disabled — start() never fires.) */
  addSink(fn: Sink): void {
    this.sinks.push(fn);
  }

  setPhase(p: string): void { this.phase = p; }
  setCycle(c: number): void { this.cycle = c; }

  /** Build the current folded record. Providers overlay the cumulative counters; metadata last.
   *  PUBLIC so a harness can grab a baseline snapshot synchronously at a cycle boundary. Returns a
   *  zeroed record when disabled (cheap; never reads providers). */
  snapshot(): StatsRecord {
    if (!this.enabled) {
      return { ...zeroCounters(), t: this.now(), env: this.env, seq: this.seq, cycle: this.cycle, phase: this.phase };
    }
    const c: StatsCounters = { ...this.cumulative };
    for (const p of this.providers) {
      try {
        Object.assign(c, p());
      } catch {
        /* a provider throw must never break the aggregator */
      }
    }
    return { ...c, t: this.now(), env: this.env, seq: this.seq, cycle: this.cycle, phase: this.phase };
  }

  /** Fold once and push to every sink. Increments the record sequence. No-op when disabled. */
  emit(): void {
    if (!this.enabled) return;
    const rec = this.snapshot();
    this.seq++;
    for (const s of this.sinks) {
      try {
        s(rec);
      } catch {
        /* a sink throw must never break the aggregator or perturb decode */
      }
    }
  }

  /** Arm the ONE ~1 Hz aggregator. No-op (and no timer) when disabled ⇒ zero cost. */
  start(intervalMs = 1000): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.emit(), intervalMs);
    // Don't keep a node process alive just for the instrument.
    (this.timer as { unref?: () => void })?.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }
}

// --- portable sinks (DOM-free / Node-API-free) -------------------------------------------------

/** Secondary sink: console.log the folded record (console = secondary, live eyeballing). */
export const consoleSink: Sink = (rec) => {
  console.log('[buildlog] ' + JSON.stringify(rec));
};

/** PRIMARY sink: POST the folded record to the server-log route (the `benchlog` pattern). Fire-and-
 *  forget; uses the global fetch (browser + node ≥18). A failed POST is swallowed (never perturbs decode). */
export function fetchSink(url = '/buildlog'): Sink {
  return (rec) => {
    try {
      void (globalThis as { fetch?: typeof fetch }).fetch?.(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
        keepalive: true,
      })?.catch(() => {});
    } catch {
      /* no fetch / offline — silent */
    }
  };
}
