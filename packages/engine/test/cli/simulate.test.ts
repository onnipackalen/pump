import { describe, expect, it } from 'vitest';
import { compare, div, toNumber } from '../../cli/fraction';
import { createRng } from '../../cli/prng';
import { rtpOf } from '../../cli/proof';
import {
  climbPlay,
  expectedFor,
  PASS_MARK,
  REAL_ENGINE,
  report,
  SIM_BETS,
  simulate,
  SPREAD,
  targetWeights,
  type EnginePort,
} from '../../cli/simulate';
import { DIFFICULTIES, GAME_CONFIG, LIMITS, RTP_BP } from '../../src/config';
import { topRungForBet } from '../../src/math';
import { FIXED_DIFFICULTIES, fixedConfig } from '../fixtures';

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
  it('uses legal bets that can reach at least the first rung of every ladder', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (const bet of [...SIM_BETS, ...climbPlay(GAME_CONFIG).bets]) {
        expect(bet).toBeGreaterThanOrEqual(LIMITS.minBetCents);
        expect(bet).toBeLessThanOrEqual(LIMITS.maxBetCents);
        expect(topRungForBet(ladder, bet, LIMITS.maxPayoutCents)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('aims for a rung with twice the multiplier half as often', () => {
    expect(targetWeights([100, 200, 400, 800], 3)).toEqual([10_000_000, 5_000_000, 2_500_000]);
  });

  it('climbs with the smallest bet, an odd one and the largest, a Patch every time', () => {
    expect(climbPlay(GAME_CONFIG)).toEqual({
      bets: [LIMITS.minBetCents, 1234, LIMITS.maxBetCents],
      patchOneIn: 1,
      aim: 'top',
    });
  });
});

describe.each(DIFFICULTIES)('simulating $id', (difficulty) => {
  describe.each(RTPS)('at RTP %i', (rtpBp) => {
    const config = { ...GAME_CONFIG, rtpBp };
    const result = simulate(config, difficulty, 40_000, createRng(11));
    const stats = report(config, difficulty, result);

    it('finds the engine doing exactly what the rules say, every time', () => {
      expect(result.mismatches).toEqual({
        chances: 0,
        rolls: 0,
        outcomes: 0,
        payouts: 0,
        patchPrices: 0,
        topRungs: 0,
        first: '',
      });
      expect(stats.exact).toBe(true);
    });

    it('lands within luck of the exact expected RTP', () => {
      expect(Math.abs(stats.z)).toBeLessThan(4);
      expect(stats.standardError).toBeGreaterThan(0);
    });

    // The exact expectation takes seconds on a ladder of 80 rungs or more,
    // so it gets a longer time limit.
    it('expects no more than the RTP, and close to it', () => {
      const expected = expectedFor(config, difficulty);
      const expectedRtp = div(expected.returned, expected.paid);
      expect(compare(expectedRtp, rtpOf(rtpBp))).toBeLessThanOrEqual(0);
      // Cent rounding on these bets costs well under half a point.
      expect(toNumber(rtpOf(rtpBp)) - toNumber(expectedRtp)).toBeLessThan(0.005);
    }, 60_000);

    it('sees every pump survive about as often as its exact chance', () => {
      expect(stats.worstPumpZ).toBeLessThan(5);
      // Pump 1 alone shows the RTP: within 5 standard errors of the configured value.
      expect(stats.pumpOneZ).toBeLessThan(5);
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
      expect(result.payouts).toBeLessThanOrEqual(result.balloons);
      expect(result.biggest.payoutCents).toBeLessThanOrEqual(LIMITS.maxPayoutCents);
      for (const pump of result.pumps) expect(pump.survived).toBeLessThanOrEqual(pump.attempts);
    });

    it('climbs to the top: every balloon that survives pump 1 gets there', () => {
      const way = climbPlay(config);
      const up = simulate(config, difficulty, 1500, createRng(5), way);
      const climbed = report(config, difficulty, up, way);
      expect(climbed.exact).toBe(true);
      expect(up.topsReached).toBe(up.pumps[1]?.survived);
      expect(up.payouts).toBe(up.topsReached);
      expect(up.topsReached).toBeGreaterThan(0);
      expect(Math.abs(climbed.z)).toBeLessThan(4);
      expect(climbed.worstPumpZ).toBeLessThan(5);
      expect(compare(climbed.expectedRtp, rtpOf(rtpBp))).toBeLessThanOrEqual(0);
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

describe('the climb on a ladder that goes past the payout cap', () => {
  // On the fixed Expert ladder the largest bet stops at rung 6 of 10.
  const config = fixedConfig(9700);
  const expert = FIXED_DIFFICULTIES.find((d) => d.id === 'expert');
  if (expert === undefined) throw new Error('no fixed expert ladder');
  const way = climbPlay(config);
  const up = simulate(config, expert, 3000, createRng(9), way);

  it('ends capped balloons on their own top rung, paid to the cent', () => {
    expect(up.cappedBalloons).toBeGreaterThan(0);
    expect(up.cappedBalloons).toBeLessThan(up.balloons);
    expect(up.topsReached).toBe(up.pumps[1]?.survived);
    // Exact means every one of them was paid the rules' amount on the rules'
    // top rung: $47,500 on rung 6 for the capped $1,000 bet.
    expect(report(config, expert, up, way).exact).toBe(true);
    // The largest win is not the largest bet: $12.34 climbs all 10 rungs to 5,000x.
    expect(up.biggest).toEqual({ payoutCents: 6_170_000, betCents: 1234, rung: 10 });
  });
});

describe('the simulator catches an engine that is wrong', () => {
  // Each engine below is the real one with one thing changed. A simulator that
  // took its yardsticks from the engine would pass all of them.
  const config = fixedConfig(9700);
  const easy = FIXED_DIFFICULTIES.find((d) => d.id === 'easy');
  const expert = FIXED_DIFFICULTIES.find((d) => d.id === 'expert');
  if (easy === undefined || expert === undefined) throw new Error('no fixed ladders');
  const run = (engine: EnginePort, difficulty = easy, rounds = 20_000) => {
    const result = simulate(config, difficulty, rounds, createRng(2), SPREAD, engine);
    return { result, stats: report(config, difficulty, result) };
  };

  it('passes the real engine', () => {
    const { result, stats } = run(REAL_ENGINE);
    expect(stats.exact).toBe(true);
    expect(result.mismatches.first).toBe('');
  });

  it('a payout one cent too high', () => {
    const engine: EnginePort = {
      ...REAL_ENGINE,
      cashOut: (round, request) => {
        const real = REAL_ENGINE.cashOut(round, request);
        return { ...real, payoutCents: real.payoutCents + 1 };
      },
    };
    const { result, stats } = run(engine);
    expect(stats.exact).toBe(false);
    expect(result.mismatches.payouts).toBeGreaterThan(0);
    expect(result.mismatches.first).toMatch(/cashing out .* the rules give/);
  });

  it('a Patch charged one cent too little', () => {
    const engine: EnginePort = {
      ...REAL_ENGINE,
      pump: (round, request, draw) => {
        const real = REAL_ENGINE.pump(round, request, draw);
        const charged = real.patchChargedCents;
        return { ...real, patchChargedCents: charged === null ? null : charged - 1 };
      },
    };
    const { result, stats } = run(engine);
    expect(stats.exact).toBe(false);
    expect(result.mismatches.patchPrices).toBeGreaterThan(0);
    expect(result.mismatches.payouts).toBe(0);
  });

  it('pumps drawn at an RTP five points too low', () => {
    const engine: EnginePort = {
      ...REAL_ENGINE,
      pump: (round, request, draw) => {
        const real = REAL_ENGINE.pump({ ...round, rtpBp: round.rtpBp - 500 }, request, draw);
        return { ...real, round: { ...real.round, rtpBp: round.rtpBp } };
      },
    };
    const { result, stats } = run(engine, easy, 60_000);
    // Caught exactly, on the first draw...
    expect(stats.exact).toBe(false);
    expect(result.mismatches.chances).toBe(result.pumps[1]?.attempts);
    expect(result.mismatches.first).toBe('pump 1 was drawn at 92/101, the rules give 97/101');
    // ...and by counting: the RTP, the pump counts and pump 1 alone are all
    // past the mark npm run sim fails at.
    expect(Math.abs(stats.z)).toBeGreaterThan(PASS_MARK);
    expect(stats.worstPumpZ).toBeGreaterThan(PASS_MARK);
    expect(stats.pumpOneZ).toBeGreaterThan(PASS_MARK);
  });

  it('a roll swapped on a pump the main run hardly ever plays', () => {
    // An unpatched pump onto the top rung always pops: the engine plays and
    // records den - 1, whatever roll it was handed. Its record agrees with
    // what it did, so only the roll it was handed gives it away.
    const engine: EnginePort = {
      ...REAL_ENGINE,
      pump: (round, request, draw) => {
        const balloon = round.balloons[request.balloonIndex];
        if (request.patch || balloon === undefined || balloon.rung + 1 !== balloon.topRung) {
          return REAL_ENGINE.pump(round, request, draw);
        }
        return REAL_ENGINE.pump(round, request, (den) => {
          draw(den);
          return den - 1;
        });
      },
    };
    const { result, stats } = run(engine);
    // A handful of pumps in the run go this way, and each one is caught...
    expect(stats.exact).toBe(false);
    expect(result.mismatches.rolls).toBeGreaterThan(0);
    expect(result.mismatches.outcomes).toBe(0);
    expect(result.mismatches.first).toMatch(
      /^pump 24 recorded roll 124 below 125, it was handed \d+ below 125$/,
    );
    // ...but they are far too few to show in the counts.
    expect(Math.abs(stats.z)).toBeLessThan(PASS_MARK);
    expect(stats.worstPumpZ).toBeLessThan(PASS_MARK);
  });

  it('two draws for one pump', () => {
    // Every pump draws twice and plays the second roll. That roll is as
    // random as the first, so no count can see it, but the draws can.
    const engine: EnginePort = {
      ...REAL_ENGINE,
      pump: (round, request, draw) =>
        REAL_ENGINE.pump(round, request, (den) => {
          draw(den);
          return draw(den);
        }),
    };
    const { result, stats } = run(engine);
    expect(stats.exact).toBe(false);
    const pumps = result.pumps.reduce((sum, pump) => sum + pump.attempts, 0);
    expect(result.mismatches.rolls).toBe(pumps);
    expect(result.mismatches.first).toBe('pump 1 made 2 draws, the rules give 1');
    expect(Math.abs(stats.z)).toBeLessThan(PASS_MARK);
    expect(stats.worstPumpZ).toBeLessThan(PASS_MARK);
  });

  it('a top rung one too low', () => {
    const engine: EnginePort = {
      ...REAL_ENGINE,
      startRound: (given, difficultyId, bets, balance) => {
        const limits = { ...given.limits, maxPayoutCents: given.limits.maxPayoutCents - 1 };
        return REAL_ENGINE.startRound({ ...given, limits }, difficultyId, bets, balance);
      },
    };
    // On the fixed Expert ladder a $20 bet reaches the cap exactly on the last rung.
    const { result, stats } = run(engine, expert);
    expect(stats.exact).toBe(false);
    expect(result.mismatches.topRungs).toBeGreaterThan(0);
    expect(result.mismatches.first).toBe(
      'a bet of 2000 cents got top rung 9, the rules give 10',
    );
  });
});
