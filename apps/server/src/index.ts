import { buildApp } from './app';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { systemRuntime } from './runtime';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
// The SQLite file. On a host, point this at a disk that survives restarts.
const databasePath = process.env.DATABASE_PATH ?? 'data/pump.db';

const db = openDatabase(databasePath);
migrate(db);

const app = buildApp({
  runtime: systemRuntime(db),
  logger: true,
  secureCookies: process.env.NODE_ENV === 'production',
});

// Finish the request in hand, then close the database cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host });
