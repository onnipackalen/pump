# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

- Play it: <https://pump-wysj.onrender.com> (see "The live site")
- Code: <https://github.com/onnipackalen/pump>

Everything the brief asks for is built: four difficulties, one to three
balloons, Patch, auto-play, keyboard play, sound, a phone layout, the exact
RTP check (`npm run rtp`), the simulator (`npm run sim`), the hammer
(`npm run hammer`) and the verify page. Extras: a stats page, live stats,
public wins, and the after-round reveal below.

Also in the repo: [PLAYTEST.md](PLAYTEST.md), [AI_USAGE.md](AI_USAGE.md), and
the hours I spent (the last section of this file).

## The fun part: where it would have popped

After a round, every balloon you cashed out early plays on by itself and
shows where it would have popped: "Next pump would have popped", "Would have
reached 1.37×, then popped", or "Would have reached the top (25.00×)".

Why: the hardest moment in Pump is deciding when to stop, and normally you
never find out if you were right. The reveal tells you, and it goes both
ways. Often you got out just in time; sometimes you left money behind. That
is the moment players talk about, and the reason to play one more round. It
was my first idea for the game.

It can't be used to cheat. It is worked out only once the whole round is
over, from the same draws the next pumps would have used. It moves no money,
and the verify page checks it like every other pump (see "Provably fair").

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

Never put an older version of the server back on the live site: not with
Render's Rollback button, not with "Deploy a specific commit", and not by
undoing a change on `main` and deploying that. A newer version may have added
a step to the database that older code cannot follow. On such a database an
older server fails half way through some actions, and a pump that fails only
when it would end the round tells the player what that pump would do. From
this version on the server refuses to start on a database that a newer
version has changed (`migrate` in `apps/server/src/db/migrations.ts`), so the
mistake is loud instead of quiet. Each database step is one-way in this
sense: once step 2 (the after-round reveal) or step 3 (a player's choice to
keep wins private) has run on the live database, no version from before that
step may be deployed there again. If something is wrong after a deploy, fix
it with a new commit and deploy that.

Never delete the service while the site is in use: the wallets are on its
disk. Render takes a snapshot of the disk once a day and keeps it for a week,
but that is a last resort, not a backup: restoring one puts the whole disk
back to that moment, so every round and payout since is gone, and Render
warns that a database restored this way can come back damaged.

When the site is no longer needed: on the Blueprint's Settings page set Auto
Sync to No, then delete the `pump` service. That destroys every wallet for
good. Afterwards look at the Billing page to see that the charges stopped.

## Feature switches

Some features are not allowed in every market, so each one can be turned off
without touching the game's math. All of them are listed here.

| Switch | Where | What it turns off |
|---|---|---|
| `VITE_MARKET` | Set when the web app is built, e.g. `VITE_MARKET=gb npm run build`. The rules per market are in `apps/web/src/market.ts`. | `autoPlay`: the Auto tab. `autoBetSizing`: auto-play's "On win" / "On loss" bet changes (the bets then stay as the player entered them). |
| `PUBLIC_WINS` | Set when the server starts (`"on"` or `"off"`; on Render it is in `render.yaml`, applied by a Blueprint sync, not by a Manual Deploy). On a host it is off unless set to `"on"`; run from the repo it is on. The server logs `public wins: ON` or `OFF` at every start. | The public lists of other players' wins (`GET /api/wins`); the screen hides them when they are off. Details under "The API". |
| Keep my wins private | Each player, in the game's settings menu (`PUT /api/settings`). | That player's wins, past ones too, in the public lists. |

Known markets: no value means `default` (everything on); `gb` (or `uk`) has
auto-play off. A value the file does not know switches every listed feature
off and says so in the browser console, so a typo never turns a banned feature
on. Adding a market, for example one for Ontario, is one line in `market.ts`.

The player's own settings (sound, Animations off, Keep my wins private) are
in the game's settings menu. Animations off removes movement but keeps the
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

## Provably fair

Each pump is decided by one draw: HMAC-SHA256 keyed with the player's server
seed, over `clientSeed:nonce:balloonIndex:drawIndex:block`, turned into an
exact roll by rejection sampling. The server seed is shown only as its
SHA-256 until the player rotates it. After that, every round played with it
can be checked. `docs/fairness.md` is the recipe for players, with worked
examples. `packages/engine/test/fair/reference/fair_reference.py` is a
separate copy in Python, written from that page alone, and the engine tests
must match its vectors.

