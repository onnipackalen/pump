/**
 * When the screen asks the server for the public wins (GET /api/wins).
 *
 * The lists are the same for everyone and the server reuses one answer for
 * at least five seconds, so asking more often than that gains nothing. The
 * rule, in plain words:
 *
 * 1. Once when the page loads, to learn whether the lists are switched on.
 *    Off: nothing more is asked until the page is loaded again, and nothing
 *    is shown.
 * 2. On: asked again only while the lists are on screen and the browser tab
 *    is in front. Every ten seconds, or five seconds after the last request
 *    when something new is wanted soon: the lists just came on screen, the
 *    tab came back, a round of the player's just ended, or the player just
 *    changed "Keep my wins private".
 * 3. Never two requests at once, and never two within five seconds.
 * 4. If the first request fails, it is tried again a minute later (while the
 *    tab is in front), so a page opened while offline still finds out.
 *
 * Everything here is a pure function of the state below and the time, so
 * the tests check the rule without a browser.
 */

/** Never two requests closer together than this. The server's own reuse time. */
export const MIN_GAP_MS = 5_000;

/** How often the lists refresh while they are on screen and nothing new is wanted. */
export const POLL_MS = 10_000;

/** After a failed first request: when to try again. */
export const RECHECK_MS = 60_000;

export interface WinsWatch {
  /** What the server last said: on, off, or null before any answer came. */
  readonly enabled: boolean | null;
  /** Whether any part of the lists is on screen (IntersectionObserver). */
  readonly onScreen: boolean;
  /** Whether the browser tab is in front (document.visibilityState). */
  readonly tabVisible: boolean;
  /** When the last request was sent (ms on the page's own clock, performance.now()), or null if none was. */
  readonly lastSentAt: number | null;
  /** A request is on its way. */
  readonly inFlight: boolean;
  /** Something new is wanted soon (see 2 above). Cleared when a request goes. */
  readonly wantSoon: boolean;
}

export const START_WATCH: WinsWatch = {
  enabled: null,
  onScreen: false,
  tabVisible: true,
  lastSentAt: null,
  inFlight: false,
  wantSoon: false,
};

/**
 * How long until the next request should go, in ms (0: now), or null for
 * none until something in the state changes.
 */
export function nextFetchIn(watch: WinsWatch, now: number): number | null {
  if (watch.inFlight || !watch.tabVisible) return null;
  // Switched off: the page-load answer stands.
  if (watch.enabled === false) return null;
  // The page-load check.
  if (watch.lastSentAt === null) return 0;
  // That check failed: try again, rarely.
  if (watch.enabled === null) return Math.max(0, watch.lastSentAt + RECHECK_MS - now);
  if (!watch.onScreen) return null;
  const gap = watch.wantSoon ? MIN_GAP_MS : POLL_MS;
  return Math.max(0, watch.lastSentAt + gap - now);
}

/** A request goes now. */
export function sent(watch: WinsWatch, now: number): WinsWatch {
  return { ...watch, inFlight: true, lastSentAt: now, wantSoon: false };
}

/** The answer came: on or off. */
export function answered(watch: WinsWatch, enabled: boolean): WinsWatch {
  return { ...watch, inFlight: false, enabled };
}

/** No proper answer came. What was known stays; the rule tries again later. */
export function failed(watch: WinsWatch): WinsWatch {
  return { ...watch, inFlight: false };
}

/** The lists came on or went off the screen. Coming on wants fresh lists soon. */
export function seen(watch: WinsWatch, onScreen: boolean): WinsWatch {
  if (watch.onScreen === onScreen) return watch;
  return { ...watch, onScreen, wantSoon: watch.wantSoon || onScreen };
}

/** The tab came to the front or went behind. Coming back wants fresh lists soon. */
export function tabShown(watch: WinsWatch, tabVisible: boolean): WinsWatch {
  if (watch.tabVisible === tabVisible) return watch;
  return { ...watch, tabVisible, wantSoon: watch.wantSoon || tabVisible };
}

/** A round of the player's ended, or their privacy choice changed: fresh lists soon. */
export function wanted(watch: WinsWatch): WinsWatch {
  return watch.wantSoon ? watch : { ...watch, wantSoon: true };
}
