import { useEffect, useState } from 'react';

/**
 * Upright phones: the sheet first, then the wins.
 *
 * There the page rests in three places: sheet down (the top of the page),
 * sheet up (the sheet's bottom at the screen's bottom) and the end of the
 * wins table. Scroll snapping alone cannot keep a quick flick from flying
 * past the middle one: measured in Chrome, a flick up from sheet down went
 * on to the wins every time, scroll-snap-stop or not, because the whole
 * app is itself a snap area and its end is the wins' end.
 *
 * So while the sheet is down the wins wait off the page (display: none,
 * public-wins.css, upright only), and the page is exactly what it is
 * without them: a flick rests at sheet up. They join the page once it has
 * come to rest with the sheet up, below the screen's bottom edge, where
 * nothing moves; one more swipe goes on to them. When the page comes to
 * rest with the sheet down again, they wait again.
 *
 * "At rest" means no finger on the screen and no scroll for REST_MS, so a
 * flick's glide never counts. On a computer the attribute has no effect.
 */

/** How long the page must be still before it counts as at rest. */
export const REST_MS = 120;

/** Rounding, and a phone's browser bars: how far off still counts as in place. */
export const SHEET_SLACK_PX = 4;

export interface PageAtRest {
  /** How far the page is scrolled down. */
  readonly scrollTop: number;
  /** The sheet's bottom edge, from the top of the screen. */
  readonly sheetBottom: number;
  /** The screen's height. */
  readonly screenHeight: number;
}

/**
 * Whether the wins may be on the page, decided once it is at rest. Yes when
 * it rests anywhere but the top (with the wins hidden the only other resting
 * place is sheet up), or when the whole sheet already fits on the screen
 * (a tall tablet, where sheet down and sheet up are the same place).
 */
export function winsMayJoin({ scrollTop, sheetBottom, screenHeight }: PageAtRest): boolean {
  return scrollTop > SHEET_SLACK_PX || sheetBottom <= screenHeight + SHEET_SLACK_PX;
}

/**
 * True while the wins should wait off the page (sheet down). Starts true: a
 * page opens with the sheet down.
 */
export function useWinsWaitForSheet(): boolean {
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    let touching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const decide = (): void => {
      timer = undefined;
      if (touching) return;
      const sheet = document.querySelector('.controls');
      if (!sheet) return;
      const join = winsMayJoin({
        scrollTop: document.scrollingElement?.scrollTop ?? window.scrollY,
        sheetBottom: sheet.getBoundingClientRect().bottom,
        screenHeight: window.innerHeight,
      });
      setWaiting(!join);
    };
    // Every scroll, resize or change of the page's height starts the wait again.
    const later = (): void => {
      clearTimeout(timer);
      timer = setTimeout(decide, REST_MS);
    };
    const fingerDown = (): void => {
      touching = true;
      clearTimeout(timer);
    };
    const fingerUp = (event: TouchEvent): void => {
      if (event.touches.length > 0) return;
      touching = false;
      later();
    };

    const passive = { passive: true } as const;
    window.addEventListener('scroll', later, passive);
    window.addEventListener('resize', later);
    window.addEventListener('touchstart', fingerDown, passive);
    window.addEventListener('touchend', fingerUp, passive);
    window.addEventListener('touchcancel', fingerUp, passive);
    // The sheet changes height between the bet panel, a round and auto-play.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
    resized?.observe(document.body);
    later();

    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
      window.removeEventListener('touchstart', fingerDown);
      window.removeEventListener('touchend', fingerUp);
      window.removeEventListener('touchcancel', fingerUp);
      resized?.disconnect();
    };
  }, []);

  return waiting;
}
