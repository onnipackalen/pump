/**
 * The market switches (market.ts). Each fails closed: a market the file
 * doesn't know gets every switchable feature off.
 */
import { describe, expect, it, vi } from 'vitest';
import { marketFor } from '../src/market';

describe('market.autoBetSizing: the off switch for auto-play changing bets', () => {
  it('is on for the default market', () => {
    expect(marketFor('default').autoBetSizing).toBe(true);
    expect(marketFor(undefined).autoBetSizing).toBe(true);
    expect(marketFor('').autoBetSizing).toBe(true);
  });

  it('is off for Great Britain, under either name', () => {
    expect(marketFor('gb').autoBetSizing).toBe(false);
    expect(marketFor('UK').autoBetSizing).toBe(false);
  });

  it('fails closed for a market it does not know', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(marketFor('nowhere').autoBetSizing).toBe(false);
    expect(marketFor('toString').autoBetSizing).toBe(false);
    quiet.mockRestore();
  });
});
