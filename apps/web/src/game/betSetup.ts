import type { Difficulty, Limits } from '@pump/engine';
import type { RoundView } from '../api/contract';
import { centsToInput, formatCents, parseDollarsToCents } from '../money';

/** What the player has typed into the bet panel. One bet text per balloon. */
export interface BetSetup {
  readonly difficultyId: string;
  readonly bets: readonly string[];
}

export interface BetCheck {
  /** The bets in cents, or null while any of them is not valid. */
  readonly betsCents: readonly number[] | null;
  /** Per balloon: what is wrong with its bet, or null. */
  readonly errors: readonly (string | null)[];
  /** Sum of the valid bets. */
  readonly totalCents: number;
  /** A problem with the round as a whole, such as not enough balance. */
  readonly problem: string | null;
}

/** Checks the typed bets against the limits and the balance. */
export function checkBets(setup: BetSetup, limits: Limits, balanceCents: number): BetCheck {
  const parsed = setup.bets.map((text) => parseDollarsToCents(text));
  const errors = parsed.map((cents) => {
    if (cents === null) return 'Enter an amount like 1.50';
    if (cents < limits.minBetCents) return `At least ${formatCents(limits.minBetCents)}`;
    if (cents > limits.maxBetCents) return `At most ${formatCents(limits.maxBetCents)}`;
    return null;
  });
  const totalCents = parsed.reduce<number>((sum, cents) => sum + (cents ?? 0), 0);
  const allValid = errors.every((error) => error === null);
  const problem =
    allValid && totalCents > balanceCents ? 'Not enough balance for these bets.' : null;
  const betsCents = allValid && problem === null ? parsed.map((cents) => cents ?? 0) : null;
  return { betsCents, errors, totalCents, problem };
}

/**
 * The bet panel's set-up for a round in play that the panel did not set up:
 * one restored after a page load, which always starts from the default
 * set-up. It takes the round's difficulty and bets. Without this, once the
 * round is over the stage would take the panel's other set-up for a new one
 * and hide how the round ended (stage.ts), and the next bet would not start
 * from the round just played.
 *
 * Null when the panel already has the round's difficulty and number of
 * balloons, which is always so for a round started from it (auto-play's
 * raised bets included, so they never overwrite the bets the player
 * entered), or when the round's difficulty is no longer in the config.
 */
export function setupForRound(
  round: Pick<RoundView, 'difficultyId' | 'balloons'>,
  setup: BetSetup,
  difficulties: readonly Difficulty[],
): BetSetup | null {
  if (setup.difficultyId === round.difficultyId && setup.bets.length === round.balloons.length) {
    return null;
  }
  if (!difficulties.some((difficulty) => difficulty.id === round.difficultyId)) return null;
  return {
    difficultyId: round.difficultyId,
    bets: round.balloons.map((balloon) => centsToInput(balloon.betCents)),
  };
}

/** Changes the number of balloons, copying the last bet into new ones. */
export function withBalloonCount(setup: BetSetup, count: number): BetSetup {
  const bets = setup.bets.slice(0, count);
  const last = bets[bets.length - 1] ?? '1.00';
  while (bets.length < count) bets.push(last);
  return { ...setup, bets };
}
