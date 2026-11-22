import { describe, expect, it } from 'vitest';
import { ApiFailure, NetworkFailure, type GameClient } from '../src/api/client';
import type { FairnessView, RoundView, SessionView } from '../src/api/contract';
import { HttpClient } from '../src/api/httpClient';
import { roundNetCents } from '../src/game/autoPlay';
import { CLIENT_SEED_PATTERN } from '../src/game/clientSeed';
import {
  afterFailure,
  CLOSED_FOR_IDLE_TEXT,
  closedForIdle,
  failureNotice,
  IDLE_CLOSE_MS,
} from '../src/game/refusal';
import { ensureClientSeed, fairnessAfterStart, openGame, send } from '../src/game/session';
import { openedState } from '../src/game/useGame';
import {
  roundPayoutCents,
  roundRefundedCents,
  roundStakeCents,
  roundWinTier,
} from '../src/game/winTier';
import { balloon, round } from './fixtures';

const DAY = IDLE_CLOSE_MS;
const STARTED = Date.parse('2026-11-20T00:00:00.000Z');

/** A 409 "This round is over." carrying the finished round, as the server sends it. */
function roundOver(finished: RoundView): ApiFailure {
  return new ApiFailure({ code: 'conflict', message: 'This round is over.', round: finished });
}

describe('E1: a round closed by the 24-hour rule', () => {
  // Three $10 bets: one pumped once and paid $10.10, two never pumped and returned.
  const before = round([
    balloon({ betCents: 1000, rung: 1, drawIndex: 1, multiplierHundredths: 101, cashOutCents: 1010 }),
    balloon({ betCents: 1000 }),
    balloon({ betCents: 1000 }),
  ]);
  const closed = round([
    balloon({ betCents: 1000, status: 'cashed', rung: 1, drawIndex: 1, payoutCents: 1010 }),
    balloon({ betCents: 1000, status: 'refunded' }),
    balloon({ betCents: 1000, status: 'refunded' }),
  ]);

  it('counts a refunded bet as void: Net +$0.10, not -$19.90', () => {
    expect(roundStakeCents(closed)).toBe(1000);
    expect(roundPayoutCents(closed)).toBe(1010);
    expect(roundRefundedCents(closed)).toBe(2000);
    expect(roundNetCents(closed)).toBe(10);
  });

  it('judges the win on the bets that were played', () => {
    expect(roundWinTier(closed)).toBe(1);
    // Every bet returned: nothing was played, nothing was won.
    const allReturned = round([balloon({ status: 'refunded' }), balloon({ status: 'refunded' })]);
    expect(roundStakeCents(allReturned)).toBe(0);
    expect(roundNetCents(allReturned)).toBe(0);
    expect(roundWinTier(allReturned)).toBeNull();
  });

  it('is told calmly, as information, when the refusal carries it', () => {
    const notice = failureNotice(roundOver(closed), before, STARTED + DAY);
    expect(notice).toEqual({ tone: 'info', text: CLOSED_FOR_IDLE_TEXT });
    // A finished round needs nothing more fetched: the refusal shows it.
    expect(afterFailure(roundOver(closed))).toBe('none');
  });

  it('is recognised with no refund too: every balloon in play cashed out with no new draw, a day on', () => {
    const allPumped = round([
      balloon({ rung: 2, drawIndex: 3 }),
      balloon({ status: 'popped', drawIndex: 1 }),
    ]);
    const settled = round([
      balloon({ status: 'cashed', rung: 2, drawIndex: 3, payoutCents: 120 }),
      balloon({ status: 'popped', drawIndex: 1 }),
    ]);
    expect(closedForIdle(allPumped, settled, STARTED + DAY)).toBe(true);
    // The same picture less than a day after the round began can't be the rule.
    expect(closedForIdle(allPumped, settled, STARTED + DAY - 1)).toBe(false);
  });

  it('is not claimed for a round that ended another way, so the notice never says something untrue', () => {
    // Cashed out in another tab, an hour in.
    const cashedElsewhere = round([balloon({ status: 'cashed', rung: 1, drawIndex: 1, payoutCents: 101 })]);
    const playing = round([balloon({ rung: 1, drawIndex: 1 })]);
    expect(closedForIdle(playing, cashedElsewhere, STARTED + 3_600_000)).toBe(false);
    // Popped by a pump this screen never saw (a new draw), even days later.
    const poppedElsewhere = round([balloon({ status: 'popped', rung: 1, drawIndex: 2 })]);
    expect(closedForIdle(playing, poppedElsewhere, STARTED + 3 * DAY)).toBe(false);
    const notice = failureNotice(roundOver(poppedElsewhere), playing, STARTED + 3 * DAY);
    expect(notice).toEqual({ tone: 'info', text: 'This round is over.' });
  });

  it('leaves other failures as errors in the server\'s words', () => {
    const poor = new ApiFailure({ code: 'insufficient_funds', message: 'Not enough balance.' });
    expect(failureNotice(poor, before, STARTED)).toEqual({ tone: 'error', text: 'Not enough balance.' });
  });
});

