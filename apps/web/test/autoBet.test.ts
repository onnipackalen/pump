/**
 * Auto-bet: auto-play changing the bets by itself after a win or a loss.
 * The bet change itself (whole cents, rounded down, kept inside the bet
 * limits), the stop-on-loss look-ahead with growing bets, and the form.
 * The market's off switch is in market.test.ts.
 */
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoundView } from '../src/api/contract';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { DemoClient } from '../src/demo/DemoClient';
import {
  changeBet,
  checkAutoPlayForm,
  describeHeld,
  describeStop,
  enteredBets,
  nextBets,
  roundNetCents,
  roundWon,
  type AutoPlayForm,
  type AutoPlaySettings,
  type BetChange,
} from '../src/game/autoPlay';
import { roundProgress } from '../src/game/roundOrder';
import { runAutoPlay, type AutoPlayHooks, type AutoPlayStatus } from '../src/game/useAutoPlay';
import type { GameActions } from '../src/game/useGame';
import { formatCents } from '../src/money';
import { balloon, round } from './fixtures';
import { demoActions, scriptedGame } from './scriptedGame';

const RTPS = [9400, 9700, 9900] as const;
const limits = GAME_CONFIG.limits;
const NO_PAUSES = { stepMs: 0, roundMs: 0 };

const RESET: BetChange = { kind: 'reset' };
const up = (percent: number): BetChange => ({ kind: 'increase', percent });

const settings = (overrides: Partial<AutoPlaySettings> = {}): AutoPlaySettings => ({
  rounds: 10,
  targetPumps: 3,
  stopOnProfitCents: null,
  stopOnLossCents: null,
  onWin: RESET,
  onLoss: RESET,
  ...overrides,
});

const hooks = (overrides: Partial<AutoPlayHooks> = {}): AutoPlayHooks => ({
  shouldStop: () => false,
  report: () => undefined,
  handCashOuts: () => new Set(),
  ...overrides,
});

/** floor(current * (100 + percent) / 100), worked out with BigInt as a check. */
const expected = (current: number, percent: number): number =>
  Number((BigInt(current) * BigInt(100 + percent)) / 100n);

describe('changeBet: one balloon, one change', () => {
  it('reset goes back to the bet entered, whatever the bet is now', () => {
    expect(changeBet(800, 100, RESET, limits)).toEqual({ cents: 100, held: null });
    expect(changeBet(100, 100, RESET, limits)).toEqual({ cents: 100, held: null });
  });

  it('increase multiplies in whole cents', () => {
    expect(changeBet(100, 100, up(50), limits)).toEqual({ cents: 150, held: null });
    expect(changeBet(100, 100, up(100), limits)).toEqual({ cents: 200, held: null });
    // 1000% makes a bet 11 times as big.
    expect(changeBet(100, 100, up(1000), limits)).toEqual({ cents: 1100, held: null });
    // 0% leaves it as it is.
    expect(changeBet(437, 100, up(0), limits)).toEqual({ cents: 437, held: null });
  });

  it('rounds down to the cent, never up', () => {
    // $2.25 up 50% is $3.375: $3.37.
    expect(changeBet(225, 100, up(50), limits).cents).toBe(337);
    // $0.33 up 10% is $0.363: $0.36.
    expect(changeBet(33, 33, up(10), limits).cents).toBe(36);
    // $9.99 up 1% is $10.0899: $10.08.
    expect(changeBet(999, 999, up(1), limits).cents).toBe(1008);
  });

  it('agrees with exact whole-number arithmetic for every bet and percent tried', () => {
    for (let current = limits.minBetCents; current <= limits.maxBetCents; current += 997) {
      for (let percent = 0; percent <= 1000; percent += 7) {
        const want = Math.min(expected(current, percent), limits.maxBetCents);
        expect(changeBet(current, current, up(percent), limits).cents).toBe(want);
      }
    }
  });

  it('keeps to the 10-cent floor: a $0.10 bet up 5% is $0.105, so it stays $0.10', () => {
    expect(limits.minBetCents).toBe(10);
    expect(changeBet(10, 10, up(5), limits)).toEqual({ cents: 10, held: null });
    expect(changeBet(10, 10, up(9), limits)).toEqual({ cents: 10, held: null });
    expect(changeBet(10, 10, up(10), limits)).toEqual({ cents: 11, held: null });
    // Nothing ever lands under the floor, even from a bet below it.
    expect(changeBet(5, 5, up(0), limits)).toEqual({ cents: 10, held: 'min' });
    expect(changeBet(500, 5, RESET, limits)).toEqual({ cents: 10, held: 'min' });
  });

  it('holds at the maximum bet, and says so', () => {
    expect(changeBet(60_000, 100, up(100), limits)).toEqual({ cents: limits.maxBetCents, held: 'max' });
    expect(changeBet(limits.maxBetCents, 100, up(1), limits)).toEqual({
      cents: limits.maxBetCents,
      held: 'max',
    });
    // Exactly at the maximum is not held.
    expect(changeBet(50_000, 100, up(100), limits)).toEqual({ cents: 100_000, held: null });
    // The largest product stays a safe whole number.
    expect(Number.isSafeInteger(limits.maxBetCents * 1100)).toBe(true);
  });
});

