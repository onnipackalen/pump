/**
 * Text to bytes, strictly ASCII.
 *
 * The fairness recipe feeds two pieces of text into HMAC-SHA256: the server
 * seed (the key) and the draw message (the data). Both are plain ASCII by
 * construction, so each character becomes exactly one byte with the same
 * value. Anyone re-checking a round with their own tools gets the same bytes
 * whether their language calls it ASCII, Latin-1 or UTF-8, because those
 * three agree on characters 0 to 127.
 *
 * TextEncoder would also do this for ASCII, but the engine runs without DOM or
 * Node globals, and TextEncoder quietly turns anything else into UTF-8. Here,
 * anything outside ASCII is a bug in the caller, so it throws instead.
 */

/** The highest ASCII character code. */
const ASCII_MAX = 127;

/**
 * One byte per character, each byte equal to the character code.
 *
 * Throws on any character code above 127. JavaScript strings are UTF-16, so a
 * character outside the Basic Multilingual Plane (an emoji, say) arrives as
 * two code units, both above 127; it is rejected like any other non-ASCII
 * character.
 */
export function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > ASCII_MAX) {
      // The text may be a secret (a server seed), so only say where it failed.
      throw new Error(`Text is not ASCII: character ${i} has code ${code}, above ${ASCII_MAX}.`);
    }
    bytes[i] = code;
  }
  return bytes;
}
