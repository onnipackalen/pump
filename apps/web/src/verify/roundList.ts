import type { HistoryResponse, RoundSummary } from '../api/contract';

/**
 * The verify page's list of rounds to pick from.
 *
 * It starts as the game's own list of newest rounds and grows downwards, a
 * page at a time, each time the player asks for older rounds. The game loads
 * its list again whenever a round ends or the seed is rotated, so the newest
 * part can change while older pages are on screen.
 *
 * The rules here keep one promise through all of that: the list is always
 * the start of the server's own list. Every round once, in the server's
 * order, with nothing missing in between, and the button shows whenever
 * older rounds may remain. It holds at the start (the game's list is the
 * server's first page), after each page (the server's next page after the
 * last round listed), and each time the game's list comes in again: the
 * rounds below are kept only when nothing can be missing in between, and
 * otherwise the list starts again from the game's list. (That last part
 * leans on the server's clock never going back; see laterMayHide.)
 */

/** How many rounds one press of "Older rounds" loads. */
export const OLDER_PAGE_SIZE = 20;

export const OLDER_FAILED = 'Could not load older rounds. Try again.';

export interface RoundListState {
  /** The game's list of newest rounds, as it was last handed in. */
  readonly newest: readonly RoundSummary[];
  /**
   * The rounds listed under `newest`, newest first: pages loaded with the
   * button, and rounds that newer ones pushed down out of `newest`.
   */
  readonly older: readonly RoundSummary[];
  /** Whether rounds older than the last one listed remain. Null: not asked yet. */
  readonly more: boolean | null;
  /** The round a page is being loaded after, or null when none is on its way. */
  readonly loadingAfter: string | null;
  /** A plain failure to show, or null. */
  readonly failure: string | null;
}

/** What happens to the list: the game's list changes, or a page is asked for and answered. */
export type RoundListEvent =
  | { readonly type: 'newest'; readonly rounds: readonly RoundSummary[] }
  | { readonly type: 'asked'; readonly before: string }
  | { readonly type: 'answered'; readonly before: string; readonly page: HistoryResponse }
  | { readonly type: 'failed'; readonly before: string };

export function startRoundList(newest: readonly RoundSummary[]): RoundListState {
  return { newest, older: [], more: null, loadingAfter: null, failure: null };
}

/** Every round in the list, newest first. */
export function listedRounds(state: RoundListState): readonly RoundSummary[] {
  return state.older.length === 0 ? state.newest : [...state.newest, ...state.older];
}

/** The id of the last round listed: the next page starts right after it. */
export function lastListed(state: RoundListState): string | null {
  return (state.older.at(-1) ?? state.newest.at(-1))?.id ?? null;
}

/**
 * Whether the "Older rounds" button shows. Once a page has come back, its
 * `more` says. Before that, older rounds can only exist if the game's list
 * is full: a shorter list is every round the player has.
 */
export function mayHaveOlder(state: RoundListState, newestSize: number): boolean {
  return state.more ?? (state.newest.length > 0 && state.newest.length >= newestSize);
}

/**
 * Whether `top` is just `listed` with newer rounds put on top: first rounds
 * that are not in `listed`, then the start of `listed`, in the same order.
 * Only then are the rounds below still right where they are, with nothing
 * missing between them and `top`. It is not when no round of `top` is in
 * `listed` (more new rounds finished than the game's list holds, so some
 * may be missing in between), nor when the rounds come in another order.
 */
export function fitsOnTop(top: readonly RoundSummary[], listed: readonly RoundSummary[]): boolean {
  if (listed.length === 0) return true;
  const held = new Set(listed.map((r) => r.id));
  const first = top.findIndex((r) => held.has(r.id));
  if (first < 0) return false;
  const rest = top.slice(first);
  return rest.length <= listed.length && rest.every((r, i) => r.id === listed[i]?.id);
}

/**
 * Whether a round that ended since `listed` was loaded could sort below the
 * last round of `top`, out of sight. The list is by finish time, and a round
 * that ended later finished no earlier than every listed one. So it sorts
 * below `top`'s last round only if it finished in that very millisecond,
 * which makes that last round as new as the newest round listed (ties are
 * then broken by start time and id, which can put the later round lower).
 * In real play that needs whole rounds inside one millisecond. When it can
 * happen, the list starts again rather than risk a round out of sight.
 */
export function laterMayHide(top: readonly RoundSummary[], listed: readonly RoundSummary[]): boolean {
  const bottom = top.at(-1);
  const newestListed = listed[0];
  if (bottom === undefined || newestListed === undefined) return false;
  return bottom.finishedAt >= newestListed.finishedAt;
}

/**
 * The list's rule, as a pure function.
 *
 * - The game's list changed: if it is the list with newer rounds on top,
 *   and no later round can be out of sight below it, those go on top and
 *   the rest stays, each round once (the game's copy, which is the newer,
 *   wins). If not, the list starts again from the game's list, and a page
 *   still on its way is dropped when it comes.
 * - A page came: its rounds go on the end, unless the list started again
 *   since it was asked for. A round already listed is never added twice.
 */
export function roundListStep(state: RoundListState, event: RoundListEvent): RoundListState {
  switch (event.type) {
    case 'newest': {
      if (event.rounds === state.newest) return state;
      const listed = listedRounds(state);
      if (!fitsOnTop(event.rounds, listed) || laterMayHide(event.rounds, listed)) {
        return startRoundList(event.rounds);
      }
      const onTop = new Set(event.rounds.map((r) => r.id));
      return { ...state, newest: event.rounds, older: listed.filter((r) => !onTop.has(r.id)) };
    }
    case 'asked':
      return { ...state, loadingAfter: event.before, failure: null };
    case 'answered': {
      if (event.before !== state.loadingAfter) return state;
      // The list's last round is where the page was asked from, unless the
      // list has started again since. Then the page may not follow on.
      if (event.before !== lastListed(state)) return { ...state, loadingAfter: null };
      const seen = new Set(listedRounds(state).map((r) => r.id));
      const added: RoundSummary[] = [];
      for (const round of event.page.rounds) {
        if (seen.has(round.id)) continue;
        seen.add(round.id);
        added.push(round);
      }
      return {
        ...state,
        older: [...state.older, ...added],
        more: event.page.more,
        loadingAfter: null,
        failure: null,
      };
    }
    case 'failed':
      if (event.before !== state.loadingAfter) return state;
      return { ...state, loadingAfter: null, failure: OLDER_FAILED };
  }
}

/**
 * The rounds with each one's seed brought up to date. A round loaded before
 * its seed was rotated still says "seed in use". But a server seed is
 * revealed all at once and never hidden again: so once anything says one
 * round's seed is revealed (a newer answer about another round on it, or
 * this browser's own rotation, in `revealedHashes`), every listed round on
 * that seed (the same hash) can be checked. Never the other way: a round
 * the server called revealed is never shown as in use.
 */
export function withSeedsKnown(
  rounds: readonly RoundSummary[],
  revealedHashes: readonly string[],
): readonly RoundSummary[] {
  const revealed = new Set(revealedHashes);
  for (const round of rounds) if (round.seedRevealed) revealed.add(round.serverSeedHash);
  return rounds.map((round) =>
    !round.seedRevealed && revealed.has(round.serverSeedHash) ? { ...round, seedRevealed: true } : round,
  );
}
