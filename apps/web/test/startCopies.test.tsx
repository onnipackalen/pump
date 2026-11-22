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
import { afterFailure, finishedRefusal, seedsInRefusal } from '../src/game/refusal';
import { isOlder } from '../src/game/roundOrder';
import { keepLostStartCopy, openGame, startRoundShown } from '../src/game/session';
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

/**
 * A cheating server that plays a start on the client seed the player had
 * replaced. It refuses one start in a way that loads nothing again (too
 * little money), lets the player save a new client seed, then plays the
 * next start on the old one (it skips the check of the seeds shown) and
 * loses both answers. Its panel keeps showing the new seed.
 */
class PlaysOnReplacedSeed extends DemoClient {
  mode: 'honest' | 'refuse' | 'rig' = 'honest';
  showSeed: string | null = null;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (this.mode === 'refuse') {
      this.mode = 'honest';
      throw new ApiFailure({ code: 'insufficient_funds', message: 'Not enough money.', wallet: { balanceCents: 5 } });
    }
    if (this.mode === 'rig') {
      if (this.realId === null) {
        await super.setClientSeed('player-seed', key());
        this.realId = (await super.startRound(unchecked(request), k)).round.id;
      }
      throw new NetworkFailure('The game server did not answer properly (502).');
    }
    return super.startRound(request, k);
  }

  override async getSession(): Promise<SessionView> {
    const s = await super.getSession();
    return this.showSeed === null ? s : { ...s, fairness: { ...s.fairness, clientSeed: this.showSeed } };
  }
}

/**
 * The same, with a lying "seeds_changed" for the first start (the seeds it
 * carries are the same ones), and the rigged round called by an older
 * round's id while it is played, one this browser already has a copy under.
 */
class RenamesRoundOnReplacedSeed extends DemoClient {
  mode: 'honest' | 'refuse' | 'rig' = 'honest';
  showSeed: string | null = null;
  alias: string | null = null;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (this.mode === 'refuse') {
      this.mode = 'honest';
      const s = await super.getSession();
      throw new ApiFailure({ code: 'seeds_changed', message: 'Changed.', fairness: s.fairness, wallet: s.wallet });
    }
    if (this.mode === 'rig') {
      if (this.realId === null) {
        await super.setClientSeed('player-seed', key());
        this.realId = (await super.startRound(unchecked(request), k)).round.id;
      }
      throw new NetworkFailure('The game server did not answer properly (502).');
    }
    return super.startRound(request, k);
  }

  private out(round: RoundView): RoundView {
    return this.alias !== null && round.id === this.realId ? { ...round, id: this.alias } : round;
  }

  private into(roundId: string): string {
    return this.alias !== null && roundId === this.alias && this.realId !== null ? this.realId : roundId;
  }

  override async getSession(): Promise<SessionView> {
    const s = await super.getSession();
    const fairness = this.showSeed === null ? s.fairness : { ...s.fairness, clientSeed: this.showSeed };
    return { ...s, fairness, activeRound: s.activeRound ? this.out(s.activeRound) : null };
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
 * A cheating server that plays the start itself, on a client seed it
 * picked, to its end, then refuses the start with a 409 that carries that
 * round, finished, shown with the player's client seed.
 */
class RefusesWithFinishedRound extends DemoClient {
  rigNext = false;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (!this.rigNext) return super.startRound(request, k);
    this.rigNext = false;
    await super.setClientSeed('server-picked', key());
    const { round } = await super.startRound(unchecked(request), k);
    const finished = await finishRound(this, round);
    this.realId = finished;
    await super.setClientSeed('player-seed', key());
    const { wallet } = await super.getSession();
    const history = await super.getHistory(1);
    if (history[0]?.id !== finished) throw new Error('the rigged round is over');
    throw new ApiFailure({
      code: 'conflict',
      message: 'That round is over.',
      round: { ...round, status: 'finished', clientSeed: 'player-seed' },
      wallet,
    });
  }
}

/**
 * The reviewers' probe for a refused start. A cheating server makes the
 * rigged start's round anyway, on a client seed it picked, at the hash and
 * nonce the panel showed, and answers with a refusal that carries no round:
 * "Something went wrong on our side" (500), or a lying "seeds_changed".
 * While the round is played it calls it by an EARLIER round's id, one this
 * browser already has a copy under, and shows the player's client seed.
 */
