import type { FastifyInstance } from 'fastify';
import { identify, type RouteContext } from './context';
import { historyQuery } from './schemas';

/** Reading: the session the screen loads with, and the list of past rounds. */
export function sessionRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get('/api/session', (request, reply) => {
    const player = identify(context, request, reply);
    return reply.send(context.services.session.view(player.id));
  });

  app.get('/api/history', (request, reply) => {
    const { limit } = historyQuery.parse(request.query);
    const player = identify(context, request, reply);
    return reply.send(context.services.session.history(player.id, limit));
  });
}
