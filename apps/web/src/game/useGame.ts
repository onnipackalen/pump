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
import { pressMs } from './risk';
import { isOlder } from './roundOrder';
import { roundWinTier } from './winTier';

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
  /**
   * Per balloon index: the balloon as it was when its pump was pressed, kept
   * until that pump's own answer is shown; null at any other time. Another
   * balloon's answer carries the whole round, so it can hold this balloon's
   * result before its press is over (see shownRound).
   */
  readonly pressed: readonly (BalloonView | null)[];
  /**
   * Per balloon index: what its last pump did, kept until the next press.
   * The beat goes back to idle once its motion is over; this stays, so the
   * line under the balloon can still say "Patch stopped a pop".
   */
  readonly outcomes: readonly (PumpOutcome | null)[];
  /**
   * Per balloon index: its own cash-out (or top) answer ended the round in
   * a real win, so it waits a moment before it floats away and the win can
   * be seen. Decided once, when that motion starts: a balloon cashed out
   * earlier never gets it later, which would restart a float already on
   * its way.
   */
  readonly held: readonly boolean[];
  /**
   * The id of the won round whose win effects have already played, or null.
   * The art then gets no win, so the burst never plays a second time.
   */
  readonly winShownFor: string | null;
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

/*
 * A pump keeps its "press" pose at least pressMs(its published pop chance),
 * even if the server answers sooner: the time the air pocket takes to run
 * up the hose. It depends only on the chance shown before the pump, so every
 * pump at the same risk has the same beat whatever the outcome.
 */

/**
 * Every answer's beat goes back to "idle" once its motion is over, so the
 * balloon shows a still picture: its end picture ("popped" or "cashed") once
 * it is finished, or no beat at all while it is in play. Otherwise the beat
 * would stay, and switching the Animations setting would play the motion
 * again. Each wait is longer than the longest motion of that beat (see
 * balloon.css), so none is cut short.
 *
 * END_BEAT_MS: pop, top and cash-out, a win's included (the float-away is
 * 1100 ms after a 160 ms win wait).
 * SURVIVE_BEAT_MS: the spring (340 ms) and a Patch that wasn't needed
 * peeling off (80 + 280 ms).
 * SAVED_BEAT_MS: the Patch save (800 ms), with room for a late first frame
 * on a slow phone, so the falling patch halves are never cut.
 */
const END_BEAT_MS = 1500;
const SURVIVE_BEAT_MS = 450;
const SAVED_BEAT_MS = 950;

/**
 * When a Patch stops a pop, the balloon swells as if to pop, shudders and
 * the patch tears off: 800 ms (--pb-blocked-ms in balloon.css). The balloon
 * takes no new press (pump, Patch, cash-out, a hold) until it is over, so
 * nothing cuts it off halfway.
 */
const SAVED_MS = 800;

/**
 * Whether a settle timer may set a balloon back to "idle": only if nothing
 * has happened to it since. Same round, same beat, and the same number of
 * draws, so a newer pump that ended the same way keeps its own motion.
 */
export function shouldSettle(
  state: Pick<GameState, 'round' | 'beats'>,
  roundId: string,
  balloonIndex: number,
  beat: Beat,
  drawIndex: number,
): boolean {
  return (
    state.round?.id === roundId &&
    state.beats[balloonIndex] === beat &&
    state.round.balloons[balloonIndex]?.drawIndex === drawIndex
  );
}

/**
 * Whether a pump's answer leaves its balloon busy (pending) for a while:
 * only a Patch save, whose motion must not be cut by the next press.
 */
export function busyAfter(outcome: PumpOutcome): boolean {
  return outcome === 'saved';
}

/**
 * The round as the screen draws it. `round` is the newest the server has
 * sent. A balloon whose pump is still in its press is drawn as it was when
 * the pump was pressed (`pressed`), until its own answer sets its beat.
 *
 * Why: every answer carries the whole round. With Pump all, or a cash-out on
 * another balloon, an answer for balloon B can arrive holding balloon A's
 * result while A's press is still running (a riskier pump has a longer
 * press). Without this, A's result (its label, size, strain and pocket)
 * would show before A's own answer beat.
 *
 * While any balloon is held back, the round still counts as active: it was
 * active when that pump was pressed.
 */
export function shownRound(
  round: RoundView | null,
  pressed: readonly (BalloonView | null)[],
): RoundView | null {
  if (!round) return null;
  let held = false;
  const balloons = round.balloons.map((now) => {
    const was = pressed[now.index];
    if (!was || (was.drawIndex === now.drawIndex && was.status === now.status)) return now;
    held = true;
    return was;
  });
  return held ? { ...round, status: 'active', balloons } : round;
}

/**
 * The wallet as the screen draws it: without the payout of a pump that
 * reached the top but whose own answer is not shown yet (see shownRound).
 * Otherwise the balance would give that result away early. Whole cents.
 */
