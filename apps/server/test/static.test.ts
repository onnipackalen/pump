import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { testRuntime } from './helpers';

/** A stand-in for apps/web/dist: one page and one script. */
function builtScreen(): string {
  const root = mkdtempSync(join(tmpdir(), 'pump-screen-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Pump</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("pump")');
  return root;
}

describe('the server with a built game screen', () => {
  const app = buildApp({ runtime: testRuntime(), webRoot: builtScreen() });

  it('hands out the page at the front door', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>Pump</title>');
  });

  it('hands out the screen’s files', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log("pump")');
  });

  it('gives the page for any other address that is not part of the API', async () => {
    const response = await app.inject({ method: 'GET', url: '/verify/some-round' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Pump</title>');
  });

  it('still answers the API, and marks only API answers as never to be cached', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/health' });
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(api.json()).toEqual({ status: 'ok' });
    expect(api.headers['cache-control']).toBe('no-store');
    expect(page.headers['cache-control']).not.toBe('no-store');
  });

  it('answers an unknown API address with the usual error, not the page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('does not let an address climb out of the screen’s folder', async () => {
    const response = await app.inject({ method: 'GET', url: '/../../package.json' });
    expect(response.body).not.toContain('"workspaces"');
  });
});

describe('the server without a built game screen', () => {
  it('answers the front door with a plain "not found"', async () => {
    const app = buildApp({ runtime: testRuntime() });
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
