import { describe, expect, it } from 'vitest';
import { compare, div, toNumber } from '../../cli/fraction';
import { createRng } from '../../cli/prng';
import { rtpOf } from '../../cli/proof';
import { expectedFor, report, SIM_BETS, simulate, targetWeights } from '../../cli/simulate';
import { DIFFICULTIES, GAME_CONFIG, LIMITS, RTP_BP } from '../../src/config';
import { topRungForBet } from '../../src/math';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];

describe('the simulator’s random numbers', () => {
  it('repeat exactly for the same seed and differ for another', () => {
    const a = createRng(1);
    const b = createRng(1);
    const c = createRng(2);
    const first = Array.from({ length: 8 }, () => a.next());
    expect(Array.from({ length: 8 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 8 }, () => c.next())).not.toEqual(first);
    for (const word of first) {
      expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(true);
    }
  });

  it('roll every value from 0 to den - 1 about equally often', () => {
    const rng = createRng(7);
    for (const den of [2, 3, 7, 101, 111]) {
      const counts = new Array<number>(den).fill(0);
      const rolls = den * 20_000;
      for (let i = 0; i < rolls; i += 1) {
        const roll = rng.below(den);
        counts[roll] = (counts[roll] ?? 0) + 1;
      }
      // Each count should be 20,000 give or take luck; 6 standard deviations is about 850.
      for (const seen of counts) expect(Math.abs(seen - 20_000)).toBeLessThan(900);
    }
  });

  it('refuse a den that is not a whole number from 1 to 2^32', () => {
    const rng = createRng(1);
    expect(() => rng.below(0)).toThrow(RangeError);
    expect(() => rng.below(1.5)).toThrow(RangeError);
    expect(() => rng.below(2 ** 32 + 1)).toThrow(RangeError);
    expect(rng.below(1)).toBe(0);
  });
});

describe('how the simulator plays', () => {
  it('uses bets that can climb every ladder to the top', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (const bet of SIM_BETS) {
        expect(bet).toBeGreaterThanOrEqual(LIMITS.minBetCents);
        expect(topRungForBet(ladder, bet, LIMITS.maxPayoutCents)).toBe(ladder.length);
      }
    }
  });

  it('aims for a rung with twice the multiplier half as often', () => {
    expect(targetWeights([100, 200, 400, 800], 3)).toEqual([10_000_000, 5_000_000, 2_500_000]);
  });
});

describe.each(DIFFICULTIES)('simulating $id', (difficulty) => {
  describe.each(RTPS)('at RTP %i', (rtpBp) => {
    const config = { ...GAME_CONFIG, rtpBp };
    const result = simulate(config, difficulty, 40_000, createRng(11));
    const stats = report(config, difficulty, result);

    it('lands within luck of the exact expected RTP', () => {
      expect(Math.abs(stats.z)).toBeLessThan(4);
      expect(stats.standardError).toBeGreaterThan(0);
    });

    it('expects no more than the RTP, and close to it', () => {
      const expected = expectedFor(config, difficulty);
      const expectedRtp = div(expected.returned, expected.paid);
      expect(compare(expectedRtp, rtpOf(rtpBp))).toBeLessThanOrEqual(0);
      // Cent rounding on these bets costs well under half a point.
      expect(toNumber(rtpOf(rtpBp)) - toNumber(expectedRtp)).toBeLessThan(0.005);
    });

    it('sees every pump survive about as often as its exact chance', () => {
      expect(stats.worstPumpZ).toBeLessThan(5);
      // Pump 1 alone shows the RTP: within 5 standard errors of the configured value.
      const off = Math.abs(stats.pumpOneRtp - rtpBp / 10_000);
      expect(off).toBeLessThan(5 * stats.pumpOneError);
    });

    it('keeps its books: one first pump per balloon, and money that adds up', () => {
      expect(result.rounds).toBe(40_000);
      expect(result.pumps[1]?.attempts).toBe(result.balloons);
      expect(result.balloons).toBeGreaterThanOrEqual(result.rounds);
      expect(result.balloons).toBeLessThanOrEqual(result.rounds * LIMITS.maxBalloons);
      expect(result.paidCents).toBeGreaterThan(0);
      expect(result.hitRounds).toBeLessThanOrEqual(result.rounds);
      expect(result.biggest.payoutCents).toBeLessThanOrEqual(LIMITS.maxPayoutCents);
      for (const pump of result.pumps) expect(pump.survived).toBeLessThanOrEqual(pump.attempts);
    });
  });

  it('gives the same result for the same seed', () => {
    const once = simulate(GAME_CONFIG, difficulty, 2000, createRng(3));
    const again = simulate(GAME_CONFIG, difficulty, 2000, createRng(3));
    expect(again).toEqual(once);
    const other = simulate(GAME_CONFIG, difficulty, 2000, createRng(4));
    expect(other.returnedCents).not.toBe(once.returnedCents);
  });
});
