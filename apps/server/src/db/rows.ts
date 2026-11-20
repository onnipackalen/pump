/**
 * SQLite hands rows back as loosely typed objects. These readers turn one
 * column into a known type, or throw, so nothing unchecked leaves the
 * repositories.
 */
export type Row = Readonly<Record<string, unknown>>;

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Column ${column} is not a whole number`);
  }
  return value;
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Column ${column} is not text`);
  return value;
}

export function nullableText(row: Row, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

export function nullableInt(row: Row, column: string): number | null {
  return row[column] === null ? null : int(row, column);
}
