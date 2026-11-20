import { buildApp } from './app';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { systemRuntime } from './runtime';
import { buildServices } from './services';
import { ABANDONED_SWEEP_EVERY_MS } from './settings';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
// The SQLite file. On a host, point this at a disk that survives restarts.
const databasePath = process.env.DATABASE_PATH ?? 'data/pump.db';

const db = openDatabase(databasePath);
migrate(db);

const runtime = systemRuntime(db);
const app = buildApp({ runtime, logger: true });

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
