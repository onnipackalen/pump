import type { Db } from '../db/database';
import { int, text } from '../db/rows';

export interface ReconcileReport {
  readonly players: number;
  readonly ledgerRows: number;
  /** Empty when the books add up. Each entry says what is wrong and for whom. */
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
 *
 * The database already refuses writes that would break these. This is the
 * independent check that it worked, run after the hammer test.
 */
export function reconcile(db: Db): ReconcileReport {
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
      `player ${text(row, 'id')}: balance ${int(row, 'balance_cents')} but ledger sums to ${int(row, 'ledger_sum')}`,
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
      `player ${text(row, 'player_id')}: ledger row ${int(row, 'id')} does not continue from the row before it`,
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
      `player ${text(row, 'id')}: balance ${int(row, 'balance_cents')} but the last ledger row says ${int(row, 'last_balance')}`,
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
    problems.push(`player ${text(row, 'id')}: ${int(row, 'grants')} opening grants, expected 1`);
  }

  const players = db.prepare('SELECT COUNT(*) AS n FROM players').get();
  const ledgerRows = db.prepare('SELECT COUNT(*) AS n FROM ledger').get();
  return {
    players: players ? int(players, 'n') : 0,
    ledgerRows: ledgerRows ? int(ledgerRows, 'n') : 0,
    problems,
  };
}
