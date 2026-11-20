import type { FastifyInstance } from 'fastify';
import { change, identify, type RouteContext } from './context';
import { clientSeedBody, noBody } from './schemas';

/** Changing seeds. Both are refused while a round is in progress. */
export function fairnessRoutes(app: FastifyInstance, context: RouteContext): void {
  app.put('/api/fairness/client-seed', (request, reply) => {
    const body = clientSeedBody.parse(request.body);
    const player = identify(context, request, reply);
    return change(context, request, reply, player, body, () => ({
      status: 200,
      body: context.services.fairness.setClientSeed(player.id, body.clientSeed),
    }));
  });

  app.post('/api/fairness/rotate', (request, reply) => {
    noBody.parse(request.body);
    const player = identify(context, request, reply);
    return change(context, request, reply, player, null, () => ({
      status: 200,
      body: context.services.fairness.rotate(player.id),
    }));
  });
}
