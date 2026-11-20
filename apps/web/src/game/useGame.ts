import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, NetworkFailure, type GameClient } from '../api/client';
import type {
  ActionResult,
  FairnessView,
  PumpOutcome,
  RevealedSeed,
  RoundSummary,
  RoundView,
  WalletView,
} from '../api/contract';
import { makeClientSeed } from './clientSeed';

/**
 * What a balloon's picture is doing right now. The balloon art reads it:
 * "press" while a pump is waiting for the server, then the outcome.
 */
export type Beat = 'idle' | 'press' | PumpOutcome | 'cashed';

export interface Notice {
  readonly tone: 'info' | 'error';
  readonly text: string;
}

export interface GameState {
  readonly phase: 'loading' | 'ready' | 'failed';
  readonly wallet: WalletView | null;
  readonly fairness: FairnessView | null;
  /** The round on screen: the active one, or the last one until the next starts. */
  readonly round: RoundView | null;
  readonly history: readonly RoundSummary[];
  readonly revealed: readonly RevealedSeed[];
  /** Per balloon index. */
  readonly beats: readonly Beat[];
  /** Per balloon index: a request for this balloon is in flight. */
  readonly pending: readonly boolean[];
  readonly starting: boolean;
  readonly notice: Notice | null;
}

export interface Game {
  readonly state: GameState;
  readonly startRound: (difficultyId: string, betsCents: readonly number[]) => void;
  readonly pump: (balloonIndex: number, patch: boolean) => void;
  readonly cashOut: (balloonIndex: number) => void;
  readonly setClientSeed: (clientSeed: string) => Promise<boolean>;
  readonly rotateSeed: () => void;
  readonly dismissNotice: () => void;
}

const HISTORY_SIZE = 10;

/**
 * A pump keeps its "press" pose at least this long, even if the server
 * answers sooner, so every pump has the same beat whatever the outcome.
 */
const MIN_PRESS_MS = 300;

const initialState: GameState = {
  phase: 'loading',
  wallet: null,
  fairness: null,
  round: null,
  history: [],
  revealed: [],
  beats: [],
  pending: [],
  starting: false,
  notice: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = [...items];
  copy[index] = value;
  return copy;
}

/**
 * Sends one player action. The key is made once and reused if the request
 * has to be retried, so the server applies the action at most once.
 */
async function send<T>(action: (key: string) => Promise<T>): Promise<T> {
  const key = crypto.randomUUID();
  try {
    return await action(key);
  } catch (error) {
    if (error instanceof NetworkFailure) return action(key);
    throw error;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure || error instanceof NetworkFailure) return error.message;
  return 'Something went wrong. Please try again.';
}

