/**
 * Three small fixes from a critique of the bet and auto-play panels:
 * (a) the info line shows the top the entered bets can reach, not the
 *     ladder's when the payout cap holds a bet lower;
 * (b) a mouse press on ½ or 2× doesn't take focus, so Enter still bets;
 * (c) auto-play's pump count says what it reaches on the chosen difficulty.
 */
import { GAME_CONFIG, multiplierAt, popChance, topRungForBet, type GameConfig } from '@pump/engine';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { BetPanel, shownTopRung } from '../src/components/BetPanel';
import { pumpReach, targetMultiplier } from '../src/game/autoPlay';
import { checkBets, type BetSetup } from '../src/game/betSetup';
import { centsToInput, formatChance, formatMultiplier } from '../src/money';

const RTPS = [9400, 9700, 9900] as const;
const { limits } = GAME_CONFIG;

/** A difficulty whose ladder the largest bet can't climb to the top. */
const capped = GAME_CONFIG.difficulties.find(
  (d) => topRungForBet(d.ladder, limits.maxBetCents, limits.maxPayoutCents) < d.ladder.length,
);

function panel(config: GameConfig, setup: BetSetup) {
  return {
    config,
    setup,
    check: checkBets(setup, config.limits, 100_000_000),
    disabled: false,
    starting: false,
    showBet: true,
    onChange: () => undefined,
    onStart: () => undefined,
  };
}

/** The text of the info line under the balloon count. */
function infoLine(html: string): string {
  const match = /<p class="note bet-info"[^>]*>(.*?)<\/p>/.exec(html);
  return (match?.[1] ?? '').replace(/<[^>]+>/g, '');
}

describe('(a) shownTopRung: the top for the bets entered', () => {
  it('is the ladder top with no bet entered yet', () => {
    const ladder = capped?.ladder ?? [];
    expect(shownTopRung(ladder, [], limits.maxPayoutCents)).toBe(ladder.length);
    expect(shownTopRung(ladder, [null], limits.maxPayoutCents)).toBe(ladder.length);
  });

  it('is the capped top for one bet the cap holds lower', () => {
    expect(capped).toBeDefined();
    const ladder = capped?.ladder ?? [];
    const top = topRungForBet(ladder, limits.maxBetCents, limits.maxPayoutCents);
    expect(shownTopRung(ladder, [limits.maxBetCents], limits.maxPayoutCents)).toBe(top);
  });

  it('is the highest any entered bet can reach', () => {
    const ladder = capped?.ladder ?? [];
    expect(
      shownTopRung(ladder, [limits.maxBetCents, limits.minBetCents], limits.maxPayoutCents),
    ).toBe(ladder.length);
  });
});

describe.each(RTPS)('(a) the info line at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };

  it('shows the capped top, and its pump count, for a capped bet', () => {
    const difficulty = capped;
    if (!difficulty) throw new Error('no capped difficulty');
    const top = topRungForBet(difficulty.ladder, limits.maxBetCents, limits.maxPayoutCents);
    const html = renderToStaticMarkup(
      createElement(
        BetPanel,
        panel(config, { difficultyId: difficulty.id, bets: [centsToInput(limits.maxBetCents)] }),
      ),
    );
    const line = infoLine(html);
    expect(line).toContain(`${top} pumps`);
    expect(line).toContain(`top ${formatMultiplier(multiplierAt(difficulty.ladder, top))}`);
    expect(line).not.toContain(
      formatMultiplier(multiplierAt(difficulty.ladder, difficulty.ladder.length)),
    );
    expect(line).toContain(formatChance(popChance(rtpBp, difficulty.ladder, 1)));
  });

  it('shows the full top for a bet the cap does not reach', () => {
    for (const difficulty of config.difficulties) {
      const html = renderToStaticMarkup(
        createElement(BetPanel, panel(config, { difficultyId: difficulty.id, bets: ['1.00'] })),
      );
      const n = difficulty.ladder.length;
      expect(infoLine(html)).toContain(
        `${n} pumps · top ${formatMultiplier(multiplierAt(difficulty.ladder, n))}`,
      );
    }
  });
});

/** Every element in a tree, depth first. */
function* elements(node: ReactNode): Generator<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) yield* elements(child);
    return;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return;
  yield { type: node.type, props: node.props };
  yield* elements(node.props.children as ReactNode);
}

