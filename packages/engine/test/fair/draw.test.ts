import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptanceLimit,
  bytesToHex,
  drawerFor,
  drawMessage,
  drawRoll,
  hashServerSeed,
  hmacSha256,
  readWords,
  revealDrawerFor,
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

/**
 * The second worked example in docs/fairness.md: a round where a Patch saves
 * a pump. It pins down the rule the docs spell out for players: a pump's
 * fraction comes from the rung it is trying to reach (rung before + 1), not
 * from how many times pump was pressed. A Patch save uses a draw but leaves
 * the rung alone, so the next press uses the same fraction with the next draw
 * index.
 */
describe('the docs/fairness.md round with a Patch save', () => {
  // What the round recorded when it was played. Verification uses the
  // round's own copies, never the current config, so these are fixed here.
  const ROUND_RTP_BP = 9700;
  const ROUND_LADDER = [101, 111, 123] as const;
  const ROUND: DrawInputs = { ...DOCS, nonce: 3 };

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

  /** num / den in lowest terms for a pump trying to reach `targetRung` (1 = first pump). */
  function surviveFraction(targetRung: number): { num: number; den: number } {
    const step = (k: number): number => {
      const h = ROUND_LADDER[k - 1];
      if (h === undefined) throw new Error(`no ladder step ${k}`);
      return h;
    };
    const [num, den] =
      targetRung === 1 ? [ROUND_RTP_BP, 100 * step(1)] : [step(targetRung - 1), step(targetRung)];
    const common = gcd(num, den);
    return { num: num / common, den: den / common };
  }

  type Outcome = 'survive' | 'saved' | 'pop';
  const PRESSES: readonly {
    rungBefore: number;
    patched: boolean;
    hex: string;
    result: SampledRoll;
    outcome: Outcome;
  }[] = [
    {
      rungBefore: 0,
      patched: false,
      hex: '0d996f9b5485bb7ee9fd02bbc7b611e6c4bba56d68d49e6fe48b16a77d78bc38',
      result: { roll: 84, block: 0, wordIndex: 0, word: 228159387 },
      outcome: 'survive',
    },
    {
      rungBefore: 1,
      patched: true,
      hex: '250c6ed4e5f5c47f46865d9c4bc3689f2adab0170490d8fb7c6f2f008b3bb63a',
      result: { roll: 101, block: 0, wordIndex: 0, word: 621571796 },
      outcome: 'saved',
    },
    {
      rungBefore: 1,
      patched: false,
      hex: '1db1b8b7c3af1cb03d2652fe2af62df8769465f6ad259803f7328bfec0f2e3da',
      result: { roll: 108, block: 0, wordIndex: 0, word: 498186423 },
      outcome: 'pop',
    },
  ];

  it('plays forward exactly as documented: survive, Patch save on the same rung, pop', () => {
    let rung = 0;
    PRESSES.forEach((press, drawIndex) => {
      expect(rung).toBe(press.rungBefore);
      const { num, den } = surviveFraction(rung + 1);
      const inputs = { ...ROUND, drawIndex };
      expect(bytesToHex(hmacSha256(inputs.serverSeed, drawMessage({ ...inputs, block: 0 })))).toBe(
        press.hex,
      );
      const result = drawRoll(inputs, den);
      expect(result).toEqual(press.result);
      expect(nodeDraw(inputs, den)).toEqual(press.result);
      let outcome: Outcome;
      if (result.roll < num) {
        outcome = 'survive';
        rung += 1;
      } else {
        outcome = press.patched ? 'saved' : 'pop';
      }
      expect(outcome).toBe(press.outcome);
    });
  });

  it('uses 97/101, then 101/111 twice: the press after a save repeats the fraction', () => {
    expect(surviveFraction(1)).toEqual({ num: 97, den: 101 });
    expect(surviveFraction(2)).toEqual({ num: 101, den: 111 });
    expect(acceptanceLimit(111)).toBe(4294967289);
  });

  it('counting presses instead (rung 3 chance 37/41 on press 3) gives roll 15, the documented mistake', () => {
    expect(surviveFraction(3)).toEqual({ num: 37, den: 41 });
    expect(drawRoll({ ...ROUND, drawIndex: 2 }, 41).roll).toBe(15);
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

describe('revealDrawerFor', () => {
  // A balloon cashed out after 3 draws: its reveal starts at draw index 3.
  const CASHED: DrawInputs = { ...DOCS, drawIndex: 3 };
  const rollAt = (drawIndex: number, den = DOCS_DEN, inputs = CASHED): number =>
    drawRoll({ ...inputs, drawIndex }, den).roll;
  const wrongIndex = (next: number, asked: number): string =>
    `The reveal must ask for draw index ${String(next)} next, not ${String(asked)}.`;

  it('gives the roll drawRoll gives at each index, from the first index up', () => {
    const draw = revealDrawerFor(CASHED);
    const dens = [41, 137, DOCS_DEN, HALF_REJECTING_DEN, 19];
    dens.forEach((den, i) => {
      const drawIndex = 3 + i;
      const roll = draw(drawIndex, den);
      expect(roll).toBe(rollAt(drawIndex, den));
      expect(roll).toBe(nodeDraw({ ...CASHED, drawIndex }, den).roll);
    });
  });

  it('must start at the first index', () => {
    expect(() => revealDrawerFor(CASHED)(0, DOCS_DEN)).toThrow(wrongIndex(3, 0));
    expect(() => revealDrawerFor(CASHED)(2, DOCS_DEN)).toThrow(wrongIndex(3, 2));
    expect(() => revealDrawerFor(CASHED)(4, DOCS_DEN)).toThrow(wrongIndex(3, 4));
  });

  it('refuses a repeat, a skip or an earlier index, and draws nothing for them', () => {
    const draw = revealDrawerFor(CASHED);
    expect(draw(3, DOCS_DEN)).toBe(rollAt(3));
    expect(() => draw(3, DOCS_DEN)).toThrow(wrongIndex(4, 3));
    expect(() => draw(5, DOCS_DEN)).toThrow(wrongIndex(4, 5));
    expect(() => draw(1, DOCS_DEN)).toThrow(wrongIndex(4, 1));
    expect(() => draw(Number.NaN, DOCS_DEN)).toThrow(wrongIndex(4, Number.NaN));
    // The refused calls did not use index 4 up.
    expect(draw(4, DOCS_DEN)).toBe(rollAt(4));
  });

  it('counts a call that threw on a bad den as used, so it cannot be retried', () => {
    const draw = revealDrawerFor(CASHED);
    expect(() => draw(3, 0)).toThrow(/^Denominator must be a whole number/);
    expect(() => draw(3, DOCS_DEN)).toThrow(wrongIndex(4, 3));
    expect(draw(4, DOCS_DEN)).toBe(rollAt(4));
  });

  it('draws only for the balloon it was made for', () => {
    const other = { ...CASHED, balloonIndex: 1 };
    expect(revealDrawerFor(other)(3, 2 ** 32)).toBe(rollAt(3, 2 ** 32, other));
    expect(revealDrawerFor(other)(3, 2 ** 32)).not.toBe(rollAt(3, 2 ** 32));
  });

  it('checks the inputs when it is made, and keeps its own copy', () => {
    expect(() => revealDrawerFor({ ...CASHED, serverSeed: 'nope' })).toThrow(/Server seed/);
    expect(() => revealDrawerFor({ ...CASHED, clientSeed: 'my:seed' })).toThrow(/Client seed/);
    expect(() => revealDrawerFor({ ...CASHED, drawIndex: -1 })).toThrow(/^drawIndex must be/);
    const inputs = { ...CASHED };
    const draw = revealDrawerFor(inputs);
    inputs.nonce = 6;
    inputs.balloonIndex = 2;
    inputs.drawIndex = 0;
    expect(draw(3, DOCS_DEN)).toBe(rollAt(3));
  });

  it('never puts the server seed in an error message', () => {
    const messages: string[] = [];
    const caught = (call: () => unknown): void => {
      try {
        call();
        messages.push('no error');
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    };
    const secret = `${DOCS.serverSeed.slice(0, 63)}G`;
    caught(() => revealDrawerFor({ ...CASHED, serverSeed: secret }));
    const draw = revealDrawerFor(CASHED);
    caught(() => draw(7, DOCS_DEN));
    caught(() => draw(3, -1));
    caught(() => draw(3, DOCS_DEN));
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).not.toBe('no error');
      expect(message).not.toContain(secret.slice(0, 16));
      expect(message).not.toContain(DOCS.serverSeed.slice(0, 16));
    }
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
