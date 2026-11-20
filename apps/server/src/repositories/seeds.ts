import type { Db } from '../db/database';
import { int, text, type Row } from '../db/rows';

/**
 * What may be shown about a server seed while it is still in use: its hash
 * and its nonce counter. The seed itself is deliberately not in this type.
 */
export interface ActiveSeed {
  readonly id: number;
  readonly seedHash: string;
  /** The nonce the next round under this seed will use. */
  readonly nextNonce: number;
}

/** A seed that has been retired. Only now may the seed itself be read. */
export interface RevealedSeed {
  readonly seed: string;
  readonly seedHash: string;
  /** Rounds played on it used nonces 0 to roundsPlayed - 1. */
  readonly roundsPlayed: number;
}

function toActiveSeed(row: Row): ActiveSeed {
  return {
    id: int(row, 'id'),
    seedHash: text(row, 'seed_hash'),
    nextNonce: int(row, 'next_nonce'),
  };
}

export type SeedsRepository = ReturnType<typeof seedsRepository>;

export function seedsRepository(db: Db) {
  const insert = db.prepare(`
    INSERT INTO server_seeds (player_id, seed, seed_hash, created_at)
    VALUES (:playerId, :seed, :seedHash, :at)
  `);
  // Note the column list: the seed column is not selected.
  const selectActive = db.prepare(`
    SELECT id, seed_hash, next_nonce FROM server_seeds
    WHERE player_id = :playerId AND revealed_at IS NULL
  `);
  const reveal = db.prepare(`
    UPDATE server_seeds SET revealed_at = :at
    WHERE id = :id AND revealed_at IS NULL
  `);
  // Reads the seed itself, and only works once it has been revealed.
  const selectRevealed = db.prepare(`
    SELECT seed, seed_hash, next_nonce FROM server_seeds
    WHERE id = :id AND revealed_at IS NOT NULL
  `);

  return {
    /** Stores a new active seed, with its nonce at 0. */
    insert(seed: { playerId: string; seed: string; seedHash: string; at: string }): void {
      insert.run({
        playerId: seed.playerId,
        seed: seed.seed,
        seedHash: seed.seedHash,
        at: seed.at,
      });
    },

    /** The player's active seed, without the seed itself. */
    active(playerId: string): ActiveSeed {
      const row = selectActive.get({ playerId });
      if (!row) throw new Error('Player has no active server seed');
      return toActiveSeed(row);
    },

    /** Retires a seed and returns it. From here on it is public. */
    reveal(id: number, at: string): RevealedSeed {
      const changed = reveal.run({ id, at });
      if (Number(changed.changes) !== 1) throw new Error('Seed is not active');
      const row = selectRevealed.get({ id });
      if (!row) throw new Error('Seed was not revealed');
      return {
        seed: text(row, 'seed'),
        seedHash: text(row, 'seed_hash'),
        roundsPlayed: int(row, 'next_nonce'),
      };
    },
  };
}
