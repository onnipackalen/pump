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
 * Kept in localStorage. Storage can be missing, full or blocked (a private
 * window, cleared site data); every read and write is wrapped, and a failure
 * only means the verify page says it has no copy for that round.
 *
 * Three keys:
 * - 'pump.shownSeeds': what this build saves, newest first, at most MAX_SHOWN
 *   rounds (under 100 KB with the server's ids):
 *   [roundId, serverSeedHash, clientSeed, nonce].
 * - 'pump.shownSeedHashes': [roundId, serverSeedHash] pairs saved by older
 *   builds, which kept only the hash. Read here, never written. For those
 *   rounds the hash check still works, and this browser has no copy of the
 *   client seed or nonce.
 * - 'pump.startsOnTheirWay': starts sent whose answer has not come yet, so a
 *   round whose start answer was lost still gets its copy (see
 *   rememberStarting, and keepLostStartCopy in game/session.ts). Each one
 *   ends as a copy: under its round's id, or under a stand-in id
 *   (rememberStandIn), so what the screen showed is never thrown away.
 *
 * Why a new key, not longer entries under the old one: an older build still
 * open in another tab rewrites the old key with only the two-part entries it
 * knows, which would erase every longer entry, hash and all. It never
 * touches the new key. And every entry under the new key was saved by this
 * build with all three values, so a partial or junk entry there is skipped,
 * never read as a hash-only copy.
 *
 * A copy is found by round id (shownFor), and also by the hash and nonce it
 * saved (copiesWithSameNonce). The second is for a server that gives a round
 * another id in its answers: then no copy is found under the round's real
 * id, but one server seed and nonce belong to one round only, so a copy
 * saved with the same hash and nonce under another id is still found.
 */

import { CLIENT_SEED_PATTERN } from '../game/clientSeed';

const KEY = 'pump.shownSeeds';
const OLD_KEY = 'pump.shownSeedHashes';
const STARTING_KEY = 'pump.startsOnTheirWay';

/** How many rounds are remembered. Older ones are forgotten first. */
export const MAX_SHOWN = 500;

/** How many starts on their way are remembered (normally one at most). */
export const MAX_STARTING = 5;

/** The three values the screen showed before a round: what a new round saves. */
export interface SeedsBeforeRound {
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
}

/**
 * What this browser has of one round. The client seed and nonce are null
 * for a round an older build saved, which kept only the hash.
 */
export interface ShownSeeds {
  readonly serverSeedHash: string;
  readonly clientSeed: string | null;
  readonly nonce: number | null;
}

/** One remembered round as stored under the new key. */
export type ShownEntry = readonly [
  roundId: string,
  serverSeedHash: string,
  clientSeed: string,
  nonce: number,
];

/** One round an older build remembered: only its hash. */
export type OldShownEntry = readonly [roundId: string, serverSeedHash: string];

/** A start sent whose answer has not come yet: what it asked for, and the seeds on screen as it went. */
export interface StartOnItsWay {
  readonly difficultyId: string;
  readonly betsCents: readonly number[];
  readonly shown: SeedsBeforeRound;
}

/** The part of localStorage used here, so tests can hand in their own. */
export interface HashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A server seed hash: SHA-256 as 64 lowercase hex characters. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The longest round id kept. The server's ids are UUIDs (36 characters). */
const MAX_ID = 128;

function isRoundId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}

/**
 * The id a copy is saved under: the round's own id, or, for an id no real
 * server sends (empty, too long, not text), a stand-in made from it: '?'
 * and then the id, cut to fit. A copy under a stand-in is never found by the
 * id the server gave, so the verify page says it has no copy of that round,
 * which is true. But it is still found by its hash and nonce
 * (copiesWithSameNonce), so a server can't make the copy go away just by
 * sending such an id.
 */