/** All game state and actions for the screen. Talks to the server through `client`. */
export function useGame(client: GameClient): Game {
  const [state, setState] = useState<GameState>(initialState);

  const refreshHistory = useCallback(async () => {
    const history = await client.getHistory(HISTORY_SIZE);
    setState((s) => ({ ...s, history }));
  }, [client]);

  // Load the session once. If a round was in progress, this restores it.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [session, history] = await Promise.all([
          client.getSession(),
          client.getHistory(HISTORY_SIZE),
        ]);
        if (cancelled) return;
        // A new player has no client seed yet: this browser makes the first one.
        const fairness =
          session.fairness.clientSeed === null
            ? await send((key) => client.setClientSeed(makeClientSeed(), key))
            : session.fairness;
        if (cancelled) return;
        const round = session.activeRound;
        setState((s) => ({
          ...s,
          phase: 'ready',
          wallet: session.wallet,
          fairness,
          round,
          history,
          beats: round ? round.balloons.map(() => 'idle') : [],
          pending: round ? round.balloons.map(() => false) : [],
        }));
      } catch (error) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          phase: 'failed',
          notice: { tone: 'error', text: describeFailure(error) },
        }));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client]);

  /** Takes in a server answer for the round and wallet. */
  const apply = useCallback(
    (result: ActionResult) => {
      setState((s) => ({ ...s, round: result.round, wallet: result.wallet }));
      if (result.round.status === 'finished') void refreshHistory();
    },
    [refreshHistory],
  );

  /** On a 409 the server sends the state as it is now; show that. */
  const handleFailure = useCallback(
    (error: unknown, balloonIndex: number | null) => {
      setState((s) => {
        let next: GameState = {
          ...s,
          notice: { tone: 'error', text: describeFailure(error) },
        };
        if (balloonIndex !== null) {
          next = {
            ...next,
            beats: replaceAt(next.beats, balloonIndex, 'idle'),
            pending: replaceAt(next.pending, balloonIndex, false),
          };
        }
        if (error instanceof ApiFailure) {
          const { round, wallet } = error.body;
          if (round) next = { ...next, round };
          if (wallet) next = { ...next, wallet };
        }
        return next;
      });
    },
    [],
  );

  const startRound = useCallback(
    (difficultyId: string, betsCents: readonly number[]) => {
      if (state.starting) return;
      setState((s) => ({ ...s, starting: true, notice: null }));
      void (async () => {
        try {
          const result = await send((key) =>
            client.startRound({ difficultyId, betsCents }, key),
          );
          setState((s) => ({
            ...s,
            starting: false,
            round: result.round,
            wallet: result.wallet,
            beats: result.round.balloons.map(() => 'idle'),
            pending: result.round.balloons.map(() => false),
          }));
        } catch (error) {
          setState((s) => ({ ...s, starting: false }));
          handleFailure(error, null);
        }
      })();
    },
    [client, handleFailure, state.starting],
  );

  const pump = useCallback(
    (balloonIndex: number, patch: boolean) => {
      const round = state.round;
      const balloon = round?.balloons[balloonIndex];
      if (!round || !balloon || balloon.status !== 'active') return;
      if (state.pending[balloonIndex]) return;
      if (patch && balloon.next?.patchPriceCents == null) return;

      setState((s) => ({
        ...s,
        notice: null,
        beats: replaceAt(s.beats, balloonIndex, 'press'),
        pending: replaceAt(s.pending, balloonIndex, true),
      }));
      void (async () => {
        try {
          const [result] = await Promise.all([
            send((key) =>
              client.pump(
                round.id,
                { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch },
                key,
              ),
            ),
            sleep(MIN_PRESS_MS),
          ]);
          setState((s) => ({
            ...s,
            beats: replaceAt(s.beats, balloonIndex, result.outcome),
            pending: replaceAt(s.pending, balloonIndex, false),
          }));
          apply(result);
        } catch (error) {
          handleFailure(error, balloonIndex);
        }
      })();
    },
    [apply, client, handleFailure, state.pending, state.round],
  );

  const cashOut = useCallback(
    (balloonIndex: number) => {
      const round = state.round;
      const balloon = round?.balloons[balloonIndex];
      if (!round || !balloon || balloon.status !== 'active' || balloon.rung === 0) return;
      if (state.pending[balloonIndex]) return;

      setState((s) => ({
        ...s,
        notice: null,
        pending: replaceAt(s.pending, balloonIndex, true),
      }));
      void (async () => {
        try {
          const result = await send((key) =>
            client.cashOut(
              round.id,
              { balloonIndex, expectedDrawIndex: balloon.drawIndex },
              key,
            ),
          );
          setState((s) => ({
            ...s,
            beats: replaceAt(s.beats, balloonIndex, 'cashed'),
            pending: replaceAt(s.pending, balloonIndex, false),
          }));
          apply(result);
        } catch (error) {
          handleFailure(error, balloonIndex);
        }
      })();
    },
    [apply, client, handleFailure, state.pending, state.round],
  );

  const setClientSeed = useCallback(
    async (clientSeed: string): Promise<boolean> => {
      try {
        const fairness = await send((key) => client.setClientSeed(clientSeed, key));
        setState((s) => ({
          ...s,
          fairness,
          notice: { tone: 'info', text: 'Client seed saved.' },
        }));
        return true;
      } catch (error) {
        handleFailure(error, null);
        return false;
      }
    },
    [client, handleFailure],
  );

  const rotateSeed = useCallback(() => {
    void (async () => {
      try {
        const result = await send((key) => client.rotateSeed(key));
        setState((s) => ({
          ...s,
          fairness: result.fairness,
          revealed: [result.revealed, ...s.revealed],
          notice: { tone: 'info', text: 'New server seed. The old one is revealed below.' },
        }));
      } catch (error) {
        handleFailure(error, null);
      }
    })();
  }, [client, handleFailure]);

  const dismissNotice = useCallback(() => {
    setState((s) => ({ ...s, notice: null }));
  }, []);

  return { state, startRound, pump, cashOut, setClientSeed, rotateSeed, dismissNotice };
}
