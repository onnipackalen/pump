import { NetworkFailure, type GameClient } from '../api/client';
import type { FairnessView, RoundSummary, RoundView, SessionView } from '../api/contract';
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
): Promise<OpenedGame> {
  const session = await client.getSession();
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
