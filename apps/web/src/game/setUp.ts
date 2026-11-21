import { useEffect, useState } from 'react';
import type { BalloonView, RoundView } from '../api/contract';

/**
 * The start of a balloon: its set-up at the bet and its first pump.
 *
 * When a round is over its balloons stay on screen as they ended: the hose
 * lies on the floor (after a pop or a cash-out alike), or a refunded
 * balloon still lies flat on it. At the next bet a small flat balloon goes
 * onto the hose's end, on the floor, and waits there for its first pump
 * (the set-up). The first pump's answer lifts it and blows it up, or bursts
 * it on the floor (the first pump). The user chose this on 2026-11-20.
 *
 * Display only. The round is live as soon as the server says so; nothing
 * waits for any of this (balloon.css, "First pump" and "Set-up").
 */

/**
 * What was in a slot before a round's set-up: how its balloon ended
 * ("popped", "cashed"), "void" for a bet refunded unpumped (its flat
 * balloon still lies there), or "idle" for nothing (the picture before any
 * bet, or a slot that had no balloon).
 */
export type SetUpFrom = 'idle' | 'popped' | 'cashed' | 'void';

/**
 * The longest a set-up moves for, in milliseconds (balloon.css
 * --pb-setup-ms; a test checks they match). Auto-play can wait this long
 * after a bet before its first press, so the first air pocket runs along a
 * hose that has settled.
 */
export const SET_UP_MS = 320;

/**
 * How long the first pump's lift moves for, from its answer: the view
 * easing back out is the longest part (balloon.css --pb-zoom-ms; a test
 * checks the lift's motions all end by then). The lift is kept on screen
 * this long whatever comes next, so a quick next pump or cash-out never
 * cuts it short.
 */
export const FIRST_LIFT_MS = 900;

/**
 * For each slot of `next`: what was in the same slot of `previous`, when
 * `next` is a new round that replaces it on screen. With no earlier round,
 * "idle" for every slot if the picture before any bet was on screen
 * (`idleShown`). Empty when `next` is the same round, or when nothing was
 * on screen before it (a round restored after a page load).
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
    if (before === 'popped' || before === 'cashed') return before;
    if (before === 'refunded') return 'void';
    // An empty slot (the round before had fewer balloons): a new pump with
    // its hose on the floor, the same as before any bet.
    return 'idle';
  });
}

/**
 * The set-up a balloon's art gets: only while it waits for its first
 * answer (in play, not pumped yet). From that answer on the first pump's
 * own motion takes over (`firstPump`), and the set-up must not be there:
 * kept, it would start again whenever the first pump's state goes.
 */
export function balloonSetUp(
  balloon: BalloonView,
  from: SetUpFrom | undefined,
): SetUpFrom | undefined {
  return balloon.status === 'active' && balloon.rung === 0 ? from : undefined;
}

/**
 * setUpFrom for the round on screen, kept for as long as that round is on
 * screen. The round object changes on every answer; only a new round id
 * starts a new set-up. `idleShown`: the picture before any bet is on screen
 * now (no round, not loading). A round restored after a page load gets no
 * set-up: only the loading message was on screen before it. `onStage`:
 * the game is on screen (not the stats or verify page). Once it is not,
 * the round's set-up is over: coming back shows the waiting picture, and
 * the set-up does not play again.
 */
export function useSetUpFrom(
  round: RoundView | null,
  idleShown: boolean,
  onStage = true,
): readonly (SetUpFrom | undefined)[] {
  const [shown, setShown] = useState<{
    readonly round: RoundView | null;
    readonly idleShown: boolean;
    readonly from: readonly (SetUpFrom | undefined)[];
  }>({ round, idleShown, from: [] });
  if (!onStage && shown.from.length > 0) {
    setShown({ ...shown, from: [] });
    return [];
  }
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

/** The first pump's state for a balloon's art (Balloon's `first`). */
export type FirstPump = 'floor' | 'lift' | 'floor-popped' | 'floor-void';

/**
 * The first pump's state for a balloon:
 * - "floor": in play and not pumped yet, the small flat balloon on the floor;
 * - "lift": its first pump just held, seen live on this screen (`lifting`,
 *   from useFirstLift), for as long as the lift moves, whatever comes next;
 * - "floor-popped": its first pump popped it, on the floor;
 * - "floor-void": its bet was refunded unpumped (the 24-hour rule), so it
 *   stays flat on the floor;
 * - nothing otherwise. A balloon on its first rung that this screen did not
 *   see lift (a page load, coming back from the stats or verify page) just
 *   stands: the lift never plays again.
 */
export function firstPump(balloon: BalloonView, lifting: boolean): FirstPump | undefined {
  if (balloon.rung === 0) {
    if (balloon.status === 'active') return 'floor';
    if (balloon.status === 'popped') return 'floor-popped';
    if (balloon.status === 'refunded') return 'floor-void';
  }
  return lifting ? 'lift' : undefined;
}

/**
 * Whether a balloon's first-pump lift starts now: its first pump's answer
 * (it held, or reached the top in one pump) is on screen this moment.
 */
export function liftStarts(rung: number, beat: string): boolean {
  return rung === 1 && (beat === 'survived' || beat === 'top');
}

/**
 * True from the moment this screen shows a balloon's first pump holding
 * (liftStarts) until FIRST_LIFT_MS later, and never again for that
 * balloon. A balloon mounted on its first rung (restored) never lifts.
 */
export function useFirstLift(rung: number, beat: string): boolean {
  const [seen, setSeen] = useState(false);
  const [lifting, setLifting] = useState(false);
  if (!seen && liftStarts(rung, beat)) {
    // React's way to keep a value derived from what was rendered: set it
    // during the render that first shows it.
    setSeen(true);
    setLifting(true);
  }
  useEffect(() => {
    if (!lifting) return undefined;
    const done = setTimeout(() => setLifting(false), FIRST_LIFT_MS);
    return () => clearTimeout(done);
  }, [lifting]);
  return lifting;
}
