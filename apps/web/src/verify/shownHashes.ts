/**
 * What this browser showed the player before each round, kept in this
 * browser by round id: the server-seed hash, the client seed and the nonce.
 *
 * Why: the verify page recomputes a round from its server seed, client seed
 * and nonce, and checks the server seed against the hash shown before the
 * round. If those came from the server's own record, a server that lied
 * could play a round with a client seed or nonce of its own choosing, then
 * name it in the record, and the round would still check out. A copy the
 * browser saved when the round started is the player's own evidence.
 *
 * Kept in localStorage, newest first, at most MAX_SHOWN_HASHES rounds (about
 * 100 KB at most with the server's round ids). Storage can be missing, full
 * or blocked (a private window, cleared site data); every read and write is
 * wrapped, and a failure only means the verify page says it has no copy for
 * that round.
 *
 * The format. One list under one key; each entry is one of:
 *   [roundId, serverSeedHash]                       the older entries
 *   [roundId, serverSeedHash, clientSeed, nonce]    saved now
 * Why the old list grows a longer entry instead of a second key: the three
 * values are saved in one write, so they are kept or lost together, and one
 * list has one size limit. Two-part entries still read as before: their hash
 * check works, and for them this browser has no copy of the client seed or
 * nonce. (An older build reading the new list skips the four-part entries:
 * it loses those copies, but never reads a wrong one.)
 */

import { CLIENT_SEED_PATTERN } from '../game/clientSeed';

const STORAGE_KEY = 'pump.shownSeedHashes';

/** How many rounds are remembered. Older ones are forgotten first. */
export const MAX_SHOWN_HASHES = 500;

/** What this browser showed before one round. */
export interface ShownSeeds {
  readonly serverSeedHash: string;
  /**
   * The client seed and the nonce on screen as the bet went out. Both null
   * when this browser has no copy of them: an entry saved before they were
   * kept, or a round started with no client seed on screen.
   */
  readonly clientSeed: string | null;
  readonly nonce: number | null;
}

/** One remembered round as stored: its id and what was shown before it. */
export type ShownEntry =
  | readonly [roundId: string, serverSeedHash: string]
  | readonly [roundId: string, serverSeedHash: string, clientSeed: string, nonce: number];

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

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isClientSeed(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SEED_PATTERN.test(value);
}

function isNonce(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * One stored entry, cleaned up: null if its round id or hash is not usable.
 * A client seed and nonce are kept only as a valid pair; anything else
 * (missing, partial, junk or extra parts) leaves just the hash.
 */
function entryFrom(value: unknown): ShownEntry | null {
  if (!Array.isArray(value)) return null;
  const [roundId, hash, clientSeed, nonce] = value as unknown[];
  if (!isRoundId(roundId) || !isHash(hash)) return null;
  if (value.length === 4 && isClientSeed(clientSeed) && isNonce(nonce)) {
    return [roundId, hash, clientSeed, nonce];
  }
  return [roundId, hash];
}

/** The saved list, or an empty one if nothing usable is saved. Never throws. */
export function parseShownHashes(text: string | null): readonly ShownEntry[] {
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const entries: ShownEntry[] = [];
  for (const value of data as unknown[]) {
    const entry = entryFrom(value);
    if (entry !== null) entries.push(entry);
    if (entries.length === MAX_SHOWN_HASHES) break;
  }
  return entries;
}

/** The stored entry for what was shown: four parts with a client seed and nonce, two without. */
function entryOf(roundId: string, shown: ShownSeeds): ShownEntry {
  const { serverSeedHash, clientSeed, nonce } = shown;
  return isClientSeed(clientSeed) && isNonce(nonce)
    ? [roundId, serverSeedHash, clientSeed, nonce]
    : [roundId, serverSeedHash];
}

/** What a stored entry says was shown. */
function shownOf(entry: ShownEntry): ShownSeeds {
  return entry.length === 4
    ? { serverSeedHash: entry[1], clientSeed: entry[2], nonce: entry[3] }
    : { serverSeedHash: entry[1], clientSeed: null, nonce: null };
}

/** The list with this round put first (replacing an older entry for it), cut to `max`. */
export function withShown(
  list: readonly ShownEntry[],
  roundId: string,
  shown: ShownSeeds,
  max = MAX_SHOWN_HASHES,
): readonly ShownEntry[] {
  const others = list.filter(([id]) => id !== roundId);
  return [entryOf(roundId, shown), ...others].slice(0, Math.max(0, max));
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
 * Saves what was shown before a round. Does nothing for a value that is not
 * a round id and a 64-character lowercase hex hash, or if storage fails. A
 * client seed or nonce that is not valid is left out, and the hash is still
 * saved.
 */
export function rememberShown(
  roundId: string,
  shown: ShownSeeds,
  storage: HashStorage | null = browserStorage(),
): void {
  if (!storage || !isRoundId(roundId) || !isHash(shown.serverSeedHash)) return;
  try {
    const list = parseShownHashes(storage.getItem(STORAGE_KEY));
    storage.setItem(STORAGE_KEY, JSON.stringify(withShown(list, roundId, shown)));
  } catch {
    // Full or blocked: the verify page will say it has no copy of this round.
  }
}

/** What this browser showed before the round, or null if it has no copy of it. */
export function shownFor(
  roundId: string,
  storage: HashStorage | null = browserStorage(),
): ShownSeeds | null {
  if (!storage) return null;
  try {
    const found = parseShownHashes(storage.getItem(STORAGE_KEY)).find(([id]) => id === roundId);
    return found ? shownOf(found) : null;
  } catch {
    return null;
  }
}
