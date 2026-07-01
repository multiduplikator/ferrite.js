// The PlaybackController — a PURE reducer for the live/VOD playback lifecycle (skeleton).
//
// "(state, event) → (state', commands[]). No I/O inside. This is what makes
// it portable and unit-testable without a browser." Teardown is a STATE (Closing → Closed), never a
// `closing` boolean checked in five places — so a load racing a destroy is a TOTAL, testable transition.
//
// DOM-free / side-effect-free by construction: this module imports nothing and touches no global. The
// imperative glue (fetch, workers, AudioContext) lives OUTSIDE behind the SourcePort / facade; the
// controller only emits the COMMANDS that glue should run — keeping the lifecycle policy in one pure,
// portable, testable place.
//
// SCOPE: the live-push lifecycle Idle→Opening→Buffering→Playing⇄Paused→Closing→Closed, plus
// the live-only Reconnecting: Playing/Buffering --recoverable drop--> Reconnecting --recovered-->
// Buffering --> Playing, with backoff-exhaustion → fatal → teardown. The VOD-only Seeking
// and Ended(VOD) arrive later — events for them are simply ignored here (the reducer stays TOTAL: every
// (state,event) has a defined result, unmatched ones are inert).

export type PlaybackMode = 'live' | 'vod';

/** The lifecycle states. `closing`/`closed` model teardown-as-state; `reconnecting` is the
 *  live-only recovery state — VOD never enters it (it seeks/EOFs instead). */
export type PlaybackStateName =
  | 'idle'         // nothing loaded
  | 'opening'      // source opening (fetch connecting / demux not yet open)
  | 'buffering'    // source opened, decoding, pre-roll filling toward low-water
  | 'playing'      // presenting at the live edge
  | 'paused'       // user-paused (live: gate closed; VOD: position held)
  | 'reconnecting' // LIVE: a recoverable drop (network / upstream-silence) → the source is re-opening with backoff
  | 'eof'          // end-of-stream reached (source/decoder drained) — `paused()` reads stopped + the host has
                   // been told (LOADING_COMPLETE), but NOT torn down: a fresh `load` restarts, `userDestroy`
                   // tears down (the global rules below). The combined audio+video EOF gate hangs here.
  | 'closing'      // teardown in progress (pipeline freeing) — TERMINAL-bound
  | 'closed';      // teardown complete (terminal)

/** Inputs the controller reduces ("events in"). Late/again events are inert by design. */
export type PlaybackEvent =
  | { type: 'load'; mode: PlaybackMode; url: string } // user/host: start a stream
  | { type: 'opened' }                                 // source: demux opened / first bytes connected
  | { type: 'lowWater' }                               // decode: pre-roll reached the play watermark
  | { type: 'bytesIn'; n: number }                     // ingest: progress (tracked; no transition)
  | { type: 'clockTick' }                              // ~1 Hz aggregator tick (no transition)
  | { type: 'userPlay' }                               // user: resume
  | { type: 'userPause' }                              // user: pause
  | { type: 'userDestroy' }                            // user/host: tear everything down
  | { type: 'error'; fatal: boolean }                  // classified error: fatal → teardown (incl. backoff-exhausted)
  // ---- recovery events (the error controller's recoverable actions, fed in from the worker) ----
  | { type: 'reconnect' }                              // LIVE recoverable drop → enter Reconnecting (the worker is re-opening with backoff)
  | { type: 'recovered' }                              // bytes flowing again after a reconnect → leave Reconnecting (Buffering → Playing)
  | { type: 'recreateDecoder' }                        // transient decode glitch → rebuild the decoder, keep playing (no state change)
  | { type: 'eof' }                                    // source/decoder reached end-of-stream (the glue raises it from the demux/decode `ended`)
  | { type: 'drained' };                               // teardown finished (Closing → Closed)

/**
 * The RAII teardown targets, emitted IN ORDER on Closing. Each names exactly
 * ONE owner that releases on its command — the order IS the proven free→reap→terminate sequence, encoded
 * in the reducer (not scattered booleans across the imperative glue):
 *
 *   'pipeline' — DECODE-worker realm. Triggers the worker's destroy handshake, which internally runs the
 *                proven order: abort the in-flight source connection SYNCHRONOUSLY (while alive) → free
 *                demux + decoders (joins the frame-threads) → release ALL held decoder frames → reap the
 *                pthread pool → terminate. Atomic from main's view (one owner: the decode worker).
 *   'present'  — PRESENT-worker realm. Close ALL VideoFrames + dispose GL, then terminate (one owner).
 *   'audio'    — MAIN realm. Close the AudioContext (the master clock) + stop the clock publisher.
 *   'engine'   — MAIN realm, emitted on Closed (`drained`). Finalize the baseline: the engine memory died
 *                with the terminated decode worker; this zeroes main's mirrored counters to baseline.
 *
 * Cross-realm steps run concurrently (each realm preserves its own internal order); the canonical
 * RAII order is the EMIT order here.
 */
export type TeardownTarget = 'pipeline' | 'present' | 'audio' | 'engine';

