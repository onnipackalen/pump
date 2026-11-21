import type { Db } from '../db/database';
import { int, text, type Row } from '../db/rows';

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
 * 10. reveals match the balloons exactly: a finished round has one for each
 *     balloon cashed out below its top rung and none for any other balloon,
 *     and a round in progress has none. Each reveal fits its balloon (see
 *     revealProblem). Rounds started before reveals existed (no stored cap)
 *     may have finished without them, so for those a missing reveal is not
 *     a problem.
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

  const missingReveals = db
    .prepare(
      `SELECT b.round_id, b.balloon_index, b.rung, b.top_rung
       FROM balloons b
       JOIN rounds r ON r.id = b.round_id
       LEFT JOIN balloon_reveals v
         ON v.round_id = b.round_id AND v.balloon_index = b.balloon_index
       WHERE r.status = 'finished' AND r.max_payout_cents IS NOT NULL
         AND b.status = 'cashed' AND b.rung < b.top_rung AND v.round_id IS NULL`,
    )
    .all();
  for (const row of missingReveals) {
    problems.push(
      `round ${text(row, 'round_id')} balloon ${String(int(row, 'balloon_index'))}: ` +
        `cashed out on rung ${String(int(row, 'rung'))}, below its top rung ` +
        `${String(int(row, 'top_rung'))}, but has no reveal`,
    );
  }

  const reveals = db
    .prepare(
      `SELECT v.round_id, v.balloon_index, v.outcome, v.reached_rung, v.draws_json,
              r.status AS round_status, b.status, b.rung, b.draw_index, b.top_rung
       FROM balloon_reveals v
       JOIN rounds r ON r.id = v.round_id
       JOIN balloons b ON b.round_id = v.round_id AND b.balloon_index = v.balloon_index`,
    )
    .all();
  for (const row of reveals) {
    const problem = revealProblem(row);
    if (problem !== null) {
      problems.push(
        `round ${text(row, 'round_id')} balloon ${String(int(row, 'balloon_index'))}: ${problem}`,
      );
    }
  }

  return problems;
}

/** One stored reveal draw, as far as the books can check it without the seeds. */
interface StoredDraw {
  readonly drawIndex: number;
  readonly den: number;
  readonly num: number;
  readonly roll: number;
}

function wholeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** The reveal's draws, or null if they are not a list of four whole numbers each. */
function storedDraws(json: string): StoredDraw[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const draws: StoredDraw[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const fields: Readonly<Record<string, unknown>> = { ...item };
    const drawIndex = wholeOrNull(fields.drawIndex);
    const den = wholeOrNull(fields.den);
    const num = wholeOrNull(fields.num);
    const roll = wholeOrNull(fields.roll);
    if (drawIndex === null || den === null || num === null || roll === null) return null;
    draws.push({ drawIndex, den, num, roll });
  }
  return draws;
}

/**
 * What is wrong with one stored reveal, or null. Without the seeds the rolls
 * themselves cannot be checked here (the verify page does that); what can be
 * checked is that the reveal fits its balloon and tells one story:
 *
 *   - its round is finished, and its balloon was cashed out below its top;
 *   - its draws start at the balloon's draw count and go up one at a time;
 *   - with rung r and top T: 'popped' stops on a rung from r to T - 1 after
 *     (that rung - r + 1) draws, 'top' stops on T after T - r draws;
 *   - every roll is below its den, every draw survives (roll < num) except
 *     the last one of a 'popped' reveal, which pops.
 */
function revealProblem(row: Row): string | null {
  const status = text(row, 'status');
  const rung = int(row, 'rung');
  const top = int(row, 'top_rung');
  if (text(row, 'round_status') !== 'finished') {
    return 'has a reveal while its round is still in progress';
  }
  if (status !== 'cashed' || rung >= top) {
    return `${status} on rung ${String(rung)} of ${String(top)}, so it has no reveal, but one is stored`;
  }
  const draws = storedDraws(text(row, 'draws_json'));
  if (draws === null) return 'its reveal draws cannot be read';
  const outcome = text(row, 'outcome');
  const reached = int(row, 'reached_rung');
  const due =
    outcome === 'popped' && reached >= rung && reached < top
      ? reached - rung + 1
      : outcome === 'top' && reached === top
        ? top - rung
        : null;
  if (due === null) {
    return `its reveal says ${outcome} on rung ${String(reached)}, outside rungs ${String(rung)} to ${String(top)}`;
  }
  if (draws.length !== due) {
    return `its reveal has ${String(draws.length)} draws, but ${outcome} on rung ${String(reached)} needs ${String(due)}`;
  }
  const first = int(row, 'draw_index');
  for (const [i, draw] of draws.entries()) {
    if (draw.drawIndex !== first + i) {
      return `its reveal draws do not start at draw ${String(first)} and go up one at a time`;
    }
    const pops = outcome === 'popped' && i === draws.length - 1;
    if (draw.roll < 0 || draw.roll >= draw.den || draw.num < 1 || draw.num >= draw.den) {
      return `its reveal draw ${String(draw.drawIndex)} is not a roll below its den`;
    }
    if (pops === draw.roll < draw.num) {
      return `its reveal draw ${String(draw.drawIndex)} does not match the outcome ${outcome}`;
    }
  }
  return null;
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
