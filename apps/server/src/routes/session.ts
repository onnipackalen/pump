import type { FastifyInstance } from 'fastify';
import { identify, openSession, type RouteContext } from './context';
import { historyQuery } from './schemas';

/** Reading: the session the screen loads with, and the list of past rounds. */
export function sessionRoutes(app: FastifyInstance, context: RouteContext): void {
  // The one request that may create a player. The screen loads it first.
  app.get('/api/session', (request, reply) => {
    const playerId = openSession(context, request, reply);
    return reply.send(context.services.session.view(playerId));
  });

  app.get('/api/history', (request, reply) => {
    const { limit } = historyQuery.parse(request.query);
    const playerId = identify(context, request);
    return reply.send(context.services.session.history(playerId, limit));
  });
}
