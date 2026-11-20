import type { HistoryResponse, VerifiableRound } from '@pump/contract';
import { GAME_CONFIG, replayBalloon, type Difficulty, type GameConfig, type Round } from '@pump/engine';
import { drawRoll } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import { ledgerRepository } from '../src/repositories/ledger';
import { reconcile } from '../src/services/reconcile';
import { ABANDONED_AFTER_MS } from '../src/settings';
import { count, onlyPlayerId, testWorld, type TestWorld } from './helpers';
import { clientSeedWhere, ladderOf, Seat, secretSeed, willSurvive, type Foretold } from './play';

const TINY: Difficulty = { id: 'tiny', label: 'Tiny', ladder: [101, 111, 123] };
const CONFIG: GameConfig = {
  ...GAME_CONFIG,
  difficulties: [...GAME_CONFIG.difficulties, TINY],
};
const START = 1_000_000;
const HOUR = 60 * 60 * 1000;

/** One player with a round of three $10 balloons where balloon 0's first two pumps survive. */
async function table(): Promise<{ world: TestWorld; seat: Seat }> {
  const world = testWorld(CONFIG);
  const seat = await Seat.join(world.app, null);
  const foretold = {
    serverSeed: secretSeed(world.db),
    nonce: 0,
    rtpBp: CONFIG.rtpBp,
    ladder: ladderOf(CONFIG, 'tiny'),
  };
  const good = (round: Foretold): boolean =>
    willSurvive(round, 0, 0, 1) && willSurvive(round, 0, 1, 2) && willSurvive(round, 1, 0, 1);
  await seat.setClientSeed(clientSeedWhere((clientSeed) => good({ ...foretold, clientSeed })));
  return { world, seat };
}

