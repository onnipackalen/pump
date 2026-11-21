import { DIFFICULTIES, GAME_CONFIG, surviveChance } from '@pump/engine';
import { drawRoll, verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import type {
  VerifiableAfterRound,
  VerifiableBalloon,
  VerifiableRound,
} from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';

const key = (): string => crypto.randomUUID();

const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

/** Plays rounds in the demo every which way: Patches, pops, cash-outs, every difficulty. */
async function playRounds(client: DemoClient, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const difficultyId = DIFFICULTIES[n % DIFFICULTIES.length]?.id ?? 'easy';
    let { round } = await client.startRound({ difficultyId, betsCents: [100, 250, 1000] }, key());
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

async function demoWithRounds(
  count: number,
  rtpBp = GAME_CONFIG.rtpBp,
): Promise<{ client: DemoClient; ids: string[] }> {
  const client = new DemoClient({ ...GAME_CONFIG, rtpBp }, 0);
  await client.setClientSeed('verify-test', key());
  const ids = await playRounds(client, count);
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

describe('rounds played in the demo, checked by the engine', () => {
  it('cannot be fetched for checking while their seed is still in use', async () => {
    const { client, ids } = await demoWithRounds(1);
    await expect(client.getVerifiableRound(ids[0] ?? '')).rejects.toMatchObject({
      code: 'seed_not_revealed',
    });
  });

  it.each(RTPS)('all check out once the seed is rotated, at RTP %i', async (rtpBp) => {
    const { client, ids } = await demoWithRounds(40, rtpBp);
    await client.rotateSeed(key());
    let patchedSaves = 0;
    let reveals = 0;
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
        const stored = record.balloons[i]?.afterRound ?? null;
        expect(check.afterRound === null).toBe(stored === null);
        if (check.afterRound === null || stored === null) return;
        reveals += 1;
        expect(check.afterRound.outcome).toBe(stored.outcome);
        expect(check.afterRound.reachedRung).toBe(stored.reachedRung);
        expect(
          check.afterRound.draws.map(({ drawIndex, den, num, roll }) => ({ drawIndex, den, num, roll })),
        ).toEqual(stored.draws);
        expect(check.afterRound.draws.every((d) => !d.patched)).toBe(true);
        expectRecipe(record, i);
      });
    }
    // The rounds really did exercise the Patch-save path and reveals.
    expect(patchedSaves).toBeGreaterThan(0);
    expect(reveals).toBeGreaterThan(0);
  });

  it('starts a reveal at the draw count, not the rung, after a Patch save', async () => {
    // At every RTP together, so a save followed by a cash-out below the top
    // turns up for sure.
    let savedThenRevealed = 0;
    for (const rtpBp of RTPS) {
      const { client, ids } = await demoWithRounds(40, rtpBp);
      await client.rotateSeed(key());
      for (const id of ids) {
        const record = await client.getVerifiableRound(id);
        record.balloons.forEach((b, i) => {
          if (b.afterRound === null || b.drawIndex === b.rung) return;
          savedThenRevealed += 1;
          expect(b.afterRound.draws[0]?.drawIndex).toBe(b.drawIndex);
          expectRecipe(record, i);
        });
      }
    }
    expect(savedThenRevealed).toBeGreaterThan(0);
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
  /** A checked-out record with a balloon that `pick` likes, and that balloon's index. */
  async function aRecordWith(
    pick: (b: VerifiableBalloon) => boolean,
  ): Promise<{ record: VerifiableRound; index: number }> {
    const { client, ids } = await demoWithRounds(30);
    await client.rotateSeed(key());
    for (const id of ids) {
      const record = await client.getVerifiableRound(id);
      const index = record.balloons.findIndex(pick);
      if (index >= 0) {
        expect(verifyRound(record).ok).toBe(true);
        return { record, index };
      }
    }
    throw new Error('No such balloon in 30 rounds');
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
