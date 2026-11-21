import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, type GameClient } from '../api/client';
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
import { rememberShownHash } from '../verify/shownHashes';
import {
  canQueueCashOut,
  cashOutsToSend,
  cashOutWaiting,
  dropQueued,
  queueCashOut,
  type QueuedCashOut,
} from './cashOutQueue';
import {
  afterFailure,
  describeFailure,
  failureNotice,
  finishedRefusal,
  LOST_SESSION_TEXT,
} from './refusal';
import { pressMs } from './risk';
import { isOlder } from './roundOrder';
import {
  ensureClientSeed,
  fairnessAfterStart,
  HISTORY_SIZE,
  openGame,
  send,
  type OpenedGame,
} from './session';
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
  /**
   * The id of a round that came to the screen already finished, in a
   * refusal: the 24-hour rule closed it, or it ended somewhere else. No
   * answer to this screen's own pump or cash-out ended it, so it was not
   * played here (the live stats leave it out). Null until that happens.
   */
  readonly endedElsewhere: string | null;
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
  /**
   * Cashes out a balloon. If its pump is still on its way, the cash-out
   * waits and is sent once that answer is in and its survive motion has
   * played, if the balloon is still in play (see cashOutQueue). Only for a
   * balloon that already has a cash-out value: during its first pump this
   * does nothing.
   */
  readonly cashOut: (balloonIndex: number) => void;
  /**
   * Per balloon index of the round on screen: a cash-out pressed while it
   * was busy is waiting to go (or on its way).
   */
  readonly waitingCashOuts: readonly boolean[];
  readonly setClientSeed: (clientSeed: string) => Promise<boolean>;
  readonly rotateSeed: () => void;
  readonly dismissNotice: () => void;
}

/*
 * A pump keeps its "press" pose at least pressMs(the balloon as pressed),
 * even if the server answers sooner: the time the air pocket takes to run
 * up the hose. It depends only on what was shown before the pump (the
 * published pop chance, placed in that balloon's own range), so every pump
 * at the same tension has the same beat whatever the outcome.
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
 * How long a pump's answer keeps its balloon busy (pending), in ms:
 * - a Patch save, for its whole motion (SAVED_MS);
 * - a pump that survived while a cash-out waits for it, for its survive
 *   beat (SURVIVE_BEAT_MS). The spring, the new number's punch, the air
 *   going in and a spent Patch peeling off all play before the balloon
 *   cashes out, instead of being cut after a few milliseconds;
 * - otherwise not at all.
 */
export function busyForMs(outcome: PumpOutcome, cashOutWaits: boolean): number {
  if (busyAfter(outcome)) return SAVED_MS;
  if (outcome === 'survived' && cashOutWaits) return SURVIVE_BEAT_MS;
  return 0;
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
  endedElsewhere: null,
  starting: false,
  notice: null,
  session: null,
};

/**
 * The state once the game has been opened (see openGame): the first load, or
 * a fresh start after the server lost this browser's session. Everything
 * from before goes: the round (a restored round in progress comes back from
 * the session), the history list, the revealed seeds, and the session net
 * and time, which start again from this balance.
 */
