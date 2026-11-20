import type { Db } from '../db/database';
import { int, text, type Row } from '../db/rows';

/** One finished round, summed up for the history list. */
export interface FinishedRound {
  readonly id: string;
  readonly difficultyId: string;
  readonly balloonCount: number;
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  readonly serverSeedHash: string;
  readonly nonce: number;
  readonly finishedAt: string;
}

function toFinishedRound(row: Row): FinishedRound {
  return {
    id: text(row, 'id'),
    difficultyId: text(row, 'difficulty_id'),
    balloonCount: int(row, 'balloon_count'),
    betCents: int(row, 'bet_cents'),
    patchesCents: int(row, 'patches_cents'),
    payoutCents: int(row, 'payout_cents'),
    serverSeedHash: text(row, 'seed_hash'),
    nonce: int(row, 'nonce'),
    finishedAt: text(row, 'finished_at'),
  };
}

export type RoundsRepository = ReturnType<typeof roundsRepository>;

/**
 * Reading rounds. Starting and playing a round is added with the game
 * service, once the engine is in place.
 */
export function roundsRepository(db: Db) {
  const countActive = db.prepare(
    "SELECT COUNT(*) AS n FROM rounds WHERE player_id = :playerId AND status = 'active'",
  );
  const selectFinished = db.prepare(`
    SELECT r.id, r.difficulty_id, r.nonce, r.finished_at, s.seed_hash,
           COUNT(b.balloon_index)            AS balloon_count,
           COALESCE(SUM(b.bet_cents), 0)     AS bet_cents,
           COALESCE(SUM(b.patches_cents), 0) AS patches_cents,
           COALESCE(SUM(b.payout_cents), 0)  AS payout_cents
    FROM rounds r
    JOIN server_seeds s ON s.id = r.server_seed_id
    LEFT JOIN balloons b ON b.round_id = r.id
    WHERE r.player_id = :playerId AND r.status = 'finished'
    GROUP BY r.id
    ORDER BY r.finished_at DESC, r.id DESC
    LIMIT :limit
  `);

  return {
    hasActive(playerId: string): boolean {
      const row = countActive.get({ playerId });
      return row !== undefined && int(row, 'n') > 0;
    },

    /** The player's latest finished rounds, newest first. */
    latestFinished(playerId: string, limit: number): FinishedRound[] {
      return selectFinished.all({ playerId, limit }).map(toFinishedRound);
    },
  };
}
