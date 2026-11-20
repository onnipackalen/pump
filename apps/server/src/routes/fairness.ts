import type { FastifyInstance } from 'fastify';
import { change, identify, type RouteContext } from './context';
import { clientSeedBody, noBody } from './schemas';

/** Changing seeds. Both are refused while a round is in progress. */
export function fairnessRoutes(app: FastifyInstance, context: RouteContext): void {
  app.put('/api/fairness/client-seed', (request, reply) => {
    const playerId = identify(context, request);
    const body = clientSeedBody.parse(request.body);
    return change(context, request, reply, playerId, body, () => ({
      status: 200,
      body: context.services.fairness.setClientSeed(playerId, body.clientSeed),
    }));
  });

  app.post('/api/fairness/rotate', (request, reply) => {
    const playerId = identify(context, request);
    noBody.parse(request.body);
    return change(context, request, reply, playerId, null, () => ({
      status: 200,
      body: context.services.fairness.rotate(playerId),
    }));
  });
}
