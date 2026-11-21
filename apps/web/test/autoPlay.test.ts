import { describe, expect, it } from 'vitest';
import {
  checkAutoPlayForm,
  checkBeforeRound,
  maxStepsPerRound,
  MAX_AUTO_ROUNDS,
  nextSteps,
  roundNetCents,
  type AutoPlayForm,
  type AutoPlaySettings,
} from '../src/game/autoPlay';
import { balloon, round } from './fixtures';

const settings = (overrides: Partial<AutoPlaySettings> = {}): AutoPlaySettings => ({
  rounds: 10,
  targetPumps: 3,
  stopOnProfitCents: null,
  stopOnLossCents: null,
  onWin: { kind: 'reset' },
  onLoss: { kind: 'reset' },
  ...overrides,
});

describe('nextSteps', () => {
  it('pumps every balloon still in play that is below the target, together', () => {
    const r = round([balloon({ rung: 2 }), balloon(), balloon({ rung: 1 })]);
    expect(nextSteps(r, 3)).toEqual([
      { kind: 'pump', balloonIndex: 0 },
      { kind: 'pump', balloonIndex: 1 },
      { kind: 'pump', balloonIndex: 2 },
    ]);
  });

  it('cashes out a balloon at the target while it keeps pumping the others', () => {
    const r = round([balloon({ rung: 3 }), balloon({ rung: 1 })]);
    expect(nextSteps(r, 3)).toEqual([
      { kind: 'cash-out', balloonIndex: 0 },
      { kind: 'pump', balloonIndex: 1 },
    ]);
  });

  it('leaves out balloons that popped or cashed out', () => {
    const r = round([balloon({ status: 'popped' }), balloon({ status: 'cashed' }), balloon()]);
    expect(nextSteps(r, 3)).toEqual([{ kind: 'pump', balloonIndex: 2 }]);
  });

  it('is empty when no balloon is in play', () => {
    const r = round([balloon({ status: 'popped' }), balloon({ status: 'cashed' })]);
    expect(nextSteps(r, 3)).toEqual([]);
  });
});

describe('checkBeforeRound', () => {
  const progress = (roundsPlayed: number, netCents: number) => ({ roundsPlayed, netCents });

  it('lets a round start when nothing says stop', () => {
    expect(checkBeforeRound(settings(), progress(0, 0), 300, 10_000)).toBeNull();
  });

  it('stops after the chosen number of rounds', () => {
    expect(checkBeforeRound(settings({ rounds: 5 }), progress(5, 0), 300, 10_000)).toBe(
      'rounds-done',
    );
    expect(checkBeforeRound(settings({ rounds: 5 }), progress(4, 0), 300, 10_000)).toBeNull();
  });

  it('stops once the profit target is reached, not before', () => {
    const s = settings({ stopOnProfitCents: 500 });
    expect(checkBeforeRound(s, progress(3, 499), 300, 10_000)).toBeNull();
    expect(checkBeforeRound(s, progress(3, 500), 300, 10_000)).toBe('profit');
  });

  it('never starts a round whose bets could take the loss past the limit', () => {
    const s = settings({ stopOnLossCents: 1000 });
    // Down $7: a $3 round could end $10 down, which is exactly the limit.
    expect(checkBeforeRound(s, progress(3, -700), 300, 10_000)).toBeNull();
    // Down $7.01: a $3 round could end $10.01 down.
    expect(checkBeforeRound(s, progress(3, -701), 300, 10_000)).toBe('loss');
  });

  it('stops when the balance cannot cover the next round', () => {
    expect(checkBeforeRound(settings(), progress(1, 0), 300, 299)).toBe('balance');
    expect(checkBeforeRound(settings(), progress(1, 0), 300, 300)).toBeNull();
  });
});

describe('roundNetCents', () => {
  it('is payouts minus bets and Patches', () => {
    const r = round([
      balloon({ status: 'cashed', betCents: 100, payoutCents: 163, patchesCents: 33 }),
      balloon({ status: 'popped', betCents: 100 }),
    ]);
    expect(roundNetCents(r)).toBe(163 - 100 - 33 - 100);
  });
});

describe('maxStepsPerRound', () => {
  it('allows one pump per target rung and one cash-out, per balloon', () => {
    expect(maxStepsPerRound(3, 5)).toBe(18);
  });
});

describe('checkAutoPlayForm', () => {
  const form = (overrides: Partial<AutoPlayForm> = {}): AutoPlayForm => ({
    rounds: '10',
    targetPumps: '3',
    stopOnProfit: '',
    stopOnLoss: '',
    onWin: 'reset',
    onWinPercent: '',
    onLoss: 'reset',
    onLossPercent: '',
    ...overrides,
  });

  it('reads a valid form, with blank limits switched off', () => {
    expect(checkAutoPlayForm(form(), 24, 300, true).settings).toEqual({
      rounds: 10,
      targetPumps: 3,
      stopOnProfitCents: null,
      stopOnLossCents: null,
      onWin: { kind: 'reset' },
      onLoss: { kind: 'reset' },
    });
  });

  it('reads limits as exact cents', () => {
    const check = checkAutoPlayForm(form({ stopOnProfit: '5.25', stopOnLoss: '20' }), 24, 300, true);
    expect(check.settings?.stopOnProfitCents).toBe(525);
    expect(check.settings?.stopOnLossCents).toBe(2000);
  });

  it('rejects rounds outside 1 to the maximum', () => {
    for (const rounds of ['0', String(MAX_AUTO_ROUNDS + 1), '1.5', '-1', 'ten', '']) {
      const check = checkAutoPlayForm(form({ rounds }), 24, 300, true);
      expect(check.settings).toBeNull();
      expect(check.errors.rounds).not.toBeNull();
    }
  });

  it('rejects a pump target longer than the ladder', () => {
    expect(checkAutoPlayForm(form({ targetPumps: '25' }), 24, 300, true).settings).toBeNull();
    expect(checkAutoPlayForm(form({ targetPumps: '24' }), 24, 300, true).settings).not.toBeNull();
    expect(checkAutoPlayForm(form({ targetPumps: '0' }), 24, 300, true).settings).toBeNull();
  });

  it('rejects a zero profit target', () => {
    expect(checkAutoPlayForm(form({ stopOnProfit: '0' }), 24, 300, true).errors.stopOnProfit).not.toBe(
      null,
    );
  });

  it('rejects a loss limit smaller than one round of bets', () => {
    const check = checkAutoPlayForm(form({ stopOnLoss: '2.99' }), 24, 300, true);
    expect(check.settings).toBeNull();
    expect(check.errors.stopOnLoss).toContain('$3.00');
    expect(checkAutoPlayForm(form({ stopOnLoss: '3' }), 24, 300, true).settings).not.toBeNull();
  });
});
