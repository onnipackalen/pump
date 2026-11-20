/**
 * The TypeScript draw code against the independent Python reference.
 *
 * reference/fair_reference.py is a second copy of the recipe in
 * docs/fairness.md, written in plain Python with no game code. It writes
 * reference/vectors.json: seed hashes, raw HMAC blocks and whole draws. This
 * file checks that the engine's public fair API gives exactly the same answer
 * for every entry, so two separate implementations of the recipe have to agree
 * before either can be trusted.
 *
 * Three layers are checked separately, so a mismatch points at one step:
 *
 *   seedHashes  SHA-256 of the server seed's 64 ASCII characters (the
 *               fingerprint a player sees before the seed is revealed)
 *   hmacBlocks  one HMAC-SHA256 block for one message (the mixing step)
 *   draws       the whole draw: message, HMAC blocks, words, rejection
 *               sampling, roll (every step together)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  drawRoll,
  hashServerSeed,
  hmacSha256,
  verifyServerSeedHash,
  type DrawInputs,
  type SampledRoll,
} from '@pump/engine/fair';

const VECTORS_PATH = fileURLToPath(new URL('./reference/vectors.json', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('./reference/fair_reference.py', import.meta.url));

// ---------------------------------------------------------------------------
// The shape of vectors.json
//
// JSON.parse gives back an untyped value, so it is checked field by field
// before any test uses it. Each object must have exactly the keys listed, no
// more and no fewer: if the Python script starts writing a new field, this
// test fails and the new field gets looked at instead of being silently
// ignored.
// ---------------------------------------------------------------------------

/** One server seed and the SHA-256 hash the reference computed for it. */
interface SeedHashVector {
  readonly serverSeed: string;
  readonly hash: string;
}

/** One HMAC-SHA256 block: key = server seed, data = message, as lowercase hex. */
interface HmacVector {
  readonly serverSeed: string;
  readonly message: string;
  readonly hex: string;
}

/** One whole draw: the inputs and den, then where the reference found the roll. */
interface DrawVector {
  readonly serverSeed: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly balloonIndex: number;
  readonly drawIndex: number;
  readonly den: number;
  readonly roll: number;
  readonly block: number;
  readonly wordIndex: number;
  readonly word: number;
}

interface ReferenceVectors {
  readonly about: string;
  readonly seedHashes: readonly SeedHashVector[];
  readonly hmacBlocks: readonly HmacVector[];
  readonly draws: readonly DrawVector[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * A whole number from 0 up to 2^53 - 1. Every number in the vectors must be a
 * safe integer: JSON.parse rounds a bigger one to the nearest double, and a
 * rounded value lands at 2^53 or above, so it fails here instead of quietly
 * comparing the wrong number.
 */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isArrayOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item: unknown) => isItem(item));
}

function isSeedHashVector(value: unknown): value is SeedHashVector {
  return (
    isObject(value) &&
    hasExactKeys(value, ['serverSeed', 'hash']) &&
    isString(value.serverSeed) &&
    isString(value.hash)
  );
}

function isHmacVector(value: unknown): value is HmacVector {
  return (
    isObject(value) &&
    hasExactKeys(value, ['serverSeed', 'message', 'hex']) &&
    isString(value.serverSeed) &&
    isString(value.message) &&
    isString(value.hex)
  );
}

const DRAW_COUNT_KEYS = [
  'nonce',
  'balloonIndex',
  'drawIndex',
  'den',
  'roll',
  'block',
  'wordIndex',
  'word',
] as const;

function isDrawVector(value: unknown): value is DrawVector {
  return (
    isObject(value) &&
    hasExactKeys(value, ['serverSeed', 'clientSeed', ...DRAW_COUNT_KEYS]) &&
    isString(value.serverSeed) &&
    isString(value.clientSeed) &&
    DRAW_COUNT_KEYS.every((key) => isCount(value[key]))
  );
}

function isReferenceVectors(value: unknown): value is ReferenceVectors {
  return (
    isObject(value) &&
    hasExactKeys(value, ['about', 'seedHashes', 'hmacBlocks', 'draws']) &&
    isString(value.about) &&
    isArrayOf(value.seedHashes, isSeedHashVector) &&
    isArrayOf(value.hmacBlocks, isHmacVector) &&
    isArrayOf(value.draws, isDrawVector)
  );
}

const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

/** The vectors, once their shape is known to be right. */
function vectors(): ReferenceVectors {
  if (!isReferenceVectors(parsed)) {
    throw new Error(`${VECTORS_PATH} does not have the shape this test expects`);
  }
  return parsed;
}

/**
 * Runs `fn`. If it throws, the error becomes a value to compare instead, so one
 * entry that throws is reported next to the others rather than stopping the
 * loop and hiding them.
 */