**After the round: where it would have popped.** Once a round is over, each
balloon that was cashed out below its top rung shows where it would have
popped. The server plays it on with plain pumps (no Patch), using the draws
its next pumps would have used, starting at its draw count (not its rung),
until a pump would pop or it reaches its top rung. These draws decide
nothing and move no money. The verify page works them out again from the
revealed seed and checks them against the reveal on record and, when this
browser kept them, the line its screen showed and each balloon's top rung as
the screen first showed the round. (A reveal stops at the top rung, and the
record's top comes from the record's own payout cap, so a record with a lower
cap could carry a shorter reveal that still checks out against itself.) A
balloon that popped, reached its top or was refunded has no reveal. A round
that ended before the server stored reveals gets its reveal worked out when
it is checked, from its by-then public seed.

**Why this keeps "no pop result before the player pumps".** Nothing about a
pump the player did not make is worked out or sent until the whole round is
over. The reveal is computed only in the transaction that finishes the round:
the player's last pump or cash-out, or the 24-hour settle (on the player's
next request or by the sweep). That is always after every balloon is done,
and after the engine has accepted the action, so it cannot change any balloon.
While any balloon is still in play, no answer holds a reveal, and a refused
request (400 or 409) computes nothing. Once the round is over nothing is left
to pump, and its server seed and nonce can never be played again, so the
reveal tells the player nothing they can use.

## The API

All JSON. The exact shapes are TypeScript types in `packages/contract`.

| Address | What it does |
| --- | --- |
| `GET /api/health` | Answers `{ "status": "ok" }`. Render calls it to see that the server is up, so `render.yaml` names it. |
| `GET /api/session` | Wallet, seeds and the round in progress, so a page refresh restores it. A first visit creates the player with $10,000 and sets the cookie. It is the only request that creates a player, so the screen loads it first. |
| `GET /api/history?limit=10` | The player's latest finished rounds. |
| `GET /api/stats` | The player's own results over every finished round: profit over time, best win, rounds by difficulty. |
| `GET /api/settings` | The player's own choices: `{ winsPrivate }`. |
| `PUT /api/settings` | Changes them: `{ winsPrivate: true }` keeps all of the player's wins, past ones too, out of the public lists, at once. |
| `GET /api/wins` | The latest, largest and luckiest wins, ten of each, of all players who have not chosen to keep theirs private. Needs no cookie. No player id, round id or seed is sent; a player is a short tag that changes every day. Empty when the server is started with `PUBLIC_WINS=off`. |
| `POST /api/rounds` | Starts a round: `{ difficultyId, betsCents }`, one bet per balloon. Charges the bets. |
| `POST /api/rounds/:id/pump` | One pump: `{ balloonIndex, expectedDrawIndex, patch }`. With `patch: true` the Patch is bought and the pump made in one step. The answer says `survived`, `saved`, `popped` or `top`. If it ends the round, each balloon cashed out below its top gets `afterRound`: where it would have popped. |
| `POST /api/rounds/:id/cash-out` | Cashes out one balloon: `{ balloonIndex, expectedDrawIndex }`. If it ends the round, each balloon cashed out below its top gets `afterRound`, as with a pump. |
| `GET /api/rounds/:id/verify` | A finished round with its revealed server seed, the RTP, ladder and payout cap it was played with, and each balloon's actions, draws and reveal, to recompute it. 409 until the seed has been rotated. |
| `PUT /api/fairness/client-seed` | Sets the client seed. Never resets the nonce. |
| `POST /api/fairness/rotate` | Retires the server seed, reveals it, and starts a new one. Refused during a round. |

Showing players' wins to everyone is not allowed in every market, so it has
an off switch, `PUBLIC_WINS`, read when the server starts:

- `off`: `GET /api/wins` answers `"enabled": false` with empty lists, and the
  server reads nothing for it.
- `on`: the lists are shown.
- A word that is neither: off, with a warning in the log. A typo in the value
  never switches it on.
