import { describe, expect, it } from 'vitest';
import {
  assertClientSeed,
  assertServerSeed,
  isClientSeed,
  isServerSeed,
} from '../../src/fair/seeds';

/** The server seed from the worked example in docs/fairness.md. */
const DOCS_SERVER_SEED = 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14';

describe('client seed', () => {
  const good = [
    'a',
    'myseed',
    'Z',
    '0',
    '_',
    '-',
    'A-Za-z0-9_-',
    'x'.repeat(64),
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-',
  ];

  it.each(good)('accepts %j', (seed) => {
    expect(isClientSeed(seed)).toBe(true);
    expect(() => assertClientSeed(seed)).not.toThrow();
  });

  it('accepts exactly 1 and exactly 64 characters', () => {
    expect(isClientSeed('q')).toBe(true);
    expect(isClientSeed('q'.repeat(64))).toBe(true);
  });

  const bad: [string, unknown][] = [
    ['empty', ''],
    ['65 characters', 'x'.repeat(65)],
    ['a colon', 'my:seed'],
    ['only a colon', ':'],
    ['a space', 'my seed'],
    ['a leading space', ' myseed'],
    ['a trailing newline', 'myseed\n'],
    ['a tab', 'my\tseed'],
    ['a dot', 'my.seed'],
    ['a slash', 'my/seed'],
    ['a plus', 'my+seed'],
    ['an accented letter', 'café'],
    ['a non-ASCII digit', 'seed١'],
    ['an emoji', 'seed😀'],
    ['a NUL character', 'seed\u0000'],
    ['a number', 123],
    ['undefined', undefined],
    ['null', null],
  ];

  it.each(bad)('rejects %s', (_label, seed) => {
    expect(isClientSeed(seed)).toBe(false);
    expect(() => assertClientSeed(seed)).toThrow(/Client seed must be 1 to 64 characters/);
  });
});

describe('server seed', () => {
  it('accepts 64 lowercase hex characters', () => {
    const seeds = [DOCS_SERVER_SEED, '0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)];
    for (const seed of seeds) {
      expect(isServerSeed(seed)).toBe(true);
      expect(() => assertServerSeed(seed)).not.toThrow();
    }
  });

  const bad: [string, unknown][] = [
    ['uppercase hex', DOCS_SERVER_SEED.toUpperCase()],
    ['one uppercase letter', `A${DOCS_SERVER_SEED.slice(1)}`],
    ['63 characters', DOCS_SERVER_SEED.slice(1)],
    ['65 characters', `${DOCS_SERVER_SEED}0`],
    ['empty', ''],
    ['a non-hex letter', `g${DOCS_SERVER_SEED.slice(1)}`],
    ['a 0x prefix', `0x${DOCS_SERVER_SEED.slice(2)}`],
    ['a trailing newline', `${DOCS_SERVER_SEED.slice(1)}\n`],
    ['a space', ` ${DOCS_SERVER_SEED.slice(1)}`],
    ['a number', 12345],
    ['undefined', undefined],
  ];

  it.each(bad)('rejects %s', (_label, seed) => {
    expect(isServerSeed(seed)).toBe(false);
    expect(() => assertServerSeed(seed)).toThrow(/Server seed must be exactly 64 lowercase hex/);
  });

  it('never puts the seed itself in the error message', () => {
    const almost = DOCS_SERVER_SEED.toUpperCase();
    let message = '';
    try {
      assertServerSeed(almost);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(almost);
    expect(message.toLowerCase()).not.toContain(DOCS_SERVER_SEED.slice(0, 16));
  });
});
