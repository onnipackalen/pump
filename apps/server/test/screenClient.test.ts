import type { PumpResult, RoundView } from '@pump/contract';
import { verifyRound } from '@pump/engine/fair';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
// The game screen's own client, the very file the browser runs.
import { ApiFailure, NetworkFailure } from '../../web/src/api/client';
import { HttpClient } from '../../web/src/api/httpClient';
import { seedsInRefusal } from '../../web/src/game/refusal';
import { startRoundShown } from '../../web/src/game/session';
import { shownFor, type HashStorage } from '../../web/src/verify/shownHashes';
import { count, testWorld } from './helpers';

// The screen and the server were built apart, against a shared description of
// the API. This test puts the two real halves together: the screen's client
// sends its requests straight into the server, and a whole round is played,
// restored, refused, finished and checked.

type Method = 'GET' | 'POST' | 'PUT';

function methodOf(value: string | undefined): Method {
  if (value === 'POST' || value === 'PUT') return value;
  return 'GET';
}

/**
 * A stand-in for the browser's fetch that hands each request to the server
 * directly, and keeps the cookie the way a browser would.
 */
function browserFor(app: FastifyInstance): { fetch: typeof fetch; forgetCookie: () => void } {
  let cookie = '';
  const send: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.inject({
      method: methodOf(init?.method),
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const setCookie = response.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof first === 'string') cookie = first.split(';')[0] ?? cookie;
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetch: send,
    forgetCookie: () => {
      cookie = '';
    },
  };
}

const newKey = (): string => crypto.randomUUID();

/** Pumps a balloon until it is on a rung or has popped, then cashes it out if it is still in play. */
async function playOut(client: HttpClient, start: RoundView, balloonIndex: number): Promise<RoundView> {
  let round = start;
  for (let step = 0; step < 3; step += 1) {
    const balloon = round.balloons[balloonIndex];
    if (balloon?.status !== 'active') return round;
    const pumped: PumpResult = await client.pump(
      round.id,
      { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch: balloon.rung >= 1 },
      newKey(),
    );
    round = pumped.round;
  }
  const balloon = round.balloons[balloonIndex];
  if (balloon?.status === 'active') {
    round = (
      await client.cashOut(round.id, { balloonIndex, expectedDrawIndex: balloon.drawIndex }, newKey())
    ).round;
  }
  return round;
}

