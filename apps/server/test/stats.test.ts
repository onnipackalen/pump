import type { HistoryResponse, PlayerStats, ProfitPoint } from '@pump/contract';
import { GAME_CONFIG } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import { int } from '../src/db/rows';
import type { PlayedRound } from '../src/repositories/rounds';
import {
  PROFIT_GROUPS,
  PROFIT_POINTS_IN_FULL,
  summarize,
  thinProfit,
} from '../src/services/stats';
import { STARTING_BALANCE_CENTS } from '../src/settings';
import {
  cashOutByHand,
  finishRound,
  firstVisit,
  insertActiveRound,
  onlyPlayerId,
  testWorld,
} from './helpers';
import { Seat } from './play';

const ORDER = GAME_CONFIG.difficulties.map((difficulty) => difficulty.id);

let nextId = 0;
/** A finished round as the repository returns it. */
function played(fields: Partial<PlayedRound>): PlayedRound {
  nextId += 1;
  return {
    id: `r${String(nextId)}`,
    difficultyId: 'easy',
    balloonsPlayed: 1,
    betCents: 1000,
    patchesCents: 0,
    payoutCents: 0,
    seedRevealed: false,
    finishedAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

describe('summarize', () => {
  it('is all zeros for a player with no rounds', () => {
    expect(summarize([], ORDER)).toEqual({
      rounds: 0,
      balloons: 0,
      wageredCents: 0,
      paidOutCents: 0,
      netCents: 0,
      profit: [],
      bestRound: null,
      byDifficulty: [],
    });
  });

  it('counts Patches as money wagered and keeps a running net', () => {
    const summary = summarize(
      [
        played({ betCents: 1000, payoutCents: 0 }),
        played({ betCents: 1000, patchesCents: 250, payoutCents: 3000 }),
        played({ balloonsPlayed: 3, betCents: 3000, payoutCents: 1200 }),
      ],
      ORDER,
    );
    expect(summary.rounds).toBe(3);
    expect(summary.balloons).toBe(5);
    expect(summary.wageredCents).toBe(5250);
    expect(summary.paidOutCents).toBe(4200);
    expect(summary.netCents).toBe(-1050);
    expect(summary.profit).toEqual([
      { round: 1, netCents: -1000 },
      { round: 2, netCents: 750 },
      { round: 3, netCents: -1050 },
    ]);
  });

  it('leaves out a round whose bets were all handed back unplayed', () => {
    const summary = summarize(
      [played({ balloonsPlayed: 0, betCents: 0 }), played({ payoutCents: 1500 })],
      ORDER,
    );
    expect(summary.rounds).toBe(1);
    expect(summary.profit).toEqual([{ round: 1, netCents: 500 }]);
    expect(summary.byDifficulty).toEqual([
      { difficultyId: 'easy', rounds: 1, wageredCents: 1000, paidOutCents: 1500, netCents: 500 },
    ]);
  });

  it('picks the biggest gain as the best win, and the earlier round on a tie', () => {
    const first = played({ payoutCents: 5000 });
    const tie = played({ payoutCents: 5000 });
    const bigPayoutSmallGain = played({ betCents: 40_000, payoutCents: 44_000 });
    const summary = summarize([played({}), first, tie, bigPayoutSmallGain], ORDER);
    expect(summary.bestRound).toBe(first);
  });

  it('never calls a round that only got its money back a win', () => {
    const evenWithPatch = played({ betCents: 1000, patchesCents: 100, payoutCents: 1100 });
    const underStake = played({ betCents: 1000, payoutCents: 990 });
    expect(summarize([evenWithPatch, underStake], ORDER).bestRound).toBeNull();
  });

  it('lists difficulties in the game’s order, then any the game no longer has', () => {
    const last = ORDER[ORDER.length - 1] ?? '';
    const first = ORDER[0] ?? '';
    const summary = summarize(
      [
        played({ difficultyId: 'retired' }),
        played({ difficultyId: last }),
        played({ difficultyId: first }),
        played({ difficultyId: last }),
      ],
      ORDER,
    );
    expect(summary.byDifficulty.map((entry) => [entry.difficultyId, entry.rounds])).toEqual([
      [first, 1],
      [last, 2],
      ['retired', 1],
    ]);
  });
});

describe('thinProfit', () => {
  /** A bumpy line: the net goes up and down, with one big peak and one big dip. */
  function line(length: number): ProfitPoint[] {
    return Array.from({ length }, (_, i) => {
      let net = ((i * 7919) % 2001) - 1000;
      if (i === Math.floor(length / 3)) net = 1_000_000;
      if (i === Math.floor((2 * length) / 3)) net = -1_000_000;
      return { round: i + 1, netCents: net };
    });
  }

  it('keeps every point of a short line', () => {
    const short = line(PROFIT_POINTS_IN_FULL);
    expect(thinProfit(short)).toEqual(short);
  });

  it.each([PROFIT_POINTS_IN_FULL + 1, 1000, 12_345, 100_000])(
    'shortens %i points but keeps the peak, the dip and the latest round',
    (length) => {
      const full = line(length);
      const thin = thinProfit(full);
      expect(thin.length).toBeLessThanOrEqual(3 * PROFIT_GROUPS);
      expect(thin.at(-1)).toEqual(full.at(-1));
      expect(Math.max(...thin.map((p) => p.netCents))).toBe(1_000_000);
      expect(Math.min(...thin.map((p) => p.netCents))).toBe(-1_000_000);
      // Real points only, in order, none twice.
      for (let i = 1; i < thin.length; i += 1) {
        expect(thin[i]?.round ?? 0).toBeGreaterThan(thin[i - 1]?.round ?? 0);
      }
      for (const point of thin) expect(full[point.round - 1]).toEqual(point);
    },
  );
});

describe('GET /api/stats', () => {
  it('is empty for a new player', async () => {
    const { app } = testWorld();
    const { cookies } = await firstVisit(app);
    const response = await app.inject({ method: 'GET', url: '/api/stats', cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json<PlayerStats>()).toEqual({
      rounds: 0,
      balloons: 0,
      wageredCents: 0,
      paidOutCents: 0,
      netCents: 0,
      profit: [],
      bestWin: null,
      byDifficulty: [],
    });
  });

  it('needs the player cookie, like every request but the session', async () => {
    const { app } = testWorld();
    const response = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(response.statusCode).toBe(401);
  });

  it('leaves out a refunded bet and gives the best win its multiplier', async () => {
    const { app, db } = testWorld();
    const { cookies } = await firstVisit(app);
    const playerId = onlyPlayerId(db);
    // Balloon 0 cashes out at rung 1 of the ladder [101, 111]; balloon 1 is refunded.
    insertActiveRound(db, playerId, 'round-1', [1000, 500]);
    cashOutByHand(db, 'round-1', 0, 1500);
    db.exec("UPDATE balloons SET status = 'refunded' WHERE balloon_index = 1");
    finishRound(db, 'round-1');
    // Every bet handed back: not a round at all.
    insertActiveRound(db, playerId, 'round-2', [700]);
    db.exec("UPDATE balloons SET status = 'refunded' WHERE round_id = 'round-2'");
    finishRound(db, 'round-2');
    // Still in play: not counted until it finishes.
    insertActiveRound(db, playerId, 'round-3', [900]);

    const stats = (await app.inject({ method: 'GET', url: '/api/stats', cookies })).json<PlayerStats>();

    expect(stats).toEqual({
      rounds: 1,
      balloons: 1,
      wageredCents: 1000,
      paidOutCents: 1500,
      netCents: 500,
      profit: [{ round: 1, netCents: 500 }],
      bestWin: {
        roundId: 'round-1',
        difficultyId: 'easy',
        netCents: 500,
        wageredCents: 1000,
        payoutCents: 1500,
        multiplierHundredths: 101,
        finishedAt: '2026-01-01T00:05:00.000Z',
        seedRevealed: false,
      },
      byDifficulty: [
        { difficultyId: 'easy', rounds: 1, wageredCents: 1000, paidOutCents: 1500, netCents: 500 },
      ],
    });
  });

  it.each([9400, 9700, 9900])('agrees with the wallet and the ledger after real play at RTP %i', async (rtpBp) => {
    const { app, db } = testWorld({ ...GAME_CONFIG, rtpBp });
    const seat = await Seat.join(app);
    const difficulties = GAME_CONFIG.difficulties.map((difficulty) => difficulty.id);

    // 40 rounds across every difficulty, 1 to 3 balloons, some with Patches.
    for (let n = 0; n < 40; n += 1) {
      const difficultyId = difficulties[n % difficulties.length] ?? 'easy';
      const bets = [1000, 250, 5000].slice(0, 1 + (n % 3));
      let round = (await seat.start(difficultyId, bets)).body.round;
      for (const balloon of round.balloons) {
        for (let pump = 0; pump < 1 + (n % 4); pump += 1) {
          const now = round.balloons[balloon.index];
          if (now?.status !== 'active') break;
          const patch = pump > 0 && n % 5 === 0;
          round = (await seat.pump(round, balloon.index, { patch })).body.round;
        }
        if (round.balloons[balloon.index]?.status === 'active') {
          round = (await seat.cashOut(round, balloon.index)).body.round;
        }
      }
      expect(round.status).toBe('finished');
    }

    const stats = (await seat.get<PlayerStats>('/api/stats')).body;
    const balance = (await seat.session()).body.wallet.balanceCents;
    const ledger = (kinds: string): number => {
      const row = db
        .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger WHERE kind IN (${kinds})`)
        .get();
      return row ? int(row, 'total') : 0;
    };

    expect(stats.rounds).toBe(40);
    expect(stats.netCents).toBe(balance - STARTING_BALANCE_CENTS);
    expect(stats.wageredCents).toBe(-ledger("'bet', 'patch'"));
    expect(stats.paidOutCents).toBe(ledger("'payout'"));
    expect(stats.profit.at(-1)).toEqual({ round: 40, netCents: stats.netCents });
    expect(stats.byDifficulty.map((entry) => entry.difficultyId)).toEqual(difficulties);
    expect(stats.byDifficulty.reduce((sum, entry) => sum + entry.rounds, 0)).toBe(40);
    expect(stats.byDifficulty.reduce((sum, entry) => sum + entry.netCents, 0)).toBe(stats.netCents);

    // The best win is the round in the history that gained the most; on a
    // tie, the earliest. The history is newest first, so that is the last one.
    const history = (await seat.get<HistoryResponse>('/api/history?limit=50')).body.rounds;
    const gains = history.map((r) => r.payoutCents - r.betCents - r.patchesCents);
    const top = Math.max(...gains);
    expect(top).toBeGreaterThan(0);
    expect(stats.bestWin?.netCents).toBe(top);
    expect(stats.bestWin?.roundId).toBe(history[gains.lastIndexOf(top)]?.id);
  });
});
