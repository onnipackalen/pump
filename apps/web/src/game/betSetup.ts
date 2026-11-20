import type { Limits } from '@pump/engine';
import { formatCents, parseDollarsToCents } from '../money';

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

/** Changes the number of balloons, copying the last bet into new ones. */
export function withBalloonCount(setup: BetSetup, count: number): BetSetup {
  const bets = setup.bets.slice(0, count);
  const last = bets[bets.length - 1] ?? '1.00';
  while (bets.length < count) bets.push(last);
  return { ...setup, bets };
}
