import { createHash } from 'node:crypto';
import { hashServerSeed } from '@pump/engine/fair';
import { immediate } from '../db/transaction';
import type { Player, PlayersRepository } from '../repositories/players';
import type { SeedsRepository } from '../repositories/seeds';
import type { Runtime } from '../runtime';
import { STARTING_BALANCE_CENTS } from '../settings';
import type { WalletService } from './wallet';

/** A cookie token is 32 random bytes in base64url: exactly 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Only the hash of a token is stored, so the database cannot be used to log in. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

export interface NewPlayer {
  readonly player: Player;
  /** The token to put in the new player's cookie. It is not stored anywhere else. */
  readonly token: string;
}

export type PlayersService = ReturnType<typeof playersService>;

export function playersService(
  runtime: Runtime,
  players: PlayersRepository,
  seeds: SeedsRepository,
  wallet: WalletService,
) {
  /**
   * Creates a player in one transaction: the player row, the opening grant
   * through the ledger, and their first server seed.
   */
  function create(): NewPlayer {
    const id = runtime.newId();
    const token = runtime.newToken();
    const at = runtime.now().toISOString();
    const seed = runtime.newServerSeed();
    immediate(runtime.db, () => {
      players.insert({ id, tokenHash: hashToken(token), at });
      wallet.grant(id, STARTING_BALANCE_CENTS, at);
      seeds.insert({ playerId: id, seed, seedHash: hashServerSeed(seed), at });
    });
    return { player: players.get(id), token };
  }

  return {
    /** The player a cookie token belongs to, or null if there is none. */
    find(token: string | undefined): Player | null {
      if (token === undefined || !TOKEN_PATTERN.test(token)) return null;
      return players.findByTokenHash(hashToken(token));
    },

    /** A first visit: a new player with the opening balance and a first server seed. */
    create,
  };
}
