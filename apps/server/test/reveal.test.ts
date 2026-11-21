import type {
  AfterRoundView,
  HistoryResponse,
  RoundView,
  VerifiableRound,
} from '@pump/contract';
import {
  GAME_CONFIG,
  LIMITS,
  surviveChance,
  type Difficulty,
  type GameConfig,
  type Limits,
  type RevealOutcome,
} from '@pump/engine';
import { drawRoll, hashServerSeed, verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { migrate } from '../src/db/migrations';
import { immediate } from '../src/db/transaction';
import { roundsRepository } from '../src/repositories/rounds';
import { buildServices } from '../src/services';
import { reconcile } from '../src/services/reconcile';
import { ABANDONED_AFTER_MS } from '../src/settings';
import { count, testRuntime, testWorld, type TestWorld } from './helpers';
import {
  clientSeedWhere,
  ladderOf,
  newKey,
  Seat,
  secretSeed,
  willSurvive,
  type Foretold,
  type Reply,
} from './play';

// The reveal: once a round is over, each balloon cashed out below its top
// rung shows where it would have popped. These tests play through the real
// HTTP routes and work out every expected reveal here, from the seeds, with
// willSurvive (drawRoll and the pump chance): not with the engine's reveal.

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

/** A short ladder, added by configuration alone, so tests can reach the top rung. */
const TINY: Difficulty = { id: 'tiny', label: 'Tiny', ladder: [101, 111, 123] };

function configAt(rtpBp: number): GameConfig {
  return { ...GAME_CONFIG, rtpBp, difficulties: [...GAME_CONFIG.difficulties, TINY] };
}

/** A payout cap of $1,110, and the largest bet, which it holds back. */
const SMALL_CAP_CENTS = 111_000;
const LARGEST_BET_CENTS = LIMITS.maxBetCents;

/**
 * Tiny alone, under the small cap. The largest bet ($1,000) can reach 1.11x
 * ($1,110) but not 1.23x: its top rung is 2, not 3. The usual bet limits
 * stay, because the verify page checks the cap against them.
 */
function cappedAt(rtpBp: number): GameConfig {
  const limits: Limits = { ...LIMITS, maxPayoutCents: SMALL_CAP_CENTS };
  return { rtpBp, limits, difficulties: [TINY] };
}

interface Table {
  readonly world: TestWorld;
  readonly seat: Seat;
  readonly round: RoundView;
  /** The round's seeds, nonce, RTP and ladder, so its draws can be worked out here. */
  readonly foretold: Foretold;
}

/** Sits one player down and starts a Tiny round whose draws do what `wanted` says. */
async function deal(
  wanted: (round: Foretold) => boolean,
  config: GameConfig,
  bets: readonly number[] = [1000],
): Promise<Table> {
  const world = testWorld(config);
  const seat = await Seat.join(world.app, null);
  const base = {
    serverSeed: secretSeed(world.db),
    nonce: 0,
    rtpBp: config.rtpBp,
    ladder: ladderOf(config, 'tiny'),
  };
  const clientSeed = clientSeedWhere((seed) => wanted({ ...base, clientSeed: seed }));
  await seat.setClientSeed(clientSeed);
  const started = await seat.start('tiny', bets);
  expect(started.status).toBe(200);
  return { world, seat, round: started.body.round, foretold: { ...base, clientSeed } };
}

/** Balloon `balloon` survives its first `pumps` pumps. */
const survives =
  (pumps: number, balloon = 0) =>
  (round: Foretold): boolean =>
    Array.from({ length: pumps }, (_, i) => willSurvive(round, balloon, i, i + 1)).every(Boolean);

/**
 * The reveal worked out here: from rung `rung`, plain pumps at draw
 * `drawIndex`, `drawIndex + 1`, ... until one pops or the top rung is
 * reached.
 */
function foreseen(
  round: Foretold,
  balloonIndex: number,
  from: { readonly rung: number; readonly drawIndex: number; readonly topRung: number },
): AfterRoundView {
  let rung = from.rung;
  let drawIndex = from.drawIndex;
  let outcome: RevealOutcome = 'top';
  while (rung < from.topRung) {
    if (!willSurvive(round, balloonIndex, drawIndex, rung + 1)) {
      outcome = 'popped';
      break;
    }
    rung += 1;
    drawIndex += 1;
  }
  return {
    outcome,
    reachedRung: rung,
    reachedMultiplierHundredths: round.ladder[rung - 1] ?? -1,
  };
}

/** Every balloon's reveal in an answer's round. */
const revealsIn = (round: RoundView | null | undefined) =>
  round?.balloons.map((balloon) => balloon.afterRound);

function ok<T>(reply: Reply<T>): T {
  expect(reply.status, reply.raw).toBe(200);
  return reply.body;
}

describe.each(RTPS)('reveals at RTP %i', (rtpBp) => {
  const config = configAt(rtpBp);

  it.each([
    ['the very next pump pops', false, false, { outcome: 'popped', reachedRung: 1 }],
    ['it pops one rung higher', true, false, { outcome: 'popped', reachedRung: 2 }],
    ['it reaches the top', true, true, { outcome: 'top', reachedRung: 3 }],
  ] as const)(
    'the last cash-out shows where the balloon would have popped: %s',
    async (_label, second, third, expected) => {
      const { world, seat, round, foretold } = await deal(
        (r) =>
          survives(1)(r) && willSurvive(r, 0, 1, 2) === second && (!second || willSurvive(r, 0, 2, 3) === third),
        config,
      );
      const pumped = ok(await seat.pump(round, 0)).round;
      expect(revealsIn(pumped)).toEqual([null]);

      const cashed = ok(await seat.cashOut(pumped, 0)).round;

      expect(cashed.status).toBe('finished');
      const afterRound = cashed.balloons[0]?.afterRound;
      expect(afterRound).toEqual(foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 }));
      expect(afterRound).toMatchObject(expected);
      expect(afterRound?.reachedMultiplierHundredths).toBe(TINY.ladder[expected.reachedRung - 1]);
      // A reveal moves no money and uses up no draw of the balloon.
      expect(cashed.balloons[0]).toMatchObject({ rung: 1, drawIndex: 1, payoutCents: 1010 });
      expect(count(world.db, 'balloon_reveals')).toBe(1);
      expect(count(world.db, 'balloon_actions')).toBe(2);
      expect(reconcile(world.db).problems).toEqual([]);
    },
  );

  it('a pop that ends the round reveals the balloon cashed out before it, and only that one', async () => {
    const { world, seat, round, foretold } = await deal(
      (r) => survives(1, 0)(r) && survives(1, 1)(r) && !willSurvive(r, 1, 1, 2),
      config,
      [1000, 1000],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.cashOut(now, 0)).round;
    // Balloon 0 is cashed, but the round is still in progress: nothing yet.
    expect(now.status).toBe('active');
    expect(revealsIn(now)).toEqual([null, null]);
    expect(count(world.db, 'balloon_reveals')).toBe(0);
    now = ok(await seat.pump(now, 1)).round;

    const popped = ok(await seat.pump(now, 1));

    expect(popped.outcome).toBe('popped');
    expect(popped.round.status).toBe('finished');
    expect(revealsIn(popped.round)).toEqual([
      foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 }),
      null,
    ]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('reaching the top that ends the round reveals the other balloon, not the one at the top', async () => {
    const { world, seat, round, foretold } = await deal(
      (r) => survives(1, 0)(r) && survives(3, 1)(r),
      config,
      [1000, 1000],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.cashOut(now, 0)).round;
    now = ok(await seat.pump(now, 1)).round;
    now = ok(await seat.pump(now, 1)).round;
    expect(revealsIn(now)).toEqual([null, null]);

    const top = ok(await seat.pump(now, 1));

    expect(top.outcome).toBe('top');
    expect(top.round.status).toBe('finished');
    expect(top.round.balloons[1]).toMatchObject({ status: 'cashed', rung: 3 });
    expect(revealsIn(top.round)).toEqual([
      foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 }),
      null,
    ]);
    expect(count(world.db, 'balloon_reveals')).toBe(1);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('starts a Patch-saved balloon’s reveal at its draw count, not its rung', async () => {
    // Pump 2 pops on draw 1 (the Patch saves it), and survives on draw 2. A
    // reveal that started at the rung would replay draw 1 and pop at once.
    const { world, seat, round, foretold } = await deal(
      (r) => survives(1)(r) && !willSurvive(r, 0, 1, 2) && willSurvive(r, 0, 2, 2),
      config,
    );
    let now = ok(await seat.pump(round, 0)).round;
    const saved = ok(await seat.pump(now, 0, { patch: true }));
    expect(saved.outcome).toBe('saved');
    now = saved.round;
    expect(now.balloons[0]).toMatchObject({ rung: 1, drawIndex: 2 });

    const cashed = ok(await seat.cashOut(now, 0)).round;

    const afterRound = cashed.balloons[0]?.afterRound;
    expect(afterRound).toEqual(foreseen(foretold, 0, { rung: 1, drawIndex: 2, topRung: 3 }));
    expect(afterRound?.reachedRung).toBeGreaterThanOrEqual(2);
    await seat.rotate();
    const verifiable = ok(await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));
    expect(verifiable.balloons[0]?.afterRound?.draws[0]?.drawIndex).toBe(2);
    expect(verifyRound(verifiable).problems).toEqual([]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it.each([
    ['reaches the capped top', true, { outcome: 'top', reachedRung: 2 }],
    ['pops below it', false, { outcome: 'popped', reachedRung: 1 }],
  ] as const)('stops at the balloon’s top rung under the payout cap: %s', async (_label, survivesTo2, expected) => {
    const capped = cappedAt(rtpBp);
    // Pump 3 would pop, so a reveal that ignored the cap would say "popped
    // on rung 2" where the capped one says "top".
    const { seat, round, foretold } = await deal(
      (r) => survives(1)(r) && willSurvive(r, 0, 1, 2) === survivesTo2 && !willSurvive(r, 0, 2, 3),
      capped,
      [LARGEST_BET_CENTS],
    );
    expect(round.balloons[0]?.topRung).toBe(2);
    const pumped = ok(await seat.pump(round, 0)).round;

    const cashed = ok(await seat.cashOut(pumped, 0)).round;

    expect(cashed.balloons[0]?.afterRound).toEqual(
      foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 2 }),
    );
    expect(cashed.balloons[0]?.afterRound).toMatchObject(expected);
    await seat.rotate();
    const verifiable = ok(await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));
    expect(verifiable.maxPayoutCents).toBe(SMALL_CAP_CENTS);
    expect(verifyRound(verifiable).problems).toEqual([]);
  });

  it('is made by the 24-hour rule on the player’s next request, for the pumped balloons only', async () => {
    const { world, seat, round, foretold } = await deal(
      (r) => survives(2, 0)(r) && survives(1, 1)(r),
      config,
      [1000, 1000, 1000],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.pump(now, 0)).round;
    now = ok(await seat.pump(now, 1)).round;
    world.runtime.advance(ABANDONED_AFTER_MS);

    // The old screen's Pump: the round is settled first, then this is refused.
    const late = await seat.pump(now, 0);

    expect(late.status).toBe(409);
    expect(late.error?.round?.status).toBe('finished');
    expect(revealsIn(late.error?.round)).toEqual([
      foreseen(foretold, 0, { rung: 2, drawIndex: 2, topRung: 3 }),
      foreseen(foretold, 1, { rung: 1, drawIndex: 1, topRung: 3 }),
      // Refunded: never pumped, so no reveal.
      null,
    ]);
    const stored = roundsRepository(world.db).find(round.id);
    const written = world.db
      .prepare('SELECT DISTINCT created_at FROM balloon_reveals WHERE round_id = ?')
      .all(round.id)
      .map((row) => row.created_at);
    expect(written).toEqual([stored?.finishedAt]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('is made by the sweep for a player who never comes back', async () => {
    const { world, seat, round, foretold } = await deal(
      (r) => survives(1, 0)(r) && survives(1, 1)(r),
      config,
      [1000, 1000, 1000],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.pump(now, 1)).round;
    expect(ok(await seat.cashOut(now, 1)).round.status).toBe('active');
    expect(count(world.db, 'balloon_reveals')).toBe(0);
    world.runtime.advance(ABANDONED_AFTER_MS);

    expect(world.services.game.sweepAbandoned()).toBe(1);

    const stored = roundsRepository(world.db).find(round.id);
    expect(stored?.status).toBe('finished');
    const ending = (reveal: { outcome: RevealOutcome; reachedRung: number } | null) =>
      reveal && { outcome: reveal.outcome, reachedRung: reveal.reachedRung };
    expect(stored?.reveals.map(ending)).toEqual([
      ending(foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 })),
      ending(foreseen(foretold, 1, { rung: 1, drawIndex: 1, topRung: 3 })),
      null,
    ]);
    // Balloon 1 was cashed out by the player before the sweep; its reveal
    // still waited for the round to end.
    await seat.rotate();
    const verifiable = ok(await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));
    expect(verifyRound(verifiable).problems).toEqual([]);
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('gives the verify page every draw, every reveal and the cap, and the round checks out', async () => {
    const { world, seat, round, foretold } = await deal(
      (r) => survives(2, 0)(r) && survives(1, 1)(r),
      config,
      [1234, 777, 10],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.pump(now, 0, { patch: true })).round;
    now = ok(await seat.cashOut(now, 0)).round;
    now = ok(await seat.pump(now, 1)).round;
    now = ok(await seat.cashOut(now, 1)).round;
    const last = ok(await seat.pump(now, 2));
    if (last.round.status === 'active') ok(await seat.cashOut(last.round, 2));
    await seat.rotate();

    const verifiable = ok(await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));

    expect(verifiable.maxPayoutCents).toBe(GAME_CONFIG.limits.maxPayoutCents);
    expect(verifiable.balloons.map((balloon) => balloon.draws.map((draw) => draw.drawIndex))).toEqual([
      [0, 1],
      [0],
      [0],
    ]);
    const shown = verifiable.balloons[0]?.afterRound;
    const expected = foreseen(foretold, 0, { rung: 2, drawIndex: 2, topRung: 3 });
    expect(shown && { outcome: shown.outcome, reachedRung: shown.reachedRung }).toEqual({
      outcome: expected.outcome,
      reachedRung: expected.reachedRung,
    });
    const check = verifyRound(verifiable);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    // What the verify page shows is what the game showed.
    expect(check.balloons.map((balloon) => balloon.afterRound?.reachedRung ?? null)).toEqual(
      verifiable.balloons.map((balloon) => balloon.afterRound?.reachedRung ?? null),
    );
    expect(reconcile(world.db).problems).toEqual([]);
  });

  it('uses the round’s own RTP, ladder and cap, even after a restart with new ones', async () => {
    const { world, seat, round, foretold } = await deal(survives(1), config);
    const pumped = ok(await seat.pump(round, 0)).round;
    const changed: GameConfig = {
      rtpBp: rtpBp === 9400 ? 9900 : 9400,
      limits: { ...LIMITS, maxPayoutCents: 9_000_000 },
      difficulties: [...GAME_CONFIG.difficulties, { ...TINY, ladder: [105, 130, 170] }],
    };
    const restarted = seat.on(buildApp({ runtime: { ...world.runtime, config: changed } }));

    const cashed = ok(await restarted.cashOut(pumped, 0)).round;

    expect(cashed).toMatchObject({ rtpBp, ladder: TINY.ladder });
    expect(cashed.balloons[0]?.afterRound).toEqual(
      foreseen(foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 }),
    );
    await restarted.rotate();
    const verifiable = ok(await restarted.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));
    expect(verifiable.maxPayoutCents).toBe(GAME_CONFIG.limits.maxPayoutCents);
    expect(verifyRound(verifiable).problems).toEqual([]);
  });

  it('answers the same, byte for byte, while the round is in progress, whatever the later draws', async () => {
    // Two tables whose rounds play out the same so far, but where balloon 0
    // would survive its next pump at one table and pop at the other.
    const sameSoFar = (r: Foretold): boolean => survives(1, 0)(r) && survives(1, 1)(r);
    const tables = [
      await deal((r) => sameSoFar(r) && willSurvive(r, 0, 1, 2), config, [1000, 1000]),
      await deal((r) => sameSoFar(r) && !willSurvive(r, 0, 1, 2), config, [1000, 1000]),
    ];
    const play = async ({ seat, round, foretold }: Table) => {
      const raws: string[] = [];
      const keep = <T>(reply: Reply<T>): Reply<T> => {
        // The client seeds differ by design; nothing else may.
        raws.push(reply.raw.replaceAll(`"${foretold.clientSeed}"`, '"<client seed>"'));
        return reply;
      };
      let now = keep(await seat.pump(round, 0)).body.round;
      const beforeCashOut = now;
      now = keep(await seat.cashOut(now, 0)).body.round;
      // An old screen, a refusal that carries the round in progress.
      expect(keep(await seat.cashOut(beforeCashOut, 0)).status).toBe(409);
      keep(await seat.session());
      keep(await seat.get<HistoryResponse>('/api/history'));
      now = keep(await seat.pump(now, 1)).body.round;
      expect(now.status).toBe('active');
      const last = await seat.cashOut(now, 1);
      return { raws, finished: last.body.round };
    };

    const [first, second] = [await play(tables[0] as Table), await play(tables[1] as Table)];

    expect(second.raws).toEqual(first.raws);
    for (const raw of first.raws) expect(raw).not.toMatch(/"afterRound":\{/);
    // Once the round is over the two differ, so the comparison above could see a reveal.
    expect(first.finished.balloons[0]?.afterRound?.reachedRung).toBeGreaterThanOrEqual(2);
    expect(second.finished.balloons[0]?.afterRound).toMatchObject({ outcome: 'popped', reachedRung: 1 });
  });

  it('gives balloon 0 the same reveal whatever happens to balloons 1 and 2, and in any order', async () => {
    const wanted = (r: Foretold): boolean => survives(1, 0)(r) && survives(1, 1)(r) && survives(1, 2)(r);
    /** Plays one balloon: pumps `pumps` times, then cashes out if it is still in play. */
    const playBalloon = async (seat: Seat, round: RoundView, index: number, pumps: number) => {
      let now = round;
      for (let i = 0; i < pumps && now.balloons[index]?.status === 'active'; i += 1) {
        now = ok(await seat.pump(now, index)).round;
      }
      if (now.balloons[index]?.status === 'active') now = ok(await seat.cashOut(now, index)).round;
      return now;
    };

    const a = await deal(wanted, config, [1000, 1000, 1000]);
    let roundA = await playBalloon(a.seat, a.round, 0, 1);
    roundA = await playBalloon(a.seat, roundA, 1, 1);
    roundA = await playBalloon(a.seat, roundA, 2, 2);

    const b = await deal(wanted, config, [1000, 1000, 1000]);
    expect(b.foretold).toEqual(a.foretold);
    let roundB = await playBalloon(b.seat, b.round, 2, 1);
    roundB = await playBalloon(b.seat, roundB, 1, 3);
    roundB = await playBalloon(b.seat, roundB, 0, 1);

    expect(roundA.status).toBe('finished');
    expect(roundB.status).toBe('finished');
    expect(roundB.balloons[0]?.afterRound).toEqual(roundA.balloons[0]?.afterRound);
    expect(roundA.balloons[0]?.afterRound).toEqual(
      foreseen(a.foretold, 0, { rung: 1, drawIndex: 1, topRung: 3 }),
    );
    const drawsOf = (world: TestWorld) => roundsRepository(world.db).find(a.round.id)?.reveals[0];
    expect(drawsOf(b.world)).toEqual(drawsOf(a.world));
  });

  it('answers a repeated finishing request with the same body, byte for byte, and reveals once', async () => {
    const { world, seat, round } = await deal(survives(1), config);
    const pumped = ok(await seat.pump(round, 0)).round;
    const key = newKey();

    const [first, second] = await Promise.all([
      seat.cashOut(pumped, 0, { key }),
      seat.cashOut(pumped, 0, { key }),
    ]);
    const later = await seat.cashOut(pumped, 0, { key });
    await seat.rotate();
    const afterRotate = await seat.cashOut(pumped, 0, { key });

    expect(first.status).toBe(200);
    expect(first.body.round.balloons[0]?.afterRound).not.toBeNull();
    for (const repeat of [second, later, afterRotate]) expect(repeat.raw).toBe(first.raw);
    expect(count(world.db, 'balloon_reveals')).toBe(1);
    expect(count(world.db, "ledger WHERE kind = 'payout'")).toBe(1);
  });

  it('makes no reveal for a refused request, even one that would have ended the round', async () => {
    const { world, seat, round } = await deal(
      (r) => survives(1, 0)(r) && survives(1, 1)(r),
      config,
      [1000, 1000],
    );
    let now = ok(await seat.pump(round, 0)).round;
    now = ok(await seat.cashOut(now, 0)).round;
    now = ok(await seat.pump(now, 1)).round;

    const stale = await seat.cashOut(now, 1, { expectedDrawIndex: 0 });
    const missing = await seat.cashOut(now, 2);

    expect(stale.status).toBe(409);
    expect(missing.status).toBe(400);
    expect(revealsIn(stale.error?.round)).toEqual([null, null]);
    expect(count(world.db, 'balloon_reveals')).toBe(0);
    expect((await seat.session()).body.activeRound?.status).toBe('active');

    const last = ok(await seat.cashOut(now, 1)).round;
    expect(last.status).toBe('finished');
    expect(count(world.db, 'balloon_reveals')).toBe(2);
  });

  it('never puts the unrevealed server seed in any answer', async () => {
    const { world, seat, round } = await deal(
      (r) => survives(1, 0)(r) && survives(1, 1)(r),
      config,
      [1000, 1000],
    );
    const secret = secretSeed(world.db);
    const raws: string[] = [];
    let now = ok(await seat.pump(round, 0)).round;
    const cashed = await seat.cashOut(now, 0);
    raws.push(cashed.raw);
    now = cashed.body.round;
    now = ok(await seat.pump(now, 1)).round;
    const finished = await seat.cashOut(now, 1);
    raws.push(finished.raw);
    raws.push((await seat.cashOut(now, 1)).raw);
    raws.push((await seat.session()).raw);
    raws.push((await seat.get(`/api/history`)).raw);
    raws.push((await seat.get(`/api/rounds/${round.id}/verify`)).raw);

    expect(finished.body.round.balloons.every((balloon) => balloon.afterRound !== null)).toBe(true);
    expect(secretSeed(world.db)).toBe(secret);
    for (const raw of raws) expect(raw).not.toContain(secret);
  });
});

