import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { pressGuard, watchShown, type PressGuard } from './controls';

interface ShownGuard {
  /** Null when the button has no guard. */
  readonly guard: PressGuard | null;
  /** Put this on the button. */
  readonly ref: RefObject<HTMLButtonElement | null>;
}

/**
 * The press guard for a button that appears where another one was (see
 * BET_GUARD_MS). It starts when the button can first be seen, and again
 * each time the button comes back from hidden, not only when it is put in
 * the page. With no guardMs there is no guard. `outer` is a ref the caller
 * already has for the button (to focus it), used instead of a new one.
 */
export function useShownGuard(
  guardMs: number | undefined,
  outer?: RefObject<HTMLButtonElement | null>,
): ShownGuard {
  const [guard] = useState(() => (guardMs === undefined ? null : pressGuard(guardMs)));
  const own = useRef<HTMLButtonElement>(null);
  const ref = outer ?? own;

  // In the page from now on. A hidden button (display: none, on it or on a
  // box around it) has no boxes, and ResizeObserver says when that changes.
  useLayoutEffect(() => {
    const button = ref.current;
    if (guard === null || button === null) return;
    const Observer = typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver;
    return watchShown(button, guard, () => performance.now(), Observer);
  }, [guard, ref]);

  return { guard, ref };
}
