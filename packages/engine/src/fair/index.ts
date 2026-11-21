/**
 * @pump/engine/fair: turning seeds into draws (provably fair).
 *
 * Kept apart from PumpEngine.ts, which must not touch crypto or seeds: engine
 * files outside this folder may import only types from here (`import type`),
 * and nothing from @noble. test/fair/boundary.test.ts checks this.
 *
 * The server and the browser verify page both import this, so a round can be
 * recomputed anywhere from its seeds. It is pure and synchronous: no I/O, no
 * clock, no randomness of its own, and the same result in Node and in the
 * browser.
 *
 * The recipe for one pump, top to bottom (docs/fairness.md has a worked
 * example with real numbers):
 *
 * 1. Inputs (seeds.ts, message.ts). A server seed of 64 lowercase hex
 *    characters, shown only as its SHA-256 until the player rotates it. A
 *    client seed of 1 to 64 characters from A-Z a-z 0-9 _ -, which the player
 *    picks. A nonce counting rounds under the server seed, a balloon index,
 *    and a draw index counting draws already made on that balloon.
 * 2. Message (message.ts). `clientSeed:nonce:balloonIndex:drawIndex:block`,
 *    numbers in plain decimal, block starting at 0. The client seed has no
 *    `:`, so each draw has its own message.
 * 3. Bytes (hash.ts). HMAC-SHA256, key = the server seed's 64 characters as
 *    ASCII, data = the message as ASCII: 32 bytes.
 * 4. Words (roll.ts). Those 32 bytes as 8 unsigned 32-bit big-endian numbers.
 * 5. Roll (roll.ts). For a survive chance num / den in lowest terms:
 *    limit = 2^32 - (2^32 mod den); the first word below limit gives
 *    roll = word mod den, which is exactly uniform over 0 .. den - 1. If all 8
 *    words are at or above limit, the next block (block 1, 2, ...) is read.
 * 6. Decide (the engine, not here). The pump survives if roll < num.
 *
 * After the round (draw.ts revealDrawerFor): once a round is over, each
 * balloon cashed out below its top rung shows where it would have popped. The
 * engine plays it on with plain pumps, using this same recipe at the next
 * draw indexes (from the balloon's draw count up), until a pump pops or it
 * reaches its top rung. Those draws decide nothing and move no money.
 *
 * Checking a seed (hash.ts): its fingerprint is SHA-256 of its 64 characters
 * as ASCII, in lowercase hex.
 *
 * Checking a whole round (verify.ts): verifyRound takes what the server
 * stored about a finished round, replays every balloon with the engine's own
 * replayBalloon and draws from these seeds, and lists every place where the
 * server's account differs. This is the one file here that imports the game
 * rules; the rules never import this module (test/fair/boundary.test.ts).
 */
export { asciiBytes } from './ascii';
export {
  drawerFor,
  drawRoll,
  revealDrawerFor,
  type DrawInputs,
  type Drawer,
  type RevealDrawer,
} from './draw';
export { bytesToHex, hashServerSeed, hmacSha256, verifyServerSeedHash } from './hash';
export { drawMessage, type DrawMessageParts } from './message';
export {
  acceptanceLimit,
  BLOCK_BYTES,
  MAX_BLOCKS,
  readWords,
  rollFromWord,
  sampleRoll,
  WORD_SPACE,
  WORDS_PER_BLOCK,
  type BlockSource,
  type SampledRoll,
} from './roll';
export { assertClientSeed, assertServerSeed, isClientSeed, isServerSeed } from './seeds';
export {
  verifyRound,
  type BalloonCheck,
  type BalloonRecord,
  type CheckedDraw,
  type ClaimedBalloon,
  type RoundCheck,
  type RoundRecord,
} from './verify';
