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

import type { ProfitPoint, RoundView } from '../api/contract';
import type { Beat } from '../game/useGame';
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
  const wagered = roundStakeCents(round);
  const paid = roundPayoutCents(round);
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
    counted: new Set(stats.counted).add(round.id),
  };
}

/** Starts the figures and the line afresh. The ids already counted are kept. */
export function resetLiveStats(stats: LiveStats): LiveStats {
  return { ...NO_LIVE_STATS, counted: stats.counted };
}

/**
 * What the live stats are watching, besides the figures: the round last seen
 * in play on this screen.
 */
export interface LiveWatch {
  readonly stats: LiveStats;
  readonly inPlayId: string | null;
}

export const START_WATCH: LiveWatch = { stats: NO_LIVE_STATS, inPlayId: null };

/** The beats a balloon's last motion starts with: it popped, reached its top or cashed out. */
const END_BEATS: ReadonlySet<Beat> = new Set<Beat>(['popped', 'top', 'cashed']);

/**
 * Looks at the round as the screen draws it (useGame's shownRound, with
 * `beats` from the same state) and counts it once its end is on screen.
 *
 * A round counts when all three hold:
 * - It shows as finished. A balloon whose pump is still in its press is drawn
 *   as it was before (shownRound), and the round still shows as in play, so
 *   nothing here can give a result away before the balloon shows it. The
 *   round counts in the same moment as its pop or cash-out motion starts and
 *   the balance and the round's Net change: never earlier.
 * - It was seen in play on this screen during this visit. A finished round
 *   the screen only ever saw finished is not one the player played here.
 * - Its end was played as a balloon's motion: some balloon's beat is a pop,
 *   a top or a cash-out. That is how every answer to the player's own pump
 *   or cash-out ends a round. A round closed by the 24-hour rule while the
 *   player was away comes back in a refusal with no motion, so it is left out.
 *
 * Returns the same object when nothing changes, so a caller can tell.
 */
export function watchShown(
  watch: LiveWatch,
  round: RoundView | null,
  beats: readonly Beat[],
): LiveWatch {
  if (!round) return watch;
  if (round.status === 'active') {
    return round.id === watch.inPlayId ? watch : { ...watch, inPlayId: round.id };
  }
  if (round.id !== watch.inPlayId) return watch;
  if (!beats.some((beat) => END_BEATS.has(beat))) return watch;
  const stats = addRound(watch.stats, round);
  return stats === watch.stats ? watch : { ...watch, stats };
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
