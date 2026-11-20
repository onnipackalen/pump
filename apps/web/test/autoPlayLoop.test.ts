import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { BalloonView, RoundView } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import type { AutoPlaySettings } from '../src/game/autoPlay';
import { runAutoPlay } from '../src/game/useAutoPlay';
import type { GameActions } from '../src/game/useGame';
import { balloon, round } from './fixtures';

const NO_PAUSES = { stepMs: 0, roundMs: 0 };

/** The game actions the screen uses, wired straight to a demo client. */
function actionsFor(client: DemoClient): GameActions {
  const call = <T>(action: (key: string) => Promise<T>): Promise<T | null> =>
    action(crypto.randomUUID()).catch(() => null);
  const drawIndex = (r: RoundView, i: number): number => r.balloons[i]?.drawIndex ?? -1;
  return {
    startRound: (difficultyId, betsCents) =>
      call((key) => client.startRound({ difficultyId, betsCents }, key)),
    pump: (r, i, patch) =>
      call((key) =>
        client.pump(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i), patch }, key),
      ),
    cashOut: (r, i) =>
      call((key) => client.cashOut(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i) }, key)),
  };
}

async function newDemo(): Promise<{ client: DemoClient; balance: number }> {
  const client = new DemoClient(GAME_CONFIG, 0);
  await client.setClientSeed('test-seed', crypto.randomUUID());
  const session = await client.getSession();
  return { client, balance: session.wallet.balanceCents };
}

const settings = (overrides: Partial<AutoPlaySettings> = {}): AutoPlaySettings => ({
  rounds: 10,
  targetPumps: 3,
  stopOnProfitCents: null,
  stopOnLossCents: null,
  ...overrides,
});

describe('runAutoPlay against the demo game', () => {
  it('plays exactly the chosen number of rounds, and its net matches the wallet', async () => {
    const { client, balance } = await newDemo();
    const { reason, progress } = await runAutoPlay(
      { settings: settings({ rounds: 25 }), difficultyId: 'easy', betsCents: [100, 250], balanceCents: balance },
      actionsFor(client),
      () => false,
      () => undefined,
      NO_PAUSES,
    );
    expect(reason).toBe('rounds-done');
    expect(progress.roundsPlayed).toBe(25);
    const after = await client.getSession();
    expect(after.wallet.balanceCents - balance).toBe(progress.netCents);
    expect(after.activeRound).toBeNull();
  });

  it('never ends further down than the loss limit', async () => {
    for (let run = 0; run < 30; run += 1) {
      const { client, balance } = await newDemo();
      const { reason, progress } = await runAutoPlay(
        {
          settings: settings({ rounds: MAX_ROUNDS, targetPumps: 4, stopOnLossCents: 750 }),
          difficultyId: 'expert',
          betsCents: [100, 100, 50],
          balanceCents: balance,
        },
        actionsFor(client),
        () => false,
        () => undefined,
        NO_PAUSES,
      );
      expect(progress.netCents).toBeGreaterThanOrEqual(-750);
      expect(['loss', 'rounds-done']).toContain(reason);
      const after = await client.getSession();
      expect(after.wallet.balanceCents - balance).toBe(progress.netCents);
    }
  }, 60_000);

  it('stops at the profit target', async () => {
    const { reason, progress } = await runAutoPlay(
      {
        settings: settings({ rounds: MAX_ROUNDS, targetPumps: 2, stopOnProfitCents: 250 }),
        difficultyId: 'easy',
        betsCents: [100],
        balanceCents: 10_000,
      },
      alwaysSurvives(),
      () => false,
      () => undefined,
      NO_PAUSES,
    );
    // Each round wins $1 (2x on $1), so the $2.50 target is passed after round 3.
    expect(reason).toBe('profit');
    expect(progress).toEqual({ roundsPlayed: 3, netCents: 300 });
  });

  it('stops when the balance runs out', async () => {
    const { client, balance } = await newDemo();
    const { reason, progress } = await runAutoPlay(
      {
        settings: settings({ rounds: MAX_ROUNDS, targetPumps: 10 }),
        difficultyId: 'expert',
        betsCents: [100_000, 100_000, 100_000],
        balanceCents: balance,
      },
      actionsFor(client),
      () => false,
      () => undefined,
      NO_PAUSES,
    );
    const after = await client.getSession();
    // Expert 10 pumps on three $1,000 bets: almost surely broke, or capped wins.
    if (reason === 'balance') {
      expect(after.wallet.balanceCents).toBeLessThan(300_000);
    } else {
      expect(reason).toBe('rounds-done');
    }
    expect(after.wallet.balanceCents - balance).toBe(progress.netCents);
  });

  it('stops when the player asks, without starting another round', async () => {
    const { client, balance } = await newDemo();
    let reports = 0;
    const { reason, progress } = await runAutoPlay(
      { settings: settings({ rounds: 50 }), difficultyId: 'easy', betsCents: [100], balanceCents: balance },
      actionsFor(client),
      () => reports >= 3,
      () => {
        reports += 1;
      },
      NO_PAUSES,
    );
    expect(reason).toBe('player');
    expect(progress.roundsPlayed).toBe(3);
    expect((await client.getHistory(100)).length).toBe(3);
  });

  it('stops on the first failed action', async () => {
    const { client, balance } = await newDemo();
    const actions = actionsFor(client);
    let pumps = 0;
    const failing: GameActions = {
      ...actions,
      pump: (r, i, patch) => (++pumps === 2 ? Promise.resolve(null) : actions.pump(r, i, patch)),
    };
    const { reason } = await runAutoPlay(
      { settings: settings({ targetPumps: 5 }), difficultyId: 'easy', betsCents: [100], balanceCents: balance },
      failing,
      () => false,
      () => undefined,
      NO_PAUSES,
    );
    expect(reason).toBe('error');
  });
});

const MAX_ROUNDS = 1000;

/**
 * A scripted game where every pump survives and every rung pays 2x, so a
 * test can know the result in advance.
 */
function alwaysSurvives(): GameActions {
  let balanceCents = 10_000;
  const wallet = () => ({ balanceCents });
  const withBalloon = (r: RoundView, i: number, change: Partial<BalloonView>): RoundView => {
    const balloons = r.balloons.map((b) => (b.index === i ? { ...b, ...change } : b));
    const status = balloons.some((b) => b.status === 'active') ? 'active' : 'finished';
    return { ...r, balloons, status };
  };
  return {
    startRound: (_difficulty, betsCents) => {
      balanceCents -= betsCents.reduce((sum, bet) => sum + bet, 0);
      const r = round(betsCents.map((betCents) => balloon({ betCents })));
      return Promise.resolve({ round: r, wallet: wallet() });
    },
    pump: (r, i) => {
      const b = r.balloons[i];
      if (!b) return Promise.resolve(null);
      const next = withBalloon(r, i, { rung: b.rung + 1, drawIndex: b.drawIndex + 1 });
      return Promise.resolve({ outcome: 'survived' as const, round: next, wallet: wallet() });
    },
    cashOut: (r, i) => {
      const b = r.balloons[i];
      if (!b) return Promise.resolve(null);
      balanceCents += b.betCents * 2;
      const next = withBalloon(r, i, { status: 'cashed', payoutCents: b.betCents * 2 });
      return Promise.resolve({ round: next, wallet: wallet() });
    },
  };
}