class RefusesStartAndReusesId extends DemoClient {
  rigNext: 'internal_error' | 'seeds_changed' | null = null;
  alias: string | null = null;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    const refusal = this.rigNext;
    if (refusal === null) return super.startRound(request, k);
    this.rigNext = null;
    await super.setClientSeed('server-picked', key());
    this.realId = (await super.startRound(unchecked(request), k)).round.id;
    if (refusal === 'internal_error') {
      throw new ApiFailure({ code: 'internal_error', message: 'Something went wrong on our side.' });
    }
    const { fairness, wallet } = await this.getSession();
    throw new ApiFailure({ code: 'seeds_changed', message: 'Changed.', fairness, wallet });
  }

  private out(round: RoundView): RoundView {
    if (round.id !== this.realId) return round;
    return { ...round, clientSeed: 'player-seed', ...(this.alias !== null ? { id: this.alias } : {}) };
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

  for (const [refusal, after] of [
    ['internal_error', 'a reload'],
    ['seeds_changed', 'its resync, with no reload'],
  ] as const) {
    it(`a start refused with no round (${refusal}), played anyway and called by an older round’s id after ${after}, keeps a stand-in`, async () => {
      const storage = memoryStorage();
      const { client, fairness } = await demo(new RefusesStartAndReusesId(GAME_CONFIG, 0));
      const first = await honestRound(client, fairness, storage);

      const shown = (await client.getSession()).fairness;
      client.rigNext = refusal;
      const failure = await startRoundShown(client, BETS, shown, storage).catch((e: unknown) => e);
      expect(failure instanceof ApiFailure && failure.code).toBe(refusal);
      expect(startsOnTheirWay(storage).map((s) => s.refused)).toEqual([true]);
      expect(afterFailure(failure)).toBe(refusal === 'internal_error' ? 'none' : 'resync');

      // The game loads the whole state again and finds the round in play,
      // called by the first round's id, which already has a copy.
      client.alias = first;
      let activeRound: RoundView | null;
      if (refusal === 'internal_error') {
        ({ activeRound } = (await openGame(client, undefined, storage)).session);
      } else {
        ({ activeRound } = await client.getSession());
        keepLostStartCopy(activeRound, storage);
      }
      if (!activeRound) throw new Error('the start was applied');
      expect(activeRound.id).toBe(first);
      expect(startsOnTheirWay(storage)).toEqual([]);
      // A round for its bets turned up, so the refusal is in doubt: its seeds are kept.
      expect(copies(storage).filter(([id]) => isStandIn(id)).map((e) => e.slice(1))).toEqual([
        [shown.serverSeedHash, 'player-seed', shown.nextNonce],
      ]);

      await finishRound(client, activeRound);
      await client.rotateSeed(key());
      const realId = client.realId;
      if (realId === null) throw new Error('a rigged round expected');
      const { record, html, checksOut } = await verdictOf(client, realId, storage);
      expect(record).toMatchObject({
        clientSeed: 'server-picked',
        nonce: shown.nextNonce,
        serverSeedHash: shown.serverSeedHash,
      });
      expect(verifyRound(record).ok).toBe(true);
      expect(shownFor(realId, storage)).toBeNull();
      expect(checksOut).toBe(false);
      expect(html).toContain('“server-picked”');
      expect(html).toContain('“player-seed”');
      // The honest first round still checks out.
      expect((await verdictOf(client, first, storage)).checksOut).toBe(true);
    });
  }
});

/**
 * A cheating server that plays the rigged start on a nonce already used
 * (with the player's own client seed), so the round has the rolls of an
 * earlier round. It loses both answers, moves the next nonce on as if the
 * nonce on screen was used, and calls the round by another round's id
 * while it is played.
 */
