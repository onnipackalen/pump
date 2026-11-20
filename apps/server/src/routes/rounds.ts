import type { FastifyInstance } from 'fastify';
import { change, identify, type RouteContext } from './context';
import { cashOutBody, pumpBody, roundParams, startRoundBody } from './schemas';

/** Playing: start a round, pump (with or without a Patch), cash out, and check a finished round. */
export function roundRoutes(app: FastifyInstance, context: RouteContext): void {
  const { game } = context.services;

  app.post('/api/rounds', (request, reply) => {
    const body = startRoundBody.parse(request.body);
    const player = identify(context, request, reply);
    return change(context, request, reply, player, body, () => ({
      status: 200,
      body: game.start(player.id, body),
    }));
  });

  // With patch: true this buys a Patch and pumps in one atomic step.
  app.post('/api/rounds/:roundId/pump', (request, reply) => {
    const { roundId } = roundParams.parse(request.params);
    const body = pumpBody.parse(request.body);
    const player = identify(context, request, reply);
    return change(context, request, reply, player, body, () => ({
      status: 200,
      body: game.pump(player.id, roundId, body),
    }));
  });

  app.post('/api/rounds/:roundId/cash-out', (request, reply) => {
    const { roundId } = roundParams.parse(request.params);
    const body = cashOutBody.parse(request.body);
    const player = identify(context, request, reply);
    return change(context, request, reply, player, body, () => ({
      status: 200,
      body: game.cashOut(player.id, roundId, body),
    }));
  });

  // A finished round with everything needed to recompute it, once its server
  // seed has been revealed.
  app.get('/api/rounds/:roundId/verify', (request, reply) => {
    const { roundId } = roundParams.parse(request.params);
    const player = identify(context, request, reply);
    return reply.send(game.verifiable(player.id, roundId));
  });
}
