import type {
  Balloon,
  BalloonAction,
  BalloonStatus,
  CashOutReveal,
  DrawRecord,
  PumpOutcome,
  RevealOutcome,
  Round,
} from '@pump/engine';
import type { Db } from '../db/database';
import { int, nullableInt, nullableText, text, type Row } from '../db/rows';

/** One finished round, summed up for the history list. */
export interface FinishedRound {
  readonly id: string;
  readonly difficultyId: string;
  readonly balloonCount: number;
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  /** Bets handed back unplayed by the 24-hour rule. Not part of betCents. */
  readonly refundedCents: number;
  readonly serverSeedHash: string;
  /** True once the round's server seed has been rotated out, so it can be checked. */
  readonly seedRevealed: boolean;
  readonly nonce: number;
  readonly finishedAt: string;
}

/**
 * Where a finished round sits in the history order: newest finish first,
 * then newest start, then the highest id. A page of older rounds starts
 * right after it.
 */
export interface HistoryPlace {
  readonly id: string;
  readonly finishedAt: string;
  readonly startedAt: string;
}

/** One finished round's money, for the stats page. Refunded (void) bets are left out. */
export interface PlayedRound {
  readonly id: string;
  readonly difficultyId: string;
  /** Balloons whose bets were played, not handed back. */
  readonly balloonsPlayed: number;
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  readonly seedRevealed: boolean;
  readonly finishedAt: string;
}

/**
 * One finished round that paid out more than went in, for the public lists.
 * It carries the player's id so the service can make a tag from it; the id
 * itself is never sent to anyone.
 */
export interface PublicWinRow {
  readonly playerId: string;
  readonly difficultyId: string;
  /** Bets that were played. Refunded (void) bets are left out. */
  readonly betCents: number;
  readonly patchesCents: number;
  readonly payoutCents: number;
  /** The highest multiplier a balloon in the round cashed out at, in hundredths. */
  readonly topMultiplierHundredths: number;
  readonly finishedAt: string;
}

/** Which public list: the latest wins, the largest gains, or the highest multipliers. */
export type PublicWinOrder = 'recent' | 'biggest' | 'luckiest';

/**
 * A round as stored: who owns it, which seeds it uses, and the round itself
 * in the engine's own shape (its RTP, its ladder and its balloons).
 */
export interface StoredRound {
  readonly id: string;
  readonly playerId: string;
  readonly status: 'active' | 'finished';
  readonly serverSeedId: number;
  readonly serverSeedHash: string;
  readonly seedRevealed: boolean;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly startedAt: string;
  readonly lastActionAt: string;
  readonly finishedAt: string | null;
  /** The payout cap per balloon when the round started. */
  readonly maxPayoutCents: number;
  /**
   * True for a round started once reveals were stored: as it ended, the
   * reveal of each balloon cashed out below its top rung was stored with it.
   * False only for a round started before that, which may have ended with
   * no reveal stored.
   */
  readonly revealsRecorded: boolean;
  readonly round: Round;
  /**
   * Each balloon's reveal, by balloon index: where it would have popped.
   * Written as the round ends, so null for every balloon while the round is
   * in progress, and null for a balloon that has none.
   */
  readonly reveals: readonly (CashOutReveal | null)[];
}

/** A round left idle, and whose it is. */
export interface IdleRound {
  readonly roundId: string;
  readonly playerId: string;
}

/** How a recorded action ended. The last two are cash-outs. */
export type ActionOutcome = PumpOutcome | 'cashed' | 'abandoned';

/** One thing done to a balloon, as stored. A pump carries the draw that decided it. */
export interface StoredAction {
  readonly balloonIndex: number;
  readonly action: BalloonAction;
  readonly outcome: ActionOutcome;
  readonly draw: DrawRecord | null;
}

export interface NewRound {
  readonly id: string;
  readonly playerId: string;
  readonly serverSeedId: number;
  readonly clientSeed: string;
  readonly nonce: number;
  /** The payout cap per balloon in force now, kept with the round. */
  readonly maxPayoutCents: number;
  readonly round: Round;
  readonly at: string;
}

const BALLOON_STATUSES: readonly string[] = ['active', 'popped', 'cashed', 'refunded'];
const ACTION_OUTCOMES: readonly string[] = [
  'survived',
  'saved',
  'popped',
  'top',
  'cashed',
  'abandoned',
];

function isBalloonStatus(value: string): value is BalloonStatus {
  return BALLOON_STATUSES.includes(value);
}

