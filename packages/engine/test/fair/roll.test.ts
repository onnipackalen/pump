import { describe, expect, it } from 'vitest';
import {
  acceptanceLimit,
  BLOCK_BYTES,
  MAX_BLOCKS,
  readWords,
  rollFromWord,
  sampleRoll,
  WORD_SPACE,
  WORDS_PER_BLOCK,
  type BlockSource,
} from '../../src/fair/roll';

const S = 2 ** 32;

/**
 * A 32-byte block holding the given words, big-endian. Built with Node's
 * Buffer, not with the code under test, so the two check each other.
 */
function blockOf(words: readonly number[]): Uint8Array {
  if (words.length !== 8) throw new Error('a block has 8 words');
  const buffer = Buffer.alloc(32);
  words.forEach((word, i) => buffer.writeUInt32BE(word, i * 4));
  return new Uint8Array(buffer);
}

const ALL_FF = new Uint8Array(32).fill(0xff);
const ALL_ZERO = new Uint8Array(32);

/** A block source that serves fixed blocks and records which were asked for. */
function fakeSource(blocks: readonly Uint8Array[]): { source: BlockSource; asked: number[] } {
  const asked: number[] = [];
  const source: BlockSource = (block) => {
    asked.push(block);
    const bytes = blocks[block];
    if (!bytes) throw new Error(`test source has no block ${block}`);
    return bytes;
  };
  return { source, asked };
}

describe('constants', () => {
  it('describe 32-byte blocks of eight 32-bit words, capped at 1024 blocks', () => {
    expect(WORD_SPACE).toBe(4294967296);
    expect(BLOCK_BYTES).toBe(32);
    expect(WORDS_PER_BLOCK).toBe(8);
    expect(MAX_BLOCKS).toBe(1024);
  });
});

describe('readWords', () => {
  it('reads big-endian, unsigned', () => {
    const block = new Uint8Array(32);
    block.set([0xff, 0xff, 0xff, 0xff], 0);
    block.set([0x80, 0x00, 0x00, 0x00], 4);
    block.set([0x00, 0x00, 0x00, 0x01], 8);
    block.set([0x01, 0x02, 0x03, 0x04], 12);
    block.set([0x7f, 0xff, 0xff, 0xff], 16);
    block.set([0x00, 0x00, 0x01, 0x00], 20);
    expect(readWords(block)).toEqual([
      4294967295, 2147483648, 1, 0x01020304, 2147483647, 256, 0, 0,
    ]);
  });

  it('gives the 8 numbers of the docs example', () => {
    const block = new Uint8Array(
      Buffer.from('c52f148266db67d40e90cea0680eb6be927163f2e35acd8df0df73aff0921b4a', 'hex'),
    );
    expect(readWords(block)).toEqual([
      3308196994, 1725654996, 244371104, 1745794750, 2456904690, 3814378893, 4041175983,
      4036107082,
    ]);
  });

  it('agrees with Node readUInt32BE on 1,000 pseudo-random blocks', () => {
    // xorshift32: integer-only test input, nothing in the game uses it.
    let state = 12345;
    for (let n = 0; n < 1000; n++) {
      const block = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        block[i] = state & 0xff;
      }
      const node = Buffer.from(block);
      const expected = Array.from({ length: 8 }, (_, i) => node.readUInt32BE(i * 4));
      expect(readWords(block)).toEqual(expected);
    }
  });

  it.each([0, 1, 31, 33, 64])('rejects a block of %i bytes', (length) => {
    expect(() => readWords(new Uint8Array(length))).toThrow(
      `A draw block must be exactly 32 bytes, got ${length}.`,
    );
  });
});

/**
 * The counting proof. For a word space S small enough to list every word, run
 * every word through the real acceptance rule and count what comes out. If
 * each roll appears exactly floor(S / den) times, the roll is exactly uniform
 * over accepted words. Nothing about 2^32 is special: the rule only uses
 * S mod den, so the same argument holds there.
 */
