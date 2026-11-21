import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balloonFirst, balloonSetUp, setUpFrom } from '../src/game/setUp';
import { balloon, round } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');
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

/** The transform a keyframe at `at` (like "0%" or "from") sets. */
function transformAt(block: string, at: string): string {
  const start = block.indexOf(`${at} {`);
  if (start < 0) throw new Error(`no ${at}`);
  const found = /transform: ([^;]+);/.exec(block.slice(start));
  if (!found?.[1]) throw new Error(`no transform at ${at}`);
  return found[1];
}

describe('which set-up a new round gets', () => {
  const ended = round(
    [balloon({ status: 'popped', rung: 3 }), balloon({ status: 'cashed', rung: 5 })],
    { id: 'round-a' },
  );

  it('sets each slot up from how the balloon before it in that slot ended', () => {
    const next = round([balloon(), balloon(), balloon()], { id: 'round-b' });
    expect(setUpFrom(ended, next)).toEqual(['popped', 'cashed', undefined]);
  });

  it('sets every slot up from the picture before any bet, when that was on screen', () => {
    const next = round([balloon(), balloon()], { id: 'round-b' });
    expect(setUpFrom(null, next, true)).toEqual(['idle', 'idle']);
  });

  it('gives no set-up when nothing was on screen before, or the round is the same one', () => {
    const next = round([balloon()], { id: 'round-b' });
    // A round restored after a page load: only "Loading" was on screen.
    expect(setUpFrom(null, next, false)).toEqual([]);
    expect(setUpFrom(ended, null)).toEqual([]);
    // The same round after an answer: it is not new.
    expect(setUpFrom(ended, { ...ended })).toEqual([]);
  });

  it('keeps the set-up while the balloon is in play, and drops it the moment it ends', () => {
    expect(balloonSetUp(balloon(), 'popped')).toBe('popped');
    // Pumped already: kept, so a quick first answer cannot cut the set-up short.
    expect(balloonSetUp(balloon({ rung: 1 }), 'idle')).toBe('idle');
    // Popped or cashed out: gone in the same frame, so it never replays.
    expect(balloonSetUp(balloon({ status: 'popped' }), 'cashed')).toBeUndefined();
    expect(balloonSetUp(balloon({ status: 'cashed', rung: 2 }), 'popped')).toBeUndefined();
    expect(balloonSetUp(balloon(), undefined)).toBeUndefined();
  });
});

