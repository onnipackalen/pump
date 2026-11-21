import { describe, expect, it } from 'vitest';
import { BET_GUARD_MS, pressCounts, pressGuard } from '../src/game/controls';

/*
 * "Bet and pump must be on top of each other": the big Pump button takes the
 * Bet button's exact box during a round. These check the order of the
 * buttons and the guard that stops a double-tap from betting or pumping by
 * accident. The boxes themselves were measured in a browser at ten screen
 * sizes (see docs/worklog.md).
 */

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

