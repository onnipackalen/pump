/**
 * The simulator behind `npm run sim`, as functions that return results and
 * print nothing.
 *
 * It plays rounds through the real engine (startRound, pump, cashOut), the
 * same functions the server calls, with rolls from a fast generator.
 *
 * How it plays. Each round has 1, 2 or 3 balloons. Each balloon:
 *   - bets one of SIM_BETS, each equally often (round and odd amounts, all
 *     small enough to climb every ladder to the top);
 *   - picks a target rung, lower rungs more often (see targetWeights), and
 *     cashes out when it gets there;
 *   - before each pump after the first, buys a Patch one time in PATCH_ONE_IN.
 *
 * Because the way of playing is fixed, its exact expected RTP can be worked
 * out (expectedFor), cent rounding included. The simulated RTP is judged
 * against that number, not against the bare RTP.
 */
import {
  cashOut,
  pump,
  startRound,
  surviveChance,
  topRungForBet,
  type Difficulty,
  type GameConfig,
} from '../src/index';
import { add, div, fr, mul, toNumber, ZERO, type Fr } from './fraction';
import type { Rng } from './prng';
import { strategyExpectation, type Expectation } from './proof';

/** Bets the simulator uses, in cents. Whole dollars and odd cents, to exercise rounding. */
export const SIM_BETS: readonly number[] = [10, 13, 100, 250, 1000, 1234, 2000];

/** A Patch is bought before one eligible pump in this many. */
export const PATCH_ONE_IN = 4;

/** More than any simulated round can spend, so no request is refused for funds. */
const RICH = Number.MAX_SAFE_INTEGER;

/**
 * How often each rung is the target: rung t gets weight floor(10^9 / h_t), so
 * a rung with twice the multiplier is aimed for half as often. Every rung is
 * played, but the rare huge wins do not drown the result in noise.
 */
export function targetWeights(ladder: readonly number[], topRung: number): readonly number[] {
  return ladder.slice(0, topRung).map((h) => Math.floor(1_000_000_000 / h));
}

export interface PumpCount {
  /** Times this pump was drawn. */
  attempts: number;
  /** Times it survived. */
  survived: number;
}

export interface BiggestWin {
  readonly payoutCents: number;
  readonly betCents: number;
  readonly rung: number;
}

export interface SimResult {
  readonly rounds: number;
  readonly balloons: number;
  /** Total bets plus Patch prices, in cents. */
  readonly paidCents: number;
  /** Total payouts, in cents. */
  readonly returnedCents: number;
  /** Rounds that paid out anything. */
  readonly hitRounds: number;
  /** Sums over rounds for the statistics: returned^2, paid^2, returned x paid. */
  readonly sumReturnedSq: number;
  readonly sumPaidSq: number;
  readonly sumCross: number;
  /** Sums over rounds of (returned / paid) and its square, for volatility. */
  readonly sumRatio: number;
  readonly sumRatioSq: number;
  /** The largest single payout, and the bet and rung it came from. */
  readonly biggest: BiggestWin;
  /** Index k holds the counts for pump k. Index 0 is unused. */
  readonly pumps: readonly PumpCount[];
  readonly patchesBought: number;
}

/** Plays `rounds` rounds of one difficulty through the engine. */
export function simulate(
  config: GameConfig,
  difficulty: Difficulty,
  rounds: number,
  rng: Rng,
): SimResult {
  const { ladder } = difficulty;
  const pumps: PumpCount[] = Array.from({ length: ladder.length + 1 }, () => ({
    attempts: 0,
    survived: 0,
  }));
  // Target tables by top rung: cumulative weights, so one roll picks a rung.
  const tables = new Map<number, { cumulative: number[]; total: number }>();
  const tableFor = (topRung: number): { cumulative: number[]; total: number } => {
    let table = tables.get(topRung);
    if (table === undefined) {
      let total = 0;
      const cumulative = targetWeights(ladder, topRung).map((weight) => (total += weight));
      table = { cumulative, total };
      tables.set(topRung, table);
    }
    return table;
  };
  const draw = (den: number): number => rng.below(den);

  let balloons = 0;
  let paidCents = 0;
  let returnedCents = 0;
  let hitRounds = 0;
  let sumReturnedSq = 0;
  let sumPaidSq = 0;
  let sumCross = 0;
  let sumRatio = 0;
  let sumRatioSq = 0;
  let patchesBought = 0;
  let biggest = { payoutCents: 0, betCents: 0, rung: 0 };

  for (let i = 0; i < rounds; i += 1) {
    const count = 1 + rng.below(config.limits.maxBalloons);
    const bets: number[] = [];
    for (let b = 0; b < count; b += 1) bets.push(SIM_BETS[rng.below(SIM_BETS.length)] ?? 100);
    let round = startRound(config, difficulty.id, bets, RICH).round;
    let roundPaid = 0;
    let roundReturned = 0;

    for (let b = 0; b < count; b += 1) {
      const bet = bets[b] ?? 0;
      roundPaid += bet;
      const topRung = round.balloons[b]?.topRung ?? 0;
      const { cumulative, total } = tableFor(topRung);
      const pick = rng.below(total);
      let target = 1;
      while ((cumulative[target - 1] ?? total) <= pick) target += 1;

      for (;;) {
        const balloon = round.balloons[b];
        if (balloon === undefined || balloon.status !== 'active') break;
        if (balloon.rung >= target) {
          round = cashOut(round, { balloonIndex: b, expectedDrawIndex: balloon.drawIndex }).round;
          break;
        }
        const patch = balloon.rung >= 1 && rng.below(PATCH_ONE_IN) === 0;
        const result = pump(
          round,
          {
            balloonIndex: b,
            expectedDrawIndex: balloon.drawIndex,
            patch,
            balanceCents: RICH,
          },
          draw,
        );
        const counted = pumps[balloon.rung + 1];
        if (counted !== undefined) {
          counted.attempts += 1;
          if (result.outcome === 'survived' || result.outcome === 'top') counted.survived += 1;
        }
        if (result.patchChargedCents !== null) {
          patchesBought += 1;
          roundPaid += result.patchChargedCents;
        }
        round = result.round;
      }

      const after = round.balloons[b];
      const payout = after?.payoutCents ?? 0;
      roundReturned += payout;
      if (payout > biggest.payoutCents) {
        biggest = { payoutCents: payout, betCents: bet, rung: after?.rung ?? 0 };
      }
    }

    balloons += count;
    paidCents += roundPaid;
    returnedCents += roundReturned;
    if (roundReturned > 0) hitRounds += 1;
    sumReturnedSq += roundReturned * roundReturned;
    sumPaidSq += roundPaid * roundPaid;
    sumCross += roundReturned * roundPaid;
    const ratio = roundReturned / roundPaid;
    sumRatio += ratio;
    sumRatioSq += ratio * ratio;
  }

  return {
    rounds,
    balloons,
    paidCents,
    returnedCents,
    hitRounds,
    sumReturnedSq,
    sumPaidSq,
    sumCross,
    sumRatio,
    sumRatioSq,
    biggest,
    pumps,
    patchesBought,
  };
}