export function openedState(s: GameState, opened: OpenedGame, nowMs: number): GameState {
  const { session, fairness, history } = opened;
  const round = session.activeRound;
  const each = <T>(value: T): T[] => (round ? round.balloons.map(() => value) : []);
  return {
    ...s,
    phase: 'ready',
    wallet: session.wallet,
    session: { startedAt: nowMs, startBalanceCents: session.wallet.balanceCents },
    fairness,
    round,
    history,
    revealed: [],
    beats: each<Beat>('idle'),
    pending: each(false),
    patched: each(false),
    pressed: each<BalloonView | null>(null),
    outcomes: each<PumpOutcome | null>(null),
    held: each(false),
    winShownFor: null,
    endedElsewhere: null,
    starting: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = [...items];
  copy[index] = value;
  return copy;
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

  // Cash-outs pressed while their balloon was busy, sent once it is free
  // (see cashOutQueue and the effect below cashOutAction).
  const queued = useRef<readonly QueuedCashOut[]>([]);
  // The same presses as state, so the panel can show that a cash-out is
  // waiting. Changed only by presses and answers, never by the effect that
  // sends them: an entry it sends stays here, and stops counting once its
  // balloon is no longer in play (see waitingCashOuts below).
  const [waitingShown, setWaitingShown] = useState<readonly QueuedCashOut[]>([]);

  // The server-seed hash on screen now: the one a new round is bet against.
  // It is saved for each round, so the verify page can later check the
  // revealed seed against what this browser showed (verify/shownHashes).
  const shownHash = useRef<string | null>(null);
  useEffect(() => {
    shownHash.current = state.fairness?.serverSeedHash ?? null;
  }, [state.fairness]);

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
    openGame(client).then(
      (opened) => {
        if (cancelled) return;
        const nowMs = Date.now();
        setState((s) => openedState(s, opened, nowMs));
      },
      (error: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          phase: 'failed',
          notice: { tone: 'error', text: describeFailure(error) },
        }));
      },
    );
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
      // A player with no client seed could never start a round ("Set a
      // client seed"): make the first one here too, as the first load does.
      const fairness = await ensureClientSeed(client, session.fairness);
      setState((s) => {
        const active = session.activeRound;
        // With no active round left, keep a finished round on screen, but
        // never one that still looks active.
        const round = active ?? (s.round?.status === 'active' ? null : s.round);
        const sameRound = round !== null && round.id === s.round?.id;
        return {
          ...s,
          wallet: session.wallet,
          fairness,
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

  /**
   * The server no longer knows this browser's player (the cookie has gone,
   * or the server's data was reset): start over the way the first visit does,
   * with a new player, and say so. Everything from the old session goes.
   * One at a time, however many requests were refused at once.
   */
  const startingOver = useRef(false);
  const startOver = useCallback(async () => {
    if (startingOver.current) return;
    startingOver.current = true;
    queued.current = [];
    setWaitingShown([]);
    try {
      const opened = await openGame(client);
      const nowMs = Date.now();
      setState((s) => ({
        ...openedState(s, opened, nowMs),
        notice: { tone: 'info', text: LOST_SESSION_TEXT },
      }));
    } catch (error) {
      // Say why, in the server's words (it says when cookies are needed).
      setState((s) => ({ ...s, notice: { tone: 'error', text: describeFailure(error) } }));
    } finally {
      startingOver.current = false;
    }
  }, [client]);

  /**
   * Shows what went wrong (see refusal.ts). On a 409 the server sends the
   * state as it is now; show that. A refusal carrying a finished round (the
   * 24-hour rule closed it, or it ended elsewhere) is shown calmly, with no
   * win effect: nothing was won by this click.
   */
  const handleFailure = useCallback(
    (error: unknown, balloonIndex: number | null) => {
      // A cash-out waiting behind this balloon's request is dropped: the
      // request failed, so the screen can no longer be sure of its state.
      if (balloonIndex !== null) {
        queued.current = dropQueued(queued.current, balloonIndex);
        setWaitingShown((w) => dropQueued(w, balloonIndex));
      }
      const then = afterFailure(error);
      const finished = finishedRefusal(error);
      const nowMs = Date.now();
      setState((s) => {
        let next: GameState = { ...s, notice: failureNotice(error, s.round, nowMs) };
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
            // Its win effects never play: they belong to a click that won.
            if (round.status === 'finished') {
              next = { ...next, winShownFor: round.id, endedElsewhere: round.id };
            }
          } else if (!round && wallet) {
            next = { ...next, wallet };
          }
        }
        return next;
      });
      if (finished) void refreshHistory();
      if (then === 'start-over') void startOver();
      // The server may have applied an action whose answer never arrived, or
      // refused one because of a round the screen doesn't show. Catch up.
      if (then === 'resync') void resync();
    },
    [refreshHistory, resync, startOver],
  );

  const startRoundAction = useCallback(
    async (difficultyId: string, betsCents: readonly number[]): Promise<ActionResult | null> => {
      if (inFlight.current.has('start')) return null;
      inFlight.current.add('start');
      // The hash on screen as the bet goes out: the one this round is bet against.
      const hashBefore = shownHash.current;
      setState((s) => ({ ...s, starting: true, notice: null }));
      try {
        const result = await send((key) => client.startRound({ difficultyId, betsCents }, key));
        if (hashBefore !== null) rememberShownHash(result.round.id, hashBefore);
        queued.current = [];
        setWaitingShown([]);
        setState((s) => ({
          ...s,
          starting: false,
          round: result.round,
          wallet: result.wallet,
          // The round used the next nonce of these seeds: the panel moves on.
          fairness: fairnessAfterStart(result.round),
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
      // A cash-out is waiting for this balloon: the player wants out, so no
      // new pump goes before it.
      if (cashOutWaiting(queued.current, round.id, balloonIndex)) return null;
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
          sleep(pressMs(round, balloon)),
        ]);
        const after = result.round.balloons[balloonIndex];
        const drawIndex = after?.drawIndex ?? balloon.drawIndex + 1;
        const busyMs = busyForMs(
          result.outcome,
          cashOutWaiting(queued.current, round.id, balloonIndex),
        );
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
          // A Patch save, or a survive with a cash-out waiting, keeps the
          // balloon busy until its motion is over (see busyForMs).
          pending: busyMs > 0 ? s.pending : replaceAt(s.pending, balloonIndex, false),
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
        if (busyMs > 0) {
          await sleep(busyMs);
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

  // Sends each waiting cash-out once its balloon is free: its pump answered,
  // and its survive or Patch save motion is over. It runs after every change to the
  // round or to what is busy, on the newest round the screen has. A balloon
  // that popped, reached its top or is in another round is dropped, never
  // sent (see cashOutsToSend).
  const { round: realRound, pending: realPending } = state;
  useEffect(() => {
    if (queued.current.length === 0) return;
    const { send: ready, keep } = cashOutsToSend(
      queued.current,
      realRound,
      (index) => inFlight.current.has(String(index)) || (realPending[index] ?? false),
    );
    queued.current = keep;
    if (!realRound) return;
    for (const index of ready) void cashOutAction(realRound, index);
  }, [realRound, realPending, cashOutAction]);

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

  const pressed = state.pressed;

  const cashOut = useCallback(
    (balloonIndex: number) => {
      if (!round) return;
      const busy = pending[balloonIndex] ?? false;
      if (busy || inFlight.current.has(String(balloonIndex))) {
        // Its pump is still on its way: wait for the answer, then cash out
        // if it is still in play. Only for a balloon that, as the player
        // sees it (as pressed), already has a cash-out value.
        if (canQueueCashOut(round, pressed[balloonIndex] ?? round.balloons[balloonIndex])) {
          queued.current = queueCashOut(queued.current, round.id, balloonIndex);
          setWaitingShown(queued.current);
        }
        return;
      }
      void cashOutAction(round, balloonIndex);
    },
    [cashOutAction, round, pending, pressed],
  );

  // Which balloons of the round on screen have a cash-out waiting: pressed
  // while busy, and the balloon still in play (sent or not yet).
  const waitingCashOuts = useMemo<readonly boolean[]>(
    () =>
      round
        ? round.balloons.map(
            (b) => b.status === 'active' && cashOutWaiting(waitingShown, round.id, b.index),
          )
        : [],
    [round, waitingShown],
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
    waitingCashOuts,
    setClientSeed,
    rotateSeed,
    dismissNotice,
  };
}
