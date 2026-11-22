import {
  configProblems,
  GAME_CONFIG,
  popChance,
  surviveChance,
  topRungForBet,
  type Difficulty,
} from '@pump/engine';
import { drawRoll, verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import type {
  BalloonView,
  VerifiableAfterRound,
  VerifiableBalloon,
  VerifiableRound,
} from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { BASE, configWith, difficultyWhere, MADE_CAPPED } from './fixtures';

const key = (): string => crypto.randomUUID();

const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

/** The bets of every round played here, one per balloon. */
const BETS = [100, 250, 1000];

// Every configured difficulty. BASE is added only when it is a made ladder
// (no configured one has 10 rungs), so there is always one to play. As
// shipped this is just the config.
const PLAYED = configWith(BASE).difficulties;

/** Plays rounds in the demo every which way: Patches, pops, cash-outs, every difficulty. */
async function playRounds(
  client: DemoClient,
  difficulties: readonly Difficulty[],
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const difficultyId = difficulties[n % difficulties.length]?.id ?? BASE.id;
    let { round } = await client.startRound({ difficultyId, betsCents: BETS }, key());
    ids.push(round.id);
    for (let step = 0; step < 80 && round.status === 'active'; step += 1) {
      const b = round.balloons.find((x) => x.status === 'active');
      if (!b) break;
      if (b.rung >= 1 + ((n + b.index) % 4)) {
        ({ round } = await client.cashOut(
          round.id,
          { balloonIndex: b.index, expectedDrawIndex: b.drawIndex },
          key(),
        ));
      } else {
        const patch = b.rung >= 1 && (step + n) % 3 === 0;
        ({ round } = await client.pump(
          round.id,
          { balloonIndex: b.index, expectedDrawIndex: b.drawIndex, patch },
          key(),
        ));
      }
    }
  }
  return ids;
}

/*
 * "Sure" rounds. The mixed play above often gives a Patch save and a reveal,
 * but not for sure: a one-rung or steep ladder gives few or none, and with
 * more difficulties the others get fewer rounds. So the checks that need
 * those paths also play sure rounds, on one ladder, with every balloon
 * played the same way: pump 1, then pump 2 with a Patch, then cash out if it
 * is still going. Per balloon that gives
 *
 *   a pop at pump 1                     with chance  p_1 = 1 - R / m_1
 *   a Patch save at pump 2, then a      with chance  (R / m_1) * p_2
 *   cash-out at rung 1 below the top,
 *   so a reveal from draw 2, not rung 1
 *
 * This needs every bet to reach rung 2 under the payout cap: then the Patch
 * is on sale and rung 1 is below the top.
 */

/**
 * For one balloon of a sure round on `ladder`: the smaller of the two
 * chances above, or 0 if the ladder cannot be used.
 */
function sureChance(rtpBp: number, ladder: readonly number[]): number {
  const { maxPayoutCents } = GAME_CONFIG.limits;
  if (BETS.some((bet) => topRungForBet(ladder, bet, maxPayoutCents) < 2)) return 0;
  const pop1 = popChance(rtpBp, ladder, 1);
  const survive1 = surviveChance(rtpBp, ladder, 1);
  const pop2 = popChance(rtpBp, ladder, 2);
  return Math.min(pop1.num / pop1.den, (survive1.num / survive1.den) * (pop2.num / pop2.den));
}

/** Sure rounds are played on a ladder whose sureChance is at least this. */
const SURE_FLOOR = 0.2;

/** The chance that a check below misses a path it needs is under this. */
const MISS_CHANCE = 1e-9;

/** The ladder for sure rounds: the first of `difficulties` good enough, or the made capped one. */
function sureDifficulty(rtpBp: number, difficulties: readonly Difficulty[]): Difficulty {
  return difficultyWhere((d) => sureChance(rtpBp, d.ladder) >= SURE_FLOOR, MADE_CAPPED, difficulties);
}

/**
 * How many sure rounds make missing a path less likely than MISS_CHANCE.
 * With c = sureChance, one balloon misses a path with chance at most 1 - c,
 * so b balloons all miss it with chance at most (1 - c)^b. There are two
 * paths, so each may have half of MISS_CHANCE.
 */
function sureRoundCount(chance: number): number {
  const balloons = Math.log(MISS_CHANCE / 2) / Math.log(1 - chance);
  return Math.ceil(balloons / BETS.length);
}