describe('a reveal across RTPs', () => {
  it('is the same at 9400, 9700 and 9900: from pump 2 on, the RTP never enters', async () => {
    const worlds = await Promise.all(
      [9400, 9700, 9900].map(async (rtpBp) => {
        const world = testWorld(configAt(rtpBp));
        return { world, seat: await Seat.join(world.app, null), rtpBp };
      }),
    );
    const serverSeed = secretSeed(worlds[0]?.world.db ?? testWorld().db);
    const foretold = (rtpBp: number, clientSeed: string): Foretold => ({
      serverSeed,
      clientSeed,
      nonce: 0,
      rtpBp,
      ladder: TINY.ladder,
    });
    // Pump 1 depends on the RTP: pick a seed where it survives at all three.
    const clientSeed = clientSeedWhere((seed) =>
      worlds.every(({ rtpBp }) => willSurvive(foretold(rtpBp, seed), 0, 0, 1)),
    );

    const reveals = [];
    for (const { world, seat, rtpBp } of worlds) {
      expect(secretSeed(world.db)).toBe(serverSeed);
      await seat.setClientSeed(clientSeed);
      const started = ok(await seat.start('tiny', [1000])).round;
      expect(started.rtpBp).toBe(rtpBp);
      const pumped = ok(await seat.pump(started, 0)).round;
      reveals.push(ok(await seat.cashOut(pumped, 0)).round.balloons[0]?.afterRound);
    }

    expect(reveals[0]).not.toBeNull();
    expect(reveals[1]).toEqual(reveals[0]);
    expect(reveals[2]).toEqual(reveals[0]);
  });
});