describe.each([256, 4096])('counting every word in a word space of %i', (space) => {
  it('every den from 1 to S: each roll exactly floor(S/den) times, S mod den rejected', () => {
    const failures: string[] = [];
    for (let den = 1; den <= space; den++) {
      const counts = new Array<number>(den).fill(0);
      let rejected = 0;
      let lowestRejected = space;
      for (let word = 0; word < space; word++) {
        const roll = rollFromWord(word, den, space);
        if (roll === undefined) {
          rejected++;
          lowestRejected = Math.min(lowestRejected, word);
        } else {
          counts[roll] = (counts[roll] ?? 0) + 1;
        }
      }
      const each = Math.floor(space / den);
      const leftover = space % den;
      if (counts.some((count) => count !== each)) failures.push(`den ${den}: uneven counts`);
      if (rejected !== leftover) failures.push(`den ${den}: rejected ${rejected}, not ${leftover}`);
      // The rejected words are exactly the top `leftover` ones.
      if (lowestRejected !== space - leftover) failures.push(`den ${den}: wrong words rejected`);
      if (acceptanceLimit(den, space) !== space - leftover) failures.push(`den ${den}: limit`);
      // Fewer than half of all words are rejected (the MAX_BLOCKS argument).
      if (2 * rejected >= space) failures.push(`den ${den}: rejects half or more`);
    }
    expect(failures).toEqual([]);
  });
});

describe('the acceptance rule at S = 2^32', () => {
  it('den 101: limit is 4294967228, as in the docs', () => {
    expect(S % 101).toBe(68);
    expect(acceptanceLimit(101)).toBe(4294967228);
    expect(acceptanceLimit(101, S)).toBe(4294967228);
  });

  it('den 101: the word just below the limit is accepted as roll 100', () => {
    expect(rollFromWord(4294967227, 101)).toBe(100);
  });

  it('den 101: the limit itself and the top word are rejected', () => {
    expect(rollFromWord(4294967228, 101)).toBeUndefined();
    expect(rollFromWord(S - 1, 101)).toBeUndefined();
  });

  it('den 101: the docs word 3308196994 gives roll 69', () => {
    expect(rollFromWord(3308196994, 101)).toBe(69);
  });

  it.each([4, 2 ** 31, 2 ** 32])('den %i (a power of two) rejects nothing', (den) => {
    expect(acceptanceLimit(den)).toBe(S);
    expect(rollFromWord(S - 1, den)).toBe((S - 1) % den);
    expect(rollFromWord(0, den)).toBe(0);
  });

  it('den 1 always gives roll 0 and rejects nothing', () => {
    expect(acceptanceLimit(1)).toBe(S);
    for (const word of [0, 1, 101, 2 ** 31, S - 1]) expect(rollFromWord(word, 1)).toBe(0);
  });

  it('den 2^32 gives roll = word', () => {
    for (const word of [0, 1, 3308196994, 2 ** 31, S - 1]) {
      expect(rollFromWord(word, 2 ** 32)).toBe(word);
    }
  });

  it('den 3: limit 4294967295, so only the top word is rejected', () => {
    expect(acceptanceLimit(3)).toBe(4294967295);
    expect(rollFromWord(S - 2, 3)).toBe((S - 2) % 3);
    expect(rollFromWord(S - 1, 3)).toBeUndefined();
  });

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2^32 + 1', 2 ** 32 + 1],
  ])('rejects a den that is %s', (_label, den) => {
    expect(() => acceptanceLimit(den)).toThrow(/^Denominator must be a whole number from 1 to/);
    expect(() => rollFromWord(0, den)).toThrow(/^Denominator must be a whole number from 1 to/);
  });

  it('rejects a den above a smaller word space', () => {
    expect(() => acceptanceLimit(257, 256)).toThrow(
      'Denominator must be a whole number from 1 to 256, got 257.',
    );
  });

  // Not numbers at all: the message must name the type, not say "got 101".
  it.each([
    ['a numeric string', '101', 'a string'],
    ['a bigint', 101n, 'a bigint (101n)'],
    ['an array', [101], 'an array'],
    ['null', null, 'null'],
  ])('rejects a den that is %s and names its type', (_label, den, described) => {
    const message = `Denominator must be a whole number from 1 to 4294967296, got ${described}.`;
    const bad = den as unknown as number;
    expect(() => acceptanceLimit(bad)).toThrow(message);
    expect(() => rollFromWord(0, bad)).toThrow(message);
    expect(() => sampleRoll(fakeSource([ALL_ZERO]).source, bad)).toThrow(message);
  });

  it('rejects a word or word space that is not a number, and names its type', () => {
    expect(() => rollFromWord('7' as unknown as number, 101)).toThrow(
      'Word must be a whole number from 0 to 4294967295, got a string.',
    );
    expect(() => rollFromWord(7n as unknown as number, 101)).toThrow(
      'Word must be a whole number from 0 to 4294967295, got a bigint (7n).',
    );
    expect(() => acceptanceLimit(1, '256' as unknown as number)).toThrow(
      'Word space must be a whole number from 1 to 2^32, got a string.',
    );
  });

  it.each([-1, 1.5, Number.NaN, S, S + 1])('rejects the word %d', (word) => {
    expect(() => rollFromWord(word, 101)).toThrow(/^Word must be a whole number from 0 to/);
  });

  it.each([0, -1, 1.5, S + 1, Number.NaN])('rejects the word space %d', (space) => {
    expect(() => acceptanceLimit(1, space)).toThrow(/^Word space must be a whole number/);
  });
});

