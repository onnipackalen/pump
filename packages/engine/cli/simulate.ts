/**
 * The simulator behind `npm run sim`, as functions that return results and
 * print nothing.
 *
 * It plays rounds through the real engine (startRound, pump, cashOut), the
 * same functions the server calls, with rolls from a fast generator.
 *
 * The engine is never asked what the right answer is. Every yardstick comes
 * from the rules worked out apart from it (cli/rules.ts):
 *
 *   - Exact checks, with no luck in them. Every draw must use the chance the
 *     rules give for that pump. Every outcome must follow from the roll.
 *     Every payout, every Patch charge and every top rung must be the rules'
 *     number to the cent. One mismatch is a failure.
 *   - Counts, where luck plays a part. The simulated RTP is compared with the
 *     exact RTP of the way the simulator plays, and each pump's survival
 *     count with its exact chance, both taken from the rules. PASS_MARK
 *     says how far luck may move them.
 *
 * Two ways of playing (see Play):
 *   SPREAD   Each balloon bets one of SIM_BETS, picks a target rung, lower
 *            rungs more often (see targetWeights), and cashes out there.
 *            Before each pump after the first it buys a Patch one time in
 *            PATCH_ONE_IN. This is the main run.
 *   climb    Each balloon buys a Patch before every pump after the first and
 *            never cashes out, so every balloon that survives its first pump
 *            tries every later pump and ends on its top rung. It bets the
 *            smallest bet, an odd one and the largest, which the payout cap
 *            stops early on a ladder that goes past the cap. The main run
 *            hardly ever gets that far up.
 */
import { cashOut, pump, startRound, type Difficulty, type GameConfig } from '../src/index';
import { add, div, fr, mul, toNumber, ZERO, type Fr } from './fraction';
import type { Rng } from './prng';
import { strategyExpectation, type Expectation } from './proof';
import { rulePatchPriceCents, rulePayoutCents, ruleSurvive, ruleTopRung } from './rules';

/** Bets the main run uses, in cents. Whole dollars and odd cents, to exercise rounding. */
export const SIM_BETS: readonly number[] = [10, 13, 100, 250, 1000, 1234, 2000];

/** In the main run a Patch is bought before one eligible pump in this many. */
export const PATCH_ONE_IN = 4;

/** One way of playing. */
export interface Play {
  /** Each balloon bets one of these, each equally often. */
  readonly bets: readonly number[];
  /** A Patch is bought before one eligible pump in this many. 1 means every time. */
  readonly patchOneIn: number;
  /** 'spread': cash out on a rung picked by targetWeights. 'top': never cash out. */
  readonly aim: 'spread' | 'top';
}

/** The main run. */
export const SPREAD: Play = { bets: SIM_BETS, patchOneIn: PATCH_ONE_IN, aim: 'spread' };

/** The climb to the top, with the smallest bet, an odd one and the largest. */
export function climbPlay(config: GameConfig): Play {
  const { minBetCents, maxBetCents } = config.limits;
  const bets = [minBetCents, 1234, maxBetCents].filter(
    (bet) => bet >= minBetCents && bet <= maxBetCents,
  );
  return { bets: [...new Set(bets)], patchOneIn: 1, aim: 'top' };
}

/**
 * The three engine functions the simulator plays through. They are passed in
 * so that a test can hand the simulator an engine that is wrong on purpose
 * and see that it is caught.
 */
export interface EnginePort {
  readonly startRound: typeof startRound;
  readonly pump: typeof pump;
  readonly cashOut: typeof cashOut;
}

/** The real engine. */
export const REAL_ENGINE: EnginePort = { startRound, pump, cashOut };

/** More than any simulated round can spend, so no request is refused for funds. */
const RICH = Number.MAX_SAFE_INTEGER;

/** No balloon needs this many pumps. Reaching it means the engine never ended the balloon. */
const PUMP_LIMIT = 100_000;

/**
 * The pass mark, in standard errors, for every check where luck plays a
 * part: the RTP, each pump's survival count and pump 1 alone.
 *
 * It is set for the whole run, not for one check. On the shipped ladders a
 * run makes 170 such checks: the RTP, every pump and pump 1 alone, in the
 * main run and the climb of each difficulty. Under the normal approximation
 * one check lands more than 6 standard errors out once in 500 million, so a
 * correct engine fails a run by luck about once in 3 million. Every check
 * adds the same small share, so more difficulties or longer ladders change
 * this little: it takes about 5,000 checks to reach once in 100,000.
 *
 * The RTP check needs the room most. Its standard error comes from the
 * sample, and runs small when rare big wins are missing, so the RTP lands
 * far out on the low side more often than the normal curve says, most of
 * all in short runs.
 *
 * A wide mark loses little. The checks to the cent have no luck in them and
 * carry the strictness: one wrong cent, chance or roll fails the run. And at
 * the default 10 million rounds a pump chance one point off (50% played as
 * 49%) is still at least 13 standard errors out, on every pump of every
 * shipped ladder. The closest is Hard's pump 13, tried 431,000 times in the
 * climb.
 */
