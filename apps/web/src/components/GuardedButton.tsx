import type { ButtonHTMLAttributes, MouseEvent, RefObject } from 'react';
import { BET_GUARD_MS, guardedClickActs, guardedDown } from '../game/controls';
import { useShownGuard } from '../game/useShownGuard';

interface GuardedButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onPointerDown'> {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** For a caller that moves focus to the button. */
  readonly ref?: RefObject<HTMLButtonElement | null>;
}

/**
 * A button that starts a round (Bet, Start auto-play). It sits where the big
 * Pump button is during a round, so it ignores a click whose press began
 * before it could be seen or less than BET_GUARD_MS after: a quick tap on
 * Pump as the balloon pops, or a tap that began on Pump and lifted here,
 * must never place a bet.
 */
export function GuardedButton({ onClick, ref, ...rest }: GuardedButtonProps) {
  const { guard, ref: buttonRef } = useShownGuard(BET_GUARD_MS, ref);

  return (
    <button
      type="button"
      {...rest}
      ref={buttonRef}
      // Says the guard is on (the tests and a live check look for it).
      data-guard-ms={BET_GUARD_MS}
      onPointerDown={(event) => {
        guardedDown(guard, event, performance.now());
      }}
      onClick={(event) => {
        if (guardedClickActs(guard, event, performance.now())) onClick(event);
      }}
    />
  );
}