export function shownWallet(
  wallet: WalletView | null,
  round: RoundView | null,
  pressed: readonly (BalloonView | null)[],
): WalletView | null {
  if (!wallet || !round) return wallet;
  let heldBackCents = 0;
  for (const now of round.balloons) {
    const was = pressed[now.index];
    if (was) heldBackCents += now.payoutCents - was.payoutCents;
  }
  return heldBackCents === 0
    ? wallet
    : { ...wallet, balanceCents: wallet.balanceCents - heldBackCents };
}

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
  pressed: [],
  outcomes: [],
  held: [],
  winShownFor: null,
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

  // Sets a balloon's end beat back to "idle" once its motion is over (see
  // END_BEAT_MS), unless the round or the beat has changed since.
  const endTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = endTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  // Only if nothing has happened to the balloon since (see shouldSettle).
  const settleBeat = useCallback(
    (roundId: string, balloonIndex: number, beat: Beat, drawIndex: number, afterMs: number) => {
      const timer = setTimeout(() => {
        endTimers.current.delete(timer);
        setState((s) =>
          shouldSettle(s, roundId, balloonIndex, beat, drawIndex)
            ? { ...s, beats: replaceAt(s.beats, balloonIndex, 'idle') }
            : s,
        );
      }, afterMs);
      endTimers.current.add(timer);
    },
    [],
  );

  // A won round's effects play once. After its motion is over the round is
  // marked as shown, and the balloons stop passing the win to the art, so
  // nothing can start the burst again (say, coming back from the Verify
  // page, which remounts the balloons).
  const settleWin = useCallback((result: ActionResult) => {
    if (result.round.status !== 'finished' || roundWinTier(result.round) === null) return;
    const roundId = result.round.id;
    const timer = setTimeout(() => {
      endTimers.current.delete(timer);
      setState((s) => (s.round?.id === roundId ? { ...s, winShownFor: roundId } : s));
    }, END_BEAT_MS);
    endTimers.current.add(timer);
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
          pressed: round ? round.balloons.map(() => null) : [],
          outcomes: round ? round.balloons.map(() => null) : [],
          held: round ? round.balloons.map(() => false) : [],
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
          pressed: sameRound ? s.pressed : (round?.balloons.map(() => null) ?? []),
          outcomes: sameRound ? s.outcomes : (round?.balloons.map(() => null) ?? []),
          held: sameRound ? s.held : (round?.balloons.map(() => false) ?? []),
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
            pressed: replaceAt(next.pressed, balloonIndex, null),
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
          pressed: result.round.balloons.map(() => null),
          outcomes: result.round.balloons.map(() => null),
          held: result.round.balloons.map(() => false),
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
        // Drawn from this view until its own answer is shown (see shownRound).
        pressed: replaceAt(s.pressed, balloonIndex, balloon),
        outcomes: replaceAt(s.outcomes, balloonIndex, null),
      }));
      emit({ kind: 'press', balloon });
      try {
        const [result] = await Promise.all([
          send((key) =>
            client.pump(round.id, { balloonIndex, expectedDrawIndex: balloon.drawIndex, patch }, key),
          ),
          // The same view the art is drawn from during the press (`pressed`),
          // so the game's wait and the art's press length are one number.
          sleep(pressMs(balloon.next?.popChance)),
        ]);
        const after = result.round.balloons[balloonIndex];
        const drawIndex = after?.drawIndex ?? balloon.drawIndex + 1;
        const busy = busyAfter(result.outcome);
        setState((s) => ({
          ...s,
          beats: replaceAt(s.beats, balloonIndex, result.outcome),
          // Its own answer: from here it is drawn from the round again.
          pressed: replaceAt(s.pressed, balloonIndex, null),
          outcomes: replaceAt(s.outcomes, balloonIndex, result.outcome),
          held: replaceAt(
            s.held,
            balloonIndex,
            result.outcome === 'top' && roundWinTier(result.round) !== null,
          ),
          // A Patch save keeps the balloon busy until its motion is over.
          pending: busy ? s.pending : replaceAt(s.pending, balloonIndex, false),
        }));
        const settleMs =
          result.outcome === 'survived'
            ? SURVIVE_BEAT_MS
            : result.outcome === 'saved'
              ? SAVED_BEAT_MS
              : END_BEAT_MS;
        settleBeat(round.id, balloonIndex, result.outcome, drawIndex, settleMs);
        apply(result);
        settleWin(result);
        if (after) {
          emit({ kind: 'pump', outcome: result.outcome, balloon: after, round: result.round });
        }
        if (busy) {
          await sleep(SAVED_MS);
          // Always free the balloon, even if a resync has put another round on
          // screen meanwhile: its pending flag came from this request
          // (inFlight), which ends in the finally below.
          setState((s) =>
            balloonIndex < s.pending.length
              ? { ...s, pending: replaceAt(s.pending, balloonIndex, false) }
              : s,
          );
        }
        return result;
      } catch (error) {
        handleFailure(error, balloonIndex);
        return null;
      } finally {
        inFlight.current.delete(tag);
      }
    },
    [apply, client, emit, handleFailure, settleBeat, settleWin],
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
        const after = result.round.balloons[balloonIndex];
        setState((s) => ({
          ...s,
          beats: replaceAt(s.beats, balloonIndex, 'cashed'),
          held: replaceAt(s.held, balloonIndex, roundWinTier(result.round) !== null),
          pending: replaceAt(s.pending, balloonIndex, false),
        }));
        settleBeat(
          round.id,
          balloonIndex,
          'cashed',
          after?.drawIndex ?? balloon.drawIndex,
          END_BEAT_MS,
        );
        apply(result);
        settleWin(result);
        if (after) emit({ kind: 'cash-out', balloon: after, round: result.round });
        return result;
      } catch (error) {
        handleFailure(error, balloonIndex);
        return null;
      } finally {
        inFlight.current.delete(tag);
      }
    },
    [apply, client, emit, handleFailure, settleBeat, settleWin],
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

  // What the screen gets: a balloon in its press stays as it was pressed
  // (see shownRound). Everything inside this hook works on the real state.
  const shown = useMemo<GameState>(() => {
    const shownRoundNow = shownRound(state.round, state.pressed);
    const shownWalletNow = shownWallet(state.wallet, state.round, state.pressed);
    return shownRoundNow === state.round && shownWalletNow === state.wallet
      ? state
      : { ...state, round: shownRoundNow, wallet: shownWalletNow };
  }, [state]);

  return {
    state: shown,
    actions,
    startRound,
    pump,
    cashOut,
    setClientSeed,
    rotateSeed,
    dismissNotice,
  };
}
