/**
 * Auto-play rules, as plain functions with no React and no I/O.
 *
 * Auto-play is not game math: it decides which button to press next, the
 * way a player would, and sends the same requests a player sends. The
 * server can't tell the two apart and needs no change for it.
 *
 * The strategy, for each round:
 * - start a round with this round's bets: the ones in the bet panel for the
 *   first round, then whatever the On win and On loss settings made of them
 *   (see nextBets);
 * - play every balloon at once: on each beat, every balloon still in play
 *   is pumped if it is below the target number of successful pumps, or
 *   cashed out if it has reached it. Balloons are independent and each has
 *   its own draws, so playing them together changes no outcome;
 * - a balloon the player cashed out by hand is cashed out on the next beat
 *   instead, and is then done (see nextSteps);
 * - a balloon whose top rung (after the payout cap) is below the target
 *   cashes out by itself when it reaches the top;
 * - no Patches are bought.
 *
 * Between rounds it checks the stop rules, with the next round's bets.
 * Money is integer cents throughout.
 */

import type { Limits } from '@pump/engine';
import type { RoundView } from '../api/contract';
import { formatCents, parseDollarsToCents } from '../money';
import { roundWinTier } from './winTier';

export const MAX_AUTO_ROUNDS = 1000;

/** The largest "Increase by" a player can set: 1000% makes a bet 11 times as big. */
export const MAX_BET_INCREASE_PERCENT = 1000;

/**
 * What happens to every bet after a round:
 * - "reset": back to the bet the player entered for that balloon;
 * - "increase": up by a whole percent of the bet it had (0 leaves it as it is).
 */
export type BetChange =
  | { readonly kind: 'reset' }
  | { readonly kind: 'increase'; readonly percent: number };

const RESET: BetChange = { kind: 'reset' };

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
  /** What happens to the bets after a round that won (see roundWon). */
  readonly onWin: BetChange;
  /** What happens to the bets after any other round. */
  readonly onLoss: BetChange;
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

const NONE: ReadonlySet<number> = new Set();

/**
 * The actions for the next beat of a round: one for every balloon still in
 * play, all sent together. A balloon below the target (or its own lower
 * top) is pumped; one that has reached the target is cashed out.
 *
 * `handCashOuts` are the balloons the player has cashed out by hand during
 * this round. Each of those still in play is cashed out now instead of
 * pumped, so its very next request is the cash-out. Only one that has been
 * pumped, as there is nothing to cash out before that (and the player's
 * Cash out can't be pressed then either). Once it has cashed out it is no
 * longer in play, so nothing is ever sent for it again.
 *
 * Empty when no balloon is in play, so the round is over.
 */
export function nextSteps(
  round: RoundView,
  targetPumps: number,
  handCashOuts: ReadonlySet<number> = NONE,
): readonly AutoStep[] {
  const steps: AutoStep[] = [];
  for (const balloon of round.balloons) {
    if (balloon.status !== 'active') continue;
    const cashOut =
      balloon.rung >= targetPumps || (balloon.rung >= 1 && handCashOuts.has(balloon.index));
    // An active balloon is always below its top: the top cashes out by itself.
    steps.push(
      cashOut
        ? { kind: 'cash-out', balloonIndex: balloon.index }
        : { kind: 'pump', balloonIndex: balloon.index },
    );
  }
  return steps;
}

/**
 * The most actions one round can take: per balloon, one pump per rung up to
 * the target and one cash-out. Auto-play buys no Patches, so every pump
 * either moves up a rung or ends the balloon, and a hand cash-out only
 * comes sooner. A round that takes more actions than this means something
 * is wrong, and auto-play stops.
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
 * Whether a finished round counts as a win for On win: a real win, the same
 * one the screen celebrates (winTier). The round paid out more than it
 * cost; a refunded bet is void and counts for neither. A round that only
 * paid its bets back is not a win, so On loss applies to it.
 */
export function roundWon(round: RoundView): boolean {
  return roundWinTier(round) !== null;
}

/** The two bet limits that bet changes keep to. */
export type BetLimits = Pick<Limits, 'minBetCents' | 'maxBetCents'>;

/** Where a changed bet had to stop: at the bet limit below or above, or nowhere. */
export type BetHeld = 'min' | 'max' | null;

/** The bets for a round, one per balloon, in integer cents. */
export interface RoundBets {
  readonly betsCents: readonly number[];
  /** Per balloon: the limit its bet was held at by the last change, or null. */
  readonly held: readonly BetHeld[];
}

/** A round's bets as the player entered them: nothing held. */
export function enteredBets(betsCents: readonly number[]): RoundBets {
  return { betsCents, held: betsCents.map(() => null) };
}

/** The total of a round's bets. */
export function totalBetCents(bets: RoundBets): number {
  return bets.betsCents.reduce((sum, bet) => sum + bet, 0);
}

