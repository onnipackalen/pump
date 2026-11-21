import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@pump/engine';
import { balloonSize } from '../src/balloon/Balloon';
import { cardScale } from '../src/components/BalloonCard';
import { balloon } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../src/balloon/balloon-app.css', import.meta.url), 'utf8');

/** The body of the first CSS rule with exactly this selector. */
function rule(sheet: string, selector: string): string {
  const start = sheet.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return sheet.slice(start, sheet.indexOf('}', start));
}

/** A custom property's value, as balloon.css sets it on .pump-balloon. */
function token(name: string): string {
  const found = new RegExp(`\\n  ${name}: (#[0-9a-f]{6});`).exec(css);
  if (!found?.[1]) throw new Error(`no ${name}`);
  return found[1];
}

/** WCAG contrast between two #rrggbb colours, from 1 to 21. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The three balloon colours, read from balloon.css. */
function balloonColours(): string[] {
  const found = [...css.matchAll(/--balloon-base: (#[0-9a-f]{6});/g)].map((m) => m[1] ?? '');
  expect(found).toHaveLength(3);
  return found;
}

describe('balloonSize', () => {
  // Ladder lengths come from config, plus the short tops a payout cap can
  // leave a balloon with.
  const tops = [...new Set([1, 2, 3, ...GAME_CONFIG.difficulties.map((d) => d.ladder.length)])];

  it.each(tops)('runs from 0.45 before the first pump to 1 at a top of %i pumps', (top) => {
    expect(balloonSize(0, top)).toBe(0.45);
    expect(balloonSize(top, top)).toBe(1);
  });

  it.each(tops)('grows with every pump, never by less than half an even share (top %i)', (top) => {
    const evenShare = 0.55 / top;
    for (let rung = 1; rung <= top; rung += 1) {
      const step = balloonSize(rung, top) - balloonSize(rung - 1, top);
      expect(step).toBeGreaterThanOrEqual(evenShare / 2 - 1e-12);
    }
  });

  it.each(tops)('takes the balloon a fifth of the way to full size on its first pump (top %i)', (top) => {
    // The first pump lifts the flat balloon off the floor and blows it up:
    // a clear jump, then the rest of the ladder shares what is left.
    const jump = (balloonSize(1, top) - balloonSize(0, top)) / (1 - balloonSize(0, top));
    expect(jump).toBeGreaterThanOrEqual(0.2);
    // Full size only at the top rung: the biggest balloon is unchanged,
    // so three side by side at their biggest still do not touch.
    expect(balloonSize(top, top)).toBe(1);
    if (top > 1) expect(balloonSize(top - 1, top)).toBeLessThan(1);
  });

  it.each(tops)('makes the first pump the biggest step, at least a tenth bigger (top %i)', (top) => {
    const first = balloonSize(1, top) - balloonSize(0, top);
    for (let rung = 2; rung <= top; rung += 1) {
      expect(balloonSize(rung, top) - balloonSize(rung - 1, top)).toBeLessThan(first);
    }
    expect(balloonSize(1, top) / balloonSize(0, top)).toBeGreaterThanOrEqual(1.1);
  });

  it('stays inside 0.45 to 1 for numbers it should never get', () => {
    expect(balloonSize(0, 0)).toBe(0.45);
    expect(balloonSize(-1, 10)).toBe(0.45);
    expect(balloonSize(11, 10)).toBe(1);
  });
});

describe('cardScale: the size the screen really draws', () => {
  it('follows the balloon\'s rung out of its own top, not its multiplier', () => {
    for (const { ladder } of GAME_CONFIG.difficulties) {
      const top = ladder.length;
      for (let rung = 0; rung <= top; rung += 1) {
        const b = balloon({
          rung,
          topRung: top,
          multiplierHundredths: rung === 0 ? null : (ladder[rung - 1] ?? null),
        });
        expect(cardScale(b)).toBe(balloonSize(rung, top));
      }
    }
  });

  it('grows a balloon by at least a tenth on its first pump, on the longest ladder too', () => {
    const top = Math.max(...GAME_CONFIG.difficulties.map((d) => d.ladder.length));
    const ladder = GAME_CONFIG.difficulties.find((d) => d.ladder.length === top)?.ladder ?? [];
    const before = cardScale(balloon({ rung: 0, topRung: top }));
    const after = cardScale(
      balloon({ rung: 1, topRung: top, multiplierHundredths: ladder[0] ?? null }),
    );
    expect(after / before).toBeGreaterThanOrEqual(1.1);
  });

  it('fills the box at a top the payout cap has brought down', () => {
    expect(cardScale(balloon({ rung: 4, topRung: 4, multiplierHundredths: 946 }))).toBe(1);
  });
});

describe('a pop stays quiet', () => {
  it('flies grey pieces, not pieces in the balloon colour', () => {
    const shard = rule(css, '.pump-balloon .pb-shard');
    expect(shard).toContain('fill: var(--pb-popped);');
    expect(shard).not.toContain('--balloon-base');
  });

  it('leaves nothing of the balloon behind: no torn neck, no bits on the floor', () => {
    // The user asked for this on 2026-11-20 ("just make it pop like blast
    // into oblivion"), after trying both.
    const art = readFileSync(new URL('../src/balloon/Balloon.tsx', import.meta.url), 'utf8');
    expect(art).not.toMatch(/pb-remnant|pb-floor-bit|pb-torn/);
    expect(css).not.toMatch(/pb-remnant|pb-floor-bit|--pb-torn/);
  });

  it('lets the pieces float down and fade out completely', () => {
    const end = /@keyframes pb-shard-fly \{[\s\S]*?100% \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(end).toContain('opacity: 0;');
    expect(end).toMatch(/translate\(calc\(var\(--dx\) \* [\d.]+\), calc\(var\(--dy\) \+ \d+px\)\)/);
  });

  it('keeps the pump number at full strength after a pop', () => {
    // It is how players tell balloons apart; dimmed, the pump looked off.
    expect(css).not.toMatch(/\[data-beat="popped"\]\)? \.pb-tag \{[^}]*opacity/);
  });
});

describe('the Patch', () => {
  it('reads on every balloon colour: the tape or its edge is at least 4.5 to 1', () => {
    const tape = token('--pb-patch-tape');
    const edge = token('--pb-patch-edge');
    for (const colour of balloonColours()) {
      expect(Math.max(contrast(tape, colour), contrast(edge, colour))).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tape, edge)).toBeGreaterThanOrEqual(4.5);
  });

  it('is never the win mint', () => {
    const mint = token('--pb-win');
    expect(token('--pb-patch-tape')).not.toBe(mint);
    expect(token('--pb-patch-edge')).not.toBe(mint);
    expect(rule(css, '.pump-balloon .pb-patch-tape')).toContain('fill: var(--pb-patch-tape);');
  });
});

describe('the multiplier on the balloon', () => {
  it('has a floor the page can raise, and the game raises it for small pictures', () => {
    expect(rule(css, '.pump-balloon .pb-value')).toContain(
      'transform: scale(max(1, calc(var(--pb-value-floor) / var(--balloon-scale))));',
    );
    // Each step: a picture under this height (px) gets this floor. The
    // number is 30 of the picture's 320 units tall, so at the bottom of a
    // step it is 30 x floor x next-height / 320 px. 12 px or more.
    const steps = [...appCss.matchAll(/@container \(height < (\d+)px\)[^{]*\{[^}]*--pb-value-floor: ([\d.]+);/g)].map(
      (m) => ({ below: Number(m[1]), floor: Number(m[2]) }),
    );
    expect(steps.length).toBeGreaterThan(0);
    const floors = [{ below: Infinity, floor: 0.5 }, ...steps];
    const smallestPicture = 160;
    floors.forEach((step, i) => {
      const bottom = floors[i + 1]?.below ?? smallestPicture;
      expect((30 * step.floor * bottom) / 320).toBeGreaterThanOrEqual(12);
      // Above 0.8 "1.01x" no longer fits the smallest balloon with a number.
      expect(step.floor).toBeLessThanOrEqual(0.8);
    });
  });
});
