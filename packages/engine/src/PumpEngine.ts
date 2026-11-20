/**
 * PumpEngine: the pure game rules for Pump.
 *
 * Nothing in this file does I/O: no database, HTTP, clock or crypto. It keeps
 * no state of its own. Every function takes a round and returns a new round,
 * and the same input always gives the same output. Randomness is passed in.
 *
 * The game. A round is one to three balloons, each with its own bet. Each
 * balloon climbs a ladder of multipliers, one rung per pump, until it pops or
 * is cashed out.
 *
 *   pump         the balloon moves up one rung, or pops
 *   Patch        bought together with a pump, after the first; if that pump
 *                would have popped the balloon, the balloon stays where it is
 *   cash out     pays bet x the multiplier of the balloon's rung
 *   top          a balloon that reaches its top rung cashes out by itself
 *
 * The math (chances, prices, payouts, the cap, rounding) is in math.ts, which
 * starts with the one rule it all follows from. This file is the order of
 * play: what is allowed when, and what money moves. It never moves money
 * itself. It says how much, and the caller's wallet does it.
 *
 * Randomness. Each pump is decided by one draw: one whole number, uniformly
 * from 0 to den - 1, where num / den is that pump's chance to survive. The
 * engine asks for it through a PumpDraw and never sees seeds. Nothing else in
 * the game is random. Each balloon counts its own draws: `drawIndex` is how
 * many pumps have been drawn on it, and the next pump uses that index.
 *
 * Refusals. A request the rules do not allow is refused with an EngineError
 * before any draw is made, and changes nothing.
 */
import type { GameConfig } from './config';
import {
  cashOutCents,
  multiplierAt,
  patchPriceCents,
  popChance,
  pumpSurvives,
  surviveChance,
  topRungForBet,
  type Fraction,
} from './math';

/**
 * active    still in play
 * popped    a pump popped it; the bet is lost
 * cashed    cashed out, by the player, at its top rung, or as an abandoned round
 * refunded  the round was abandoned before this balloon was ever pumped
 */
export type BalloonStatus = 'active' | 'popped' | 'cashed' | 'refunded';

export interface Balloon {
  readonly betCents: number;
  readonly status: BalloonStatus;
  /** How many times it has moved up. 0 means not pumped yet. */
  readonly rung: number;
  /**
   * Pumps drawn on this balloon so far; the next pump uses this index. It can
   * be more than the rung: a pump saved by a Patch uses a draw and stays put.
   */
  readonly drawIndex: number;
  /** The highest rung this bet can reach under the payout cap. Reaching it cashes out. */
  readonly topRung: number;
  /** Cents charged for Patches on this balloon so far. */
  readonly patchesCents: number;
  /** Cents paid out. 0 until it cashes out. */
  readonly payoutCents: number;
}

/**
 * One round. It carries the RTP and the ladder it was started with, so it
 * plays and verifies the same way even if the configuration changes later.
 */
export interface Round {
  readonly difficultyId: string;
  readonly rtpBp: number;
  readonly ladder: readonly number[];
  readonly balloons: readonly Balloon[];
}

/**
 * Where a pump's draw comes from: given den, a whole number drawn uniformly
 * from 0 to den - 1, using the balloon's next draw index. The engine calls it
 * exactly once for each pump it resolves, and never for a refused request.
 */
export type PumpDraw = (den: number) => number;

/** The draw that decided one pump, with everything needed to check it again later. */
export interface DrawRecord {
  /** The balloon's draw index this pump used. */
  readonly drawIndex: number;
  /** The roll was drawn from 0 to den - 1. */
  readonly den: number;
  /** The pump survived if roll < num. */
  readonly num: number;
  readonly roll: number;
}

/**
 * invalid_request     the request makes no sense for this round
 * conflict            the balloon is not in the state the request expected
 * insufficient_funds  the balance does not cover what the request costs
 */
export type EngineErrorCode = 'invalid_request' | 'conflict' | 'insufficient_funds';

/** A request the rules refuse. A refused request makes no draw and changes nothing. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** With insufficient_funds: the balance the request needs. Otherwise null. */
  readonly neededCents: number | null;

  constructor(code: EngineErrorCode, message: string, needed: number | null = null) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.neededCents = needed;
  }
}

