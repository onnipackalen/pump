/**
 * Checking a whole finished round from its revealed seeds.
 *
 * The verify page (in the browser) and the tests both call verifyRound with
 * what the server stored about one round: the seeds, the RTP and ladder the
 * round was played with, and for each balloon what the player did and what
 * the server says happened. verifyRound recomputes everything it can and
 * says, in plain sentences, every place where the server's account and the
 * recomputation disagree. An empty list of problems means the round checks
 * out.
 *
 * This is the recipe in docs/fairness.md, "Checking a whole round", done by
 * code. The checks, in the order they run and are reported:
 *
 *   a. Seeds. The server seed and client seed have the right form, the nonce
 *      is a whole number, and SHA-256 of the revealed server seed is the hash
 *      the player was shown while playing.
 *   b. Config. The round's own RTP and ladder pass the engine's own start-up
 *      checks (math.ts ladderProblems). The round's copies are used, never
 *      the game's current configuration, so a round played at 9700 still
 *      checks after the RTP is changed to 9400.
 *   c. Top rung, per balloon. The top rung the server gave the balloon is
 *      the one math.ts topRungForBet gives for that bet under the round's cap.
 *   d. Replay, per balloon. The balloon is started fresh and its actions are
 *      played again by the engine's own replayBalloon, with every draw
 *      recomputed from the seeds by drawRoll. This file contains no game
 *      rules of its own: the replay is the same code as live play, so the
 *      verifier and the game cannot disagree about what a pump does.
 *   e. Compare, per balloon. The recomputed draws against the server's
 *      (count, then drawIndex, den, num and roll of each), and the recomputed
 *      end state against the server's (status, rung, drawIndex, patchesCents,
 *      payoutCents).
 *   f. A replay the engine refuses (an action that could not have happened)
 *      becomes a problem for that balloon, naming the action.
 *
 * Every problem is collected; checking does not stop at the first one.
 *
 * Throwing. verifyRound is pure and synchronous, and never throws because a
 * record is wrong or dishonest: every such problem becomes a sentence in the
 * result. It can throw only when a value is not even the right JavaScript
 * type, for example `balloons` or `actions` not being an array. Turning raw
 * JSON into a RoundRecord of the right shape is the caller's job, at its
 * boundary.
 */
import { LIMITS } from '../config';
import { ladderProblems, pumpSurvives, topRungForBet } from '../math';
import {
  EngineError,
  replayBalloon,
  settleAbandoned,
  type Balloon,
  type BalloonAction,
  type BalloonStatus,
  type DrawRecord,
  type ReplayedBalloon,
  type Round,
} from '../PumpEngine';
import { drawRoll } from './draw';
import { hashServerSeed } from './hash';
import { drawMessage } from './message';
import type { SampledRoll } from './roll';
import { isClientSeed, isServerSeed } from './seeds';

// ---------------------------------------------------------------------------
// What the server sends
// ---------------------------------------------------------------------------

/**
 * What the server says one balloon ended as: the engine's Balloon fields,
 * plus the draws it recorded. Every field is checked.
 */
export interface ClaimedBalloon {
  readonly status: BalloonStatus;
  readonly rung: number;
  readonly drawIndex: number;
  readonly topRung: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  /** The draw of every pump on this balloon, in order, as the server recorded it. */
  readonly draws: readonly DrawRecord[];
}

/**
 * One balloon of a finished round, as stored: what the player did (the bet
 * and the actions, which are replayed) and what the server says came of it
 * (the ClaimedBalloon fields, which are checked).
 */
export interface BalloonRecord extends ClaimedBalloon {
  readonly betCents: number;
  /**
   * What was done to the balloon, in order. A cash-out made when an
   * abandoned round was settled is a plain 'cashOut'. A bet refunded because
   * the round was abandoned before the balloon's first pump has no actions.
   */
  readonly actions: readonly BalloonAction[];
}

/** Everything needed to check one finished round. */
export interface RoundRecord {
  /** The revealed server seed: 64 lowercase hex characters. */
  readonly serverSeed: string;
  /** The hash the player was shown while playing, before the seed was revealed. */
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  /** A label only. The ladder below is what the round was played with. */
  readonly difficultyId: string;
  /** The RTP the round was played with, in basis points. */
  readonly rtpBp: number;
  /** The ladder the round was played with, in hundredths. */
  readonly ladder: readonly number[];
  /** The payout cap per balloon the round was played under, in cents. */
  readonly maxPayoutCents: number;
  /** Balloon 1, 2, 3 in order; the array index is the balloon index in the draw message. */
  readonly balloons: readonly BalloonRecord[];
}

