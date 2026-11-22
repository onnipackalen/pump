import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_SCROLL_MARGIN,
  CheckScroll,
  scrollBoxTo,
  type OnScreen,
  type ScrollBox,
} from '../src/verify/checkScroll';

/*
 * Pressing Check on the verify page brings the round's check into view.
 * Two things went wrong with it once, both checked here:
 *
 * - The window scrolled and the page went off screen for good. The page
 *   clips the window, so the player can't scroll it back. Only the verify
 *   page's own box may scroll, and nothing in that box may make the window
 *   taller than the screen.
 * - It scrolled to the one-line "Loading" note at the end of the box, so
 *   the check opened at the bottom of the screen. It must wait until the
 *   check is drawn.
 *
 * There is no DOM here, so the layout part is read from styles.css and
 * the page's source.
 */

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/components/VerifyPage.tsx', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe('the verify page never scrolls the window', () => {
  it('keeps text placed with position: absolute inside its own scroll box', () => {
    // The screen-reader labels in the list of rounds are placed this way.
    expect(rule('.visually-hidden')).toMatch(/position:\s*absolute/);
    expect(pageSource).toContain('className="visually-hidden"');
    // Such text is placed against its nearest positioned box. The verify
    // box must be that box, or the text lands in the window's own overflow
    // and makes the window taller than the screen.
    const box = rule('.verify');
    expect(box).toMatch(/position:\s*relative/);
    expect(box).toMatch(/overflow-y:\s*auto/);
  });

  it('scrolls by setting its own box, not with scrollIntoView (which scrolls the window too)', () => {
    expect(pageSource).not.toMatch(/\.scrollIntoView\(/);
    expect(pageSource).not.toMatch(/window\.scroll/);
  });
});

/** A box on the screen, `top` pixels down, scrolled `scrollTop` already. */
function fakeBox(top: number, scrollTop: number): ScrollBox {
  return { scrollTop, clientTop: 0, getBoundingClientRect: () => ({ top }) };
}

/** A target that may only be measured: if it is asked to scroll itself into view, the test fails. */
function fakeTarget(top: number): OnScreen & { scrollIntoView(): never } {
  return {
    getBoundingClientRect: () => ({ top }),
    scrollIntoView: () => {
      throw new Error('the target must not scroll itself (and the window) into view');
    },
  };
}

describe('scrollBoxTo', () => {
  it('moves the box so the target sits just under its top', () => {
    // The box starts 60px down the screen (under the top bar); the check is
    // 1500px further down than that.
    const box = fakeBox(60, 200);
    scrollBoxTo(box, fakeTarget(1560));
    expect(box.scrollTop).toBe(200 + 1500 - CHECK_SCROLL_MARGIN);
  });

  it('scrolls up to a target above, and never past the start', () => {
    const box = fakeBox(60, 900);
    scrollBoxTo(box, fakeTarget(-240));
    expect(box.scrollTop).toBe(900 - 300 - CHECK_SCROLL_MARGIN);
    const near = fakeBox(60, 2);
    scrollBoxTo(near, fakeTarget(40));
    expect(near.scrollTop).toBe(0);
  });

  it('counts the box’s top border', () => {
    const box: ScrollBox = { scrollTop: 0, clientTop: 3, getBoundingClientRect: () => ({ top: 60 }) };
    scrollBoxTo(box, fakeTarget(563));
    expect(box.scrollTop).toBe(500 - CHECK_SCROLL_MARGIN);
  });
});

describe('when Check scrolls', () => {
  it('waits until the round pressed is drawn, not while it is loading', () => {
    const scroll = new CheckScroll();
    // Pressed: only "Loading the round…" is there yet.
    expect(scroll.pressed('r1')).toBe(false);
    // Drawn: now.
    expect(scroll.shown('r1')).toBe(true);
    // Only once for each press.
    expect(scroll.shown('r1')).toBe(false);
  });

  it('scrolls at once when the round pressed is already on screen', () => {
    const scroll = new CheckScroll();
    scroll.shown('r1');
    expect(scroll.pressed('r1')).toBe(true);
    expect(scroll.shown('r1')).toBe(false);
  });

  it('scrolls to a round opened another way only if it was pressed', () => {
    const scroll = new CheckScroll();
    // Opened from the game screen's own list, or by typing its id.
    expect(scroll.shown('r1')).toBe(false);
    // Pressed, then another round is typed in before it loads.
    expect(scroll.pressed('r2')).toBe(false);
    expect(scroll.shown('r3')).toBe(false);
  });

  it('waits again when a round that was on screen is pressed after another', () => {
    const scroll = new CheckScroll();
    scroll.shown('r1');
    // r2 pressed: r1's check goes, r2 loads.
    expect(scroll.pressed('r2')).toBe(false);
    scroll.gone('r1');
    // r1 pressed again before r2 is drawn: r1 loads again from the start,
    // so this must wait for it too.
    expect(scroll.pressed('r1')).toBe(false);
    expect(scroll.shown('r1')).toBe(true);
    // A round that goes after another is drawn changes nothing.
    scroll.gone('r2');
    expect(scroll.pressed('r1')).toBe(true);
  });
});
