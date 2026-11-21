import type { PublicWin, PublicWinsResponse, RoundView } from '@pump/contract';
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { text } from '../src/db/rows';
import { featuresFromEnv } from '../src/features';
import { PUBLIC_WINS_FRESH_MS, PUBLIC_WINS_PER_LIST, playerTag } from '../src/services/publicWins';
import { ABANDONED_AFTER_MS } from '../src/settings';
import { count, testWorld, type TestWorld } from './helpers';
import { clientSeedWhere, ladderOf, Seat, willSurvive, type Foretold } from './play';

// GET /api/wins shows every visitor other players' wins. These tests play
// real rounds through the routes, with the outcome of each chosen in advance
// from the real draw code, and then check three things: only real wins of
// finished rounds are listed, in the right order; nothing in the answer can
// identify a player or a round; and the switch really switches it off.

const MINUTE = 60 * 1000;

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

/** A finished round: one balloon pumped `rung` times and cashed out. */
async function cashOutAt(
  world: TestWorld,
  player: Player,
  difficultyId: string,
  betCents: number,
  rung: number,
): Promise<RoundView> {
  const round = await startKnown(world, player, difficultyId, [betCents], rung);
  const finished = (await player.seat.cashOut(round, 0)).body.round;
  expect(finished.status).toBe('finished');
  return finished;
}