export const PASS_MARK = 6;

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

/** How many times the engine did something other than what the rules say. */
export interface Mismatches {
  /** Draws made with a chance that is not the rules' chance for that pump. */
  chances: number;
  /** Pumps whose outcome or new state did not follow from the roll. */
  outcomes: number;
  /** Payouts that are not bet x multiplier rounded down. */
  payouts: number;
  /** Patch charges that are not the exact price rounded up. */
  patchPrices: number;
  /** Balloons whose top rung is not the highest one under the cap. */
  topRungs: number;
  /** The first one found, in words. Empty if there is none. */
  first: string;
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
  /** Balloons that were paid out, by cashing out or by reaching their top rung. */
  readonly payouts: number;
  /** Balloons that reached their top rung. */
  readonly topsReached: number;
  /** Balloons the payout cap stopped below the end of the ladder. */
  readonly cappedBalloons: number;
  readonly mismatches: Mismatches;
}

/** What the rules say about one bet on one ladder, looked up once. */
interface BetRules {
  readonly topRung: number;
  /** Index k: the payout for cashing out on rung k. */
  readonly payout: readonly number[];
  /** Index k: the Patch price for pump k. */
  readonly price: readonly number[];
}

/** Plays `rounds` rounds of one difficulty through the engine, one way of playing. */
export function simulate(
  config: GameConfig,
  difficulty: Difficulty,
  rounds: number,
  rng: Rng,
  play: Play = SPREAD,
  engine: EnginePort = REAL_ENGINE,
): SimResult {
  const { ladder } = difficulty;
  const pumps: PumpCount[] = Array.from({ length: ladder.length + 1 }, () => ({
    attempts: 0,
    survived: 0,
  }));

  // The rules' numbers, worked out once: the chance of each pump, and for
  // each bet its top rung, payouts and Patch prices.
  const chanceNum: number[] = [0];
  const chanceDen: number[] = [1];
  for (let k = 1; k <= ladder.length; k += 1) {
    const chance = ruleSurvive(config.rtpBp, ladder, k);
    chanceNum[k] = Number(chance.n);
    chanceDen[k] = Number(chance.d);
  }
  const rulesByBet = new Map<number, BetRules>();
  const rulesFor = (bet: number): BetRules => {
    let rules = rulesByBet.get(bet);
    if (rules === undefined) {
      const payout = [0];
      const price = [0, 0];
      for (let k = 1; k <= ladder.length; k += 1) {
        payout[k] = rulePayoutCents(bet, ladder, k);
        if (k >= 2) price[k] = rulePatchPriceCents(config.rtpBp, ladder, bet, k);
      }
      const topRung = ruleTopRung(ladder, bet, config.limits.maxPayoutCents);
      rules = { topRung, payout, price };
      rulesByBet.set(bet, rules);
    }
    return rules;
  };

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

  const mismatches: Mismatches = {
    chances: 0,
    outcomes: 0,
    payouts: 0,
    patchPrices: 0,
    topRungs: 0,
    first: '',
  };
  const mismatch = (
    kind: 'chances' | 'outcomes' | 'payouts' | 'patchPrices' | 'topRungs',
    what: () => string,
  ): void => {
    mismatches[kind] += 1;
    if (mismatches.first === '') mismatches.first = what();
  };

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
  let payouts = 0;
  let topsReached = 0;
  let cappedBalloons = 0;
  let biggest = { payoutCents: 0, betCents: 0, rung: 0 };

  for (let i = 0; i < rounds; i += 1) {
    const count = 1 + rng.below(config.limits.maxBalloons);
    const bets: number[] = [];
    for (let b = 0; b < count; b += 1) bets.push(play.bets[rng.below(play.bets.length)] ?? 100);
    let round = engine.startRound(config, difficulty.id, bets, RICH).round;
    let roundPaid = 0;
    let roundReturned = 0;

    for (let b = 0; b < count; b += 1) {
      const bet = bets[b] ?? 0;
      const rules = rulesFor(bet);
      roundPaid += bet;
      const topRung = round.balloons[b]?.topRung ?? 0;
      if (topRung !== rules.topRung) {
        mismatch(
          'topRungs',
          () =>
            `a bet of ${String(bet)} cents got top rung ${String(topRung)}, ` +
            `the rules give ${String(rules.topRung)}`,
        );
      }
      if (rules.topRung < ladder.length) cappedBalloons += 1;

      let target = Number.POSITIVE_INFINITY; // 'top': never cash out
      if (play.aim === 'spread') {
        const { cumulative, total } = tableFor(topRung);
        const pick = rng.below(total);
        target = 1;
        while ((cumulative[target - 1] ?? total) <= pick) target += 1;
      }

      for (let made = 0; ; made += 1) {
        const balloon = round.balloons[b];
        if (balloon === undefined || balloon.status !== 'active') break;
        if (made >= PUMP_LIMIT) {
          mismatch('outcomes', () => `a balloon was still in play after ${String(made)} pumps`);
          break;
        }
        if (balloon.rung >= target) {
          const cashed = engine.cashOut(round, {
            balloonIndex: b,
            expectedDrawIndex: balloon.drawIndex,
          });
          const due = rules.payout[balloon.rung] ?? -1;
          if (cashed.payoutCents !== due) {
            mismatch(
              'payouts',
              () =>
                `cashing out ${String(bet)} cents on rung ${String(balloon.rung)} paid ` +
                `${String(cashed.payoutCents)}, the rules give ${String(due)}`,
            );
          }
          round = cashed.round;
          break;
        }
        const pumpNumber = balloon.rung + 1;
        const patch =
          balloon.rung >= 1 && (play.patchOneIn === 1 || rng.below(play.patchOneIn) === 0);
        const result = engine.pump(
          round,
          {
            balloonIndex: b,
            expectedDrawIndex: balloon.drawIndex,
            patch,
            balanceCents: RICH,
          },
          draw,
        );

        // The chance used must be the rules' chance for this pump.
        const num = chanceNum[pumpNumber] ?? -1;
        const den = chanceDen[pumpNumber] ?? -1;
        if (result.draw.num !== num || result.draw.den !== den) {
          mismatch(
            'chances',
            () =>
              `pump ${String(pumpNumber)} was drawn at ` +
              `${String(result.draw.num)}/${String(result.draw.den)}, ` +
              `the rules give ${String(num)}/${String(den)}`,
          );
        }
        // The outcome must follow from the roll, the Patch and the top rung.
        const survives = result.draw.roll < num;
        const due = survives
          ? pumpNumber === rules.topRung
            ? 'top'
            : 'survived'
          : patch
            ? 'saved'
            : 'popped';
        const after = result.round.balloons[b];
        const rungDue = survives ? pumpNumber : balloon.rung;
        const statusDue = due === 'top' ? 'cashed' : due === 'popped' ? 'popped' : 'active';
        if (result.outcome !== due || after?.rung !== rungDue || after.status !== statusDue) {
          mismatch(
            'outcomes',
            () =>
              `pump ${String(pumpNumber)} with roll ${String(result.draw.roll)} came out as ` +
              `${result.outcome} on rung ${String(after?.rung)}, ` +
              `the rules give ${due} on rung ${String(rungDue)}`,
          );
        }
        // A Patch is charged the rules' price, and only when one was bought.
        const priceDue = patch ? (rules.price[pumpNumber] ?? -1) : null;
        if (result.patchChargedCents !== priceDue) {
          mismatch(
            'patchPrices',
            () =>
              `a Patch for pump ${String(pumpNumber)} on ${String(bet)} cents was charged ` +
              `${String(result.patchChargedCents)}, the rules give ${String(priceDue)}`,
          );
        }
        // Reaching the top pays out in the same step; nothing else pays here.
        const payoutDue = due === 'top' ? (rules.payout[pumpNumber] ?? -1) : 0;
        if (result.payoutCents !== payoutDue) {
          mismatch(
            'payouts',
            () =>
              `pump ${String(pumpNumber)} on ${String(bet)} cents paid ` +
              `${String(result.payoutCents)}, the rules give ${String(payoutDue)}`,
          );
        }

        const counted = pumps[pumpNumber];
        if (counted !== undefined) {
          counted.attempts += 1;
          if (result.outcome === 'survived' || result.outcome === 'top') counted.survived += 1;
        }
        if (result.outcome === 'top') topsReached += 1;
        if (result.patchChargedCents !== null) {
          patchesBought += 1;
          roundPaid += result.patchChargedCents;
        }
        round = result.round;
      }

      const after = round.balloons[b];
      const payout = after?.payoutCents ?? 0;
      if (after?.status === 'cashed') payouts += 1;
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
    payouts,
    topsReached,
    cappedBalloons,
    mismatches,
  };
}

/**
 * The exact expected money paid in and paid back per balloon, for one way of
 * playing, with cent rounding included. Their ratio is the RTP the simulator
 * should measure, give or take luck. Worked out from the rules alone.
 */
export function expectedFor(
  config: GameConfig,
  difficulty: Difficulty,
  play: Play = SPREAD,
): Expectation {
  const { ladder } = difficulty;
  const patchChance = fr(1, play.patchOneIn);
  let paid = ZERO;
  let returned = ZERO;
  for (const bet of play.bets) {
    const topRung = ruleTopRung(ladder, bet, config.limits.maxPayoutCents);
    // 'top' always ends on the top rung; 'spread' on a rung picked by weight.
    const weights =
      play.aim === 'top'
        ? Array.from({ length: topRung }, (_, index) => (index + 1 === topRung ? 1 : 0))
        : targetWeights(ladder, topRung);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    weights.forEach((weight, index) => {
      if (weight === 0) return;
      const share = fr(weight, total * play.bets.length);
      const one = strategyExpectation(config.rtpBp, ladder, bet, index + 1, patchChance);
      paid = add(paid, mul(share, one.paid));
      returned = add(returned, mul(share, one.returned));
    });
  }
  return { paid, returned };
}

/** The numbers `npm run sim` prints and judges for one difficulty and one way of playing. */
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
  /** The largest |z| over all pumps, of survival counts against the rules' chances. */
  readonly worstPumpZ: number;
  readonly worstPump: number;
  /** RTP implied by the first pump's survival count alone, and its standard error. */
  readonly pumpOneRtp: number;
  readonly pumpOneError: number;
  /** How many standard errors pumpOneRtp is from the configured RTP. */
  readonly pumpOneZ: number;
  /** True when the engine did exactly what the rules say every single time. */
  readonly exact: boolean;
}

