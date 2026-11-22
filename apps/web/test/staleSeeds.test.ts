import { GAME_CONFIG } from '@pump/engine';
import { verifyRound } from '@pump/engine/fair';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkFailure } from '../src/api/client';
import type { FairnessView, RotateResult } from '../src/api/contract';
import { formFrom, roundFrom, roundToCheck } from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';
import { SEED_CHANGE_BUSY_TEXT, SEEDS_CHANGED_TEXT } from '../src/game/refusal';
import { runAutoPlay } from '../src/game/useAutoPlay';
import { useGame, type Game } from '../src/game/useGame';
import { recordProblems } from '../src/verify/copyCheck';
import { parseShown } from '../src/verify/shownHashes';
import { mount } from './hookRunner';

// The real useGame, run on a small stand-in for React's hooks.
vi.mock('react', () => import('./hookRunner'));

/*
 * The game screen against seeds that changed behind its back: a second tab
 * of the same player, or a seed change whose answer was lost. The start
 * names the seeds the screen showed, so the server refuses instead of
 * playing a round the verify page would call a mismatch.
 */

/** localStorage as a Map: two tabs of one browser share it. */
const items = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      items.set(k, v);
    },
  },
});

beforeEach(() => {
  items.clear();
});

const DIFFICULTY = GAME_CONFIG.difficulties[0]?.id ?? 'easy';
const key = (): string => crypto.randomUUID();

type Tab = { readonly current: () => Game };

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openTab(client: DemoClient): Promise<Tab> {
  const tab = mount(() => useGame(client));
  await until(() => tab.current().state.phase === 'ready');
  return tab;
}

/** What the tab's Provably fair panel shows. */
function panel(tab: Tab): FairnessView {
  const fairness = tab.current().state.fairness;
  if (!fairness) throw new Error('the panel shows seeds');
  return fairness;
}

/** Plays the round on screen to its end with the tab's own actions: one pump, then cash out. */
async function finish(tab: Tab, roundId: string): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const round = tab.current().state.round;
    if (!round || round.id !== roundId || round.status !== 'active') return;
    const b = round.balloons.find((x) => x.status === 'active');
    if (!b) return;
    if (b.rung >= 1) await tab.current().actions.cashOut(round, b.index);
    else await tab.current().actions.pump(round, b.index, false);
    await until(() => !tab.current().state.pending[b.index]);
  }
}

/** Whether the verify page calls this round checked: the draws add up and nothing differs from the copy. */
async function checksOut(client: DemoClient, roundId: string): Promise<boolean> {
  const record = await client.getVerifiableRound(roundId);
  const { shown, elsewhere } = roundToCheck(roundId, record);
  const built = roundFrom(formFrom(record, shown), record);
  if (!('round' in built)) return false;
  return verifyRound(built.round).ok && recordProblems(roundId, shown, record, elsewhere).length === 0;
}

describe('a tab left out of date by another tab', () => {
  it('is refused, shows the seeds now, and its next Bet starts and checks out', async () => {
    const server = new DemoClient(GAME_CONFIG, 5);
    const tabA = await openTab(server);
    const tabB = await openTab(server);
    expect(panel(tabB)).toEqual(panel(tabA));

    // Tab A plays a round to its end.
    const a = await tabA.current().actions.startRound(DIFFICULTY, [100]);
    if (!a) throw new Error('tab A’s round started');
    await finish(tabA, a.round.id);

    // Tab B still shows the nonce that round used, and the player presses Bet there.
    const stale = panel(tabB);
    expect(stale.nextNonce).toBe(a.round.nonce);
    expect(await tabB.current().actions.startRound(DIFFICULTY, [100])).toBeNull();
    expect(tabB.current().state.notice).toEqual({ tone: 'error', text: SEEDS_CHANGED_TEXT });
    expect((await server.getSession()).activeRound).toBeNull();
    // The panel shows the seeds the refusal carried at once.
    await until(() => panel(tabB).nextNonce === stale.nextNonce + 1);
    expect(panel(tabB)).toEqual((await server.getSession()).fairness);

    const b = await tabB.current().actions.startRound(DIFFICULTY, [100]);
    if (!b) throw new Error('tab B’s second Bet started');
    expect(b.round.nonce).toBe(stale.nextNonce + 1);
    await finish(tabB, b.round.id);

    await server.rotateSeed(key());
    expect(await checksOut(server, a.round.id)).toBe(true);
    expect(await checksOut(server, b.round.id)).toBe(true);
    // Nothing was saved for the refused start: round A's copy has its hash and nonce.
    expect(parseShown(items.get('pump.shownSeeds') ?? null).map(([id]) => id).sort()).toEqual(
      [a.round.id, b.round.id].sort(),
    );
  }, 30_000);

  it('auto-play there stops at the refused start, and starts no round', async () => {
    const server = new DemoClient(GAME_CONFIG, 5);
    const tabA = await openTab(server);
    const tabB = await openTab(server);
    const a = await tabA.current().actions.startRound(DIFFICULTY, [100]);
    if (!a) throw new Error('tab A’s round started');
    await finish(tabA, a.round.id);

    const started: string[] = [];
    const { reason } = await runAutoPlay(
      {
        settings: {
          rounds: 5,
          targetPumps: 1,
          stopOnProfitCents: null,
          stopOnLossCents: null,
          onWin: { kind: 'reset' },
          onLoss: { kind: 'reset' },
        },
        difficultyId: DIFFICULTY,
        betsCents: [100],
        balanceCents: (await server.getSession()).wallet.balanceCents,
        limits: GAME_CONFIG.limits,
      },
      tabB.current().actions,
      {
        shouldStop: () => false,
        report: () => undefined,
        roundStarted: (id) => started.push(id),
        handCashOuts: () => new Set(),
      },
      { stepMs: 0, roundMs: 0 },
    );
    expect(reason).toBe('error');
    expect(started).toEqual([]);
    expect(tabB.current().state.notice?.text).toBe(SEEDS_CHANGED_TEXT);
  }, 30_000);
});

