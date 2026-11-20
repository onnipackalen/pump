import { createHash } from 'node:crypto';
import type { FairnessView, RotateResult, SessionView } from '@pump/contract';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { text } from '../src/db/rows';
import {
  bumpNonce,
  count,
  firstVisit,
  insertActiveRound,
  onlyPlayerId,
  testWorld,
  type Visitor,
} from './helpers';

let app: FastifyInstance;
let db: Db;
let visitor: Visitor;
let keyCounter = 0;

/** A fresh idempotency key, as a browser would make for each new action. */
const newKey = (): string => `key-${String(keyCounter++)}`;

function setClientSeed(clientSeed: unknown, key = newKey()) {
  return app.inject({
    method: 'PUT',
    url: '/api/fairness/client-seed',
    cookies: visitor.cookies,
    headers: { 'idempotency-key': key },
    payload: { clientSeed },
  });
}

function rotate(key = newKey()) {
  return app.inject({
    method: 'POST',
    url: '/api/fairness/rotate',
    cookies: visitor.cookies,
    headers: { 'idempotency-key': key },
  });
}

/** The secret, straight from the database. No response may ever contain it. */
function activeSeed(): string {
  const row = db.prepare('SELECT seed FROM server_seeds WHERE revealed_at IS NULL').get();
  if (!row) throw new Error('no active seed');
  return text(row, 'seed');
}

/** SHA-256 of the seed's 64 characters, computed here without the project's own code. */
const sha256 = (value: string): string => createHash('sha256').update(value, 'ascii').digest('hex');

beforeEach(async () => {
  const world = testWorld();
  app = world.app;
  db = world.db;
  visitor = await firstVisit(app);
});

describe('the server seed', () => {
  it('is shown only as its SHA-256 hash', () => {
    expect(visitor.session.fairness.serverSeedHash).toBe(sha256(activeSeed()));
  });

  it('is 32 random bytes written as 64 lowercase hex characters', () => {
    expect(activeSeed()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PUT /api/fairness/client-seed', () => {
  it('sets the client seed and shows it in the session afterwards', async () => {
    const response = await setClientSeed('my-lucky_Seed-7');

    expect(response.statusCode).toBe(200);
    expect(response.json<FairnessView>()).toEqual({
      serverSeedHash: visitor.session.fairness.serverSeedHash,
      clientSeed: 'my-lucky_Seed-7',
      nextNonce: 0,
    });
    const session = await app.inject({ method: 'GET', url: '/api/session', cookies: visitor.cookies });
    expect(session.json<SessionView>().fairness.clientSeed).toBe('my-lucky_Seed-7');
  });

  it('never resets the nonce and never touches the server seed', async () => {
    // As if three rounds had been played on this server seed.
    bumpNonce(db, 3);

    const first = await setClientSeed('seed-A');
    const second = await setClientSeed('seed-B');
    const backAgain = await setClientSeed('seed-A');

    for (const response of [first, second, backAgain]) {
      expect(response.json<FairnessView>()).toMatchObject({
        nextNonce: 3,
        serverSeedHash: visitor.session.fairness.serverSeedHash,
      });
    }
    expect(count(db, 'server_seeds')).toBe(1);
  });

  it.each([
    ['a colon', 'bad:seed'],
    ['a space', 'bad seed'],
    ['nothing', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a newline at the end', 'seed\n'],
    ['a number', 12345],
    ['null', null],
  ])('refuses a client seed with %s', async (_label, clientSeed) => {
    const response = await setClientSeed(clientSeed);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const session = await app.inject({ method: 'GET', url: '/api/session', cookies: visitor.cookies });
    expect(session.json<SessionView>().fairness.clientSeed).toBeNull();
  });

  it('accepts the longest allowed seed, 64 characters', async () => {
    const response = await setClientSeed('a'.repeat(64));
    expect(response.statusCode).toBe(200);
  });

  it('refuses extra fields in the body', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/fairness/client-seed',
      cookies: visitor.cookies,
      headers: { 'idempotency-key': newKey() },
      payload: { clientSeed: 'ok', nonce: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('is refused while a round is in progress', async () => {
    await setClientSeed('before');
    insertActiveRound(db, onlyPlayerId(db));

    const response = await setClientSeed('during');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'round_active' } });
    const session = await app.inject({ method: 'GET', url: '/api/session', cookies: visitor.cookies });
    expect(session.json<SessionView>().fairness.clientSeed).toBe('before');
  });
});

describe('POST /api/fairness/rotate', () => {
  it('reveals the old seed, and it matches the hash that was shown before', async () => {
    const hashShownBefore = visitor.session.fairness.serverSeedHash;
    bumpNonce(db, 5);

    const response = await rotate();

    expect(response.statusCode).toBe(200);
    const result = response.json<RotateResult>();
    expect(result.revealed.serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(result.revealed.serverSeed)).toBe(hashShownBefore);
    expect(result.revealed.serverSeedHash).toBe(hashShownBefore);
    expect(result.revealed.roundsPlayed).toBe(5);
  });

  it('starts a new seed with a new hash and its nonce at 0', async () => {
    bumpNonce(db, 5);

    const result = (await rotate()).json<RotateResult>();

    expect(result.fairness.serverSeedHash).not.toBe(visitor.session.fairness.serverSeedHash);
    expect(result.fairness.serverSeedHash).toBe(sha256(activeSeed()));
    expect(result.fairness.nextNonce).toBe(0);
    expect(count(db, 'server_seeds')).toBe(2);
  });

  it('keeps the client seed', async () => {
    await setClientSeed('mine');
    const result = (await rotate()).json<RotateResult>();
    expect(result.fairness.clientSeed).toBe('mine');
  });

  it('is refused while a round is in progress, and reveals nothing', async () => {
    insertActiveRound(db, onlyPlayerId(db));
    const secret = activeSeed();

    const response = await rotate();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'round_active' } });
    expect(response.body).not.toContain(secret);
    expect(activeSeed()).toBe(secret);
    expect(count(db, 'server_seeds')).toBe(1);
  });

  it('accepts an empty JSON object as its body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/fairness/rotate',
      cookies: visitor.cookies,
      headers: { 'idempotency-key': newKey() },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a body with anything in it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/fairness/rotate',
      cookies: visitor.cookies,
      headers: { 'idempotency-key': newKey() },
      payload: { reveal: 'everything' },
    });
    expect(response.statusCode).toBe(400);
    expect(count(db, 'server_seeds')).toBe(1);
  });
});

describe('an unrevealed server seed', () => {
  it('never appears in any response, whatever is asked', async () => {
    const get = (url: string) => app.inject({ method: 'GET', url, cookies: visitor.cookies });
    const bodies: string[] = [];
    const collect = async (pending: ReturnType<typeof get>): Promise<void> => {
      const response = await pending;
      bodies.push(response.body + JSON.stringify(response.headers));
    };

    await collect(get('/api/session'));
    await collect(get('/api/history'));
    await collect(setClientSeed('seed-1'));
    await collect(setClientSeed('bad:seed'));
    await collect(rotate());
    await collect(get('/api/session'));
    insertActiveRound(db, onlyPlayerId(db));
    await collect(rotate());
    await collect(setClientSeed('seed-2'));
    await collect(get('/api/session'));
    await collect(get('/api/nothing'));

    const secret = activeSeed();
    for (const body of bodies) expect(body).not.toContain(secret);
  });
});
