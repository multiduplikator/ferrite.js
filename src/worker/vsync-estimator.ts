// Vsync estimator — measure the REAL display refresh from rAF inter-callback intervals (mpv vo.c:411-442
// / vo.c:476-531, web-adapted). PURE arithmetic + a tiny stateful ring, factored out of the present
// worker so it is unit-testable headless (no rAF / `self`); the accumulator + gate are
// platform-independent floats.
//
// WHY: the Bresenham display cadence (present-worker.ts) needs the TRUE vsync interval as its denominator
// — reported display FPS is often wrong (59.94, compositor, multi-monitor) and rAF is the only refresh
// signal a canvas-only player gets (rvfc/expectedDisplayTime is <video>-only). We accumulate successive
// rAF `dt`s, take a ROBUST interval (median — a missed vsync shows up as a 2×/3× dt outlier that the
// median ignores), estimate jitter, and only ADOPT the measured interval once it is stable (mpv's gate:
// enough samples, sane 20–400 Hz range, recent samples tightly clustered, low jitter). Until then we
// return a NOMINAL fallback (60 Hz) so the cadence has a usable denominator from the first frame and
// only switches to the measured ~75 Hz once it is trustworthy.

/** Skip the first N rAF intervals — warmup (first paint, shader compile, layout) is not representative. */
export const SKIP_SAMPLES = 10;
/** rAF-interval ring capacity. ~256 ≈ 3.4 s at 75 Hz — enough for a robust median, cheap to scan. */
export const RING_CAP = 256;
/** Minimum samples in the ring before the measured interval may be ADOPTED (mpv uses 500; 120 ≈ 1.6 s
 *  at 75 Hz is enough here and adopts sooner). */
export const MIN_SAMPLES = 120;
/** Sane refresh band: interval must fall in [1/400 s, 1/20 s] = [2.5 ms, 50 ms] (20–400 Hz) to adopt. */
export const VSYNC_MIN_MS = 1000 / 400; // 2.5 ms  (400 Hz ceiling)
export const VSYNC_MAX_MS = 1000 / 20;  // 50 ms   (20 Hz floor)
/** A single dt outside [0, this] is a tab-background / long-stall gap, NOT a vsync — dropped entirely
 *  (never enters the ring) so it can't pollute even the median. (100 ms ⇒ below 10 Hz.) */
export const MAX_DT_MS = 100;
/** Adoption tolerance: this fraction of ring samples must sit within ±25 % of the median (a few missed
 *  vsyncs are tolerated; a bimodal 30/60-style beat is not). */
export const TOL = 0.25;
export const TOL_FRAC = 0.90;
/** Hysteresis floor: once adopted, DISENGAGE the latch (fall back to nominal) only if the cluster
 *  tightness collapses below this (a genuine refresh breakdown — e.g. a mid-playback monitor change),
 *  well below the 0.90 adoption threshold. Mere jitter keeps the median robust and the cadence engaged,
 *  so the cadence never thrashes between measured/nominal on a stable-but-noisy panel. */
export const LATCH_DROP_FRAC = 0.60;
/** Adoption jitter ceiling: normalized median-absolute-deviation must be ≤ this. MAD (not stddev) so a
 *  handful of missed-vsync outliers don't block adoption; 0.15 admits a real panel's ±1 ms rAF jitter
 *  (MAD ≈ 0.5 ms / 13.3 ms ≈ 0.04) while rejecting a genuinely unstable refresh. */
export const MAX_JITTER = 0.15;
/** Nominal fallback refresh — the LAST resort, used only at true cold start (< RECENT_N samples) or a
 *  genuinely bimodal stream (a window straddling two monitors). Once a tight recent cluster exists the
 *  estimator uses THAT real rate as the provisional interval instead (so a 100/144 Hz primary is never
 *  stuck reporting 60). 60 Hz (mpv seeds a nominal too). */
export const NOMINAL_HZ = 60;
export const NOMINAL_INTERVAL_MS = 1000 / NOMINAL_HZ;

// --- multi-monitor mixed-refresh handling (regime tracking) ---
/** Recent-window length for regime tracking. Short enough to re-acquire a display change (a window
 *  dragged 60→144 Hz) in a fraction of a second (~24 frames ≈ 0.17 s @ 144 Hz / 0.4 s @ 60 Hz), long
 *  enough that a single missed-vsync outlier doesn't move its median or break its tightness. */
