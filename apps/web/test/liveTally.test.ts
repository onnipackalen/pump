import { describe, expect, it } from 'vitest';
import type { BalloonView, RoundSummary, RoundView } from '../src/api/contract';
import { shownRound } from '../src/game/useGame';
import { formatSignedCents } from '../src/money';
import {
  addRound,
  addSummary,
  LINE_GROUPS,
  LINE_POINTS_IN_FULL,
  NO_LIVE_STATS,
  resetLiveStats,
  START_WATCH,
  thinLine,
  watchShown,
  type LiveStats,
  type LiveWatch,
  type ShownGame,
} from '../src/stats/liveTally';
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

describe('addSummary', () => {
  /** A round's line in the history list, as the server sends it. */
  const line = (id: string, more: Partial<RoundSummary> = {}): RoundSummary => ({
    id,
    difficultyId: 'easy',
    balloonCount: 1,
    betCents: 100,
    patchesCents: 0,
    payoutCents: 0,
    refundedCents: 0,
    serverSeedHash: 'hash',
    nonce: 0,
    finishedAt: '2026-11-20T00:05:00.000Z',
    seedRevealed: false,
    ...more,
  });

  it('gives the same figures as the round itself', () => {
    const r = round(
      [
        balloon({ status: 'cashed', betCents: 200, payoutCents: 330, patchesCents: 45, rung: 3 }),
        balloon({ status: 'popped', betCents: 100, patchesCents: 12, rung: 1 }),
      ],
      { id: 'a' },
    );
    const fromLine = addSummary(
      NO_LIVE_STATS,
      line('a', { balloonCount: 2, betCents: 300, patchesCents: 57, payoutCents: 330 }),
    );
    const fromRound = addRound(NO_LIVE_STATS, r);
    expect(fromLine).toEqual(fromRound);
    expect([...fromLine.counted]).toEqual(['a']);
  });

  it('counts a round once, whichever way it comes in', () => {
    const once = addRound(NO_LIVE_STATS, cashed('a', 100, 250));
    expect(addSummary(once, line('a', { payoutCents: 250 }))).toBe(once);
  });

  it('does not count a round with no bet played', () => {
    expect(addSummary(NO_LIVE_STATS, line('a', { betCents: 0, refundedCents: 100 }))).toBe(
      NO_LIVE_STATS,
    );
  });
});

