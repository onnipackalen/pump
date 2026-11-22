import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { ApiFailure, NetworkFailure } from '../src/api/client';
import type {
  ActionResult,
  FairnessView,
  RoundView,
  StartRoundRequest,
} from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { afterFailure, describeFailure } from '../src/game/refusal';
import { runAutoPlay, type AutoPlayHooks } from '../src/game/useAutoPlay';
import type { GameActions } from '../src/game/useGame';
import {
  fairnessAfterStart,
  keepLostStartCopy,
  openGame,
  SeedsNotShown,
  shownBefore,
  startRoundShown,
} from '../src/game/session';
import {
  rememberShown,
  rememberStarting,
  shownFor,
  startsOnTheirWay,
  type HashStorage,
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

/** What the screen showed, as saved: hash, client seed and next nonce. */
const copyOf = (fairness: FairnessView) => ({
  serverSeedHash: fairness.serverSeedHash,
  clientSeed: fairness.clientSeed,
  nonce: fairness.nextNonce,
});

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

/**
 * A server that starts the round, then loses every answer to it (a crash
 * page, a proxy error, or on purpose): both tries fail.
 */
class LosesEveryStartAnswer extends DemoClient {
  starts = 0;
  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    this.starts += 1;
    await super.startRound(request, k);
    throw new NetworkFailure('The game server did not answer properly (502).');
  }
}

/** A server that starts the round, then says another round is in the way. */
class StartsThenSaysRoundActive extends DemoClient {
  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    await super.startRound(request, k);
    throw new ApiFailure({ code: 'round_active', message: 'Finish the current round first.' });
  }
}

/** Counts the starts sent, and the server never gets one it should not. */
class CountsStarts extends DemoClient {
  starts = 0;
  override startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    this.starts += 1;
    return super.startRound(request, k);
  }
}

