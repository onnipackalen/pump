/**
 * Bringing a round's check into view after its Check button is pressed.
 *
 * The check comes up under the list of rounds, which can be long once older
 * rounds are loaded, so the page scrolls down to it. Two rules:
 *
 * - Only the verify page's own box scrolls, never the window. The page
 *   clips the window (styles.css), so the player has no way to scroll the
 *   window back: a scroll there would leave the page stuck off screen. That
 *   is why this is not scrollIntoView, which scrolls the window too.
 * - It scrolls once the check is drawn, not when Check is pressed. Until the
 *   round has loaded, there is only a one-line "Loading" note at the very
 *   end of the box, and the box can't bring that to its top: the check
 *   would then open at the bottom of the screen.
 */

/** Space left above the check once it is at the top of the box. */
export const CHECK_SCROLL_MARGIN = 8;

/** Where an element is on the screen. */
export interface OnScreen {
  getBoundingClientRect(): { readonly top: number };
}

/** The box that scrolls: the verify page's own. */
export interface ScrollBox extends OnScreen {
  scrollTop: number;
  /** The width of its top border. */
  readonly clientTop: number;
}

/**
 * Scrolls `box` so `target` sits at its top, or as near as the box can go
 * (the browser stops it at the end). Nothing else moves.
 */
export function scrollBoxTo(box: ScrollBox, target: OnScreen): void {
  const inside = box.getBoundingClientRect().top + box.clientTop;
  const by = target.getBoundingClientRect().top - inside - CHECK_SCROLL_MARGIN;
  box.scrollTop = Math.max(0, box.scrollTop + by);
}

/**
 * Keeps track of when to scroll. The page tells it when Check is pressed,
 * and when a round's check is drawn and taken away again. `pressed` and
 * `shown` say true when the page should scroll to the check now: once the
 * round pressed is on screen, and only once for each press.
 */
export class CheckScroll {
  /** The round whose check should be brought into view once it is drawn. */
  private wanted: string | null = null;
  /** The round whose check is on screen now. */
  private drawn: string | null = null;

  /** Check was pressed for `roundId`. */
  pressed(roundId: string): boolean {
    if (this.drawn === roundId) {
      // Already on screen (Check pressed again): scroll back to it now.
      this.wanted = null;
      return true;
    }
    this.wanted = roundId;
    return false;
  }

  /** The check for `roundId`, or the note that it could not be loaded, is on screen. */
  shown(roundId: string): boolean {
    this.drawn = roundId;
    if (this.wanted !== roundId) return false;
    this.wanted = null;
    return true;
  }

  /** The check for `roundId` has gone from the screen. */
  gone(roundId: string): void {
    if (this.drawn === roundId) this.drawn = null;
  }
}
