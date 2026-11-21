import { readFileSync } from 'node:fs';
import { cashOutCents, GAME_CONFIG, multiplierAt, popChance, topRungForBet } from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView, PumpOutcome } from '../src/api/contract';
import { BalloonCard, PreviewCard } from '../src/components/BalloonCard';
import { shownRound } from '../src/game/useGame';
import { formatMultiplier } from '../src/money';
import { balloon, round } from './fixtures';

/**
 * How the cards hand a balloon to its row of steps, read from the markup
 * they write. stepRow.test.ts checks the row's own rules; these check that
 * the cards give it the right balloon, top and next step, since a card
 * that passed the wrong top would still pass every test of the pure rules.
 */

// The card's art reads the pop chance, so it is drawn at each RTP the
// reviewers will set.
const RTPS = [9400, 9700, 9900];
const { limits } = GAME_CONFIG;

/** Ordinary bets, the largest one, and the bets one cent either side of each step's cap edge. */
function betsFor(ladder: readonly number[]): number[] {
  const bets = new Set([limits.minBetCents, 100, 12_345, limits.maxBetCents]);
  for (const hundredths of ladder) {
    // The largest bet this step can still pay within the cap.
    const edge = Math.floor((limits.maxPayoutCents * 100) / hundredths);
    for (const bet of [edge - 1, edge, edge + 1]) {
      if (bet >= limits.minBetCents && bet <= limits.maxBetCents) bets.add(bet);
    }
  }
  return [...bets];
}

/** A balloon in play on `rung`, as the server would send it. */
function inPlay(
  ladder: readonly number[],
  rtpBp: number,
  betCents: number,
  rung: number,
): BalloonView {
  return balloon({
    betCents,
    rung,
    drawIndex: rung,
    topRung: topRungForBet(ladder, betCents, limits.maxPayoutCents),
    multiplierHundredths: rung === 0 ? null : multiplierAt(ladder, rung),
    cashOutCents: rung === 0 ? null : cashOutCents(betCents, ladder, rung),
    next: {
      popChance: popChance(rtpBp, ladder, rung + 1),
      multiplierHundredths: multiplierAt(ladder, rung + 1),
      patchPriceCents: null,
    },
  });
}

interface CardOptions {
  readonly rtpBp?: number;
  readonly canPump?: boolean;
  readonly quiet?: boolean;
  readonly patched?: boolean;
  readonly outcome?: PumpOutcome | null;
}

function card(view: BalloonView, ladder: readonly number[], options: CardOptions = {}): string {
  return renderToStaticMarkup(
    createElement(BalloonCard, {
      balloon: view,
      rtpBp: options.rtpBp ?? GAME_CONFIG.rtpBp,
      ladder,
      difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
      beat: 'idle',
      patched: options.patched ?? false,
      outcome: options.outcome ?? null,
      held: false,
      pending: false,
      winShown: true,
      roundWin: null,
      quiet: options.quiet ?? true,
      selectable: false,
      selected: false,
      onSelect: () => undefined,
      canPump: options.canPump ?? false,
      onPump: () => undefined,
      onPumpHold: () => undefined,
      afterRoundShown: false,
    }),
  );
}

function preview(ladder: readonly number[], betCents: number | null, cap: number): string {
  return renderToStaticMarkup(
    createElement(PreviewCard, {
      slot: 1,
      difficultyId: GAME_CONFIG.difficulties[0]?.id ?? 'easy',
      betCents,
      ladder,
      maxPayoutCents: cap,
    }),
  );
}

/** The state of each step in the markup, in order (the place before the first step left out). */
function states(html: string): string[] {
  return [...html.matchAll(/<li class="step" data-step="([a-z]+)"/g)].map((m) => m[1] ?? '');
}

/** The row's own opening tag, with its attributes and style. */
function rowTag(html: string): string {
  return /<div class="steps"[^>]*>/.exec(html)?.[0] ?? '';
}

