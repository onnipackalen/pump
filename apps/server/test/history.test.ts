import type { HistoryResponse, RoundView } from '@pump/contract';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { text } from '../src/db/rows';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '../src/settings';
import { testWorld, type TestWorld } from './helpers';
import { Seat } from './play';

// GET /api/history a page at a time: `before` is the id of one of the
// player's finished rounds, and the answer is the rounds right after it in
// the list's order, with `more` saying whether older ones remain.

const DIFFICULTY = GAME_CONFIG.difficulties[0]?.id ?? 'easy';
const BET = GAME_CONFIG.limits.minBetCents;

/** Plays one round with one balloon: one pump, then a cash-out if it is still in play. */
async function playRound(seat: Seat, world: TestWorld, waitMs: number): Promise<string> {
  const started = await seat.start(DIFFICULTY, [BET]);
  expect(started.status).toBe(200);
  let round: RoundView = started.body.round;
  if (waitMs > 0) world.runtime.advance(waitMs);
  round = (await seat.pump(round, 0)).body.round;
  if (round.status === 'active') round = (await seat.cashOut(round, 0)).body.round;
  expect(round.status).toBe('finished');
  return round.id;
}

/**
 * Plays `count` rounds with a clock that often stands still, so many rounds
 * share a finish time. In each group of five:
 *   1st: a second after the group before, starts and ends at once;
 *   2nd: starts and ends at the same moment as the 1st (all three times tie);
 *   3rd: starts at that moment too, but ends a little later;
 *   4th: starts and ends when the 3rd ended (same finish, later start);
 *   5th: the same as the 4th (all three times tie again).
 */
async function playMany(seat: Seat, world: TestWorld, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    if (n % 5 === 0) world.runtime.advance(1000);
    ids.push(await playRound(seat, world, n % 5 === 2 ? 250 : 0));
  }
  return ids;
}

interface Placed {
  readonly id: string;
  readonly finishedAt: string;
  readonly startedAt: string;
}

/** A player's finished rounds as stored. */
function finishedOf(db: Db, playerId: string): Placed[] {
  return db
    .prepare("SELECT id, finished_at, started_at FROM rounds WHERE player_id = ? AND status = 'finished'")
    .all(playerId)
    .map((row) => ({
      id: text(row, 'id'),
      finishedAt: text(row, 'finished_at'),
      startedAt: text(row, 'started_at'),
    }));
}

/**
 * The order the list promises, worked out here on its own: newest finish
 * first, then newest start, then the highest id, all in plain character
 * order as the database compares text.
 */
function expectedOrder(rounds: readonly Placed[]): string[] {
  const later = (x: string, y: string): number => (x === y ? 0 : x > y ? -1 : 1);
  return [...rounds]
    .sort(
      (x, y) =>
        later(x.finishedAt, y.finishedAt) || later(x.startedAt, y.startedAt) || later(x.id, y.id),
    )
    .map((r) => r.id);
}

function playerOf(db: Db, roundId: string): string {
  const row = db.prepare('SELECT player_id FROM rounds WHERE id = ?').get(roundId);
  if (!row) throw new Error(`no round ${roundId}`);
  return text(row, 'player_id');
}

/** Walks the whole history with pages of `limit`, starting from the newest. */
async function walk(seat: Seat, limit: number): Promise<HistoryResponse[]> {
  const pages: HistoryResponse[] = [];
  let before: string | null = null;
  for (;;) {
    const url: string =
      before === null
        ? `/api/history?limit=${String(limit)}`
        : `/api/history?limit=${String(limit)}&before=${before}`;
    const reply = await seat.get<HistoryResponse>(url);
    expect(reply.status, url).toBe(200);
    pages.push(reply.body);
    const last = reply.body.rounds.at(-1);
    if (!reply.body.more || last === undefined) return pages;
    before = last.id;
    // A walk that never ends is a bug, not a long history.
    if (pages.length > 1000) throw new Error('the pages never end');
  }
}

