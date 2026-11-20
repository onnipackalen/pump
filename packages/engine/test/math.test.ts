import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, GAME_CONFIG, LIMITS, RTP_BP } from '../src/config';
import {
  assertValidConfig,
  cashOutCents,
  configProblems,
  ladderProblems,
  multiplierAt,
  patchPriceCents,
  popChance,
  pumpSurvives,
  surviveChance,
  topRungForBet,
} from '../src/math';
import { fixedConfig, fixedLadder } from './fixtures';

// These tests redo the arithmetic in their own BigInt code, so that a mistake
// in math.ts cannot hide behind the same mistake in a test.

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];

// Exact numbers are pinned against the fixed ladders in fixtures.ts, so tuning
// the live ladders never touches them. The live ladders are covered by every
// test that loops over DIFFICULTIES or uses GAME_CONFIG.
const ladderOf = fixedLadder;

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/** Bets to sweep: every cent up to $30, then steps that miss round numbers, then the limits. */
const BETS: readonly number[] = [
  ...Array.from({ length: 2991 }, (_, i) => i + 10),
  ...Array.from({ length: 1000 }, (_, i) => 3001 + i * 97),
  10_000,
  99_999,
  100_000,
];

/** The exact Patch price for pump `pump` as [top, bottom] in cents, before rounding. */
function exactPatchPrice(
  rtpBp: number,
  ladder: readonly number[],
  bet: number,
  pump: number,
): [bigint, bigint] {
  const current = BigInt(multiplierAt(ladder, pump - 1));
  const next = BigInt(multiplierAt(ladder, pump));
  return [BigInt(bet) * current * (next - current) * 100n, next * BigInt(rtpBp)];
}

describe('surviveChance and popChance', () => {
  it('match the worked examples at 9700', () => {
    expect(surviveChance(9700, ladderOf('easy'), 1)).toEqual({ num: 97, den: 101 });
    expect(surviveChance(9700, ladderOf('easy'), 2)).toEqual({ num: 101, den: 111 });
    expect(surviveChance(9700, ladderOf('easy'), 3)).toEqual({ num: 37, den: 41 });
    expect(surviveChance(9700, ladderOf('expert'), 10)).toEqual({ num: 1, den: 4 });
    expect(popChance(9700, ladderOf('easy'), 2)).toEqual({ num: 10, den: 111 });
  });

  it('only pump 1 depends on the RTP', () => {
    expect(surviveChance(9400, ladderOf('easy'), 1)).toEqual({ num: 94, den: 101 });
    expect(surviveChance(9900, ladderOf('easy'), 1)).toEqual({ num: 99, den: 101 });
    for (let pump = 2; pump <= ladderOf('easy').length; pump += 1) {
      expect(surviveChance(9400, ladderOf('easy'), pump)).toEqual(
        surviveChance(9900, ladderOf('easy'), pump),
      );
    }
  });

  it('refuses an RTP at or above the first multiplier, and rungs off the ladder', () => {
    expect(() => surviveChance(10_100, ladderOf('easy'), 1)).toThrow(RangeError);
    expect(() => surviveChance(9700, ladderOf('easy'), 0)).toThrow(RangeError);
    expect(() => surviveChance(9700, ladderOf('easy'), 25)).toThrow(RangeError);
    expect(() => multiplierAt(ladderOf('easy'), 0)).toThrow(RangeError);
  });

  it('refuses a chance whose denominator would not fit one 32-bit roll', () => {
    // 2^32 + 1 shares no factor with 150, so the fraction cannot be reduced.
    expect(() => surviveChance(9700, [150, 4_294_967_297], 2)).toThrow(RangeError);
    // Exactly 2^32 is refused too; one below it is the largest allowed.
    expect(() => surviveChance(9700, [101, 4_294_967_296], 2)).toThrow(RangeError);
    expect(surviveChance(9700, [101, 4_294_967_295], 2)).toEqual({
      num: 101,
      den: 4_294_967_295,
    });
  });

  describe.each(DIFFICULTIES)('$id', ({ ladder }) => {
    it.each(RTPS)('every cash-out point returns exactly the RTP at %i', (rtpBp) => {
      // Chance to reach rung k = product of the pump chances. Times m_k it must be R.
      let reachNum = 1n;
      let reachDen = 1n;
      for (let rung = 1; rung <= ladder.length; rung += 1) {
        const survive = surviveChance(rtpBp, ladder, rung);
        reachNum *= BigInt(survive.num);
        reachDen *= BigInt(survive.den);
        const h = BigInt(multiplierAt(ladder, rung));
        // reach * h / 100 == rtpBp / 10000
        expect(reachNum * h * 10_000n).toBe(BigInt(rtpBp) * reachDen * 100n);
      }
    });

    it.each(RTPS)('every fraction is in lowest terms and pop + survive = 1 at %i', (rtpBp) => {
      for (let pump = 1; pump <= ladder.length; pump += 1) {
        const survive = surviveChance(rtpBp, ladder, pump);
        const pop = popChance(rtpBp, ladder, pump);
        expect(gcd(BigInt(survive.num), BigInt(survive.den))).toBe(1n);
        expect(pop.den).toBe(survive.den);
        expect(pop.num + survive.num).toBe(survive.den);
        expect(survive.num).toBeGreaterThan(0);
        expect(pop.num).toBeGreaterThan(0);
      }
    });
  });
});

