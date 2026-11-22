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
 *
 * A server could also give the round another id in its answers while it is
 * played, so the copy is saved under that id and none is found under the
 * round's real one. So when there is no copy under the round's id, the page
 * also looks for a copy saved with the record's hash and nonce under another
 * id (one server seed and nonce belong to one round only):
 * - under another round's id: always a problem. That hash and nonce belong
 *   to that other round, so this is that round under another id, or a round
 *   that used its rolls again, even with the same client seed.
 * - under a stand-in id (the seeds a start was bet against, kept when this
 *   browser never learned the id of the round it made; shownHashes,
 *   rememberStandIn): a problem if it names another client seed. With the
 *   same one, it is this round's own copy.
 * A server that also moved the round to a server seed or nonce this browser
 * has no copy for is not caught this way; the no-copy note says that a
 * missing copy can be a warning sign.
 *
 * All of these compare the record's values exactly as sent. The form, by
 * contrast, trims text and reads numbers from text, so a record whose hash,
 * client seed or nonce is not in the exact form a real server sends (a
 * nonce sent as the text "0", a hash with a space after it) could slip past
 * a lookup and still add up once the form has tidied it. So such a record is
 * a problem of its own (recordFormProblem), and never checks out.
 */

import { recordHashProblem } from './hashCheck';
import { isStandIn, MAX_SHOWN, validSeeds, type ShownEntry, type ShownSeeds } from './shownHashes';

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
 * A problem with the server's record itself: its server seed hash, client
 * seed or nonce is not in the exact form a real server sends (a hash of 64
 * lowercase hex characters, a client seed of 1 to 64 allowed characters, a
 * whole number of 0 or more, sent as a number). This server never sends
 * them any other way, so this gives no false alarms. Null when all three
 * are in that form.
 */
export function recordFormProblem(record: RecordSeeds): string | null {
  if (validSeeds(record)) return null;
  return (
    'The server’s record gives the server seed hash, client seed or nonce in a form this game ' +
    'never sends (for example a nonce sent as text, or a hash with a space in it). So the ' +
    'record can’t be compared exactly with what this browser saved, and this round can’t be ' +
    'called checked.'
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
 * A problem with the server's record itself: this browser has no copy under
 * this round's id, but it saved this record's hash and nonce for another
 * round start (`copy`). Under another round's id that is always a problem
 * (see the top of this file). Under a stand-in id it is one only when the
 * client seeds differ; null when they agree.
 */
export function sameNonceProblem(copy: ShownEntry, record: RecordSeeds): string | null {
  const [otherId, , clientSeed, nonce] = copy;
  if (isStandIn(otherId)) {
    if (clientSeed === record.clientSeed) return null;
    return (
      `The server’s record says this round used the client seed “${record.clientSeed}” with ` +
      `nonce ${String(nonce)}. This browser has no copy saved under this round’s id. But for a ` +
      'round start whose round it never learned the id of (its answer was lost, or named another ' +
      'round, or an id this game does not keep), it saved the same server seed hash and nonce ' +
      `${String(nonce)}, with the client seed “${clientSeed}”. One server seed and nonce belong ` +
      'to one round only. So this may be that start’s round, played on a client seed the server ' +
      'picked. (Rarely it happens without cheating: a start that never reached the server, then ' +
      'a new client seed, then a round on the same nonce whose start answer was lost too.)'
    );
  }
  if (clientSeed === record.clientSeed) {
    return (
      `The server’s record says this round used nonce ${String(nonce)}, with the client seed ` +
      `“${clientSeed}”. This browser has no copy saved under this round’s id. But when it started ` +
      `round ${otherId}, it saved this same server seed hash, client seed and nonce. One server ` +
      `seed and nonce belong to one round only. So this may be round ${otherId} under another id, ` +
      `or a round that used the rolls of round ${otherId} again. (A round started in another tab ` +
      'by an older version of this game, on a screen that still showed that nonce, would also ' +
      `cause this. Then round ${otherId} shows another nonce when you check it.)`
    );
  }
  return (
    `The server’s record says this round used the client seed “${record.clientSeed}” with ` +
    `nonce ${String(nonce)}. This browser has no copy saved under this round’s id. But when it ` +
    `started round ${otherId}, it saved the same server seed hash and nonce ${String(nonce)}, ` +
    `with the client seed “${clientSeed}”. One server seed and nonce belong to one round only. ` +
    `So this may be round ${otherId}, played on a client seed the server picked, under another ` +
    `id. (Playing a round in another tab or on another device just before round ${otherId} ` +
    'started, after changing the client seed there, would also cause this. Then that round ' +
    'shows another nonce when you check it.)'
  );
}

/**
 * Every place the server's answer differs from what it should be: a record
 * under another round id, seeds not in the exact form a real server sends
 * (recordFormProblem), or another hash, client seed or nonce than this
 * browser saved when the round started (`shown`, the copy for `askedId`).
 * With no full copy for `askedId`, `elsewhere` holds the copies saved under
 * other ids with the record's hash and nonce (see copiesWithSameNonce), and
 * each of those is a problem too (sameNonceProblem), except a stand-in that
 * names the record's client seed. Empty when they
 * all agree, or when the ids agree and this browser has no copy at all. Any
 * of these means the round does not check out, whatever the draws say.
 */
export function recordProblems(
  askedId: string,
  shown: ShownSeeds | null,
  record: RecordSeeds,
  elsewhere: readonly ShownEntry[] = [],
): string[] {
  const problems = [recordIdProblem(askedId, record.id), recordFormProblem(record)];
  if (shown !== null) {
    problems.push(
      recordHashProblem(shown.serverSeedHash, record.serverSeedHash),
      recordClientSeedProblem(shown.clientSeed, record.clientSeed),
      recordNonceProblem(shown.nonce, record.nonce),
    );
  }
  for (const copy of elsewhere) problems.push(sameNonceProblem(copy, record));
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
      'browser keeps. It also happens if the server gave the round another id in its answers ' +
      'while you played it. So all three checked here are the server’s own record, and this ' +
      'check can’t catch a server that changed them. If you played this round in this browser ' +
      'not long ago, and none of the other causes fits, take this note as a warning sign.'
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
