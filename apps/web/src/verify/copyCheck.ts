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
 *
 * The copy is looked up by the round id the player asked for, never by the
 * id inside the record, and a record that comes back under another id is a
 * problem too. Otherwise a server could send this round's record under
 * another id (no copy is found, so nothing is compared), or another round's
 * record whose copy agrees.
 */

import { recordHashProblem } from './hashCheck';
import { MAX_SHOWN, type ShownSeeds } from './shownHashes';

/** The values the server's record names for a round. */
export interface RecordSeeds {
  readonly id: string;
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
 * A problem with the server's answer itself: the page asked for one round,
 * and the record is another's (or carries another id). Null when the ids
 * are the same.
 */
export function recordIdProblem(askedId: string, recordId: string): string | null {
  if (askedId === recordId) return null;
  return (
    `This page asked the server for round ${askedId}, but the server sent the record of round ` +
    `${recordId}. So this is not the record of the round you asked for.`
  );
}

/**
 * Every place the server's answer differs from what it should be: a record
 * under another round id, or another hash, client seed or nonce than this
 * browser saved when the round started (`shown`, the copy for `askedId`).
 * Empty when they all agree, or when the ids agree and this browser has no
 * copy. Any of these means the round does not check out, whatever the draws
 * say.
 */
export function recordProblems(
  askedId: string,
  shown: ShownSeeds | null,
  record: RecordSeeds,
): string[] {
  const problems = [recordIdProblem(askedId, record.id)];
  if (shown !== null) {
    problems.push(
      recordHashProblem(shown.serverSeedHash, record.serverSeedHash),
      recordClientSeedProblem(shown.clientSeed, record.clientSeed),
      recordNonceProblem(shown.nonce, record.nonce),
    );
  }
  return problems.filter((problem): problem is string => problem !== null);
}

/**
 * Said plainly when this browser has no copy of some of what it showed
 * before the round, or null when it has all of it. The causes are put as
 * what can happen, not as what did: this browser can't know which it was.
 */
export function noRecordNote(shown: ShownSeeds | null): string | null {
  if (shown === null) {
    return (
      'This browser has no copy of the hash, client seed and nonce it showed you before this ' +
      'round. That happens if the round was played on another device or in another browser, if ' +
      'this browser’s saved data was cleared or could not be saved, if the connection was lost ' +
      `as the round started, or if it is older than the last ${String(MAX_SHOWN)} rounds this ` +
      'browser keeps. So all three checked here are the server’s own record, and this check ' +
      'can’t catch a server that changed them.'
    );
  }
  if (shown.clientSeed === null || shown.nonce === null) {
    return (
      'This browser has a copy of the hash it showed you before this round, but not of the ' +
      'client seed and nonce: an older version of the game started this round, and it kept ' +
      'only the hash. So the client seed and nonce checked here are the server’s own record, ' +
      'and this check can’t catch a server that changed them.'
    );
  }
  return null;
}
