import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balloonSetUp, setUpFrom } from '../src/game/setUp';
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

  it('gives no set-up when nothing was on screen before, or the round is the same one', () => {
    const next = round([balloon()], { id: 'round-b' });
    expect(setUpFrom(null, next)).toEqual([]);
    expect(setUpFrom(ended, null)).toEqual([]);
    // The same round after an answer: it is not new.
    expect(setUpFrom(ended, { ...ended })).toEqual([]);
  });

  it('keeps the set-up while the balloon is in play, and drops it the moment it ends', () => {
    expect(balloonSetUp(balloon(), 'popped')).toBe('popped');
    // Pumped already: kept, so a quick first answer cannot cut the set-up short.
    expect(balloonSetUp(balloon({ rung: 1 }), 'popped')).toBe('popped');
    // Popped or cashed out: gone in the same frame, so it never replays.
    expect(balloonSetUp(balloon({ status: 'popped' }), 'cashed')).toBeUndefined();
    expect(balloonSetUp(balloon({ status: 'cashed', rung: 2 }), 'popped')).toBeUndefined();
    expect(balloonSetUp(balloon(), undefined)).toBeUndefined();
  });
});

describe('the set-up in balloon.css', () => {
  it('starts from exactly the picture the round before left', () => {
    // After a pop the hose lies on the floor ...
    expect(rule('.pump-balloon:is([data-beat="pop"], [data-beat="popped"]) .pb-hose')).toContain(
      'transform: var(--pb-hose-down);',
    );
    expect(transformAt(keyframes('pb-hose-up'), '0%')).toBe('var(--pb-hose-down)');
    // ... and what shows there is the lying hose, not the standing one:
    // the set-up starts with exactly that and hands over to the standing one.
    expect(rule('.pump-balloon:is([data-beat="pop"], [data-beat="popped"]) .pb-hose-stand')).toContain(
      'opacity: 0;',
    );
    expect(keyframes('pb-hose-pick-up')).toMatch(/0% \{\s*opacity: 0;/);
    expect(rule('.pump-balloon:is([data-beat="pop"], [data-beat="popped"]) :is(.pb-hose-flat, .pb-floor-bits)')).toContain(
      'opacity: 1;',
    );
    expect(keyframes('pb-hose-put-away')).toMatch(/from \{\s*opacity: 1;/);
    // ... after a cash-out it is shrunk back to the pump.
    const cashed = /transform: ([^;]+);/.exec(
      rule('.pump-balloon:is([data-beat="cashout"], [data-beat="cashed"]) .pb-hose'),
    );
    expect(transformAt(keyframes('pb-hose-out'), 'from')).toBe(cashed?.[1]);
  });

  it('ends at rest, and holds nothing once it is over', () => {
    expect(transformAt(keyframes('pb-hose-up'), '100%')).toBe('rotate(0deg)');
    expect(transformAt(keyframes('pb-hose-out'), 'to')).toBe('scale(1)');
    expect(transformAt(keyframes('pb-fill-in'), 'to')).toBe('scale(1)');
    for (const selector of [
      '.pump-balloon[data-setup="popped"] .pb-hose',
      '.pump-balloon[data-setup="cashed"] .pb-hose',
      '.pump-balloon[data-setup="popped"] .pb-hose-flat',
      '.pump-balloon[data-setup="popped"] .pb-hose-stand',
      '.pump-balloon[data-setup="popped"] :is(.pb-remnant, .pb-floor-bits)',
      '.pump-balloon[data-setup] .pb-float',
    ]) {
      // "backwards" shows the start pose from the first frame; nothing is
      // kept after the end ("forwards" or "both" would be).
      expect(rule(selector)).toMatch(/ backwards;/);
      expect(rule(selector)).not.toMatch(/ (forwards|both);/);
    }
  });

  it('comes before Pop and Cash-out, so a pop or a cash-out always takes the hose over', () => {
    const setUp = css.indexOf('[data-setup="popped"] .pb-hose {');
    expect(setUp).toBeGreaterThan(0);
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
});
