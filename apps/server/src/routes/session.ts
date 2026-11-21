import type { FastifyInstance } from 'fastify';
import { identify, openSession, type RouteContext } from './context';
import { historyQuery } from './schemas';

/** Reading: the session the screen loads with, the list of past rounds, and the stats. */
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

  // The player's results over every finished round: profit over time, best
  // win, and rounds by difficulty.
  app.get('/api/stats', (request, reply) => {
    const playerId = identify(context, request);
    return reply.send(context.services.stats.of(playerId));
  });
}
