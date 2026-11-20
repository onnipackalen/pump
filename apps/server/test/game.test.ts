import type { HistoryResponse, RoundView } from '@pump/contract';
import { GAME_CONFIG, type Difficulty, type GameConfig } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { immediate } from '../src/db/transaction';
import { ledgerRepository, type LedgerEntry } from '../src/repositories/ledger';
import { reconcile } from '../src/services/reconcile';
import { count, onlyPlayerId, testWorld, type TestWorld } from './helpers';
import {
  clientSeedWhere,
  ladderOf,
  newKey,
  Seat,
  secretSeed,
  willSurvive,
  type Foretold,
} from './play';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

/** A short ladder, added by configuration alone, so tests can reach the top rung. */
const TINY: Difficulty = { id: 'tiny', label: 'Tiny', ladder: [101, 111, 123] };

function configAt(rtpBp: number): GameConfig {
  return { ...GAME_CONFIG, rtpBp, difficulties: [...GAME_CONFIG.difficulties, TINY] };
}

const START = 1_000_000;

/** bet x multiplier, rounded down to the cent. Worked out here, not by the engine. */
function payoutOf(betCents: number, hundredths: number): number {
  return Number((BigInt(betCents) * BigInt(hundredths)) / 100n);
}

/** The Patch price for the pump from `from` to `to`, rounded up to the cent. Worked out here. */
function patchPriceOf(betCents: number, from: number, to: number, rtpBp: number): number {
  const top = BigInt(betCents) * BigInt(from) * BigInt(to - from) * 100n;
  const bottom = BigInt(to) * BigInt(rtpBp);
  return Number((top + bottom - 1n) / bottom);
}

interface Table {
  readonly world: TestWorld;
  readonly seat: Seat;
  readonly round: RoundView;
}

/**
 * Sits one player down and starts a round whose draws do what `wanted` says.
 * The round is found by trying client seeds against the real draw code.
 */
async function deal(
  wanted: (round: Foretold) => boolean,
  options: { difficultyId?: string; bets?: readonly number[]; config?: GameConfig } = {},
): Promise<Table> {
  const config = options.config ?? configAt(GAME_CONFIG.rtpBp);
  const difficultyId = options.difficultyId ?? 'tiny';
  const world = testWorld(config);
  const seat = await Seat.join(world.app, null);
  const foretold = {
    serverSeed: secretSeed(world.db),
    nonce: 0,
    rtpBp: config.rtpBp,
    ladder: ladderOf(config, difficultyId),
  };
  await seat.setClientSeed(clientSeedWhere((clientSeed) => wanted({ ...foretold, clientSeed })));
  const started = await seat.start(difficultyId, options.bets ?? [1000]);
  expect(started.status).toBe(200);
  return { world, seat, round: started.body.round };
}

/** Balloon `balloon` survives its first `pumps` pumps. */
const survives =
  (pumps: number, balloon = 0) =>
  (round: Foretold): boolean =>
    Array.from({ length: pumps }, (_, i) => willSurvive(round, balloon, i, i + 1)).every(Boolean);

/** Balloon 0 survives `pumps` pumps and the next one pops. */
const survivesThenPops =
  (pumps: number) =>
  (round: Foretold): boolean =>
    survives(pumps)(round) && !willSurvive(round, 0, pumps, pumps + 1);

function ledgerOf(world: TestWorld): LedgerEntry[] {
  return ledgerRepository(world.db).entriesOf(onlyPlayerId(world.db));
}

async function balanceOf(seat: Seat): Promise<number> {
  return (await seat.session()).body.wallet.balanceCents;
}

