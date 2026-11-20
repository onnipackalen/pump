import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, NetworkFailure, type GameClient } from '../api/client';
import type {
  ActionResult,
  BalloonView,
  FairnessView,
  PumpOutcome,
  PumpResult,
  RevealedSeed,
  RoundSummary,
  RoundView,
  WalletView,
} from '../api/contract';
import { makeClientSeed } from './clientSeed';
import { isOlder } from './roundOrder';

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
  /** Per balloon index: its last pump was bought with a Patch. */
  readonly patched: readonly boolean[];
  readonly starting: boolean;
  readonly notice: Notice | null;
  /**
   * When this visit's session started and the balance then, for the
   * session net result and time played (UK RTS 2E and 13C).
   */
  readonly session: { readonly startedAt: number; readonly startBalanceCents: number } | null;
}

/**
 * Something the player should hear or feel. Sent after the server has
 * answered, except "press", which is sent as a pump goes out.
 */
export type GameEvent =
  | { readonly kind: 'round-start'; readonly round: RoundView }
  | { readonly kind: 'press'; readonly balloon: BalloonView }
  | {
      readonly kind: 'pump';
      readonly outcome: PumpOutcome;
      readonly balloon: BalloonView;
      readonly round: RoundView;
    }
  | { readonly kind: 'cash-out'; readonly balloon: BalloonView; readonly round: RoundView };

export type GameListener = (event: GameEvent) => void;

/**
 * The player actions as promises, for auto-play. Each takes the round the
 * caller last saw and resolves with the server's answer, or null if the
 * action was refused or failed (the screen has already said why).
 *
 * These never read React state, so they are safe to call from a loop that
 * outlives the render it started in.
 */
export interface GameActions {
  readonly startRound: (
    difficultyId: string,
    betsCents: readonly number[],
  ) => Promise<ActionResult | null>;
  readonly pump: (
    round: RoundView,
    balloonIndex: number,
    patch: boolean,
  ) => Promise<PumpResult | null>;
  readonly cashOut: (round: RoundView, balloonIndex: number) => Promise<ActionResult | null>;
}

