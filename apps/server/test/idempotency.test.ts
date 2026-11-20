import type { FairnessView, RotateResult, SessionView } from '@pump/contract';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { ApiError } from '../src/errors';
import { playersRepository } from '../src/repositories/players';
import { requestFingerprint } from '../src/services/idempotency';
import {
  count,
  finishRound,
  firstVisit,
  insertActiveRound,
  onlyPlayerId,
  testWorld,
  type TestWorld,
  type Visitor,
} from './helpers';

let world: TestWorld;
let app: FastifyInstance;
let db: Db;
let visitor: Visitor;

function setClientSeed(clientSeed: string, key: string | undefined, cookies = visitor.cookies) {
  return app.inject({
    method: 'PUT',
    url: '/api/fairness/client-seed',
    cookies,
    headers: key === undefined ? {} : { 'idempotency-key': key },
    payload: { clientSeed },
  });
}

function rotate(key: string) {
  return app.inject({
    method: 'POST',
    url: '/api/fairness/rotate',
    cookies: visitor.cookies,
    headers: { 'idempotency-key': key },
  });
}

async function clientSeedNow(): Promise<string | null> {
  const session = await app.inject({ method: 'GET', url: '/api/session', cookies: visitor.cookies });
  return session.json<SessionView>().fairness.clientSeed;
}

beforeEach(async () => {
  world = testWorld();
  app = world.app;
  db = world.db;
  visitor = await firstVisit(app);
});

describe('a request that changes something', () => {
  it('is refused without an Idempotency-Key', async () => {
    const response = await setClientSeed('seed', undefined);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await clientSeedNow()).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['with a space', 'two words'],
    ['129 characters long', 'k'.repeat(129)],
    ['with a slash', 'a/b'],
  ])('is refused with a key that is %s', async (_label, key) => {
    const response = await setClientSeed('seed', key);
    expect(response.statusCode).toBe(400);
    expect(await clientSeedNow()).toBeNull();
  });

  it('accepts a UUID and a 128-character key', async () => {
    expect((await setClientSeed('a', '3f1c9a52-7d0e-4c1b-9a57-2f6f5a0d1e11')).statusCode).toBe(200);
    expect((await setClientSeed('b', 'k'.repeat(128))).statusCode).toBe(200);
  });
});

