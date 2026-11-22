import { describe, expect, it } from 'vitest';
import {
  forgetStarting,
  MAX_SHOWN,
  MAX_STARTING,
  parseOldShown,
  parseShown,
  rememberShown,
  rememberStarting,
  shownFor,
  startsOnTheirWay,
  validSeeds,
  withShown,
  type HashStorage,
  type SeedsBeforeRound,
} from '../src/verify/shownHashes';

const SHOWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const KEY = 'pump.shownSeeds';
const OLD_KEY = 'pump.shownSeedHashes';
const STARTING_KEY = 'pump.startsOnTheirWay';

/** What a screen showed before a round: a hash, a client seed and the next nonce. */
const shown = (serverSeedHash: string, clientSeed = 'player-seed', nonce = 4): SeedsBeforeRound => ({
  serverSeedHash,
  clientSeed,
  nonce,
});

/** localStorage as a Map, the way the browser keeps it. */
class MemoryStorage implements HashStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** Storage that refuses everything, like a blocked or full one. */
const broken: HashStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

/**
 * What the build before this one did on every round start (9cfa504
 * shownHashes.ts): read the old key keeping only two-part entries, put the
 * new pair first, and write the list back.
 */
function olderBuildStarts(storage: MemoryStorage, roundId: string, hash: string): void {
  const text = storage.getItem(OLD_KEY);
  const data: unknown = text === null ? [] : JSON.parse(text);
  const kept = Array.isArray(data) ? (data as unknown[]).filter((e) => Array.isArray(e) && e.length === 2) : [];
  storage.setItem(OLD_KEY, JSON.stringify([[roundId, hash], ...kept]));
}

