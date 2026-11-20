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
