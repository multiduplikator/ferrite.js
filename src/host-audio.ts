// Host-side AudioContext glue — REUSABLE across hosts (an app shell, the standalone demo). The player is a
// pure CONSUMER of an injected AudioContext (FerritePlayer.attachAudio); THIS module is the host that owns
// that context's lifetime: it creates ONE app-lifetime context (suspended), UNLOCKS it on the first user
// gesture, and RECOVERS it across iOS interruptions. The player never creates/resumes/closes it. TS twin of
// the reference player's host-audio module.
//
// IMPORTANT: this is OPTIONAL. The standalone player works WITHOUT it — without a host ctx the player owns a
// per-stream context itself (the own-ctx path in index.ts: created on play(), resumed on play(), recovered
// via its own statechange ladder, closed on teardown). Use this module only when a host wants ONE long-lived,
// gesture-unlocked, app-recovered context shared across multiple players/streams (e.g. a previews grid where a
// per-stream resume() would miss the activation window).
//
// Standards-grounded (Howler.js / Tone.js / MDN / W3C):
//   * resume() must ride a real user gesture — call it synchronously (the safe path on all platforms);
//     node construction / addModule are legal on a suspended context (only rendering needs the gesture).
//   * Unlock = resume() + a 1-sample silent-buffer prime; remove the listeners only once `running`.
//   * Recovery lives on the LONG-LIVED context owner (here), not per-stream — survives every stream.
//   * `interrupted` ≠ `suspended`: resume() during `interrupted` can reject → retry on a capped backoff.
//
// Usage: a host calls `initHostAudio()` ONCE at load (client only), then injects `hostAudioCtx()` into each
// player via `player.attachAudio(ctx)` BEFORE play().

// The capture-phase gesture events that can unlock the AudioContext (gesture END / activation, not
// `touchstart` which can be a scroll). `keydown` covers desktop.
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

// Recovery backoff (mirrors the facade's own-ctx ladder): capped so a persistent interruption doesn't spin
// the timer forever; `running` clears it. resume() during iOS `interrupted` may reject, so we retry.
const HOST_RECOVERY_MAX_ATTEMPTS = 8;
const HOST_RECOVERY_BACKOFF_MIN_MS = 250;
const HOST_RECOVERY_BACKOFF_MAX_MS = 5000;

// ---- module-singleton state (the app-lifetime ctx lives for the whole session) -----------------------
let ctx: AudioContext | null = null;            // HOST-OWNED, app-lifetime (created once, suspended)
let unlockHandler: (() => void) | null = null;  // the one-time first-gesture unlock listener
let resumeTimer: ReturnType<typeof setTimeout> | 0 = 0;
let recoveryAttempts = 0;
// Last observed host-ctx state — distinguishes a FRESH interruption episode (running→interrupted) from
// intra-episode flapping (interrupted↔suspended). The former re-opens the recovery ladder; the latter must
// NOT (else the backoff pegs at the floor). Critical because the host ctx is app-lifetime: without this, one
// cap-hitting interruption (a >~23 s phone call) would kill recovery for the whole session.
let lastState = '';

/** Raw AudioContext `state` string — the non-standard iOS `interrupted` state isn't in TS's union, so read
 *  it as a plain string (a typed read would lose it). */
function ctxStateStr(c: AudioContext): string {
  return (c as unknown as { state: string }).state ?? '';
}

/** Create the app-lifetime AudioContext (suspended) and arm a ONE-TIME first-gesture unlock + recovery.
 *  Idempotent; a host calls it once at load (client only). Because the user must interact to reach a stream,
 *  the context is typically already `running` before any player mounts → audio on the opening tap. */
export function initHostAudio(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof AudioContext === 'undefined') return null;
  try { ctx = new AudioContext({ latencyHint: 'interactive' }); }
  catch { try { ctx = new AudioContext(); } catch { return null; } }
  // iOS 17+: route audio to the "playback" category (audible past the silent switch; less OS suspension).
  // Non-standard → feature-detected reflection; a harmless no-op on every other browser.
  const session = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
  if (session) { try { session.type = 'playback'; } catch { /* ignore */ } }
  armGestureUnlock(ctx);
  registerHostRecovery(ctx);
  return ctx;
}

