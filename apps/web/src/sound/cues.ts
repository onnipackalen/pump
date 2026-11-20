/**
 * Which sounds each game event plays. Plain functions, so the rules can be
 * tested without a speaker.
 *
 * The rules:
 * - Tension rises: the pump sound and the "survived" sound climb in pitch
 *   as the balloon nears its top.
 * - Wins are sharp: a bright chime, but only when the whole round paid back
 *   more than it cost (all bets plus all Patches). A round with 2 or 3
 *   balloons is one game, so a balloon cashed out mid-round gets a neutral
 *   tick, and the chime waits for the round to end in profit (UK RTS 14F).
 *   A big win (tier 3) gets the longer chime.
 * - Losses are quiet: a pop is short and soft, and a round that returns no
 *   more than it cost gets a neutral tick, never a win sound.
 */

import type { BalloonView, RoundView } from '../api/contract';
import type { GameEvent } from '../game/useGame';
import { roundWinTier } from '../game/winTier';

export type Cue =
  | 'start'
  | 'press'
  | 'survive'
  | 'saved'
  | 'pop'
  | 'return'
  | 'win'
  | 'big-win';

export interface CueToPlay {
  readonly cue: Cue;
  /** 0 at the bottom of the ladder, 1 at this balloon's top. Sets pitch. */
  readonly height: number;
  /** Seconds to wait before playing, so two cues don't land on each other. */
  readonly delay: number;
}

/** Gap between a pop and the chime of the round it ended in profit. */
const AFTER_POP_SECONDS = 0.25;

/** How far up its own ladder a balloon is, from 0 to 1. */
export function heightOf(balloon: BalloonView, rung: number = balloon.rung): number {
  if (balloon.topRung <= 0) return 0;
  return Math.min(1, Math.max(0, rung / balloon.topRung));
}

/** The win chime for a round that just ended, or null if it is no real gain. */
function roundEndChime(round: RoundView, delay: number): CueToPlay | null {
  const tier = roundWinTier(round);
  if (tier === null) return null;
  return { cue: tier === 3 ? 'big-win' : 'win', height: 1, delay };
}

/** A balloon was collected: a neutral tick, or the round's win chime if this ended it in profit. */
function collected(balloon: BalloonView, round: RoundView): CueToPlay[] {
  const chime = roundEndChime(round, 0);
  return [chime ?? { cue: 'return', height: heightOf(balloon), delay: 0 }];
}

export function cuesFor(event: GameEvent): CueToPlay[] {
  switch (event.kind) {
    case 'round-start':
      return [{ cue: 'start', height: 0, delay: 0 }];
    case 'press':
      // The pump that is going out takes the balloon toward rung + 1.
      return [{ cue: 'press', height: heightOf(event.balloon, event.balloon.rung + 1), delay: 0 }];
    case 'cash-out':
      return collected(event.balloon, event.round);
    case 'pump':
      switch (event.outcome) {
        case 'survived':
          return [{ cue: 'survive', height: heightOf(event.balloon), delay: 0 }];
        case 'saved':
          return [{ cue: 'saved', height: heightOf(event.balloon), delay: 0 }];
        case 'top':
          return collected(event.balloon, event.round);
        case 'popped': {
          // The pop can still end a round that is in profit overall.
          const chime = roundEndChime(event.round, AFTER_POP_SECONDS);
          return chime
            ? [{ cue: 'pop', height: 0, delay: 0 }, chime]
            : [{ cue: 'pop', height: 0, delay: 0 }];
        }
      }
  }
}
