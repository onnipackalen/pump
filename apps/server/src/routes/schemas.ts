import { isClientSeed } from '@pump/engine/fair';
import { z } from 'zod';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '../settings';

/**
 * The shape every request must have. Each route checks its input against one
 * of these before anything else happens, so the services only ever see
 * well-formed values.
 */

/** GET /api/history?limit=10 */
export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
});

/** PUT /api/fairness/client-seed */
export const clientSeedBody = z.strictObject({
  clientSeed: z.string().refine(isClientSeed, {
    message: 'A client seed is 1 to 64 characters from A-Z, a-z, 0-9, _ and -.',
  }),
});

/**
 * The game requests. Only their shape is checked here: the right fields of
 * the right types. Whether a bet is allowed, how many balloons a round may
 * have, or whether a balloon exists are rules, and rules are the engine's.
 */

/** The :roundId in an address. */
export const roundParams = z.object({
  roundId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { message: 'That is not a round id.' }),
});

/** POST /api/rounds */
export const startRoundBody = z.strictObject({
  difficultyId: z.string().min(1).max(64),
  betsCents: z.array(z.int()).min(1).max(16),
});

/** POST /api/rounds/:roundId/pump */
export const pumpBody = z.strictObject({
  balloonIndex: z.int().min(0),
  expectedDrawIndex: z.int().min(0),
  patch: z.boolean(),
});

/** POST /api/rounds/:roundId/cash-out */
export const cashOutBody = z.strictObject({
  balloonIndex: z.int().min(0),
  expectedDrawIndex: z.int().min(0),
});

/** A request that carries no data: no body at all, or an empty object. */
export const noBody = z.union([z.undefined(), z.null(), z.strictObject({})]);

/** The Idempotency-Key header: 1 to 128 characters from A-Z, a-z, 0-9, _ and -. */
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, {
  message: 'Send an Idempotency-Key header: 1 to 128 characters from A-Z, a-z, 0-9, _ and -.',
});
