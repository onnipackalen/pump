import { describe, expect, it } from 'vitest';
import { RTP_BP, type GameConfig } from '../src/config';
import {
  cashOut,
  EngineError,
  isRoundOver,
  pump,
  quoteBalloon,
  replayBalloon,
  settleAbandoned,
  startRound,
  type Balloon,
  type BalloonAction,
  type DrawRecord,
  type PumpDraw,
  type ReplayDraw,
  type Round,
} from '../src/PumpEngine';
import { fixedConfig, fixedLadder } from './fixtures';

/** The three RTP values reviewers will try, plus whatever is configured now. */
const RTPS = [...new Set([9400, 9700, 9900, RTP_BP])];
// The rounds here are played on the fixed ladders in fixtures.ts, so the exact
// numbers below do not move when the live ladders are tuned.
const at = (rtpBp: number): GameConfig => fixedConfig(rtpBp);
const CONFIG = at(9700);
const RICH = 1_000_000_000;

/** A draw source that hands out the given rolls in order and notes each den asked for. */
function scripted(rolls: readonly number[]): { draw: PumpDraw; dens: number[] } {
  const dens: number[] = [];
  const draw: PumpDraw = (den) => {
    const roll = rolls[dens.length];
    if (roll === undefined) throw new Error('the engine asked for more draws than expected');
    dens.push(den);
    return roll;
  };
  return { draw, dens };
}

/** A draw source for requests that must be refused before any draw. */
const noDraw: PumpDraw = () => {
  throw new Error('a refused request must not draw');
};

/** Roll 0 is below every num, so the pump always survives. */
const alwaysSurvive: PumpDraw = () => 0;
/** The highest roll is never below num, so the pump always pops (or is saved). */
const alwaysPop: PumpDraw = (den) => den - 1;

function balloonOf(round: Round, index = 0): Balloon {
  const balloon = round.balloons[index];
  if (!balloon) throw new Error(`no balloon ${String(index)}`);
  return balloon;
}

/**
 * Freezes a round and its balloons. The engine promises to return a new round
 * and never change the one it was given; on a frozen round, any change made in
 * place throws. Every helper below freezes the round it passes in.
 */
function frozen(round: Round): Round {
  for (const balloon of round.balloons) Object.freeze(balloon);
  Object.freeze(round.balloons);
  return Object.freeze(round);
}

function start(difficultyId: string, bets: readonly number[], config = CONFIG): Round {
  return frozen(startRound(config, difficultyId, bets, RICH).round);
}

function pumpOnce(round: Round, patch: boolean, draw: PumpDraw, balanceCents = RICH, index = 0) {
  return pump(
    frozen(round),
    {
      balloonIndex: index,
      expectedDrawIndex: balloonOf(round, index).drawIndex,
      patch,
      balanceCents,
    },
    draw,
  );
}

/** Pumps balloon `index` up `times` rungs without Patches. */
function climb(round: Round, times: number, index = 0): Round {
  let current = round;
  for (let i = 0; i < times; i += 1) {
    current = pumpOnce(current, false, alwaysSurvive, RICH, index).round;
  }
  return current;
}

function cashOutNow(round: Round, index = 0) {
  return cashOut(frozen(round), {
    balloonIndex: index,
    expectedDrawIndex: balloonOf(round, index).drawIndex,
  });
}

