/**
 * Exact fractions of whole numbers, for the proof and the simulator's
 * expected values. No decimals are used until a number is printed.
 */

/** n / d in lowest terms, with d above zero. */
export interface Fr {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** The fraction n / d. Whole numbers only; d must not be zero. */
export function fr(n: bigint | number, d: bigint | number = 1n): Fr {
  const top = BigInt(n);
  const bottom = BigInt(d);
  if (bottom === 0n) throw new RangeError('A fraction cannot have zero below the line');
  const divisor = gcd(top, bottom) * (bottom < 0n ? -1n : 1n);
  return { n: top / divisor, d: bottom / divisor };
}

export const ZERO = fr(0);
export const ONE = fr(1);

export const add = (a: Fr, b: Fr): Fr => fr(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Fr, b: Fr): Fr => fr(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Fr, b: Fr): Fr => fr(a.n * b.n, a.d * b.d);
export const div = (a: Fr, b: Fr): Fr => fr(a.n * b.d, a.d * b.n);

/** Below zero if a < b, zero if they are equal, above zero if a > b. */
export function compare(a: Fr, b: Fr): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export const equal = (a: Fr, b: Fr): boolean => compare(a, b) === 0;
export const max = (a: Fr, b: Fr): Fr => (compare(a, b) >= 0 ? a : b);

/** The fraction as a plain number, for printing and for statistics only. */
export function toNumber(a: Fr): number {
  // Scale first so that very large tops and bottoms do not overflow a double.
  const scale = 10n ** 18n;
  return Number((a.n * scale) / a.d) / 1e18;
}

/**
 * The fraction (zero or more) as a percentage with `digits` decimals, rounded
 * to the nearest: 0.915094... becomes "91.51%". Worked out in whole numbers,
 * so the last digit shown is right.
 */
export function percent(a: Fr, digits = 2): string {
  const scale = 10n ** BigInt(digits);
  // floor(x + 1/2) with x = a * 100 * scale
  const scaled = (a.n * 200n * scale + a.d) / (2n * a.d);
  const whole = scaled / scale;
  const rest = (scaled % scale).toString().padStart(digits, '0');
  return digits === 0 ? `${whole.toString()}%` : `${whole.toString()}.${rest}%`;
}