describe('roundWon and nextBets: the round decides, every balloon changes', () => {
  const won = round([
    balloon({ status: 'cashed', betCents: 100, rung: 3, payoutCents: 118 }),
    balloon({ status: 'popped', betCents: 10 }),
  ]);
  const lost = round([
    balloon({ status: 'cashed', betCents: 100, rung: 1, payoutCents: 101 }),
    balloon({ status: 'popped', betCents: 100 }),
  ]);
  // Paid back exactly what it cost: not a win.
  const even = round([balloon({ status: 'cashed', betCents: 10, rung: 1, payoutCents: 10 })]);
  // One balloon won, two were refunded unplayed (void): a win.
  const withRefunds = round([
    balloon({ status: 'cashed', betCents: 100, rung: 1, payoutCents: 101 }),
    balloon({ status: 'refunded', betCents: 100 }),
    balloon({ status: 'refunded', betCents: 100 }),
  ]);

  it('counts a win exactly as the screen does: payout above the stake, refunds void', () => {
    expect(roundWon(won)).toBe(true);
    expect(roundWon(lost)).toBe(false);
    expect(roundWon(even)).toBe(false);
    expect(roundNetCents(even)).toBe(0);
    expect(roundWon(withRefunds)).toBe(true);
  });

  it('applies On win after a win and On loss otherwise, to each balloon', () => {
    const s = { onWin: up(50), onLoss: up(100) };
    expect(nextBets([100, 10], [100, 10], won, s, limits).betsCents).toEqual([150, 15]);
    expect(nextBets([100, 100], [100, 100], lost, s, limits).betsCents).toEqual([200, 200]);
    expect(nextBets([10], [10], even, s, limits).betsCents).toEqual([20]);
  });

  it('resets each balloon to its own entered bet', () => {
    const s = { onWin: RESET, onLoss: up(100) };
    expect(nextBets([800, 80], [100, 10], won, s, limits)).toEqual({
      betsCents: [100, 10],
      held: [null, null],
    });
  });

  it('marks only the balloons held at a limit', () => {
    const s = { onWin: RESET, onLoss: up(100) };
    expect(nextBets([60_000, 100], [100, 100], lost, s, limits)).toEqual({
      betsCents: [limits.maxBetCents, 200],
      held: ['max', null],
    });
  });
});

describe('describeHeld: the screen says when a bet was held at a limit', () => {
  const max = formatCents(limits.maxBetCents);
  it('says nothing when every bet changed in full', () => {
    expect(describeHeld(enteredBets([100, 200]), limits)).toBeNull();
  });
  it('names the limit, and the balloons when there are several', () => {
    expect(describeHeld({ betsCents: [100_000], held: ['max'] }, limits)).toBe(
      `Bet held at the ${max} maximum.`,
    );
    expect(describeHeld({ betsCents: [100_000, 5, 100_000], held: ['max', null, 'max'] }, limits)).toBe(
      `Bets 1 and 3 held at the ${max} maximum.`,
    );
    expect(describeHeld({ betsCents: [5, 100_000], held: [null, 'max'] }, limits)).toBe(
      `Bet 2 held at the ${max} maximum.`,
    );
  });
});

