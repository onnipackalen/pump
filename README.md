# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

Work in progress. Built so far: the engine (game rules and math), the exact RTP
check and the simulator, the provably fair draw code, the server (wallet, game
routes and the hammer test), and the game screen, which still plays against an
in-browser demo. Not done yet: connecting the screen to the server, the verify
page and the live site.

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
| `npm run hammer`    | 4,000 overlapping requests at a server, then reconciles   |

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

To follow the math, read `packages/engine/src/PumpEngine.ts` first (the order
of play, with the math in short at the top), then `packages/engine/src/math.ts`
(each formula with a worked example).

## The API

All JSON. The exact shapes are TypeScript types in `packages/contract`.

| Address | What it does |
| --- | --- |
| `GET /api/session` | Wallet, seeds and the round in progress, so a page refresh restores it. A first visit creates the player with $10,000 and sets the cookie. It is the only request that creates a player, so the screen loads it first. |
| `GET /api/history?limit=10` | The player's latest finished rounds. |
| `POST /api/rounds` | Starts a round: `{ difficultyId, betsCents }`, one bet per balloon. Charges the bets. |
| `POST /api/rounds/:id/pump` | One pump: `{ balloonIndex, expectedDrawIndex, patch }`. With `patch: true` the Patch is bought and the pump made in one step. The answer says `survived`, `saved`, `popped` or `top`. |
| `POST /api/rounds/:id/cash-out` | Cashes out one balloon: `{ balloonIndex, expectedDrawIndex }`. |
| `GET /api/rounds/:id/verify` | A finished round with its revealed server seed and every action, to recompute it. 409 until the seed has been rotated. |
| `PUT /api/fairness/client-seed` | Sets the client seed. Never resets the nonce. |
| `POST /api/fairness/rotate` | Retires the server seed, reveals it, and starts a new one. Refused during a round. |

Every request that changes something needs an `Idempotency-Key` header. Errors
always look like `{ "error": { "code", "message" } }`:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request is malformed or breaks a rule. |
| `no_session` | 401 | No player cookie. Load `GET /api/session` first. |
| `insufficient_funds` | 402 | The balance does not cover the bets or the Patch. Nothing was charged. |
| `not_found` | 404 | No such round for this player. |
| `conflict` | 409 | The balloon is not in the state the request expected. The body carries the round as it is now. |
| `round_active` | 409 | A round is in progress: no second round, no seed changes. |
| `seed_not_revealed` | 409 | The round cannot be checked until its server seed is rotated. |
| `key_reused` | 422 | This idempotency key was already used for a different request. |

**Pump and Cash Out at the same moment.** Each pump and cash-out says which
state of the balloon it was made from (`expectedDrawIndex`, the number of draws
made on it so far). The first to arrive changes that number, so the second is
refused with a 409 and the current round. The rung would not be enough: a pump
saved by a Patch uses a draw without moving the rung.

**Abandoned rounds.** A round nobody has touched for 24 hours is settled for
the player: balloons that were pumped cash out at their current multiplier,
and bets that were never pumped are handed back. Cashing out at any rung
returns the RTP, and a bet with no draw on it is simply void, so neither
changes the RTP. The rule is applied before the player's next request and by a
sweep every ten minutes. We chose this over forfeiting the bets (unfair to a
player whose connection dropped) and over leaving rounds open for ever (the
player could never start another).

**The hammer.** `npm run hammer` starts its own server as a separate process
on a fresh database, has 20 players play at once, and makes every step a burst
sent at the same moment: the same key twice, Pump with Cash Out, two Pumps, two
Cash Outs, four round starts. Then it opens the database and reconciles it. To
aim it at a server you already run:
`npm run hammer -- --url=http://localhost:3000 --db=data/pump.db`.

How the wallet is kept safe:

- **One transaction per request.** SQLite runs synchronously in one server
  process, and every change is one immediate transaction with no `await`
  inside it. Two requests can never both read a balance and then both spend it.
- **The ledger is append-only and chained.** Every cent that moves is one
  ledger row holding the amount and the balance after it. Database triggers
  refuse to change, delete or replace a row, refuse a row that does not
  continue from the previous balance, and refuse a balance that does not match
  the last row. Writing the row moves the balance in the same statement. So
  the balance equals the sum of the ledger at all times, and the database
  enforces it, not only the code.
- **The ledger must agree with the round.** A bet row has to be the balloon's
  bet, a payout has to be what a cashed balloon recorded, and a refund has to
  be the bet of a refunded balloon, all for a balloon of that same player.
- **Check and charge are one statement.** The ledger row is written only if
  the balance can take it. A player with $5 cannot spend $10.
- **Nothing is paid twice.** Unique indexes allow one opening grant per player,
  one bet per balloon, and at most one payout or refund per balloon.
- **A repeated request is applied once.** Every changing request carries an
  `Idempotency-Key` header. The key lookup, the change, and the stored answer
  are one transaction, so a crash cannot leave a change done but unrecorded.
  A repeat gets the first answer back, whether that was a success or a
  refusal. A refusal's answer is built after its request is rolled back, so it
  shows the real balance. One key used for two different requests is refused.
- **The server seed stays secret.** Only its SHA-256 is shown until the player
  rotates. The code that reads seeds cannot read an active one.
- **Players are anonymous.** A random token in an httpOnly cookie; the
  database stores only its hash.
- **Finished means finished.** Triggers stop a popped, cashed or refunded
  balloon, and a finished round, from ever changing again. A draw index can be
  recorded for one pump only.
- **The books can be checked from the data alone.** `reconcile()` compares
  every balance with its ledger, walks the ledger chain, and checks that every
  balloon was charged and paid exactly what its round says.

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