/** Turns raw counts into the report, and compares them with the rules' expectations. */
export function report(
  config: GameConfig,
  difficulty: Difficulty,
  result: SimResult,
  play: Play = SPREAD,
): SimReport {
  const { ladder } = difficulty;
  const rtp = result.returnedCents / result.paidCents;
  // RTP is a ratio of two sums over rounds. Its standard error, to first
  // order: sqrt(sum of (returned - rtp x paid)^2) / total paid.
  const residualSq =
    result.sumReturnedSq - 2 * rtp * result.sumCross + rtp * rtp * result.sumPaidSq;
  const standardError = Math.sqrt(Math.max(residualSq, 0)) / result.paidCents;
  const expected = expectedFor(config, difficulty, play);
  const expectedRtp = div(expected.returned, expected.paid);
  const expectedNumber = toNumber(expectedRtp);

  let worstPumpZ = 0;
  let worstPump = 0;
  for (let k = 1; k <= ladder.length; k += 1) {
    const counted = result.pumps[k];
    if (counted === undefined || counted.attempts === 0) continue;
    const q = toNumber(ruleSurvive(config.rtpBp, ladder, k));
    const spread = Math.sqrt(counted.attempts * q * (1 - q));
    const z = Math.abs(counted.survived - counted.attempts * q) / spread;
    if (z > worstPumpZ) {
      worstPumpZ = z;
      worstPump = k;
    }
  }

  // Pump 1 is the only pump the RTP sets: survival = RTP / m_1. So its count
  // alone measures the RTP, with nothing taken from the engine.
  const first = result.pumps[1] ?? { attempts: 0, survived: 0 };
  const m1 = (ladder[0] ?? 100) / 100;
  const share = first.attempts === 0 ? 0 : first.survived / first.attempts;
  const pumpOneRtp = share * m1;
  const pumpOneError =
    first.attempts === 0 ? 0 : Math.sqrt((share * (1 - share)) / first.attempts) * m1;
  const pumpOneOff = Math.abs(pumpOneRtp - config.rtpBp / 10_000);
  const pumpOneZ =
    pumpOneError === 0 ? (pumpOneOff === 0 ? 0 : Infinity) : pumpOneOff / pumpOneError;

  const mean = result.sumRatio / result.rounds;
  const volatility = Math.sqrt(Math.max(result.sumRatioSq / result.rounds - mean * mean, 0));
  const { chances, outcomes, payouts, patchPrices, topRungs } = result.mismatches;
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
    pumpOneZ,
    exact: chances + outcomes + payouts + patchPrices + topRungs === 0,
  };
}