describe('E2: the nonce panel moves on with every round', () => {
  it('takes the seeds and the next nonce from the round that just started', () => {
    const started = round([balloon()], { serverSeedHash: 'f'.repeat(64), clientSeed: 'mine', nonce: 41 });
    expect(fairnessAfterStart(started)).toEqual({
      serverSeedHash: 'f'.repeat(64),
      clientSeed: 'mine',
      nextNonce: 42,
    });
  });
});

describe('E3: what each failure leads to', () => {
  it('starts over on a lost session, and catches up when the screen may be behind', () => {
    expect(afterFailure(new ApiFailure({ code: 'no_session', message: 'gone' }))).toBe('start-over');
    expect(afterFailure(new ApiFailure({ code: 'not_found', message: 'There is no such round.' }))).toBe(
      'resync',
    );
    expect(afterFailure(new ApiFailure({ code: 'round_active', message: 'busy' }))).toBe('resync');
    expect(afterFailure(new ApiFailure({ code: 'conflict', message: 'old' }))).toBe('resync');
    expect(afterFailure(new NetworkFailure('offline'))).toBe('resync');
    expect(afterFailure(new ApiFailure({ code: 'insufficient_funds', message: 'poor' }))).toBe('none');
    expect(afterFailure(new Error('bug'))).toBe('none');
  });
});

const FAIRNESS: FairnessView = { serverSeedHash: 'e'.repeat(64), clientSeed: null, nextNonce: 0 };

/** A game client that answers from fixed values and records what it was asked. */
class FakeClient implements GameClient {
  readonly isDemo = true;
  readonly calls: string[] = [];
  readonly seedsSent: { seed: string; key: string }[] = [];
  /** How many setClientSeed calls fail on the way before one gets through. */
  failSeedTimes = 0;

  constructor(private readonly session: SessionView) {}

  getSession() {
    this.calls.push('getSession');
    return Promise.resolve(this.session);
  }
  getHistory() {
    this.calls.push('getHistory');
    return Promise.resolve([]);
  }
  getHistoryPage(): never {
    throw new Error('not used');
  }
  setClientSeed(seed: string, key: string) {
    this.calls.push('setClientSeed');
    this.seedsSent.push({ seed, key });
    if (this.failSeedTimes > 0) {
      this.failSeedTimes -= 1;
      return Promise.reject(new NetworkFailure('lost on the way'));
    }
    return Promise.resolve({ ...this.session.fairness, clientSeed: seed });
  }
  startRound(): never {
    throw new Error('not used');
  }
  pump(): never {
    throw new Error('not used');
  }
  cashOut(): never {
    throw new Error('not used');
  }
  rotateSeed(): never {
    throw new Error('not used');
  }
  getVerifiableRound(): never {
    throw new Error('not used');
  }
  getStats(): never {
    throw new Error('not used');
  }
  getPublicWins(): never {
    throw new Error('not used');
  }
  getSettings(): never {
    throw new Error('not used');
  }
  setSettings(): never {
    throw new Error('not used');
  }
}

