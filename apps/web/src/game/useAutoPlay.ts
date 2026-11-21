import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult, RoundView } from '../api/contract';
import {
  addHandCashOuts,
  checkBeforeRound,
  enteredBets,
  handCashOutsFor,
  maxStepsPerRound,
  nextBets,
  nextSteps,
  roundNetCents,
  totalBetCents,
  type AutoPlayProgress,
  type AutoPlaySettings,
  type AutoStep,
  type BetLimits,
  type HandCashOuts,
  type RoundBets,
  type StopReason,
} from './autoPlay';
import { roundProgress } from './roundOrder';
import type { GameActions } from './useGame';

/** Everything auto-play needs to know when it starts. */
export interface AutoPlayPlan {
  readonly settings: AutoPlaySettings;
  readonly difficultyId: string;
  /** The bets the player entered: the first round's, and what "reset" goes back to. */
  readonly betsCents: readonly number[];
  readonly balanceCents: number;
  /** The bet limits a changed bet is kept inside. */
  readonly limits: BetLimits;
}

export interface AutoPlayStatus {
  readonly running: boolean;
  /** Stop was pressed; waiting for the action in flight to come back. */
  readonly stopping: boolean;
  readonly settings: AutoPlaySettings | null;
  readonly progress: AutoPlayProgress;
  /**
   * The bets of the round in play, or of the next round between rounds. After
   * a run, the bets the next round would have had. Null before the first run.
   */
  readonly bets: RoundBets | null;
  /** Balloons the player has cashed out by hand during this run. */
  readonly handCashOuts: HandCashOuts | null;
  /** Why the last run stopped. Null while running or before the first run. */
  readonly stopReason: StopReason | null;
}

export interface AutoPlay {
  readonly status: AutoPlayStatus;
  readonly start: (plan: AutoPlayPlan) => void;
  readonly stop: () => void;
  /**
   * The player's own Cash out while auto-play runs, for these balloons of the
   * round on screen. Auto-play sends it on its next beat (see runAutoPlay).
   * A press on any round but the one auto-play is playing is ignored.
   */
  readonly cashOut: (round: RoundView, balloonIndexes: readonly number[]) => void;
}

export interface AutoPlayPauses {
  /** Pause before each pump or cash-out, on top of the pump's own beat. */
  readonly stepMs: number;
  /** Pause between rounds, so each result can be seen. */
  readonly roundMs: number;
}

/** How auto-play hears from the screen, and tells it how it is going. */
export interface AutoPlayHooks {
  /** True once the player has pressed Stop (or left). */
  readonly shouldStop: () => boolean;
  /** Called after each round: the new progress, and the next round's bets. */
  readonly report: (progress: AutoPlayProgress, bets: RoundBets) => void;
  /**
   * Called as soon as a round has started, with its id: the round auto-play
   * now plays. A hand Cash out counts only on this round (addHandCashOuts).
   */
  readonly roundStarted: (roundId: string) => void;
  /** The balloons of this round the player has cashed out by hand so far. */
  readonly handCashOuts: (roundId: string) => ReadonlySet<number>;
}

export interface AutoPlayEnd {
  readonly reason: StopReason;
  readonly progress: AutoPlayProgress;
  /** The bets the next round would have had. */
  readonly bets: RoundBets;
}

const SCREEN_PAUSES: AutoPlayPauses = { stepMs: 150, roundMs: 900 };

