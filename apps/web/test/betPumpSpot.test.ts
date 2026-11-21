import { GAME_CONFIG } from '@pump/engine';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BalloonView } from '../src/api/contract';
import { AutoPlayPanel } from '../src/components/AutoPlayPanel';
import { BetPanel } from '../src/components/BetPanel';
import { RoundControls } from '../src/components/RoundControls';
import { checkBets } from '../src/game/betSetup';
import {
  BET_GUARD_MS,
  guardedClickActs,
  guardedDown,
  holdClickActs,
  holdDownActs,
  pressCounts,
  pressGuard,
  watchShown,
} from '../src/game/controls';
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

describe('a button that is in the page but hidden (Start auto-play during a round finished by hand)', () => {
  const G = BET_GUARD_MS;

  it('ignores a tap within the guard of being shown, not of being put in the page', () => {
    const start = pressGuard(G);
    // Stop pressed mid-round: Start is put in the page at 1000, hidden
    // behind the round's buttons while the player finishes the round.
    start.seen(false, 1000);
    // The last balloon pops at 9000 and Start shows up under the finger.
    start.seen(true, 9000);
    // A quick tap meant for Pump, 100 ms later: no new auto-play run.
    expect(start.pointerDown(9100, 9100)).toBe(false);
    expect(start.click(1, 9150, 9150)).toBe(false);
    // A tap the player means, after the guard, starts it.
    expect(start.pointerDown(9000 + G, 9000 + G)).toBe(true);
    expect(start.click(1, 9000 + G + 60, 9000 + G + 60)).toBe(true);
  });

  it('never counts a press while hidden, and starts over each time it comes back', () => {
    const start = pressGuard(G);
    start.seen(true, 0);
    start.seen(false, 5000);
    expect(start.pointerDown(6000, 6000)).toBe(false);
    start.seen(true, 7000);
    expect(start.pointerDown(7000 + G - 1, 7000 + G - 1)).toBe(false);
    expect(start.pointerDown(7000 + G, 7000 + G)).toBe(true);
  });

  it('does not start over while it stays in view (its box only changed size)', () => {
    const bet = pressGuard(G);
    bet.seen(true, 0);
    bet.seen(true, 2000);
    expect(bet.pointerDown(2010, 2010)).toBe(true);
  });

  /** A button whose visibility the test sets, and an observer the test fires. */
  function fakePage(visible: boolean) {
    const box = { visible, observed: false, disconnected: false };
    const target = { getClientRects: () => ({ length: box.visible ? 1 : 0 }) };
    let fire = (): void => undefined;
    class Observer {
      constructor(onChange: () => void) {
        fire = onChange;
      }
      observe(): void {
        box.observed = true;
      }
      disconnect(): void {
        box.disconnected = true;
      }
    }
    return { box, target, Observer, fire: () => fire() };
  }

  it('watchShown: looks once when the button is put in the page, and again on each box change', () => {
    const page = fakePage(false);
    let now = 1000;
    const guard = pressGuard(G);
    const stop = watchShown(page.target, guard, () => now, page.Observer);
    expect(page.box.observed).toBe(true);
    // Hidden: even a press long after does nothing.
    expect(guard.pointerDown(5000, 5000)).toBe(false);
    // Shown at 9000: the guard runs from then.
    now = 9000;
    page.box.visible = true;
    page.fire();
    expect(guard.pointerDown(9100, 9100)).toBe(false);
    expect(guard.pointerDown(9000 + G, 9000 + G)).toBe(true);
    stop();
    expect(page.box.disconnected).toBe(true);
  });

  it('watchShown: a button shown when put in the page is guarded from then, with or without an observer', () => {
    for (const withObserver of [true, false]) {
      const page = fakePage(true);
      const guard = pressGuard(G);
      watchShown(page.target, guard, () => 500, withObserver ? page.Observer : undefined);
      expect(guard.pointerDown(500 + G - 1, 500 + G - 1)).toBe(false);
      expect(guard.pointerDown(500 + G, 500 + G)).toBe(true);
    }
  });
});

