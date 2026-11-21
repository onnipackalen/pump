import type { Db } from './database';
import { text } from './rows';
import { immediate } from './transaction';

/**
 * The database schema, as a list of steps that only ever grows. Each step
 * runs once, in order, and is recorded in schema_migrations with its name.
 * A step's name is part of that record: never rename one that has shipped.
 * migrate() refuses a database whose recorded step has another name than
 * the code's, because unreleased code (an earlier version of a branch) made
 * that step differently, and skipping it by its number alone would leave
 * the tables in a shape this code does not expect.
 *
 * The rules that keep money safe are written here as constraints and
 * triggers, so the database itself refuses a bad write even if the code
 * above it has a bug. Four kinds of guard appear on every table that matters:
 *
 *   no update / no delete   history is never rewritten
 *   no replace              SQLite's INSERT OR REPLACE deletes the old row
 *                           first, quietly. A BEFORE INSERT trigger sees that
 *                           the row exists and refuses, on any connection.
 *   starts fresh            a new row begins in its first state, never
 *                           halfway through
 *   one step at a time      a row only moves forward, one step per change
 */
interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'players, seeds, rounds, balloons, actions, ledger, idempotency',
    sql: `
      ------------------------------------------------------------------
      -- Players. One row per anonymous player. The cookie holds a random
      -- token; only its SHA-256 is stored, so a copy of the database
      -- cannot log in.
      ------------------------------------------------------------------
      CREATE TABLE players (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL UNIQUE,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        client_seed   TEXT,
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER players_no_replace BEFORE INSERT ON players
      WHEN EXISTS (SELECT 1 FROM players WHERE id = NEW.id OR token_hash = NEW.token_hash)
      BEGIN SELECT RAISE(ABORT, 'a player is never replaced'); END;

      -- A player starts with nothing. The opening grant arrives through the
      -- ledger like every other cent.
      CREATE TRIGGER players_start_at_zero BEFORE INSERT ON players
      WHEN NEW.balance_cents <> 0
      BEGIN SELECT RAISE(ABORT, 'a new player starts at 0; money arrives through the ledger'); END;

      CREATE TRIGGER players_fixed BEFORE UPDATE ON players
      WHEN NEW.id <> OLD.id OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a player keeps their id and token'); END;

      CREATE TRIGGER players_no_delete BEFORE DELETE ON players
      BEGIN SELECT RAISE(ABORT, 'players are never deleted'); END;

      ------------------------------------------------------------------
      -- Server seeds. A player has exactly one active seed (revealed_at is
      -- null). The nonce belongs to the seed: it starts at 0 and goes up by
      -- one for each round, never back.
      ------------------------------------------------------------------
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

      CREATE TRIGGER server_seeds_no_replace BEFORE INSERT ON server_seeds
      WHEN EXISTS (
        SELECT 1 FROM server_seeds
        WHERE id = NEW.id OR seed = NEW.seed
           OR (player_id = NEW.player_id AND revealed_at IS NULL)
      )
      BEGIN SELECT RAISE(ABORT, 'a player has one active seed, and a seed is never replaced'); END;

      CREATE TRIGGER server_seeds_start_fresh BEFORE INSERT ON server_seeds
      WHEN NEW.next_nonce <> 0 OR NEW.revealed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a new seed starts secret, with its nonce at 0'); END;

      CREATE TRIGGER server_seeds_fixed BEFORE UPDATE ON server_seeds
      WHEN NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
        OR NEW.seed <> OLD.seed OR NEW.seed_hash <> OLD.seed_hash
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a server seed never changes'); END;

      CREATE TRIGGER server_seeds_nonce_one_step BEFORE UPDATE OF next_nonce ON server_seeds
      WHEN NEW.next_nonce <> OLD.next_nonce AND NEW.next_nonce <> OLD.next_nonce + 1
      BEGIN SELECT RAISE(ABORT, 'a nonce only goes up, one round at a time'); END;

      CREATE TRIGGER server_seeds_revealed_is_final BEFORE UPDATE ON server_seeds
      WHEN OLD.revealed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a revealed seed is finished and cannot change'); END;

      CREATE TRIGGER server_seeds_no_delete BEFORE DELETE ON server_seeds
      BEGIN SELECT RAISE(ABORT, 'server seeds are never deleted'); END;

      ------------------------------------------------------------------
      -- Rounds. Each keeps its own copy of the RTP, ladder and payout cap
      -- it was played with, so it still verifies after the configuration
      -- changes.
      ------------------------------------------------------------------
      CREATE TABLE rounds (
        id             TEXT PRIMARY KEY,
        player_id      TEXT NOT NULL REFERENCES players(id),
        status         TEXT NOT NULL CHECK (status IN ('active', 'finished')),
        difficulty_id  TEXT NOT NULL,
        rtp_bp         INTEGER NOT NULL,
        ladder         TEXT NOT NULL,
        -- The payout cap per balloon when the round started. Each balloon's
        -- top rung was worked out from it, so checking a round needs it.
        max_payout_cents INTEGER NOT NULL CHECK (max_payout_cents > 0),
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

      CREATE TRIGGER rounds_no_replace BEFORE INSERT ON rounds
      WHEN EXISTS (
        SELECT 1 FROM rounds
        WHERE id = NEW.id
           OR (server_seed_id = NEW.server_seed_id AND nonce = NEW.nonce)
           OR (player_id = NEW.player_id AND status = 'active')
      )
      BEGIN SELECT RAISE(ABORT, 'one active round per player, and a round is never replaced'); END;

      CREATE TRIGGER rounds_start_active BEFORE INSERT ON rounds
      WHEN NEW.status <> 'active'
      BEGIN SELECT RAISE(ABORT, 'a new round starts active'); END;

      -- The nonce is not chosen: it is the one the player's own active seed
      -- has just handed out.
      CREATE TRIGGER rounds_on_own_active_seed BEFORE INSERT ON rounds
      WHEN NOT EXISTS (
        SELECT 1 FROM server_seeds
        WHERE id = NEW.server_seed_id AND player_id = NEW.player_id
          AND revealed_at IS NULL AND next_nonce = NEW.nonce + 1
      )
      BEGIN SELECT RAISE(ABORT, 'a round uses its own player''s active seed and the nonce that seed just gave'); END;

      -- A finished round is closed for good, and a round keeps the seeds,
      -- RTP and ladder it started with.
      CREATE TRIGGER rounds_finished_is_final BEFORE UPDATE ON rounds
      WHEN OLD.status = 'finished'
      BEGIN SELECT RAISE(ABORT, 'a finished round never changes'); END;

      CREATE TRIGGER rounds_fixed BEFORE UPDATE ON rounds
      WHEN NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
        OR NEW.difficulty_id <> OLD.difficulty_id OR NEW.rtp_bp <> OLD.rtp_bp
        OR NEW.ladder <> OLD.ladder OR NEW.max_payout_cents <> OLD.max_payout_cents
        OR NEW.server_seed_id <> OLD.server_seed_id
        OR NEW.client_seed <> OLD.client_seed OR NEW.nonce <> OLD.nonce
        OR NEW.started_at <> OLD.started_at
      BEGIN SELECT RAISE(ABORT, 'a round keeps the seeds, RTP, ladder and cap it started with'); END;

      CREATE TRIGGER rounds_no_delete BEFORE DELETE ON rounds
      BEGIN SELECT RAISE(ABORT, 'rounds are never deleted'); END;

      -- Seeds cannot change mid-round: a seed cannot be revealed while a
      -- round is still being played on it.
      CREATE TRIGGER server_seeds_not_revealed_mid_round BEFORE UPDATE OF revealed_at ON server_seeds
      WHEN NEW.revealed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM rounds WHERE server_seed_id = OLD.id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'a seed cannot be revealed while a round is using it'); END;

      ------------------------------------------------------------------
      -- Balloons. How many a round may have is the engine's rule, not the
      -- database's.
      ------------------------------------------------------------------
      CREATE TABLE balloons (
        round_id      TEXT NOT NULL REFERENCES rounds(id),
        balloon_index INTEGER NOT NULL CHECK (balloon_index >= 0),
        bet_cents     INTEGER NOT NULL CHECK (bet_cents > 0),
        status        TEXT NOT NULL CHECK (status IN ('active', 'popped', 'cashed', 'refunded')),
        rung          INTEGER NOT NULL CHECK (rung >= 0),
        draw_index    INTEGER NOT NULL CHECK (draw_index >= 0),
        top_rung      INTEGER NOT NULL CHECK (top_rung >= 1),
        patches_cents INTEGER NOT NULL DEFAULT 0 CHECK (patches_cents >= 0),
        payout_cents  INTEGER NOT NULL DEFAULT 0 CHECK (payout_cents >= 0),
        PRIMARY KEY (round_id, balloon_index),
        -- A balloon cannot climb without a draw, or past its top rung.
        CHECK (rung <= draw_index AND rung <= top_rung),
        -- Only a cashed balloon has a payout, and it was pumped at least once.
        CHECK ((status = 'cashed') = (payout_cents > 0)),
        CHECK (status <> 'cashed' OR rung >= 1),
        -- A refunded balloon was never played.
        CHECK (status <> 'refunded' OR (draw_index = 0 AND patches_cents = 0))
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER balloons_no_replace BEFORE INSERT ON balloons
      WHEN EXISTS (
        SELECT 1 FROM balloons WHERE round_id = NEW.round_id AND balloon_index = NEW.balloon_index
      )
      BEGIN SELECT RAISE(ABORT, 'a balloon is never replaced'); END;

      CREATE TRIGGER balloons_start_fresh BEFORE INSERT ON balloons
      WHEN NEW.status <> 'active' OR NEW.rung <> 0 OR NEW.draw_index <> 0
        OR NEW.patches_cents <> 0 OR NEW.payout_cents <> 0
      BEGIN SELECT RAISE(ABORT, 'a new balloon starts unpumped'); END;

      CREATE TRIGGER balloons_only_in_an_active_round BEFORE INSERT ON balloons
      WHEN NOT EXISTS (SELECT 1 FROM rounds WHERE id = NEW.round_id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'a balloon belongs to a round in progress'); END;

      -- Once a balloon has popped, cashed out or been refunded it is over.
      -- Nothing can pump it, pay it or change it again.
      CREATE TRIGGER balloons_finished_is_final BEFORE UPDATE ON balloons
      WHEN OLD.status <> 'active'
      BEGIN SELECT RAISE(ABORT, 'a finished balloon never changes'); END;

      CREATE TRIGGER balloons_fixed BEFORE UPDATE ON balloons
      WHEN NEW.round_id <> OLD.round_id OR NEW.balloon_index <> OLD.balloon_index
        OR NEW.bet_cents <> OLD.bet_cents OR NEW.top_rung <> OLD.top_rung
      BEGIN SELECT RAISE(ABORT, 'a balloon keeps its bet and its top rung'); END;

      -- One change is at most one draw and at most one rung, and a Patch
      -- charge is never taken back.
      CREATE TRIGGER balloons_one_step BEFORE UPDATE ON balloons
      WHEN NEW.draw_index NOT IN (OLD.draw_index, OLD.draw_index + 1)
        OR NEW.rung NOT IN (OLD.rung, OLD.rung + 1)
        OR (NEW.rung = OLD.rung + 1 AND NEW.draw_index <> OLD.draw_index + 1)
        OR NEW.patches_cents < OLD.patches_cents
      BEGIN SELECT RAISE(ABORT, 'a balloon moves one draw and one rung at a time, never back'); END;

      CREATE TRIGGER balloons_move_only_in_an_active_round BEFORE UPDATE ON balloons
      WHEN NOT EXISTS (SELECT 1 FROM rounds WHERE id = OLD.round_id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'a balloon belongs to a round in progress'); END;

      CREATE TRIGGER balloons_no_delete BEFORE DELETE ON balloons
      BEGIN SELECT RAISE(ABORT, 'balloons are never deleted'); END;

      -- A round ends when its last balloon is done, not before.
      CREATE TRIGGER rounds_finish_when_no_balloon_in_play BEFORE UPDATE OF status ON rounds
      WHEN NEW.status = 'finished'
        AND EXISTS (SELECT 1 FROM balloons WHERE round_id = OLD.id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'a round cannot finish while a balloon is still in play'); END;

      ------------------------------------------------------------------
      -- Balloon actions. Everything that was done to a balloon, in order.
      -- With the seeds, this is enough to play a finished round again and
      -- check every cent. A pump stores the draw that decided it; a
      -- cash-out stores no draw.
      -- outcome: survived, saved, popped or top for a pump; cashed (the
      -- player pressed Cash Out) or abandoned (the 24-hour rule did).
      ------------------------------------------------------------------
      CREATE TABLE balloon_actions (
        round_id      TEXT NOT NULL,
        balloon_index INTEGER NOT NULL,
        seq           INTEGER NOT NULL CHECK (seq >= 0),
        kind          TEXT NOT NULL CHECK (kind IN ('pump', 'cashOut')),
        patch         INTEGER CHECK (patch IN (0, 1)),
        draw_index    INTEGER CHECK (draw_index >= 0),
        den           INTEGER CHECK (den >= 2),
        num           INTEGER CHECK (num >= 1),
        roll          INTEGER CHECK (roll >= 0),
        outcome       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (round_id, balloon_index, seq),
        FOREIGN KEY (round_id, balloon_index) REFERENCES balloons(round_id, balloon_index),
        CHECK (
          (kind = 'pump'
            AND patch IS NOT NULL AND draw_index IS NOT NULL
            AND den IS NOT NULL AND num IS NOT NULL AND roll IS NOT NULL
            AND roll < den AND num < den
            AND outcome IN ('survived', 'saved', 'popped', 'top')
            -- The outcome must be what the roll says: below num survives.
            AND (roll < num) = (outcome IN ('survived', 'top'))
            -- Only a Patch can save a pump that would have popped.
            AND (outcome = 'saved') = (roll >= num AND patch = 1))
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

      -- Actions are numbered 0, 1, 2, ... and a pump's draw index is the
      -- number of pumps before it. Nothing can be slipped in or skipped.
      CREATE TRIGGER balloon_actions_in_order BEFORE INSERT ON balloon_actions
      WHEN NEW.seq <> (SELECT COUNT(*) FROM balloon_actions
                       WHERE round_id = NEW.round_id AND balloon_index = NEW.balloon_index)
        OR (NEW.kind = 'pump' AND NEW.draw_index <> (
              SELECT COUNT(*) FROM balloon_actions
              WHERE round_id = NEW.round_id AND balloon_index = NEW.balloon_index
                AND kind = 'pump'))
      BEGIN SELECT RAISE(ABORT, 'balloon actions are recorded in order, with no gaps'); END;

      CREATE TRIGGER balloon_actions_no_update BEFORE UPDATE ON balloon_actions
      BEGIN SELECT RAISE(ABORT, 'balloon actions are append-only'); END;

      CREATE TRIGGER balloon_actions_no_delete BEFORE DELETE ON balloon_actions
      BEGIN SELECT RAISE(ABORT, 'balloon actions are append-only'); END;

      ------------------------------------------------------------------
      -- The ledger: one row for every cent that moves. Amounts are signed:
      -- a bet or a Patch is negative, a grant, payout or refund is positive.
      -- balance_after_cents is the balance once this row has been applied,
      -- so the rows form a chain that can be checked from first to last.
      ------------------------------------------------------------------
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
        -- Ids stay in the range every tool can read exactly.
        CHECK (id > 0 AND id < 9007199254740992),
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

      -- The same three rules as triggers. A unique index alone can be got
      -- round with INSERT OR REPLACE, which would delete the first payment
      -- to make room for the second.
      CREATE TRIGGER ledger_paid_once BEFORE INSERT ON ledger
      WHEN EXISTS (
        SELECT 1 FROM ledger
        WHERE id = NEW.id
           OR (NEW.kind = 'grant' AND kind = 'grant' AND player_id = NEW.player_id)
           OR (NEW.kind = 'bet' AND kind = 'bet'
               AND round_id = NEW.round_id AND balloon_index = NEW.balloon_index)
           OR (NEW.kind IN ('payout', 'refund') AND kind IN ('payout', 'refund')
               AND round_id = NEW.round_id AND balloon_index = NEW.balloon_index)
      )
      BEGIN SELECT RAISE(ABORT, 'this money was already moved: one grant per player, one bet and one payout or refund per balloon'); END;

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

      -- A row for a round must be for a real balloon of that player, and say
      -- what the balloon says: a bet row is the balloon's bet, a payout is
      -- what a cashed balloon recorded, a refund is the bet of a refunded one.
      CREATE TRIGGER ledger_matches_its_balloon BEFORE INSERT ON ledger
      WHEN NEW.round_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM balloons b JOIN rounds r ON r.id = b.round_id
        WHERE b.round_id = NEW.round_id AND b.balloon_index = NEW.balloon_index
          AND r.player_id = NEW.player_id
          AND (NEW.kind <> 'bet' OR b.bet_cents = -NEW.amount_cents)
          AND (NEW.kind <> 'payout' OR (b.status = 'cashed' AND b.payout_cents = NEW.amount_cents))
          AND (NEW.kind <> 'refund' OR (b.status = 'refunded' AND b.bet_cents = NEW.amount_cents))
      )
      BEGIN SELECT RAISE(ABORT, 'a ledger row must match a balloon of its own player'); END;

      -- New rows go on the end. A row cannot be slipped into the past.
      CREATE TRIGGER ledger_newest_last AFTER INSERT ON ledger
      WHEN NEW.id <> (SELECT MAX(id) FROM ledger)
      BEGIN SELECT RAISE(ABORT, 'a ledger row is always added at the end'); END;

      -- The stored balance may only be set to what the ledger says ...
      CREATE TRIGGER players_balance_follows_ledger BEFORE UPDATE OF balance_cents ON players
      BEGIN
        SELECT RAISE(ABORT, 'a balance must equal the last ledger row')
        WHERE NEW.balance_cents <> COALESCE(
          (SELECT balance_after_cents FROM ledger
           WHERE player_id = NEW.id ORDER BY id DESC LIMIT 1), 0);
      END;

      -- ... and writing a ledger row moves it there, in the same statement.
      -- So a row and its balance change are one step that cannot be split:
      -- the balance equals the sum of the ledger at all times.
      CREATE TRIGGER ledger_moves_the_balance AFTER INSERT ON ledger
      BEGIN
        UPDATE players SET balance_cents = NEW.balance_after_cents WHERE id = NEW.player_id;
      END;

      ------------------------------------------------------------------
      -- Repeated requests. The first answer to (player, key) is stored here
      -- in the same transaction as the change it describes, and returned
      -- for every repeat.
      ------------------------------------------------------------------
      CREATE TABLE idempotency_keys (
        player_id    TEXT NOT NULL REFERENCES players(id),
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status       INTEGER NOT NULL,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (player_id, key)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER idempotency_keys_no_replace BEFORE INSERT ON idempotency_keys
      WHEN EXISTS (
        SELECT 1 FROM idempotency_keys WHERE player_id = NEW.player_id AND key = NEW.key
      )
      BEGIN SELECT RAISE(ABORT, 'a stored answer is never replaced'); END;

      CREATE TRIGGER idempotency_keys_no_update BEFORE UPDATE ON idempotency_keys
      BEGIN SELECT RAISE(ABORT, 'a stored answer never changes'); END;

      -- Deleting a stored answer would let its request run a second time.
      CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON idempotency_keys
      BEGIN SELECT RAISE(ABORT, 'a stored answer is never deleted'); END;
    `,
  },
  {
    id: 2,
    name: 'reveals at round end',
    sql: `
      ------------------------------------------------------------------
      -- Which rounds are sure to have their reveals stored. From this step
      -- on, the database closes no round without the reveal of each
      -- balloon cashed out below its top rung (rounds_finish_with_their_
      -- reveals, below), and every round started from now on is marked 1.
      -- A round already here is marked 0: it may have ended before this
      -- step, with no reveal stored. Those rows take the default 0 as the
      -- column is added, with no UPDATE, so no finished round is changed.
      -- The mark is about reveals alone; the payout cap is kept with each
      -- round since the first step.
      ------------------------------------------------------------------
      ALTER TABLE rounds ADD COLUMN reveals_recorded INTEGER NOT NULL DEFAULT 0
        CHECK (reveals_recorded IN (0, 1));

      -- AFTER, not BEFORE, so the older guards on a new round speak first.
      CREATE TRIGGER rounds_start_recording_reveals AFTER INSERT ON rounds
      WHEN NEW.reveals_recorded <> 1
      BEGIN SELECT RAISE(ABORT, 'a new round is marked as storing its reveals'); END;

      CREATE TRIGGER rounds_keep_reveals_recorded BEFORE UPDATE OF reveals_recorded ON rounds
      WHEN NEW.reveals_recorded IS NOT OLD.reveals_recorded
      BEGIN SELECT RAISE(ABORT, 'a round keeps its mark of whether it stores its reveals'); END;

      ------------------------------------------------------------------
      -- Reveals: where a balloon cashed out below its top rung would have
      -- popped. One row per such balloon, worked out and written in the
      -- transaction that ends its round, just before the round is closed.
      -- A reveal decides nothing and moves no money.
      --
      -- Its draws are kept here and never in balloon_actions: those are
      -- the draws that decided real pumps, and a balloon's draw_index
      -- counts only them. draws_json lists the reveal's draws in order,
      -- each {"drawIndex", "den", "num", "roll"}.
      -- outcome: popped (a later pump would have popped it, on
      -- reached_rung) or top (it would have reached its top rung).
      ------------------------------------------------------------------
      CREATE TABLE balloon_reveals (
        round_id      TEXT NOT NULL,
        balloon_index INTEGER NOT NULL,
        outcome       TEXT NOT NULL CHECK (outcome IN ('popped', 'top')),
        reached_rung  INTEGER NOT NULL CHECK (reached_rung >= 1),
        draws_json    TEXT NOT NULL
                      CHECK (json_valid(draws_json) AND json_type(draws_json) = 'array'),
        created_at    TEXT NOT NULL,
        PRIMARY KEY (round_id, balloon_index),
        FOREIGN KEY (round_id, balloon_index) REFERENCES balloons(round_id, balloon_index)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER balloon_reveals_no_replace BEFORE INSERT ON balloon_reveals
      WHEN EXISTS (
        SELECT 1 FROM balloon_reveals
        WHERE round_id = NEW.round_id AND balloon_index = NEW.balloon_index
      )
      BEGIN SELECT RAISE(ABORT, 'a reveal is never replaced'); END;

      -- Only as the round ends: every balloon is done, and the round is not
      -- closed yet. So no reveal exists while a pump can still be made.
      CREATE TRIGGER balloon_reveals_at_round_end BEFORE INSERT ON balloon_reveals
      WHEN NOT EXISTS (SELECT 1 FROM rounds WHERE id = NEW.round_id AND status = 'active')
        OR EXISTS (SELECT 1 FROM balloons WHERE round_id = NEW.round_id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'a reveal is written as its round ends: after its last balloon, before the round closes'); END;

      -- Only for a balloon cashed out below its top rung T, starting at its
      -- draw count (not its rung, which a Patch save leaves behind). From
      -- its rung r it either pops on a rung from r to T - 1, after
      -- (that rung - r + 1) draws, or reaches T after T - r draws.
      CREATE TRIGGER balloon_reveals_fit_their_balloon BEFORE INSERT ON balloon_reveals
      WHEN NOT EXISTS (
        SELECT 1 FROM balloons b
        WHERE b.round_id = NEW.round_id AND b.balloon_index = NEW.balloon_index
          AND b.status = 'cashed' AND b.rung < b.top_rung
          AND json_extract(NEW.draws_json, '$[0].drawIndex') = b.draw_index
          AND ((NEW.outcome = 'popped'
                AND NEW.reached_rung >= b.rung AND NEW.reached_rung < b.top_rung
                AND json_array_length(NEW.draws_json) = NEW.reached_rung - b.rung + 1)
            OR (NEW.outcome = 'top'
                AND NEW.reached_rung = b.top_rung
                AND json_array_length(NEW.draws_json) = b.top_rung - b.rung))
      )
      BEGIN SELECT RAISE(ABORT, 'a reveal is for a balloon cashed out below its top rung: it starts at its draw count and stops between its rung and its top'); END;

      CREATE TRIGGER balloon_reveals_no_update BEFORE UPDATE ON balloon_reveals
      BEGIN SELECT RAISE(ABORT, 'reveals are append-only'); END;

      CREATE TRIGGER balloon_reveals_no_delete BEFORE DELETE ON balloon_reveals
      BEGIN SELECT RAISE(ABORT, 'reveals are append-only'); END;

      -- A round closes with the reveal of every balloon cashed out below
      -- its top rung, written just before. AFTER, so the older guards on
      -- closing a round speak first.
      CREATE TRIGGER rounds_finish_with_their_reveals AFTER UPDATE OF status ON rounds
      WHEN NEW.status = 'finished' AND OLD.status = 'active'
        AND EXISTS (
          SELECT 1 FROM balloons b
          WHERE b.round_id = NEW.id AND b.status = 'cashed' AND b.rung < b.top_rung
            AND NOT EXISTS (
              SELECT 1 FROM balloon_reveals v
              WHERE v.round_id = b.round_id AND v.balloon_index = b.balloon_index
            )
        )
      BEGIN SELECT RAISE(ABORT, 'a round closes with the reveal of each balloon cashed out below its top rung'); END;
    `,
  },
];

