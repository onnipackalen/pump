import { useState } from 'react';
import type { BalloonView, RoundView } from '../api/contract';

/**
 * The set-up of a new round's pumps.
 *
 * When a round is over its balloons stay on screen as they ended: after a
 * pop the hose lies on the floor with a torn scrap on its end, after a
 * cash-out it is curled back to the pump. The next bet used to swap that
 * for a fresh pump in one frame. Instead, each new pump now sets up from
 * the picture that was in its place: the hose lifts off the floor or
 * stretches back out to the neck, then the new balloon fills in.
 *
 * Display only. The round is live as soon as the server says so; nothing
 * waits for the set-up, and a pump during it is fine (balloon.css).
 */

/** How the balloon that was in a slot before ended. */
export type SetUpFrom = 'popped' | 'cashed';

/**
 * For each slot of `next`: how the balloon in the same slot of `previous`
 * ended, when `next` is a new round that replaces it on screen. Empty when
 * there is no earlier round on screen or `next` is the same round.
 */
export function setUpFrom(
  previous: RoundView | null,
  next: RoundView | null,
): readonly (SetUpFrom | undefined)[] {
  if (!previous || !next || previous.id === next.id) return [];
  return next.balloons.map((balloon) => {
    const before = previous.balloons[balloon.index]?.status;
    return before === 'popped' || before === 'cashed' ? before : undefined;
  });
}

/**
 * The set-up a balloon's art gets: only while the balloon is in play.
 *
 * It stays on after the first pump. Auto-play pumps straight after the
 * bet, and the first answer can come before the set-up is over; taking
 * the attribute away then would cut it short and the picture would jump.
 * Keeping it changes nothing once it has played: nothing else moves the
 * hose or the balloon's float while the balloon is in play.
 *
 * It goes in the same frame as the pop or cash-out, so the set-up can
 * never play again at the end of the round (when that motion is over and
 * the hose would otherwise pick the set-up rule back up).
 */
export function balloonSetUp(
  balloon: BalloonView,
  from: SetUpFrom | undefined,
): SetUpFrom | undefined {
  return balloon.status === 'active' ? from : undefined;
}

/**
 * setUpFrom for the round on screen, kept for as long as that round is on
 * screen. The round object changes on every answer; only a new round id
 * starts a new set-up. A round restored after a page refresh gets none:
 * nothing was on screen before it.
 */
export function useSetUpFrom(round: RoundView | null): readonly (SetUpFrom | undefined)[] {
  const [shown, setShown] = useState<{
    readonly round: RoundView | null;
    readonly from: readonly (SetUpFrom | undefined)[];
  }>({ round, from: [] });
  if (round === shown.round) return shown.from;
  // The round changed since the last render. React's way to keep a value
  // derived from the previous render: set it during this one.
  const from = round !== null && round.id === shown.round?.id ? shown.from : setUpFrom(shown.round, round);
  setShown({ round, from });
  return from;
}
