import { createHash } from 'node:crypto';
import { immediate, undoable } from '../db/transaction';
import { ApiError } from '../errors';
import type { IdempotencyRepository } from '../repositories/idempotency';
import type { Runtime } from '../runtime';

/** What a request was answered with. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** JSON with object keys in a fixed order, so equal requests hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A fingerprint of a request: what it asked for, and of which address. A key
 * that comes back with a different fingerprint is being reused for something
 * else, and is refused.
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonicalJson(body)}`, 'utf8')
    .digest('hex');
}

export interface OnceRequest {
  readonly playerId: string;
  /** The client's idempotency key for this action. */
  readonly key: string;
  readonly fingerprint: string;
}

export type IdempotencyService = ReturnType<typeof idempotencyService>;

export function idempotencyService(runtime: Runtime, keys: IdempotencyRepository) {
  return {
    /**
     * Runs `action` at most once for a (player, key) pair, and returns the
     * same answer to every repeat.
     *
     * All of it is ONE transaction: looking the key up, doing the action, and
     * storing the key with the full answer. So a crash can never leave an
     * action done but not recorded; a retry after one either finds the stored
     * answer or finds nothing was done at all.
     *
     * A refusal (an ApiError) is an answer too. The action's own changes are
     * undone first, and only then is the refusal's answer built, so it shows
     * the balance and round as they really are. The refusal is stored, and a
     * repeat gets the same refusal. Any other error undoes everything and
     * stores nothing, so it can be retried.
     */
    once(request: OnceRequest, action: () => Answer): Answer {
      return immediate(runtime.db, () => {
        const stored = keys.find(request.playerId, request.key);
        if (stored) {
          if (stored.requestHash !== request.fingerprint) {
            throw new ApiError(
              'key_reused',
              'This idempotency key was already used for a different request.',
            );
          }
          const body: unknown = JSON.parse(stored.body);
          return { status: stored.status, body };
        }

        let answer: Answer;
        try {
          answer = undoable(runtime.db, action);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          answer = { status: error.status, body: error.toResponse() };
        }

        keys.insert({
          playerId: request.playerId,
          key: request.key,
          requestHash: request.fingerprint,
          status: answer.status,
          body: JSON.stringify(answer.body),
          at: runtime.now().toISOString(),
        });
        return answer;
      });
    },
  };
}
