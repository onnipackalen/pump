import { GAME_CONFIG } from '@pump/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { immediate } from '../src/db/transaction';
import { walletProblems } from '../src/services/reconcile';
import { cashOutByHand, count, insertActiveRound, testRuntime } from './helpers';

// These tests go around the application and write SQL by hand, the way a bug
// or a careless script would. The database itself must refuse each one.

const AT = '2026-01-01T00:00:00.000Z';
const CAP = String(GAME_CONFIG.limits.maxPayoutCents);
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
    db.prepare(
      'INSERT INTO server_seeds (player_id, seed, seed_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, `seed-${id}`, `seed-hash-${id}`, AT);
  });
}

/** One ledger row for balloon 0 of round-1, with the running balance given. */
function row(kind: string, amount: number, after: number, extra = ''): string {
  return `INSERT ${extra} INTO ledger (player_id, kind, amount_cents, balance_after_cents,
                                       round_id, balloon_index, created_at)
          VALUES ('p1', '${kind}', ${String(amount)}, ${String(after)}, 'round-1', 0, '${AT}')`;
}

/** A round with one $1 balloon, its bet charged. Balance 900. */
function placeBet(): void {
  insertActiveRound(db, 'p1', 'round-1', [100]);
  db.exec(row('bet', -100, 900));
}

function balance(): number {
  return Number(db.prepare("SELECT balance_cents FROM players WHERE id = 'p1'").get()?.balance_cents);
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

  it('refuses INSERT OR REPLACE, which would delete a row to make room for another', () => {
    // Swap the grant for a bigger one, by id and by the one-grant rule.
    expect(() =>
      db.exec(`INSERT OR REPLACE INTO ledger (id, player_id, kind, amount_cents, balance_after_cents, created_at)
               VALUES (1, 'p1', 'grant', 2000, 3000, '${AT}')`),
    ).toThrow('already moved');
    expect(() =>
      db.exec(`REPLACE INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
               VALUES ('p1', 'grant', 2000, 3000, '${AT}')`),
    ).toThrow('already moved');
    expect(balance()).toBe(1000);
    expect(walletProblems(db)).toEqual([]);
  });

  it('refuses REPLACE even on a connection that never switched the second lock on', () => {
    db.exec('PRAGMA recursive_triggers = OFF');
    expect(() =>
      db.exec(`INSERT OR REPLACE INTO ledger (id, player_id, kind, amount_cents, balance_after_cents, created_at)
               VALUES (1, 'p1', 'grant', 2000, 3000, '${AT}')`),
    ).toThrow('already moved');
    expect(() => db.exec("REPLACE INTO players (id, token_hash, created_at) VALUES ('p1', 'x', 'now')")).toThrow(
      'never replaced',
    );
    expect(balance()).toBe(1000);
  });

  it('refuses a row slipped in before the last one', () => {
    placeBet();
    expect(() =>
      db.exec(`INSERT INTO ledger (id, player_id, kind, amount_cents, balance_after_cents,
                                   round_id, balloon_index, created_at)
               VALUES (-5, 'p1', 'patch', -10, 890, 'round-1', 0, '${AT}')`),
    ).toThrow();
    expect(count(db, 'ledger')).toBe(2);
  });
});

describe('the balance cannot drift from the ledger', () => {
  it('moves the balance in the same statement as the ledger row', () => {
    placeBet();
    expect(balance()).toBe(900);
    expect(walletProblems(db)).toEqual([]);
  });

  it('refuses a balance change that has no ledger row behind it', () => {
    expect(() => db.exec("UPDATE players SET balance_cents = 999999 WHERE id = 'p1'")).toThrow(
      'must equal the last ledger row',
    );
  });

  it('refuses a ledger row that does not continue from the previous balance', () => {
    placeBet();
    expect(() => db.exec(row('patch', -10, 5000))).toThrow(
      'must continue from the previous balance',
    );
  });

  it('refuses a balance below zero', () => {
    placeBet();
    expect(() => db.exec(row('patch', -901, -1))).toThrow('CHECK constraint failed');
  });

  it('refuses a new player who starts with money, and a player written over an old one', () => {
    expect(() =>
      db.exec(
        `INSERT INTO players (id, token_hash, balance_cents, created_at)
         VALUES ('rich', 'h', 1000000, '${AT}')`,
      ),
    ).toThrow('starts at 0');
    expect(() =>
      db.exec("INSERT OR REPLACE INTO players (id, token_hash, created_at) VALUES ('p1', 'x', 'now')"),
    ).toThrow('never replaced');
    expect(balance()).toBe(1000);
  });
});

