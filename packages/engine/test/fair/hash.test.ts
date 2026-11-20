import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hashServerSeed,
  hmacSha256,
  hmacSha256Bytes,
  sha256Bytes,
  verifyServerSeedHash,
} from '../../src/fair/hash';

// Node's crypto is the independent check here. The engine never uses it; the
// tests may.
const nodeHmacHex = (key: Uint8Array, message: Uint8Array): string =>
  createHmac('sha256', key).update(message).digest('hex');
const nodeSha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The worked example in docs/fairness.md. */
const DOCS = {
  serverSeed: 'a4d93ce3d9f9e3f860e6275882ff4ecdfdb3adc0e87e99e1bc07b8ab1beeff14',
  serverSeedHash: '947d192d090f6845f059ae8e45b1d90105b3a34cfdcf209e7369fda4b5d60071',
  message: 'myseed:5:0:0:0',
  hmacHex: 'c52f148266db67d40e90cea0680eb6be927163f2e35acd8df0df73aff0921b4a',
};

const repeat = (length: number, byte: number): Uint8Array => new Uint8Array(length).fill(byte);
const text = (value: string): Uint8Array => Buffer.from(value, 'utf8');

/**
 * RFC 4231, section 4: the HMAC-SHA256 test cases. Case 5's expected value is
 * the first 128 bits only, as the RFC gives it.
 */
const RFC_4231: { name: string; key: Uint8Array; data: Uint8Array; expected: string }[] = [
  {
    name: 'case 1: 20-byte key',
    key: repeat(20, 0x0b),
    data: text('Hi There'),
    expected: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  },
  {
    name: 'case 2: key shorter than the output',
    key: text('Jefe'),
    data: text('what do ya want for nothing?'),
    expected: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  },
  {
    name: 'case 3: combined key and data length over 64 bytes',
    key: repeat(20, 0xaa),
    data: repeat(50, 0xdd),
    expected: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  },
  {
    name: 'case 4: 25-byte key 0x01..0x19',
    key: Uint8Array.from({ length: 25 }, (_, i) => i + 1),
    data: repeat(50, 0xcd),
    expected: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
  },
  {
    name: 'case 5: output truncated to 128 bits',
    key: repeat(20, 0x0c),
    data: text('Test With Truncation'),
    expected: 'a3b6167473100ee06e0c796c2955552b',
  },
  {
    name: 'case 6: 131-byte key, longer than the block size',
    key: repeat(131, 0xaa),
    data: text('Test Using Larger Than Block-Size Key - Hash Key First'),
    expected: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  },
  {
    name: 'case 7: key and data both longer than the block size',
    key: repeat(131, 0xaa),
    data: text(
      'This is a test using a larger than block-size key and a larger than block-size data.' +
        ' The key needs to be hashed before being used by the HMAC algorithm.',
    ),
    expected: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  },
];

/**
 * A small deterministic pseudo-random generator (xorshift32), integers only.
 * It only picks test inputs; nothing about the game depends on it.
 */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** ASCII text of the given length, every character drawn from codes 0 to 127. */
function randomAscii(next: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(next() % 128);
  return out;
}

describe('hmacSha256Bytes on the RFC 4231 test vectors', () => {
  it.each(RFC_4231)('$name', ({ key, data, expected }) => {
    // Node must agree with the typed value, so a typo in it would fail here.
    expect(nodeHmacHex(key, data).slice(0, expected.length)).toBe(expected);
    expect(bytesToHex(hmacSha256Bytes(key, data)).slice(0, expected.length)).toBe(expected);
    expect(hmacSha256Bytes(key, data).length).toBe(32);
  });
});