/** Plays `count` sure rounds (see above) on `difficultyId`. */
async function playSureRounds(
  client: DemoClient,
  difficultyId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    let { round } = await client.startRound({ difficultyId, betsCents: BETS }, key());
    ids.push(round.id);
    for (const { index } of round.balloons) {
      const current = (): BalloonView | undefined => round.balloons.find((x) => x.index === index);
      // Pump 1 plain, then pump 2 with a Patch, while the balloon is still going.
      for (const patch of [false, true]) {
        const b = current();
        if (b?.status !== 'active') break;
        ({ round } = await client.pump(
          round.id,
          { balloonIndex: index, expectedDrawIndex: b.drawIndex, patch },
          key(),
        ));
      }
      const b = current();
      if (b?.status === 'active') {
        ({ round } = await client.cashOut(
          round.id,
          { balloonIndex: index, expectedDrawIndex: b.drawIndex },
          key(),
        ));
      }
    }
  }
  return ids;
}

interface DemoOptions {
  readonly rtpBp?: number;
  /** The difficulties the mixed rounds take turns on. All of PLAYED unless told otherwise. */
  readonly difficulties?: readonly Difficulty[];
  /** Also play the sure rounds, after the mixed ones. */
  readonly sure?: boolean;
}

/** A demo client that has played `count` mixed rounds, and the sure rounds if asked. */
async function demoWithRounds(
  count: number,
  options: DemoOptions = {},
): Promise<{ client: DemoClient; ids: string[] }> {
  const { rtpBp = GAME_CONFIG.rtpBp, difficulties = PLAYED, sure = false } = options;
  const sureOne = sure ? sureDifficulty(rtpBp, difficulties) : null;
  const mixed = { ...GAME_CONFIG, rtpBp, difficulties };
  const config = sureOne === null ? mixed : configWith(sureOne, mixed);
  // The demo plays only on a config the game would start with.
  expect(configProblems(config)).toEqual([]);
  const client = new DemoClient(config, 0);
  await client.setClientSeed('verify-test', key());
  const ids = await playRounds(client, difficulties, count);
  if (sureOne !== null) {
    const sureCount = sureRoundCount(sureChance(rtpBp, sureOne.ladder));
    ids.push(...(await playSureRounds(client, sureOne.id, sureCount)));
  }
  return { client, ids };
}

/**
 * Checks one stored reveal against the spec's recipe, by hand: plain pumps
 * from the cash-out rung up, on this balloon's draws from its draw count up,
 * each chance from the round's own RTP and ladder, stopping at the first pop
 * or at the top rung.
 */
function expectRecipe(record: VerifiableRound, balloonIndex: number): void {
  const b = record.balloons[balloonIndex];
  const after = b?.afterRound ?? null;
  if (!b || after === null) throw new Error('a balloon with a reveal expected');
  after.draws.forEach((draw, i) => {
    const rung = b.rung + 1 + i;
    const chance = surviveChance(record.rtpBp, record.ladder, rung);
    expect(draw.drawIndex).toBe(b.drawIndex + i);
    expect({ num: draw.num, den: draw.den }).toEqual({ num: chance.num, den: chance.den });
    const { serverSeed, clientSeed, nonce } = record;
    const inputs = { serverSeed, clientSeed, nonce, balloonIndex, drawIndex: draw.drawIndex };
    expect(draw.roll).toBe(drawRoll(inputs, draw.den).roll);
    // Every draw but the last survives; the last pops, or reaches the top.
    const last = i === after.draws.length - 1;
    expect(draw.roll < draw.num).toBe(!last || after.outcome === 'top');
  });
  const end = b.rung + after.draws.length;
  expect(after.reachedRung).toBe(after.outcome === 'top' ? end : end - 1);
  if (after.outcome === 'top') expect(after.reachedRung).toBe(b.topRung);
}

/** How often the paths the checks need turned up. */
interface PathsSeen {
  /** Draws where a Patch saved the balloon: the pump would have popped it. */
  readonly patchedSaves: number;
  /** Balloons with a reveal. */
  readonly reveals: number;
  /** Balloons with a reveal after a Patch save, so their draw count is not their rung. */
  readonly savedThenRevealed: number;
}

