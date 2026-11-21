import type { BalloonView, RoundView } from '../api/contract';

/**
 * Cash-outs asked for while the balloon was busy: its pump (or a Patch save's
 * motion) was still on its way. Plain functions, no React, so they can be
 * tested on their own; useGame keeps the list.
 *
 * Why a queue: holding Space pumps again after every answer. A C press or a
 * Cash out click that landed while a pump was in flight used to be dropped,
 * and the hold then pumped once more. Now the press stops the hold and waits
 * here, and the cash-out is sent once the balloon is free again, if it is
 * still in play. "Free" includes its survive motion: a pump that survives
 * with a cash-out waiting keeps its balloon busy for the survive beat, so
 * the spring and the new number play before it cashes out (useGame's
 * busyForMs).
 *
 * Only a balloon that already had a cash-out value when the press came is
 * queued (canQueueCashOut). The panel's Cash out shows no amount while the
 * pump is on its way, because the amount is about to change.
 *
 * A queued cash-out is never sent for a balloon that popped, reached its
 * top, was cashed out already, or is in another round: each of those drops
 * it. The server checks the draw index as well, so even a cash-out sent on
 * an old view could never pay for a balloon that has since popped.
 */
export interface QueuedCashOut {
  readonly roundId: string;
  readonly index: number;
}

/**
 * Whether a cash-out pressed while this balloon is busy may wait for it.
 * `seen` is the balloon as the player sees it then: as it was pressed, while
 * its pump is on its way. Only a balloon in play that already has a
 * cash-out value: the same rule as the Cash out button and Cash out all.
 *
 * So C during a balloon's very first pump does nothing but end a hold. The
 * button shows no amount then, and a key must not cash out what the button
 * says can't be.
 */
export function canQueueCashOut(
  round: RoundView,
  seen: BalloonView | null | undefined,
): boolean {
  return round.status === 'active' && seen?.status === 'active' && seen.cashOutCents !== null;
}

/** The list with this cash-out added (once: a second press changes nothing). */
export function queueCashOut(
  queue: readonly QueuedCashOut[],
  roundId: string,
  index: number,
): readonly QueuedCashOut[] {
  if (queue.some((q) => q.roundId === roundId && q.index === index)) return queue;
  return [...queue, { roundId, index }];
}

/** True when a cash-out is waiting for this balloon: no new pump may go out before it. */
export function cashOutWaiting(
  queue: readonly QueuedCashOut[],
  roundId: string,
  index: number,
): boolean {
  return queue.some((q) => q.roundId === roundId && q.index === index);
}

/** The list without any cash-out waiting for this balloon (its request failed). */
export function dropQueued(queue: readonly QueuedCashOut[], index: number): readonly QueuedCashOut[] {
  return queue.some((q) => q.index === index) ? queue.filter((q) => q.index !== index) : queue;
}

/**
 * What to do with the waiting cash-outs, given the newest round the screen
 * has and which balloons are still busy:
 * - a balloon still busy keeps waiting;
 * - a free balloon leaves the queue, and its cash-out is sent only if the
 *   round is the same one, still in play, and the balloon is in play with a
 *   cash-out value (pumped at least once).
 */
export function cashOutsToSend(
  queue: readonly QueuedCashOut[],
  round: RoundView | null,
  busy: (index: number) => boolean,
): { readonly send: readonly number[]; readonly keep: readonly QueuedCashOut[] } {
  const send: number[] = [];
  const keep: QueuedCashOut[] = [];
  for (const queued of queue) {
    if (busy(queued.index)) {
      keep.push(queued);
      continue;
    }
    const balloon = round?.id === queued.roundId ? round.balloons[queued.index] : undefined;
    if (round?.status === 'active' && balloon?.status === 'active' && balloon.rung >= 1) {
      send.push(queued.index);
    }
  }
  return { send, keep };
}