function isActionOutcome(value: string): value is ActionOutcome {
  return ACTION_OUTCOMES.includes(value);
}

function isRevealOutcome(value: string): value is RevealOutcome {
  return value === 'popped' || value === 'top';
}

/** The ladder is stored as JSON text: a list of whole numbers. */
function parseLadder(json: string): number[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('A stored ladder is not a list');
  return parsed.map((value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error('A stored ladder holds something that is not a whole number');
    }
    return value;
  });
}

/** A whole number read from parsed JSON, or a throw. */
function wholeIn(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`A stored reveal draw has a ${what} that is not a whole number`);
  }
  return value;
}

/** A reveal's draws are stored as JSON text: a list of { drawIndex, den, num, roll }. */
function parseDraws(json: string): DrawRecord[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('Stored reveal draws are not a list');
  return parsed.map((item: unknown): DrawRecord => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('A stored reveal draw is not an object');
    }
    const draw: Readonly<Record<string, unknown>> = { ...item };
    return {
      drawIndex: wholeIn(draw.drawIndex, 'drawIndex'),
      den: wholeIn(draw.den, 'den'),
      num: wholeIn(draw.num, 'num'),
      roll: wholeIn(draw.roll, 'roll'),
    };
  });
}

function toReveal(row: Row): CashOutReveal {
  const outcome = text(row, 'outcome');
  if (!isRevealOutcome(outcome)) throw new Error(`Unknown reveal outcome ${outcome}`);
  return {
    outcome,
    reachedRung: int(row, 'reached_rung'),
    draws: parseDraws(text(row, 'draws_json')),
  };
}

function toBalloon(row: Row): Balloon {
  const status = text(row, 'status');
  if (!isBalloonStatus(status)) throw new Error(`Unknown balloon status ${status}`);
  return {
    betCents: int(row, 'bet_cents'),
    status,
    rung: int(row, 'rung'),
    drawIndex: int(row, 'draw_index'),
    topRung: int(row, 'top_rung'),
    patchesCents: int(row, 'patches_cents'),
    payoutCents: int(row, 'payout_cents'),
  };
}

function toFinishedRound(row: Row): FinishedRound {
  return {
    id: text(row, 'id'),
    difficultyId: text(row, 'difficulty_id'),
    balloonCount: int(row, 'balloon_count'),
    betCents: int(row, 'bet_cents'),
    patchesCents: int(row, 'patches_cents'),
    payoutCents: int(row, 'payout_cents'),
    refundedCents: int(row, 'refunded_cents'),
    serverSeedHash: text(row, 'seed_hash'),
    seedRevealed: nullableText(row, 'revealed_at') !== null,
    nonce: int(row, 'nonce'),
    finishedAt: text(row, 'finished_at'),
  };
}

function toStoredAction(row: Row): StoredAction {
  const outcome = text(row, 'outcome');
  if (!isActionOutcome(outcome)) throw new Error(`Unknown action outcome ${outcome}`);
  const balloonIndex = int(row, 'balloon_index');
  if (text(row, 'kind') === 'cashOut') {
    return { balloonIndex, action: { kind: 'cashOut' }, outcome, draw: null };
  }
  return {
    balloonIndex,
    action: { kind: 'pump', patch: nullableInt(row, 'patch') === 1 },
    outcome,
    draw: {
      drawIndex: int(row, 'draw_index'),
      den: int(row, 'den'),
      num: int(row, 'num'),
      roll: int(row, 'roll'),
    },
  };
}

export type RoundsRepository = ReturnType<typeof roundsRepository>;

