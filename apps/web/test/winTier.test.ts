import { describe, expect, it } from 'vitest';
import { roundWinTier, WIN_TIER_MULTIPLES } from '../src/game/winTier';
import { balloon, round } from './fixtures';

const finished = (payoutCents: number, betCents = 100, patchesCents = 0) =>
  round([balloon({ status: 'cashed', betCents, patchesCents, payoutCents })]);

describe('roundWinTier', () => {
  it('is null for a round still in play', () => {
    expect(roundWinTier(round([balloon()]))).toBeNull();
  });

  it('is null when the payout is at or below the stake', () => {
    expect(roundWinTier(finished(100))).toBeNull();
    expect(roundWinTier(finished(99))).toBeNull();
    expect(roundWinTier(finished(110, 100, 10))).toBeNull();
  });

  it('starts tier 1 one cent above the stake', () => {
    expect(roundWinTier(finished(101))).toBe(1);
    expect(roundWinTier(finished(111, 100, 10))).toBe(1);
  });

  it('moves up at the configured multiples of the stake, compared in cents', () => {
    const stake = 110;
    expect(roundWinTier(finished(WIN_TIER_MULTIPLES.tier2 * stake - 1, 100, 10))).toBe(1);
    expect(roundWinTier(finished(WIN_TIER_MULTIPLES.tier2 * stake, 100, 10))).toBe(2);
    expect(roundWinTier(finished(WIN_TIER_MULTIPLES.tier3 * stake - 1, 100, 10))).toBe(2);
    expect(roundWinTier(finished(WIN_TIER_MULTIPLES.tier3 * stake, 100, 10))).toBe(3);
  });

  it('judges all balloons together', () => {
    const r = round([
      balloon({ status: 'popped', betCents: 100 }),
      balloon({ status: 'cashed', betCents: 100, payoutCents: 150 }),
    ]);
    expect(roundWinTier(r)).toBeNull();
  });
});