/**
 * One balloon's next bet after a change, kept inside the bet limits.
 *
 * "Increase by N%" multiplies in whole cents and rounds down to the cent,
 * like every amount that favours the house:
 *     next = floor(current * (100 + N) / 100)
 * The product is at most 100,000 * 1,100, far inside exact whole numbers,
 * and the division is done on whole numbers too (no floating point).
 * A $0.10 bet up 5% is $0.105, so it stays $0.10.
 *
 * A bet that would land outside the limits is held at the limit, and says
 * so, so the screen can tell the player.
 */
export function changeBet(
  currentCents: number,
  enteredCents: number,
  change: BetChange,
  limits: BetLimits,
): { readonly cents: number; readonly held: BetHeld } {
  let wanted = enteredCents;
  if (change.kind === 'increase') {
    const scaled = currentCents * (100 + change.percent);
    wanted = (scaled - (scaled % 100)) / 100;
  }
  if (wanted > limits.maxBetCents) return { cents: limits.maxBetCents, held: 'max' };
  if (wanted < limits.minBetCents) return { cents: limits.minBetCents, held: 'min' };
  return { cents: wanted, held: null };
}

/**
 * The bets for the next round, from this round's bets and its result.
 *
 * The round is judged as a whole (roundWon), the same way the screen judges
 * it, and the one change (On win or On loss) applies to every balloon's own
 * bet. "Reset" goes back to the bets the player entered (`entered`).
 */
export function nextBets(
  previous: readonly number[],
  entered: readonly number[],
  finished: RoundView,
  settings: Pick<AutoPlaySettings, 'onWin' | 'onLoss'>,
  limits: BetLimits,
): RoundBets {
  const change = roundWon(finished) ? settings.onWin : settings.onLoss;
  const changed = previous.map((bet, i) => changeBet(bet, entered[i] ?? bet, change, limits));
  return { betsCents: changed.map((c) => c.cents), held: changed.map((c) => c.held) };
}

/**
 * What the screen says when a bet change was held at a bet limit, or null
 * when every bet changed in full. "Bet held at the $1,000.00 maximum." With
 * two or three balloons it names them: "Bets 1 and 3 held at ...".
 */
export function describeHeld(bets: RoundBets, limits: BetLimits): string | null {
  const many = bets.held.length > 1;
  const lines: string[] = [];
  for (const [limit, word, cents] of [
    ['max', 'maximum', limits.maxBetCents],
    ['min', 'minimum', limits.minBetCents],
  ] as const) {
    const which = bets.held.flatMap((held, i) => (held === limit ? [String(i + 1)] : []));
    const last = which.pop();
    if (last === undefined) continue;
    const names = !many
      ? 'Bet'
      : which.length === 0
        ? `Bet ${last}`
        : `Bets ${which.join(', ')} and ${last}`;
    lines.push(`${names} held at the ${formatCents(cents)} ${word}.`);
  }
  return lines.length === 0 ? null : lines.join(' ');
}

/**
 * Whether the next round may start. Returns why not, or null to go on.
 * `roundBetCents` is the total of the bets that round would be played
 * with: after a bet change, the changed ones.
 *
 * The loss rule looks ahead: the most a round can lose is its bets, because
 * auto-play buys no Patches. So a round starts only if losing all of its
 * bets would still leave the loss within the limit. Auto-play can therefore
 * never end further down than the limit, however its bets grow.
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

/**
 * The balloons the player has cashed out by hand while auto-play runs, in
 * the round they were pressed in. Auto-play sends those cash-outs itself
 * (nextSteps), so each balloon gets exactly one request at a time and never
 * a cash-out from both the player and auto-play.
 */
export interface HandCashOuts {
  readonly roundId: string;
  readonly indexes: readonly number[];
}

/**
 * The hand cash-outs after the player presses Cash out on these balloons,
 * as the round on screen shows them. A balloon counts only while it is in
 * play and has a cash-out value (it has been pumped): the same rule as the
 * Cash out button. Returns the same object when the press changes nothing,
 * so a second press is a no-op.
 *
 * `playingRoundId` is the round auto-play is playing now. A press counts
 * only on that round: one made on an older round still on screen is too
 * late and is ignored, so it can never wipe the presses already made in
 * the round in play. The first press in a new round starts a new list.
 */
export function addHandCashOuts(
  asked: HandCashOuts | null,
  round: RoundView,
  indexes: readonly number[],
  playingRoundId: string | null,
): HandCashOuts | null {
  if (round.id !== playingRoundId) return asked;
  const before = asked?.roundId === round.id ? asked.indexes : [];
  const added = indexes.filter((index) => {
    const balloon = round.balloons[index];
    return (
      round.status === 'active' &&
      balloon?.status === 'active' &&
      balloon.cashOutCents !== null &&
      !before.includes(index)
    );
  });
  if (added.length === 0) return asked;
  return { roundId: round.id, indexes: [...before, ...new Set(added)] };
}

