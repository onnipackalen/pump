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
 * It also keeps each balloon's top rung as this device first saw the round
 * (normally the answer that started it). A reveal stops at the top rung, and
 * the record's top comes from its own payout cap, so a record with a lower
 * cap could carry a shorter reveal that still checks out against itself.
 * The top this device showed during the round is the player's evidence.
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

/** What this device kept of one round. */
interface ShownRound {
  /** Balloon index -> the reveal line shown once the round was over. */
  readonly lines: ReadonlyMap<number, ShownReveal>;
  /** Balloon index -> its top rung, as this device first saw the round. */
  readonly tops: ReadonlyMap<number, number>;
}

/** Round id -> what was kept of it. Oldest round first. */
type Shown = Map<string, ShownRound>;

/**
 * As stored, oldest first:
 * [roundId, [[balloonIndex, outcome, reachedRung], ...], [[balloonIndex, topRung], ...]].
 * Rounds kept before tops were kept have no third part.
 */
type StoredLine = readonly [number, RevealOutcome, number];
type StoredTop = readonly [number, number];
type StoredRound = readonly [string, readonly StoredLine[], readonly StoredTop[]];

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
    const [roundId, storedLines, storedTops = []] = entry as unknown[];
    if (typeof roundId !== 'string' || !Array.isArray(storedLines) || !Array.isArray(storedTops)) {
      continue;
    }
    const lines = new Map<number, ShownReveal>();
    for (const line of storedLines as unknown[]) {
      if (!Array.isArray(line)) continue;
      const [balloonIndex, outcome, reachedRung] = line as unknown[];
      if (isWhole(balloonIndex) && isOutcome(outcome) && isWhole(reachedRung)) {
        lines.set(balloonIndex, { outcome, reachedRung });
      }
    }
    const tops = new Map<number, number>();
    for (const top of storedTops as unknown[]) {
      if (!Array.isArray(top)) continue;
      const [balloonIndex, topRung] = top as unknown[];
      if (isWhole(balloonIndex) && isWhole(topRung)) tops.set(balloonIndex, topRung);
    }
    if (lines.size > 0 || tops.size > 0) shown.set(roundId, { lines, tops });
  }
  return shown;
}

function serialise(shown: Shown): string {
  const rounds: StoredRound[] = [...shown].map(([roundId, { lines, tops }]) => [
    roundId,
    [...lines].map(([index, line]): StoredLine => [index, line.outcome, line.reachedRung]),
    [...tops].map(([index, topRung]): StoredTop => [index, topRung]),
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

  /** Puts a round's updated record last (newest), keeps the latest MAX_ROUNDS, and saves. */
  const save = (roundId: string, kept: ShownRound): void => {
    const all = load();
    all.delete(roundId);
    all.set(roundId, kept);
    for (const old of [...all.keys()].slice(0, Math.max(0, all.size - MAX_ROUNDS))) {
      all.delete(old);
    }
    try {
      store?.setItem(KEY, serialise(all));
    } catch {
      // Storage full or blocked: it is still kept for this visit.
    }
  };

  const keptOf = (roundId: string): ShownRound =>
    load().get(roundId) ?? { lines: new Map(), tops: new Map() };

  return {
    /**
     * Keeps every reveal line a finished round shows. Call it when the lines
     * are on screen. The first line kept for a balloon stays: what the
     * player saw first is what the verify page checks.
     */
    remember(round: RoundView): void {
      if (round.status !== 'finished') return;
      const kept = keptOf(round.id);
      const lines = new Map(kept.lines);
      for (const balloon of round.balloons) {
        const afterRound = balloon.afterRound ?? null;
        if (afterRound === null || afterRoundLine(balloon) === null) continue;
        if (lines.has(balloon.index)) continue;
        lines.set(balloon.index, {
          outcome: afterRound.outcome,
          reachedRung: afterRound.reachedRung,
        });
      }
      if (lines.size === kept.lines.size) return;
      save(round.id, { lines, tops: kept.tops });
    },

    /**
     * Keeps each balloon's top rung as this device first saw the round. Call
     * it with every round the screen shows; the first top kept for a balloon
     * stays, so a later answer cannot change it.
     */
    rememberTops(round: RoundView): void {
      const kept = keptOf(round.id);
      const tops = new Map(kept.tops);
      for (const balloon of round.balloons) {
        if (!tops.has(balloon.index)) tops.set(balloon.index, balloon.topRung);
      }
      if (tops.size === kept.tops.size) return;
      save(round.id, { lines: kept.lines, tops });
    },

    /** The line this device showed for one balloon, or null if it kept none. */
    shownOf(roundId: string, balloonIndex: number): ShownReveal | null {
      return load().get(roundId)?.lines.get(balloonIndex) ?? null;
    },

    /** The top rung this device first showed for one balloon, or null if it kept none. */
    topOf(roundId: string, balloonIndex: number): number | null {
      return load().get(roundId)?.tops.get(balloonIndex) ?? null;
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

/**
 * Whether the top rung this device showed for a balloon during the round is
 * the one the record's bet, ladder and payout cap give (the replayed
 * balloon's top). With no replayed balloon there is nothing to compare:
 * verifyRound already says why it could not be replayed.
 */
export function topAgrees(shownTop: number, replayedTop: number | null): boolean {
  return replayedTop === null || shownTop === replayedTop;
}
