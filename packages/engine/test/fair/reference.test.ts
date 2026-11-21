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
 * Four layers are checked separately, so a mismatch points at one step:
 *
 *   seedHashes  SHA-256 of the server seed's 64 ASCII characters (the
 *               fingerprint a player sees before the seed is revealed)
 *   hmacBlocks  one HMAC-SHA256 block for one message (the mixing step)
 *   draws       the whole draw: message, HMAC blocks, words, rejection
 *               sampling, roll (every step together)
 *   reveals     where a balloon cashed out below its top would have popped,
 *               once its round is over: its top rung after the payout cap,
 *               then plain pumps from its draw count until one pops or it
 *               reaches the top (the engine's revealAfterCashOut)
 *
 * Each reveal carries its own RTP, ladder, bet and payout cap, as a stored
 * round does, so nothing here reads the live config.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cashOutCents,
  revealAfterCashOut,
  topRungForBet,
  type Balloon,
  type RevealOutcome,
  type Round,
} from '@pump/engine';
import {
  bytesToHex,
  drawRoll,
  hashServerSeed,
  hmacSha256,
  revealDrawerFor,
  verifyServerSeedHash,
  type DrawInputs,
  type SampledRoll,
} from '@pump/engine/fair';
import { fixedLadder } from '../fixtures';

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

/** One draw of a reveal, in the engine's DrawRecord shape. */
interface RevealDrawVector {
  readonly drawIndex: number;
  readonly den: number;
  readonly num: number;
  readonly roll: number;
}

/**
 * One reveal: a balloon as it ended (cashed on `rung` with `drawIndex` draws
 * used, below `topRung`), the round it was in, and where the reference says
 * it would have popped.
 */
interface RevealVector {
  readonly serverSeed: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly balloonIndex: number;
  readonly rtpBp: number;
  readonly ladder: readonly number[];
  readonly betCents: number;
  readonly maxPayoutCents: number;
  readonly topRung: number;
  readonly rung: number;
  readonly drawIndex: number;
  readonly outcome: RevealOutcome;
  readonly reachedRung: number;
  readonly draws: readonly RevealDrawVector[];
}

