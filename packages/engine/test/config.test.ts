import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, LIMITS, RTP_BP } from '../src/config';

// These tests check the ladder data itself. They do their own arithmetic on
// purpose, so a mistake in the engine's math cannot hide a bad ladder.

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];

/**
 * Pop chance of pump number `pump` (1-based) as an exact fraction [num, den].
 *
 * V[0] = rtpBp and V[k] = ladder[k-1] * 100, so that V[k] / 10000 is the
 * multiplier at rung k. Pump k survives with chance V[k-1] / V[k], so it pops
 * with chance (V[k] - V[k-1]) / V[k].
 */
function popChance(rtpBp: number, ladder: readonly number[], pump: number): [bigint, bigint] {
  const v = (k: number): bigint => {
    if (k === 0) return BigInt(rtpBp);
    const rung = ladder[k - 1];
    if (rung === undefined) throw new Error(`no rung ${k}`);
    return BigInt(rung) * 100n;
  };
  return [v(pump) - v(pump - 1), v(pump)];
}

/** a/b <= c/d, without leaving whole numbers. */
function lessOrEqual(a: [bigint, bigint], c: [bigint, bigint]): boolean {
  return a[0] * c[1] <= c[0] * a[1];
}

/** a/b < c/d, strictly. */
function less(a: [bigint, bigint], c: [bigint, bigint]): boolean {
  return a[0] * c[1] < c[0] * a[1];
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

describe('limits', () => {
  it('match the brief: $0.10 to $1,000 per balloon, $100,000 max payout, 1 to 3 balloons', () => {
    expect(LIMITS).toEqual({
      minBetCents: 10,
      maxBetCents: 100_000,
      maxPayoutCents: 10_000_000,
      maxBalloons: 3,
    });
  });
});

describe('difficulties', () => {
  it('are Easy, Medium, Hard and Expert, each with its own id', () => {
    expect(DIFFICULTIES.map((d) => d.id)).toEqual(['easy', 'medium', 'hard', 'expert']);
  });

  it('go from the longest ladder (Easy) to the shortest (Expert)', () => {
    const lengths = DIFFICULTIES.map((d) => d.ladder.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(new Set(lengths).size).toBe(lengths.length);
  });

  it('Easy has the smallest steps: its biggest jump is smaller than any other ladder’s biggest', () => {
    // Biggest step of a ladder, as the exact fraction next / previous.
    const biggestStep = (ladder: readonly number[]): [bigint, bigint] => {
      let best: [bigint, bigint] = [1n, 1n];
      for (let i = 1; i < ladder.length; i++) {
        const step: [bigint, bigint] = [BigInt(ladder[i] ?? 0), BigInt(ladder[i - 1] ?? 1)];
        if (!lessOrEqual(step, best)) best = step;
      }
      return best;
    };
    const [easy, ...others] = DIFFICULTIES;
    if (!easy) throw new Error('no easy ladder');
    for (const other of others) {
      expect(lessOrEqual(biggestStep(easy.ladder), biggestStep(other.ladder))).toBe(true);
    }
  });

  it('Expert tops out at 5,000x or more', () => {
    const expert = DIFFICULTIES.find((d) => d.id === 'expert');
    expect(expert?.ladder.at(-1)).toBeGreaterThanOrEqual(500_000);
  });
});

describe.each(DIFFICULTIES)('$id ladder', ({ ladder }) => {
  it('is whole numbers that only go up', () => {
    for (let i = 0; i < ladder.length; i++) {
      expect(Number.isInteger(ladder[i])).toBe(true);
      if (i > 0) expect(ladder[i]).toBeGreaterThan(ladder[i - 1] ?? Infinity);
    }
  });

  it('pays its top prize in full at the minimum bet', () => {
    const top = ladder.at(-1) ?? 0;
    expect((top * LIMITS.minBetCents) / 100).toBeLessThanOrEqual(LIMITS.maxPayoutCents);
  });

  it('lets the maximum bet reach at least the first rung under the payout cap', () => {
    const first = ladder[0] ?? Infinity;
    expect(BigInt(first) * BigInt(LIMITS.maxBetCents)).toBeLessThanOrEqual(
      BigInt(LIMITS.maxPayoutCents) * 100n,
    );
  });

  describe.each(RTPS)('at RTP %i', (rtpBp) => {
    it('leaves the first pump a real chance to pop (RTP / m_1 < 1)', () => {
      expect(rtpBp).toBeLessThan((ladder[0] ?? 0) * 100);
    });

    it('raises the pop chance with every pump, strictly', () => {
      // The brief says each pump "raises the chance that it pops", so staying
      // level is not good enough.
      for (let pump = 2; pump <= ladder.length; pump++) {
        const before = popChance(rtpBp, ladder, pump - 1);
        const now = popChance(rtpBp, ladder, pump);
        expect(less(before, now), `pump ${pump - 1} -> ${pump}`).toBe(true);
      }
    });

    it('keeps every reduced survive fraction below 2^32, so one 32-bit roll decides a pump', () => {
      for (let pump = 1; pump <= ladder.length; pump++) {
        const [popNum, den] = popChance(rtpBp, ladder, pump);
        const surviveNum = den - popNum;
        const reducedDen = den / gcd(surviveNum, den);
        expect(reducedDen < 2n ** 32n).toBe(true);
      }
    });
  });
});
