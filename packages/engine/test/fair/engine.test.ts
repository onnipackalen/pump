/**
 * Real seeds through the live engine, then the verifier on what was played.
 *
 * This plays a few thousand rounds the way the server does: startRound, then
 * pump (with drawerFor on the round's real seeds), Patch + pump, cash out, and
 * now and then a round walked away from and settled with settleAbandoned. It
 * records every action and every DrawRecord the way a server would store
 * them, builds the RoundRecord the verify page would be sent, and checks
 * that verifyRound finds nothing wrong, and that the draws and balloons it
 * recomputes from the seeds are exactly the live ones.
 *
 * It runs at 9400, 9700 and 9900 (and the configured RTP) on every
 * difficulty. Choices come from a small seeded generator, never Math.random,
 * so a failure always reproduces.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cashOut,
  GAME_CONFIG,
  isRoundOver,
  pump,
  RTP_BP,
  settleAbandoned,
  startRound,
  type BalloonAction,
  type DrawRecord,
  type GameConfig,
  type Round,
} from '@pump/engine';
import { drawerFor, hashServerSeed, verifyRound, type RoundRecord } from '@pump/engine/fair';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];
const RICH = 1_000_000_000;
const ROUNDS_PER_CASE = 200;

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
}

/** Tallies of what happened, to show the rounds covered every path. */
type Seen = Map<string, number>;

function note(seen: Seen, what: string): void {
  seen.set(what, (seen.get(what) ?? 0) + 1);
}

/**
 * Plays one round with seeded choices. Each balloon is either cautious
 * (cashes out at random, rarely patches) or a climber (never cashes out,
 * patches most pumps, so it often reaches its top rung). With chance 1 in 6
 * the round is walked away from after a few steps and settled as abandoned.
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
        if (kind === 'cashed') actions[balloonIndex]?.push({ kind: 'cashOut' });
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

    if (balloon.rung >= 1 && !isClimber && choice < 5) {
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
    })),
  };
  return { record, live: round, patched };
}

const CASES = RTPS.flatMap((rtpBp) =>
  GAME_CONFIG.difficulties.map((difficulty) => [rtpBp, difficulty.id] as const),
);

describe('verifyRound on rounds played by the live engine with real seeds', () => {
  it.each(CASES)('at RTP %i on %s, every round verifies and recomputes exactly', (rtpBp, id) => {
    const config: GameConfig = { ...GAME_CONFIG, rtpBp };
    const pick = generator(rtpBp * 31 + id.length * 7919 + (id.codePointAt(0) ?? 0));
    const seen: Seen = new Map();

    // One player: the server seed rotates every 25 rounds (nonce back to 0),
    // and the client seed is edited now and then (nonce carries on).
    let serverSeed = '';
    let nonce = 0;
    let clientSeed = clientSeedFrom(pick);
    for (let r = 0; r < ROUNDS_PER_CASE; r += 1) {
      if (r % 25 === 0) {
        serverSeed = serverSeedFor(`engine.test ${String(rtpBp)} ${id} ${String(r)}`);
        nonce = 0;
      }
      if (pick(8) === 0) clientSeed = clientSeedFrom(pick);

      const { record, live, patched } = playRound(
        config,
        id,
        { serverSeed, clientSeed, nonce },
        pick,
        seen,
      );
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
      });
    }

    // Every path was taken: each kind of pump outcome, both kinds of
    // settlement, player cash-outs, and every special bet.
    for (const path of [
      'survived',
      'saved',
      'popped',
      'top',
      'cash out',
      'abandoned cashed',
      'abandoned refunded',
      ...SPECIAL_BETS.map((bet) => `bet ${String(bet)}`),
    ]) {
      expect(seen.get(path) ?? 0, path).toBeGreaterThan(0);
    }
  });
});
