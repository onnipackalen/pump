import type { RoundView } from '../api/contract';

/**
 * How long the panel's Cash out and Patch + Pump, and the Space, P and C
 * keys, wait after the controls move to another balloon. A tap or key meant
 * for the balloon that just ended lands in this pause and does nothing,
 * instead of acting on the next balloon.
 */
export const SWITCH_PAUSE_MS = 500;

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