describe('a round start saves what this browser showed before it', () => {
  it('saves the hash, client seed and next nonce from the screen, by round id', async () => {
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const first = await startRoundShown(client, REQUEST, fairness, storage);
    expect(shownFor(first.round.id, storage)).toEqual(copyOf(fairness));
    // An honest server used exactly what the screen showed.
    expect(first.round).toMatchObject({
      serverSeedHash: fairness.serverSeedHash,
      clientSeed: 'player-seed',
      nonce: fairness.nextNonce,
    });
    // Its answer came, so nothing is left on its way.
    expect(startsOnTheirWay(storage)).toEqual([]);
  });

  it('saves what the screen showed, never what the server answers', async () => {
    const { client, fairness } = await demo(new LyingAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const { round } = await startRoundShown(client, REQUEST, fairness, storage);
    expect(round.clientSeed).toBe('server-picked');
    expect(shownFor(round.id, storage)).toEqual(copyOf(fairness));
  });

  it('saves the same copy when the answer is lost and the retry gets the stored answer', async () => {
    const { client, fairness } = await demo(new LosesFirstAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const result = await startRoundShown(client, REQUEST, fairness, storage);
    // Sent twice under one key, applied once.
    expect(client.starts).toBe(2);
    expect((await client.getSession()).fairness.nextNonce).toBe(fairness.nextNonce + 1);
    expect(shownFor(result.round.id, storage)).toEqual(copyOf(fairness));
  });

  it('saves no round copy for a start the server refuses', async () => {
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    const storage = memoryStorage();
    await expect(
      startRoundShown(client, { difficultyId: 'no-such', betsCents: [100] }, fairness, storage),
    ).rejects.toBeInstanceOf(ApiFailure);
    // Still on its way as far as this browser knows; the next load of the
    // state finds no round in play and forgets it.
    expect(startsOnTheirWay(storage)).toHaveLength(1);
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    expect(startsOnTheirWay(storage)).toEqual([]);
  });
});

describe('a round is only started on seeds that can be checked later', () => {
  const HASH = 'e'.repeat(64);
  const cases: readonly [string, FairnessView | null][] = [
    ['no seeds on screen yet', null],
    ['no client seed', { serverSeedHash: HASH, clientSeed: null, nextNonce: 0 }],
    // Looks the same as 'player-seed' on screen.
    ['a client seed with an invisible character', { serverSeedHash: HASH, clientSeed: 'player-seed​', nextNonce: 0 }],
    ['a client seed with a colon', { serverSeedHash: HASH, clientSeed: 'a:b', nextNonce: 0 }],
    // Shown the same as the number 0.
    ['a nonce sent as text', { serverSeedHash: HASH, clientSeed: 'mine', nextNonce: '0' as unknown as number }],
    ['a nonce below 0', { serverSeedHash: HASH, clientSeed: 'mine', nextNonce: -1 }],
    ['an upper-case hash', { serverSeedHash: HASH.toUpperCase(), clientSeed: 'mine', nextNonce: 0 }],
    ['a short hash', { serverSeedHash: 'hash', clientSeed: 'mine', nextNonce: 0 }],
  ];

  for (const [name, fairness] of cases) {
    it(`refuses, sending nothing, with ${name}`, async () => {
      const client = new CountsStarts(GAME_CONFIG, 0);
      await client.setClientSeed('player-seed', key());
      const storage = memoryStorage();
      expect(shownBefore(fairness)).toBeNull();
      const failure = await startRoundShown(client, REQUEST, fairness, storage).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(SeedsNotShown);
      expect(client.starts).toBe(0);
      expect(startsOnTheirWay(storage)).toEqual([]);
      // The screen says why in plain words, and loads the seeds again.
      expect(describeFailure(failure)).toMatch(/not started/);
      expect(afterFailure(failure)).toBe('resync');
    });
  }

  it('starts on valid seeds, and saves them exactly as shown', () => {
    const fairness: FairnessView = { serverSeedHash: HASH, clientSeed: 'mine', nextNonce: 41 };
    expect(shownBefore(fairness)).toEqual({ serverSeedHash: HASH, clientSeed: 'mine', nonce: 41 });
  });
});

describe('a start whose answer never came still gets its copy', () => {
  it('after both tries lose the answer, the next load gives the round in play this copy', async () => {
    const { client, fairness } = await demo(new LosesEveryStartAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    await expect(startRoundShown(client, REQUEST, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);
    expect(client.starts).toBe(2);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    expect(shownFor(activeRound.id, storage)).toBeNull();

    // A reload (or a fresh start of the screen) loads the session again.
    const opened = await openGame(client, () => 'unused', storage);
    expect(opened.session.activeRound?.id).toBe(activeRound.id);
    expect(shownFor(activeRound.id, storage)).toEqual(copyOf(fairness));
    expect(startsOnTheirWay(storage)).toEqual([]);
  });

  it('the same after a resync (keepLostStartCopy with the session’s round)', async () => {
    const { client, fairness } = await demo(new LosesEveryStartAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    await startRoundShown(client, REQUEST, fairness, storage).catch(() => null);
    const { activeRound } = await client.getSession();
    keepLostStartCopy(activeRound, storage);
    expect(activeRound && shownFor(activeRound.id, storage)).toEqual(copyOf(fairness));
  });

  it('after a refusal that says another round is in the way, for a round this start made', async () => {
    const { client, fairness } = await demo(new StartsThenSaysRoundActive(GAME_CONFIG, 0));
    const storage = memoryStorage();
    const failure = await startRoundShown(client, REQUEST, fairness, storage).catch((e: unknown) => e);
    expect(afterFailure(failure)).toBe('resync');
    const { activeRound } = await client.getSession();
    keepLostStartCopy(activeRound, storage);
    expect(activeRound && shownFor(activeRound.id, storage)).toEqual(copyOf(fairness));
  });

  it('saves what the screen showed, even when the server played on seeds of its own', async () => {
    const { client, fairness } = await demo(new LosesEveryStartAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    await startRoundShown(client, REQUEST, fairness, storage).catch(() => null);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    // The round says another client seed: the copy still says the player's.
    keepLostStartCopy({ ...activeRound, clientSeed: 'server-picked' }, storage);
    expect(shownFor(activeRound.id, storage)?.clientSeed).toBe('player-seed');
  });

  it('never for a round with other bets, and never over a copy already saved', async () => {
    const { client, fairness } = await demo(new LosesEveryStartAnswer(GAME_CONFIG, 0));
    const storage = memoryStorage();
    await startRoundShown(client, REQUEST, fairness, storage).catch(() => null);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');

    const otherBets: RoundView = {
      ...activeRound,
      balloons: activeRound.balloons.map((b) => ({ ...b, betCents: b.betCents + 1 })),
    };
    keepLostStartCopy(otherBets, storage);
    expect(shownFor(activeRound.id, storage)).toBeNull();

    const shown = shownBefore(fairness);
    if (!shown) throw new Error('valid seeds expected');
    rememberStarting({ ...REQUEST, shown }, storage);
    const saved = { serverSeedHash: 'f'.repeat(64), clientSeed: 'saved-here', nonce: 7 };
    rememberShown(activeRound.id, saved, storage);
    keepLostStartCopy(activeRound, storage);
    expect(shownFor(activeRound.id, storage)).toEqual(saved);
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
        const result = await startRoundShown(client, { difficultyId, betsCents }, onScreen, storage);
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
    // Through the seed gate, with the seeds on screen read once any seed
    // change on its way is done.
    expect(game).toMatch(
      /seedGate\.start\(\(\) =>\s+startRoundShown\(client, \{ difficultyId, betsCents \}, shownFairness\.current\)/,
    );
    expect(game).toMatch(/startRound: startRoundAction/);
    const autoPlay = readFileSync(join(SRC, 'game/useAutoPlay.ts'), 'utf8');
    expect(autoPlay).toMatch(/actions\.startRound\(/);
  });

  it('a lost start answer is looked for on every full load of the state', () => {
    const game = readFileSync(join(SRC, 'game/useGame.ts'), 'utf8');
    // The resync after a lost answer or a refusal (the first load and a fresh
    // start go through openGame, tested above).
    expect(game).toMatch(/if \(!inFlight\.current\.has\('start'\)\) keepLostStartCopy\(session\.activeRound\);/);
    const session = readFileSync(join(SRC, 'game/session.ts'), 'utf8');
    expect(session).toMatch(/const session = await client\.getSession\(\);\s+(\/\/.*\s+)*keepLostStartCopy\(session\.activeRound, storage\);/);
  });
});
