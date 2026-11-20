import { DIFFICULTIES, GAME_CONFIG } from '@pump/engine';
import { verifyRound } from '@pump/engine/fair';
import { describe, expect, it } from 'vitest';
import type { VerifiableRound } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';

const key = (): string => crypto.randomUUID();

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

async function demoWithRounds(count: number): Promise<{ client: DemoClient; ids: string[] }> {
  const client = new DemoClient(GAME_CONFIG, 0);
  await client.setClientSeed('verify-test', key());
  const ids = await playRounds(client, count);
  return { client, ids };
}

describe('rounds played in the demo, checked by the engine', () => {
  it('cannot be fetched for checking while their seed is still in use', async () => {
    const { client, ids } = await demoWithRounds(1);
    await expect(client.getVerifiableRound(ids[0] ?? '')).rejects.toMatchObject({
      code: 'seed_not_revealed',
    });
  });

  it('all check out once the seed is rotated', async () => {
    const { client, ids } = await demoWithRounds(40);
    await client.rotateSeed(key());
    let patchedSaves = 0;
    for (const id of ids) {
      const record = await client.getVerifiableRound(id);
      const result = verifyRound(record);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      patchedSaves += result.balloons
        .flatMap((b) => b.draws)
        .filter((d) => d.patched && !d.survived).length;
    }
    // The rounds really did exercise the Patch-save path at least once.
    expect(patchedSaves).toBeGreaterThan(0);
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
