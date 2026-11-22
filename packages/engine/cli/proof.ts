/**
 * The exact RTP proof behind `npm run rtp`, as functions that return results
 * and print nothing. Everything is whole numbers and exact fractions.
 *
 * It does not trust the engine: it calls the engine's own functions and
 * checks what they return against the rules worked out apart from the engine
 * (cli/rules.ts) and against arithmetic done here.
 *
 * What is proved, for one ladder at one RTP:
 *
 * 1. Every pump's chance is the one the rules give, and every cash-out point
 *    returns exactly the RTP before rounding. The chance to reach rung k is
 *    the product of the engine's pump chances; times the multiplier it must
 *    equal the RTP, as fractions, with nothing left over. The same for every
 *    Patch: what it is worth on average, over its exact price, is the RTP.
 * 2. For every legal bet on every rung it can reach, the payout is bet x
 *    multiplier rounded down, and its real return (the engine's chance of
 *    getting there x the payout / the bet) is never above the RTP.
 * 3. For every legal bet and every Patch it can buy, the price is the exact
 *    price rounded up, and its real return (the engine's pop chance x the
 *    value saved / the price) is never above the RTP.
 * 4. No way of playing beats the RTP: the best possible strategy, found by
 *    working backwards from the top rung, never returns more.
 */
import {
  cashOutCents,
  multiplierAt,
  patchPriceCents,
  popChance,
  surviveChance,
  topRungForBet,
  type Fraction,
  type Limits,
} from '../src/index';
import { add, compare, div, equal, fr, max, mul, ONE, sub, ZERO, type Fr } from './fraction';
import {
  rulePatchPriceCents,
  rulePatchShare,
  rulePayoutCents,
  ruleSurvive,
  ruleTopRung,
} from './rules';

/** One rung of a ladder, with everything the proof says about it. */
export interface RungProof {
  readonly rung: number;
  readonly multiplierHundredths: number;
  /** Chance that the pump onto this rung pops. */
  readonly popChance: Fraction;
  /** Chance that a balloon played without Patches reaches this rung. */
  readonly reach: Fr;
  /** reach x multiplier: the return of cashing out here, before rounding. */
  readonly cashOutReturn: Fr;
  /** True when cashOutReturn equals the RTP exactly. */
  readonly exact: boolean;
  /**
   * True when the engine's survival chance for this pump is the one the rules
   * give, and its pop chance is exactly the rest.
   */
  readonly chanceRight: boolean;
  /** Exact Patch price for the pump onto this rung, as a share of the bet. Null for rung 1. */
  readonly patchShareOfBet: Fr | null;
  /**
   * True when a Patch for this pump returns exactly the RTP before rounding:
   * the engine's pop chance x the multiplier it saves / the exact price.
   * Null for rung 1, where no Patch is sold.
   */
  readonly patchExact: boolean | null;
}

/** The RTP as an exact fraction: 9700 basis points is 97/100. */
export const rtpOf = (rtpBp: number): Fr => fr(rtpBp, 10_000);

/** Part 1: every rung of one ladder. */
export function proveRungs(rtpBp: number, ladder: readonly number[]): readonly RungProof[] {
  const rtp = rtpOf(rtpBp);
  const rows: RungProof[] = [];
  let reach = ONE;
  for (let rung = 1; rung <= ladder.length; rung += 1) {
    const survive = surviveChance(rtpBp, ladder, rung);
    const pop = popChance(rtpBp, ladder, rung);
    const surviveFr = fr(survive.num, survive.den);
    const popFr = fr(pop.num, pop.den);
    reach = mul(reach, surviveFr);
    const h = multiplierAt(ladder, rung);
    const cashOutReturn = mul(reach, fr(h, 100));
    const byTheRules = ruleSurvive(rtpBp, ladder, rung);
    // The exact price comes from the rules. What the Patch is worth uses the
    // engine's own pop chance: pop chance x m_(k-1), per cent of bet.
    const patchShareOfBet = rung === 1 ? null : rulePatchShare(rtpBp, ladder, rung);
    const patchExact =
      patchShareOfBet === null
        ? null
        : equal(div(mul(popFr, fr(multiplierAt(ladder, rung - 1), 100)), patchShareOfBet), rtp);
    rows.push({
      rung,
      multiplierHundredths: h,
      popChance: pop,
      reach,
      cashOutReturn,
      exact: compare(cashOutReturn, rtp) === 0,
      chanceRight: equal(surviveFr, byTheRules) && equal(popFr, sub(ONE, byTheRules)),
      patchShareOfBet,
      patchExact,
    });
  }
  return rows;
}

