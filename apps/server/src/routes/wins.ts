import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context';

/** Reading: the wins everyone may see. */
export function winsRoutes(app: FastifyInstance, context: RouteContext): void {
  // Open to anyone. It needs no player and makes none, it reads no cookie,
  // and the answer is the same for everyone: see services/publicWins.ts.
  app.get('/api/wins', (_request, reply) => reply.send(context.services.publicWins.list()));
}
