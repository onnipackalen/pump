import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { immediate } from '../src/db/transaction';
import { count, insertActiveRound, testRuntime } from './helpers';

// These tests go around the application and write SQL by hand, the way a bug
// or a careless script would. The database itself must refuse each one.

const AT = '2026-01-01T00:00:00.000Z';
let db: Db;

/** A player with a grant of 1,000 cents and one active seed, written correctly. */
function seedPlayer(id = 'p1'): void {
  immediate(db, () => {
    db.prepare('INSERT INTO players (id, token_hash, created_at) VALUES (?, ?, ?)').run(
      id,
      `hash-${id}`,
      AT,
    );
    db.prepare(
      `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
       VALUES (?, 'grant', 1000, 1000, ?)`,
    ).run(id, AT);
    db.prepare('UPDATE players SET balance_cents = 1000 WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO server_seeds (player_id, seed, seed_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, `seed-${id}`, `seed-hash-${id}`, AT);
  });
}

/** A bet of 100 cents on balloon 0 of round-1, written correctly. */
function placeBet(): void {
  insertActiveRound(db, 'p1');
  immediate(db, () => {
    db.exec(
      `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                           round_id, balloon_index, created_at)
       VALUES ('p1', 'bet', -100, 900, 'round-1', 0, '${AT}')`,
    );
    db.exec("UPDATE players SET balance_cents = 900 WHERE id = 'p1'");
  });
}

beforeEach(() => {
  db = testRuntime().db;
  seedPlayer();
});

describe('the ledger is append-only', () => {
  it('refuses to change a row', () => {
    expect(() => db.exec('UPDATE ledger SET amount_cents = 5000')).toThrow('append-only');
  });

  it('refuses to delete a row', () => {
    expect(() => db.exec('DELETE FROM ledger')).toThrow('append-only');
    expect(count(db, 'ledger')).toBe(1);
  });
});

describe('the balance cannot drift from the ledger', () => {
  it('refuses a balance change that has no ledger row behind it', () => {
    expect(() => db.exec("UPDATE players SET balance_cents = 999999 WHERE id = 'p1'")).toThrow(
      'must equal the last ledger row',
    );
  });

  it('refuses a ledger row that does not continue from the previous balance', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'payout', 500, 5000, 'r', 0, '${AT}')`,
      ),
    ).toThrow('must continue from the previous balance');
  });

  it('refuses a balance below zero', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'bet', -1001, -1, 'r', 0, '${AT}')`,
      ),
    ).toThrow('CHECK constraint failed');
  });

  it('refuses a new player who starts with money', () => {
    expect(() =>
      db.exec(
        `INSERT INTO players (id, token_hash, balance_cents, created_at)
         VALUES ('rich', 'h', 1000000, '${AT}')`,
      ),
    ).toThrow('starts at 0');
  });
});

describe('ledger rows must make sense', () => {
  it('refuses a bet that adds money and a payout that takes it', () => {
    insertActiveRound(db, 'p1');
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'bet', 100, 1100, 'round-1', 0, '${AT}')`,
      ),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'payout', -100, 900, 'round-1', 0, '${AT}')`,
      ),
    ).toThrow('CHECK constraint failed');
  });

  it('refuses an unknown kind of row', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
         VALUES ('p1', 'bonus', 100, 1100, '${AT}')`,
      ),
    ).toThrow('CHECK constraint failed');
  });

  it('refuses a row for a round that does not exist', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'bet', -100, 900, 'no-such-round', 0, '${AT}')`,
      ),
    ).toThrow('FOREIGN KEY constraint failed');
  });
});

describe('the same money is never handed out twice', () => {
  it('refuses a second opening grant', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
         VALUES ('p1', 'grant', 1000, 2000, '${AT}')`,
      ),
    ).toThrow('UNIQUE constraint failed');
  });

  it('refuses a second payout on one balloon', () => {
    placeBet();
    const pay = (after: number): void => {
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'payout', 150, ${String(after)}, 'round-1', 0, '${AT}')`,
      );
    };
    immediate(db, () => {
      pay(1050);
      db.exec("UPDATE players SET balance_cents = 1050 WHERE id = 'p1'");
    });
    expect(() => {
      pay(1200);
    }).toThrow('UNIQUE constraint failed');
  });

  it('refuses a refund on a balloon that was already paid', () => {
    placeBet();
    immediate(db, () => {
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'payout', 150, 1050, 'round-1', 0, '${AT}')`,
      );
      db.exec("UPDATE players SET balance_cents = 1050 WHERE id = 'p1'");
    });
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'refund', 100, 1150, 'round-1', 0, '${AT}')`,
      ),
    ).toThrow('UNIQUE constraint failed');
  });

  it('refuses a second bet on one balloon', () => {
    placeBet();
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                             round_id, balloon_index, created_at)
         VALUES ('p1', 'bet', -100, 800, 'round-1', 0, '${AT}')`,
      ),
    ).toThrow('UNIQUE constraint failed');
  });
});

describe('rounds', () => {
  it('allows one active round per player, and refuses a second', () => {
    insertActiveRound(db, 'p1', 'round-1');
    expect(() => {
      insertActiveRound(db, 'p1', 'round-2');
    }).toThrow('UNIQUE constraint failed');
  });

  it('refuses two rounds on the same server seed and nonce', () => {
    insertActiveRound(db, 'p1', 'round-1');
    db.exec(
      "UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T00:01:00.000Z' WHERE id = 'round-1'",
    );
    expect(() =>
      db.exec(
        `INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder,
                             server_seed_id, client_seed, nonce, started_at, last_action_at)
         SELECT 'round-2', player_id, 'active', 'easy', 9700, '[101]',
                server_seed_id, 'seed', nonce, '${AT}', '${AT}'
         FROM rounds WHERE id = 'round-1'`,
      ),
    ).toThrow('UNIQUE constraint failed');
  });
});

describe('server seeds', () => {
  it('allows one active seed per player', () => {
    expect(() =>
      db.exec(
        `INSERT INTO server_seeds (player_id, seed, seed_hash, created_at)
         VALUES ('p1', 'another', 'another-hash', '${AT}')`,
      ),
    ).toThrow('UNIQUE constraint failed');
  });

  it('never lets a nonce go back', () => {
    db.exec('UPDATE server_seeds SET next_nonce = 5');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 4')).toThrow('only goes up');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 0')).toThrow('only goes up');
  });

  it('never lets a seed or its hash be swapped', () => {
    expect(() => db.exec("UPDATE server_seeds SET seed = 'other'")).toThrow('never changes');
    expect(() => db.exec("UPDATE server_seeds SET seed_hash = 'other'")).toThrow('never changes');
  });

  it('freezes a seed once it is revealed', () => {
    db.exec(`UPDATE server_seeds SET revealed_at = '${AT}'`);
    expect(() => db.exec('UPDATE server_seeds SET revealed_at = NULL')).toThrow('finished');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 9')).toThrow('finished');
  });

  it('is never deleted', () => {
    expect(() => db.exec('DELETE FROM server_seeds')).toThrow('never deleted');
  });
});
