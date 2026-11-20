import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  drawerFor,
  drawMessage,
  drawRoll,
  hashServerSeed,
  hmacSha256,
  readWords,
  type DrawInputs,
  type SampledRoll,
} from '@pump/engine/fair';

/** The worked example in docs/fairness.md. */
const DOCS: DrawInputs = {
  serverSeed: 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14',
  clientSeed: 'myseed',
  nonce: 5,
  balloonIndex: 0,
  drawIndex: 0,
};
const DOCS_DEN = 101;
const DOCS_RESULT: SampledRoll = { roll: 69, block: 0, wordIndex: 0, word: 3308196994 };

/** A den just over 2^31: close to half of all words are rejected. */
const HALF_REJECTING_DEN = 2 ** 31 + 1;

/**
 * The same recipe written separately for the test, from docs/fairness.md, on
 * Node's crypto and BigInt. It shares no code with the fair module.
 */
function nodeDraw(inputs: DrawInputs, den: number): SampledRoll {
  const space = 2n ** 32n;
  const limit = space - (space % BigInt(den));
  const { serverSeed, clientSeed, nonce, balloonIndex, drawIndex } = inputs;
  for (let block = 0; block < 1024; block++) {
    const message = `${clientSeed}:${nonce}:${balloonIndex}:${drawIndex}:${block}`;
    const bytes = createHmac('sha256', Buffer.from(serverSeed, 'utf8')).update(message).digest();
    for (let wordIndex = 0; wordIndex < 8; wordIndex++) {
      const word = bytes.readUInt32BE(wordIndex * 4);
      if (BigInt(word) < limit) {
        return { roll: Number(BigInt(word) % BigInt(den)), block, wordIndex, word };
      }
    }
  }
  throw new Error('no accepted word');
}

describe('the docs/fairness.md worked example, end to end', () => {
  it('has the documented seed hash, message, HMAC and words', () => {
    expect(hashServerSeed(DOCS.serverSeed)).toBe(
      '947d192d090f6845f059ae8e45b1d90105b3a34cfdcf209e7369fda4b5d60071',
    );
    const message = drawMessage({ ...DOCS, block: 0 });
    expect(message).toBe('myseed:5:0:0:0');
    const bytes = hmacSha256(DOCS.serverSeed, message);
    expect(bytesToHex(bytes)).toBe(
      'c52f148266db67d40e90cea0680eb6be927163f2e35acd8df0df73aff0921b4a',
    );
    expect(readWords(bytes)).toEqual([
      3308196994, 1725654996, 244371104, 1745794750, 2456904690, 3814378893, 4041175983,
      4036107082,
    ]);
  });

  it('rolls 69 from block 0, word 0, and the balloon survives (69 < 97)', () => {
    // Easy, first pump, RTP 97%: survive 9700 / 10100, which is 97 / 101.
    const result = drawRoll(DOCS, DOCS_DEN);
    expect(result).toEqual(DOCS_RESULT);
    expect(result.roll < 97).toBe(true);
    expect(nodeDraw(DOCS, DOCS_DEN)).toEqual(DOCS_RESULT);
  });

  it('gives the same roll through drawerFor', () => {
    expect(drawerFor(DOCS)(DOCS_DEN)).toBe(69);
  });
});

describe('draws that need more than the first word', () => {
  it('nonce 1 with den 2^31 + 1: the first 7 words are rejected, word 7 is used', () => {
    const inputs = { ...DOCS, nonce: 1 };
    const expected = { roll: 1087467065, block: 0, wordIndex: 7, word: 1087467065 };
    expect(nodeDraw(inputs, HALF_REJECTING_DEN)).toEqual(expected);
    expect(drawRoll(inputs, HALF_REJECTING_DEN)).toEqual(expected);
  });

  it('nonce 127 with den 2^31 + 1: all of block 0 is rejected, block 1 word 0 is used', () => {
    const inputs = { ...DOCS, nonce: 127 };
    const expected = { roll: 1064048742, block: 1, wordIndex: 0, word: 1064048742 };
    expect(nodeDraw(inputs, HALF_REJECTING_DEN)).toEqual(expected);
    expect(drawRoll(inputs, HALF_REJECTING_DEN)).toEqual(expected);
    // Block 1 is the HMAC of the message ending in :1.
    const block1 = hmacSha256(inputs.serverSeed, 'myseed:127:0:0:1');
    expect(bytesToHex(block1)).toBe(
      '3f6c1866d2423719dd68b9890a7a0f009829cdd0ff910784199ff7e825e02067',
    );
  });

  it('agrees with the separate Node version on 1,000 varied draws', () => {
    const dens = [
      1, 2, 3, 97, 101, 10100, 2 ** 24 + 1, HALF_REJECTING_DEN, 3 * 2 ** 30, 2 ** 32 - 1, 2 ** 32,
    ];
    let skippedWords = 0;
    for (let i = 0; i < 1000; i++) {
      const inputs: DrawInputs = {
        ...DOCS,
        clientSeed: `seed_${i % 7}`,
        nonce: i,
        balloonIndex: i % 3,
        drawIndex: i % 11,
      };
      const den = dens[i % dens.length] ?? 101;
      const ours = drawRoll(inputs, den);
      if (ours.block > 0 || ours.wordIndex > 0) skippedWords++;
      expect(ours).toEqual(nodeDraw(inputs, den));
    }
    // The rejection path ran on real HMAC bytes, not only on fake blocks.
    expect(skippedWords).toBeGreaterThan(10);
  });
});