// ---------------------------------------------------------------------------
// What verifyRound answers
// ---------------------------------------------------------------------------

/** One recomputed draw, with every step a player can check by hand. */
export interface CheckedDraw {
  readonly drawIndex: number;
  /** The roll was drawn from 0 to den - 1. */
  readonly den: number;
  /** The pump survived if roll < num. */
  readonly num: number;
  readonly roll: number;
  /** roll < num. When false and `patched`, the Patch saved the balloon. */
  readonly survived: boolean;
  /** A Patch was bought for this pump. */
  readonly patched: boolean;
  /** The block that held the accepted word (almost always 0). */
  readonly block: number;
  /** Which of that block's 8 words was accepted (almost always 0). */
  readonly wordIndex: number;
  /** The accepted word; roll = word mod den. */
  readonly word: number;
  /** The block-0 draw message, `clientSeed:nonce:balloonIndex:drawIndex:0`. */
  readonly message: string;
}

export interface BalloonCheck {
  /** 0-based, as in the draw message. The player sees it as Balloon balloonIndex + 1. */
  readonly balloonIndex: number;
  /** True when this balloon's own checks (c to f) found nothing. */
  readonly ok: boolean;
  /** This balloon's problems; each also appears in RoundCheck.problems. */
  readonly problems: readonly string[];
  /**
   * The balloon as the replay ends it. If an action was refused, the balloon
   * just before that action. Null if it could not be replayed at all.
   */
  readonly balloon: Balloon | null;
  /** Every recomputed draw, in order (up to a refused action, if any). */
  readonly draws: readonly CheckedDraw[];
}

export interface RoundCheck {
  /** True when no problem at all was found. */
  readonly ok: boolean;
  /** SHA-256 of the revealed server seed is the hash the player was shown. */
  readonly seedHashMatches: boolean;
  /** Every problem: round-level first, then Balloon 1, 2, 3. */
  readonly problems: readonly string[];
  readonly balloons: readonly BalloonCheck[];
}

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

/** "1 draw", "3 draws". */
function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** An error's message as the end of a sentence. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : 'An unexpected error.';
  return text.endsWith('.') ? text : `${text}.`;
}

/** What a balloon "did", for "the server says it ___". */
function statusWords(status: string): string {
  switch (status) {
    case 'active':
      return 'is still in play';
    case 'popped':
      return 'popped';
    case 'cashed':
      return 'cashed out';
    case 'refunded':
      return 'was refunded';
    default:
      return `has a status the game does not have (${JSON.stringify(status)})`;
  }
}

function actionWords(action: BalloonAction): string {
  if (action.kind === 'cashOut') return 'cash out';
  return action.patch ? 'Patch + pump' : 'pump';
}

/** True for the two shapes of action the engine knows. Anything else is not replayed. */
function isAction(value: unknown): value is BalloonAction {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, patch } = value as { readonly kind?: unknown; readonly patch?: unknown };
  return kind === 'cashOut' || (kind === 'pump' && typeof patch === 'boolean');
}

// ---------------------------------------------------------------------------
// a. Seeds
// ---------------------------------------------------------------------------

interface SeedCheck {
  readonly seedHashMatches: boolean;
  /** The seeds and nonce are well-formed, so draws can be recomputed. */
  readonly drawable: boolean;
}

function checkSeeds(record: RoundRecord, problems: string[]): SeedCheck {
  const { serverSeed, serverSeedHash, clientSeed, nonce } = record;
  let seedHashMatches = false;
  if (!isServerSeed(serverSeed)) {
    problems.push('The revealed server seed is not 64 lowercase hex characters (0-9, a-f).');
  } else {
    // Hash the seed's 64 characters ourselves and compare with what was shown.
    const actual = hashServerSeed(serverSeed);
    seedHashMatches = actual === serverSeedHash;
    if (!seedHashMatches) {
      problems.push(
        'The revealed server seed does not match the hash you were shown. ' +
          `Its SHA-256 is ${actual}, the hash shown was ${JSON.stringify(serverSeedHash)}.`,
      );
    }
  }
  const clientSeedOk = isClientSeed(clientSeed);
  if (!clientSeedOk) {
    problems.push('The client seed is not 1 to 64 characters from A-Z, a-z, 0-9, _ and -.');
  }
  const nonceOk = Number.isSafeInteger(nonce) && nonce >= 0;
  if (!nonceOk) problems.push('The nonce is not a whole number from 0 up.');
  return { seedHashMatches, drawable: isServerSeed(serverSeed) && clientSeedOk && nonceOk };
}