/**
 * The engine functions scanBets checks. They are passed in so that a test
 * can hand it an engine that is wrong on purpose and see that it is caught.
 */
export interface MathPort {
  readonly surviveChance: typeof surviveChance;
  readonly popChance: typeof popChance;
  readonly cashOutCents: typeof cashOutCents;
  readonly patchPriceCents: typeof patchPriceCents;
  readonly topRungForBet: typeof topRungForBet;
}

/** The real engine. */
export const REAL_MATH: MathPort = {
  surviveChance,
  popChance,
  cashOutCents,
  patchPriceCents,
  topRungForBet,
};

/** The lowest return found, and where. */
export interface Worst {
  /** The return, as a fraction of the money paid: 0.9099... for 90.99%. */
  readonly value: Fr;
  readonly betCents: number;
  /** The rung cashed out on, or the rung the patched pump was aiming for. */
  readonly rung: number;
}

/** Parts 2 and 3: what cent rounding does, over a set of bets. */
export interface BetScan {
  readonly bets: number;
  readonly cashOuts: number;
  readonly patches: number;
  /** Every payout is bet x multiplier rounded down to a whole cent. */
  readonly payoutsRoundDown: boolean;
  /** Every Patch price is the exact price rounded up to a whole cent. */
  readonly pricesRoundUp: boolean;
  /** Every bet that is a whole number of dollars is paid bet x multiplier exactly. */
  readonly wholeDollarsExact: boolean;
  /** No payout is above the payout cap. */
  readonly underCap: boolean;
  /** For every bet, the engine's top rung is the highest one under the cap. */
  readonly topRungsRight: boolean;
  /**
   * No cash-out returns more than the RTP: the engine's chance of reaching the
   * rung x the engine's payout / the bet, for every bet and rung.
   */
  readonly cashOutsWithinRtp: boolean;
  /**
   * No Patch returns more than the RTP: the engine's pop chance x the value
   * the Patch saves / the engine's price, for every bet and pump.
   */
  readonly patchesWithinRtp: boolean;
  /** The lowest cash-out return. Its bet is 0 if no payout loses anything to rounding. */
  readonly worstCashOut: Worst;
  /** Null if no bet in the set could buy a Patch. */
  readonly worstPatch: Worst | null;
}

/**
 * Checks every cash-out and every Patch for each bet, on every rung the bet
 * can reach under the payout cap, and finds the lowest returns.
 */
