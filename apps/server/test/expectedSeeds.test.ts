import type { ExpectedSeeds, FairnessView, RoundView } from '@pump/contract';
import { describe, expect, it } from 'vitest';
import { immediate } from '../src/db/transaction';
import { ApiError } from '../src/errors';
import { count, onlyPlayerId, testWorld, type TestWorld } from './helpers';
import { newKey, Seat } from './play';

/*
 * A round start can name the seeds its screen showed (expectedSeeds). The
 * server then starts the round only if they are the player's seeds now, all
 * three parts. Otherwise it refuses with 409 "seeds_changed" and changes
 * nothing: no charge, no nonce used, no round.
 */

const BET = 1000;

interface Table {
  readonly world: TestWorld;
  readonly seat: Seat;
  /** The seeds the player's screen shows now. */
  readonly fairness: FairnessView;
  readonly balanceCents: number;
}

async function table(): Promise<Table> {
  const world = testWorld();
  const seat = await Seat.join(world.app);
  const { fairness, wallet } = (await seat.session()).body;
  return { world, seat, fairness, balanceCents: wallet.balanceCents };
}

/** What a screen showing `fairness` sends as expectedSeeds. */
function shownOn(fairness: FairnessView): ExpectedSeeds {
  if (fairness.clientSeed === null) throw new Error('a client seed is set');
  return {
    serverSeedHash: fairness.serverSeedHash,
    clientSeed: fairness.clientSeed,
    nonce: fairness.nextNonce,
  };
}

/** Everything a refused start must leave alone. */
async function stateOf({ world, seat }: Table) {
  const { fairness, wallet, activeRound } = (await seat.session()).body;
  return {
    fairness,
    wallet,
    activeRound,
    rounds: count(world.db, 'rounds'),
    ledger: count(world.db, 'ledger'),
  };
}

/** Plays a round to its end: pump each balloon once, then cash out what survived. */
async function playToEnd(seat: Seat, started: RoundView): Promise<void> {
  let round = started;
  for (let step = 0; step < 20 && round.status === 'active'; step += 1) {
    const balloon = round.balloons.find((b) => b.status === 'active');
    if (!balloon) break;
    const reply =
      balloon.rung >= 1 ? await seat.cashOut(round, balloon.index) : await seat.pump(round, balloon.index);
    expect(reply.status).toBe(200);
    round = reply.body.round;
  }
  expect(round.status).toBe('finished');
}

