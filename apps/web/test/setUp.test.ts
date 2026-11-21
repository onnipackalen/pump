import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  balloonSetUp,
  FIRST_LIFT_MS,
  firstPump,
  liftStarts,
  SET_UP_MS,
  setUpFrom,
} from '../src/game/setUp';
import {
  fallAt,
  FLAT,
  FLOOR_Y,
  HOSE_FALL_MS,
  HOSE_LIFT_MS,
  hoseAt,
  hoseLies,
  liftAt,
  onTip,
  STAND,
  STAND_END,
  tipPose,
  type Point,
} from '../src/balloon/hoseShape';
import { balloon, round } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../src/balloon/balloon-app.css', import.meta.url), 'utf8');
const art = readFileSync(new URL('../src/balloon/Balloon.tsx', import.meta.url), 'utf8');

/** The text of one @keyframes block in balloon.css. */
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  return css.slice(start, css.indexOf('\n}', start));
}

/** One CSS rule's text, found by its exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

/** A custom property's milliseconds, as balloon.css sets it on .pump-balloon. */
function cssMs(name: string): number {
  const found = new RegExp(`${name}: (\\d+)ms;`).exec(css);
  if (!found?.[1]) throw new Error(`no ${name}`);
  return Number(found[1]);
}

/** A time in a rule: "300ms" or "var(--x)", in ms. */
function ms(value: string): number {
  const named = /^var\((--[\w-]+)\)$/.exec(value);
  return named?.[1] ? cssMs(named[1]) : Number(value.replace('ms', ''));
}

/** When a rule's one animation is over: its duration plus any delay, in ms. */
function endMs(selector: string): number {
  const shorthand = /animation: ([^;]+);/.exec(rule(selector))?.[1];
  if (!shorthand) throw new Error(`no animation in ${selector}`);
  const times = shorthand.match(/var\(--[\w-]+\)|\b\d+ms\b/g) ?? [];
  return times.reduce((sum, t) => sum + ms(t), 0);
}

/** Every rule whose selector ends in `target` and that sets an animation. */
function animatedRules(target: string): string[] {
  const out: string[] = [];
  const re = /\n([^\n{}]*?) \{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selector = (m[1] ?? '').trim();
    if (selector.endsWith(target) && /\banimation(-name)?:/.test(m[2] ?? '')) out.push(selector);
  }
  return out;
}

const zoom = Number(/--pb-first-zoom: scale\(([\d.]+)\)/.exec(css)?.[1]);
const origin = /\.pb-scene \{[^}]*transform-origin: ([\d.]+)px ([\d.]+)px;/.exec(css);
const zoomed = ([x, y]: Point): Point => {
  const [ox, oy] = [Number(origin?.[1]), Number(origin?.[2])];
  return [ox + (x - ox) * zoom, oy + (y - oy) * zoom];
};
const pointsOf = (d: string): Point[] => {
  const n = [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
  const out: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i] ?? 0, n[i + 1] ?? 0]);
  return out;
};

