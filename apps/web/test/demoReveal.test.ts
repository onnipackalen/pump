/**
 * The demo works out where each cashed-out balloon would have popped exactly
 * as the server does: only once the whole round is over, only after the
 * engine accepted the action that ended it, and never in any answer while
 * the round is in progress.
 *
 * revealDrawerFor is wrapped in a spy (same behaviour), so the tests can see
 * every time the demo starts drawing for a reveal.
 */
import { DIFFICULTIES, GAME_CONFIG, multiplierAt, type GameConfig } from '@pump/engine';
import type * as Fair from '@pump/engine/fair';
import { revealDrawerFor } from '@pump/engine/fair';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../src/api/client';
import type { BalloonView, RoundView } from '../src/api/contract';
import { DemoClient } from '../src/demo/DemoClient';
import { afterRoundLine } from '../src/game/afterRound';
import { formatMultiplier } from '../src/money';
import { climbsAll, configWith, MADE_LONG, surestStart } from './fixtures';

vi.mock('@pump/engine/fair', async (importOriginal) => {
  const actual = await importOriginal<typeof Fair>();
  return { ...actual, revealDrawerFor: vi.fn(actual.revealDrawerFor) };
});

const revealDraws = vi.mocked(revealDrawerFor);

const RTPS = [...new Set([9400, 9700, 9900, GAME_CONFIG.rtpBp])];

const key = (): string => crypto.randomUUID();

/** The spec's rule: a balloon has a reveal iff it cashed out below its top rung. */
function revealDue(b: BalloonView): boolean {
  return b.status === 'cashed' && b.rung < b.topRung;
}

function expectNoReveal(round: RoundView | null): void {
  for (const b of round?.balloons ?? []) expect(b.afterRound).toBeNull();
}

/** A finished round carries a reveal exactly on the balloons due one, and each makes sense. */
function expectRevealsOnFinished(round: RoundView): void {
  expect(round.status).toBe('finished');
  for (const b of round.balloons) {
    const after = b.afterRound;
    expect(after !== null).toBe(revealDue(b));
    if (after === null) continue;
    expect(after.reachedMultiplierHundredths).toBe(multiplierAt(round.ladder, after.reachedRung));
    if (after.outcome === 'top') {
      expect(after.reachedRung).toBe(b.topRung);
    } else {
      expect(after.reachedRung).toBeGreaterThanOrEqual(b.rung);
      expect(after.reachedRung).toBeLessThan(b.topRung);
    }
  }
}

async function newClient(config: GameConfig): Promise<DemoClient> {
  const client = new DemoClient(config, 0);
  await client.setClientSeed('reveal-test', key());
  return client;
}

/** Ends a round: cashes out pumped balloons, pumps unpumped ones. */
async function finish(client: DemoClient, start: RoundView): Promise<RoundView> {
  let round = start;
  while (round.status === 'active') {
    const b = round.balloons.find((x) => x.status === 'active');
    if (!b) break;
    const body = { balloonIndex: b.index, expectedDrawIndex: b.drawIndex };
    ({ round } =
      b.rung >= 1
        ? await client.cashOut(round.id, body, key())
        : await client.pump(round.id, { ...body, patch: false }, key()));
  }
  return round;
}

beforeEach(() => {
  revealDraws.mockClear();
});