describe.each(RTPS)('a database from before reveals existed, at RTP %i', (rtpBp) => {
  it('is brought up to date, its honest old rounds still check out, and new rounds store the cap', () => {
    const config = configAt(rtpBp);
    const runtime = testRuntime(config);
    const db = openDatabase(':memory:');
    migrate(db, 1);
    // An older server's round, played with real draws: a $10 Tiny balloon
    // pumped once (it survived), then cashed out on rung 1 of 3 and paid
    // 1.01x. It finished with no cap stored and no reveal, and its seed was
    // then revealed.
    const serverSeed = 'a'.repeat(64);
    const ladder = ladderOf(config, 'tiny');
    const base = { serverSeed, nonce: 0, rtpBp, ladder };
    const clientSeed = clientSeedWhere((seed) => survives(1)({ ...base, clientSeed: seed }));
    const chance = surviveChance(rtpBp, ladder, 1);
    const { roll } = drawRoll(
      { serverSeed, clientSeed, nonce: 0, balloonIndex: 0, drawIndex: 0 },
      chance.den,
    );
    const at = '2026-01-01T00:00:00.000Z';
    db.exec(`
      INSERT INTO players (id, token_hash, created_at) VALUES ('p1', 'h1', '${at}');
      INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, created_at)
        VALUES ('p1', 'grant', 1000000, 1000000, '${at}');
      INSERT INTO server_seeds (player_id, seed, seed_hash, created_at)
        VALUES ('p1', '${serverSeed}', '${hashServerSeed(serverSeed)}', '${at}');
      UPDATE server_seeds SET next_nonce = 1;
      INSERT INTO rounds (id, player_id, status, difficulty_id, rtp_bp, ladder, server_seed_id,
                          client_seed, nonce, started_at, last_action_at)
        VALUES ('old', 'p1', 'active', 'tiny', ${String(rtpBp)}, '${JSON.stringify(ladder)}', 1,
                '${clientSeed}', 0, '${at}', '${at}');
      INSERT INTO balloons (round_id, balloon_index, bet_cents, status, rung, draw_index, top_rung)
        VALUES ('old', 0, 1000, 'active', 0, 0, 3);
      INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, round_id, balloon_index, created_at)
        VALUES ('p1', 'bet', -1000, 999000, 'old', 0, '${at}');
      INSERT INTO balloon_actions (round_id, balloon_index, seq, kind, patch, draw_index, den, num, roll, outcome, created_at)
        VALUES ('old', 0, 0, 'pump', 0, 0, ${String(chance.den)}, ${String(chance.num)},
                ${String(roll)}, 'survived', '${at}');
      UPDATE balloons SET rung = 1, draw_index = 1;
      INSERT INTO balloon_actions (round_id, balloon_index, seq, kind, outcome, created_at)
        VALUES ('old', 0, 1, 'cashOut', 'cashed', '${at}');
      UPDATE balloons SET status = 'cashed', payout_cents = 1010;
      INSERT INTO ledger (player_id, kind, amount_cents, balance_after_cents, round_id, balloon_index, created_at)
        VALUES ('p1', 'payout', 1010, 1000010, 'old', 0, '${at}');
      UPDATE rounds SET status = 'finished', finished_at = '${at}';
      UPDATE server_seeds SET revealed_at = '${at}';
    `);

    migrate(db);

    expect(count(db, 'schema_migrations')).toBe(2);
    expect(reconcile(db).problems).toEqual([]);
    const game = buildServices({ ...runtime, db }).game;
    const verifiable = game.verifiable('p1', 'old');
    expect(verifiable.maxPayoutCents).toBe(GAME_CONFIG.limits.maxPayoutCents);
    expect(verifiable.balloons[0]?.draws).toEqual([
      { drawIndex: 0, den: chance.den, num: chance.num, roll },
    ]);
    // No reveal was stored for it, so the verify answer works it out from
    // the revealed seed, starting at the balloon's draw count.
    const expected = foreseen({ ...base, clientSeed }, 0, { rung: 1, drawIndex: 1, topRung: 3 });
    const late = verifiable.balloons[0]?.afterRound;
    expect(late && { outcome: late.outcome, reachedRung: late.reachedRung }).toEqual({
      outcome: expected.outcome,
      reachedRung: expected.reachedRung,
    });
    expect(late?.draws[0]?.drawIndex).toBe(1);
    // So the honest old round checks out, as a player would check it.
    const check = verifyRound(verifiable);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    // Checking it stores nothing, and the books still agree.
    expect(count(db, 'balloon_reveals')).toBe(0);
    expect(reconcile(db).problems).toEqual([]);

    // A round started now stores the cap it is played under.
    db.exec(`INSERT INTO server_seeds (player_id, seed, seed_hash, created_at)
             VALUES ('p1', '${'b'.repeat(64)}', 'hash-b', '${at}')`);
    db.exec("UPDATE players SET client_seed = 'seed'");
    const started = immediate(db, () => game.start('p1', { difficultyId: 'tiny', betsCents: [1000] }));
    expect(roundsRepository(db).find(started.round.id)?.maxPayoutCents).toBe(
      GAME_CONFIG.limits.maxPayoutCents,
    );
  });

  it('does not fill in a reveal missing from a round that stored its cap', async () => {
    const { world, seat, round } = await deal(survives(1), configAt(rtpBp));
    const pumped = ok(await seat.pump(round, 0)).round;
    expect(ok(await seat.cashOut(pumped, 0)).round.status).toBe('finished');
    await seat.rotate();
    // Such a round can only lose its reveal by hand: the database keeps
    // reveals for good. If it ever did, the verify answer must say so
    // rather than work one out.
    world.db.exec(`
      DROP TRIGGER balloon_reveals_no_delete;
      DELETE FROM balloon_reveals;
    `);

    const verifiable = ok(await seat.get<VerifiableRound>(`/api/rounds/${round.id}/verify`));

    expect(verifiable.balloons[0]?.afterRound).toBeNull();
    const check = verifyRound(verifiable);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/server shows nothing/);
  });
});