// ---------------------------------------------------------------------------
// b. Config
// ---------------------------------------------------------------------------

/**
 * The engine's own start-up checks on the round's RTP and ladder, with the
 * round's cap. ladderProblems also wants the bet limits; those are fixed by
 * the spec (10 to 100,000 cents) and are not stored per round, so the game's
 * LIMITS supply them. Nothing about the RTP or the ladder comes from the
 * current configuration.
 */
function checkConfig(record: RoundRecord, problems: string[]): void {
  const { rtpBp, ladder, maxPayoutCents } = record;
  if (!Number.isSafeInteger(maxPayoutCents) || maxPayoutCents < 1) {
    // ladderProblems needs a whole-number cap; the top-rung checks will say more.
    problems.push('The payout cap is not a whole number of cents from 1 up.');
    return;
  }
  for (const problem of ladderProblems(rtpBp, ladder, { ...LIMITS, maxPayoutCents })) {
    problems.push(`The round's RTP and ladder break a game rule: ${problem}.`);
  }
}

// ---------------------------------------------------------------------------
// c to f. One balloon
// ---------------------------------------------------------------------------

/**
 * Where the replay's draws come from: drawRoll on the round's seeds, at this
 * balloon and the draw index the engine asks for. Each result is kept, both
 * to show its steps (block, word) and so that replaying part of a balloon
 * again (see replayAsFarAsAllowed) computes no HMAC twice.
 */
interface SeededDraws {
  /** The sampled roll for this draw index and den, computed once. */
  readonly sample: (drawIndex: number, den: number) => SampledRoll;
  /** The same, as the ReplayDraw the engine's replayBalloon takes. */
  readonly drawAt: (drawIndex: number, den: number) => number;
}

function seededDraws(record: RoundRecord, balloonIndex: number): SeededDraws {
  const { serverSeed, clientSeed, nonce } = record;
  const kept = new Map<string, SampledRoll>();
  const sample = (drawIndex: number, den: number): SampledRoll => {
    const key = `${String(drawIndex)}/${String(den)}`;
    const found = kept.get(key);
    if (found !== undefined) return found;
    const sampled = drawRoll({ serverSeed, clientSeed, nonce, balloonIndex, drawIndex }, den);
    kept.set(key, sampled);
    return sampled;
  };
  return { sample, drawAt: (drawIndex, den) => sample(drawIndex, den).roll };
}

interface Replay {
  readonly result: ReplayedBalloon;
  /** The first action the engine refused, or null if it accepted them all. */
  readonly refused: { readonly actionIndex: number; readonly error: unknown } | null;
}

/**
 * Replays the balloon's actions with the engine's replayBalloon. If the
 * engine refuses one, finds which: a replay stops at the first action it
 * refuses, so every shorter list of actions replays and every longer one
 * fails, and a binary search over the list's length finds the first refused
 * action. The longest list that replays gives the balloon and draws up to
 * that point, for display.
 */
function replayAsFarAsAllowed(
  started: Round,
  balloonIndex: number,
  actions: readonly BalloonAction[],
  draws: SeededDraws,
): Replay {
  const run = (length: number): ReplayedBalloon =>
    replayBalloon(started, balloonIndex, actions.slice(0, length), draws.drawAt);
  try {
    return { result: run(actions.length), refused: null };
  } catch (firstError) {
    // run(good) replays, run(bad) throws `badError`. No actions always replays.
    let good = 0;
    let bad = actions.length;
    let badError: unknown = firstError;
    while (bad - good > 1) {
      const middle = good + Math.floor((bad - good) / 2);
      try {
        run(middle);
        good = middle;
      } catch (error) {
        bad = middle;
        badError = error;
      }
    }
    return { result: run(good), refused: { actionIndex: good, error: badError } };
  }
}

/** The values one balloon needs from the rest of the round. */
interface BalloonContext {
  readonly record: RoundRecord;
  /** The round as it started (see verifyRound). */
  readonly started: Round;
  /** The seeds and nonce are well-formed, so draws can be recomputed. */
  readonly drawable: boolean;
}

type PumpAction = Extract<BalloonAction, { readonly kind: 'pump' }>;

function isPump(action: BalloonAction): action is PumpAction {
  return action.kind === 'pump';
}