describe.each(RTPS)('the demo at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };

  it('shows no reveal while a round is in progress, and exactly the due ones once it is over', async () => {
    const client = await newClient(config);
    let reveals = 0;
    for (let n = 0; n < 30; n += 1) {
      const difficultyId = DIFFICULTIES[n % DIFFICULTIES.length]?.id ?? 'easy';
      let { round } = await client.startRound({ difficultyId, betsCents: [100, 250, 1000] }, key());
      for (let step = 0; round.status === 'active'; step += 1) {
        // Every answer during play, and the session a refresh would load.
        expectNoReveal(round);
        expectNoReveal((await client.getSession()).activeRound);
        expect(revealDraws).not.toHaveBeenCalled();
        const b = round.balloons.find((x) => x.status === 'active');
        if (!b) break;
        const body = { balloonIndex: b.index, expectedDrawIndex: b.drawIndex };
        if (b.rung >= 1 + ((n + b.index) % 3)) {
          ({ round } = await client.cashOut(round.id, body, key()));
        } else {
          const patch = b.rung >= 1 && (step + n) % 3 === 0;
          ({ round } = await client.pump(round.id, { ...body, patch }, key()));
        }
      }
      expectRevealsOnFinished(round);
      // One reveal per balloon due one, each started at its own draw count.
      const due = round.balloons.filter(revealDue);
      expect(revealDraws).toHaveBeenCalledTimes(due.length);
      for (const b of due) {
        expect(revealDraws).toHaveBeenCalledWith(
          expect.objectContaining({ balloonIndex: b.index, drawIndex: b.drawIndex }),
        );
      }
      reveals += due.length;
      revealDraws.mockClear();
    }
    expect(reveals).toBeGreaterThan(0);
  });

  it('makes no reveal draw for a refused request, and a repeat gets the same answer', async () => {
    // A ladder where a $1 balloon is still in play after one pump, and pump
    // 1 survives at least half the time (Easy, as shipped). Both balloons
    // then get past pump 1 at least a quarter of the time, so 1000 tries
    // miss with a chance of about 1 in 10^125, whatever ladder comes first.
    const difficulty = surestStart(rtpBp, (d) => d.ladder.length >= 2 && climbsAll(d.ladder, 100));
    const client = await newClient(configWith(difficulty, config));
    const difficultyId = difficulty.id;

    // A round with two balloons, both pumped once and still in play.
    let round: RoundView | null = null;
    for (let tries = 0; round === null; tries += 1) {
      if (tries === 1000) throw new Error('no round left both balloons in play');
      let started = (await client.startRound({ difficultyId, betsCents: [100, 100] }, key())).round;
      for (const index of [0, 1]) {
        const b = started.balloons[index];
        if (b?.status !== 'active') continue;
        const body = { balloonIndex: index, expectedDrawIndex: b.drawIndex, patch: false };
        started = (await client.pump(started.id, body, key())).round;
      }
      if (started.balloons.every((b) => b.status === 'active')) round = started;
      else await finish(client, started);
    }
    revealDraws.mockClear();
    const [first, second] = round.balloons;
    if (!first || !second) throw new Error('two balloons expected');

    // Balloon 1 cashes out; balloon 2 is still in play, so no reveal yet.
    const firstOut = { balloonIndex: 0, expectedDrawIndex: first.drawIndex };
    round = (await client.cashOut(round.id, firstOut, key())).round;
    expect(round.status).toBe('active');
    expectNoReveal(round);

    // Refused: a stale draw index (409, with the state as it is now), and
    // cashing out balloon 1 a second time.
    const stale = { balloonIndex: 1, expectedDrawIndex: second.drawIndex + 1 };
    const conflict = await client.cashOut(round.id, stale, key()).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiFailure);
    if (conflict instanceof ApiFailure) {
      expect(conflict.code).toBe('conflict');
      expectNoReveal(conflict.body.round ?? null);
    }
    await expect(client.cashOut(round.id, firstOut, key())).rejects.toBeInstanceOf(ApiFailure);
    expect(revealDraws).not.toHaveBeenCalled();

    // The cash-out that ends the round makes both reveals.
    const lastKey = key();
    const secondOut = { balloonIndex: 1, expectedDrawIndex: second.drawIndex };
    const ended = await client.cashOut(round.id, secondOut, lastKey);
    expectRevealsOnFinished(ended.round);
    expect(ended.round.balloons.every((b) => b.afterRound !== null)).toBe(true);
    expect(revealDraws).toHaveBeenCalledTimes(2);

    // A repeat of that request gets the stored answer and draws nothing more.
    expect(await client.cashOut(round.id, secondOut, lastKey)).toEqual(ended);
    // A new request on the finished round is refused and draws nothing.
    await expect(client.cashOut(round.id, secondOut, key())).rejects.toMatchObject({
      code: 'conflict',
      body: { round: null },
    });
    expect(revealDraws).toHaveBeenCalledTimes(2);
  });

  it('says each ending in the spec’s words', async () => {
    // A three-rung ladder, so the top is in reach: the start of the
    // configured ladder that gives the best chance of getting there (Easy,
    // as shipped), or of the long made one if it gives a better chance.
    const ladder = [...DIFFICULTIES, MADE_LONG]
      .filter((d) => d.ladder.length >= 3)
      .map((d) => d.ladder.slice(0, 3))
      .reduce((best, next) =>
        // Survive pumps 2 and 3: h1 / h3. Higher is better.
        (next[0] ?? 0) * (best[2] ?? 1) > (best[0] ?? 0) * (next[2] ?? 1) ? next : best,
      );
    const short: GameConfig = {
      ...config,
      difficulties: [{ id: 'short', label: 'Short', ladder }],
    };
    const top = `Would have reached the top (${formatMultiplier(multiplierAt(ladder, 3))})`;
    const higher = `Would have reached ${formatMultiplier(multiplierAt(ladder, 2))}, then popped`;
    const next = 'Next pump would have popped';
    const seen = new Set<string>();
    const client = await newClient(short);
    for (let n = 0; n < 600 && seen.size < 3; n += 1) {
      // Cash out on rung 1 or 2, below the top rung 3.
      const cashAt = 1 + (n % 2);
      let { round } = await client.startRound({ difficultyId: 'short', betsCents: [100] }, key());
      for (let b = round.balloons[0]; b?.status === 'active'; b = round.balloons[0]) {
        const body = { balloonIndex: 0, expectedDrawIndex: b.drawIndex };
        ({ round } =
          b.rung >= cashAt
            ? await client.cashOut(round.id, body, key())
            : await client.pump(round.id, { ...body, patch: false }, key()));
      }
      expectRevealsOnFinished(round);
      const line = round.balloons[0] ? afterRoundLine(round.balloons[0]) : null;
      if (line === null) continue;
      expect([top, higher, next]).toContain(line);
      seen.add(line);
    }
    expect([...seen].sort()).toEqual([top, higher, next].sort());
  });
});
