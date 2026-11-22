import { GAME_CONFIG, multiplierAt, topRungForBet } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { BalloonStatus } from '../src/api/contract';
import { stepAnchor, stepRow, stepWords, type StepRowInput } from '../src/game/stepRow';
import { formatMultiplier } from '../src/money';
import { MADE_CAPPED } from './fixtures';

/**
 * The row of multiplier steps shown with a balloon. The ladders come from
 * the config (plus one made in fixtures.ts), so nothing here pins a number
 * from a live ladder.
 */

const { limits } = GAME_CONFIG;
/** Bets that reach the whole ladder, and the largest bet, which the payout cap cuts short. */
const bets = [limits.minBetCents, 100, 12_345, limits.maxBetCents];

/** Every state a balloon of this ladder and bet can be drawn in. */
function* everyState(ladder: readonly number[], topRung: number): Generator<StepRowInput> {
  yield { ladder, rung: 0, topRung, status: 'preview' };
  yield { ladder, rung: 0, topRung, status: 'refunded' };
  for (let rung = 0; rung <= topRung; rung += 1) {
    // In play below the top; at the top it has cashed out by itself.
    if (rung < topRung) yield { ladder, rung, topRung, status: 'active' };
    // It popped on the pump after `rung` (there is none after the top).
    if (rung < topRung) yield { ladder, rung, topRung, status: 'popped' };
    if (rung > 0) yield { ladder, rung, topRung, status: 'cashed' };
  }
}

// Every configured ladder, and one made here that the cap cuts short, so
// the locked steps are looked at whatever the config holds.
const LADDERS = [...GAME_CONFIG.difficulties.map((d) => d.ladder), MADE_CAPPED.ladder];

function* everyCase(): Generator<StepRowInput> {
  for (const ladder of LADDERS) {
    for (const betCents of bets) {
      const topRung = topRungForBet(ladder, betCents, limits.maxPayoutCents);
      yield* everyState(ladder, topRung);
    }
  }
}

const count = (input: StepRowInput, state: string): number =>
  stepRow(input).filter((step) => step.state === state).length;

describe('the row of multiplier steps', () => {
  it('has one step per rung, in order, written as the ladder says', () => {
    for (const input of everyCase()) {
      const steps = stepRow(input);
      expect(steps).toHaveLength(input.ladder.length);
      steps.forEach((step, index) => {
        expect(step.rung).toBe(index + 1);
        expect(step.text).toBe(formatMultiplier(multiplierAt(input.ladder, index + 1)));
      });
    }
  });

  it('locks exactly the steps above the top the bet can reach', () => {
    let capped = 0;
    for (const input of everyCase()) {
      if (input.topRung < input.ladder.length) capped += 1;
      for (const step of stepRow(input)) {
        expect(step.state === 'locked').toBe(step.rung > input.topRung);
      }
    }
    // The largest bet is cut short by the payout cap on some ladder (the
    // made one at least), so the locked steps really were looked at.
    expect(capped).toBeGreaterThan(0);
  });

  it('marks the step a balloon is on, and no other', () => {
    for (const input of everyCase()) {
      const on = stepRow(input).filter((step) => step.state === 'current');
      const stands =
        input.rung > 0 && (input.status === 'active' || input.status === 'cashed');
      expect(on.map((step) => step.rung)).toEqual(stands ? [input.rung] : []);
    }
  });

  it('marks the step the next pump goes for only while a pump can be made', () => {
    for (const input of everyCase()) {
      const next = stepRow(input).filter((step) => step.state === 'next');
      const canPump =
        (input.status === 'active' || input.status === 'preview') && input.rung < input.topRung;
      expect(next.map((step) => step.rung)).toEqual(canPump ? [input.rung + 1] : []);
    }
  });

  it('shows a pop on the step that pump was going for, and only after a pop', () => {
    for (const input of everyCase()) {
      const popped = stepRow(input).filter((step) => step.state === 'popped');
      expect(popped.map((step) => step.rung)).toEqual(
        input.status === 'popped' ? [input.rung + 1] : [],
      );
      // A popped balloon is on no step any more.
      if (input.status === 'popped') expect(count(input, 'current')).toBe(0);
    }
  });

  it('counts every step below the balloon as passed', () => {
    for (const input of everyCase()) {
      const passed = stepRow(input)
        .filter((step) => step.state === 'passed')
        .map((step) => step.rung);
      // After a pop the step it stood on is passed too: it is not on it now.
      const upTo = input.status === 'popped' ? input.rung : input.rung - 1;
      expect(passed).toEqual(Array.from({ length: Math.max(0, upTo) }, (_, i) => i + 1));
    }
  });

  it('never marks a step above the balloon as anything but next, ahead, locked or popped', () => {
    // The row may not hint at pumps that were not made.
    const allowed = new Set(['next', 'ahead', 'locked', 'popped']);
    for (const input of everyCase()) {
      for (const step of stepRow(input)) {
        if (step.rung > input.rung) expect(allowed.has(step.state)).toBe(true);
      }
    }
  });

  it('keeps in view the step the balloon is on, or the one it popped on', () => {
    for (const input of everyCase()) {
      const anchor = stepAnchor(input);
      expect(anchor).toBe(input.status === 'popped' ? input.rung + 1 : input.rung);
      expect(anchor).toBeGreaterThanOrEqual(0);
      expect(anchor).toBeLessThanOrEqual(input.ladder.length);
    }
  });

  it('shows a refunded balloon with nothing passed, current, next or popped', () => {
    // A refunded bet was never pumped: its whole ladder is simply ahead.
    const status: BalloonStatus = 'refunded';
    for (const ladder of LADDERS) {
      const steps = stepRow({ ladder, rung: 0, topRung: ladder.length, status });
      expect(steps.every((step) => step.state === 'ahead')).toBe(true);
    }
  });
});

describe('the row in one short line, for a screen reader', () => {
  it('names the next step and the top the bet can reach, while a pump can be made', () => {
    let said = 0;
    for (const input of everyCase()) {
      const words = stepWords(input);
      const canPump =
        (input.status === 'active' || input.status === 'preview') && input.rung < input.topRung;
      if (!canPump) {
        expect(words).toBeNull();
        continue;
      }
      said += 1;
      const next = formatMultiplier(multiplierAt(input.ladder, input.rung + 1));
      const top = formatMultiplier(multiplierAt(input.ladder, input.topRung));
      const lead = input.status === 'preview' ? 'First step' : 'Next';
      expect(words).toBe(`${lead} ${next}. Top at this bet ${top}.`);
    }
    expect(said).toBeGreaterThan(0);
  });

  it('never names a step above the top the bet can reach', () => {
    for (const input of everyCase()) {
      const words = stepWords(input);
      if (words === null) continue;
      for (let rung = input.topRung + 1; rung <= input.ladder.length; rung += 1) {
        expect(words).not.toContain(formatMultiplier(multiplierAt(input.ladder, rung)));
      }
    }
  });
});