/** Outputs the controller asks the glue to perform ("commands out"). NEVER executed here. */
export type PlaybackCommand =
  | { type: 'openSource' }                                  // LiveSourcePort.open / VOD AVIO (mode/url read off the controller state)
  | { type: 'feedGate'; open: boolean }                     // backpressure: read (open) / stop reading (close)
  | { type: 'startDecode' }                                 // begin demux+decode+present
  | { type: 'presentReset' }                                // flush present ring + re-anchor the clock
  | { type: 'reconnect' }                                   // a recoverable drop is recovering (the worker owns the backoff/fetch)
  | { type: 'recreateDecoder' }                             // rebuild the decoder in place (transient glitch self-heal)
  | { type: 'teardown'; phase: TeardownTarget }             // RAII teardown step (Closing emits the ordered set)
  | { type: 'emit'; event: string };                        // a facade event for the host (mpegts vocab)

export interface PlaybackState {
  name: PlaybackStateName;
  mode: PlaybackMode;
  url: string;
  /** Cumulative bytes ingested (folded from `bytesIn`) — observability only, no transition effect. */
  bytesIn: number;
}

export interface ReduceResult {
  state: PlaybackState;
  commands: PlaybackCommand[];
}

export function initialState(): PlaybackState {
  return { name: 'idle', mode: 'live', url: '', bytesIn: 0 };
}

// --- command constructors (keep the reducer body readable; tree-shake to nothing) -----------------
const openSource = (): PlaybackCommand => ({ type: 'openSource' });
const feedGate = (open: boolean): PlaybackCommand => ({ type: 'feedGate', open });
const startDecode = (): PlaybackCommand => ({ type: 'startDecode' });
const presentReset = (): PlaybackCommand => ({ type: 'presentReset' });
const reconnectCmd = (): PlaybackCommand => ({ type: 'reconnect' });
const recreateDecoder = (): PlaybackCommand => ({ type: 'recreateDecoder' });
const teardown = (phase: TeardownTarget): PlaybackCommand => ({ type: 'teardown', phase });
const emit = (event: string): PlaybackCommand => ({ type: 'emit', event });

/** The RAII teardown sequence emitted on EVERY entry to Closing. The ORDER lives HERE so a
 *  destroy from ANY state runs the SAME total teardown — abort source → free decoders (join) → release
 *  held → reap pool → terminate (all inside 'pipeline') → close VideoFrames ('present') → close audio. */
const TEARDOWN_SEQUENCE: PlaybackCommand[] = [
  feedGate(false),       // stop the ingest backpressure gate first (no new bytes enter the pipeline)
  teardown('pipeline'),  // decode-worker realm: abort source → free decoders → release held → reap pool → terminate
  teardown('present'),   // present-worker realm: close ALL VideoFrames + dispose GL → terminate
  teardown('audio'),     // main realm: close the AudioContext (master clock) + stop the clock publisher
  emit('destroying'),    // facade event (mpegts vocab) — host-visible
];

/**
 * The pure reducer: `(state, event) → (state', commands[])`. TOTAL — every (state, event) pair has a
 * defined result; events that don't apply to the current state return the state UNCHANGED with no
 * commands (so a stale `opened` after a destroy can never resurrect a torn-down pipeline — the
 * load-racing-destroy invariant, encoded as a transition rather than a flag).
 */
