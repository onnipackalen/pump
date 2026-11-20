import { idempotencyRepository } from '../repositories/idempotency';
import { ledgerRepository } from '../repositories/ledger';
import { playersRepository } from '../repositories/players';
import { roundsRepository } from '../repositories/rounds';
import { seedsRepository } from '../repositories/seeds';
import type { Runtime } from '../runtime';
import { fairnessService, type FairnessService } from './fairness';
import { idempotencyService, type IdempotencyService } from './idempotency';
import { playersService, type PlayersService } from './players';
import { sessionService, type SessionService } from './session';
import { walletService, type WalletService } from './wallet';

export interface Services {
  readonly wallet: WalletService;
  readonly players: PlayersService;
  readonly fairness: FairnessService;
  readonly session: SessionService;
  readonly idempotency: IdempotencyService;
}

/**
 * Builds the layers once, bottom up: repositories hold the SQL, services hold
 * the rules, and the routes (in ../routes) only translate HTTP to service
 * calls.
 */
export function buildServices(runtime: Runtime): Services {
  const ledger = ledgerRepository(runtime.db);
  const players = playersRepository(runtime.db);
  const seeds = seedsRepository(runtime.db);
  const rounds = roundsRepository(runtime.db);
  const keys = idempotencyRepository(runtime.db);

  const wallet = walletService(ledger);
  const fairness = fairnessService(runtime, players, seeds, rounds);
  return {
    wallet,
    players: playersService(runtime, players, seeds, wallet),
    fairness,
    session: sessionService(wallet, fairness, rounds),
    idempotency: idempotencyService(runtime, keys),
  };
}