class ReusesNonce extends DemoClient {
  rigNonce: number | null = null;
  alias: string | null = null;
  realId: string | null = null;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    if (this.rigNonce === null) return super.startRound(request, k);
    if (this.realId === null) {
      // The demo keeps its next nonce in a private field; a cheating server sets its own.
      const seeds = this as unknown as { nonce: number };
      const next = seeds.nonce;
      seeds.nonce = this.rigNonce;
      this.realId = (await super.startRound(unchecked(request), k)).round.id;
      seeds.nonce = next + 1;
    }
    throw new NetworkFailure('The game server did not answer properly (502).');
  }

  private out(round: RoundView): RoundView {
    return this.alias !== null && round.id === this.realId ? { ...round, id: this.alias } : round;
  }

  private into(roundId: string): string {
    return this.alias !== null && roundId === this.alias && this.realId !== null ? this.realId : roundId;
  }

  override async getSession(): Promise<SessionView> {
    const s = await super.getSession();
    return { ...s, activeRound: s.activeRound ? this.out(s.activeRound) : null };
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

describe('a cheating server cannot pick which start’s seeds a round is checked against', () => {
  it('a refused start, a new client seed, then a lost start played on the old seed does not check out', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new PlaysOnReplacedSeed(GAME_CONFIG, 0));
    client.mode = 'refuse';
    const refusal = await startRoundShown(client, BETS, fairness, storage).catch((e: unknown) => e);
    // Nothing is loaded again, so this start stays on its way, marked refused.
    expect(afterFailure(refusal)).toBe('none');
    expect(startsOnTheirWay(storage).map((s) => [s.shown.clientSeed, s.refused])).toEqual([['player-seed', true]]);

    const changed = await client.setClientSeed('new-seed', key());
    client.showSeed = 'new-seed';
    client.mode = 'rig';
    await expect(startRoundShown(client, BETS, changed, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The resync finds the round in play. Its own seeds name the old client
    // seed, but the copy is the newest start's: what the screen showed for it.
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    expect(activeRound.clientSeed).toBe('player-seed');
    keepLostStartCopy(activeRound, storage);
    expect(shownFor(activeRound.id, storage)).toEqual({
      serverSeedHash: changed.serverSeedHash,
      clientSeed: 'new-seed',
      nonce: changed.nextNonce,
    });
    expect(startsOnTheirWay(storage)).toEqual([]);

    await finishRound(client, activeRound);
    await client.rotateSeed(key());
    const { record, html, checksOut } = await verdictOf(client, activeRound.id, storage);
    expect(record.clientSeed).toBe('player-seed');
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain('“player-seed”, but this browser saved “new-seed”');
  });

  it('a lying seeds_changed, a new client seed, then a lost start renamed to an older round’s id does not check out', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RenamesRoundOnReplacedSeed(GAME_CONFIG, 0));
    const first = await honestRound(client, fairness, storage);

    client.mode = 'refuse';
    const refusal = await startRoundShown(client, BETS, (await client.getSession()).fairness, storage).catch(
      (e: unknown) => e,
    );
    expect(afterFailure(refusal)).toBe('resync');
    keepLostStartCopy((await client.getSession()).activeRound, storage); // the resync
    // The refused start leaves no stand-in.
    expect(copies(storage).map(([id]) => id)).toEqual([first]);

    const changed = await client.setClientSeed('new-seed', key());
    client.showSeed = 'new-seed';
    client.mode = 'rig';
    client.alias = first;
    await expect(startRoundShown(client, BETS, changed, storage)).rejects.toBeInstanceOf(NetworkFailure);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    expect(activeRound.id).toBe(first);
    keepLostStartCopy(activeRound, storage);
    // What the screen showed for the start that made the round is kept.
    expect(copies(storage).some(([id, , clientSeed]) => isStandIn(id) && clientSeed === 'new-seed')).toBe(true);

    await finishRound(client, activeRound);
    await client.rotateSeed(key());
    const realId = client.realId;
    if (realId === null) throw new Error('a rigged round expected');
    const { record, html, checksOut } = await verdictOf(client, realId, storage);
    expect(record).toMatchObject({ clientSeed: 'player-seed', nonce: changed.nextNonce });
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain('“new-seed”');
    expect((await verdictOf(client, first, storage)).checksOut).toBe(true);
  });

  it('a renamed round that reuses an earlier nonce’s rolls does not check out, though the client seed is the same', async () => {
    const storage = memoryStorage();
    const { client } = await demo(new ReusesNonce(GAME_CONFIG, 0));
    const honest: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      honest.push(await honestRound(client, (await client.getSession()).fairness, storage));
    }
    const shown = (await client.getSession()).fairness;
    expect(shown.nextNonce).toBe(3);
    client.rigNonce = 1;
    client.alias = honest[2] ?? null;
    await expect(startRoundShown(client, BETS, shown, storage)).rejects.toBeInstanceOf(NetworkFailure);
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    keepLostStartCopy(activeRound, storage);
    await finishRound(client, activeRound);
    await client.rotateSeed(key());

    const realId = client.realId;
    if (realId === null) throw new Error('a rigged round expected');
    const { record, html, checksOut } = await verdictOf(client, realId, storage);
    expect(record).toMatchObject({ clientSeed: 'player-seed', nonce: 1 });
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain(`used the rolls of round ${honest[1] ?? ''} again`);
    // The honest rounds still check out.
    for (const id of honest) expect((await verdictOf(client, id, storage)).checksOut).toBe(true);
  });

  it('a start refused with a finished round in its body is caught at once, with no reload', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesWithFinishedRound(GAME_CONFIG, 0));
    client.rigNext = true;
    const refusal = await startRoundShown(client, BETS, fairness, storage).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ApiFailure);
    // The screen shows it calmly as a finished round, and loads nothing again.
    expect(afterFailure(refusal)).toBe('none');
    expect(finishedRefusal(refusal)).not.toBeNull();
    expect(startsOnTheirWay(storage)).toEqual([]);

    // The player rotates in the same tab and checks it straight away.
    await client.rotateSeed(key());
    const realId = client.realId;
    if (realId === null) throw new Error('a rigged round expected');
    expect(shownFor(realId, storage)?.clientSeed).toBe('player-seed');
    const { record, html, checksOut } = await verdictOf(client, realId, storage);
    expect(record.clientSeed).toBe('server-picked');
    expect(verifyRound(record).ok).toBe(true);
    expect(checksOut).toBe(false);
    expect(html).toContain('“server-picked”, but this browser saved “player-seed”');
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