describe('sampleRoll', () => {
  it('takes the first word of block 0 when it is accepted, and reads nothing more', () => {
    const { source, asked } = fakeSource([blockOf([3308196994, 0, 0, 0, 0, 0, 0, 0])]);
    expect(sampleRoll(source, 101)).toEqual({ roll: 69, block: 0, wordIndex: 0, word: 3308196994 });
    expect(asked).toEqual([0]);
  });

  it('skips rejected words inside a block: first 3 rejected gives wordIndex 3', () => {
    const top = S - 1;
    const { source, asked } = fakeSource([blockOf([top, top, 4294967228, 202, 5, 6, 7, 8])]);
    expect(sampleRoll(source, 101)).toEqual({ roll: 0, block: 0, wordIndex: 3, word: 202 });
    expect(asked).toEqual([0]);
  });

  it('block 0 all 0xff with den 101 forces block 1', () => {
    const { source, asked } = fakeSource([ALL_FF, blockOf([1234, 0, 0, 0, 0, 0, 0, 0])]);
    expect(sampleRoll(source, 101)).toEqual({ roll: 22, block: 1, wordIndex: 0, word: 1234 });
    expect(asked).toEqual([0, 1]);
  });

  it('blocks 0 and 1 all 0xff force block 2', () => {
    const { source, asked } = fakeSource([ALL_FF, ALL_FF, ALL_ZERO]);
    expect(sampleRoll(source, 101)).toEqual({ roll: 0, block: 2, wordIndex: 0, word: 0 });
    expect(asked).toEqual([0, 1, 2]);
  });

  it('all 0xff is accepted when den divides 2^32 (nothing is rejected)', () => {
    const { source } = fakeSource([ALL_FF]);
    expect(sampleRoll(source, 2 ** 31)).toEqual({
      roll: 2 ** 31 - 1,
      block: 0,
      wordIndex: 0,
      word: S - 1,
    });
  });

  it('a source that only ever gives 0xff hits the cap after exactly 1024 blocks and throws', () => {
    const asked: number[] = [];
    const source: BlockSource = (block) => {
      asked.push(block);
      return ALL_FF;
    };
    expect(() => sampleRoll(source, 101)).toThrow(
      'No accepted word in 1024 blocks. The block source is broken.',
    );
    expect(asked).toEqual(Array.from({ length: MAX_BLOCKS }, (_, i) => i));
  });

  it('throws on a block that is not 32 bytes', () => {
    const { source } = fakeSource([new Uint8Array(31)]);
    expect(() => sampleRoll(source, 101)).toThrow('A draw block must be exactly 32 bytes, got 31.');
  });

  it('checks den before reading any block', () => {
    for (const den of [0, -5, 2.5, Number.NaN, 2 ** 32 + 1]) {
      const { source, asked } = fakeSource([ALL_ZERO]);
      expect(() => sampleRoll(source, den)).toThrow(/^Denominator must be a whole number/);
      expect(asked).toEqual([]);
    }
  });

  it('works at both ends of the den range', () => {
    const { source } = fakeSource([blockOf([S - 1, 0, 0, 0, 0, 0, 0, 0])]);
    expect(sampleRoll(source, 1)).toEqual({ roll: 0, block: 0, wordIndex: 0, word: S - 1 });
    const top = { roll: S - 1, block: 0, wordIndex: 0, word: S - 1 };
    expect(sampleRoll(source, 2 ** 32)).toEqual(top);
  });
});