interface ReferenceVectors {
  readonly about: string;
  readonly seedHashes: readonly SeedHashVector[];
  readonly hmacBlocks: readonly HmacVector[];
  readonly draws: readonly DrawVector[];
  readonly reveals: readonly RevealVector[];
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

const REVEAL_DRAW_KEYS = ['drawIndex', 'den', 'num', 'roll'] as const;

function isRevealDrawVector(value: unknown): value is RevealDrawVector {
  return (
    isObject(value) &&
    hasExactKeys(value, REVEAL_DRAW_KEYS) &&
    REVEAL_DRAW_KEYS.every((key) => isCount(value[key]))
  );
}

const REVEAL_COUNT_KEYS = [
  'nonce',
  'balloonIndex',
  'rtpBp',
  'betCents',
  'maxPayoutCents',
  'topRung',
  'rung',
  'drawIndex',
  'reachedRung',
] as const;

const isRevealOutcome = (value: unknown): value is RevealOutcome =>
  value === 'popped' || value === 'top';

function isRevealVector(value: unknown): value is RevealVector {
  return (
    isObject(value) &&
    hasExactKeys(value, [
      'serverSeed',
      'clientSeed',
      'ladder',
      'outcome',
      'draws',
      ...REVEAL_COUNT_KEYS,
    ]) &&
    isString(value.serverSeed) &&
    isString(value.clientSeed) &&
    REVEAL_COUNT_KEYS.every((key) => isCount(value[key])) &&
    isArrayOf(value.ladder, isCount) &&
    isRevealOutcome(value.outcome) &&
    isArrayOf(value.draws, isRevealDrawVector)
  );
}

function isReferenceVectors(value: unknown): value is ReferenceVectors {
  return (
    isObject(value) &&
    hasExactKeys(value, ['about', 'seedHashes', 'hmacBlocks', 'draws', 'reveals']) &&
    isString(value.about) &&
    isArrayOf(value.seedHashes, isSeedHashVector) &&
    isArrayOf(value.hmacBlocks, isHmacVector) &&
    isArrayOf(value.draws, isDrawVector) &&
    isArrayOf(value.reveals, isRevealVector)
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

/**
 * The finished round a reveal vector describes, built from the vector's own
 * RTP and ladder (never the config). The cashed balloon sits at its balloon
 * index. Every other balloon popped on its first pump: it only has to be
 * over, so the round is over, and its draws use another balloon index.
 * Patch spending plays no part in a reveal, so it is left at 0.
 */
function finishedRound(v: RevealVector): Round {
  const cashed: Balloon = {
    betCents: v.betCents,
    status: 'cashed',
    rung: v.rung,
    drawIndex: v.drawIndex,
    topRung: v.topRung,
    patchesCents: 0,
    payoutCents: cashOutCents(v.betCents, v.ladder, v.rung),
  };
  const popped: Balloon = {
    ...cashed,
    status: 'popped',
    rung: 0,
    drawIndex: 1,
    payoutCents: 0,
  };
  return {
    difficultyId: 'reference',
    rtpBp: v.rtpBp,
    ladder: v.ladder,
    balloons: Array.from({ length: v.balloonIndex + 1 }, (_, i) =>
      i === v.balloonIndex ? cashed : popped,
    ),
  };
}

const revealLabel = (i: number, v: RevealVector): string =>
  `reveals[${String(i)}] ${v.clientSeed}:${String(v.nonce)}:${String(v.balloonIndex)} ` +
  `rung ${String(v.rung)} draws ${String(v.drawIndex)} top ${String(v.topRung)} RTP ${String(v.rtpBp)}`;

/** A reveal's balloon and round, without its RTP. The RTP must not change a reveal. */
const endState = (v: RevealVector): string =>
  JSON.stringify([
    v.serverSeed,
    v.clientSeed,
    v.nonce,
    v.balloonIndex,
    v.ladder,
    v.betCents,
    v.maxPayoutCents,
    v.rung,
    v.drawIndex,
  ]);

const RTPS = [9400, 9700, 9900] as const;

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

  it('drawRoll gives the roll of every reveal draw', () => {
    // The bytes alone, so a mismatch here points at the draw, not the rules.
    const { reveals } = vectors();
    expect(reveals.length).toBeGreaterThan(0);
    for (const [i, v] of reveals.entries()) {
      for (const d of v.draws) {
        const inputs: DrawInputs = {
          serverSeed: v.serverSeed,
          clientSeed: v.clientSeed,
          nonce: v.nonce,
          balloonIndex: v.balloonIndex,
          drawIndex: d.drawIndex,
        };
        const roll = orThrown(() => drawRoll(inputs, d.den).roll);
        expect.soft(roll, `${revealLabel(i, v)} draw ${String(d.drawIndex)}`).toBe(d.roll);
      }
    }
  });

  it('topRungForBet gives the reference top rung for every reveal', () => {
    const { reveals } = vectors();
    for (const [i, v] of reveals.entries()) {
      const top = orThrown(() => topRungForBet(v.ladder, v.betCents, v.maxPayoutCents));
      expect.soft(top, revealLabel(i, v)).toBe(v.topRung);
    }
  });

  it('revealAfterCashOut gives the reference reveal for every cashed balloon', () => {
    // Through revealDrawerFor, as the server does: it throws if the engine
    // asks for any draw index but the next one from the balloon's draw count.
    const { reveals } = vectors();
    for (const [i, v] of reveals.entries()) {
      const drawAt = revealDrawerFor({
        serverSeed: v.serverSeed,
        clientSeed: v.clientSeed,
        nonce: v.nonce,
        balloonIndex: v.balloonIndex,
        drawIndex: v.drawIndex,
      });
      const got = orThrown(() => revealAfterCashOut(finishedRound(v), v.balloonIndex, drawAt));
      const want = {
        outcome: v.outcome,
        reachedRung: v.reachedRung,
        draws: v.draws,
      };
      expect.soft(got, revealLabel(i, v)).toEqual(want);
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

  it('has a seed hash for every seed the HMAC blocks, draws and reveals use', () => {
    const { seedHashes, hmacBlocks, draws, reveals } = vectors();
    const hashed = new Set(seedHashes.map((v) => v.serverSeed));
    const used = [...hmacBlocks, ...draws, ...reveals].map((v) => v.serverSeed);
    expect(used.filter((seed) => !hashed.has(seed))).toEqual([]);
  });
});

/**
 * The reveal cases most likely to hide a bug: starting at the rung instead of
 * the draw count, running past a top the payout cap set, an off-by-one at the
 * last rung, and letting the RTP leak in. The minimums match the Python
 * script's own coverage check.
 */
describe('vectors.json covers the hard reveal cases', () => {
  const DOCS_SEED = 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14';

  it('starts with the two reveal examples from docs/fairness.md', () => {
    const { reveals } = vectors();
    // A reveal after a Patch save: rung 1, but two draws used, so it starts
    // at draw index 2.
    expect(reveals[0]).toEqual({
      serverSeed: DOCS_SEED,
      clientSeed: 'myseed',
      nonce: 338,
      balloonIndex: 0,
      rtpBp: 9700,
      ladder: fixedLadder('easy'),
      betCents: 1000,
      maxPayoutCents: 10_000_000,
      topRung: 24,
      rung: 1,
      drawIndex: 2,
      outcome: 'popped',
      reachedRung: 3,
      draws: [
        { drawIndex: 2, den: 111, num: 101, roll: 57 },
        { drawIndex: 3, den: 41, num: 37, roll: 36 },
        { drawIndex: 4, den: 137, num: 123, roll: 134 },
      ],
    });
    // A reveal stopped by the payout cap: $1,000 on Expert tops out at rung 6.
    expect(reveals[1]).toEqual({
      serverSeed: DOCS_SEED,
      clientSeed: 'myseed',
      nonce: 83,
      balloonIndex: 0,
      rtpBp: 9700,
      ladder: fixedLadder('expert'),
      betCents: 100_000,
      maxPayoutCents: 10_000_000,
      topRung: 6,
      rung: 5,
      drawIndex: 5,
      outcome: 'top',
      reachedRung: 6,
      draws: [{ drawIndex: 5, den: 19, num: 8, roll: 6 }],
    });
  });

  it('has reveals that reach the top after 2+ draws, pop after 3+, and pop at once', () => {
    const { reveals } = vectors();
    const top = reveals.filter((v) => v.outcome === 'top' && v.draws.length >= 2);
    const longPop = reveals.filter((v) => v.outcome === 'popped' && v.draws.length >= 3);
    const atOnce = reveals.filter((v) => v.outcome === 'popped' && v.draws.length === 1);
    expect(top.length).toBeGreaterThanOrEqual(3);
    expect(longPop.length).toBeGreaterThanOrEqual(5);
    expect(atOnce.length).toBeGreaterThanOrEqual(3);
  });

  it('has Patch-saved balloons, whose draw count is above their rung', () => {
    const { reveals } = vectors();
    expect(reveals.filter((v) => v.drawIndex > v.rung).length).toBeGreaterThanOrEqual(5);
  });

  it('has balloons cashed one rung below their top, with both outcomes', () => {
    const { reveals } = vectors();
    const lastRung = reveals.filter((v) => v.rung === v.topRung - 1);
    expect(lastRung.filter((v) => v.outcome === 'top').length).toBeGreaterThanOrEqual(2);
    expect(lastRung.filter((v) => v.outcome === 'popped').length).toBeGreaterThanOrEqual(2);
  });

  it('has tops set by the payout cap, one exactly at the cap, and another cap', () => {
    const { reveals } = vectors();
    expect(reveals.filter((v) => v.topRung < v.ladder.length).length).toBeGreaterThanOrEqual(5);
    const atCap = reveals.filter(
      (v) => v.betCents * (v.ladder[v.topRung - 1] ?? 0) === v.maxPayoutCents * 100,
    );
    expect(atCap.length).toBeGreaterThanOrEqual(1);
    expect(reveals.some((v) => v.maxPayoutCents !== 10_000_000)).toBe(true);
  });

  it('never draws past the top, and every draw but a last pop moves up a rung', () => {
    const { reveals } = vectors();
    for (const [i, v] of reveals.entries()) {
      const label = revealLabel(i, v);
      expect.soft(v.draws.length, label).toBeLessThanOrEqual(v.topRung - v.rung);
      const indexes = v.draws.map((d) => d.drawIndex);
      expect.soft(indexes, label).toEqual(indexes.map((_, k) => v.drawIndex + k));
      const climbed = v.draws.length - (v.outcome === 'popped' ? 1 : 0);
      expect.soft(v.reachedRung, label).toBe(v.rung + climbed);
    }
  });

  it('has every balloon index, the largest safe nonce and a made-up ladder', () => {
    const { reveals } = vectors();
    expect([...new Set(reveals.map((v) => v.balloonIndex))].sort()).toEqual([0, 1, 2]);
    expect(reveals.some((v) => v.nonce === Number.MAX_SAFE_INTEGER)).toBe(true);
    const shipped = ['easy', 'medium', 'hard', 'expert'].map((id) =>
      JSON.stringify(fixedLadder(id)),
    );
    expect(reveals.some((v) => !shipped.includes(JSON.stringify(v.ladder)))).toBe(true);
  });

  it.each(RTPS)(
    'has reveals at RTP %i, each the same as its end state at the other RTPs',
    (rtpBp) => {
      // A cash-out needs rung 1, so a reveal's first pump is pump 2 or later and
      // the RTP never enters: the same balloon gives the same reveal at any RTP.
      const { reveals } = vectors();
      const atRtp = reveals.filter((v) => v.rtpBp === rtpBp);
      expect(atRtp.length).toBeGreaterThanOrEqual(5);
      const others = reveals.filter((v) => v.rtpBp !== rtpBp);
      let shared = 0;
      for (const v of atRtp) {
        for (const o of others.filter((x) => endState(x) === endState(v))) {
          shared += 1;
          expect
            .soft({
              outcome: o.outcome,
              reachedRung: o.reachedRung,
              draws: o.draws,
            })
            .toEqual({
              outcome: v.outcome,
              reachedRung: v.reachedRung,
              draws: v.draws,
            });
        }
      }
      // Each RTP shares at least 5 end states with each of the other two.
      expect(shared).toBeGreaterThanOrEqual(10);
    },
  );
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