/** The same, and it can also refuse the next start, as a real one would for a balance too small. */
class RefusesOrLosesNextStart extends LosesNextStart {
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
 * An honest server whose next start is slow: it is held until released. On
 * release the round is made, and then both answers can be lost (`lose`) or
 * the first answer arrives. Its "round_active" carries the round in play,
 * as the real server's does.
 */
class HoldsNextStart extends DemoClient {
  hold: Promise<void> | null = null;
  lose = false;
  private tries = 0;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    const held = this.hold;
    if (held === null) return this.answer(request, k);
    await held;
    if (!this.lose) {
      this.hold = null;
      return this.answer(request, k);
    }
    await this.answer(request, k).catch(() => null);
    this.tries += 1;
    if (this.tries === 2) this.hold = null;
    throw new NetworkFailure('Could not reach the game server. Check your connection.');
  }

  private async answer(request: StartRoundRequest, k: string): Promise<ActionResult> {
    try {
      return await super.startRound(request, k);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.code !== 'round_active') throw error;
      const { activeRound, wallet } = await super.getSession();
      throw new ApiFailure({ ...error.body, round: activeRound, wallet });
    }
  }
}

/**
 * An honest server whose next start makes its round at once but holds its
 * answer back until released (`holdNext`), and then can lose it
 * (`loseHeld`). Its "round_active" carries the round in play, as the real
 * server's does.
 */
class MakesRoundThenHoldsAnswer extends DemoClient {
  holdNext: Promise<void> | null = null;
  loseHeld = false;
  private lost = 0;

  override async startRound(request: StartRoundRequest, k: string): Promise<ActionResult> {
    const held = this.holdNext;
    this.holdNext = null;
    let answer: ActionResult;
    try {
      answer = await super.startRound(request, k);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.code !== 'round_active') throw error;
      const { activeRound, wallet } = await super.getSession();
      throw new ApiFailure({ ...error.body, round: activeRound, wallet });
    }
    if (held === null) return answer;
    await held;
    if (!this.loseHeld) return answer;
    // The retry under the same key loses its answer too; after that, answers come.
    this.lost += 1;
    if (this.lost === 1) this.holdNext = Promise.resolve();
    else this.loseHeld = false;
    throw new NetworkFailure('Could not reach the game server. Check your connection.');
  }
}