describe('hmacSha256 (ASCII text in)', () => {
  it('matches the RFC 4231 cases whose key and data are both ASCII (1, 2, 5)', () => {
    const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
    for (const index of [0, 1, 4]) {
      const vector = RFC_4231[index];
      if (!vector) throw new Error(`no RFC 4231 case ${index + 1}`);
      const out = bytesToHex(hmacSha256(ascii(vector.key), ascii(vector.data)));
      expect(out.slice(0, vector.expected.length)).toBe(vector.expected);
    }
  });

  it('gives the docs example', () => {
    expect(bytesToHex(hmacSha256(DOCS.serverSeed, DOCS.message))).toBe(DOCS.hmacHex);
    expect(nodeHmacHex(text(DOCS.serverSeed), text(DOCS.message))).toBe(DOCS.hmacHex);
  });

  it('throws on a non-ASCII key or message', () => {
    expect(() => hmacSha256('kéy', 'message')).toThrow(/not ASCII/);
    expect(() => hmacSha256('key', 'méssage')).toThrow(/not ASCII/);
  });

  it('agrees with Node on 10,000 random ASCII keys and messages of 0 to 200 characters', () => {
    const next = xorshift32(0x5eed1234);
    // Fixed edge lengths first (empty, around the 64-byte block, the maximum),
    // then random ones.
    const edges = [0, 1, 31, 32, 33, 55, 56, 63, 64, 65, 127, 128, 129, 200];
    let longKeys = 0;
    for (let i = 0; i < 10_000; i++) {
      const keyLength = edges[i] ?? next() % 201;
      const messageLength = edges[edges.length - 1 - i] ?? next() % 201;
      if (keyLength > 64) longKeys++;
      const key = randomAscii(next, keyLength);
      const message = randomAscii(next, messageLength);
      const ours = bytesToHex(hmacSha256(key, message));
      const node = nodeHmacHex(text(key), text(message));
      if (ours !== node) {
        expect({ i, key, message, ours }).toEqual({ i, key, message, ours: node });
      }
    }
    // Keys over the 64-byte block size are hashed first; make sure many ran.
    expect(longKeys).toBeGreaterThan(3000);
  });
});

describe('SHA-256', () => {
  it('matches the known empty-input and "abc" digests', () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(nodeSha256Hex(new Uint8Array(0))).toBe(empty);
    expect(nodeSha256Hex(text('abc'))).toBe(abc);
    expect(bytesToHex(sha256Bytes(new Uint8Array(0)))).toBe(empty);
    expect(bytesToHex(sha256Bytes(text('abc')))).toBe(abc);
  });

  it('agrees with Node on 10,000 random ASCII inputs of 0 to 200 characters', () => {
    const next = xorshift32(0xc0ffee);
    for (let i = 0; i < 10_000; i++) {
      const input = text(randomAscii(next, next() % 201));
      const ours = bytesToHex(sha256Bytes(input));
      const node = nodeSha256Hex(input);
      if (ours !== node) expect({ i, ours }).toEqual({ i, ours: node });
    }
  });
});

describe('hashServerSeed', () => {
  it('gives the docs example', () => {
    expect(hashServerSeed(DOCS.serverSeed)).toBe(DOCS.serverSeedHash);
    expect(nodeSha256Hex(text(DOCS.serverSeed))).toBe(DOCS.serverSeedHash);
  });

  it('hashes the 64 characters, not the 32 bytes they spell', () => {
    const ofBytes = nodeSha256Hex(Buffer.from(DOCS.serverSeed, 'hex'));
    expect(hashServerSeed(DOCS.serverSeed)).not.toBe(ofBytes);
  });

  it('agrees with Node on 1,000 random server seeds', () => {
    const next = xorshift32(42);
    for (let i = 0; i < 1000; i++) {
      let seed = '';
      for (let j = 0; j < 64; j++) seed += '0123456789abcdef'.charAt(next() % 16);
      expect(hashServerSeed(seed)).toBe(nodeSha256Hex(text(seed)));
    }
  });

  it('throws on anything that is not a server seed', () => {
    for (const bad of ['', DOCS.serverSeed.toUpperCase(), DOCS.serverSeed.slice(1), 'myseed']) {
      expect(() => hashServerSeed(bad)).toThrow(/Server seed must be exactly 64 lowercase hex/);
    }
  });
});

describe('verifyServerSeedHash', () => {
  it('accepts the docs seed with its hash', () => {
    expect(verifyServerSeedHash(DOCS.serverSeed, DOCS.serverSeedHash)).toBe(true);
  });

  it('rejects a wrong hash, a wrong seed, an uppercase hash and an invalid seed', () => {
    const otherSeed = `b${DOCS.serverSeed.slice(1)}`;
    expect(verifyServerSeedHash(otherSeed, DOCS.serverSeedHash)).toBe(false);
    expect(verifyServerSeedHash(DOCS.serverSeed, hashServerSeed(otherSeed))).toBe(false);
    expect(verifyServerSeedHash(DOCS.serverSeed, DOCS.serverSeedHash.toUpperCase())).toBe(false);
    expect(verifyServerSeedHash(DOCS.serverSeed, '')).toBe(false);
    expect(verifyServerSeedHash(DOCS.serverSeed.toUpperCase(), DOCS.serverSeedHash)).toBe(false);
    expect(verifyServerSeedHash('', DOCS.serverSeedHash)).toBe(false);
  });
});

describe('bytesToHex', () => {
  it('writes two lowercase digits per byte, high digit first', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255]))).toBe(
      '00010f107f80feff',
    );
  });

  it('matches Node for all 256 byte values', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToHex(all)).toBe(Buffer.from(all).toString('hex'));
  });
});
