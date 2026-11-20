/**
 * How an error message names a value that failed a number check.
 *
 * The checks in message.ts and roll.ts take numbers, but data that crossed an
 * unchecked boundary can arrive as something else: a string from a request
 * body, or a bigint from a database driver that reads INTEGER columns that
 * way. String(value) would turn "5", 5n and [5] all into `5`, so the message
 * would read "got 5" and look as if a valid number had been refused. This
 * names the type instead.
 *
 *   number   its decimal text, as before: 5, -1, 1.5, NaN, Infinity
 *   bigint   "a bigint (5n)"
 *   string   "a string", without its text: a string in the wrong place could
 *            be a server seed, which must never reach a log (see seeds.ts)
 *   other    "null", "undefined", "an array", "a boolean", "an object", ...
 */
export function describeValue(value: unknown): string {
  switch (typeof value) {
    case 'number':
      return String(value);
    case 'bigint':
      return `a bigint (${String(value)}n)`;
    case 'undefined':
      return 'undefined';
    case 'object':
      if (value === null) return 'null';
      return Array.isArray(value) ? 'an array' : 'an object';
    default:
      // 'string', 'boolean', 'symbol' or 'function'.
      return `a ${typeof value}`;
  }
}
