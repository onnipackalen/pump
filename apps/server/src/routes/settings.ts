import type { FastifyInstance } from 'fastify';
import { change, identify, type RouteContext } from './context';
import { settingsBody } from './schemas';

/** A player's own choices: reading them and changing them. */
export function settingsRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get('/api/settings', (request, reply) => {
    const playerId = identify(context, request);
    return reply.send(context.services.settings.view(playerId));
  });

  app.put('/api/settings', (request, reply) => {
    const playerId = identify(context, request);
    const body = settingsBody.parse(request.body);
    return change(context, request, reply, playerId, body, () => ({
      status: 200,
      body: context.services.settings.set(playerId, body),
    }));
  });
}