describe('which set-up a new round gets', () => {
  const ended = round(
    [
      balloon({ status: 'popped', rung: 3 }),
      balloon({ status: 'cashed', rung: 5 }),
      balloon({ status: 'refunded' }),
    ],
    { id: 'round-a' },
  );

  it('sets each slot up from what was in it: a pop, a cash-out, a refund', () => {
    const next = round([balloon(), balloon(), balloon()], { id: 'round-b' });
    expect(setUpFrom(ended, next)).toEqual(['popped', 'cashed', 'void']);
  });

  it('sets a slot that had no balloon up like the picture before any bet', () => {
    const one = round([balloon({ status: 'cashed', rung: 2 })], { id: 'round-a' });
    const three = round([balloon(), balloon(), balloon()], { id: 'round-b' });
    expect(setUpFrom(one, three)).toEqual(['cashed', 'idle', 'idle']);
    expect(setUpFrom(null, three, true)).toEqual(['idle', 'idle', 'idle']);
  });

  it('gives no set-up when nothing was on screen before, or the round is the same one', () => {
    const next = round([balloon()], { id: 'round-b' });
    // A round restored after a page load: only "Loading" was on screen.
    expect(setUpFrom(null, next, false)).toEqual([]);
    expect(setUpFrom(ended, null)).toEqual([]);
    expect(setUpFrom(ended, { ...ended })).toEqual([]);
  });

  it('is gone from the first answer on, so it can never start again', () => {
    expect(balloonSetUp(balloon(), 'popped')).toBe('popped');
    // The first pump held: the lift takes over. Kept, the set-up replayed
    // on the second pump (live check, 2026-11-20).
    expect(balloonSetUp(balloon({ rung: 1 }), 'idle')).toBeUndefined();
    expect(balloonSetUp(balloon({ rung: 2 }), 'cashed')).toBeUndefined();
    expect(balloonSetUp(balloon({ status: 'popped' }), 'cashed')).toBeUndefined();
  });

  it('moves for SET_UP_MS at most, the time auto-play can wait after a bet', () => {
    expect(cssMs('--pb-setup-ms')).toBe(SET_UP_MS);
    const setUps = animatedRules('.pb-scene').concat(animatedRules('.pb-limp')).filter((s) => s.includes('data-setup'));
    expect(setUps.length).toBeGreaterThan(0);
    for (const selector of setUps) expect(endMs(selector)).toBeLessThanOrEqual(SET_UP_MS);
  });

  it('starts from the picture before it and ends in the floor picture, holding nothing after', () => {
    expect(keyframes('pb-zoom-in')).toMatch(/from \{\s*transform: scale\(1\);/);
    expect(keyframes('pb-zoom-in')).toMatch(/to \{\s*transform: var\(--pb-first-zoom\);/);
    expect(keyframes('pb-limp-on')).toMatch(/from \{\s*opacity: 0;/);
    // A refunded balloon already lies there: it does not unroll again.
    expect(css).toContain('.pump-balloon[data-setup]:not([data-setup="void"]) .pb-limp {');
    for (const selector of animatedRules('.pb-scene').concat(animatedRules('.pb-limp'))) {
      expect(rule(selector)).not.toMatch(/ (forwards|both);/);
    }
  });
});

describe('the first pump', () => {
  it('keeps a new balloon flat on the floor until its first answer', () => {
    expect(firstPump(balloon(), false)).toBe('floor');
    expect(firstPump(balloon({ status: 'popped' }), false)).toBe('floor-popped');
    expect(firstPump(balloon({ status: 'refunded' }), false)).toBe('floor-void');
  });

  it('lifts only when this screen sees the first pump hold, never on a reload', () => {
    expect(liftStarts(1, 'survived')).toBe(true);
    expect(liftStarts(1, 'top')).toBe(true);
    // Restored on its first rung, or a later pump: no lift.
    expect(liftStarts(1, 'idle')).toBe(false);
    expect(liftStarts(2, 'survived')).toBe(false);
    expect(firstPump(balloon({ rung: 1 }), false)).toBeUndefined();
    expect(firstPump(balloon({ rung: 1 }), true)).toBe('lift');
  });

  it('keeps the lift whatever comes next, until it is over', () => {
    // A quick second pump or a cash-out used to cut it short with a jump.
    expect(firstPump(balloon({ rung: 2 }), true)).toBe('lift');
    expect(firstPump(balloon({ rung: 1, status: 'cashed' }), true)).toBe('lift');
    expect(cssMs('--pb-zoom-ms')).toBe(FIRST_LIFT_MS);
    for (const layer of ['.pb-limp', '.pb-grow', '.pb-scene']) {
      expect(endMs(`.pump-balloon[data-first="lift"] ${layer}`)).toBeLessThanOrEqual(FIRST_LIFT_MS);
    }
  });

  it('runs the lift on layers no pop or cash-out moves, so its end state is never cut', () => {
    // The blow-up is on the grow layer (a cash-out floats the layer around
    // it), the view on the scene: only these start rules animate them.
    for (const selector of animatedRules('.pb-grow')) expect(selector).toContain('[data-first="lift"]');
    for (const selector of animatedRules('.pb-scene')) expect(selector).toMatch(/data-setup|data-first/);
    expect(keyframes('pb-blow-up')).toMatch(/to \{\s*opacity: 1;\s*scale: 1;/);
    expect(keyframes('pb-zoom-out')).toMatch(/to \{\s*transform: scale\(1\);/);
  });

  it('lifts from exactly the floor picture', () => {
    expect(rule('.pump-balloon:is([data-first="floor"], [data-first="floor-void"]) .pb-limp')).toContain('opacity: 1;');
    expect(keyframes('pb-limp-off')).toMatch(/0%,\s*55% \{\s*opacity: 1;/);
    expect(rule('.pump-balloon[data-first="floor"] .pb-scene')).toContain('transform: var(--pb-first-zoom);');
    expect(keyframes('pb-zoom-out')).toMatch(/from \{\s*transform: var\(--pb-first-zoom\);/);
    // The flat balloon rides up for exactly as long as the hose lifts.
    expect(cssMs('--pb-lift-ms')).toBe(HOSE_LIFT_MS);
  });

  it('shows no blown-up balloon when the first pump pops it, or its bet is refunded', () => {
    const hidden = rule(
      '.pump-balloon:is([data-idle], [data-first="floor"], [data-first="floor-popped"], [data-first="floor-void"]) .pb-float',
    );
    expect(hidden).toContain('opacity: 0;');
    expect(rule('.pump-balloon[data-first="floor-popped"] .pb-shards')).toContain('display: none;');
  });

  it('with motion off, fades the new balloon in at once', () => {
    expect(rule(':root[data-motion="reduce"] .pump-balloon[data-first="lift"] .pb-grow')).toContain(
      'animation-delay: 0s;',
    );
  });

  it('zooms in only when one balloon is on the stage', () => {
    expect(appCss).toMatch(/\.slots:has\(> \.slot:nth-child\(2\)\) \.pump-balloon \{\s*--pb-first-zoom: scale\(1\);/);
  });
});

describe('the hose', () => {
  it('lies on the floor before a bet, while a balloon waits, and after a pop or a cash-out alike', () => {
    expect(hoseLies({ idle: true })).toBe(true);
    for (const first of ['floor', 'floor-popped', 'floor-void']) expect(hoseLies({ first })).toBe(true);
    for (const beat of ['pop', 'popped', 'cashout', 'cashed']) expect(hoseLies({ beat })).toBe(true);
    for (const beat of [undefined, 'press', 'survive', 'blocked']) expect(hoseLies({ beat, first: 'lift' })).toBe(false);
  });

  it('bends from its standing shape exactly into its lying one', () => {
    const same = (a: readonly Point[], b: readonly Point[]) =>
      a.every(([x, y], i) => Math.abs(x - (b[i]?.[0] ?? NaN)) < 1e-9 && Math.abs(y - (b[i]?.[1] ?? NaN)) < 1e-9);
    expect(same(hoseAt(0), STAND)).toBe(true);
    expect(same(hoseAt(1), FLAT)).toBe(true);
    expect([fallAt(0), fallAt(1), liftAt(0), liftAt(1)]).toEqual([0, 1, 1, 0]);
  });

  it('moves as one fluid line: no part of it jumps from one frame to the next', () => {
    // The user asked for a fluid fall (2026-11-20): it used to turn over
    // stiffly and swap shapes as it landed. At 60 frames a second no point
    // may move more than 16 units in one frame, in the fall or the lift.
    for (const [curve, duration] of [[fallAt, HOSE_FALL_MS], [liftAt, HOSE_LIFT_MS]] as const) {
      const frames = Math.ceil(duration / (1000 / 60));
      for (let i = 1; i <= frames; i += 1) {
        const a = hoseAt(curve((i - 1) / frames));
        const b = hoseAt(curve(i / frames));
        a.forEach(([ax, ay], k) => {
          const [bx, by] = b[k] ?? [ax, ay];
          expect(Math.hypot(ax - bx, ay - by)).toBeLessThan(16);
        });
      }
    }
  });

  it('never passes through the floor or outside 14% to 87% of the width', () => {
    for (let i = 0; i <= 100; i += 1) {
      for (const [x, y] of hoseAt(i / 100).slice(1)) {
        expect(y).toBeLessThanOrEqual(FLOOR_Y);
        expect(x).toBeGreaterThanOrEqual(28);
        expect(x).toBeLessThanOrEqual(174);
      }
    }
  });

  it('carries the fitting and the flat balloon on its end, onto the floor and inside the layout', () => {
    const still = tipPose(STAND);
    expect(Math.abs(still.dx) + Math.abs(still.dy) + Math.abs(still.degrees)).toBeLessThan(1e-9);
    const pose = tipPose(FLAT);
    const [ex, ey] = onTip(STAND_END, pose);
    expect(Math.hypot(ex - (FLAT[9]?.[0] ?? 0), ey - (FLAT[9]?.[1] ?? 0))).toBeLessThan(1e-9);
    const limp = /className="pb-limp-body" d="([^"]+)"/.exec(art)?.[1] ?? '';
    const fitting: Point[] = [[96, 221], [104, 221], [96, 228], [104, 228]];
    for (const p of [...pointsOf(limp), ...fitting].map((q) => onTip(q, pose))) {
      // On the floor: no lower than the pump's base (y 311), with a little give.
      expect(p[1]).toBeLessThanOrEqual(311.5);
      // Inside 14% to 87%, even in the closer view of a waiting balloon.
      const [x, y] = zoomed(p);
      expect(x).toBeGreaterThanOrEqual(28);
      expect(x).toBeLessThanOrEqual(174);
      expect(y).toBeLessThanOrEqual(320);
    }
    for (const p of FLAT) expect(zoomed(p)[0]).toBeGreaterThanOrEqual(28);
  });

  it('puts every line of the air pocket on the hose, so it runs along whatever shape the hose has', () => {
    const pocket = [...art.matchAll(/<path className="pb-air-[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(pocket.length).toBe(9);
    for (const line of pocket) expect(line).toContain('data-hose-line');
  });
});
