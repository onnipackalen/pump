import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDatabase, type Db } from './db/database';
import { databasePlace, runningOnHost } from './db/location';
import { migrate } from './db/migrations';
import { featuresFromEnv } from './features';
import { playersRepository } from './repositories/players';
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
// The SQLite file that holds every wallet. On a host it must be on the disk
// that survives deploys; the server will not start otherwise (db/location.ts).
const database = databasePlace({
  chosen: process.env.DATABASE_PATH,
  onHost: runningOnHost(process.env),
  fallback: inPackage('data/pump.db'),
  folderExists: existsSync,
});
// The built game screen. If it has been built (npm run build), the server
// hands it out too, so one address serves the game and its API.
const builtScreen = process.env.WEB_ROOT ?? inPackage('../web/dist');
// The built screen carries its own copy of the RTP and the ladders, for what it
// shows before a bet. While the game is being worked on (npm run dev) that
// copy can be older than the server, so there the server is started with
// --api-only and the screen comes from its own, always fresh, address.
const apiOnly = process.argv.includes('--api-only');
const webRoot =
  !apiOnly && existsSync(join(builtScreen, 'index.html')) ? builtScreen : undefined;

// Looked at before the file is opened, because opening it makes it.
const databaseWasThere = existsSync(database.path);

function openOrExplain(): Db {
  try {
    return openDatabase(database.path, { createFolder: database.createFolder });
  } catch (error) {
    // SQLite only says "unable to open database file", without the path.
    throw new Error(
      `Could not open the database file "${database.path}". It must be a file, not a ` +
        'folder, and its folder must be writable.',
      { cause: error },
    );
  }
}

const db = openOrExplain();
migrate(db);

// What this market allows, for example PUBLIC_WINS=off. See features.ts.
const market = featuresFromEnv(process.env);
const runtime = systemRuntime(db, market.features);
const app = buildApp({ runtime, logger: true, ...(webRoot === undefined ? {} : { webRoot }) });
for (const warning of market.warnings) app.log.warn(warning);
// Said at every start, on or off, with the value that was read: a missing or
// mistyped entry on a host is then seen in the log, not found out later.
app.log.info(
  `public wins: ${market.features.publicWins ? 'ON' : 'OFF'} (PUBLIC_WINS ${
    process.env.PUBLIC_WINS === undefined ? 'is not set' : `is "${process.env.PUBLIC_WINS}"`
  })`,
);
// Said at every start, so a host's log shows where the wallets are kept and
// whether they were found. The folder check in db/location.ts cannot tell the
// host's disk from any other folder that exists. This line can: on a site that
// has been played on, "a NEW, EMPTY file" means the wallets were not found.
app.log.info(
  databaseWasThere
    ? `the database file is ${database.path}: opened the existing file, ${String(playersRepository(db).count())} players`
    : `the database file is ${database.path}: made a NEW, EMPTY file`,
);
if (webRoot !== undefined) app.log.info(`serving the game screen from ${webRoot}`);
else if (apiOnly) app.log.info('serving the API only (the game screen has its own address: npm run dev)');
else app.log.info('serving the API only (the game screen has not been built: npm start)');

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

// Finish the request in hand, then close the database cleanly. A host may
// send the stop signal more than once; the later ones must not cut the first
// short, so they are taken and ignored.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host });
