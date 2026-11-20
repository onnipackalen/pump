import { describe, expect, it } from 'vitest';
import { drawMessage, type DrawMessageParts } from '../../src/fair/message';

/** The draw from the worked example in docs/fairness.md. */
const DOCS_PARTS: DrawMessageParts = {
  clientSeed: 'myseed',
  nonce: 5,
  balloonIndex: 0,
  drawIndex: 0,
  block: 0,
};

const COUNTERS = ['nonce', 'balloonIndex', 'drawIndex', 'block'] as const;

describe('drawMessage', () => {
  it('builds the docs example exactly', () => {
    expect(drawMessage(DOCS_PARTS)).toBe('myseed:5:0:0:0');
  });

  it('puts the five parts in the documented order', () => {
    expect(
      drawMessage({ clientSeed: 'abc', nonce: 1, balloonIndex: 2, drawIndex: 3, block: 4 }),
    ).toBe('abc:1:2:3:4');
  });

  it('writes the largest safe integer in plain decimal', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(max).toBe(9007199254740991);
    expect(drawMessage({ ...DOCS_PARTS, nonce: max })).toBe('myseed:9007199254740991:0:0:0');
    expect(
      drawMessage({ clientSeed: 'z', nonce: max, balloonIndex: max, drawIndex: max, block: max }),
    ).toBe('z:9007199254740991:9007199254740991:9007199254740991:9007199254740991');
  });

  it('writes numbers without leading zeros, exponents or separators', () => {
    expect(drawMessage({ ...DOCS_PARTS, nonce: 10 })).toBe('myseed:10:0:0:0');
    expect(drawMessage({ ...DOCS_PARTS, nonce: 1e15 })).toBe('myseed:1000000000000000:0:0:0');
    expect(drawMessage({ ...DOCS_PARTS, drawIndex: 0x10 })).toBe('myseed:5:0:16:0');
  });

  it('keeps the longest client seed whole', () => {
    const seed = 'A'.repeat(64);
    expect(drawMessage({ ...DOCS_PARTS, clientSeed: seed })).toBe(`${seed}:5:0:0:0`);
  });

  it('treats -0 as 0 (same number, same message)', () => {
    expect(drawMessage({ ...DOCS_PARTS, nonce: -0, block: -0 })).toBe('myseed:0:0:0:0');
  });

  it('gives different messages for draws that differ in any one part', () => {
    const variants: DrawMessageParts[] = [
      DOCS_PARTS,
      { ...DOCS_PARTS, clientSeed: 'myseee' },
      { ...DOCS_PARTS, nonce: 6 },
      { ...DOCS_PARTS, balloonIndex: 1 },
      { ...DOCS_PARTS, drawIndex: 1 },
      { ...DOCS_PARTS, block: 1 },
    ];
    const messages = variants.map(drawMessage);
    expect(new Set(messages).size).toBe(variants.length);
  });

  it('rejects a bad client seed', () => {
    for (const clientSeed of ['', 'my:seed', 'my seed', 'x'.repeat(65), 'café']) {
      expect(() => drawMessage({ ...DOCS_PARTS, clientSeed })).toThrow(/Client seed/);
    }
  });

  describe.each(COUNTERS)('%s', (name) => {
    const bad: [string, number][] = [
      ['negative', -1],
      ['a large negative', -Number.MAX_SAFE_INTEGER],
      ['fractional', 1.5],
      ['tiny fractional', Number.EPSILON],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['2^53', 2 ** 53],
      ['2^53 + 2', 2 ** 53 + 2],
    ];

    it.each(bad)('rejects %s', (_label, value) => {
      expect(() => drawMessage({ ...DOCS_PARTS, [name]: value })).toThrow(
        new RegExp(`^${name} must be a whole number from 0 to 2\\^53 - 1`),
      );
    });

    it('accepts 0 and 2^53 - 1', () => {
      expect(() => drawMessage({ ...DOCS_PARTS, [name]: 0 })).not.toThrow();
      expect(() => drawMessage({ ...DOCS_PARTS, [name]: 2 ** 53 - 1 })).not.toThrow();
    });
  });
});
