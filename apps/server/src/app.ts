import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './errors';
import type { RouteContext } from './routes/context';
import { fairnessRoutes } from './routes/fairness';
import { roundRoutes } from './routes/rounds';
import { sessionRoutes } from './routes/session';
import type { Runtime } from './runtime';
import { buildServices } from './services';

export interface AppOptions {
  /** The database, clock and randomness the app runs on. */
  readonly runtime: Runtime;
  /** Print request logs. Off in tests. */
  readonly logger?: boolean;
  /** Send the player cookie over HTTPS only. On in production. */
  readonly secureCookies?: boolean;
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const status = error.statusCode;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return null;
}

/**
 * Builds the HTTP app without starting it, so tests can call routes directly.
 *
 * Layers: routes (this folder's routes/) turn HTTP into service calls,
 * services hold the rules, repositories hold the SQL. Game rules live in
 * @pump/engine, never here.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  void app.register(cookie);

  const context: RouteContext = {
    services: buildServices(options.runtime),
    secureCookies: options.secureCookies ?? false,
  };

  // Answers hold balances and seeds: never let a browser or proxy cache them.
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('cache-control', 'no-store');
    done();
  });

  // Every failure leaves as { error: { code, message } }.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(error.toResponse());
    }
    if (error instanceof z.ZodError) {
      const message = error.issues[0]?.message ?? 'The request is not valid.';
      return reply.status(400).send(new ApiError('invalid_request', message).toResponse());
    }
    // Fastify's own refusals: a body that is not JSON, too large, and so on.
    const status = statusOf(error);
    if (status !== null && status >= 400 && status < 500) {
      const refusal = new ApiError('invalid_request', 'The request could not be read.', { status });
      return reply.status(status).send(refusal.toResponse());
    }
    // Anything else is our bug. The transaction it was in has been rolled back.
    request.log.error(error);
    const failure = new ApiError(
      'internal_error',
      'Something went wrong on our side. Nothing was changed.',
    );
    return reply.status(500).send(failure.toResponse());
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(new ApiError('not_found', 'There is nothing here.').toResponse()),
  );

  app.get('/api/health', (_request, reply) => reply.send({ status: 'ok' }));
  sessionRoutes(app, context);
  fairnessRoutes(app, context);
  roundRoutes(app, context);

  return app;
}