- Nothing set: on when the game is run from this repo, so you see it; off on
  a host, where showing players' results to others has to be a written
  choice. `render.yaml` says `"off"` for the live site. Write the value in
  quotes there: a bare `on` or `off` in a YAML file can be read as `true` or
  `false`.

On the live site today the server logs "PUBLIC_WINS is not set": a Manual
Deploy builds the new code but does not apply `render.yaml`'s settings, and
the service was made before this setting existed. It is off all the same,
because nothing set means off on a host. To switch the lists on, set
`PUBLIC_WINS` to `"on"` in `render.yaml` and sync the Blueprint on Render,
which is what applies `render.yaml`'s settings; a Manual Deploy alone will
not. Then read the `public wins:` line in the log.

The server cannot see a typo in the variable's name, so it says
`public wins: ON` or `public wins: OFF` in its log at every start. Read that
line after changing the setting.

A player can keep their own wins private. `PUT /api/settings` with
`{ "winsPrivate": true }` takes every win of theirs out of the three lists,
past wins too, and it happens at once, not after the five seconds. Until the
lists are next read they can then be shorter than ten. Switching back shows
the wins again the next time the lists are read: about five seconds, longer
after a slow read. The player's own history and stats are not touched by it.
Every player starts with their wins shown. That is the default of one column
(`wins_private`, database step 3). It can be changed by editing that step only
until the step has run on a database; after that it takes a new step.

What the lists give away, in plain words. A win there is a finished round that
paid out more than its bets and Patches, shown with its time, stake and
payout. A player is shown as a six-character tag: a one-way hash of the player
and the day. It cannot be turned back into anything, and it changes every
day. But someone who knows one of a player's wins (say from a screenshot) can
find that row, and with it that player's other listed wins of the same day.
Two players can also share a tag by chance. And when a player goes private,
all their rows leave the lists in the same moment, whatever day they are
from: someone comparing one answer with the next can tell that those rows
were one player, and that this player chose private. A fresh answer reads
every finished round, so one answer is reused for at least five seconds, and
for longer the slower the read was, up to twenty minutes.

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
changes the RTP. A balloon cashed out this way gets a reveal like any other.
The rule is applied before the player's next request and by a sweep every ten
minutes. We chose this over forfeiting the bets (unfair to a player whose
connection dropped) and over leaving rounds open for ever (the player could
never start another). Each round is settled in its own transaction: if one
cannot be settled, none of it is saved and it stays as it was. The sweep logs
it as an error with its round and player, still settles every other round,
and tries that one again next time. Until it settles, that player's own
requests answer with a plain 500 error, logged without the round or player.

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

## The math: pop curves and Patch prices

Everything here comes from two settings in `packages/engine/src/config.ts`:
the RTP (`RTP_BP`, in basis points: 9700 means 97.00%) and one ladder of
multipliers per difficulty. Nothing else is tuned. The numbers below are at
97% with the ladders as they were on 2026-11-20. `npm run rtp` prints the
current numbers for every rung.

### One rule sets every pop chance

Every cash-out point must return exactly the RTP. Call the RTP R and the
multiplier on rung k m_k. Cashing out on rung k pays the bet times m_k, so it
returns R only if a balloon reaches rung k with chance R / m_k. That fixes
every pump:

```
pump 1 survives with chance   R / m_1
pump k survives with chance   m_(k-1) / m_k      (k = 2, 3, ...)
```

Multiply the pumps up to rung k and everything in between cancels, leaving
R / m_k. So choosing a pop curve means choosing a ladder: the chances follow
from it, and there is nothing else to set.

Two things follow:

- **The whole house edge is on the first pump.** Every later pump is a fair
  bet: on average it pays back exactly what it risks. So once a balloon has
  survived one pump, pumping on and cashing out are worth the same on
  average, before cent rounding.
- **Changing the RTP changes only the first pump**, and the Patch prices
  (below). Every other chance stays the same:

| | First pump pops at 94% | at 97% | at 99% | Second pump pops (any RTP) |
| --- | --- | --- | --- | --- |
| Easy | 6.93% | 3.96% | 1.98% | 7.34% |
| Medium | 9.62% | 6.73% | 4.81% | 11.11% |
| Hard | 21.67% | 19.17% | 17.50% | 22.08% |
| Expert | 41.25% | 39.38% | 38.13% | 42.24% |

