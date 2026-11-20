import type { RoundView } from '../api/contract';

/**
 * How far a round has gone. Every change the server makes to a round either
 * uses a draw or ends a balloon, so this number only ever goes up.
 */
export function roundProgress(round: RoundView): number {
  return round.balloons.reduce(
    (total, b) => total + b.drawIndex + (b.status === 'active' ? 0 : 1),
    0,
  );
}

/**
 * True when `incoming` is an older snapshot of the round on screen. Answers
 * can arrive out of order (a pump's answer is held for its press beat while a
 * cash-out on another balloon comes straight back), and an older answer must
 * never replace a newer one.
 */
export function isOlder(incoming: RoundView, shown: RoundView | null): boolean {
  return (
    shown !== null && shown.id === incoming.id && roundProgress(incoming) < roundProgress(shown)
  );
}
