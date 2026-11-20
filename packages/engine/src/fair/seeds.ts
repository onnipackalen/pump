/**
 * What counts as a valid client seed and a valid server seed.
 *
 * Both checks are written as whole-string regular expressions. In JavaScript,
 * `$` without the `m` flag matches only at the very end of the text, so a
 * trailing newline is rejected (unlike `$` in some other languages).
 */

/**
 * Client seed: 1 to 64 characters, each one of A-Z, a-z, 0-9, `_` or `-`.
 *
 * The player chooses it. It can never contain `:`, the separator in the draw
 * message, so two different draws can never produce the same message.
 */
const CLIENT_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Server seed: exactly 64 lowercase hex characters (32 random bytes, written
 * out). Uppercase is rejected so each seed has exactly one spelling, and so
 * its SHA-256 (taken over those 64 characters) has exactly one value.
 */
const SERVER_SEED_PATTERN = /^[0-9a-f]{64}$/;

/** True when `value` is a valid client seed. */
export function isClientSeed(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SEED_PATTERN.test(value);
}

/** Throws unless `value` is a valid client seed. */
export function assertClientSeed(value: unknown): asserts value is string {
  if (!isClientSeed(value)) {
    throw new Error(
      'Client seed must be 1 to 64 characters, each one of A-Z, a-z, 0-9, _ or -.',
    );
  }
}

/** True when `value` is a valid server seed. */
export function isServerSeed(value: unknown): value is string {
  return typeof value === 'string' && SERVER_SEED_PATTERN.test(value);
}

/**
 * Throws unless `value` is a valid server seed.
 *
 * The message never includes the value: an unrevealed server seed is secret,
 * and error messages end up in logs.
 */
export function assertServerSeed(value: unknown): asserts value is string {
  if (!isServerSeed(value)) {
    throw new Error('Server seed must be exactly 64 lowercase hex characters (0-9, a-f).');
  }
}
