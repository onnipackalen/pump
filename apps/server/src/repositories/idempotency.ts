import type { Db } from '../db/database';
import { int, text } from '../db/rows';

/** The answer first given to a (player, key) pair. */
export interface StoredAnswer {
  /** Fingerprint of the request that produced it. */
  readonly requestHash: string;
  readonly status: number;
  /** The response body, as JSON text. */
  readonly body: string;
}

export type IdempotencyRepository = ReturnType<typeof idempotencyRepository>;

export function idempotencyRepository(db: Db) {
  const select = db.prepare(`
    SELECT request_hash, status, body FROM idempotency_keys
    WHERE player_id = :playerId AND key = :key
  `);
  const insert = db.prepare(`
    INSERT INTO idempotency_keys (player_id, key, request_hash, status, body, created_at)
    VALUES (:playerId, :key, :requestHash, :status, :body, :at)
  `);

  return {
    find(playerId: string, key: string): StoredAnswer | null {
      const row = select.get({ playerId, key });
      if (!row) return null;
      return {
        requestHash: text(row, 'request_hash'),
        status: int(row, 'status'),
        body: text(row, 'body'),
      };
    },

    insert(answer: StoredAnswer & { playerId: string; key: string; at: string }): void {
      insert.run({
        playerId: answer.playerId,
        key: answer.key,
        requestHash: answer.requestHash,
        status: answer.status,
        body: answer.body,
        at: answer.at,
      });
    },
  };
}
