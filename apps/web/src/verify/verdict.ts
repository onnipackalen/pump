/**
 * The verify page's overall verdict on a round, as a plain function so it
 * can be tested.
 *
 * "This round checks out" is said only when all of these hold:
 * - verifyRound finds nothing wrong with the inputs on the page;
 * - the server's record is the round asked for, and names the same hash,
 *   client seed and nonce as this browser saved when that round started
 *   (copyCheck);
 * - the record agrees with what this device's screen showed (a reveal line,
 *   a top rung; shownReveals);
 * - the inputs on the page are the round's own: this browser's copy where it
 *   has one, the record's otherwise. Otherwise a player who typed in other
 *   values (say, the hash the page works out from the revealed seed) would
 *   see the success line for a round that was not played that way.
 */

import type { RoundCheck } from '@pump/engine/fair';

/** How the verdict box looks: the page's CSS has one colour for each. */
export type VerdictTone = 'match' | 'mismatch' | 'cannot-check';

export interface Verdict {
  readonly ok: boolean;
  readonly tone: VerdictTone;
  readonly headline: string;
  /** Every problem found, record problems first. */
  readonly problems: readonly string[];
}

export interface VerdictParts {
  /** verifyRound's check of the inputs on the page. */
  readonly result: RoundCheck;
  /** Where the server's record is another round's, or names another hash, client seed or nonce than this browser saved. */
  readonly recordProblems: readonly string[];
  /** Where the record differs from what this device's screen showed. */
  readonly screenProblems: readonly string[];
  /** Some input on the page is not the round's own (see the top of this file). */
  readonly inputsChanged: boolean;
  /** Some balloon has a reveal, so the success line says it was checked too. */
  readonly anyReveal: boolean;
}

export function roundVerdict(parts: VerdictParts): Verdict {
  const { result, recordProblems, screenProblems, inputsChanged, anyReveal } = parts;
  const problems = [...recordProblems, ...result.problems, ...screenProblems];
  if (!result.ok || recordProblems.length > 0) {
    return {
      ok: false,
      tone: 'mismatch',
      headline: '✗ This round does not match what was recorded.',
      problems,
    };
  }
  if (screenProblems.length > 0) {
    return {
      ok: false,
      tone: 'mismatch',
      headline: '✗ This round does not match what this device showed.',
      problems,
    };
  }
  if (inputsChanged) {
    return {
      ok: false,
      tone: 'cannot-check',
      headline:
        '✗ Not checked as played: an input above was changed. Press “Reset the inputs” to ' +
        'check this round.',
      problems,
    };
  }
  return {
    ok: true,
    tone: 'match',
    headline: `✓ This round checks out. Every pump, worked out again from the seeds, gives exactly what was recorded and paid${
      anyReveal ? ', and so does where each cashed-out balloon would have popped' : ''
    }.`,
    problems,
  };
}