/** The host-owned context, if initHostAudio() ran. Inject it into a player via attachAudio() before play(). */
export function hostAudioCtx(): AudioContext | null {
  return ctx;
}

/** Register the app-lifetime statechange recovery on the host ctx. `running` clears the ladder; an
 *  `interrupted`/`suspended` kicks the backoff-paced resume. The host ctx is NEVER suspended by the player,
 *  so any non-running here is OS-driven → always safe to re-resume; no intentional-suspend flag needed. */
function registerHostRecovery(c: AudioContext): void {
  c.onstatechange = onHostStatechange;
}

function onHostStatechange(): void {
  if (!ctx) return;
  const st = ctxStateStr(ctx);
  const prev = lastState;
  lastState = st;
  if (st === 'running') {
    recoveryAttempts = 0; // recovered → fresh ladder for the next interruption
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; } // cancel any pending retry
  } else if (st === 'interrupted' || st === 'suspended') {
    // A FRESH interruption episode (entered from running/unset) re-opens the ladder — vital for the
    // app-lifetime host ctx, so a prior cap-hitting interruption can't permanently kill recovery. Intra-
    // episode flapping (interrupted↔suspended) does NOT reset (matches the facade's anti-flap).
    if (prev !== 'interrupted' && prev !== 'suspended') recoveryAttempts = 0;
    scheduleHostResume();
  }
}

/** Arm a one-shot backoff timer to retry resume() on the host ctx. No-op if one is pending or the cap is hit. */
function scheduleHostResume(): void {
  if (resumeTimer || recoveryAttempts >= HOST_RECOVERY_MAX_ATTEMPTS) return;
  const delay = Math.min(
    HOST_RECOVERY_BACKOFF_MIN_MS << Math.min(recoveryAttempts, 5),
    HOST_RECOVERY_BACKOFF_MAX_MS,
  );
  resumeTimer = setTimeout(tryHostResume, delay);
}

function tryHostResume(): void {
  resumeTimer = 0;
  if (!ctx) return;
  // Already recovered (the running statechange may not have been delivered before this timer fired) →
  // reset + bail without burning an attempt (mirrors the facade's tryResumeAudio guard).
  if (ctxStateStr(ctx) === 'running') { recoveryAttempts = 0; return; }
  recoveryAttempts++;
  ctx.resume().catch(() => {}); // async; success → statechange→running clears the ladder
  // resume() can reject during iOS `interrupted` (no state change fires) → re-arm the backoff so we keep
  // retrying (capped). The running-transition handler cancels the pending timer + resets attempts.
  if (ctxStateStr(ctx) !== 'running') scheduleHostResume();
}

/** Arm a one-time, capture-phase document listener on each UNLOCK_EVENTS type. On the first real gesture it
 *  resume()s the context SYNCHRONOUSLY (before any await — safe on all platforms) + primes with a 1-sample
 *  silent buffer (Howler pattern; resume() alone is unreliable on older iOS), and once the context is
 *  confirmed `running` it removes ALL the listeners + drops the closure. Idempotent resume/prime are harmless
 *  if it takes more than one gesture to reach `running`. */
function armGestureUnlock(c: AudioContext): void {
  if (typeof document === 'undefined') return;
  const handler = (): void => {
    c.resume().catch(() => {}); // synchronous call, inside the gesture
    // 1-sample silent prime → BufferSource → destination → start(0). The real unlock signal on iOS.
    try {
      const buf = c.createBuffer(1, 1, Math.max(8000, c.sampleRate));
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start();
    } catch { /* ignore */ }
    // Confirmed unlocked → remove all listeners + drop the closure (one-shot).
    if (c.state === 'running' && unlockHandler) {
      for (const ev of UNLOCK_EVENTS) document.removeEventListener(ev, unlockHandler, true);
      unlockHandler = null;
    }
  };
  unlockHandler = handler;
  for (const ev of UNLOCK_EVENTS) document.addEventListener(ev, handler, true); // capture phase
}
