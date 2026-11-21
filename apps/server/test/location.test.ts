import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { databasePlace, runningOnHost } from '../src/db/location';

// Every wallet is in one file. These are the rules that keep that file off a
// host's throwaway disk, where the next deploy would wipe it.

const FALLBACK = '/app/apps/server/data/pump.db';
const diskAt =
  (...folders: string[]) =>
  (folder: string): boolean =>
    folders.includes(folder);

describe('where the database file may live', () => {
  it('uses the file inside the app folder on a developer’s machine, and makes its folder', () => {
    const place = databasePlace({
      chosen: undefined,
      onHost: false,
      fallback: FALLBACK,
      folderExists: diskAt(),
    });
    expect(place).toEqual({ path: FALLBACK, createFolder: true });
  });

  it.each([undefined, '', '   '])(
    'refuses to start on a host when DATABASE_PATH is %j',
    (chosen) => {
      expect(() =>
        databasePlace({ chosen, onHost: true, fallback: FALLBACK, folderExists: diskAt() }),
      ).toThrow(/DATABASE_PATH is not set/);
    },
  );

  it('uses the chosen file when its folder is there, and never makes that folder', () => {
    const place = databasePlace({
      chosen: '/var/data/pump.db',
      onHost: true,
      fallback: FALLBACK,
      folderExists: diskAt('/var/data'),
    });
    expect(place).toEqual({ path: '/var/data/pump.db', createFolder: false });
  });

  it('refuses a chosen file whose folder is missing: the disk is not attached there, or the path is mistyped', () => {
    for (const onHost of [true, false]) {
      expect(() =>
        databasePlace({
          chosen: '/var/daat/pump.db',
          onHost,
          fallback: FALLBACK,
          folderExists: diskAt('/var/data'),
        }),
      ).toThrow(/the folder "\/var\/daat" does not exist/);
    }
  });

  it('refuses a path that is not a full path on a host, but allows it on a developer’s machine', () => {
    const inputs = { chosen: 'data/pump.db', fallback: FALLBACK, folderExists: diskAt('data') };
    expect(() => databasePlace({ ...inputs, onHost: true })).toThrow(/must be a full path/);
    expect(databasePlace({ ...inputs, onHost: false })).toEqual({
      path: 'data/pump.db',
      createFolder: false,
    });
  });
});

describe('telling a host from a developer’s machine', () => {
  it('is a host when NODE_ENV is production or RENDER is set', () => {
    expect(runningOnHost({ NODE_ENV: 'production' })).toBe(true);
    expect(runningOnHost({ RENDER: 'true' })).toBe(true);
  });

  it('is a developer’s machine otherwise', () => {
    expect(runningOnHost({})).toBe(false);
    expect(runningOnHost({ NODE_ENV: 'development' })).toBe(false);
    expect(runningOnHost({ NODE_ENV: 'test' })).toBe(false);
  });
});

describe('opening the database file', () => {
  it('does not make a missing folder unless asked to', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'pump-place-')), 'not-there', 'pump.db');
    expect(() => openDatabase(missing)).toThrow();
    const db = openDatabase(missing, { createFolder: true });
    db.close();
  });
});
