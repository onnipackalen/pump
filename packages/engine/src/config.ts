/**
 * Game configuration. This file is data only: every number a reviewer might
 * want to change lives here, and the rules that use it live in PumpEngine.ts.
 */

/**
 * RTP ("return to player") in basis points. 9700 means 97.00%: on average,
 * 97 cents of every dollar staked is paid back.
 *
 * This is the one place RTP is set. Nothing else in the project may assume a
 * value for it.
 */
export const RTP_BP = 9700;

/** Limits on a single balloon and a single round. Money is integer cents. */
export interface Limits {
  /** Smallest bet on one balloon ($0.10). */
  readonly minBetCents: number;
  /** Largest bet on one balloon ($1,000). */
  readonly maxBetCents: number;
  /** Largest payout on one balloon ($100,000). */
  readonly maxPayoutCents: number;
  /** A round has between 1 and this many balloons. */
  readonly maxBalloons: number;
}

/**
 * One difficulty is one ladder of multipliers.
 *
 * The ladder is stored as integer hundredths, so 101 means 1.01x and 500000
 * means 5,000x. ladder[0] is the multiplier after the first pump.
 */
export interface Difficulty {
  readonly id: string;
  readonly label: string;
  readonly ladder: readonly number[];
}

/** Everything the engine needs to know. Passed in, never read from a global. */
export interface GameConfig {
  readonly rtpBp: number;
  readonly limits: Limits;
  readonly difficulties: readonly Difficulty[];
}

export const LIMITS: Limits = {
  minBetCents: 10,
  maxBetCents: 100_000,
  maxPayoutCents: 10_000_000,
  maxBalloons: 3,
};

/**
 * The four ladders. Adding a fifth difficulty means adding one entry here;
 * the engine needs no change.
 *
 * How they were chosen:
 * - Easy is long with small steps: 24 pumps to reach 25x.
 * - Expert is short and steep: 10 pumps to reach 5,000x.
 * - On every ladder each step is a little riskier than the one before, so the
 *   chance of a pop rises with every pump. That holds for any RTP from 92% up.
 */
export const DIFFICULTIES: readonly Difficulty[] = [
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

/** The configuration the real game runs with. */
export const GAME_CONFIG: GameConfig = {
  rtpBp: RTP_BP,
  limits: LIMITS,
  difficulties: DIFFICULTIES,
};
