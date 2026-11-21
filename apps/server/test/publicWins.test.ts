import { createHash } from 'node:crypto';
import type { PublicWin, PublicWinsResponse, RoundView } from '@pump/contract';
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { text } from '../src/db/rows';
import { featuresFromEnv } from '../src/features';
import { roundsRepository } from '../src/repositories/rounds';
import {
  PUBLIC_WINS_FRESH_MS,
  PUBLIC_WINS_PER_LIST,
  PUBLIC_WINS_REST_FACTOR,
  playerTag,
  publicWinsService,
} from '../src/services/publicWins';
import { ABANDONED_AFTER_MS } from '../src/settings';
import {
  cashOutByHand,
  count,
  finishRound,
  firstVisit,
  insertActiveRound,
  onlyPlayerId,
  testRuntime,
  testWorld,
  type TestWorld,
} from './helpers';
import { clientSeedWhere, ladderOf, Seat, willSurvive, type Foretold } from './play';

// GET /api/wins shows every visitor the wins of all players. These tests
// check three things: only real wins of finished rounds are listed, with the
// right numbers and in the right order; nothing in the answer can identify a
// player or a round; and the switch really switches it off.
//
// Two kinds of rounds are used. Rounds played through the real routes, with
// each outcome chosen in advance from the real draw code. And rounds made by
// hand in the database, for cases real play cannot be steered into exactly
// (a payout equal to the stake, Patches that eat a gain). Hand-made rounds
// carry their own ladder, [101, 111], whatever the game's ladders are.
//
// The lists do not depend on the RTP: a round's payout comes from its ladder
// and its bets. Running at 9400, 9700 and 9900 shows that rounds stored at
// each RTP are listed the same way; it is one check, not three different ones.
//
// The expected numbers are worked out from whatever the first ladder is, so
// these tests keep passing when the ladders are retuned.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** The day the test clock starts on, and the one after. */
const DAY_ONE = '2026-01-01';
const DAY_TWO = '2026-01-02';
/** When a hand-made round is finished (test/helpers.ts finishRound). */
const HAND_MADE_FINISH = '2026-01-01T00:05:00.000Z';

interface Player {
  readonly seat: Seat;
  readonly id: string;
  readonly serverSeed: string;
  /** The nonce the player's next round will use. */
  nonce: number;
}

const playerIds = (world: TestWorld): string[] =>
  world.db
    .prepare('SELECT id FROM players')
    .all()
    .map((row) => text(row, 'id'));

/** A new player, with their id and their secret seed read straight from the database. */
async function join(world: TestWorld): Promise<Player> {
  const before = new Set(playerIds(world));
  const seat = await Seat.join(world.app, null);
  const id = playerIds(world).find((candidate) => !before.has(candidate));
  if (id === undefined) throw new Error('No new player appeared');
  const row = world.db
    .prepare('SELECT seed FROM server_seeds WHERE player_id = :id AND revealed_at IS NULL')
    .get({ id });
  if (!row) throw new Error('The new player has no seed');
  return { seat, id, serverSeed: text(row, 'seed'), nonce: 0 };
}

/**
 * Starts a round whose first balloon is known in advance: it survives its
 * first `survives` pumps, and if `thenPops` the pump after that pops it. The
 * balloon is pumped that far and the round handed back.
 */
async function startKnown(
  world: TestWorld,
  player: Player,
  difficultyId: string,
  betsCents: readonly number[],
  survives: number,
  thenPops = false,
): Promise<RoundView> {
  const { config } = world.runtime;
  const ladder = ladderOf(config, difficultyId);
  const clientSeed = clientSeedWhere((candidate) => {
    const round: Foretold = {
      serverSeed: player.serverSeed,
      clientSeed: candidate,
      nonce: player.nonce,
      rtpBp: config.rtpBp,
      ladder,
    };
    for (let pump = 1; pump <= survives; pump += 1) {
      if (!willSurvive(round, 0, pump - 1, pump)) return false;
    }
    return !thenPops || !willSurvive(round, 0, survives, survives + 1);
  });
  expect((await player.seat.setClientSeed(clientSeed)).status).toBe(200);
  let round = (await player.seat.start(difficultyId, betsCents)).body.round;
  player.nonce += 1;
  for (let pump = 0; pump < survives + (thenPops ? 1 : 0); pump += 1) {
    round = (await player.seat.pump(round, 0)).body.round;
  }
  world.runtime.advance(MINUTE);
  return round;
}

