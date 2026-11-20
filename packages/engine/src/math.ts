/**
 * The math of Pump: every chance, price and payout, from one ladder and one
 * RTP value, in whole numbers only.
 *
 * Nothing here does I/O or keeps state. Randomness is passed in as a roll.
 *
 * The one rule everything follows from: wherever a player cashes out, the
 * game pays back exactly the RTP on average. With m_k the multiplier on rung
 * k and R the RTP, that fixes the chance of reaching rung k:
 *
 *     chance to reach rung k  =  R / m_k
 *
 * and so the chance of each single pump:
 *
 *     pump 1 survives with chance   R / m_1
 *     pump k survives with chance   m_(k-1) / m_k      (k >= 2)
 *
 * Multiply those and the middle terms cancel, leaving R / m_k. So the whole
 * house edge on a bet sits in the first pump, and every later pump is a fair
 * bet. A Patch is a separate purchase, priced to return R as well.
 *
 * Units. A ladder is a list of multipliers in whole hundredths: h_k = 100 *
 * m_k, so 111 means 1.11x. RTP is in basis points: 9700 means 97.00%. Money
 * is whole cents. A "rung" is how many times a balloon has moved up; "pump k"
 * is the pump that tries to move it from rung k - 1 to rung k.
 *
 * Rounding. An amount that is not a whole number of cents is rounded in the
 * house's favour: a payout down, a Patch price up. That is the only direction
 * that can never pay back more than the RTP. So every cash-out point and
 * every Patch returns exactly R before rounding, and at most one cent less
 * per payment after it. A whole-dollar bet always cashes out exactly.
 */
import type { GameConfig, Limits } from './config';

/** An exact chance: num out of den, in lowest terms. */
export interface Fraction {
  readonly num: number;
  readonly den: number;
}

/**
 * A pump is decided by one roll from one 32-bit word, so the denominator of
 * every pump chance must be below 2^32.
 */
