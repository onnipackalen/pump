/**
 * Draw bytes to an exactly uniform roll.
 *
 * A pump's survival chance is an exact fraction num / den. To decide it, we
 * need one whole number `roll` that is equally likely to be each of
 * 0, 1, ..., den - 1; the balloon survives if roll < num. This file turns
 * 32-byte blocks (from HMAC-SHA256, see draw.ts) into such a roll, using only
 * whole numbers.
 *
 * Step 1, bytes to words. A block's 32 bytes are read as 8 unsigned 32-bit
 * numbers ("words"), 4 bytes each, big-endian: the first byte is the biggest
 * part. Each word is one of S = 2^32 values, 0 to 4,294,967,295.
 *
 * Step 2, word to roll, by rejection. Taking `word mod den` directly would be
 * slightly unfair whenever den does not divide S: the leftover S mod den
 * values would make the smallest rolls come up once more than the rest. So:
 *
 *     limit = S - (S mod den)        the largest multiple of den that is <= S
 *     accept the word if word < limit, and then roll = word mod den
 *     reject it otherwise, and use the next word
 *
 * The accepted words 0 .. limit - 1 are exactly limit / den = floor(S / den)
 * full runs of 0, 1, ..., den - 1, so every roll is produced by exactly
 * floor(S / den) words: exactly equal chances. The tests check this by
 * counting every word for every den in two smaller word spaces, using this
 * same function, which is why it takes S as a parameter.
 *
 * Step 3, words in order. The sampler tries words 0..7 of block 0, then words
 * 0..7 of block 1, and so on, and returns the first accepted roll.
 *
 * No floating point: S is at most 2^32 and den at most S, so every value here
 * (S, den, limit, word, roll) is a whole number no bigger than 2^32. JavaScript
 * numbers hold every whole number up to 2^53 exactly, and +, -, * and % on
 * them are exact while results stay that small.
 */

/** Values a 32-bit unsigned word can take: 2^32 = 4,294,967,296. */
export const WORD_SPACE = 2 ** 32;

/** Bytes in one HMAC-SHA256 output block. */
export const BLOCK_BYTES = 32;

/** 4-byte words in one block. */
export const WORDS_PER_BLOCK = BLOCK_BYTES / 4;

/**
 * The sampler gives up after this many blocks (8,192 words).
 *
 * This can never happen in practice. With r = S mod den and q = floor(S / den),
 * den <= S means q >= 1, so r < den <= q * den = S - r, which gives 2r < S:
 * fewer than half of all words are ever rejected. Treating HMAC-SHA256 output
 * as uniform random bytes (the standard assumption), each word is rejected
 * with chance below 1/2, a whole block with chance below 2^-8, and 1024 blocks
 * in a row with chance below 2^-8192. For the fractions the game uses the
 * chance per word is far smaller still: below den / 2^32.
 *
 * The cap exists only so that a broken block source (one that always returns
 * the same bytes, say) fails loudly instead of looping forever.
 */
export const MAX_BLOCKS = 1024;

/** Byte `index` of `bytes`, which the caller has already length-checked. */
function byteAt(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) throw new Error(`No byte at index ${index}.`);
  return byte;
}

/**
 * The 8 words of a 32-byte block, big-endian.
 *
 * Word i is built from bytes 4i .. 4i+3 as
 *     b0 * 2^24 + b1 * 2^16 + b2 * 2^8 + b3
 * using multiplication, not bit shifts: in JavaScript `b0 << 24` is a signed
 * 32-bit result and goes negative for b0 >= 128. The sum is at most
 * 2^32 - 1, so it is exact.
 */
export function readWords(block: Uint8Array): number[] {
  if (block.length !== BLOCK_BYTES) {
    throw new Error(`A draw block must be exactly ${BLOCK_BYTES} bytes, got ${block.length}.`);
  }
  const words: number[] = [];
  for (let i = 0; i < WORDS_PER_BLOCK; i++) {
    const at = i * 4;
    words.push(
      byteAt(block, at) * 0x1000000 +
        byteAt(block, at + 1) * 0x10000 +
        byteAt(block, at + 2) * 0x100 +
        byteAt(block, at + 3),
    );
  }
  return words;
}

/** Throws unless `space` is a whole number from 1 to 2^32. */
function assertSpace(space: number): void {
  if (!Number.isSafeInteger(space) || space < 1 || space > WORD_SPACE) {
    throw new Error(`Word space must be a whole number from 1 to 2^32, got ${String(space)}.`);
  }
}

/** Throws unless `den` is a whole number from 1 to `space`. */
function assertDenominator(den: number, space: number): void {
  if (!Number.isSafeInteger(den) || den < 1 || den > space) {
    throw new Error(
      `Denominator must be a whole number from 1 to ${String(space)}, got ${String(den)}.`,
    );
  }
}

/**
 * limit = S - (S mod den): words below it are accepted, the rest rejected.
 *
 * `space` (S) is 2^32 in the game; tests pass smaller spaces to count every
 * case. Throws unless 1 <= den <= S and S is a whole number from 1 to 2^32.
 */
export function acceptanceLimit(den: number, space: number = WORD_SPACE): number {
  assertSpace(space);
  assertDenominator(den, space);
  return space - (space % den);
}

/**
 * The acceptance rule, the one place it is written.
 *
 * Returns `word mod den` if the word is accepted (word < limit), or undefined
 * if it is rejected and the next word must be tried. `word` must be a whole
 * number with 0 <= word < S.
 */
export function rollFromWord(
  word: number,
  den: number,
  space: number = WORD_SPACE,
): number | undefined {
  const limit = acceptanceLimit(den, space);
  if (!Number.isSafeInteger(word) || word < 0 || word >= space) {
    throw new Error(
      `Word must be a whole number from 0 to ${String(space - 1)}, got ${String(word)}.`,
    );
  }
  return word < limit ? word % den : undefined;
}

/**
 * Where draw bytes come from: block number (0, 1, 2, ...) to 32 bytes.
 * In the game this is HMAC-SHA256 of the draw message for that block.
 */
export type BlockSource = (block: number) => Uint8Array;

/** A roll, and exactly where in the draw bytes it was found. */
export interface SampledRoll {
  /** The roll, uniform in [0, den). */
  readonly roll: number;
  /** Which block held the accepted word (almost always 0). */
  readonly block: number;
  /** Which of that block's 8 words was accepted, 0 to 7 (almost always 0). */
  readonly wordIndex: number;
  /** The accepted word itself, 0 to 2^32 - 1. */
  readonly word: number;
}

/**
 * The first accepted roll from the block source, trying words in order:
 * block 0 words 0..7, then block 1 words 0..7, and so on.
 *
 * Blocks are fetched only when needed, so block 1 is computed only if all 8
 * words of block 0 were rejected. Throws if `den` is not a whole number from
 * 1 to 2^32 (before reading any block), if a block is not 32 bytes, or if
 * MAX_BLOCKS blocks pass with no accepted word.
 */
export function sampleRoll(blockAt: BlockSource, den: number): SampledRoll {
  acceptanceLimit(den); // Validates den up front, before any bytes are read.
  for (let block = 0; block < MAX_BLOCKS; block++) {
    const words = readWords(blockAt(block));
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const word = words[wordIndex];
      if (word === undefined) break; // Unreachable: wordIndex < words.length.
      const roll = rollFromWord(word, den);
      if (roll !== undefined) return { roll, block, wordIndex, word };
    }
  }
  throw new Error(`No accepted word in ${MAX_BLOCKS} blocks. The block source is broken.`);
}
