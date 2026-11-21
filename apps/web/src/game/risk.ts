import type { Fraction } from '../api/contract';

/**
 * Which of the four risk steps a pop chance is in: under 25%, under 40%,
 * under 60%, and above. The same steps on every difficulty. It reads only
 * the chance the player is shown (an exact fraction, compared in whole
 * numbers), never a draw. The panel colours the pop chance by this step,
 * and the balloon strains by it (step 1 is no strain, step 4 the most).
 */
export function riskStep({ num, den }: Fraction): 1 | 2 | 3 | 4 {
  if (num * 100 < den * 25) return 1;
  if (num * 100 < den * 40) return 2;
  if (num * 100 < den * 60) return 3;
  return 4;
}

/**
 * How long a pump's "press" lasts at each risk step, in milliseconds. The
 * air pocket takes exactly this long to run up the hose, and balloon.css
 * has the same four numbers (--pb-press-ms for data-strain 0 to 3); a test
 * checks that the two lists match.
 */
export const PRESS_MS = [300, 360, 420, 480] as const;

/**
 * The shortest time a pump is shown as "press" before its answer may be
 * shown: longer the riskier the pump. It reads only the pop chance the
 * player is shown for that pump, never a draw, so it is the same whatever
 * the pump's result will be. With no published chance it is the shortest.
 */
export function pressMs(popChance: Fraction | null | undefined): number {
  if (!popChance) return PRESS_MS[0];
  return PRESS_MS[riskStep(popChance) - 1] ?? PRESS_MS[0];
}