/** The code of the EngineError a call throws, or 'no error'. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('startRound', () => {
  it('makes one fresh balloon per bet and says what to charge', () => {
    const { round, costCents } = startRound(CONFIG, 'expert', [2000, 100_000, 10], 102_010);
    expect(costCents).toBe(102_010);
    expect(round.difficultyId).toBe('expert');
    expect(round.rtpBp).toBe(9700);
    expect(round.ladder).toEqual(fixedLadder('expert'));
    const fresh = { status: 'active', rung: 0, drawIndex: 0, patchesCents: 0, payoutCents: 0 };
    expect(round.balloons).toEqual([
      { ...fresh, betCents: 2000, topRung: 10 },
      { ...fresh, betCents: 100_000, topRung: 6 }, // the cap stops $1,000 at 47.5x
      { ...fresh, betCents: 10, topRung: 10 },
    ]);
    expect(isRoundOver(round)).toBe(false);
  });

  it('refuses a bad difficulty, bet count, bet size or balance', () => {
    const four = [100, 100, 100, 100];
    expect(refusal(() => startRound(CONFIG, 'nope', [100], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', four, RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [9], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [100_001], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [10.5], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [Number.NaN], RICH))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [100], -1))).toBe('invalid_request');
    expect(refusal(() => startRound(CONFIG, 'easy', [100], Number.NaN))).toBe('invalid_request');
  });

  it('refuses bets the balance does not cover, and says how much is needed', () => {
    try {
      startRound(CONFIG, 'easy', [500, 500], 999);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'insufficient_funds', neededCents: 1000 });
    }
    expect(startRound(CONFIG, 'easy', [500, 500], 1000).costCents).toBe(1000);
  });
});

describe('pump without a Patch', () => {
  it('survives when the roll is below num, and moves up one rung', () => {
    const { draw, dens } = scripted([96]);
    const result = pumpOnce(start('easy', [100]), false, draw);
    expect(result.outcome).toBe('survived');
    expect(result.patchChargedCents).toBeNull();
    expect(result.payoutCents).toBe(0);
    expect(dens).toEqual([101]);
    expect(result.draw).toEqual({ drawIndex: 0, den: 101, num: 97, roll: 96 });
    expect(balloonOf(result.round)).toMatchObject({ status: 'active', rung: 1, drawIndex: 1 });
  });

  it('pops when the roll is num or more, and the round is over', () => {
    const result = pumpOnce(start('easy', [100]), false, scripted([97]).draw);
    expect(result.outcome).toBe('popped');
    const after = balloonOf(result.round);
    expect(after).toMatchObject({ status: 'popped', rung: 0, drawIndex: 1, payoutCents: 0 });
    expect(isRoundOver(result.round)).toBe(true);
  });

  it('uses the next rung’s chance and the next draw index each time', () => {
    const first = pumpOnce(start('easy', [100]), false, scripted([0]).draw);
    const second = pumpOnce(first.round, false, scripted([100]).draw);
    expect(second.draw).toEqual({ drawIndex: 1, den: 111, num: 101, roll: 100 });
    const third = pumpOnce(second.round, false, scripted([37]).draw);
    expect(third.draw).toEqual({ drawIndex: 2, den: 41, num: 37, roll: 37 });
    expect(third.outcome).toBe('popped');
  });

  it('follows the RTP on the first pump only', () => {
    const first = (rtpBp: number): DrawRecord =>
      pumpOnce(start('easy', [100], at(rtpBp)), false, alwaysSurvive).draw;
    expect(first(9400)).toMatchObject({ den: 101, num: 94 });
    expect(first(9900)).toMatchObject({ den: 101, num: 99 });
    const second = (rtpBp: number): DrawRecord =>
      pumpOnce(climb(start('easy', [100], at(rtpBp)), 1), false, alwaysSurvive).draw;
    expect(second(9400)).toEqual(second(9900));
  });

  it('changes only the pumped balloon and never the round it was given', () => {
    const round = start('easy', [100, 200]);
    const result = pumpOnce(round, false, alwaysSurvive, RICH, 1);
    expect(balloonOf(round, 1).rung).toBe(0);
    expect(balloonOf(result.round, 0)).toBe(balloonOf(round, 0));
    expect(balloonOf(result.round, 1).rung).toBe(1);
  });

  it('refuses, without drawing, a wrong draw index, a finished balloon or a missing one', () => {
    const round = start('easy', [100]);
    const stale = { balloonIndex: 0, expectedDrawIndex: 1, patch: false, balanceCents: RICH };
    expect(refusal(() => pump(round, stale, noDraw))).toBe('conflict');
    const missing = { balloonIndex: 1, expectedDrawIndex: 0, patch: false, balanceCents: RICH };
    expect(refusal(() => pump(round, missing, noDraw))).toBe('invalid_request');
    const popped = pumpOnce(round, false, alwaysPop).round;
    expect(refusal(() => pumpOnce(popped, false, noDraw))).toBe('conflict');
  });

  it('lets a roll outside 0 .. den - 1 fail loudly instead of deciding anything', () => {
    expect(() => pumpOnce(start('easy', [100]), false, () => 101)).toThrow(RangeError);
    expect(() => pumpOnce(start('easy', [100]), false, () => -1)).toThrow(RangeError);
  });
});

describe('Patch + pump', () => {
  const atRungOne = (bet: number): Round => climb(start('easy', [bet]), 1);

  it('is not sold for the first pump', () => {
    expect(refusal(() => pumpOnce(start('easy', [100]), true, noDraw))).toBe('invalid_request');
  });

  it('charges the Patch and makes the one pump draw', () => {
    // $100 on Easy at 1.01x: the exact price is 938.05 cents, charged as 939.
    const { draw, dens } = scripted([100]);
    const result = pumpOnce(atRungOne(10_000), true, draw);
    expect(dens).toEqual([111]);
    expect(result.draw).toEqual({ drawIndex: 1, den: 111, num: 101, roll: 100 });
    expect(result.patchChargedCents).toBe(939);
    expect(result.outcome).toBe('survived');
    expect(balloonOf(result.round)).toMatchObject({ rung: 2, drawIndex: 2, patchesCents: 939 });
  });

  it('saves a balloon that would have popped: same rung, still in play, Patch spent', () => {
    const result = pumpOnce(atRungOne(10_000), true, scripted([101]).draw);
    expect(result.outcome).toBe('saved');
    expect(result.payoutCents).toBe(0);
    expect(balloonOf(result.round)).toMatchObject({
      status: 'active',
      rung: 1,
      drawIndex: 2,
      patchesCents: 939,
    });
    // The next pump is the same pump again, as a new draw, and a new Patch costs the same.
    const again = pumpOnce(result.round, true, scripted([101]).draw);
    expect(again.draw).toEqual({ drawIndex: 2, den: 111, num: 101, roll: 101 });
    expect(again.patchChargedCents).toBe(939);
    expect(balloonOf(again.round)).toMatchObject({ rung: 1, drawIndex: 3, patchesCents: 1878 });
  });

  it('needs a balance that covers the price, checked before the draw', () => {
    const round = atRungOne(10_000);
    try {
      pumpOnce(round, true, noDraw, 938);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'insufficient_funds', neededCents: 939 });
    }
    expect(pumpOnce(round, true, alwaysSurvive, 939).patchChargedCents).toBe(939);
    // The smallest Patch costs one cent: 0.94 of a cent, rounded up.
    expect(refusal(() => pumpOnce(atRungOne(10), true, noDraw, 0))).toBe('insufficient_funds');
    expect(pumpOnce(atRungOne(10), true, alwaysSurvive, 1).patchChargedCents).toBe(1);
    expect(refusal(() => pumpOnce(round, true, noDraw, Number.NaN))).toBe('invalid_request');
  });

  it('does not look at the balance when no Patch is bought', () => {
    expect(pumpOnce(atRungOne(10_000), false, alwaysSurvive, 0).outcome).toBe('survived');
  });

  // A Patch price is divided by the RTP, so it moves when the RTP does. The
  // check, the charge and the quote must all use the round's own RTP.
  it.each([
    [9400, 968],
    [9700, 939],
    [9900, 920],
  ])('is priced, checked and quoted at the round’s own RTP (%i: %i cents)', (rtpBp, price) => {
    const round = climb(start('easy', [10_000], at(rtpBp)), 1);
    expect(refusal(() => pumpOnce(round, true, noDraw, price - 1))).toBe('insufficient_funds');
    expect(pumpOnce(round, true, alwaysSurvive, price).patchChargedCents).toBe(price);
    expect(quoteBalloon(round, 0).next?.patchPriceCents).toBe(price);
  });
});

describe('the top rung', () => {
  it('cashes out in the same request', () => {
    // $20 on Expert can climb the whole ladder: 5,000x = $100,000.
    const round = climb(start('expert', [2000]), 9);
    const { draw, dens } = scripted([0]);
    const result = pumpOnce(round, false, draw);
    expect(result.outcome).toBe('top');
    expect(result.payoutCents).toBe(10_000_000);
    expect(dens).toEqual([4]);
    const after = balloonOf(result.round);
    expect(after).toMatchObject({ status: 'cashed', rung: 10, payoutCents: 10_000_000 });
    expect(isRoundOver(result.round)).toBe(true);
  });

  it('is lower for a bet the cap stops', () => {
    // $999.99 on Expert stops at rung 6 (47.5x), worth 4,749,952.5 cents: pays 4,749,952.
    const round = climb(start('expert', [99_999]), 5);
    expect(balloonOf(round).topRung).toBe(6);
    const result = pumpOnce(round, true, alwaysSurvive);
    expect(result.outcome).toBe('top');
    expect(result.payoutCents).toBe(4_749_952);
    expect(balloonOf(result.round)).toMatchObject({ status: 'cashed', rung: 6, drawIndex: 6 });
    // The Patch bought for the pump that reached the top is charged and recorded
    // like any other: 999.99 x 20 x 27.5 / 47.5 / 0.97 = $11,936.94.
    expect(result.patchChargedCents).toBe(1_193_694);
    expect(balloonOf(result.round).patchesCents).toBe(1_193_694);
  });

  it('pays nothing when the last pump pops', () => {
    // Pump 6 on Expert survives with chance 2000/4750 = 8/19: roll 8 is the first that pops.
    const round = climb(start('expert', [99_999]), 5);
    const result = pumpOnce(round, false, scripted([8]).draw);
    expect(result.outcome).toBe('popped');
    expect(result.payoutCents).toBe(0);
  });
});

describe('cashOut', () => {
  it('is not allowed before the first pump', () => {
    expect(refusal(() => cashOutNow(start('easy', [100])))).toBe('invalid_request');
  });

  it('pays bet x multiplier, rounded down, and makes no draw', () => {
    const exact = cashOutNow(climb(start('easy', [100]), 3));
    expect(exact.payoutCents).toBe(123);
    // $12.34 at 1.23x is worth 1517.82 cents.
    const round = climb(start('easy', [1234]), 3);
    const result = cashOutNow(round);
    expect(result.payoutCents).toBe(1517);
    const after = balloonOf(result.round);
    expect(after).toMatchObject({ status: 'cashed', rung: 3, payoutCents: 1517, drawIndex: 3 });
    expect(isRoundOver(result.round)).toBe(true);
  });

  it('refuses a wrong draw index, and a balloon already cashed or popped', () => {
    const round = climb(start('easy', [1234]), 3);
    const stale = { balloonIndex: 0, expectedDrawIndex: 2 };
    expect(refusal(() => cashOut(round, stale))).toBe('conflict');
    const cashed = cashOutNow(round).round;
    expect(refusal(() => cashOutNow(cashed))).toBe('conflict');
    expect(refusal(() => pumpOnce(cashed, false, noDraw))).toBe('conflict');
    const popped = pumpOnce(round, false, alwaysPop).round;
    expect(refusal(() => cashOutNow(popped))).toBe('conflict');
  });
});

describe('settleAbandoned', () => {
  it('cashes out pumped balloons, refunds unpumped ones, and leaves finished ones alone', () => {
    let round = start('easy', [1234, 500, 300]);
    round = climb(round, 3, 0);
    round = pumpOnce(round, false, alwaysPop, RICH, 2).round; // balloon 2 pops
    const manual = cashOutNow(round, 0);

    const result = settleAbandoned(frozen(round));
    expect(result.settled).toEqual([
      { balloonIndex: 0, kind: 'cashed', cents: 1517 },
      { balloonIndex: 1, kind: 'refunded', cents: 500 },
    ]);
    // The same cents and the same balloon as pressing Cash Out.
    expect(balloonOf(result.round, 0)).toEqual(balloonOf(manual.round, 0));
    const refunded = balloonOf(result.round, 1);
    expect(refunded).toMatchObject({ status: 'refunded', payoutCents: 0, drawIndex: 0 });
    expect(balloonOf(result.round, 2)).toBe(balloonOf(round, 2));
    expect(isRoundOver(result.round)).toBe(true);
    expect(settleAbandoned(result.round).settled).toEqual([]);
  });

  it('returns a new round and leaves the one it was given untouched', () => {
    const round = climb(start('easy', [1234, 500]), 3, 0);
    const before = JSON.stringify(round);
    const result = settleAbandoned(frozen(round));
    expect(JSON.stringify(round)).toBe(before);
    expect(result.round).not.toBe(round);
    expect(result.round.balloons).not.toBe(round.balloons);
    expect(balloonOf(round, 0).status).toBe('active');
    expect(balloonOf(round, 1).status).toBe('active');
  });
});

describe('quoteBalloon', () => {
  it('before the first pump: no multiplier, no cash-out, no Patch', () => {
    expect(quoteBalloon(start('easy', [10_000]), 0)).toEqual({
      multiplierHundredths: null,
      cashOutCents: null,
      next: { popChance: { num: 4, den: 101 }, multiplierHundredths: 101, patchPriceCents: null },
    });
  });

  it('after a pump: multiplier, cash-out value, next pop chance and Patch price', () => {
    expect(quoteBalloon(climb(start('easy', [10_000]), 1), 0)).toEqual({
      multiplierHundredths: 101,
      cashOutCents: 10_100,
      next: {
        popChance: { num: 10, den: 111 },
        multiplierHundredths: 111,
        patchPriceCents: 939,
      },
    });
    expect(quoteBalloon(climb(start('easy', [1234]), 3), 0).cashOutCents).toBe(1517);
  });

  it.each([
    [9400, { num: 7, den: 101 }],
    [9700, { num: 4, den: 101 }],
    [9900, { num: 2, den: 101 }],
  ] as const)('shows the first pump’s pop chance at the round’s own RTP (%i)', (rtpBp, pop) => {
    expect(quoteBalloon(start('easy', [10_000], at(rtpBp)), 0).next?.popChance).toEqual(pop);
  });

  it('quotes the balloon it is asked about', () => {
    const round = climb(start('easy', [10_000, 200]), 2, 1);
    expect(quoteBalloon(round, 1)).toEqual({
      multiplierHundredths: 111,
      cashOutCents: 222,
      next: { popChance: { num: 4, den: 41 }, multiplierHundredths: 123, patchPriceCents: 23 },
    });
    expect(quoteBalloon(round, 0).multiplierHundredths).toBeNull();
    expect(refusal(() => quoteBalloon(round, 2))).toBe('invalid_request');
  });

  it.each(RTPS)('quotes exactly what a cash-out pays and a Patch costs at %i', (rtpBp) => {
    const round = climb(start('hard', [777], at(rtpBp)), 4);
    const quote = quoteBalloon(round, 0);
    expect(cashOutNow(round).payoutCents).toBe(quote.cashOutCents);
    expect(pumpOnce(round, true, alwaysSurvive).patchChargedCents).toBe(
      quote.next?.patchPriceCents,
    );
  });

  it('once over: the multiplier it reached, and nothing to do next', () => {
    const over = { cashOutCents: null, next: null };
    const cashed = cashOutNow(climb(start('easy', [100]), 2)).round;
    expect(quoteBalloon(cashed, 0)).toEqual({ ...over, multiplierHundredths: 111 });
    const popped = pumpOnce(start('easy', [100]), false, alwaysPop).round;
    expect(quoteBalloon(popped, 0)).toEqual({ ...over, multiplierHundredths: null });
  });
});

describe('replayBalloon', () => {
  it('gives the same balloon and the same draws as live play', () => {
    const rolls = [0, 101, 100];
    const live = scripted(rolls);
    const started = start('easy', [10_000, 100]);
    const first = pumpOnce(started, false, live.draw);
    const second = pumpOnce(first.round, true, live.draw); // saved
    const third = pumpOnce(second.round, true, live.draw); // survived
    const end = cashOutNow(third.round);

    const actions: BalloonAction[] = [
      { kind: 'pump', patch: false },
      { kind: 'pump', patch: true },
      { kind: 'pump', patch: true },
      { kind: 'cashOut' },
    ];
    // The replay asks for each roll by its draw index, in order: 0, 1, 2.
    const asked: number[] = [];
    const byIndex: ReplayDraw = (drawIndex) => {
      asked.push(drawIndex);
      return rolls[drawIndex] ?? -1;
    };
    const replayed = replayBalloon(started, 0, actions, byIndex);
    expect(asked).toEqual([0, 1, 2]);
    expect(replayed.balloon).toEqual(balloonOf(end.round));
    expect(replayed.draws).toEqual([first.draw, second.draw, third.draw]);
    expect(replayed.balloon).toMatchObject({
      status: 'cashed',
      rung: 2,
      drawIndex: 3,
      patchesCents: 1878,
      payoutCents: 11_100,
    });
  });

  it('refuses actions that could not have happened', () => {
    const started = start('easy', [100]);
    const replay = (actions: readonly BalloonAction[], drawAt: ReplayDraw) => () =>
      replayBalloon(started, 0, actions, drawAt);
    const popsAt: ReplayDraw = (_drawIndex, den) => den - 1;
    const never: ReplayDraw = () => {
      throw new Error('an action that could not have happened must not draw');
    };
    const afterPop: BalloonAction[] = [{ kind: 'pump', patch: false }, { kind: 'cashOut' }];
    expect(refusal(replay(afterPop, popsAt))).toBe('invalid_request');
    expect(refusal(replay([{ kind: 'cashOut' }], never))).toBe('invalid_request');
    expect(refusal(replay([{ kind: 'pump', patch: true }], never))).toBe('invalid_request');
  });
});

/**
 * The whole point, end to end: play a strategy through the engine down every
 * possible path, weigh each path by its exact chance, and compare the money
 * paid back with RTP times the money paid in. It must never be more. It may
 * be less only by cent rounding: under one cent for the payout, and under one
 * cent for each Patch bought. With nothing to round it must be exactly equal.
 */