const idle: AutoPlayStatus = {
  running: false,
  stopping: false,
  settings: null,
  progress: { roundsPlayed: 0, netCents: 0 },
  bets: null,
  handCashOuts: null,
  stopReason: null,
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The answer that saw every change, from a beat of actions sent together.
 * The server applies requests one at a time, so the last one it applied
 * holds every balloon's latest state and the latest balance; it is the one
 * with the most round progress. Null if any action failed.
 */
export function newestAnswer(results: readonly (ActionResult | null)[]): ActionResult | null {
  let newest: ActionResult | null = null;
  for (const result of results) {
    if (!result) return null;
    if (!newest || roundProgress(result.round) > roundProgress(newest.round)) newest = result;
  }
  return newest;
}

/** Sends one beat: every step at once, each carrying its own balloon's draw index. */
async function sendBeat(
  actions: GameActions,
  round: RoundView,
  steps: readonly AutoStep[],
): Promise<ActionResult | null> {
  const results = await Promise.all(
    steps.map((step) =>
      step.kind === 'pump'
        ? actions.pump(round, step.balloonIndex, false)
        : actions.cashOut(round, step.balloonIndex),
    ),
  );
  return newestAnswer(results);
}

/**
 * Plays rounds until a stop rule says no. Every action goes through the
 * same GameActions as a player's clicks, and the next step is worked out
 * from the server's last answer, never from a guess.
 *
 * Auto-play is the only thing that sends requests while it runs. The
 * player's own Cash out doesn't go to the server directly: it is noted
 * (hooks.handCashOuts) and sent here as that balloon's next step. So a
 * balloon never has two requests on their way, a pump can't follow its
 * cash-out, and the round carries on for the other balloons as usual.
 *
 * After each round the bets change by the On win or On loss setting
 * (nextBets), and the stop rules are checked with the changed bets.
 */
export async function runAutoPlay(
  plan: AutoPlayPlan,
  actions: GameActions,
  hooks: AutoPlayHooks,
  pauses: AutoPlayPauses = SCREEN_PAUSES,
): Promise<AutoPlayEnd> {
  const { settings } = plan;
  let progress: AutoPlayProgress = { roundsPlayed: 0, netCents: 0 };
  let bets = enteredBets(plan.betsCents);
  let balanceCents = plan.balanceCents;
  const end = (reason: StopReason): AutoPlayEnd => ({ reason, progress, bets });

  for (;;) {
    const blocked = checkBeforeRound(settings, progress, totalBetCents(bets), balanceCents);
    if (blocked) return end(blocked);
    if (progress.roundsPlayed > 0) await sleep(pauses.roundMs);
    if (hooks.shouldStop()) return end('player');

    const started = await actions.startRound(plan.difficultyId, bets.betsCents);
    if (!started) return end('error');
    let round: RoundView = started.round;
    balanceCents = started.wallet.balanceCents;
    hooks.roundStarted(round.id);

    const stepLimit = maxStepsPerRound(round.balloons.length, settings.targetPumps);
    let taken = 0;
    while (nextSteps(round, settings.targetPumps).length > 0) {
      await sleep(pauses.stepMs);
      // Read after the pause, so a Cash out pressed during it goes on this beat.
      const handCashOuts = hooks.handCashOuts(round.id);
      const steps = nextSteps(round, settings.targetPumps, handCashOuts);

      if (hooks.shouldStop()) {
        // Stop leaves the balloons to the player, but a Cash out they have
        // already pressed still goes, rather than being lost. That includes
        // one pressed while these cash-outs are on their way (the button
        // said "queued"), so the list is read again after each send until
        // it has nothing new. Each send ends at least one balloon, so this
        // runs at most once per balloon.
        for (let sends = 0; sends < round.balloons.length; sends += 1) {
          const asked = hooks.handCashOuts(round.id);
          const theirs = nextSteps(round, settings.targetPumps, asked).filter(
            (step) => step.kind === 'cash-out' && asked.has(step.balloonIndex),
          );
          if (theirs.length === 0) break;
          const newest = await sendBeat(actions, round, theirs);
          if (!newest) return end('error');
          round = newest.round;
        }
        // If those were the last balloons in play, the round is over: count it.
        if (round.status === 'finished') {
          progress = {
            roundsPlayed: progress.roundsPlayed + 1,
            netCents: progress.netCents + roundNetCents(round),
          };
        }
        return end('player');
      }

      taken += steps.length;
      if (taken > stepLimit) return end('error');
      // Every balloon still in play at once. Each request carries its own
      // balloon's draw index, so they can't get in each other's way.
      const newest = await sendBeat(actions, round, steps);
      if (!newest) return end('error');
      round = newest.round;
      balanceCents = newest.wallet.balanceCents;
    }

    progress = {
      roundsPlayed: progress.roundsPlayed + 1,
      netCents: progress.netCents + roundNetCents(round),
    };
    bets = nextBets(bets.betsCents, plan.betsCents, round, settings, plan.limits);
    hooks.report(progress, bets);
  }
}

/** Runs auto-play on top of the game's actions. Stops if the screen goes away. */
export function useAutoPlay(actions: GameActions): AutoPlay {
  const [status, setStatus] = useState<AutoPlayStatus>(idle);
  const running = useRef(false);
  const stopRequested = useRef(false);
  // The player's hand cash-outs. A ref, so the loop reads the newest at once.
  const handCashOuts = useRef<HandCashOuts | null>(null);
  // The round auto-play is playing: a hand press counts only on this one.
  const playingRoundId = useRef<string | null>(null);

  // Leaving the page (or this component) stops auto-play for good: it never
  // carries on, or starts again, without the player.
  useEffect(
    () => () => {
      stopRequested.current = true;
    },
    [],
  );

  const start = useCallback(
    (plan: AutoPlayPlan) => {
      if (running.current) return;
      running.current = true;
      stopRequested.current = false;
      handCashOuts.current = null;
      playingRoundId.current = null;
      setStatus({
        running: true,
        stopping: false,
        settings: plan.settings,
        progress: { roundsPlayed: 0, netCents: 0 },
        bets: enteredBets(plan.betsCents),
        handCashOuts: null,
        stopReason: null,
      });
      void (async () => {
        const { reason, progress, bets } = await runAutoPlay(plan, actions, {
          shouldStop: () => stopRequested.current,
          report: (latest, nextRound) =>
            setStatus((s) => ({ ...s, progress: latest, bets: nextRound })),
          roundStarted: (roundId) => {
            playingRoundId.current = roundId;
          },
          handCashOuts: (roundId) => handCashOutsFor(handCashOuts.current, roundId),
        });
        running.current = false;
        handCashOuts.current = null;
        playingRoundId.current = null;
        setStatus((s) => ({
          ...s,
          running: false,
          stopping: false,
          progress,
          bets,
          handCashOuts: null,
          stopReason: reason,
        }));
      })();
    },
    [actions],
  );

  const stop = useCallback(() => {
    if (!running.current) return;
    stopRequested.current = true;
    setStatus((s) => ({ ...s, stopping: true }));
  }, []);

  const cashOut = useCallback((round: RoundView, balloonIndexes: readonly number[]) => {
    if (!running.current) return;
    const next = addHandCashOuts(
      handCashOuts.current,
      round,
      balloonIndexes,
      playingRoundId.current,
    );
    if (next === handCashOuts.current) return;
    handCashOuts.current = next;
    setStatus((s) => ({ ...s, handCashOuts: next }));
  }, []);

  return { status, start, stop, cashOut };
}