describe('what the buttons do with each event (the code they run)', () => {
  const G = BET_GUARD_MS;
  const down = (timeStamp: number, button = 0) => ({ button, timeStamp });
  const click = (detail: number, timeStamp: number) => ({ detail, timeStamp });

  it('Pump (HoldButton) starts a hold only with the main button, while enabled, past the guard', () => {
    const guard = pressGuard(G);
    guard.shown(0);
    expect(holdDownActs(guard, down(G - 1), G - 1, false)).toBe(false);
    expect(holdDownActs(guard, down(G + 5, 2), G + 5, false)).toBe(false);
    expect(holdDownActs(guard, down(G + 5), G + 5, true)).toBe(false);
    expect(holdDownActs(guard, down(G + 5), G + 5, false)).toBe(true);
    // A guard whose button was never shown counts nothing.
    expect(holdDownActs(pressGuard(G), down(99_999), 99_999, false)).toBe(false);
    // A balloon's own Pump has no guard: it acts at once.
    expect(holdDownActs(null, down(0), 0, false)).toBe(true);
  });

  it('Pump acts on a click only from the keyboard, judged by that key press\'s own time', () => {
    const guard = pressGuard(G);
    guard.shown(1000);
    // A finger or mouse already acted when it went down.
    expect(holdClickActs(guard, click(1, 9000), 9000)).toBe(false);
    expect(holdClickActs(null, click(1, 9000), 9000)).toBe(false);
    expect(holdClickActs(guard, click(0, 1000 + G - 1), 1000 + G - 1)).toBe(false);
    expect(holdClickActs(guard, click(0, 1000 + G), 1000 + G)).toBe(true);
    expect(holdClickActs(pressGuard(G), click(0, 99_999), 99_999)).toBe(false);
    expect(holdClickActs(null, click(0, 0), 0)).toBe(true);
  });

  it('Bet, Start and Stop (GuardedButton) act on a click whose press began on them, past the guard', () => {
    const guard = pressGuard(G);
    guard.shown(5000);
    // A tap that began on Pump and lifted here: nothing went down on this button.
    expect(guardedClickActs(guard, click(1, 9000), 9000)).toBe(false);
    guardedDown(guard, down(5100), 5100);
    expect(guardedClickActs(guard, click(1, 5150), 5150)).toBe(false);
    guardedDown(guard, down(5000 + G), 5000 + G);
    expect(guardedClickActs(guard, click(1, 5000 + G + 60), 5000 + G + 60)).toBe(true);
    // From the keyboard (or an assistive tool's click), judged by its own time.
    expect(guardedClickActs(guard, click(0, 5000 + G), 5000 + G)).toBe(true);
    // Never shown: never acts.
    const hidden = pressGuard(G);
    guardedDown(hidden, down(99_999), 99_999);
    expect(guardedClickActs(hidden, click(1, 99_999), 99_999)).toBe(false);
  });
});