describe('a round left alone for 24 hours', () => {
  it('is settled before the player’s next request: pumped balloons cash out, unpumped bets come back', async () => {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    round = (await seat.pump(round, 0)).body.round;
    round = (await seat.pump(round, 0)).body.round;
    await seat.pump(round, 1);
    // Balloon 0 is on rung 2, balloon 1 on rung 1, balloon 2 was never pumped.
    world.runtime.advance(ABANDONED_AFTER_MS);

    const session = (await seat.session()).body;

    expect(session.activeRound).toBeNull();
    // 1000 x 1.11, 1000 x 1.01, and the third bet handed back whole.
    expect(session.wallet.balanceCents).toBe(START - 3000 + 1110 + 1010 + 1000);
    const rows = ledgerRepository(world.db)
      .entriesOf(onlyPlayerId(world.db))
      .slice(-3)
      .map(({ kind, amountCents, balloonIndex }) => ({ kind, amountCents, balloonIndex }));
    expect(rows).toEqual([
      { kind: 'payout', amountCents: 1110, balloonIndex: 0 },
      { kind: 'payout', amountCents: 1010, balloonIndex: 1 },
      { kind: 'refund', amountCents: 1000, balloonIndex: 2 },
    ]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('is not settled one millisecond earlier', async () => {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    round = (await seat.pump(round, 0)).body.round;
    world.runtime.advance(ABANDONED_AFTER_MS - 1);

    const session = (await seat.session()).body;

    expect(session.activeRound).toEqual(round);
    expect(session.wallet.balanceCents).toBe(START - 3000);
  });

  it('counts the 24 hours from the last thing that happened, not from the start', async () => {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    world.runtime.advance(23 * HOUR);
    round = (await seat.pump(round, 0)).body.round;
    world.runtime.advance(23 * HOUR);

    expect((await seat.session()).body.activeRound).toEqual(round);

    world.runtime.advance(HOUR);
    expect((await seat.session()).body.activeRound).toBeNull();
  });

  it('is not kept alive by looking, or by a refused request', async () => {
    const { world, seat } = await table();
    const round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    world.runtime.advance(23 * HOUR);
    await seat.session();
    // Refused: no cash-out before the first pump.
    expect((await seat.cashOut(round, 0)).status).toBe(400);
    world.runtime.advance(HOUR);

    expect((await seat.session()).body.activeRound).toBeNull();
  });

  it('is settled before the request that found it, so that request sees the settled state', async () => {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    round = (await seat.pump(round, 0)).body.round;
    world.runtime.advance(ABANDONED_AFTER_MS);

    // The player comes back and presses Pump on the old screen.
    const late = await seat.pump(round, 0);

    expect(late.status).toBe(409);
    expect(late.error?.message).toBe('This round is over.');
    expect(late.error?.round).toMatchObject({ status: 'finished' });
    expect(late.error?.round?.balloons.map((balloon) => balloon.status)).toEqual([
      'cashed',
      'refunded',
      'refunded',
    ]);
    // The settlement stands even though the request was refused.
    expect((await seat.session()).body.wallet.balanceCents).toBe(START - 3000 + 1010 + 2000);
  });

  it('lets a new round start straight away', async () => {
    const { world, seat } = await table();
    await seat.start('tiny', [1000, 1000, 1000]);
    world.runtime.advance(ABANDONED_AFTER_MS);

    const next = await seat.start('tiny', [500]);

    expect(next.status).toBe(200);
    expect(next.body.round.nonce).toBe(1);
    expect(next.body.wallet.balanceCents).toBe(START - 500);
  });

  it('is settled by the sweep for a player who never comes back', async () => {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    round = (await seat.pump(round, 0)).body.round;
    const other = await Seat.join(world.app);
    await other.start('easy', [2500]);

    expect(world.services.game.sweepAbandoned()).toBe(0);
    world.runtime.advance(ABANDONED_AFTER_MS);
    expect(world.services.game.sweepAbandoned()).toBe(2);
    expect(world.services.game.sweepAbandoned()).toBe(0);

    expect(count(world.db, "rounds WHERE status = 'active'")).toBe(0);
    expect((await seat.session()).body.wallet.balanceCents).toBe(START - 3000 + 1010 + 2000);
    expect((await other.session()).body.wallet.balanceCents).toBe(START);
    expect(reconcile(world.db).problems).toEqual([]);
    expect(round.status).toBe('active');
  });

  it('shows in the history as a finished round', async () => {
    const { world, seat } = await table();
    const round = (await seat.start('tiny', [1000, 1000, 1000])).body.round;
    await seat.pump(round, 0);
    world.runtime.advance(ABANDONED_AFTER_MS);

    const history = (await seat.get<HistoryResponse>('/api/history')).body.rounds;

    expect(history).toHaveLength(1);
    // Two of the three bets were never played: they are refunded, not staked.
    expect(history[0]).toMatchObject({
      id: round.id,
      betCents: 1000,
      payoutCents: 1010,
      refundedCents: 2000,
    });
  });
});

/** Plays a stored round again with the engine and the real draw code, as the verify page does. */
function replay(verifiable: VerifiableRound) {
  const started: Round = {
    difficultyId: verifiable.difficultyId,
    rtpBp: verifiable.rtpBp,
    ladder: verifiable.ladder,
    balloons: verifiable.balloons.map((balloon) => ({
      betCents: balloon.betCents,
      status: 'active',
      rung: 0,
      drawIndex: 0,
      topRung: balloon.topRung,
      patchesCents: 0,
      payoutCents: 0,
    })),
  };
  return verifiable.balloons.map((balloon, balloonIndex) => {
    const replayed = replayBalloon(
      started,
      balloonIndex,
      balloon.actions,
      (drawIndex, den) =>
        drawRoll(
          {
            serverSeed: verifiable.serverSeed,
            clientSeed: verifiable.clientSeed,
            nonce: verifiable.nonce,
            balloonIndex,
            drawIndex,
          },
          den,
        ).roll,
    ).balloon;
    // A refunded balloon was never played: nothing to replay, so it is still "active" here.
    return balloon.status === 'refunded' ? { ...replayed, status: 'refunded' as const } : replayed;
  });
}

describe('checking a finished round', () => {
  async function finishedRound() {
    const { world, seat } = await table();
    let round = (await seat.start('tiny', [1234, 777, 10])).body.round;
    round = (await seat.pump(round, 0)).body.round;
    round = (await seat.pump(round, 0, { patch: true })).body.round;
    round = (await seat.cashOut(round, 0)).body.round;
    round = (await seat.pump(round, 1)).body.round;
    // Balloon 1 is pumped, balloon 2 never is; the 24-hour rule ends the round.
    world.runtime.advance(ABANDONED_AFTER_MS);
    await seat.session();
    return { world, seat, round };
  }

  it('is refused while the round’s server seed is still in use', async () => {
    const { world, seat, round } = await finishedRound();
    const secret = secretSeed(world.db);

    const reply = await seat.get(`/api/rounds/${round.id}/verify`);

    expect(reply.status).toBe(409);
    expect(reply.error?.code).toBe('seed_not_revealed');
    expect(reply.raw).not.toContain(secret);
  });

  it('is refused for a round still in progress, even after an earlier seed was revealed', async () => {
    const { seat } = await table();
    await seat.rotate();
    const round = (await seat.start('tiny', [1000])).body.round;

    const reply = await seat.get(`/api/rounds/${round.id}/verify`);

    expect(reply.status).toBe(409);
    expect(reply.error?.code).toBe('seed_not_revealed');
  });

  it('gives everything needed once the seed is rotated, and the replay matches to the cent', async () => {
    const { seat, round } = await finishedRound();
    const rotated = (await seat.rotate()).body;

    const reply = await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`);

    expect(reply.status).toBe(200);
    const verifiable = reply.body;
    expect(verifiable).toMatchObject({
      id: round.id,
      difficultyId: 'tiny',
      rtpBp: CONFIG.rtpBp,
      ladder: TINY.ladder,
      serverSeed: rotated.revealed.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      nonce: 0,
    });
    expect(verifiable.balloons.map((balloon) => balloon.actions)).toEqual([
      [{ kind: 'pump', patch: false }, { kind: 'pump', patch: true }, { kind: 'cashOut' }],
      // Settled by the 24-hour rule: a pumped balloon ends with a cash-out, an unpumped one has nothing.
      [{ kind: 'pump', patch: false }, { kind: 'cashOut' }],
      [],
    ]);

    const replayed = replay(verifiable);
    verifiable.balloons.forEach((recorded, index) => {
      expect(replayed[index]).toEqual({
        betCents: recorded.betCents,
        status: recorded.status,
        rung: recorded.rung,
        drawIndex: recorded.drawIndex,
        topRung: recorded.topRung,
        patchesCents: recorded.patchesCents,
        payoutCents: recorded.payoutCents,
      });
    });
  });

  it('marks the round as checkable in the history only after the rotation', async () => {
    const { seat } = await finishedRound();
    const before = (await seat.get<HistoryResponse>('/api/history')).body.rounds[0];
    await seat.rotate();
    const after = (await seat.get<HistoryResponse>('/api/history')).body.rounds[0];

    expect(before?.seedRevealed).toBe(false);
    expect(after?.seedRevealed).toBe(true);
  });
});