describe('watchShown', () => {
  const inPlay = (id: string) => round([balloon({ status: 'active', rung: 1 })], { id });
  /** The game as the screen draws it: a round, no history list, no refusal. */
  const screen = (r: RoundView | null, more: Partial<ShownGame> = {}): ShownGame => ({
    round: r,
    history: [],
    endedElsewhere: null,
    ...more,
  });
  const watchAll = (frames: readonly ShownGame[], from: LiveWatch = START_WATCH): LiveWatch =>
    frames.reduce(watchShown, from);

  it('counts a round seen in play once its end shows', () => {
    let watch = watchShown(START_WATCH, screen(inPlay('a')));
    expect(watch.stats.rounds).toBe(0);
    watch = watchShown(watch, screen(popped('a', 100)));
    expect(watch.stats.rounds).toBe(1);
    expect(watch.stats.losses).toBe(1);
  });

  describe('a round of two balloons whose answers come out of order', () => {
    // A is pumped; its press is still running when B's cash-out answer comes
    // back carrying the whole round, already over: A popped.
    const twoInPlay = round(
      [balloon({ status: 'active', rung: 1, drawIndex: 1 }), balloon({ status: 'active', rung: 2, drawIndex: 2 })],
      { id: 'a' },
    );
    const [aAsPressed] = twoInPlay.balloons;
    const over = round(
      [
        balloon({ status: 'popped', rung: 1, drawIndex: 2 }),
        balloon({ status: 'cashed', rung: 2, drawIndex: 2, payoutCents: 150 }),
      ],
      { id: 'a' },
    );

    it('counts nothing while A is still in its press', () => {
      // The real round is over, but the screen still draws A as pressed.
      const shown = shownRound(over, [aAsPressed ?? null, null]);
      expect(shown?.status).toBe('active');
      const watch = watchAll([screen(twoInPlay), screen(shown)]);
      expect(watch.stats).toBe(NO_LIVE_STATS);
    });

    it("counts it once, when A's own answer shows its pop", () => {
      const watch = watchAll([
        screen(twoInPlay),
        screen(shownRound(over, [aAsPressed ?? null, null])),
        // A's answer: its press is over, so the round shows as it is.
        screen(shownRound(over, [null, null])),
        screen(shownRound(over, [null, null])),
      ]);
      expect(watch.stats).toMatchObject({ rounds: 1, losses: 1, wageredCents: 200, netCents: -50 });
    });

    it("counts it when A's answer is lost and the round shows over as a still picture", () => {
      // The request for A failed twice: the screen lets go of A's press with
      // no motion (every beat idle), keeps the finished round, and catches up.
      const watch = watchAll([
        screen(twoInPlay),
        screen(shownRound(over, [aAsPressed ?? null, null])),
        screen(shownRound(over, [null, null])),
      ]);
      expect(watch.stats).toMatchObject({ rounds: 1, netCents: -50 });
    });
  });

  it('does not count a round that came to the screen over, in a refusal', () => {
    // The 24-hour rule closed it, or it ended elsewhere: useGame marks it.
    const watch = watchAll([
      screen(inPlay('a')),
      screen(cashed('a', 100, 120), { endedElsewhere: 'a' }),
      screen(cashed('a', 100, 120), { endedElsewhere: 'a' }),
    ]);
    expect(watch.stats).toBe(NO_LIVE_STATS);
  });

  it('does not count a finished round never seen in play here', () => {
    expect(watchShown(START_WATCH, screen(popped('a', 100)))).toBe(START_WATCH);
    const other = watchShown(START_WATCH, screen(inPlay('b')));
    expect(watchShown(other, screen(popped('a', 100))).stats).toBe(NO_LIVE_STATS);
  });

  it('counts a round already in play when the page opened in full, its bet too', () => {
    // Restored after a refresh: the bet was placed before this page opened.
    // The figures are per round, so the round counts as the round it was.
    const watch = watchAll([screen(inPlay('a')), screen(cashed('a', 100, 101))]);
    expect(watch.stats).toMatchObject({ rounds: 1, wageredCents: 100, netCents: 1, wins: 1 });
  });

  it('counts a round once over many renders', () => {
    let watch = watchShown(START_WATCH, screen(inPlay('a')));
    const end = cashed('a', 100, 150);
    watch = watchShown(watch, screen(end));
    const counted = watch;
    // Later renders: the beat settles to idle, a fresh copy of the round comes in.
    expect(watchShown(watch, screen(end))).toBe(counted);
    expect(watchShown(watch, screen({ ...end }))).toBe(counted);
    expect(watch.stats.rounds).toBe(1);
  });

  it('counts each auto-play round as it shows', () => {
    const watch = watchAll([
      screen(inPlay('a')),
      screen(popped('a', 100)),
      screen(inPlay('b')),
      screen(cashed('b', 100, 300)),
      screen(inPlay('c')),
      screen(cashed('c', 100, 300)),
    ]);
    expect(watch.stats).toMatchObject({ rounds: 3, wins: 2, losses: 1, netCents: 300 });
  });

  describe('a round that left the screen before its end showed', () => {
    // Its last answer was lost twice; catching up found no round in play, so
    // the screen dropped it. The history list then carries its line.
    const lineOf = (id: string, more: Partial<RoundSummary> = {}): RoundSummary => ({
      id,
      difficultyId: 'easy',
      balloonCount: 1,
      betCents: 100,
      patchesCents: 0,
      payoutCents: 101,
      refundedCents: 0,
      serverSeedHash: 'hash',
      nonce: 0,
      finishedAt: '2026-11-20T00:05:00.000Z',
      seedRevealed: false,
      ...more,
    });

    it('is counted from its line in the history list, once', () => {
      const gone = watchAll([screen(inPlay('a')), screen(null)]);
      expect(gone.stats).toBe(NO_LIVE_STATS);
      const back = watchAll([screen(null, { history: [lineOf('a')] })], gone);
      expect(back.stats).toMatchObject({ rounds: 1, wageredCents: 100, netCents: 1, wins: 1 });
      // Later lists carry it again: still once.
      expect(watchShown(back, screen(null, { history: [lineOf('a')] }))).toBe(back);
    });

    it('still counts it if the next round starts before the list comes', () => {
      const watch = watchAll([
        screen(inPlay('a')),
        screen(null),
        screen(inPlay('b')),
        screen(popped('b', 50), { history: [lineOf('b', { payoutCents: 0, betCents: 50 }), lineOf('a')] }),
      ]);
      expect(watch.stats).toMatchObject({ rounds: 2, wageredCents: 150, netCents: -49 });
    });

    it('is left out when its line shows the 24-hour rule', () => {
      const gone = watchAll([screen(inPlay('a')), screen(null)]);
      // A bet handed back: only the 24-hour rule does that.
      const refunded = lineOf('a', { refundedCents: 300 });
      expect(watchShown(gone, screen(null, { history: [refunded] })).stats).toBe(NO_LIVE_STATS);
      // Or the round lasted a whole day: the rule closed it, not the player.
      const dayLong = lineOf('a', { finishedAt: '2026-11-21T00:00:00.000Z' });
      expect(watchShown(gone, screen(null, { history: [dayLong] })).stats).toBe(NO_LIVE_STATS);
    });

    it('settles: once nothing is new, the same object comes back', () => {
      const gone = watchAll([screen(inPlay('a')), screen(null)]);
      expect(watchShown(gone, screen(null))).toBe(gone);
    });
  });

  it('ignores an empty screen', () => {
    expect(watchShown(START_WATCH, screen(null))).toBe(START_WATCH);
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
