import { popChance } from '@pump/engine';
import type { BalloonView, Fraction, RoundView } from '../api/contract';

/**
 * Which of the four absolute risk steps a pop chance is in: under 25%,
 * under 40%, under 60%, and above. The same steps on every difficulty. It
 * reads only the chance the player is shown (an exact fraction, compared in
 * whole numbers), never a draw.
 *
 * It is the floor under a balloon's tension (see balloonTension): a pump
 * this likely to pop is never drawn calmer than its step, whatever the
 * difficulty.
 */
export function riskStep({ num, den }: Fraction): 1 | 2 | 3 | 4 {
  if (num * 100 < den * 25) return 1;
  if (num * 100 < den * 40) return 2;
  if (num * 100 < den * 60) return 3;
  return 4;
}

/**
 * How tense the next pump is, 0 (calm) to 3 (most tense). The balloon's
 * strain and the length of its press both come from this one number.
 */
export type Tension = 0 | 1 | 2 | 3;

/** The pop chances one balloon can face: its first pump's and its riskiest one's. */
export interface PopRange {
  readonly lowest: Fraction;
  readonly highest: Fraction;
}

/** a/b < c/d, in whole numbers (BigInt, so no product can lose a digit). */
function below(x: Fraction, y: Fraction): boolean {
  return BigInt(x.num) * BigInt(y.den) < BigInt(y.num) * BigInt(x.den);
}

/**
 * The lowest and highest pop chance over pumps 1 to topRung of a ladder, at
 * an RTP: the engine's own exact fractions. On a valid ladder the chance
 * rises with every pump, so these are pump 1 and the top pump; all of them
 * are looked at anyway, so the answer never leans on that.
 *
 * Null when there is no pump to look at, or when the engine refuses the
 * numbers. A round always carries numbers the server played with, so the
 * second never happens; if it did, the balloon would just show no tension
 * instead of breaking the screen.
 */
export function popRange(rtpBp: number, ladder: readonly number[], topRung: number): PopRange | null {
  const last = Math.min(topRung, ladder.length);
  if (last < 1) return null;
  try {
    let lowest = popChance(rtpBp, ladder, 1);
    let highest = lowest;
    for (let pump = 2; pump <= last; pump += 1) {
      const chance = popChance(rtpBp, ladder, pump);
      if (below(chance, lowest)) lowest = chance;
      if (below(highest, chance)) highest = chance;
    }
    return { lowest, highest };
  } catch {
    return null;
  }
}

/**
 * Where a pop chance sits in a balloon's own range, in quarter steps:
 *
 *     position = (chance - lowest) / (highest - lowest)
 *     tension  = 0 below 1/4, 1 below 1/2, 2 below 3/4, 3 from 3/4 up
 *
 * So on this reading the first pump is always 0 and the pump that reaches
 * the top is always 3, on every difficulty: Easy's chances are small, but
 * its last pumps are still the tensest of that balloon. (balloonTension
 * then lifts it to the absolute floor, so a steep ladder's early pumps are
 * not drawn calm.)
 *
 * In whole numbers, with chance = a/b, lowest = c/d and highest = e/f:
 *
 *     position = (a*d - c*b) * f  /  (b * (e*d - c*f))
 *
 * and "position >= k/4" is "4 * (a*d - c*b) * f >= k * b * (e*d - c*f)".
 * A chance outside the range counts as its nearest end. A range with no
 * width (a balloon with a single pump) has nothing to compare: 0.
 */
export function tensionStep(chance: Fraction, range: PopRange): Tension {
  const a = BigInt(chance.num);
  const b = BigInt(chance.den);
  const c = BigInt(range.lowest.num);
  const d = BigInt(range.lowest.den);
  const e = BigInt(range.highest.num);
  const f = BigInt(range.highest.den);
  const above = (a * d - c * b) * f;
  const width = b * (e * d - c * f);
  if (width <= 0n || above <= 0n) return 0;
  if (4n * above >= 3n * width) return 3;
  if (4n * above >= 2n * width) return 2;
  if (4n * above >= width) return 1;
  return 0;
}

/**
 * The absolute floor under the tension: one less than the risk step, so
 *
 *     below 25% -> 0,  25% to 40% -> 1,  40% to 60% -> 2,  60% and up -> 3
 *
 * The same on every difficulty.
 */
export function tensionFloor(chance: Fraction): Tension {
  const step = riskStep(chance);
  return step === 1 ? 0 : step === 2 ? 1 : step === 3 ? 2 : 3;
}

/**
 * The one helper for a balloon's tension: the strain the art shows and the
 * press the game waits out both read it, so they can never disagree.
 *
 * It reads only what the player is shown before the pump: the published
 * chance that the next pump pops, worked out from the RTP and ladder the
 * round was played with. Never anything about a draw. Two readings of that
 * one chance, and the tension is the higher:
 *
 *     tension = max( tensionStep(chance, this balloon's own range),
 *                    tensionFloor(chance) )
 *
 * - Its own range (pumps 1 to topRung) lets every difficulty climb: Easy's
 *   chances are all small, but its last pumps are still its tensest.
 * - The floor stops that from turning risk upside down: a pump at 40% or
 *   more is never drawn calm because it is early on a steep ladder (Expert's
 *   first pumps are already 39% to 47%).
 *
 * Both rise with the chance, so the tension never falls as a balloon goes
 * up its ladder, and on a balloon with two or more pumps the top pump is
 * 3. Undefined once the balloon is over or has no next pump.
 */
export function balloonTension(
  round: Pick<RoundView, 'rtpBp' | 'ladder'>,
  balloon: BalloonView,
): Tension | undefined {
  const next = balloon.next;
  if (balloon.status !== 'active' || !next) return undefined;
  const floor = tensionFloor(next.popChance);
  const range = popRange(round.rtpBp, round.ladder, balloon.topRung);
  const own = range ? tensionStep(next.popChance, range) : 0;
  return own > floor ? own : floor;
}

/**
 * How long a pump's "press" lasts at each tension, in milliseconds. The air
 * pocket takes exactly this long to run up the hose, and balloon.css has the
 * same four numbers (--pb-press-ms for data-strain 0 to 3); a test checks
 * that the two lists match.
 */
export const PRESS_MS = [300, 360, 420, 480] as const;

/**
 * The shortest time a pump is shown as "press" before its answer may be
 * shown: longer the tenser the pump. It comes from the balloon as it was
 * when the pump was pressed (balloonTension), so it is the same whatever
 * the pump's result will be. A balloon with no next pump gets the shortest.
 */
export function pressMs(round: Pick<RoundView, 'rtpBp' | 'ladder'>, balloon: BalloonView): number {
  return PRESS_MS[balloonTension(round, balloon) ?? 0];
}