/** Every place in the row, the first (before any step) included, as its opening tag. */
function places(html: string): string[] {
  return [...html.matchAll(/<li class="step[^>]*>/g)].map((m) => m[0]);
}

const lockedFrom = (html: string): number => {
  const all = states(html);
  const first = all.indexOf('locked');
  return first === -1 ? all.length + 1 : first + 1;
};

describe('a balloon card and its row of steps', () => {
  it('locks exactly the steps above the balloon own top, at every bet and RTP', () => {
    let capped = 0;
    for (const rtpBp of RTPS) {
      for (const { ladder } of GAME_CONFIG.difficulties) {
        for (const betCents of betsFor(ladder)) {
          const top = topRungForBet(ladder, betCents, limits.maxPayoutCents);
          if (top < ladder.length) capped += 1;
          for (const rung of new Set([0, 1, Math.floor(top / 2), top - 1])) {
            if (rung < 0 || rung >= top) continue;
            const all = states(card(inPlay(ladder, rtpBp, betCents, rung), ladder, { rtpBp }));
            expect(all).toHaveLength(ladder.length);
            all.forEach((state, index) => {
              expect(state === 'locked').toBe(index + 1 > top);
            });
          }
        }
      }
    }
    // Some bet really was cut short by the cap, so locked steps were drawn.
    expect(capped).toBeGreaterThan(0);
  });

  it('takes the top from the balloon, not from the length of the ladder', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    const view = balloon({ rung: 1, topRung: 3, multiplierHundredths: multiplierAt(ladder, 1) });
    expect(lockedFrom(card(view, ladder))).toBe(4);
  });

  it('marks the step the balloon is on and the one its next pump goes for', () => {
    for (const { ladder } of GAME_CONFIG.difficulties) {
      const all = states(card(inPlay(ladder, GAME_CONFIG.rtpBp, 100, 2), ladder));
      expect(all.slice(0, 4)).toEqual(['passed', 'current', 'next', 'ahead']);
    }
  });

  it('keeps the place before the first step, and keeps exactly one place in view', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    for (const rung of [0, 1, 2, 5]) {
      const html = card(inPlay(ladder, GAME_CONFIG.rtpBp, 100, rung), ladder);
      const all = places(html);
      // One place more than the ladder has steps, the extra one in front.
      expect(all).toHaveLength(ladder.length + 1);
      expect(all[0]).toContain('step-start');
      // The place in view is the balloon's rung: 0 is the place in front.
      const inView = all.flatMap((tag, index) => (tag.includes('data-anchor="true"') ? [index] : []));
      expect(inView).toEqual([rung]);
      expect(rowTag(html)).toContain(`--at:${String(rung)}`);
    }
  });

  it('does not move the row for the small line under the amount', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    const view = inPlay(ladder, GAME_CONFIG.rtpBp, 100, 3);
    const plain = card(view, ladder);
    // A Patch that stopped a pop puts long words in the small line.
    const saved = card(view, ladder, { patched: true, outcome: 'saved' });
    expect(saved).toContain('Patch stopped a pop');
    expect(rowTag(saved)).toBe(rowTag(plain));
    expect(rowTag(plain)).toContain('--main-chars:');
    expect(rowTag(plain)).not.toContain('--sub-chars');
  });
});

