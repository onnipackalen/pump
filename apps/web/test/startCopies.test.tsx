import { GAME_CONFIG } from '@pump/engine';
import { verifyRound } from '@pump/engine/fair';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiFailure, NetworkFailure } from '../src/api/client';
import type {
  ActionResult,
  CashOutBody,
  FairnessView,
  PumpBody,
  PumpResult,
  RoundView,
  SessionView,
  StartRoundRequest,
} from '../src/api/contract';
import { roundToCheck, Workbench } from '../src/components/VerifyPage';
import { DemoClient } from '../src/demo/DemoClient';
import { afterFailure, seedsInRefusal } from '../src/game/refusal';
import { isOlder } from '../src/game/roundOrder';
import { keepLostStartCopy, startRoundShown } from '../src/game/session';
import {
  copiesWithSameNonce,
  isStandIn,
  parseShown,
  shownFor,
  startsOnTheirWay,
  type HashStorage,
} from '../src/verify/shownHashes';

/*
 * What a round start leaves behind in this browser, for the verify page.
 * The rule: what the screen showed for a start is never thrown away. It is
 * saved under the round's id, or, when this browser never learns that id,
 * under a stand-in id that the verify page finds by the round's hash and
 * nonce. And none of this may make an honest round fail the verify page.
 *
 * The cheating servers here are the reviewers' probes, made into tests.
 */

const SUCCESS = 'This round checks out';
const key = (): string => crypto.randomUUID();
const BETS: StartRoundRequest = { difficultyId: 'easy', betsCents: [100, 250, 1000] };

function memoryStorage(): HashStorage {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

/** Every copy this browser saved, stand-ins too. */
const copies = (storage: HashStorage) => parseShown(storage.getItem('pump.shownSeeds'));

/** The start as a dishonest server treats it: it skips the check of the seeds the screen showed. */
const unchecked = (request: StartRoundRequest): StartRoundRequest => ({
  difficultyId: request.difficultyId,
  betsCents: request.betsCents,
});

/** Plays a round to its end: pump each balloon up to two rungs, then cash out. */
async function finishRound(client: DemoClient, started: RoundView): Promise<string> {
  let round = started;
  for (let step = 0; step < 40 && round.status === 'active'; step += 1) {
    const b = round.balloons.find((x) => x.status === 'active');
    if (!b) break;
    ({ round } =
      b.rung >= 2
        ? await client.cashOut(round.id, { balloonIndex: b.index, expectedDrawIndex: b.drawIndex }, key())
        : await client.pump(round.id, { balloonIndex: b.index, expectedDrawIndex: b.drawIndex, patch: false }, key()));
  }
  return round.id;
}

/** What the verify page says about a round, once its seed is revealed. */
async function verdictOf(client: DemoClient, roundId: string, storage: HashStorage) {
  const record = await client.getVerifiableRound(roundId);
  const html = renderToStaticMarkup(<Workbench {...roundToCheck(roundId, record, storage)} />);
  return { record, html, checksOut: html.includes(SUCCESS) };
}

/** A demo game with the player's own client seed set, and the seeds its screen shows. */
async function demo<C extends DemoClient>(client: C): Promise<{ client: C; fairness: FairnessView }> {
  await client.setClientSeed('player-seed', key());
  return { client, fairness: (await client.getSession()).fairness };
}

/** One round through the game's own start, played to its end. Returns its id. */
async function honestRound(client: DemoClient, onScreen: FairnessView, storage: HashStorage): Promise<string> {
  const { round } = await startRoundShown(client, BETS, onScreen, storage);
  return finishRound(client, round);
}

/**
 * Finding 1. A cheating server plays the rigged start on a client seed it
 * picked, loses both answers to it, and while the round is played calls it
 * by an EARLIER round's id, one this browser already has a copy under.
 */
class LosesStartAndReusesId extends DemoClient {
  rigNext = false;
  alias: string | null = null;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.rigNext) return super.startRound(request, k);
    if (this.realId === null) {
      await super.setClientSeed('server-picked', key());
      const answer = await super.startRound(unchecked(request), k);
      this.realId = answer.round.id;
    }
    throw new NetworkFailure('The game server did not answer properly (502).');
  }

  private out(round: RoundView): RoundView {
    return this.alias !== null && round.id === this.realId
      ? { ...round, id: this.alias, clientSeed: 'player-seed' }
      : round;
  }

  private into(roundId: string): string {
    return this.alias !== null && roundId === this.alias && this.realId !== null ? this.realId : roundId;
  }

  override async getSession(): Promise<SessionView> {
    const s = await super.getSession();
    return {
      ...s,
      fairness: { ...s.fairness, clientSeed: s.fairness.clientSeed === null ? null : 'player-seed' },
      activeRound: s.activeRound ? this.out(s.activeRound) : null,
    };
  }

  override async pump(roundId: string, body: PumpBody, k: string): Promise<PumpResult> {
    const r = await super.pump(this.into(roundId), body, k);
    return { ...r, round: this.out(r.round) };
  }

  override async cashOut(roundId: string, body: CashOutBody, k: string): Promise<ActionResult> {
    const r = await super.cashOut(this.into(roundId), body, k);
    return { ...r, round: this.out(r.round) };
  }
}

