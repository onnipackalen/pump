import { useLayoutEffect, useState, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { BET_GUARD_MS, pressGuard } from '../game/controls';

interface GuardedButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onPointerDown'> {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * A button that starts a round (Bet, Start auto-play). It sits where the big
 * Pump button is during a round, so it ignores a click whose press began
 * before it appeared or less than BET_GUARD_MS after: a quick tap on Pump
 * as the balloon pops, or a tap that began on Pump and lifted here, must
 * never place a bet.
 */
export function GuardedButton({ onClick, ...rest }: GuardedButtonProps) {
  const [guard] = useState(() => pressGuard(BET_GUARD_MS));
  // Committed to the page: it is on screen from now on.
  useLayoutEffect(() => {
    guard.shown(performance.now());
  }, [guard]);

  return (
    <button
      type="button"
      {...rest}
      onPointerDown={(event) => {
        guard.pointerDown(event.timeStamp, performance.now());
      }}
      onClick={(event) => {
        if (guard.click(event.detail, event.timeStamp, performance.now())) onClick(event);
      }}
    />
  );
}