describe('(b) ½ and 2× keep focus off themselves', () => {
  it('stops a mouse press from focusing them, as HoldButton does', () => {
    // BetPanel has no hooks, so it can be called to get its element tree.
    const tree = BetPanel(panel(GAME_CONFIG, { difficultyId: 'easy', bets: ['1.00', '2.00'] }));
    const scalers = [...elements(tree)].filter(
      (e) => e.type === 'button' && /^(Halve|Double) bet \d$/.test(String(e.props['aria-label'])),
    );
    expect(scalers).toHaveLength(4);
    for (const button of scalers) {
      const preventDefault = vi.fn();
      const onMouseDown = button.props.onMouseDown as (event: { preventDefault: () => void }) => void;
      onMouseDown({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });
});

describe('(c) targetMultiplier: what the pump count reaches', () => {
  it('is the multiplier at that rung of the chosen ladder', () => {
    for (const difficulty of GAME_CONFIG.difficulties) {
      for (let n = 1; n <= difficulty.ladder.length; n += 1) {
        expect(targetMultiplier(difficulty.ladder, n)).toBe(multiplierAt(difficulty.ladder, n));
      }
    }
  });

  it('is nothing for a count the ladder does not have', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    expect(targetMultiplier(ladder, 0)).toBeNull();
    expect(targetMultiplier(ladder, ladder.length + 1)).toBeNull();
    expect(targetMultiplier(ladder, 1.5)).toBeNull();
  });
});

describe('(c) pumpReach: what the count reaches at the bets entered', () => {
  it('within the top: the multiplier at that rung, on every count of every difficulty', () => {
    for (const d of GAME_CONFIG.difficulties) {
      for (let n = 1; n <= d.ladder.length; n += 1) {
        const x = formatMultiplier(multiplierAt(d.ladder, n));
        expect(pumpReach(d.ladder, n, d.ladder.length, d.label)).toEqual({
          short: `= ${x}`,
          full: `${n} pumps = ${x} on ${d.label}`,
          toppedOut: false,
        });
      }
    }
  });

  it('past the top the max payout holds a bet to: says the top, never a higher multiplier', () => {
    for (const d of GAME_CONFIG.difficulties) {
      const top = topRungForBet(d.ladder, limits.maxBetCents, limits.maxPayoutCents);
      for (let n = 1; n <= d.ladder.length; n += 1) {
        const reach = pumpReach(d.ladder, n, top, d.label);
        const shown = formatMultiplier(multiplierAt(d.ladder, Math.min(n, top)));
        expect(reach?.toppedOut).toBe(n > top);
        expect(reach?.short).toBe(n > top ? `top ${top} = ${shown}` : `= ${shown}`);
        if (n > top) {
          expect(reach?.full).toContain(`tops out at ${top} pumps = ${shown} on ${d.label}`);
          expect(reach?.short).not.toContain(formatMultiplier(multiplierAt(d.ladder, n)));
        }
      }
    }
  });

  it('is nothing for a count the ladder does not have', () => {
    const d = GAME_CONFIG.difficulties[0];
    if (!d) throw new Error('no difficulty');
    expect(pumpReach(d.ladder, 0, d.ladder.length, d.label)).toBeNull();
    expect(pumpReach(d.ladder, d.ladder.length + 1, d.ladder.length, d.label)).toBeNull();
  });
});

describe('(c) the auto-play panel says what the pump count reaches', () => {
  const props = (difficulty: (typeof GAME_CONFIG.difficulties)[number], topRung: number) => ({
    ladder: difficulty.ladder,
    topRung,
    difficultyLabel: difficulty.label,
    roundBetCents: 100,
    betsValid: true,
    limits,
    betSizing: true,
    roundActive: false,
    starting: false,
    status: {
      running: false,
      stopping: false,
      settings: null,
      progress: { roundsPlayed: 0, netCents: 0 },
      bets: null,
      handCashOuts: null,
      stopReason: null,
    },
    round: null,
    onStart: () => undefined,
    onStop: () => undefined,
    onCashOut: () => undefined,
  });
  /** The line under the Pumps box, as seen (the hidden full text left out). */
  const reachLine = (html: string): string => {
    const match = /<span class="field-reach"[^>]*><span aria-hidden="true">(.*?)<\/span>/.exec(html);
    return match?.[1] ?? '';
  };

  it('under the Pumps box, not in it, for the 3 pumps the form starts with', () => {
    for (const difficulty of GAME_CONFIG.difficulties) {
      const html = renderToStaticMarkup(
        createElement(AutoPlayPanel, props(difficulty, difficulty.ladder.length)),
      );
      const reach = formatMultiplier(multiplierAt(difficulty.ladder, 3));
      expect(reachLine(html)).toBe(`= ${reach}`);
      // In full for the tooltip and screen readers.
      expect(html).toContain(`3 pumps = ${reach} on ${difficulty.label}`);
      // The Pumps box holds its name and the count only, so the count has room.
      const box = /<label class="field" title="Pumps per balloon[^"]*">(.*?)<\/label>/.exec(html);
      expect(box?.[1]).toBeDefined();
      expect(box?.[1]).not.toContain('field-reach');
    }
  });

  it('says the top when the bets top out below the count', () => {
    const difficulty = GAME_CONFIG.difficulties[0];
    if (!difficulty) throw new Error('no difficulty');
    const html = renderToStaticMarkup(createElement(AutoPlayPanel, props(difficulty, 2)));
    expect(reachLine(html)).toBe(`top 2 = ${formatMultiplier(multiplierAt(difficulty.ladder, 2))}`);
    expect(html).toContain('data-top="true"');
  });
});
