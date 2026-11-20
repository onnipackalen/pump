/**
 * The player's "Animations: on/off" setting.
 *
 * By default the game follows the device's reduced-motion setting. The
 * player can override it; the choice is saved in this browser. It works by
 * setting data-motion on the <html> element, which balloon.css reads:
 * "reduce" removes movement but keeps exactly the same timing, so turning
 * animations off can never show results sooner (UK RTS 14E).
 */

import { useCallback, useEffect, useState } from 'react';

export type MotionChoice = 'full' | 'reduce';

const KEY = 'pump.motion';

function readChoice(): MotionChoice | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'full' || value === 'reduce' ? value : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: MotionChoice): void {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}

function systemPrefersReduced(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** What is in effect: the player's choice, or else the device setting. */
export function effectiveMotion(choice: MotionChoice | null, systemReduced: boolean): MotionChoice {
  return choice ?? (systemReduced ? 'reduce' : 'full');
}

/** The current setting and a toggle for it. */
export function useMotionSetting(): { readonly animationsOn: boolean; readonly toggle: () => void } {
  const [choice, setChoice] = useState<MotionChoice | null>(readChoice);
  const [systemReduced] = useState(systemPrefersReduced);
  const motion = effectiveMotion(choice, systemReduced);

  useEffect(() => {
    // No saved choice: leave the attribute off, so the CSS follows the device.
    if (choice === null) delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = choice;
  }, [choice]);

  const toggle = useCallback(() => {
    const next: MotionChoice = motion === 'full' ? 'reduce' : 'full';
    saveChoice(next);
    setChoice(next);
  }, [motion]);

  return { animationsOn: motion === 'full', toggle };
}
