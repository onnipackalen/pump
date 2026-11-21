import { createHash } from 'node:crypto';
import type { PublicWin, PublicWinsResponse } from '@pump/contract';
import type { PublicWinRow, RoundsRepository } from '../repositories/rounds';
import type { Runtime } from '../runtime';

/**
 * The wins everyone may see: the latest, the largest and the luckiest.
 *
 * A win is a finished round that paid out more than went in. What went in is
 * the bets that were played plus the Patches; a bet the 24-hour rule handed
 * back was never played, so it is left out, as everywhere else.
 *
 * This only reads rounds that are over. It decides nothing about the game
 * and moves no money. It sends nothing that could identify a player or let
 * anyone look a round up: no player id, no round id, no seed, no cookie.
 */

/** How many wins each of the three lists holds at most. */
export const PUBLIC_WINS_PER_LIST = 10;

/**
 * How long one answer is reused. The lists are the same for everyone and are
 * read from every finished round, and the address needs no player, so it must
 * not cost a full read on every request.
 */
export const PUBLIC_WINS_FRESH_MS = 5_000;

const SWITCHED_OFF: PublicWinsResponse = { enabled: false, recent: [], biggest: [], luckiest: [] };

/**
 * The tag shown in place of a player. It is the same for all of one player's
 * wins, so a viewer can see that two wins belong together, and it is a
 * one-way hash cut to six characters, so it cannot be turned back into the
 * player's id. The id itself is never sent, and it is not the cookie.
 */
export function playerTag(playerId: string): string {
  return createHash('sha256').update(`pump-public-tag:${playerId}`).digest('hex').slice(0, 6);
}

function toPublicWin(row: PublicWinRow): PublicWin {
  const wageredCents = row.betCents + row.patchesCents;
  return {
    playerTag: playerTag(row.playerId),
    difficultyId: row.difficultyId,
    wageredCents,
    payoutCents: row.payoutCents,
    netCents: row.payoutCents - wageredCents,
    multiplierHundredths: row.topMultiplierHundredths,
    finishedAt: row.finishedAt,
  };
}

export type PublicWinsService = ReturnType<typeof publicWinsService>;

export function publicWinsService(runtime: Runtime, rounds: RoundsRepository) {
  let kept: { readonly at: number; readonly answer: PublicWinsResponse } | null = null;

  return {
    /** The three lists, or empty lists if the feature is switched off. */
    list(): PublicWinsResponse {
      // Switched off: read nothing, send nothing.
      if (!runtime.features.publicWins) return SWITCHED_OFF;

      const now = runtime.now().getTime();
      if (kept !== null && now >= kept.at && now - kept.at < PUBLIC_WINS_FRESH_MS) {
        return kept.answer;
      }
      const answer: PublicWinsResponse = {
        enabled: true,
        recent: rounds.publicWins('recent', PUBLIC_WINS_PER_LIST).map(toPublicWin),
        biggest: rounds.publicWins('biggest', PUBLIC_WINS_PER_LIST).map(toPublicWin),
        luckiest: rounds.publicWins('luckiest', PUBLIC_WINS_PER_LIST).map(toPublicWin),
      };
      kept = { at: now, answer };
      return answer;
    },
  };
}
