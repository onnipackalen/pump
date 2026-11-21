/**
 * Cash out by hand while auto-play runs. The press doesn't go to the
 * server itself: auto-play sends it as that balloon's next step. So a
 * balloon never gets two cash-outs, or a pump after its cash-out, and the
 * run carries on with the next round as usual.
 */
import { GAME_CONFIG, type GameConfig } from '@pump/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoundView } from '../src/api/contract';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { DemoClient } from '../src/demo/DemoClient';
import {
  addHandCashOuts,
  handCashOutsFor,
  nextSteps,
  type AutoPlaySettings,
  type HandCashOuts,
} from '../src/game/autoPlay';
import { runAutoPlay, type AutoPlayHooks, type AutoPlayStatus } from '../src/game/useAutoPlay';
import type { GameActions } from '../src/game/useGame';
import { formatCents } from '../src/money';
import { balloon, round } from './fixtures';
import { demoActions, scriptedGame, type SentRequest } from './scriptedGame';

const RTPS = [9400, 9700, 9900] as const;
const limits = GAME_CONFIG.limits;
const NO_PAUSES = { stepMs: 0, roundMs: 0 };

const settings = (overrides: Partial<AutoPlaySettings> = {}): AutoPlaySettings => ({
  rounds: 3,
  targetPumps: 5,
  stopOnProfitCents: null,
  stopOnLossCents: null,
  onWin: { kind: 'reset' },
  onLoss: { kind: 'reset' },
  ...overrides,
});

/**
 * The player's side: hand cash-outs pressed through `press` (as the screen
 * shows the round then), read by auto-play through the hooks.
 */
function player(overrides: Partial<AutoPlayHooks> = {}) {
  let asked: HandCashOuts | null = null;
  return {
    press: (seen: RoundView, indexes: readonly number[]): void => {
      asked = addHandCashOuts(asked, seen, indexes);
    },
    hooks: {
      shouldStop: () => false,
      report: () => undefined,
      handCashOuts: (roundId: string) => handCashOutsFor(asked, roundId),
      ...overrides,
    } satisfies AutoPlayHooks,
  };
}

/** Calls `before` with each pump as it goes out, before the game answers it. */
function onPump(actions: GameActions, before: (seen: RoundView, index: number) => void): GameActions {
  return {
    ...actions,
    pump: (seen, index, patch) => {
      before(seen, index);
      return actions.pump(seen, index, patch);
    },
  };
}

/**
 * No double send: per balloon of a round, at most one cash-out, and nothing
 * after it. Every request carried the balloon's draw index at the time.
 */
function expectNoDoubleSend(sent: readonly SentRequest[]): void {
  const done = new Set<string>();
  for (const request of sent) {
    if (request.kind === 'start') continue;
    const key = `${request.roundId}/${request.balloonIndex}`;
    expect(done.has(key), `a request for ${key} after its cash-out`).toBe(false);
    if (request.kind === 'cash-out') done.add(key);
  }
}

const requestsFor = (sent: readonly SentRequest[], roundId: string, index: number) =>
  sent
    .filter((r) => r.kind !== 'start' && r.roundId === roundId && r.balloonIndex === index)
    .map((r) => `${r.kind}@${r.drawIndex}`);

describe('nextSteps with hand cash-outs', () => {
  it('cashes out a pressed balloon now instead of pumping it', () => {
    const r = round([balloon({ rung: 1 }), balloon({ rung: 1 })]);
    expect(nextSteps(r, 5, new Set([0]))).toEqual([
      { kind: 'cash-out', balloonIndex: 0 },
      { kind: 'pump', balloonIndex: 1 },
    ]);
  });

  it('never asks for a cash-out with nothing to cash out, or for a balloon out of play', () => {
    const r = round([balloon({ rung: 0 }), balloon({ status: 'cashed', rung: 2 })]);
    expect(nextSteps(r, 5, new Set([0, 1]))).toEqual([{ kind: 'pump', balloonIndex: 0 }]);
  });
});

