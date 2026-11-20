/**
 * Whether a finished round is a real win, and how big. Both the win effects
 * on the balloons and the win sound come from here, so they always agree.
 *
 * The rule (UK RTS 14F, Ontario AGCO 2.20): never celebrate a return at or
 * below the total stake. A round with 2 or 3 balloons is one game, so it is
 * judged as a whole: total payout against total bet plus every Patch. A
 * balloon that cashes out mid-round gets no win effect of its own; if the
 * round ends in profit, the effects play then.
 *
 * Tiers are multiples of the round's total stake, the way slots set their
 * big-win levels by multiples of the bet. Money is compared in integer cents.
 */

import type { RoundView } from '../api/contract';

export type WinTier = 1 | 2 | 3;

/** Payout as a multiple of total stake at which tiers 2 and 3 start. */
export const WIN_TIER_MULTIPLES = { tier2: 2, tier3: 10 } as const;

/** What the round cost: every bet plus every Patch. */
export function roundStakeCents(round: RoundView): number {
  return round.balloons.reduce((sum, b) => sum + b.betCents + b.patchesCents, 0);
}

export function roundPayoutCents(round: RoundView): number {
  return round.balloons.reduce((sum, b) => sum + b.payoutCents, 0);
}

/** The win tier of a finished round, or null when it is not a real gain. */
export function roundWinTier(round: RoundView): WinTier | null {
  if (round.status !== 'finished') return null;
  const stake = roundStakeCents(round);
  const paid = roundPayoutCents(round);
  if (paid <= stake) return null;
  if (paid >= WIN_TIER_MULTIPLES.tier3 * stake) return 3;
  if (paid >= WIN_TIER_MULTIPLES.tier2 * stake) return 2;
  return 1;
}
