/**
 * One draw: seeds and counters in, one uniform roll out.
 *
 * This joins the three steps together. For block b = 0, 1, 2, ...:
 *
 *     message_b = drawMessage(clientSeed, nonce, balloonIndex, drawIndex, b)
 *     bytes_b   = HMAC-SHA256(key = serverSeed, data = message_b)
 *
 * and sampleRoll reads those blocks in order until a word is accepted. Block 1
 * is computed only if every word of block 0 was rejected, and so on.
 */
import { hmacSha256 } from './hash';
import { drawMessage } from './message';
import { sampleRoll, type SampledRoll } from './roll';
import { assertServerSeed } from './seeds';

/** Everything that identifies one draw. */
export interface DrawInputs {
  /** The active server seed: 64 lowercase hex characters, secret until rotated. */
  readonly serverSeed: string;
  /** The player's client seed for this round. */
  readonly clientSeed: string;
  /** The round's nonce under this server seed. */
  readonly nonce: number;
  /** Which balloon in the round. */
  readonly balloonIndex: number;
  /** Draws already made on this balloon before this one. */
  readonly drawIndex: number;
}

/**
 * What the engine is handed for one pump: it asks for one whole number in
 * [0, den) and gets it. Usable once.
 */
export type Drawer = (den: number) => number;

/**
 * Checks every input and returns a copy, so later changes to the caller's
 * object cannot change the draw. Throws on a bad seed or counter; the error
 * never includes the server seed.
 */
function checkedInputs(inputs: DrawInputs): DrawInputs {
  const { serverSeed, clientSeed, nonce, balloonIndex, drawIndex } = inputs;
  assertServerSeed(serverSeed);
  // Building the block-0 message checks the client seed and the three counters.
  drawMessage({ clientSeed, nonce, balloonIndex, drawIndex, block: 0 });
  return { serverSeed, clientSeed, nonce, balloonIndex, drawIndex };
}

/**
 * The roll for one draw, and where in the HMAC bytes it was found.
 *
 * `den` is the denominator of the pump's survive fraction num / den, in lowest
 * terms; the engine works that fraction out and decides survive (roll < num)
 * itself. This function knows nothing about the game. Throws on a bad seed,
 * counter or den, before any HMAC is computed.
 */
export function drawRoll(inputs: DrawInputs, den: number): SampledRoll {
  const { serverSeed, clientSeed, nonce, balloonIndex, drawIndex } = checkedInputs(inputs);
  const blockAt = (block: number): Uint8Array =>
    hmacSha256(serverSeed, drawMessage({ clientSeed, nonce, balloonIndex, drawIndex, block }));
  return sampleRoll(blockAt, den);
}

/**
 * A single-use drawer for the engine: `drawerFor(inputs)(den)` is
 * `drawRoll(inputs, den).roll`.
 *
 * The inputs are checked and copied now, so a bad seed fails before the pump
 * is resolved. The returned function may be called exactly once. Any later
 * call throws, even if the first one threw (on a bad den, say): one draw
 * decides one pump, and a draw is never used twice.
 */
export function drawerFor(inputs: DrawInputs): Drawer {
  const checked = checkedInputs(inputs);
  let used = false;
  return (den: number): number => {
    if (used) throw new Error('This draw has already been used. One draw decides one pump.');
    used = true;
    return drawRoll(checked, den).roll;
  };
}
