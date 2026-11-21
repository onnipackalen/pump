import { cashOutCents } from '@pump/engine';
import type { BalloonView } from '../api/contract';

/**
 * What the next pump adds to a balloon's cash-out if it holds, in cents:
 * the next rung's cash-out minus the cash-out now. The Patch + Pump button
 * shows it beside the Patch price, so the player can weigh the two.
 *
 * Both numbers come from the server's view of the balloon: the cash-out
 * now, and the next rung's multiplier. The next cash-out is rounded down
 * to the cent by the engine's own rule (cashOutCents), so this is exactly
 * what the player would be paid, in whole numbers, with no fractions.
 *
 * Null when there is nothing to compare: before the first pump (no
 * cash-out yet, and no Patch for sale) or once the balloon is over.
 */
export function nextPumpGainCents(balloon: BalloonView): number | null {
  if (balloon.status !== 'active' || balloon.cashOutCents === null || balloon.next === null) {
    return null;
  }
  // cashOutCents reads rung 1 of the ladder it is given; here that ladder
  // is just the next rung's multiplier, as the server sent it.
  const nextCents = cashOutCents(balloon.betCents, [balloon.next.multiplierHundredths], 1);
  return nextCents - balloon.cashOutCents;
}
