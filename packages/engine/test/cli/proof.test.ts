import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  div,
  equal,
  fr,
  mul,
  percent,
  sub,
  toNumber,
  ZERO,
} from '../../cli/fraction';
import {
  bestStrategyEdge,
  proveRungs,
  rtpOf,
  scanBets,
  strategyExpectation,
} from '../../cli/proof';
import { DIFFICULTIES, LIMITS, RTP_BP } from '../../src/config';
import { cashOutCents, patchPriceCents, surviveChance } from '../../src/math';
import { fixedLadder } from '../fixtures';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];

// Exact numbers are pinned against the fixed ladders in fixtures.ts, so tuning
// the live ladders never touches them. The loops over DIFFICULTIES below check
// the live ladders.
const ladderOf = fixedLadder;

/** Every cent up to $30, then steps that miss round numbers, then the limits. */
const BETS: readonly number[] = [
  ...Array.from({ length: 2991 }, (_, i) => i + 10),
  ...Array.from({ length: 1000 }, (_, i) => 3001 + i * 97),
  10_000,
  99_999,
  100_000,
];

describe('fractions', () => {
  it('stay exact and in lowest terms', () => {
    expect(fr(6, 8)).toEqual({ n: 3n, d: 4n });
    expect(fr(3, -6)).toEqual({ n: -1n, d: 2n });
    expect(add(fr(1, 3), fr(1, 6))).toEqual(fr(1, 2));
    expect(sub(fr(1, 2), fr(1, 3))).toEqual(fr(1, 6));
    expect(mul(fr(97, 101), fr(101, 111))).toEqual(fr(97, 111));
    expect(div(fr(1, 2), fr(1, 4))).toEqual(fr(2));
    expect(compare(fr(1, 3), fr(1, 2))).toBeLessThan(0);
    expect(equal(fr(2, 4), fr(1, 2))).toBe(true);
    expect(() => fr(1, 0)).toThrow(RangeError);
  });

  it('print as percentages rounded to the nearest', () => {
    expect(percent(fr(97, 100))).toBe('97.00%');
    expect(percent(fr(9151, 10_000))).toBe('91.51%');
    expect(percent(fr(915_094, 1_000_000))).toBe('91.51%'); // 91.5094
    expect(percent(fr(909_950, 1_000_000))).toBe('91.00%'); // 90.995 rounds up
    expect(percent(fr(1, 3), 4)).toBe('33.3333%');
    expect(percent(fr(2, 3), 0)).toBe('67%');
    expect(toNumber(fr(1, 8))).toBe(0.125);
  });
});

describe.each(DIFFICULTIES)('proof for $id', ({ ladder }) => {
  it.each(RTPS)('every rung returns exactly the RTP before rounding at %i', (rtpBp) => {
    const rows = proveRungs(rtpBp, ladder);
    expect(rows).toHaveLength(ladder.length);
    for (const row of rows) {
      expect(row.exact).toBe(true);
      expect(equal(row.cashOutReturn, rtpOf(rtpBp))).toBe(true);
      // reach = RTP / multiplier
      expect(equal(row.reach, div(rtpOf(rtpBp), fr(row.multiplierHundredths, 100)))).toBe(true);
    }
    expect(rows[0]?.patchShareOfBet).toBeNull();
  });

  it.each(RTPS)('cent rounding never pays more than the RTP at %i', (rtpBp) => {
    const scan = scanBets(rtpBp, ladder, LIMITS, BETS);
    expect(scan.bets).toBe(BETS.length);
    expect(scan.payoutsRoundDown).toBe(true);
    expect(scan.pricesRoundUp).toBe(true);
    expect(scan.wholeDollarsExact).toBe(true);
    expect(scan.underCap).toBe(true);
    expect(compare(scan.worstCashOut.value, rtpOf(rtpBp))).toBeLessThanOrEqual(0);
    expect(scan.worstPatch).not.toBeNull();
    if (scan.worstPatch !== null) {
      expect(compare(scan.worstPatch.value, rtpOf(rtpBp))).toBeLessThanOrEqual(0);
    }
  });

  it.each(RTPS)('the best possible strategy never beats the RTP at %i', (rtpBp) => {
    for (const bet of [10, 11, 13, 25, 99, 100, 777, 1234, 2000, 10_000, 99_999, 100_000]) {
      const edge = bestStrategyEdge(rtpBp, ladder, LIMITS, bet);
      expect(compare(edge, ZERO)).toBeLessThanOrEqual(0);
    }
    // A whole-dollar bet can cash out exactly, so its best strategy returns exactly the RTP.
    expect(equal(bestStrategyEdge(rtpBp, ladder, LIMITS, 100), ZERO)).toBe(true);
  });
});

