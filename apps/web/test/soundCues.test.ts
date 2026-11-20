import { describe, expect, it, vi } from 'vitest';
import { cuesFor, heightOf } from '../src/sound/cues';
import { marketFor } from '../src/market';
import { balloon, round } from './fixtures';

const cueNames = (cues: { cue: string }[]) => cues.map((c) => c.cue);

describe('cuesFor', () => {
  it('chimes when a one-balloon round ends in real profit', () => {
    const b = balloon({ status: 'cashed', betCents: 100, payoutCents: 101 });
    expect(cueNames(cuesFor({ kind: 'cash-out', balloon: b, round: round([b]) }))).toEqual(['win']);
  });

  it('never chimes for money back: a 10-cent bet at 1.01x pays 10 cents', () => {
    const b = balloon({ status: 'cashed', betCents: 10, payoutCents: 10 });
    expect(cueNames(cuesFor({ kind: 'cash-out', balloon: b, round: round([b]) }))).toEqual([
      'return',
    ]);
  });

  it('counts Patches as stake', () => {
    const b = balloon({ status: 'cashed', betCents: 100, patchesCents: 70, payoutCents: 163 });
    expect(cueNames(cuesFor({ kind: 'cash-out', balloon: b, round: round([b]) }))).toEqual([
      'return',
    ]);
  });

  it('judges a 2-balloon round as one game (UK RTS 14F)', () => {
    // Balloon 1 popped ($1 lost). Balloon 2 cashes out at 1.5x: +$0.50 on its
    // own, but the round paid $1.50 for $2.00, so no chime.
    const popped = balloon({ status: 'popped', betCents: 100 });
    const cashed = balloon({ status: 'cashed', betCents: 100, payoutCents: 150 });
    const r = round([popped, cashed]);
    expect(r.status).toBe('finished');
    expect(cueNames(cuesFor({ kind: 'cash-out', balloon: r.balloons[1] ?? cashed, round: r }))).toEqual([
      'return',
    ]);
  });

  it('gives a mid-round cash-out a neutral tick, even when that balloon profits', () => {
    const cashed = balloon({ status: 'cashed', betCents: 100, payoutCents: 500 });
    const r = round([cashed, balloon()]);
    expect(r.status).toBe('active');
    expect(cueNames(cuesFor({ kind: 'cash-out', balloon: cashed, round: r }))).toEqual(['return']);
  });

  it('chimes after the pop that ends a round in profit', () => {
    const cashed = balloon({ status: 'cashed', betCents: 100, payoutCents: 500 });
    const popped = balloon({ status: 'popped', betCents: 100 });
    const cues = cuesFor({ kind: 'pump', outcome: 'popped', balloon: popped, round: round([cashed, popped]) });
    expect(cueNames(cues)).toEqual(['pop', 'win']);
    expect(cues[1]?.delay).toBeGreaterThan(0);
  });

  it('gives a pop that ends a losing round only the quiet pop', () => {
    const popped = balloon({ status: 'popped' });
    expect(
      cueNames(cuesFor({ kind: 'pump', outcome: 'popped', balloon: popped, round: round([popped]) })),
    ).toEqual(['pop']);
  });

  it('plays the big chime for a tier 3 win', () => {
    const b = balloon({ status: 'cashed', rung: 10, betCents: 100, payoutCents: 2500 });
    expect(cueNames(cuesFor({ kind: 'pump', outcome: 'top', balloon: b, round: round([b]) }))).toEqual([
      'big-win',
    ]);
  });

  it('raises the pump sound as the balloon climbs', () => {
    const [low] = cuesFor({ kind: 'press', balloon: balloon({ rung: 0, topRung: 10 }) });
    const [high] = cuesFor({ kind: 'press', balloon: balloon({ rung: 8, topRung: 10 }) });
    expect(low?.cue).toBe('press');
    expect(high?.height).toBeGreaterThan(low?.height ?? 1);
  });
});

describe('heightOf', () => {
  it('measures height against the balloon’s own top, capped at 1', () => {
    expect(heightOf(balloon({ rung: 5, topRung: 10 }))).toBe(0.5);
    expect(heightOf(balloon({ rung: 11, topRung: 10 }))).toBe(1);
  });
});

describe('marketFor', () => {
  it('turns auto-play off for Great Britain, however it is written', () => {
    for (const id of ['gb', 'GB', ' gb ', 'uk', 'UK']) {
      expect(marketFor(id).autoPlay).toBe(false);
    }
  });

  it('keeps auto-play on for the default market', () => {
    expect(marketFor('default').autoPlay).toBe(true);
    expect(marketFor(undefined).autoPlay).toBe(true);
    expect(marketFor('').autoPlay).toBe(true);
  });

  it('fails closed for a market it does not know', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(marketFor('nowhere').autoPlay).toBe(false);
    expect(marketFor('toString').autoPlay).toBe(false);
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});