function orThrown<T>(fn: () => T): T | { readonly threw: string } {
  try {
    return fn();
  } catch (error) {
    return { threw: error instanceof Error ? error.message : 'a value that is not an Error' };
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe('the engine agrees with the Python reference on every vector', () => {
  it('reads vectors.json with the expected shape', () => {
    expect(isReferenceVectors(parsed)).toBe(true);
  });

  it('hashServerSeed gives the reference hash for every seed', () => {
    const { seedHashes } = vectors();
    expect(seedHashes.length).toBeGreaterThan(0);
    for (const [i, v] of seedHashes.entries()) {
      expect.soft(orThrown(() => hashServerSeed(v.serverSeed)), `seedHashes[${i}]`).toBe(v.hash);
      // The same pair, through the check a player runs after rotating.
      expect.soft(verifyServerSeedHash(v.serverSeed, v.hash), `seedHashes[${i}] verify`).toBe(true);
    }
  });

  it('hmacSha256 gives the reference bytes for every block', () => {
    const { hmacBlocks } = vectors();
    expect(hmacBlocks.length).toBeGreaterThan(0);
    for (const [i, v] of hmacBlocks.entries()) {
      const hex = orThrown(() => bytesToHex(hmacSha256(v.serverSeed, v.message)));
      expect.soft(hex, `hmacBlocks[${i}] ${v.message}`).toBe(v.hex);
    }
  });

  it('drawRoll gives the same roll, block, wordIndex and word for every draw', () => {
    const { draws } = vectors();
    expect(draws.length).toBeGreaterThan(0);
    for (const [i, v] of draws.entries()) {
      const inputs: DrawInputs = {
        serverSeed: v.serverSeed,
        clientSeed: v.clientSeed,
        nonce: v.nonce,
        balloonIndex: v.balloonIndex,
        drawIndex: v.drawIndex,
      };
      const want: SampledRoll = { roll: v.roll, block: v.block, wordIndex: v.wordIndex, word: v.word };
      const label = `draws[${i}] ${v.clientSeed}:${v.nonce}:${v.balloonIndex}:${v.drawIndex} den ${v.den}`;
      expect.soft(orThrown(() => drawRoll(inputs, v.den)), label).toEqual(want);
    }
  });
});

/**
 * Agreeing on easy draws proves little: almost every draw takes word 0 of
 * block 0. The paths most likely to hide a bug are the rare ones, where words
 * are rejected and the sampler has to move on. These checks make sure the
 * vectors keep exercising them, so a future regeneration of vectors.json can't
 * quietly drop them and still pass.
 */
describe('vectors.json covers the hard paths', () => {
  /** At least this many draws must have needed block 1 (all 8 words of block 0 rejected). */
  const MIN_BLOCK_ONE = 5;
  /** At least this many draws must have needed block 2 or later (16+ words rejected). */
  const MIN_BLOCK_TWO_PLUS = 1;
  /** At least this many draws must have kept a word at index 3 or later inside its block. */
  const MIN_LATE_WORD = 5;

  it('starts with the worked example from docs/fairness.md', () => {
    // Ties the vectors to the numbers written in the docs, not only to the script.
    expect(vectors().draws[0]).toEqual({
      serverSeed: 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14',
      clientSeed: 'myseed',
      nonce: 5,
      balloonIndex: 0,
      drawIndex: 0,
      den: 101,
      roll: 69,
      block: 0,
      wordIndex: 0,
      word: 3308196994,
    });
  });

  it('has draws that read block 1 and block 2 or later', () => {
    const { draws } = vectors();
    expect(draws.filter((v) => v.block === 1).length).toBeGreaterThanOrEqual(MIN_BLOCK_ONE);
    expect(draws.filter((v) => v.block >= 2).length).toBeGreaterThanOrEqual(MIN_BLOCK_TWO_PLUS);
  });

  it('has draws that kept a late word, and a kept word at every index 0 to 7', () => {
    const { draws } = vectors();
    expect(draws.filter((v) => v.wordIndex >= 3).length).toBeGreaterThanOrEqual(MIN_LATE_WORD);
    expect([...new Set(draws.map((v) => v.wordIndex))].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('has the number edges: the largest safe nonce, and den 1 and 2^32', () => {
    // 2^53 - 1 is the largest nonce a JavaScript number holds exactly. den 1
    // and den 2^32 are the two ends of the legal range, where no word is ever
    // rejected.
    const { draws } = vectors();
    expect(draws.some((v) => v.nonce === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(draws.some((v) => v.den === 1)).toBe(true);
    expect(draws.some((v) => v.den === 2 ** 32)).toBe(true);
  });

  it('has a seed hash for every seed the HMAC blocks and draws use', () => {
    const { seedHashes, hmacBlocks, draws } = vectors();
    const hashed = new Set(seedHashes.map((v) => v.serverSeed));
    const used = [...hmacBlocks, ...draws].map((v) => v.serverSeed);
    expect(used.filter((seed) => !hashed.has(seed))).toEqual([]);
  });
});

// The reference script rebuilds the vectors in memory and, with --check,
// exits non-zero if the committed vectors.json differs. This proves the file
// is exactly what the script makes, not something edited by hand.
//
// It needs python3 on PATH. Some machines and CI images don't have it, so the
// test is skipped (not failed) there. The vector checks above still run
// without Python, because they only read the committed JSON.
const hasPython3 = spawnSync('python3', ['--version']).status === 0;

describe('the Python reference itself', () => {
  it.skipIf(!hasPython3)(
    'python3 -I fair_reference.py --check exits 0 (vectors.json is exactly what the script makes)',
    () => {
      // -I runs Python isolated: no user site-packages, no PYTHON* variables,
      // and the current folder is not on the import path.
      const result = spawnSync('python3', ['-I', SCRIPT_PATH, '--check'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
    60_000,
  );
});
