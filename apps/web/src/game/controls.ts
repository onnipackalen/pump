import type { BalloonView, RoundView } from '../api/contract';
import type { Beat } from './useGame';

/**
 * How long the panel's Cash out and Patch + Pump, and the Space, P and C
 * keys, wait after the controls move to another balloon. A tap or key meant
 * for the balloon that just ended lands in this pause and does nothing,
 * instead of acting on the next balloon.
 */
export const SWITCH_PAUSE_MS = 500;

/**
 * Bet and the big Pump button share one spot on the screen, so a player
 * presses Bet and keeps pressing in the same place to pump. That makes a
 * fast double-tap dangerous both ways: the second tap of a double-tap on Bet
 * would land on Pump the moment the round appears, and a quick tap on Pump
 * as the balloon pops would land on the Bet button that takes its place.
 * Either is a gamble the player did not choose.
 *
 * So a button that appears in that spot (Pump, Bet, Start auto-play)
 * ignores any press that began before it appeared or less than this long
 * after. 350 ms is longer than the gap between the two taps of a
 * double-tap, and short enough that a player who means to press again
 * never notices. (To be lined up with the start animation's SET_UP_MS.)
 * Stop is never held back: stopping must always work at once.
 */
export const BET_GUARD_MS = 350;

/**
 * The guard for one button (see BET_GUARD_MS). Times are on the page's
 * clock (performance.now(), which event time stamps also use). `now` is
 * the time the event is handled: a press is never taken as later than
 * that, so a browser whose time stamps run on another clock is judged by
 * when the event arrives instead.
 */
export interface PressGuard {
  /** The button has appeared. */
  readonly shown: (at: number) => void;
  /**
   * A finger or mouse went down on the button. Returns whether this press
   * counts. It is remembered for the click it ends in.
   */
  readonly pointerDown: (at: number, now: number) => boolean;
  /**
   * A click on the button. From the keyboard (detail 0) it is its own
   * press, judged by its own time. From a finger or mouse it is judged by
   * when that finger or mouse went down on this button; with no such press
   * (a tap that began on the button that was here before), it never counts.
   */
  readonly click: (detail: number, at: number, now: number) => boolean;
}

/** Whether a press that began at `pressedAt` counts, for a button shown at `shownAt`. */
export function pressCounts(
  pressedAt: number | null,
  shownAt: number | null,
  now: number,
  guardMs: number,
): boolean {
  if (pressedAt === null || shownAt === null) return false;
  return Math.min(pressedAt, now) >= shownAt + guardMs;
}

export function pressGuard(guardMs: number): PressGuard {
  let shownAt: number | null = null;
  let downAt: number | null = null;
  return {
    shown: (at) => {
      shownAt = at;
      downAt = null;
    },
    pointerDown: (at, now) => {
      downAt = Math.min(at, now);
      return pressCounts(downAt, shownAt, now, guardMs);
    },
    click: (detail, at, now) => {
      const pressedAt = detail === 0 ? at : downAt;
      downAt = null;
      return pressCounts(pressedAt, shownAt, now, guardMs);
    },
  };
}

/**
 * Whether a balloon shows its own Pump button under it: only while it and
 * at least one other balloon are still in play. Then the panel's big button
 * is Pump all, and each balloon needs its own. With one balloon in play
 * (a round of one, or a round of two or three down to its last balloon) the
 * big button is plain Pump, so nothing on screen says it twice. (The
 * button's row stays either way, so the picture never jumps.)
 */
export function showOwnPump(round: RoundView, balloon: BalloonView): boolean {
  if (balloon.status !== 'active') return false;
  return round.balloons.filter((b) => b.status === 'active').length > 1;
}

/**
 * The balloon the panel and the keys act on: the one the player picked,
 * while it is in play. Once it has popped or cashed out, the next balloon
 * still in play after it (wrapping round to the first), so the controls
 * move on by themselves. Null when no balloon is in play.
 */
export function controlTarget(round: RoundView | null, chosen: number): number | null {
  if (!round || round.status !== 'active') return null;
  const count = round.balloons.length;
  for (let step = 0; step < count; step += 1) {
    const index = (chosen + step) % count;
    if (round.balloons[index]?.status === 'active') return index;
  }
  return null;
}

/**
 * What a balloon is doing, as the control panel needs to know it:
 * - "queued": a cash-out pressed while it was busy is waiting to go;
 * - "pumping": its pump is on its way, so its cash-out amount is about to
 *   change (or go, if it pops);
 * - "busy": another request, or a Patch save's motion, is on its way;
 * - "free": nothing is.
 * Only "free" takes a Patch + Pump; anything else would be ignored.
 */
export type PanelActivity = 'free' | 'busy' | 'pumping' | 'queued';

export function panelActivity(pending: boolean, beat: Beat, queued: boolean): PanelActivity {
  if (queued) return 'queued';
  if (beat === 'press') return 'pumping';
  return pending ? 'busy' : 'free';
}
