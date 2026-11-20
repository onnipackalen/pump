/**
 * Which sound each game event plays. Plain functions, so the rules can be
 * tested without a speaker.
 *
 * The rules:
 * - Tension rises: the pump sound and the "survived" sound climb in pitch
 *   as the balloon nears its top.
 * - Wins are sharp: a bright chime, only when the balloon paid back more
 *   than it cost (its bet plus any Patches).
 * - Losses are quiet: a pop is short and soft, and a cash-out that returns
 *   no more than it cost gets a neutral tick, never a win sound.
 */

import type { BalloonView } from '../api/contract';
import type { GameEvent } from '../game/useGame';

export type Cue =
  | 'start'
  | 'press'
  | 'survive'
  | 'saved'
  | 'pop'
  | 'return'
  | 'win'
  | 'top-win';

export interface CueToPlay {
  readonly cue: Cue;
  /** 0 at the bottom of the ladder, 1 at this balloon's top. Sets pitch. */
  readonly height: number;
}

/** How far up its own ladder a balloon is, from 0 to 1. */
export function heightOf(balloon: BalloonView, rung: number = balloon.rung): number {
  if (balloon.topRung <= 0) return 0;
  return Math.min(1, Math.max(0, rung / balloon.topRung));
}

/** True only when the balloon paid back more than its bet plus Patches. */
export function isRealWin(balloon: BalloonView): boolean {
  return balloon.payoutCents > balloon.betCents + balloon.patchesCents;
}

export function cueFor(event: GameEvent): CueToPlay | null {
  switch (event.kind) {
    case 'round-start':
      return { cue: 'start', height: 0 };
    case 'press':
      // The pump that is going out takes the balloon toward rung + 1.
      return { cue: 'press', height: heightOf(event.balloon, event.balloon.rung + 1) };
    case 'pump':
      switch (event.outcome) {
        case 'survived':
          return { cue: 'survive', height: heightOf(event.balloon) };
        case 'saved':
          return { cue: 'saved', height: heightOf(event.balloon) };
        case 'popped':
          return { cue: 'pop', height: 0 };
        case 'top':
          return { cue: isRealWin(event.balloon) ? 'top-win' : 'return', height: 1 };
      }
      break;
    case 'cash-out':
      return { cue: isRealWin(event.balloon) ? 'win' : 'return', height: heightOf(event.balloon) };
  }
  return null;
}