/** Rotates the seed, then checks every round in `ids` with the engine and by hand. */
async function checkRounds(
  client: DemoClient,
  ids: readonly string[],
  rtpBp: number,
): Promise<PathsSeen> {
  await client.rotateSeed(key());
  let patchedSaves = 0;
  let reveals = 0;
  let savedThenRevealed = 0;
  for (const id of ids) {
    const record = await client.getVerifiableRound(id);
    expect(record.rtpBp).toBe(rtpBp);
    const result = verifyRound(record);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    patchedSaves += result.balloons
      .flatMap((b) => b.draws)
      .filter((d) => d.patched && !d.survived).length;
    // verifyRound worked out every reveal again, and it is the stored one.
    result.balloons.forEach((check, i) => {
      const b = record.balloons[i];
      const stored = b?.afterRound ?? null;
      expect(check.afterRound === null).toBe(stored === null);
      if (!b || check.afterRound === null || stored === null) return;
      reveals += 1;
      expect(check.afterRound.outcome).toBe(stored.outcome);
      expect(check.afterRound.reachedRung).toBe(stored.reachedRung);
      expect(
        check.afterRound.draws.map(({ drawIndex, den, num, roll }) => ({ drawIndex, den, num, roll })),
      ).toEqual(stored.draws);
      expect(check.afterRound.draws.every((d) => !d.patched)).toBe(true);
      expectRecipe(record, i);
      if (b.drawIndex !== b.rung) {
        savedThenRevealed += 1;
        // The reveal starts at the draw count, not the rung.
        expect(stored.draws[0]?.drawIndex).toBe(b.drawIndex);
      }
    });
  }
  return { patchedSaves, reveals, savedThenRevealed };
}

describe('rounds played in the demo, checked by the engine', () => {
  it('cannot be fetched for checking while their seed is still in use', async () => {
    const { client, ids } = await demoWithRounds(1);
    await expect(client.getVerifiableRound(ids[0] ?? '')).rejects.toMatchObject({
      code: 'seed_not_revealed',
    });
  });

  it.each(RTPS)('all check out once the seed is rotated, at RTP %i', async (rtpBp) => {
    const { client, ids } = await demoWithRounds(40, { rtpBp, sure: true });
    const seen = await checkRounds(client, ids, rtpBp);
    // The rounds really did exercise the Patch-save path and reveals.
    expect(seen.patchedSaves).toBeGreaterThan(0);
    expect(seen.reveals).toBeGreaterThan(0);
  });

  it.each(RTPS)(
    'starts a reveal at the draw count, not the rung, after a Patch save, at RTP %i',
    async (rtpBp) => {
      const { client, ids } = await demoWithRounds(40, { rtpBp, sure: true });
      const seen = await checkRounds(client, ids, rtpBp);
      expect(seen.savedThenRevealed).toBeGreaterThan(0);
    },
  );

  it.each(RTPS)(
    'see a Patch save and a reveal even when no configured ladder can give one, at RTP %i',
    async (rtpBp) => {
      // One rung only: there is no pump 2, so no Patch, and every cash-out
      // is at the top, so no reveal. Only the sure rounds give these paths.
      const oneRung = (id: string, top: number): Difficulty => ({ id, label: id, ladder: [top] });
      const difficulties = [oneRung('one-rung-low', 150), oneRung('one-rung-high', 1000)];
      const { client, ids } = await demoWithRounds(40, { rtpBp, difficulties, sure: true });
      const seen = await checkRounds(client, ids, rtpBp);
      expect(seen.patchedSaves).toBeGreaterThan(0);
      expect(seen.reveals).toBeGreaterThan(0);
      expect(seen.savedThenRevealed).toBeGreaterThan(0);
    },
  );
});

describe('the sure rounds', () => {
  it('use only a ladder where every bet reaches rung 2', () => {
    // Good chances, but rung 2 is just over the cap for the largest bet here.
    const { maxPayoutCents } = GAME_CONFIG.limits;
    const largest = Math.max(...BETS);
    const overCap = Math.floor((maxPayoutCents * 100) / largest) + 1;
    const capped: Difficulty = { id: 'capped-at-one', label: 'Capped', ladder: [150, overCap] };
    expect(topRungForBet(capped.ladder, largest, maxPayoutCents)).toBe(1);
    for (const rtpBp of RTPS) {
      expect(configProblems({ ...GAME_CONFIG, rtpBp, difficulties: [capped] })).toEqual([]);
      expect(sureChance(rtpBp, capped.ladder)).toBe(0);
      expect(sureDifficulty(rtpBp, [capped])).toBe(MADE_CAPPED);
      expect(sureChance(rtpBp, MADE_CAPPED.ladder)).toBeGreaterThanOrEqual(SURE_FLOOR);
    }
  });
});

