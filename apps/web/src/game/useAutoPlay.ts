import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoundView } from '../api/contract';
import {
  checkBeforeRound,
  maxStepsPerRound,
  nextStep,
  roundNetCents,
  type AutoPlayProgress,
  type AutoPlaySettings,
  type StopReason,
} from './autoPlay';
import type { GameActions } from './useGame';

/** Everything auto-play needs to know when it starts. */
export interface AutoPlayPlan {
  readonly settings: AutoPlaySettings;
  readonly difficultyId: string;
  readonly betsCents: readonly number[];
  readonly balanceCents: number;
}

export interface AutoPlayStatus {
  readonly running: boolean;
  /** Stop was pressed; waiting for the action in flight to come back. */
  readonly stopping: boolean;
  readonly settings: AutoPlaySettings | null;
  readonly progress: AutoPlayProgress;
  /** Why the last run stopped. Null while running or before the first run. */
  readonly stopReason: StopReason | null;
}

export interface AutoPlay {
  readonly status: AutoPlayStatus;
  readonly start: (plan: AutoPlayPlan) => void;
  readonly stop: () => void;
}

export interface AutoPlayPauses {
  /** Pause before each pump or cash-out, on top of the pump's own beat. */
  readonly stepMs: number;
  /** Pause between rounds, so each result can be seen. */
  readonly roundMs: number;
}

const SCREEN_PAUSES: AutoPlayPauses = { stepMs: 150, roundMs: 900 };

const idle: AutoPlayStatus = {
  running: false,
  stopping: false,
  settings: null,
  progress: { roundsPlayed: 0, netCents: 0 },
  stopReason: null,
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Plays rounds until a stop rule says no. Every action goes through the
 * same GameActions as a player's clicks, and the next step is worked out
 * from the server's last answer, never from a guess.
 */
export async function runAutoPlay(
  plan: AutoPlayPlan,
  actions: GameActions,
  shouldStop: () => boolean,
  report: (progress: AutoPlayProgress) => void,
  pauses: AutoPlayPauses = SCREEN_PAUSES,
): Promise<{ reason: StopReason; progress: AutoPlayProgress }> {
  const { settings } = plan;
  const roundBetCents = plan.betsCents.reduce((sum, bet) => sum + bet, 0);
  let progress: AutoPlayProgress = { roundsPlayed: 0, netCents: 0 };
  let balanceCents = plan.balanceCents;

  for (;;) {
    const blocked = checkBeforeRound(settings, progress, roundBetCents, balanceCents);
    if (blocked) return { reason: blocked, progress };
    if (progress.roundsPlayed > 0) await sleep(pauses.roundMs);
    if (shouldStop()) return { reason: 'player', progress };

    const started = await actions.startRound(plan.difficultyId, plan.betsCents);
    if (!started) return { reason: 'error', progress };
    let round: RoundView = started.round;
    balanceCents = started.wallet.balanceCents;

    const stepLimit = maxStepsPerRound(round.balloons.length, settings.targetPumps);
    for (let steps = 0; ; steps += 1) {
      const step = nextStep(round, settings.targetPumps);
      if (step.kind === 'done') break;
      if (steps >= stepLimit) return { reason: 'error', progress };
      await sleep(pauses.stepMs);
      if (shouldStop()) return { reason: 'player', progress };

      const result =
        step.kind === 'pump'
          ? await actions.pump(round, step.balloonIndex, false)
          : await actions.cashOut(round, step.balloonIndex);
      if (!result) return { reason: 'error', progress };
      round = result.round;
      balanceCents = result.wallet.balanceCents;
    }

    progress = {
      roundsPlayed: progress.roundsPlayed + 1,
      netCents: progress.netCents + roundNetCents(round),
    };
    report(progress);
  }
}

/** Runs auto-play on top of the game's actions. Stops if the screen goes away. */
export function useAutoPlay(actions: GameActions): AutoPlay {
  const [status, setStatus] = useState<AutoPlayStatus>(idle);
  const running = useRef(false);
  const stopRequested = useRef(false);

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
      setStatus({
        running: true,
        stopping: false,
        settings: plan.settings,
        progress: { roundsPlayed: 0, netCents: 0 },
        stopReason: null,
      });
      void (async () => {
        const { reason, progress } = await runAutoPlay(
          plan,
          actions,
          () => stopRequested.current,
          (latest) => setStatus((s) => ({ ...s, progress: latest })),
        );
        running.current = false;
        setStatus((s) => ({ ...s, running: false, stopping: false, progress, stopReason: reason }));
      })();
    },
    [actions],
  );

  const stop = useCallback(() => {
    if (!running.current) return;
    stopRequested.current = true;
    setStatus((s) => ({ ...s, stopping: true }));
  }, []);

  return { status, start, stop };
}