describe('pumpSurvives', () => {
  it('survives on exactly num of the den rolls', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (let pump = 1; pump <= ladder.length; pump += 1) {
        const chance = surviveChance(9700, ladder, pump);
        let survived = 0;
        for (let roll = 0; roll < chance.den; roll += 1) {
          if (pumpSurvives(chance, roll)) survived += 1;
        }
        expect(survived).toBe(chance.num);
      }
    }
  });

  it('survives below num and pops at num', () => {
    const chance = { num: 101, den: 111 };
    expect(pumpSurvives(chance, 100)).toBe(true);
    expect(pumpSurvives(chance, 101)).toBe(false);
  });

  it('refuses a roll outside 0 .. den - 1', () => {
    const chance = { num: 101, den: 111 };
    expect(() => pumpSurvives(chance, -1)).toThrow(RangeError);
    expect(() => pumpSurvives(chance, 111)).toThrow(RangeError);
    expect(() => pumpSurvives(chance, 1.5)).toThrow(RangeError);
    expect(() => pumpSurvives(chance, Number.NaN)).toThrow(RangeError);
  });
});

describe('cashOutCents', () => {
  it('matches the test vectors: bet x multiplier, rounded down', () => {
    expect(cashOutCents(1234, ladderOf('easy'), 3)).toBe(1517); // 1517.82
    expect(cashOutCents(13, ladderOf('easy'), 3)).toBe(15); // 15.99
    expect(cashOutCents(10, ladderOf('easy'), 1)).toBe(10); // 10.1
    expect(cashOutCents(11, ladderOf('expert'), 1)).toBe(16); // 16.5
    expect(cashOutCents(777, ladderOf('hard'), 5)).toBe(3807); // 3807.3
    expect(cashOutCents(2000, ladderOf('expert'), 10)).toBe(10_000_000);
  });

  it('pays a whole-dollar bet exactly', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (let rung = 1; rung <= ladder.length; rung += 1) {
        for (const bet of [100, 500, 2500, 100_000]) {
          expect(cashOutCents(bet, ladder, rung) * 100).toBe(bet * multiplierAt(ladder, rung));
        }
      }
    }
  });

  it('is never above bet x multiplier and less than one cent below, for every bet swept', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (let rung = 1; rung <= ladder.length; rung += 1) {
        const h = BigInt(multiplierAt(ladder, rung));
        for (const bet of BETS) {
          const lost = BigInt(bet) * h - BigInt(cashOutCents(bet, ladder, rung)) * 100n;
          expect(lost >= 0n && lost < 100n).toBe(true);
        }
      }
    }
  });

  it('refuses a bet that is not a whole positive number of cents', () => {
    expect(() => cashOutCents(0, ladderOf('easy'), 1)).toThrow(RangeError);
    expect(() => cashOutCents(10.5, ladderOf('easy'), 1)).toThrow(RangeError);
    expect(() => cashOutCents(Number.NaN, ladderOf('easy'), 1)).toThrow(RangeError);
  });
});

