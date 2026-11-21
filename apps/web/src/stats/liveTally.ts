/**
 * Live stats: what the rounds of this visit did, for the small panel the
 * player can keep open beside the game (Profit, Wagered, Wins, Losses and
 * the profit line).
 *
 * Everything here is pure, and every money figure is integer cents.
 *
 * What counts is the same as on the stats page (GET /api/stats):
 * - wagered: the bets that were played plus every Patch bought;
 * - net: payouts minus wagered;
 * - a bet the 24-hour rule handed back unplayed is void: it is left out of
 *   every figure, and a round whose bets were all handed back is not a round.
 *
 * A win is a round that paid back more than it cost (net above 0), the
 * game's own meaning of "won" everywhere. A loss paid back less (net below
 * 0). A round that paid back exactly what it cost (a 10-cent bet cashed out
 * at 1.01x pays 10 cents) is neither: it is counted as a round and moves the
 * line by nothing.
 */

import type { ProfitPoint, RoundSummary, RoundView } from '../api/contract';
import { IDLE_CLOSE_MS } from '../game/refusal';
import type { GameState } from '../game/useGame';
import { roundPayoutCents, roundStakeCents } from '../game/winTier';

export interface LiveStats {
  /** Rounds counted since the visit began or the last Reset, break-even ones included. */
  readonly rounds: number;
  /** Rounds that paid back more than they cost. */
  readonly wins: number;
  /** Rounds that paid back less than they cost. */
  readonly losses: number;
  /** Bets played plus Patches bought. */
  readonly wageredCents: number;
  readonly paidOutCents: number;
  /** paidOutCents - wageredCents. Below 0 is a loss. */
  readonly netCents: number;
  /**
   * The running net after each round, oldest first, counting rounds from 1.
   * The line starts at $0.00 before round 1; that point is not stored
   * (profitLine adds it), as with the stats page.
   */
  readonly profit: readonly ProfitPoint[];
  /**
   * Every round id counted this visit. Reset keeps it, so a round counted
   * before a Reset can never come back into the new figures.
   */
  readonly counted: ReadonlySet<string>;
}

export const NO_LIVE_STATS: LiveStats = {
  rounds: 0,
  wins: 0,
  losses: 0,
  wageredCents: 0,
  paidOutCents: 0,
  netCents: 0,
  profit: [],
  counted: new Set<string>(),
};

/** Whether any bet in the round was played: a round of refunds only is not a round. */
function anyBetPlayed(round: RoundView): boolean {
  return round.balloons.some((balloon) => balloon.status !== 'refunded');
}

/** Adds one round's totals, under its id. */
function addTotals(stats: LiveStats, id: string, wagered: number, paid: number): LiveStats {
  const net = paid - wagered;
  const rounds = stats.rounds + 1;
  const netCents = stats.netCents + net;
  return {
    rounds,
    wins: stats.wins + (net > 0 ? 1 : 0),
    losses: stats.losses + (net < 0 ? 1 : 0),
    wageredCents: stats.wageredCents + wagered,
    paidOutCents: stats.paidOutCents + paid,
    netCents,
    profit: [...stats.profit, { round: rounds, netCents }],
    counted: new Set(stats.counted).add(id),
  };
}

/**
 * Adds a finished round. Returns the same object when nothing changes: the
 * round is not finished yet, was counted already (a re-render, a fresh copy
 * of the state or a conflict answer carries the same id), or had every bet
 * handed back.
 */
export function addRound(stats: LiveStats, round: RoundView): LiveStats {
  if (round.status !== 'finished' || stats.counted.has(round.id) || !anyBetPlayed(round)) {
    return stats;
  }
  // Refunded balloons are left out of both (see winTier).
  return addTotals(stats, round.id, roundStakeCents(round), roundPayoutCents(round));
}

/**
 * Adds a finished round from its line in the history list, with the same
 * figures as addRound: the line's betCents already leaves out refunded bets,
 * and a refunded balloon never has Patches or a payout. Returns the same
 * object when the round was counted already or had no bet played.
 */
export function addSummary(stats: LiveStats, line: RoundSummary): LiveStats {
  if (stats.counted.has(line.id) || line.betCents === 0) return stats;
  return addTotals(stats, line.id, line.betCents + line.patchesCents, line.payoutCents);
}

/** Starts the figures and the line afresh. The ids already counted are kept. */
export function resetLiveStats(stats: LiveStats): LiveStats {
  return { ...NO_LIVE_STATS, counted: stats.counted };
}

/** A round as the screen saw it in play: enough to find it again and judge how it ended. */
export interface SeenRound {
  readonly id: string;
  /** ISO 8601, as the round carries it. */
  readonly startedAt: string;
}

/** What the live stats are watching, besides the figures. */
export interface LiveWatch {
  readonly stats: LiveStats;
  /** The round in play on screen, until its end is counted or left out. */
  readonly inPlay: SeenRound | null;
  /**
   * A round seen in play that left the screen before its end was shown: its
   * last answer was lost on the way, and catching up (useGame's resync)
   * found no round in play. Its line in the history list, which comes with
   * that catching up, counts it.
   */
  readonly gone: SeenRound | null;
}

