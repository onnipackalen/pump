import type { ButtonHTMLAttributes } from 'react';

interface HoldButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick' | 'onPointerDown'> {
  /** A finger or mouse went down on it: act now, and keep acting while it is held. */
  readonly onHoldStart: () => void;
  /** Pressed from the keyboard (Enter, or Space while it has focus): act once. */
  readonly onPress: () => void;
}

/**
 * A button that acts the moment a finger or mouse goes down on it, and keeps
 * acting while it is held (the hold itself lives in useHoldPump). From the
 * keyboard it acts once per press.
 */
export function HoldButton({ onHoldStart, onPress, className, ...rest }: HoldButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={className ? `${className} hold` : 'hold'}
      onPointerDown={(event) => {
        if (event.button !== 0 || rest.disabled) return;
        onHoldStart();
      }}
      // A mouse press doesn't take focus, so Space keeps meaning "pump the
      // picked balloon", and holding Space keeps pumping it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        // The slot around a balloon's button also picks the balloon on a click.
        event.stopPropagation();
        // A finger or mouse already acted on pointer down. Only a click from
        // the keyboard (detail 0) acts here.
        if (event.detail === 0) onPress();
      }}
      // A long press on a phone must not open a menu.
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
