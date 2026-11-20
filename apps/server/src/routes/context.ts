import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import type { Services } from '../services';
import { requestFingerprint, type Answer } from '../services/idempotency';
import { PLAYER_COOKIE, PLAYER_COOKIE_MAX_AGE_SECONDS } from '../settings';
import { idempotencyKey } from './schemas';

export interface RouteContext {
  readonly services: Services;
  /**
   * Send the player cookie over HTTPS only. Left unset, each request decides
   * for itself: Secure when it arrived over HTTPS, which is always the case
   * behind a host's proxy, and plain on http://localhost.
   */
  readonly secureCookies: boolean | undefined;
}

function setPlayerCookie(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(PLAYER_COOKIE, token, {
    // httpOnly: scripts on the page cannot read it.
    httpOnly: true,
    sameSite: 'lax',
    secure: context.secureCookies ?? request.protocol === 'https',
    path: '/',
    maxAge: PLAYER_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * The first request of a visit, GET /api/session. It is the ONLY place a
 * player is created: with no valid cookie this is a first visit, so a player
 * is made with the opening balance and the cookie is set. A returning player
 * gets their cookie sent again, so it does not run out while they keep
 * playing. Returns the player's id.
 */
export function openSession(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): string {
  const { players, game } = context.services;
  const token = request.cookies[PLAYER_COOKIE];
  const known = players.find(token);
  if (known && token !== undefined) {
    setPlayerCookie(context, request, reply, token);
    game.settleIfAbandoned(known.id);
    return known.id;
  }
  const created = players.create();
  setPlayerCookie(context, request, reply, created.token);
  return created.player.id;
}

/**
 * Who is asking, for every other request. Without a valid cookie the request
 * is refused: it never creates a player. Returns the player's id.
 *
 * This is also where the 24-hour rule is applied "on the player's next
 * request": a round they left idle that long is settled first, as a change of
 * its own, before the request itself is looked at.
 */
export function identify(context: RouteContext, request: FastifyRequest): string {
  const { players, game } = context.services;
  const player = players.find(request.cookies[PLAYER_COOKIE]);
  if (!player) {
    throw new ApiError('no_session', 'Load the game first: this request has no player yet.');
  }
  game.settleIfAbandoned(player.id);
  return player.id;
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
  playerId: string,
  body: unknown,
  action: () => Answer,
): FastifyReply {
  const key = idempotencyKey.parse(request.headers['idempotency-key']);
  const path = request.url.split('?')[0] ?? request.url;
  const answer = context.services.idempotency.once(
    { playerId, key, fingerprint: requestFingerprint(request.method, path, body) },
    action,
  );
  return reply.status(answer.status).send(answer.body);
}
