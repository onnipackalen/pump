import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG, type Difficulty } from '@pump/engine';
import { Balloon } from '../src/balloon/Balloon';
import { FLOOR_Y } from '../src/balloon/hoseShape';
import { BalloonCard, PreviewCard } from '../src/components/BalloonCard';
import { BetPanel } from '../src/components/BetPanel';
import { checkBets } from '../src/game/betSetup';
import {
  LEVEL_COLOURS,
  LEVEL_FALLBACK,
  levelColour,
  levelOf,
  MAX_LEVEL_MARKS,
  stageLevelId,
} from '../src/game/level';
import { balloon, round } from './fixtures';

const css = readFileSync(new URL('../src/balloon/balloon.css', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const difficulties = GAME_CONFIG.difficulties;

/** A colour token as a sheet sets it, like "  --mint: #4fe0a8;". */
function token(sheet: string, name: string): string {
  const found = new RegExp(`\\n\\s*${name}: (#[0-9a-f]{6});`).exec(sheet);
  if (!found?.[1]) throw new Error(`no ${name}`);
  return found[1];
}

/** A #rrggbb colour in OKLab, a space where distance follows how different two colours look. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** How different two colours look: OKLab distance, times 100 (about 2 is just visible). */
function difference(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
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

/** Every ring the markup draws, as numbers. */
function rings(html: string): { x: number; y: number; width: number; height: number }[] {
  return [...html.matchAll(/<rect class="pb-level-ring" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(
    (m) => ({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) }),
  );
}

/** The opening tag of the balloon picture in some markup. */
function svgTag(html: string): string {
  return /<svg[^>]*class="pump-balloon"[^>]*>/.exec(html)?.[0] ?? '';
}

describe('the difficulty colours', () => {
  it('give every configured difficulty a colour of its own', () => {
    for (const d of difficulties) {
      expect(Object.hasOwn(LEVEL_COLOURS, d.id), d.id).toBe(true);
      expect(levelColour(d.id)).not.toBe(LEVEL_FALLBACK);
    }
    const used = difficulties.map((d) => levelColour(d.id));
    expect(new Set(used).size).toBe(used.length);
  });

  it('falls back for a difficulty with no colour, even one named like a built-in', () => {
    for (const id of ['insane', '', 'constructor', 'toString', '__proto__']) {
      expect(levelColour(id)).toBe(LEVEL_FALLBACK);
    }
  });

  it('stays well clear of every colour that already means something: a win, a pop, the pop chance, a warning, an error or a balloon', () => {
    // Not just a different hex code: a colour that only looks the same
    // would mean the same thing. The pop-chance steps count too, though no
    // rule uses them yet: the page keeps them for the pop chance alone.
    const taken = [
      token(css, '--pb-win'),
      token(pageCss, '--mint'),
      token(css, '--pb-popped'),
      token(pageCss, '--pop'),
      token(pageCss, '--risk'),
      token(pageCss, '--risk-1'),
      token(pageCss, '--risk-2'),
      token(pageCss, '--risk-3'),
      token(pageCss, '--risk-4'),
      token(pageCss, '--error'),
      token(pageCss, '--pearl'),
      ...[...css.matchAll(/--balloon-base: (#[0-9a-f]{6});/g)].map((m) => m[1] ?? ''),
    ];
    expect(taken.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    for (const colour of [...Object.values(LEVEL_COLOURS), LEVEL_FALLBACK]) {
      for (const other of taken) {
        expect(difference(colour, other), `${colour} against ${other}`).toBeGreaterThanOrEqual(9);
      }
    }
  });

  it('look clearly different from each other', () => {
    const colours = Object.values(LEVEL_COLOURS);
    colours.forEach((a, i) => {
      for (const b of colours.slice(i + 1)) {
        expect(difference(a, b), `${a} against ${b}`).toBeGreaterThanOrEqual(12);
      }
    });
  });

  it('shows on the pump: at least 3 to 1 against its barrel', () => {
    const barrel = /\.pb-pump-barrel \{\s*fill: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '';
    expect(barrel).toMatch(/^#/);
    for (const colour of Object.values(LEVEL_COLOURS)) {
      expect(contrast(colour, barrel), colour).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('levelOf', () => {
  it('gives one ring for the first difficulty, one more for each after it', () => {
    difficulties.forEach((d, i) => {
      expect(levelOf(d.id)).toEqual({
        id: d.id,
        colour: levelColour(d.id),
        marks: Math.min(i + 1, MAX_LEVEL_MARKS),
      });
    });
  });

  it('still draws a difficulty added to the config, in the fallback colour', () => {
    const extra: Difficulty = { id: 'insane', label: 'Insane', ladder: [300, 1000] };
    const level = levelOf('insane', [...difficulties, extra]);
    expect(level.colour).toBe(LEVEL_FALLBACK);
    expect(level.marks).toBe(Math.min(difficulties.length + 1, MAX_LEVEL_MARKS));
  });

  it('shows no rings for a difficulty that is not in the config', () => {
    expect(levelOf('gone').marks).toBe(0);
  });
});

describe('the rings on the pump', () => {
  it('draws one ring per mark, in the colour given, and says the difficulty', () => {
    for (let marks = 0; marks <= MAX_LEVEL_MARKS; marks += 1) {
      const html = renderToStaticMarkup(
        createElement(Balloon, { slot: 1, scale: 0.45, idle: true, level: { id: 'x', colour: '#123456', marks } }),
      );
      expect(rings(html)).toHaveLength(marks);
      expect(svgTag(html)).toContain('data-level="x"');
      expect(svgTag(html)).toContain('--pb-level:#123456');
    }
  });

  it('draws none, and no level, when it is not given one', () => {
    const html = renderToStaticMarkup(createElement(Balloon, { slot: 1, scale: 0.45, idle: true }));
    expect(rings(html)).toHaveLength(0);
    expect(svgTag(html)).not.toContain('data-level');
    expect(svgTag(html)).not.toContain('--pb-level');
  });

  it('never draws more rings than there is room for', () => {
    const html = renderToStaticMarkup(
      createElement(Balloon, { slot: 1, scale: 1, level: { id: 'x', colour: '#123456', marks: 99 } }),
    );
    expect(rings(html)).toHaveLength(MAX_LEVEL_MARKS);
  });

  it('keeps to the art: on the barrel, under the number dial, above the floor, 14% to 87% across', () => {
    const html = renderToStaticMarkup(
      createElement(Balloon, { slot: 1, scale: 1, level: { id: 'x', colour: '#123456', marks: MAX_LEVEL_MARKS } }),
    );
    const barrel = /<rect class="pb-pump-barrel" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(html);
    const dial = /<circle class="pb-tag-card" cx="[\d.]+" cy="([\d.]+)" r="([\d.]+)"/.exec(html);
    expect(barrel).not.toBeNull();
    expect(dial).not.toBeNull();
    const [bx, by, bw, bh] = [1, 2, 3, 4].map((i) => Number(barrel?.[i]));
    // The dial's outline is 3 wide, half of it outside the circle.
    const dialBottom = Number(dial?.[1]) + Number(dial?.[2]) + 1.5;
    const found = rings(html);
    const ys = found.map((r) => r.y);
    expect(new Set(ys).size).toBe(found.length);
    for (const r of found) {
      expect(r.x).toBeGreaterThanOrEqual(bx ?? NaN);
      expect(r.x + r.width).toBeLessThanOrEqual((bx ?? NaN) + (bw ?? NaN));
      expect(r.x).toBeGreaterThanOrEqual(200 * 0.14);
      expect(r.x + r.width).toBeLessThanOrEqual(200 * 0.87);
      expect(r.y).toBeGreaterThan(dialBottom);
      expect(r.y + r.height).toBeLessThanOrEqual((by ?? NaN) + (bh ?? NaN));
      expect(r.y + r.height).toBeLessThan(FLOOR_Y);
    }
  });

  it('takes its colour from the level the balloon is given, and nothing paints over it', () => {
    const rules = [...css.matchAll(/([^{}]*\.pb-level-ring[^{}]*)\{([^}]*)\}/g)];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.[2]).toMatch(/^\s*fill: var\(--pb-level, #[0-9a-f]{6}\);\s*$/);
  });

  it('never moves: no animation or transition reaches the rings', () => {
    // Any rule whose selector names a ring class (the whole drawing still
    // zooms with the view, as it always has).
    expect(css).toMatch(/\.pb-level-ring \{/);
    expect(css).not.toMatch(/\.pb-level[\w-]*[^{};]*\{[^}]*(animation|transition|transform)/);
  });
});

describe('the cards pass the difficulty to the pump', () => {
  const noop = (): void => undefined;

  it.each(difficulties.map((d) => d.id))('a balloon in a round on %s', (id) => {
    const html = renderToStaticMarkup(
      createElement(BalloonCard, {
        balloon: balloon({ rung: 2, multiplierHundredths: 150, cashOutCents: 150 }),
        difficultyId: id,
        rtpBp: GAME_CONFIG.rtpBp,
        ladder: difficulties.find((d) => d.id === id)?.ladder ?? [],
        beat: 'idle',
        patched: false,
        outcome: null,
        held: false,
        pending: false,
        winShown: true,
        roundWin: null,
        quiet: true,
        selectable: false,
        selected: false,
        onSelect: noop,
        canPump: false,
        onPump: noop,
        onPumpHold: noop,
        afterRoundShown: false,
      }),
    );
    const level = levelOf(id);
    expect(svgTag(html)).toContain(`data-level="${id}"`);
    expect(svgTag(html)).toContain(`--pb-level:${level.colour}`);
    expect(rings(html)).toHaveLength(level.marks);
  });

  it.each(difficulties.map((d) => d.id))('the pump before a bet on %s', (id) => {
    const ladder = difficulties.find((d) => d.id === id)?.ladder ?? [];
    const html = renderToStaticMarkup(
      createElement(PreviewCard, { slot: 2, difficultyId: id, betCents: 100, ladder, topRung: ladder.length }),
    );
    const level = levelOf(id);
    expect(svgTag(html)).toContain(`data-level="${id}"`);
    expect(svgTag(html)).toContain(`--pb-level:${level.colour}`);
    expect(rings(html)).toHaveLength(level.marks);
  });
});

describe('the level the pumps of a round show', () => {
  const ids = difficulties.map((d) => d.id);
  const played = ids[0] ?? '';

  it('is the round\'s own while it is in play, whatever is picked', () => {
    const live = round([balloon({ rung: 2 })], { difficultyId: played });
    expect(live.status).toBe('active');
    for (const picked of [...ids, undefined]) {
      expect(stageLevelId(live, picked)).toBe(played);
    }
  });

  it('follows the difficulty picked for the next round once the round is over', () => {
    // The stage keeps a finished round's balloons beside the bet panel, so
    // picking another difficulty there must change their pumps at once.
    const over = round([balloon({ status: 'cashed', rung: 2 })], { difficultyId: played });
    expect(over.status).toBe('finished');
    for (const picked of ids) {
      expect(stageLevelId(over, picked)).toBe(picked);
    }
  });

  it('stays the round\'s own once it is over if nothing is picked', () => {
    const over = round([balloon({ status: 'popped', rung: 1 })], { difficultyId: played });
    expect(stageLevelId(over, undefined)).toBe(played);
  });

  it('is what the game screen hands each balloon of a round', () => {
    // The screen itself is not rendered in these tests (no DOM here), so
    // check that it passes the round and the picked difficulty through.
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const card = /<BalloonCard\b[\s\S]*?\/>/.exec(app)?.[0] ?? '';
    expect(card).toMatch(/difficultyId=\{stageLevelId\(round, setupDifficulty\?\.id\)\}/);
  });
});

describe('the bet panel', () => {
  it('puts the matching colour dot on each difficulty button', () => {
    const setup = { difficultyId: difficulties[0]?.id ?? '', bets: ['1.00'] };
    const html = renderToStaticMarkup(
      createElement(BetPanel, {
        config: GAME_CONFIG,
        setup,
        check: checkBets(setup, GAME_CONFIG.limits, 1_000_000),
        disabled: false,
        starting: false,
        showBet: true,
        onChange: () => undefined,
        onStart: () => undefined,
      }),
    );
    const group = /<div class="segmented" role="radiogroup" aria-label="Difficulty">(.*?)<\/div>/.exec(html)?.[1] ?? '';
    const buttons = group.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(difficulties.length);
    difficulties.forEach((d, i) => {
      const button = buttons[i] ?? '';
      expect(button).toContain(
        `<span class="level-dot" data-level="${d.id}" style="--level-colour:${levelColour(d.id)}" aria-hidden="true"></span>${d.label}`,
      );
    });
  });

  it('stacks the dot under the name in the button\'s own flow, so it cannot touch the letters', () => {
    // Placed absolutely, a fixed gap from the bottom, it ran into the "y"
    // of Easy and the "p" of Expert once short screens shrank the button.
    const button = /\.segment:has\(> \.level-dot\) \{([^}]*)\}/.exec(pageCss)?.[1] ?? '';
    const dot = /\.level-dot \{([^}]*)\}/.exec(pageCss)?.[1] ?? '';
    expect(button).toMatch(/display: flex;/);
    expect(button).toMatch(/flex-direction: column;/);
    expect(button).toMatch(/gap: [1-9]/);
    expect(dot).toMatch(/order: 1;/);
    expect(button + dot).not.toMatch(/position: absolute/);
  });
});
