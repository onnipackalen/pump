import { ApiFailure, NetworkFailure, type GameClient } from '../api/client';
import type {
  ActionResult,
  FairnessView,
  RoundSummary,
  RoundView,
  SessionView,
  StartRoundRequest,
} from '../api/contract';
import {
  forgetStarting,
  markRefused,
  rememberShown,
  rememberStandIn,
  rememberStarting,
  shownFor,
  startsOnTheirWay,
  validSeeds,
  type HashStorage,
  type SeedsBeforeRound,
  type StartOnItsWay,
} from '../verify/shownHashes';
import { makeClientSeed } from './clientSeed';

/** How many finished rounds the history list holds. */
export const HISTORY_SIZE = 10;

/**
 * Sends one player action. The key is made once and reused if the request
 * has to be retried, so the server applies the action at most once.
 *
 * `action` must send the same request both times: anything random in it
 * (a new client seed, say) is made before calling send, never inside, or
 * the retry would be a different request under the same key, which the
 * server refuses ("key_reused").
 */
export async function send<T>(
  action: (key: string) => Promise<T>,
  makeKey: () => string = () => crypto.randomUUID(),
): Promise<T> {
  const key = makeKey();
  try {
    return await action(key);
  } catch (error) {
    if (error instanceof NetworkFailure) return action(key);
    throw error;
  }
}

/**
 * First client seeds on their way, one per client at most. See
 * ensureClientSeed.
 */
const firstSeeds = new WeakMap<GameClient, Promise<FairnessView>>();

/**
 * The player's fairness settings with a client seed. A new player has none
 * yet, and this browser makes the first one, so even a player who never
 * edits it is not using one the server picked. The seed is made once, before
 * the request, so a retry sends the very same seed under the same key.
 *
 * At most one first seed is on its way at a time. Callers that find none
 * at the same moment (React's development double start of the first load,
 * or a resync running beside a fresh start) all wait for that one request
 * instead of each sending a different seed, so the seed on screen is the
 * one the server kept.
 */
export function ensureClientSeed(
  client: GameClient,
  fairness: FairnessView,
  makeSeed: () => string = makeClientSeed,
): Promise<FairnessView> {
  if (fairness.clientSeed !== null) return Promise.resolve(fairness);
  const onItsWay = firstSeeds.get(client);
  if (onItsWay) return onItsWay;
  const clientSeed = makeSeed();
  const request = send((key) => client.setClientSeed(clientSeed, key));
  firstSeeds.set(client, request);
  const done = (): void => {
    if (firstSeeds.get(client) === request) firstSeeds.delete(client);
  };
  void request.then(done, done);
  return request;
}

/** Everything the screen needs to open: the session, its seeds, and the history list. */
export interface OpenedGame {
  readonly session: SessionView;
  /** The session's fairness, with a client seed made here if it had none. */
  readonly fairness: FairnessView;
  readonly history: readonly RoundSummary[];
}

/**
 * Opens the game the way the first visit does: load the session first and
 * alone (it is the only request that creates a player), make the first
 * client seed if there is none, then load the history list. Used on the
 * first load and again when the server has lost this browser's session.
 */
export async function openGame(
  client: GameClient,
  makeSeed: () => string = makeClientSeed,
  storage?: HashStorage | null,
): Promise<OpenedGame> {
  const session = await client.getSession();
  // A start whose answer never came (the page was closed, say) may have
  // started the round in play: it gets its copy now.
  keepLostStartCopy(session.activeRound, storage);
  const fairness = await ensureClientSeed(client, session.fairness, makeSeed);
  const history = await client.getHistory(HISTORY_SIZE);
  return { session, fairness, history };
}

/**
 * The fairness settings once a round has started on them: the round used
 * the seed with this hash, this client seed and this nonce, so the next
 * round uses the next nonce on the same seeds.
 */
export function fairnessAfterStart(round: RoundView): FairnessView {
  return {
    serverSeedHash: round.serverSeedHash,
    clientSeed: round.clientSeed,
    nextNonce: round.nonce + 1,
  };
}

/**
 * A round start this browser refused, before sending anything: the seeds on
 * screen are missing or not in a form a real server sends, so the round
 * could not be checked later against what was shown.
 */
export class SeedsNotShown extends Error {
  constructor() {
    super(
      'The round was not started: the seeds under Provably fair are missing or not valid, ' +
        'so the round could not be checked later.',
    );
    this.name = 'SeedsNotShown';
  }
}

/**
 * What a round started now is bet against, as this browser shows it: the
 * server-seed hash, the client seed and the next nonce from the fairness
 * panel. Null when the screen shows no seeds yet, or seeds not in a valid
 * form (see validSeeds): no round is started on those. So every round this
 * browser starts saves exactly what was on screen, all three values, never
 * a part of them.
 */
export function shownBefore(fairness: FairnessView | null): SeedsBeforeRound | null {
  if (fairness === null) return null;
  const shown = {
    serverSeedHash: fairness.serverSeedHash,
    clientSeed: fairness.clientSeed,
    nonce: fairness.nextNonce,
  };
  return validSeeds(shown) ? shown : null;
}

