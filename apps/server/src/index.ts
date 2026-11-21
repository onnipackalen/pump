import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { systemRuntime } from './runtime';
import { buildServices } from './services';
import { ABANDONED_SWEEP_EVERY_MS } from './settings';

/** A path inside this package, wherever the server was started from. */
const inPackage = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url));

function portFromEnv(): number {
  const text = process.env.PORT ?? '3000';
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, not "${text}"`);
  }
  return port;
}

const port = portFromEnv();
const host = process.env.HOST ?? '0.0.0.0';
// The SQLite file. On a host, point this at a disk that survives restarts.
const databasePath = process.env.DATABASE_PATH ?? inPackage('data/pump.db');
// The built game screen. If it has been built (npm run build), the server
// hands it out too, so one address serves the game and its API.
const builtScreen = process.env.WEB_ROOT ?? inPackage('../web/dist');
const webRoot = existsSync(join(builtScreen, 'index.html')) ? builtScreen : undefined;

const db = openDatabase(databasePath);
migrate(db);

const runtime = systemRuntime(db);
const app = buildApp({ runtime, logger: true, ...(webRoot === undefined ? {} : { webRoot }) });
app.log.info(
  webRoot === undefined
    ? 'serving the API only (the game screen has not been built: npm run build)'
    : `serving the game screen from ${webRoot}`,
);

// The 24-hour rule for players who never come back: now and then, settle
// every round that has been left idle that long.
const { game } = buildServices(runtime);
const sweep = setInterval(() => {
  try {
    const settled = game.sweepAbandoned();
    if (settled > 0) app.log.info({ settled }, 'settled abandoned rounds');
  } catch (error) {
    app.log.error(error, 'the abandoned-round sweep failed');
  }
}, ABANDONED_SWEEP_EVERY_MS);
sweep.unref();

// Finish the request in hand, then close the database cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(sweep);
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host });