export function scanBets(
  rtpBp: number,
  ladder: readonly number[],
  limits: Limits,
  bets: Iterable<number>,
  engine: MathPort = REAL_MATH,
): BetScan {
  const rtp = BigInt(rtpBp);
  // Per pump k >= 2, the exact price is betCents * priceTop[k] / priceBottom[k].
  const priceTop: bigint[] = [];
  const priceBottom: bigint[] = [];
  for (let k = 2; k <= ladder.length; k += 1) {
    const current = BigInt(multiplierAt(ladder, k - 1));
    const next = BigInt(multiplierAt(ladder, k));
    priceTop[k] = current * (next - current) * 100n;
    priceBottom[k] = next * rtp;
  }
  // The engine's own chances, per rung: the chance to reach rung k (the
  // product of its pump chances) and the chance that pump k pops.
  const reachTop: bigint[] = [];
  const reachBottom: bigint[] = [];
  const popTop: bigint[] = [];
  const popBottom: bigint[] = [];
  let reach = ONE;
  for (let k = 1; k <= ladder.length; k += 1) {
    const survive = engine.surviveChance(rtpBp, ladder, k);
    reach = mul(reach, fr(survive.num, survive.den));
    reachTop[k] = reach.n;
    reachBottom[k] = reach.d;
    const pop = engine.popChance(rtpBp, ladder, k);
    popTop[k] = BigInt(pop.num);
    popBottom[k] = BigInt(pop.den);
  }

  let betCount = 0;
  let cashOuts = 0;
  let patches = 0;
  let payoutsRoundDown = true;
  let pricesRoundUp = true;
  let wholeDollarsExact = true;
  let underCap = true;
  let topRungsRight = true;
  let cashOutsWithinRtp = true;
  let patchesWithinRtp = true;
  // Worst cash-out: the largest lost / worth, as whole numbers (lost < 100).
  let lostWorst = 0;
  let worthWorst = 1;
  let cashWorst = { betCents: 0, rung: 0 };
  // Worst Patch: the largest over / charged, with over = charged - exact.
  let overWorst = 0n;
  let chargedWorst = 1n;
  let patchWorst: { betCents: number; rung: number } | null = null;

  for (const bet of bets) {
    betCount += 1;
    // The rungs to check are the ones the rules allow, not the ones the engine says.
    const top = ruleTopRung(ladder, bet, limits.maxPayoutCents);
    if (engine.topRungForBet(ladder, bet, limits.maxPayoutCents) !== top) topRungsRight = false;
    const betBig = BigInt(bet);
    for (let rung = 1; rung <= top; rung += 1) {
      cashOuts += 1;
      const worth = bet * multiplierAt(ladder, rung); // in hundredths of a cent
      const payout = engine.cashOutCents(bet, ladder, rung);
      const lost = worth - payout * 100;
      if (lost < 0 || lost >= 100) payoutsRoundDown = false;
      if (bet % 100 === 0 && lost !== 0) wholeDollarsExact = false;
      if (payout > limits.maxPayoutCents) underCap = false;
      // reach x payout / bet <= rtpBp / 10000, without dividing
      const paidBack = (reachTop[rung] ?? 1n) * BigInt(payout) * 10_000n;
      if (paidBack > rtp * betBig * (reachBottom[rung] ?? 1n)) cashOutsWithinRtp = false;
      // lost / worth > lostWorst / worthWorst, without dividing
      if (lost * worthWorst > lostWorst * worth) {
        lostWorst = lost;
        worthWorst = worth;
        cashWorst = { betCents: bet, rung };
      }

      if (rung < 2) continue;
      patches += 1;
      const exactTop = BigInt(bet) * (priceTop[rung] ?? 0n);
      const bottom = priceBottom[rung] ?? 1n;
      const price = BigInt(engine.patchPriceCents(rtpBp, ladder, bet, rung));
      // price - 1 < exact <= price
      if (!(price * bottom >= exactTop && (price - 1n) * bottom < exactTop)) pricesRoundUp = false;
      // pop chance x (bet x m_(k-1)) / price <= rtpBp / 10000, without dividing.
      // bet x h_(k-1) is the value saved in hundredths of a cent, hence the 100.
      const saved = (popTop[rung] ?? 1n) * betBig * BigInt(multiplierAt(ladder, rung - 1));
      if (saved * 10_000n > rtp * price * (popBottom[rung] ?? 1n) * 100n) patchesWithinRtp = false;
      const over = price * bottom - exactTop;
      const charged = price * bottom;
      if (over * chargedWorst > overWorst * charged) {
        overWorst = over;
        chargedWorst = charged;
        patchWorst = { betCents: bet, rung };
      }
    }
  }

  const rtpFr = rtpOf(rtpBp);
  return {
    bets: betCount,
    cashOuts,
    patches,
    payoutsRoundDown,
    pricesRoundUp,
    wholeDollarsExact,
    underCap,
    topRungsRight,
    cashOutsWithinRtp,
    patchesWithinRtp,
    // What rounding alone costs, given exact chances (part 1 proves those):
    // return = RTP x paid / worth = RTP x (1 - lost / worth)
    worstCashOut: { value: mul(rtpFr, sub(ONE, fr(lostWorst, worthWorst))), ...cashWorst },
    // return = RTP x exact price / charged price = RTP x (1 - over / charged)
    worstPatch:
      patchWorst === null
        ? null
        : { value: mul(rtpFr, sub(ONE, fr(overWorst, chargedWorst))), ...patchWorst },
  };
}