/**
 * The exact expected money paid in and paid back per balloon, for the way
 * `simulate` plays, with cent rounding included. Their ratio is the RTP the
 * simulator should measure, give or take luck.
 */
export function expectedFor(config: GameConfig, difficulty: Difficulty): Expectation {
  const { ladder } = difficulty;
  const patchChance = fr(1, PATCH_ONE_IN);
  let paid = ZERO;
  let returned = ZERO;
  for (const bet of SIM_BETS) {
    const topRung = topRungForBet(ladder, bet, config.limits.maxPayoutCents);
    const weights = targetWeights(ladder, topRung);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    weights.forEach((weight, index) => {
      const share = fr(weight, total * SIM_BETS.length);
      const one = strategyExpectation(config.rtpBp, ladder, bet, index + 1, patchChance);
      paid = add(paid, mul(share, one.paid));
      returned = add(returned, mul(share, one.returned));
    });
  }
  return { paid, returned };
}

/** The numbers `npm run sim` prints and judges for one difficulty. */
export interface SimReport {
  /** Simulated RTP: total paid back / total paid in. */
  readonly rtp: number;
  /** The exact RTP this way of playing should give, cent rounding included. */
  readonly expectedRtp: Fr;
  /** How far luck alone is expected to move the simulated RTP (one standard error). */
  readonly standardError: number;
  /** (rtp - expected) / standardError. */
  readonly z: number;
  /** Share of rounds that paid out anything. */
  readonly hitRate: number;
  /** Standard deviation of a round's (paid back / paid in). */
  readonly volatility: number;
  /** The largest |z| over all pumps, of survival counts against their exact chances. */
  readonly worstPumpZ: number;
  readonly worstPump: number;
  /** RTP implied by the first pump's survival count alone, and its standard error. */
  readonly pumpOneRtp: number;
  readonly pumpOneError: number;
}

/** Turns raw counts into the report, and compares them with the exact expectations. */
export function report(config: GameConfig, difficulty: Difficulty, result: SimResult): SimReport {
  const { ladder } = difficulty;
  const rtp = result.returnedCents / result.paidCents;
  // RTP is a ratio of two sums over rounds. Its standard error, to first
  // order: sqrt(sum of (returned - rtp x paid)^2) / total paid.
  const residualSq =
    result.sumReturnedSq - 2 * rtp * result.sumCross + rtp * rtp * result.sumPaidSq;
  const standardError = Math.sqrt(Math.max(residualSq, 0)) / result.paidCents;
  const expected = expectedFor(config, difficulty);
  const expectedRtp = div(expected.returned, expected.paid);
  const expectedNumber = toNumber(expectedRtp);

  let worstPumpZ = 0;
  let worstPump = 0;
  for (let k = 1; k <= ladder.length; k += 1) {
    const counted = result.pumps[k];
    if (counted === undefined || counted.attempts === 0) continue;
    const chance = surviveChance(config.rtpBp, ladder, k);
    const q = chance.num / chance.den;
    const spread = Math.sqrt(counted.attempts * q * (1 - q));
    const z = Math.abs(counted.survived - counted.attempts * q) / spread;
    if (z > worstPumpZ) {
      worstPumpZ = z;
      worstPump = k;
    }
  }

  // Pump 1 is the only pump the RTP sets: survival = RTP / m_1.
  const first = result.pumps[1] ?? { attempts: 0, survived: 0 };
  const m1 = (ladder[0] ?? 100) / 100;
  const share = first.attempts === 0 ? 0 : first.survived / first.attempts;
  const pumpOneRtp = share * m1;
  const pumpOneError =
    first.attempts === 0 ? 0 : Math.sqrt((share * (1 - share)) / first.attempts) * m1;

  const mean = result.sumRatio / result.rounds;
  const volatility = Math.sqrt(Math.max(result.sumRatioSq / result.rounds - mean * mean, 0));
  return {
    rtp,
    expectedRtp,
    standardError,
    z: (rtp - expectedNumber) / standardError,
    hitRate: result.hitRounds / result.rounds,
    volatility,
    worstPumpZ,
    worstPump,
    pumpOneRtp,
    pumpOneError,
  };
}
