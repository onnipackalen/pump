import { describe, expect, it } from 'vitest';
import type { BalloonView, RoundView } from '../src/api/contract';
import type { Beat } from '../src/game/useGame';
import { formatSignedCents } from '../src/money';
import {
  addRound,
  LINE_GROUPS,
  LINE_POINTS_IN_FULL,
  NO_LIVE_STATS,
  resetLiveStats,
  START_WATCH,
  thinLine,
  watchShown,
  type LiveStats,
} from '../src/stats/liveStats';
import { balloon, round } from './fixtures';

/** A finished one-balloon round. */
function played(
  id: string,
  ending: Partial<BalloonView> & { readonly status: BalloonView['status'] },
): RoundView {
  return round([balloon(ending)], { id });
}

const cashed = (id: string, betCents: number, payoutCents: number, patchesCents = 0) =>
  played(id, { status: 'cashed', betCents, payoutCents, patchesCents, rung: 3 });

const popped = (id: string, betCents: number, patchesCents = 0) =>
  played(id, { status: 'popped', betCents, patchesCents, rung: 2 });

function addAll(rounds: readonly RoundView[], from: LiveStats = NO_LIVE_STATS): LiveStats {
  return rounds.reduce(addRound, from);
}

describe('addRound', () => {
  it('starts empty', () => {
    expect(NO_LIVE_STATS).toMatchObject({
      rounds: 0,
      wins: 0,
      losses: 0,
      wageredCents: 0,
      paidOutCents: 0,
      netCents: 0,
      profit: [],
    });
  });

  it('counts a cash-out above the bet as a win and a pop as a loss', () => {
    const stats = addAll([cashed('a', 100, 250), popped('b', 300)]);
    expect(stats).toMatchObject({
      rounds: 2,
      wins: 1,
      losses: 1,
      wageredCents: 400,
      paidOutCents: 250,
      netCents: -150,
    });
  });

  it('counts a round once, however many times it is added', () => {
    const once = addRound(NO_LIVE_STATS, cashed('a', 100, 250));
    // The same round again: a re-render, a fresh copy of the state, or a
    // conflict answer carrying it (with its after-round reveal filled in).
    const again = addRound(once, {
      ...cashed('a', 100, 250),
      balloons: [
        balloon({
          status: 'cashed',
          betCents: 100,
          payoutCents: 250,
          rung: 3,
          afterRound: { outcome: 'popped', reachedRung: 4, reachedMultiplierHundredths: 300 },
        }),
      ],
    });
    expect(again).toBe(once);
    expect(again.rounds).toBe(1);
    expect(again.profit).toHaveLength(1);
  });

  it('ignores a round still in play', () => {
    const live = round([balloon({ status: 'active', rung: 2 })], { id: 'a' });
    expect(addRound(NO_LIVE_STATS, live)).toBe(NO_LIVE_STATS);
  });

  it('puts every Patch into wagered and the net', () => {
    const stats = addRound(NO_LIVE_STATS, cashed('a', 100, 150, 37));
    expect(stats.wageredCents).toBe(137);
    expect(stats.netCents).toBe(13);
    expect(stats.wins).toBe(1);
  });

  it('counts a cash-out that Patches made cost more than it paid as a loss', () => {
    const stats = addRound(NO_LIVE_STATS, cashed('a', 100, 150, 60));
    expect(stats.netCents).toBe(-10);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(1);
  });

  it('counts a break-even round as a round, but neither a win nor a loss', () => {
    // A 10-cent bet cashed out at 1.01x pays 10 cents (payouts floor).
    const stats = addRound(NO_LIVE_STATS, cashed('a', 10, 10));
    expect(stats).toMatchObject({ rounds: 1, wins: 0, losses: 0, netCents: 0, wageredCents: 10 });
    expect(stats.profit).toEqual([{ round: 1, netCents: 0 }]);
  });

  it('leaves a refunded bet out of every figure', () => {
    // The 24-hour rule: the pumped balloon cashed out, the unpumped one was refunded.
    const r = round(
      [
        balloon({ status: 'cashed', betCents: 200, payoutCents: 150, rung: 1 }),
        balloon({ status: 'refunded', betCents: 500 }),
      ],
      { id: 'a' },
    );
    const stats = addRound(NO_LIVE_STATS, r);
    expect(stats).toMatchObject({
      rounds: 1,
      wageredCents: 200,
      paidOutCents: 150,
      netCents: -50,
      losses: 1,
    });
  });

  it('does not count a round whose bets were all refunded', () => {
    const r = round(
      [balloon({ status: 'refunded', betCents: 100 }), balloon({ status: 'refunded', betCents: 300 })],
      { id: 'a' },
    );
    expect(addRound(NO_LIVE_STATS, r)).toBe(NO_LIVE_STATS);
  });

  it('judges a round of several balloons as a whole', () => {
    const r = round(
      [
        balloon({ status: 'popped', betCents: 100, rung: 1 }),
        balloon({ status: 'cashed', betCents: 100, payoutCents: 150, rung: 2 }),
      ],
      { id: 'a' },
    );
    const stats = addRound(NO_LIVE_STATS, r);
    expect(stats).toMatchObject({ rounds: 1, wins: 0, losses: 1, wageredCents: 200, netCents: -50 });
  });

  it('draws the running net after each round, from round 1', () => {
    const stats = addAll([popped('a', 100), cashed('b', 100, 400), cashed('c', 10, 10), popped('d', 50)]);
    expect(stats.profit).toEqual([
      { round: 1, netCents: -100 },
      { round: 2, netCents: 200 },
      { round: 3, netCents: 200 },
      { round: 4, netCents: 150 },
    ]);
    expect(stats.netCents).toBe(stats.profit.at(-1)?.netCents);
  });

  it('adds large amounts exactly, in whole cents', () => {
    // Three balloons at the largest bet, each paid the most a balloon can pay.
    const big = (id: string) =>
      round(
        [0, 1, 2].map(() =>
          balloon({ status: 'cashed', betCents: 100_000, payoutCents: 10_000_000, rung: 9 }),
        ),
        { id },
      );
    let stats = NO_LIVE_STATS;
    for (let i = 0; i < 2000; i += 1) stats = addRound(stats, big(`r${String(i)}`));
    expect(stats.wageredCents).toBe(600_000_000);
    expect(stats.paidOutCents).toBe(60_000_000_000);
    expect(stats.netCents).toBe(59_400_000_000);
    expect(stats.wins).toBe(2000);
    for (const value of [stats.wageredCents, stats.paidOutCents, stats.netCents]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    expect(stats.profit.every((point) => Number.isSafeInteger(point.netCents))).toBe(true);
    expect(formatSignedCents(stats.netCents)).toBe('+$594,000,000.00');
  });
});

describe('resetLiveStats', () => {
  it('starts the figures and the line afresh', () => {
    const before = addAll([cashed('a', 100, 250), popped('b', 100)]);
    const after = resetLiveStats(before);
    expect(after).toMatchObject({
      rounds: 0,
      wins: 0,
      losses: 0,
      wageredCents: 0,
      paidOutCents: 0,
      netCents: 0,
      profit: [],
    });
  });

  it('never counts a round from before the Reset again', () => {
    const after = resetLiveStats(addRound(NO_LIVE_STATS, cashed('a', 100, 250)));
    expect(addRound(after, cashed('a', 100, 250))).toBe(after);
  });

  it('numbers the next round 1 on the new line', () => {
    const after = resetLiveStats(addAll([popped('a', 100), popped('b', 100)]));
    expect(addRound(after, cashed('c', 100, 180)).profit).toEqual([{ round: 1, netCents: 80 }]);
  });
});

describe('watchShown', () => {
  const inPlay = (id: string) => round([balloon({ status: 'active', rung: 1 })], { id });
  const idle: readonly Beat[] = ['idle'];

  it('counts a round seen in play once its end shows with its motion', () => {
    let watch = watchShown(START_WATCH, inPlay('a'), idle);
    expect(watch.stats.rounds).toBe(0);
    watch = watchShown(watch, popped('a', 100), ['popped']);
    expect(watch.stats.rounds).toBe(1);
    expect(watch.stats.losses).toBe(1);
  });

  it('counts each end beat: pop, top and cash-out', () => {
    for (const beat of ['popped', 'top', 'cashed'] as const) {
      const watch = watchShown(watchShown(START_WATCH, inPlay('a'), idle), cashed('a', 100, 200), [
        beat,
      ]);
      expect(watch.stats.rounds).toBe(1);
    }
  });

  it('counts nothing while the round still shows in play', () => {
    // A balloon still in its press is drawn as pressed, so the round shows
    // as in play even if the server has already ended it.
    const watch = watchShown(START_WATCH, inPlay('a'), ['press']);
    expect(watch.stats).toBe(NO_LIVE_STATS);
  });

  it('does not count a finished round never seen in play here', () => {
    expect(watchShown(START_WATCH, popped('a', 100), ['popped'])).toBe(START_WATCH);
    const other = watchShown(START_WATCH, inPlay('b'), idle);
    expect(watchShown(other, popped('a', 100), ['popped'])).toBe(other);
  });

  it('does not count a round that ended with no motion (the 24-hour rule)', () => {
    const watch = watchShown(START_WATCH, inPlay('a'), idle);
    expect(watchShown(watch, cashed('a', 100, 120), ['idle'])).toBe(watch);
    expect(watchShown(watch, cashed('a', 100, 120), ['survived'])).toBe(watch);
  });

  it('counts a round once over many renders', () => {
    let watch = watchShown(START_WATCH, inPlay('a'), idle);
    const end = cashed('a', 100, 150);
    watch = watchShown(watch, end, ['cashed']);
    const counted = watch;
    // Later renders: the beat settles to idle, a fresh copy of the round comes in.
    expect(watchShown(watch, end, ['cashed'])).toBe(counted);
    expect(watchShown(watch, { ...end }, ['idle'])).toBe(counted);
    expect(watch.stats.rounds).toBe(1);
  });

  it('counts each auto-play round as it shows', () => {
    let watch = START_WATCH;
    const steps: [RoundView, Beat][] = [
      [inPlay('a'), 'idle'],
      [popped('a', 100), 'popped'],
      [inPlay('b'), 'idle'],
      [cashed('b', 100, 300), 'cashed'],
      [inPlay('c'), 'press'],
      [cashed('c', 100, 300), 'top'],
    ];
    for (const [r, beat] of steps) watch = watchShown(watch, r, [beat]);
    expect(watch.stats).toMatchObject({ rounds: 3, wins: 2, losses: 1, netCents: 300 });
  });

  it('ignores an empty screen', () => {
    expect(watchShown(START_WATCH, null, [])).toBe(START_WATCH);
  });
});

describe('thinLine', () => {
  const line = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ round: i + 1, netCents: (i % 7) - 3 }));

  it('keeps a short line as it is', () => {
    const points = line(LINE_POINTS_IN_FULL);
    expect(thinLine(points)).toBe(points);
  });

  it('keeps a long line short, its peaks and dips, and the latest round', () => {
    const points = line(5000).map((point) =>
      point.round === 1234
        ? { ...point, netCents: 99_999 }
        : point.round === 4321
          ? { ...point, netCents: -99_999 }
          : point,
    );
    const thin = thinLine(points);
    expect(thin.length).toBeLessThanOrEqual(3 * LINE_GROUPS);
    expect(thin.at(-1)).toEqual(points.at(-1));
    expect(thin.some((point) => point.netCents === 99_999)).toBe(true);
    expect(thin.some((point) => point.netCents === -99_999)).toBe(true);
    // In round order.
    expect(thin.every((point, i) => i === 0 || point.round > (thin[i - 1]?.round ?? 0))).toBe(true);
  });
});
