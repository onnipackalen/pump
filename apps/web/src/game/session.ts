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
 * are never thrown away:
 * - it goes through: they are saved under the round's id, and every start on
 *   its way is settled (settleStarts);
 * - the refusal puts a round in play on screen (a 409 that carries it): that
 *   round gets its copy now, before the player can play it
 *   (keepLostStartCopy);
 * - anything else (both tries lose the answer, or another refusal): the next
 *   full load of the state settles it (keepLostStartCopy).
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
  rememberStarting({ difficultyId, betsCents, shown }, storage);
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
    const round = roundInPlayIn(error);
    if (round !== null) keepLostStartCopy(round, storage);
    throw error;
  }
  rememberShown(result.round.id, shown, storage);
  settleStarts(storage);
  return result;
}

/** The round in play a refusal carries (a 409 with the round as it is now), or null. */
function roundInPlayIn(error: unknown): RoundView | null {
  if (!(error instanceof ApiFailure)) return null;
  const round = error.body.round;
  return round?.status === 'active' ? round : null;
}

/**
 * Settles every start on its way: each one's seeds are kept under a
 * stand-in id (rememberStandIn), then the starts are forgotten.
 *
 * Why this is safe after a start went through, and keeps the evidence: one
 * server seed and nonce belong to one round only. So a start on its way with
 * the same hash and nonce as a round this browser already has a copy of
 * cannot have made another round; it needs no copy of its own, and none is
 * saved. Any other start on its way may have made a round whose answer was
 * lost, or that the server named with another id; its stand-in is found by
 * that round's hash and nonce on the verify page.
 */
function settleStarts(storage?: HashStorage | null): void {
  for (const start of startsOnTheirWay(storage)) rememberStandIn(start.shown, storage);
  forgetStarting(storage);
}

/** Whether this start was bet against the seeds this round names: the same hash, client seed and nonce. */
function betOn(start: StartOnItsWay, round: RoundView): boolean {
  return (
    start.shown.serverSeedHash === round.serverSeedHash &&
    start.shown.clientSeed === round.clientSeed &&
    start.shown.nonce === round.nonce
  );
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
 * and with the round a start's refusal puts in play. Not while this tab's
 * own start is on its way: its own answer is still to come.
 *
 * A start whose answer never came (both tries lost, or the page closed) may
 * have started this round. If this browser has no copy of it, and a start
 * on its way asked for this difficulty and these bets, the round gets the
 * seeds that start was bet against: what the screen showed, not what the
 * round says. So a server that played a round on seeds of its own and then
 * lost the answer on purpose is still checked. With two tabs, two starts can
 * ask for the same bets: the one bet against the seeds the round names is
 * taken first (an honest server plays a round on exactly those), and
 * otherwise the newest.
 *
 * Then every start on its way is settled (settleStarts). A start that made
 * no copy under this round's id (the round already had one, or it asked for
 * other bets, or there is no round in play because its round is over) keeps
 * its seeds under a stand-in id, unless a copy with the same hash and nonce
 * is already saved. So what the screen showed for a start is never thrown
 * away.
 */
export function keepLostStartCopy(activeRound: RoundView | null, storage?: HashStorage | null): void {
  const starting = startsOnTheirWay(storage);
  if (starting.length === 0) return;
  if (activeRound !== null && shownFor(activeRound.id, storage) === null) {
    const asked = starting.filter((s) => askedFor(s, activeRound));
    const start = asked.find((s) => betOn(s, activeRound)) ?? asked[0];
    if (start) rememberShown(activeRound.id, start.shown, storage);
  }
  settleStarts(storage);
}
