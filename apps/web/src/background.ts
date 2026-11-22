/**
 * The player's "Background" setting: which night scene is drawn behind the
 * balloons.
 *
 * Dusk is the default. The choice is saved in this browser, like the
 * Animations setting (motion.ts). It works by setting data-bg on the
 * <html> element, which scenes/scenes.css reads; Dusk leaves the attribute
 * off, so background.css draws it as before.
 *
 * It changes the look only: no number, chance or result depends on it.
 */

import { useCallback, useLayoutEffect, useState } from 'react';

/** Every scene, in the order Settings lists them. top and horizon are its sky, for the swatch. */
export const BACKGROUNDS = [
  { id: 'dusk', name: 'Dusk', top: '#17203c', horizon: '#26387a' },
  { id: 'desert', name: 'Desert', top: '#120c2a', horizon: '#3d2450' },
  { id: 'dessert', name: 'Dessert', top: '#1d1020', horizon: '#3b1d33' },
  { id: 'arctic', name: 'Arctic', top: '#0a1430', horizon: '#1f3560' },
  { id: 'mountain', name: 'Mountain', top: '#0b1026', horizon: '#22264a' },
  { id: 'fair', name: 'Fairground', top: '#12122a', horizon: '#2e1c3c' },
  { id: 'city', name: 'City', top: '#0d1226', horizon: '#1e2748' },
  { id: 'orbit', name: 'Orbit', top: '#05060d', horizon: '#121733' },
] as const;

export type BackgroundId = (typeof BACKGROUNDS)[number]['id'];

export const DEFAULT_BACKGROUND: BackgroundId = 'dusk';

const KEY = 'pump.background';

/** A saved value, or Dusk if it is missing or not a scene we have. */
export function parseBackground(value: string | null): BackgroundId {
  return BACKGROUNDS.find((scene) => scene.id === value)?.id ?? DEFAULT_BACKGROUND;
}

function readChoice(): BackgroundId {
  try {
    return parseBackground(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_BACKGROUND;
  }
}

function saveChoice(id: BackgroundId): void {
  try {
    if (id === DEFAULT_BACKGROUND) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, id);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}

/** index.html's theme-color, Dusk's page colour, read once before any scene changes it. */
let duskBarColour: string | null = null;

/**
 * Some browsers (Chrome on Android, an installed app) paint their own bar
 * at the top of the screen in the page's theme-color. With Dusk it matches
 * the game's top bar. A scene repaints the top bar in the top of its sky
 * (--scene-top in scenes.css), so the browser's bar follows it, or a seam
 * would run across the top of the screen.
 */
function paintBrowserBar(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  duskBarColour ??= meta.getAttribute('content');
  const sceneTop = getComputedStyle(document.documentElement).getPropertyValue('--scene-top').trim();
  const colour = sceneTop || duskBarColour;
  if (colour) meta.setAttribute('content', colour);
}

/** The current scene and a way to pick another. */
export function useBackgroundSetting(): {
  readonly background: BackgroundId;
  readonly choose: (id: BackgroundId) => void;
} {
  const [background, setBackground] = useState<BackgroundId>(readChoice);

  // Before the first paint, so a saved scene never flashes Dusk first.
  useLayoutEffect(() => {
    if (background === DEFAULT_BACKGROUND) delete document.documentElement.dataset.bg;
    else document.documentElement.dataset.bg = background;
    paintBrowserBar();
  }, [background]);

  const choose = useCallback((id: BackgroundId) => {
    saveChoice(id);
    setBackground(id);
  }, []);

  return { background, choose };
}