describe('E3: starting over like the first load', () => {
  const session: SessionView = { wallet: { balanceCents: 1_000_000 }, fairness: FAIRNESS, activeRound: null };

  it('loads the session first and alone, then makes the first client seed, then the history', async () => {
    const client = new FakeClient(session);
    const opened = await openGame(client);
    expect(client.calls).toEqual(['getSession', 'setClientSeed', 'getHistory']);
    expect(opened.fairness.clientSeed).toMatch(CLIENT_SEED_PATTERN);
  });

  it('makes no seed for a player who has one', async () => {
    const client = new FakeClient({ ...session, fairness: { ...FAIRNESS, clientSeed: 'mine' } });
    expect((await openGame(client)).fairness.clientSeed).toBe('mine');
    expect(client.calls).toEqual(['getSession', 'getHistory']);
  });

  it('retries the first seed as the very same request: same seed, same key', async () => {
    const client = new FakeClient(session);
    client.failSeedTimes = 1;
    const fairness = await ensureClientSeed(client, FAIRNESS);
    expect(client.seedsSent).toHaveLength(2);
    const [first, retry] = client.seedsSent;
    expect(retry).toEqual(first);
    expect(fairness.clientSeed).toBe(first?.seed);
  });

  it('sends the same body under the same key over HTTP when the first try is lost', async () => {
    const sent: { url: string; key: string | null; body: string | null }[] = [];
    let seedTries = 0;
    const fetchFake: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      sent.push({ url, key: headers.get('idempotency-key'), body: typeof init?.body === 'string' ? init.body : null });
      const json = (value: unknown) =>
        Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }));
      if (url === '/api/session') return json(session);
      if (url.startsWith('/api/history')) return json({ rounds: [] });
      seedTries += 1;
      if (seedTries === 1) return Promise.reject(new TypeError('network down'));
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return json({ ...FAIRNESS, clientSeed: (body as { clientSeed: string }).clientSeed });
    };
    const opened = await openGame(new HttpClient(fetchFake));
    const seedRequests = sent.filter((r) => r.url === '/api/fairness/client-seed');
    expect(seedRequests).toHaveLength(2);
    expect(seedRequests[1]).toEqual(seedRequests[0]);
    expect(opened.fairness.clientSeed).toMatch(CLIENT_SEED_PATTERN);
  });

  it('sends one first seed when two loads start at once (React StrictMode runs the first load twice)', async () => {
    const client = new FakeClient(session);
    const [first, second] = await Promise.all([openGame(client), openGame(client)]);
    expect(client.seedsSent).toHaveLength(1);
    expect(first.fairness.clientSeed).toBe(client.seedsSent[0]?.seed);
    expect(second.fairness.clientSeed).toBe(first.fairness.clientSeed);
  });

  it('shares one first seed between a resync and a fresh start that both find none', async () => {
    const client = new FakeClient(session);
    let made = 0;
    const makeSeed = (): string => `seed-${String((made += 1))}`;
    const [a, b] = await Promise.all([
      ensureClientSeed(client, FAIRNESS, makeSeed),
      ensureClientSeed(client, FAIRNESS, makeSeed),
    ]);
    expect(client.seedsSent.map((x) => x.seed)).toEqual(['seed-1']);
    expect([a.clientSeed, b.clientSeed]).toEqual(['seed-1', 'seed-1']);
    // Once that one has landed, a player who has lost it again gets a new one.
    await ensureClientSeed(client, FAIRNESS, makeSeed);
    expect(client.seedsSent.map((x) => x.seed)).toEqual(['seed-1', 'seed-2']);
  });

  it('lets the next try make its own seed after a first seed fails', async () => {
    const client = new FakeClient(session);
    client.failSeedTimes = 2;
    await expect(ensureClientSeed(client, FAIRNESS)).rejects.toBeInstanceOf(NetworkFailure);
    const fairness = await ensureClientSeed(client, FAIRNESS);
    expect(fairness.clientSeed).toBe(client.seedsSent[2]?.seed);
  });

  it('send: reuses one key for its one retry, and passes a refusal on untouched', async () => {
    const keys: string[] = [];
    let tries = 0;
    const answer = await send(
      (key) => {
        keys.push(key);
        tries += 1;
        return tries === 1 ? Promise.reject(new NetworkFailure('lost')) : Promise.resolve('ok');
      },
      () => 'key-1',
    );
    expect(answer).toBe('ok');
    expect(keys).toEqual(['key-1', 'key-1']);
    const refusal = new ApiFailure({ code: 'conflict', message: 'no' });
    await expect(send(() => Promise.reject(refusal))).rejects.toBe(refusal);
  });

  it('clears the old round, history and revealed seeds, and restarts the session clock', () => {
    const old = round([balloon({ rung: 2, drawIndex: 2 })]);
    const state = {
      phase: 'ready' as const,
      wallet: { balanceCents: 5 },
      fairness: { ...FAIRNESS, clientSeed: 'old' },
      round: old,
      history: [
        {
          id: 'old-round',
          difficultyId: 'easy',
          balloonCount: 1,
          betCents: 100,
          patchesCents: 0,
          payoutCents: 0,
          refundedCents: 0,
          serverSeedHash: 'e'.repeat(64),
          nonce: 0,
          finishedAt: '2026-11-20T00:00:00.000Z',
          seedRevealed: true,
        },
      ],
      revealed: [{ serverSeed: 'd'.repeat(64), serverSeedHash: 'e'.repeat(64), roundsPlayed: 1 }],
      beats: ['survived' as const],
      pending: [true],
      patched: [true],
      pressed: [null],
      outcomes: [null],
      held: [false],
      winShownFor: 'old-round',
      endedElsewhere: 'old-round',
      starting: false,
      notice: null,
      session: { startedAt: 1, startBalanceCents: 900 },
    };
    const fresh = openedState(
      state,
      { session, fairness: { ...FAIRNESS, clientSeed: 'new' }, history: [] },
      12_345,
    );
    expect(fresh.round).toBeNull();
    expect(fresh.history).toEqual([]);
    expect(fresh.revealed).toEqual([]);
    expect(fresh.pending).toEqual([]);
    expect(fresh.winShownFor).toBeNull();
    expect(fresh.endedElsewhere).toBeNull();
    expect(fresh.wallet).toEqual({ balanceCents: 1_000_000 });
    expect(fresh.fairness?.clientSeed).toBe('new');
    expect(fresh.session).toEqual({ startedAt: 12_345, startBalanceCents: 1_000_000 });
  });
});
