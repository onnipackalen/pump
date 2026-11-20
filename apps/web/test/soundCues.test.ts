import { describe, expect, it, vi } from 'vitest';
import { cueFor, heightOf, isRealWin } from '../src/sound/cues';
import { marketFor } from '../src/market';
import { balloon } from './fixtures';

describe('cueFor', () => {
  it('plays a win chime only when the payout beats the bet plus Patches', () => {
    const win = balloon({ status: 'cashed', betCents: 100, payoutCents: 101 });
    expect(cueFor({ kind: 'cash-out', balloon: win })?.cue).toBe('win');

    // A 10-cent bet at 1.01x floors to 10 cents: money back, not a win.
    const even = balloon({ status: 'cashed', betCents: 10, payoutCents: 10 });
    expect(cueFor({ kind: 'cash-out', balloon: even })?.cue).toBe('return');

    // Patches count as cost: $1.63 back on $1 + $0.70 of Patches is a loss.
    const patched = balloon({ status: 'cashed', betCents: 100, patchesCents: 70, payoutCents: 163 });
    expect(cueFor({ kind: 'cash-out', balloon: patched })?.cue).toBe('return');
  });

  it('treats reaching the top the same way', () => {
    const top = balloon({ status: 'cashed', rung: 10, betCents: 100, payoutCents: 2500 });
    expect(cueFor({ kind: 'pump', outcome: 'top', balloon: top })?.cue).toBe('top-win');
    const costly = balloon({
      status: 'cashed',
      rung: 10,
      betCents: 100,
      patchesCents: 2400,
      payoutCents: 2500,
    });
    expect(cueFor({ kind: 'pump', outcome: 'top', balloon: costly })?.cue).toBe('return');
  });

  it('gives a pop the quiet pop cue', () => {
    expect(cueFor({ kind: 'pump', outcome: 'popped', balloon: balloon({ status: 'popped' }) })?.cue)
      .toBe('pop');
  });

  it('raises the pump sound as the balloon climbs', () => {
    const low = cueFor({ kind: 'press', balloon: balloon({ rung: 0, topRung: 10 }) });
    const high = cueFor({ kind: 'press', balloon: balloon({ rung: 8, topRung: 10 }) });
    expect(low?.cue).toBe('press');
    expect(high?.height).toBeGreaterThan(low?.height ?? 1);
  });
});

describe('heightOf and isRealWin', () => {
  it('measures height against the balloon’s own top, capped at 1', () => {
    expect(heightOf(balloon({ rung: 5, topRung: 10 }))).toBe(0.5);
    expect(heightOf(balloon({ rung: 11, topRung: 10 }))).toBe(1);
  });

  it('counts a payout equal to the cost as no win', () => {
    expect(isRealWin(balloon({ betCents: 100, patchesCents: 10, payoutCents: 110 }))).toBe(false);
    expect(isRealWin(balloon({ betCents: 100, patchesCents: 10, payoutCents: 111 }))).toBe(true);
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
