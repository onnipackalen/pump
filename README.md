# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

- Play it: <https://pump-wysj.onrender.com>
- Code: <https://github.com/onnipackalen/pump>
- Also in the repo: [PLAYTEST.md](PLAYTEST.md), [AI_USAGE.md](AI_USAGE.md),
  and my hours (the last section of this file).

What's built:

- Everything the brief asks for: four difficulties, one to three balloons,
  Patch, auto-play, keyboard play, sound, a phone layout, the exact RTP
  check (`npm run rtp`), the simulator (`npm run sim`), the hammer
  (`npm run hammer`) and the verify page.
- Extras: a stats page, live stats, public wins, and the after-round reveal
  below.
- What's still wrong is listed under [Known issues](#known-issues).

## The fun part: where it would have popped

After a round, every balloon you cashed out early plays on by itself and
shows where it would have popped:

- "Next pump would have popped"
- "Would have reached 1.37×, then popped"
- "Would have reached the top (25.00×)"

Why:

- The hardest moment in Pump is deciding when to stop, and normally you
  never find out if you were right. Now you do.
- It cuts both ways. Often you got out just in time. Sometimes you left
  money behind. Either way, you want another round.
- It was my first idea for the game.

It can't be used to cheat:

- It is worked out only once the whole round is over, from the same draws
  the next pumps would have used.
