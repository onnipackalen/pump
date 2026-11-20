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
 * These numbers are meant to be tuned. Change them here and nowhere else,
 * then run `npm run rtp`: it checks the new ladders exactly and prints every
 * rung, chance and worst case. No test pins a number from these ladders.
 *
 * How they were chosen:
 * - Easy is long with small steps. Expert is short and steep.
 * - Every ladder has rungs on round numbers a player can aim for, such as 2x,
 *   5x, 10x and 100x.
 * - Medium, Hard and Expert each have a rung at exactly 100x, so the largest
 *   bet can win exactly the payout cap.
 * - On every ladder each step is a little riskier than the one before, so the
 *   chance of a pop rises with every pump. The game refuses to start if that
 *   does not hold at the configured RTP.
 */
export const DIFFICULTIES: readonly Difficulty[] = [
  {
    id: 'easy',
    label: 'Easy',
    ladder: [
      101, 109, 118, 128, 139, 151, 165, 181, 200, 222, 247, 275, 307, 345, 389, 440, 500, 571,
      655, 753, 867, 1000, 1155, 1340, 1560, 1820, 2130, 2500, 2950, 3500, 4175, 5000,
    ],
  },
  {
    id: 'medium',
    label: 'Medium',
    ladder: [
      104, 117, 132, 150, 172, 200, 235, 279, 335, 407, 500, 621, 781, 1000, 1310, 1770, 2500,
      3725, 5900, 10000,
    ],
  },
  {
    id: 'hard',
    label: 'Hard',
    ladder: [
      120, 154, 200, 264, 357, 500, 730, 1115, 1785, 3005, 5330, 10000, 20000, 43000, 100000,
    ],
  },
  {
    id: 'expert',
    label: 'Expert',
    ladder: [160, 277, 500, 946, 1900, 4130, 10000, 28200, 100000, 500000],
  },
];

/** The configuration the real game runs with. */
export const GAME_CONFIG: GameConfig = {
  rtpBp: RTP_BP,
  limits: LIMITS,
  difficulties: DIFFICULTIES,
};
