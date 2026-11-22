import { NetworkFailure, type GameClient } from '../api/client';
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
  rememberShown,
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
 * that same copy. If both tries lose the answer, the start is still
 * remembered as on its way, and the next full load of the state gives the
 * round it started this copy (keepLostStartCopy).
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
  rememberStarting({ difficultyId: request.difficultyId, betsCents: request.betsCents, shown }, storage);
  const result = await send((key) => client.startRound(request, key));
  rememberShown(result.round.id, shown, storage);
  // A start went through, so no earlier start left a round in play.
  forgetStarting(storage);
  return result;
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
 * Called with the round in play whenever the whole state is loaded again:
 * the first load, a reload, or a resync after a lost answer or a refusal
 * (round_active, say). Not while a start is on its way: its own answer is
 * still to come.
 *
 * A start whose answer never came (both tries lost, or the page closed) may
 * have started this round. If this browser has no copy of it, and the
 * newest start on its way asked for this difficulty and these bets, the
 * round gets the seeds that start was bet against: what the screen showed,
 * not what the round says. So a server that played a round on seeds of its
 * own and then lost the answer on purpose is still checked.
 *
 * Then no start is on its way any more: with a round in play, any other
 * start was refused; with none, none of them started a round still in play.
 */
export function keepLostStartCopy(activeRound: RoundView | null, storage?: HashStorage | null): void {
  const starting = startsOnTheirWay(storage);
  if (starting.length === 0) return;
  if (activeRound !== null && shownFor(activeRound.id, storage) === null) {
    const start = starting.find((s) => askedFor(s, activeRound));
    if (start) rememberShown(activeRound.id, start.shown, storage);
  }
  forgetStarting(storage);
}
