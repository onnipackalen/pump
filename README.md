# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

Work in progress. Built so far: the engine (game rules and math), the exact RTP
check and the simulator, the provably fair draw code, the server (wallet, game
routes and the hammer test), and the game screen with its verify page, which
play against the real server. It is live at <https://pump-wysj.onrender.com>
(see "The live site").

## Run it locally

You need Node 26 (see `.nvmrc`).

```bash
npm install
npm start            # builds the screen, then serves the whole game on http://localhost:3000
```

To work on the game, with both halves reloading as you edit:

```bash
npm run dev          # the game on http://localhost:5173; its /api requests go on to the server on :3000
```

`npm start` is the one to use after changing the RTP or a ladder: the screen
carries its own copy of those numbers for what it shows before a bet, and
`npm start` rebuilds it every time. Under `npm run dev` the server hands out
the API only, so an older build can never be mistaken for the game.

The server keeps everything in one SQLite file, `apps/server/data/pump.db`,
created on first start. Set `DATABASE_PATH` to put it somewhere else; the
folder you name must already be there. It uses Node's built-in SQLite, so
there is nothing native to compile.

## The live site

The game is live at **<https://pump-wysj.onrender.com>**.

It runs on [Render](https://render.com): one web service with one 1 GB disk,
set up from `render.yaml` in this repo. No setting is typed in by hand on
Render's pages, and none should be changed there: Render puts back what
`render.yaml` says.

It costs about 7.25 US dollars a month (7 for the server, 0.25 for the disk),
and less for part of a month. A service with a disk needs a paid plan, so add
a payment card under Billing on Render first.

How it was set up, and how to set it up again from nothing:

1. `main` on GitHub must contain `render.yaml`, with a green check on its
   newest commit.
2. On Render choose **New > Blueprint**. Under **Public Git Repository** paste
   this repository's address and continue. (Connecting Render to GitHub works
   too and is not needed: the repository is public.) Give the Blueprint any
   name and leave the branch as `main`.
3. Render lists what `render.yaml` will create: a web service named `pump`.
   If the file has a mistake, Render shows the mistake here instead. Choose
   **Deploy Blueprint**.
4. When the deploy is live, open the `onrender.com` address shown on the
   service's page.

Then check it, once:

- The service's Disk page shows a 1 GB disk mounted at `/var/data`.
- Search the service's log for `the database file is`. The line is printed at
  every start and must name `/var/data/pump.db`.
- Play a round and note the balance. On the service's page choose
  **Manual Deploy > Deploy latest commit**, wait until it is live, reload the
  game in the same browser, and see the same balance. A fresh $10,000 means
  the database was lost. After this second start the log line must say
  `opened the existing file`, not `made a NEW, EMPTY file`.

If the first deploy fails, do not make a second Blueprint: that creates a
second paid service with its own empty disk. Fix the cause, push, and deploy
the same service again.

A new version goes live by hand: push to `main`, wait for the green check on
GitHub, then on the service's page choose **Manual Deploy > Deploy latest
commit**. Render is not connected to the repository on GitHub, so a push does
not deploy by itself (seen on 2026-11-20: a push with a green check started
nothing). Use "Deploy latest commit" only; "Deploy a specific commit" also
switches automatic deploys off. The site is down for a few seconds on each
deploy: Render stops the old copy before it starts the new one, so two
versions never write to the same database. Balances and rounds in play are
kept.

### Where the wallets are

Every wallet is in one file on that disk, `/var/data/pump.db`. Render keeps
only what is on the disk; the rest of the machine is thrown away on every
deploy and every restart. So that a missing setting or a missing disk cannot
quietly lose the wallets, the server will not start on a host unless
`DATABASE_PATH` is set and its folder is already there
(`apps/server/src/db/location.ts`). The server cannot tell the disk from any
other folder that exists, so `DATABASE_PATH` and the disk's mount path are
changed only in `render.yaml`, both together, never on Render's pages.

Never delete the service while the site is in use: the wallets are on its
disk. Render takes a snapshot of the disk once a day and keeps it for a week,
but that is a last resort, not a backup: restoring one puts the whole disk
back to that moment, so every round and payout since is gone, and Render
warns that a database restored this way can come back damaged.

When the site is no longer needed: on the Blueprint's Settings page set Auto
Sync to No, then delete the `pump` service. That destroys every wallet for
good. Afterwards look at the Billing page to see that the charges stopped.

## Scripts

All of these run from the repo root.

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm start`         | Builds the screen and serves the whole game on port 3000  |
| `npm run dev`       | Server and screen together, reloading as you edit         |
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
| `GET /api/health` | Answers `{ "status": "ok" }`. Render calls it to see that the server is up, so `render.yaml` names it. |
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
| `no_session` | 401 | No player cookie. Only `GET /api/session` starts a player; the screen tells the player to reload. |
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