describe('the first pump', () => {
  it('keeps a new balloon on the floor until its first pump, and lifts it only when that pump holds', () => {
    expect(balloonFirst(balloon({ rung: 0 }))).toBe('floor');
    expect(balloonFirst(balloon({ rung: 1 }))).toBe('lift');
    expect(balloonFirst(balloon({ rung: 0, status: 'popped' }))).toBe('floor-popped');
    // Later pumps, and pops or cash-outs after the first pump: the usual pictures.
    expect(balloonFirst(balloon({ rung: 2 }))).toBeUndefined();
    expect(balloonFirst(balloon({ rung: 1, status: 'popped' }))).toBeUndefined();
    expect(balloonFirst(balloon({ rung: 1, status: 'cashed' }))).toBeUndefined();
  });

  it('starts the lift from exactly the floor picture', () => {
    expect(rule('.pump-balloon:is([data-idle], [data-first="floor"]) .pb-hose')).toContain(
      'transform: var(--pb-hose-down);',
    );
    expect(transformAt(keyframes('pb-hose-up'), '0%')).toBe('var(--pb-hose-down)');
    expect(rule('.pump-balloon:is([data-idle], [data-first="floor"]) .pb-hose-stand')).toContain('opacity: 0;');
    expect(keyframes('pb-hose-pick-up')).toMatch(/0% \{\s*opacity: 0;/);
    expect(rule('.pump-balloon:is([data-idle], [data-first="floor"]) .pb-hose-flat')).toContain('opacity: 1;');
    expect(keyframes('pb-hose-put-away')).toMatch(/from \{\s*opacity: 1;/);
    expect(rule('.pump-balloon[data-first="floor"] .pb-limp')).toContain('opacity: 1;');
    expect(keyframes('pb-limp-off')).toMatch(/0%,\s*55% \{\s*opacity: 1;/);
    expect(rule('.pump-balloon[data-first="floor"] .pb-scene')).toContain('transform: var(--pb-first-zoom);');
    expect(transformAt(keyframes('pb-zoom-out'), 'from')).toBe('var(--pb-first-zoom)');
    // It ends at rest: upright, full size, the usual view.
    expect(transformAt(keyframes('pb-hose-up'), '100%')).toBe('rotate(0deg)');
    expect(transformAt(keyframes('pb-fill-in'), 'to')).toBe('scale(1)');
    expect(transformAt(keyframes('pb-zoom-out'), 'to')).toBe('scale(1)');
  });

  it('does not let the hose fall on a pop it already lies under', () => {
    // Weightier than the Pop section's fall, so it wins wherever it is.
    expect(
      rule('.pump-balloon[data-first="floor-popped"][data-beat="pop"] :is(.pb-hose, .pb-hose-stand, .pb-hose-flat)'),
    ).toContain('animation: none;');
    expect(rule('.pump-balloon[data-first="floor-popped"] .pb-shards')).toContain('display: none;');
  });

  it('runs the first press along the hose that is there', () => {
    // The lying hose has its own pocket, and the standing one is hidden.
    expect(art).toMatch(/<g className="pb-air pb-air-flat">[\s\S]*?d=\{FLAT_HOSE_PATH\}/);
    expect(css).toMatch(/\.pump-balloon\[data-first="floor"\] \.pb-hose \.pb-air,[^{]*\{\s*display: none;/);
  });
});

describe('the set-up in balloon.css', () => {
  it('starts from exactly the picture before it, and ends in the floor picture', () => {
    // After a pop the hose already lies there, as in the floor picture ...
    expect(rule('.pump-balloon:is([data-beat="pop"], [data-beat="popped"]) .pb-hose')).toContain(
      'transform: var(--pb-hose-down);',
    );
    expect(rule('.pump-balloon:is([data-beat="pop"], [data-beat="popped"]) :is(.pb-hose-flat, .pb-floor-bits)')).toContain(
      'opacity: 1;',
    );
    expect(keyframes('pb-scrap-off')).toMatch(/from \{\s*opacity: 1;/);
    // ... after a cash-out it is shrunk back to the pump, and lays itself down.
    const cashed = /transform: ([^;]+);/.exec(
      rule('.pump-balloon:is([data-beat="cashout"], [data-beat="cashed"]) .pb-hose'),
    )?.[1];
    expect(transformAt(keyframes('pb-hose-lay'), 'from')).toBe(`rotate(0deg) ${cashed}`);
    expect(transformAt(keyframes('pb-hose-lay'), 'to')).toBe('var(--pb-hose-down) scale(1)');
    // The view moves from the usual one to the floor picture's.
    expect(transformAt(keyframes('pb-zoom-in'), 'from')).toBe('scale(1)');
    expect(transformAt(keyframes('pb-zoom-in'), 'to')).toBe('var(--pb-first-zoom)');
  });

  it('holds nothing once it is over', () => {
    for (const selector of [
      '.pump-balloon[data-setup] .pb-scene',
      '.pump-balloon[data-setup] .pb-limp',
      '.pump-balloon[data-setup="popped"] :is(.pb-remnant, .pb-floor-bits)',
      '.pump-balloon[data-setup="cashed"] .pb-hose',
      '.pump-balloon[data-setup="cashed"] .pb-hose-stand',
      '.pump-balloon[data-setup="cashed"] .pb-hose-flat',
      '.pump-balloon[data-first="lift"] .pb-hose',
      '.pump-balloon[data-first="lift"] .pb-scene',
    ]) {
      // "backwards" at most: nothing is kept after the end ("forwards" or
      // "both" would be), so the floor picture's own rules take over.
      expect(rule(selector)).not.toMatch(/ (forwards|both);/);
    }
  });

  it('lets the lift, a pop and a cash-out take over from a set-up', () => {
    const setUp = css.indexOf('.pump-balloon[data-setup="cashed"] .pb-hose {');
    expect(setUp).toBeGreaterThan(0);
    expect(setUp).toBeLessThan(css.indexOf('.pump-balloon[data-first="lift"] .pb-hose {'));
    expect(setUp).toBeLessThan(css.indexOf('[data-beat="pop"] .pb-hose {'));
    expect(setUp).toBeLessThan(css.indexOf('[data-beat="cashout"] .pb-hose {'));
  });

  it('keeps the air pocket in the hose layer, so a pump during the set-up rides the moving hose', () => {
    const hose = art.indexOf('<g className="pb-hose">');
    const pocket = art.indexOf('<g className="pb-air">');
    const hoseEnd = art.indexOf('<g className="pb-remnant">');
    expect(hose).toBeGreaterThan(0);
    expect(pocket).toBeGreaterThan(hose);
    expect(pocket).toBeLessThan(hoseEnd);
  });
});

describe('the popped picture in Balloon.tsx', () => {
  /** The numbers of a path constant in Balloon.tsx. */
  const pathNumbers = (name: string): number[] => {
    const found = new RegExp(`const ${name} =\\s*'([^']+)'`).exec(art);
    if (!found?.[1]) throw new Error(`no ${name}`);
    return [...found[1].matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
  };
  const angle = Number(/--pb-hose-down: rotate\((-?[\d.]+)deg\)/.exec(css)?.[1]);
  /** A point of the standing hose, turned by --pb-hose-down around the nozzle. */
  const turned = (x: number, y: number): [number, number] => {
    const [nx, ny] = [116, 295];
    const r = (angle * Math.PI) / 180;
    return [
      nx + (x - nx) * Math.cos(r) - (y - ny) * Math.sin(r),
      ny + (x - nx) * Math.sin(r) + (y - ny) * Math.cos(r),
    ];
  };

  it('lays the hose so its end is where the fallen standing hose ends, pointing the same way', () => {
    // The fitting and the torn neck turn with the standing hose; the lying
    // hose must end right under them, or they would float beside it.
    const stand = pathNumbers('HOSE_PATH');
    const flat = pathNumbers('FLAT_HOSE_PATH');
    const [ex, ey] = turned(stand[stand.length - 2] ?? 0, stand[stand.length - 1] ?? 0);
    const [fx, fy] = [flat[flat.length - 2] ?? 0, flat[flat.length - 1] ?? 0];
    expect(Math.hypot(ex - fx, ey - fy)).toBeLessThan(0.3);
    // Direction at the end: from the last control point to the end point.
    const [cx, cy] = turned(stand[stand.length - 4] ?? 0, stand[stand.length - 3] ?? 0);
    const [gx, gy] = [flat[flat.length - 4] ?? 0, flat[flat.length - 3] ?? 0];
    const along = (a: number, b: number) => Math.atan2(b, a);
    const diff = Math.abs(along(ex - cx, ey - cy) - along(fx - gx, fy - gy));
    expect(diff).toBeLessThan((5 * Math.PI) / 180);
    // Both start at the nozzle.
    expect(flat.slice(0, 2)).toEqual(stand.slice(0, 2));
  });

  it('keeps the floor bits on the floor, between the hose end and the pump', () => {
    const bits = [...art.matchAll(/className="pb-floor-bit" d="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(bits.length).toBeGreaterThanOrEqual(2);
    expect(bits.length).toBeLessThanOrEqual(3);
    const flat = pathNumbers('FLAT_HOSE_PATH');
    const hoseEnd = flat[flat.length - 2] ?? 0;
    for (const d of bits) {
      const n = [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
      for (let i = 0; i < n.length; i += 2) {
        expect(n[i]).toBeGreaterThan(hoseEnd);
        expect(n[i]).toBeLessThan(116); // the nozzle: the pump starts here
        expect(n[i + 1]).toBeGreaterThan(310); // on the floor, in front of the hose
      }
    }
  });

  it('keeps the closer view of a new balloon inside 14% to 87% of the width, and on the floor', () => {
    const zoom = Number(/--pb-first-zoom: scale\(([\d.]+)\)/.exec(css)?.[1]);
    const origin = /\.pb-scene \{[^}]*transform-origin: ([\d.]+)px ([\d.]+)px;/.exec(css);
    const [ox, oy] = [Number(origin?.[1]), Number(origin?.[2])];
    expect(zoom).toBeGreaterThan(1);
    const zoomed = ([x, y]: [number, number]): [number, number] => [ox + (x - ox) * zoom, oy + (y - oy) * zoom];
    // What the floor picture draws: the lying hose, the fitting and the
    // flat balloon (both turned down with the standing hose), and the pump.
    const flat = pathNumbers('FLAT_HOSE_PATH');
    const points: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) points.push([flat[i] ?? 0, flat[i + 1] ?? 0]);
    for (const [x, y] of [[96, 221], [104, 221], [96, 228], [104, 228]] as const) points.push(turned(x, y));
    const limp = /className="pb-limp-body" d="([^"]+)"/.exec(art)?.[1] ?? '';
    const n = [...limp.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
    for (let i = 0; i < n.length; i += 2) points.push(turned(n[i] ?? 0, n[i + 1] ?? 0));
    points.push([174, 314], [168, 311]); // the shadow's right edge, the pump's base
    for (const p of points) {
      const [x, y] = zoomed(p);
      expect(x).toBeGreaterThanOrEqual(28);
      expect(x).toBeLessThanOrEqual(174);
      expect(y).toBeLessThanOrEqual(320);
    }
  });
});
