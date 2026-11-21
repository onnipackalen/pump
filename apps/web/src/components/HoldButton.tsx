import type { ButtonHTMLAttributes } from 'react';
import { holdClickActs, holdDownActs } from '../game/controls';
import { useShownGuard } from '../game/useShownGuard';

interface HoldButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick' | 'onPointerDown'> {
  /** A finger or mouse went down on it: act now, and keep acting while it is held. */
  readonly onHoldStart: () => void;
  /** Pressed from the keyboard (Enter, or Space while it has focus): act once. */
  readonly onPress: () => void;
  /**
   * Set on a button that appears where another one was (the big Pump, in
   * the Bet button's place): it ignores any press that began before it
   * appeared or less than this long after (see BET_GUARD_MS).
   */
  readonly guardMs?: number;
}

/**
 * A button that acts the moment a finger or mouse goes down on it, and keeps
 * acting while it is held (the hold itself lives in useHoldPump). From the
 * keyboard it acts once per press.
 */
export function HoldButton({ onHoldStart, onPress, guardMs, className, ...rest }: HoldButtonProps) {
  const { guard, ref } = useShownGuard(guardMs);

  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      // Says the guard is on (the tests and a live check look for it).
      data-guard-ms={guardMs}
      className={className ? `${className} hold` : 'hold'}
      onPointerDown={(event) => {
        if (holdDownActs(guard, event, performance.now(), rest.disabled === true)) onHoldStart();
      }}
      // A mouse press doesn't take focus, so Space keeps meaning "pump the
      // picked balloon", and holding Space keeps pumping it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        // The slot around a balloon's button also picks the balloon on a click.
        event.stopPropagation();
        // A finger or mouse already acted on pointer down. Only a click from
        // the keyboard (detail 0) acts here.
        if (holdClickActs(guard, event, performance.now())) onPress();
      }}
      // A long press on a phone must not open a menu.
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
