import type {
  Balloon,
  BalloonAction,
  BalloonStatus,
  DrawRecord,
  PumpOutcome,
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
  readonly round: Round;
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
    s.seed_hash, s.revealed_at
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
  const countActive = db.prepare(
    "SELECT COUNT(*) AS n FROM rounds WHERE player_id = :playerId AND status = 'active'",
  );
  const selectFinished = db.prepare(`
    SELECT r.id, r.difficulty_id, r.nonce, r.finished_at, s.seed_hash, s.revealed_at,
           COUNT(b.balloon_index)            AS balloon_count,
           -- A refunded bet is void: it was never played, so it is not a stake.
           COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN 0 ELSE b.bet_cents END), 0)
                                             AS bet_cents,
           COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN b.bet_cents ELSE 0 END), 0)
                                             AS refunded_cents,
           COALESCE(SUM(b.patches_cents), 0) AS patches_cents,
           COALESCE(SUM(b.payout_cents), 0)  AS payout_cents
    FROM rounds r
    JOIN server_seeds s ON s.id = r.server_seed_id
    LEFT JOIN balloons b ON b.round_id = r.id
    WHERE r.player_id = :playerId AND r.status = 'finished'
    GROUP BY r.id
    ORDER BY r.finished_at DESC, r.started_at DESC, r.id DESC
    LIMIT :limit
  `);
  const selectExpired = db.prepare(`
    SELECT id FROM rounds WHERE status = 'active' AND last_action_at <= :cutoff
    ORDER BY last_action_at
  `);
  const insertRound = db.prepare(`
    INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder, max_payout_cents,
                        server_seed_id, client_seed, nonce, started_at, last_action_at)
    VALUES (:id, :playerId, 'active', :difficultyId, :rtpBp, :ladder, :maxPayoutCents,
            :serverSeedId, :clientSeed, :nonce, :at, :at)
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
  const selectActions = db.prepare(`
    SELECT * FROM balloon_actions WHERE round_id = :roundId ORDER BY balloon_index, seq
  `);

  function toStoredRound(row: Row): StoredRound {
    const status = text(row, 'status');
    if (status !== 'active' && status !== 'finished') {
      throw new Error(`Unknown round status ${status}`);
    }
    const id = text(row, 'id');
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
      round: {
        difficultyId: text(row, 'difficulty_id'),
        rtpBp: int(row, 'rtp_bp'),
        ladder: parseLadder(text(row, 'ladder')),
        balloons: selectBalloons.all({ roundId: id }).map(toBalloon),
      },
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

    /** The player's latest finished rounds, newest first. */
    latestFinished(playerId: string, limit: number): FinishedRound[] {
      return selectFinished.all({ playerId, limit }).map(toFinishedRound);
    },

    /** Rounds still in progress that nobody has touched since `cutoff`. */
    idleSince(cutoff: string): string[] {
      return selectExpired.all({ cutoff }).map((row) => text(row, 'id'));
    },

    /** Stores a new round with its balloons, keeping its own copy of the RTP and ladder. */
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