/**
 * Finding 2. A cheating server plays the rigged start on a client seed it
 * picked, then answers the start with a 409 "conflict" that carries the
 * round (shown with the player's client seed), under its real id.
 */
class RefusesStartWithRound extends DemoClient {
  rigNext = false;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.rigNext) return super.startRound(request, k);
    this.rigNext = false;
    await super.setClientSeed('server-picked', key());
    const answer = await super.startRound(unchecked(request), k);
    this.realId = answer.round.id;
    // It puts the player's seed back, so the panel looks right afterwards.
    throw new ApiFailure({
      code: 'conflict',
      message: 'Your round is below.',
      round: { ...answer.round, clientSeed: 'player-seed' },
      wallet: answer.wallet,
    });
  }

  /** Puts the player's client seed back once the rigged round is over. */
  async restoreSeed(): Promise<void> {
    await super.setClientSeed('player-seed', key());
  }
}

/**
 * Finding 6. A cheating server plays the rigged start on a client seed it
 * picked, plays the round to its end itself, and loses both answers. At the
 * next load there is no round in play.
 */
class FinishesLostStartItself extends DemoClient {
  rigNext = false;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.rigNext) return super.startRound(request, k);
    if (this.realId === null) {
      await super.setClientSeed('server-picked', key());
      const { round } = await super.startRound(unchecked(request), k);
      this.realId = await finishRound(this, round);
      await super.setClientSeed('player-seed', key());
    }
    throw new NetworkFailure('The game server did not answer properly (502).');
  }
}

