import type { RoundView } from '../api/contract';

/**
 * What the stage shows: the balloons of a round, or the set-up of the next
 * one (a pump for each balloon in the bet panel, in the difficulty picked
 * there, under the steps of that difficulty's ladder).
 *
 * - No round yet: the set-up.
 * - A round in play: that round, whatever the bet panel says. The panel is
 *   not on screen then, so nothing in it can change.
 * - A round that is over: its balloons stay as they ended, so the player
 *   sees how it went. But the bet panel beside it is setting up the next
 *   round, and the stage must match it: once the player picks another
 *   number of balloons or another difficulty, the set-up shows at once
 *   instead. Picking the round's own again brings the round back. Bet
 *   amounts alone change nothing here (each round keeps its own tops).
 *
 * Display only: nothing here touches the math or the round itself.
 *
 * Returns the round to show, or null for the set-up.
 */
export function stageRound<R extends Pick<RoundView, 'status' | 'difficultyId' | 'balloons'>>(
  round: R | null,
  pickedDifficultyId: string | undefined,
  pickedBalloons: number,
): R | null {
  if (round === null || round.status === 'active') return round;
  const sameSetUp =
    (pickedDifficultyId === undefined || pickedDifficultyId === round.difficultyId) &&
    pickedBalloons === round.balloons.length;
  return sameSetUp ? round : null;
}
