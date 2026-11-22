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
 *
 * Two kinds of round are played. Random rounds: choices from a small seeded
 * generator, never Math.random, so a failure always reproduces. On the fixed
 * ladder they alone must take every path a round can take. And found
 * rounds: for each path, a one-balloon plan that takes it, with client seeds
 * tried in turn until the real draws make it happen. A path a ladder seldom
 * takes (a steep start, a top pump that seldom survives) is still checked
 * that way, on any ladder the config may hold.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canReveal,
  cashOut,
  GAME_CONFIG,
  isRoundOver,
  ladderProblems,
  pump,
  revealAfterCashOut,
  RTP_BP,
  settleAbandoned,
  startRound,
  topRungForBet,
  type Balloon,
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
/** Every case plays this many random rounds. */
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

/** The seeds one round is played with. */
interface Seeds {
  readonly serverSeed: string;
  readonly clientSeed: string;
  readonly nonce: number;
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

/** One move: pump a balloon (with a Patch or not), cash it out, or walk away from the round. */
type Move =
  | { readonly kind: 'pump'; readonly balloonIndex: number; readonly patch: boolean }
  | { readonly kind: 'cash out'; readonly balloonIndex: number }
  | { readonly kind: 'walk away' };

/** Someone playing a round: the bets they place, then one move at a time. */
interface Player {
  readonly bets: readonly number[];
  /** The next move, while some balloon is still in play. */
  move(round: Round): Move;
}

/**
 * A player with seeded choices. Each balloon is either cautious (cashes out
 * at random, rarely patches) or a climber (patches most pumps, so it often
 * reaches its top rung; it cashes out only on the rung below the top, half
 * the time, so some reveals reach the top). With chance 1 in 6 the round is
 * walked away from after a few steps and settled as abandoned.
 */
function randomPlayer(config: GameConfig, pick: (n: number) => number): Player {
  const balloonCount = 1 + pick(config.limits.maxBalloons);
  const bets = Array.from({ length: balloonCount }, () =>
    pick(2) === 0
      ? (SPECIAL_BETS[pick(SPECIAL_BETS.length)] ?? minBetCents)
      : minBetCents + pick(maxBetCents - minBetCents + 1),
  );
  const climber = bets.map(() => pick(4) === 0);
  const abandonAfter = pick(6) === 0 ? pick(5) : Number.POSITIVE_INFINITY;
  let steps = 0;

  return {
    bets,
    move(round) {
      if (steps === abandonAfter) return { kind: 'walk away' };
      steps += 1;

      const active = round.balloons.flatMap((b, i) => (b.status === 'active' ? [i] : []));
      const balloonIndex = active[pick(active.length)] ?? 0;
      const balloon = round.balloons[balloonIndex];
      if (balloon === undefined) throw new Error('no such balloon');
      const isClimber = climber[balloonIndex] === true;
      const choice = pick(20);

      const climberStops = isClimber && balloon.rung === balloon.topRung - 1 && choice < 10;
      if (balloon.rung >= 1 && ((!isClimber && choice < 5) || climberStops)) {
        return { kind: 'cash out', balloonIndex };
      }
      const patch = balloon.rung >= 1 && (isClimber ? choice < 15 : choice < 9);
      return { kind: 'pump', balloonIndex, patch };
    },
  };
}

/** Plays one round as `player` says, and records it the way a server would. */
function playRound(
  config: GameConfig,
  difficultyId: string,
  seeds: Seeds,
  player: Player,
  seen: Seen,
): Played {
  const { bets } = player;
  for (const bet of bets) note(seen, `bet ${String(bet)}`);
  const actions: BalloonAction[][] = bets.map(() => []);
  const draws: DrawRecord[][] = bets.map(() => []);
  const patched: boolean[][] = bets.map(() => []);
  const beforeCashOut: (Round | undefined)[] = bets.map(() => undefined);

  let round = startRound(config, difficultyId, bets, RICH).round;

  while (!isRoundOver(round)) {
    const move = player.move(round);
    if (move.kind === 'walk away') {
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

    const { balloonIndex } = move;
    const balloon = round.balloons[balloonIndex];
    if (balloon === undefined) throw new Error('no such balloon');

    if (move.kind === 'cash out') {
      beforeCashOut[balloonIndex] = round;
      round = cashOut(round, { balloonIndex, expectedDrawIndex: balloon.drawIndex }).round;
      actions[balloonIndex]?.push({ kind: 'cashOut' });
      note(seen, 'cash out');
      continue;
    }

    const { patch } = move;
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
function pumpedOn(round: Round, balloonIndex: number, seeds: Seeds): CashOutReveal {
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

/**
 * The verify page's check of one played round: it finds nothing wrong, and
 * the balloons, draws and reveals it works out from the seeds are exactly
 * the live ones.
 */
function expectVerifies({ record, live, patched, beforeCashOut }: Played, seeds: Seeds): void {
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
 * The paths a balloon whose top rung is `top` can take at all. With a top of
 * 1 the first pump goes to the top, so no pump survives below it; a Patch is
 * sold from pump 2 on, so there is none; and no balloon is ever in play on a
 * rung, so there is no cash-out below the top, by hand or by the 24-hour
 * rule, and no reveal.
 */
function pathsOf(top: number): readonly string[] {
  if (top >= 2) return EVERY_PATH;
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

/**
 * A plan for a found round: one balloon, its bet, and what to do next from
 * where the balloon is. A Patch is never asked for before pump 1.
 */
interface Plan {
  readonly bet: number;
  readonly next: (balloon: Balloon) => 'pump' | 'patch' | 'cash out' | 'walk away';
}

function planPlayer(plan: Plan): Player {
  return {
    bets: [plan.bet],
    move(round) {
      const balloon = round.balloons[0];
      if (balloon === undefined) throw new Error('no balloon');
      const next = plan.next(balloon);
      if (next === 'walk away') return { kind: 'walk away' };
      if (next === 'cash out') return { kind: 'cash out', balloonIndex: 0 };
      return { kind: 'pump', balloonIndex: 0, patch: next === 'patch' };
    },
  };
}

/** Pump 1 plain, then a Patch on every pump: once pump 1 survives, it always gets to the top. */
const climbing = (balloon: Balloon): 'pump' | 'patch' => (balloon.rung >= 1 ? 'patch' : 'pump');

/**
 * How a found round takes one path: the plan, its chance of taking the path
 * on one try, and about how many draws a try takes, at most, on average.
 */
interface Way {
  readonly plan: Plan;
  readonly chance: number;
  readonly draws: number;
}

/**
 * The plan that takes `path`, its chance per try and its draws per try,
 * worked out from the ladder. With s_1 = R / m_1 the chance pump 1
 * survives, s_k = m_(k-1) / m_k for later pumps, and T the top rung:
 *
 *   cash out on rung 1                      s_1
 *   ... and the reveal then pops            s_1 * (1 - m_1 / m_T)
 *   climb with Patches, stop after a save   s_1 * (1 - m_1 / m_T)
 *   climb with Patches to the top           s_1
 *   ... stop one below, the reveal tops     s_1 * s_T
 *   pump with no Patch until it pops        1 - R / m_T
 *
 * A climb with Patches takes about 1 / s_k draws for each pump k. Plain
 * pumps, a climb that stops at the first save, and a reveal take at most T
 * draws each. These numbers only say how long to look, so floats are fine.
 */
function wayTo(path: string, rtpBp: number, ladder: readonly number[], top: number): Way {
  const at = (rung: number): number => ladder[rung - 1] ?? Number.NaN;
  const first = rtpBp / (100 * at(1));
  const reachTop = at(1) / at(top);
  /** Draws for a climb with Patches from rung 1 to rung `to`. */
  const climb = (to: number): number => {
    let draws = 0;
    for (let k = 2; k <= to; k += 1) draws += at(k) / at(k - 1);
    return draws;
  };
  /** Pump 1, then, if it survives, `after` more draws. */
  const draws = (after: number): number => 1 + first * after;
  const plan = (next: Plan['next']): Plan => ({ bet: minBetCents, next });
  const cashAtOne = plan((b) => (b.rung >= 1 ? 'cash out' : 'pump'));
  const afterSave = plan((b) => (b.drawIndex > b.rung ? 'cash out' : climbing(b)));

  if (path.startsWith('bet ')) {
    return { plan: { bet: Number(path.slice(4)), next: () => 'walk away' }, chance: 1, draws: 1 };
  }
  switch (path) {
    case 'abandoned refunded':
      return { plan: plan(() => 'walk away'), chance: 1, draws: 1 };
    case 'popped':
      return { plan: plan(() => 'pump'), chance: 1 - rtpBp / (100 * at(top)), draws: top };
    case 'survived':
    case 'cash out':
      return { plan: cashAtOne, chance: first, draws: draws(top) };
    case 'reveal popped':
      return { plan: cashAtOne, chance: first * (1 - reachTop), draws: draws(top) };
    case 'abandoned cashed':
      return {
        plan: plan((b) => (b.rung >= 1 ? 'walk away' : 'pump')),
        chance: first,
        draws: draws(top),
      };
    case 'saved':
    case 'reveal after a Patch save':
      return { plan: afterSave, chance: first * (1 - reachTop), draws: draws(2 * top) };
    case 'top':
      return { plan: plan(climbing), chance: first, draws: draws(climb(top)) };
    case 'reveal top':
      return {
        plan: plan((b) => (b.rung >= 1 && b.rung === b.topRung - 1 ? 'cash out' : climbing(b))),
        chance: first * (at(top - 1) / at(top)),
        draws: draws(climb(top - 1) + 1),
      };
    default:
      throw new Error(`no way to ${path}`);
  }
}

/**
 * A path is looked for only if that takes at most this many draws on
 * average. On a ladder where it would take more (say a top pump that
 * survives once in a million: only a balloon given about a million Patches
 * gets there), it is left out. The fixed ladder takes every path, so the
 * check of each path never goes away.
 */
const MOST_DRAWS = 100_000;

/** The paths found rounds look for on a ladder, and the ones left out as too slow to find. */
function pathsToFind(
  rtpBp: number,
  ladder: readonly number[],
): { readonly find: readonly string[]; readonly tooSlow: readonly string[] } {
  const top = topRungForBet(ladder, minBetCents, GAME_CONFIG.limits.maxPayoutCents);
  const find: string[] = [];
  const tooSlow: string[] = [];
  for (const path of pathsOf(top)) {
    const { chance, draws } = wayTo(path, rtpBp, ladder, top);
    (draws / chance <= MOST_DRAWS ? find : tooSlow).push(path);
  }
  return { find, tooSlow };
}

/**
 * A round that takes `path`: the plan for it, played with client seeds
 * tried in turn until the real draws take that path. It gives up after 40
 * times the tries it needs on average, which a working engine misses with
 * a chance of about e^-40.
 */
function findRound(
  config: GameConfig,
  name: string,
  id: string,
  path: string,
): { readonly played: Played; readonly seeds: Seeds; readonly seen: Seen } | null {
  const ladder = config.difficulties.find((d) => d.id === id)?.ladder ?? [];
  const top = topRungForBet(ladder, minBetCents, config.limits.maxPayoutCents);
  const { plan, chance } = wayTo(path, config.rtpBp, ladder, top);
  const serverSeed = serverSeedFor(`engine.test found ${String(config.rtpBp)} ${name} ${path}`);
  const tries = Math.ceil(40 / chance);
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const seeds = { serverSeed, clientSeed: `found-${String(attempt)}`, nonce: 0 };
    const seen: Seen = new Map();
    const played = playRound(config, id, seeds, planPlayer(plan), seen);
    if ((seen.get(path) ?? 0) > 0) return { played, seeds, seen };
  }
  return null;
}

/** One case: an RTP, a name for the ladder, the config it is in, and its difficulty id. */
type Case = readonly [rtpBp: number, name: string, config: GameConfig, id: string];

const FIXED = 'the fixed medium ladder';

const CASES: readonly Case[] = RTPS.flatMap((rtpBp) => [
  // Every configured difficulty...
  ...GAME_CONFIG.difficulties.map(
    (difficulty): Case => [rtpBp, difficulty.id, { ...GAME_CONFIG, rtpBp }, difficulty.id],
  ),
  // ...and a fixed ladder that takes every path, so the check of every
  // path never goes away, whatever the config holds.
  [rtpBp, FIXED, fixedConfig(rtpBp), 'medium'] as const,
]);

function ladderIn(config: GameConfig, id: string): readonly number[] {
  const ladder = config.difficulties.find((d) => d.id === id)?.ladder;
  if (ladder === undefined) throw new Error(`no difficulty ${id}`);
  return ladder;
}

describe('verifyRound on rounds played by the live engine with real seeds', () => {
  it.each(CASES)('at RTP %i on %s, every round verifies and recomputes exactly', (rtpBp, name, config, id) => {
    const pick = generator(rtpBp * 31 + name.length * 7919 + (name.codePointAt(0) ?? 0));
    const seen: Seen = new Map();

    // One player: the server seed rotates every 25 rounds (nonce back to 0),
    // and the client seed is edited now and then (nonce carries on).
    let serverSeed = '';
    let nonce = 0;
    let clientSeed = clientSeedFrom(pick);
    for (let r = 0; r < ROUNDS_PER_CASE; r += 1) {
      if (r % 25 === 0) {
        serverSeed = serverSeedFor(`engine.test ${String(rtpBp)} ${name} ${String(r)}`);
        nonce = 0;
      }
      if (pick(8) === 0) clientSeed = clientSeedFrom(pick);

      const seeds = { serverSeed, clientSeed, nonce };
      const played = playRound(config, id, seeds, randomPlayer(config, pick), seen);
      nonce += 1;
      expectVerifies(played, seeds);
    }

    // On the fixed ladder, random play alone takes every path: each kind of
    // pump outcome, both kinds of settlement, player cash-outs, and every
    // special bet. So the random player stays a good one. On other ladders
    // the found rounds below make sure of every path.
    if (name === FIXED) {
      for (const path of EVERY_PATH) expect(seen.get(path) ?? 0, path).toBeGreaterThan(0);
    }
  }, 60_000);

  it.each(CASES)('at RTP %i on %s, a round is found for each path, takes it and verifies', (rtpBp, name, config, id) => {
    const ladder = ladderIn(config, id);
    const { find, tooSlow } = pathsToFind(rtpBp, ladder);
    // The fixed ladder can take every path, and none is too slow to find.
    if (name === FIXED) {
      expect(find).toEqual(EVERY_PATH);
      expect(tooSlow).toEqual([]);
    }
    for (const path of find) {
      const found = findRound(config, name, id, path);
      expect(found, `no round found that takes "${path}"`).not.toBeNull();
      if (found === null) continue;
      expectVerifies(found.played, found.seeds);
    }
  }, 60_000);
});

describe('the found rounds', () => {
  const { limits } = GAME_CONFIG;
  /** A steep made ladder: random play seldom gets far on it. */
  const steep = [5000, 300_000, 20_000_000];
  /** A made ladder whose top pump survives about once in 670,000. */
  const rareTop = [150, 100_000_000];

  it('are made on ladders the game would start with', () => {
    for (const rtpBp of RTPS) {
      expect(ladderProblems(rtpBp, steep, limits)).toEqual([]);
      expect(ladderProblems(rtpBp, rareTop, limits)).toEqual([]);
    }
  });

  it('look for every path on a steep ladder, and find each', () => {
    const config: GameConfig = {
      rtpBp: 9400,
      limits,
      difficulties: [{ id: 'steep', label: 'Steep', ladder: steep }],
    };
    expect(pathsToFind(9400, steep)).toEqual({ find: EVERY_PATH, tooSlow: [] });
    for (const path of EVERY_PATH) {
      const found = findRound(config, 'steep', 'steep', path);
      expect(found, path).not.toBeNull();
      if (found !== null) expectVerifies(found.played, found.seeds);
    }
  }, 60_000);

  it('leave out only the paths that need the top pump to survive, when it seldom does', () => {
    expect(pathsToFind(9700, rareTop).tooSlow).toEqual(['top', 'reveal top']);
  });

  it('on a one-rung ladder, look for no path that needs a rung below the top', () => {
    expect(pathsToFind(9700, [300]).find).toEqual([
      'popped',
      'top',
      'abandoned refunded',
      ...SPECIAL_BETS.map((bet) => `bet ${String(bet)}`),
    ]);
  });
});
