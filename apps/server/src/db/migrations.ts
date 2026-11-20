import type { Db } from './database';
import { int } from './rows';
import { immediate } from './transaction';

/**
 * The database schema, as a list of steps that only ever grows. Each step
 * runs once, in order, and is recorded in schema_migrations.
 *
 * The rules that keep money safe are written here as constraints and
 * triggers, so the database itself refuses a bad write even if the code
 * above it has a bug.
 */
interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'players, seeds, rounds, ledger, idempotency',
    sql: `
      -- One row per anonymous player. The cookie holds a random token; only
      -- its SHA-256 is stored, so a copy of the database cannot log in.
      CREATE TABLE players (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL UNIQUE,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        client_seed   TEXT,
        created_at    TEXT NOT NULL
      ) STRICT;

      -- A player starts with nothing. The opening grant arrives through the
      -- ledger like every other cent.
      CREATE TRIGGER players_start_at_zero BEFORE INSERT ON players
      WHEN NEW.balance_cents <> 0
      BEGIN SELECT RAISE(ABORT, 'a new player starts at 0; money arrives through the ledger'); END;

      CREATE TRIGGER players_no_delete BEFORE DELETE ON players
      BEGIN SELECT RAISE(ABORT, 'players are never deleted'); END;

      -- Server seeds. A player has exactly one active seed (revealed_at is
      -- null). The nonce belongs to the seed: it starts at 0 and only goes up.
      CREATE TABLE server_seeds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   TEXT NOT NULL REFERENCES players(id),
        seed        TEXT NOT NULL UNIQUE,
        seed_hash   TEXT NOT NULL,
        next_nonce  INTEGER NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
        created_at  TEXT NOT NULL,
        revealed_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX one_active_seed_per_player
        ON server_seeds(player_id) WHERE revealed_at IS NULL;

      CREATE TRIGGER server_seeds_fixed BEFORE UPDATE ON server_seeds
      WHEN NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
        OR NEW.seed <> OLD.seed OR NEW.seed_hash <> OLD.seed_hash
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a server seed never changes'); END;

      CREATE TRIGGER server_seeds_nonce_only_up BEFORE UPDATE OF next_nonce ON server_seeds
      WHEN NEW.next_nonce < OLD.next_nonce
      BEGIN SELECT RAISE(ABORT, 'a nonce only goes up'); END;

      CREATE TRIGGER server_seeds_revealed_is_final BEFORE UPDATE ON server_seeds
      WHEN OLD.revealed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a revealed seed is finished and cannot change'); END;

      CREATE TRIGGER server_seeds_no_delete BEFORE DELETE ON server_seeds
      BEGIN SELECT RAISE(ABORT, 'server seeds are never deleted'); END;

      -- Rounds. Each keeps its own copy of the RTP and ladder it was played
      -- with, so it still verifies after the configuration changes.
      CREATE TABLE rounds (
        id             TEXT PRIMARY KEY,
        player_id      TEXT NOT NULL REFERENCES players(id),
        status         TEXT NOT NULL CHECK (status IN ('active', 'finished')),
        difficulty_id  TEXT NOT NULL,
        rtp_bp         INTEGER NOT NULL,
        ladder         TEXT NOT NULL,
        server_seed_id INTEGER NOT NULL REFERENCES server_seeds(id),
        client_seed    TEXT NOT NULL,
        nonce          INTEGER NOT NULL CHECK (nonce >= 0),
        started_at     TEXT NOT NULL,
        last_action_at TEXT NOT NULL,
        finished_at    TEXT,
        CHECK ((status = 'finished') = (finished_at IS NOT NULL)),
        -- A (server seed, nonce) pair is used by at most one round, so no
        -- round can ever be replayed.
        UNIQUE (server_seed_id, nonce)
      ) STRICT;

      -- One active round per player.
      CREATE UNIQUE INDEX one_active_round_per_player
        ON rounds(player_id) WHERE status = 'active';

      CREATE INDEX rounds_history ON rounds(player_id, finished_at);

      CREATE TABLE balloons (
        round_id      TEXT NOT NULL REFERENCES rounds(id),
        balloon_index INTEGER NOT NULL CHECK (balloon_index BETWEEN 0 AND 2),
        bet_cents     INTEGER NOT NULL CHECK (bet_cents > 0),
        status        TEXT NOT NULL CHECK (status IN ('active', 'popped', 'cashed', 'refunded')),
        rung          INTEGER NOT NULL CHECK (rung >= 0),
        draw_index    INTEGER NOT NULL CHECK (draw_index >= 0),
        top_rung      INTEGER NOT NULL CHECK (top_rung >= 1),
        patches_cents INTEGER NOT NULL DEFAULT 0 CHECK (patches_cents >= 0),
        payout_cents  INTEGER NOT NULL DEFAULT 0 CHECK (payout_cents >= 0),
        PRIMARY KEY (round_id, balloon_index)
      ) STRICT, WITHOUT ROWID;

      -- The ledger: one row for every cent that moves. Amounts are signed:
      -- a bet or a Patch is negative, a grant, payout or refund is positive.
      -- balance_after_cents is the balance once this row has been applied,
      -- so the rows form a chain that can be checked from the first to the last.
      CREATE TABLE ledger (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id           TEXT NOT NULL REFERENCES players(id),
        kind                TEXT NOT NULL
                            CHECK (kind IN ('grant', 'bet', 'patch', 'payout', 'refund')),
        amount_cents        INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
        round_id            TEXT REFERENCES rounds(id),
        balloon_index       INTEGER,
        created_at          TEXT NOT NULL,
        CHECK (
          (kind IN ('bet', 'patch') AND amount_cents < 0)
          OR (kind IN ('grant', 'payout', 'refund') AND amount_cents > 0)
        ),
        -- Only the opening grant is not tied to a balloon.
        CHECK ((kind = 'grant') = (round_id IS NULL)),
        CHECK ((round_id IS NULL) = (balloon_index IS NULL))
      ) STRICT;

      CREATE INDEX ledger_by_player ON ledger(player_id, id);

      -- The same money can never be handed out twice: one grant per player,
      -- one bet per balloon, and at most one payout or refund per balloon.
      CREATE UNIQUE INDEX one_grant_per_player
        ON ledger(player_id) WHERE kind = 'grant';
      CREATE UNIQUE INDEX one_bet_per_balloon
        ON ledger(round_id, balloon_index) WHERE kind = 'bet';
      CREATE UNIQUE INDEX one_payout_or_refund_per_balloon
        ON ledger(round_id, balloon_index) WHERE kind IN ('payout', 'refund');

      -- Append-only: a ledger row is never changed and never removed.
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
      BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;

      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
      BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;

      -- Each new row must continue the chain: its balance is the previous
      -- row's balance plus its own amount.
      CREATE TRIGGER ledger_continues_chain BEFORE INSERT ON ledger
      BEGIN
        SELECT RAISE(ABORT, 'a ledger row must continue from the previous balance')
        WHERE NEW.balance_after_cents <> NEW.amount_cents + COALESCE(
          (SELECT balance_after_cents FROM ledger
           WHERE player_id = NEW.player_id ORDER BY id DESC LIMIT 1), 0);
      END;

      -- The stored balance may only be set to what the ledger says. A balance
      -- can therefore never change without a ledger row in the same
      -- transaction, and never drift from the ledger.
      CREATE TRIGGER players_balance_follows_ledger BEFORE UPDATE OF balance_cents ON players
      BEGIN
        SELECT RAISE(ABORT, 'a balance must equal the last ledger row')
        WHERE NEW.balance_cents <> COALESCE(
          (SELECT balance_after_cents FROM ledger
           WHERE player_id = NEW.id ORDER BY id DESC LIMIT 1), 0);
      END;

      -- Repeated requests. The first answer to (player, key) is stored here
      -- in the same transaction as the change it describes, and returned for
      -- every repeat.
      CREATE TABLE idempotency_keys (
        player_id    TEXT NOT NULL REFERENCES players(id),
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status       INTEGER NOT NULL,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (player_id, key)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER idempotency_keys_no_update BEFORE UPDATE ON idempotency_keys
      BEGIN SELECT RAISE(ABORT, 'a stored answer never changes'); END;
    `,
  },
  {
    id: 2,
    name: 'balloon actions, and guards on finished balloons and rounds',
    sql: `
      -- Everything that was done to a balloon, in order. With the seeds, this
      -- is enough to play a finished round again and check every cent.
      -- A pump stores the draw that decided it. A cash-out stores no draw.
      -- outcome: survived, saved, popped or top for a pump; cashed (the
      -- player pressed Cash Out) or abandoned (the 24-hour rule did).
      CREATE TABLE balloon_actions (
        round_id      TEXT NOT NULL,
        balloon_index INTEGER NOT NULL,
        seq           INTEGER NOT NULL CHECK (seq >= 0),
        kind          TEXT NOT NULL CHECK (kind IN ('pump', 'cashOut')),
        patch         INTEGER CHECK (patch IN (0, 1)),
        draw_index    INTEGER CHECK (draw_index >= 0),
        den           INTEGER CHECK (den >= 1),
        num           INTEGER CHECK (num >= 0),
        roll          INTEGER CHECK (roll >= 0),
        outcome       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (round_id, balloon_index, seq),
        FOREIGN KEY (round_id, balloon_index) REFERENCES balloons(round_id, balloon_index),
        CHECK (
          (kind = 'pump'
            AND patch IS NOT NULL AND draw_index IS NOT NULL
            AND den IS NOT NULL AND num IS NOT NULL AND roll IS NOT NULL
            AND roll < den AND num <= den
            AND outcome IN ('survived', 'saved', 'popped', 'top'))
          OR
          (kind = 'cashOut'
            AND patch IS NULL AND draw_index IS NULL
            AND den IS NULL AND num IS NULL AND roll IS NULL
            AND outcome IN ('cashed', 'abandoned'))
        )
      ) STRICT, WITHOUT ROWID;

      -- A draw index decides one pump, once. Two pumps sent with the same
      -- expected draw index can never both be recorded.
      CREATE UNIQUE INDEX one_pump_per_draw_index
        ON balloon_actions(round_id, balloon_index, draw_index) WHERE draw_index IS NOT NULL;

      CREATE TRIGGER balloon_actions_no_update BEFORE UPDATE ON balloon_actions
      BEGIN SELECT RAISE(ABORT, 'balloon actions are append-only'); END;

      CREATE TRIGGER balloon_actions_no_delete BEFORE DELETE ON balloon_actions
      BEGIN SELECT RAISE(ABORT, 'balloon actions are append-only'); END;

      -- Once a balloon has popped, cashed out or been refunded it is over.
      -- Nothing can pump it, pay it or change it again.
      CREATE TRIGGER balloons_finished_is_final BEFORE UPDATE ON balloons
      WHEN OLD.status <> 'active'
      BEGIN SELECT RAISE(ABORT, 'a finished balloon never changes'); END;

      CREATE TRIGGER balloons_fixed BEFORE UPDATE ON balloons
      WHEN NEW.round_id <> OLD.round_id OR NEW.balloon_index <> OLD.balloon_index
        OR NEW.bet_cents <> OLD.bet_cents OR NEW.top_rung <> OLD.top_rung
      BEGIN SELECT RAISE(ABORT, 'a balloon keeps its bet and its top rung'); END;

      -- A balloon only moves forward: it uses up draws, climbs, and is
      -- charged for Patches. None of those ever goes back down.
      CREATE TRIGGER balloons_only_forward BEFORE UPDATE ON balloons
      WHEN NEW.draw_index < OLD.draw_index OR NEW.rung < OLD.rung
        OR NEW.patches_cents < OLD.patches_cents OR NEW.rung > NEW.top_rung
      BEGIN SELECT RAISE(ABORT, 'a balloon only moves forward, and never past its top rung'); END;

      CREATE TRIGGER balloons_no_delete BEFORE DELETE ON balloons
      BEGIN SELECT RAISE(ABORT, 'balloons are never deleted'); END;

      -- A finished round is closed for good, and a round keeps the seeds,
      -- RTP and ladder it started with.
      CREATE TRIGGER rounds_finished_is_final BEFORE UPDATE ON rounds
      WHEN OLD.status = 'finished'
      BEGIN SELECT RAISE(ABORT, 'a finished round never changes'); END;

      CREATE TRIGGER rounds_fixed BEFORE UPDATE ON rounds
      WHEN NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
        OR NEW.difficulty_id <> OLD.difficulty_id OR NEW.rtp_bp <> OLD.rtp_bp
        OR NEW.ladder <> OLD.ladder OR NEW.server_seed_id <> OLD.server_seed_id
        OR NEW.client_seed <> OLD.client_seed OR NEW.nonce <> OLD.nonce
        OR NEW.started_at <> OLD.started_at
      BEGIN SELECT RAISE(ABORT, 'a round keeps the seeds, RTP and ladder it started with'); END;

      CREATE TRIGGER rounds_no_delete BEFORE DELETE ON rounds
      BEGIN SELECT RAISE(ABORT, 'rounds are never deleted'); END;
    `,
  },
];

/** Brings the database up to date. Safe to call on every start. */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => int(row, 'id')),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (:id, :name, :at)',
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    immediate(db, () => {
      db.exec(migration.sql);
      record.run({ id: migration.id, name: migration.name, at: new Date().toISOString() });
    });
  }
}