describe('the stop-on-loss look-ahead with growing bets', () => {
  it('doubles after each loss, and never starts the round that could pass the limit', async () => {
    const game = scriptedGame(1_000_000, () => true);
    const end = await runAutoPlay(
      {
        settings: settings({ rounds: 100, onLoss: up(100), stopOnLossCents: 1500 }),
        difficultyId: 'easy',
        betsCents: [100],
        balanceCents: 1_000_000,
        limits,
      },
      game.actions,
      hooks(),
      NO_PAUSES,
    );
    // Down 1, 3, 7, then 15 dollars. A $16 round could end $31 down: not started.
    expect(game.sent.filter((r) => r.kind === 'start').map((r) => r.betsCents)).toEqual([
      [100],
      [200],
      [400],
      [800],
    ]);
    expect(end.reason).toBe('loss');
    expect(end.progress).toEqual({ roundsPlayed: 4, netCents: -1500 });
    expect(end.bets.betsCents).toEqual([1600]);
    expect(describeStop(end.reason, end.progress, 1600)).toContain('a $16.00 round');
  });

  it('stops when the grown bets are more than the balance', async () => {
    const game = scriptedGame(1000, () => true);
    const end = await runAutoPlay(
      {
        settings: settings({ rounds: 100, onLoss: up(100) }),
        difficultyId: 'easy',
        betsCents: [100],
        balanceCents: 1000,
        limits,
      },
      game.actions,
      hooks(),
      NO_PAUSES,
    );
    // $1 + $2 + $4 lost leaves $3, short of the next $8 round.
    expect(end.reason).toBe('balance');
    expect(end.progress.roundsPlayed).toBe(3);
    expect(game.balanceCents()).toBe(300);
    expect(game.sent.filter((r) => r.kind === 'start')).toHaveLength(3);
  });

  it('grows on win and holds at the maximum bet', async () => {
    const game = scriptedGame(100_000_000, () => false);
    const end = await runAutoPlay(
      {
        settings: settings({ rounds: 4, targetPumps: 3, onWin: up(1000) }),
        difficultyId: 'easy',
        betsCents: [1000],
        balanceCents: 100_000_000,
        limits,
      },
      game.actions,
      hooks(),
      NO_PAUSES,
    );
    expect(end.reason).toBe('rounds-done');
    expect(game.sent.filter((r) => r.kind === 'start').map((r) => r.betsCents)).toEqual([
      [1000],
      [11_000],
      [limits.maxBetCents],
      [limits.maxBetCents],
    ]);
    expect(end.bets).toEqual({ betsCents: [limits.maxBetCents], held: ['max'] });
  });

  it('with bet changes off (reset both ways) never changes a bet', async () => {
    const game = scriptedGame(1_000_000, (n) => n % 2 === 0);
    await runAutoPlay(
      {
        settings: settings({ rounds: 6 }),
        difficultyId: 'easy',
        betsCents: [130, 70],
        balanceCents: 1_000_000,
        limits,
      },
      game.actions,
      hooks(),
      NO_PAUSES,
    );
    for (const start of game.sent.filter((r) => r.kind === 'start')) {
      expect(start.betsCents).toEqual([130, 70]);
    }
  });
});

describe.each(RTPS)('auto-bet against the demo game at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };

  it('follows nextBets round after round, keeps to the loss limit, and matches the wallet', async () => {
    for (let run = 0; run < 12; run += 1) {
      const client = new DemoClient(config, 0);
      await client.setClientSeed(`auto-bet-${rtpBp}-${run}`, crypto.randomUUID());
      const balance = (await client.getSession()).wallet.balanceCents;
      const actions = demoActions(client);
      const starts: (readonly number[])[] = [];
      const ends = new Map<string, RoundView>();
      const keep = (r: RoundView): void => {
        const had = ends.get(r.id);
        if (!had || roundProgress(r) > roundProgress(had)) ends.set(r.id, r);
      };
      const watching: GameActions = {
        startRound: async (d, b) => {
          starts.push(b);
          const result = await actions.startRound(d, b);
          if (result) keep(result.round);
          return result;
        },
        pump: async (r, i, p) => {
          const result = await actions.pump(r, i, p);
          if (result) keep(result.round);
          return result;
        },
        cashOut: async (r, i) => {
          const result = await actions.cashOut(r, i);
          if (result) keep(result.round);
          return result;
        },
      };
      const s = settings({
        rounds: 40,
        targetPumps: 2 + (run % 3),
        onWin: run % 2 === 0 ? RESET : up(25),
        onLoss: up(50 + run * 10),
        stopOnLossCents: 5000,
      });
      const entered = [100, 35, 1000].slice(0, 1 + (run % 3));
      const end = await runAutoPlay(
        { settings: s, difficultyId: 'medium', betsCents: entered, balanceCents: balance, limits },
        watching,
        hooks(),
        NO_PAUSES,
      );
      expect(['loss', 'rounds-done']).toContain(end.reason);
      expect(end.progress.netCents).toBeGreaterThanOrEqual(-5000);

      // Each round's bets are nextBets of the round before.
      const finished = [...ends.values()];
      expect(finished).toHaveLength(starts.length);
      expect(starts[0]).toEqual(entered);
      for (let k = 1; k < starts.length; k += 1) {
        const before = finished[k - 1];
        const previous = starts[k - 1];
        if (!before || !previous) throw new Error('missing round');
        expect(starts[k]).toEqual(nextBets(previous, entered, before, s, limits).betsCents);
      }
      const after = await client.getSession();
      expect(after.wallet.balanceCents - balance).toBe(end.progress.netCents);
    }
  }, 60_000);
});

