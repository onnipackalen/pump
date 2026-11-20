/**
 * The draw message: the text that HMAC-SHA256 mixes with the server seed.
 *
 *     clientSeed:nonce:balloonIndex:drawIndex:block
 *
 * for example `myseed:5:0:0:0`.
 *
 * Why this identifies one draw exactly:
 * - The client seed cannot contain `:` (see seeds.ts), and the four numbers
 *   are written in plain decimal, which has no `:` either. So the message
 *   splits back into its five parts in exactly one way, and two different
 *   draws can never share a message.
 * - The nonce picks the round, the balloon index the balloon, and the draw
 *   index counts draws already made on that balloon. A balloon's outcomes
 *   therefore do not depend on the order the player clicks balloons in.
 * - The block number picks which 32-byte block of that draw is being read.
 *   It is always present and starts at 0; see roll.ts for when block 1 and
 *   later are needed.
 */
import { describeValue } from './describe';
import { assertClientSeed } from './seeds';

/** The five parts of one draw message. */
export interface DrawMessageParts {
  readonly clientSeed: string;
  /** Round counter for the active server seed: 0, 1, 2, ... */
  readonly nonce: number;
  /** Which balloon in the round: 0, 1, 2, ... */
  readonly balloonIndex: number;
  /** Draws already made on this balloon before this one: 0, 1, 2, ... */
  readonly drawIndex: number;
  /** Which 32-byte block of this draw: 0, 1, 2, ... */
  readonly block: number;
}

/**
 * Throws unless `value` is a whole number from 0 to 2^53 - 1.
 *
 * Number.isSafeInteger rejects NaN, Infinity, fractions and anything at or
 * beyond 2^53, where doubles stop being able to tell neighbouring integers
 * apart. For every safe integer, String(value) is plain decimal: no exponent
 * (that only starts at 1e21), no leading zeros, no plus sign.
 *
 * -0 passes, and String(-0) is "0". That is deliberate: -0 and 0 are the same
 * number for every purpose here, and they produce the same message.
 *
 * A value that is not a number at all (a string or bigint from an unchecked
 * boundary) is rejected too, and the error names its type (see describe.ts).
 */
export function assertCounter(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a whole number from 0 to 2^53 - 1, got ${describeValue(value)}.`,
    );
  }
}

/** Builds `clientSeed:nonce:balloonIndex:drawIndex:block`, checking every part. */
export function drawMessage(parts: DrawMessageParts): string {
  const { clientSeed, nonce, balloonIndex, drawIndex, block } = parts;
  assertClientSeed(clientSeed);
  assertCounter('nonce', nonce);
  assertCounter('balloonIndex', balloonIndex);
  assertCounter('drawIndex', drawIndex);
  assertCounter('block', block);
  return [clientSeed, nonce, balloonIndex, drawIndex, block].map(String).join(':');
}
