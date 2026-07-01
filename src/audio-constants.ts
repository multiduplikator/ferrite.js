// Audio producer constants — the TypeScript twin of the values in the reference player
// `player/src/worker/audio_decode.rs`. These tune the PCM-ring producer's loudness fold (the AGC level
// measurement that moved off MAIN into the decode worker, where the PCM lives) and the mpv-style
// cache-pause rebuffer monitor. Kept in ONE module so the producer (worker.ts) and any future twin can
// share the exact numbers (no hand-typed drift between realms).

import { UNDERRUN_RESUME_SECS } from './audio-ring';

// ---- loudness measurement (RMS-dBFS proxy over a long EWMA) — ported from facade.rs / audio_decode.rs ----
/** EWMA time-constant (s) for the integrated mean-square loudness — a long tail so the makeup-gain target
 *  tracks programme loudness, not transients. */
export const LOUDNESS_TAU_SECS = 12.0;
/** Mean-square floor below which a chunk is treated as silence (hold the last loudness, don't drag it to 0). */
export const LOUDNESS_SILENCE_GATE_MS = 1e-7;
/** Windowed-peak relaxation time-constant (s): a single transient pins the peak cap ~2 s, then it eases —
 *  so the peak-aware makeup-gain cap (mpv ReplayGain `gain = min(gain, 1/peak)`) can recover. */
export const PEAK_DECAY_TAU_SECS = 2.0;

// ---- mpv cache-pause (playloop.c handle_update_cache) — ported from audio_decode.rs ----
// When the audio output genuinely STARVES (the PCM ring is critically low AND there is nothing left to
// decode) freeze the clock + rebuffer instead of free-running/skipping at the live edge (the small live
// buffer has almost no cushion for a network blip). Enter on real starvation, exit once the buffer is
// rebuilt past the resume cushion.
/** PCM ring depth (s) below which (+ no packets to decode) we are genuinely out of data → ENTER buffering. */
export const CACHE_PAUSE_ENTER_SECS = 0.06;
/** PCM ring depth (s) the worker must rebuild to (the cushion) before we EXIT buffering and resume. Resume at
 *  the SAME high-water as the worklet underrun-HOLD (they MUST agree — both reference UNDERRUN_RESUME_SECS so
 *  the cache-pause resume and the HOLD resume can never drift apart). */
export const CACHE_PAUSE_RESUME_SECS = UNDERRUN_RESUME_SECS;

/** mpv cache-pause monitor cadence (ms) — 20 Hz, so detection is prompt (the small buffer drains fast). */
export const REBUFFER_TICK_MS = 50;
