/**
 * Auto-play rules, as plain functions with no React and no I/O.
 *
 * Auto-play is not game math: it decides which button to press next, the
 * way a player would, and sends the same requests a player sends. The
 * server can't tell the two apart and needs no change for it.
 *
 * The strategy, for each round:
 * - start a round with the bets in the bet panel;
 * - play every balloon at once: on each beat, every balloon still in play
 *   is pumped if it is below the target number of successful pumps, or
 *   cashed out if it has reached it. Balloons are independent and each has
 *   its own draws, so playing them together changes no outcome;
 * - a balloon whose top rung (after the payout cap) is below the target
 *   cashes out by itself when it reaches the top;
 * - no Patches are bought.
 *
 * Between rounds it checks the stop rules. Money is integer cents throughout.
 */

import type { RoundView } from '../api/contract';
import { formatCents, parseDollarsToCents } from '../money';

export const MAX_AUTO_ROUNDS = 1000;

export interface AutoPlaySettings {
  /** How many rounds to play, 1 to MAX_AUTO_ROUNDS. */
  readonly rounds: number;
  /** Successful pumps per balloon before cashing it out. */
  readonly targetPumps: number;
  /** Stop once the net result is at least this much up. Null: off. */
  readonly stopOnProfitCents: number | null;
  /**
   * Never start a round that could take the net result past this loss.
   * Null: off.
   */
  readonly stopOnLossCents: number | null;
}

export interface AutoPlayProgress {
  readonly roundsPlayed: number;
  /** Payouts minus bets and Patches, over the rounds auto-play played. */
  readonly netCents: number;
}

export type StopReason = 'rounds-done' | 'profit' | 'loss' | 'balance' | 'player' | 'error';

/** One action on one balloon. */
export type AutoStep =
  | { readonly kind: 'pump'; readonly balloonIndex: number }
  | { readonly kind: 'cash-out'; readonly balloonIndex: number };

/**
 * The actions for the next beat of a round: one for every balloon still in
 * play, all sent together. A balloon below the target (or its own lower
 * top) is pumped; one that has reached the target is cashed out. Empty when
 * no balloon is in play, so the round is over.
 */
export function nextSteps(round: RoundView, targetPumps: number): readonly AutoStep[] {
  const steps: AutoStep[] = [];
  for (const balloon of round.balloons) {
    if (balloon.status !== 'active') continue;
    // An active balloon is always below its top: the top cashes out by itself.
    steps.push(
      balloon.rung >= targetPumps
        ? { kind: 'cash-out', balloonIndex: balloon.index }
        : { kind: 'pump', balloonIndex: balloon.index },
    );
  }
  return steps;
}

/**
 * The most actions one round can take: per balloon, one pump per rung up to
 * the target and one cash-out. Auto-play buys no Patches, so every pump
 * either moves up a rung or ends the balloon. A round that takes more
 * actions than this means something is wrong, and auto-play stops.
 */
export function maxStepsPerRound(balloonCount: number, targetPumps: number): number {
  return balloonCount * (targetPumps + 1);
}

/**
 * What one finished round did to the player's money. The same sum as the
 * result shown over the stage and the win check (winTier): a refunded bet
 * is void, so it counts neither as spent nor as paid.
 */
export { roundNetCents } from './winTier';

/**
 * Whether the next round may start. Returns why not, or null to go on.
 *
 * The loss rule looks ahead: the most a round can lose is its bets, because
 * auto-play buys no Patches. So a round starts only if losing all of its
 * bets would still leave the loss within the limit. Auto-play can therefore
 * never end further down than the limit.
 */
export function checkBeforeRound(
  settings: AutoPlaySettings,
  progress: AutoPlayProgress,
  roundBetCents: number,
  balanceCents: number,
): StopReason | null {
  if (progress.roundsPlayed >= settings.rounds) return 'rounds-done';
  if (settings.stopOnProfitCents !== null && progress.netCents >= settings.stopOnProfitCents) {
    return 'profit';
  }
  if (
    settings.stopOnLossCents !== null &&
    -progress.netCents + roundBetCents > settings.stopOnLossCents
  ) {
    return 'loss';
  }
  if (roundBetCents > balanceCents) return 'balance';
  return null;
}

/** What auto-play says when it stops. */
export function describeStop(reason: StopReason, progress: AutoPlayProgress): string {
  const played = `${progress.roundsPlayed} round${progress.roundsPlayed === 1 ? '' : 's'}`;
  switch (reason) {
    case 'rounds-done':
      return `Auto-play finished: ${played} played.`;
    case 'profit':
      return `Auto-play stopped after ${played}: profit target reached.`;
    case 'loss':
      return `Auto-play stopped after ${played}: another round could pass your loss limit.`;
    case 'balance':
      return `Auto-play stopped after ${played}: not enough balance for another round.`;
    case 'player':
      return `Auto-play stopped after ${played}. Any balloon still in play is yours to finish.`;
    case 'error':
      return `Auto-play stopped after ${played} because an action failed.`;
  }
}

/** What the player typed into the auto-play panel. */
export interface AutoPlayForm {
  readonly rounds: string;
  readonly targetPumps: string;
  readonly stopOnProfit: string;
  readonly stopOnLoss: string;
}

export interface AutoPlayFormCheck {
  /** The settings, or null while any field is wrong. */
  readonly settings: AutoPlaySettings | null;
  readonly errors: { readonly [K in keyof AutoPlayForm]: string | null };
}

function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Checks the auto-play form. `maxPumps` is the ladder length of the chosen
 * difficulty; `roundBetCents` is the total of the bets in the bet panel.
 */
export function checkAutoPlayForm(
  form: AutoPlayForm,
  maxPumps: number,
  roundBetCents: number,
): AutoPlayFormCheck {
  const rounds = parseWhole(form.rounds);
  const roundsError =
    rounds === null || rounds < 1 || rounds > MAX_AUTO_ROUNDS
      ? `A whole number from 1 to ${MAX_AUTO_ROUNDS}`
      : null;

  const target = parseWhole(form.targetPumps);
  const targetError =
    target === null || target < 1 || target > maxPumps
      ? `A whole number from 1 to ${maxPumps}`
      : null;

  const profitText = form.stopOnProfit.trim();
  const profit = profitText === '' ? null : parseDollarsToCents(profitText);
  const profitError =
    profitText !== '' && (profit === null || profit < 1) ? 'An amount like 5.00, or blank' : null;

  const lossText = form.stopOnLoss.trim();
  const loss = lossText === '' ? null : parseDollarsToCents(lossText);
  let lossError: string | null = null;
  if (lossText !== '' && loss === null) lossError = 'An amount like 20.00, or blank';
  else if (loss !== null && loss < roundBetCents) {
    lossError = `At least one round's bets (${formatCents(roundBetCents)})`;
  }

  const errors = {
    rounds: roundsError,
    targetPumps: targetError,
    stopOnProfit: profitError,
    stopOnLoss: lossError,
  };
  const ok = Object.values(errors).every((e) => e === null);
  return {
    settings:
      ok && rounds !== null && target !== null
        ? { rounds, targetPumps: target, stopOnProfitCents: profit, stopOnLossCents: loss }
        : null,
    errors,
  };
}
