import type { DifficultyStats, PlayerStats, ProfitPoint } from '@pump/contract';
import { multiplierAt } from '@pump/engine';
import type { PlayedRound, RoundsRepository } from '../repositories/rounds';
import type { Runtime } from '../runtime';

/**
 * The player's stats: profit over time, best win, rounds by difficulty.
 *
 * This only adds up money that the game already settled. It decides nothing
 * about the game, so no game rule lives here.
 *
 * What counts: bets that were played, Patches bought, and payouts. A bet the
 * 24-hour rule handed back was never played, so it is void and left out, the
 * same way the RTP figures leave it out. A round whose bets were all handed
 * back adds nothing and is not counted as a round.
 */

/** Up to this many rounds, the profit line has one point per round. */
export const PROFIT_POINTS_IN_FULL = 300;

/** Past that, the rounds are split into this many groups of about equal size. */
export const PROFIT_GROUPS = 100;

/** The money that went in on a round: bets played plus Patches. */
function wagered(round: PlayedRound): number {
  return round.betCents + round.patchesCents;
}

/** What a round gained (above 0) or lost (below 0). */
function netOf(round: PlayedRound): number {
  return round.payoutCents - wagered(round);
}

/**
 * Shortens a long profit line without hiding anything a player would look for.
 *
 * Up to PROFIT_POINTS_IN_FULL rounds, every point is kept. Past that, the
 * rounds are cut into PROFIT_GROUPS groups in order, and each group keeps
 * three points: its lowest, its highest and its last. So the line keeps every
 * peak and every dip that matters (the overall highest and lowest points are
 * always the highest or lowest of their group) and always ends on the latest
 * round. At most 3 * PROFIT_GROUPS points come out.
 *
 * Example: 1,000 rounds make 100 groups of 10. Rounds 1 to 10 form the first
 * group; if the net is lowest after round 4 and highest after round 9, the
 * points kept are rounds 4, 9 and 10.
 */
export function thinProfit(points: readonly ProfitPoint[]): ProfitPoint[] {
  if (points.length <= PROFIT_POINTS_IN_FULL) return [...points];
  const kept: ProfitPoint[] = [];
  for (let group = 0; group < PROFIT_GROUPS; group += 1) {
    // Group g covers points [floor(g * n / G), floor((g + 1) * n / G)), so the
    // groups cover every point once and differ in size by at most one.
    const start = Math.floor((group * points.length) / PROFIT_GROUPS);
    const end = Math.floor(((group + 1) * points.length) / PROFIT_GROUPS);
    let low = start;
    let high = start;
    for (let i = start; i < end; i += 1) {
      const here = points[i]?.netCents ?? 0;
      if (here < (points[low]?.netCents ?? 0)) low = i;
      if (here > (points[high]?.netCents ?? 0)) high = i;
    }
    // In round order, each index once.
    for (const index of [...new Set([low, high, end - 1])].sort((a, b) => a - b)) {
      const point = points[index];
      if (point) kept.push(point);
    }
  }
  return kept;
}

/** The stats before the best win's multiplier is looked up. */
export interface Summary extends Omit<PlayerStats, 'bestWin'> {
  /** The round with the biggest gain, or null if no round has gained anything. */
  readonly bestRound: PlayedRound | null;
}

/**
 * Adds up a player's finished rounds. `rounds` must be oldest first.
 * `difficultyOrder` is the game's own list of difficulty ids, which sets the
 * order of byDifficulty; a difficulty no longer in the game comes after
 * them, in the order it was first played.
 *
 * Pure: the same rounds always give the same summary.
 */
export function summarize(
  rounds: readonly PlayedRound[],
  difficultyOrder: readonly string[],
): Summary {
  let count = 0;
  let balloons = 0;
  let wageredCents = 0;
  let paidOutCents = 0;
  const profit: ProfitPoint[] = [];
  let bestRound: PlayedRound | null = null;
  const perDifficulty = new Map<string, { rounds: number; wagered: number; paid: number }>();

  for (const round of rounds) {
    // All bets handed back: nothing was played, so it is not a round.
    if (round.balloonsPlayed === 0) continue;
    count += 1;
    balloons += round.balloonsPlayed;
    wageredCents += wagered(round);
    paidOutCents += round.payoutCents;
    profit.push({ round: count, netCents: paidOutCents - wageredCents });

    // A win is a real gain: more back than went in. On a tie the earlier
    // round keeps the title.
    const net = netOf(round);
    if (net > 0 && (bestRound === null || net > netOf(bestRound))) bestRound = round;

    const entry = perDifficulty.get(round.difficultyId) ?? { rounds: 0, wagered: 0, paid: 0 };
    entry.rounds += 1;
    entry.wagered += wagered(round);
    entry.paid += round.payoutCents;
    perDifficulty.set(round.difficultyId, entry);
  }

  // The game's own order first, then any difficulty it no longer has.
  const ids = [
    ...difficultyOrder.filter((id) => perDifficulty.has(id)),
    ...[...perDifficulty.keys()].filter((id) => !difficultyOrder.includes(id)),
  ];
  const byDifficulty: DifficultyStats[] = ids.map((difficultyId) => {
    const entry = perDifficulty.get(difficultyId) ?? { rounds: 0, wagered: 0, paid: 0 };
    return {
      difficultyId,
      rounds: entry.rounds,
      wageredCents: entry.wagered,
      paidOutCents: entry.paid,
      netCents: entry.paid - entry.wagered,
    };
  });

  return {
    rounds: count,
    balloons,
    wageredCents,
    paidOutCents,
    netCents: paidOutCents - wageredCents,
    profit: thinProfit(profit),
    bestRound,
    byDifficulty,
  };
}

export type StatsService = ReturnType<typeof statsService>;

export function statsService(runtime: Runtime, rounds: RoundsRepository) {
  return {
    /** The player's stats over every round they have finished. */
    of(playerId: string): PlayerStats {
      const { bestRound, ...summary } = summarize(
        rounds.playedRounds(playerId),
        runtime.config.difficulties.map((difficulty) => difficulty.id),
      );
      if (bestRound === null) return { ...summary, bestWin: null };

      // The best win's top multiplier: the highest rung a balloon in it cashed
      // out at, read on the ladder that round was played with.
      const stored = rounds.find(bestRound.id);
      const cashed = (stored?.round.balloons ?? []).filter(
        (balloon) => balloon.status === 'cashed' && balloon.rung >= 1,
      );
      if (!stored || cashed.length === 0) {
        throw new Error(`Round ${bestRound.id} gained money but has no cashed balloon`);
      }
      const multiplierHundredths = Math.max(
        ...cashed.map((balloon) => multiplierAt(stored.round.ladder, balloon.rung)),
      );
      return {
        ...summary,
        bestWin: {
          roundId: bestRound.id,
          difficultyId: bestRound.difficultyId,
          netCents: netOf(bestRound),
          wageredCents: wagered(bestRound),
          payoutCents: bestRound.payoutCents,
          multiplierHundredths,
          finishedAt: bestRound.finishedAt,
          seedRevealed: bestRound.seedRevealed,
        },
      };
    },
  };
}