export const START_WATCH: LiveWatch = { stats: NO_LIVE_STATS, inPlay: null, gone: null };

/** The parts of the game's state watchShown reads, as the screen draws them. */
export type ShownGame = Pick<GameState, 'round' | 'history' | 'endedElsewhere'>;

/**
 * Whether a round known only from its history line was played here, as far
 * as the line can tell. Only the 24-hour rule ends a round without the
 * player, and it leaves two signs: it hands back every bet never pumped
 * (refundedCents), and it comes after a whole day without play, so the
 * round lasted at least that long. Either sign leaves the round out. (So a
 * round the player spread over more than a day, whose last answer was then
 * lost, is left out too: rare, and it never counts a round that was not played.)
 */
function playedHere(line: RoundSummary, seen: SeenRound): boolean {
  if (line.refundedCents > 0) return false;
  const lastedMs = Date.parse(line.finishedAt) - Date.parse(seen.startedAt);
  return Number.isFinite(lastedMs) && lastedMs < IDLE_CLOSE_MS;
}

/**
 * Looks at the game as the screen draws it (useGame's shown state, where
 * shownRound holds back a balloon still in its press) and counts each round
 * of this visit once its end is on screen.
 *
 * A round counts when it was seen in play on this screen during this visit
 * and then shows as finished:
 * - Never early. A balloon whose pump is still in its press is drawn as it
 *   was before, and the round still shows as in play, so nothing here can
 *   give a result away before the balloon shows it. The round counts in the
 *   same moment as the balance and the round's Net change on screen.
 * - However its end got there: with a pop, top or cash-out motion, or as a
 *   still picture after the answer for a balloon in its press was lost and
 *   the round turned out to be over.
 * - Not if it came to the screen already finished in a refusal
 *   (endedElsewhere): the 24-hour rule closed it, or it ended elsewhere.
 * - A finished round the screen only ever saw finished (one that was over
 *   before the page opened) is not one the player played here.
 * - A round that left the screen before its end showed (gone) is counted
 *   from its line in the history list, unless that line shows the 24-hour
 *   rule (playedHere).
 * - A round already in play when the page opened (restored after a refresh)
 *   counts in full, its bet too: the figures are per round, so it is counted
 *   as the round it was, not as the part of it played since the page opened.
 *
 * Returns the same object when nothing changes, so a caller can tell.
 */
export function watchShown(watch: LiveWatch, shown: ShownGame): LiveWatch {
  const { round, history, endedElsewhere } = shown;
  let next = watch;
  // The round in play has left the screen with its end unseen.
  if (next.inPlay && next.inPlay.id !== round?.id) {
    next = { ...next, inPlay: null, gone: next.inPlay };
  }
  if (round?.status === 'active') {
    if (next.inPlay?.id !== round.id) {
      next = {
        ...next,
        inPlay: { id: round.id, startedAt: round.startedAt },
        gone: next.gone?.id === round.id ? null : next.gone,
      };
    }
  } else if (round && (round.id === next.inPlay?.id || round.id === next.gone?.id)) {
    // Its end is on screen: counted, or left out if it came in a refusal.
    next = {
      stats: round.id === endedElsewhere ? next.stats : addRound(next.stats, round),
      inPlay: null,
      gone: next.gone?.id === round.id ? null : next.gone,
    };
  }
  const gone = next.gone;
  if (gone) {
    const line = history.find((r) => r.id === gone.id);
    if (line) {
      next = {
        ...next,
        stats:
          gone.id !== endedElsewhere && playedHere(line, gone)
            ? addSummary(next.stats, line)
            : next.stats,
        gone: null,
      };
    }
  }
  return next;
}

/** Up to this many rounds, the drawn line has one point per round. */
export const LINE_POINTS_IN_FULL = 300;

/** Past that, the rounds are split into this many groups of about equal size. */
export const LINE_GROUPS = 100;

/**
 * Shortens a long line for drawing, the way the server thins the stats
 * page's line: past LINE_POINTS_IN_FULL points, the rounds are cut into
 * LINE_GROUPS groups in order and each keeps its lowest, its highest and its
 * last point. So every peak and dip that matters stays, the line always ends
 * on the latest round, and at most 3 * LINE_GROUPS points are drawn. Each
 * point keeps its real round number, so they are still placed correctly.
 * The figures are never thinned: only the drawing is.
 */
export function thinLine(points: readonly ProfitPoint[]): readonly ProfitPoint[] {
  if (points.length <= LINE_POINTS_IN_FULL) return points;
  const kept: ProfitPoint[] = [];
  for (let group = 0; group < LINE_GROUPS; group += 1) {
    const start = Math.floor((group * points.length) / LINE_GROUPS);
    const end = Math.floor(((group + 1) * points.length) / LINE_GROUPS);
    let low = start;
    let high = start;
    for (let i = start; i < end; i += 1) {
      const here = points[i]?.netCents ?? 0;
      if (here < (points[low]?.netCents ?? 0)) low = i;
      if (here > (points[high]?.netCents ?? 0)) high = i;
    }
    for (const index of [...new Set([low, high, end - 1])].sort((a, b) => a - b)) {
      const point = points[index];
      if (point) kept.push(point);
    }
  }
  return kept;
}