describe('a preview card and its row of steps', () => {
  it('locks what the engine says the bet cannot reach, before the round starts', () => {
    let capped = 0;
    for (const { ladder } of GAME_CONFIG.difficulties) {
      for (const betCents of betsFor(ladder)) {
        const top = topRungForBet(ladder, betCents, limits.maxPayoutCents);
        if (top < ladder.length) capped += 1;
        const all = states(preview(ladder, betCents, limits.maxPayoutCents));
        expect(all).toHaveLength(ladder.length);
        all.forEach((state, index) => {
          expect(state === 'locked').toBe(index + 1 > top);
        });
      }
    }
    expect(capped).toBeGreaterThan(0);
  });

  it('follows the payout cap it is given', () => {
    // With a tenth of the cap, the largest bet must be cut shorter on some ladder.
    const shorter = GAME_CONFIG.difficulties.some(({ ladder }) => {
      const full = lockedFrom(preview(ladder, limits.maxBetCents, limits.maxPayoutCents));
      const tenth = Math.floor(limits.maxPayoutCents / 10);
      const cut = lockedFrom(preview(ladder, limits.maxBetCents, tenth));
      expect(cut).toBe(topRungForBet(ladder, limits.maxBetCents, tenth) + 1);
      return cut < full;
    });
    expect(shorter).toBe(true);
  });

  it('locks nothing while there is no valid bet', () => {
    for (const { ladder } of GAME_CONFIG.difficulties) {
      expect(states(preview(ladder, null, limits.maxPayoutCents))).not.toContain('locked');
    }
  });

  it('shows the first step as the one the first pump goes for', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    expect(states(preview(ladder, 100, limits.maxPayoutCents)).slice(0, 2)).toEqual([
      'next',
      'ahead',
    ]);
  });
});

describe('the "next" line under a balloon', () => {
  const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
  // A number no step of the ladder has, to tell the server's own number
  // for the next pump from one looked up on the ladder.
  const odd = { popChance: { num: 1, den: 2 }, multiplierHundredths: 12_345, patchPriceCents: null };
  const text = `next ${formatMultiplier(odd.multiplierHundredths)}`;
  const inRound = balloon({ rung: 2, drawIndex: 2, multiplierHundredths: 118, next: odd });

  it('is the server number for the next pump, inside the Pump button', () => {
    const html = card(inRound, ladder, { canPump: true });
    const button = /<button[^>]*slot-pump[^>]*>.*?<\/button>/s.exec(html)?.[0] ?? '';
    expect(button).toContain(`<span class="slot-next"`);
    expect(button).toContain(`>${text}</span>`);
    expect(html).not.toContain('<p class="slot-next"');
  });

  it('stands alone when the balloon has no button of its own', () => {
    const html = card(inRound, ladder, { canPump: false });
    expect(html).not.toContain('slot-pump');
    expect(html).toMatch(new RegExp(`<p class="slot-next"[^>]*>${text.replace('.', '\\.')}</p>`));
  });

  it('is never there for a balloon that is over, even if it still carries a next pump', () => {
    for (const status of ['popped', 'cashed', 'refunded'] as const) {
      for (const canPump of [true, false]) {
        const over = balloon({ status, rung: 2, drawIndex: 3, multiplierHundredths: 118, next: odd });
        expect(card(over, ladder, { canPump })).not.toContain('slot-next');
      }
    }
  });

  it('is not there when the server sends no next pump', () => {
    expect(card(balloon({ rung: 2, next: null }), ladder, { canPump: true })).not.toContain(
      'slot-next',
    );
  });

  it('shows nothing of a result that is being held back', () => {
    // Balloon 1 was pressed on rung 2. Another balloon's answer already
    // holds its pop, but its own answer has not been shown yet.
    const pressed = inPlay(ladder, GAME_CONFIG.rtpBp, 100, 2);
    const answered = round([
      balloon({ status: 'popped', rung: 2, drawIndex: 3, next: null }),
      inPlay(ladder, GAME_CONFIG.rtpBp, 100, 1),
    ]);
    const shown = shownRound(answered, [pressed, null]);
    const first = shown?.balloons[0];
    expect(first).toBeDefined();
    if (!first) return;
    const html = card(first, ladder, { canPump: true });
    expect(states(html)).not.toContain('popped');
    expect(states(html)[1]).toBe('current');
    expect(html).toContain(`next ${formatMultiplier(multiplierAt(ladder, 3))}`);
  });
});

