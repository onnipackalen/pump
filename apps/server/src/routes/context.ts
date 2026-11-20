import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Player } from '../repositories/players';
import type { Services } from '../services';
import { requestFingerprint, type Answer } from '../services/idempotency';
import { PLAYER_COOKIE, PLAYER_COOKIE_MAX_AGE_SECONDS } from '../settings';
import { idempotencyKey } from './schemas';

export interface RouteContext {
  readonly services: Services;
  /** Send the player cookie over HTTPS only. On in production. */
  readonly secureCookies: boolean;
}

/**
 * Who is asking. A first visit has no cookie: a new player is created with
 * the opening balance, and the cookie is set on this response.
 *
 * The cookie is httpOnly, so scripts on the page cannot read it.
 *
 * This is also where the 24-hour rule is applied "on the player's next
 * request": a round they left idle that long is settled first, as a change of
 * its own, before the request itself is looked at.
 */
export function identify(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Player {
  const { player, issuedToken } = context.services.players.resolve(request.cookies[PLAYER_COOKIE]);
  if (issuedToken !== null) {
    reply.setCookie(PLAYER_COOKIE, issuedToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: context.secureCookies,
      path: '/',
      maxAge: PLAYER_COOKIE_MAX_AGE_SECONDS,
    });
  }
  context.services.game.settleIfAbandoned(player.id);
  return player;
}

/**
 * Runs a request that changes something. It must carry an Idempotency-Key;
 * the action then runs at most once for that key, in one transaction with the
 * stored answer, and a repeat gets the same answer back.
 *
 * `body` is the already validated request body. It is part of the request's
 * fingerprint, so one key cannot be reused for a different request.
 */
export function change(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  player: Player,
  body: unknown,
  action: () => Answer,
): FastifyReply {
  const key = idempotencyKey.parse(request.headers['idempotency-key']);
  const path = request.url.split('?')[0] ?? request.url;
  const answer = context.services.idempotency.once(
    { playerId: player.id, key, fingerprint: requestFingerprint(request.method, path, body) },
    action,
  );
  return reply.status(answer.status).send(answer.body);
}
