import { randomBytes, randomUUID } from 'node:crypto';
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import type { Db } from './db/database';
import type { Features } from './features';

/**
 * Everything the services need from the outside world: the database, the
 * game's configuration, the clock and the sources of randomness. Tests pass
 * their own, so time and ids are predictable there.
 */
export interface Runtime {
  readonly db: Db;
  /** RTP, limits and ladders. New rounds are started with these. */
  readonly config: GameConfig;
  /** What is switched on for this market. Not game math: see features.ts. */
  readonly features: Features;
  readonly now: () => Date;
  /** A new unique id for a player or a round. */
  readonly newId: () => string;
  /** A new secret for a player's cookie. */
  readonly newToken: () => string;
  /** A new server seed: 32 random bytes as 64 lowercase hex characters. */
  readonly newServerSeed: () => string;
}

/** The real thing: the system clock and the operating system's secure random source. */
export function systemRuntime(db: Db, features: Features): Runtime {
  return {
    db,
    config: GAME_CONFIG,
    features,
    now: () => new Date(),
    newId: () => randomUUID(),
    newToken: () => randomBytes(32).toString('base64url'),
    newServerSeed: () => randomBytes(32).toString('hex'),
  };
}
