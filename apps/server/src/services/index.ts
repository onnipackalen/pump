import { assertValidConfig } from '@pump/engine';
import { idempotencyRepository } from '../repositories/idempotency';
import { ledgerRepository } from '../repositories/ledger';
import { playersRepository } from '../repositories/players';
import { roundsRepository } from '../repositories/rounds';
import { seedsRepository } from '../repositories/seeds';
import type { Runtime } from '../runtime';
import { fairnessService, type FairnessService } from './fairness';
import { gameService, type GameService } from './game';
import { idempotencyService, type IdempotencyService } from './idempotency';
import { playersService, type PlayersService } from './players';
import { publicWinsService, type PublicWinsService } from './publicWins';
import { sessionService, type SessionService } from './session';
import { settingsService, type SettingsService } from './settings';
import { statsService, type StatsService } from './stats';
import { walletService, type WalletService } from './wallet';

export interface Services {
  readonly wallet: WalletService;
  readonly players: PlayersService;
  readonly fairness: FairnessService;
  readonly game: GameService;
  readonly session: SessionService;
  readonly stats: StatsService;
  readonly publicWins: PublicWinsService;
  readonly settings: SettingsService;
  readonly idempotency: IdempotencyService;
}

/**
 * Builds the layers once, bottom up: repositories hold the SQL, services hold
 * the rules, and the routes (in ../routes) only translate HTTP to service
 * calls.
 *
 * It first asks the engine to check the game's configuration, and throws if
 * the engine refuses it (for example an RTP the ladders cannot support). A
 * server with a bad configuration does not start.
 */
export function buildServices(runtime: Runtime): Services {
  assertValidConfig(runtime.config);

  const ledger = ledgerRepository(runtime.db);
  const players = playersRepository(runtime.db);
  const seeds = seedsRepository(runtime.db);
  const rounds = roundsRepository(runtime.db);
  const keys = idempotencyRepository(runtime.db);

  const wallet = walletService(ledger);
  const fairness = fairnessService(runtime, players, seeds, rounds);
  const game = gameService(runtime, players, seeds, rounds, wallet, fairness);
  const publicWins = publicWinsService(runtime, rounds);
  return {
    wallet,
    players: playersService(runtime, players, seeds, wallet),
    fairness,
    game,
    session: sessionService(wallet, fairness, game, rounds),
    stats: statsService(runtime, rounds),
    publicWins,
    settings: settingsService(players, publicWins),
    idempotency: idempotencyService(runtime, keys),
  };
}
