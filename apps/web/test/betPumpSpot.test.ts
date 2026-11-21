import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView } from '../src/api/contract';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { RoundControls } from '../src/components/RoundControls';
import { BET_GUARD_MS, pressCounts, pressGuard } from '../src/game/controls';
import { balloon } from './fixtures';

/*
 * "Bet and pump must be on top of each other": the big Pump button takes the
 * Bet button's exact box during a round. These check the order of the
 * buttons and the guard that stops a double-tap from betting or pumping by
 * accident. The boxes themselves were measured in a browser at ten screen
 * sizes (see docs/worklog.md).
 */

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('the guard on a button that appears in the Bet and Pump spot', () => {
  const G = BET_GUARD_MS;

  it('is longer than the gap between the two taps of a double-tap, and short', () => {
    expect(G).toBeGreaterThanOrEqual(300);
    expect(G).toBeLessThanOrEqual(500);
  });

  it('counts a press only once the guard after the button appeared is over', () => {
    expect(pressCounts(100 + G - 1, 100, 1000, G)).toBe(false);
    expect(pressCounts(100 + G, 100, 1000, G)).toBe(true);
    // Began before the button was there at all.
    expect(pressCounts(90, 100, 1000, G)).toBe(false);
    // No press, or a button not on screen yet.
    expect(pressCounts(null, 100, 1000, G)).toBe(false);
    expect(pressCounts(5000, null, 5000, G)).toBe(false);
  });

  it('judges a press never later than the moment it is handled (a time stamp on another clock)', () => {
    // A browser whose event time is since 1970, not since the page opened.
    const epochStamp = 1_790_000_000_000;
    expect(pressCounts(epochStamp, 1000, 1000 + G - 1, G)).toBe(false);
    expect(pressCounts(epochStamp, 1000, 1000 + G, G)).toBe(true);
  });

  describe('Pump, which acts when the finger goes down (pointer path)', () => {
    it('ignores the second tap of a double-tap on Bet', () => {
      const pump = pressGuard(G);
      // Bet tapped at 0 ms; the round's answer puts Pump in its place at 120.
      pump.shown(120);
      // The second tap of the double-tap, 200 ms after the first.
      expect(pump.pointerDown(200, 200)).toBe(false);
      // A tap the player means, once the guard is over, pumps.
      expect(pump.pointerDown(120 + G, 120 + G)).toBe(true);
    });

    it('ignores a press that began before it appeared, even if it is handled late', () => {
      const pump = pressGuard(G);
      pump.shown(120);
      // Queued while the page was busy drawing the round: stamped at 100,
      // handled well after the guard.
      expect(pump.pointerDown(100, 120 + G + 500)).toBe(false);
    });

    it('ignores a fast double-click with a mouse: both its downs and its click', () => {
      const pump = pressGuard(G);
      pump.shown(60);
      expect(pump.pointerDown(150, 150)).toBe(false);
      expect(pump.click(2, 230, 230)).toBe(false);
    });

    it('never starts a hold from a press that began on Bet', () => {
      const pump = pressGuard(G);
      // The finger went down on Bet at 0 and is still down when Pump
      // appears at 120: Pump gets no press of its own, and a click from that
      // finger (lifted at 1000) has none to go by.
      pump.shown(120);
      expect(pump.click(1, 1000, 1000)).toBe(false);
      // Hold to pump starts only with a new press on Pump.
      expect(pump.pointerDown(1100, 1100)).toBe(true);
    });

    it('ignores a press that starts inside the guard for its whole length', () => {
      const pump = pressGuard(G);
      pump.shown(0);
      // Down inside the guard: no hold starts, and the finger staying down
      // past the guard changes nothing (there is no second "down").
      expect(pump.pointerDown(G - 50, G - 50)).toBe(false);
      expect(pump.click(1, G + 400, G + 400)).toBe(false);
    });
  });

  describe('the keyboard path (a click with detail 0)', () => {
    it('is judged by its own time', () => {
      const pump = pressGuard(G);
      pump.shown(1000);
      expect(pump.click(0, 1000 + G - 1, 1000 + G - 1)).toBe(false);
      expect(pump.click(0, 1000 + G, 1000 + G)).toBe(true);
    });
  });

  describe('Bet and Start auto-play, which act on a click (the other way round)', () => {
    it('ignore a quick tap on Pump that lands on Bet as the balloon pops', () => {
      const bet = pressGuard(G);
      // The balloon popped: Bet takes Pump's place at 5000.
      bet.shown(5000);
      expect(bet.pointerDown(5100, 5100)).toBe(false);
      expect(bet.click(1, 5180, 5180)).toBe(false);
    });

    it('ignore a press that began on Pump and lifted on Bet', () => {
      const bet = pressGuard(G);
      bet.shown(5000);
      // No pointer went down on Bet itself: a click with nothing to go by.
      expect(bet.click(1, 5000 + G + 300, 5000 + G + 300)).toBe(false);
    });

    it('ignore a press that began inside the guard even if the finger lifts after it', () => {
      const bet = pressGuard(G);
      bet.shown(5000);
      bet.pointerDown(5000 + G - 10, 5000 + G - 10);
      expect(bet.click(1, 5000 + G + 80, 5000 + G + 80)).toBe(false);
    });

    it('take a tap the player means, once the guard is over', () => {
      const bet = pressGuard(G);
      bet.shown(5000);
      bet.pointerDown(5000 + G, 5000 + G);
      expect(bet.click(1, 5000 + G + 80, 5000 + G + 80)).toBe(true);
      // Each click uses up its own press: a second click needs a new one.
      expect(bet.click(1, 5000 + G + 200, 5000 + G + 200)).toBe(false);
    });

    it('start over each time the button appears again', () => {
      const bet = pressGuard(G);
      bet.shown(0);
      bet.pointerDown(G + 10, G + 10);
      // Gone and back (a round played in between): the old press is forgotten.
      bet.shown(9000);
      expect(bet.click(1, 9050, 9050)).toBe(false);
    });
  });
});