- It moves no money.
- The verify page checks it like every other pump (see
  [Provably fair](#provably-fair)).

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

- Use `npm start` after changing the RTP or a ladder. The screen keeps its
  own copy of those numbers for what it shows before a bet, and `npm start`
  rebuilds it every time. Under `npm run dev` the server serves the API
  only, so an older build can't be mistaken for the game.
- Everything is stored in one SQLite file, `apps/server/data/pump.db`, made
  on first start. Set `DATABASE_PATH` to put it somewhere else; the folder
  must already exist. It uses Node's built-in SQLite, so nothing native has
  to compile.
- The live site runs on Render. How it's set up, deployed and taken down is
  in [docs/live-site.md](docs/live-site.md).

## How it's built

```
packages/engine   game rules, ladder config, RTP calculator, simulator
  src/            pure code: no Node, no DOM, no clock, no Math.random
  src/fair/       seeds to draws; imported as @pump/engine/fair
  cli/            npm run rtp and npm run sim (may use Node)
  test/
packages/contract request and response types shared by the server and the web app
apps/server       HTTP API and SQLite; routes -> services -> repositories
  src/routes/       HTTP only: check the input, find the player, call a service
  src/services/     wallet, players, seeds, repeated requests
  src/repositories/ the SQL, and nothing else
  src/db/           the schema with its guards, and the transaction helper
  scripts/          npm run hammer
  test/
apps/web          React + Vite frontend
  src/
```

- **The engine is pure.** `packages/engine/src` is compiled without Node or
  DOM types and linted against `node:` imports, `Date` and `Math.random`.
  Same input, same output.
- **The engine never sees a seed.** A pump asks for one whole number, and
  `src/fair` supplies it. Engine files outside `src/fair` may import only
  types from it; `packages/engine/test/fair/boundary.test.ts` fails
  otherwise.
- **The server holds no game rules.** Routes check the request, services
  run the engine and the wallet in one transaction, repositories hold the
  SQL. Every request body is checked against a schema
  (`apps/server/src/routes/schemas.ts`).
- **One engine everywhere.** The server and the web app import it by name
  (`@pump/engine`), straight from its TypeScript source, with no build step.
  The verify page runs the same code in the browser.
- **No `any`.** ESLint treats it as an error. TypeScript is strict in every
  package.
- **CI** (`.github/workflows/ci.yml`) runs lint, typecheck, every test and
  the web build on each push.

Read the engine first: `packages/engine/src/PumpEngine.ts` (the order of
play, with the math in short at the top), then `packages/engine/src/math.ts`
(each formula with a worked example).

## The math: pop curves and Patch prices

Everything here comes from `packages/engine/src/config.ts`: the RTP
(`RTP_BP`, in basis points, so 9700 means 97.00%), one ladder of
multipliers per difficulty, and the bet and payout limits. Nothing else is
tuned. The numbers below are at 97%. `npm run rtp` prints the current
numbers for every rung.

### One rule sets every pop chance

Every cash-out point must return exactly the RTP. Call the RTP R and the
multiplier on rung k m_k. Cashing out on rung k pays the bet times m_k, so
it returns R only if a balloon reaches rung k with chance R / m_k. That
fixes every pump:

```
pump 1 survives with chance   R / m_1
pump k survives with chance   m_(k-1) / m_k      (k = 2, 3, ...)
```

Multiply the pumps up to rung k and everything in between cancels, leaving
R / m_k. So choosing a pop curve means choosing a ladder. There is nothing
else to set.

What follows from it:

- **The whole house edge is on the first pump.** Every later pump is a fair
  bet: on average it pays back exactly what it risks, before cent rounding.
  Once a balloon has survived one pump, pumping on and cashing out are
  worth the same on average.
- **Changing the RTP changes only the first pump and the Patch prices.**
  Every other chance stays the same:

| | First pump pops at 94% | at 97% | at 99% | Second pump pops (any RTP) |
| --- | --- | --- | --- | --- |
| Easy | 6.93% | 3.96% | 1.98% | 7.34% |
| Medium | 9.62% | 6.73% | 4.81% | 11.11% |
| Hard | 21.67% | 19.17% | 17.50% | 22.08% |
| Expert | 41.25% | 39.38% | 38.13% | 42.24% |

- **Chances are exact fractions in lowest terms** (97/101, never 0.9604). A
  pump draws a whole number from 0 up to the fraction's bottom number and
  survives if it is below the top number. No floating point decides a pump.

### The four ladders

| | Pumps | First rung | Top | First pump pops | Last pump pops | Reaches the top |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 32 | 1.01x | 50x | 3.96% | 16.50% | 1 in 52 |
| Medium | 20 | 1.04x | 100x | 6.73% | 41.00% | 1 in 103 |
| Hard | 15 | 1.20x | 1,000x | 19.17% | 57.00% | 1 in 1,031 |
| Expert | 10 | 1.60x | 5,000x | 39.38% | 80.00% | 1 in 5,155 |

Why they look like this:

- **Easy is long with small steps, Expert is short and steep**, as the
  brief asks. Expert's top is 5,000x.
- **Every pump pops a little more often than the one before**, on every
  ladder. That is where the tension comes from. The server checks this at
  start-up for the configured RTP and refuses to start if a ladder breaks
  it. In whole numbers, with h_k the multiplier in hundredths:
  - first two pumps: R × h_2 > 100 × h_1²
  - every pump after that: h_(k-1) × h_(k+1) > h_k²
- **The first rungs set the lowest RTP the game can run at.** A lower RTP
  makes the first pump riskier, and it must stay less risky than the
  second. With these ladders the game runs at any RTP from 93.59% to
  99.99%. Easy sets the 93.59%. Below that, or at 100% and above, the
  server refuses to start and says why.
- **Round numbers to aim for.** Easy has rungs at 2x, 5x, 10x, 25x and 50x;
  Medium at 2x, 5x, 10x, 25x and 100x; Hard at 2x, 5x, 100x, 200x and
  1,000x; Expert at 5x, 100x, 1,000x and 5,000x.
- **A rung at exactly 100x** on Medium, Hard and Expert, so the largest bet,
  $1,000, can win exactly the $100,000 cap.

Adding a fifth difficulty is one more entry in `DIFFICULTIES`, with no
engine change, and `npm run rtp` checks it like the others. (Three tests
still assume the four shipped ladders; see [Known issues](#known-issues).)

### The payout cap

- One balloon pays at most $100,000.
- For each bet, the rungs where bet × multiplier would pass the cap are
  locked, and the highest rung left becomes that balloon's top. Reaching it
  cashes out automatically.
- When the cap cuts a balloon's ladder, the bet panel shows the new top
  before the round starts. For example, $1,000 on Expert tops out at 100x
  (pump 7), not 5,000x.
- The RTP doesn't move, because every rung returns the RTP on its own. The
  cap makes the ladder shorter for a big bet; it never lowers a prize.

### Patch prices

- A Patch can be bought with any pump from the second on. If that pump
  would have popped, the balloon stays on its rung and the next pump is a
  fresh draw. Either way the Patch is used up.
- The Patch is bought and the pump made in one request, so a Patch is never
  left waiting.

For pump k on a bet B, with p_k that pump's pop chance:

```
price = p_k × B × m_(k-1) / R      rounded up to the cent
```

Why this returns exactly R: the Patch only matters when the pump would pop,
which happens with chance p_k. Then it keeps the balloon on rung k-1, worth
B × m_(k-1). That is its cash-out, and pumping on from there is a fair bet,
so it is worth the same either way. On average a Patch is worth
p_k × B × m_(k-1), and its price is that divided by R.

Example at 97%: $10 on Hard, about to pump from 3.57x to 5x (pump 6), which
pops 28.6% of the time.

- Price: 0.286 × $10 × 3.57 / 0.97 = $10.5260, rounded up to $10.53.
- Worth on average: 0.286 × $35.70 = $10.2102.
- That is 96.96% of the price: just under 97%, because the price was
  rounded up.

A Patch is cheap on an early pump and expensive near the top, because both
the risk and what's at stake grow. The price is on the Patch button before
you buy. There is no upper limit: the largest single Patch is $25,773.20
(Hard, $500 bet, pump 13). The price is worked out with whole-number
BigInt math, because its numerator can pass 2^53.

### Rounding: which way, and why

Money is whole cents everywhere. When an amount isn't a whole number of
cents, it is rounded toward the house: **payouts round down, Patch prices
round up.**

- **Why:** the brief allows rounding to push the RTP just under, never
  over. Rounding toward the house is the only direction that can never pay
  back more than the RTP, for every legal bet, not only round ones.
- **What it costs:** at most one cent per payment. Nothing on a $10 bet, a
  lot on a 10-cent one. `npm run rtp` checks every legal bet from $0.10 to
  $1,000 on every rung and prints the worst cases. At 97%:
  - worst cash-out: 88.99% (Easy, $0.10 bet, rung 2: 1.09x of 10 cents is
    10.9 cents, paid as 10)
  - worst Patch: 49.88% (Easy, $0.12 bet, pump 3)
  - a whole-dollar bet always cashes out at exactly bet × multiplier
- **What we turned down:** rounding at random, up or down in proportion,
  which keeps the average exact. It would need a random draw for money. We
  want the only draws to be pump draws, so every payout is one number
  anyone can work out again from the round.

### How the math is checked

- **`npm run rtp`** works everything out exactly, in fractions, with no
  luck: every rung's chance, every cash-out and every Patch on every
  difficulty, for all 99,991 legal bets. It also checks that the best
  possible way of playing never returns more than the RTP.
- **`npm run sim`** plays 10 million rounds per difficulty through the real
  engine and prints the RTP, hit rate, volatility and biggest win. It fails
  if any payout or price is off by a cent, or if the measured RTP is too
  far from the exact RTP of the way it plays, allowing for luck.
- **Neither one trusts the engine.** Every expected number comes from
  `packages/engine/cli/rules.ts`, which works the rules out from the config
  alone and never calls the engine. The tests hand the simulator engines
  that are wrong on purpose and expect FAIL.
- **Every test that depends on the RTP runs at 94%, 97% and 99%**, whatever
  `config.ts` says. Both scripts read the RTP and the ladders from
  `config.ts`, so they check whatever is configured.

To try another RTP, change `RTP_BP` in `config.ts`, then run `npm test`,
`npm run rtp` and `npm run sim`, and `npm start` to see it in the game.

## Provably fair

- Each pump is one draw: HMAC-SHA256 keyed with the player's server seed,
  over `clientSeed:nonce:balloonIndex:drawIndex:block`, turned into an
  exact roll by rejection sampling.
- The server seed is shown only as its SHA-256 until the player rotates it.
  After that, every round played with it can be checked.
- The nonce belongs to the server seed and goes up by one each round.
  Changing the client seed never resets it, so a round can't be replayed.
- [docs/fairness.md](docs/fairness.md) is the recipe for players, with
  worked examples.
- `packages/engine/test/fair/reference/fair_reference.py` is a separate
  copy in Python, written from that page alone. The engine tests must match
  its vectors.

### After the round: where it would have popped

- Once a round is over, each balloon cashed out below its top rung is
  played on with plain pumps (no Patch), using the draws its next pumps
  would have used. It starts at its draw count, not its rung, and stops
  when a pump would pop or it reaches its top rung.
- These draws decide nothing and move no money.
- A balloon that popped, reached its top or was refunded has no reveal.
- The verify page works the reveal out again from the revealed seed. It
  checks it against the reveal on record and, when this browser kept them,
  against the line its screen showed and each balloon's top rung as the
  screen first showed it. (A reveal stops at the top rung, and the
  record's top comes from the record's own payout cap. So without this
  browser's copy, a record with a lower cap could carry a shorter reveal
  that still checks out against itself.)
- A round that ended before the server stored reveals gets its reveal
  worked out when it is checked, from its by-then public seed.

### Why this still means "no pop result before the player pumps"

- Nothing about a pump the player didn't make is worked out or sent until
  the whole round is over.
- The reveal is computed only in the transaction that finishes the round:
  the last pump or cash-out, or the 24-hour settle. That is after every
  balloon is done and after the engine has accepted the action, so it
  can't change any balloon.
- While any balloon is still in play, no answer holds a reveal, and a
  refused request (400 or 409) computes nothing.
- Once the round is over, nothing is left to pump, and its server seed and
  nonce can never be played again. The reveal tells the player nothing
  they can use.

## The wallet

- **One transaction per request.** SQLite runs synchronously in one server
  process, and every change is one immediate transaction with no `await`
  inside it. Two requests can never both read a balance and then both
  spend it.
- **The ledger is append-only and chained.** Every cent that moves is one
  ledger row with the amount and the balance after it. Database triggers
  refuse to change, delete or replace a row, refuse a row that doesn't
  continue from the previous balance, and refuse a balance that doesn't
  match the last row. Writing the row moves the balance in the same
  statement. So the balance equals the sum of the ledger at all times, and
  the database enforces it, not just the code.
- **The ledger must agree with the round.** A bet row has to be the
  balloon's bet, a payout has to be what a cashed balloon recorded, and a
  refund has to be the bet of a refunded balloon, all for a balloon of that
  same player.
- **Check and charge are one statement.** The ledger row is written only if
  the balance can take it. A player with $5 can't spend $10.
- **Nothing is paid twice.** Unique indexes allow one opening grant per
  player, one bet per balloon, and at most one payout or refund per balloon.
- **One active round per player**, enforced by a partial unique index.
- **A repeated request is applied once.** Every changing request carries an
  `Idempotency-Key` header. The key lookup, the change and the stored
  answer are one transaction, so a crash can't leave a change done but
  unrecorded. A repeat gets the first answer back, success or refusal. A
  refusal's answer is built after its request is rolled back, so it shows
  the real balance. One key used for two different requests is refused.
- **Finished means finished.** Triggers stop a popped, cashed or refunded
  balloon, and a finished round, from ever changing again. A draw index can
  be recorded for one pump only.
- **The server seed stays secret.** Only its SHA-256 is shown until the
  player rotates. The code that reads seeds can't read an active one.
- **Players are anonymous.** A random token in an httpOnly cookie; the
  database stores only its hash.
- **The books can be checked from the data alone.** `reconcile()` compares
  every balance with its ledger, walks the ledger chain, and checks that
  every balloon was charged and paid exactly what its round says.

### Pump and Cash Out at the same moment

- Each pump and cash-out says which state of the balloon it was made from:
  `expectedDrawIndex`, the number of draws made on it so far.
- The first to arrive changes that number, so the second is refused with a
  409 and the current round.
- The rung wouldn't be enough: a pump saved by a Patch uses a draw without
  moving the rung.

### Abandoned rounds

- A round nobody has touched for 24 hours is settled for the player:
  balloons that were pumped cash out at their current multiplier, and bets
  that were never pumped are handed back.
- Cashing out at any rung returns the RTP, and a bet with no draw on it is
  simply void, so neither changes the RTP. A balloon cashed out this way
  gets a reveal like any other.
- It runs before the player's next request, and in a sweep every ten
  minutes.
- Why this rule: forfeiting the bets is unfair to a player whose connection
  dropped, and leaving rounds open for ever means the player could never
  start another.

### The hammer

- `npm run hammer` starts its own server as a separate process on a fresh
  database and has 20 players play at once.
- Every step is a burst sent at the same moment: the same key twice, Pump
  with Cash Out, two Pumps, two Cash Outs, four round starts.
- Then it opens the database and reconciles it.
- To aim it at a server you already run:
  `npm run hammer -- --url=http://localhost:3000 --db=data/pump.db`.

## The API

All JSON. The exact shapes are TypeScript types in `packages/contract`.

| Address | What it does |
| --- | --- |
| `GET /api/health` | Answers `{ "status": "ok" }`. Render calls it to see the server is up. |
| `GET /api/session` | Wallet, seeds and the round in progress, so a page refresh restores it. A first visit creates the player with $10,000 and sets the cookie. It is the only request that creates a player, so the screen loads it first. |
| `GET /api/history?limit=10` | The player's latest finished rounds. |
| `GET /api/stats` | The player's results over every finished round: profit over time, best win, rounds by difficulty. |
| `GET /api/settings` | The player's own choices: `{ winsPrivate }`. |
| `PUT /api/settings` | Changes them. `{ winsPrivate: true }` takes all of the player's wins, past ones too, out of the public lists at once. |
| `GET /api/wins` | The latest, largest and luckiest wins, ten of each, from players who haven't chosen private. Needs no cookie. When `PUBLIC_WINS` is off it answers `"enabled": false` with empty lists and reads nothing. |
| `POST /api/rounds` | Starts a round: `{ difficultyId, betsCents }`, one bet per balloon. Charges the bets. |
| `POST /api/rounds/:id/pump` | One pump: `{ balloonIndex, expectedDrawIndex, patch }`. With `patch: true` the Patch is bought and the pump made in one step. Answers `survived`, `saved`, `popped` or `top`. If it ends the round, each balloon cashed out below its top gets `afterRound`: where it would have popped. |
| `POST /api/rounds/:id/cash-out` | Cashes out one balloon: `{ balloonIndex, expectedDrawIndex }`. If it ends the round, it carries `afterRound` like a pump. |
| `GET /api/rounds/:id/verify` | A finished round with its revealed server seed, the RTP, ladder and payout cap it was played with, and each balloon's actions, draws and reveal. 409 until the seed has been rotated. |
| `PUT /api/fairness/client-seed` | Sets the client seed. Never resets the nonce. |
| `POST /api/fairness/rotate` | Retires the server seed, reveals it, and starts a new one. Refused during a round. |

Every request that changes something needs an `Idempotency-Key` header.
Errors always look like `{ "error": { "code", "message" } }`:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request is malformed or breaks a rule. |
| `no_session` | 401 | No player cookie. Only `GET /api/session` starts a player; the screen tells the player to reload. |
| `insufficient_funds` | 402 | The balance doesn't cover the bets or the Patch. Nothing was charged. |
| `not_found` | 404 | No such round for this player. |
| `conflict` | 409 | The balloon isn't in the state the request expected. The body carries the round as it is now. |
| `round_active` | 409 | A round is in progress: no second round, no seed changes. |
| `seed_not_revealed` | 409 | The round can't be checked until its server seed is rotated. |
| `key_reused` | 422 | This idempotency key was already used for a different request. |

### What the public wins give away

- A win in the lists is a finished round that paid out more than its bets
  and Patches, shown with its time, stake and payout. No player id, round
  id or seed is sent.
- A player shows as a six-character tag: a one-way hash of the player and
  the day. It can't be turned back into anything and it changes every day.
- But someone who knows one of a player's wins (from a screenshot, say)
  can find that row, and with it that player's other wins from the same
  day. Two players can also share a tag by chance.
- When a player goes private, all their rows leave the lists at the same
  moment, whatever day they're from. Someone comparing one answer with the
  next can tell those rows were one player, and that this player chose
  private.
- Going private is instant, and the lists can be shorter than ten until
  they are next read. Going public again shows the wins the next time the
  lists are read: one answer is reused for at least five seconds, longer
  after a slow read, up to twenty minutes.
- It doesn't touch the player's own history or stats.
- Every player starts with their wins shown: the default of the
  `wins_private` column (database step 3).

## Feature switches

Some features aren't allowed in every market, so each one can be turned
off without touching the game's math.

| Switch | Where | What it turns off |
|---|---|---|
| `VITE_MARKET` | Set when the web app is built, e.g. `VITE_MARKET=gb npm run build`. The rules per market are in `apps/web/src/market.ts`. | `autoPlay`: the Auto tab. `autoBetSizing`: auto-play's "On win" / "On loss" bet changes (the bets then stay as the player entered them). |
| `PUBLIC_WINS` | Set when the server starts: `"on"` or `"off"`. On Render it is in `render.yaml`. | The public lists of other players' wins (`GET /api/wins`); the screen hides them when they're off. |
| Keep my wins private | Each player, in the game's settings menu (`PUT /api/settings`). | That player's wins, past ones too, in the public lists. |

- **Markets.** No value means `default` (everything on). `gb` (or `uk`) has
  auto-play off. A value the file doesn't know switches every listed
  feature off and says so in the browser console, so a typo never turns a
  banned feature on. Adding a market, for example Ontario, is one line in
  `market.ts`.
- **`PUBLIC_WINS`.** Run from this repo with nothing set, it's on, so you
  see it. On a host with nothing set, it's off: showing players' results to
  others has to be a written choice. A word that is neither `on` nor `off`
  means off, with a warning in the log. The live site has it off. Write the
  value in quotes in `render.yaml`, because a bare `on` or `off` in YAML can
  be read as `true` or `false`. The server can't see a typo in the
  variable's name, so it logs `public wins: ON` or `OFF` at every start.
  Read that line after changing it.
- **Player settings.** Sound, Animations off and Keep my wins private are in
  the game's settings menu. Animations off removes movement but keeps the
  same timing, so a result never shows sooner.

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

Conventions:

- Tests live in a `test/` folder next to `src/`, named `*.test.ts`.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.
- npm blocks dependency install scripts unless `allowScripts` in the root
  `package.json` allows them. A dependency that needs to compile native
  code has to be approved there.

## Tradeoffs

- **The first pump carries the whole house edge.** This follows from every
  cash-out returning exactly the RTP. The cost is a floor on the RTP: below
  93.59% the first pump would pop more often than the second on Easy, so
  the ladders would have to change. 94% and 99% both run.
- **Rounding favours the house**, so tiny bets get back a little less than
  the RTP. We show this in `npm run rtp` instead of hiding it, and chose it
  over random rounding.
- **Patches are always sold, at any price.** On Easy with a $1 bet, the
  Patch for each of pumps 2 to 8 costs exactly what that pump can win (8
  cents for a step from 1.01x to 1.09x). Every Patch still returns the RTP,
  so we show the price and let the player choose, instead of capping the
  price or hiding those Patches.
- **The cap shortens the ladder instead of lowering a prize.** A big bet
  has fewer rungs, and the player sees where it stops before betting.
- **Easy stays long and gentle.** Its pop chance only rises from 4% to
  16.5% over 32 pumps, so the tension builds slowly. A shorter, steeper
  Easy was designed and not taken.
- **One server process and SQLite.** Every change is one synchronous
  transaction, so two requests can never both spend the same money, and
  that is easy to check. The cost is that the game can't spread over
  several servers.
- **Players are anonymous.** The cookie is the account. Clearing cookies or
  changing browser starts a new $10,000 wallet, and the old one can't be
  got back.
- **Abandoned rounds settle after 24 hours**, instead of forfeiting the
  bets or staying open for ever (see [Abandoned rounds](#abandoned-rounds)).

## Known issues

Found in the final check before submitting, and not fixed on `main` yet:

- **The verify page trusts the server's client seed and nonce.** The
  browser keeps its own copy only of the server seed's hash. A dishonest
  server could send back a different client seed whose rolls happen to give
  the same results the player saw, and the page would say the round checks
  out. Being fixed: the browser will keep its own copy of the client seed
  and nonce shown before each round, and check against that.
- **A fifth difficulty breaks three tests.** The engine, `npm run rtp` and
  `npm run sim` handle it with no change. But the level colour test wants a
  colour for every difficulty, one web test assumes every ladder has at
  least 10 rungs, and one fairness test expects a "reveal to the top" in a
  short random sample. Being fixed.
- **One bad round can stop the 24-hour sweep.** If one abandoned round
  fails to settle, the sweep stops for every round after it. Being fixed.
- **`GET /api/session` has no limit.** Every visit without a cookie makes a
  new player, so a script could fill the database.
- **The hammer never tries to overspend over HTTP.** That case is tested
  only in `apps/server/test/wallet.test.ts`.

## With more time

- Play-test the ladders with real players and tune them. A ladder change is
  one edit in `config.ts` and one run of `npm run rtp`.
- Watch whether players buy Patches that cost as much as their step can
  win, and decide whether to keep selling them.
- Accounts, so a wallet survives cleared cookies and works on more than one
  device.
- A database server, so more than one copy of the server can run.
- Deploy each green push to the live site automatically, instead of by
  hand.

## Hours I spent

About 18½ hours of my own time. I counted it from when I was sending
messages to the AI chats, not from the commits.

- **Friday 20 November:** about 9½ hours, from 1:30 pm to 6 pm and from
  7:15 pm to midnight.
- **Saturday 21 November:** about 2 hours in the morning. I had an
  engineering competition for the middle of the day. Then about 7 hours in
  the evening, from about 5 pm to midnight, on the write-ups, final checks
  and last fixes.

The AI chats kept working while I was away (overnight and during the
competition), so the project ran for longer than my hours.