/**
 * Part 4: the best a player can do with one balloon, by any way of playing.
 *
 * Returns the largest possible value of
 *
 *     expected payout - RTP x expected money paid in      (in cents)
 *
 * over every strategy, with an unlimited balance. Zero means the best
 * strategy returns exactly the RTP; below zero means even the best returns
 * less. Above zero would mean the game can be beaten.
 *
 * Worked backwards from the top rung. With V(k) the best value of a balloon
 * standing on rung k, q the chance the next pump survives and P the Patch
 * price for it:
 *
 *     cash out             payout(k)
 *     pump                 q x V(k+1)
 *     Patch + pump         V(k+1) - RTP x P / q
 *
 * The last line is a Patch bought on every try until the pump survives: each
 * try costs P and survives with chance q, so 1/q tries on average. A balloon
 * saved by a Patch is back in the same position, so if a Patch is the best
 * choice once it is the best choice again.
 */
export function bestStrategyEdge(
  rtpBp: number,
  ladder: readonly number[],
  limits: Limits,
  betCents: number,
): Fr {
  const rtp = rtpOf(rtpBp);
  const top = topRungForBet(ladder, betCents, limits.maxPayoutCents);
  let value = fr(cashOutCents(betCents, ladder, top)); // the top rung cashes out
  for (let rung = top - 1; rung >= 1; rung -= 1) {
    const survive = surviveChance(rtpBp, ladder, rung + 1);
    const q = fr(survive.num, survive.den);
    const price = fr(patchPriceCents(rtpBp, ladder, betCents, rung + 1));
    const cash = fr(cashOutCents(betCents, ladder, rung));
    const pump = mul(q, value);
    const patched = sub(value, div(mul(rtp, price), q));
    value = max(cash, max(pump, patched));
  }
  const first = surviveChance(rtpBp, ladder, 1);
  return sub(mul(fr(first.num, first.den), value), mul(rtp, fr(betCents)));
}

/** Expected money in and out for one balloon played a fixed way. */
export interface Expectation {
  readonly paid: Fr;
  readonly returned: Fr;
}

/**
 * The exact expected money paid in and paid back, in cents, for one balloon
 * played like this: pump until rung `target`, then cash out; before each pump
 * after the first, buy a Patch with chance `patchChance`.
 *
 * With q the chance the next pump survives, p = 1 - q, c the patch chance and
 * P the Patch price, standing on rung k:
 *
 *     back(k) = c (q back(k+1) + p back(k)) + (1 - c) q back(k+1)
 *     paid(k) = c (P + q paid(k+1) + p paid(k)) + (1 - c) q paid(k+1)
 *
 * which solve to
 *
 *     back(k) = q back(k+1) / (1 - c p)
 *     paid(k) = (c P + q paid(k+1)) / (1 - c p)
 *
 * The simulator plays exactly this through the engine, and its result is
 * judged against this number. So every chance, payout and price here comes
 * from the rules alone (cli/rules.ts), never from the engine: an engine that
 * pays too little must not be able to move its own yardstick.
 */
export function strategyExpectation(
  rtpBp: number,
  ladder: readonly number[],
  betCents: number,
  target: number,
  patchChance: Fr,
): Expectation {
  let back = fr(rulePayoutCents(betCents, ladder, target));
  let paid = ZERO;
  for (let rung = target - 1; rung >= 1; rung -= 1) {
    const q = ruleSurvive(rtpBp, ladder, rung + 1);
    const p = sub(ONE, q);
    const price = fr(rulePatchPriceCents(rtpBp, ladder, betCents, rung + 1));
    const retry = sub(ONE, mul(patchChance, p));
    back = div(mul(q, back), retry);
    paid = div(add(mul(patchChance, price), mul(q, paid)), retry);
  }
  const q1 = ruleSurvive(rtpBp, ladder, 1);
  return { paid: add(fr(betCents), mul(q1, paid)), returned: mul(q1, back) };
}