Chances are exact fractions in lowest terms (97/101, never 0.9604). A pump
draws a whole number from 0 up to the fraction's bottom number and survives
if it is below the top number. No floating point is used to decide a pump.

### The four ladders

| | Pumps | First rung | Top | First pump pops | Last pump pops | Reaches the top |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 32 | 1.01x | 50x | 3.96% | 16.50% | 1 in 52 |
| Medium | 20 | 1.04x | 100x | 6.73% | 41.00% | 1 in 103 |
| Hard | 15 | 1.20x | 1,000x | 19.17% | 57.00% | 1 in 1,031 |
| Expert | 10 | 1.60x | 5,000x | 39.38% | 80.00% | 1 in 5,155 |

Why they look like this:

- **Easy is long with small steps, Expert is short and steep**, as the brief
  asks. Expert's top is 5,000x.
- **Every pump pops a little more often than the one before**, on every
  ladder. That is where the tension comes from. The server checks it at
  start-up for the configured RTP and refuses to start if any ladder breaks
  it. In whole numbers, with h_k the multiplier in hundredths:
  R × h_2 > 100 × h_1² for the first two pumps, and
  h_(k-1) × h_(k+1) > h_k² for every pump after that.
- **The lowest RTP the game can run at comes from the first rungs.** A lower
  RTP makes the first pump riskier, and it must stay less risky than the
  second. With these ladders the game runs at any RTP from 93.59% to 99.99%.
  Easy sets the 93.59%. Below it, or at 100% and above, the server refuses to
  start and says why.
- **Round numbers to aim for.** Easy has rungs at 2x, 5x, 10x, 25x and 50x;
  Medium at 2x, 5x, 10x, 25x and 100x; Hard at 2x, 5x, 100x, 200x and 1,000x;
  Expert at 5x, 100x, 1,000x and 5,000x.
- **A rung at exactly 100x** on Medium, Hard and Expert, so the largest bet,
  $1,000, can win exactly the $100,000 cap.

Adding a fifth difficulty is one more entry in `DIFFICULTIES`, with no engine
change. `npm run rtp` then checks it like the others.

### The payout cap

One balloon pays at most $100,000. For each bet, the rungs where bet ×
multiplier would pass the cap are locked, and the highest rung left becomes
that balloon's top: reaching it cashes out automatically. When the cap cuts a
balloon's ladder, the bet panel shows its new top before the round starts.
For example, $1,000 on Expert tops out at 100x (pump 7), not 5,000x.

The RTP does not move, because every rung returns the RTP on its own. The cap
only makes the ladder shorter for a big bet; it never lowers a prize.

### Patch prices

A Patch can be bought with any pump from the second on. If that pump would
have popped, the balloon stays on its rung instead, and the next pump is a
fresh draw. Either way the Patch is used up. The Patch is bought and the pump
made in one request, so a Patch is never left waiting.

For pump k on a bet B, with p_k that pump's pop chance:

```
price = p_k × B × m_(k-1) / R      rounded up to the cent
```

Why this returns exactly R: the Patch only matters when the pump would pop,
which happens with chance p_k. Then it keeps the balloon on rung k-1, worth
B × m_(k-1): that is its cash-out, and pumping on from there is a fair bet,
so it is worth the same either way. On average, then, a Patch is worth
p_k × B × m_(k-1), and its price is that divided by R.

Example at 97%: $10 on Hard, about to pump from 3.57x to 5x (pump 6), which
pops 28.6% of the time. The Patch costs 0.286 × $10 × 3.57 / 0.97 = $10.5260,
rounded up to $10.53. On average it is worth 0.286 × $35.70 = $10.2102,
which is 96.96% of its price: just under 97%, because the price was rounded
up.

A Patch costs little on an early pump and a lot near the top, because both
the risk and what is at stake grow. The price is on the Patch button before
the player buys. There is no upper limit: the largest single Patch is
$25,773.20 (Hard, $500 bet, pump 13). The price is computed with whole-number
BigInt math, because its numerator can pass 2^53.

### Rounding: which way, and why

Money is whole cents everywhere. When an amount is not a whole number of
cents, it is rounded toward the house: **payouts round down, Patch prices
round up.**

