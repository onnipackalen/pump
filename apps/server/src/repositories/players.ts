import type { Db } from '../db/database';
import { int, nullableText, text, type Row } from '../db/rows';

export interface Player {
  readonly id: string;
  readonly balanceCents: number;
  /** Null until the browser has sent its first client seed. */
  readonly clientSeed: string | null;
  readonly createdAt: string;
}

function toPlayer(row: Row): Player {
  return {
    id: text(row, 'id'),
    balanceCents: int(row, 'balance_cents'),
    clientSeed: nullableText(row, 'client_seed'),
    createdAt: text(row, 'created_at'),
  };
}

export type PlayersRepository = ReturnType<typeof playersRepository>;

export function playersRepository(db: Db) {
  const insert = db.prepare(
    'INSERT INTO players (id, token_hash, created_at) VALUES (:id, :tokenHash, :at)',
  );
  const byTokenHash = db.prepare('SELECT * FROM players WHERE token_hash = :tokenHash');
  const byId = db.prepare('SELECT * FROM players WHERE id = :id');
  const updateClientSeed = db.prepare('UPDATE players SET client_seed = :clientSeed WHERE id = :id');

  return {
    /** A new player always starts with a balance of 0. */
    insert(player: { id: string; tokenHash: string; at: string }): void {
      insert.run({ id: player.id, tokenHash: player.tokenHash, at: player.at });
    },

    findByTokenHash(tokenHash: string): Player | null {
      const row = byTokenHash.get({ tokenHash });
      return row ? toPlayer(row) : null;
    },

    get(id: string): Player {
      const row = byId.get({ id });
      if (!row) throw new Error('No such player');
      return toPlayer(row);
    },

    setClientSeed(id: string, clientSeed: string): void {
      updateClientSeed.run({ id, clientSeed });
    },
  };
}
