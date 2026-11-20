import { describe, expect, it } from 'vitest';
import {
  centsToInput,
  formatCents,
  formatChance,
  formatMultiplier,
  formatSignedCents,
  parseDollarsToCents,
} from '../src/money';

describe('formatCents', () => {
  it('shows dollars and cents with thousands grouped', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(7)).toBe('$0.07');
    expect(formatCents(123_456)).toBe('$1,234.56');
    expect(formatCents(10_000_000)).toBe('$100,000.00');
    expect(formatCents(-250)).toBe('-$2.50');
  });

  it('refuses amounts that are not whole cents', () => {
    expect(() => formatCents(1.5)).toThrow(RangeError);
  });

  it('shows a plus sign on gains only', () => {
    expect(formatSignedCents(100)).toBe('+$1.00');
    expect(formatSignedCents(-100)).toBe('-$1.00');
    expect(formatSignedCents(0)).toBe('$0.00');
  });
});

describe('parseDollarsToCents', () => {
  it('reads plain amounts exactly', () => {
    expect(parseDollarsToCents('1')).toBe(100);
    expect(parseDollarsToCents('1.5')).toBe(150);
    expect(parseDollarsToCents('0.29')).toBe(29);
    expect(parseDollarsToCents('.1')).toBe(10);
    expect(parseDollarsToCents(' 1000.00 ')).toBe(100_000);
  });

  it('rejects anything else', () => {
    for (const text of ['', '.', 'abc', '1.234', '-1', '1e3', '1,000', '$1']) {
      expect(parseDollarsToCents(text)).toBeNull();
    }
  });

  it('round-trips with centsToInput for every legal bet', () => {
    for (let cents = 10; cents <= 100_000; cents += 1) {
      expect(parseDollarsToCents(centsToInput(cents))).toBe(cents);
    }
  });
});

describe('formatMultiplier', () => {
  it('shows hundredths as a multiplier', () => {
    expect(formatMultiplier(101)).toBe('1.01×');
    expect(formatMultiplier(2500)).toBe('25.00×');
    expect(formatMultiplier(500_000)).toBe('5,000.00×');
  });
});

describe('formatChance', () => {
  it('shows a percentage with two decimals', () => {
    expect(formatChance({ num: 4, den: 101 })).toBe('3.96%');
    expect(formatChance({ num: 3, den: 4 })).toBe('75.00%');
  });

  it('never rounds a real chance to 0% or 100%', () => {
    expect(formatChance({ num: 1, den: 1_000_000 })).toBe('<0.01%');
    expect(formatChance({ num: 999_999, den: 1_000_000 })).toBe('>99.99%');
    expect(formatChance({ num: 0, den: 7 })).toBe('0%');
    expect(formatChance({ num: 7, den: 7 })).toBe('100%');
  });
});
