import { createHash } from 'node:crypto';
import type { PublicWin, PublicWinsResponse } from '@pump/contract';
import type { PublicWinRow, RoundsRepository } from '../repositories/rounds';
import type { Runtime } from '../runtime';

/**
 * The wins everyone may see: the latest, the largest and the luckiest, across
 * all players (the viewer's own wins are among them).
 *
 * A win is a finished round that paid out more than went in. What went in is
 * the bets that were played plus the Patches; a bet the 24-hour rule handed
 * back was never played, so it is left out, as everywhere else.
 *
 * This only reads rounds that are over. It decides nothing about the game
 * and moves no money. It sends no player id, no round id, no seed and no
 * cookie, so nobody can look a round up or learn who a player is. What it
 * does send is a tag per player and day (see playerTag), with the time, the
 * stake and the payout of each win.
 */

/** How many wins each of the three lists holds at most. */
export const PUBLIC_WINS_PER_LIST = 10;

/**
 * How long one answer is reused at least. The lists are the same for
 * everyone, the address needs no player, and a fresh answer reads every
 * finished round, so it must not be read on every request.
 */
export const PUBLIC_WINS_FRESH_MS = 5_000;

/**
 * A fresh answer is also kept for this many times as long as it took to
 * read. The read blocks every other request while it runs, so however large
 * the table of rounds grows, reading it takes at most about a twentieth of
 * the server's time.
 */
export const PUBLIC_WINS_REST_FACTOR = 20;

/**
 * The longest a read is ever taken to have lasted. The read is timed with
 * the same clock everything else uses, and that clock can jump: a laptop
 * wakes up, a host resumes, the time is corrected. Without this limit an
 * hour's jump during a read would count as an hour's read and freeze the
 * lists for twenty hours. With it the longest rest is twenty minutes.
 */
export const PUBLIC_WINS_SLOWEST_READ_MS = 60_000;

const SWITCHED_OFF: PublicWinsResponse = { enabled: false, recent: [], biggest: [], luckiest: [] };

/**
 * The tag shown in place of a player: six characters of a one-way hash of
 * the player's id and the day (UTC) the round finished.
 *
 * - It cannot be turned back into the player's id, and the id is not the
 *   cookie. The id itself is never sent to anyone.
 * - One player's wins of one day carry the same tag; the next day the tag is
 *   another. So someone who knows one of a player's wins (its time, stake
 *   and payout) can pick out that player's other listed wins of that day,
 *   and no further.
 * - Two players can get the same tag by chance. Same tag means "almost
 *   always the same player", not "certainly".
 */
export function playerTag(playerId: string, day: string): string {
  return createHash('sha256').update(`pump-public-tag:${day}:${playerId}`).digest('hex').slice(0, 6);
}

function toPublicWin(row: PublicWinRow): PublicWin {
  const wageredCents = row.betCents + row.patchesCents;
  return {
    // finishedAt is ISO 8601 in UTC; its first ten characters are the day.
    playerTag: playerTag(row.playerId, row.finishedAt.slice(0, 10)),
    difficultyId: row.difficultyId,
    wageredCents,
    payoutCents: row.payoutCents,
    netCents: row.payoutCents - wageredCents,
    multiplierHundredths: row.topMultiplierHundredths,
    finishedAt: row.finishedAt,
  };
}

export type PublicWinsService = ReturnType<typeof publicWinsService>;

/** The rows of the three lists as read, with player ids, and the answer made from them. */
interface Kept {
  readonly from: number;
  readonly until: number;
  readonly rows: Record<'recent' | 'biggest' | 'luckiest', readonly PublicWinRow[]>;
  readonly answer: PublicWinsResponse;
}

function answerFrom(rows: Kept['rows']): PublicWinsResponse {
  return {
    enabled: true,
    recent: rows.recent.map(toPublicWin),
    biggest: rows.biggest.map(toPublicWin),
    luckiest: rows.luckiest.map(toPublicWin),
  };
}

export function publicWinsService(runtime: Runtime, rounds: RoundsRepository) {
  let kept: Kept | null = null;

  return {
    /**
     * Takes one player's wins out of the answer that is being reused, at
     * once. Called when a player chooses to keep their wins private: the
     * database already leaves them out of every later read, and this covers
     * the seconds until the next one. It reads nothing, so it cannot be used
     * to make the server read the rounds more often.
     */
    hide(playerId: string): void {
      if (kept === null) return;
      const without = (list: readonly PublicWinRow[]): PublicWinRow[] =>
        list.filter((row) => row.playerId !== playerId);
      const rows = {
        recent: without(kept.rows.recent),
        biggest: without(kept.rows.biggest),
        luckiest: without(kept.rows.luckiest),
      };
      kept = { from: kept.from, until: kept.until, rows, answer: answerFrom(rows) };
    },

    /** The three lists, or empty lists if the feature is switched off. */
    list(): PublicWinsResponse {
      // Switched off: read nothing, send nothing.
      if (!runtime.features.publicWins) return SWITCHED_OFF;

      const asked = runtime.now().getTime();
      if (kept !== null && asked >= kept.from && asked < kept.until) return kept.answer;

      const rows = rounds.publicWins(PUBLIC_WINS_PER_LIST);
      const answer = answerFrom(rows);
      // Counted from the END of the read, and longer after a slow read.
      const read = runtime.now().getTime();
      const took = Math.min(Math.max(read - asked, 0), PUBLIC_WINS_SLOWEST_READ_MS);
      const rest = Math.max(PUBLIC_WINS_FRESH_MS, PUBLIC_WINS_REST_FACTOR * took);
      kept = { from: asked, until: read + rest, rows, answer };
      return answer;
    },
  };
}