function isWhole(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

/** The balloon a request is about, or an invalid_request error. */
function balloonAt(round: Round, balloonIndex: number): Balloon {
  const balloon = round.balloons[balloonIndex];
  if (!Number.isSafeInteger(balloonIndex) || balloon === undefined) {
    throw new EngineError('invalid_request', 'There is no such balloon in this round');
  }
  return balloon;
}

/**
 * Pump and cash-out arriving at the same moment must not both succeed. Every
 * request says how many draws the player has seen on the balloon; if the
 * balloon has moved on since, or is no longer in play, the request is refused.
 * The rung is not enough for this, because a pump saved by a Patch uses a
 * draw without moving the rung.
 */
function assertCurrent(balloon: Balloon, expectedDrawIndex: number): void {
  if (balloon.status !== 'active') {
    throw new EngineError('conflict', 'This balloon is no longer in play');
  }
  if (balloon.drawIndex !== expectedDrawIndex) {
    throw new EngineError('conflict', 'This balloon has changed since the request was made');
  }
}

function withBalloon(round: Round, balloonIndex: number, balloon: Balloon): Round {
  return {
    ...round,
    balloons: round.balloons.map((old, index) => (index === balloonIndex ? balloon : old)),
  };
}

/** A balloon cashed out at its rung. Used by cash-out, the top rung and abandoned rounds. */
function cashedOut(round: Round, balloon: Balloon): Balloon {
  return {
    ...balloon,
    status: 'cashed',
    payoutCents: cashOutCents(balloon.betCents, round.ladder, balloon.rung),
  };
}

/**
 * What a pump did:
 *   survived  moved up one rung
 *   saved     would have popped, but the Patch saved it; same rung
 *   popped    the bet on this balloon is lost
 *   top       reached its top rung and cashed out
 */
export type PumpOutcome = 'survived' | 'saved' | 'popped' | 'top';

interface PumpedBalloon {
  readonly balloon: Balloon;
  readonly outcome: PumpOutcome;
  readonly patchChargedCents: number | null;
  readonly draw: DrawRecord;
}

/**
 * One pump on an active balloon, with or without a Patch. All checks have
 * been made by the caller; this is what the draw decides.
 */
function pumped(round: Round, balloon: Balloon, patch: boolean, draw: PumpDraw): PumpedBalloon {
  const pumpNumber = balloon.rung + 1;

  // The Patch is charged whether or not the pump pops.
  const patchChargedCents = patch
    ? patchPriceCents(round.rtpBp, round.ladder, balloon.betCents, pumpNumber)
    : null;

  // The one draw. The pump survives if roll < num.
  const chance = surviveChance(round.rtpBp, round.ladder, pumpNumber);
  const roll = draw(chance.den);
  const survived = pumpSurvives(chance, roll);
  const record: DrawRecord = {
    drawIndex: balloon.drawIndex,
    den: chance.den,
    num: chance.num,
    roll,
  };

  const drawn: Balloon = {
    ...balloon,
    drawIndex: balloon.drawIndex + 1,
    patchesCents: balloon.patchesCents + (patchChargedCents ?? 0),
  };
  if (!survived) {
    // With a Patch the balloon stays on its rung, and the next pump is a new draw.
    const outcome: PumpOutcome = patch ? 'saved' : 'popped';
    const after: Balloon = { ...drawn, status: patch ? 'active' : 'popped' };
    return { balloon: after, outcome, patchChargedCents, draw: record };
  }
  const moved: Balloon = { ...drawn, rung: pumpNumber };
  if (pumpNumber < balloon.topRung) {
    return { balloon: moved, outcome: 'survived', patchChargedCents, draw: record };
  }
  // The top rung cashes out in the same request.
  return { balloon: cashedOut(round, moved), outcome: 'top', patchChargedCents, draw: record };
}

export interface StartedRound {
  readonly round: Round;
  /** The sum of the bets: what the wallet must charge for this round to exist. */
  readonly costCents: number;
}

/**
 * Starts a round: one to maxBalloons bets on one difficulty.
 *
 * Each balloon's top rung is fixed here from its bet and the payout cap, so
 * the player can be shown it before pumping. `balanceCents` is the player's
 * balance before the round; the bets must fit in it.
 */
export function startRound(
  config: GameConfig,
  difficultyId: string,
  betsCents: readonly number[],
  balanceCents: number,
): StartedRound {
  const difficulty = config.difficulties.find((d) => d.id === difficultyId);
  if (difficulty === undefined) {
    throw new EngineError('invalid_request', 'There is no such difficulty');
  }
  const { minBetCents, maxBetCents, maxPayoutCents, maxBalloons } = config.limits;
  if (betsCents.length < 1 || betsCents.length > maxBalloons) {
    throw new EngineError('invalid_request', `A round has 1 to ${String(maxBalloons)} balloons`);
  }
  if (!betsCents.every((bet) => isWhole(bet, minBetCents) && bet <= maxBetCents)) {
    throw new EngineError(
      'invalid_request',
      `A bet is a whole number of cents from ${String(minBetCents)} to ${String(maxBetCents)}`,
    );
  }
  if (!isWhole(balanceCents, 0)) {
    throw new EngineError('invalid_request', 'The balance must be a whole number of cents');
  }
  const costCents = betsCents.reduce((sum, bet) => sum + bet, 0);
  if (balanceCents < costCents) {
    throw new EngineError('insufficient_funds', 'The balance does not cover the bets', costCents);
  }

  const balloons = betsCents.map((betCents): Balloon => {
    const topRung = topRungForBet(difficulty.ladder, betCents, maxPayoutCents);
    if (topRung < 1) {
      throw new EngineError('invalid_request', 'This bet cannot reach rung 1 under the cap');
    }
    return {
      betCents,
      status: 'active',
      rung: 0,
      drawIndex: 0,
      topRung,
      patchesCents: 0,
      payoutCents: 0,
    };
  });

  return {
    round: {
      difficultyId: difficulty.id,
      rtpBp: config.rtpBp,
      ladder: difficulty.ladder,
      balloons,
    },
    costCents,
  };
}

export interface PumpRequest {
  readonly balloonIndex: number;
  /** The balloon's draw index as the player last saw it. */
  readonly expectedDrawIndex: number;
  /** Buy a Patch for this pump, in the same step. */
  readonly patch: boolean;
  /** The player's balance before this request. Only a Patch needs it. */
  readonly balanceCents: number;
}

export interface PumpResult {
  readonly round: Round;
  readonly outcome: PumpOutcome;
  /** Cents charged for the Patch. Null if none was bought. */
  readonly patchChargedCents: number | null;
  /** Cents paid out by this pump: more than 0 only when the outcome is 'top'. */
  readonly payoutCents: number;
  /** The draw that decided this pump. */
  readonly draw: DrawRecord;
}

/**
 * One pump, with or without a Patch.
 *
 * In order: check the balloon is in the expected state; for a Patch, check it
 * is allowed and that the balance covers its price; only then draw. Patch and
 * pump are one step: the Patch is charged and the pump is drawn together.
 */
export function pump(round: Round, request: PumpRequest, draw: PumpDraw): PumpResult {
  const balloon = balloonAt(round, request.balloonIndex);
  assertCurrent(balloon, request.expectedDrawIndex);

  if (request.patch) {
    if (balloon.rung < 1) {
      throw new EngineError('invalid_request', 'A Patch is only sold after the first pump');
    }
    if (!isWhole(request.balanceCents, 0)) {
      throw new EngineError('invalid_request', 'The balance must be a whole number of cents');
    }
    const price = patchPriceCents(round.rtpBp, round.ladder, balloon.betCents, balloon.rung + 1);
    if (request.balanceCents < price) {
      throw new EngineError('insufficient_funds', 'The balance does not cover this Patch', price);
    }
  }

  const result = pumped(round, balloon, request.patch, draw);
  return {
    round: withBalloon(round, request.balloonIndex, result.balloon),
    outcome: result.outcome,
    patchChargedCents: result.patchChargedCents,
    payoutCents: result.balloon.payoutCents,
    draw: result.draw,
  };
}

export interface CashOutRequest {
  readonly balloonIndex: number;
  /** The balloon's draw index as the player last saw it. */
  readonly expectedDrawIndex: number;
}

export interface CashOutResult {
  readonly round: Round;
  readonly payoutCents: number;
}

/**
 * Cashes out one balloon: bet x the multiplier of its rung, rounded down to a
 * whole cent. No draw is made.
 *
 * Not allowed before the first pump: a balloon that has not been pumped has
 * no multiplier, and handing the bet back would return 100%, not the RTP.
 */
export function cashOut(round: Round, request: CashOutRequest): CashOutResult {
  const balloon = balloonAt(round, request.balloonIndex);
  assertCurrent(balloon, request.expectedDrawIndex);
  if (balloon.rung < 1) {
    throw new EngineError('invalid_request', 'A balloon cannot cash out before its first pump');
  }
  const after = cashedOut(round, balloon);
  return {
    round: withBalloon(round, request.balloonIndex, after),
    payoutCents: after.payoutCents,
  };
}

/** What settling an abandoned round did to one balloon. */
export interface AbandonedBalloon {
  readonly balloonIndex: number;
  /** cashed: paid `cents` as a payout. refunded: the bet of `cents` is handed back. */
  readonly kind: 'cashed' | 'refunded';
  readonly cents: number;
}

export interface AbandonedResult {
  readonly round: Round;
  /** One entry for each balloon that was still in play, in balloon order. */
  readonly settled: readonly AbandonedBalloon[];
}

/**
 * Ends a round the player walked away from. No draw is made.
 *
 * A balloon that was pumped cashes out at its rung, for the same cents as if
 * the player had pressed Cash Out. A balloon never pumped has its bet
 * refunded: no draw was made on it, so it is a cancelled bet, not a result.
 * Neither changes the RTP.
 */
export function settleAbandoned(round: Round): AbandonedResult {
  const settled: AbandonedBalloon[] = [];
  const balloons = round.balloons.map((balloon, balloonIndex): Balloon => {
    if (balloon.status !== 'active') return balloon;
    if (balloon.rung < 1) {
      settled.push({ balloonIndex, kind: 'refunded', cents: balloon.betCents });
      return { ...balloon, status: 'refunded' };
    }
    const after = cashedOut(round, balloon);
    settled.push({ balloonIndex, kind: 'cashed', cents: after.payoutCents });
    return after;
  });
  return { round: { ...round, balloons }, settled };
}

/** True once every balloon has popped, cashed out or been refunded. */
export function isRoundOver(round: Round): boolean {
  return round.balloons.every((balloon) => balloon.status !== 'active');
}

/** What the next pump on a balloon would be. */
export interface NextPump {
  /** Chance that it pops the balloon. */
  readonly popChance: Fraction;
  /** The multiplier after it, if it survives, in hundredths. */
  readonly multiplierHundredths: number;
  /** Price of a Patch for it. Null before the first pump, when no Patch is sold. */
  readonly patchPriceCents: number | null;
}

/** The numbers the screen shows for one balloon. */
export interface BalloonQuote {
  /** Its multiplier in hundredths. Null before the first pump. */
  readonly multiplierHundredths: number | null;
  /** What cashing out now would pay. Null before the first pump or once it is over. */
  readonly cashOutCents: number | null;
  /** The next pump. Null once the balloon is over. */
  readonly next: NextPump | null;
}

/**
 * The numbers the screen shows for a balloon: multiplier, cash-out value,
 * pop chance of the next pump, and Patch price. It makes no draw, so nothing
 * it returns can give away a result.
 */
export function quoteBalloon(round: Round, balloonIndex: number): BalloonQuote {
  const balloon = balloonAt(round, balloonIndex);
  const active = balloon.status === 'active';
  const pumpedOnce = balloon.rung >= 1;
  const nextPump = balloon.rung + 1;
  return {
    multiplierHundredths: pumpedOnce ? multiplierAt(round.ladder, balloon.rung) : null,
    cashOutCents:
      active && pumpedOnce ? cashOutCents(balloon.betCents, round.ladder, balloon.rung) : null,
    next: active
      ? {
          popChance: popChance(round.rtpBp, round.ladder, nextPump),
          multiplierHundredths: multiplierAt(round.ladder, nextPump),
          patchPriceCents: pumpedOnce
            ? patchPriceCents(round.rtpBp, round.ladder, balloon.betCents, nextPump)
            : null,
        }
      : null,
  };
}

/**
 * Where draws come from when a balloon is played again. Unlike PumpDraw it is
 * told which draw index to use, so one function can serve every pump of the
 * balloon: given a draw index and den, the roll that index gives, from 0 to
 * den - 1.
 */
export type ReplayDraw = (drawIndex: number, den: number) => number;

/** One thing that was done to a balloon, as stored with a finished round. */
export type BalloonAction =
  { readonly kind: 'pump'; readonly patch: boolean } | { readonly kind: 'cashOut' };

export interface ReplayedBalloon {
  readonly balloon: Balloon;
  /** The draw of every pump, in order. */
  readonly draws: readonly DrawRecord[];
}

/**
 * Plays one balloon again from its stored actions, to check a finished round.
 *
 * Give it the round as it started and a draw source built from the round's
 * seeds. It applies the same rules as live play and returns what the balloon
 * must have ended as, cent for cent, with the draw of every pump. Each pump
 * asks for the draw at the balloon's own draw index, so the replay cannot
 * drift out of step. Balance checks are left out: the actions are ones the
 * game already accepted. A cash-out made by an abandoned round replays as a
 * plain 'cashOut'.
 */
export function replayBalloon(
  started: Round,
  balloonIndex: number,
  actions: readonly BalloonAction[],
  drawAt: ReplayDraw,
): ReplayedBalloon {
  let balloon = balloonAt(started, balloonIndex);
  const draws: DrawRecord[] = [];
  for (const action of actions) {
    if (balloon.status !== 'active') {
      throw new EngineError('invalid_request', 'These actions go on after the balloon was over');
    }
    if (action.kind === 'pump') {
      if (action.patch && balloon.rung < 1) {
        throw new EngineError('invalid_request', 'A Patch is only sold after the first pump');
      }
      const drawIndex = balloon.drawIndex;
      const result = pumped(started, balloon, action.patch, (den) => drawAt(drawIndex, den));
      balloon = result.balloon;
      draws.push(result.draw);
    } else {
      if (balloon.rung < 1) {
        throw new EngineError('invalid_request', 'A balloon cannot cash out before its first pump');
      }
      balloon = cashedOut(started, balloon);
    }
  }
  return { balloon, draws };
}
