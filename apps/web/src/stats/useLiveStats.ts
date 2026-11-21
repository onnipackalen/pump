import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import {
  resetLiveStats,
  START_WATCH,
  watchShown,
  type LiveStats,
  type LiveWatch,
  type ShownGame,
} from './liveTally';

/** What is being played now: a round by hand, auto-play, or nothing. */
export type InPlay = 'round' | 'auto-play' | null;

export interface LiveStatsControl {
  readonly stats: LiveStats;
  /** Whether the player has the panel open. Closed at the start of every visit. */
  readonly open: boolean;
  /**
   * What holds the panel back, or null. On an upright screen the round panel
   * needs all of the room under the balloons during a round and auto-play,
   * so the strip waits until play stops (see live-stats.css), and the
   * opener says so instead of looking like it does nothing.
   */
  readonly heldBy: InPlay;
  /** Whether the panel is on screen now: open and not held back. */
  readonly shown: boolean;
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
 * What holds the panel back: play, but only on an upright screen. Beside
 * the game (a wide screen) the panel has its own room and stays.
 */
export function heldBy(playing: InPlay, upright: boolean): InPlay {
  return upright ? playing : null;
}

// The same test as the CSS that lays the page out for an upright screen.
const UPRIGHT = '(orientation: portrait)';

function watchUpright(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(UPRIGHT);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isUpright(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(UPRIGHT).matches;
}

/**
 * The live stats of this visit, and whether their panel is open.
 *
 * `shown` is the game's state as the screen draws it (useGame's shown
 * state), so a round is counted only once its end is on screen (see
 * watchShown). It keeps counting while the panel is closed, and while the
 * stats or verify page is showing. `playing` is what is being played now.
 *
 * The figures live in memory only, for this visit: a page refresh starts
 * them afresh (Stake's live stats do the same). A round restored by the
 * refresh that had already finished is never counted, as it was not played
 * in this visit.
 */
export function useLiveStats(shown: ShownGame, playing: InPlay): LiveStatsControl {
  const [watch, setWatch] = useState<LiveWatch>(START_WATCH);
  // Counted while rendering, so the figures change in the same frame as the
  // balance and the round's Net, never a frame later. watchShown returns the
  // same object once nothing is new, so this settles after one extra pass
  // (React's pattern for keeping information from earlier renders).
  const next = watchShown(watch, shown);
  if (next !== watch) setWatch(next);

  const [open, setOpen] = useState(false);
  const upright = useSyncExternalStore(watchUpright, isUpright, () => false);
  const held = heldBy(playing, upright);
  const panelId = useId();
  const openerId = useId();

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => {
    setOpen(false);
    // The Close button is about to go: focus goes back where the panel came from.
    document.getElementById(openerId)?.focus();
  }, [openerId]);
  const reset = useCallback(() => setWatch((w) => ({ ...w, stats: resetLiveStats(w.stats) })), []);

  return {
    stats: next.stats,
    open,
    heldBy: held,
    shown: open && held === null,
    panelId,
    openerId,
    toggle,
    close,
    reset,
  };
}