describe('patchPriceCents', () => {
  it('matches the test vectors: the exact price, rounded up', () => {
    const easy = ladderOf('easy');
    expect(patchPriceCents(9700, easy, 10_000, 2)).toBe(939); // 938.05
    expect(patchPriceCents(9700, easy, 100, 2)).toBe(10); // 9.38
    expect(patchPriceCents(9700, easy, 11, 2)).toBe(2); // 1.03
    expect(patchPriceCents(9700, easy, 10, 2)).toBe(1); // 0.94
    expect(patchPriceCents(9700, easy, 10_767, 2)).toBe(1010); // exactly 1010
    expect(patchPriceCents(9700, ladderOf('expert'), 2000, 10)).toBe(1_932_990);
    expect(patchPriceCents(9400, easy, 10_000, 2)).toBe(968); // 967.99
    expect(patchPriceCents(9900, easy, 10_000, 2)).toBe(920); // 919.10
  });

  it('is not sold for pump 1', () => {
    expect(() => patchPriceCents(9700, ladderOf('easy'), 100, 1)).toThrow(RangeError);
  });

  it('stays exact where ordinary numbers do not', () => {
    // The top of the fraction here is 61,600,028,599,998,900: past 2^53, and not a
    // value an ordinary number can hold. The exact price is 211,683.947...
    const ladder = [200, 500, 1500, 6000, 30_000, 200_001, 2_000_001, 30_000_000];
    expect(patchPriceCents(9700, ladder, 11, 8)).toBe(211_684);
    // And one that sits a hair above a whole cent: the exact price is
    // 691,159,282,954.0000243, so it rounds up to ...955. Ordinary numbers lose
    // the fraction and give ...954, one cent too cheap.
    expect(patchPriceCents(9700, [1_000_000_007, 20_000_000_011], 70_571, 2)).toBe(
      691_159_282_955,
    );
    // A second one, found by the review: 0.00004 above a whole cent, where
    // ordinary numbers give ...665.
    expect(patchPriceCents(9700, [1_295_455_190, 1_811_452_306], 72_451, 2)).toBe(
      275_622_974_666,
    );
  });

  describe.each(DIFFICULTIES)('$id', ({ ladder }) => {
    it.each(RTPS)('is the exact price rounded up, for every bet swept at %i', (rtpBp) => {
      for (let pump = 2; pump <= ladder.length; pump += 1) {
        for (const bet of BETS) {
          const [top, bottom] = exactPatchPrice(rtpBp, ladder, bet, pump);
          const price = BigInt(patchPriceCents(rtpBp, ladder, bet, pump));
          // price - 1 < top / bottom <= price
          expect(price * bottom >= top && (price - 1n) * bottom < top).toBe(true);
        }
      }
    });

    it.each(RTPS)('no Patch returns more than the RTP at %i', (rtpBp) => {
      for (let pump = 2; pump <= ladder.length; pump += 1) {
        const current = BigInt(multiplierAt(ladder, pump - 1));
        const next = BigInt(multiplierAt(ladder, pump));
        for (const bet of BETS) {
          // What the Patch is worth on average, before any rounding, in cents:
          //   pop chance * bet * m_(k-1) = (next - current) / next * bet * current / 100
          const worthTop = (next - current) * BigInt(bet) * current;
          const worthBottom = next * 100n;
          const price = BigInt(patchPriceCents(rtpBp, ladder, bet, pump));
          // worth / price <= rtpBp / 10000
          expect(worthTop * 10_000n <= BigInt(rtpBp) * price * worthBottom).toBe(true);
        }
      }
    });
  });
});

