// Optional, framework-free controls + long-press debug overlay for a ferrite player.
//
// ferrite.js owns a <canvas> (not a <video>), so — unlike mpegts.js, which rides the browser's native
// <video> controls — there is no built-in control surface. This module provides an auto-hiding control
// bar + a long-press debug overlay. It is OPT-IN: import it only if you want the built-in UI; the
// player works headless without it.
//
//   import { createPlayer } from 'ferrite.js';
//   import { attachControls } from 'ferrite.js/controls';
//   const player = createPlayer({ type: 'mpegts', isLive: true, url }, { wasmBaseUrl: '/assets/' });
//   player.attachCanvas(canvas);
//   const controls = attachControls(player, canvas);   // auto-hiding bar + long-press debug overlay
//   player.load(); player.play();
//   // ... later: controls.destroy();
//
// Zero dependencies, no DOM framework. Styles are injected once into <head>; everything is removed
// again on destroy().

import { Events } from '../types';
import type { FerritePlayer } from '../index';

const LONG_PRESS_MS = 600;   // long-press hold timer for the debug overlay
const IDLE_HIDE_MS = 3000;   // fade the controls after ~3 s idle (auto-hide)
const STYLE_ID = 'ferrite-controls-style';

export interface AttachControlsOptions {
  /** Reveal the bar on pointer activity + fade it after `idleHideMs`. Default true. */
  autoHide?: boolean;
  /** Idle timeout (ms) before the bar fades. Default 3000. */
  idleHideMs?: number;
  /** Long-press duration (ms) on the video surface to toggle the debug overlay. Default 600. */
  longPressMs?: number;
  /** Enable the long-press diagnostic overlay (off until long-pressed). Default true. */
  debugOverlay?: boolean;
  /** Persist the volume across sessions in localStorage. Default true. */
  persistVolume?: boolean;
  /** localStorage key for the persisted volume. Default 'ferrite.volume'. */
  volumeStorageKey?: string;
}

export interface ControlsHandle {
  /** Remove the controls + debug overlay, all listeners/timers, and (if we wrapped) restore the canvas. */
  destroy(): void;
}

