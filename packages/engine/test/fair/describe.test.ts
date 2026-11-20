import { describe, expect, it } from 'vitest';
import { describeValue } from '../../src/fair/describe';

describe('describeValue', () => {
  it.each([
    [5, '5'],
    [0, '0'],
    [-1, '-1'],
    [1.5, '1.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [2 ** 53, '9007199254740992'],
  ])('prints the number %d as itself', (value, text) => {
    expect(describeValue(value)).toBe(text);
  });

  it.each([
    ['5', 'a string'],
    [5n, 'a bigint (5n)'],
    [[5], 'an array'],
    [null, 'null'],
    [undefined, 'undefined'],
    [true, 'a boolean'],
    [{}, 'an object'],
    [Symbol('x'), 'a symbol'],
    [() => 5, 'a function'],
  ])('names the type of %o', (value, text) => {
    expect(describeValue(value)).toBe(text);
  });

  it('never prints the text of a string, which could be a secret server seed', () => {
    const seed = 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14';
    expect(describeValue(seed)).toBe('a string');
  });
});