describe('rounding only ever costs the player', () => {
  // The worst cases at 97% on the fixed ladders. They sit at the smallest
  // bets, where one cent is a large share of the amount. `npm run rtp` prints
  // the same figures for the live ladders.
  // A percentage with two decimals, rounded to the nearest (a tie goes up),
  // worked out in whole numbers. Easy's worst Patch is exactly 50.045%, a tie
  // that an ordinary number only rounds the right way by luck.
  const percent = (top: bigint, bottom: bigint): string => {
    const hundredths = (top * 20_000n + bottom) / (2n * bottom);
    return `${String(hundredths / 100n)}.${String(hundredths % 100n).padStart(2, '0')}`;
  };

  it.each([
    ['easy', '90.99', 13, 3],
    ['medium', '91.51', 10, 1],
    ['hard', '91.97', 11, 2],
    ['expert', '94.06', 11, 1],
  ] as const)('worst cash-out on %s is %s%% (bet %i cents, rung %i)', (id, pct, bet, rung) => {
    const ladder = ladderOf(id);
    let worst = { top: 1n, bottom: 1n, bet: 0, rung: 0 };
    for (const b of BETS) {
      const top = topRungForBet(ladder, b, LIMITS.maxPayoutCents);
      for (let k = 1; k <= top; k += 1) {
        // return = chance to reach rung k * payout / bet = 9700 * payout / (100 * h_k * bet)
        const t = 9700n * BigInt(cashOutCents(b, ladder, k));
        const d = 100n * BigInt(multiplierAt(ladder, k)) * BigInt(b);
        expect(t * 10_000n <= 9700n * d).toBe(true); // never above 97%
        if (t * worst.bottom < worst.top * d) worst = { top: t, bottom: d, bet: b, rung: k };
      }
    }
    expect([percent(worst.top, worst.bottom), worst.bet, worst.rung]).toEqual([pct, bet, rung]);
  });

  it.each([
    ['easy', '50.05', 11, 2],
    ['medium', '64.75', 10, 3],
    ['hard', '79.14', 10, 2],
    ['expert', '84.93', 11, 2],
  ] as const)('worst Patch on %s returns %s%% (bet %i cents, pump %i)', (id, pct, bet, pump) => {
    const ladder = ladderOf(id);
    let worst = { top: 1n, bottom: 1n, bet: 0, pump: 0 };
    for (const b of BETS) {
      const top = topRungForBet(ladder, b, LIMITS.maxPayoutCents);
      for (let k = 2; k <= top; k += 1) {
        const current = BigInt(multiplierAt(ladder, k - 1));
        const next = BigInt(multiplierAt(ladder, k));
        // return = worth / price, with worth = (next - current) / next * bet * current / 100
        const t = (next - current) * BigInt(b) * current;
        const d = next * 100n * BigInt(patchPriceCents(9700, ladder, b, k));
        if (t * worst.bottom < worst.top * d) worst = { top: t, bottom: d, bet: b, pump: k };
      }
    }
    expect([percent(worst.top, worst.bottom), worst.bet, worst.pump]).toEqual([pct, bet, pump]);
  });
});

