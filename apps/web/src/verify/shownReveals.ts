/**
 * The reveal lines this device's screen showed, kept so the verify page can
 * check them later.
 *
 * A pump's result moves money, so the wallet ties it to the record. A reveal
 * ("Next pump would have popped") moves nothing, so nothing else ties the
 * line on screen to the reveal the server sends later for checking. This
 * keeps the line: for each round and balloon, how it ended (popped or top)
 * and the rung it named.
 *
 * It lives in memory, and in localStorage when the browser allows. It is
 * only a help: another device, a private window or cleared site data has
 * none, and then the verify page says nothing about the screen.
 */

import type { RevealOutcome, RoundView } from '../api/contract';
import { afterRoundLine } from '../game/afterRound';

/** One reveal line as the screen showed it. */
export interface ShownReveal {
  readonly outcome: RevealOutcome;
  readonly reachedRung: number;
}

/** The part of localStorage this needs, so tests can pass their own. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'pump.shownReveals';

/** The most rounds kept. The oldest goes first. */
export const MAX_ROUNDS = 200;

/** Round id -> balloon index -> the line shown. Oldest round first. */
type Shown = Map<string, Map<number, ShownReveal>>;

/** As stored: [roundId, [[balloonIndex, outcome, reachedRung], ...]], oldest first. */
type StoredLine = readonly [number, RevealOutcome, number];
type StoredRound = readonly [string, readonly StoredLine[]];

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOutcome(value: unknown): value is RevealOutcome {
  return value === 'popped' || value === 'top';
}

/** Reads what is stored. Anything it does not recognise is left out. */
function parse(text: string | null): Shown {
  const shown: Shown = new Map();
  if (text === null) return shown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return shown;
  }
  if (!Array.isArray(parsed)) return shown;
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const [roundId, lines] = entry as unknown[];
    if (typeof roundId !== 'string' || !Array.isArray(lines)) continue;
    const byBalloon = new Map<number, ShownReveal>();
    for (const line of lines as unknown[]) {
      if (!Array.isArray(line)) continue;
      const [balloonIndex, outcome, reachedRung] = line as unknown[];
      if (isWhole(balloonIndex) && isOutcome(outcome) && isWhole(reachedRung)) {
        byBalloon.set(balloonIndex, { outcome, reachedRung });
      }
    }
    if (byBalloon.size > 0) shown.set(roundId, byBalloon);
  }
  return shown;
}

function serialise(shown: Shown): string {
  const rounds: StoredRound[] = [...shown].map(([roundId, byBalloon]) => [
    roundId,
    [...byBalloon].map(([index, line]): StoredLine => [index, line.outcome, line.reachedRung]),
  ]);
  return JSON.stringify(rounds);
}

/** The browser's localStorage, or null where it is blocked. */
function browserStore(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A memory of shown reveal lines, kept in `store` too when there is one. */
export function shownRevealStore(store: KeyValueStore | null) {
  let shown: Shown | null = null;

  const load = (): Shown => {
    if (shown === null) {
      let text: string | null = null;
      try {
        text = store?.getItem(KEY) ?? null;
      } catch {
        // Storage blocked: start empty, and keep this visit in memory.
      }
      shown = parse(text);
    }
    return shown;
  };

  return {
    /**
     * Keeps every reveal line a finished round shows. Call it when the lines
     * are on screen. The first line kept for a balloon stays: what the
     * player saw first is what the verify page checks.
     */
    remember(round: RoundView): void {
      if (round.status !== 'finished') return;
      const all = load();
      const byBalloon = new Map(all.get(round.id) ?? []);
      for (const balloon of round.balloons) {
        const afterRound = balloon.afterRound ?? null;
        if (afterRound === null || afterRoundLine(balloon) === null) continue;
        if (byBalloon.has(balloon.index)) continue;
        byBalloon.set(balloon.index, {
          outcome: afterRound.outcome,
          reachedRung: afterRound.reachedRung,
        });
      }
      if (byBalloon.size === (all.get(round.id)?.size ?? 0)) return;
      // Newest last, and only the latest MAX_ROUNDS rounds.
      all.delete(round.id);
      all.set(round.id, byBalloon);
      for (const roundId of [...all.keys()].slice(0, Math.max(0, all.size - MAX_ROUNDS))) {
        all.delete(roundId);
      }
      try {
        store?.setItem(KEY, serialise(all));
      } catch {
        // Storage full or blocked: it is still kept for this visit.
      }
    },

    /** The line this device showed for one balloon, or null if it kept none. */
    shownOf(roundId: string, balloonIndex: number): ShownReveal | null {
      return load().get(roundId)?.get(balloonIndex) ?? null;
    },
  };
}

export type ShownRevealStore = ReturnType<typeof shownRevealStore>;

/** This browser's memory of shown reveal lines. */
export const shownReveals: ShownRevealStore = shownRevealStore(browserStore());

/**
 * Whether the line the screen showed says the same as the reveal worked out
 * from the seeds: the same ending on the same rung. A screen that showed a
 * line where no reveal is due does not.
 */
export function screenAgrees(
  shown: ShownReveal,
  recomputed: { readonly outcome: RevealOutcome; readonly reachedRung: number } | null,
): boolean {
  return (
    recomputed !== null &&
    shown.outcome === recomputed.outcome &&
    shown.reachedRung === recomputed.reachedRung
  );
}
