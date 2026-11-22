import type { HistoryResponse, RoundView } from '@pump/contract';
import { GAME_CONFIG } from '@pump/engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The game screen's own clients: the real one, and the in-browser demo.
import { ApiFailure, type GameClient } from '../../web/src/api/client';
import { HttpClient } from '../../web/src/api/httpClient';
import { DemoClient } from '../../web/src/demo/DemoClient';
import { testWorld } from './helpers';

// The in-browser demo stands in for the server, so its history must page
// exactly as the server's does: the same order (ties included), the same
// pages, the same `more`, and the same refusals. Both are played the same
// way here, on clocks that stand still for long stretches, and walked page
// by page through the screen's own client calls.

const DIFFICULTY = GAME_CONFIG.difficulties[0]?.id ?? 'easy';
const BET = GAME_CONFIG.limits.minBetCents;
const key = (): string => crypto.randomUUID();

/** The browser's fetch, sent straight into the server, keeping the cookie. */
function serverFetch(app: FastifyInstance): typeof fetch {
  let cookie = '';
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.inject({
      method: init?.method === 'POST' ? 'POST' : init?.method === 'PUT' ? 'PUT' : 'GET',
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const setCookie = response.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof first === 'string') cookie = first.split(';')[0] ?? cookie;
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** One round with one balloon: one pump, then a cash-out if it is still in play. */
async function playRound(client: GameClient, waitMs: number, advance: (ms: number) => void): Promise<RoundView> {
  const { round: started } = await client.startRound({ difficultyId: DIFFICULTY, betsCents: [BET] }, key());
  if (waitMs > 0) advance(waitMs);
  let round = (await client.pump(started.id, { balloonIndex: 0, expectedDrawIndex: 0, patch: false }, key()))
    .round;
  const balloon = round.balloons[0];
  if (round.status === 'active' && balloon) {
    round = (await client.cashOut(round.id, { balloonIndex: 0, expectedDrawIndex: balloon.drawIndex }, key()))
      .round;
  }
  expect(round.status).toBe('finished');
  return started;
}

/**
 * Plays `count` rounds with the clock standing still most of the time (see
 * history.test.ts): rounds that share finish and start times, and rounds
 * that share a finish time but not a start time. Returns each round's start
 * time by id, from the start's own answer.
 */
async function playMany(client: GameClient, count: number, advance: (ms: number) => void) {
  const startedAt = new Map<string, string>();
  for (let n = 0; n < count; n += 1) {
    if (n % 5 === 0) advance(1000);
    const round = await playRound(client, n % 5 === 2 ? 250 : 0, advance);
    startedAt.set(round.id, round.startedAt);
  }
  return startedAt;
}

/** Walks the whole history with pages of `limit`. */
async function walk(client: GameClient, limit: number): Promise<HistoryResponse[]> {
  const pages: HistoryResponse[] = [];
  let before: string | null = null;
  for (;;) {
    const page: HistoryResponse = await client.getHistoryPage(limit, before);
    pages.push(page);
    const last = page.rounds.at(-1);
    if (!page.more || last === undefined) return pages;
    before = last.id;
    if (pages.length > 1000) throw new Error('the pages never end');
  }
}

/** The order the list promises, worked out here on its own from what the client was told. */
function expectedOrder(pages: readonly HistoryResponse[], startedAt: ReadonlyMap<string, string>): string[] {
  const later = (x: string, y: string): number => (x === y ? 0 : x > y ? -1 : 1);
  return pages
    .flatMap((page) => page.rounds)
    .map((r) => ({ id: r.id, finishedAt: r.finishedAt, startedAt: startedAt.get(r.id) ?? '' }))
    .sort(
      (x, y) =>
        later(x.finishedAt, y.finishedAt) || later(x.startedAt, y.startedAt) || later(x.id, y.id),
    )
    .map((r) => r.id);
}

/** What a refused call was refused with. */
async function refusal(call: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await call;
    return null;
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    return { code: error.code, message: error.body.message };
  }
}

interface Table {
  readonly client: GameClient;
  readonly advance: (ms: number) => void;
}

async function server(): Promise<Table> {
  const world = testWorld();
  const client = new HttpClient(serverFetch(world.app));
  await client.getSession();
  await client.setClientSeed('test-seed', key());
  return { client, advance: (ms) => world.runtime.advance(ms) };
}

async function demo(): Promise<Table> {
  // Only the clock is faked: the demo stamps its rounds with new Date().
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const client = new DemoClient(GAME_CONFIG, 0);
  await client.setClientSeed('test-seed', key());
  return { client, advance: (ms) => vi.setSystemTime(Date.now() + ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the demo’s history pages exactly like the server’s', () => {
  it('lists the same rounds in the same order, pages and more, ties included', async () => {
    const tables = { server: await server(), demo: await demo() };
    const played = {
      server: await playMany(tables.server.client, 42, tables.server.advance),
      demo: await playMany(tables.demo.client, 42, tables.demo.advance),
    };
    for (const limit of [1, 4, 10, 50]) {
      const pages = {
        server: await walk(tables.server.client, limit),
        demo: await walk(tables.demo.client, limit),
      };
      const shape = (list: readonly HistoryResponse[]) =>
        list.map((page) => ({ size: page.rounds.length, more: page.more }));
      expect(shape(pages.demo), `limit ${String(limit)}`).toEqual(shape(pages.server));
      for (const side of ['server', 'demo'] as const) {
        const ids = pages[side].flatMap((page) => page.rounds.map((r) => r.id));
        expect(new Set(ids), side).toEqual(new Set(played[side].keys()));
        expect(ids, side).toEqual(expectedOrder(pages[side], played[side]));
      }
    }
    // The game's own list is the first page.
    for (const side of ['server', 'demo'] as const) {
      const first = (await tables[side].client.getHistoryPage(10, null)).rounds;
      expect(await tables[side].client.getHistory(10), side).toEqual(first);
    }
  });

  it('refuses the same cursors and limits with the same codes', async () => {
    const answers: Record<string, ({ code: string; message: string } | null)[]> = {};
    for (const [side, table] of [
      ['server', await server()],
      ['demo', await demo()],
    ] as const) {
      const { client, advance } = table;
      const played = [...(await playMany(client, 3, advance)).keys()];
      const oldest = (await client.getHistoryPage(50, null)).rounds.at(-1)?.id ?? '';
      const active = (await client.startRound({ difficultyId: DIFFICULTY, betsCents: [BET] }, key())).round.id;
      const afterOldest = await client.getHistoryPage(5, oldest);
      expect(afterOldest, side).toEqual({ rounds: [], more: false });
      expect(played).toContain(oldest);
      answers[side] = [
        await refusal(client.getHistoryPage(5, active)),
        await refusal(client.getHistoryPage(5, 'no-such-round')),
        await refusal(client.getHistoryPage(0, null)),
        await refusal(client.getHistoryPage(51, oldest)),
        await refusal(client.getHistoryPage(5, 'a:b')),
        await refusal(client.getHistoryPage(50, oldest)),
      ];
    }
    const codes = (list: readonly ({ code: string } | null)[] | undefined) => list?.map((a) => a?.code ?? null);
    expect(codes(answers.server)).toEqual([
      'not_found',
      'not_found',
      'invalid_request',
      'invalid_request',
      'invalid_request',
      null,
    ]);
    expect(codes(answers.demo)).toEqual(codes(answers.server));
    // The cursor refusals read the same too.
    expect(answers.demo?.slice(0, 2)).toEqual(answers.server?.slice(0, 2));
  });
});