describe('topRungForBet', () => {
  it('matches the test vectors', () => {
    const cap = LIMITS.maxPayoutCents;
    expect(topRungForBet(ladderOf('easy'), 100_000, cap)).toBe(24);
    expect(topRungForBet(ladderOf('medium'), 100_000, cap)).toBe(17);
    expect(topRungForBet(ladderOf('hard'), 100_000, cap)).toBe(10);
    expect(topRungForBet(ladderOf('expert'), 100_000, cap)).toBe(6);
    expect(topRungForBet(ladderOf('expert'), 2000, cap)).toBe(10);
    expect(topRungForBet(ladderOf('expert'), 2001, cap)).toBe(9);
    expect(topRungForBet(ladderOf('medium'), 66_666, cap)).toBe(18);
    expect(topRungForBet(ladderOf('medium'), 66_667, cap)).toBe(17);
  });

  it('locks a rung worth more than the cap, even by a fraction of a cent', () => {
    // 99167 * 100.84 = 10,000,000.28 cents: over the cap, though it would round down to it.
    expect(topRungForBet([10_084], 99_167, 10_000_000)).toBe(0);
  });

  it('never lets a payout pass the cap, and always leaves rung 1 open', () => {
    for (const { ladder } of DIFFICULTIES) {
      for (const bet of BETS) {
        const top = topRungForBet(ladder, bet, LIMITS.maxPayoutCents);
        expect(top).toBeGreaterThanOrEqual(1);
        expect(cashOutCents(bet, ladder, top)).toBeLessThanOrEqual(LIMITS.maxPayoutCents);
      }
    }
  });
});

