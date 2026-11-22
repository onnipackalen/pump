import {
  cashOutCents,
  GAME_CONFIG,
  multiplierAt,
  patchPriceCents,
  popChance,
  topRungForBet,
} from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView } from '../src/api/contract';
import { BalloonCard, chanceWords } from '../src/components/BalloonCard';
import { RoundControls } from '../src/components/RoundControls';
import { formatCents, formatChance } from '../src/money';
import { balloon, BASE } from './fixtures';

/*
 * The brief asks every balloon to show the chance its next pump pops it and
 * the Patch price. Each balloon in play says both in one quiet line under
 * its amount, with the same words the control panel uses for the picked
 * balloon, during auto-play too.
 */

const RTPS = [9400, 9700, 9900];
const { limits } = GAME_CONFIG;

/** A balloon in play on `rung`, as the server would send it. */
function inPlay(ladder: readonly number[], rtpBp: number, betCents: number, rung: number): BalloonView {
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
      // No Patch for the first pump.
      patchPriceCents: rung === 0 ? null : patchPriceCents(rtpBp, ladder, betCents, rung + 1),
    },
  });
}

/** The card as auto-play draws it: quiet, with no Pump button of its own. */
function card(view: BalloonView, ladder: readonly number[], rtpBp: number): string {
  return renderToStaticMarkup(
    createElement(BalloonCard, {
      balloon: view,
      rtpBp,
      ladder,
      difficultyId: BASE.id,
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
      onSelect: () => undefined,
      canPump: false,
      onPump: () => undefined,
      onPumpHold: () => undefined,
      afterRoundShown: false,
    }),
  );
}

/** The control panel with `view` picked. */
function panel(view: BalloonView): string {
  return renderToStaticMarkup(
    createElement(RoundControls, {
      balloon: view,
      balloons: [view],
      multi: false,
      pending: false,
      activity: ['free'],
      onPump: () => undefined,
      onPumpHold: () => undefined,
      onPatchPump: () => undefined,
      onCashOut: () => undefined,
      onCashOutAll: () => undefined,
      liveCount: 1,
      onPumpAll: () => undefined,
      onPumpAllHold: () => undefined,
    }),
  );
}

/** The text of the card's quiet line, at each length. */
function chanceLine(html: string): string | null {
  return /<span class="slot-chance".*?<\/span><\/span>/s.exec(html)?.[0] ?? null;
}

describe('the pop chance and Patch price on every balloon', () => {
  for (const rtpBp of RTPS) {
    for (const difficulty of GAME_CONFIG.difficulties) {
      const { ladder } = difficulty;
      it(`shows the panel's own numbers at RTP ${rtpBp}, ${difficulty.id}`, () => {
        for (const betCents of [limits.minBetCents, 100, 12_345]) {
          const top = topRungForBet(ladder, betCents, limits.maxPayoutCents);
          for (const rung of [0, 1, Math.min(2, top - 1)]) {
            if (rung >= top) continue;
            const view = inPlay(ladder, rtpBp, betCents, rung);
            const pop = formatChance(popChance(rtpBp, ladder, rung + 1));
            const words = chanceWords(view);
            if (rung === 0) {
              // Before the first pump: no Patch yet.
              expect(words).toEqual({ full: `${pop} pop`, short: `${pop} pop`, tiny: `${pop} pop` });
            } else {
              const price = formatCents(patchPriceCents(rtpBp, ladder, betCents, rung + 1));
              expect(words).toEqual({
                full: `${pop} pop · Patch ${price}`,
                short: `${pop} · Patch ${price}`,
                tiny: `${pop} · ${price}`,
              });
              // The panel says the same price on its Patch + Pump button.
              expect(panel(view)).toContain(price);
            }
            // The panel's Pop chance reads the same.
            expect(panel(view)).toContain(`<dd>${pop}</dd>`);
            // The card draws it while auto-play runs (quiet, no Pump button).
            const line = chanceLine(card(view, ladder, rtpBp));
            expect(line).not.toBeNull();
            expect(line).toContain(words?.full ?? 'missing');
          }
        }
      });
    }
  }

  it('says nothing once the balloon is over', () => {
    const ladder = BASE.ladder;
    const live = inPlay(ladder, GAME_CONFIG.rtpBp, 100, 2);
    for (const status of ['popped', 'cashed', 'refunded'] as const) {
      const over: BalloonView = { ...live, status };
      expect(chanceWords(over)).toBeNull();
      expect(chanceLine(card(over, ladder, GAME_CONFIG.rtpBp))).toBeNull();
    }
    // A balloon in play with no next pump (at its top) has nothing to say.
    expect(chanceWords({ ...live, next: null })).toBeNull();
  });

  it('fits three balloons on a narrow phone: the narrow forms are shorter', () => {
    const view = inPlay(BASE.ladder, GAME_CONFIG.rtpBp, 100, 2);
    const words = chanceWords(view);
    expect(words).not.toBeNull();
    if (!words) return;
    expect(words.short.length).toBeLessThan(words.full.length);
    expect(words.tiny.length).toBeLessThan(words.short.length);
  });
});