/** A finished round: one balloon pumped `rung` times and cashed out. Returns the moment it finished. */
async function cashOutAt(
  world: TestWorld,
  player: Player,
  difficultyId: string,
  betCents: number,
  rung: number,
): Promise<string> {
  const round = await startKnown(world, player, difficultyId, [betCents], rung);
  const finishedAt = world.runtime.now().toISOString();
  const finished = (await player.seat.cashOut(round, 0)).body.round;
  expect(finished.status).toBe('finished');
  return finishedAt;
}

async function publicWins(world: TestWorld): Promise<{ answer: PublicWinsResponse; raw: string }> {
  // No cookie at all: anyone may ask.
  const response = await world.app.inject({ method: 'GET', url: '/api/wins' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toBeUndefined();
  return { answer: response.json<PublicWinsResponse>(), raw: response.body };
}

/** One player in a fresh world, for rounds made by hand. */
async function handMadeWorld(): Promise<{ world: TestWorld; playerId: string }> {
  const world = testWorld();
  await firstVisit(world.app);
  return { world, playerId: onlyPlayerId(world.db) };
}

describe.each([9400, 9700, 9900])('the public wins lists at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };
  const easy = config.difficulties[0]?.id ?? 'easy';
  const ladder = ladderOf(config, easy);
  const h3 = ladder[2] ?? 0;
  const h4 = ladder[3] ?? 0;
  /** What a round cashed out at `rung` pays on `betCents`, worked out here from the ladder. */
  const payoutAt = (betCents: number, rung: number): number =>
    Math.floor((betCents * (ladder[rung - 1] ?? 0)) / 100);

  it('lists real wins of finished rounds only, in three orders, and nothing that is not a win', async () => {
    const world = testWorld(config);
    // D will bet 100 at rung 4 and gain h4 - 100. A bets 100 * n at rung 3 and
    // gains n * (h3 - 100), with n picked so that A gains more. Any valid
    // ladder has h3 > 100 and h4 > h3, so this works for every ladder.
    const betA = 100 * (Math.floor((h4 - 100) / (h3 - 100)) + 1);

    // A: cashes out at rung 3. A win.
    const a = await join(world);
    const finishedA = await cashOutAt(world, a, easy, betA, 3);
    // B: pops on the first pump. A loss.
    const b = await join(world);
    const popped = await startKnown(world, b, easy, [1000], 0, true);
    expect(popped.status).toBe('finished');
    // C: got back exactly what went in. Nothing was gained: not a win.
    const c = await join(world);
    insertActiveRound(world.db, c.id, 'even-round', [1000]);
    cashOutByHand(world.db, 'even-round', 0, 1000);
    finishRound(world.db, 'even-round');
    // D: a small bet cashed out one rung higher. A smaller gain than A's at
    // a higher multiplier.
    const d = await join(world);
    const finishedD = await cashOutAt(world, d, easy, 100, 4);
    // F: bets twice, pumps the first balloon to rung 3 and walks away. The
    // 24-hour rule cashes that balloon out and hands the other bet back. The
    // bet that came back was never played, so the stake is one bet.
    const f = await join(world);
    await startKnown(world, f, easy, [2 * betA, 2 * betA], 3);
    world.runtime.advance(ABANDONED_AFTER_MS);
    const finishedF = world.runtime.now().toISOString();
    expect((await f.seat.session()).body.activeRound).toBeNull();
    world.runtime.advance(MINUTE);
    // E: a round still in progress, with one balloon already cashed out for
    // far more than BOTH bets together. By the numbers it is a win; only the
    // fact that it is not over keeps it out.
    const e = await join(world);
    insertActiveRound(world.db, e.id, 'open-round', [1000, 10]);
    cashOutByHand(world.db, 'open-round', 0, 5000);

    const { answer } = await publicWins(world);
    expect(answer.enabled).toBe(true);

    const winA = {
      playerTag: playerTag(a.id, DAY_ONE),
      difficultyId: easy,
      wageredCents: betA,
      payoutCents: payoutAt(betA, 3),
      netCents: payoutAt(betA, 3) - betA,
      multiplierHundredths: h3,
      finishedAt: finishedA,
    };
    const winD = {
      playerTag: playerTag(d.id, DAY_ONE),
      difficultyId: easy,
      wageredCents: 100,
      payoutCents: payoutAt(100, 4),
      netCents: payoutAt(100, 4) - 100,
      multiplierHundredths: h4,
      finishedAt: finishedD,
    };
    const winF = {
      playerTag: playerTag(f.id, DAY_TWO),
      difficultyId: easy,
      wageredCents: 2 * betA,
      payoutCents: payoutAt(2 * betA, 3),
      netCents: payoutAt(2 * betA, 3) - 2 * betA,
      multiplierHundredths: h3,
      finishedAt: finishedF,
    };
    // The orders below rest on these, so they are checked, not assumed.
    expect(winF.netCents).toBeGreaterThan(winA.netCents);
    expect(winA.netCents).toBeGreaterThan(winD.netCents);
    expect(winD.netCents).toBeGreaterThan(0);
    expect(winD.multiplierHundredths).toBeGreaterThan(winA.multiplierHundredths);
    expect(finishedA.startsWith(DAY_ONE) && finishedF.startsWith(DAY_TWO)).toBe(true);

    // Newest first; largest gain first; highest multiplier first (the two
    // with the same multiplier: the newer one first). Exactly these, whole.
    expect(answer.recent).toEqual([winF, winD, winA]);
    expect(answer.biggest).toEqual([winF, winA, winD]);
    expect(answer.luckiest).toEqual([winD, winF, winA]);
  });

  it('sends nothing that could identify a player or a round, and makes no player', async () => {
    const world = testWorld(config);
    const a = await join(world);
    await cashOutAt(world, a, easy, 1000, 3);
    await cashOutAt(world, a, easy, 500, 2);
    const d = await join(world);
    await cashOutAt(world, d, easy, 100, 2);
    // The next day, A wins once more.
    world.runtime.advance(DAY);
    await cashOutAt(world, a, easy, 300, 2);
    const playersBefore = count(world.db, 'players');

    const { answer, raw } = await publicWins(world);

    expect(answer.recent).toHaveLength(4);
    expect(count(world.db, 'players')).toBe(playersBefore);
    // Only these fields, on every win.
    for (const win of [...answer.recent, ...answer.biggest, ...answer.luckiest]) {
      expect(Object.keys(win).sort()).toEqual(
        [
          'difficultyId',
          'finishedAt',
          'multiplierHundredths',
          'netCents',
          'payoutCents',
          'playerTag',
          'wageredCents',
        ].sort(),
      );
      expect(win.playerTag).toMatch(/^[0-9a-f]{6}$/);
    }
    // Every secret and every id in the database, searched for in the raw answer.
    const column = (sql: string, name: string): string[] =>
      world.db
        .prepare(sql)
        .all()
        .map((row) => text(row, name));
    const mustNotAppear = [
      ...column('SELECT id FROM players', 'id'),
      ...column('SELECT token_hash FROM players', 'token_hash'),
      ...column('SELECT id FROM rounds', 'id'),
      ...column('SELECT client_seed FROM rounds', 'client_seed'),
      ...column('SELECT seed FROM server_seeds', 'seed'),
      ...column('SELECT seed_hash FROM server_seeds', 'seed_hash'),
      ...Object.values(a.seat.cookies),
      ...Object.values(d.seat.cookies),
    ];
    expect(mustNotAppear.length).toBeGreaterThan(8);
    for (const secret of mustNotAppear) expect(raw).not.toContain(secret);

    // One player's wins of one day carry one tag; another player's carry
    // another; and the same player's tag is different the next day.
    const [nextDay, other, sameDayTwo, sameDayOne] = answer.recent;
    expect(sameDayOne?.playerTag).toBe(sameDayTwo?.playerTag);
    expect(other?.playerTag).not.toBe(sameDayOne?.playerTag);
    expect(nextDay?.playerTag).not.toBe(sameDayOne?.playerTag);
    expect(nextDay?.wageredCents).toBe(300);
  });

  it('holds at most ten wins a list, and reuses one answer for five seconds', async () => {
    const world = testWorld(config);
    const a = await join(world);
    const bets: number[] = [];
    for (let n = 0; n < 12; n += 1) {
      const bet = 100 + n * 100;
      bets.push(bet);
      await cashOutAt(world, a, easy, bet, 1);
    }

    const first = await publicWins(world);
    expect(first.answer.recent).toHaveLength(10);
    expect(first.answer.biggest).toHaveLength(10);
    expect(first.answer.luckiest).toHaveLength(10);
    // Newest first: the last ten bets placed.
    const newestFirst = [...bets].reverse().slice(0, 10);
    expect(first.answer.recent.map((win: PublicWin) => win.wageredCents)).toEqual(newestFirst);
    // All twelve cashed out at the same multiplier, so "luckiest" falls back
    // on newest first as well.
    expect(first.answer.luckiest.map((win: PublicWin) => win.wageredCents)).toEqual(newestFirst);

    // A win made inside the five seconds does not show yet...
    const read = world.runtime.now().getTime();
    const late = await join(world);
    const round = await startKnown(world, late, easy, [100], 2);
    await late.seat.cashOut(round, 0);
    // (startKnown moves the clock a minute; put it back just inside the five seconds.)
    world.runtime.advance(read + 4_999 - world.runtime.now().getTime());
    expect((await publicWins(world)).raw).toBe(first.raw);

    // ...and does once they have passed. It cashed out a rung higher, so it
    // is the luckiest.
    world.runtime.advance(1);
    const later = await publicWins(world);
    expect(later.answer.luckiest[0]).toMatchObject({ wageredCents: 100, multiplierHundredths: ladder[1] });
    expect(later.answer.luckiest[0]?.playerTag).not.toBe(first.answer.luckiest[0]?.playerTag);
  });

  it('is empty when it is switched off, whatever has been won', async () => {
    const world = testWorld(config, { publicWins: false });
    const a = await join(world);
    await cashOutAt(world, a, easy, 1000, 3);

    const { answer } = await publicWins(world);

    expect(answer).toEqual({ enabled: false, recent: [], biggest: [], luckiest: [] });
  });
});

describe('what counts as a public win, on rounds made by hand', () => {
  it('counts Patches as part of what went in', async () => {
    const { world, playerId } = await handMadeWorld();
    // Three rounds with a bet of 1000 and Patches of 100: paid 1050 (a loss
    // of 50 although it paid more than the bet), 1100 (even) and 1500.
    for (const [roundId, paid] of [
      ['lost-50', 1050],
      ['even', 1100],
      ['won-400', 1500],
    ] as const) {
      insertActiveRound(world.db, playerId, roundId, [1000]);
      world.db.prepare('UPDATE balloons SET patches_cents = 100 WHERE round_id = ?').run(roundId);
      cashOutByHand(world.db, roundId, 0, paid);
      finishRound(world.db, roundId);
    }

    const { answer } = await publicWins(world);

    const only = [{ wageredCents: 1100, payoutCents: 1500, netCents: 400 }];
    expect(answer.recent).toHaveLength(1);
    expect(answer.recent).toMatchObject(only);
    expect(answer.biggest).toMatchObject(only);
    expect(answer.luckiest).toMatchObject(only);
  });

  it('sends the highest multiplier a balloon cashed out at, and the time the round finished', async () => {
    const { world, playerId } = await handMadeWorld();
    insertActiveRound(world.db, playerId, 'two', [1000, 1000]);
    // Balloon 0 cashed out at rung 1 (1.01x), balloon 1 at rung 2 (1.11x).
    cashOutByHand(world.db, 'two', 0, 1010);
    for (const rung of [1, 2]) {
      world.db
        .prepare('UPDATE balloons SET rung = ?, draw_index = ? WHERE round_id = ? AND balloon_index = 1')
        .run(rung, rung, 'two');
    }
    world.db
      .prepare(
        "UPDATE balloons SET status = 'cashed', payout_cents = 1110 WHERE round_id = ? AND balloon_index = 1",
      )
      .run('two');
    finishRound(world.db, 'two');

    const { answer } = await publicWins(world);

    expect(answer.recent).toEqual([
      {
        playerTag: playerTag(playerId, DAY_ONE),
        difficultyId: 'easy',
        wageredCents: 2000,
        payoutCents: 2120,
        netCents: 120,
        multiplierHundredths: 111,
        finishedAt: HAND_MADE_FINISH,
      },
    ]);
  });

  it('never shows a round in progress, even one that is ahead by the numbers', async () => {
    const { world, playerId } = await handMadeWorld();
    insertActiveRound(world.db, playerId, 'open-round', [1000, 10]);
    cashOutByHand(world.db, 'open-round', 0, 5000);

    expect((await publicWins(world)).answer).toEqual({
      enabled: true,
      recent: [],
      biggest: [],
      luckiest: [],
    });
  });
});

describe('the promises the public wins lists make in numbers', () => {
  it('ten wins a list, five seconds of reuse, and twenty times a slow read', () => {
    expect(PUBLIC_WINS_PER_LIST).toBe(10);
    expect(PUBLIC_WINS_FRESH_MS).toBe(5_000);
    expect(PUBLIC_WINS_REST_FACTOR).toBe(20);
  });

  it('the tag is six characters of SHA-256 over the day and the player id', () => {
    expect(playerTag('id-1', '2026-01-01')).toBe(
      createHash('sha256').update('pump-public-tag:2026-01-01:id-1').digest('hex').slice(0, 6),
    );
    expect(playerTag('id-1', '2026-01-02')).not.toBe(playerTag('id-1', '2026-01-01'));
  });

  it('does not read the database at all when it is switched off', () => {
    const runtime = testRuntime(GAME_CONFIG, { publicWins: false });
    const service = publicWinsService(runtime, {
      ...roundsRepository(runtime.db),
      publicWins: () => {
        throw new Error('the database was read');
      },
    });

    expect(service.list()).toEqual({ enabled: false, recent: [], biggest: [], luckiest: [] });
  });

  it('rests longer after a slow read, counted from the end of the read', () => {
    const runtime = testRuntime(GAME_CONFIG);
    let reads = 0;
    const service = publicWinsService(runtime, {
      ...roundsRepository(runtime.db),
      // A read that takes one second.
      publicWins: () => {
        reads += 1;
        runtime.advance(1_000);
        return { recent: [], biggest: [], luckiest: [] };
      },
    });

    service.list();
    expect(reads).toBe(1);
    // Twenty times one second, from the end of the read: nothing is read
    // again until then, however often it is asked for.
    runtime.advance(19_999);
    service.list();
    expect(reads).toBe(1);
    runtime.advance(1);
    service.list();
    expect(reads).toBe(2);
  });
});

describe('the switch for public wins', () => {
  it('is on when nothing is set, when it is empty, or when it is set to "on"', () => {
    expect(featuresFromEnv({})).toEqual({ features: { publicWins: true }, warnings: [] });
    expect(featuresFromEnv({ PUBLIC_WINS: 'on' }).features.publicWins).toBe(true);
    expect(featuresFromEnv({ PUBLIC_WINS: '' }).features.publicWins).toBe(true);
    expect(featuresFromEnv({ PUBLIC_WINS: '  ' }).features.publicWins).toBe(true);
  });

  it('is off when set to "off", whatever the case or spaces', () => {
    expect(featuresFromEnv({ PUBLIC_WINS: 'off' })).toEqual({
      features: { publicWins: false },
      warnings: [],
    });
    expect(featuresFromEnv({ PUBLIC_WINS: ' OFF ' }).features.publicWins).toBe(false);
  });

  it('is off, with a warning, for a word it does not know: a typo never switches it on', () => {
    for (const word of ['of', 'false', 'true', '0', '"off"']) {
      const read = featuresFromEnv({ PUBLIC_WINS: word });
      expect(read.features.publicWins).toBe(false);
      expect(read.warnings).toHaveLength(1);
      expect(read.warnings[0]).toContain(`PUBLIC_WINS is "${word}"`);
    }
  });
});
