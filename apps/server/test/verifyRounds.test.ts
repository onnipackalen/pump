import type { PumpOutcome, RoundView, VerifiableRound } from '@pump/contract';
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import { ABANDONED_AFTER_MS } from '../src/settings';
import { testWorld, type TestWorld } from './helpers';
import { clientSeedWhere, Seat, secretSeed, willSurvive, type Foretold } from './play';

// A player checks a round with verifyRound, in their browser, from what the
// server sends once the seed is revealed. This test plays rounds through the
// real routes that end in every way a round can end, then checks each one
// exactly as the verify page does. It runs at three RTPs, because a round
// must still check out after the RTP in the config is changed.

interface Reachable {
  readonly id: string;
  readonly ladder: readonly number[];
  /** The highest rung the largest bet may reach. */
  readonly top: number;
}

/**
 * The highest rung a bet may reach: the last one whose payout stays within
 * the cap. Worked out here, apart from the engine.
 */
function topRungOf(ladder: readonly number[], betCents: number, maxPayoutCents: number): number {
  const cap = BigInt(maxPayoutCents) * 100n;
  let top = 0;
  for (const hundredths of ladder) {
    if (BigInt(betCents) * BigInt(hundredths) > cap) break;
    top += 1;
  }
  return top;
}

/**
 * The difficulty whose top is nearest for the largest bet. With the ladders
 * as they are, that is one where the payout cap locks the upper rungs.
 */
function nearestTop(config: GameConfig): Reachable {
  const all = config.difficulties.map((difficulty) => ({
    id: difficulty.id,
    ladder: difficulty.ladder,
    top: topRungOf(difficulty.ladder, config.limits.maxBetCents, config.limits.maxPayoutCents),
  }));
  const [first, ...rest] = all;
  if (!first) throw new Error('The config has no difficulties');
  return rest.reduce((best, next) => (next.top < best.top ? next : best), first);
}

/** Pumps one balloon once and returns the round and what happened. */
async function pumpOnce(
  seat: Seat,
  round: RoundView,
  balloonIndex: number,
  patch = false,
): Promise<{ round: RoundView; outcome: PumpOutcome }> {
  const reply = await seat.pump(round, balloonIndex, { patch });
  expect(reply.status).toBe(200);
  return { round: reply.body.round, outcome: reply.body.outcome };
}

/** Leaves the round alone for 24 hours; the player's next visit then settles it. */
async function abandon(world: TestWorld, seat: Seat): Promise<void> {
  world.runtime.advance(ABANDONED_AFTER_MS);
  expect((await seat.session()).body.activeRound).toBeNull();
}

describe.each([9400, 9700, 9900])('rounds the server played, checked as a player checks them, at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };
  const { minBetCents, maxBetCents, maxPayoutCents } = config.limits;

  it('checks out however the round ended: top rung, cash-out, pop, Patch save, 24-hour rule, refund', async () => {
    const world = testWorld(config);
    const seat = await Seat.join(world.app, null);
    const serverSeed = secretSeed(world.db);
    const foretold = (nonce: number, ladder: readonly number[], clientSeed: string): Foretold => ({
      serverSeed,
      clientSeed,
      nonce,
      rtpBp,
      ladder,
    });

    // Round 1: the largest bet climbs all the way to its top rung, which
    // pays it out by itself. A second balloon is never pumped.
    const high = nearestTop(config);
    await seat.setClientSeed(
      clientSeedWhere((clientSeed) => {
        const round = foretold(0, high.ladder, clientSeed);
        return Array.from({ length: high.top }, (_, k) => k).every((k) =>
          willSurvive(round, 0, k, k + 1),
        );
      }),
    );
    let first = (await seat.start(high.id, [maxBetCents, minBetCents])).body.round;
    expect(first.balloons[0]?.topRung).toBe(high.top);
    let outcome: PumpOutcome = 'survived';
    for (let pump = 0; pump < high.top; pump += 1) {
      ({ round: first, outcome } = await pumpOnce(seat, first, 0));
    }
    expect(outcome).toBe('top');
    const topHundredths = high.ladder[high.top - 1] ?? 0;
    const topPayout = Number((BigInt(maxBetCents) * BigInt(topHundredths)) / 100n);
    expect(first.balloons[0]?.payoutCents).toBe(topPayout);
    expect(topPayout).toBeLessThanOrEqual(maxPayoutCents);
    await abandon(world, seat);

    // Round 2: balloon 0 survives a pump, then a Patch saves it from a pop;
    // balloon 1 pops at once; balloon 2 is never pumped. Then 24 hours pass.
    const easy = config.difficulties[0];
    if (!easy) throw new Error('The config has no difficulties');
    await seat.setClientSeed(
      clientSeedWhere((clientSeed) => {
        const round = foretold(1, easy.ladder, clientSeed);
        return (
          willSurvive(round, 0, 0, 1) && !willSurvive(round, 0, 1, 2) && !willSurvive(round, 1, 0, 1)
        );
      }),
    );
    let second = (await seat.start(easy.id, [250, 250, 250])).body.round;
    ({ round: second, outcome } = await pumpOnce(seat, second, 0));
    expect(outcome).toBe('survived');
    ({ round: second, outcome } = await pumpOnce(seat, second, 0, true));
    expect(outcome).toBe('saved');
    ({ round: second, outcome } = await pumpOnce(seat, second, 1));
    expect(outcome).toBe('popped');
    await abandon(world, seat);

    // Round 3: one pump, then the player cashes out.
    await seat.setClientSeed(
      clientSeedWhere((clientSeed) => willSurvive(foretold(2, easy.ladder, clientSeed), 0, 0, 1)),
    );
    let third = (await seat.start(easy.id, [500])).body.round;
    ({ round: third } = await pumpOnce(seat, third, 0));
    third = (await seat.cashOut(third, 0)).body.round;
    expect(third.status).toBe('finished');

    // Nothing can be checked while the seed is still in use.
    const tooEarly = await seat.get(`/api/rounds/${first.id}/verify`);
    expect(tooEarly.error?.code).toBe('seed_not_revealed');
    expect((await seat.rotate()).status).toBe(200);

    const records: VerifiableRound[] = [];
    for (const id of [first.id, second.id, third.id]) {
      const reply = await seat.get<VerifiableRound>(`/api/rounds/${id}/verify`);
      expect(reply.status).toBe(200);
      records.push(reply.body);
    }
    expect(records.map((record) => record.balloons.map((balloon) => balloon.status))).toEqual([
      ['cashed', 'refunded'],
      ['cashed', 'popped', 'refunded'],
      ['cashed'],
    ]);

    for (const record of records) {
      // The round keeps the RTP it was played with.
      expect(record.rtpBp).toBe(rtpBp);
      const check = verifyRound(record);
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.seedHashMatches).toBe(true);
    }

    // And the check is a real one: a cent more paid, or another RTP, is caught.
    const [honest] = records;
    if (!honest) throw new Error('No round to check');
    const overpaid: VerifiableRound = {
      ...honest,
      balloons: honest.balloons.map((balloon, index) =>
        index === 0 ? { ...balloon, payoutCents: balloon.payoutCents + 1 } : balloon,
      ),
    };
    expect(verifyRound(overpaid).ok).toBe(false);
    expect(verifyRound({ ...honest, rtpBp: rtpBp === 9700 ? 9400 : 9700 }).ok).toBe(false);
  });
});