export const RECENT_N = 24;
/** A tight recent-window median this far (fractional) from the currently-adopted interval is a genuine
 *  refresh REGIME change (a monitor switch), NOT jitter: every real refresh change (60↔100↔144) is ≥31 %,
 *  while the adoption MAD-jitter ceiling is 0.15. So this disengages the stale latch on a real display
 *  change without ever firing on a noisy-but-stable panel (the no-thrash invariant). */
export const REGIME_DELTA = 0.25;

/** Median of a numeric array (robust interval estimator — a missed vsync's 2×/3× dt doesn't move it).
 *  Returns 0 for empty. Does not mutate the input. */
export function median(xs: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = n >> 1;
  return (n & 1) ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Normalized median-absolute-deviation: median(|x − med|) / med. A robust, outlier-resistant jitter
 *  estimate (0 = perfectly even; ~0.04 = a good 75 Hz panel's ±1 ms rAF noise). Returns 0 for an empty
 *  set or a non-positive median. */
export function normalizedJitter(xs: number[], med: number): number {
  if (xs.length === 0 || med <= 0) return 0;
  const dev = xs.map((x) => Math.abs(x - med));
  return median(dev) / med;
}

/** Fraction of samples within ±tol of `center` (relative). 0 for empty. */
export function withinTolFraction(xs: number[], center: number, tol: number): number {
  const n = xs.length;
  if (n === 0 || center <= 0) return 0;
  const lo = center * (1 - tol), hi = center * (1 + tol);
  let k = 0;
  for (let i = 0; i < n; i++) if (xs[i] >= lo && xs[i] <= hi) k++;
  return k / n;
}

/** The most recent RECENT_N samples of the ring (or the whole ring if shorter) — the regime-tracking
 *  window that re-acquires a display refresh change fast (vs the slow full-ring flush). */
export function recentWindow(ring: number[]): number[] {
  const n = ring.length;
  return n > RECENT_N ? ring.slice(n - RECENT_N) : ring;
}

/** Fractional difference `|a − b| / b` (0 when `b ≤ 0`). */
export function relDiff(a: number, b: number): number {
  return b > 0 ? Math.abs(a - b) / b : 0;
}

/** The adoption gate (mpv vo.c:411-442, adapted) — PURE: does a robust median over `samples` qualify as
 *  the measured display refresh? Returns the decision + the diagnostics the telemetry surfaces. */
export interface VsyncGate {
  adopt: boolean;     // all conditions met → the measured interval is trustworthy
  intervalMs: number; // the robust median interval (ms) — meaningful only alongside `adopt`
  jitter: number;     // normalized MAD jitter
  tolFrac: number;    // fraction within ±25 % of the median
  count: number;      // samples considered
}
export function evaluateGate(samples: number[]): VsyncGate {
  const count = samples.length;
  const intervalMs = median(samples);
  const jitter = normalizedJitter(samples, intervalMs);
  const tolFrac = withinTolFraction(samples, intervalMs, TOL);
  const adopt =
    count >= MIN_SAMPLES &&
    intervalMs >= VSYNC_MIN_MS && intervalMs <= VSYNC_MAX_MS &&
    tolFrac >= TOL_FRAC &&
    jitter <= MAX_JITTER;
  return { adopt, intervalMs, jitter, tolFrac, count };
}

/** Stateful estimator the present worker feeds one rAF `dt` (ms) per tick. Holds a bounded ring of
 *  inter-callback intervals and exposes the current vsync interval (measured once adopted, else nominal),
 *  plus jitter + measured-Hz for telemetry. Cheap: one push + (on demand) one median scan. */
export class VsyncEstimator {
  private ring: number[] = [];
  private seen = 0;            // total dts offered (to skip the warmup window)
  private adopted = false;     // latched once the gate first passes (then we track the live median)

  /** Offer one rAF inter-callback interval (ms). Drops the warmup window, drops out-of-band gaps
   *  (pause/background) entirely, and ring-buffers the rest. NaN/≤0/huge → ignored. */
  push(dtMs: number): void {
    if (!(dtMs > 0) || dtMs > MAX_DT_MS) return; // ≤0, NaN, or a background/stall gap → not a vsync
    this.seen++;
    if (this.seen <= SKIP_SAMPLES) return;       // warmup: not representative
    this.ring.push(dtMs);
    if (this.ring.length > RING_CAP) this.ring.shift();
  }

  /** Re-arm for a fresh measurement (load / seek / live-resume). Keeps the LATCHED `adopted` state and
   *  the ring is rebuilt from the new rAF cadence — but we DON'T wipe `adopted`/ring here, because the
   *  display refresh does not change across a media seam; only the present clock does. (Provided so a
   *  caller MAY hard-reset if it ever needs to, e.g. a canvas re-attach to a different display.) */
  reset(): void {
    this.ring = [];
    this.seen = 0;
    this.adopted = false;
  }

  /** The current best vsync interval (ms): the robust measured median once adopted, else nominal. */
  get intervalMs(): number { return this.read().intervalMs; }

  /** Whether the measured interval is currently in use (vs the nominal fallback). */
  get isAdopted(): boolean { return this.read().adopted; }

  /** Measured refresh in Hz from the robust median (0 if no samples yet) — telemetry only. */
  get measuredHz(): number {
    const m = median(this.ring);
    return m > 0 ? 1000 / m : 0;
  }

  /** Normalized jitter of the current ring — telemetry only. */
  get jitter(): number {
    return normalizedJitter(this.ring, median(this.ring));
  }

  /** One-shot snapshot (THE single source of truth for adoption) — interval + adoption + measured Hz +
   *  jitter from ONE median scan; the present worker calls this once per tick. Latches `adopted` on the
   *  first gate pass and DISENGAGES it only on a genuine refresh breakdown (out of band, or tightness
   *  below LATCH_DROP_FRAC) — hysteresis, so a noisy-but-stable panel never thrashes the cadence mode. */
  read(): { intervalMs: number; adopted: boolean; hz: number; jitter: number } {
    const g = evaluateGate(this.ring);
    if (g.adopt) this.adopted = true; // latch on first full-gate pass
    // Recent-window regime tracking (the multi-monitor fix). A TIGHT recent cluster (the last RECENT_N
    // samples agree) at a rate FAR from the currently-adopted interval is a genuine display refresh change
    // (a window dragged to a different-Hz monitor) → force-drop the stale latch so we re-acquire the new
    // rate in ~RECENT_N frames instead of riding the old one until the slow full-ring tol collapse. A
    // genuinely BIMODAL stream (window straddling two monitors → alternating dt's) is NOT tight, so this
    // never fires for it (it falls through to the nominal floor — no thrash), and a noisy-but-stable
    // panel's recent median stays within REGIME_DELTA → never fires (the no-regression invariant).
    const recent = recentWindow(this.ring);
    const recentMed = median(recent);
    const recentTight =
      recent.length >= RECENT_N &&
      recentMed >= VSYNC_MIN_MS && recentMed <= VSYNC_MAX_MS &&
      withinTolFraction(recent, recentMed, TOL) >= TOL_FRAC;
    if (this.adopted && recentTight && relDiff(recentMed, g.intervalMs) > REGIME_DELTA) {
      this.adopted = false; // refresh regime changed → disengage; re-adopt at the new rate
    }
    const inBand = g.intervalMs >= VSYNC_MIN_MS && g.intervalMs <= VSYNC_MAX_MS;
    if (this.adopted && (!inBand || g.tolFrac < LATCH_DROP_FRAC)) this.adopted = false; // hysteresis drop
    const adopted = this.adopted && inBand;
    // Interval: the adopted full-ring median when latched; else a tight recent cluster's REAL rate
    // (pre-adoption on a 100/144 Hz panel, or just after a regime change — re-acquires fast); else the
    // nominal floor (true cold start / genuinely bimodal).
    const intervalMs = adopted ? g.intervalMs : recentTight ? recentMed : NOMINAL_INTERVAL_MS;
    return {
      intervalMs,
      adopted,
      hz: g.intervalMs > 0 ? 1000 / g.intervalMs : 0,
      jitter: g.jitter,
    };
  }
}
