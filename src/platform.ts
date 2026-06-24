// Platform capability/UA detection — a single, conservative, DOM-free signal that the
// rest of the player gates iOS/Apple-WebKit-specific robustness on.
//
// WHY this exists: the WebCodecs HEVC tier wedges on iPadOS-WebKit — a stream stutters,
// freezes, and then POISONS later streams. The leading cause is that
// iOS/VideoToolbox caps in-flight `VideoFrame`/GPU surfaces far harder than desktop Chrome, so the
// fixed desktop present-ring budget (120) over-pins the decoder pool there. The fixes (smaller iOS
// VideoFrame budget, prefer/fallback-software-HEVC) must trigger ONLY on Apple devices, so they need
// a reliable platform tell. This module is that tell — pure + node-testable; detection happens ONCE
// on the main thread (where `navigator.maxTouchPoints` is reliable) and is handed to the decode
// worker via the `init` message (a WorkerNavigator has no maxTouchPoints, so the worker can't redo it).
//
// CONSERVATIVE BY DESIGN: a wrong positive must never hurt desktop. The only behaviour gated on
// `isIOS` today is a SMALLER present-ring cap, which on a (non-existent) touchscreen-Mac
// false-positive merely tightens the live cushion — invisible, never a regression. So the detector
// errs toward catching every Apple device rather than minimising false positives.

/** The platform tells the player needs. Both are derived purely from UA + touch-point count. */
export interface PlatformInfo {
  /** iPhone / iPod / iPad (incl. iPadOS 13+ which masquerades as desktop "Macintosh" + multitouch).
   *  The tight-VideoFrame-budget signal — gates the iOS present-ring cap and, later, the
   *  prefer/fallback-software-HEVC lever. */
  isIOS: boolean;
  /** The WebKit ENGINE: every iOS browser (Safari, Chrome=CriOS, Firefox=FxiOS are all WebKit) PLUS
   *  desktop Safari. NOT Chromium/Firefox on any non-iOS OS. Broader than isIOS — for telemetry
   *  segmentation + any WebKit-engine-specific (not iOS-hardware-specific) handling. */
  isAppleWebKit: boolean;
}

/**
 * Pure platform detection from the three navigator fields the player reads. Kept side-effect-free and
 * DOM-free so it node-imports and is unit-tested (facade_test.mjs). The caller supplies the values
 * (`currentPlatform()` reads them off `navigator`); passing them in keeps the decision testable.
 *
 * @param ua            navigator.userAgent
 * @param platform      navigator.platform ('' if unavailable — deprecated but still the clearest Mac tell)
 * @param maxTouchPoints navigator.maxTouchPoints (0 if unavailable; the iPadOS-as-desktop tell)
 */
export function detectPlatform(ua: string, platform: string, maxTouchPoints: number): PlatformInfo {
  const u = ua || '';
  const p = platform || '';
  const isIPhone = /iPhone|iPod/.test(u);
  const isIPadLegacy = /iPad/.test(u); // pre-iPadOS-13 still carried an explicit "iPad" token
  const isMac = /Macintosh|Mac OS X/.test(u) || /^Mac/.test(p);
  // iPadOS 13+ defaults to a DESKTOP user agent ("...Macintosh; Intel Mac OS X...") so the only
  // reliable tell that a "Mac" is actually an iPad is a touchscreen — real Macs report maxTouchPoints 0.
  const isIPadDesktopUA = isMac && maxTouchPoints > 1;
  const isIOS = isIPhone || isIPadLegacy || isIPadDesktopUA;
  // WebKit engine on the DESKTOP: Safari's UA carries "Safari" but so do Chromium and Android; exclude
  // the engines that aren't WebKit. (On iOS every browser is WebKit and is already caught by isIOS.)
  const isChromium = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser/.test(u);
  const isFirefox = /Firefox|FxiOS/.test(u);
  const isDesktopSafari = isMac && /Safari/.test(u) && !isChromium && !isFirefox;
  const isAppleWebKit = isIOS || isDesktopSafari;
  return { isIOS, isAppleWebKit };
}

/** Detect the current runtime's platform from `navigator`. Safe to call on the main thread (where
 *  maxTouchPoints is present); in a worker maxTouchPoints is absent (→ 0) so detection there would
 *  miss iPadOS-as-desktop — which is exactly why the main thread detects once and forwards the result. */
export function currentPlatform(): PlatformInfo {
  const nav = (globalThis as { navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number } }).navigator;
  return detectPlatform(nav?.userAgent ?? '', nav?.platform ?? '', nav?.maxTouchPoints ?? 0);
}
