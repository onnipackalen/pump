import { describe, expect, it } from 'vitest';
import { asciiBytes } from '../../src/fair/ascii';

describe('asciiBytes', () => {
  it('turns each character into one byte with the same code', () => {
    expect([...asciiBytes('myseed:5:0:0:0')]).toEqual([
      0x6d, 0x79, 0x73, 0x65, 0x65, 0x64, 0x3a, 0x35, 0x3a, 0x30, 0x3a, 0x30, 0x3a, 0x30,
    ]);
  });

  it('gives an empty array for empty text', () => {
    const bytes = asciiBytes('');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(0);
  });

  it('covers every code from 0 to 127', () => {
    const codes = Array.from({ length: 128 }, (_, i) => i);
    const text = String.fromCharCode(...codes);
    expect([...asciiBytes(text)]).toEqual(codes);
  });

  it('matches Node for every ASCII character', () => {
    const text = String.fromCharCode(...Array.from({ length: 128 }, (_, i) => i));
    expect(Buffer.from(asciiBytes(text)).equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it.each([
    ['code 128', '\u0080'],
    ['code 255', 'ÿ'],
    ['an accented letter', 'é'],
    ['a Euro sign', '€'],
    ['an emoji (two UTF-16 code units)', '😀'],
    ['a lone surrogate', '\ud800'],
  ])('throws on %s', (_label, text) => {
    expect(() => asciiBytes(`ok${text}`)).toThrow(/^Text is not ASCII: character 2 has code \d+/);
  });

  it('does not echo the text in the error (it may be a secret)', () => {
    expect(() => asciiBytes('secretparté')).toThrow(
      'Text is not ASCII: character 10 has code 233, above 127.',
    );
  });
});
