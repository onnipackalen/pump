import type { FairnessView, RotateResult } from '@pump/contract';
import { hashServerSeed, isClientSeed } from '@pump/engine/fair';
import { assertInTransaction } from '../db/transaction';
import { ApiError } from '../errors';
import type { PlayersRepository } from '../repositories/players';
import type { RoundsRepository } from '../repositories/rounds';
import type { SeedsRepository } from '../repositories/seeds';
import type { Runtime } from '../runtime';

export type FairnessService = ReturnType<typeof fairnessService>;

/**
 * The seeds a player's rounds are drawn from.
 *
 * The server seed is secret while it is in use: only its hash is shown.
 * Rotating retires it, reveals it, and starts a new one. Nothing here can
 * return an active seed, because the repository does not read that column
 * until the seed has been revealed.
 */
export function fairnessService(
  runtime: Runtime,
  players: PlayersRepository,
  seeds: SeedsRepository,
  rounds: RoundsRepository,
) {
  function view(playerId: string): FairnessView {
    const player = players.get(playerId);
    const seed = seeds.active(playerId);
    return {
      serverSeedHash: seed.seedHash,
      clientSeed: player.clientSeed,
      nextNonce: seed.nextNonce,
    };
  }

  /** Seeds cannot change during a round: the round was promised these ones. */
  function assertNoActiveRound(playerId: string): void {
    if (rounds.hasActive(playerId)) {
      throw new ApiError(
        'round_active',
        'Finish the round in progress first. Seeds cannot change during a round.',
      );
    }
  }

  return {
    view,

    /**
     * Sets the player's client seed for future rounds. The nonce is left
     * alone: it belongs to the server seed and never goes back.
     */
    setClientSeed(playerId: string, clientSeed: string): FairnessView {
      assertInTransaction(runtime.db);
      if (!isClientSeed(clientSeed)) {
        throw new ApiError(
          'invalid_request',
          'A client seed is 1 to 64 characters from A-Z, a-z, 0-9, _ and -.',
        );
      }
      assertNoActiveRound(playerId);
      players.setClientSeed(playerId, clientSeed);
      return view(playerId);
    },

    /**
     * Retires the active server seed, reveals it, and starts a new one with
     * its nonce at 0. Every round played on the old seed can now be checked.
     */
    rotate(playerId: string): RotateResult {
      assertInTransaction(runtime.db);
      assertNoActiveRound(playerId);
      const at = runtime.now().toISOString();
      const revealed = seeds.reveal(seeds.active(playerId).id, at);
      const next = runtime.newServerSeed();
      seeds.insert({ playerId, seed: next, seedHash: hashServerSeed(next), at });
      return {
        revealed: {
          serverSeed: revealed.seed,
          serverSeedHash: revealed.seedHash,
          roundsPlayed: revealed.roundsPlayed,
        },
        fairness: view(playerId),
      };
    },
  };
}
