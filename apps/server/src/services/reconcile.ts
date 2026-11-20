import type { Db } from '../db/database';
import { int, text } from '../db/rows';

export interface ReconcileReport {
  readonly players: number;
  readonly ledgerRows: number;
  readonly rounds: number;
  /** Empty when the books add up. Each entry says what is wrong and where. */
  readonly problems: readonly string[];
}

/**
 * Checks, from the stored data alone, that the wallet adds up:
 *
 * 1. every balance equals the sum of that player's ledger rows;
 * 2. every ledger row continues from the row before it (balance after =
 *    balance before + amount), so no row was slipped in, changed or removed;
 * 3. every balance equals the last ledger row's running balance;
 * 4. every player has exactly one opening grant.
 */
export function walletProblems(db: Db): string[] {
  const problems: string[] = [];

  const sums = db
    .prepare(
      `SELECT p.id, p.balance_cents, COALESCE(SUM(l.amount_cents), 0) AS ledger_sum
       FROM players p LEFT JOIN ledger l ON l.player_id = p.id
       GROUP BY p.id
       HAVING p.balance_cents <> COALESCE(SUM(l.amount_cents), 0)`,
    )
    .all();
  for (const row of sums) {
    problems.push(
      `player ${text(row, 'id')}: balance ${String(int(row, 'balance_cents'))} ` +
        `but ledger sums to ${String(int(row, 'ledger_sum'))}`,
    );
  }

  const breaks = db
    .prepare(
      `SELECT id, player_id FROM (
         SELECT id, player_id,
                balance_after_cents - amount_cents AS balance_before,
                LAG(balance_after_cents, 1, 0) OVER (PARTITION BY player_id ORDER BY id) AS previous
         FROM ledger
       ) WHERE balance_before <> previous`,
    )
    .all();
  for (const row of breaks) {
    problems.push(
      `player ${text(row, 'player_id')}: ledger row ${String(int(row, 'id'))} ` +
        `does not continue from the row before it`,
    );
  }

  const lastRows = db
    .prepare(
      `SELECT p.id, p.balance_cents,
              COALESCE((SELECT balance_after_cents FROM ledger
                        WHERE player_id = p.id ORDER BY id DESC LIMIT 1), 0) AS last_balance
       FROM players p
       WHERE p.balance_cents <> COALESCE((SELECT balance_after_cents FROM ledger
                                          WHERE player_id = p.id ORDER BY id DESC LIMIT 1), 0)`,
    )
    .all();
  for (const row of lastRows) {
    problems.push(
      `player ${text(row, 'id')}: balance ${String(int(row, 'balance_cents'))} ` +
        `but the last ledger row says ${String(int(row, 'last_balance'))}`,
    );
  }

  const grants = db
    .prepare(
      `SELECT p.id, COUNT(l.id) AS grants
       FROM players p LEFT JOIN ledger l ON l.player_id = p.id AND l.kind = 'grant'
       GROUP BY p.id
       HAVING COUNT(l.id) <> 1`,
    )
    .all();
  for (const row of grants) {
    problems.push(
      `player ${text(row, 'id')}: ${String(int(row, 'grants'))} opening grants, expected 1`,
    );
  }

  return problems;
}

/**
 * Checks that the rounds tell the same story as the ledger:
 *
 * 5. every balloon has exactly one bet row for its bet, and its Patches equal
 *    the Patch rows charged for it;
 * 6. a cashed balloon was paid exactly its recorded payout, once; a refunded
 *    balloon got exactly its bet back; a popped or active balloon got nothing;
 * 7. every ledger row for a round belongs to a balloon of the same player;
 * 8. a finished round has no balloon in play, and an active one has at least
 *    one; no player has two active rounds;
 * 9. every draw a balloon used is recorded as a pump, numbered 0, 1, 2, ...
 */