describe('GET /api/history, a page at a time', () => {
  it('walks through 125 rounds, many finished in the same millisecond, each once and in order', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const played = await playMany(seat, world, 125);
    const playerId = playerOf(world.db, played[0] ?? '');
    const stored = finishedOf(world.db, playerId);
    const order = expectedOrder(stored);
    expect(new Set(order)).toEqual(new Set(played));

    // The ties are really there: rounds sharing a finish time, some of them
    // with different start times and some with the same start time too.
    const byFinish = new Map<string, Placed[]>();
    for (const r of stored) byFinish.set(r.finishedAt, [...(byFinish.get(r.finishedAt) ?? []), r]);
    const groups = [...byFinish.values()];
    expect(Math.max(...groups.map((group) => group.length))).toBeGreaterThanOrEqual(3);
    expect(groups.some((group) => new Set(group.map((r) => r.startedAt)).size > 1)).toBe(true);
    expect(
      stored.some((x) =>
        stored.some((y) => x.id !== y.id && x.finishedAt === y.finishedAt && x.startedAt === y.startedAt),
      ),
    ).toBe(true);

    // Page sizes that cut the ties in every place they can.
    for (const limit of [1, 2, 3, 7, 10, HISTORY_MAX_LIMIT]) {
      const pages = await walk(seat, limit);
      const ids = pages.flatMap((page) => page.rounds.map((r) => r.id));
      expect(ids, `limit ${String(limit)}`).toEqual(order);
      expect(pages.length).toBe(Math.ceil(order.length / limit));
      pages.forEach((page, n) => {
        const last = n === pages.length - 1;
        expect(page.more).toBe(!last);
        if (!last) expect(page.rounds).toHaveLength(limit);
      });
    }
  });

  it('answers as before with no cursor: the newest rounds, 10 by default, and says if more remain', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const playerId = playerOf(world.db, (await playMany(seat, world, 12))[0] ?? '');
    const order = expectedOrder(finishedOf(world.db, playerId));

    const first = await seat.get<HistoryResponse>('/api/history');
    expect(first.status).toBe(200);
    expect(first.body.rounds.map((r) => r.id)).toEqual(order.slice(0, HISTORY_DEFAULT_LIMIT));
    expect(first.body.more).toBe(true);

    const all = await seat.get<HistoryResponse>('/api/history?limit=12');
    expect(all.body.rounds.map((r) => r.id)).toEqual(order);
    expect(all.body.more).toBe(false);

    // A page after the oldest round is empty, with nothing more.
    const after = await seat.get<HistoryResponse>(`/api/history?before=${order.at(-1) ?? ''}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ rounds: [], more: false });
  });

  it('pages each player through their own rounds only, even when their rounds finish at the same moments', async () => {
    const world = testWorld();
    const alice = await Seat.join(world.app, 'alice-seed');
    const bob = await Seat.join(world.app, 'bob-seed');
    // Turn about, with the clock standing still, so their rounds tie in time
    // and their ids are mixed together.
    for (let n = 0; n < 15; n += 1) {
      if (n % 4 === 0) world.runtime.advance(1000);
      await playRound(alice, world, 0);
      await playRound(bob, world, 0);
    }
    for (const seat of [alice, bob]) {
      const first = (await seat.get<HistoryResponse>('/api/history?limit=1')).body.rounds[0];
      if (!first) throw new Error('no rounds');
      const playerId = playerOf(world.db, first.id);
      const ids = (await walk(seat, 4)).flatMap((page) => page.rounds.map((r) => r.id));
      expect(ids).toEqual(expectedOrder(finishedOf(world.db, playerId)));
      expect(ids.every((id) => playerOf(world.db, id) === playerId)).toBe(true);
    }
  });

  it('refuses a cursor that is not one of the player’s finished rounds, all the same way', async () => {
    const world = testWorld();
    const alice = await Seat.join(world.app, 'alice-seed');
    const bob = await Seat.join(world.app, 'bob-seed');
    const [aliceRound] = await playMany(alice, world, 3);
    const [bobRound] = await playMany(bob, world, 3);
    // Alice's round still in play.
    const active = (await alice.start(DIFFICULTY, [BET])).body.round.id;

    for (const before of [bobRound ?? '', active, 'no-such-round']) {
      const reply = await alice.get(`/api/history?before=${before}`);
      expect(reply.status, before).toBe(404);
      expect(reply.error).toEqual({
        code: 'not_found',
        message: 'There is no finished round of yours with that id.',
      });
    }
    // Her own finished round is fine, and Bob can use his.
    expect((await alice.get(`/api/history?before=${aliceRound ?? ''}`)).status).toBe(200);
    expect((await bob.get(`/api/history?before=${bobRound ?? ''}`)).status).toBe(200);
  });

  it.each([
    ['empty', ''],
    ['with a space', 'a%20b'],
    ['with a colon', 'a:b'],
    ['too long', 'a'.repeat(65)],
    ['given twice', 'a&before=b'],
  ])('refuses a cursor that is not shaped like a round id: %s', async (_label, before) => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const reply = await seat.get(`/api/history?before=${before}`);
    expect(reply.status).toBe(400);
    expect(reply.error?.code).toBe('invalid_request');
  });

  it('keeps the limit bounds with a cursor too', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const [, second] = await playMany(seat, world, 3);
    for (const limit of ['0', '51', '-1', '2.5', 'abc']) {
      const reply = await seat.get(`/api/history?limit=${limit}&before=${second ?? ''}`);
      expect(reply.status, limit).toBe(400);
      expect(reply.error?.code).toBe('invalid_request');
    }
    for (const limit of ['1', '50']) {
      const reply = await seat.get<HistoryResponse>(`/api/history?limit=${limit}&before=${second ?? ''}`);
      expect(reply.status, limit).toBe(200);
      expect(reply.body.rounds.length).toBeLessThanOrEqual(Number(limit));
    }
  });

  it('shows a round as checkable on every page once its seed is rotated', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const early = await playMany(seat, world, 6);
    expect((await seat.rotate()).status).toBe(200);
    const late = await playMany(seat, world, 6);
    const listed = (await walk(seat, 4)).flatMap((page) => page.rounds);
    for (const round of listed) {
      expect(round.seedRevealed, round.id).toBe(early.includes(round.id));
      expect(late.includes(round.id)).toBe(!round.seedRevealed);
    }
  });
});