describe('a cheating server cannot make a start’s copy go away', () => {
  it('a lost start whose round is called by an older round’s id keeps its copy under a stand-in (finding 1)', async () => {
    const storage = memoryStorage();
    const { client } = await demo(new LosesStartAndReusesId(GAME_CONFIG, 0));
    const honest: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      honest.push(await honestRound(client, (await client.getSession()).fairness, storage));
    }
    const [first] = honest;
    if (!first) throw new Error('two rounds expected');

    client.alias = first;
    client.rigNext = true;
    const { fairness } = await client.getSession();
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The game loads the whole state again (resync or openGame), and plays the round it finds.
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    expect(activeRound.id).toBe(first);
    keepLostStartCopy(activeRound, storage);
    expect(startsOnTheirWay(storage)).toEqual([]);
    await finishRound(client, activeRound);
    await client.rotateSeed(key());

    const realId = client.realId;
    if (realId === null) throw new Error('a rigged round expected');
    const { record, html, checksOut } = await verdictOf(client, realId, storage);
    expect(record).toMatchObject({ clientSeed: 'server-picked', nonce: 2, serverSeedHash: fairness.serverSeedHash });
    expect(verifyRound(record).ok).toBe(true);
    // The copy of what the screen showed is found by the round's hash and nonce.
    const [standIn, ...others] = copiesWithSameNonce(record.serverSeedHash, record.nonce, realId, storage);
    expect(others).toEqual([]);
    expect(standIn && isStandIn(standIn[0])).toBe(true);
    expect(standIn?.slice(1)).toEqual([fairness.serverSeedHash, 'player-seed', 2]);
    expect(checksOut).toBe(false);
    expect(html).toContain('data-verdict="mismatch"');
    expect(html).toContain('a round start whose round it never learned the id of');
    expect(html).toContain('“server-picked”');
    // The older round keeps its own copy, and still checks out.
    expect((await verdictOf(client, first, storage)).checksOut).toBe(true);
  });

  it('a start refused with the round in its body gets its copy at once (finding 2)', async () => {
    const storage = memoryStorage();
    const { client } = await demo(new RefusesStartWithRound(GAME_CONFIG, 0));
    await honestRound(client, (await client.getSession()).fairness, storage);

    client.rigNext = true;
    const { fairness } = await client.getSession();
    const refusal = await startRoundShown(client, BETS, fairness, storage).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ApiFailure);
    // The screen takes the refusal's word and puts its round on screen.
    expect(afterFailure(refusal)).toBe('none');
    const onScreen = refusal instanceof ApiFailure ? refusal.body.round : null;
    if (!onScreen) throw new Error('a round in the refusal expected');
    expect(isOlder(onScreen, null)).toBe(false);
    // Its copy was saved before the player could play it, under its real id.
    expect(shownFor(onScreen.id, storage)).toEqual({
      serverSeedHash: fairness.serverSeedHash,
      clientSeed: 'player-seed',
      nonce: fairness.nextNonce,
    });
    expect(startsOnTheirWay(storage)).toEqual([]);

    const riggedId = await finishRound(client, onScreen);
    expect(riggedId).toBe(client.realId);
    await client.restoreSeed();
    // The player rotates straight away to check it (no next start, no reload).
    await client.rotateSeed(key());
    const { record, html, checksOut } = await verdictOf(client, riggedId, storage);
    expect(record.clientSeed).toBe('server-picked');
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain('“server-picked”, but this browser saved “player-seed”');
  });

  it('a lost start whose round is over before the next load keeps its copy under a stand-in (finding 6)', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new FinishesLostStartItself(GAME_CONFIG, 0));
    client.rigNext = true;
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The next load finds no round in play.
    const { activeRound } = await client.getSession();
    expect(activeRound).toBeNull();
    keepLostStartCopy(activeRound, storage);
    expect(startsOnTheirWay(storage)).toEqual([]);

    await client.rotateSeed(key());
    const realId = client.realId;
    if (realId === null) throw new Error('a rigged round expected');
    const { record, html, checksOut } = await verdictOf(client, realId, storage);
    expect(record.clientSeed).toBe('server-picked');
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain('“player-seed”');
  });
});

/** An honest server that refuses the next start, as a real one would for a balance too small. */
class RefusesNextStart extends DemoClient {
  refuseNext = false;
  override startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.refuseNext) return super.startRound(request, k);
    this.refuseNext = false;
    return Promise.reject(
      new ApiFailure({ code: 'insufficient_funds', message: 'Not enough money.', wallet: { balanceCents: 5 } }),
    );
  }
}

/**
 * An honest server on a line that drops both tries of the next start (as
 * when the page is closed mid-start): after the start arrived, so the round
 * was made, or before it did, so nothing was.
 */
class LosesNextStart extends DemoClient {
  lose: 'after' | 'before' | null = null;
  private tries = 0;
  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (this.lose === null) return super.startRound(request, k);
    // The retry uses the same key, so the round is made once at most.
    if (this.lose === 'after') await super.startRound(request, k);
    this.tries += 1;
    if (this.tries === 2) this.lose = null;
    throw new NetworkFailure('Could not reach the game server. Check your connection.');
  }
}