Why: the brief allows rounding to push the RTP just under, never over.
Rounding toward the house is the only direction that can never pay back more
than the RTP, for every legal bet, not only round ones.

What it costs: at most one cent per payment. That is nothing on a $10 bet and
a lot on a 10-cent one. `npm run rtp` checks every legal bet from $0.10 to
$1,000 on every rung and prints the worst cases instead of hiding them. At
97%, the worst cash-out returns 88.99% (Easy, $0.10 bet, rung 2: 1.09x of 10
cents is 10.9 cents, paid as 10) and the worst Patch returns 49.88% (Easy,
$0.12 bet, pump 3). A whole-dollar bet always cashes out at exactly bet ×
multiplier.

What we turned down: rounding at random, up or down in proportion, which
keeps the average exact. It would need a random draw for money amounts. We
want the only draws to be pump draws, so every payout is one number anyone
can work out again from the round.

### How the math is checked

- **`npm run rtp`** works everything out exactly, in fractions, with no
  luck: every rung's chance, every cash-out and every Patch on every
  difficulty, for all 99,991 legal bets. It also checks that the best
  possible way of playing never returns more than the RTP. It reads the RTP
  and the ladders from `config.ts`, so it checks whatever is configured.
- **`npm run sim`** plays 10 million rounds per difficulty through the real
  engine and prints the RTP, hit rate, volatility and biggest win. It fails
  if any payout or price is off by a cent, or if the measured RTP is too far
  from the exact RTP of the way it plays.
- Every test that depends on the RTP runs at 94%, 97% and 99%, whatever
  `config.ts` says.

To try another RTP, change `RTP_BP` in `config.ts`, then run `npm test`,
`npm run rtp` and `npm run sim`, and `npm start` to see it in the game.

## Tradeoffs

- **The first pump carries the whole house edge.** This follows from every
  cash-out returning exactly the RTP. The cost is a floor on the RTP: below
  93.59% the first pump would pop more often than the second on Easy, so the
  ladders would have to change. 94% and 99% both run.
- **Rounding favours the house**, so tiny bets get back a little less than
  the RTP. We show this in `npm run rtp` rather than hide it, and chose it
  over random rounding.
- **Patches are always sold, at any price.** On Easy with a $1 bet, the Patch
  for each of pumps 2 to 8 costs exactly what that pump can win (8 cents for
  a step from 1.01x to 1.09x). Every Patch still returns the RTP, so we show
  the price and let the player choose, rather than cap the price or hide
  those Patches.
- **The cap shortens the ladder instead of lowering a prize.** A big bet has
  fewer rungs, and the player sees where it stops before betting.
- **Easy stays long and gentle.** Its pop chance only rises from 4% to 16.5%
  over 32 pumps, so the tension builds slowly. A shorter, steeper Easy was
  designed and not taken.
- **One server process and SQLite.** Every change is one synchronous
  transaction, so two requests can never both spend the same money, and that
  is easy to check. The cost is that the game cannot spread over several
  servers.
- **Players are anonymous.** The cookie is the account: clearing cookies or
  changing browser starts a new $10,000 wallet, and the old one cannot be got
  back.
- **Abandoned rounds settle after 24 hours** (see "Abandoned rounds" above),
  rather than forfeiting the bets or staying open for ever.

## With more time

- Play-test the ladders with real players and tune them. A ladder change is
  one edit in `config.ts` and one run of `npm run rtp`.
- Watch whether players buy Patches that cost as much as their step can win,
  and decide whether to keep selling them.
- Accounts, so a wallet survives cleared cookies and works on more than one
  device.
- A database server, so more than one copy of the server can run.
- Deploy each green push to the live site automatically, instead of by hand.

## Hours I spent

About 16½ hours of my own time. I counted it from when I was sending
messages to the AI chats, not from the commits:

- **Friday 20 November:** about 9½ hours, from 1:30 pm to 6 pm and from
  7:15 pm to midnight.
- **Saturday 21 November:** about 2 hours in the morning. I had an
  engineering competition for the rest of the day, then spent about 5 hours
  in the evening on the write-ups and final checks.

The AI chats kept working while I was away (overnight and during the
competition), so the project ran for longer than my hours.
