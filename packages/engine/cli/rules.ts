/**
 * The game's math worked out from the configuration alone: the RTP, a ladder
 * and the payout cap. Nothing in this file calls the engine.
 *
 * `npm run rtp` and `npm run sim` hold the engine up against these numbers.
 * If they asked the engine what the right answer is, an engine that is wrong
 * would be measured against itself and pass.
 *
 * The rules, with h_k the multiplier on rung k in hundredths (101 = 1.01x),
 * the RTP in basis points (9700 = 97%) and money in cents:
 *
 *     pump 1 survives with chance   RTP / (100 x h_1)
 *     pump k survives with chance   h_(k-1) / h_k              (k >= 2)
 *     payout       =  bet x h_k / 100, rounded down
 *     Patch price  =  bet x h_(k-1) x (h_k - h_(k-1)) x 100 / (h_k x RTP),
 *                     rounded up
 *     top rung     =  the highest k with bet x h_k <= cap x 100
 */
import { fr, type Fr } from './fraction';

function h(ladder: readonly number[], rung: number): bigint {
  const value = ladder[rung - 1];
  if (value === undefined) throw new RangeError(`The ladder has no rung ${String(rung)}`);
  return BigInt(value);
}

/** The chance that pump `pump` survives. */
export function ruleSurvive(rtpBp: number, ladder: readonly number[], pump: number): Fr {
  return pump === 1
    ? fr(BigInt(rtpBp), 100n * h(ladder, 1))
    : fr(h(ladder, pump - 1), h(ladder, pump));
}

/** What cashing out on `rung` pays, in cents. */
export function rulePayoutCents(betCents: number, ladder: readonly number[], rung: number): number {
  return Number((BigInt(betCents) * h(ladder, rung)) / 100n);
}

/** The exact Patch price for pump `pump` (2 or later) as a share of the bet, before rounding. */
export function rulePatchShare(rtpBp: number, ladder: readonly number[], pump: number): Fr {
  const current = h(ladder, pump - 1);
  const next = h(ladder, pump);
  return fr(current * (next - current) * 100n, next * BigInt(rtpBp));
}

/** What a Patch for pump `pump` (2 or later) costs, in cents. */
export function rulePatchPriceCents(
  rtpBp: number,
  ladder: readonly number[],
  betCents: number,
  pump: number,
): number {
  const share = rulePatchShare(rtpBp, ladder, pump);
  const top = BigInt(betCents) * share.n;
  return Number((top + share.d - 1n) / share.d);
}

/** The highest rung this bet can reach under the payout cap. 0 if it can reach none. */
export function ruleTopRung(
  ladder: readonly number[],
  betCents: number,
  maxPayoutCents: number,
): number {
  const cap = BigInt(maxPayoutCents) * 100n;
  let top = 0;
  for (let rung = 1; rung <= ladder.length; rung += 1) {
    if (BigInt(betCents) * h(ladder, rung) <= cap) top = rung;
  }
  return top;
}
