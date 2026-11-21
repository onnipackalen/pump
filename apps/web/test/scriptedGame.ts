import { GAME_CONFIG } from '@pump/engine';
import type { BalloonView, RoundView } from '../src/api/contract';
import type { DemoClient } from '../src/demo/DemoClient';
import type { GameActions } from '../src/game/useGame';
import { balloon, round } from './fixtures';

/** One request the scripted game was sent, in the order it got them. */
export interface SentRequest {
  readonly kind: 'start' | 'pump' | 'cash-out';
  readonly roundId: string;
  readonly balloonIndex: number;
  /** The draw index the request carried (start: -1). */
  readonly drawIndex: number;
  /** For a start: the bets. */
  readonly betsCents: readonly number[];
}

export interface ScriptedGame {
  readonly actions: GameActions;
  /** Every request, in order. */
  readonly sent: SentRequest[];
  /** Every round as it ended, in order. */
  readonly finished: RoundView[];
  readonly balanceCents: () => number;
}

/**
 * A scripted game for tests that need to know outcomes in advance. Like the
 * server, it keeps one current round, applies each request to it in turn,
 * and refuses (null) a request whose draw index is out of date or whose
 * balloon is no longer in play, so a double send shows up as a failure.
 *
 * `pops(roundNumber, balloonIndex, rung)` says whether the pump from `rung`
 * pops. A cash-out pays floor(bet * multiplier) on the configured first
 * ladder, as the engine does, in whole cents.
 */
export function scriptedGame(
  startBalanceCents: number,
  pops: (roundNumber: number, balloonIndex: number, rung: number) => boolean,
): ScriptedGame {
  const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
  let balanceCents = startBalanceCents;
  let current: RoundView | null = null;
  let rounds = 0;
  const sent: SentRequest[] = [];
  const finished: RoundView[] = [];
  const wallet = () => ({ balanceCents });

  const apply = (
    seen: RoundView,
    i: number,
    change: (b: BalloonView) => Partial<BalloonView>,
  ): RoundView | null => {
    const b = current?.balloons[i];
    if (!current || !b || current.id !== seen.id || b.status !== 'active') return null;
    if (b.drawIndex !== seen.balloons[i]?.drawIndex) return null;
    const balloons = current.balloons.map((x) => (x.index === i ? { ...x, ...change(x) } : x));
    const status = balloons.some((x) => x.status === 'active') ? 'active' : 'finished';
    current = { ...current, balloons, status };
    if (status === 'finished') finished.push(current);
    return current;
  };

  const payout = (b: BalloonView): number => {
    const product = b.betCents * (ladder[b.rung - 1] ?? 100);
    return (product - (product % 100)) / 100;
  };

  const actions: GameActions = {
    startRound: (_difficulty, betsCents) => {
      const total = betsCents.reduce((sum, bet) => sum + bet, 0);
      rounds += 1;
      const id = `round-${rounds}`;
      sent.push({ kind: 'start', roundId: id, balloonIndex: -1, drawIndex: -1, betsCents });
      if (total > balanceCents || (current && current.status === 'active')) {
        return Promise.resolve(null);
      }
      balanceCents -= total;
      current = round(
        betsCents.map((betCents) => balloon({ betCents, topRung: ladder.length })),
        { id },
      );
      return Promise.resolve({ round: current, wallet: wallet() });
    },
    pump: (seen, i) => {
      const drawIndex = seen.balloons[i]?.drawIndex ?? -1;
      sent.push({ kind: 'pump', roundId: seen.id, balloonIndex: i, drawIndex, betsCents: [] });
      const roundNumber = rounds;
      let popped = false;
      const next = apply(seen, i, (b) => {
        popped = pops(roundNumber, i, b.rung);
        if (popped) return { status: 'popped', drawIndex: b.drawIndex + 1, cashOutCents: null };
        const rung = b.rung + 1;
        const after = { ...b, rung };
        return { rung, drawIndex: b.drawIndex + 1, cashOutCents: payout(after) };
      });
      if (!next) return Promise.resolve(null);
      return Promise.resolve({
        outcome: popped ? ('popped' as const) : ('survived' as const),
        round: next,
        wallet: wallet(),
      });
    },
    cashOut: (seen, i) => {
      const drawIndex = seen.balloons[i]?.drawIndex ?? -1;
      sent.push({ kind: 'cash-out', roundId: seen.id, balloonIndex: i, drawIndex, betsCents: [] });
      const before = current?.balloons[i];
      if (!before || before.rung === 0) return Promise.resolve(null);
      const paid = payout(before);
      const next = apply(seen, i, () => ({ status: 'cashed', payoutCents: paid }));
      if (next) balanceCents += paid;
      return Promise.resolve(next ? { round: next, wallet: wallet() } : null);
    },
  };

  return { actions, sent, finished, balanceCents: () => balanceCents };
}

/** The game actions the screen uses, wired straight to a demo client. */
export function demoActions(client: DemoClient): GameActions {
  const call = <T>(action: (key: string) => Promise<T>): Promise<T | null> =>
    action(crypto.randomUUID()).catch(() => null);
  const drawIndex = (r: RoundView, i: number): number => r.balloons[i]?.drawIndex ?? -1;
  return {
    startRound: (difficultyId, betsCents) =>
      call((key) => client.startRound({ difficultyId, betsCents }, key)),
    pump: (r, i, patch) =>
      call((key) =>
        client.pump(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i), patch }, key),
      ),
    cashOut: (r, i) =>
      call((key) => client.cashOut(r.id, { balloonIndex: i, expectedDrawIndex: drawIndex(r, i) }, key)),
  };
}