describe('the worst cases of cent rounding at 97%', () => {
  it.each([
    ['easy', '90.99%', 13, 3, '50.05%', 11, 2],
    ['medium', '91.51%', 10, 1, '64.75%', 10, 3],
    ['hard', '91.97%', 11, 2, '79.14%', 10, 2],
    ['expert', '94.06%', 11, 1, '84.93%', 11, 2],
  ] as const)('%s', (id, cash, cashBet, cashRung, patch, patchBet, patchPump) => {
    const scan = scanBets(9700, ladderOf(id), LIMITS, BETS);
    expect([
      percent(scan.worstCashOut.value),
      scan.worstCashOut.betCents,
      scan.worstCashOut.rung,
    ]).toEqual([cash, cashBet, cashRung]);
    expect(scan.worstPatch).not.toBeNull();
    if (scan.worstPatch !== null) {
      expect([
        percent(scan.worstPatch.value),
        scan.worstPatch.betCents,
        scan.worstPatch.rung,
      ]).toEqual([patch, patchBet, patchPump]);
    }
  });

  it('only looks at rungs a bet can reach under the cap', () => {
    // $1,000 on Expert reaches 6 rungs, so 6 cash-outs and 5 Patches (pumps 2 to 6).
    const capped = scanBets(9700, ladderOf('expert'), LIMITS, [100_000]);
    expect([capped.cashOuts, capped.patches]).toEqual([6, 5]);
    // With a cap of one cent nothing is reachable, so there is nothing to check.
    const none = scanBets(9700, ladderOf('expert'), { ...LIMITS, maxPayoutCents: 1 }, [10]);
    expect([none.cashOuts, none.patches, none.worstPatch]).toEqual([0, 0, null]);
  });
});

describe('strategyExpectation', () => {
  const rtpBp = 9700;
  const ladder = ladderOf('easy');
  const q = (pump: number) => {
    const chance = surviveChance(rtpBp, ladder, pump);
    return fr(chance.num, chance.den);
  };

  it('with no Patches: pay the bet, get the payout if every pump survives', () => {
    for (const [bet, target] of [
      [100, 1],
      [13, 3],
      [1234, 5],
      [2000, 24],
    ] as const) {
      const { paid, returned } = strategyExpectation(rtpBp, ladder, bet, target, ZERO);
      let reach = fr(1);
      for (let pump = 1; pump <= target; pump += 1) reach = mul(reach, q(pump));
      expect(equal(paid, fr(bet))).toBe(true);
      expect(equal(returned, mul(reach, fr(cashOutCents(bet, ladder, target))))).toBe(true);
    }
  });

  it('with a Patch on every pump: only pump 1 can pop, and each try is paid for', () => {
    const bet = 1234;
    const target = 4;
    const { paid, returned } = strategyExpectation(rtpBp, ladder, bet, target, fr(1));
    // After pump 1 the balloon always gets to the target.
    expect(equal(returned, mul(q(1), fr(cashOutCents(bet, ladder, target))))).toBe(true);
    // Each pump k >= 2 is tried 1 / q_k times on average, at the Patch price each time.
    let patches = ZERO;
    for (let pump = 2; pump <= target; pump += 1) {
      patches = add(patches, div(fr(patchPriceCents(rtpBp, ladder, bet, pump)), q(pump)));
    }
    expect(equal(paid, add(fr(bet), mul(q(1), patches)))).toBe(true);
  });

  it.each(RTPS)('never returns more than the RTP, whatever the Patch chance, at %i', (rtp) => {
    for (const { ladder: l } of DIFFICULTIES) {
      for (const bet of [10, 13, 100, 1234, 2000]) {
        for (const target of [1, 2, l.length]) {
          for (const chance of [ZERO, fr(1, 4), fr(1, 2), fr(1)]) {
            const { paid, returned } = strategyExpectation(rtp, l, bet, target, chance);
            expect(compare(div(returned, paid), rtpOf(rtp))).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });
});