/**
 * Starts a round, then saves what this browser showed before it, for the
 * verify page (verify/shownHashes). Every round start goes through here:
 * the Bet button and auto-play both call the game's startRound action,
 * which calls this, with the real server or the in-browser demo.
 *
 * `before` is the fairness on screen, read by the caller before anything is
 * sent, and copied here before the request goes out. So the saved copy is
 * what the player saw, never the server's answer. A retry under the same key
 * (see send), which the server answers with its stored first answer, saves
 * that same copy.
 *
 * The request carries those same three values (expectedSeeds). The server
 * starts the round only if they are the player's seeds now, and otherwise
 * refuses with "seeds_changed", changing nothing. So an honest server never
 * plays a round on seeds other than the ones saved here: a panel left out
 * of date in another tab gets a refusal, not a round that fails the verify
 * page.
 *
 * The start is remembered as on its way until it is settled, and its seeds
 * are never thrown away while they could be evidence:
 * - it goes through: they are saved under the round's id, and every other
 *   start on its way is settled (settleStarts);
 * - the refusal carries a round (a 409 with the round as it is now, in play
 *   or over): that round gets its copy now, before the player can play or
 *   check it (keepLostStartCopy);
 * - any other refusal: it is marked refused (for an honest server it made no
 *   round), and the next full load of the state, or the next start that
 *   goes through, settles it;
 * - both tries lose the answer: the same, unmarked.
 *
 * Throws SeedsNotShown, sending nothing, if the screen shows no valid seeds.
 */
export async function startRoundShown(
  client: GameClient,
  request: StartRoundRequest,
  before: FairnessView | null,
  storage?: HashStorage | null,
): Promise<ActionResult> {
  const shown = shownBefore(before);
  if (shown === null) throw new SeedsNotShown();
  const { difficultyId, betsCents } = request;
  const start: StartOnItsWay = { difficultyId, betsCents, shown };
  rememberStarting(start, storage);
  const sent: StartRoundRequest = {
    difficultyId,
    betsCents,
    expectedSeeds: {
      serverSeedHash: shown.serverSeedHash,
      clientSeed: shown.clientSeed,
      nonce: shown.nonce,
    },
  };
  let result: ActionResult;
  try {
    result = await send((key) => client.startRound(sent, key));
  } catch (error) {
    if (error instanceof ApiFailure) {
      const round = roundIn(error);
      if (round !== null) keepLostStartCopy(round, storage);
      else markRefused(start, storage);
    }
    throw error;
  }
  rememberShown(result.round.id, shown, storage);
  settleStarts(startsOnTheirWay(storage), storage, shown);
  return result;
}

/** The round a refusal carries (a 409 with the round as it is now, in play or over), or null. */
function roundIn(error: ApiFailure): RoundView | null {
  const round = error.body.round;
  return round !== undefined && round !== null && typeof round === 'object' ? round : null;
}

/**
 * Settles these starts on their way, then forgets every start on its way.
 * Each one keeps its seeds under a stand-in id (rememberStandIn), so what
 * the screen showed is never thrown away while it could be evidence. Two
 * kinds are dropped instead:
 * - a start the server refused with no round in its answer (marked
 *   refused). For an honest server it made no round, so a stand-in could
 *   only make a later honest round on the same nonce look wrong.
 * - after a start went through (`wentThrough`, the seeds it was bet
 *   against): a start with the same hash and nonce. One server seed and
 *   nonce belong to one round only, so it made no other round, and any
 *   round the server names with that hash and nonce is checked against the
 *   copy just saved.
 * Any other start may have made a round whose answer was lost, or that the
 * server named with another id. Its stand-in is found by that round's hash
 * and nonce on the verify page.
 */
function settleStarts(
  starts: readonly StartOnItsWay[],
  storage: HashStorage | null | undefined,
  wentThrough: SeedsBeforeRound | null = null,
): void {
  for (const start of starts) {
    if (start.refused === true) continue;
    if (
      wentThrough !== null &&
      start.shown.serverSeedHash === wentThrough.serverSeedHash &&
      start.shown.nonce === wentThrough.nonce
    ) {
      continue;
    }
    rememberStandIn(start.shown, storage);
  }
  forgetStarting(storage);
}

/** Whether this start asked for this round: the same difficulty, and the same bet on each balloon. */
function askedFor(start: StartOnItsWay, round: RoundView): boolean {
  return (
    start.difficultyId === round.difficultyId &&
    start.betsCents.length === round.balloons.length &&
    round.balloons.every((b) => start.betsCents[b.index] === b.betCents)
  );
}

/**
 * Called with the round in play whenever the whole state is loaded again
 * (the first load, a reload, or a resync after a lost answer or a refusal),
 * and with the round a start's refusal carries, in play or over. Not while
 * this tab's own start is on its way: its own answer is still to come.
 *
 * A start whose answer never came (both tries lost, or the page closed) may
 * have started this round. If this browser has no copy of it, and a start
 * on its way asked for this difficulty and these bets, the round gets the
 * seeds that start was bet against: what the screen showed, not what the
 * round says. So a server that played a round on seeds of its own and then
 * lost the answer on purpose is still checked.
 *
 * If more than one start asked for these bets, the newest one is taken,
 * whatever its answer was. Never the one whose seeds agree with the round:
 * then the server, by picking the seeds it played on, would pick which
 * start's copy the round gets. A start marked refused can still be taken
 * here, so a server that refused a start and still made its round is
 * checked too.
 *
 * Then every other start on its way is settled (settleStarts): kept under
 * a stand-in id, or dropped if it was refused.
 */
export function keepLostStartCopy(round: RoundView | null, storage?: HashStorage | null): void {
  const starting = startsOnTheirWay(storage);
  if (starting.length === 0) return;
  let rest = starting;
  if (round !== null && shownFor(round.id, storage) === null) {
    const start = starting.find((s) => askedFor(s, round));
    if (start) {
      rememberShown(round.id, start.shown, storage);
      rest = starting.filter((s) => s !== start);
    }
  }
  settleStarts(rest, storage);
}