/** An honest server on a flaky line: it applies a seed change, then both answers are lost. */
class LosesSeedAnswer extends DemoClient {
  lose = false;
  override async setClientSeed(clientSeed: string, k: string): Promise<FairnessView> {
    const answer = await super.setClientSeed(clientSeed, k);
    if (this.lose) throw new NetworkFailure('The game server did not answer properly (502).');
    return answer;
  }
  override async rotateSeed(k: string): Promise<RotateResult> {
    const answer = await super.rotateSeed(k);
    if (this.lose) throw new NetworkFailure('The game server did not answer properly (502).');
    return answer;
  }
}

describe('a seed change whose answer was lost, then Bet at once', () => {
  for (const change of ['save', 'rotate'] as const) {
    it(`${change}: the round is never played on seeds the screen did not show`, async () => {
      const server = new LosesSeedAnswer(GAME_CONFIG, 40);
      const tab = await openTab(server);
      server.lose = true;
      if (change === 'save') {
        expect(await tab.current().setClientSeed('my-new-seed')).toBe(false);
      } else {
        tab.current().rotateSeed();
        await until(() => tab.current().state.notice?.tone === 'error');
      }
      server.lose = false;

      // Bet at once, while the resync started by the failure is on its way.
      let result = await tab.current().actions.startRound(DIFFICULTY, [100]);
      if (result === null) {
        // Refused: the seeds on screen were the old ones.
        expect(tab.current().state.notice?.text).toBe(SEEDS_CHANGED_TEXT);
        result = await tab.current().actions.startRound(DIFFICULTY, [100]);
      }
      if (!result) throw new Error('the second Bet started');
      const now = await server.getSession();
      expect(result.round.serverSeedHash).toBe(now.fairness.serverSeedHash);
      if (change === 'save') expect(result.round.clientSeed).toBe('my-new-seed');
      await finish(tab, result.round.id);
      await server.rotateSeed(key());
      expect(await checksOut(server, result.round.id)).toBe(true);
    }, 30_000);
  }
});

describe('a seed change pressed while another is on its way', () => {
  it('is not sent, says so, and Save and Rotate wait while a change is on its way', async () => {
    const server = new DemoClient(GAME_CONFIG, 60);
    const tab = await openTab(server);
    const before = panel(tab);
    tab.current().rotateSeed();
    await until(() => tab.current().state.seedChanging);

    expect(await tab.current().setClientSeed('my-own-seed')).toBe(false);
    await until(() => tab.current().state.notice?.text === SEED_CHANGE_BUSY_TEXT);
    // Pressing Rotate again is not sent either.
    tab.current().rotateSeed();

    await until(() => !tab.current().state.seedChanging);
    const after = await server.getSession();
    expect(after.fairness.clientSeed).toBe(before.clientSeed);
    expect(after.fairness.serverSeedHash).not.toBe(before.serverSeedHash);
    expect(tab.current().state.revealed).toHaveLength(1);
    // Once it is done, a save goes again.
    expect(await tab.current().setClientSeed('my-own-seed')).toBe(true);
    expect((await server.getSession()).fairness.clientSeed).toBe('my-own-seed');
  }, 30_000);
});