export function roundsRepository(db: Db) {
  const ROUND_COLUMNS = `
    r.id, r.player_id, r.status, r.difficulty_id, r.rtp_bp, r.ladder, r.max_payout_cents,
    r.server_seed_id,
    r.client_seed, r.nonce, r.started_at, r.last_action_at, r.finished_at,
    r.reveals_recorded, s.seed_hash, s.revealed_at
  `;
  const selectById = db.prepare(`
    SELECT ${ROUND_COLUMNS} FROM rounds r JOIN server_seeds s ON s.id = r.server_seed_id
    WHERE r.id = :id
  `);
  const selectActive = db.prepare(`
    SELECT ${ROUND_COLUMNS} FROM rounds r JOIN server_seeds s ON s.id = r.server_seed_id
    WHERE r.player_id = :playerId AND r.status = 'active'
  `);
  const selectBalloons = db.prepare(
    'SELECT * FROM balloons WHERE round_id = :roundId ORDER BY balloon_index',
  );
  const selectReveals = db.prepare(
    'SELECT * FROM balloon_reveals WHERE round_id = :roundId ORDER BY balloon_index',
  );
  const countActive = db.prepare(
    "SELECT COUNT(*) AS n FROM rounds WHERE player_id = :playerId AND status = 'active'",
  );
  // The history list: a player's finished rounds, newest first, one page at
  // a time. The order is finish time, then start time, then id, so it is
  // the same on every read, even for rounds that finished in the same
  // millisecond. The page's rounds are picked first, from the rounds table
  // alone (the rounds_history index on player and finish time finds them
  // without reading the rest), and only their balloons are then added up.
  const finishedPage = (olderThan: string) =>
    db.prepare(`
      WITH page AS (
        SELECT r.id, r.difficulty_id, r.nonce, r.started_at, r.finished_at, r.server_seed_id
        FROM rounds r
        WHERE r.player_id = :playerId AND r.status = 'finished' ${olderThan}
        ORDER BY r.finished_at DESC, r.started_at DESC, r.id DESC
        LIMIT :limit
      )
      SELECT p.id, p.difficulty_id, p.nonce, p.finished_at, s.seed_hash, s.revealed_at,
             COUNT(b.balloon_index)            AS balloon_count,
             -- A refunded bet is void: it was never played, so it is not a stake.
             COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN 0 ELSE b.bet_cents END), 0)
                                               AS bet_cents,
             COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN b.bet_cents ELSE 0 END), 0)
                                               AS refunded_cents,
             COALESCE(SUM(b.patches_cents), 0) AS patches_cents,
             COALESCE(SUM(b.payout_cents), 0)  AS payout_cents
      FROM page p
      JOIN server_seeds s ON s.id = p.server_seed_id
      LEFT JOIN balloons b ON b.round_id = p.id
      GROUP BY p.id
      ORDER BY p.finished_at DESC, p.started_at DESC, p.id DESC
    `);
  const selectFinished = finishedPage('');
  // A later page: only the rounds that come after one round in that order.
  // The three values are compared as one row, (a, b, c) < (x, y, z), which
  // is exactly the order's own rule. So a page starts right after that
  // round, and rounds tied on finish time are never skipped or listed twice.
  const selectFinishedAfter = finishedPage(
    'AND (r.finished_at, r.started_at, r.id) < (:finishedAt, :startedAt, :id)',
  );
  // Only a finished round of this same player can mark a place in their list.
  const selectPlace = db.prepare(`
    SELECT id, finished_at, started_at FROM rounds
    WHERE id = :id AND player_id = :playerId AND status = 'finished'
  `);
  // Every finished round of a player, oldest first, in the same order as the
  // history list read backwards. Refunded balloons are void, so they add
  // nothing; Patches and payouts on them are always 0 anyway.
  const selectPlayed = db.prepare(`
    SELECT r.id, r.difficulty_id, r.finished_at, s.revealed_at,
           COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN 0 ELSE 1 END), 0)
                                             AS balloons_played,
           COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN 0 ELSE b.bet_cents END), 0)
                                             AS bet_cents,
           COALESCE(SUM(b.patches_cents), 0) AS patches_cents,
           COALESCE(SUM(b.payout_cents), 0)  AS payout_cents
    FROM rounds r
    JOIN server_seeds s ON s.id = r.server_seed_id
    LEFT JOIN balloons b ON b.round_id = r.id
    WHERE r.player_id = :playerId AND r.status = 'finished'
    GROUP BY r.id
    ORDER BY r.finished_at ASC, r.started_at ASC, r.id ASC
  `);
  // Wins across all players, for the public lists. Only rounds that are
  // over; a round still in progress never shows. "More than went in" counts
  // bets played plus Patches, with refunded bets left out, exactly as the
  // stats page does. The top multiplier is read from the round's own stored
  // ladder (a JSON list): rung k is item k - 1. A round can only have paid
  // out through a cashed balloon, so a win always has one. A player who
  // keeps their wins private has none of them listed, past ones included.
  //
  // The wins are worked out once (the MATERIALIZED part) and the three lists
  // are cut from that one result, so the finished rounds are read once, not
  // three times. Each list is the first :limit rows in its own order.
  const publicWinsList = (list: PublicWinOrder, order: string): string => `
    SELECT * FROM (
      SELECT '${list}' AS list, wins.* FROM wins
      ORDER BY ${order}, finished_at DESC, round_id DESC
      LIMIT :limit
    )`;
  const selectPublicWins = db.prepare(`
    WITH wins AS MATERIALIZED (
      SELECT r.id AS round_id, r.player_id, r.difficulty_id, r.finished_at,
             SUM(CASE WHEN b.status = 'refunded' THEN 0 ELSE b.bet_cents END) AS staked_cents,
             SUM(b.patches_cents) AS patch_cents,
             SUM(b.payout_cents)  AS paid_cents,
             MAX(CASE WHEN b.status = 'cashed'
                      THEN json_extract(r.ladder, '$[' || (b.rung - 1) || ']') END)
                                  AS top_hundredths
      FROM rounds r
      JOIN players p ON p.id = r.player_id
      JOIN balloons b ON b.round_id = r.id
      WHERE r.status = 'finished' AND p.wins_private = 0
      GROUP BY r.id
      HAVING paid_cents > staked_cents + patch_cents
    )
    ${publicWinsList('recent', 'finished_at DESC')}
    UNION ALL
    ${publicWinsList('biggest', '(paid_cents - staked_cents - patch_cents) DESC')}
    UNION ALL
    ${publicWinsList('luckiest', 'top_hundredths DESC')}
  `);
  // Oldest first. The id breaks ties, so the order is the same every time.
  const selectExpired = db.prepare(`
    SELECT id, player_id FROM rounds WHERE status = 'active' AND last_action_at <= :cutoff
    ORDER BY last_action_at, id
  `);
  const insertRound = db.prepare(`
    INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder, max_payout_cents,
                        server_seed_id, client_seed, nonce, started_at, last_action_at,
                        reveals_recorded)
    VALUES (:id, :playerId, 'active', :difficultyId, :rtpBp, :ladder, :maxPayoutCents,
            :serverSeedId, :clientSeed, :nonce, :at, :at, 1)
  `);
  const insertBalloon = db.prepare(`
    INSERT INTO balloons (round_id, balloon_index, bet_cents, status, rung, draw_index,
                          top_rung, patches_cents, payout_cents)
    VALUES (:roundId, :balloonIndex, :betCents, :status, :rung, :drawIndex,
            :topRung, :patchesCents, :payoutCents)
  `);
  // Conditional on the state the caller read: still active, same draw index.
  // If anything moved in between, this changes no row and the caller stops.
  const updateBalloon = db.prepare(`
    UPDATE balloons
    SET status = :status, rung = :rung, draw_index = :drawIndex,
        patches_cents = :patchesCents, payout_cents = :payoutCents
    WHERE round_id = :roundId AND balloon_index = :balloonIndex
      AND status = 'active' AND draw_index = :previousDrawIndex
  `);
  const touchRound = db.prepare(
    "UPDATE rounds SET last_action_at = :at WHERE id = :id AND status = 'active'",
  );
  const finishRound = db.prepare(`
    UPDATE rounds SET status = 'finished', finished_at = :at, last_action_at = :at
    WHERE id = :id AND status = 'active'
  `);
  const insertAction = db.prepare(`
    INSERT INTO balloon_actions (round_id, balloon_index, seq, kind, patch,
                                 draw_index, den, num, roll, outcome, created_at)
    VALUES (:roundId, :balloonIndex,
            (SELECT COUNT(*) FROM balloon_actions
             WHERE round_id = :roundId AND balloon_index = :balloonIndex),
            :kind, :patch, :drawIndex, :den, :num, :roll, :outcome, :at)
  `);
  const insertReveal = db.prepare(`
    INSERT INTO balloon_reveals (round_id, balloon_index, outcome, reached_rung,
                                 draws_json, created_at)
    VALUES (:roundId, :balloonIndex, :outcome, :reachedRung, :drawsJson, :at)
  `);
  const selectActions = db.prepare(`
    SELECT * FROM balloon_actions WHERE round_id = :roundId ORDER BY balloon_index, seq
  `);

  function toStoredRound(row: Row): StoredRound {
    const status = text(row, 'status');
    if (status !== 'active' && status !== 'finished') {
      throw new Error(`Unknown round status ${status}`);
    }
    const id = text(row, 'id');
    const balloons = selectBalloons.all({ roundId: id }).map(toBalloon);
    const reveals: (CashOutReveal | null)[] = balloons.map(() => null);
    for (const revealRow of selectReveals.all({ roundId: id })) {
      reveals[int(revealRow, 'balloon_index')] = toReveal(revealRow);
    }
    return {
      id,
      playerId: text(row, 'player_id'),
      status,
      serverSeedId: int(row, 'server_seed_id'),
      serverSeedHash: text(row, 'seed_hash'),
      seedRevealed: nullableText(row, 'revealed_at') !== null,
      clientSeed: text(row, 'client_seed'),
      nonce: int(row, 'nonce'),
      startedAt: text(row, 'started_at'),
      lastActionAt: text(row, 'last_action_at'),
      finishedAt: nullableText(row, 'finished_at'),
      maxPayoutCents: int(row, 'max_payout_cents'),
      revealsRecorded: int(row, 'reveals_recorded') === 1,
      round: {
        difficultyId: text(row, 'difficulty_id'),
        rtpBp: int(row, 'rtp_bp'),
        ladder: parseLadder(text(row, 'ladder')),
        balloons,
      },
      reveals,
    };
  }

  return {
    hasActive(playerId: string): boolean {
      const row = countActive.get({ playerId });
      return row !== undefined && int(row, 'n') > 0;
    },

    find(id: string): StoredRound | null {
      const row = selectById.get({ id });
      return row ? toStoredRound(row) : null;
    },

    /** The player's round in progress, if there is one. There is never more than one. */
    activeOf(playerId: string): StoredRound | null {
      const row = selectActive.get({ playerId });
      return row ? toStoredRound(row) : null;
    },

    /**
     * The player's latest finished rounds, newest first, at most `limit`.
     * With `after`, only the rounds that come after that place in the order.
     */
    latestFinished(
      playerId: string,
      limit: number,
      after: HistoryPlace | null = null,
    ): FinishedRound[] {
      const rows =
        after === null
          ? selectFinished.all({ playerId, limit })
          : selectFinishedAfter.all({
              playerId,
              limit,
              id: after.id,
              finishedAt: after.finishedAt,
              startedAt: after.startedAt,
            });
      return rows.map(toFinishedRound);
    },

    /** Where one of the player's finished rounds sits in their history, or null if it is not one. */
    placeOfFinished(playerId: string, roundId: string): HistoryPlace | null {
      const row = selectPlace.get({ playerId, id: roundId });
      if (!row) return null;
      return {
        id: text(row, 'id'),
        finishedAt: text(row, 'finished_at'),
        startedAt: text(row, 'started_at'),
      };
    },

    /** Every finished round of the player with its money, oldest first. */
    playedRounds(playerId: string): PlayedRound[] {
      return selectPlayed.all({ playerId }).map((row) => ({
        id: text(row, 'id'),
        difficultyId: text(row, 'difficulty_id'),
        balloonsPlayed: int(row, 'balloons_played'),
        betCents: int(row, 'bet_cents'),
        patchesCents: int(row, 'patches_cents'),
        payoutCents: int(row, 'payout_cents'),
        seedRevealed: nullableText(row, 'revealed_at') !== null,
        finishedAt: text(row, 'finished_at'),
      }));
    },

    /** The three public lists, each with up to `limit` wins, read in one go. */
    publicWins(limit: number): Record<PublicWinOrder, PublicWinRow[]> {
      interface Listed extends PublicWinRow {
        readonly list: string;
        readonly roundId: string;
      }
      const rows: Listed[] = selectPublicWins.all({ limit }).map((row) => ({
        list: text(row, 'list'),
        roundId: text(row, 'round_id'),
        playerId: text(row, 'player_id'),
        difficultyId: text(row, 'difficulty_id'),
        betCents: int(row, 'staked_cents'),
        patchesCents: int(row, 'patch_cents'),
        payoutCents: int(row, 'paid_cents'),
        topMultiplierHundredths: int(row, 'top_hundredths'),
        finishedAt: text(row, 'finished_at'),
      }));
      // The database picked each list's rows in the right order; the order of
      // rows across a UNION is not promised, so each list is put in order
      // again here, by the same rule: its own measure, then newest first.
      // Plain character order, as the database's own ORDER BY uses.
      const later = (x: string, y: string): number => (x === y ? 0 : x > y ? -1 : 1);
      const newestFirst = (x: Listed, y: Listed): number =>
        later(x.finishedAt, y.finishedAt) || later(x.roundId, y.roundId);
      const gain = (row: Listed): number => row.payoutCents - row.betCents - row.patchesCents;
      const measure: Record<PublicWinOrder, (row: Listed) => number> = {
        recent: () => 0,
        biggest: gain,
        luckiest: (row) => row.topMultiplierHundredths,
      };
      const cut = (list: PublicWinOrder): PublicWinRow[] =>
        rows
          .filter((row) => row.list === list)
          .sort((x, y) => measure[list](y) - measure[list](x) || newestFirst(x, y))
          // Only the win itself leaves this file: not the round's id.
          .map((row) => ({
            playerId: row.playerId,
            difficultyId: row.difficultyId,
            betCents: row.betCents,
            patchesCents: row.patchesCents,
            payoutCents: row.payoutCents,
            topMultiplierHundredths: row.topMultiplierHundredths,
            finishedAt: row.finishedAt,
          }));
      return { recent: cut('recent'), biggest: cut('biggest'), luckiest: cut('luckiest') };
    },

    /** Rounds still in progress that nobody has touched since `cutoff`, oldest first. */
    idleSince(cutoff: string): IdleRound[] {
      return selectExpired
        .all({ cutoff })
        .map((row) => ({ roundId: text(row, 'id'), playerId: text(row, 'player_id') }));
    },

    /**
     * Stores a new round with its balloons, keeping its own copy of the RTP,
     * ladder and payout cap, and marked as storing its reveals as it ends.
     */
    insert(round: NewRound): void {
      insertRound.run({
        id: round.id,
        playerId: round.playerId,
        difficultyId: round.round.difficultyId,
        rtpBp: round.round.rtpBp,
        ladder: JSON.stringify(round.round.ladder),
        maxPayoutCents: round.maxPayoutCents,
        serverSeedId: round.serverSeedId,
        clientSeed: round.clientSeed,
        nonce: round.nonce,
        at: round.at,
      });
      round.round.balloons.forEach((balloon, balloonIndex) => {
        insertBalloon.run({
          roundId: round.id,
          balloonIndex,
          betCents: balloon.betCents,
          status: balloon.status,
          rung: balloon.rung,
          drawIndex: balloon.drawIndex,
          topRung: balloon.topRung,
          patchesCents: balloon.patchesCents,
          payoutCents: balloon.payoutCents,
        });
      });
    },

    /**
     * Saves a balloon's new state, but only if it is still active and still at
     * `previousDrawIndex`. Throws if it is not, which rolls the request back.
     */
    saveBalloon(
      roundId: string,
      balloonIndex: number,
      previousDrawIndex: number,
      balloon: Balloon,
    ): void {
      const changed = updateBalloon.run({
        roundId,
        balloonIndex,
        previousDrawIndex,
        status: balloon.status,
        rung: balloon.rung,
        drawIndex: balloon.drawIndex,
        patchesCents: balloon.patchesCents,
        payoutCents: balloon.payoutCents,
      });
      if (Number(changed.changes) !== 1) {
        throw new Error('The balloon changed while the request was being handled');
      }
    },

    /** Notes that the round was just played, which restarts its 24-hour clock. */
    touch(id: string, at: string): void {
      touchRound.run({ id, at });
    },

    finish(id: string, at: string): void {
      const changed = finishRound.run({ id, at });
      if (Number(changed.changes) !== 1) throw new Error('The round is not active');
    },

    /**
     * Stores one balloon's reveal. The database takes it only while the
     * round is ending: every balloon done, the round not yet closed.
     */
    saveReveal(roundId: string, balloonIndex: number, reveal: CashOutReveal, at: string): void {
      insertReveal.run({
        roundId,
        balloonIndex,
        outcome: reveal.outcome,
        reachedRung: reveal.reachedRung,
        // Field by field, so nothing but the draw itself is stored.
        drawsJson: JSON.stringify(
          reveal.draws.map(({ drawIndex, den, num, roll }) => ({ drawIndex, den, num, roll })),
        ),
        at,
      });
    },

    /** Appends one action to a balloon's list. */
    recordAction(roundId: string, action: StoredAction, at: string): void {
      insertAction.run({
        roundId,
        balloonIndex: action.balloonIndex,
        kind: action.action.kind,
        patch: action.action.kind === 'pump' ? (action.action.patch ? 1 : 0) : null,
        drawIndex: action.draw?.drawIndex ?? null,
        den: action.draw?.den ?? null,
        num: action.draw?.num ?? null,
        roll: action.draw?.roll ?? null,
        outcome: action.outcome,
        at,
      });
    },

    /** Every action of a round, grouped by balloon and in the order they happened. */
    actionsOf(roundId: string): StoredAction[] {
      return selectActions.all({ roundId }).map(toStoredAction);
    },
  };
}