describe('no way of playing returns more than the RTP', () => {
  type Fr = readonly [bigint, bigint];
  const add = (a: Fr, b: Fr): Fr => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
  const times = (a: Fr, b: Fr): Fr => [a[0] * b[0], a[1] * b[1]];

  interface Played {
    readonly paidCents: number;
    readonly returnedCents: number;
    readonly draws: readonly DrawRecord[];
  }
  class NeedsAnotherChoice extends Error {}

  /**
   * Exact expected money paid in and paid back. Each pump has two outcomes:
   * it survives (roll 0 stands for every roll below num) or it does not (roll
   * den - 1). The search tries both at every pump; a path's chance is the
   * product of num/den or (den - num)/den over its pumps, read from the
   * engine's own draw records.
   */
  function expectation(play: (draw: PumpDraw) => Played): { paid: Fr; returned: Fr } {
    let paid: Fr = [0n, 1n];
    let returned: Fr = [0n, 1n];
    const explore = (choices: readonly boolean[]): void => {
      let used = 0;
      const draw: PumpDraw = (den) => {
        const survive = choices[used];
        if (survive === undefined) throw new NeedsAnotherChoice();
        used += 1;
        return survive ? 0 : den - 1;
      };
      let played: Played;
      try {
        played = play(draw);
      } catch (error) {
        if (!(error instanceof NeedsAnotherChoice)) throw error;
        explore([...choices, true]);
        explore([...choices, false]);
        return;
      }
      let chance: Fr = [1n, 1n];
      for (const d of played.draws) {
        chance = times(chance, [BigInt(d.roll < d.num ? d.num : d.den - d.num), BigInt(d.den)]);
      }
      paid = add(paid, times(chance, [BigInt(played.paidCents), 1n]));
      returned = add(returned, times(chance, [BigInt(played.returnedCents), 1n]));
    };
    explore([]);
    return { paid, returned };
  }

  /** Pump to `target` (or the top), buying a Patch on the first `patches` pumps that allow one. */
  const strategy =
    (config: GameConfig, difficultyId: string, bet: number, target: number, patches: number) =>
    (draw: PumpDraw): Played => {
      let round = startRound(config, difficultyId, [bet], RICH).round;
      const draws: DrawRecord[] = [];
      let paidCents = bet;
      let bought = 0;
      for (;;) {
        const balloon = balloonOf(round);
        if (balloon.status !== 'active') break;
        if (balloon.rung >= target) {
          round = cashOutNow(round).round;
          break;
        }
        const patch = balloon.rung >= 1 && bought < patches;
        const result = pumpOnce(round, patch, draw);
        if (patch) bought += 1;
        paidCents += result.patchChargedCents ?? 0;
        draws.push(result.draw);
        round = result.round;
      }
      return { paidCents, returnedCents: balloonOf(round).payoutCents, draws };
    };

  const cases: readonly (readonly [string, number, number, number])[] = [
    // difficulty, bet in cents, target rung, Patches bought
    ['easy', 10, 3, 0],
    ['easy', 11, 3, 2],
    ['easy', 13, 4, 1],
    ['easy', 1234, 3, 2],
    ['easy', 100, 2, 3],
    ['medium', 10, 2, 2],
    ['medium', 99, 3, 1],
    ['hard', 11, 2, 2],
    ['hard', 777, 3, 0],
    ['expert', 10, 3, 2],
    ['expert', 25, 2, 3],
    ['expert', 99_999, 6, 0], // stopped by the cap: the top rung is worth 4,749,952.5 cents
    ['expert', 99_999, 6, 2],
  ];

  describe.each(RTPS)('at RTP %i', (rtpBp) => {
    it.each(cases)('%s, bet %i cents, to rung %i, %i Patches', (id, bet, target, patches) => {
      const { paid, returned } = expectation(strategy(at(rtpBp), id, bet, target, patches));
      // short = RTP * paid - returned, in cents, as a fraction [top, bottom]
      const top = BigInt(rtpBp) * paid[0] * returned[1] - returned[0] * paid[1] * 10_000n;
      const bottom = paid[1] * returned[1] * 10_000n;
      expect(top >= 0n).toBe(true); // never more than the RTP
      expect(top < BigInt(1 + patches) * bottom).toBe(true); // under a cent per rounded amount
    });

    // Whole-dollar bets cash out to whole cents, so with no Patch nothing is rounded.
    it.each([
      ['easy', 100, 5],
      ['easy', 100_000, 24],
      ['medium', 500, 4],
      ['hard', 10_000, 14],
      ['expert', 2000, 10], // the whole ladder, to 5,000x
      ['expert', 100_000, 6],
    ] as const)('exactly the RTP: %s, bet %i cents, to rung %i, no Patch', (id, bet, target) => {
      const { paid, returned } = expectation(strategy(at(rtpBp), id, bet, target, 0));
      expect(returned[0] * paid[1] * 10_000n).toBe(BigInt(rtpBp) * paid[0] * returned[1]);
    });
  });
});