describe('the round panel: the big button first, in the Bet button\'s place', () => {
  const live = balloon({
    rung: 1,
    drawIndex: 1,
    multiplierHundredths: 160,
    cashOutCents: 160,
    next: { popChance: { num: 42, den: 100 }, multiplierHundredths: 277, patchPriceCents: 75 },
  });

  function panel(balloons: readonly BalloonView[]): string {
    const noop = (): void => undefined;
    return renderToStaticMarkup(
      createElement(RoundControls, {
        balloon: balloons[0] ?? null,
        balloons,
        multi: balloons.length > 1,
        pending: false,
        activity: balloons.map(() => 'free' as const),
        onPump: noop,
        onPumpHold: noop,
        onPatchPump: noop,
        onCashOut: noop,
        onCashOutAll: noop,
        liveCount: balloons.filter((b) => b.status === 'active').length,
        onPumpAll: noop,
        onPumpAllHold: noop,
      }),
    );
  }

  /** Each button's class and text, top to bottom. */
  function buttons(html: string): { cls: string; text: string }[] {
    return [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)].map((m) => ({
      cls: m[1] ?? '',
      text: (m[2] ?? '').replace(/<[^>]+>/g, ''),
    }));
  }

  it('with one balloon: Pump, then Cash out and Patch + Pump, then the numbers', () => {
    const html = panel([live]);
    const list = buttons(html);
    expect(list.map((b) => b.text.split('$')[0])).toEqual(['Pump', 'Cash out', 'Patch + Pump']);
    expect(list[0]?.cls).toContain('btn-primary');
    // The numbers come after every button.
    expect(html.indexOf('<dl')).toBeGreaterThan(html.lastIndexOf('</button>'));
    // The big button is the first thing in the panel, as Bet is in the bet panel.
    expect(html).toMatch(/^<section class="round"[^>]*><div class="round-actions"><button[^>]*btn-primary/);
  });

  it('with two or three balloons: Pump all, Cash out, Patch + Pump, then Cash out all', () => {
    for (const count of [2, 3]) {
      const all = Array.from({ length: count }, (_, index) => ({ ...live, index }));
      const list = buttons(panel(all));
      expect(list.map((b) => b.text.split('$')[0])).toEqual([
        'Pump all',
        'Cash out',
        'Patch + Pump',
        'Cash out all',
      ]);
    }
  });

  it('says plain Pump once one balloon of several is left, in the same first place', () => {
    const list = buttons(panel([live, { ...live, index: 1, status: 'popped' }]));
    expect(list[0]?.text).toBe('Pump');
  });

  it('keeps Patch + Pump unlike Pump and Cash out: its own fill, tape icon and stitches', () => {
    const list = buttons(panel([live, { ...live, index: 1 }]));
    const [pump, cashOut, patch, cashAll] = list;
    expect(pump?.cls).toContain('btn-primary');
    expect(cashOut?.cls).toContain('btn-outline');
    expect(cashAll?.cls).toContain('btn-outline');
    expect(patch?.cls).toContain('btn-patch');
    expect(patch?.cls).not.toContain('btn-outline');
    expect(panel([live])).toContain('class="patch-icon"');
    expect(css).toMatch(/\.btn-patch::before \{[^}]*dashed/);
  });
});

describe('the CSS that keeps the boxes the same', () => {
  /** The rules inside the upright-screen block. */
  const upright = css.slice(css.indexOf('@media (orientation: portrait)'), css.indexOf('/* -', css.indexOf('@media (orientation: portrait)')));

  it('keeps the phone sheet\'s handle space in a round and during auto-play, so Pump and Stop sit where Bet and Start were', () => {
    expect(upright).toMatch(
      /\.controls:has\(> \.round\)::before,\s*\.controls:has\(\.auto-progress\[data-running='true'\]\)::before \{\s*visibility: hidden;/,
    );
    expect(upright).not.toMatch(/::before \{\s*display: none/);
  });

  it('never lets the big button grow past the Bet button\'s height', () => {
    expect(css).not.toMatch(/round-actions \{[^}]*grid-template-rows/);
    expect(css).toMatch(/\.round-actions > \.btn-primary \{\s*grid-column: 1 \/ -1;/);
  });

  it('puts the auto-play progress under Stop, not above it', () => {
    expect(css).not.toMatch(/\.auto-progress\[data-running='true'\] \{[^}]*order:/);
  });
});

describe('auto-play: Stop where Start was', () => {
  it('puts Stop first in the panel while it runs, with the progress line after it', () => {
    const noop = (): void => undefined;
    const html = renderToStaticMarkup(
      createElement(AutoPlayPanel, {
        maxPumps: 10,
        roundBetCents: 100,
        betsValid: true,
        roundActive: false,
        starting: false,
        status: {
          running: true,
          stopping: false,
          settings: { rounds: 10, targetPumps: 3, stopOnProfitCents: null, stopOnLossCents: null },
          progress: { roundsPlayed: 2, netCents: -150 },
          stopReason: null,
        },
        onStart: noop,
        onStop: noop,
      }),
    );
    expect(html).toMatch(/^<section class="auto"[^>]*><button[^>]*btn-stop/);
    expect(html.indexOf('auto-progress')).toBeGreaterThan(html.indexOf('btn-stop'));
  });
});
