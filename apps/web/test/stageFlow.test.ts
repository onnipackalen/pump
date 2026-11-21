import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_MS, flowsOnChange } from '../src/stageFlow';

/**
 * The stage flowing into a new set-up (stageFlow.ts). The glide itself needs
 * a browser; these check when it runs and how the screen hooks it in.
 */
describe('flowsOnChange', () => {
  const one = { difficultyId: 'easy', bets: ['1.00'] };

  it('glides for a new number of balloons or a new difficulty', () => {
    expect(flowsOnChange(one, { ...one, bets: ['1.00', '1.00', '1.00'] })).toBe(true);
    expect(flowsOnChange(one, { ...one, difficultyId: 'hard' })).toBe(true);
  });

  it('not for a typed bet, which just changes', () => {
    expect(flowsOnChange(one, { ...one, bets: ['2.50'] })).toBe(false);
    expect(flowsOnChange(one, one)).toBe(false);
  });

  it('is short and calm', () => {
    expect(FLOW_MS).toBeGreaterThanOrEqual(250);
    expect(FLOW_MS).toBeLessThanOrEqual(400);
  });
});

describe('the game screen', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  it('measures the stage before a change that flows, and only then', () => {
    expect(app).toMatch(/if \(flowsOnChange\(setup, next\)\) beforeFlow\(\);\s*setSetup\(next\);/);
    expect(app).toMatch(/onChange=\{changeSetup\}/);
  });

  it('follows the Animations setting', () => {
    expect(app).toMatch(/useStageFlow\(slotsRef, goneRef, motion\.animationsOn\)/);
  });
});
