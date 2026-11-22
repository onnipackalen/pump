import type { GameService } from './services/game';

/** The two log levels the sweep uses. The server's own logger fits this. */
export interface SweepLog {
  info(details: { readonly settled: number }, message: string): void;
  error(details: unknown, message: string): void;
}

/**
 * One run of the 24-hour rule for players who never come back. index.ts calls
 * it every ten minutes. It is here, not in index.ts, so a test can run it:
 * this is the only place a round the sweep could not settle is logged.
 *
 * Each such round is logged as an error, with its round, its player and the
 * error. Nothing about it was changed, it stays active, and the next sweep
 * tries it again. This never throws: a sweep that fails as a whole (say, it
 * could not even list the idle rounds) is logged as an error too.
 */
export function runAbandonedSweep(game: Pick<GameService, 'sweepAbandoned'>, log: SweepLog): void {
  try {
    const { settled, failed } = game.sweepAbandoned();
    if (settled > 0) log.info({ settled }, 'settled abandoned rounds');
    for (const { roundId, playerId, error } of failed) {
      log.error(
        { err: error, roundId, playerId },
        'could not settle an abandoned round: nothing was changed, it stays active, the next sweep tries again',
      );
    }
  } catch (error) {
    log.error(error, 'the abandoned-round sweep failed');
  }
}
