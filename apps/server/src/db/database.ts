import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The database handle. It is Node's built-in SQLite, which is synchronous:
 * a query returns its rows directly, with no `await`. That is what lets a
 * whole request run as one uninterrupted transaction.
 */
export type Db = DatabaseSync;

/**
 * Opens the database file. Pass ':memory:' for a throwaway database in tests.
 *
 * The file's folder is made only when asked. Where the file may live, and
 * why its folder is usually NOT made, is decided in location.ts.
 */
export function openDatabase(path: string, options: { createFolder?: boolean } = {}): Db {
  if (options.createFolder === true) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL: readers never block the writer, and a crash cannot leave half a commit.
  db.exec('PRAGMA journal_mode = WAL');
  // FULL: a commit is on disk before we answer. This is money, so no shortcuts.
  db.exec('PRAGMA synchronous = FULL');
  // SQLite only enforces foreign keys when asked to.
  db.exec('PRAGMA foreign_keys = ON');
  // Without this, INSERT OR REPLACE deletes the row it replaces WITHOUT
  // firing the "never delete" triggers. The schema also guards against
  // REPLACE on its own, for any other connection; this is the second lock.
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
