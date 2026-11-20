/**
 * A fast random number generator for the simulator only.
 *
 * The real game never uses this: its draws come from the provably fair
 * module (src/fair), from seeds. The simulator needs hundreds of millions of
 * rolls, so it uses xoshiro128**, a small well-tested generator, seeded from
 * one number so that a run can be repeated exactly.
 */

export interface Rng {
  /** The next 32-bit word: a whole number from 0 to 4,294,967,295. */
  next(): number;
  /** A whole number drawn uniformly from 0 to den - 1. */
  below(den: number): number;
}

const WORD_SPACE = 2 ** 32;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export function createRng(seed: number): Rng {
  // splitmix32 spreads the one seed over the generator's four words.
  let s = seed >>> 0;
  const spread = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = spread();
  let b = spread();
  let c = spread();
  let d = spread();

  const next = (): number => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };

  /**
   * The same rejection rule as the real game: words at or above the largest
   * multiple of den are skipped, so every roll is exactly as likely as any
   * other.
   */
  const below = (den: number): number => {
    if (!Number.isSafeInteger(den) || den < 1 || den > WORD_SPACE) {
      throw new RangeError('den must be a whole number from 1 to 2^32');
    }
    const limit = WORD_SPACE - (WORD_SPACE % den);
    for (;;) {
      const word = next();
      if (word < limit) return word % den;
    }
  };

  return { next, below };
}
