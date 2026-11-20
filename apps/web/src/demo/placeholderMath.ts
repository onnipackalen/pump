/**
 * TEMPORARY. The game rules the screen needs before the engine has them.
 *
 * The real rules belong in packages/engine (PumpEngine.ts) and are being
 * written separately. When the engine exports these, delete this file and
 * import from @pump/engine instead. Each function follows the formula
 * locked in CLAUDE.md, in integers, but none of it is the tested source of
 * truth.
 */

import type { Fraction } from '../api/contract';

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

function reduce(num: number, den: number): Fraction {
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor };
}

/** The multiplier, in hundredths, at rung k (k >= 1). */
export function multiplierAt(ladder: readonly number[], rung: number): number {
  const value = ladder[rung - 1];
  if (value === undefined) {
    throw new RangeError(`No rung ${rung} on a ladder of ${ladder.length}`);
  }
  return value;
}

/**
 * Chance that pump k survives:
 *   pump 1:  R / m_1          = rtpBp / (100 * h_1)
 *   pump k:  m_(k-1) / m_k    = h_(k-1) / h_k
 */
export function surviveChance(rtpBp: number, ladder: readonly number[], pump: number): Fraction {
  if (pump === 1) return reduce(rtpBp, 100 * multiplierAt(ladder, 1));
  return reduce(multiplierAt(ladder, pump - 1), multiplierAt(ladder, pump));
}

/** Chance that pump k pops: 1 minus its survive chance. */
export function popChance(rtpBp: number, ladder: readonly number[], pump: number): Fraction {
  const survive = surviveChance(rtpBp, ladder, pump);
  return { num: survive.den - survive.num, den: survive.den };
}

/** Cash-out value at rung k: floor(bet * h_k / 100). Floors toward the house. */
export function cashOutCents(betCents: number, ladder: readonly number[], rung: number): number {
  const product = betCents * multiplierAt(ladder, rung);
  return (product - (product % 100)) / 100;
}

/**
 * Patch price for pump k (k >= 2): ceil(p_k * B * m_(k-1) / R).
 * In integers: ceil((h_k - h_(k-1)) * B * h_(k-1) * 100 / (h_k * rtpBp)).
 * BigInt because the top of that fraction can pass 2^53.
 */
export function patchPriceCents(
  rtpBp: number,
  ladder: readonly number[],
  betCents: number,
  pump: number,
): number {
  if (pump < 2) throw new RangeError('A Patch is only sold for pump 2 onward');
  const current = BigInt(multiplierAt(ladder, pump - 1));
  const next = BigInt(multiplierAt(ladder, pump));
  const top = (next - current) * BigInt(betCents) * current * 100n;
  const bottom = next * BigInt(rtpBp);
  return Number((top + bottom - 1n) / bottom);
}

/**
 * The highest rung a bet can reach under the payout cap: the last k with
 * bet * m_k <= cap, i.e. bet * h_k <= cap * 100. Rungs above it are locked.
 */
export function topRungForBet(
  ladder: readonly number[],
  betCents: number,
  maxPayoutCents: number,
): number {
  let top = 0;
  for (let rung = 1; rung <= ladder.length; rung += 1) {
    if (betCents * multiplierAt(ladder, rung) > maxPayoutCents * 100) break;
    top = rung;
  }
  return top;
}
