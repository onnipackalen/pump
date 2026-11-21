/**
 * Two small fixes from a critique of the bet panel:
 * (a) the info line shows the top the entered bets can reach, not the
 *     ladder's when the payout cap holds a bet lower;
 * (b) a mouse press on ½ or 2× doesn't take focus, so Enter still bets.
 */
import { GAME_CONFIG, multiplierAt, popChance, topRungForBet, type GameConfig } from '@pump/engine';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BetPanel, shownTopRung } from '../src/components/BetPanel';
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
