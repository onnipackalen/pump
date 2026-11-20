import { LIMITS, type Difficulty, type GameConfig } from '../src/config';

/**
 * Fixed ladders for the tests that pin exact numbers.
 *
 * The live ladders in src/config.ts are tuned often. A test that says "this
 * Patch costs 939 cents" must not turn red because a ladder was tuned, and the
 * engine's math must not care which ladder it is handed. So every test that
 * pins a number uses the ladders below, which never change.
 *
 * The live ladders are covered separately: by the tests that loop over
 * DIFFICULTIES at 9400, 9700 and 9900, and by `npm run rtp`.
 */
export const FIXED_DIFFICULTIES: readonly Difficulty[] = [
  {
    id: 'easy',
    label: 'Easy',
    ladder: [
      101, 111, 123, 137, 153, 171, 192, 216, 244, 277, 316, 362, 416, 480, 555, 645, 752, 881,
      1040, 1230, 1460, 1740, 2080, 2500,
    ],
  },
  {
    id: 'medium',
    label: 'Medium',
    ladder: [
      106, 125, 148, 178, 218, 271, 342, 440, 575, 765, 1040, 1435, 2020, 2900, 4250, 6350, 9700,
      15000,
    ],
  },
  {
    id: 'hard',
    label: 'Hard',
    ladder: [120, 163, 228, 330, 490, 755, 1210, 2000, 3450, 6200, 11600, 22800, 47000, 100000],
  },
  {
    id: 'expert',
    label: 'Expert',
    ladder: [150, 255, 465, 920, 2000, 4750, 12500, 37500, 125000, 500000],
  },
];

/** One of the fixed ladders, by difficulty id. */
export function fixedLadder(id: string): readonly number[] {
  const found = FIXED_DIFFICULTIES.find((d) => d.id === id);
  if (!found) throw new Error(`no fixed ladder ${id}`);
  return found.ladder;
}

/** A whole configuration on the fixed ladders, at the given RTP. */
export function fixedConfig(rtpBp: number): GameConfig {
  return { rtpBp, limits: LIMITS, difficulties: FIXED_DIFFICULTIES };
}