describe('addHandCashOuts', () => {
  const live = round([
    balloon({ rung: 1, cashOutCents: 101 }),
    balloon({ rung: 0 }),
    balloon({ status: 'popped' }),
  ]);

  it('takes a balloon in play with a cash-out value, once', () => {
    const asked = addHandCashOuts(null, live, [0]);
    expect(asked).toEqual({ roundId: live.id, indexes: [0] });
    // A second press changes nothing, and says so by returning the same list.
    expect(addHandCashOuts(asked, live, [0])).toBe(asked);
  });

  it('leaves out a balloon not yet pumped, or out of play', () => {
    expect(addHandCashOuts(null, live, [1, 2])).toBeNull();
    expect(addHandCashOuts(null, live, [0, 1, 2])).toEqual({ roundId: live.id, indexes: [0] });
  });

  it('starts a new list in a new round, and only reads the list for its own round', () => {
    const asked = addHandCashOuts(null, live, [0]);
    const next = round([balloon({ rung: 2, cashOutCents: 109 })], { id: 'round-2' });
    expect(addHandCashOuts(asked, next, [0])).toEqual({ roundId: 'round-2', indexes: [0] });
    expect(handCashOutsFor(asked, 'round-2').size).toBe(0);
    expect([...handCashOutsFor(asked, live.id)]).toEqual([0]);
  });
});