describe('starting a round', () => {
  it('needs a client seed first', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app, null);

    const reply = await seat.start('easy', [1000]);

    expect(reply.status).toBe(400);
    expect(reply.error?.message).toBe('Set a client seed before starting a round.');
    expect(count(world.db, 'rounds')).toBe(0);
  });

  it('charges each bet, takes nonce 0, and shows every balloon unpumped', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);

    const reply = await seat.start('easy', [1000, 250, 10]);

    expect(reply.status).toBe(200);
    expect(reply.body.wallet).toEqual({ balanceCents: START - 1260 });
    const { round } = reply.body;
    expect(round).toMatchObject({
      difficultyId: 'easy',
      rtpBp: GAME_CONFIG.rtpBp,
      ladder: ladderOf(GAME_CONFIG, 'easy'),
      status: 'active',
      clientSeed: 'test-seed',
      nonce: 0,
    });
    expect(round.balloons.map((balloon) => balloon.betCents)).toEqual([1000, 250, 10]);
    for (const balloon of round.balloons) {
      expect(balloon).toMatchObject({
        status: 'active',
        rung: 0,
        drawIndex: 0,
        multiplierHundredths: null,
        cashOutCents: null,
        patchesCents: 0,
        payoutCents: 0,
      });
      // No Patch before the first pump.
      expect(balloon.next?.patchPriceCents).toBeNull();
    }
    expect(
      ledgerOf(world)
        .slice(1)
        .map(({ kind, amountCents, balloonIndex }) => ({ kind, amountCents, balloonIndex })),
    ).toEqual([
      { kind: 'bet', amountCents: -1000, balloonIndex: 0 },
      { kind: 'bet', amountCents: -250, balloonIndex: 1 },
      { kind: 'bet', amountCents: -10, balloonIndex: 2 },
    ]);
  });

  it('is restored by the session after a page refresh', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const { round } = (await seat.start('medium', [500, 500])).body;

    const session = await seat.session();

    expect(session.body.activeRound).toEqual(round);
    expect(session.body.fairness.nextNonce).toBe(1);
  });

  it('is refused while another round is in progress, and shows that round', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    const first = (await seat.start('easy', [1000])).body.round;

    const second = await seat.start('easy', [1000]);

    expect(second.status).toBe(409);
    expect(second.error?.code).toBe('round_active');
    expect(second.error?.round).toEqual(first);
    expect(count(world.db, 'rounds')).toBe(1);
    expect(await balanceOf(seat)).toBe(START - 1000);
  });

  it.each([
    ['a bet below the minimum', 'easy', [9]],
    ['a bet above the maximum', 'easy', [100_001]],
    ['a bet that is not whole cents', 'easy', [10.5]],
    ['no balloons', 'easy', []],
    ['four balloons', 'easy', [10, 10, 10, 10]],
    ['a difficulty that does not exist', 'impossible', [1000]],
  ])('refuses %s and charges nothing', async (_label, difficultyId, bets) => {
    const world = testWorld();
    const seat = await Seat.join(world.app);

    const reply = await seat.start(difficultyId, bets);

    expect(reply.status).toBe(400);
    expect(reply.error?.code).toBe('invalid_request');
    expect(count(world.db, 'rounds')).toBe(0);
    expect(await balanceOf(seat)).toBe(START);
  });

  it('refuses bets the balance cannot cover, and uses up no nonce', async () => {
    const world = testWorld();
    const seat = await Seat.join(world.app);
    // Get the player down to $15: play one round, take the rest through the
    // wallet, and close that round by hand so a new one may start.
    const first = (await seat.start('easy', [100_000])).body.round;
    immediate(world.db, () =>
      world.services.wallet.charge(
        onlyPlayerId(world.db),
        'patch',
        START - 100_000 - 1500,
        { roundId: first.id, balloonIndex: 0 },
        '2026-01-01T00:00:00.000Z',
      ),
    );
    world.db.exec("UPDATE balloons SET status = 'popped'");
    world.db.exec(
      "UPDATE rounds SET status = 'finished', finished_at = '2026-01-01T00:01:00.000Z'",
    );
    expect(await balanceOf(seat)).toBe(1500);

    const reply = await seat.start('easy', [1000, 1000]);

    expect(reply.status).toBe(402);
    expect(reply.error).toMatchObject({
      code: 'insufficient_funds',
      wallet: { balanceCents: 1500 },
    });
    expect(count(world.db, 'rounds')).toBe(1);
    expect((await seat.session()).body.fairness.nextNonce).toBe(1);
    expect(await balanceOf(seat)).toBe(1500);
  });

  it('gives each round the next nonce', async () => {
    const { seat, round } = await deal(survives(1));
    const pumped = (await seat.pump(round, 0)).body.round;
    await seat.cashOut(pumped, 0);

    const next = await seat.start('tiny', [1000]);

    expect(round.nonce).toBe(0);
    expect(next.body.round.nonce).toBe(1);
  });
});

