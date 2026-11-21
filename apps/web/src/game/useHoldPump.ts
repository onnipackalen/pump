import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoundView } from '../api/contract';

/**
 * Hold to pump: while a Pump button or key is held down, the balloon is
 * pumped again and again. Each pump is still an ordinary pump, sent only
 * after the last one's answer is back, so the server sees exactly what it
 * would see from fast taps. A balloon a Patch just saved stays busy
 * (pending) until its save motion is over, so a hold waits for it too.
 */

/** What a hold keeps pumping: one balloon, or every balloon still in play. */
export type HoldTarget =
  | { readonly kind: 'one'; readonly roundId: string; readonly index: number }
  | { readonly kind: 'all'; readonly roundId: string };

/**
 * The pause between a pump's answer and the next pump of a hold, so the
 * balloon's grow can be seen before the next press.
 */
export const HOLD_GAP_MS = 250;

/**
 * Which balloons a hold pumps now. Null: the hold is over, because the
 * round changed or its balloons are no longer in play. Empty: wait, an
 * answer is still on its way (a hold on all balloons waits for all of them,
 * so they stay in step). A hold never moves on to a balloon it did not
 * start on.
 */
export function holdStep(
  round: RoundView | null,
  pending: readonly boolean[],
  hold: HoldTarget,
): readonly number[] | null {
  if (!round || round.id !== hold.roundId || round.status !== 'active') return null;
  const live = round.balloons.filter(
    (b) => b.status === 'active' && (hold.kind === 'all' || b.index === hold.index),
  );
  if (live.length === 0) return null;
  if (live.some((b) => pending[b.index] ?? false)) return [];
  return live.map((b) => b.index);
}

/**
 * Which balloons the first press of a hold pumps: every held balloon that is
 * free now. A balloon still busy (its pump on its way, or a Patch save still
 * playing) is left out of this first press instead of holding up the
 * others, the same as Pump all from the keyboard. Later steps (holdStep)
 * wait for all of them, so they fall into step. Null: nothing to hold.
 */
export function holdStartStep(
  round: RoundView | null,
  pending: readonly boolean[],
  hold: HoldTarget,
): readonly number[] | null {
  if (!round || round.id !== hold.roundId || round.status !== 'active') return null;
  const live = round.balloons.filter(
    (b) => b.status === 'active' && (hold.kind === 'all' || b.index === hold.index),
  );
  if (live.length === 0) return null;
  return live.filter((b) => !(pending[b.index] ?? false)).map((b) => b.index);
}

export interface HoldPump {
  /**
   * Pumps at once, then again after each answer until the hold ends. A
   * pointer hold ends when the finger or mouse lifts anywhere; a key hold
   * ends with `stop` (on key up). Leaving the page ends either.
   */
  readonly start: (hold: HoldTarget, by: 'pointer' | 'key') => void;
  readonly stop: () => void;
}

export function useHoldPump(
  round: RoundView | null,
  pending: readonly boolean[],
  pump: (balloonIndex: number, patch: boolean) => void,
  enabled: boolean,
): HoldPump {
  const [hold, setHold] = useState<HoldTarget | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    unlisten.current?.();
    unlisten.current = null;
    setHold(null);
  }, []);

  const start = useCallback(
    (next: HoldTarget, by: 'pointer' | 'key') => {
      if (!enabled) return;
      const now = holdStartStep(round, pending, next);
      if (now === null) return;
      for (const index of now) pump(index, false);

      // Listen for the release from the very start, so even the quickest
      // tap can never leave a hold running.
      unlisten.current?.();
      const end = (): void => stop();
      const names = by === 'pointer' ? ['pointerup', 'pointercancel', 'blur'] : ['blur'];
      for (const name of names) window.addEventListener(name, end);
      document.addEventListener('visibilitychange', end);
      unlisten.current = () => {
        for (const name of names) window.removeEventListener(name, end);
        document.removeEventListener('visibilitychange', end);
      };
      setHold(next);
    },
    [enabled, round, pending, pump, stop],
  );

  // While held: once the answer is back, wait a beat, then pump again.
  useEffect(() => {
    if (!hold || !enabled) return;
    const step = holdStep(round, pending, hold);
    if (!step || step.length === 0) return;
    const timer = setTimeout(() => {
      for (const index of step) pump(index, false);
    }, HOLD_GAP_MS);
    return () => clearTimeout(timer);
  }, [hold, enabled, round, pending, pump]);

  useEffect(() => () => unlisten.current?.(), []);

  return { start, stop };
}
