import { ladderProblems, LIMITS, popChance } from '@pump/engine';
import { describe, expect, it } from 'vitest';
import type { Fraction } from '../src/api/contract';
import { balloonTension, popRange, riskStep, tensionFloor, tensionStep } from '../src/game/risk';
import { balloon, round } from './fixtures';

/**
 * Made-up ladders for these tests only (not configured ones). All keep the
 * pop chance rising at 94, 97 and 99% RTP, which the first test checks.
 */
const LADDER = [110, 140, 180, 240, 330];
/** Small steps, like Easy: every pop chance stays under 25%. */
const GENTLE = [101, 109, 118, 128, 139];
/** Steep, like Expert: every pop chance is 40% or more, the first one too. */
const STEEP = [170, 320, 640, 1400, 3300];
const RTPS = [9400, 9700, 9900] as const;

const pct = (num: number): Fraction => ({ num, den: 100 });

/** a/b == c/d. */
const same = (x: Fraction | undefined, y: Fraction): boolean =>
  x !== undefined && x.num * y.den === y.num * x.den;

/** A balloon on `ladder` at `rung`, its next pump's chance as the server would publish it. */
function at(ladder: readonly number[], rtpBp: number, rung: number, topRung = ladder.length) {
  return balloon({
    rung,
    topRung,
    next: {
      popChance: popChance(rtpBp, ladder, rung + 1),
      multiplierHundredths: ladder[rung] ?? 0,
      patchPriceCents: null,
    },
  });
}

it('uses fixture ladders the game would accept at every tested RTP', () => {
  for (const rtpBp of RTPS) {
    for (const ladder of [LADDER, GENTLE, STEEP]) {
      expect(ladderProblems(rtpBp, ladder, LIMITS)).toEqual([]);
    }
  }
});

describe('tensionStep', () => {
  // A range from 10% to 50%: its quarters start at 20%, 30% and 40%.
  const range = { lowest: pct(10), highest: pct(50) };

  it('puts a chance in the quarter of the range it sits in, a quarter mark counting upward', () => {
    expect(tensionStep(pct(10), range)).toBe(0);
    expect(tensionStep({ num: 1999, den: 10000 }, range)).toBe(0);
    expect(tensionStep(pct(20), range)).toBe(1);
    expect(tensionStep(pct(29), range)).toBe(1);
    expect(tensionStep(pct(30), range)).toBe(2);
    expect(tensionStep({ num: 3999, den: 10000 }, range)).toBe(2);
    expect(tensionStep(pct(40), range)).toBe(3);
    expect(tensionStep(pct(50), range)).toBe(3);
  });

  it('reads the same chance the same however it is written', () => {
    expect(tensionStep({ num: 1, den: 5 }, range)).toBe(tensionStep(pct(20), range));
    const tenths = { lowest: { num: 1, den: 10 }, highest: { num: 5, den: 10 } };
    expect(tensionStep({ num: 3, den: 10 }, tenths)).toBe(tensionStep(pct(30), range));
  });

  it('counts a chance outside the range as its nearest end', () => {
    expect(tensionStep(pct(5), range)).toBe(0);
    expect(tensionStep(pct(90), range)).toBe(3);
  });

  it('is 0 for a range with no width: a single pump has nothing to compare', () => {
    expect(tensionStep(pct(30), { lowest: pct(30), highest: pct(30) })).toBe(0);
  });

  it('is exact with denominators near 2^32, where plain number products would round', () => {
    const den = 4_294_967_291; // the largest prime below 2^32
    const wide = { lowest: { num: 1, den }, highest: { num: den - 1, den } };
    // Exactly halfway starts step 2; a hair below it is still step 1.
    expect(tensionStep({ num: 1, den: 2 }, wide)).toBe(2);
    expect(tensionStep({ num: (den - 1) / 2, den }, wide)).toBe(1);
  });
});

describe('popRange', () => {
  for (const rtpBp of RTPS) {
    it(`spans pump 1 to the top pump of the balloon's own ladder, at RTP ${rtpBp}`, () => {
      const full = popRange(rtpBp, LADDER, LADDER.length);
      // Pump 1 carries the house edge: 1 - R / m_1 = (11000 - R) / 11000.
      expect(same(full?.lowest, { num: 11000 - rtpBp, den: 11000 })).toBe(true);
      // The top pump: 1 - m_4 / m_5 = 1 - 240/330.
      expect(same(full?.highest, { num: 90, den: 330 })).toBe(true);
      // A balloon the payout cap stops at rung 3 has a narrower range: up to 1 - 140/180.
      expect(same(popRange(rtpBp, LADDER, 3)?.highest, { num: 40, den: 180 })).toBe(true);
    });
  }

  it('has nothing to span with no pump', () => {
    expect(popRange(9700, LADDER, 0)).toBeNull();
  });

  it('gives no range, rather than breaking the screen, for numbers the engine refuses', () => {
    // An RTP at or above the first multiplier could never pop: the engine refuses it.
    expect(popRange(11000, LADDER, LADDER.length)).toBeNull();
    const b = balloon({
      next: { popChance: pct(10), multiplierHundredths: 110, patchPriceCents: null },
    });
    expect(balloonTension({ rtpBp: 11000, ladder: LADDER }, b)).toBe(0);
  });
});

