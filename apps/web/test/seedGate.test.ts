import { readFileSync } from 'node:fs';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { FairnessView, RoundView, StartRoundRequest } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { SeedGate } from '../src/game/seedGate';
import { startRoundShown } from '../src/game/session';
import { recordProblems } from '../src/verify/copyCheck';
import { shownFor, type HashStorage } from '../src/verify/shownHashes';

const key = (): string => crypto.randomUUID();
const REQUEST: StartRoundRequest = { difficultyId: 'easy', betsCents: [100] };

function memoryStorage(): HashStorage {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

/** Cashes out the round's balloon after one pump (or lets it pop). */
async function finish(client: DemoClient, started: RoundView): Promise<void> {
  let round = started;
  for (let step = 0; step < 5 && round.status === 'active'; step += 1) {
    const b = round.balloons[0];
    if (!b) return;
    ({ round } =
      b.rung >= 1
        ? await client.cashOut(round.id, { balloonIndex: 0, expectedDrawIndex: b.drawIndex }, key())
        : await client.pump(round.id, { balloonIndex: 0, expectedDrawIndex: b.drawIndex, patch: false }, key()));
  }
}

/** A promise and the function that settles it. */
function later<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * The player saves a seed change, then presses Bet before its answer is
 * back (one round trip on a slow host). `wait` says whether the start goes
 * through the gate, as useGame's does. What the server's record and this
 * browser's copy say about that round.
 */
async function betDuringSeedChange(
  change: (client: DemoClient) => Promise<FairnessView>,
  wait: boolean,
): Promise<readonly string[]> {
  const client = new DemoClient(GAME_CONFIG, 50);
  await client.setClientSeed('old-seed', key());
  let onScreen = (await client.getSession()).fairness;
  const storage = memoryStorage();
  const gate = new SeedGate();
  const changing = gate.changeSeeds(async () => {
    onScreen = await change(client);
    return true;
  });
  // The seeds on screen are read when the start runs, as useGame reads its ref.
  const start = () => startRoundShown(client, REQUEST, onScreen, storage);
  const started = wait ? await gate.start(start) : await start();
  expect(await changing).toBe(true);
  if (started === null) throw new Error('the start should have gone');
  await finish(client, started.round);
  await client.rotateSeed(key());
  const record = await client.getVerifiableRound(started.round.id);
  return recordProblems(record.id, shownFor(record.id, storage), record);
}

describe('a round start and a seed change are never on their way at once', () => {
  it('without the gate, an honest round would be called a mismatch (the old fault)', async () => {
    const problems = await betDuringSeedChange((c) => c.setClientSeed('new-seed', key()), false);
    expect(problems.join(' ')).toContain('“new-seed”, but this browser saved “old-seed”');
  });

  it('a start pressed while a client seed save is on its way waits for it, and matches its record', async () => {
    expect(await betDuringSeedChange((c) => c.setClientSeed('new-seed', key()), true)).toEqual([]);
  });

  it('a start pressed while a rotate is on its way waits for it, and matches its record', async () => {
    const rotate = async (c: DemoClient): Promise<FairnessView> => (await c.rotateSeed(key())).fairness;
    expect(await betDuringSeedChange(rotate, true)).toEqual([]);
  });

  it('refuses a seed change while a start is on its way, sending nothing', async () => {
    const gate = new SeedGate();
    const start = later<string>();
    const starting = gate.start(() => start.promise);
    let sent = false;
    expect(
      gate.changeSeeds(() => {
        sent = true;
        return Promise.resolve(true);
      }),
    ).toBeNull();
    start.settle('started');
    expect(await starting).toBe('started');
    expect(sent).toBe(false);
    // Once the start is done, a change goes again.
    expect(await gate.changeSeeds(() => Promise.resolve(true))).toBe(true);
  });

  it('refuses a second seed change while one is on its way', async () => {
    const gate = new SeedGate();
    const first = later<boolean>();
    const changing = gate.changeSeeds(() => first.promise);
    expect(gate.changeSeeds(() => Promise.resolve(true))).toBeNull();
    first.settle(true);
    expect(await changing).toBe(true);
    expect(await gate.changeSeeds(() => Promise.resolve(true))).toBe(true);
  });

  it('starts no round after a seed change that failed: the screen may be behind', async () => {
    const gate = new SeedGate();
    const failing = later<boolean>();
    void gate.changeSeeds(() => failing.promise);
    let ran = false;
    const starting = gate.start(() => {
      ran = true;
      return Promise.resolve('started');
    });
    failing.settle(false);
    expect(await starting).toBeNull();
    expect(ran).toBe(false);
    // A change that throws counts as failed too.
    void gate.changeSeeds(() => Promise.reject(new Error('lost')));
    expect(await gate.start(() => Promise.resolve('started'))).toBeNull();
    expect(await gate.start(() => Promise.resolve('started'))).toBe('started');
  });

  it('the game sends every seed change and round start through it, and locks the seeds while a start is on its way', () => {
    const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
    const game = source('../src/game/useGame.ts');
    expect(game.match(/seedGate\.changeSeeds\(/g)).toHaveLength(2);
    expect(game).toMatch(/client\.setClientSeed\(clientSeed, key\)/);
    expect(game).toMatch(/client\.rotateSeed\(key\)/);
    expect(game).toMatch(/seedGate\.start\(/);
    // Each answer puts its seeds where the next start reads them, at once.
    expect(game).toMatch(/shownFairness\.current = fairness;/);
    expect(game).toMatch(/shownFairness\.current = result\.fairness;/);
    const app = source('../src/App.tsx');
    expect(app).toMatch(/locked=\{roundActive \|\| autoRunning \|\| state\.starting\}/);
    expect(app).toMatch(/canRotate=\{!roundActive && !autoRunning && !state\.starting && /);
  });
});
