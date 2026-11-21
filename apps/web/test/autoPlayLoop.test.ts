import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { BalloonView, RoundView } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import type { AutoPlaySettings } from '../src/game/autoPlay';
import { runAutoPlay, type AutoPlayHooks } from '../src/game/useAutoPlay';
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
  onWin: { kind: 'reset' },
  onLoss: { kind: 'reset' },
  ...overrides,
});

const limits = GAME_CONFIG.limits;

/** The screen's side of a run: no Stop and no hand cash-out unless a test says so. */
const hooks = (overrides: Partial<AutoPlayHooks> = {}): AutoPlayHooks => ({
  shouldStop: () => false,
  report: () => undefined,
  ...overrides,
});

describe('runAutoPlay against the demo game', () => {
  it('plays exactly the chosen number of rounds, and its net matches the wallet', async () => {
    const { client, balance } = await newDemo();
    const { reason, progress } = await runAutoPlay(
      { settings: settings({ rounds: 25 }), difficultyId: 'easy', betsCents: [100, 250], balanceCents: balance, limits },
      actionsFor(client),
      hooks(),
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
          limits,
        },
        actionsFor(client),
        hooks(),
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
        limits,
      },
      alwaysSurvives(),
      hooks(),
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
        limits,
      },
      actionsFor(client),
      hooks(),
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
      { settings: settings({ rounds: 50 }), difficultyId: 'easy', betsCents: [100], balanceCents: balance, limits },
      actionsFor(client),
      hooks({
        shouldStop: () => reports >= 3,
        report: () => {
          reports += 1;
        },
      }),
      NO_PAUSES,
    );
    expect(reason).toBe('player');
    expect(progress.roundsPlayed).toBe(3);
    expect((await client.getHistory(100)).length).toBe(3);
  });

  it('plays every balloon at once: one action per balloon still in play on each beat', async () => {
    const { client, balance } = await newDemo();
    const actions = actionsFor(client);
    const beats = new Map<RoundView, number[]>();
    const record = (r: RoundView, i: number): void => {
      beats.set(r, [...(beats.get(r) ?? []), i]);
    };
    const watching: GameActions = {
      ...actions,
      pump: (r, i, patch) => {
        record(r, i);
        return actions.pump(r, i, patch);
      },
      cashOut: (r, i) => {
        record(r, i);
        return actions.cashOut(r, i);
      },
    };
    const { reason, progress } = await runAutoPlay(
      { settings: settings({ rounds: 5 }), difficultyId: 'easy', betsCents: [100, 100, 100], balanceCents: balance, limits },
      watching,
      hooks(),
      NO_PAUSES,
    );
    expect(reason).toBe('rounds-done');
    // Each beat acts once on every balloon that round still had in play.
    for (const [r, indexes] of beats) {
      const live = r.balloons.filter((b) => b.status === 'active').map((b) => b.index);
      expect(indexes).toEqual(live);
    }
    const after = await client.getSession();
    expect(after.wallet.balanceCents - balance).toBe(progress.netCents);
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
      { settings: settings({ targetPumps: 5 }), difficultyId: 'easy', betsCents: [100], balanceCents: balance, limits },
      failing,
      hooks(),
      NO_PAUSES,
    );
    expect(reason).toBe('error');
  });
});

const MAX_ROUNDS = 1000;

/**
 * A scripted game where every pump survives and every rung pays 2x, so a
 * test can know the result in advance. Like the server, it keeps one
 * current round, applies each request to it in turn, and refuses a request
 * whose draw index is out of date.
 */
function alwaysSurvives(): GameActions {
  let balanceCents = 10_000;
  let current: RoundView | null = null;
  const wallet = () => ({ balanceCents });
  const apply = (sent: RoundView, i: number, change: (b: BalloonView) => Partial<BalloonView>) => {
    const b = current?.balloons[i];
    if (!current || !b || current.id !== sent.id || b.status !== 'active') return null;
    if (b.drawIndex !== sent.balloons[i]?.drawIndex) return null;
    const balloons = current.balloons.map((x) => (x.index === i ? { ...x, ...change(x) } : x));
    const status = balloons.some((x) => x.status === 'active') ? 'active' : 'finished';
    current = { ...current, balloons, status };
    return current;
  };
  return {
    startRound: (_difficulty, betsCents) => {
      balanceCents -= betsCents.reduce((sum, bet) => sum + bet, 0);
      current = round(betsCents.map((betCents) => balloon({ betCents })));
      return Promise.resolve({ round: current, wallet: wallet() });
    },
    pump: (r, i) => {
      const next = apply(r, i, (b) => ({ rung: b.rung + 1, drawIndex: b.drawIndex + 1 }));
      return Promise.resolve(
        next ? { outcome: 'survived' as const, round: next, wallet: wallet() } : null,
      );
    },
    cashOut: (r, i) => {
      const bet = current?.balloons[i]?.betCents ?? 0;
      const next = apply(r, i, (b) => ({ status: 'cashed', payoutCents: b.betCents * 2 }));
      if (next) balanceCents += bet * 2;
      return Promise.resolve(next ? { round: next, wallet: wallet() } : null);
    },
  };
}

describe('DemoClient keeps the server rules under same-moment requests', () => {
  it('never lets two starts at the same moment both charge', async () => {
    const { client, balance } = await newDemo();
    const request = { difficultyId: 'easy', betsCents: [100] };
    const results = await Promise.allSettled([
      client.startRound(request, crypto.randomUUID()),
      client.startRound(request, crypto.randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await client.getSession()).wallet.balanceCents).toBe(balance - 100);
  });

  it('never reveals a seed with the wrong hash when two rotations race', async () => {
    const { client } = await newDemo();
    const results = await Promise.allSettled([
      client.rotateSeed(crypto.randomUUID()),
      client.rotateSeed(crypto.randomUUID()),
    ]);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { serverSeed, serverSeedHash } = result.value.revealed;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverSeed));
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      expect(hex).toBe(serverSeedHash);
    }
  });
});
