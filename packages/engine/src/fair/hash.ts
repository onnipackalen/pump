/**
 * HMAC-SHA256 and SHA-256, the two hash steps in the fairness recipe.
 *
 * - SHA-256 makes the server seed's public fingerprint. The player sees
 *   SHA-256(server seed) before playing; once the seed is revealed they hash
 *   it themselves and compare. The hash is taken over the seed's 64 hex
 *   characters as ASCII text, not over the 32 bytes they spell.
 * - HMAC-SHA256 mixes the server seed (key) with the draw message (data) into
 *   32 bytes, which roll.ts turns into a roll.
 *
 * Both come from @noble/hashes, a small audited pure-JavaScript library with
 * no dependencies. It needs no Node or browser crypto API, so this file runs
 * the same, synchronously, on the server and on the verify page. The tests
 * check it against Node's own crypto on the RFC 4231 vectors and on 10,000
 * random inputs.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { asciiBytes } from './ascii';
import { assertServerSeed, isServerSeed } from './seeds';

/** HMAC-SHA256 over raw bytes. 32 bytes out. */
export function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

/** SHA-256 over raw bytes. 32 bytes out. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * HMAC-SHA256 with ASCII text as the key and ASCII text as the message.
 *
 * In the recipe the key is the server seed's 64 characters and the message is
 * the draw message. Throws if either is not ASCII.
 */
export function hmacSha256(keyText: string, messageText: string): Uint8Array {
  return hmacSha256Bytes(asciiBytes(keyText), asciiBytes(messageText));
}

/** Lowercase hex digits, indexed by value. */
const HEX_DIGITS = '0123456789abcdef';

/** Bytes as lowercase hex, two digits per byte, most significant digit first. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    // byte >> 4 is the high half (0-15), byte & 15 the low half (0-15).
    hex += HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 15);
  }
  return hex;
}

/**
 * The server seed's public fingerprint: SHA-256 of its 64 characters (as
 * ASCII), written as 64 lowercase hex characters.
 *
 * Throws unless `serverSeed` is a valid server seed. The error does not
 * include the seed.
 */
export function hashServerSeed(serverSeed: string): string {
  assertServerSeed(serverSeed);
  return bytesToHex(sha256Bytes(asciiBytes(serverSeed)));
}

/**
 * True when `serverSeed` is a valid server seed and `hash` is exactly its
 * fingerprint from hashServerSeed (64 lowercase hex characters).
 *
 * Anything else is false rather than an error, including an invalid seed and
 * a hash in uppercase: the game only ever shows the lowercase form, so a
 * different spelling did not come from it. A plain comparison is fine here,
 * because by the time anyone verifies, both the hash and the seed are public.
 */
export function verifyServerSeedHash(serverSeed: string, hash: string): boolean {
  return isServerSeed(serverSeed) && hashServerSeed(serverSeed) === hash;
}
