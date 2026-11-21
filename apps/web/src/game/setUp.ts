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

/**
 * What was in a slot before: how its balloon ended, or "idle", the
 * picture before any bet (the hose on the floor, no balloon).
 */
export type SetUpFrom = 'idle' | 'popped' | 'cashed';

/**
 * For each slot of `next`: how the balloon in the same slot of `previous`
 * ended, when `next` is a new round that replaces it on screen. With no
 * earlier round, "idle" for every slot if the picture before any bet was on
 * screen (`idleShown`). Empty when `next` is the same round, or when
 * nothing was on screen before it (a round restored after a page load).
 */
export function setUpFrom(
  previous: RoundView | null,
  next: RoundView | null,
  idleShown = false,
): readonly (SetUpFrom | undefined)[] {
  if (!next) return [];
  if (!previous) return idleShown ? next.balloons.map(() => 'idle') : [];
  if (previous.id === next.id) return [];
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
 * starts a new set-up. `idleShown`: the picture before any bet is on screen
 * now (no round, not loading). A round restored after a page load gets no
 * set-up: only the loading message was on screen before it.
 */
export function useSetUpFrom(
  round: RoundView | null,
  idleShown: boolean,
): readonly (SetUpFrom | undefined)[] {
  const [shown, setShown] = useState<{
    readonly round: RoundView | null;
    readonly idleShown: boolean;
    readonly from: readonly (SetUpFrom | undefined)[];
  }>({ round, idleShown, from: [] });
  if (round === shown.round && idleShown === shown.idleShown) return shown.from;
  // The round changed since the last render. React's way to keep a value
  // derived from the previous render: set it during this one.
  const from =
    round !== null && round.id === shown.round?.id
      ? shown.from
      : setUpFrom(shown.round, round, shown.idleShown);
  setShown({ round, idleShown, from });
  return from;
}

/**
 * The first pump's state for a balloon's art (Balloon's `first`): the
 * small flat balloon lies on the floor until its first pump; the first
 * pump that holds lifts it and blows it up; one that pops it pops it on
 * the floor. Read from the balloon alone, so a round restored after a page
 * load shows the same picture.
 */
export function balloonFirst(balloon: BalloonView): 'floor' | 'lift' | 'floor-popped' | undefined {
  if (balloon.rung === 0) {
    if (balloon.status === 'active') return 'floor';
    if (balloon.status === 'popped') return 'floor-popped';
    return undefined;
  }
  return balloon.status === 'active' && balloon.rung === 1 ? 'lift' : undefined;
}
