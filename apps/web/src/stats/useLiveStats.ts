import { useCallback, useId, useState } from 'react';
import {
  resetLiveStats,
  START_WATCH,
  watchShown,
  type LiveStats,
  type LiveWatch,
  type ShownGame,
} from './liveTally';

export interface LiveStatsControl {
  readonly stats: LiveStats;
  /** Whether the panel is open. Closed at the start of every visit. */
  readonly open: boolean;
  /** The panel's element id, for the opener's aria-controls. */
  readonly panelId: string;
  /** The opener's element id, so closing the panel can hand focus back to it. */
  readonly openerId: string;
  readonly toggle: () => void;
  /** Closes the panel and puts focus back on the opener. */
  readonly close: () => void;
  /** Starts the figures and the line afresh. */
  readonly reset: () => void;
}

/**
 * The live stats of this visit, and whether their panel is open.
 *
 * `shown` is the game's state as the screen draws it (useGame's shown
 * state), so a round is counted only once its end is on screen (see
 * watchShown). It keeps counting while the panel is closed, and while the
 * stats or verify page is showing.
 *
 * The figures live in memory only, for this visit: a page refresh starts
 * them afresh (Stake's live stats do the same). A round restored by the
 * refresh that had already finished is never counted, as it was not played
 * in this visit.
 */
export function useLiveStats(shown: ShownGame): LiveStatsControl {
  const [watch, setWatch] = useState<LiveWatch>(START_WATCH);
  // Counted while rendering, so the figures change in the same frame as the
  // balance and the round's Net, never a frame later. watchShown returns the
  // same object once nothing is new, so this settles after one extra pass
  // (React's pattern for keeping information from earlier renders).
  const next = watchShown(watch, shown);
  if (next !== watch) setWatch(next);

  const [open, setOpen] = useState(false);
  const panelId = useId();
  const openerId = useId();

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => {
    setOpen(false);
    // The Close button is about to go: focus goes back where the panel came from.
    document.getElementById(openerId)?.focus();
  }, [openerId]);
  const reset = useCallback(() => setWatch((w) => ({ ...w, stats: resetLiveStats(w.stats) })), []);

  return { stats: next.stats, open, panelId, openerId, toggle, close, reset };
}
