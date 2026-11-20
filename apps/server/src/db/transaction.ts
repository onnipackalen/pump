import type { Db } from './database';

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Runs `work` as one transaction: everything in it happens, or none of it.
 *
 * "Immediate" means the write lock is taken at the start, not at the first
 * write. Two requests can therefore never both read a balance and then both
 * spend it: the second one waits until the first has committed.
 *
 * `work` must be synchronous. An `await` inside would let another request run
 * in the middle of this one, so a callback that returns a promise is refused
 * and rolled back.
 */
export function immediate<T>(db: Db, work: () => T): T {
  if (db.isTransaction) throw new Error('A transaction is already open; they do not nest');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (isThenable(result)) {
      throw new Error('A transaction callback must be synchronous: no await inside it');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Runs `work` inside an open transaction so that it can be undone on its own.
 * If `work` throws, only its changes are rolled back and the error is passed
 * on; the surrounding transaction stays open and can still commit.
 */
export function undoable<T>(db: Db, work: () => T): T {
  if (!db.isTransaction) throw new Error('undoable() needs an open transaction');
  db.exec('SAVEPOINT undoable');
  try {
    const result = work();
    if (isThenable(result)) {
      throw new Error('A transaction callback must be synchronous: no await inside it');
    }
    db.exec('RELEASE undoable');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO undoable');
    db.exec('RELEASE undoable');
    throw error;
  }
}

/** Throws unless a transaction is open. For code that must never run outside one. */
export function assertInTransaction(db: Db): void {
  if (!db.isTransaction) throw new Error('This must run inside a transaction');
}
