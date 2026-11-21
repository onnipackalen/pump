/**
 * The words for a balloon's reveal: once a round is over, where a balloon
 * cashed out below its top rung would have popped if the player had kept
 * pumping (plain pumps, no Patch). The server or the demo works it out; the
 * screen only says it. Neutral words, no money, nothing that sounds like a
 * missed win.
 */

import type { AfterRoundView, BalloonView, RevealOutcome } from '../api/contract';
import { formatMultiplier } from '../money';

/**
 * The line for one reveal. `cashedRung` is the rung the balloon was cashed
 * out on.
 *
 *   popped on the cash-out rung   "Next pump would have popped"
 *   popped higher up              "Would have reached 1.37×, then popped"
 *   top                           "Would have reached the top (25.00×)"
 */
export function afterRoundText(
  cashedRung: number,
  outcome: RevealOutcome,
  reachedRung: number,
  reachedMultiplierHundredths: number,
): string {
  if (outcome === 'top') {
    return `Would have reached the top (${formatMultiplier(reachedMultiplierHundredths)})`;
  }
  if (reachedRung <= cashedRung) return 'Next pump would have popped';
  return `Would have reached ${formatMultiplier(reachedMultiplierHundredths)}, then popped`;
}

/**
 * The line under a balloon, or null when there is nothing to say: the
 * balloon did not cash out, or it has no reveal. The caller shows it only
 * once the round is over. Answers stored before reveals existed have no
 * `afterRound` at all, which counts as none.
 */
export function afterRoundLine(balloon: BalloonView): string | null {
  const afterRound: AfterRoundView | null = balloon.afterRound ?? null;
  if (balloon.status !== 'cashed' || afterRound === null) return null;
  return afterRoundText(
    balloon.rung,
    afterRound.outcome,
    afterRound.reachedRung,
    afterRound.reachedMultiplierHundredths,
  );
}

/**
 * How many characters the longer line has when the text is split into two
 * lines as evenly as its spaces allow. The CSS sizes the text by it, so it
 * fits a narrow slot in two short lines.
 */
export function twoLineChars(text: string): number {
  let best = text.length;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    best = Math.min(best, Math.max(i, text.length - i - 1));
  }
  return best;
}
