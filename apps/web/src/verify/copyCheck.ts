/**
 * What the verify page says about the client seed and the nonce, and about
 * this browser's copy of all three values it saved before a round (the hash,
 * client seed and nonce; see shownHashes). Plain functions, so the wording
 * can be tested. hashCheck.ts has the hash's own lines; these follow it.
 *
 * Every pump of a round is drawn from its server seed, client seed and
 * nonce. If the client seed and nonce came from the server's record, a
 * server that lied could play a round with a client seed (or another nonce
 * of the same server seed) of its own choosing, then name it in the record,
 * and the draws worked out from the record would match. So the verify page
 * fills them in from this browser's copy when it has one, and says so when
 * the record names other values. Without a copy, they are the server's own
 * record, and the page says that plainly too.
 */

import { recordHashProblem } from './hashCheck';
import type { ShownSeeds } from './shownHashes';

/** The values the server's record names for a round. */
export interface RecordSeeds {
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
}

/** The label of the client seed field. */
export function clientSeedFieldLabel(shownClientSeed: string | null): string {
  return shownClientSeed === null
    ? 'Client seed (the server’s record)'
    : 'Client seed (saved by this browser before the round)';
}

/** The label of the nonce field. */
export function nonceFieldLabel(shownNonce: number | null): string {
  return shownNonce === null
    ? 'Nonce (the server’s record)'
    : 'Nonce (saved by this browser before the round)';
}

/**
 * A problem with the server's record itself: it names another client seed
 * than the one this browser showed when the round started. Null when they
 * agree, or when this browser has no copy to compare.
 */
export function recordClientSeedProblem(
  shownClientSeed: string | null,
  recordClientSeed: string,
): string | null {
  if (shownClientSeed === null || shownClientSeed === recordClientSeed) return null;
  return (
    `The server’s record says this round used the client seed “${recordClientSeed}”, but this ` +
    `browser saved “${shownClientSeed}” when the round started. (Changing the client seed in ` +
    'another tab or on another device just before the round would also cause this.)'
  );
}

/**
 * A problem with the server's record itself: it names another nonce than
 * the one this browser showed for the next round when this one started.
 * Null when they agree, or when this browser has no copy to compare.
 */
export function recordNonceProblem(shownNonce: number | null, recordNonce: number): string | null {
  if (shownNonce === null || shownNonce === recordNonce) return null;
  return (
    `The server’s record says this round used nonce ${String(recordNonce)}, but this browser ` +
    `saved nonce ${String(shownNonce)} when the round started. (Playing a round, or rotating ` +
    'the server seed, in another tab or on another device just before this round would also ' +
    'cause this.)'
  );
}

/**
 * Every place the server's record names another hash, client seed or nonce
 * than this browser saved when the round started. Empty when they all agree
 * or this browser has no copy. Any of these means the round does not check
 * out, whatever the draws say.
 */
export function recordProblems(shown: ShownSeeds | null, record: RecordSeeds): string[] {
  if (shown === null) return [];
  return [
    recordHashProblem(shown.serverSeedHash, record.serverSeedHash),
    recordClientSeedProblem(shown.clientSeed, record.clientSeed),
    recordNonceProblem(shown.nonce, record.nonce),
  ].filter((problem): problem is string => problem !== null);
}

/**
 * Said plainly when this browser has no copy of some of what it showed
 * before the round, or null when it has all of it.
 */
export function noRecordNote(shown: ShownSeeds | null): string | null {
  if (shown === null) {
    return (
      'This browser has no record of the hash, client seed and nonce it showed you before this ' +
      'round: the round was played on another device or in another browser, or this browser’s ' +
      'saved data was cleared. So all three checked here are the server’s own record, and this ' +
      'check can’t catch a server that changed them.'
    );
  }
  if (shown.clientSeed === null || shown.nonce === null) {
    return (
      'This browser saved the hash it showed you before this round, but not the client seed and ' +
      'nonce (rounds played before it kept those have only the hash). So the client seed and ' +
      'nonce checked here are the server’s own record, and this check can’t catch a server that ' +
      'changed them.'
    );
  }
  return null;
}