describe('the game screen’s client against the real server', () => {
  it('loads, plays a round, is refused and restored correctly, and the round then checks out', async () => {
    const world = testWorld();
    const client = new HttpClient(browserFor(world.app).fetch);

    // The screen asks for the session and the history together on a first
    // visit. That must still make exactly one player.
    const [session, history] = await Promise.all([client.getSession(), client.getHistory(10)]);
    expect(session.wallet.balanceCents).toBe(1_000_000);
    expect(session.fairness.clientSeed).toBeNull();
    expect(history).toEqual([]);
    expect(count(world.db, 'players')).toBe(1);

    // The browser makes the first client seed.
    const fairness = await client.setClientSeed('made-in-the-browser', newKey());
    expect(fairness.clientSeed).toBe('made-in-the-browser');

    const started = await client.startRound({ difficultyId: 'easy', betsCents: [1000, 250] }, newKey());
    expect(started.wallet.balanceCents).toBe(1_000_000 - 1250);
    let round = started.round;

    // A page refresh mid-round gets the same round back.
    expect((await client.getSession()).activeRound).toEqual(round);

    // The same action sent twice with one key is applied once.
    const key = newKey();
    const body = { balloonIndex: 0, expectedDrawIndex: 0, patch: false };
    const first = await client.pump(round.id, body, key);
    const repeat = await client.pump(round.id, body, key);
    expect(repeat).toEqual(first);
    expect(first.round.balloons[0]?.drawIndex).toBe(1);
    round = first.round;

    // A request made from an out-of-date screen is refused, and the refusal
    // carries the round as it is now.
    const stale = await client.pump(round.id, body, newKey()).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(ApiFailure);
    if (stale instanceof ApiFailure) {
      expect(stale.code).toBe('conflict');
      expect(stale.body.round).toEqual(round);
    }

    round = await playOut(client, round, 0);
    round = await playOut(client, round, 1);
    expect(round.status).toBe('finished');

    const after = await client.getSession();
    expect(after.activeRound).toBeNull();
    expect(after.fairness.nextNonce).toBe(1);
    const paid = round.balloons.reduce((sum, b) => sum + b.payoutCents - b.patchesCents, 0);
    expect(after.wallet.balanceCents).toBe(1_000_000 - 1250 + paid);

    // The round is in the history, but cannot be checked until the seed is rotated.
    const [line] = await client.getHistory(10);
    expect(line).toMatchObject({ id: round.id, seedRevealed: false, refundedCents: 0 });
    const tooEarly = await client.getVerifiableRound(round.id).catch((error: unknown) => error);
    expect(tooEarly instanceof ApiFailure ? tooEarly.code : tooEarly).toBe('seed_not_revealed');

    const rotated = await client.rotateSeed(newKey());
    expect(rotated.revealed.serverSeedHash).toBe(round.serverSeedHash);
    expect((await client.getHistory(10))[0]?.seedRevealed).toBe(true);

    // The same check the verify page runs in the browser: replay every pump
    // from the seeds and compare with what the server recorded and paid.
    const record = await client.getVerifiableRound(round.id);
    expect(record.serverSeed).toBe(rotated.revealed.serverSeed);
    const check = verifyRound(record);
    expect(check.problems).toEqual([]);
  });

  it('a start from a tab left out of date is refused (seeds_changed), and the next one checks out', async () => {
    const world = testWorld();
    const client = new HttpClient(browserFor(world.app).fetch);
    const items = new Map<string, string>();
    const storage: HashStorage = {
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => {
        items.set(k, v);
      },
    };
    await client.getSession();
    const shown = await client.setClientSeed('made-in-the-browser', newKey());
    const bets = { difficultyId: 'easy', betsCents: [1000] };

    // Two tabs show these seeds. One plays a round to its end.
    const first = await startRoundShown(client, bets, shown, storage);
    expect(first.round.nonce).toBe(shown.nextNonce);
    expect((await playOut(client, first.round, 0)).status).toBe('finished');

    // The other tab's start names the nonce that round used: refused, nothing charged.
    const balance = (await client.getSession()).wallet.balanceCents;
    const refused = await startRoundShown(client, bets, shown, storage).catch((error: unknown) => error);
    expect(refused instanceof ApiFailure && refused.code).toBe('seeds_changed');
    const now = seedsInRefusal(refused);
    expect(now).toEqual((await client.getSession()).fairness);
    expect(count(world.db, 'rounds')).toBe(1);
    expect((await client.getSession()).wallet.balanceCents).toBe(balance);

    // With the seeds the refusal carried, the next start goes through.
    const next = await startRoundShown(client, bets, now, storage);
    expect(next.round.nonce).toBe(shown.nextNonce + 1);
    expect(shownFor(next.round.id, storage)?.nonce).toBe(next.round.nonce);
  });

  it('makes one player when the session is asked for twice at the same moment', async () => {
    const world = testWorld();
    const client = new HttpClient(browserFor(world.app).fetch);

    // This is what React does in development: it runs the first load twice.
    const [one, two] = await Promise.all([client.getSession(), client.getSession()]);

    expect(two).toEqual(one);
    expect(count(world.db, 'players')).toBe(1);
  });

  it('never quietly becomes a new player if the cookie has gone', async () => {
    const world = testWorld();
    const browser = browserFor(world.app);
    const client = new HttpClient(browser.fetch);
    await client.getSession();
    await client.setClientSeed('made-in-the-browser', newKey());

    browser.forgetCookie();

    // Reading and playing are both refused, in the server's words, and no
    // second player appears behind the screen's back.
    const reading = await client.getHistory(10).catch((error: unknown) => error);
    const playing = await client
      .startRound({ difficultyId: 'easy', betsCents: [1000] }, newKey())
      .catch((error: unknown) => error);
    for (const refused of [reading, playing]) {
      expect(refused).toBeInstanceOf(ApiFailure);
      if (refused instanceof ApiFailure) {
        expect(refused.code).toBe('no_session');
        expect(refused.message).toContain('Reload the page');
      }
    }
    expect(count(world.db, 'players')).toBe(1);
    expect(count(world.db, 'rounds')).toBe(0);

    // A reload loads the session, and that is what starts a new player.
    const fresh = await client.getSession();
    expect(fresh.fairness.clientSeed).toBeNull();
    expect(count(world.db, 'players')).toBe(2);
  });

  it('passes a refusal on with the server’s own words', async () => {
    const world = testWorld();
    const client = new HttpClient(browserFor(world.app).fetch);
    await client.getSession();

    // No client seed yet: a round cannot start.
    const refused = await client
      .startRound({ difficultyId: 'easy', betsCents: [1000] }, newKey())
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiFailure);
    if (refused instanceof ApiFailure) {
      expect(refused.code).toBe('invalid_request');
      expect(refused.message).toBe('Set a client seed before starting a round.');
    }
  });

  it('reports a dead connection, or an answer that is not the server’s, as safe to retry', async () => {
    const offline = new HttpClient(() => Promise.reject(new TypeError('fetch failed')));
    await expect(offline.getSession()).rejects.toBeInstanceOf(NetworkFailure);

    const badGateway = new HttpClient(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    await expect(badGateway.getSession()).rejects.toBeInstanceOf(NetworkFailure);

    // A web page answering "200 OK" where the API should be is not the game either.
    const aPage = new HttpClient(() =>
      Promise.resolve(new Response('<!doctype html><title>Pump</title>', { status: 200 })),
    );
    await expect(aPage.getSession()).rejects.toBeInstanceOf(NetworkFailure);
  });
});