export function roundProblems(db: Db): string[] {
  const problems: string[] = [];

  const balloonMoney = db
    .prepare(
      `SELECT b.round_id, b.balloon_index, b.status, b.bet_cents, b.patches_cents, b.payout_cents,
              COALESCE(SUM(CASE WHEN l.kind = 'bet'    THEN 1 END), 0)               AS bet_rows,
              COALESCE(SUM(CASE WHEN l.kind = 'bet'    THEN -l.amount_cents END), 0) AS bet_paid,
              COALESCE(SUM(CASE WHEN l.kind = 'patch'  THEN -l.amount_cents END), 0) AS patch_paid,
              COALESCE(SUM(CASE WHEN l.kind = 'payout' THEN l.amount_cents END), 0)  AS paid_out,
              COALESCE(SUM(CASE WHEN l.kind = 'refund' THEN l.amount_cents END), 0)  AS refunded
       FROM balloons b
       LEFT JOIN ledger l ON l.round_id = b.round_id AND l.balloon_index = b.balloon_index
       GROUP BY b.round_id, b.balloon_index`,
    )
    .all();
  for (const row of balloonMoney) {
    const where = `round ${text(row, 'round_id')} balloon ${String(int(row, 'balloon_index'))}`;
    const status = text(row, 'status');
    const bet = int(row, 'bet_cents');
    const patches = int(row, 'patches_cents');
    const payout = int(row, 'payout_cents');
    const paidOut = int(row, 'paid_out');
    const refunded = int(row, 'refunded');
    if (int(row, 'bet_rows') !== 1 || int(row, 'bet_paid') !== bet) {
      problems.push(`${where}: the ledger does not hold exactly one bet of ${String(bet)}`);
    }
    if (int(row, 'patch_paid') !== patches) {
      problems.push(
        `${where}: Patches of ${String(patches)} recorded ` +
          `but the ledger charged ${String(int(row, 'patch_paid'))}`,
      );
    }
    // What the ledger must have paid for a balloon that ended this way.
    const owedPayout = status === 'cashed' ? payout : 0;
    const owedRefund = status === 'refunded' ? bet : 0;
    if (paidOut !== owedPayout || refunded !== owedRefund) {
      problems.push(
        `${where}: ${status}, so payout ${String(owedPayout)} and refund ${String(owedRefund)} ` +
          `are due, but the ledger paid ${String(paidOut)} and refunded ${String(refunded)}`,
      );
    }
    if (status === 'cashed' ? payout <= 0 : payout !== 0) {
      problems.push(`${where}: ${status} with a recorded payout of ${String(payout)}`);
    }
  }

  const strayRows = db
    .prepare(
      `SELECT l.id FROM ledger l
       LEFT JOIN rounds r ON r.id = l.round_id
       LEFT JOIN balloons b ON b.round_id = l.round_id AND b.balloon_index = l.balloon_index
       WHERE l.round_id IS NOT NULL
         AND (r.id IS NULL OR b.round_id IS NULL OR r.player_id <> l.player_id)`,
    )
    .all();
  for (const row of strayRows) {
    problems.push(`ledger row ${String(int(row, 'id'))} is not for a balloon of its own player`);
  }

  const roundStates = db
    .prepare(
      `SELECT r.id, r.status,
              COALESCE(SUM(CASE WHEN b.status = 'active' THEN 1 END), 0) AS active_balloons,
              COUNT(b.balloon_index) AS balloons
       FROM rounds r LEFT JOIN balloons b ON b.round_id = r.id
       GROUP BY r.id`,
    )
    .all();
  for (const row of roundStates) {
    const id = text(row, 'id');
    const active = int(row, 'active_balloons');
    const status = text(row, 'status');
    if (int(row, 'balloons') < 1) problems.push(`round ${id}: has no balloons`);
    if (status === 'finished' && active > 0) {
      problems.push(`round ${id}: finished with ${String(active)} balloon(s) still in play`);
    }
    if (status === 'active' && active === 0) {
      problems.push(`round ${id}: still active with no balloon in play`);
    }
  }

  const doubleRounds = db
    .prepare(
      `SELECT player_id, COUNT(*) AS n FROM rounds WHERE status = 'active'
       GROUP BY player_id HAVING COUNT(*) > 1`,
    )
    .all();
  for (const row of doubleRounds) {
    problems.push(`player ${text(row, 'player_id')}: ${String(int(row, 'n'))} active rounds`);
  }

  const drawCounts = db
    .prepare(
      `SELECT b.round_id, b.balloon_index, b.draw_index, COUNT(a.draw_index) AS pumps
       FROM balloons b
       LEFT JOIN balloon_actions a
         ON a.round_id = b.round_id AND a.balloon_index = b.balloon_index AND a.kind = 'pump'
       GROUP BY b.round_id, b.balloon_index
       HAVING COUNT(a.draw_index) <> b.draw_index
           OR COALESCE(MAX(a.draw_index), -1) <> b.draw_index - 1`,
    )
    .all();
  for (const row of drawCounts) {
    problems.push(
      `round ${text(row, 'round_id')} balloon ${String(int(row, 'balloon_index'))}: ` +
        `${String(int(row, 'draw_index'))} draws used but ${String(int(row, 'pumps'))} pumps recorded`,
    );
  }

  return problems;
}

function countOf(db: Db, table: 'players' | 'ledger' | 'rounds'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row ? int(row, 'n') : 0;
}

/**
 * The whole check: the wallet adds up, and the rounds agree with it.
 *
 * The database already refuses writes that would break these rules. This is
 * the independent check that it worked, and what "npm run hammer" runs after
 * firing its overlapping requests.
 */
export function reconcile(db: Db): ReconcileReport {
  return {
    players: countOf(db, 'players'),
    ledgerRows: countOf(db, 'ledger'),
    rounds: countOf(db, 'rounds'),
    problems: [...walletProblems(db), ...roundProblems(db)],
  };
}
