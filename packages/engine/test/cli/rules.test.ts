import { describe, expect, it } from 'vitest';
import { equal, fr } from '../../cli/fraction';
import {
  rulePatchPriceCents,
  rulePatchShare,
  rulePayoutCents,
  ruleSurvive,
  ruleTopRung,
} from '../../cli/rules';
import { DIFFICULTIES, LIMITS, RTP_BP } from '../../src/config';
import { cashOutCents, patchPriceCents, surviveChance, topRungForBet } from '../../src/math';
import { fixedLadder } from '../fixtures';

// cli/rules.ts is the yardstick `npm run rtp` and `npm run sim` hold the
// engine up against. It is written apart from the engine, so these tests pin
// it to numbers worked out by hand, and then check that the two agree.

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];
const CAP = LIMITS.maxPayoutCents;

describe('the rules, worked out apart from the engine', () => {
  const easy = fixedLadder('easy'); // 1.01x, 1.11x, 1.23x, ...
  const expert = fixedLadder('expert'); // ..., 47.5x on rung 6, ..., 5,000x on rung 10

  it('give the chances by hand: RTP / m_1, then m_(k-1) / m_k', () => {
    expect(ruleSurvive(9700, easy, 1)).toEqual(fr(97, 101));
    expect(ruleSurvive(9400, easy, 1)).toEqual(fr(94, 101));
    expect(ruleSurvive(9700, easy, 2)).toEqual(fr(101, 111));
    expect(ruleSurvive(9700, easy, 3)).toEqual(fr(37, 41)); // 111/123
    expect(ruleSurvive(9900, easy, 3)).toEqual(fr(37, 41)); // the RTP only moves pump 1
    expect(ruleSurvive(9700, expert, 10)).toEqual(fr(1, 4));
    expect(() => ruleSurvive(9700, easy, 25)).toThrow(RangeError);
  });

  it('round a payout down and a Patch price up', () => {
    expect(rulePayoutCents(1234, easy, 3)).toBe(1517); // 1517.82
    expect(rulePayoutCents(13, easy, 3)).toBe(15); // 15.99
    expect(rulePayoutCents(100, easy, 3)).toBe(123); // exact
    expect(rulePatchPriceCents(9700, easy, 10_000, 2)).toBe(939); // 938.05
    expect(rulePatchPriceCents(9400, easy, 10_000, 2)).toBe(968); // 967.99
    expect(rulePatchPriceCents(9900, easy, 10_000, 2)).toBe(920); // 919.10
    expect(rulePatchPriceCents(9700, easy, 10_767, 2)).toBe(1010); // exactly 1010
    // 101 x 10 x 100 / (111 x 9700), in lowest terms
    expect(rulePatchShare(9700, easy, 2)).toEqual(fr(101_000, 1_076_700));
  });

  it('stay exact where ordinary numbers do not', () => {
    // The exact price is 691,159,282,954.0000243, so it rounds up to ...955.
    expect(rulePatchPriceCents(9700, [1_000_000_007, 20_000_000_011], 70_571, 2)).toBe(
      691_159_282_955,
    );
  });

  it('stop a bet at the highest rung whose payout fits under the cap', () => {
    expect(ruleTopRung(expert, 2000, CAP)).toBe(10); // $20 x 5,000 is exactly the cap
    expect(ruleTopRung(expert, 2001, CAP)).toBe(9);
    expect(ruleTopRung(expert, 100_000, CAP)).toBe(6); // $1,000 x 47.5
    expect(ruleTopRung(expert, 10, 1)).toBe(0); // nothing fits under a cap of one cent
  });
});

describe.each(DIFFICULTIES)('the rules and the engine agree on $id', ({ ladder }) => {
  const bets = [10, 11, 13, 99, 100, 777, 1234, 2000, 2001, 50_000, 99_999, 100_000];

  it.each(RTPS)('at RTP %i', (rtpBp) => {
    for (let k = 1; k <= ladder.length; k += 1) {
      const engine = surviveChance(rtpBp, ladder, k);
      expect(equal(ruleSurvive(rtpBp, ladder, k), fr(engine.num, engine.den))).toBe(true);
    }
    for (const bet of bets) {
      expect(ruleTopRung(ladder, bet, CAP)).toBe(topRungForBet(ladder, bet, CAP));
      for (let k = 1; k <= ladder.length; k += 1) {
        expect(rulePayoutCents(bet, ladder, k)).toBe(cashOutCents(bet, ladder, k));
        if (k >= 2) {
          expect(rulePatchPriceCents(rtpBp, ladder, bet, k)).toBe(
            patchPriceCents(rtpBp, ladder, bet, k),
          );
        }
      }
    }
  });
});
