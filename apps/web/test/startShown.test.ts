import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { NetworkFailure } from '../src/api/client';
import type {
  ActionResult,
  FairnessView,
  RoundView,
  StartRoundRequest,
} from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { runAutoPlay, type AutoPlayHooks } from '../src/game/useAutoPlay';
import type { GameActions } from '../src/game/useGame';
import { fairnessAfterStart, shownBefore, startRoundShown } from '../src/game/session';
import {
  rememberShown,
  shownFor,
  type HashStorage,
  type ShownSeeds,
} from '../src/verify/shownHashes';

const key = (): string => crypto.randomUUID();
const REQUEST: StartRoundRequest = { difficultyId: 'easy', betsCents: [100, 250] };

/** localStorage as a Map. */
function memoryStorage(): HashStorage {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

/** A demo game with the player's own client seed set, and the fairness it shows. */
async function demo<C extends DemoClient>(client: C): Promise<{ client: C; fairness: FairnessView }> {
  await client.setClientSeed('player-seed', key());
  const { fairness } = await client.getSession();
  return { client, fairness };
}

/** A demo whose answer to the first start is lost on the way, after the round was started. */
class LosesFirstAnswer extends DemoClient {
  starts = 0;
  override startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    this.starts += 1;
    const answer = super.startRound(request, k);
    if (this.starts > 1) return answer;
    return answer.then(() => {
      throw new NetworkFailure('The answer was lost.');
    });
  }
}

/** A server that lies in its answer: it names a client seed and nonce of its own. */
class LyingAnswer extends DemoClient {
  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    const answer = await super.startRound(request, k);
    return { ...answer, round: { ...answer.round, clientSeed: 'server-picked', nonce: 99 } };
  }
}

describe('a round start saves what this browser showed before it', () => {
  it('saves the hash, client seed and next nonce from the screen, by round id', async () => {
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const remember = (id: string, shown: ShownSeeds): void => rememberShown(id, shown, storage);
    const first = await startRoundShown(client, REQUEST, fairness, remember);
    expect(shownFor(first.round.id, storage)).toEqual({
      serverSeedHash: fairness.serverSeedHash,
      clientSeed: 'player-seed',
      nonce: fairness.nextNonce,
    });
    // An honest server used exactly what the screen showed.
    expect(first.round).toMatchObject({
      serverSeedHash: fairness.serverSeedHash,
      clientSeed: 'player-seed',
      nonce: fairness.nextNonce,
    });
  });

  it('saves what the screen showed, never what the server answers', async () => {
    const { client, fairness } = await demo(new LyingAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const { round } = await startRoundShown(client, REQUEST, fairness, (id, shown) =>
      rememberShown(id, shown, storage),
    );
    expect(round.clientSeed).toBe('server-picked');
    expect(shownFor(round.id, storage)).toEqual({
      serverSeedHash: fairness.serverSeedHash,
      clientSeed: 'player-seed',
      nonce: fairness.nextNonce,
    });
  });

  it('saves the same copy when the answer is lost and the retry gets the stored answer', async () => {
    const { client, fairness } = await demo(new LosesFirstAnswer(GAME_CONFIG, 0));
    const saved: [string, ShownSeeds][] = [];
    const result = await startRoundShown(client, REQUEST, fairness, (id, shown) =>
      saved.push([id, shown]),
    );
    // Sent twice under one key, applied once.
    expect(client.starts).toBe(2);
    expect((await client.getSession()).fairness.nextNonce).toBe(fairness.nextNonce + 1);
    expect(saved).toEqual([[result.round.id, shownBefore(fairness)]]);
  });

  it('saves nothing for a start the server refuses', async () => {
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    const saved: string[] = [];
    await expect(
      startRoundShown(client, { difficultyId: 'no-such', betsCents: [100] }, fairness, (id) =>
        saved.push(id),
      ),
    ).rejects.toBeDefined();
    expect(saved).toEqual([]);
  });

  it('saves nothing with no seeds on screen, and only the hash with no client seed', () => {
    expect(shownBefore(null)).toBeNull();
    expect(shownBefore({ serverSeedHash: 'a'.repeat(64), clientSeed: null, nextNonce: 3 })).toEqual({
      serverSeedHash: 'a'.repeat(64),
      clientSeed: null,
      nonce: null,
    });
  });
});

describe('auto-play saves a copy for every round it starts', () => {
  it('with the right nonce each time, even with no pause for the screen to catch up', async () => {
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    const storage = memoryStorage();
    // The game's startRound action, as useGame wires it: the seeds on screen
    // are read before the start is sent, and move on at once after it.
    let onScreen: FairnessView = fairness;
    const call = <T>(action: (k: string) => Promise<T>): Promise<T | null> =>
      action(key()).catch(() => null);
    const drawIndex = (r: RoundView, i: number): number => r.balloons[i]?.drawIndex ?? -1;
    const actions: GameActions = {
      startRound: async (difficultyId, betsCents) => {
        const before = onScreen;
        const result = await startRoundShown(client, { difficultyId, betsCents }, before, (id, shown) =>
          rememberShown(id, shown, storage),
        );
        onScreen = fairnessAfterStart(result.round);
        return result;
      },
      pump: (r, i, patch) =>
        call((k) => client.pump(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i), patch }, k)),
      cashOut: (r, i) =>
        call((k) => client.cashOut(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i) }, k)),
    };
    const started: string[] = [];
    const hooks: AutoPlayHooks = {
      shouldStop: () => false,
      report: () => undefined,
      roundStarted: (id) => started.push(id),
      handCashOuts: () => new Set(),
    };
    const { reason } = await runAutoPlay(
      {
        settings: {
          rounds: 12,
          targetPumps: 2,
          stopOnProfitCents: null,
          stopOnLossCents: null,
          onWin: { kind: 'reset' },
          onLoss: { kind: 'reset' },
        },
        difficultyId: 'easy',
        betsCents: [100, 250],
        balanceCents: (await client.getSession()).wallet.balanceCents,
        limits: GAME_CONFIG.limits,
      },
      actions,
      hooks,
      { stepMs: 0, roundMs: 0 },
    );
    expect(reason).toBe('rounds-done');
    expect(started).toHaveLength(12);
    started.forEach((id, n) => {
      expect(shownFor(id, storage)).toEqual({
        serverSeedHash: fairness.serverSeedHash,
        clientSeed: 'player-seed',
        nonce: fairness.nextNonce + n,
      });
    });
  });
});

describe('every way a round starts goes through the saving start', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );

  it('only startRoundShown sends a start to the client', () => {
    // A client's startRound is called in one place only; the Bet button and
    // auto-play both reach it through the game's startRound action.
    const callers = files(SRC).filter((file) => /\bclient\.startRound\(/.test(readFileSync(file, 'utf8')));
    expect(callers.map((file) => file.slice(SRC.length))).toEqual(['game/session.ts']);
    const game = readFileSync(join(SRC, 'game/useGame.ts'), 'utf8');
    expect(game).toMatch(/startRoundShown\(client, \{ difficultyId, betsCents \}, before\)/);
    expect(game).toMatch(/startRound: startRoundAction/);
    const autoPlay = readFileSync(join(SRC, 'game/useAutoPlay.ts'), 'utf8');
    expect(autoPlay).toMatch(/actions\.startRound\(/);
  });
});
