import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  /** Print request logs. Off in tests. */
  logger?: boolean;
}

/**
 * Builds the HTTP app without starting it, so tests can call routes directly.
 * Only a health check exists so far.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', (_request, reply) => reply.send({ status: 'ok' }));

  return app;
}
