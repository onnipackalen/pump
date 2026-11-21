import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { migrate } from '../src/db/migrations';
import { count } from './helpers';

// The database's steps are applied once and in order. These tests cover what
// happens when the server is started on a file it has seen before, and on a
// file that a NEWER version of the server has already changed.

describe('applying the database steps', () => {
  it('applies them once: a second start changes nothing', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const steps = count(db, 'schema_migrations');
    expect(steps).toBeGreaterThan(0);

    migrate(db);

    expect(count(db, 'schema_migrations')).toBe(steps);
  });

  it('refuses a database that holds a step this version does not know', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // What a newer version of the server leaves behind: one more recorded step.
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (:id, :name, :at)',
    ).run({ id: 9999, name: 'a step from the future', at: '2026-01-01T00:00:00.000Z' });

    // An older version must not run on it: a rollback is refused at the door.
    expect(() => {
      migrate(db);
    }).toThrow(/changed by a newer version.*step 9999 \("a step from the future"\)/s);
    // The words an operator reads must never suggest losing the wallets.
    expect(() => {
      migrate(db);
    }).toThrow(/Do NOT delete or change the database file/);
  });

  it('does not touch a newer database before refusing it', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (:id, :name, :at)',
    ).run({ id: 9999, name: 'a step from the future', at: '2026-01-01T00:00:00.000Z' });
    const before = count(db, 'schema_migrations');

    expect(() => {
      migrate(db);
    }).toThrow();

    expect(count(db, 'schema_migrations')).toBe(before);
    expect(count(db, 'players')).toBe(0);
  });
});