function idToKeep(roundId: unknown): string {
  if (isRoundId(roundId)) return roundId;
  const text = typeof roundId === 'string' || typeof roundId === 'number' ? String(roundId) : '';
  return `?${text}`.slice(0, MAX_ID);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isClientSeed(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SEED_PATTERN.test(value);
}

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether all three are in the form a real server sends: a hash of 64
 * lowercase hex characters, a client seed of 1 to 64 allowed characters, and
 * a whole nonce of 0 or more. A round is only started on seeds like these
 * (see shownBefore in game/session.ts), so what is saved is exactly what was
 * on screen, and is compared with the record as it is.
 */
export function validSeeds(seeds: {
  readonly serverSeedHash: unknown;
  readonly clientSeed: unknown;
  readonly nonce: unknown;
}): seeds is SeedsBeforeRound {
  return isHash(seeds.serverSeedHash) && isClientSeed(seeds.clientSeed) && isWhole(seeds.nonce);
}

/** A JSON list from storage, each item read by `read` (null: skipped), at most `max`. Never throws. */
function listFrom<T>(text: string | null, read: (value: unknown) => T | null, max: number): T[] {
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const items: T[] = [];
  for (const value of data as unknown[]) {
    if (items.length === max) break;
    const item = read(value);
    if (item !== null) items.push(item);
  }
  return items;
}

/** One entry under the new key: all four parts valid, or null. */
function entryFrom(value: unknown): ShownEntry | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [roundId, serverSeedHash, clientSeed, nonce] = value as unknown[];
  return isRoundId(roundId) && isHash(serverSeedHash) && isClientSeed(clientSeed) && isWhole(nonce)
    ? [roundId, serverSeedHash, clientSeed, nonce]
    : null;
}

/** One entry an older build saved: exactly a round id and a hash, or null. */
function oldEntryFrom(value: unknown): OldShownEntry | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [roundId, serverSeedHash] = value as unknown[];
  return isRoundId(roundId) && isHash(serverSeedHash) ? [roundId, serverSeedHash] : null;
}

/** The saved list, or an empty one if nothing usable is saved. Never throws. */
export function parseShown(text: string | null): readonly ShownEntry[] {
  return listFrom(text, entryFrom, MAX_SHOWN);
}

/** The list older builds saved (hash only), or an empty one. Never throws. */
export function parseOldShown(text: string | null): readonly OldShownEntry[] {
  return listFrom(text, oldEntryFrom, MAX_SHOWN);
}

/**
 * The list with this round put first, cut to `max`. The same entry saved
 * again (a retry's answer) moves to the front instead of being kept twice.
 * An older entry under the same id with other values is kept too: an honest
 * server never gives two starts one id, and a server that did so would
 * otherwise wipe out the first copy, which copiesWithSameNonce still needs
 * to find. shownFor finds the newest.
 */
