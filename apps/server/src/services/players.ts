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

export interface ResolvedPlayer {
  readonly player: Player;
  /** Set when a new player was just created: the token to put in their cookie. */
  readonly issuedToken: string | null;
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
  function create(): ResolvedPlayer {
    const id = runtime.newId();
    const token = runtime.newToken();
    const at = runtime.now().toISOString();
    const seed = runtime.newServerSeed();
    immediate(runtime.db, () => {
      players.insert({ id, tokenHash: hashToken(token), at });
      wallet.grant(id, STARTING_BALANCE_CENTS, at);
      seeds.insert({ playerId: id, seed, seedHash: hashServerSeed(seed), at });
    });
    return { player: players.get(id), issuedToken: token };
  }

  return {
    /**
     * Finds the player a cookie token belongs to. With no token, or one we do
     * not know, this is a first visit and a new player is created.
     */
    resolve(token: string | undefined): ResolvedPlayer {
      if (token !== undefined && TOKEN_PATTERN.test(token)) {
        const player = players.findByTokenHash(hashToken(token));
        if (player) return { player, issuedToken: null };
      }
      return create();
    },
  };
}
