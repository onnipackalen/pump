import { ApiFailure, NetworkFailure } from '../api/client';
import type { FairnessView, RoundView } from '../api/contract';
import { SeedsNotShown, shownBefore } from './session';

/**
 * What the screen does when an action fails. Plain functions, no React, so
 * each rule can be tested on its own; useGame applies them.
 */

/** The words for a failure: the server's own, or a plain fallback. */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure || error instanceof NetworkFailure || error instanceof SeedsNotShown) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

/**
 * What to do after a failure, besides showing it:
 * - 'start-over': the server no longer knows this browser's player (the
 *   cookie has gone, or the server's data was reset). Start again the way the
 *   first visit does.
 * - 'resync': the screen may be behind the server. The answer may have been
 *   lost on the way, a round the screen doesn't show is in the way, the
 *   round the screen shows no longer exists, the seeds on screen could not
 *   be bet on (SeedsNotShown), or they are no longer the player's seeds
 *   (seeds_changed: a round played, or a seed changed, in another tab).
 *   Ask for the whole state again.
 * - 'none': the refusal says all there is (a 409 with the round as it is now
 *   carries that round; too little money carries the balance).
 */
export function afterFailure(error: unknown): 'start-over' | 'resync' | 'none' {
  if (error instanceof NetworkFailure || error instanceof SeedsNotShown) return 'resync';
  if (!(error instanceof ApiFailure)) return 'none';
  switch (error.code) {
    case 'no_session':
      return 'start-over';
    case 'round_active':
    case 'not_found':
    case 'seeds_changed':
      return 'resync';
    case 'conflict':
      return error.body.round ? 'none' : 'resync';
    default:
      return 'none';
  }
}

/**
 * The seeds a "seeds_changed" refusal carries: the player's seeds as they
 * are now, for the Provably fair panel. Null for any other failure, or for
 * seeds not in a form a round can be started on (the resync that follows
 * loads them again).
 */
export function seedsInRefusal(error: unknown): FairnessView | null {
  if (!(error instanceof ApiFailure) || error.code !== 'seeds_changed') return null;
  const fairness = error.body.fairness;
  return fairness !== undefined && shownBefore(fairness) !== null ? fairness : null;
}

/**
 * Said when a round start is refused because the seeds on screen are no
 * longer the player's seeds. The screen's own words, so they are the same
 * with the real server and the in-browser demo.
 */
export const SEEDS_CHANGED_TEXT =
  'No round was started: the seeds changed since this screen last showed them (in another ' +
  'tab, say). Check Provably fair, then press Bet again.';

/** The finished round a refusal carries, if it carries one. */
export function finishedRefusal(error: unknown): RoundView | null {
  if (!(error instanceof ApiFailure)) return null;
  const round = error.body.round;
  return round?.status === 'finished' ? round : null;
}

/**
 * How long a round must be left untouched before the server closes it (the
 * 24-hour rule; the server's own setting is ABANDONED_AFTER_MS). The screen
 * uses it only to word a notice, never to decide anything about money.
 */
export const IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;

export const CLOSED_FOR_IDLE_TEXT =
  'This round was closed after 24 hours without play. Pumped balloons were cashed out and unpumped bets were returned.';

/**
 * True when a finished round was closed by the 24-hour rule, as far as the
 * screen can tell. The round carries no reason, so this reads the signs:
 * - a refunded balloon: only the 24-hour rule hands a bet back; or
 * - the round started 24 hours ago or more, and every balloon that was
 *   still in play on screen is now cashed out with no new draw: exactly
 *   what the rule does to a pumped balloon.
 * Anything else (say, a pop or a cash-out made in another tab) is not
 * called a 24-hour close, so the notice never says something untrue.
 */
export function closedForIdle(before: RoundView | null, after: RoundView, nowMs: number): boolean {
  if (after.status !== 'finished') return false;
  if (after.balloons.some((b) => b.status === 'refunded')) return true;
  const startedMs = Date.parse(after.startedAt);
  if (!Number.isFinite(startedMs) || nowMs - startedMs < IDLE_CLOSE_MS) return false;
  if (!before || before.id !== after.id) return false;
  const live = before.balloons.filter((b) => b.status === 'active');
  return (
    live.length > 0 &&
    live.every((b) => {
      const now = after.balloons[b.index];
      return now?.status === 'cashed' && now.drawIndex === b.drawIndex;
    })
  );
}

/**
 * The notice for a failure. A refusal that carries a finished round is said
 * calmly, as information: the round is over, and here is how it ended. A
 * start refused because the seeds changed says so in this screen's words.
 * Every other failure is an error, in the server's own words.
 */
export function failureNotice(
  error: unknown,
  before: RoundView | null,
  nowMs: number,
): { readonly tone: 'info' | 'error'; readonly text: string } {
  if (error instanceof ApiFailure && error.code === 'seeds_changed') {
    return { tone: 'error', text: SEEDS_CHANGED_TEXT };
  }
  const finished = finishedRefusal(error);
  if (finished) {
    return {
      tone: 'info',
      text: closedForIdle(before, finished, nowMs) ? CLOSED_FOR_IDLE_TEXT : describeFailure(error),
    };
  }
  return { tone: 'error', text: describeFailure(error) };
}

export const LOST_SESSION_TEXT =
  'Your game session was lost, so a new one has started. Rounds and seeds from before it are no longer shown here.';
