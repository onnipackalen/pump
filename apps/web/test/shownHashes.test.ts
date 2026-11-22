import { describe, expect, it } from 'vitest';
import type { VerifiableRound } from '../src/api/contract';
import { formFrom } from '../src/components/VerifyPage';
import {
  hashSource,
  hashVerdict,
  noRecordNote,
  recordHashProblem,
} from '../src/verify/hashCheck';
import {
  MAX_SHOWN_HASHES,
  parseShownHashes,
  rememberShown,
  shownFor,
  withShown,
  type HashStorage,
  type ShownSeeds,
} from '../src/verify/shownHashes';

const SHOWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const KEY = 'pump.shownSeedHashes';

/** What a screen showed before a round: a hash, a client seed and the next nonce. */
const shown = (serverSeedHash: string, clientSeed: string | null = 'player-seed', nonce: number | null = 4): ShownSeeds => ({
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

  it(`never holds more than ${MAX_SHOWN_HASHES} rounds in storage`, () => {
    const storage = new MemoryStorage();
    // The longest client seed and a large nonce, with the server's UUID round ids.
    const longest = shown(SHOWN, 'z'.repeat(64), 9_007_199_254_740_991);
    const id = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    for (let n = 0; n < MAX_SHOWN_HASHES + 20; n += 1) rememberShown(id(n), longest, storage);
    const saved = parseShownHashes(storage.getItem(KEY));
    expect(saved).toHaveLength(MAX_SHOWN_HASHES);
    expect(shownFor(id(MAX_SHOWN_HASHES + 19), storage)).toEqual(longest);
    expect(shownFor(id(0), storage)).toBeNull();
    // About 100 KB at most.
    expect(storage.getItem(KEY)?.length ?? 0).toBeLessThan(100_000);
  });

  it('never throws when storage is blocked or full: it just has no copy', () => {
    expect(() => rememberShown('round-1', shown(SHOWN), broken)).not.toThrow();
    expect(shownFor('round-1', broken)).toBeNull();
    expect(shownFor('round-1', null)).toBeNull();
  });

  it('still reads the older entries, which kept only the hash', () => {
    // Saved by the game before it kept client seeds and nonces.
    const storage = new MemoryStorage();
    storage.setItem(KEY, JSON.stringify([['old-round', SHOWN]]));
    expect(shownFor('old-round', storage)).toEqual({
      serverSeedHash: SHOWN,
      clientSeed: null,
      nonce: null,
    });
    // A new round is added in front, and the old entry stays as it was.
    rememberShown('new-round', shown(OTHER, 'mine', 3), storage);
    expect(parseShownHashes(storage.getItem(KEY))).toEqual([
      ['new-round', OTHER, 'mine', 3],
      ['old-round', SHOWN],
    ]);
    expect(shownFor('old-round', storage)?.clientSeed).toBeNull();
  });

  it('ignores anything in storage that is not a round id and a hash', () => {
    expect(parseShownHashes(null)).toEqual([]);
    expect(parseShownHashes('not json')).toEqual([]);
    expect(parseShownHashes('{"round-1":"x"}')).toEqual([]);
    expect(parseShownHashes('"text"')).toEqual([]);
    expect(
      parseShownHashes(
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
        ]),
      ),
    ).toEqual([['round-1', SHOWN]]);
  });

  it('keeps a client seed and nonce only as a valid pair, and the hash either way', () => {
    const entries = parseShownHashes(
      JSON.stringify([
        ['ok', SHOWN, 'mine', 0],
        // Partial: a seed with no nonce.
        ['partial', SHOWN, 'mine'],
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
        // Extra parts.
        ['extra', SHOWN, 'mine', 1, 'more'],
      ]),
    );
    expect(entries[0]).toEqual(['ok', SHOWN, 'mine', 0]);
    expect(entries.slice(1)).toEqual(
      ['partial', 'colon', 'long', 'empty', 'number', 'negative', 'fraction', 'huge', 'text', 'extra'].map(
        (id) => [id, SHOWN],
      ),
    );
  });

  it('reads at most the newest rounds from storage, however many are there', () => {
    const many = Array.from({ length: MAX_SHOWN_HASHES * 3 }, (_, n) => [`round-${n}`, SHOWN, 'mine', n]);
    const entries = parseShownHashes(JSON.stringify(many));
    expect(entries).toHaveLength(MAX_SHOWN_HASHES);
    expect(entries[0]).toEqual(['round-0', SHOWN, 'mine', 0]);
  });

  it('saves only a real hash: 64 lowercase hex characters', () => {
    const storage = new MemoryStorage();
    rememberShown('round-1', shown('hash'), storage);
    rememberShown('round-2', shown(SHOWN.toUpperCase()), storage);
    rememberShown('', shown(SHOWN), storage);
    expect(storage.items.size).toBe(0);
  });

  it('saves the hash alone when the client seed or nonce on screen is not a real one', () => {
    const storage = new MemoryStorage();
    rememberShown('no-seed', shown(SHOWN, null, null), storage);
    rememberShown('bad-seed', shown(SHOWN, 'a:b', 2), storage);
    rememberShown('bad-nonce', shown(SHOWN, 'mine', -1), storage);
    for (const id of ['no-seed', 'bad-seed', 'bad-nonce']) {
      expect(shownFor(id, storage)).toEqual({ serverSeedHash: SHOWN, clientSeed: null, nonce: null });
    }
  });
});