describe('auto-play with a cash-out by hand, scripted', () => {
  it('cashes out a balloon pressed while its pump is on its way, then plays on', async () => {
    const game = scriptedGame(1_000_000, () => false);
    const you = player();
    // The press lands while round 1's second pump is on its way.
    const actions = onPump(game.actions, (seen, i) => {
      if (seen.id === 'round-1' && i === 0 && seen.balloons[0]?.drawIndex === 1) you.press(seen, [0]);
    });
    const end = await runAutoPlay(
      { settings: settings(), difficultyId: 'easy', betsCents: [100], balanceCents: 1_000_000, limits },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(end.reason).toBe('rounds-done');
    expect(end.progress.roundsPlayed).toBe(3);
    // That pump survives; the next request is the cash-out, and the last.
    expect(requestsFor(game.sent, 'round-1', 0)).toEqual(['pump@0', 'pump@1', 'cash-out@2']);
    // The next rounds go to the target as usual.
    for (const id of ['round-2', 'round-3']) {
      expect(requestsFor(game.sent, id, 0)).toEqual([
        'pump@0',
        'pump@1',
        'pump@2',
        'pump@3',
        'pump@4',
        'cash-out@5',
      ]);
    }
    expectNoDoubleSend(game.sent);
    expect(game.balanceCents() - 1_000_000).toBe(end.progress.netCents);
  });

  it('sends nothing for a pressed balloon whose pump pops', async () => {
    // Round 1's pump from rung 1 pops.
    const game = scriptedGame(1_000_000, (n, _i, rung) => n === 1 && rung === 1);
    const you = player();
    const actions = onPump(game.actions, (seen, i) => {
      if (seen.id === 'round-1' && i === 0 && seen.balloons[0]?.drawIndex === 1) you.press(seen, [0]);
    });
    const end = await runAutoPlay(
      { settings: settings({ rounds: 2 }), difficultyId: 'easy', betsCents: [100], balanceCents: 1_000_000, limits },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(end.reason).toBe('rounds-done');
    expect(requestsFor(game.sent, 'round-1', 0)).toEqual(['pump@0', 'pump@1']);
    expect(end.progress.roundsPlayed).toBe(2);
    expectNoDoubleSend(game.sent);
  });

  it('Cash out all mid-round: each balloon cashes out once, then the next round', async () => {
    const game = scriptedGame(1_000_000, () => false);
    const you = player();
    const actions = onPump(game.actions, (seen, i) => {
      if (seen.id === 'round-1' && i === 2 && seen.balloons[2]?.drawIndex === 2) {
        you.press(seen, [0, 1, 2]);
      }
    });
    const end = await runAutoPlay(
      {
        settings: settings({ rounds: 2, targetPumps: 6 }),
        difficultyId: 'easy',
        betsCents: [100, 200, 300],
        balanceCents: 1_000_000,
        limits,
      },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(end.reason).toBe('rounds-done');
    for (const i of [0, 1, 2]) {
      expect(requestsFor(game.sent, 'round-1', i)).toEqual(['pump@0', 'pump@1', 'pump@2', 'cash-out@3']);
      expect(requestsFor(game.sent, 'round-2', i)).toHaveLength(7);
    }
    expectNoDoubleSend(game.sent);
  });

  it('Cash out on one balloon leaves the others to auto-play', async () => {
    const game = scriptedGame(1_000_000, () => false);
    const you = player();
    const actions = onPump(game.actions, (seen, i) => {
      if (seen.id === 'round-1' && i === 1 && seen.balloons[1]?.drawIndex === 1) you.press(seen, [1]);
    });
    await runAutoPlay(
      {
        settings: settings({ rounds: 1, targetPumps: 4 }),
        difficultyId: 'easy',
        betsCents: [100, 100, 100],
        balanceCents: 1_000_000,
        limits,
      },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(requestsFor(game.sent, 'round-1', 1)).toEqual(['pump@0', 'pump@1', 'cash-out@2']);
    for (const i of [0, 2]) {
      expect(requestsFor(game.sent, 'round-1', i).at(-1)).toBe('cash-out@4');
    }
    expectNoDoubleSend(game.sent);
  });

  it('Stop with a cash-out pressed: the cash-out still goes, once, then it stops', async () => {
    const game = scriptedGame(1_000_000, () => false);
    let stop = false;
    const you = player({ shouldStop: () => stop });
    const actions = onPump(game.actions, (seen, i) => {
      if (seen.id === 'round-1' && seen.balloons[i]?.drawIndex === 1 && i === 0) {
        you.press(seen, [0]);
        stop = true;
      }
    });
    const end = await runAutoPlay(
      {
        settings: settings({ rounds: 5 }),
        difficultyId: 'easy',
        betsCents: [100, 100],
        balanceCents: 1_000_000,
        limits,
      },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(end.reason).toBe('player');
    expect(requestsFor(game.sent, 'round-1', 0)).toEqual(['pump@0', 'pump@1', 'cash-out@2']);
    // The other balloon is left in play for the player, with nothing more sent.
    expect(requestsFor(game.sent, 'round-1', 1)).toEqual(['pump@0', 'pump@1']);
    expect(end.progress.roundsPlayed).toBe(0);
    expect(game.sent.filter((r) => r.kind === 'start')).toHaveLength(1);
  });

  it('counts the round when the pressed cash-out was the last balloon in play', async () => {
    const game = scriptedGame(1_000_000, () => false);
    let stop = false;
    const you = player({ shouldStop: () => stop });
    const actions = onPump(game.actions, (seen) => {
      if (seen.balloons[0]?.drawIndex === 2) {
        you.press(seen, [0]);
        stop = true;
      }
    });
    const end = await runAutoPlay(
      { settings: settings(), difficultyId: 'easy', betsCents: [100], balanceCents: 1_000_000, limits },
      actions,
      you.hooks,
      NO_PAUSES,
    );
    expect(end.reason).toBe('player');
    expect(end.progress.roundsPlayed).toBe(1);
    expect(game.balanceCents() - 1_000_000).toBe(end.progress.netCents);
  });
});

/** A small seeded random number source, so a failing run can be repeated. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe.each(RTPS)('hand cash-outs against the demo game at RTP %i', (rtpBp) => {
  const config: GameConfig = { ...GAME_CONFIG, rtpBp };

  it('never double-sends, never fails, and the net matches the wallet', async () => {
    // Cash-outs below the 6-pump target: the player's own.
    let byHand = 0;
    for (let run = 0; run < 10; run += 1) {
      const client = new DemoClient(config, 0);
      await client.setClientSeed(`hand-${rtpBp}-${run}`, crypto.randomUUID());
      const balance = (await client.getSession()).wallet.balanceCents;
      const random = seeded(rtpBp * 100 + run);
      const you = player();
      const actions = demoActions(client);
      const sent: SentRequest[] = [];
      const watching: GameActions = {
        startRound: (d, b) => actions.startRound(d, b),
        pump: (seen, i, patch) => {
          sent.push({ kind: 'pump', roundId: seen.id, balloonIndex: i, drawIndex: seen.balloons[i]?.drawIndex ?? -1, betsCents: [] });
          // Now and then the player presses Cash out on some balloon, while
          // this pump is on its way.
          if (random() < 0.3) you.press(seen, [Math.floor(random() * seen.balloons.length)]);
          return actions.pump(seen, i, patch);
        },
        cashOut: (seen, i) => {
          sent.push({ kind: 'cash-out', roundId: seen.id, balloonIndex: i, drawIndex: seen.balloons[i]?.drawIndex ?? -1, betsCents: [] });
          return actions.cashOut(seen, i);
        },
      };
      const end = await runAutoPlay(
        {
          settings: settings({ rounds: 20, targetPumps: 6, onLoss: { kind: 'increase', percent: 20 } }),
          difficultyId: 'easy',
          betsCents: [100, 50, 250].slice(0, 1 + (run % 3)),
          balanceCents: balance,
          limits,
        },
        watching,
        you.hooks,
        NO_PAUSES,
      );
      expect(end.reason).toBe('rounds-done');
      expect(end.progress.roundsPlayed).toBe(20);
      expectNoDoubleSend(sent);
      const after = await client.getSession();
      expect(after.activeRound).toBeNull();
      expect(after.wallet.balanceCents - balance).toBe(end.progress.netCents);
      byHand += sent.filter((r) => r.kind === 'cash-out' && r.drawIndex < 6).length;
    }
    expect(byHand).toBeGreaterThan(20);
  }, 60_000);
});

describe('the auto-play panel while it runs: Cash out', () => {
  const base = {
    maxPumps: GAME_CONFIG.difficulties[0]?.ladder.length ?? 1,
    roundBetCents: 300,
    betsValid: true,
    limits,
    betSizing: true,
    roundActive: false,
    starting: false,
    onStart: () => undefined,
    onStop: () => undefined,
    onCashOut: () => undefined,
  };
  const running = (overrides: Partial<AutoPlayStatus> = {}): AutoPlayStatus => ({
    running: true,
    stopping: false,
    settings: settings({ rounds: 10 }),
    progress: { roundsPlayed: 2, netCents: -150 },
    bets: { betsCents: [100, 200], held: [null, null] },
    handCashOuts: null,
    stopReason: null,
    ...overrides,
  });
  const render = (status: AutoPlayStatus, r: RoundView | null): string =>
    renderToStaticMarkup(createElement(AutoPlayPanel, { ...base, status, round: r }));
  const buttons = (html: string): string[] =>
    [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ''));

  it('one balloon: Stop and one Cash out with its amount', () => {
    const r = round([balloon({ rung: 2, cashOutCents: 109 })]);
    expect(buttons(render(running(), r))).toEqual(['Stop', `Cash out${formatCents(109)}`]);
  });

  it('three balloons: a Cash out each and Cash out all, in fixed places', () => {
    const r = round([
      balloon({ rung: 2, cashOutCents: 109 }),
      balloon({ status: 'popped' }),
      balloon({ rung: 1, cashOutCents: 202 }),
    ]);
    const asked = { roundId: r.id, indexes: [2] };
    expect(buttons(render(running({ handCashOuts: asked }), r))).toEqual([
      'Stop',
      `Cash out${formatCents(109)}`,
      'Cash out—',
      'Cash outqueued',
      `Cash out all${formatCents(109)}`,
    ]);
  });

  it('keeps the Cash out row between rounds, greyed, so the panel does not jump', () => {
    const over = round([
      balloon({ status: 'cashed', rung: 3, payoutCents: 118 }),
      balloon({ status: 'popped' }),
    ]);
    const html = render(running(), over);
    expect(buttons(html)).toEqual(['Stop', 'Cash out—', 'Cash out—', 'Cash out all—']);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });

  it('shows no Cash out once auto-play has stopped', () => {
    const r = round([balloon({ rung: 2, cashOutCents: 109 })]);
    const html = render(running({ running: false, stopReason: 'player' }), r);
    expect(buttons(html)).toEqual(['Start auto-play', 'Reset', 'Increase', 'Reset', 'Increase']);
  });
});