describe('what this browser showed before each round, kept in this browser', () => {
  it('is found again by round id: the hash, the client seed and the nonce', () => {
    const storage = new MemoryStorage();
    rememberShown('round-1', shown(SHOWN, 'mine', 0), storage);
    rememberShown('round-2', shown(OTHER, 'also_mine-2', 17), storage);
    expect(shownFor('round-1', storage)).toEqual(shown(SHOWN, 'mine', 0));
    expect(shownFor('round-2', storage)).toEqual(shown(OTHER, 'also_mine-2', 17));
    expect(shownFor('round-3', storage)).toBeNull();
  });

  it('keeps only the newest rounds, so it stays small', () => {
    let list = withShown([], 'r0', shown(SHOWN), 3);
    for (const id of ['r1', 'r2', 'r3']) list = withShown(list, id, shown(SHOWN), 3);
    expect(list.map(([id]) => id)).toEqual(['r3', 'r2', 'r1']);
    // Saving a round again moves it to the front instead of adding it twice.
    expect(withShown(list, 'r1', shown(OTHER, 'x', 9), 3)).toEqual([
      ['r1', OTHER, 'x', 9],
      ['r3', SHOWN, 'player-seed', 4],
      ['r2', SHOWN, 'player-seed', 4],
    ]);
  });

  it(`never holds more than ${MAX_SHOWN} rounds in storage`, () => {
    const storage = new MemoryStorage();
    // The longest client seed and a large nonce, with the server's UUID round ids.
    const longest = shown(SHOWN, 'z'.repeat(64), 9_007_199_254_740_991);
    const id = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    for (let n = 0; n < MAX_SHOWN + 20; n += 1) rememberShown(id(n), longest, storage);
    const saved = parseShown(storage.getItem(KEY));
    expect(saved).toHaveLength(MAX_SHOWN);
    expect(shownFor(id(MAX_SHOWN + 19), storage)).toEqual(longest);
    expect(shownFor(id(0), storage)).toBeNull();
    // About 100 KB at most.
    expect(storage.getItem(KEY)?.length ?? 0).toBeLessThan(100_000);
  });

  it('never throws when storage is blocked or full: it just has no copy', () => {
    expect(() => rememberShown('round-1', shown(SHOWN), broken)).not.toThrow();
    expect(shownFor('round-1', broken)).toBeNull();
    expect(shownFor('round-1', null)).toBeNull();
    expect(() => rememberStarting({ difficultyId: 'easy', betsCents: [100], shown: shown(SHOWN) }, broken)).not.toThrow();
    expect(startsOnTheirWay(broken)).toEqual([]);
    expect(() => forgetStarting(broken)).not.toThrow();
  });

  it('reads what older builds saved, which kept only the hash, and never writes there', () => {
    const storage = new MemoryStorage();
    const before = JSON.stringify([['old-round', SHOWN]]);
    storage.setItem(OLD_KEY, before);
    expect(shownFor('old-round', storage)).toEqual({
      serverSeedHash: SHOWN,
      clientSeed: null,
      nonce: null,
    });
    rememberShown('new-round', shown(OTHER, 'mine', 3), storage);
    expect(shownFor('new-round', storage)).toEqual(shown(OTHER, 'mine', 3));
    expect(storage.getItem(OLD_KEY)).toBe(before);
    expect(shownFor('old-round', storage)?.clientSeed).toBeNull();
  });

  it('keeps every copy when an older build in another tab starts a round', () => {
    const storage = new MemoryStorage();
    rememberShown('new-round', shown(SHOWN, 'mine', 3), storage);
    // The older build rewrites only its own key, so the new copy is untouched.
    olderBuildStarts(storage, 'old-tab-round', OTHER);
    expect(shownFor('new-round', storage)).toEqual(shown(SHOWN, 'mine', 3));
    expect(shownFor('old-tab-round', storage)).toEqual({ serverSeedHash: OTHER, clientSeed: null, nonce: null });
  });

  it('a copy with all three wins over an older hash-only one for the same round', () => {
    const storage = new MemoryStorage();
    storage.setItem(OLD_KEY, JSON.stringify([['round-1', OTHER]]));
    rememberShown('round-1', shown(SHOWN, 'mine', 1), storage);
    expect(shownFor('round-1', storage)).toEqual(shown(SHOWN, 'mine', 1));
  });

  it('ignores anything in storage that is not a whole entry', () => {
    expect(parseShown(null)).toEqual([]);
    expect(parseShown('not json')).toEqual([]);
    expect(parseShown('{"round-1":"x"}')).toEqual([]);
    expect(parseShown('"text"')).toEqual([]);
    expect(parseOldShown('not json')).toEqual([]);
    expect(
      parseOldShown(
        JSON.stringify([
          ['round-1', SHOWN],
          ['round-2', 'XYZ'],
          [7, SHOWN],
          ['round-3'],
          'round-4',
          null,
          { id: 'round-5', hash: SHOWN },
          ['x'.repeat(129), SHOWN],
          ['', SHOWN],
          ['round-6', SHOWN, 'mine', 1],
        ]),
      ),
    ).toEqual([['round-1', SHOWN]]);
  });

  it('skips a partial or junk entry under the new key, never reading it as hash-only', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify([
        ['ok', SHOWN, 'mine', 0],
        // Partial: no nonce, or only the hash.
        ['partial', SHOWN, 'mine'],
        ['hash-only', SHOWN],
        // Not a client seed: has ':', is too long, is empty, is not text.
        ['colon', SHOWN, 'a:b', 1],
        ['long', SHOWN, 'z'.repeat(65), 1],
        ['empty', SHOWN, '', 1],
        ['number', SHOWN, 12, 1],
        // Not a nonce: below 0, not whole, too big to be exact, text.
        ['negative', SHOWN, 'mine', -1],
        ['fraction', SHOWN, 'mine', 1.5],
        ['huge', SHOWN, 'mine', 2 ** 53],
        ['text', SHOWN, 'mine', '3'],
        // Not a hash: upper case.
        ['upper', SHOWN.toUpperCase(), 'mine', 1],
        // Extra parts.
        ['extra', SHOWN, 'mine', 1, 'more'],
      ]),
    );
    expect(parseShown(storage.getItem(KEY))).toEqual([['ok', SHOWN, 'mine', 0]]);
    for (const id of ['partial', 'hash-only', 'colon', 'long', 'empty', 'number', 'negative', 'fraction', 'huge', 'text', 'upper', 'extra']) {
      expect(shownFor(id, storage)).toBeNull();
    }
  });

  it('reads at most the newest rounds from storage, however many are there', () => {
    const many = Array.from({ length: MAX_SHOWN * 3 }, (_, n) => [`round-${n}`, SHOWN, 'mine', n]);
    const entries = parseShown(JSON.stringify(many));
    expect(entries).toHaveLength(MAX_SHOWN);
    expect(entries[0]).toEqual(['round-0', SHOWN, 'mine', 0]);
  });

  it('saves nothing for values not in a valid form: a round is never started on those', () => {
    const storage = new MemoryStorage();
    rememberShown('round-1', shown('hash'), storage);
    rememberShown('round-2', shown(SHOWN.toUpperCase()), storage);
    rememberShown('round-3', shown(SHOWN, 'player-seed​'), storage);
    rememberShown('round-4', shown(SHOWN, 'mine', -1), storage);
    rememberShown('', shown(SHOWN), storage);
    expect(storage.items.size).toBe(0);
  });

  it('knows a valid set of seeds', () => {
    expect(validSeeds(shown(SHOWN, 'mine', 0))).toBe(true);
    expect(validSeeds({ serverSeedHash: SHOWN, clientSeed: null, nonce: 0 })).toBe(false);
    expect(validSeeds({ serverSeedHash: SHOWN, clientSeed: 'mine', nonce: '0' })).toBe(false);
    expect(validSeeds({ serverSeedHash: SHOWN, clientSeed: 'mine​', nonce: 0 })).toBe(false);
    expect(validSeeds({ serverSeedHash: SHOWN.toUpperCase(), clientSeed: 'mine', nonce: 0 })).toBe(false);
  });
});

describe('starts on their way', () => {
  const start = (difficultyId: string, nonce: number) => ({
    difficultyId,
    betsCents: [100, 250],
    shown: shown(SHOWN, 'mine', nonce),
  });

  it('are kept newest first, at most a few, until forgotten', () => {
    const storage = new MemoryStorage();
    for (let n = 0; n < MAX_STARTING + 2; n += 1) rememberStarting(start('easy', n), storage);
    const kept = startsOnTheirWay(storage);
    expect(kept).toHaveLength(MAX_STARTING);
    expect(kept[0]).toEqual(start('easy', MAX_STARTING + 1));
    forgetStarting(storage);
    expect(startsOnTheirWay(storage)).toEqual([]);
  });

  it('ignore junk in storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STARTING_KEY,
      JSON.stringify([
        ['easy', [100], SHOWN, 'mine', 0],
        ['easy', [], SHOWN, 'mine', 0],
        ['easy', [-1], SHOWN, 'mine', 0],
        ['', [100], SHOWN, 'mine', 0],
        ['easy', [100], 'hash', 'mine', 0],
        ['easy', [100], SHOWN, 'a:b', 0],
        ['easy', [100], SHOWN, 'mine'],
        'junk',
      ]),
    );
    expect(startsOnTheirWay(storage)).toEqual([{ difficultyId: 'easy', betsCents: [100], shown: shown(SHOWN, 'mine', 0) }]);
    storage.setItem(STARTING_KEY, 'not json');
    expect(startsOnTheirWay(storage)).toEqual([]);
  });
});