describe('an honest server never gets a false alarm from these copies', () => {
  it('a start refused for too little money, then one that goes through', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesNextStart(GAME_CONFIG, 0));
    client.refuseNext = true;
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(ApiFailure);
    const id = await honestRound(client, fairness, storage);
    expect(startsOnTheirWay(storage)).toEqual([]);
    // One copy only: the refused start had the same hash and nonce, so it made no other round.
    expect(copies(storage).map(([roundId]) => roundId)).toEqual([id]);
    await client.rotateSeed(key());
    expect((await verdictOf(client, id, storage)).checksOut).toBe(true);
  });

  it('a refused start, then a client seed change, then a start that goes through', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesNextStart(GAME_CONFIG, 0));
    client.refuseNext = true;
    await startRoundShown(client, BETS, fairness, storage).catch(() => null);
    const changed = await client.setClientSeed('new-seed', key());
    const id = await honestRound(client, changed, storage);
    expect(copies(storage).map(([roundId]) => roundId)).toEqual([id]);
    await client.rotateSeed(key());
    expect((await verdictOf(client, id, storage)).checksOut).toBe(true);
  });

  it('a refused start, a reload, a client seed change, then a start: the stand-in does not get in the way', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesNextStart(GAME_CONFIG, 0));
    client.refuseNext = true;
    await startRoundShown(client, BETS, fairness, storage).catch(() => null);
    // A reload settles it: no round in play, so its seeds are kept under a stand-in.
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    expect(copies(storage)).toHaveLength(1);
    const changed = await client.setClientSeed('new-seed', key());
    const id = await honestRound(client, changed, storage);
    await client.rotateSeed(key());
    expect((await verdictOf(client, id, storage)).checksOut).toBe(true);
  });

  it('a page closed mid-start, after the start arrived: the next load gives the round its copy', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new LosesNextStart(GAME_CONFIG, 0));
    client.lose = 'after';
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    keepLostStartCopy(activeRound, storage);
    const id = await finishRound(client, activeRound);
    // No stand-in: the copy is under the round's own id.
    expect(copies(storage).map(([roundId]) => roundId)).toEqual([id]);
    const next = await honestRound(client, (await client.getSession()).fairness, storage);
    await client.rotateSeed(key());
    expect((await verdictOf(client, id, storage)).checksOut).toBe(true);
    expect((await verdictOf(client, next, storage)).checksOut).toBe(true);
  });

  it('a page closed mid-start, before the start arrived: the next round on that nonce checks out', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new LosesNextStart(GAME_CONFIG, 0));
    client.lose = 'before';
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(NetworkFailure);
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    // A stand-in, in case a round was made. None was, so the next one takes the same nonce.
    expect(copies(storage)).toHaveLength(1);
    const changed = await client.setClientSeed('new-seed', key());
    const id = await honestRound(client, changed, storage);
    await client.rotateSeed(key());
    const { record, checksOut } = await verdictOf(client, id, storage);
    expect(record.nonce).toBe(fairness.nextNonce);
    expect(checksOut).toBe(true);
  });

  it('two tabs: a tab left out of date is refused, then starts on the seeds the refusal carried', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    // Both tabs show the same seeds. Tab A plays a round.
    let tabB: FairnessView = fairness;
    const roundA = await honestRound(client, fairness, storage);

    // Tab B still shows the nonce round A used. Its start is refused.
    const refusal = await startRoundShown(client, BETS, tabB, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('seeds_changed');
    expect(afterFailure(refusal)).toBe('resync');
    const now = seedsInRefusal(refusal);
    expect(now).toEqual((await client.getSession()).fairness);
    expect(now?.nextNonce).toBe(fairness.nextNonce + 1);
    // No round, nothing charged.
    expect((await client.getSession()).activeRound).toBeNull();
    // The resync settles that start: round A's copy has its hash and nonce, so no stand-in.
    keepLostStartCopy(null, storage);
    expect(copies(storage).map(([roundId]) => roundId)).toEqual([roundA]);

    // The panel shows the seeds now, and the next Bet goes through.
    if (!now) throw new Error('the refusal carries the seeds');
    tabB = now;
    const roundB = await honestRound(client, tabB, storage);
    await client.rotateSeed(key());
    expect((await verdictOf(client, roundA, storage)).checksOut).toBe(true);
    expect((await verdictOf(client, roundB, storage)).checksOut).toBe(true);
  });

  it('two tabs: a client seed saved in the other tab gets this tab refused, not a mismatch', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new DemoClient(GAME_CONFIG, 0));
    // Tab A saves a new client seed; tab B still shows the old one.
    await client.setClientSeed('tab-a-seed', key());
    const refusal = await startRoundShown(client, BETS, fairness, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('seeds_changed');
    keepLostStartCopy(null, storage);
    const now = seedsInRefusal(refusal);
    if (!now) throw new Error('the refusal carries the seeds');
    expect(now.clientSeed).toBe('tab-a-seed');
    const id = await honestRound(client, now, storage);
    await client.rotateSeed(key());
    const { record, checksOut } = await verdictOf(client, id, storage);
    expect(record).toMatchObject({ clientSeed: 'tab-a-seed', nonce: fairness.nextNonce });
    expect(checksOut).toBe(true);
  });
});