describe('boot checks', () => {
  it('pass for the real configuration', () => {
    expect(configProblems(GAME_CONFIG)).toEqual([]);
    expect(() => assertValidConfig(GAME_CONFIG)).not.toThrow();
  });

  it.each([9400, 9700, 9900])('pass for every ladder at %i', (rtpBp) => {
    expect(configProblems({ ...GAME_CONFIG, rtpBp })).toEqual([]);
  });

  it('refuse an RTP so low that pump 1 is riskier than pump 2', () => {
    expect(ladderProblems(9191, ladderOf('easy'), LIMITS)).toEqual([]);
    expect(ladderProblems(9190, ladderOf('easy'), LIMITS)).toEqual([
      'pump 2 is not riskier than pump 1 at this RTP',
    ]);
    expect(() => assertValidConfig(fixedConfig(9100))).toThrow(/easy: pump 2/);
  });

  it('refuse an RTP at or above the first multiplier', () => {
    expect(ladderProblems(10_100, ladderOf('easy'), LIMITS)).toContain(
      'RTP must be below the first multiplier',
    );
  });

  it('refuse an RTP of 100% or more, which would give the players the edge', () => {
    // All of these are below Easy's first multiplier (1.01x), so no other rule stops them.
    for (const rtpBp of [10_000, 10_050, 10_099]) {
      expect(ladderProblems(rtpBp, ladderOf('easy'), LIMITS)).toEqual(['RTP must be below 100%']);
      expect(() => assertValidConfig({ ...GAME_CONFIG, rtpBp })).toThrow(/RTP must be below 100%/);
    }
    // 99.99% is the highest RTP that may run.
    expect(configProblems({ ...GAME_CONFIG, rtpBp: 9_999 })).toEqual([]);
    expect(() => assertValidConfig({ ...GAME_CONFIG, rtpBp: 9_999 })).not.toThrow();
  });

  it('refuse an RTP of 100% or more on every ladder, whatever its first multiplier', () => {
    // The rule is about the RTP alone. At exactly 100% it is the only thing
    // wrong with any of the ladders, so each difficulty reports it and nothing else.
    expect(configProblems({ ...GAME_CONFIG, rtpBp: 10_000 })).toEqual(
      DIFFICULTIES.map(({ id }) => `${id}: RTP must be below 100%`),
    );
    // A ladder that starts at 1.50x has room below its first multiplier for
    // an RTP of up to 149.99%. The first-multiplier rule alone let that through.
    expect(ladderProblems(14_999, [150, 300, 700], LIMITS)).toEqual(['RTP must be below 100%']);
    expect(ladderProblems(15_000, [150, 300, 700], LIMITS)).toEqual([
      'RTP must be below the first multiplier',
      'RTP must be below 100%',
    ]);
    expect(ladderProblems(9_999, [150, 300, 700], LIMITS)).toEqual([]);
  });

  it('refuse ladders that do not rise, start too low, or flatten out', () => {
    expect(ladderProblems(9700, [], LIMITS)).toEqual(['the ladder is empty']);
    expect(ladderProblems(9700, [100, 200], LIMITS)).toContain(
      'the first multiplier must be above 1.00x',
    );
    expect(ladderProblems(9700, [150, 150, 300], LIMITS)).toContain('rung 2 is not above rung 1');
    expect(ladderProblems(9700, [150, 300, 600, 1200], LIMITS)).toContain(
      'pump 3 is not riskier than pump 2',
    );
    expect(ladderProblems(9700, [150.5, 300], LIMITS)).toEqual([
      'every multiplier must be a whole number of hundredths',
    ]);
    expect(ladderProblems(97.5, [150, 300], LIMITS)).toEqual([
      'RTP must be a whole number of basis points',
    ]);
  });

  it('check every difficulty, not only the first', () => {
    const flat = { id: 'flat', label: 'Flat', ladder: [150, 300, 600] };
    const config = { ...GAME_CONFIG, rtpBp: 9700, difficulties: [...DIFFICULTIES, flat] };
    expect(configProblems(config)).toEqual(['flat: pump 3 is not riskier than pump 2']);
    expect(() => assertValidConfig(config)).toThrow(/flat: pump 3/);
  });

  it('check the last pump, a two-rung ladder, and a pump only as risky as the one before', () => {
    const notRising = 'pump 2 is not riskier than pump 1 at this RTP';
    // Pop chances 1/2, 4/7, then 1/2 again: only the last pump is wrong.
    expect(ladderProblems(9700, [150, 300, 700, 1400], LIMITS)).toEqual([
      'pump 4 is not riskier than pump 3',
    ]);
    // Pump 1 pops 35.3%, pump 2 only 6.25%.
    expect(ladderProblems(9700, [150, 160], LIMITS)).toEqual([notRising]);
    // On the ladder [RTP / 10, RTP] both pumps pop exactly 90%. Level is not rising.
    for (const rtpBp of [9400, 9700, 9900]) {
      expect(ladderProblems(rtpBp, [rtpBp / 10, rtpBp], LIMITS)).toEqual([notRising]);
    }
  });

  it('refuse a pump chance that needs more than one 32-bit roll', () => {
    // Limits roomy enough that the payout cap does not refuse these ladders first.
    const roomy = {
      minBetCents: 10,
      maxBetCents: 10,
      maxPayoutCents: 1_000_000_000_000,
      maxBalloons: 3,
    };
    expect(ladderProblems(9700, [4_294_967_297], roomy)).toEqual([
      'the chance of pump 1 needs a denominator of 2^32 or more',
    ]);
    expect(ladderProblems(9700, [150, 4_294_967_297], roomy)).toEqual([
      'the chance of pump 2 needs a denominator of 2^32 or more',
    ]);
  });

  it('allow a top prize worth exactly the cap at the smallest bet, and nothing above', () => {
    expect(ladderProblems(9700, [150, 300, 100_000_000], LIMITS)).toEqual([]);
    expect(ladderProblems(9700, [150, 300, 100_000_001], LIMITS)).toEqual([
      'the top prize is above the payout cap even at the smallest bet',
    ]);
  });

  it('refuse a top prize the cap cannot pay, and a first rung the largest bet cannot reach', () => {
    expect(ladderProblems(9700, [150, 300, 200_000_000], LIMITS)).toContain(
      'the top prize is above the payout cap even at the smallest bet',
    );
    expect(ladderProblems(9700, [20_000, 50_000], LIMITS)).toContain(
      'the largest bet cannot reach even the first rung under the payout cap',
    );
  });
});