export interface Game {
  readonly state: GameState;
  /** Stable from render to render. */
  readonly actions: GameActions;
  /** Button and key handlers: act on the round currently on screen. */
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
  patched: [],
  starting: false,
  notice: null,
  session: null,
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

/**
 * All game state and actions for the screen. Talks to the server through
 * `client`. `listener` hears game events (for sound); it may change between
 * renders.
 */
export function useGame(client: GameClient, listener?: GameListener): Game {
  const [state, setState] = useState<GameState>(initialState);

  // Actions in flight, by "start" or balloon index. A ref, not state, so a
  // second click in the same moment sees the first one at once.
  const inFlight = useRef<Set<string>>(new Set());

  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });
  const emit = useCallback((event: GameEvent) => {
    listenerRef.current?.(event);
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const history = await client.getHistory(HISTORY_SIZE);
      setState((s) => ({ ...s, history }));
    } catch {
      // The list is a convenience; the next finished round tries again.
    }
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
          session: { startedAt: Date.now(), startBalanceCents: session.wallet.balanceCents },
          fairness,
          round,
          history,
          beats: round ? round.balloons.map(() => 'idle') : [],
          pending: round ? round.balloons.map(() => false) : [],
          patched: round ? round.balloons.map(() => false) : [],
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

  /** Takes in a server answer for the round and wallet, unless the screen already has newer. */
  const apply = useCallback(
    (result: ActionResult) => {
      setState((s) =>
        isOlder(result.round, s.round) ? s : { ...s, round: result.round, wallet: result.wallet },
      );
      if (result.round.status === 'finished') void refreshHistory();
    },
    [refreshHistory],
  );

  /**
   * Asks the server for the whole state again. Used when an answer may have
   * been lost, so the screen can never hide a round the server has.
   */
  const resync = useCallback(async () => {
    try {
      const session = await client.getSession();
      setState((s) => {
        const active = session.activeRound;
        // With no active round left, keep a finished round on screen, but
        // never one that still looks active.
        const round = active ?? (s.round?.status === 'active' ? null : s.round);
        const sameRound = round !== null && round.id === s.round?.id;
        return {
          ...s,
          wallet: session.wallet,
          fairness: session.fairness,
          round,
          beats: sameRound ? s.beats : (round?.balloons.map(() => 'idle' as const) ?? []),
          patched: sameRound ? s.patched : (round?.balloons.map(() => false) ?? []),
          pending: round?.balloons.map((b) => inFlight.current.has(String(b.index))) ?? [],
        };
      });
      void refreshHistory();
    } catch {
      // Still offline: the notice already says something went wrong.
    }
  }, [client, refreshHistory]);

  /** Shows what went wrong. On a 409 the server sends the state as it is now; show that. */
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
          if (round && !isOlder(round, s.round)) {
            next = { ...next, round, ...(wallet ? { wallet } : {}) };
          } else if (!round && wallet) {
            next = { ...next, wallet };
          }
        }
        return next;
      });
      // The server may have applied an action whose answer never arrived, or
      // refused one because of a round the screen doesn't show. Catch up.
      const lost = error instanceof NetworkFailure;
      const refusedForUnseenState =
        error instanceof ApiFailure &&
        (error.code === 'round_active' || (error.code === 'conflict' && !error.body.round));
      if (lost || refusedForUnseenState) void resync();
    },
    [resync],
  );

  const startRoundAction = useCallback(
    async (difficultyId: string, betsCents: readonly number[]): Promise<ActionResult | null> => {
      if (inFlight.current.has('start')) return null;
      inFlight.current.add('start');
      setState((s) => ({ ...s, starting: true, notice: null }));
      try {
        const result = await send((key) => client.startRound({ difficultyId, betsCents }, key));
        setState((s) => ({
          ...s,
          starting: false,
          round: result.round,
          wallet: result.wallet,
          beats: result.round.balloons.map(() => 'idle'),
          pending: result.round.balloons.map(() => false),
          patched: result.round.balloons.map(() => false),
        }));
        emit({ kind: 'round-start', round: result.round });
        return result;
      } catch (error) {
        setState((s) => ({ ...s, starting: false }));
        handleFailure(error, null);
        return null;
      } finally {
        inFlight.current.delete('start');
      }
    },
    [client, emit, handleFailure],
  );

  const pumpAction = useCallback(
    async (round: RoundView, balloonIndex: number, patch: boolean): Promise<PumpResult | null> => {
      const balloon = round.balloons[balloonIndex];
      if (round.status !== 'active' || !balloon || balloon.status !== 'active') return null;
      if (patch && balloon.next?.patchPriceCents == null) return null;
      const tag = String(balloonIndex);
      if (inFlight.current.has(tag)) return null;
      inFlight.current.add(tag);

      setState((s) => ({
        ...s,
        notice: null,
        beats: replaceAt(s.beats, balloonIndex, 'press'),
        pending: replaceAt(s.pending, balloonIndex, true),
        patched: replaceAt(s.patched, balloonIndex, patch),
      }));
      emit({ kind: 'press', balloon });
      try {
        const [result] = await Promise.all([
          send((key) =>
            client.pump(round.id, { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch }, key),
          ),
          sleep(MIN_PRESS_MS),
        ]);
        setState((s) => ({
          ...s,
          beats: replaceAt(s.beats, balloonIndex, result.outcome),
          pending: replaceAt(s.pending, balloonIndex, false),
        }));
        apply(result);
        const after = result.round.balloons[balloonIndex];
        if (after) {
          emit({ kind: 'pump', outcome: result.outcome, balloon: after, round: result.round });
        }
        return result;
      } catch (error) {
        handleFailure(error, balloonIndex);
        return null;
      } finally {
        inFlight.current.delete(tag);
      }
    },
    [apply, client, emit, handleFailure],
  );

  const cashOutAction = useCallback(
    async (round: RoundView, balloonIndex: number): Promise<ActionResult | null> => {
      const balloon = round.balloons[balloonIndex];
      if (round.status !== 'active' || !balloon || balloon.status !== 'active') return null;
      if (balloon.rung === 0) return null;
      const tag = String(balloonIndex);
      if (inFlight.current.has(tag)) return null;
      inFlight.current.add(tag);

      setState((s) => ({
        ...s,
        notice: null,
        pending: replaceAt(s.pending, balloonIndex, true),
      }));
      try {
        const result = await send((key) =>
          client.cashOut(round.id, { balloonIndex, expectedDrawIndex: balloon.drawIndex }, key),
        );
        setState((s) => ({
          ...s,
          beats: replaceAt(s.beats, balloonIndex, 'cashed'),
          pending: replaceAt(s.pending, balloonIndex, false),
        }));
        apply(result);
        const after = result.round.balloons[balloonIndex];
        if (after) emit({ kind: 'cash-out', balloon: after, round: result.round });
        return result;
      } catch (error) {
        handleFailure(error, balloonIndex);
        return null;
      } finally {
        inFlight.current.delete(tag);
      }
    },
    [apply, client, emit, handleFailure],
  );

  const actions = useMemo<GameActions>(
    () => ({ startRound: startRoundAction, pump: pumpAction, cashOut: cashOutAction }),
    [startRoundAction, pumpAction, cashOutAction],
  );

  const round = state.round;

  const startRound = useCallback(
    (difficultyId: string, betsCents: readonly number[]) => {
      void startRoundAction(difficultyId, betsCents);
    },
    [startRoundAction],
  );

  // The button and key handlers also check `pending` from the same render as
  // `round`. Right after an answer, the in-flight mark is gone but a key
  // handler may still hold the old round; this stops it sending a stale
  // draw index.
  const pending = state.pending;

  const pump = useCallback(
    (balloonIndex: number, patch: boolean) => {
      if (round && !pending[balloonIndex]) void pumpAction(round, balloonIndex, patch);
    },
    [pumpAction, round, pending],
  );

  const cashOut = useCallback(
    (balloonIndex: number) => {
      if (round && !pending[balloonIndex]) void cashOutAction(round, balloonIndex);
    },
    [cashOutAction, round, pending],
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
        // Rounds on the old seed can be verified now.
        void refreshHistory();
      } catch (error) {
        handleFailure(error, null);
      }
    })();
  }, [client, handleFailure, refreshHistory]);

  const dismissNotice = useCallback(() => {
    setState((s) => ({ ...s, notice: null }));
  }, []);

  return {
    state,
    actions,
    startRound,
    pump,
    cashOut,
    setClientSeed,
    rotateSeed,
    dismissNotice,
  };
}