/** The balloons of this round the player has cashed out by hand. */
export function handCashOutsFor(asked: HandCashOuts | null, roundId: string): ReadonlySet<number> {
  return asked?.roundId === roundId ? new Set(asked.indexes) : NONE;
}

/**
 * What auto-play says when it stops. `nextRoundCents` is the total of the
 * bets the next round would have had, which is what the loss and balance
 * rules were checked against.
 */
export function describeStop(
  reason: StopReason,
  progress: AutoPlayProgress,
  nextRoundCents: number,
): string {
  const played = `${progress.roundsPlayed} round${progress.roundsPlayed === 1 ? '' : 's'}`;
  const next = formatCents(nextRoundCents);
  switch (reason) {
    case 'rounds-done':
      return `Auto-play finished: ${played} played.`;
    case 'profit':
      return `Auto-play stopped after ${played}: profit target reached.`;
    case 'loss':
      return `Auto-play stopped after ${played}: a ${next} round could pass your loss limit.`;
    case 'balance':
      return `Auto-play stopped after ${played}: not enough balance for a ${next} round.`;
    case 'player':
      return `Auto-play stopped after ${played}. Any balloon still in play is yours to finish.`;
    case 'error':
      return `Auto-play stopped after ${played} because an action failed.`;
  }
}

/**
 * What the pump count reaches on a ladder: the multiplier after that many
 * successful pumps, in hundredths. Null for a count the ladder doesn't have.
 */
export function targetMultiplier(ladder: readonly number[], targetPumps: number): number | null {
  if (!Number.isSafeInteger(targetPumps) || targetPumps < 1) return null;
  return ladder[targetPumps - 1] ?? null;
}

/** Whether a bet change field is set to reset or to increase. */
export type BetChangeKind = BetChange['kind'];

/** What the player typed into the auto-play panel. */
export interface AutoPlayForm {
  readonly rounds: string;
  readonly targetPumps: string;
  readonly stopOnProfit: string;
  readonly stopOnLoss: string;
  readonly onWin: BetChangeKind;
  readonly onWinPercent: string;
  readonly onLoss: BetChangeKind;
  readonly onLossPercent: string;
}

/** The typed fields, each of which can be wrong. */
export type AutoPlayField =
  | 'rounds'
  | 'targetPumps'
  | 'stopOnProfit'
  | 'stopOnLoss'
  | 'onWinPercent'
  | 'onLossPercent';

export interface AutoPlayFormCheck {
  /** The settings, or null while any field is wrong. */
  readonly settings: AutoPlaySettings | null;
  readonly errors: { readonly [K in AutoPlayField]: string | null };
}

function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Reads one bet change: a reset, or a whole percent from 0 to the maximum. */
function parseChange(
  kind: BetChangeKind,
  percentText: string,
): { readonly change: BetChange | null; readonly error: string | null } {
  if (kind === 'reset') return { change: RESET, error: null };
  const percent = parseWhole(percentText);
  if (percent === null || percent > MAX_BET_INCREASE_PERCENT) {
    return { change: null, error: `A whole percent from 0 to ${MAX_BET_INCREASE_PERCENT}` };
  }
  return { change: { kind: 'increase', percent }, error: null };
}

/**
 * Checks the auto-play form. `maxPumps` is the ladder length of the chosen
 * difficulty; `roundBetCents` is the total of the bets in the bet panel.
 * `betSizing` is whether this market lets auto-play change the bets
 * (market.ts): when it doesn't, On win and On loss are always "reset",
 * whatever the form holds, so the bets never change.
 */
export function checkAutoPlayForm(
  form: AutoPlayForm,
  maxPumps: number,
  roundBetCents: number,
  betSizing: boolean,
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

  const onWin = betSizing ? parseChange(form.onWin, form.onWinPercent) : { change: RESET, error: null };
  const onLoss = betSizing
    ? parseChange(form.onLoss, form.onLossPercent)
    : { change: RESET, error: null };

  const errors = {
    rounds: roundsError,
    targetPumps: targetError,
    stopOnProfit: profitError,
    stopOnLoss: lossError,
    onWinPercent: onWin.error,
    onLossPercent: onLoss.error,
  };
  const ok = Object.values(errors).every((e) => e === null);
  return {
    settings:
      ok && rounds !== null && target !== null && onWin.change !== null && onLoss.change !== null
        ? {
            rounds,
            targetPumps: target,
            stopOnProfitCents: profit,
            stopOnLossCents: loss,
            onWin: onWin.change,
            onLoss: onLoss.change,
          }
        : null,
    errors,
  };
}
