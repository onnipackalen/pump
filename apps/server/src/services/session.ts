import type { HistoryResponse, SessionView } from '@pump/contract';
import { ApiError } from '../errors';
import type { RoundsRepository } from '../repositories/rounds';
import type { FairnessService } from './fairness';
import type { GameService } from './game';
import type { WalletService } from './wallet';

export type SessionService = ReturnType<typeof sessionService>;

/** What the screen needs when it loads: the wallet, the seeds, and past rounds. */
export function sessionService(
  wallet: WalletService,
  fairness: FairnessService,
  game: GameService,
  rounds: RoundsRepository,
) {
  return {
    view(playerId: string): SessionView {
      return {
        wallet: { balanceCents: wallet.balanceOf(playerId) },
        fairness: fairness.view(playerId),
        // The round in progress, so a page refresh picks up where it was.
        activeRound: game.activeView(playerId),
      };
    },

    /**
     * The player's finished rounds, newest first, at most `limit` of them.
     * With `before`, the id of one of their finished rounds, the page starts
     * right after that round. `more` says whether older rounds remain.
     */
    history(playerId: string, limit: number, before: string | null = null): HistoryResponse {
      const after = before === null ? null : rounds.placeOfFinished(playerId, before);
      if (before !== null && after === null) {
        // Another player's round, a round still in play, or no round at all.
        // All three get the same answer, as on the verify address, so it
        // never tells whether someone else has a round with that id.
        throw new ApiError('not_found', 'There is no finished round of yours with that id.');
      }
      // One more than asked for: if it comes back, older rounds remain.
      const found = rounds.latestFinished(playerId, limit + 1, after);
      return {
        rounds: found.slice(0, limit).map((round) => ({
          id: round.id,
          difficultyId: round.difficultyId,
          balloonCount: round.balloonCount,
          betCents: round.betCents,
          patchesCents: round.patchesCents,
          payoutCents: round.payoutCents,
          refundedCents: round.refundedCents,
          serverSeedHash: round.serverSeedHash,
          nonce: round.nonce,
          finishedAt: round.finishedAt,
          seedRevealed: round.seedRevealed,
        })),
        more: found.length > limit,
      };
    },
  };
}
