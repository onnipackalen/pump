import { ApiError } from '../errors';
import type { LedgerKind, LedgerRepository } from '../repositories/ledger';

/** Which balloon a movement of money belongs to. */
export interface BalloonRef {
  readonly roundId: string;
  readonly balloonIndex: number;
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('An amount of money must be a positive whole number of cents');
  }
}

export type WalletService = ReturnType<typeof walletService>;

/**
 * The wallet. Every cent that moves goes through here, and each movement is
 * one ledger row plus the matching balance change, in the caller's
 * transaction. Callers pass positive amounts; the wallet applies the sign.
 */
export function walletService(ledger: LedgerRepository) {
  function post(
    playerId: string,
    kind: LedgerKind,
    signedCents: number,
    ref: BalloonRef | null,
    at: string,
  ): number | null {
    return ledger.append({
      playerId,
      kind,
      amountCents: signedCents,
      roundId: ref?.roundId ?? null,
      balloonIndex: ref?.balloonIndex ?? null,
      at,
    });
  }

  return {
    /**
     * Takes money for a bet or a Patch. The balance check and the charge are
     * one step: if the player cannot afford it, nothing is written and the
     * request is refused.
     */
    charge(
      playerId: string,
      kind: 'bet' | 'patch',
      cents: number,
      ref: BalloonRef,
      at: string,
    ): number {
      assertCents(cents);
      const balance = post(playerId, kind, -cents, ref, at);
      if (balance === null) {
        throw new ApiError('insufficient_funds', 'Your balance is too low for this', {
          wallet: () => ({ balanceCents: ledger.balanceOf(playerId) }),
        });
      }
      return balance;
    },

    /** Pays a cash-out, or gives back a bet that was never played. */
    credit(
      playerId: string,
      kind: 'payout' | 'refund',
      cents: number,
      ref: BalloonRef,
      at: string,
    ): number {
      assertCents(cents);
      const balance = post(playerId, kind, cents, ref, at);
      if (balance === null) throw new Error('A credit can never be refused');
      return balance;
    },

    /** The opening balance of a new player. The database allows it once. */
    grant(playerId: string, cents: number, at: string): number {
      assertCents(cents);
      const balance = post(playerId, 'grant', cents, null, at);
      if (balance === null) throw new Error('A grant can never be refused');
      return balance;
    },

    balanceOf(playerId: string): number {
      return ledger.balanceOf(playerId);
    },
  };
}