export function reduce(s: PlaybackState, e: PlaybackEvent): ReduceResult {
  const same: ReduceResult = { state: s, commands: [] };

  // Terminal: a closed controller is inert (a fresh instance starts a new session).
  if (s.name === 'closed') return same;

  // Observability fold: bytesIn accrues in every live state without changing the state name.
  if (e.type === 'bytesIn') {
    return { state: { ...s, bytesIn: s.bytesIn + e.n }, commands: [] };
  }
  if (e.type === 'clockTick') return same;

  // Destroy / fatal error from ANY non-terminal, non-closing state → Closing (teardown-as-state). This
  // single rule is why "a load racing a destroy" is total: whatever state the load reached, destroy
  // transitions it to Closing and every subsequent stale event (opened/lowWater) is ignored below.
  if (s.name !== 'closing' && (e.type === 'userDestroy' || (e.type === 'error' && e.fatal))) {
    return {
      state: { ...s, name: 'closing' },
      commands: [...TEARDOWN_SEQUENCE],
    };
  }

  // A fresh Load (re)starts the lifecycle from ANY non-teardown state — first start, channel zap, OR a re-load
  // after Eof. Handling Load only from Idle would pin the controller at Playing/Eof while the imperative path
  // reloaded, so the two could disagree. Closing/Closed ignore it (teardown completes first — the
  // load-racing-destroy invariant).
  if (e.type === 'load' && s.name !== 'closing') {
    return {
      state: { ...s, name: 'opening', mode: e.mode, url: e.url, bytesIn: 0 },
      commands: [openSource(), presentReset(), feedGate(true)],
    };
  }

  // End-of-stream from any ACTIVE state → Eof (the source/decoder drained). The FIRST Eof transitions + emits
  // the host 'ended' effect; a second Eof (the other of decode/demux ended) finds the state already Eof and is
  // inert (Eof falls into the default below), so the host is told exactly once. Re-Load / userDestroy (above)
  // leave it.
  if (e.type === 'eof' && (s.name === 'opening' || s.name === 'buffering' || s.name === 'playing' || s.name === 'paused' || s.name === 'reconnecting')) {
    return { state: { ...s, name: 'eof' }, commands: [emit('ended')] };
  }

  switch (s.name) {
    case 'idle':
      return same; // load is handled by the global rule above

    case 'opening':
      // Source connected / demux opened → start decoding and fill the pre-roll.
      if (e.type === 'opened') {
        return { state: { ...s, name: 'buffering' }, commands: [startDecode()] };
      }
      return same;

    case 'buffering':
      // Pre-roll reached the play watermark → present.
      if (e.type === 'lowWater') {
        return { state: { ...s, name: 'playing' }, commands: [feedGate(true), emit('playing')] };
      }
      // A recoverable live drop DURING pre-roll → Reconnecting (the source never fully started).
      if (e.type === 'reconnect' && s.mode === 'live') {
        return { state: { ...s, name: 'reconnecting' }, commands: [reconnectCmd()] };
      }
      if (e.type === 'recreateDecoder') return { state: s, commands: [recreateDecoder()] };
      return same;

    case 'playing':
      if (e.type === 'userPause') {
        // Live: stop reading (the glue keeps the socket + tracks the edge); VOD: hold position.
        return { state: { ...s, name: 'paused' }, commands: [feedGate(false)] };
      }
      // A recoverable live drop (network / upstream-silence) → Reconnecting. The worker owns the
      // actual backoff + re-fetch (+ awaitKeyframe); the controller just reflects the state. VOD never
      // reconnects (the reducer leaves it Playing — the guard makes that explicit + testable).
      if (e.type === 'reconnect' && s.mode === 'live') {
        return { state: { ...s, name: 'reconnecting' }, commands: [reconnectCmd()] };
      }
      // A transient decode glitch self-heals in place (rebuild + await keyframe) — NO state change,
      // NO teardown, NO reconnect storm. The decoder keeps draining once the fresh one syncs on an IDR.
      if (e.type === 'recreateDecoder') return { state: s, commands: [recreateDecoder()] };
      return same;

    case 'paused':
      if (e.type === 'userPlay') {
        // Resume just re-opens the feed gate. The live-resume re-anchor (flush the stale ring + reset the
        // present clock) is done IMPERATIVELY by play() at its tuned position (after ensureAudio, before
        // ctx.resume) — the reducer must NOT also emit it here (that would double-run it, out of order).
        return { state: { ...s, name: 'playing' }, commands: [feedGate(true)] };
      }
      return same;

    case 'reconnecting':
      // LIVE recovery. Bytes flowing again → re-buffer the pre-roll, then the next lowWater
      // (the facade re-arms its first-frame latch on entering Reconnecting) advances Buffering → Playing.
      if (e.type === 'recovered') {
        return { state: { ...s, name: 'buffering' }, commands: [feedGate(true)] };
      }
      // A user pause during a reconnect: hold (the worker stops re-reading on resume's awaitKeyframe).
      if (e.type === 'userPause') {
        return { state: { ...s, name: 'paused' }, commands: [feedGate(false)] };
      }
      // A redundant `reconnect` (another backoff attempt) is inert — already Reconnecting. The
      // backoff-EXHAUSTED case arrives as a FATAL `error` → the global rule above drives Closing → the
      // teardown (teardown-from-Reconnecting is TOTAL, like every other state).
      return same;

    case 'eof':
      // Inert: a re-load (global rule) restarts the lifecycle, userDestroy (global rule) tears down; every
      // other event — incl. a second `eof` from the other of decode/demux — is a no-op.
      return same;

    case 'closing':
      // Only `drained` advances; every other event (incl. a stale opened/lowWater from the load that
      // raced this destroy) is ignored — the teardown cannot be undone.
      if (e.type === 'drained') {
        return { state: { ...s, name: 'closed' }, commands: [teardown('engine')] };
      }
      return same;
  }

  return same;
}

/** A tiny stateful driver around the pure reducer — convenience for the glue (NOT used by the reducer
 *  itself). Holds the current state, applies events, and hands the emitted commands to an executor. */
export class PlaybackController {
  private _state: PlaybackState = initialState();
  private readonly exec?: (cmd: PlaybackCommand, state: PlaybackState) => void;
  constructor(exec?: (cmd: PlaybackCommand, state: PlaybackState) => void) { this.exec = exec; }

  get state(): PlaybackState { return this._state; }
  get name(): PlaybackStateName { return this._state.name; }

  /** Reduce one event, advance the state, and run each emitted command through the executor (if any).
   *  Returns the commands so a caller can also inspect/execute them itself. */
  dispatch(e: PlaybackEvent): PlaybackCommand[] {
    const { state, commands } = reduce(this._state, e);
    this._state = state;
    if (this.exec) for (const c of commands) this.exec(c, state);
    return commands;
  }
}