describe('what a screen reader gets instead of the row', () => {
  const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
  const view = inPlay(ladder, GAME_CONFIG.rtpBp, 100, 2);
  const next = formatMultiplier(multiplierAt(ladder, 3));
  const top = formatMultiplier(multiplierAt(ladder, view.topRung));

  it('hides the row itself, with nothing in it to announce', () => {
    const html = card(view, ladder);
    expect(rowTag(html)).toContain('aria-hidden="true"');
    const row = /<div class="steps".*?<\/ol><\/div>/s.exec(html)?.[0] ?? '';
    expect(row).not.toMatch(/aria-label|aria-current|aria-live/);
  });

  it('says the next step and the top in one short line, outside the live region', () => {
    const html = card(view, ladder, { quiet: false });
    const line = `<p class="visually-hidden">Next ${next}. Top at this bet ${top}.</p>`;
    expect(html).toContain(line);
    // The two lines under the balloon are the live region: not in there.
    const live = /<p class="slot-label".*?<\/p>/s.exec(html)?.[0] ?? '';
    expect(live).toContain('aria-live="polite"');
    expect(live).not.toContain('Next');
    expect(live).not.toContain('Top at this bet');
  });

  it('says the first step for a balloon before its round', () => {
    const first = formatMultiplier(multiplierAt(ladder, 1));
    const full = formatMultiplier(multiplierAt(ladder, ladder.length));
    expect(preview(ladder, 100, limits.maxPayoutCents)).toContain(
      `<p class="visually-hidden">First step ${first}. Top at this bet ${full}.</p>`,
    );
  });

  it('says nothing more once the balloon is over', () => {
    for (const status of ['popped', 'cashed', 'refunded'] as const) {
      const over = balloon({ status, rung: 2, drawIndex: 3, multiplierHundredths: 118 });
      expect(card(over, ladder)).not.toContain('visually-hidden');
    }
  });

  it('puts the next step in the Pump button label, which replaces its text', () => {
    const html = card(view, ladder, { canPump: true });
    expect(html).toContain(`aria-label="Pump balloon 1, next ${next}"`);
  });

  it('hides the stand-alone "next" line, which the short line already says', () => {
    const html = card(view, ladder, { canPump: false });
    expect(html).toMatch(/<p class="slot-next"[^>]*aria-hidden="true"/);
  });
});

describe('the widths at which a row along the top changes', () => {
  const css = readFileSync(new URL('../src/steps.css', import.meta.url), 'utf8');
  const px = (block: string, name: string): number => {
    const found = new RegExp(`${name}:\\s*([\\d.]+)px`).exec(block);
    if (!found?.[1]) throw new Error(`steps.css: ${name} not found`);
    return Number(found[1]);
  };
  const stage = /\.stage \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const wide = { w: px(stage, '--step-w'), gap: px(stage, '--step-gap'), fade: px(stage, '--step-fade') };
  // The row is its slot less this margin on each side.
  const side = Number(/margin: 0 (\d+)px 8px;/.exec(css)?.[1] ?? Number.NaN);
  const tiers = [...css.matchAll(/@container slot \(max-width: ([\d.]+)px\) \{\s*\.steps \{([^}]*)\}/g)].map(
    (m) => ({ under: Math.ceil(Number(m[1])), rules: m[2] ?? '' }),
  );

  it('finds its three steps down in steps.css', () => {
    expect(Number.isFinite(side)).toBe(true);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]?.rules).toContain('--step-keep: 0');
    expect(tiers[2]?.rules).toContain('display: none');
  });

  it('gives up the passed step under the width that fits passed, current and next', () => {
    // Three steps, two gaps and a fade at each end.
    expect(tiers[0]?.under).toBe(3 * wide.w + 2 * wide.gap + 2 * wide.fade + 2 * side);
  });

  it('goes to smaller steps under the width that fits current and next', () => {
    expect(tiers[1]?.under).toBe(2 * wide.w + wide.gap + 2 * wide.fade + 2 * side);
  });

  it('has no row under the width that fits two of the smaller steps', () => {
    const small = { w: px(tiers[1]?.rules ?? '', '--step-w'), fade: px(tiers[1]?.rules ?? '', '--step-fade') };
    expect(tiers[2]?.under).toBe(2 * small.w + wide.gap + 2 * small.fade + 2 * side);
  });
});
