/**
 * Real seeds through the live engine, then the verifier on what was played.
 *
 * This plays a few thousand rounds the way the server does: startRound, then
 * pump (with drawerFor on the round's real seeds), Patch + pump, cash out, and
 * now and then a round walked away from and settled with settleAbandoned. It
 * records every action and every DrawRecord the way a server would store
 * them. Once the round is over it works out each reveal (where a balloon
 * cashed out below its top would have popped) the way the server will:
 * revealAfterCashOut with revealDrawerFor on the round's seeds. It builds the
 * RoundRecord the verify page would be sent, and checks that verifyRound
 * finds nothing wrong, and that the draws, balloons and reveals it
 * recomputes from the seeds are exactly the live ones. Each reveal is also
 * checked against simply going on pumping the live balloon, as if the player
 * had not cashed out.
 *
 * It runs at 9400, 9700 and 9900 (and the configured RTP) on every
 * difficulty, and on a fixed ladder from fixtures.ts that never changes.
 * Choices come from a small seeded generator, never Math.random, so a
 * failure always reproduces.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canReveal,
  cashOut,
  GAME_CONFIG,
  isRoundOver,
  pump,
  revealAfterCashOut,
  RTP_BP,
  settleAbandoned,
  startRound,
  type BalloonAction,
  type CashOutReveal,
  type DrawRecord,
  type GameConfig,
  type Round,
} from '@pump/engine';
import {
  drawerFor,
  hashServerSeed,
  revealDrawerFor,
  verifyRound,
  type RoundRecord,
} from '@pump/engine/fair';
import { fixedConfig } from '../fixtures';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];
const RICH = 1_000_000_000;
/** Every case plays this many rounds. */
const ROUNDS_PER_CASE = 200;
/**
 * A case plays on past ROUNDS_PER_CASE, up to this many rounds, while some
 * path its ladder can take has not shown up yet. As shipped every path shows
 * up within ROUNDS_PER_CASE; a new ladder may make one rarer (a top pump
 * that seldom survives makes a reveal to the top rare).
 */
const MOST_ROUNDS_PER_CASE = 5000;

/** Bets that must be played on every ladder at every RTP: edges and awkward amounts. */
const SPECIAL_BETS = [10, 11, 99, 12_345, 100_000];
const { minBetCents, maxBetCents } = GAME_CONFIG.limits;

/**
 * A seeded generator (mulberry32): whole numbers only. pick(n) gives 0 .. n - 1;
 * the small bias of `% n` does not matter for choosing test moves.
 */
