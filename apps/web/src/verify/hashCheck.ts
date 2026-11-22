/**
 * What the verify page says about the server seed's hash, as plain
 * functions so the wording can be tested.
 *
 * The check that matters: the revealed server seed hashes to the hash the
 * player was shown before the round. Where that hash comes from decides what
 * the check proves:
 * - 'browser': the copy this browser saved when the round started
 *   (shownHashes). The server can't change it afterwards, so a match proves
 *   the seed was fixed before the round.
 * - 'server': this browser has no copy, so the hash is the server's own
 *   record. A match then only shows the server is consistent with itself.
 * - 'typed': the player changed the field, so the check is against that.
 *
 * The client seed and nonce follow the same pattern in copyCheck.ts, which
 * also has the note for a round this browser has no copy of.
 */
export type HashSource = 'browser' | 'server' | 'typed';

/** Where the hash in the field came from. */
export function hashSource(formHash: string, shownHash: string | null, recordHash: string): HashSource {
  const hash = formHash.trim();
  if (shownHash !== null) return hash === shownHash ? 'browser' : 'typed';
  return hash === recordHash ? 'server' : 'typed';
}

/** The label of the hash field. */
export function hashFieldLabel(shownHash: string | null): string {
  return shownHash === null
    ? 'Server seed hash (the server’s record)'
    : 'Server seed hash (saved by this browser before the round)';
}

/** The line under the computed hash: does it match, and what does that prove. */
export function hashVerdict(source: HashSource, matches: boolean): string {
  switch (source) {
    case 'browser':
      return matches
        ? '✓ Same as the hash this browser showed you before the round (saved when it started), so the seed was fixed before you played.'
        : '✗ Not the hash this browser showed you before the round.';
    case 'server':
      return matches
        ? '✓ Same as the server’s record of the hash shown before the round.'
        : '✗ Not even the server’s own record of the hash shown before the round.';
    case 'typed':
      return matches ? '✓ Same as the hash typed above.' : '✗ Not the hash typed above.';
  }
}

/**
 * A problem with the server's record itself: it names a different hash from
 * the one this browser saved when the round started. Null when they agree,
 * or when this browser has no copy to compare.
 */
export function recordHashProblem(shownHash: string | null, recordHash: string): string | null {
  if (shownHash === null || shownHash === recordHash) return null;
  return (
    `The server’s record says the hash shown before this round was ${recordHash}, but this ` +
    `browser saved ${shownHash} when the round started. (Rotating the server seed in another ` +
    'tab or on another device just before the round would also cause this.)'
  );
}