describe.each(RTPS)('a round at RTP %i', (rtpBp) => {
  const config = configAt(rtpBp);
  const ladder = TINY.ladder;

  it('pumps up two rungs and cashes out for bet x multiplier, rounded down', async () => {
    const bet = 1234;
    const { world, seat, round } = await deal(survives(2), { config, bets: [bet] });
    expect(round.rtpBp).toBe(rtpBp);

    const first = await seat.pump(round, 0);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('survived');
    expect(first.body.round.balloons[0]).toMatchObject({
      rung: 1,
      drawIndex: 1,
      status: 'active',
      multiplierHundredths: ladder[0],
      cashOutCents: payoutOf(bet, ladder[0] ?? 0),
    });
    // A pump costs nothing: the balance has not moved.
    expect(first.body.wallet).toEqual({ balanceCents: START - bet });

    const second = await seat.pump(first.body.round, 0);
    expect(second.body.outcome).toBe('survived');
    expect(second.body.round.balloons[0]).toMatchObject({ rung: 2, drawIndex: 2 });

    const cashed = await seat.cashOut(second.body.round, 0);
    const payout = payoutOf(bet, ladder[1] ?? 0);
    expect(cashed.status).toBe(200);
    expect(cashed.body.round.status).toBe('finished');
    expect(cashed.body.round.balloons[0]).toMatchObject({
      status: 'cashed',
      payoutCents: payout,
      cashOutCents: null,
      next: null,
    });
    expect(cashed.body.wallet).toEqual({ balanceCents: START - bet + payout });
    expect(ledgerOf(world).at(-1)).toMatchObject({ kind: 'payout', amountCents: payout });
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('loses the bet when a pump pops, and pays nothing', async () => {
    const { world, seat, round } = await deal(survivesThenPops(1), { config });

    const first = await seat.pump(round, 0);
    const second = await seat.pump(first.body.round, 0);

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('popped');
    expect(second.body.round.status).toBe('finished');
    expect(second.body.round.balloons[0]).toMatchObject({
      status: 'popped',
      rung: 1,
      drawIndex: 2,
      payoutCents: 0,
      next: null,
    });
    expect(second.body.wallet).toEqual({ balanceCents: START - 1000 });
    expect(ledgerOf(world).filter((entry) => entry.kind === 'payout')).toEqual([]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('charges a Patch whether or not it is needed, and saves the balloon when it is', async () => {
    const bet = 1000;
    const { world, seat, round } = await deal(survivesThenPops(1), { config, bets: [bet] });
    const price = patchPriceOf(bet, ladder[0] ?? 0, ladder[1] ?? 0, rtpBp);
    const afterFirst = (await seat.pump(round, 0)).body.round;
    expect(afterFirst.balloons[0]?.next?.patchPriceCents).toBe(price);

    const patched = await seat.pump(afterFirst, 0, { patch: true });

    expect(patched.status).toBe(200);
    expect(patched.body.outcome).toBe('saved');
    // Saved: same rung, still in play, but the draw is used up and the Patch is paid for.
    expect(patched.body.round.balloons[0]).toMatchObject({
      status: 'active',
      rung: 1,
      drawIndex: 2,
      patchesCents: price,
    });
    expect(patched.body.wallet).toEqual({ balanceCents: START - bet - price });
    expect(ledgerOf(world).at(-1)).toMatchObject({ kind: 'patch', amountCents: -price });
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('charges a Patch that turns out not to be needed', async () => {
    const bet = 1000;
    const { seat, round } = await deal(survives(2), { config, bets: [bet] });
    const price = patchPriceOf(bet, ladder[0] ?? 0, ladder[1] ?? 0, rtpBp);
    const afterFirst = (await seat.pump(round, 0)).body.round;

    const patched = await seat.pump(afterFirst, 0, { patch: true });

    expect(patched.body.outcome).toBe('survived');
    expect(patched.body.round.balloons[0]).toMatchObject({ rung: 2, patchesCents: price });
    expect(patched.body.wallet).toEqual({ balanceCents: START - bet - price });
  });

  it('cashes out by itself at the top rung, in the same request', async () => {
    const bet = 777;
    const { world, seat, round } = await deal(survives(3), { config, bets: [bet] });
    let current = round;
    current = (await seat.pump(current, 0)).body.round;
    current = (await seat.pump(current, 0)).body.round;

    const top = await seat.pump(current, 0);

    const payout = payoutOf(bet, ladder[2] ?? 0);
    expect(top.body.outcome).toBe('top');
    expect(top.body.round.status).toBe('finished');
    expect(top.body.round.balloons[0]).toMatchObject({
      status: 'cashed',
      rung: 3,
      payoutCents: payout,
    });
    expect(top.body.wallet).toEqual({ balanceCents: START - bet + payout });
    expect(reconcile(world.db).problems).toEqual([]);
  });
});

describe('what is not allowed', () => {
  it('refuses a cash-out before the first pump', async () => {
    const { seat, round } = await deal(survives(1));

    const reply = await seat.cashOut(round, 0);

    expect(reply.status).toBe(400);
    expect(reply.error?.message).toBe('A balloon cannot cash out before its first pump');
    expect(await balanceOf(seat)).toBe(START - 1000);
  });

  it('refuses a Patch on the first pump, and makes no draw', async () => {
    const { seat, round } = await deal(survives(1));

    const reply = await seat.pump(round, 0, { patch: true });

    expect(reply.status).toBe(400);
    expect(reply.error?.message).toBe('A Patch is only sold after the first pump');
    expect((await seat.session()).body.activeRound?.balloons[0]?.drawIndex).toBe(0);
  });

  it('refuses a Patch the balance cannot cover, makes no draw and charges nothing', async () => {
    const { world, seat, round } = await deal(survives(1), { bets: [100_000] });
    const afterFirst = (await seat.pump(round, 0)).body.round;
    const price = afterFirst.balloons[0]?.next?.patchPriceCents ?? 0;
    // Leave one cent less than the Patch costs.
    const balance = await balanceOf(seat);
    immediate(world.db, () =>
      world.services.wallet.charge(
        onlyPlayerId(world.db),
        'patch',
        balance - (price - 1),
        { roundId: round.id, balloonIndex: 0 },
        '2026-01-01T00:00:00.000Z',
      ),
    );

    const reply = await seat.pump(afterFirst, 0, { patch: true });

    expect(reply.status).toBe(402);
    expect(reply.error).toMatchObject({
      code: 'insufficient_funds',
      wallet: { balanceCents: price - 1 },
    });
    const balloon = (await seat.session()).body.activeRound?.balloons[0];
    expect(balloon).toMatchObject({ rung: 1, drawIndex: 1, status: 'active' });
    expect(await balanceOf(seat)).toBe(price - 1);
  });

  it('refuses anything on a balloon that does not exist', async () => {
    const { seat, round } = await deal(survives(1));
    const reply = await seat.pump(round, 2);
    expect(reply.status).toBe(400);
    expect(reply.error?.code).toBe('invalid_request');
  });

  it('refuses a round that does not exist, or is someone else’s', async () => {
    const { world, seat, round } = await deal(survives(1));
    const stranger = await Seat.join(world.app);

    expect((await seat.pump({ ...round, id: 'no-such-round' }, 0)).status).toBe(404);
    expect((await stranger.pump(round, 0)).status).toBe(404);
    expect((await stranger.cashOut(round, 0)).status).toBe(404);
    expect((await stranger.get(`/api/rounds/${round.id}/verify`)).status).toBe(404);
    expect((await seat.session()).body.activeRound?.balloons[0]?.drawIndex).toBe(0);
  });

  it.each([
    ['a missing field', { balloonIndex: 0, patch: false }],
    ['an extra field', { balloonIndex: 0, expectedDrawIndex: 0, patch: false, roll: 0 }],
    ['a negative index', { balloonIndex: -1, expectedDrawIndex: 0, patch: false }],
    ['a fraction', { balloonIndex: 0, expectedDrawIndex: 0.5, patch: false }],
    ['a string for a number', { balloonIndex: '0', expectedDrawIndex: 0, patch: false }],
    ['a string for the Patch', { balloonIndex: 0, expectedDrawIndex: 0, patch: 'yes' }],
  ])('refuses a pump with %s', async (_label, payload) => {
    const { world, round, seat } = await deal(survives(1));

    const response = await world.app.inject({
      method: 'POST',
      url: `/api/rounds/${round.id}/pump`,
      cookies: seat.cookies,
      headers: { 'idempotency-key': newKey() },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(count(world.db, 'balloon_actions')).toBe(0);
  });

  it('refuses everything on a round that is over, and shows how it ended', async () => {
    const { seat, round } = await deal(survives(1));
    const pumped = (await seat.pump(round, 0)).body.round;
    const finished = (await seat.cashOut(pumped, 0)).body.round;

    const pumpAgain = await seat.pump(finished, 0);
    const cashAgain = await seat.cashOut(finished, 0);

    for (const reply of [pumpAgain, cashAgain]) {
      expect(reply.status).toBe(409);
      expect(reply.error?.code).toBe('conflict');
      expect(reply.error?.round).toEqual(finished);
    }
  });

  it('refuses to change or rotate seeds during a round', async () => {
    const { seat } = await deal(survives(1));

    expect((await seat.rotate()).error?.code).toBe('round_active');
    expect((await seat.setClientSeed('new-seed')).error?.code).toBe('round_active');
  });
});

describe('two requests for one balloon at the same moment', () => {
  it('lets a pump and a cash-out through one at a time: never both', async () => {
    for (const order of ['pump first', 'cash-out first'] as const) {
      const { world, seat, round } = await deal(survives(2));
      const pumped = (await seat.pump(round, 0)).body.round;

      // Both were made from the same screen, so both expect draw index 1.
      const pair =
        order === 'pump first'
          ? await Promise.all([seat.pump(pumped, 0), seat.cashOut(pumped, 0)])
          : await Promise.all([seat.cashOut(pumped, 0), seat.pump(pumped, 0)]);

      expect(pair.map((reply) => reply.status).sort()).toEqual([200, 409]);
      const refused = pair.find((reply) => reply.status === 409);
      const now = (await seat.session()).body;
      // The loser is told the state as it is now.
      expect(refused?.error?.code).toBe('conflict');
      if (order === 'pump first') {
        expect(refused?.error?.round).toEqual(now.activeRound);
        expect(now.activeRound?.balloons[0]).toMatchObject({ rung: 2, status: 'active' });
        expect(now.wallet.balanceCents).toBe(START - 1000);
      } else {
        expect(now.activeRound).toBeNull();
        expect(refused?.error?.round?.balloons[0]).toMatchObject({ rung: 1, status: 'cashed' });
        expect(now.wallet.balanceCents).toBe(START - 1000 + payoutOf(1000, TINY.ladder[0] ?? 0));
      }
      expect(reconcile(world.db).problems).toEqual([]);
    }
  });

  it('lets only one of two pumps through, even with different keys', async () => {
    const { world, seat, round } = await deal(survives(2));

    const pair = await Promise.all([seat.pump(round, 0), seat.pump(round, 0)]);

    expect(pair.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect((await seat.session()).body.activeRound?.balloons[0]).toMatchObject({
      rung: 1,
      drawIndex: 1,
    });
    expect(count(world.db, 'balloon_actions')).toBe(1);
  });

  it('pays a balloon once when two cash-outs arrive together', async () => {
    const { world, seat, round } = await deal(survives(1));
    const pumped = (await seat.pump(round, 0)).body.round;

    const pair = await Promise.all([seat.cashOut(pumped, 0), seat.cashOut(pumped, 0)]);

    expect(pair.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(ledgerOf(world).filter((entry) => entry.kind === 'payout')).toHaveLength(1);
    expect(await balanceOf(seat)).toBe(START - 1000 + payoutOf(1000, TINY.ladder[0] ?? 0));
  });

  it('applies a double-clicked pump once: same key, same answer, one draw', async () => {
    const { world, seat, round } = await deal(survives(2));
    const key = newKey();

    const [first, second] = await Promise.all([
      seat.pump(round, 0, { key }),
      seat.pump(round, 0, { key }),
    ]);
    const later = await seat.pump(round, 0, { key });

    expect(first.status).toBe(200);
    expect(second.raw).toBe(first.raw);
    expect(later.raw).toBe(first.raw);
    expect(count(world.db, 'balloon_actions')).toBe(1);
    expect((await seat.session()).body.activeRound?.balloons[0]?.drawIndex).toBe(1);
  });

  it('refuses a request made from an out-of-date screen and sends the state now', async () => {
    const { seat, round } = await deal(survivesThenPops(1));
    const pumped = (await seat.pump(round, 0)).body.round;
    // A Patch saves the balloon: the rung stays at 1, but a draw was used.
    const saved = (await seat.pump(pumped, 0, { patch: true })).body.round;
    expect(saved.balloons[0]).toMatchObject({ rung: 1, drawIndex: 2 });

    // The old screen still shows rung 1 with draw index 1.
    const stale = await seat.cashOut(pumped, 0);

    expect(stale.status).toBe(409);
    expect(stale.error?.round).toEqual(saved);
    expect((await seat.cashOut(saved, 0)).status).toBe(200);
  });
});

describe('balloons in one round', () => {
  it('are independent, and the round ends when the last one is done', async () => {
    const { world, seat, round } = await deal(
      (r) => survives(1, 0)(r) && survives(1, 1)(r) && !willSurvive(r, 2, 0, 1),
      { bets: [1000, 2000, 3000] },
    );

    const afterPop = await seat.pump(round, 2);
    expect(afterPop.body.outcome).toBe('popped');
    expect(afterPop.body.round.status).toBe('active');
    // The other two balloons are untouched.
    expect(afterPop.body.round.balloons.slice(0, 2)).toEqual(round.balloons.slice(0, 2));

    const b0 = await seat.pump(afterPop.body.round, 0);
    const b1 = await seat.pump(b0.body.round, 1);
    const cash0 = await seat.cashOut(b1.body.round, 0);
    expect(cash0.body.round.status).toBe('active');
    const cash1 = await seat.cashOut(cash0.body.round, 1);

    expect(cash1.body.round.status).toBe('finished');
    const multiplier = TINY.ladder[0] ?? 0;
    expect(cash1.body.wallet.balanceCents).toBe(
      START - 6000 + payoutOf(1000, multiplier) + payoutOf(2000, multiplier),
    );
    expect((await seat.session()).body.activeRound).toBeNull();
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('show up in the history once the round is over', async () => {
    const { seat, round } = await deal(survives(1), { bets: [1000, 500] });
    const pumped = (await seat.pump(round, 0)).body.round;
    const cashed = (await seat.cashOut(pumped, 0)).body.round;
    expect((await seat.get<HistoryResponse>('/api/history')).body.rounds).toEqual([]);
    const pumped1 = (await seat.pump(cashed, 1)).body.round;
    if (pumped1.status === 'active') await seat.cashOut(pumped1, 1);

    const history = (await seat.get<HistoryResponse>('/api/history')).body.rounds;

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: round.id,
      difficultyId: 'tiny',
      balloonCount: 2,
      betCents: 1500,
      nonce: 0,
      seedRevealed: false,
    });
  });
});

describe('a round keeps the RTP and ladder it started with', () => {
  it('plays on unchanged after the configuration changes', async () => {
    const { world, seat, round } = await deal(survives(2), { config: configAt(9700) });
    // The server restarts with a different RTP and a different ladder for the same id.
    const changed: GameConfig = {
      ...configAt(9400),
      difficulties: [...GAME_CONFIG.difficulties, { ...TINY, ladder: [105, 130, 170] }],
    };
    const restarted = buildApp({ runtime: { ...world.runtime, config: changed } });
    const sameSeat = seat.on(restarted);

    const resumed = (await sameSeat.session()).body.activeRound;
    const pumped = await sameSeat.pump(round, 0);

    expect(resumed).toEqual(round);
    expect(pumped.body.round).toMatchObject({ rtpBp: 9700, ladder: TINY.ladder });
    expect(pumped.body.round.balloons[0]?.multiplierHundredths).toBe(TINY.ladder[0]);
  });
});
