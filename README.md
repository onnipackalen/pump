# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

Work in progress. Built so far: the engine (game rules and math), the provably
fair draw code, the game screen (playing against an in-browser demo), and the
wallet half of the server. Not built yet: the server's game routes, the exact
RTP proof, the simulator, the hammer test, the verify page and the live site.

## Run it locally

You need Node 26 (see `.nvmrc`).

```bash
npm install
npm run dev:server   # API on http://localhost:3000
npm run dev:web      # frontend on http://localhost:5173, forwards /api to the server
```

The server keeps everything in one SQLite file, `apps/server/data/pump.db`,
created on first start. Set `DATABASE_PATH` to put it somewhere else. It uses
Node's built-in SQLite, so there is nothing native to compile.

## Scripts

All of these run from the repo root.

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm test`          | Runs every test with Vitest                               |
| `npm run lint`      | ESLint; `any` is an error                                 |
| `npm run typecheck` | Strict TypeScript over every package                      |
| `npm run rtp`       | Exact RTP check: every rung, every Patch, every legal bet |
| `npm run sim`       | Simulator, 10M rounds per difficulty through the engine   |
| `npm run hammer`    | Fires overlapping requests at a running server (stub)     |

## Layout

```
packages/engine   game rules, ladder config, RTP calculator, simulator
  src/            pure code: no Node, no DOM, no clock, no Math.random
  src/fair/       seeds to draws; imported as @pump/engine/fair
  cli/            npm run rtp and npm run sim (may use Node)
  test/
packages/contract request and response types shared by the server and the web app
apps/server       HTTP API and SQLite; routes -> services -> repositories
  src/routes/       HTTP only: check the input, find the player, call a service
  src/services/     the rules: wallet, players, seeds, repeated requests
  src/repositories/ the SQL, and nothing else
  src/db/           the schema with its guards, and the transaction helper
  scripts/          npm run hammer
  test/
apps/web          React + Vite frontend
  src/
```

## The server so far

| Address | What it does |
| --- | --- |
| `GET /api/session` | Wallet, seeds and the round in progress. A first visit creates the player with $10,000 and sets the cookie. |
| `GET /api/history?limit=10` | The player's latest finished rounds. |
| `PUT /api/fairness/client-seed` | Sets the client seed. Never resets the nonce. |
| `POST /api/fairness/rotate` | Retires the server seed, reveals it, and starts a new one. |

Starting a round, pump, Patch and cash-out come next.

How the wallet is kept safe:

- **One transaction per request.** SQLite runs synchronously in one server
  process, and every change is one immediate transaction with no `await`
  inside it. Two requests can never both read a balance and then both spend it.
- **The ledger is append-only and chained.** Every cent that moves is one
  ledger row holding the amount and the balance after it. Database triggers
  refuse to change or delete a row, refuse a row that does not continue from
  the previous balance, and refuse a balance that does not match the last row.
  So the balance equals the sum of the ledger at all times, and the database
  enforces it, not only the code.
- **Check and charge are one statement.** The ledger row is written only if
  the balance can take it. A player with $5 cannot spend $10.
- **Nothing is paid twice.** Unique indexes allow one opening grant per player,
  one bet per balloon, and at most one payout or refund per balloon.
- **A repeated request is applied once.** Every changing request carries an
  `Idempotency-Key` header. The key lookup, the change, and the stored answer
  are one transaction, so a crash cannot leave a change done but unrecorded.
  A repeat gets the first answer back, whether that was a success or a
  refusal. One key used for two different requests is refused with 422.
- **The server seed stays secret.** Only its SHA-256 is shown until the player
  rotates. The code that reads seeds cannot read an active one.
- **Players are anonymous.** A random token in an httpOnly cookie; the
  database stores only its hash.

Errors always look like `{ "error": { "code", "message" } }`.

Conventions:

- Tests live in a `test/` folder next to `src/`, named `*.test.ts`.
- The server and the web app import the engine by name (`@pump/engine`),
  straight from its TypeScript source. There is no build step for it.
- `packages/engine/src` is compiled without Node or DOM types and linted
  against `node:` imports, `Date` and `Math.random`, so it cannot do I/O.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.
- npm blocks dependency install scripts unless `allowScripts` in the root
  `package.json` allows them. A dependency that needs to compile native code
  has to be approved there.