// --- minimal inline SVG icons (no icon font / dependency) ---------------------------------------
const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${inner}</svg>`;
const ICON_PLAY = svg('<path d="M8 5v14l11-7z"/>');
const ICON_PAUSE = svg('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>');
const ICON_VOL = svg('<path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2"/>');
const ICON_MUTE = svg('<path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2"/>');
const ICON_FS = svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/>');
const ICON_FS_EXIT = svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2"/>');

const CSS = `
.ferrite-shell { position: relative; display: inline-block; line-height: 0; overflow: hidden; }
.ferrite-shell canvas { display: block; max-width: 100%; }
.ferrite-controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  display: flex; align-items: center; gap: 4px; padding: 8px 12px;
  color: #fff; font: 13px/1 system-ui, sans-serif;
  background: linear-gradient(to top, rgba(0,0,0,.7), rgba(0,0,0,0));
  opacity: 0; transform: translateY(8px); pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
}
.ferrite-controls.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
.ferrite-controls button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: #fff; cursor: pointer;
}
.ferrite-controls button:hover { background: rgba(255,255,255,.15); }
.ferrite-controls input[type=range] { width: 96px; accent-color: #fff; cursor: pointer; }
.ferrite-controls input.ferrite-seek { flex: 1 1 auto; width: auto; min-width: 60px; }
.ferrite-time { font: 11px/1 ui-monospace, monospace; font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; white-space: nowrap; }
.ferrite-spacer { flex: 1 1 auto; }
.ferrite-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; letter-spacing: .06em; color: #ff5252; }
.ferrite-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff5252; }
.ferrite-controls select.ferrite-deint {
  height: 28px; border: 0; border-radius: 4px; padding: 0 6px;
  background: rgba(255,255,255,.12); color: #fff; font: 12px/1 system-ui, sans-serif; cursor: pointer;
}
.ferrite-deint-warn { display: none; align-items: center; gap: 4px; font-size: 11px; color: #ffb300; white-space: nowrap; }
.ferrite-deint-warn.visible { display: inline-flex; }
.ferrite-debug {
  position: absolute; top: 10px; left: 10px; z-index: 3; min-width: 190px;
  padding: 8px 10px; border-radius: 6px; background: rgba(0,0,0,.78); color: #e0e0e0;
  font: 12px/1.5 ui-monospace, monospace; pointer-events: none; display: none;
}
.ferrite-debug.visible { display: block; }
.ferrite-debug-row { display: flex; justify-content: space-between; gap: 12px; }
.ferrite-debug-row span { opacity: .7; }
.ferrite-debug-row b { font-weight: 600; text-align: right; word-break: break-word; }
.ferrite-debug-row b.ok { color: #69f0ae; }
.ferrite-debug-row b.bad { color: #ff5252; }
`;

function injectStyleOnce(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attach the built-in controls bar + long-press debug overlay to a ferrite player.
 *
 * `target` may be the player's <canvas> (it is wrapped in a positioned shell) OR a container element
 * that already holds the canvas (used as the shell directly). Returns a handle whose `destroy()`
 * removes everything and is idempotent. Safe to call after `attachCanvas` (before or after `load`).
 */
export function attachControls(
  player: FerritePlayer,
  target: HTMLElement,
  opts: AttachControlsOptions = {},
): ControlsHandle {
  injectStyleOnce();
  const autoHide = opts.autoHide ?? true;
  const idleHideMs = opts.idleHideMs ?? IDLE_HIDE_MS;
  const longPressMs = opts.longPressMs ?? LONG_PRESS_MS;
  const debugEnabled = opts.debugOverlay ?? true;
  const persistVolume = opts.persistVolume ?? true;
  const volKey = opts.volumeStorageKey ?? 'ferrite.volume';

  // Resolve the shell (positioned container) + canvas. Wrap a bare canvas; otherwise use the
  // container as the shell and find the canvas inside it.
  let shell: HTMLElement;
  let canvas: HTMLElement;
  let wrapped = false;
  let origParent: HTMLElement | null = null;
  let origNext: Node | null = null;
  if (target instanceof HTMLCanvasElement) {
    canvas = target;
    origParent = target.parentElement;
    origNext = target.nextSibling;
    shell = document.createElement('div');
    shell.className = 'ferrite-shell';
    origParent?.insertBefore(shell, target);
    shell.appendChild(target);
    wrapped = true;
  } else {
    shell = target;
    if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative';
    canvas = (shell.querySelector('canvas') as HTMLElement | null) ?? shell;
  }

  // ---- controls bar -------------------------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'ferrite-controls';
  const btnPlay = document.createElement('button');
  btnPlay.title = 'Play / Pause';
  const btnMute = document.createElement('button');
  btnMute.title = 'Mute';
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = '0'; vol.max = '1'; vol.step = '0.01';
  // Software-tier deinterlace select (Off/Auto/Bwdif) — mirrors the reference player's overlay control.
  // Hidden on the WebCodecs/HW tier (which deinterlaces in hardware → no avfilter graph to drive). The
  // default reflects the decode worker's auto default; the "deint n/a" warning lights on DEINT_FAILED.
  const deint = document.createElement('select');
  deint.className = 'ferrite-deint';
  deint.title = 'Deinterlace (software tier)';
  for (const [val, label] of [['0', 'Deint: Off'], ['1', 'Deint: Auto'], ['3', 'Deint: Bwdif']] as const) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    deint.appendChild(o);
  }
  deint.value = '1'; // auto — mirrors the decode worker's deintMode default
  const deintWarn = document.createElement('span');
  deintWarn.className = 'ferrite-deint-warn';
  deintWarn.textContent = '⚠ deint n/a';
  deintWarn.title = 'Deinterlace filter unavailable for this stream — showing raw frames';
  // VOD scrub bar + time (shown only for a finite-duration source; replaced by the LIVE pill for live).
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'ferrite-seek';
  seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0';
  seek.title = 'Seek';
  const time = document.createElement('span');
  time.className = 'ferrite-time';
  time.textContent = '0:00 / 0:00';
  const spacer = document.createElement('span');
  spacer.className = 'ferrite-spacer';
  const live = document.createElement('span');
  live.className = 'ferrite-live';
  live.innerHTML = '<span class="ferrite-live-dot"></span>LIVE';
  const btnFs = document.createElement('button');
  btnFs.title = 'Fullscreen';
  bar.append(btnPlay, btnMute, vol, deint, deintWarn, seek, time, spacer, live, btnFs);

  // ---- debug overlay (long-press) -----------------------------------------------------------
  const dbg = document.createElement('div');
  dbg.className = 'ferrite-debug';
  const row = (label: string): { row: HTMLElement; val: HTMLElement } => {
    const r = document.createElement('div');
    r.className = 'ferrite-debug-row';
    const s = document.createElement('span');
    s.textContent = label;
    const b = document.createElement('b');
    b.textContent = '—';
    r.append(s, b);
    return { row: r, val: b };
  };
  const rIso = row('isolated');
  const rTier = row('tier');
  const rFmt = row('format');
  const rStatus = row('status');
  const rClock = row('clock');
  // --- T2 universal telemetry rows (both tiers; fed by player.getStats()) ---
  const rDecode = row('decode');     // fps + cumulative decoded (+ dropped)
  const rPresent = row('present');   // present cadence vs the MEASURED display refresh (multi-monitor regime tracker)
  const rInflight = row('in-flight'); // present-ring depth / cap — the LEAD iPad-wedge signal
  const rQueue = row('decode q');    // tier-specific backlog: WC VideoDecoder queue / SW credits
  const rIngest = row('ingest');     // network throughput + buffered bytes (network- vs decode-stall)
  const rFetch = row('fetch');       // VOD-only: HttpSource transport — position/total · window · conns (hidden on live)
  const rAudio = row('audio');       // audio-sync state: synced/free · seg-queue · rate · stalls
  dbg.append(
    rIso.row, rTier.row, rFmt.row, rStatus.row, rClock.row,
    rDecode.row, rPresent.row, rInflight.row, rQueue.row, rIngest.row, rFetch.row, rAudio.row,
  );

  shell.append(bar);
  if (debugEnabled) shell.append(dbg);

  // ---- volume restore ----------------------------------------------------------------------
  if (persistVolume) {
    try {
      const stored = localStorage.getItem(volKey);
      if (stored !== null) {
        const v = parseFloat(stored);
        if (Number.isFinite(v)) player.volume = v;
      }
    } catch { /* storage unavailable (private mode) */ }
  }
  vol.value = String(player.volume);

  // ---- control actions ---------------------------------------------------------------------
  btnPlay.onclick = () => { if (player.paused) void player.play(); else player.pause(); };
  btnMute.onclick = () => { player.muted = !player.muted; };
  vol.oninput = () => {
    const v = parseFloat(vol.value);
    player.volume = v;
    if (player.muted && v > 0) player.muted = false;
    if (persistVolume) { try { localStorage.setItem(volKey, String(v)); } catch { /* ignore */ } }
  };
  btnFs.onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void shell.requestFullscreen().catch(() => {});
  };
  deint.onchange = () => { player.setDeint(parseInt(deint.value, 10) || 0); };

  // ---- VOD scrub: drag = live preview (seek per input, worker coalesces); position synced when idle --
  let scrubbing = false;
  const seekFraction = (): number => parseFloat(seek.value) / parseFloat(seek.max);
  const seekToValue = (): void => {
    const dur = player.duration;
    if (Number.isFinite(dur) && dur > 0) {
      const t = seekFraction() * dur;
      time.textContent = `${fmtClock(t)} / ${fmtClock(dur)}`;
      player.seek(t);
    }
  };
  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  seek.addEventListener('input', seekToValue);
  // pointerup/keyup end the drag so the idle position sync can resume driving the thumb.
  const endScrub = (): void => { scrubbing = false; };
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('keyup', endScrub);
  seek.addEventListener('blur', endScrub);

  // ---- status state (loading → playing → reconnecting/ended/error) --------------------------
  let status = 'loading';

  const onMediaInfo = (): void => { if (status === 'loading') status = 'playing'; };
  const onRecovered = (): void => { status = 'playing'; };
  const onEnded = (): void => { status = 'ended'; };
  const onLog = (m: string): void => { if (typeof m === 'string' && m.includes('reconnect')) status = 'reconnecting'; };
  const onError = (_t: string, _d: string, info: { fatal?: boolean } | undefined): void => {
    status = info && info.fatal === false ? 'reconnecting' : 'error';
  };
  // The DEINT_FAILED event carries the current state (true = graph won't build, false = it rebuilt), so
  // it both lights AND clears the "deint n/a" warning — no manual per-load reset needed.
  let deintFailed = false;
  const onDeintFailed = (failed: boolean): void => { deintFailed = !!failed; };
  player.on(Events.MEDIA_INFO, onMediaInfo);
  player.on(Events.STATISTICS_INFO, onMediaInfo);
  player.on(Events.RECOVERED_EARLY_EOF, onRecovered);
  player.on(Events.LOADING_COMPLETE, onEnded);
  player.on(Events.LOG, onLog);
  player.on(Events.ERROR, onError);
  player.on(Events.DEINT_FAILED, onDeintFailed);

  // ---- low-rate UI sync (no per-frame work; reads facade getters) ----------------------------
  let lastBar = '';
  const syncBar = (): void => {
    const paused = player.paused;
    const muted = player.muted || player.volume === 0;
    const fs = !!document.fullscreenElement;
    const liveOn = !Number.isFinite(player.duration);
    // The manual deint select is only meaningful on the software tier (the WC/HW tier deinterlaces in
    // hardware); the warning shows only when that tier requested deint and the filter graph won't build.
    const deintOk = player.tier === 'software';
    const key = `${paused}|${muted}|${fs}|${liveOn}|${deintOk}|${deintFailed}`;
    if (key === lastBar) return;
    lastBar = key;
    btnPlay.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    btnMute.innerHTML = muted ? ICON_MUTE : ICON_VOL;
    btnFs.innerHTML = fs ? ICON_FS_EXIT : ICON_FS;
    deint.style.display = deintOk ? '' : 'none';
    deintWarn.classList.toggle('visible', deintOk && deintFailed);
    // VOD shows the scrub bar + time; live shows the LIVE pill (and reclaims the spacer for layout).
    live.style.display = liveOn ? '' : 'none';
    seek.style.display = liveOn ? 'none' : '';
    time.style.display = liveOn ? 'none' : '';
    spacer.style.display = liveOn ? '' : 'none';
  };
  // Drive the scrub thumb + time from the playhead while NOT dragging (cheap; reads facade getters).
  const syncSeek = (): void => {
    const dur = player.duration;
    if (scrubbing || !Number.isFinite(dur) || dur <= 0) return;
    const cur = player.currentTime;
    seek.value = String(Math.round((Math.min(cur, dur) / dur) * parseFloat(seek.max)));
    time.textContent = `${fmtClock(cur)} / ${fmtClock(dur)}`;
  };
  const syncDebug = (): void => {
    if (!debugEnabled || !dbg.classList.contains('visible')) return;
    const s = player.getStats();
    rIso.val.textContent = s.isolated ? 'yes' : 'NO (no SharedArrayBuffer)';
    rIso.val.className = s.isolated ? 'ok' : 'bad';
    rTier.val.textContent = s.tier;
    const i = player.mediaInfo;
    rFmt.val.textContent = i ? `${i.videoCodec || '—'} ${i.width}×${i.height} / ${i.audioCodec || '—'}` : '—';
    rStatus.val.textContent = status;
    rClock.val.textContent = fmtClock(s.currentTime);

    // decode: rate + cumulative frames (+ dropped, only when non-zero).
    rDecode.val.textContent =
      `${s.decodeFps} fps · ${s.framesPresented}f${s.droppedFrames ? ` · ${s.droppedFrames} drop` : ''}`;

    // present cadence vs the MEASURED display refresh (the multi-monitor regime tracker): displayHz is
    // non-zero only when the vsync estimator has ADOPTED/latched the real refresh; vsync ms is the
    // interval driving the Bresenham hold; resync/s should stay ~0 (a refresh change re-acquires cleanly,
    // not via hard resyncs). On a mixed-refresh rig, dragging the window to a different-Hz monitor flips
    // displayHz/vsync to the new rate within ~0.2 s.
    rPresent.val.textContent =
      `${s.presentFps} fps · ${s.displayHz > 0 ? `${Math.round(s.displayHz)}Hz` : '~Hz'} · ` +
      `${s.vsyncIntervalMs.toFixed(1)}ms · hold ${s.cadenceHoldMean.toFixed(2)}` +
      `${s.syncResyncsPerSec > 0 ? ` · ${s.syncResyncsPerSec.toFixed(1)} resync/s` : ''}`;

    // in-flight: present-ring depth vs the tier's cap — the lead WebCodecs-wedge signal (on iOS the
    // un-presented VideoFrame budget; climbing toward the cap precedes the freeze). Flag near-saturation.
    rInflight.val.textContent = `${s.presentQueue} / ${s.presentQueueCap}`;
    const nearCap = s.presentQueueCap > 0 && s.presentQueue >= s.presentQueueCap * 0.9;
    rInflight.val.className = nearCap ? 'bad' : '';

    // decode q: tier-specific backlog. WebCodecs = VideoDecoder.decodeQueueSize (encoded-input backlog,
    // grows when HW decode falls behind feed); software = decode credits remaining (low = main can't
    // present fast enough → backpressure). Same row, the depth that differs per tier.
    // WC also shows the present-ring in-flight (telemetry) + a PARK marker — a stuck "park" with a low q is
    // the feed-gate latch signature (now belt-broken, but visible if a future gate re-latches).
    rQueue.val.textContent = s.tier === 'webcodecs'
      ? `${s.decodeQueueSize} q · ${s.wcInFlight} if${s.wcGateParked ? ' · PARK' : ''}`
      : `${s.credits} cr`;

    // ingest: network throughput + buffered bytes → a network stall (KB/s → 0, buffer draining) reads
    // distinctly from a decode stall (KB/s healthy, in-flight pinned).
    rIngest.val.textContent = `${s.ingestKBps} KB/s · ${fmtBytes(s.bufferedBytes)}`;

    // fetch (VOD only): the HttpSource forward-range transport — read head / total (a progress %), the
    // bounded sliding window, and the upstream connection count (1 forward scan + 1 per committed seek;
    // CLIMBING = reopen churn, the connection-churn regression). `deg` flags the HTTP-200 Range-ignored
    // fallback. Tier-agnostic (both software-VOD and WC-VOD stream via the same transport). Hidden on live.
    const vodActive = s.vodTotalBytes > 0 || s.vodConnections > 0;
    rFetch.row.style.display = vodActive ? '' : 'none';
    if (vodActive) {
      const pct = s.vodTotalBytes > 0 ? Math.min(100, Math.round((s.vodPositionBytes / s.vodTotalBytes) * 100)) : 0;
      rFetch.val.textContent =
        `${fmtBytes(s.vodPositionBytes)}/${fmtBytes(s.vodTotalBytes)} (${pct}%) · win ${fmtBytes(s.vodWindowBytes)} · ${s.vodConnections} conn${s.vodReopens ? `/${s.vodReopens} reopen` : ''}${s.vodDegraded ? ' · deg(200)' : ''}`;
    }

    // audio: master-clock sync state, scheduled-segment queue depth, live-sync rate, and stall count.
    rAudio.val.textContent =
      `${s.syncedToAudio ? 'sync' : 'free'} · q${s.audioQueue} · ${s.speed.toFixed(2)}×${s.liveSyncStalls ? ` · ${s.liveSyncStalls} stall` : ''}`;
  };
  syncBar();
  const syncTimer = setInterval(() => { syncBar(); syncSeek(); syncDebug(); }, 250);

  // ---- auto-hide + long-press wiring (port of overlay-interactions.ts) ------------------------
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const reveal = (): void => bar.classList.add('visible');
  const hide = (): void => bar.classList.remove('visible');
  const armIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; hide(); }, idleHideMs);
  };
  const activity = (): void => { reveal(); if (autoHide) armIdle(); };
  const pressDown = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdTimer = null; dbg.classList.toggle('visible'); syncDebug(); }, longPressMs);
  };
  const pressCancel = (): void => { if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; } };
  const pressEvents = ['pointerup', 'pointercancel', 'pointerleave'];

  if (autoHide) {
    shell.addEventListener('pointermove', activity);
    shell.addEventListener('pointerdown', activity);
    shell.addEventListener('pointerenter', activity);
    armIdle();
  } else {
    reveal(); // no auto-hide → always show the bar
  }
  if (debugEnabled) {
    canvas.addEventListener('pointerdown', pressDown);
    for (const ev of pressEvents) canvas.addEventListener(ev, pressCancel);
  }

  // ---- teardown ----------------------------------------------------------------------------
  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(syncTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (holdTimer !== null) clearTimeout(holdTimer);
      player.off(Events.MEDIA_INFO, onMediaInfo);
      player.off(Events.STATISTICS_INFO, onMediaInfo);
      player.off(Events.RECOVERED_EARLY_EOF, onRecovered);
      player.off(Events.LOADING_COMPLETE, onEnded);
      player.off(Events.LOG, onLog);
      player.off(Events.ERROR, onError);
      player.off(Events.DEINT_FAILED, onDeintFailed);
      if (autoHide) {
        shell.removeEventListener('pointermove', activity);
        shell.removeEventListener('pointerdown', activity);
        shell.removeEventListener('pointerenter', activity);
      }
      if (debugEnabled) {
        canvas.removeEventListener('pointerdown', pressDown);
        for (const ev of pressEvents) canvas.removeEventListener(ev, pressCancel);
      }
      bar.remove();
      dbg.remove();
      // If we created the shell, restore the canvas to its original place and drop the wrapper.
      if (wrapped && origParent) {
        origParent.insertBefore(canvas, origNext);
        shell.remove();
      }
    },
  };
}