describe('balloonTension', () => {
  for (const rtpBp of RTPS) {
    it(`goes from calm to most tense within the balloon's own range, at RTP ${rtpBp}`, () => {
      for (const ladder of [LADDER, GENTLE]) {
        for (const topRung of [ladder.length, 3]) {
          const r = round([], { rtpBp, ladder });
          const tensions = Array.from({ length: topRung }, (_, rung) =>
            balloonTension(r, at(ladder, rtpBp, rung, topRung)),
          );
          expect(tensions[0]).toBe(0);
          expect(tensions[topRung - 1]).toBe(3);
          for (let i = 1; i < tensions.length; i += 1) {
            expect(tensions[i]).toBeGreaterThanOrEqual(tensions[i - 1] ?? 0);
          }
        }
      }
    });
  }

  it('shows tension where every chance is in the lowest absolute step', () => {
    for (const rtpBp of RTPS) {
      const r = round([], { rtpBp, ladder: GENTLE });
      const last = at(GENTLE, rtpBp, GENTLE.length - 1);
      // Absolutely (riskStep), under 25% is the first step: no floor...
      expect(riskStep(last.next?.popChance ?? pct(100))).toBe(1);
      expect(tensionFloor(last.next?.popChance ?? pct(100))).toBe(0);
      // ...but this is still the balloon's tensest pump.
      expect(balloonTension(r, last)).toBe(3);
    }
  });

  for (const rtpBp of RTPS) {
    it(`never draws a pump at 40% or more calm, even early on a steep ladder, at RTP ${rtpBp}`, () => {
      const r = round([], { rtpBp, ladder: STEEP });
      const first = at(STEEP, rtpBp, 0);
      const chance = first.next?.popChance ?? pct(0);
      // The first pump is the bottom of its own range...
      const range = popRange(rtpBp, STEEP, STEEP.length);
      if (!range) throw new Error('fixture');
      expect(tensionStep(chance, range)).toBe(0);
      // ...but it pops 40% of the time or more, so the floor lifts it to 2.
      expect(chance.num * 100).toBeGreaterThanOrEqual(chance.den * 40);
      expect(balloonTension(r, first)).toBe(2);
    });

    it(`is the higher of its own-range step and the absolute floor, at RTP ${rtpBp}`, () => {
      for (const ladder of [LADDER, GENTLE, STEEP]) {
        for (const topRung of [ladder.length, 3]) {
          const r = round([], { rtpBp, ladder });
          const range = popRange(rtpBp, ladder, topRung);
          if (!range) throw new Error('fixture');
          for (let rung = 0; rung < topRung; rung += 1) {
            const b = at(ladder, rtpBp, rung, topRung);
            const chance = b.next?.popChance ?? pct(0);
            const own = tensionStep(chance, range);
            const floor = tensionFloor(chance);
            expect(balloonTension(r, b)).toBe(Math.max(own, floor));
          }
        }
      }
    });
  }

  it('puts the floor at the absolute steps: under 25%, 40% and 60%', () => {
    expect(tensionFloor({ num: 2499, den: 10000 })).toBe(0);
    expect(tensionFloor(pct(25))).toBe(1);
    expect(tensionFloor({ num: 3999, den: 10000 })).toBe(1);
    expect(tensionFloor(pct(40))).toBe(2);
    expect(tensionFloor({ num: 5999, den: 10000 })).toBe(2);
    expect(tensionFloor(pct(60))).toBe(3);
    expect(tensionFloor(pct(100))).toBe(3);
  });

  it('is undefined once the balloon is over', () => {
    const r = round([], { ladder: LADDER });
    expect(balloonTension(r, at(LADDER, 9700, 2))).toBeDefined();
    expect(balloonTension(r, { ...at(LADDER, 9700, 2), status: 'cashed' })).toBeUndefined();
    expect(balloonTension(r, { ...at(LADDER, 9700, 2), next: null })).toBeUndefined();
  });
});