/**
 * Brings the database up to date. Safe to call on every start, and safe if
 * two processes start on a fresh file at once: each step is checked and
 * applied inside one write transaction, so the second process finds the work
 * already done.
 *
 * `upTo` stops after that step. Only tests pass it, to build a database as
 * an older server left it and then bring it up to date.
 */
export function migrate(db: Db, upTo = Number.POSITIVE_INFINITY): void {
  immediate(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
  });
  const recordedName = db.prepare('SELECT name FROM schema_migrations WHERE id = :id');
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (:id, :name, :at)',
  );
  // Every step already recorded is checked first, so a database made by
  // other code is refused before anything in it is changed.
  for (const migration of MIGRATIONS) {
    const row = recordedName.get({ id: migration.id });
    if (row === undefined) continue;
    const name = text(row, 'name');
    if (name !== migration.name) {
      throw new Error(
        `This database's step ${String(migration.id)} is "${name}", but this server's step ` +
          `${String(migration.id)} is "${migration.name}". The database was made by other, ` +
          'unreleased code, so its tables are not the ones this server expects. Nothing was ' +
          'changed. Delete the database file (and its -wal and -shm files) to start afresh.',
      );
    }
  }
  for (const migration of MIGRATIONS) {
    if (migration.id > upTo) break;
    immediate(db, () => {
      if (recordedName.get({ id: migration.id }) !== undefined) return;
      db.exec(migration.sql);
      record.run({ id: migration.id, name: migration.name, at: new Date().toISOString() });
    });
  }
}