describe('ledger rows must make sense', () => {
  it('refuses a bet that adds money and a payout that takes it', () => {
    insertActiveRound(db, 'p1', 'round-1', [100]);
    // Two guards refuse each of these; either may speak first.
    const refusal = /CHECK constraint failed|must match a balloon/;
    expect(() => db.exec(row('bet', 100, 1100))).toThrow(refusal);
    expect(() => db.exec(row('payout', -100, 900))).toThrow(refusal);
  });

  it('refuses an unknown kind of row', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
         VALUES ('p1', 'bonus', 100, 1100, '${AT}')`,
      ),
    ).toThrow('CHECK constraint failed');
  });

  it('refuses a row for a round or a balloon that does not exist', () => {
    expect(() => db.exec(row('patch', -10, 990))).toThrow('must match a balloon');
    insertActiveRound(db, 'p1', 'round-1', [100]);
    expect(() => db.exec(row('patch', -10, 990).replace("'round-1', 0", "'round-1', 5"))).toThrow(
      'must match a balloon',
    );
  });

  it('refuses a bet row that is not the balloon’s bet', () => {
    insertActiveRound(db, 'p1', 'round-1', [100]);
    expect(() => db.exec(row('bet', -99, 901))).toThrow('must match a balloon');
  });

  it('refuses a row for another player’s balloon', () => {
    seedPlayer('p2');
    insertActiveRound(db, 'p2', 'round-1', [100]);
    expect(() => db.exec(row('bet', -100, 900))).toThrow('must match a balloon');
  });

  it('refuses a payout for a balloon that has not cashed out, or for a different amount', () => {
    placeBet();
    expect(() => db.exec(row('payout', 150, 1050))).toThrow('must match a balloon');
    cashOutByHand(db, 'round-1', 0, 101);
    expect(() => db.exec(row('payout', 150, 1050))).toThrow('must match a balloon');
    db.exec(row('payout', 101, 1001));
    expect(balance()).toBe(1001);
  });
});

describe('the same money is never handed out twice', () => {
  it('refuses a second opening grant', () => {
    expect(() =>
      db.exec(
        `INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
         VALUES ('p1', 'grant', 1000, 2000, '${AT}')`,
      ),
    ).toThrow('already moved');
  });

  it('refuses a second payout, a refund after a payout, and REPLACE as a way round both', () => {
    placeBet();
    cashOutByHand(db, 'round-1', 0, 101);
    db.exec(row('payout', 101, 1001));

    expect(() => db.exec(row('payout', 101, 1102))).toThrow('already moved');
    expect(() => db.exec(row('refund', 100, 1101))).toThrow(/already moved|must match a balloon/);
    expect(() => db.exec(row('payout', 101, 1102, 'OR REPLACE'))).toThrow('already moved');
    expect(balance()).toBe(1001);
    expect(walletProblems(db)).toEqual([]);
  });

  it('refuses a second bet on one balloon', () => {
    placeBet();
    expect(() => db.exec(row('bet', -100, 800))).toThrow('already moved');
  });
});

describe('rounds', () => {
  it('allows one active round per player, and refuses a second', () => {
    insertActiveRound(db, 'p1', 'round-1');
    expect(() => {
      insertActiveRound(db, 'p1', 'round-2');
    }).toThrow('one active round per player');
  });

  it('refuses a round on a nonce the seed did not just hand out', () => {
    const insert = (nonce: number): void => {
      db.exec(
        `INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder, max_payout_cents,
                             server_seed_id, client_seed, nonce, started_at, last_action_at)
         SELECT 'round-x', 'p1', 'active', 'easy', ${String(GAME_CONFIG.rtpBp)}, '[101]', ${CAP},
                id, 'seed', ${String(nonce)}, '${AT}', '${AT}'
         FROM server_seeds WHERE player_id = 'p1'`,
      );
    };
    // The seed's counter is at 0: no nonce has been handed out yet.
    expect(() => {
      insert(0);
    }).toThrow('the nonce that seed just gave');
    expect(() => {
      insert(7);
    }).toThrow('the nonce that seed just gave');
  });

  it('refuses a round on another player’s seed', () => {
    seedPlayer('p2');
    db.exec("UPDATE server_seeds SET next_nonce = 1 WHERE player_id = 'p2'");
    expect(() =>
      db.exec(
        `INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder, max_payout_cents,
                             server_seed_id, client_seed, nonce, started_at, last_action_at)
         SELECT 'round-x', 'p1', 'active', 'easy', ${String(GAME_CONFIG.rtpBp)}, '[101]', ${CAP},
                id, 'seed', 0, '${AT}', '${AT}'
         FROM server_seeds WHERE player_id = 'p2'`,
      ),
    ).toThrow('its own player');
  });

  it('cannot finish while a balloon is in play, and never changes once finished', () => {
    insertActiveRound(db, 'p1', 'round-1', [100]);
    const finish = "UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T00:01:00.000Z'";
    expect(() => db.exec(finish)).toThrow('while a balloon is still in play');
    db.exec("UPDATE balloons SET status = 'popped'");
    db.exec(finish);
    expect(() => db.exec("UPDATE rounds SET last_action_at = 'later'")).toThrow('never changes');
    expect(() => db.exec('DELETE FROM rounds')).toThrow('never deleted');
  });
});

describe('balloons', () => {
  beforeEach(() => {
    insertActiveRound(db, 'p1', 'round-1', [100]);
  });

  it('start unpumped: one cannot be written already cashed out', () => {
    expect(() =>
      db.exec(
        `INSERT INTO balloons (round_id, balloon_index, bet_cents, status, rung, draw_index,
                               top_rung, payout_cents)
         VALUES ('round-1', 1, 100, 'cashed', 1, 1, 2, 999999)`,
      ),
    ).toThrow('starts unpumped');
  });

  it('move one draw and one rung at a time, never back and never past the top', () => {
    expect(() => db.exec('UPDATE balloons SET rung = 2, draw_index = 1')).toThrow('one draw and one rung');
    expect(() => db.exec('UPDATE balloons SET rung = 1')).toThrow();
    db.exec('UPDATE balloons SET rung = 1, draw_index = 1');
    expect(() => db.exec('UPDATE balloons SET rung = 0')).toThrow('one draw and one rung');
    db.exec('UPDATE balloons SET rung = 2, draw_index = 2');
    expect(() => db.exec('UPDATE balloons SET rung = 3, draw_index = 3')).toThrow('CHECK constraint failed');
  });

  it('are over once popped, cashed or refunded', () => {
    db.exec("UPDATE balloons SET status = 'popped', draw_index = 1");
    expect(() => db.exec("UPDATE balloons SET status = 'active'")).toThrow('never changes');
    expect(() => db.exec("UPDATE balloons SET status = 'cashed', payout_cents = 500")).toThrow(
      'never changes',
    );
  });

  it('cannot be cashed with no payout, paid without cashing, or refunded after a draw', () => {
    expect(() => db.exec("UPDATE balloons SET status = 'cashed'")).toThrow('CHECK constraint failed');
    expect(() => db.exec('UPDATE balloons SET payout_cents = 500')).toThrow('CHECK constraint failed');
    db.exec('UPDATE balloons SET rung = 1, draw_index = 1');
    expect(() => db.exec("UPDATE balloons SET status = 'refunded'")).toThrow('CHECK constraint failed');
  });

  it('record their actions in order, with outcomes that match the roll', () => {
    const action = (seq: number, drawIndex: number, roll: number, outcome: string, patch = 0): string =>
      `INSERT INTO balloon_actions (round_id, balloon_index, seq, kind, patch, draw_index, den, num, roll, outcome, created_at)
       VALUES ('round-1', 0, ${String(seq)}, 'pump', ${String(patch)}, ${String(drawIndex)}, 101, 97, ${String(roll)}, '${outcome}', '${AT}')`;
    // A roll of 100 is not below 97: it cannot be recorded as survived.
    expect(() => db.exec(action(0, 0, 100, 'survived'))).toThrow('CHECK constraint failed');
    // Only a Patch can save a pump.
    expect(() => db.exec(action(0, 0, 100, 'saved', 0))).toThrow('CHECK constraint failed');
    // The first action is number 0, on draw 0.
    expect(() => db.exec(action(1, 0, 5, 'survived'))).toThrow('in order');
    expect(() => db.exec(action(0, 3, 5, 'survived'))).toThrow('in order');
    db.exec(action(0, 0, 5, 'survived'));
    expect(() => db.exec(action(1, 0, 5, 'survived'))).toThrow('in order');
    expect(() => db.exec('UPDATE balloon_actions SET roll = 1')).toThrow('append-only');
    expect(() => db.exec('DELETE FROM balloon_actions')).toThrow('append-only');
  });
});

describe('server seeds', () => {
  it('allows one active seed per player', () => {
    expect(() =>
      db.exec(
        `INSERT INTO server_seeds (player_id, seed, seed_hash, created_at)
         VALUES ('p1', 'another', 'another-hash', '${AT}')`,
      ),
    ).toThrow('one active seed');
  });

  it('never lets a nonce go back or jump', () => {
    db.exec('UPDATE server_seeds SET next_nonce = 1');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 0')).toThrow('one round at a time');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 6')).toThrow('one round at a time');
  });

  it('never lets a seed or its hash be swapped, by UPDATE or by REPLACE', () => {
    expect(() => db.exec("UPDATE server_seeds SET seed = 'other'")).toThrow('never changes');
    expect(() => db.exec("UPDATE server_seeds SET seed_hash = 'other'")).toThrow('never changes');
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO server_seeds (id, player_id, seed, seed_hash, created_at)
         SELECT id, player_id, 'attacker-chosen', 'h', created_at FROM server_seeds`,
      ),
    ).toThrow('never replaced');
  });

  it('cannot be revealed while a round is using it', () => {
    insertActiveRound(db, 'p1', 'round-1');
    expect(() => db.exec(`UPDATE server_seeds SET revealed_at = '${AT}'`)).toThrow(
      'while a round is using it',
    );
  });

  it('freezes a seed once it is revealed', () => {
    db.exec(`UPDATE server_seeds SET revealed_at = '${AT}'`);
    expect(() => db.exec('UPDATE server_seeds SET revealed_at = NULL')).toThrow('finished');
    expect(() => db.exec('UPDATE server_seeds SET next_nonce = 1')).toThrow('finished');
  });

  it('is never deleted', () => {
    expect(() => db.exec('DELETE FROM server_seeds')).toThrow('never deleted');
  });
});

describe('stored answers', () => {
  it('can never be replaced, changed or deleted', () => {
    const insert = (extra: string): void => {
      db.exec(
        `INSERT ${extra} INTO idempotency_keys (player_id, key, request_hash, status, body, created_at)
         VALUES ('p1', 'k', 'h', 200, '{}', '${AT}')`,
      );
    };
    insert('');
    expect(() => {
      insert('OR REPLACE');
    }).toThrow('never replaced');
    expect(() => db.exec("UPDATE idempotency_keys SET body = '[]'")).toThrow('never changes');
    expect(() => db.exec('DELETE FROM idempotency_keys')).toThrow('never deleted');
  });
});