describe('a record that does not add up is caught', () => {
  async function aRecord(): Promise<VerifiableRound> {
    const { client, ids } = await demoWithRounds(3);
    await client.rotateSeed(key());
    return client.getVerifiableRound(ids[2] ?? '');
  }

  it('flags a changed payout', async () => {
    const record = await aRecord();
    const tampered: VerifiableRound = {
      ...record,
      balloons: record.balloons.map((b, i) => (i === 0 ? { ...b, payoutCents: b.payoutCents + 1 } : b)),
    };
    const result = verifyRound(tampered);
    expect(result.ok).toBe(false);
    expect(result.balloons[0]?.ok).toBe(false);
  });

  it('flags a different client seed', async () => {
    const record = await aRecord();
    expect(verifyRound({ ...record, clientSeed: 'someone-else' }).ok).toBe(false);
  });

  it('flags a server seed that is not the one whose hash was shown', async () => {
    const record = await aRecord();
    const result = verifyRound({ ...record, serverSeedHash: '0'.repeat(64) });
    expect(result.seedHashMatches).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe('a reveal that does not add up is caught', () => {
  /**
   * A checked-out record with a balloon that `pick` likes, and that
   * balloon's index. The sure rounds come last, so a pop and a reveal are
   * there for sure, but the mixed rounds are searched first.
   */
  async function aRecordWith(
    pick: (b: VerifiableBalloon) => boolean,
  ): Promise<{ record: VerifiableRound; index: number }> {
    const { client, ids } = await demoWithRounds(30, { sure: true });
    await client.rotateSeed(key());
    for (const id of ids) {
      const record = await client.getVerifiableRound(id);
      const index = record.balloons.findIndex(pick);
      if (index >= 0) {
        expect(verifyRound(record).ok).toBe(true);
        return { record, index };
      }
    }
    throw new Error(`No such balloon in ${String(ids.length)} rounds`);
  }

  /** The record with one balloon's reveal replaced. */
  function withReveal(
    record: VerifiableRound,
    index: number,
    afterRound: VerifiableAfterRound | null,
  ): VerifiableRound {
    return {
      ...record,
      balloons: record.balloons.map((b, i) => (i === index ? { ...b, afterRound } : b)),
    };
  }

  /** verifyRound fails the round, on that balloon, naming it. */
  function expectCaught(tampered: VerifiableRound, index: number): void {
    const result = verifyRound(tampered);
    expect(result.ok).toBe(false);
    expect(result.balloons[index]?.ok).toBe(false);
    expect(result.balloons[index]?.problems.join(' ')).toContain(`Balloon ${index + 1}`);
  }

  const revealed = (b: VerifiableBalloon): boolean => b.afterRound !== null;

  it('flags a changed ending or rung reached', async () => {
    const { record, index } = await aRecordWith(revealed);
    const after = record.balloons[index]?.afterRound;
    if (!after) throw new Error('a reveal expected');
    const flipped = after.outcome === 'top' ? 'popped' : 'top';
    expectCaught(withReveal(record, index, { ...after, outcome: flipped }), index);
    expectCaught(withReveal(record, index, { ...after, reachedRung: after.reachedRung + 1 }), index);
  });

  it('flags a changed, missing or extra reveal draw', async () => {
    const { record, index } = await aRecordWith(revealed);
    const after = record.balloons[index]?.afterRound;
    const first = after?.draws[0];
    if (!after || !first) throw new Error('a reveal draw expected');
    const rerolled = { ...first, roll: (first.roll + 1) % first.den };
    expectCaught(
      withReveal(record, index, { ...after, draws: [rerolled, ...after.draws.slice(1)] }),
      index,
    );
    expectCaught(withReveal(record, index, { ...after, draws: after.draws.slice(0, -1) }), index);
    const extra = { ...first, drawIndex: first.drawIndex + after.draws.length };
    expectCaught(withReveal(record, index, { ...after, draws: [...after.draws, extra] }), index);
  });

  it('flags a reveal left out, including by an old record with no field at all', async () => {
    const { record, index } = await aRecordWith(revealed);
    expectCaught(withReveal(record, index, null), index);
    const old = withReveal(record, index, null);
    const balloon = old.balloons[index];
    if (balloon) Reflect.deleteProperty(balloon, 'afterRound');
    expect(() => verifyRound(old)).not.toThrow();
    expectCaught(old, index);
  });

  it('flags a reveal shown on a balloon that popped', async () => {
    const { record, index } = await aRecordWith((b) => b.status === 'popped');
    const fake: VerifiableAfterRound = { outcome: 'popped', reachedRung: record.balloons[index]?.rung ?? 0, draws: [] };
    expectCaught(withReveal(record, index, fake), index);
  });
});
