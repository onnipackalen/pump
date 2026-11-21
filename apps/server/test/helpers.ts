import { createHash } from 'node:crypto';
import type { SessionView } from '@pump/contract';
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDatabase, type Db } from '../src/db/database';
import { migrate } from '../src/db/migrations';
import { int } from '../src/db/rows';
import type { Runtime } from '../src/runtime';
import { buildServices, type Services } from '../src/services';
import { PLAYER_COOKIE } from '../src/settings';

export interface TestRuntime extends Runtime {
  /** Moves the test clock forward. */
  advance(milliseconds: number): void;
}

/**
 * A runtime on a fresh in-memory database, with a clock that only moves when
 * told to and "random" values that are the same on every run.
 */
export function testRuntime(config: GameConfig = GAME_CONFIG): TestRuntime {
  const db = openDatabase(':memory:');
  migrate(db);
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  let counter = 0;
  const bytes = (label: string): Buffer =>
    createHash('sha256')
      .update(`${label}:${String(counter++)}`)
      .digest();
  return {
    db,
    config,
    now: () => new Date(time),
    newId: () => `id-${String(counter++)}`,
    newToken: () => bytes('token').toString('base64url'),
    newServerSeed: () => bytes('seed').toString('hex'),
    advance(milliseconds) {
      time += milliseconds;
    },
  };
}

export interface TestWorld {
  readonly runtime: TestRuntime;
  readonly db: Db;
  readonly services: Services;
  readonly app: FastifyInstance;
}

export function testWorld(config: GameConfig = GAME_CONFIG): TestWorld {
  const runtime = testRuntime(config);
  return {
    runtime,
    db: runtime.db,
    services: buildServices(runtime),
    app: buildApp({ runtime }),
  };
}

export interface Visitor {
  /** The player cookie, ready to pass to app.inject({ cookies }). */
  readonly cookies: Record<string, string>;
  /** The raw Set-Cookie header of the first response. */
  readonly setCookie: string;
  readonly session: SessionView;
}

/** A first visit: loads the session with no cookie and keeps the one it is given. */
export async function firstVisit(app: FastifyInstance): Promise<Visitor> {
  const response = await app.inject({ method: 'GET', url: '/api/session' });
  const header = response.headers['set-cookie'];
  const setCookie = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  const token = new RegExp(`${PLAYER_COOKIE}=([^;]+)`).exec(setCookie)?.[1];
  if (!token) throw new Error('The first visit did not set a player cookie');
  return {
    cookies: { [PLAYER_COOKIE]: token },
    setCookie,
    session: response.json<SessionView>(),
  };
}

/** How many rows a table has. */
export function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (!row) throw new Error('COUNT returned nothing');
  return int(row, 'n');
}

/** The only player in the database, for tests that create exactly one. */
export function onlyPlayerId(db: Db): string {
  const rows = db.prepare('SELECT id FROM players').all();
  const id = rows[0]?.id;
  if (rows.length !== 1 || typeof id !== 'string') throw new Error('Expected exactly one player');
  return id;
}

/**
 * Puts an active round straight into the database, with one unpumped balloon
 * per bet. Tests that need "a round is in progress" without playing one use
 * this. It follows the database's own rules: the seed hands out the nonce
 * first, then the round and its balloons are written.
 */
export function insertActiveRound(
  db: Db,
  playerId: string,
  roundId = 'round-1',
  betsCents: readonly number[] = [],
): void {
  const seed = db
    .prepare('SELECT id, next_nonce FROM server_seeds WHERE player_id = ? AND revealed_at IS NULL')
    .get(playerId);
  if (!seed) throw new Error('Player has no active seed');
  const at = '2026-01-01T00:00:00.000Z';
  db.prepare('UPDATE server_seeds SET next_nonce = next_nonce + 1 WHERE id = ?').run(
    int(seed, 'id'),
  );
  db.prepare(
    `INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder,
                         server_seed_id, client_seed, nonce, started_at, last_action_at,
                         max_payout_cents)
     VALUES (?, ?, 'active', 'easy', ?, '[101,111]', ?, 'seed', ?, ?, ?, ?)`,
  ).run(
    roundId,
    playerId,
    GAME_CONFIG.rtpBp,
    int(seed, 'id'),
    int(seed, 'next_nonce'),
    at,
    at,
    GAME_CONFIG.limits.maxPayoutCents,
  );
  betsCents.forEach((betCents, balloonIndex) => {
    db.prepare(
      `INSERT INTO balloons (round_id, balloon_index, bet_cents, status, rung, draw_index, top_rung)
       VALUES (?, ?, ?, 'active', 0, 0, 2)`,
    ).run(roundId, balloonIndex, betCents);
  });
}

/**
 * Ends a round by hand: any balloon still in play is popped, each balloon
 * cashed out below its top rung gets a made-up reveal, then the round is
 * closed.
 */
export function finishRound(db: Db, roundId = 'round-1'): void {
  db.prepare("UPDATE balloons SET status = 'popped' WHERE round_id = ? AND status = 'active'").run(
    roundId,
  );
  // The database closes a round only with these reveals in place. A made-up
  // one: the very next pump pops (roll 1 is not below num 1).
  db.prepare(
    `INSERT INTO balloon_reveals (round_id, balloon_index, outcome, reached_rung, draws_json, created_at)
     SELECT round_id, balloon_index, 'popped', rung,
            json_array(json_object('drawIndex', draw_index, 'den', 2, 'num', 1, 'roll', 1)), ?
     FROM balloons WHERE round_id = ? AND status = 'cashed' AND rung < top_rung`,
  ).run('2026-01-01T00:05:00.000Z', roundId);
  db.prepare("UPDATE rounds SET status = 'finished', finished_at = ? WHERE id = ?").run(
    '2026-01-01T00:05:00.000Z',
    roundId,
  );
}

/** As if `rounds` more rounds had been played on the active seed: the nonce goes up one at a time. */
export function bumpNonce(db: Db, rounds: number): void {
  for (let i = 0; i < rounds; i += 1) {
    db.exec('UPDATE server_seeds SET next_nonce = next_nonce + 1 WHERE revealed_at IS NULL');
  }
}

/** Takes one balloon of a hand-made round up one rung and cashes it out for `payoutCents`. */
export function cashOutByHand(db: Db, roundId: string, balloonIndex: number, payoutCents: number): void {
  db.prepare(
    'UPDATE balloons SET rung = 1, draw_index = 1 WHERE round_id = ? AND balloon_index = ?',
  ).run(roundId, balloonIndex);
  db.prepare(
    "UPDATE balloons SET status = 'cashed', payout_cents = ? WHERE round_id = ? AND balloon_index = ?",
  ).run(payoutCents, roundId, balloonIndex);
}
