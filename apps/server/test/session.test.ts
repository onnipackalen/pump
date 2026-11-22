import { createHash } from 'node:crypto';
import type { HistoryResponse, SessionView } from '@pump/contract';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { text } from '../src/db/rows';
import { PLAYER_COOKIE } from '../src/settings';
import {
  cashOutByHand,
  count,
  finishRound,
  firstVisit,
  insertActiveRound,
  onlyPlayerId,
  testRuntime,
  testWorld,
} from './helpers';

describe('a first visit', () => {
  it('creates a player with $10,000 and a session to match the contract', async () => {
    const { app, db } = testWorld();

    const visitor = await firstVisit(app);

    expect(visitor.session).toEqual({
      wallet: { balanceCents: 1_000_000 },
      fairness: {
        serverSeedHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        clientSeed: null,
        nextNonce: 0,
      },
      activeRound: null,
    });
    expect(count(db, 'players')).toBe(1);
  });

  it('sets a cookie that page scripts cannot read', async () => {
    const { app } = testWorld();

    const { setCookie } = await firstVisit(app);

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=31536000');
    expect(setCookie).not.toContain('Secure');
  });

  it('marks the cookie Secure when told the site runs on HTTPS', async () => {
    const app = buildApp({ runtime: testRuntime(), secureCookies: true });
    const { setCookie } = await firstVisit(app);
    expect(setCookie).toContain('Secure');
  });

  it('stores only a hash of the cookie, never the cookie itself', async () => {
    const { app, db } = testWorld();

    const { cookies } = await firstVisit(app);

    const token = cookies[PLAYER_COOKIE] ?? '';
    const row = db.prepare('SELECT token_hash FROM players').get();
    if (!row) throw new Error('no player');
    expect(text(row, 'token_hash')).toBe(createHash('sha256').update(token).digest('hex'));
    expect(text(row, 'token_hash')).not.toContain(token);
  });

  it('tells browsers and proxies not to cache the answer', async () => {
    const { app } = testWorld();
    const response = await app.inject({ method: 'GET', url: '/api/session' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('coming back', () => {
  it('finds the same player and does not hand out a second grant', async () => {
    const { app, db } = testWorld();
    const { cookies, session } = await firstVisit(app);

    const response = await app.inject({ method: 'GET', url: '/api/session', cookies });

    expect(response.json<SessionView>()).toEqual(session);
    // The same cookie is sent again, so it does not run out while they keep playing.
    expect(String(response.headers['set-cookie'])).toContain(`${PLAYER_COOKIE}=${cookies[PLAYER_COOKIE] ?? ''};`);
    expect(count(db, 'players')).toBe(1);
    expect(count(db, 'ledger')).toBe(1);
  });

  it.each([
    ['an unknown token', 'A'.repeat(43)],
    ['a malformed token', 'not a token'],
    ['an empty token', ''],
  ])('treats %s as a first visit', async (_label, token) => {
    const { app, db } = testWorld();
    await firstVisit(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      cookies: { [PLAYER_COOKIE]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
    expect(count(db, 'players')).toBe(2);
  });
});

describe('GET /api/history', () => {
  it('is empty for a new player', async () => {
    const { app } = testWorld();
    const { cookies } = await firstVisit(app);

    const response = await app.inject({ method: 'GET', url: '/api/history', cookies });

    expect(response.statusCode).toBe(200);
    expect(response.json<HistoryResponse>()).toEqual({ rounds: [], more: false });
  });

  it('lists a finished round with its balloons added up, and skips the round in progress', async () => {
    const { app, db } = testWorld();
    const { cookies, session } = await firstVisit(app);
    const playerId = onlyPlayerId(db);
    insertActiveRound(db, playerId, 'round-1', [1000, 2500]);
    db.exec('UPDATE balloons SET patches_cents = 37 WHERE balloon_index = 0');
    cashOutByHand(db, 'round-1', 0, 1230);
    // finishRound pops the balloon that is still in play.
    finishRound(db, 'round-1');
    insertActiveRound(db, playerId, 'round-2');

    const response = await app.inject({ method: 'GET', url: '/api/history', cookies });

    expect(response.json<HistoryResponse>()).toEqual({
      rounds: [
        {
          id: 'round-1',
          difficultyId: 'easy',
          balloonCount: 2,
          betCents: 3500,
          patchesCents: 37,
          payoutCents: 1230,
          refundedCents: 0,
          serverSeedHash: session.fairness.serverSeedHash,
          nonce: 0,
          finishedAt: '2026-01-01T00:05:00.000Z',
          seedRevealed: false,
        },
      ],
      more: false,
    });
  });

  it('shows only the player’s own rounds', async () => {
    const { app, db } = testWorld();
    await firstVisit(app);
    insertActiveRound(db, onlyPlayerId(db), 'round-1');
    finishRound(db, 'round-1');
    const stranger = await firstVisit(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/history',
      cookies: stranger.cookies,
    });

    expect(response.json<HistoryResponse>()).toEqual({ rounds: [], more: false });
  });

  it.each(['0', '51', '-1', '2.5', 'abc', ''])('refuses limit=%s', async (limit) => {
    const { app } = testWorld();
    const { cookies } = await firstVisit(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/history?limit=${limit}`,
      cookies,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each(['1', '10', '50'])('accepts limit=%s', async (limit) => {
    const { app } = testWorld();
    const { cookies } = await firstVisit(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/history?limit=${limit}`,
      cookies,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('a request with no player cookie', () => {
  it('is refused everywhere except the session load, and never creates a player', async () => {
    const { app, db } = testWorld();
    const requests = [
      { method: 'GET', url: '/api/history' },
      { method: 'GET', url: '/api/rounds/some-round/verify' },
      { method: 'POST', url: '/api/rounds', payload: { difficultyId: 'easy', betsCents: [100] } },
      { method: 'POST', url: '/api/fairness/rotate' },
      { method: 'PUT', url: '/api/fairness/client-seed', payload: { clientSeed: 'seed' } },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({ ...request, headers: { 'idempotency-key': 'key-1' } });
      expect(response.statusCode, request.url).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'no_session' } });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(count(db, 'players')).toBe(0);
  });

  it('means two requests sent together on a first visit still make one player', async () => {
    const { app, db } = testWorld();

    const [session, history] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/session' }),
      app.inject({ method: 'GET', url: '/api/history' }),
    ]);

    expect(session.statusCode).toBe(200);
    expect(history.statusCode).toBe(401);
    expect(count(db, 'players')).toBe(1);
  });
});