/** A finished round's record as the server sends it for checking. */
function record(serverSeedHash: string): VerifiableRound {
  return {
    id: 'round-1',
    difficultyId: 'easy',
    rtpBp: 9700,
    ladder: [101, 109],
    maxPayoutCents: 10_000_000,
    serverSeed: 'c'.repeat(64),
    serverSeedHash,
    clientSeed: 'seed',
    nonce: 0,
    finishedAt: '2026-11-20T00:00:00.000Z',
    balloons: [],
  };
}

describe('the verify page checks against this browser\'s copy of the hash', () => {
  it('fills the hash from this browser\'s copy, not the server\'s record', () => {
    // A server that lies sends a hash to match whatever seed it reveals.
    expect(formFrom(record(OTHER), SHOWN).serverSeedHash).toBe(SHOWN);
  });

  it('falls back to the server\'s record only when this browser has none, and says so plainly', () => {
    expect(formFrom(record(OTHER), null).serverSeedHash).toBe(OTHER);
    expect(noRecordNote(null)).toMatch(/no record/);
    expect(noRecordNote(null)).toMatch(/another device/);
    expect(noRecordNote(null)).toMatch(/cleared/);
    expect(noRecordNote(SHOWN)).toBeNull();
  });

  it('flags a server record that names another hash than this browser saved', () => {
    expect(recordHashProblem(SHOWN, OTHER)).toContain(SHOWN);
    expect(recordHashProblem(SHOWN, OTHER)).toContain(OTHER);
    expect(recordHashProblem(SHOWN, SHOWN)).toBeNull();
    expect(recordHashProblem(null, OTHER)).toBeNull();
  });

  it('says what a match proves, by where the hash came from', () => {
    expect(hashSource(SHOWN, SHOWN, OTHER)).toBe('browser');
    expect(hashSource(` ${SHOWN} `, SHOWN, OTHER)).toBe('browser');
    expect(hashSource(OTHER, null, OTHER)).toBe('server');
    // Typed over by the player, even to the server's value.
    expect(hashSource(OTHER, SHOWN, OTHER)).toBe('typed');
    expect(hashSource('abc', null, OTHER)).toBe('typed');

    expect(hashVerdict('browser', true)).toMatch(/^✓.*this browser showed you before the round/);
    expect(hashVerdict('browser', false)).toMatch(/^✗/);
    expect(hashVerdict('server', true)).toMatch(/^✓.*server’s record/);
    expect(hashVerdict('server', false)).toMatch(/^✗/);
    expect(hashVerdict('typed', true)).toMatch(/^✓.*typed/);
  });
});