const DEN_LIMIT = 2n ** 32n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Throws unless `value` is a whole number of at least `min`. */
function assertWhole(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of at least ${String(min)}`);
  }
}

/** A whole number of cents as a plain number. Throws if it is too large to hold exactly. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount is too large to hold as whole cents');
  }
  return Number(value);
}

/** num / den in lowest terms, as plain numbers. Throws if den would not fit a roll. */
function toFraction(num: bigint, den: bigint): Fraction {
  const divisor = gcd(num, den);
  const reducedDen = den / divisor;
  if (reducedDen >= DEN_LIMIT) {
    throw new RangeError('A chance needs a denominator below 2^32 to be decided by one roll');
  }
  return { num: Number(num / divisor), den: Number(reducedDen) };
}

/** The multiplier on rung k (k >= 1), in hundredths. */
export function multiplierAt(ladder: readonly number[], rung: number): number {
  const value = ladder[rung - 1];
  if (value === undefined) {
    throw new RangeError(`No rung ${String(rung)} on a ladder of ${String(ladder.length)}`);
  }
  return value;
}

/**
 * Chance that pump k survives, in lowest terms:
 *
 *     pump 1:   R / m_1         = rtpBp / (100 * h_1)
 *     pump k:   m_(k-1) / m_k   = h_(k-1) / h_k
 *
 * Example at 9700 on a ladder starting 101, 111, 123: pump 1 is 9700/10100 =
 * 97/101, pump 2 is 101/111, pump 3 is 111/123 = 37/41.
 *
 * The fraction is always reduced. Reducing does not change the chance, but it
 * changes which roll is drawn, so it is part of the rule.
 */
export function surviveChance(rtpBp: number, ladder: readonly number[], pump: number): Fraction {
  if (pump === 1) {
    assertWhole('RTP in basis points', rtpBp, 1);
    const first = 100n * BigInt(multiplierAt(ladder, 1));
    if (BigInt(rtpBp) >= first) {
      throw new RangeError('RTP must be below the first multiplier, or pump 1 could never pop');
    }
    return toFraction(BigInt(rtpBp), first);
  }
  return toFraction(BigInt(multiplierAt(ladder, pump - 1)), BigInt(multiplierAt(ladder, pump)));
}

/** Chance that pump k pops: 1 minus its survive chance. */
export function popChance(rtpBp: number, ladder: readonly number[], pump: number): Fraction {
  const survive = surviveChance(rtpBp, ladder, pump);
  return { num: survive.den - survive.num, den: survive.den };
}

/**
 * Decides one pump. `roll` is a whole number drawn uniformly from
 * 0 .. chance.den - 1; the balloon survives if roll < chance.num. That is
 * chance.num of the chance.den equally likely rolls: exactly the chance.
 */
export function pumpSurvives(chance: Fraction, roll: number): boolean {
  if (!Number.isSafeInteger(roll) || roll < 0 || roll >= chance.den) {
    throw new RangeError(`A roll must be a whole number from 0 to ${String(chance.den - 1)}`);
  }
  return roll < chance.num;
}

/**
 * What cashing out at rung k pays: bet * m_k, rounded down to a whole cent.
 *
 *     floor(betCents * h_k / 100)
 *
 * Example: 1234 cents at 1.23x is worth 1517.82 cents and pays 1517. A
 * whole-dollar bet is always a whole number of cents, so nothing is lost.
 */
export function cashOutCents(betCents: number, ladder: readonly number[], rung: number): number {
  assertWhole('Bet in cents', betCents, 1);
  return toCents((BigInt(betCents) * BigInt(multiplierAt(ladder, rung))) / 100n);
}

/**
 * The price of a Patch for pump k (k >= 2), rounded up to a whole cent.
 *
 * A Patch saves the balloon if pump k would have popped it. The balloon is
 * then still worth bet * m_(k-1), so on average the Patch is worth
 * p_k * bet * m_(k-1), with p_k the pop chance. For the Patch to return the
 * RTP like every other bet, its price is that worth divided by R:
 *
 *     price = p_k * bet * m_(k-1) / R
 *
 * With p_k = (h_k - h_(k-1)) / h_k this is, in cents and whole numbers:
 *
 *     ceil( betCents * h_(k-1) * (h_k - h_(k-1)) * 100 / (h_k * rtpBp) )
 *
 * Example at 9700: a 10,000 cent bet, pump 2 on a ladder starting 101, 111:
 * 10000 * 101 * 10 * 100 / (111 * 9700) = 938.05, so the price is 939 cents.
 *
 * BigInt from start to end: the top of that fraction can pass 2^53, where
 * ordinary numbers stop being exact.
 */
export function patchPriceCents(
  rtpBp: number,
  ladder: readonly number[],
  betCents: number,
  pump: number,
): number {
  if (pump < 2) throw new RangeError('A Patch is only sold for pump 2 onward');
  assertWhole('RTP in basis points', rtpBp, 1);
  assertWhole('Bet in cents', betCents, 1);
  const current = BigInt(multiplierAt(ladder, pump - 1));
  const next = BigInt(multiplierAt(ladder, pump));
  const top = BigInt(betCents) * current * (next - current) * 100n;
  const bottom = next * BigInt(rtpBp);
  return toCents((top + bottom - 1n) / bottom);
}

/**
 * The highest rung a bet can reach under the payout cap: the last k with
 * bet * m_k <= cap, compared in whole numbers as
 *
 *     betCents * h_k <= maxPayoutCents * 100
 *
 * Rungs above it are locked for that bet, and reaching it cashes out. Every
 * rung returns the RTP by itself, so stopping a ladder early leaves the RTP
 * unchanged. What would change it is letting a balloon climb to a rung and
 * then paying less than that rung is worth; locking the rung avoids that.
 * Returns 0 if not even rung 1 fits.
 */
export function topRungForBet(
  ladder: readonly number[],
  betCents: number,
  maxPayoutCents: number,
): number {
  assertWhole('Bet in cents', betCents, 1);
  assertWhole('Max payout in cents', maxPayoutCents, 1);
  const cap = BigInt(maxPayoutCents) * 100n;
  let top = 0;
  for (let rung = 1; rung <= ladder.length; rung += 1) {
    if (BigInt(betCents) * BigInt(multiplierAt(ladder, rung)) > cap) break;
    top = rung;
  }
  return top;
}

/**
 * Everything that must hold for one ladder at one RTP before the game may
 * run. Returns one sentence per problem; an empty list means the ladder is
 * good.
 */
export function ladderProblems(
  rtpBp: number,
  ladder: readonly number[],
  limits: Limits,
): readonly string[] {
  const problems: string[] = [];
  const first = ladder[0];
  if (first === undefined) return ['the ladder is empty'];
  if (!ladder.every((h) => Number.isSafeInteger(h))) {
    return ['every multiplier must be a whole number of hundredths'];
  }
  if (!Number.isSafeInteger(rtpBp) || rtpBp < 1) {
    return ['RTP must be a whole number of basis points'];
  }

  const h = ladder.map((value) => BigInt(value));
  const at = (k: number): bigint => h[k - 1] ?? 0n; // rung k, 1-based
  const n = ladder.length;
  const rtp = BigInt(rtpBp);

  if (first <= 100) problems.push('the first multiplier must be above 1.00x');
  for (let k = 2; k <= n; k += 1) {
    if (at(k) <= at(k - 1)) problems.push(`rung ${String(k)} is not above rung ${String(k - 1)}`);
  }
  if (problems.length > 0) return problems; // the tests below need a rising ladder

  // R / m_1 < 1, or the first pump could never pop.
  if (rtp >= 100n * at(1)) problems.push('RTP must be below the first multiplier');

  // The pop chance must rise with every pump, strictly.
  // Pump 1 to 2:   1 - R/m_1 < 1 - m_1/m_2   <=>   rtpBp * h_2 > 100 * h_1^2
  if (n >= 2 && !(rtp * at(2) > 100n * at(1) * at(1))) {
    problems.push('pump 2 is not riskier than pump 1 at this RTP');
  }
  // Pump k to k+1: h_(k-1)/h_k > h_k/h_(k+1)   <=>   h_(k-1) * h_(k+1) > h_k^2
  for (let k = 2; k <= n - 1; k += 1) {
    if (!(at(k - 1) * at(k + 1) > at(k) * at(k))) {
      problems.push(`pump ${String(k + 1)} is not riskier than pump ${String(k)}`);
    }
  }

  // Every pump chance must fit one 32-bit roll.
  const pumpOne = 100n * at(1);
  if (pumpOne / gcd(rtp, pumpOne) >= DEN_LIMIT) {
    problems.push('the chance of pump 1 needs a denominator of 2^32 or more');
  }
  for (let k = 2; k <= n; k += 1) {
    if (at(k) / gcd(at(k - 1), at(k)) >= DEN_LIMIT) {
      problems.push(`the chance of pump ${String(k)} needs a denominator of 2^32 or more`);
    }
  }

  // The cap must leave the ladder playable.
  const cap = BigInt(limits.maxPayoutCents) * 100n;
  if (at(n) * BigInt(limits.minBetCents) > cap) {
    problems.push('the top prize is above the payout cap even at the smallest bet');
  }
  if (at(1) * BigInt(limits.maxBetCents) > cap) {
    problems.push('the largest bet cannot reach even the first rung under the payout cap');
  }
  return problems;
}

/** Every problem in a whole configuration, each named with its difficulty. */
export function configProblems(config: GameConfig): readonly string[] {
  return config.difficulties.flatMap((difficulty) =>
    ladderProblems(config.rtpBp, difficulty.ladder, config.limits).map(
      (problem) => `${difficulty.id}: ${problem}`,
    ),
  );
}

/** Throws, listing every problem, unless the configuration is good. Call it at start-up. */
export function assertValidConfig(config: GameConfig): void {
  const problems = configProblems(config);
  if (problems.length > 0) {
    throw new Error(`The game cannot start with this configuration. ${problems.join('. ')}.`);
  }
}
