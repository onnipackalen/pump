/**
 * Upright screens: slide the page to "sheet up" by code, for the live stats
 * button (the panel is the sheet's last part, LiveStats.tsx).
 *
 * Two things make this more than a scrollIntoView:
 *
 * - It aims at the sheet's own end (the controls' bottom edge, with its
 *   padding), which is exactly the "sheet up" resting place in styles.css.
 *   Aiming at the panel's bottom would ask for a spot a few pixels short of
 *   it, and whether the browser then snaps on is up to the browser.
 * - Snapping is off while it slides (html[data-sheet-slide], live-stats.css)
 *   and comes back on where it lands. On an iPhone, Safari puts the page back
 *   at the last resting place it knows whenever the page changes height (the
 *   bug that jumped the sheet up when a round ended; styles.css). A slide by
 *   code is not a resting place it knows, so the public wins joining the
 *   page a moment later could have thrown the sheet back down. Switching
 *   snapping off and on makes Safari start again from where the page is.
 */

/** Longest a slide may take before snapping comes back anyway. */
export const SLIDE_MAX_MS = 1500;

/** How far the page must scroll, from the top, to put the sheet's end at the screen's bottom. */
export function sheetUpTop(sheetBottom: number, scrollTop: number, screenHeight: number): number {
  return Math.max(0, Math.round(sheetBottom + scrollTop - screenHeight));
}

/**
 * Whether the slide is over: it has arrived, it has stopped moving for a
 * few frames (the page can't go further), or it has taken too long.
 */
export function slideOver(at: number, target: number, stillFrames: number, elapsedMs: number): boolean {
  return Math.abs(at - target) <= 1 || stillFrames >= 6 || elapsedMs >= SLIDE_MAX_MS;
}

/** Slides the page so `sheet`'s bottom edge meets the screen's bottom. */
export function slideSheetUp(sheet: Element, smooth: boolean): void {
  const root = document.documentElement;
  const scroller = document.scrollingElement ?? root;
  const target = sheetUpTop(sheet.getBoundingClientRect().bottom, scroller.scrollTop, window.innerHeight);
  const started = performance.now();
  let last = scroller.scrollTop;
  let still = 0;

  const finish = (): void => {
    delete root.dataset.sheetSlide;
    window.removeEventListener('touchstart', finish);
  };
  // A finger on the screen takes over: snapping comes back at once.
  window.addEventListener('touchstart', finish, { passive: true });
  root.dataset.sheetSlide = '';
  window.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });

  const watch = (): void => {
    if (root.dataset.sheetSlide === undefined) return;
    const at = scroller.scrollTop;
    still = Math.abs(at - last) < 0.5 ? still + 1 : 0;
    last = at;
    if (slideOver(at, target, still, performance.now() - started)) finish();
    else requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}