async function publicWins(world: TestWorld): Promise<{ answer: PublicWinsResponse; raw: string }> {
  // No cookie at all: anyone may ask.
  const response = await world.app.inject({ method: 'GET', url: '/api/wins' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toBeUndefined();
  return { answer: response.json<PublicWinsResponse>(), raw: response.body };
}

/** What a round cashed out at `rung` pays on `betCents`, worked out here from the ladder. */
const payoutAt = (config: GameConfig, difficultyId: string, betCents: number, rung: number): number =>
  Math.floor((betCents * (ladderOf(config, difficultyId)[rung - 1] ?? 0)) / 100);

describe.each([9400, 9700, 9900])('the public wins lists at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };
  const easy = config.difficulties[0]?.id ?? 'easy';
  const steep = 'hard';

  it('lists real wins of finished rounds only, in three orders, and nothing that is not a win', async () => {
    const world = testWorld(config);

    // A: bets 1000 on the easy ladder and cashes out at rung 3. A win.
    const a = await join(world);
    await cashOutAt(world, a, easy, 1000, 3);
    // B: pops on the first pump. A loss.
    const b = await join(world);
    const popped = await startKnown(world, b, easy, [1000], 0, true);
    expect(popped.status).toBe('finished');
    // C: bets 10 and cashes out at rung 1. The payout is floored to the bet
    // itself, so nothing was gained: not a win.
    const c = await join(world);
    const even = await cashOutAt(world, c, easy, 10, 1);
    expect(even.balloons[0]?.payoutCents).toBe(10);
    // D: bets 100 on a steeper ladder and cashes out at rung 2. A small win
    // at a higher multiplier.
    const d = await join(world);
    await cashOutAt(world, d, steep, 100, 2);
    // F: bets 2000 twice, pumps the first balloon to rung 3 and walks away.
    // The 24-hour rule cashes that balloon out and hands the other bet back.
    // The bet that came back was never played, so the stake is 2000.
    const f = await join(world);
    await startKnown(world, f, easy, [2000, 2000], 3);
    world.runtime.advance(ABANDONED_AFTER_MS);
    expect((await f.seat.session()).body.activeRound).toBeNull();
    world.runtime.advance(MINUTE);
    // E: has cashed one balloon out for a gain, but the round is still in
    // progress. Nothing of it may show.
    const e = await join(world);
    const open = await startKnown(world, e, easy, [1000, 1000], 3);
    const stillOpen = (await e.seat.cashOut(open, 0)).body.round;
    expect(stillOpen.status).toBe('active');
    expect(stillOpen.balloons[0]?.payoutCents).toBeGreaterThan(1000);

    const { answer } = await publicWins(world);
    expect(answer.enabled).toBe(true);

    const winA = {
      playerTag: playerTag(a.id),
      difficultyId: easy,
      wageredCents: 1000,
      payoutCents: payoutAt(config, easy, 1000, 3),
      multiplierHundredths: ladderOf(config, easy)[2],
    };
    const winD = {
      playerTag: playerTag(d.id),
      difficultyId: steep,
      wageredCents: 100,
      payoutCents: payoutAt(config, steep, 100, 2),
      multiplierHundredths: ladderOf(config, steep)[1],
    };
    const winF = {
      playerTag: playerTag(f.id),
      difficultyId: easy,
      wageredCents: 2000,
      payoutCents: payoutAt(config, easy, 2000, 3),
      multiplierHundredths: ladderOf(config, easy)[2],
    };
    // These three are wins by the numbers, and the orders below depend on it.
    expect(winF.payoutCents - 2000).toBeGreaterThan(winA.payoutCents - 1000);
    expect(winA.payoutCents - 1000).toBeGreaterThan(winD.payoutCents - 100);
    expect(winD.payoutCents - 100).toBeGreaterThan(0);
    expect(winD.multiplierHundredths).toBeGreaterThan(winA.multiplierHundredths ?? 0);

    // Newest first; largest gain first; highest multiplier first (the two
    // with the same multiplier: the newer one first).
    expect(answer.recent).toMatchObject([winF, winD, winA]);
    expect(answer.biggest).toMatchObject([winF, winA, winD]);
    expect(answer.luckiest).toMatchObject([winD, winF, winA]);

    for (const win of [...answer.recent, ...answer.biggest, ...answer.luckiest]) {
      expect(win.netCents).toBe(win.payoutCents - win.wageredCents);
      expect(win.netCents).toBeGreaterThan(0);
      expect(Number.isInteger(win.wageredCents) && Number.isInteger(win.payoutCents)).toBe(true);
      expect(win.playerTag).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it('sends nothing that could identify a player or a round, and makes no player', async () => {
    const world = testWorld(config);
    const a = await join(world);
    await cashOutAt(world, a, easy, 1000, 3);
    await cashOutAt(world, a, easy, 500, 2);
    const d = await join(world);
    await cashOutAt(world, d, steep, 100, 2);
    const playersBefore = count(world.db, 'players');

    const { answer, raw } = await publicWins(world);

    expect(answer.recent).toHaveLength(3);
    expect(count(world.db, 'players')).toBe(playersBefore);
    // Only these fields, on every win.
    for (const win of answer.recent) {
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

    // One player's wins carry one tag; another player's carry another.
    const tags = new Set(answer.recent.map((win) => win.playerTag));
    expect(tags).toEqual(new Set([playerTag(a.id), playerTag(d.id)]));
    expect(playerTag(a.id)).not.toBe(playerTag(d.id));
  });

  it('holds at most ten wins a list, and reuses one answer for a few seconds', async () => {
    const world = testWorld(config);
    const a = await join(world);
    const bets: number[] = [];
    for (let n = 0; n < PUBLIC_WINS_PER_LIST + 2; n += 1) {
      const bet = 100 + n * 100;
      bets.push(bet);
      await cashOutAt(world, a, easy, bet, 1);
    }

    const first = await publicWins(world);
    expect(first.answer.recent).toHaveLength(PUBLIC_WINS_PER_LIST);
    expect(first.answer.biggest).toHaveLength(PUBLIC_WINS_PER_LIST);
    expect(first.answer.luckiest).toHaveLength(PUBLIC_WINS_PER_LIST);
    // Newest first: the last bets placed.
    const newestFirst = [...bets].reverse().slice(0, PUBLIC_WINS_PER_LIST);
    expect(first.answer.recent.map((win: PublicWin) => win.wageredCents)).toEqual(newestFirst);

    // A win made inside the reuse window does not show yet...
    const moved = world.runtime.now().getTime();
    const dStart = await join(world);
    const round = await startKnown(world, dStart, steep, [100], 2);
    await dStart.seat.cashOut(round, 0);
    // (startKnown moves the clock a minute; put it back inside the window.)
    world.runtime.advance(moved - world.runtime.now().getTime() + PUBLIC_WINS_FRESH_MS - 1);
    expect((await publicWins(world)).raw).toBe(first.raw);

    // ...and does once the window has passed.
    world.runtime.advance(1);
    const later = await publicWins(world);
    expect(later.answer.luckiest[0]).toMatchObject({ playerTag: playerTag(dStart.id) });
  });

  it('is empty, and reads nothing, when it is switched off', async () => {
    const world = testWorld(config, { publicWins: false });
    const a = await join(world);
    await cashOutAt(world, a, easy, 1000, 3);

    const { answer } = await publicWins(world);

    expect(answer).toEqual({ enabled: false, recent: [], biggest: [], luckiest: [] });
  });
});

describe('the switch for public wins', () => {
  it('is on when nothing is set, or when it is set to "on"', () => {
    expect(featuresFromEnv({})).toEqual({ features: { publicWins: true }, warnings: [] });
    expect(featuresFromEnv({ PUBLIC_WINS: 'on' }).features.publicWins).toBe(true);
    expect(featuresFromEnv({ PUBLIC_WINS: '' }).features.publicWins).toBe(true);
  });

  it('is off when set to "off", whatever the case or spaces', () => {
    expect(featuresFromEnv({ PUBLIC_WINS: 'off' })).toEqual({
      features: { publicWins: false },
      warnings: [],
    });
    expect(featuresFromEnv({ PUBLIC_WINS: ' OFF ' }).features.publicWins).toBe(false);
  });

  it('is off, with a warning, for a word it does not know: a typo never switches it on', () => {
    const read = featuresFromEnv({ PUBLIC_WINS: 'of' });
    expect(read.features.publicWins).toBe(false);
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain('PUBLIC_WINS is "of"');
  });
});
