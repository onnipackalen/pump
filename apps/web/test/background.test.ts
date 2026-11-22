import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, DEFAULT_BACKGROUND, parseBackground } from '../src/background';

const scenes = readFileSync(new URL('../src/scenes/scenes.css', import.meta.url), 'utf8');

describe('the Background setting', () => {
  it('starts on Dusk, and falls back to Dusk for a missing or unknown saved value', () => {
    expect(DEFAULT_BACKGROUND).toBe('dusk');
    expect(parseBackground(null)).toBe('dusk');
    expect(parseBackground('')).toBe('dusk');
    expect(parseBackground('jungle')).toBe('dusk');
    expect(parseBackground('DESERT')).toBe('dusk');
  });

  it('reads back every scene it can save', () => {
    for (const scene of BACKGROUNDS) expect(parseBackground(scene.id)).toBe(scene.id);
  });

  it('has a sky and a floor in scenes.css for every scene but Dusk', () => {
    for (const scene of BACKGROUNDS) {
      const sky = scenes.includes(`:root[data-bg='${scene.id}'] .stage::before {`);
      const floor = scenes.includes(`:root[data-bg='${scene.id}'] {\n  --scene-top:`);
      expect({ id: scene.id, sky, floor }).toEqual({
        id: scene.id,
        sky: scene.id !== 'dusk',
        floor: scene.id !== 'dusk',
      });
    }
  });

  it('keeps the words under the balloons readable on every floor', () => {
    // WCAG contrast. "Popped" is large bold text (3:1); the money line and
    // the numbers are normal text (4.5:1, and the numbers far more).
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const contrast = (a: string, b: string): number => {
      const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
      return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
    };
    for (const scene of BACKGROUNDS.filter((s) => s.id !== 'dusk')) {
      const floor = new RegExp(`data-bg='${scene.id}'\\] \\{[^}]*--scene-floor: (#[0-9a-f]{6});`).exec(scenes)?.[1];
      expect(floor, scene.id).toBeDefined();
      if (!floor) continue;
      expect(contrast('#6f7789', floor), `${scene.id}: Popped`).toBeGreaterThanOrEqual(3);
      expect(contrast('#9aa3b8', floor), `${scene.id}: money line`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#e8ebf3', floor), `${scene.id}: numbers`).toBeGreaterThanOrEqual(7);
    }
  });

  it('never uses the win mint or the pop grey', () => {
    const lower = scenes.toLowerCase();
    expect(lower).not.toContain('#4fe0a8');
    expect(lower).not.toContain('#6f7789');
  });
});
