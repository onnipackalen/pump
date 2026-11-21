import { GAME_CONFIG } from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView } from '../src/api/contract';
import { BalloonCard } from '../src/components/BalloonCard';
import { afterRoundLine, afterRoundText, twoLineChars } from '../src/game/afterRound';
import { balloon } from './fixtures';

/** A balloon cashed out on rung 2 of 10, whose reveal says `afterRound`. */
function cashed(afterRound: BalloonView['afterRound']): BalloonView {
  return balloon({ status: 'cashed', rung: 2, drawIndex: 3, topRung: 10, afterRound });
}

describe('the words for where a balloon would have popped', () => {
  it('says the next pump would have popped when it pops on the cash-out rung', () => {
    expect(afterRoundText(2, 'popped', 2, 137)).toBe('Next pump would have popped');
  });

  it('says how high it would have got before it popped', () => {
    expect(afterRoundText(2, 'popped', 5, 137)).toBe('Would have reached 1.37×, then popped');
  });

  it('says it would have reached the top, with the top multiplier', () => {
    expect(afterRoundText(2, 'top', 10, 2500)).toBe('Would have reached the top (25.00×)');
  });

  it('never names money', () => {
    const lines = [
      afterRoundText(2, 'popped', 2, 137),
      afterRoundText(2, 'popped', 5, 137),
      afterRoundText(2, 'top', 10, 500000),
    ];
    for (const line of lines) expect(line).not.toMatch(/\$|cent|paid|win|lost/i);
  });
});

describe('the line under a balloon', () => {
  it('is said for a cashed-out balloon with a reveal', () => {
    const reveal = { outcome: 'popped', reachedRung: 4, reachedMultiplierHundredths: 153 } as const;
    expect(afterRoundLine(cashed(reveal))).toBe('Would have reached 1.53×, then popped');
  });

  it('is never said for a balloon that did not cash out, whatever it carries', () => {
    const stray = { outcome: 'top', reachedRung: 10, reachedMultiplierHundredths: 2500 } as const;
    for (const status of ['active', 'popped', 'refunded'] as const) {
      expect(afterRoundLine(balloon({ status, rung: 2, afterRound: stray }))).toBeNull();
    }
  });

  it('is not said for a cashed-out balloon with no reveal (cashed at its top)', () => {
    expect(afterRoundLine(balloon({ status: 'cashed', rung: 10, topRung: 10 }))).toBeNull();
  });

  it('reads an answer stored before reveals existed as having none', () => {
    const old = cashed(null);
    Reflect.deleteProperty(old, 'afterRound');
    expect('afterRound' in old).toBe(false);
    expect(afterRoundLine(old)).toBeNull();
  });
});

describe('twoLineChars', () => {
  it('is the longer line of the most even two-line split', () => {
    expect(twoLineChars('Would have reached 1.37×, then popped')).toBe(18);
    expect(twoLineChars('Would have reached the top (25.00×)')).toBe(18);
    expect(twoLineChars('Next pump would have popped')).toBe(15);
    expect(twoLineChars('Popped')).toBe(6);
  });
});

describe('BalloonCard', () => {
  const reveal = { outcome: 'top', reachedRung: 10, reachedMultiplierHundredths: 2500 } as const;
  const text = 'Would have reached the top (25.00×)';

  function render(view: BalloonView, afterRoundShown: boolean, canPump = false): string {
    return renderToStaticMarkup(
      createElement(BalloonCard, {
        balloon: view,
        rtpBp: GAME_CONFIG.rtpBp,
        // Any rising ladder with 10 rungs: the card only sizes the art from it.
        ladder: Array.from({ length: 10 }, (_, i) => 200 + 100 * i),
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
        canPump,
        onPump: () => undefined,
        onPumpHold: () => undefined,
        afterRoundShown,
      }),
    );
  }

  it('shows the line in the Pump row once the round is over and still', () => {
    const html = render(cashed(reveal), true);
    expect(html).toContain('class="slot-after"');
    expect(html).toContain(text);
  });

  it('shows nothing while the round is in progress or still moving', () => {
    expect(render(cashed(reveal), false)).not.toContain('slot-after');
  });

  it('never shows the line next to a Pump button', () => {
    const html = render(balloon({ rung: 2, afterRound: reveal }), true, true);
    expect(html).toContain('Pump');
    expect(html).not.toContain('slot-after');
  });
});
