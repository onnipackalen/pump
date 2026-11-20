import { describe, expect, it } from 'vitest';
import { isOlder, roundProgress } from '../src/game/roundOrder';
import { balloon, round } from './fixtures';

describe('roundProgress', () => {
  it('goes up with every draw and every balloon that ends', () => {
    const start = round([balloon(), balloon()]);
    const pumped = round([balloon({ drawIndex: 1, rung: 1 }), balloon()]);
    const saved = round([balloon({ drawIndex: 2, rung: 1 }), balloon()]);
    const cashed = round([balloon({ drawIndex: 2, rung: 1, status: 'cashed' }), balloon()]);
    const popped = round([
      balloon({ drawIndex: 2, rung: 1, status: 'cashed' }),
      balloon({ drawIndex: 1, status: 'popped' }),
    ]);
    const steps = [start, pumped, saved, cashed, popped].map(roundProgress);
    expect(steps).toEqual([0, 1, 2, 3, 5]);
  });
});

describe('isOlder', () => {
  // The bug the review found: balloon 1's pump answer is held for its press
  // beat, balloon 2's cash-out answer comes back first and already includes
  // the pump. The pump answer must not undo the cash-out on screen.
  const afterPump = round([balloon({ drawIndex: 1, status: 'popped' }), balloon({ rung: 1, drawIndex: 1 })]);
  const afterCashOut = round([
    balloon({ drawIndex: 1, status: 'popped' }),
    balloon({ rung: 1, drawIndex: 1, status: 'cashed' }),
  ]);

  it('spots an older answer for the round on screen', () => {
    expect(isOlder(afterPump, afterCashOut)).toBe(true);
    expect(isOlder(afterCashOut, afterPump)).toBe(false);
  });

  it('never blocks a different round or an empty screen', () => {
    expect(isOlder(afterPump, round([balloon({ drawIndex: 9 })], { id: 'other' }))).toBe(false);
    expect(isOlder(afterPump, null)).toBe(false);
  });

  it('lets the same snapshot through again', () => {
    expect(isOlder(afterCashOut, afterCashOut)).toBe(false);
  });
});
