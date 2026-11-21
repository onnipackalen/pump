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
  rememberShownHash,
  shownHashFor,
  withShownHash,
  type HashStorage,
} from '../src/verify/shownHashes';

const SHOWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

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

describe('the hash shown before each round, kept in this browser', () => {
  it('is found again by round id', () => {
    const storage = new MemoryStorage();
    rememberShownHash('round-1', SHOWN, storage);
    rememberShownHash('round-2', OTHER, storage);
    expect(shownHashFor('round-1', storage)).toBe(SHOWN);
    expect(shownHashFor('round-2', storage)).toBe(OTHER);
    expect(shownHashFor('round-3', storage)).toBeNull();
  });

  it('keeps only the newest rounds, so it stays small', () => {
    let list = withShownHash([], 'r0', SHOWN, 3);
    for (const id of ['r1', 'r2', 'r3']) list = withShownHash(list, id, SHOWN, 3);
    expect(list.map(([id]) => id)).toEqual(['r3', 'r2', 'r1']);
    // Saving a round again moves it to the front instead of adding it twice.
    expect(withShownHash(list, 'r1', OTHER, 3)).toEqual([
      ['r1', OTHER],
      ['r3', SHOWN],
      ['r2', SHOWN],
    ]);
  });

  it(`never holds more than ${MAX_SHOWN_HASHES} rounds in storage`, () => {
    const storage = new MemoryStorage();
    for (let n = 0; n < MAX_SHOWN_HASHES + 20; n += 1) rememberShownHash(`round-${n}`, SHOWN, storage);
    const saved = parseShownHashes(storage.getItem('pump.shownSeedHashes'));
    expect(saved).toHaveLength(MAX_SHOWN_HASHES);
    expect(shownHashFor(`round-${MAX_SHOWN_HASHES + 19}`, storage)).toBe(SHOWN);
    expect(shownHashFor('round-0', storage)).toBeNull();
    // About 55 KB at most.
    expect(storage.getItem('pump.shownSeedHashes')?.length ?? 0).toBeLessThan(60_000);
  });

  it('never throws when storage is blocked or full: it just has no record', () => {
    expect(() => rememberShownHash('round-1', SHOWN, broken)).not.toThrow();
    expect(shownHashFor('round-1', broken)).toBeNull();
    expect(shownHashFor('round-1', null)).toBeNull();
  });

  it('ignores anything in storage that is not a round id and a hash', () => {
    expect(parseShownHashes(null)).toEqual([]);
    expect(parseShownHashes('not json')).toEqual([]);
    expect(parseShownHashes('{"round-1":"x"}')).toEqual([]);
    expect(
      parseShownHashes(JSON.stringify([['round-1', SHOWN], ['round-2', 'XYZ'], [7, SHOWN], ['round-3']])),
    ).toEqual([['round-1', SHOWN]]);
  });

  it('saves only a real hash: 64 lowercase hex characters', () => {
    const storage = new MemoryStorage();
    rememberShownHash('round-1', 'hash', storage);
    rememberShownHash('round-2', SHOWN.toUpperCase(), storage);
    rememberShownHash('', SHOWN, storage);
    expect(storage.items.size).toBe(0);
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
