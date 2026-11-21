import { GAME_CONFIG, multiplierAt, topRungForBet } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { BalloonStatus } from '../src/api/contract';
import { stepAnchor, stepRow, type StepRowInput } from '../src/game/stepRow';
import { formatMultiplier } from '../src/money';

/**
 * The row of multiplier steps shown with a balloon. Every ladder comes from
 * the config, so nothing here pins a number from one.
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

function* everyCase(): Generator<StepRowInput> {
  for (const difficulty of GAME_CONFIG.difficulties) {
    for (const betCents of bets) {
      const topRung = topRungForBet(difficulty.ladder, betCents, limits.maxPayoutCents);
      yield* everyState(difficulty.ladder, topRung);
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
    // The largest bet is cut short by the payout cap on some ladder, so the
    // locked steps really were looked at.
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

  it('reads the same for every status that cannot be pumped at rung 0', () => {
    const ladder = GAME_CONFIG.difficulties[0]?.ladder ?? [];
    const status: BalloonStatus = 'refunded';
    const steps = stepRow({ ladder, rung: 0, topRung: ladder.length, status });
    expect(steps.every((step) => step.state === 'ahead')).toBe(true);
  });
});
