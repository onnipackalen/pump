import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { immediate, undoable } from '../src/db/transaction';
import { count } from './helpers';

function scratchDb() {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE notes (text TEXT NOT NULL) STRICT');
  return db;
}

describe('immediate', () => {
  it('keeps everything when the work finishes', () => {
    const db = scratchDb();
    const result = immediate(db, () => {
      db.exec("INSERT INTO notes VALUES ('a')");
      db.exec("INSERT INTO notes VALUES ('b')");
      return 'done';
    });
    expect(result).toBe('done');
    expect(count(db, 'notes')).toBe(2);
    expect(db.isTransaction).toBe(false);
  });

  it('keeps nothing when the work throws', () => {
    const db = scratchDb();
    expect(() =>
      immediate(db, () => {
        db.exec("INSERT INTO notes VALUES ('a')");
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(count(db, 'notes')).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('refuses work that returns a promise, and keeps nothing', () => {
    const db = scratchDb();
    expect(() =>
      immediate(db, () => {
        db.exec("INSERT INTO notes VALUES ('a')");
        return Promise.resolve('later');
      }),
    ).toThrow('must be synchronous');
    expect(count(db, 'notes')).toBe(0);
  });

  it('does not nest', () => {
    const db = scratchDb();
    expect(() => immediate(db, () => immediate(db, () => 1))).toThrow('do not nest');
    expect(db.isTransaction).toBe(false);
  });
});

describe('undoable', () => {
  it('undoes only its own work when it throws, and lets the transaction go on', () => {
    const db = scratchDb();
    immediate(db, () => {
      db.exec("INSERT INTO notes VALUES ('kept before')");
      expect(() =>
        undoable(db, () => {
          db.exec("INSERT INTO notes VALUES ('undone')");
          throw new Error('refused');
        }),
      ).toThrow('refused');
      db.exec("INSERT INTO notes VALUES ('kept after')");
    });
    const texts = db
      .prepare('SELECT text FROM notes ORDER BY rowid')
      .all()
      .map((row) => row.text);
    expect(texts).toEqual(['kept before', 'kept after']);
  });

  it('needs an open transaction', () => {
    const db = scratchDb();
    expect(() => undoable(db, () => 1)).toThrow('needs an open transaction');
  });
});