/** Waits until the server has a round in play, and gives it. */
async function roundInPlay(client: DemoClient): Promise<RoundView> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { activeRound } = await client.getSession();
    if (activeRound) return activeRound;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('no round in play');
}

/** A promise and the function that settles it. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
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

  it('a refused start, a reload, a client seed change, then a start: the refused start leaves nothing in the way', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesNextStart(GAME_CONFIG, 0));
    client.refuseNext = true;
    await startRoundShown(client, BETS, fairness, storage).catch(() => null);
    // A reload settles it: no round in play, and the server refused it, so no stand-in.
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    expect(copies(storage)).toEqual([]);
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

  it('two tabs: a stale tab refused, then its next start lost and its round over unseen: no false alarm', async () => {
    const storage = memoryStorage();
    const { client, fairness: tabX } = await demo(new LosesNextStart(GAME_CONFIG, 0));
    // The other tab saves a new client seed. This tab still shows the old one.
    await client.setClientSeed('tab-y-seed', key());
    const refusal = await startRoundShown(client, BETS, tabX, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('seeds_changed');
    keepLostStartCopy((await client.getSession()).activeRound, storage); // the resync
    expect(copies(storage)).toEqual([]);

    // Bet on the seeds the refusal carried. The round is made, both answers are lost.
    const now = seedsInRefusal(refusal);
    if (!now) throw new Error('the refusal carries the seeds');
    client.lose = 'after';
    await expect(startRoundShown(client, BETS, now, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The round ends without this browser loading it in play (as the 24-hour
    // rule would), then the page loads again.
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    const id = await finishRound(client, activeRound);
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    await client.rotateSeed(key());
    const { record, checksOut } = await verdictOf(client, id, storage);
    expect(record).toMatchObject({ clientSeed: 'tab-y-seed', nonce: tabX.nextNonce });
    expect(checksOut).toBe(true);
  });

  it('two tabs: the other tab loads while this start is on its way, the answer is lost, the round is played: no false alarm', async () => {
    const storage = memoryStorage(); // one browser, shared by both tabs
    const { client, fairness: tabX } = await demo(new HoldsNextStart(GAME_CONFIG, 0));
    await client.setClientSeed('tab-y-seed', key());
    const refusal = await startRoundShown(client, BETS, tabX, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('seeds_changed');
    keepLostStartCopy((await client.getSession()).activeRound, storage);

    // Tab X bets on the seeds the refusal carried, and the request is slow.
    const held = gate();
    client.hold = held.wait;
    client.lose = true;
    const now = seedsInRefusal(refusal);
    const pending = startRoundShown(client, BETS, now, storage).catch((e: unknown) => e);
    await Promise.resolve();
    // Meanwhile tab Y loads the state: no round yet.
    keepLostStartCopy((await client.getSession()).activeRound, storage);
    held.open();
    expect(await pending).toBeInstanceOf(NetworkFailure);

    // Tab X resyncs, finds the round in play and plays it (with draws).
    const { activeRound } = await client.getSession();
    if (!activeRound) throw new Error('the start was applied');
    keepLostStartCopy(activeRound, storage);
    const id = await finishRound(client, activeRound);
    await client.rotateSeed(key());
    const { record, checksOut } = await verdictOf(client, id, storage);
    expect(record.balloons.some((b) => b.drawIndex > 0)).toBe(true);
    expect(checksOut).toBe(true);
  });

  it('two tabs press Bet at once, one on an old panel: it is refused, and the round checks out once its answer comes', async () => {
    const storage = memoryStorage();
    const { client, fairness: tabB } = await demo(new MakesRoundThenHoldsAnswer(GAME_CONFIG, 0));
    // Tab A saves a new client seed and bets. Its round is made; its answer is slow.
    const tabA = await client.setClientSeed('tab-a-seed', key());
    const held = gate();
    client.holdNext = held.wait;
    const startA = startRoundShown(client, BETS, tabA, storage);
    const round = await roundInPlay(client);

    // Tab B still shows the old client seed, and bets while A's answer is on its way.
    const refusal = await startRoundShown(client, BETS, tabB, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('round_active');
    // For now the round has B's copy: this browser can't tell which start made it.
    expect(shownFor(round.id, storage)?.clientSeed).toBe('player-seed');

    // A's answer comes, and its own copy is what the round is checked against.
    held.open();
    expect((await startA).round.id).toBe(round.id);
    expect(shownFor(round.id, storage)?.clientSeed).toBe('tab-a-seed');
    await finishRound(client, round);
    await client.rotateSeed(key());
    expect((await verdictOf(client, round.id, storage)).checksOut).toBe(true);
  });

  it('the same race with A’s answer lost too fails the round, and says another tab may be why (a known issue)', async () => {
    const storage = memoryStorage();
    const { client, fairness: tabB } = await demo(new MakesRoundThenHoldsAnswer(GAME_CONFIG, 0));
    const tabA = await client.setClientSeed('tab-a-seed', key());
    const held = gate();
    client.holdNext = held.wait;
    client.loseHeld = true;
    const startA = startRoundShown(client, BETS, tabA, storage).catch((e: unknown) => e);
    const round = await roundInPlay(client);
    await startRoundShown(client, BETS, tabB, storage).catch(() => null);
    held.open();
    expect(await startA).toBeInstanceOf(NetworkFailure);
    keepLostStartCopy((await client.getSession()).activeRound, storage); // A's resync
    await finishRound(client, round);
    await client.rotateSeed(key());
    const { checksOut, html } = await verdictOf(client, round.id, storage);
    expect(checksOut).toBe(false);
    expect(html).toContain('Changing the client seed in another tab');
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

  it('two tabs: a stale tab presses Bet while the other tab’s round is in play: refused, and every round checks out', async () => {
    const storage = memoryStorage(); // one browser, shared by both tabs
    const { client, fairness: tabB } = await demo(new DemoClient(GAME_CONFIG, 0));
    // Tab A saves a new client seed and starts a round with the same bets.
    const tabA = await client.setClientSeed('tab-a-seed', key());
    const { round } = await startRoundShown(client, BETS, tabA, storage);

    // Tab B still shows the old client seed. The demo's "round_active"
    // carries no round, so the start is marked refused, and the resync
    // finds tab A's round in play, which already has its copy.
    const refusal = await startRoundShown(client, BETS, tabB, storage).catch((e: unknown) => e);
    expect(refusal instanceof ApiFailure && refusal.code).toBe('round_active');
    expect(afterFailure(refusal)).toBe('resync');
    const { activeRound } = await client.getSession();
    expect(activeRound?.id).toBe(round.id);
    keepLostStartCopy(activeRound, storage);
    expect(startsOnTheirWay(storage)).toEqual([]);
    expect(shownFor(round.id, storage)?.clientSeed).toBe('tab-a-seed');

    await finishRound(client, round);
    const next = await honestRound(client, (await client.getSession()).fairness, storage);
    await client.rotateSeed(key());
    expect((await verdictOf(client, round.id, storage)).checksOut).toBe(true);
    expect((await verdictOf(client, next, storage)).checksOut).toBe(true);
  });

  it('a refused start, a client seed change, then a lost start: the round gets the newest start’s copy and checks out', async () => {
    const storage = memoryStorage();
    const { client, fairness } = await demo(new RefusesOrLosesNextStart(GAME_CONFIG, 0));
    client.refuseNext = true;
    await expect(startRoundShown(client, BETS, fairness, storage)).rejects.toBeInstanceOf(ApiFailure);
    const changed = await client.setClientSeed('new-seed', key());
    client.lose = 'after';
    await expect(startRoundShown(client, BETS, changed, storage)).rejects.toBeInstanceOf(NetworkFailure);

    // The next load finds the round in play. Both starts asked for its bets.
    const opened = await openGame(client, undefined, storage);
    const activeRound = opened.session.activeRound;
    if (!activeRound) throw new Error('the start was applied');
    expect(shownFor(activeRound.id, storage)?.clientSeed).toBe('new-seed');
    expect(startsOnTheirWay(storage)).toEqual([]);
    const id = await finishRound(client, activeRound);
    const next = await honestRound(client, (await client.getSession()).fairness, storage);
    await client.rotateSeed(key());
    const { record, checksOut } = await verdictOf(client, id, storage);
    expect(record).toMatchObject({ clientSeed: 'new-seed', nonce: fairness.nextNonce });
    expect(checksOut).toBe(true);
    expect((await verdictOf(client, next, storage)).checksOut).toBe(true);
  });
});