/** Checks c to f for one balloon. `topRung` is its top rung under the cap, or why there is none. */
function checkBalloon(
  context: BalloonContext,
  stored: BalloonRecord,
  balloonIndex: number,
  topRung: number | { readonly error: unknown },
): BalloonCheck {
  const { record, started, drawable } = context;
  const { betCents, actions } = stored;
  const claimed: ClaimedBalloon = stored;
  const name = `Balloon ${String(balloonIndex + 1)}`;
  const problems: string[] = [];
  const done = (balloon: Balloon | null, draws: readonly CheckedDraw[] = []): BalloonCheck => ({
    balloonIndex,
    ok: problems.length === 0,
    problems,
    balloon,
    draws,
  });

  // c. The top rung the bet allows under the round's cap. Without one, the
  // balloon could not have been started, so it is not replayed.
  if (typeof topRung !== 'number') {
    problems.push(`${name}: its top rung cannot be worked out. ${reason(topRung.error)}`);
    return done(null);
  }
  if (topRung < 1) {
    problems.push(
      `${name}: a bet of ${String(betCents)} cents cannot reach even rung 1 under the ` +
        `${String(record.maxPayoutCents)}-cent cap, so the game would not have accepted it.`,
    );
    return done(null);
  }
  if (claimed.topRung !== topRung) {
    problems.push(
      `${name}: the server says its top rung is ${String(claimed.topRung)}, but a bet of ` +
        `${String(betCents)} cents under the ${String(record.maxPayoutCents)}-cent cap ` +
        `tops out at rung ${String(topRung)}.`,
    );
  }

  // A refunded bet is one the round never got to: never pumped, so no actions.
  const refundedWithActions = claimed.status === 'refunded' && actions.length > 0;
  if (refundedWithActions) {
    problems.push(
      `${name}: the server says its bet was refunded, but it lists ` +
        `${count(actions.length, 'action')}. Only a balloon that was never pumped is refunded.`,
    );
  }

  // Before replaying: every action must be one the engine knows, and the
  // seeds must be usable.
  const unknownAction = actions.findIndex((action) => !isAction(action));
  if (unknownAction >= 0) {
    problems.push(
      `${name}, action ${String(unknownAction + 1)}: it is neither a pump nor a cash out, ` +
        'so the balloon cannot be replayed.',
    );
    return done(null);
  }
  if (!drawable) {
    problems.push(
      `${name}: its draws cannot be recomputed without a valid server seed, client seed and nonce.`,
    );
    return done(null);
  }

  // d. Replay with the engine, every draw from the seeds. Draw i belongs to
  // the i-th pump action, so that action says whether it was patched.
  const seeded = seededDraws(record, balloonIndex);
  const { result, refused } = replayAsFarAsAllowed(started, balloonIndex, actions, seeded);
  const pumps = actions.filter(isPump);
  const checkedDraws = result.draws.map((draw, i): CheckedDraw => {
    const { block, wordIndex, word } = seeded.sample(draw.drawIndex, draw.den);
    return {
      ...draw,
      survived: pumpSurvives(draw, draw.roll),
      patched: pumps[i]?.patch ?? false,
      block,
      wordIndex,
      word,
      message: drawMessage({
        clientSeed: record.clientSeed,
        nonce: record.nonce,
        balloonIndex,
        drawIndex: draw.drawIndex,
        block: 0,
      }),
    };
  });

  // e. Each draw the replay made against the one the server recorded. Draws
  // the server left out or added are counted further down.
  result.draws.forEach((mine, i) => {
    const theirs = claimed.draws[i];
    if (theirs === undefined) return;
    const where = `${name}, pump ${String(i + 1)} (draw index ${String(mine.drawIndex)})`;
    if (theirs.drawIndex !== mine.drawIndex) {
      problems.push(`${where}: the server gives it draw index ${String(theirs.drawIndex)}.`);
    }
    if (theirs.num !== mine.num || theirs.den !== mine.den) {
      problems.push(
        `${where}: the server says the survival chance was ` +
          `${String(theirs.num)}/${String(theirs.den)}, the round's RTP and ladder give ` +
          `${String(mine.num)}/${String(mine.den)}.`,
      );
    }
    if (theirs.roll !== mine.roll) {
      problems.push(
        `${where}: the server says roll ${String(theirs.roll)}, the seeds give ${String(mine.roll)}.`,
      );
    }
  });

  // f. An action the engine refused. Nothing after it was replayed, so the
  // draw count and the end state cannot be compared.
  if (refused !== null) {
    const action = actions[refused.actionIndex];
    const what = action === undefined ? 'action' : actionWords(action);
    const verdict =
      refused.error instanceof EngineError ? 'the game rules refuse it' : 'the replay fails';
    problems.push(
      `${name}, action ${String(refused.actionIndex + 1)} (${what}): ${verdict}. ` +
        reason(refused.error),
    );
    return done(result.balloon, checkedDraws);
  }

  // e, continued. The number of draws, then the end state.
  if (claimed.draws.length !== result.draws.length) {
    problems.push(
      `${name}: the server lists ${count(claimed.draws.length, 'draw')}, ` +
        `its actions make ${String(result.draws.length)}.`,
    );
  }

  // The round is over, so the balloon must be too. One never pumped can only
  // have been refunded when the round was abandoned; the engine's
  // settleAbandoned says what that leaves. One that was pumped must have
  // popped or cashed out, and an abandoned round's cash-out is one of its
  // actions: without it, a cash-out the player was owed would go unseen.
  let balloon = result.balloon;
  if (balloon.status === 'active' && balloon.rung < 1) {
    balloon = settleAbandoned({ ...started, balloons: [balloon] }).round.balloons[0] ?? balloon;
  }
  if (balloon.status === 'active') {
    problems.push(
      `${name}: after its last action it is still in play on rung ${String(balloon.rung)}. ` +
        'In a finished round it would have popped or been cashed out.',
    );
  } else if (claimed.status !== balloon.status && !refundedWithActions) {
    problems.push(
      `${name}: the server says it ${statusWords(claimed.status)}, ` +
        `the replay says it ${statusWords(balloon.status)}.`,
    );
  }
  if (claimed.rung !== balloon.rung) {
    problems.push(
      `${name}: the server says it ended on rung ${String(claimed.rung)}, ` +
        `the replay ends on rung ${String(balloon.rung)}.`,
    );
  }
  if (claimed.drawIndex !== balloon.drawIndex) {
    problems.push(
      `${name}: the server says it used ${count(claimed.drawIndex, 'draw')}, ` +
        `the replay uses ${String(balloon.drawIndex)}.`,
    );
  }
  if (claimed.patchesCents !== balloon.patchesCents) {
    problems.push(
      `${name}: the server says its Patches cost ${String(claimed.patchesCents)} cents, ` +
        `the replay gives ${String(balloon.patchesCents)} cents.`,
    );
  }
  if (claimed.payoutCents !== balloon.payoutCents) {
    problems.push(
      `${name}: the server says it paid out ${String(claimed.payoutCents)} cents, ` +
        `the replay gives ${String(balloon.payoutCents)} cents.`,
    );
  }
  return done(balloon, checkedDraws);
}

