/**
 * Turning game numbers into text and back. Money is integer cents and
 * multipliers are integer hundredths everywhere; nothing here uses floating
 * point except formatChance, which is for display only.
 */

import type { Fraction } from './api/contract';

const groupThousands = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a whole number, got ${value}`);
  }
}

/** Splits a non-negative whole number of hundredths into whole and rest. */
function splitHundredths(value: number): { whole: number; rest: string } {
  const rest = value % 100;
  return { whole: (value - rest) / 100, rest: String(rest).padStart(2, '0') };
}

/** 123456 -> "$1,234.56". Negative amounts get a leading "-". */
export function formatCents(cents: number): string {
  assertSafeInteger(cents, 'cents');
  const { whole, rest } = splitHundredths(Math.abs(cents));
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${groupThousands.format(whole)}.${rest}`;
}

/** Like formatCents, but always shows the sign: "+$1.00", "-$1.00", "$0.00". */
export function formatSignedCents(cents: number): string {
  if (cents > 0) return `+${formatCents(cents)}`;
  return formatCents(cents);
}

/** 150 -> "1.50": the text a bet input shows for an amount. */
export function centsToInput(cents: number): string {
  assertSafeInteger(cents, 'cents');
  const { whole, rest } = splitHundredths(Math.abs(cents));
  return `${cents < 0 ? '-' : ''}${whole}.${rest}`;
}

/**
 * Reads a dollar amount typed by the player: "1", "1.5", "1.50", ".5".
 * Returns whole cents, or null if the text is not a plain amount with at
 * most two decimals. Parsed digit by digit, so "0.29" is exactly 29 cents.
 */
export function parseDollarsToCents(text: string): number | null {
  const match = /^(\d{0,9})(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  return Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
}

/** 123 -> "1.23×", 500000 -> "5,000.00×". */
export function formatMultiplier(hundredths: number): string {
  assertSafeInteger(hundredths, 'multiplier');
  const { whole, rest } = splitHundredths(hundredths);
  return `${groupThousands.format(whole)}.${rest}×`;
}

/**
 * An exact chance as a percentage with two decimals, for display only.
 * Never shows 0% or 100% for a chance that is neither.
 */
export function formatChance(chance: Fraction): string {
  const { num, den } = chance;
  if (num <= 0) return '0%';
  if (num >= den) return '100%';
  const basisPoints = Math.round((num * 10_000) / den);
  if (basisPoints < 1) return '<0.01%';
  if (basisPoints > 9_999) return '>99.99%';
  const { whole, rest } = splitHundredths(basisPoints);
  return `${whole}.${rest}%`;
}