describe('checkAutoPlayForm: On win and On loss', () => {
  const form = (overrides: Partial<AutoPlayForm> = {}): AutoPlayForm => ({
    rounds: '10',
    targetPumps: '3',
    stopOnProfit: '',
    stopOnLoss: '',
    onWin: 'reset',
    onWinPercent: '',
    onLoss: 'reset',
    onLossPercent: '',
    ...overrides,
  });

  it('starts as reset both ways', () => {
    const check = checkAutoPlayForm(form(), 24, 100, true);
    expect(check.settings?.onWin).toEqual(RESET);
    expect(check.settings?.onLoss).toEqual(RESET);
  });

  it('reads a whole percent from 0 to 1000', () => {
    const check = checkAutoPlayForm(
      form({ onWin: 'increase', onWinPercent: '0', onLoss: 'increase', onLossPercent: '1000' }),
      24,
      100,
      true,
    );
    expect(check.settings?.onWin).toEqual(up(0));
    expect(check.settings?.onLoss).toEqual(up(1000));
  });

  it('rejects a blank, fractional, negative or too-large percent', () => {
    for (const onLossPercent of ['', '1001', '12.5', '-5', 'ten']) {
      const check = checkAutoPlayForm(form({ onLoss: 'increase', onLossPercent }), 24, 100, true);
      expect(check.settings).toBeNull();
      expect(check.errors.onLossPercent).not.toBeNull();
    }
  });

  it('ignores the percent while the setting is reset', () => {
    const check = checkAutoPlayForm(form({ onWinPercent: 'nonsense' }), 24, 100, true);
    expect(check.settings?.onWin).toEqual(RESET);
  });

  it('with the market switch off, is always reset both ways, whatever the form holds', () => {
    const typed = form({ onWin: 'increase', onWinPercent: '50', onLoss: 'increase', onLossPercent: 'x' });
    const check = checkAutoPlayForm(typed, 24, 100, false);
    expect(check.errors.onWinPercent).toBeNull();
    expect(check.errors.onLossPercent).toBeNull();
    expect(check.settings?.onWin).toEqual(RESET);
    expect(check.settings?.onLoss).toEqual(RESET);
  });
});

describe('the auto-play panel: auto-bet', () => {
  const base = {
    ladder: GAME_CONFIG.difficulties[0]?.ladder ?? [],
    difficultyLabel: 'Easy',
    roundBetCents: 300,
    betsValid: true,
    limits,
    betSizing: true,
    roundActive: false,
    starting: false,
    round: null,
    onStart: () => undefined,
    onStop: () => undefined,
    onCashOut: () => undefined,
  };
  const status = (overrides: Partial<AutoPlayStatus> = {}): AutoPlayStatus => ({
    running: true,
    stopping: false,
    settings: settings({ rounds: 10 }),
    progress: { roundsPlayed: 2, netCents: -150 },
    bets: { betsCents: [100, 200], held: [null, null] },
    handCashOuts: null,
    stopReason: null,
    ...overrides,
  });
  const render = (s: AutoPlayStatus, betSizing = true): string =>
    renderToStaticMarkup(createElement(AutoPlayPanel, { ...base, betSizing, status: s }));

  it("shows the round's bet next to the progress while it runs", () => {
    const html = render(status());
    expect(html).toContain('Round 3 of 10');
    expect(html).toContain(`bet ${formatCents(300)}`);
  });

  it('says when a bet was held at the maximum', () => {
    const html = render(status({ bets: { betsCents: [limits.maxBetCents, 200], held: ['max', null] } }));
    expect(html).toContain(`Bet 1 held at the ${formatCents(limits.maxBetCents)} maximum.`);
  });

  it('when stopped by the loss rule, names the round that could pass it', () => {
    const html = render(
      status({ running: false, stopReason: 'loss', bets: { betsCents: [800, 800], held: [null, null] } }),
    );
    expect(html).toContain(`a ${formatCents(1600)} round could pass your loss limit`);
  });

  it('shows On win and On loss only where the market allows bet changes', () => {
    const idle = status({ running: false });
    const on = render(idle, true);
    const off = render(idle, false);
    expect(on).toContain('On win');
    expect(on).toContain('On loss');
    expect(off).not.toContain('On win');
    expect(off).not.toContain('On loss');
  });
});
