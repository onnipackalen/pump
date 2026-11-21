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