describe('a repeated request', () => {
  it('is applied once, and the repeat gets the first answer back', async () => {
    const first = await rotate('rotate-1');
    const repeat = await rotate('rotate-1');
    const again = await rotate('rotate-1');

    expect(first.statusCode).toBe(200);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toBe(first.body);
    expect(again.body).toBe(first.body);
    // One rotation happened, not three: the first seed and its one replacement.
    expect(count(db, 'server_seeds')).toBe(2);
    expect(count(db, 'idempotency_keys')).toBe(1);
  });

  it('is applied once even when both copies arrive at the same moment', async () => {
    const [a, b] = await Promise.all([rotate('double-click'), rotate('double-click')]);

    expect(a.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect(count(db, 'server_seeds')).toBe(2);
  });

  it('gets the first answer back even after things have changed since', async () => {
    const first = await setClientSeed('first', 'set-1');
    await setClientSeed('second', 'set-2');

    const repeat = await setClientSeed('first', 'set-1');

    expect(repeat.body).toBe(first.body);
    expect(repeat.json<FairnessView>().clientSeed).toBe('first');
    // The repeat did not run again: the newer value is still in place.
    expect(await clientSeedNow()).toBe('second');
  });

  it('with different keys is two separate actions', async () => {
    const first = (await rotate('rotate-a')).json<RotateResult>();
    const second = (await rotate('rotate-b')).json<RotateResult>();

    expect(second.revealed.serverSeed).not.toBe(first.revealed.serverSeed);
    expect(second.revealed.serverSeedHash).toBe(first.fairness.serverSeedHash);
    expect(count(db, 'server_seeds')).toBe(3);
  });
});

describe('a refusal', () => {
  it('is an answer too: the repeat gets the same refusal, even once it would succeed', async () => {
    insertActiveRound(db, onlyPlayerId(db));
    const refused = await setClientSeed('seed', 'during-round');
    expect(refused.statusCode).toBe(409);

    finishRound(db);
    const repeat = await setClientSeed('seed', 'during-round');
    const freshKey = await setClientSeed('seed', 'after-round');

    expect(repeat.statusCode).toBe(409);
    expect(repeat.body).toBe(refused.body);
    expect(freshKey.statusCode).toBe(200);
  });

  it('undoes whatever the action had started to do', () => {
    const playerId = onlyPlayerId(db);
    const players = playersRepository(db);

    const answer = world.services.idempotency.once(
      { playerId, key: 'half-done', fingerprint: 'f' },
      () => {
        players.setClientSeed(playerId, 'written-then-refused');
        throw new ApiError('conflict', 'changed my mind');
      },
    );

    expect(answer.status).toBe(409);
    expect(players.get(playerId).clientSeed).toBeNull();
    expect(count(db, 'idempotency_keys')).toBe(1);
  });
});

describe('a request that could not be read', () => {
  it('is not stored, so the key can be used once the request is fixed', async () => {
    const bad = await setClientSeed('bad:seed', 'typo');
    expect(bad.statusCode).toBe(400);
    expect(count(db, 'idempotency_keys')).toBe(0);

    const fixed = await setClientSeed('good-seed', 'typo');
    expect(fixed.statusCode).toBe(200);
  });
});

describe('an unexpected failure', () => {
  it('undoes everything and stores nothing, so a retry runs the action', () => {
    const playerId = onlyPlayerId(db);
    const players = playersRepository(db);
    const request = { playerId, key: 'crash', fingerprint: 'f' };

    expect(() =>
      world.services.idempotency.once(request, () => {
        players.setClientSeed(playerId, 'half-written');
        throw new Error('the disk caught fire');
      }),
    ).toThrow('caught fire');
    expect(players.get(playerId).clientSeed).toBeNull();
    expect(count(db, 'idempotency_keys')).toBe(0);

    const retry = world.services.idempotency.once(request, () => {
      players.setClientSeed(playerId, 'second-try');
      return { status: 200, body: { ok: true } };
    });
    expect(retry).toEqual({ status: 200, body: { ok: true } });
    expect(players.get(playerId).clientSeed).toBe('second-try');
  });

  it('answers 500 in the usual error shape without leaking the cause', async () => {
    // Break the database under a running app.
    db.exec('DROP TABLE idempotency_keys');

    const response = await rotate('boom');

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side. Nothing was changed.',
      },
    });
    expect(count(db, 'server_seeds')).toBe(1);
  });
});

describe('one key used for two different requests', () => {
  it('is refused with 422 when the body differs, and the first answer stands', async () => {
    const first = await setClientSeed('first', 'reused');

    const other = await setClientSeed('other', 'reused');

    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await clientSeedNow()).toBe('first');
    expect((await setClientSeed('first', 'reused')).body).toBe(first.body);
  });

  it('is refused with 422 when the address differs', async () => {
    await setClientSeed('first', 'reused');

    const response = await rotate('reused');

    expect(response.statusCode).toBe(422);
    expect(count(db, 'server_seeds')).toBe(1);
  });

  it('is fine when two different players happen to pick the same key', async () => {
    const stranger = await firstVisit(app);

    const mine = await setClientSeed('mine', 'same-key');
    const theirs = await setClientSeed('theirs', 'same-key', stranger.cookies);

    expect(mine.json<FairnessView>().clientSeed).toBe('mine');
    expect(theirs.json<FairnessView>().clientSeed).toBe('theirs');
  });
});

describe('the request fingerprint', () => {
  it('ignores the order of fields', () => {
    expect(requestFingerprint('POST', '/x', { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      requestFingerprint('POST', '/x', { b: [1, { d: 3, c: 2 }], a: 1 }),
    );
  });

  it('changes with the method, the address or any value', () => {
    const base = requestFingerprint('POST', '/x', { a: 1 });
    expect(requestFingerprint('PUT', '/x', { a: 1 })).not.toBe(base);
    expect(requestFingerprint('POST', '/y', { a: 1 })).not.toBe(base);
    expect(requestFingerprint('POST', '/x', { a: 2 })).not.toBe(base);
    expect(requestFingerprint('POST', '/x', { a: '1' })).not.toBe(base);
    expect(requestFingerprint('POST', '/x', null)).not.toBe(base);
  });
});

describe('a stored answer', () => {
  it('can never be changed afterwards', async () => {
    await rotate('rotate-1');
    expect(() => db.exec("UPDATE idempotency_keys SET body = '{}'")).toThrow('never changes');
  });
});
