/**
 * The server-seed hash this browser showed the player before each round,
 * kept in this browser by round id.
 *
 * Why: the verify page checks that the revealed server seed hashes to the
 * hash shown before the round. If that hash came from the server's own
 * record, a server that lied could simply send a matching one. A copy the
 * browser saved when the round started is the player's own evidence.
 *
 * Kept in localStorage, newest first, at most MAX_SHOWN_HASHES rounds (about
 * 55 KB). Storage can be missing, full or blocked (a private window, cleared
 * site data); every read and write is wrapped, and a failure only means the
 * verify page says it has no record for that round.
 */

const STORAGE_KEY = 'pump.shownSeedHashes';

/** How many rounds are remembered. Older ones are forgotten first. */
export const MAX_SHOWN_HASHES = 500;

/** One remembered round: its id and the hash shown before it. */
export type ShownHash = readonly [roundId: string, serverSeedHash: string];

/** The part of localStorage used here, so tests can hand in their own. */
export interface HashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A server seed hash: SHA-256 as 64 lowercase hex characters. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRoundId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isShownHash(value: unknown): value is ShownHash {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isRoundId(value[0]) &&
    typeof value[1] === 'string' &&
    HASH_PATTERN.test(value[1])
  );
}

/** The saved list, or an empty one if nothing usable is saved. Never throws. */
export function parseShownHashes(text: string | null): readonly ShownHash[] {
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(data) ? data.filter(isShownHash).slice(0, MAX_SHOWN_HASHES) : [];
}

/** The list with this round put first (replacing an older entry for it), cut to `max`. */
export function withShownHash(
  list: readonly ShownHash[],
  roundId: string,
  serverSeedHash: string,
  max = MAX_SHOWN_HASHES,
): readonly ShownHash[] {
  const others = list.filter(([id]) => id !== roundId);
  return [[roundId, serverSeedHash] as const, ...others].slice(0, Math.max(0, max));
}

/** This browser's localStorage, or null where there is none or it is blocked. */
function browserStorage(): HashStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Saves the hash shown before a round. Does nothing for a value that is not
 * a round id and a 64-character lowercase hex hash, or if storage fails.
 */
export function rememberShownHash(
  roundId: string,
  serverSeedHash: string,
  storage: HashStorage | null = browserStorage(),
): void {
  if (!storage || !isRoundId(roundId) || !HASH_PATTERN.test(serverSeedHash)) return;
  try {
    const list = parseShownHashes(storage.getItem(STORAGE_KEY));
    storage.setItem(STORAGE_KEY, JSON.stringify(withShownHash(list, roundId, serverSeedHash)));
  } catch {
    // Full or blocked: the verify page will say it has no record of this round.
  }
}

/** The hash this browser showed before the round, or null if it has no record of it. */
export function shownHashFor(
  roundId: string,
  storage: HashStorage | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const found = parseShownHashes(storage.getItem(STORAGE_KEY)).find(([id]) => id === roundId);
    return found ? found[1] : null;
  } catch {
    return null;
  }
}