describe('the guard is on the buttons that share the Bet and Pump spot', () => {
  const noop = (): void => undefined;
  const guarded = `data-guard-ms="${BET_GUARD_MS}"`;
  /** The opening tag of the first button whose text starts with `text`. */
  function tag(html: string, text: string): string {
    const found = [...html.matchAll(/(<button[^>]*>)(.*?)<\/button>/g)].find((m) =>
      (m[2] ?? '').replace(/<[^>]+>/g, '').startsWith(text),
    );
    return found?.[1] ?? '';
  }
  const status = (running: boolean) => ({
    running,
    stopping: false,
    settings: running
      ? {
          rounds: 10,
          targetPumps: 3,
          stopOnProfitCents: null,
          stopOnLossCents: null,
          onWin: { kind: 'reset' as const },
          onLoss: { kind: 'reset' as const },
        }
      : null,
    progress: { roundsPlayed: 0, netCents: 0 },
    bets: null,
    handCashOuts: null,
    stopReason: null,
  });
  const auto = (running: boolean): string =>
    renderToStaticMarkup(
      createElement(AutoPlayPanel, {
        ladder: GAME_CONFIG.difficulties[0]?.ladder ?? [],
        topRung: GAME_CONFIG.difficulties[0]?.ladder.length ?? 0,
        difficultyLabel: 'Easy',
        limits: GAME_CONFIG.limits,
        betSizing: true,
        round: null,
        onCashOut: noop,
        roundBetCents: 100,
        betsValid: true,
        roundActive: false,
        starting: false,
        status: status(running),
        onStart: noop,
        onStop: noop,
      }),
    );

  it('the big Pump and Pump all, but not Cash out, Patch + Pump or Cash out all', () => {
    const live = balloon({ rung: 1, drawIndex: 1, multiplierHundredths: 160, cashOutCents: 160 });
    for (const count of [1, 2, 3]) {
      const balloons = Array.from({ length: count }, (_, index) => ({ ...live, index }));
      const html = renderToStaticMarkup(
        createElement(RoundControls, {
          balloon: balloons[0] ?? null,
          balloons,
          multi: count > 1,
          pending: false,
          activity: balloons.map(() => 'free' as const),
          onPump: noop,
          onPumpHold: noop,
          onPatchPump: noop,
          onCashOut: noop,
          onCashOutAll: noop,
          liveCount: count,
          onPumpAll: noop,
          onPumpAllHold: noop,
        }),
      );
      expect(tag(html, count > 1 ? 'Pump all' : 'Pump')).toContain(guarded);
      expect(html.match(/data-guard-ms/g)).toHaveLength(1);
    }
  });

  it('Bet', () => {
    const setup = { difficultyId: GAME_CONFIG.difficulties[0]?.id ?? '', bets: ['1.00'] };
    const html = renderToStaticMarkup(
      createElement(BetPanel, {
        config: GAME_CONFIG,
        setup,
        check: checkBets(setup, GAME_CONFIG.limits, 1_000_000),
        disabled: false,
        starting: false,
        showBet: true,
        onChange: noop,
        onStart: noop,
      }),
    );
    expect(tag(html, 'Bet $')).toContain(guarded);
  });

  it('Start auto-play, and Stop, which takes its place', () => {
    expect(tag(auto(false), 'Start auto-play')).toContain(guarded);
    expect(tag(auto(true), 'Stop')).toContain(guarded);
  });
});

describe('Stop, in Start\'s place: the second click of a double-click on Start', () => {
  it('does not stop the run that the first click began', () => {
    const G = BET_GUARD_MS;
    const stop = pressGuard(G);
    // The first click on Start at 1000 begins the run; Stop appears there.
    stop.shown(1000);
    // The second click of the double-click, 90 ms later.
    expect(stop.pointerDown(1090, 1090)).toBe(false);
    expect(stop.click(2, 1120, 1120)).toBe(false);
    // A Stop the player means works once the guard is over (Esc works at once).
    expect(stop.pointerDown(1000 + G, 1000 + G)).toBe(true);
    expect(stop.click(1, 1000 + G + 60, 1000 + G + 60)).toBe(true);
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
        ladder: GAME_CONFIG.difficulties[0]?.ladder ?? [],
        topRung: GAME_CONFIG.difficulties[0]?.ladder.length ?? 0,
        difficultyLabel: 'Easy',
        limits: GAME_CONFIG.limits,
        betSizing: true,
        round: null,
        onCashOut: noop,
        roundBetCents: 100,
        betsValid: true,
        roundActive: false,
        starting: false,
        status: {
          running: true,
          stopping: false,
          settings: {
          rounds: 10,
          targetPumps: 3,
          stopOnProfitCents: null,
          stopOnLossCents: null,
          onWin: { kind: 'reset' as const },
          onLoss: { kind: 'reset' as const },
        },
          progress: { roundsPlayed: 2, netCents: -150 },
          bets: null,
          handCashOuts: null,
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
