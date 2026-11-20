import type { HistoryResponse, SessionView } from '@pump/contract';
import type { RoundsRepository } from '../repositories/rounds';
import type { FairnessService } from './fairness';
import type { WalletService } from './wallet';

export type SessionService = ReturnType<typeof sessionService>;

/** What the screen needs when it loads: the wallet, the seeds, and past rounds. */
export function sessionService(
  wallet: WalletService,
  fairness: FairnessService,
  rounds: RoundsRepository,
) {
  return {
    view(playerId: string): SessionView {
      return {
        wallet: { balanceCents: wallet.balanceOf(playerId) },
        fairness: fairness.view(playerId),
        // Rounds cannot be started yet: that arrives with the game service,
        // which will fill this in so a page refresh can restore a round.
        activeRound: null,
      };
    },

    /** The player's latest finished rounds, newest first. */
    history(playerId: string, limit: number): HistoryResponse {
      return {
        rounds: rounds.latestFinished(playerId, limit).map((round) => ({
          id: round.id,
          difficultyId: round.difficultyId,
          balloonCount: round.balloonCount,
          betCents: round.betCents,
          patchesCents: round.patchesCents,
          payoutCents: round.payoutCents,
          serverSeedHash: round.serverSeedHash,
          nonce: round.nonce,
          finishedAt: round.finishedAt,
        })),
      };
    },
  };
}