describe('drawRoll is a pure function', () => {
  it('gives the same output for the same inputs, every time', () => {
    const first = drawRoll(DOCS, DOCS_DEN);
    for (let i = 0; i < 5; i++) {
      expect(drawRoll({ ...DOCS }, DOCS_DEN)).toEqual(first);
    }
  });

  it('changes the message and the result when any one of the five inputs changes', () => {
    const changed: [string, DrawInputs][] = [
      ['serverSeed', { ...DOCS, serverSeed: `b${DOCS.serverSeed.slice(1)}` }],
      ['clientSeed', { ...DOCS, clientSeed: 'myseeD' }],
      ['nonce', { ...DOCS, nonce: 6 }],
      ['balloonIndex', { ...DOCS, balloonIndex: 1 }],
      ['drawIndex', { ...DOCS, drawIndex: 1 }],
    ];
    const docsMessage = drawMessage({ ...DOCS, block: 0 });
    const words = new Set([DOCS_RESULT.word]);
    for (const [name, inputs] of changed) {
      const message = drawMessage({ ...inputs, block: 0 });
      // The server seed is the HMAC key, not part of the message.
      if (name === 'serverSeed') expect(message).toBe(docsMessage);
      else expect(message, name).not.toBe(docsMessage);
      const result = drawRoll(inputs, DOCS_DEN);
      expect(result, name).toEqual(nodeDraw(inputs, DOCS_DEN));
      words.add(result.word);
    }
    // Six different draws, six different words.
    expect(words.size).toBe(changed.length + 1);
  });

  it('changing den keeps the same bytes and word, and rolls word mod den', () => {
    // 3308196994 is below the limit for each of these, so it is still used.
    for (const den of [97, 100, 102, 10100, 2 ** 31]) {
      expect(drawRoll(DOCS, den)).toEqual({ ...DOCS_RESULT, roll: 3308196994 % den });
    }
    expect(drawRoll(DOCS, 97).roll).toBe(63);
  });

  it('a balloon does not depend on whether another balloon was drawn first', () => {
    const balloon = (balloonIndex: number, drawIndex: number): DrawInputs => ({
      ...DOCS,
      balloonIndex,
      drawIndex,
    });
    // Balloon 1 alone.
    const alone = [0, 1, 2, 3, 4].map((d) => drawRoll(balloon(1, d), DOCS_DEN));
    // Balloon 0 drawn first, then balloon 1, interleaved with more of balloon 0.
    const interleaved: SampledRoll[] = [];
    for (let d = 0; d < 5; d++) {
      drawRoll(balloon(0, d), DOCS_DEN);
      drawerFor(balloon(0, d + 10))(7);
      interleaved.push(drawRoll(balloon(1, d), DOCS_DEN));
    }
    expect(interleaved).toEqual(alone);
    // And through single-use drawers, in reverse order.
    const reversed = [4, 3, 2, 1, 0].map((d) => drawerFor(balloon(1, d))(DOCS_DEN)).reverse();
    expect(reversed).toEqual(alone.map((r) => r.roll));
  });
});

describe('drawerFor', () => {
  it('throws on a second call', () => {
    const draw = drawerFor(DOCS);
    expect(draw(DOCS_DEN)).toBe(69);
    expect(() => draw(DOCS_DEN)).toThrow('This draw has already been used.');
    expect(() => draw(97)).toThrow('This draw has already been used.');
  });

  it('counts a call that threw as used, so a den cannot be retried', () => {
    const draw = drawerFor(DOCS);
    expect(() => draw(0)).toThrow(/^Denominator must be a whole number/);
    expect(() => draw(DOCS_DEN)).toThrow('This draw has already been used.');
  });

  it('checks the inputs when it is made, not when it is called', () => {
    expect(() => drawerFor({ ...DOCS, serverSeed: 'nope' })).toThrow(/Server seed/);
    expect(() => drawerFor({ ...DOCS, clientSeed: 'my:seed' })).toThrow(/Client seed/);
    expect(() => drawerFor({ ...DOCS, nonce: -1 })).toThrow(/^nonce must be/);
  });

  it('keeps its own copy of the inputs', () => {
    const inputs = { ...DOCS };
    const draw = drawerFor(inputs);
    inputs.nonce = 6;
    inputs.clientSeed = 'other';
    expect(draw(DOCS_DEN)).toBe(69);
  });
});

describe('drawRoll input checks', () => {
  const bad: [string, DrawInputs, RegExp][] = [
    ['uppercase server seed', { ...DOCS, serverSeed: DOCS.serverSeed.toUpperCase() }, /Server/],
    ['63-character server seed', { ...DOCS, serverSeed: DOCS.serverSeed.slice(1) }, /Server/],
    ['empty client seed', { ...DOCS, clientSeed: '' }, /Client seed/],
    ['client seed with a colon', { ...DOCS, clientSeed: 'a:b' }, /Client seed/],
    ['negative nonce', { ...DOCS, nonce: -1 }, /^nonce must be/],
    ['fractional balloonIndex', { ...DOCS, balloonIndex: 0.5 }, /^balloonIndex must be/],
    ['NaN drawIndex', { ...DOCS, drawIndex: Number.NaN }, /^drawIndex must be/],
    ['nonce of 2^53', { ...DOCS, nonce: 2 ** 53 }, /^nonce must be/],
  ];

  it.each(bad)('rejects a %s', (_label, inputs, error) => {
    expect(() => drawRoll(inputs, DOCS_DEN)).toThrow(error);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 32 + 1])('rejects den %d', (den) => {
    expect(() => drawRoll(DOCS, den)).toThrow(/^Denominator must be a whole number from 1 to/);
  });

  it('never puts the server seed in an error message', () => {
    const secret = `${DOCS.serverSeed.slice(0, 63)}G`;
    let message = '';
    try {
      drawRoll({ ...DOCS, serverSeed: secret }, DOCS_DEN);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Server seed/);
    expect(message).not.toContain(secret.slice(0, 16));
  });
});