export function withShown(
  list: readonly ShownEntry[],
  roundId: string,
  shown: SeedsBeforeRound,
  max = MAX_SHOWN,
): readonly ShownEntry[] {
  const entry: ShownEntry = [roundId, shown.serverSeedHash, shown.clientSeed, shown.nonce];
  const same = (e: ShownEntry): boolean => e.every((part, i) => part === entry[i]);
  const others = list.filter((e) => !same(e));
  return [entry, ...others].slice(0, Math.max(0, max));
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
 * Saves what was shown before a round, all three values in one write. Does
 * nothing for values not in a valid form (a round is never started on
 * those), or if storage fails. A round id no real server sends gets a
 * stand-in (see idToKeep).
 */
export function rememberShown(
  roundId: string,
  shown: SeedsBeforeRound,
  storage: HashStorage | null = browserStorage(),
): void {
  if (!storage || !validSeeds(shown)) return;
  try {
    const list = parseShown(storage.getItem(KEY));
    storage.setItem(KEY, JSON.stringify(withShown(list, idToKeep(roundId), shown)));
  } catch {
    // Full or blocked: the verify page will say it has no copy of this round.
  }
}

/** Whether this browser saved any copy with this hash and nonce, under any id. Never throws. */
function hasCopyWith(serverSeedHash: string, nonce: number, storage: HashStorage): boolean {
  try {
    return parseShown(storage.getItem(KEY)).some(
      ([, hash, , savedNonce]) => hash === serverSeedHash && savedNonce === nonce,
    );
  } catch {
    return false;
  }
}

/**
 * Whether a copy is saved under a stand-in id ('?' and then something), not
 * under an id a real server gave. Real round ids never start with '?'.
 */
export function isStandIn(roundId: string): boolean {
  return roundId.startsWith('?');
}

/**
 * Saves the seeds a round start was bet against under a stand-in id
 * ('?start:', the nonce and the hash), for a start whose round this browser
 * may never learn the id of: its answer was lost, or it named a round this
 * browser already has another copy under. See keepLostStartCopy in
 * game/session.ts.
 *
 * A stand-in is never found by a round id (shownFor), only by its hash and
 * nonce (copiesWithSameNonce). Nothing is saved if this browser already has
 * a copy with the same hash and nonce, under any id: one server seed and
 * nonce belong to one round only, so that copy already stands for whichever
 * round used them.
 */
export function rememberStandIn(
  shown: SeedsBeforeRound,
  storage: HashStorage | null = browserStorage(),
): void {
  if (!storage || !validSeeds(shown)) return;
  if (hasCopyWith(shown.serverSeedHash, shown.nonce, storage)) return;
  rememberShown(`?start:${String(shown.nonce)}:${shown.serverSeedHash}`, shown, storage);
}

/**
 * What this browser showed before the round, or null if it has no copy of
 * it. A round an older build saved has only the hash.
 */
export function shownFor(
  roundId: string,
  storage: HashStorage | null = browserStorage(),
): ShownSeeds | null {
  if (!storage) return null;
  try {
    const found = parseShown(storage.getItem(KEY)).find(([id]) => id === roundId);
    if (found) return { serverSeedHash: found[1], clientSeed: found[2], nonce: found[3] };
    const old = parseOldShown(storage.getItem(OLD_KEY)).find(([id]) => id === roundId);
    return old ? { serverSeedHash: old[1], clientSeed: null, nonce: null } : null;
  } catch {
    return null;
  }
}

/**
 * The copies this browser saved, under round ids other than `roundId`, with
 * this hash and this nonce, newest first. Only this build's copies have a
 * nonce, so an older build's copy is never among them. Never throws.
 *
 * A server seed and nonce belong to one round only. So when this browser has
 * no copy under a round's id, a copy with that round's hash and nonce under
 * another id may be the copy of that same round, whose start the server
 * answered under another id.
 */
export function copiesWithSameNonce(
  serverSeedHash: string,
  nonce: number,
  roundId: string,
  storage: HashStorage | null = browserStorage(),
): readonly ShownEntry[] {
  if (!storage) return [];
  try {
    return parseShown(storage.getItem(KEY)).filter(
      ([id, hash, , savedNonce]) => id !== roundId && hash === serverSeedHash && savedNonce === nonce,
    );
  } catch {
    return [];
  }
}

/** One stored start on its way: [difficultyId, betsCents, hash, clientSeed, nonce]. */
function startFrom(value: unknown): StartOnItsWay | null {
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [difficultyId, betsCents, serverSeedHash, clientSeed, nonce] = value as unknown[];
  if (typeof difficultyId !== 'string' || difficultyId.length === 0 || difficultyId.length > 64) {
    return null;
  }
  if (!Array.isArray(betsCents) || betsCents.length === 0 || betsCents.length > 10) return null;
  const bets = betsCents as unknown[];
  if (!bets.every(isWhole)) return null;
  const shown = { serverSeedHash, clientSeed, nonce };
  return validSeeds(shown) ? { difficultyId, betsCents: bets, shown } : null;
}

/**
 * Remembers a start before it is sent, newest first. If both tries lose the
 * answer, or the page is closed before it comes, the round the server
 * started can still get the seeds this start was bet against.
 */
export function rememberStarting(
  start: StartOnItsWay,
  storage: HashStorage | null = browserStorage(),
): void {
  if (!storage || !validSeeds(start.shown)) return;
  try {
    const list = listFrom(storage.getItem(STARTING_KEY), startFrom, MAX_STARTING);
    const { difficultyId, betsCents, shown } = start;
    const entry = [difficultyId, betsCents, shown.serverSeedHash, shown.clientSeed, shown.nonce];
    const stored = list.map((s) => [
      s.difficultyId,
      s.betsCents,
      s.shown.serverSeedHash,
      s.shown.clientSeed,
      s.shown.nonce,
    ]);
    storage.setItem(STARTING_KEY, JSON.stringify([entry, ...stored].slice(0, MAX_STARTING)));
  } catch {
    // Full or blocked: only a start whose answer is lost goes without a copy.
  }
}

/** The starts on their way, newest first. Never throws. */
export function startsOnTheirWay(
  storage: HashStorage | null = browserStorage(),
): readonly StartOnItsWay[] {
  if (!storage) return [];
  try {
    return listFrom(storage.getItem(STARTING_KEY), startFrom, MAX_STARTING);
  } catch {
    return [];
  }
}

/** Forgets every start on its way. Callers first keep each one's seeds as a copy (see settleStarts in game/session.ts). */
export function forgetStarting(storage: HashStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STARTING_KEY, '[]');
  } catch {
    // Blocked: nothing was saved there either.
  }
}
