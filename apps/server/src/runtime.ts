import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db/database';

/**
 * Everything the services need from the outside world: the database, the
 * clock and the sources of randomness. Tests pass their own, so time and
 * ids are predictable there.
 */
export interface Runtime {
  readonly db: Db;
  readonly now: () => Date;
  /** A new unique id for a player or a round. */
  readonly newId: () => string;
  /** A new secret for a player's cookie. */
  readonly newToken: () => string;
  /** A new server seed: 32 random bytes as 64 lowercase hex characters. */
  readonly newServerSeed: () => string;
}

/** The real thing: the system clock and the operating system's secure random source. */
export function systemRuntime(db: Db): Runtime {
  return {
    db,
    now: () => new Date(),
    newId: () => randomUUID(),
    newToken: () => randomBytes(32).toString('base64url'),
    newServerSeed: () => randomBytes(32).toString('hex'),
  };
}
