import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_MAX_MS, slideSheetUp } from '../src/stats/slideSheet';

/**
 * slideSheetUp against a stand-in page: just the parts it touches. What
 * matters most is that the no-snapping flag always comes off again, since a
 * page left with it on would never snap anywhere.
 */
interface Page {
  readonly root: { dataset: Record<string, string | undefined> };
  readonly scroller: { scrollTop: number };
  readonly scrolls: { top: number; behavior: string }[];
  readonly listeners: Map<string, () => void>;
  frames: (() => void)[];
  now: number;
}

let page: Page;

function sheetEndingAt(bottom: number): Element {
  return { getBoundingClientRect: () => ({ bottom }) } as unknown as Element;
}

/** Runs one animation frame, after the clock moves on by `ms`. */
function frame(ms = 16): void {
  page.now += ms;
  const run = page.frames;
  page.frames = [];
  run.forEach((f) => f());
}

beforeEach(() => {
  page = {
    root: { dataset: {} },
    scroller: { scrollTop: 0 },
    scrolls: [],
    listeners: new Map(),
    frames: [],
    now: 0,
  };
  vi.stubGlobal('document', { documentElement: page.root, scrollingElement: page.scroller });
  vi.stubGlobal('window', {
    innerHeight: 844,
    scrollTo: (o: { top: number; behavior: string }) => page.scrolls.push(o),
    addEventListener: (type: string, f: () => void) => page.listeners.set(type, f),
    removeEventListener: (type: string, f: () => void) => {
      if (page.listeners.get(type) === f) page.listeners.delete(type);
    },
  });
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => page.frames.push(f));
  vi.stubGlobal('performance', { now: () => page.now });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slideSheetUp', () => {
  it('turns snapping off, aims at the sheet\'s end, and turns it back on when it arrives', () => {
    slideSheetUp(sheetEndingAt(1144), true);
    expect(page.root.dataset.sheetSlide).toBe('');
    expect(page.scrolls).toEqual([{ top: 300, behavior: 'smooth' }]);
    page.scroller.scrollTop = 150;
    frame();
    expect(page.root.dataset.sheetSlide).toBe('');
    page.scroller.scrollTop = 300;
    frame();
    expect(page.root.dataset.sheetSlide).toBeUndefined();
    expect(page.listeners.has('touchstart')).toBe(false);
    expect(page.frames).toHaveLength(0);
  });

  it('jumps without a slide when animations are off', () => {
    slideSheetUp(sheetEndingAt(1144), false);
    expect(page.scrolls).toEqual([{ top: 300, behavior: 'auto' }]);
  });

  it('gives up waiting when the page stops short or the time runs out', () => {
    slideSheetUp(sheetEndingAt(1144), true);
    page.scroller.scrollTop = 120;
    for (let i = 0; i < 8; i++) frame();
    expect(page.root.dataset.sheetSlide).toBeUndefined();

    slideSheetUp(sheetEndingAt(1144), true);
    for (let i = 0; page.now < 2 * SLIDE_MAX_MS && page.root.dataset.sheetSlide !== undefined; i++) {
      page.scroller.scrollTop = (i % 2) * 5; // still moving, never arriving
      frame(100);
    }
    expect(page.root.dataset.sheetSlide).toBeUndefined();
  });

  it('hands over to a finger at once', () => {
    slideSheetUp(sheetEndingAt(1144), true);
    page.listeners.get('touchstart')?.();
    expect(page.root.dataset.sheetSlide).toBeUndefined();
    expect(page.listeners.has('touchstart')).toBe(false);
  });

  it('runs one slide at a time: a second press ends the first, and the flag stays on for the second', () => {
    slideSheetUp(sheetEndingAt(1144), true);
    const first = page.listeners.get('touchstart');
    slideSheetUp(sheetEndingAt(1144), true);
    expect(page.listeners.get('touchstart')).not.toBe(first);
    expect(page.root.dataset.sheetSlide).toBe('');
    page.scroller.scrollTop = 300;
    frame();
    expect(page.root.dataset.sheetSlide).toBeUndefined();
    expect(page.listeners.size).toBe(0);
  });
});
