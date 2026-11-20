import { describe, expect, it } from 'vitest';
import { controlTarget } from '../src/game/controls';
import { holdStep, type HoldTarget } from '../src/game/useHoldPump';
import { balloon, round } from './fixtures';

const one = (index: number): HoldTarget => ({ kind: 'one', roundId: 'round-1', index });
const all: HoldTarget = { kind: 'all', roundId: 'round-1' };

describe('holdStep', () => {
  it('pumps the held balloon once its last answer is back', () => {
    const r = round([balloon(), balloon()]);
    expect(holdStep(r, [false, false], one(1))).toEqual([1]);
  });

  it('waits while the held balloon still has a pump on its way', () => {
    const r = round([balloon(), balloon()]);
    expect(holdStep(r, [false, true], one(1))).toEqual([]);
  });

  it('ends when the held balloon pops or cashes out, and never moves to another one', () => {
    const r = round([balloon(), balloon({ status: 'popped' })]);
    expect(holdStep(r, [false, false], one(1))).toBeNull();
  });

  it('ends when the round is another one', () => {
    const r = round([balloon()], { id: 'round-2' });
    expect(holdStep(r, [false], one(0))).toBeNull();
    expect(holdStep(r, [false], all)).toBeNull();
  });

  it('on Pump all, pumps every balloon still in play together', () => {
    const r = round([balloon(), balloon({ status: 'cashed' }), balloon()]);
    expect(holdStep(r, [false, false, false], all)).toEqual([0, 2]);
  });

  it('on Pump all, waits for every answer so the balloons stay in step', () => {
    const r = round([balloon(), balloon()]);
    expect(holdStep(r, [true, false], all)).toEqual([]);
  });

  it('on Pump all, ends when no balloon is in play', () => {
    const r = round([balloon({ status: 'popped' }), balloon({ status: 'cashed' })]);
    expect(holdStep(r, [false, false], all)).toBeNull();
  });
});

describe('controlTarget', () => {
  it('is the picked balloon while it is in play', () => {
    const r = round([balloon(), balloon(), balloon()]);
    expect(controlTarget(r, 1)).toBe(1);
  });

  it('moves to the next balloon still in play once the picked one ends', () => {
    const r = round([balloon(), balloon({ status: 'popped' }), balloon()]);
    expect(controlTarget(r, 1)).toBe(2);
  });

  it('wraps round to the first balloon', () => {
    const r = round([balloon(), balloon(), balloon({ status: 'cashed' })]);
    expect(controlTarget(r, 2)).toBe(0);
  });

  it('is null once no balloon is in play', () => {
    const r = round([balloon({ status: 'popped' }), balloon({ status: 'cashed' })]);
    expect(controlTarget(r, 0)).toBeNull();
    expect(controlTarget(null, 0)).toBeNull();
  });
});