describe('a round start that names the seeds its screen showed', () => {
  it('starts when all three are the player’s seeds now, on exactly those seeds', async () => {
    const t = await table();
    const expected = shownOn(t.fairness);
    const reply = await t.seat.startWith({ difficultyId: 'easy', betsCents: [BET], expectedSeeds: expected });

    expect(reply.status).toBe(200);
    expect(reply.body.round).toMatchObject({
      serverSeedHash: expected.serverSeedHash,
      clientSeed: expected.clientSeed,
      nonce: expected.nonce,
    });
    expect(reply.body.wallet.balanceCents).toBe(t.balanceCents - BET);
    expect((await t.seat.session()).body.fairness.nextNonce).toBe(expected.nonce + 1);
  });

  const changes: readonly [string, (shown: ExpectedSeeds) => ExpectedSeeds][] = [
    ['server seed hash', (s) => ({ ...s, serverSeedHash: s.serverSeedHash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) })],
    ['client seed', (s) => ({ ...s, clientSeed: `${s.clientSeed}-old` })],
    ['nonce, one ahead', (s) => ({ ...s, nonce: s.nonce + 1 })],
  ];

  for (const [part, change] of changes) {
    it(`is refused when the ${part} is not the player’s now: nothing charged, no nonce used, no round`, async () => {
      const t = await table();
      const before = await stateOf(t);
      const reply = await t.seat.startWith({
        difficultyId: 'easy',
        betsCents: [BET],
        expectedSeeds: change(shownOn(t.fairness)),
      });

      expect(reply.status).toBe(409);
      expect(reply.error?.code).toBe('seeds_changed');
      expect(reply.error?.message).toMatch(/No round was started/);
      // The answer carries the seeds and balance as they are now, so the screen can catch up.
      expect(reply.error?.fairness).toEqual(t.fairness);
      expect(reply.error?.wallet).toEqual({ balanceCents: t.balanceCents });
      expect(await stateOf(t)).toEqual(before);
    });
  }

  it('refuses a screen left stale by a round played elsewhere, then starts on the next nonce', async () => {
    const t = await table();
    // Two tabs show the same seeds. The first one plays a round.
    const stale = shownOn(t.fairness);
    const first = await t.seat.startWith({ difficultyId: 'easy', betsCents: [BET], expectedSeeds: stale });
    expect(first.status).toBe(200);
    await playToEnd(t.seat, first.body.round);

    // The second tab still shows nonce 0, which that round used.
    const before = await stateOf(t);
    const refused = await t.seat.startWith({ difficultyId: 'easy', betsCents: [BET], expectedSeeds: stale });
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('seeds_changed');
    expect(refused.error?.fairness).toEqual({ ...t.fairness, nextNonce: stale.nonce + 1 });
    expect(await stateOf(t)).toEqual(before);

    // With the seeds the refusal carried, the next start goes through.
    const fresh = refused.error?.fairness;
    if (!fresh) throw new Error('the refusal carries the seeds');
    const next = await t.seat.startWith({ difficultyId: 'easy', betsCents: [BET], expectedSeeds: shownOn(fresh) });
    expect(next.status).toBe(200);
    expect(next.body.round.nonce).toBe(stale.nonce + 1);
  });

  it('a repeat under the same key gets the very same refusal, even once the seeds would match', async () => {
    const t = await table();
    const key = newKey();
    const body = {
      difficultyId: 'easy',
      betsCents: [BET],
      expectedSeeds: { ...shownOn(t.fairness), clientSeed: 'seed-before' },
    };
    const refused = await t.seat.startWith(body, key);
    expect(refused.status).toBe(409);

    // Now the player's client seed is the one that start named.
    expect((await t.seat.setClientSeed('seed-before')).status).toBe(200);
    const before = await stateOf(t);
    const repeat = await t.seat.startWith(body, key);
    expect(repeat.status).toBe(409);
    expect(repeat.raw).toBe(refused.raw);
    expect(await stateOf(t)).toEqual(before);

    // A new key is a new request, and it starts.
    expect((await t.seat.startWith(body)).status).toBe(200);
  });

  const malformed: readonly [string, (shown: ExpectedSeeds) => unknown][] = [
    ['a hash in capitals', (s) => ({ ...s, serverSeedHash: s.serverSeedHash.toUpperCase() })],
    ['a short hash', (s) => ({ ...s, serverSeedHash: s.serverSeedHash.slice(1) })],
    ['a hash with a space after it', (s) => ({ ...s, serverSeedHash: `${s.serverSeedHash} ` })],
    ['an empty client seed', (s) => ({ ...s, clientSeed: '' })],
    ['a client seed with a colon', (s) => ({ ...s, clientSeed: 'a:b' })],
    ['a client seed of 65 characters', (s) => ({ ...s, clientSeed: 'a'.repeat(65) })],
    ['a nonce below 0', (s) => ({ ...s, nonce: -1 })],
    ['a nonce that is not whole', (s) => ({ ...s, nonce: 0.5 })],
    ['a nonce sent as text', (s) => ({ ...s, nonce: String(s.nonce) })],
    ['a nonce past the safe whole numbers', (s) => ({ ...s, nonce: 2 ** 53 })],
    ['no nonce', (s) => ({ serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed })],
    ['an extra field', (s) => ({ ...s, roundId: 'r' })],
    ['null', () => null],
    ['text', () => 'seeds'],
  ];

  for (const [name, make] of malformed) {
    it(`is refused as invalid_request for ${name}, changing nothing`, async () => {
      const t = await table();
      const before = await stateOf(t);
      const expectedSeeds = make(shownOn(t.fairness));
      const reply = await t.seat.startWith({ difficultyId: 'easy', betsCents: [BET], expectedSeeds });
      expect(reply.status).toBe(400);
      expect(reply.error?.code).toBe('invalid_request');
      expect(await stateOf(t)).toEqual(before);
    });
  }

  it('without expectedSeeds a start works as before, unchecked', async () => {
    const t = await table();
    const reply = await t.seat.start('easy', [BET]);
    expect(reply.status).toBe(200);
    expect(reply.body.round.nonce).toBe(t.fairness.nextNonce);
  });

  it('a round in progress is still reported first, as round_active with the round', async () => {
    const t = await table();
    const started = await t.seat.start('easy', [BET]);
    expect(started.status).toBe(200);
    // These seeds are out of date too (the round took the nonce), but the
    // round in the way is what the screen needs to see.
    const reply = await t.seat.startWith({
      difficultyId: 'easy',
      betsCents: [BET],
      expectedSeeds: shownOn(t.fairness),
    });
    expect(reply.status).toBe(409);
    expect(reply.error?.code).toBe('round_active');
    expect(reply.error?.round?.id).toBe(started.body.round.id);
  });
});

describe('the game service checks the seeds inside the start’s own transaction', () => {
  it('throws seeds_changed before charging or taking a nonce, and the answer shows the seeds now', async () => {
    const t = await table();
    const playerId = onlyPlayerId(t.world.db);
    const before = await stateOf(t);
    const expected = { ...shownOn(t.fairness), nonce: t.fairness.nextNonce + 3 };

    let refusal: unknown = null;
    try {
      immediate(t.world.db, () =>
        t.world.services.game.start(playerId, { difficultyId: 'easy', betsCents: [BET], expectedSeeds: expected }),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ApiError);
    if (!(refusal instanceof ApiError)) return;
    expect(refusal.code).toBe('seeds_changed');
    expect(refusal.status).toBe(409);
    expect(refusal.toResponse().error).toMatchObject({
      code: 'seeds_changed',
      fairness: t.fairness,
      wallet: { balanceCents: t.balanceCents },
    });
    expect(await stateOf(t)).toEqual(before);

    // The same call with the seeds as they are starts the round on them.
    const started = immediate(t.world.db, () =>
      t.world.services.game.start(playerId, {
        difficultyId: 'easy',
        betsCents: [BET],
        expectedSeeds: shownOn(t.fairness),
      }),
    );
    expect(started.round.nonce).toBe(t.fairness.nextNonce);
  });
});