// ---------------------------------------------------------------------------
// The whole round
// ---------------------------------------------------------------------------

/**
 * Checks one finished round from its record. Pure and synchronous; see the
 * top of this file for what is checked and when it may throw.
 */
export function verifyRound(record: RoundRecord): RoundCheck {
  const roundProblems: string[] = [];

  // a and b: the seeds, and the round's own RTP and ladder.
  const { seedHashMatches, drawable } = checkSeeds(record, roundProblems);
  checkConfig(record, roundProblems);
  if (record.balloons.length === 0) roundProblems.push('The round has no balloons.');

  // The round as it started, built from the record alone: every balloon
  // fresh, with the top rung its bet allows under the round's cap. A balloon
  // whose top rung cannot be worked out is never replayed (checkBalloon stops
  // first), so the 0 it is given here is never read.
  const topRungs = record.balloons.map((stored): number | { readonly error: unknown } => {
    try {
      return topRungForBet(record.ladder, stored.betCents, record.maxPayoutCents);
    } catch (error) {
      return { error };
    }
  });
  const started: Round = {
    difficultyId: record.difficultyId,
    rtpBp: record.rtpBp,
    ladder: record.ladder,
    balloons: record.balloons.map((stored, i): Balloon => {
      const top = topRungs[i];
      return {
        betCents: stored.betCents,
        status: 'active',
        rung: 0,
        drawIndex: 0,
        topRung: typeof top === 'number' ? top : 0,
        patchesCents: 0,
        payoutCents: 0,
      };
    }),
  };

  // c to f, balloon by balloon.
  const context: BalloonContext = { record, started, drawable };
  const balloons = record.balloons.map((stored, i) =>
    checkBalloon(context, stored, i, topRungs[i] ?? { error: null }),
  );

  const problems = [...roundProblems, ...balloons.flatMap((balloon) => balloon.problems)];
  return { ok: problems.length === 0, seedHashMatches, problems, balloons };
}
