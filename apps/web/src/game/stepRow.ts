import type { BalloonStatus } from '../api/contract';
import { formatMultiplier } from '../money';
import { multiplierAt } from './rules';

/**
 * The row of multiplier steps shown with a balloon: its ladder, with the
 * steps it has passed, the one it is on, the one the next pump goes for and
 * the ones its bet cannot reach.
 *
 * Display only. It reads nothing but the balloon's own state (pumps
 * survived, top rung, status) and the ladder its round was played with, so
 * it can never show the outcome of a pump that was not made.
 */

export type StepState =
  /** Below where the balloon is now. */
  | 'passed'
  /** The step the balloon is on: its multiplier now. */
  | 'current'
  /** The step the next pump goes for. */
  | 'next'
  /** Further up, still within reach of this bet. */
  | 'ahead'
  /** Above the top this bet can reach (the payout cap). */
  | 'locked'
  /** The step the balloon was going for when it popped. */
  | 'popped';

export interface Step {
  /** 1 for the first pump's step, up to the ladder's length. */
  readonly rung: number;
  /** The step's multiplier as the screen writes it, like "1.28×". */
  readonly text: string;
  readonly state: StepState;
}

export interface StepRowInput {
  /** The ladder in integer hundredths, the round's own copy. */
  readonly ladder: readonly number[];
  /** Pumps survived so far. 0 before the first pump. */
  readonly rung: number;
  /** The highest rung this bet can reach. */
  readonly topRung: number;
  /** "preview" is a balloon before its round has started. */
  readonly status: BalloonStatus | 'preview';
}

/** Whether another pump can still be made on a balloon in this state. */
function inPlay(status: StepRowInput['status']): boolean {
  return status === 'active' || status === 'preview';
}

function stateOf(step: number, { rung, topRung, status }: StepRowInput): StepState {
  if (step > topRung) return 'locked';
  if (step < rung) return 'passed';
  if (step === rung) {
    // A popped balloon is not "on" its last step any more: it lost it.
    return status === 'popped' ? 'passed' : 'current';
  }
  if (step === rung + 1) {
    if (status === 'popped') return 'popped';
    if (inPlay(status)) return 'next';
  }
  return 'ahead';
}

/** Every step of the ladder, in order, with its state for this balloon. */
export function stepRow(input: StepRowInput): readonly Step[] {
  return input.ladder.map((_, index) => {
    const rung = index + 1;
    return {
      rung,
      text: formatMultiplier(multiplierAt(input.ladder, rung)),
      state: stateOf(rung, input),
    };
  });
}

/**
 * The row in one short line, for a screen reader: the step the next pump
 * goes for and the top this bet can reach. Null for a balloon that cannot
 * be pumped any more: its two lines under the picture already say how it
 * ended.
 */
export function stepWords(input: StepRowInput): string | null {
  const { ladder, rung, topRung, status } = input;
  if (!inPlay(status) || rung >= topRung) return null;
  const next = formatMultiplier(multiplierAt(ladder, rung + 1));
  const top = formatMultiplier(multiplierAt(ladder, topRung));
  return `${status === 'preview' ? 'First step' : 'Next'} ${next}. Top at this bet ${top}.`;
}

/**
 * The step the row keeps in view: the one the balloon is on, or the one it
 * popped on. 0 before the first pump, when it is on no step yet.
 */
export function stepAnchor({ rung, status, ladder }: StepRowInput): number {
  const anchor = status === 'popped' ? rung + 1 : rung;
  return Math.min(Math.max(anchor, 0), ladder.length);
}