function generator(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/** 64 lowercase hex characters, made from a label so every run uses the same seeds. */
function serverSeedFor(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

const CLIENT_SEED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function clientSeedFrom(pick: (n: number) => number): string {
  const length = 1 + pick(64);
  let seed = '';
  for (let i = 0; i < length; i += 1) seed += CLIENT_SEED_CHARS.charAt(pick(CLIENT_SEED_CHARS.length));
  return seed;
}

/** What a server would store about one round while it is played. */
interface Played {
  readonly record: RoundRecord;
  readonly live: Round;
  /** Per balloon: whether each pump had a Patch, in order. */
  readonly patched: readonly (readonly boolean[])[];
  /** Per balloon: the round just before it cashed out, or undefined if it never did. */
  readonly beforeCashOut: readonly (Round | undefined)[];
}

/** Tallies of what happened, to show the rounds covered every path. */
type Seen = Map<string, number>;

function note(seen: Seen, what: string): void {
  seen.set(what, (seen.get(what) ?? 0) + 1);
}

/**
 * Plays one round with seeded choices. Each balloon is either cautious
 * (cashes out at random, rarely patches) or a climber (patches most pumps, so
 * it often reaches its top rung; it cashes out only on the rung below the
 * top, half the time, so some reveals reach the top). With chance 1 in 6 the
 * round is walked away from after a few steps and settled as abandoned.
 */
function playRound(
  config: GameConfig,
  difficultyId: string,
  seeds: { readonly serverSeed: string; readonly clientSeed: string; readonly nonce: number },
  pick: (n: number) => number,
  seen: Seen,
): Played {
  const balloonCount = 1 + pick(config.limits.maxBalloons);
  const bets = Array.from({ length: balloonCount }, () =>
    pick(2) === 0
      ? (SPECIAL_BETS[pick(SPECIAL_BETS.length)] ?? minBetCents)
      : minBetCents + pick(maxBetCents - minBetCents + 1),
  );
  for (const bet of bets) note(seen, `bet ${String(bet)}`);
  const climber = bets.map(() => pick(4) === 0);
  const actions: BalloonAction[][] = bets.map(() => []);
  const draws: DrawRecord[][] = bets.map(() => []);
  const patched: boolean[][] = bets.map(() => []);
  const beforeCashOut: (Round | undefined)[] = bets.map(() => undefined);

  let round = startRound(config, difficultyId, bets, RICH).round;
  const abandonAfter = pick(6) === 0 ? pick(5) : Number.POSITIVE_INFINITY;
  let steps = 0;

  while (!isRoundOver(round)) {
    if (steps === abandonAfter) {
      // The server's sweep: pumped balloons cash out, unpumped bets are refunded.
      const settled = settleAbandoned(round);
      for (const { balloonIndex, kind } of settled.settled) {
        note(seen, `abandoned ${kind}`);
        // A cash-out made by settling is stored as a plain cash-out; a refund has no action.
        if (kind === 'cashed') {
          actions[balloonIndex]?.push({ kind: 'cashOut' });
          beforeCashOut[balloonIndex] = round;
        }
      }
      round = settled.round;
      break;
    }
    steps += 1;

    const active = round.balloons.flatMap((b, i) => (b.status === 'active' ? [i] : []));
    const balloonIndex = active[pick(active.length)] ?? 0;
    const balloon = round.balloons[balloonIndex];
    if (balloon === undefined) throw new Error('no such balloon');
    const isClimber = climber[balloonIndex] === true;
    const choice = pick(20);

    const climberStops = isClimber && balloon.rung === balloon.topRung - 1 && choice < 10;
    if (balloon.rung >= 1 && ((!isClimber && choice < 5) || climberStops)) {
      beforeCashOut[balloonIndex] = round;
      round = cashOut(round, { balloonIndex, expectedDrawIndex: balloon.drawIndex }).round;
      actions[balloonIndex]?.push({ kind: 'cashOut' });
      note(seen, 'cash out');
      continue;
    }

    const patch = balloon.rung >= 1 && (isClimber ? choice < 15 : choice < 9);
    const result = pump(
      round,
      { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch, balanceCents: RICH },
      // The live draw: the round's seeds at this balloon's next draw index.
      drawerFor({ ...seeds, balloonIndex, drawIndex: balloon.drawIndex }),
    );
    round = result.round;
    actions[balloonIndex]?.push({ kind: 'pump', patch });
    draws[balloonIndex]?.push(result.draw);
    patched[balloonIndex]?.push(patch);
    note(seen, result.outcome);
  }

  // The round is over: the server works out each reveal, from the seeds, for
  // every balloon cashed out below its top rung.
  const afterRound = round.balloons.map((balloon, balloonIndex): CashOutReveal | null => {
    if (!canReveal(balloon)) return null;
    const draws = revealDrawerFor({ ...seeds, balloonIndex, drawIndex: balloon.drawIndex });
    const reveal = revealAfterCashOut(round, balloonIndex, draws);
    note(seen, `reveal ${reveal.outcome}`);
    if (balloon.drawIndex > balloon.rung) note(seen, 'reveal after a Patch save');
    return reveal;
  });

  const record: RoundRecord = {
    serverSeed: seeds.serverSeed,
    serverSeedHash: hashServerSeed(seeds.serverSeed),
    clientSeed: seeds.clientSeed,
    nonce: seeds.nonce,
    difficultyId: round.difficultyId,
    rtpBp: round.rtpBp,
    ladder: round.ladder,
    maxPayoutCents: config.limits.maxPayoutCents,
    balloons: round.balloons.map((balloon, i) => ({
      betCents: balloon.betCents,
      actions: actions[i] ?? [],
      status: balloon.status,
      rung: balloon.rung,
      drawIndex: balloon.drawIndex,
      topRung: balloon.topRung,
      patchesCents: balloon.patchesCents,
      payoutCents: balloon.payoutCents,
      draws: draws[i] ?? [],
      afterRound: afterRound[i] ?? null,
    })),
  };
  return { record, live: round, patched, beforeCashOut };
}

/**
 * What live play would have done had the player gone on pumping balloon
 * `balloonIndex` with no Patch instead of cashing out: the same seeds, the
 * live engine's pump and a fresh drawerFor for each pump.
 */
function pumpedOn(
  round: Round,
  balloonIndex: number,
  seeds: { readonly serverSeed: string; readonly clientSeed: string; readonly nonce: number },
): CashOutReveal {
  let current = round;
  const draws: DrawRecord[] = [];
  for (;;) {
    const balloon = current.balloons[balloonIndex];
    if (balloon === undefined) throw new Error('no such balloon');
    const result = pump(
      current,
      { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch: false, balanceCents: RICH },
      drawerFor({ ...seeds, balloonIndex, drawIndex: balloon.drawIndex }),
    );
    current = result.round;
    draws.push(result.draw);
    const after = current.balloons[balloonIndex];
    if (after === undefined) throw new Error('no such balloon');
    if (result.outcome === 'popped' || result.outcome === 'top') {
      return { outcome: result.outcome, reachedRung: after.rung, draws };
    }
  }
}

/** Every path a round can take, as playRound tallies them. */
const EVERY_PATH: readonly string[] = [
  'survived',
  'saved',
  'popped',
  'top',
  'cash out',
  'abandoned cashed',
  'abandoned refunded',
  'reveal popped',
  'reveal top',
  'reveal after a Patch save',
  ...SPECIAL_BETS.map((bet) => `bet ${String(bet)}`),
];

/**
 * The paths a ladder can take at all. On a one-rung ladder the first pump
 * goes to the top, so no pump survives below it; a Patch is sold from pump
 * 2 on, so there is none; and no balloon is ever in play on a rung, so
 * there is no cash-out below the top, by hand or by the 24-hour rule, and
 * no reveal.
 */
function pathsOf(ladder: readonly number[]): readonly string[] {
  if (ladder.length >= 2) return EVERY_PATH;
  const none = new Set([
    'survived',
    'saved',
    'cash out',
    'abandoned cashed',
    'reveal popped',
    'reveal top',
    'reveal after a Patch save',
  ]);
  return EVERY_PATH.filter((path) => !none.has(path));
}

/** One case: an RTP, a name for the ladder, the config it is in, and its difficulty id. */
type Case = readonly [rtpBp: number, name: string, config: GameConfig, id: string];

const CASES: readonly Case[] = RTPS.flatMap((rtpBp) => [
  // Every configured difficulty...
  ...GAME_CONFIG.difficulties.map(
    (difficulty): Case => [rtpBp, difficulty.id, { ...GAME_CONFIG, rtpBp }, difficulty.id],
  ),
  // ...and a fixed ladder that takes every path, so the check of every
  // path never goes away, whatever the config holds.
  [rtpBp, 'the fixed medium ladder', fixedConfig(rtpBp), 'medium'] as const,
]);

describe('verifyRound on rounds played by the live engine with real seeds', () => {
  it.each(CASES)('at RTP %i on %s, every round verifies and recomputes exactly', (rtpBp, name, config, id) => {
    const ladder = config.difficulties.find((d) => d.id === id)?.ladder ?? [];
    const paths = pathsOf(ladder);
    const pick = generator(rtpBp * 31 + name.length * 7919 + (name.codePointAt(0) ?? 0));
    const seen: Seen = new Map();
    const missing = (): readonly string[] => paths.filter((path) => (seen.get(path) ?? 0) === 0);

    // One player: the server seed rotates every 25 rounds (nonce back to 0),
    // and the client seed is edited now and then (nonce carries on).
    let serverSeed = '';
    let nonce = 0;
    let clientSeed = clientSeedFrom(pick);
    for (
      let r = 0;
      r < ROUNDS_PER_CASE || (r < MOST_ROUNDS_PER_CASE && missing().length > 0);
      r += 1
    ) {
      if (r % 25 === 0) {
        serverSeed = serverSeedFor(`engine.test ${String(rtpBp)} ${name} ${String(r)}`);
        nonce = 0;
      }
      if (pick(8) === 0) clientSeed = clientSeedFrom(pick);

      const seeds = { serverSeed, clientSeed, nonce };
      const { record, live, patched, beforeCashOut } = playRound(config, id, seeds, pick, seen);
      nonce += 1;

      const check = verifyRound(record);
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.seedHashMatches).toBe(true);
      expect(check.balloons).toHaveLength(live.balloons.length);
      check.balloons.forEach((balloonCheck, i) => {
        const stored = record.balloons[i];
        expect(balloonCheck.ok).toBe(true);
        // The recomputed balloon and draws are exactly the live ones.
        expect(balloonCheck.balloon).toEqual(live.balloons[i]);
        expect(
          balloonCheck.draws.map(({ drawIndex, den, num, roll }) => ({ drawIndex, den, num, roll })),
        ).toEqual(stored?.draws);
        // The steps shown on the page agree with the recipe: the block-0
        // message, roll = word mod den, survived = roll < num, and the Patch.
        expect(
          balloonCheck.draws.map((draw) => [
            draw.message,
            draw.word % draw.den === draw.roll,
            draw.survived === draw.roll < draw.num,
            draw.patched,
          ]),
        ).toEqual(
          (patched[i] ?? []).map((patch, j) => [
            `${record.clientSeed}:${String(record.nonce)}:${String(i)}:${String(j)}:0`,
            true,
            true,
            patch,
          ]),
        );
        // The reveal: recomputed exactly, and the same as pumping on live.
        const reveal = stored?.afterRound ?? null;
        expect(balloonCheck.afterRound === null).toBe(reveal === null);
        if (reveal === null) return;
        expect(balloonCheck.afterRound).toMatchObject({
          outcome: reveal.outcome,
          reachedRung: reveal.reachedRung,
        });
        expect(
          balloonCheck.afterRound?.draws.map(({ drawIndex, den, num, roll }) => ({
            drawIndex,
            den,
            num,
            roll,
          })),
        ).toEqual(reveal.draws);
        const before = beforeCashOut[i];
        if (before === undefined) throw new Error('a revealed balloon must have cashed out');
        expect(pumpedOn(before, i, seeds)).toEqual(reveal);
      });
    }

    // Every path the ladder can take was taken: each kind of pump outcome,
    // both kinds of settlement, player cash-outs, and every special bet.
    // On the shipped ladders and the fixed one that is every path there is.
    if (name === 'the fixed medium ladder') expect(paths).toEqual(EVERY_PATH);
    for (const path of paths) {
      expect(seen.get(path) ?? 0, path).toBeGreaterThan(0);
    }
  }, 60_000);
});
