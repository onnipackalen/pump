/** What a client seed may contain: 1 to 64 of A-Z, a-z, 0-9, _ and -. No ':'. */
export const CLIENT_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A fresh client seed made in this browser: 16 random bytes as 32 hex
 * characters. The server never chooses the player's first seed.
 */
export function makeClientSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
