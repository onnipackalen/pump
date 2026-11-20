import { describe, expect, it } from 'vitest';
import { testWorld } from './helpers';

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const { app } = testWorld();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toEqual({ status: 'ok' });
  });
});

describe('an address that does not exist', () => {
  it('answers 404 in the same error shape as everything else', async () => {
    const { app } = testWorld();

    const response = await app.inject({ method: 'GET', url: '/api/nothing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'There is nothing here.' },
    });
  });
});
