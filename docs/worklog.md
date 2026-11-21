# Worklog

One entry per working session: what was built, anything that turned out
wrong, and how it was caught. Add new entries at the bottom.

## 2026-11-20: project setup

Built:

- npm workspaces monorepo: `packages/engine`, `apps/server`, `apps/web`.
- Root scripts: `test`, `lint`, `typecheck`, `rtp`, `sim`, `hammer`. The last
  three are stubs that exit with an error until they are built.
- Strict TypeScript with `noUncheckedIndexedAccess`, type-aware ESLint with
  `no-explicit-any` as an error, Vitest, GitHub Actions CI.
- Guards that keep `packages/engine/src` pure: it compiles without Node or
  DOM types, and ESLint bans `node:` imports, `Date` and `Math.random` there.
- `CLAUDE.md` with the locked project decisions.

Turned out wrong, and how it was caught:

- The newest TypeScript is 7.0.2, but typescript-eslint 8.73 only supports
  TypeScript below 6.1. Caught by reading its peer dependencies before
  installing. TypeScript is pinned to 6.0.x.
- npm 11 blocks dependency install scripts by default. esbuild and fsevents
  both have one. Caught from the warning at the end of `npm install`. Both
  work without their script (checked by running tsx, Vitest and a Vite
  build), so they are recorded as denied in `allowScripts`. Anything that
  compiles native code later will need an explicit approval there.
- Session worktrees are created under `.claude/worktrees/` inside this
  folder, and `npm run lint` from the main checkout started linting those
  copies too. Caught by listing the git worktrees and counting them in
  ESLint's debug output. `.claude/` is now ignored by ESLint.
- The briefs for the parallel sessions said survive fractions are used
  unreduced (9700/10100). `game-spec.json`, the approved math spec, says
  reduced (97/101). The two give different rolls, so a round verified one
  way would not match the other. Caught by reading the spec when it appeared
  in the folder, before any engine code was merged. The engine and fair
  sessions were told to use reduced fractions.
- The purity guards were checked with a throwaway file that imported
  `node:fs` and used `console`, `Math.random`, `Date` and `any`. The compiler
  and the linter rejected all of it. The file was deleted, not committed.

## 2026-11-20: web interface, first pass

Built, all in `apps/web`:

- `api/contract.ts`: a proposal for the API, written from what the screen
  needs: endpoints, response shapes, error codes. Money in cents, chances as
  exact fractions, a 409 carries the current state. To move into a shared
  package once the server exists.
- `demo/DemoClient.ts`: plays the game in the browser so the screen can be
  clicked before the server is written. Not provably fair, resets on
  refresh, badged "Demo" on screen. `demo/placeholderMath.ts` holds the few
  rules it needs until the engine exports them; checked against every test
  vector in `game-spec.json` with a throwaway test.
- The game screen: bet panel (difficulty, 1 to 3 balloons, a bet each, a
  cap warning before the round starts), balloon cards with multiplier,
  cash-out value, pop chance and Patch price, last 10 rounds, the provably
  fair panel, keyboard play, and a phone layout. The balloon art is copied
  from `graphics/balloon`; pop and cash-out use stand-in CSS.
- Each action sends a new idempotency key and the balloon's expected draw
  index. Wins are coloured only when the payout beats the bet plus Patches.

Turned out wrong, and how it was caught:

- After the picked balloon popped, Space pumped the next live balloon
  instead, so a player could risk a bet they never chose. Caught while
  playing a 3-balloon round in the browser. Keys now act only on the picked
  balloon, and held keys don't repeat.
- The contract had the server choosing the first client seed, and the
  screen read a round's ladder from the current config. Caught by reading
  7e79187, which locked both rules from another chat mid-session. Fixed in
  185f62f.

Not done yet: the real HTTP client (needs the server), swapping
`placeholderMath.ts` for the engine, auto-play, sound, the verify page, the
pop and cash-out graphics, and a session time and net result display.

## 2026-11-20: one screen, background and settings (branch `one-screen-layout`)

Built in `apps/web/src`, on the branch `one-screen-layout`, in its own
worktree, because another chat was fixing review bugs in the same files at
the same time. Merged after the user approved the look: main's review fixes
and new balloon art were merged into the branch first (four files by hand:
`App.tsx`, `AutoPlayPanel.tsx`, `BalloonCard.tsx`, `styles.css`), checked
again, and only then was main moved forward.

- The game is one screen that never scrolls. The page is a fixed, clipped
  box: top bar, balloons, one control panel. The balloons take the room the
  panel leaves, so they shrink before anything is pushed off the screen.
- One control panel, showing only what the next tap needs: the bet before a
  round (Manual and Auto are tabs), the picked balloon's three buttons
  during a round (`RoundControls.tsx`), and progress with Stop while
  auto-play runs. Each balloon shows two lines under it: its multiplier and
  the money that goes with it.
- The hint paragraphs are gone from the game screen. A capped bet shows its
  top inside the bet box, before the round starts.
- A settings button is always in the top bar (`SettingsMenu.tsx`, a native
  dialog). It holds sound, the provably fair panel, the last 10 rounds, and
  a new game info section (`GameInfo.tsx`): rules, limits, RTP and keys,
  all read from config.
- The background (`background.css`): a dusk glow, two far hills and a floor
  with a horizon line, drawn with gradients and one inline drawing. Nothing
  moves and nothing in it changes with the round.
- The Cash out button lost its mint border. Mint is only for a real win.

Checked in the browser with a script that measures every element and also
tries to scroll the page by code. Seven states, all with 3 balloons: the
bet screen with every bet capped, the Auto tab, a live round, a finished
round, auto-play running, auto-play done, and settings open. Run again on
the merged code at 1920x1080, 1440x900, 1366x768, 1280x720, 1024x768,
1024x600, 768x1024, 430x932, 412x915, 390x844, 375x667, 360x640, 320x568,
and sideways at 932x430, 844x390, 667x375 and 640x360. Nothing off screen,
no clipped text, no scrolling.

From the merge: the per-balloon Stop bar from the review fixes is left out,
because the panel shows only progress and Stop while auto-play runs and is
always on screen. Everything else from those fixes is kept.

Turned out wrong, and how it was caught:

- With `overflow: hidden` the page could still be scrolled by code. A test
  click on the settings button scrolled the whole game sideways. Caught
  from the screenshot. The page now uses `overflow: clip`, which cannot be
  scrolled at all, and the size check tries to scroll it.
- The first background had rings centred on the stage. With three balloons
  they circled the middle one and looked like a selection. Caught on a
  phone screenshot. Removed; the glow is now wide and even.
- The background is drawn wider than the stage, and on a sideways phone it
  painted over the Start button. Caught on a 568x320 screenshot. The panel
  now sits above the scene.
- "$1,000.00" under a balloon spilled into the next balloon on narrow
  screens. Caught by the size check's clipped-text test. The number size is
  now the slot width divided by the number of characters.
- After an auto-play run, its result line pushed the panel past the screen
  at 375x667 with three balloons. Caught by running auto-play and measuring
  again. The result now takes the place of the ladder line.

- After the merge, the result line of an auto-play run made the panel
  scroll inside itself at 320x568 with three balloons. Caught by adding two
  states to the size check (auto-play running and done) and running it on
  the merged code. On very small upright phones the result now floats over
  the top of the stage.

Known limits:

- A phone held sideways and narrower than 640px (568x320) with three
  balloons: the control panel scrolls inside itself. The page still does
  not. The same happens if several bets show an error at once on the
  smallest phones.
- On sideways phones the half and double buttons are left out to make room.
- Checked in Chromium only. `overflow: clip` and container units need
  Safari 16 or newer. Not tried in Safari or on a real phone.
## 2026-11-20: provably fair draws

Built:

- `CLAUDE.md` now locks the formats that change every roll. The HMAC key
  and the shown hash both use the server seed's 64-character text. Words
  are read big-endian. Fractions are reduced first. Each round keeps its
  own RTP and ladder. The browser makes the first client seed. HMAC comes
  from @noble/hashes. (7e79187)
- `docs/fairness.md`: the recipe for players, with a worked example and a
  worked round that includes a Patch save.
- `packages/engine/src/fair`, in four commits: seed and message rules
  (877a347), HMAC and SHA-256 from @noble/hashes 2.4.0, cross-checked
  against Node's crypto and RFC 4231 (5da1e0f), bytes to an exactly uniform
  roll (45bee52), and the draw function plus a single-use drawer for the
  engine (a3abd19).
- An independent Python reference written only from the docs, and
  `vectors.json` with 393 draws, including 9 that need block 1 or 2
  (355d713). A test checks that the TypeScript code matches it on every
  vector (7e2091d). They agreed the first time.
- Proof that the roll is uniform: the same acceptance function, run over
  every word for every den in 8-bit and 12-bit word spaces, gives each roll
  exactly the same number of times.
- Mutation check: 18 deliberate bugs (byte order, `<=` limit, block
  starting at 1, wrong separator, hex-decoded key, and so on). The existing
  tests caught every one.

Turned out wrong, and how it was caught:

- The verify recipe didn't say that pump k means the rung the balloon
  climbs to, not the number of presses. After a Patch save, a player
  counting presses would use the wrong fraction and conclude an honest round
  was rigged. Caught by a reviewer who recomputed a Patch-saved round in
  Python, then confirmed by a second agent. Fixed with a worked Patch round
  in the docs and tests (614c74a).
- Nothing stopped `PumpEngine.ts` from importing HMAC or seed functions
  from `src/fair` or `@noble`. The lint rules only ban `node:*`. Caught
  separately by two reviewers, by linting a made-up engine file through
  stdin. `test/fair/boundary.test.ts` now fails on any non-type import
  (95df4b9).
- Error messages showed a string "5" or a bigint 5n as "got 5", which reads
  as if a valid value was refused. Caught by the integration reviewer
  (f7c7964).
- The Python reference's first run had one draw in it twice. Caught by its
  own duplicate check before commit.
- The docs said to keep reading blocks forever, but the code stops at 1024.
  Caught in review. The docs now say so.

Not done yet: the server side (seed storage, nonce, rotation, the unique
index), the per-round copy of RTP and ladder, and the verify page. These
need the engine and the server first.

## 2026-11-20: auto-play, sound, review fixes and graphics (web)

Built, in `apps/web`:

- Auto-play: rounds, pumps per balloon, stop at profit, stop at loss. The
  loss check looks ahead, so a round starts only if losing all its bets
  stays within the limit. No Patches. Any failed action stops it. A
  per-market switch (`VITE_MARKET=gb`) turns it off and fails closed for
  unknown markets.
- Sound made with Web Audio, no files. Pitch climbs toward the top; a pop
  is short and quiet; mute is saved.
- The balloon art from `graphics/balloon` (floor pump, hose, multiplier on
  the balloon, burst on pop, float-away on cash-out), the app icons and a
  manifest, session net and time in the top bar, a Total bet readout, and
  an Animations on/off setting.

Turned out wrong, and how it was caught:

- A multi-agent review (four angles, each finding re-checked by a skeptic)
  confirmed 12 bugs. The worst: a pump's answer, held for its 300 ms press
  beat, could land after a newer cash-out answer and undo it on screen,
  with a wrong balance and a locked screen. Reproduced in a test before the
  fix; answers are now ranked by draws used plus balloons ended. Also:
  Space on a focused Stop, Sound or Cash out button pumped instead; sound
  never unlocked on iPhone taps; `VITE_MARKET=GB` turned auto-play back on;
  two demo starts at the same moment could both charge.
- The user asked that only signs the gambling industry actually uses ship.
  Each graphic was checked against live games and UK and Ontario rules,
  with a skeptic re-checking every claim. No product was found using the
  strain cues, the top seal, the odds dot grid, the ghost outline and scrap
  after a pop, the cash-out tick, or the Patch tape sticker, so they are
  off. The Patch shows in words instead.
- That check also caught a rule break in my sound: a balloon cashed at a
  profit played a win chime even when its 2-3 balloon round lost overall,
  which UK RTS 14F bans. Wins are now judged over the whole round, for
  both effects and sound, with a test for that exact case.
- My own fix for a demo race first paired a revealed seed with the wrong
  hash when two rotations raced. Caught by thinking through the await gap
  before committing; the check now sits right before the change.

## 2026-11-20: game math and engine rules

Built:

- `game-spec.json`: the math spec. The ladders, the one rule every chance
  follows from, Patch pricing, rounding, the cap, what the proof and the
  simulator must show, and test vectors. (f59b856)
- `packages/engine/src/math.ts`: pump chances in lowest terms, the cash-out
  value, the Patch price in BigInt, the top rung under the cap, and the
  start-up checks from `CLAUDE.md`. Same function names as the web app's
  `placeholderMath.ts`. (28d9a59)
- `packages/engine/src/PumpEngine.ts`: start a round, pump with or without
  a Patch, cash out, the top rung, abandoned rounds, a quote for the screen
  and a replay for the verify page. One draw per pump. A refused request
  makes no draw. The engine never moves money; it returns the cents.
  (b3d3cf0)
- Tests that do their own arithmetic, at 9400, 9700 and 9900. Every
  cash-out point returns exactly the RTP before rounding. Whole strategies
  are played through the engine down every path and weighed with exact
  fractions: none returns more than the RTP, the shortfall is under one
  cent per rounded amount, and whole-dollar play without Patches returns
  exactly the RTP.
- A plain-English document explaining all the math (outside the repo),
  read by three reviewers, one of whom recomputed every number in it.

Turned out wrong, and how it was caught:

- The first spec let a player buy a Patch first and pump later, with a
  refund if they cashed out instead. `CLAUDE.md` locks Patch + pump as one
  step. Caught by the review chat reading the spec against `CLAUDE.md`. The
  armed state was removed before any code used it.
- The first checking script worked out the worst rounding cases and never
  printed them. Caught by the same review. They are now pinned in a test
  and listed in the spec: 90.99% for a 13-cent Easy cash-out, 50.05% for a
  Patch on an 11-cent Easy bet.
- Rounding was changed to a random draw in the math chat on the user's
  word, while another chat held the opposite answer from the user. The
  math and the engine were first written with random rounding, then
  switched back to floor and ceil the same day, before any commit. Caught
  by the builder chat, which set the two answers side by side and asked
  the user once. Lesson: a design question goes to the user in one chat
  only, and the answer is passed on.
- The math document said changing the RTP changes one thing. It changes
  two: the first pump's pop chance and every Patch price. Its diagram also
  suggested a Patch is only spent when it saves the balloon. Caught by the
  reviewers who read the document against `CLAUDE.md`.
- One engine test used a roll outside its range (19 on a draw whose rolls
  run 0 to 18). Caught on its first run by the engine's own range check.

Not done yet: `npm run rtp` and `npm run sim` are still stubs, so the scan
of every legal bet and the 10-million-round runs have not been done with
the game's own code. The engine was committed before anyone who did not
write it had reviewed it; that review has been asked for. A gentler set of
ladders is still being worked out; the ladders in `config.ts` are
unchanged.

## 2026-11-20: the screen uses the engine's math

- The bet panel's preview and the demo game now import the math from
  `@pump/engine`, and `apps/web/src/demo/placeholderMath.ts` is deleted
  (3338cb2). The demo still draws with the browser's random source, not
  the seeds, until the server is connected.
- Nothing turned out wrong: the stand-in had matched every test vector in
  `game-spec.json`, and all tests passed unchanged after the swap. The
  one-screen layout was re-checked at its worst cases (3 balloons on the
  Auto tab at 320x568 and 360x640): no scrolling.

## 2026-11-20: the RTP check and the simulator

Built:

- `npm run rtp` (aa1eb14): for each ladder, every cash-out point returns
  exactly the RTP before rounding; every legal bet on every rung is paid
  bet x multiplier rounded down and charged the exact Patch price rounded
  up, so nothing returns more than the RTP; and the best possible way of
  playing, worked backwards from the top rung, never beats it. It prints
  every rung and the worst that cent rounding does.
- `npm run sim` (32b258c): 10 million rounds per difficulty through the
  real `startRound`, `pump` and `cashOut`. The measured RTP is judged
  against the exact RTP of the way the simulator plays, cent rounding
  included, and each pump's survival count against its exact chance.
- Both pass at 9400, 9700 and 9900. At 9700 the simulator measured 96.883%
  (Easy), 96.915% (Medium), 96.924% (Hard) and 97.077% (Expert), each
  within 1.1 standard errors of its exact figure. The 9400 and 9900 runs
  were made on a copy with `RTP_BP` changed, so the shared config file was
  not touched.

Turned out wrong, and how it was caught:

- `npm run sim -- --rounds=200000` ran the full 10 million rounds: the
  root script did not pass options on to the engine's script. Caught from
  the first line of output, which prints the round count. The root script
  now ends in `--`.
- The first output cut percentages off instead of rounding them, so it
  printed 91.50% where the spec and the tests say 91.51%. Caught by
  comparing the first run with `game-spec.json`. It now rounds to the
  nearest, in whole numbers.
- One test in the first draft had a title that promised more than its body
  checked. Caught on re-reading before it was run, and rewritten.
- The simulator used a top-level `await`, which failed when the files were
  run from a folder without `"type": "module"`. Caught by the 9400 run on
  the copy. It now uses an ordinary `main()`.
- The full run took 144 seconds in one process. Each difficulty now runs in
  its own process, and a single-process run gives the same numbers.

Not done yet: nobody who did not write these two commands has reviewed
them. Timings above were taken while other work was loading the machine.

## 2026-11-20: server, wallet, game routes and hammer

Built, all in `apps/server` and `packages/contract`:

- The database layer on Node's built-in SQLite: one schema with the money
  rules written as constraints and triggers. The ledger is append-only and
  chained by a running balance; a balance can only be set to what the last
  ledger row says; one grant per player; one bet and at most one payout or
  refund per balloon; one active round and one active seed per player; a
  nonce that only goes up; finished balloons and rounds that never change.
- Wallet, players (anonymous, httpOnly cookie, only a hash stored), seeds
  (hash shown, seed revealed on rotation) and idempotency: the key lookup,
  the change and the stored answer are one immediate transaction.
- The game routes on top of the engine: start a round, pump with or without
  a Patch, cash out, restore after refresh, the 24-hour abandoned-round rule
  (lazily and by a sweep), and the data a finished round needs to be
  replayed. Every balloon action is stored in order with its draw.
- `reconcile()`: checks the wallet and the rounds against each other from
  the stored data alone.
- `npm run hammer`: starts a real server, fires about 4,000 overlapping
  requests, then reconciles.
- `@pump/contract`: the request and response types, moved out of the web
  app so both sides import the same ones.

Turned out wrong, and how it was caught:

- The first reconcile only checked the wallet. Once rounds existed it would
  have passed a database where a balloon was marked paid with no ledger row.
  Caught while writing the hammer and asking what it actually proves. Round
  checks were added, with tests that corrupt the data and expect a report.
- The hammer's first version would have called a refused Patch (402, not
  enough balance) a failure. Caught by reading its rules against the API's
  status codes before any player ran low. 402 is now a fair way to lose a
  race.
- To be sure the hammer can fail, the expected-draw-index check was removed
  from a copy of the game service on purpose. The hammer then reported "2 of
  2 same-moment requests succeeded" in every group, while the ledger still
  reconciled: money was safe, the rule was not. The file was restored with
  `git checkout`.
- Another chat had a change staged in the shared working tree. A bare
  `git commit` would have swept it into this session's commit. Caught by
  reading `git status` first; every commit here names its files.
- The test fixtures first used a non-null `!` and a hand-built object to get
  a second server instance. Replaced with a guard and a `Seat.on(app)`
  helper before commit.

Not done yet: the web app still plays against its demo client; the verify
page; serving the web build from the server; deployment. Findings from the
independent review of this code are still to come.

## 2026-11-20: ladder redesign, proposed and not applied

- The user asked whether the ladders were tuned for enjoyment. They were
  not. Easy popped 9% to 17% of the time on every pump after the first, no
  ladder had round rungs such as 2x, 5x or 10x, and a $1,000 bet stopped at
  $62,000 on Hard and $47,500 on Expert.
- Four ladder sets were designed from different angles, each re-checked
  from scratch with exact whole-number math, scored by three judges, and
  merged into one proposal (multipliers in hundredths):

  ```
  easy    101 109 118 128 139 151 165 181 200 222 247 275 307 345 389 440
          500 571 655 753 867 1000 1155 1340 1560 1820 2130 2500 2950 3500
          4175 5000
  medium  104 117 132 150 172 200 235 279 335 407 500 621 781 1000 1310
          1770 2500 3725 5900 10000
  hard    120 154 200 264 357 500 730 1115 1785 3005 5330 10000 20000 43000
          100000
  expert  160 277 500 946 1900 4130 10000 28200 100000 500000
  ```

- Against today's ladders at 97%: a balloon that is never cashed out lasts
  9.9 pumps on Easy, not 8.2, and 6.3 on Medium, not 4.8. Easy has rungs at
  2x, 5x, 10x, 25x and 50x. A $1,000 bet reaches exactly $100,000 on
  Medium, Hard and Expert.
- What it costs: the pop chance keeps rising only from an RTP of 93.59%
  (today 91.91%), so 94% still starts but 93% would not. Medium's top prize
  drops from 150x to 100x and Easy's rises from 25x to 50x. Some in-between
  bets end further below the cap than today.
- Status: it passes the exact ladder checks at 9400, 9700 and 9900. The
  last step, three reviewers trying to break it, was stopped when every
  chat was asked to wrap up. `config.ts` is unchanged. Applying it is a
  config-only change (the four arrays, plus the tests and spec values that
  quote the old ones) and needs the user's yes.

## 2026-11-20: verify page, and the demo on real seeds (web)

Built:

- The demo game now plays through the engine's own startRound, pump and
  cashOut, and draws every pump from the seeds with @pump/engine/fair, as
  the server will. It records each balloon's actions and draws (a672904).
- The web contract gained the round record the verify page reads, agreed
  with the server chat: GET /api/rounds/:roundId/verify -> VerifiableRound,
  409 seed_not_revealed before rotation, seedRevealed on history rows.
- The verify page (#verify): pick a revealed round, see its inputs, the
  verdict, the seed-hash check and every draw, and edit inputs to watch the
  check fail. It is on branch `verify-page` (c165458), not main, because it
  imports verifyRound from the provably fair chat's
  packages/engine/src/fair/verify.ts, which is not committed yet. Merge the
  branch once it lands, mapping onto its final shapes.

Turned out wrong, and how it was caught:

- I first wrote my own round checker. Then I found the provably fair chat
  writing verifyRound in the engine for the same page. I deleted mine
  (never committed) and pointed the page at theirs, so there is one checker.
- My checker's "tries for rung" label was filled in before the rung was
  tracked, so every pump showed rung 1. Caught by the docs/fairness.md
  Patch-save example used as a test.
- At 360px the verify page's cards grew to the width of the draw table, so
  the page scrolled sideways inside its box. Caught by a width check in the
  browser; the cards now shrink and only the table scrolls.
- The background code review of the page was stopped before it finished,
  so the branch has not been independently reviewed yet.

## 2026-11-20: round checker

Built:

- `verifyRound` in `packages/engine/src/fair/verify.ts` (746db0a). From a
  finished round and its revealed seed, it checks the seed hash, recomputes
  every pump's roll, and replays each balloon with the engine's own
  `replayBalloon`, using the RTP and ladder stored with the round. It then
  lists every difference from what the server claims, as plain sentences.
  It never throws for a dishonest record. The verify page calls it, so
  there is one checker, not two.
- `test/fair/verify.test.ts`: each kind of server cheating is caught, one
  change at a time. Examples: a changed roll, num or den, an extra cent, a
  missing draw, a raised top rung, a swapped RTP, a refund with actions.
- `test/fair/engine.test.ts` (1fd415c): 2,400 rounds with real seeds at
  RTP 9400, 9700 and 9900 on every difficulty, played through the live
  engine with `drawerFor`. The checker agrees with every one.

Turned out wrong, and how it was caught:

- The web chat had started its own round checker as well. Caught by the
  builder agent finding `apps/web/src/verify/checkRound.ts`. Settled by
  message: the web chat uses `verifyRound` and deleted its copy.

Unfinished (the review was stopped early so every chat could wrap up):

- Confirmed by a second agent, not fixed:
  - The checker doesn't check the bet range or the 3-balloon limit.
  - Its sentences say "pump N" for the Nth press, where the docs use
    "pump k" for the pump that reaches rung k.
  - It builds the round's start by hand instead of through `startRound`.
- Reported, not yet checked: the payout cap is taken from the record
  without a check.
- Not done: the integration review in a browser bundle, the mutation test
  of `verify.ts`, and showing the message of the block that actually gave
  the roll (promised to the web chat; it can rebuild it with
  `drawMessage`).
- The server doesn't yet send `maxPayoutCents` or each balloon's draws in
  its verify answer. The web and server chats have agreed to add them.

## 2026-11-20: a Pump button per balloon, and Pump all (web)

Built, at the user's request after playing three balloons:

- Each balloon in play has its own Pump button under it. Pressing it picks
  that balloon, so the panel shows its Cash out and Patch, and pumps it.
  The button row keeps its height when empty, so balloons don't resize.
- Pump all, in the panel next to the picked balloon's name and on the A
  key: one ordinary pump per balloon still in play, each its own request
  with its own expected draw index.

Also in this session: waited for the other chats to wrap up, pushed main
to GitHub up to 3c850c5 (the brief asks for a public repo), and checked
the brief against the repo.

Turned out wrong, and how it was caught: nothing in the change. One process
point: four chats were editing this folder at once, and a local test run
in the middle showed 66 failures from half-finished edits. CI on the pushed
commit was green. Caught by running the suite before building.

## 2026-11-20: server fixes after an independent review

Ten reviewers (five attacking, five checking each claim) went through the
server. Nothing they found lets a player create or lose money through the
API. What they did find, and what was done:

- `INSERT OR REPLACE` deletes the row it replaces without firing "never
  delete" triggers, so plain SQL could swap a ledger row and double a
  balance. Caught by a reviewer who tried it. The schema now refuses a
  replace on every guarded table by itself, and the connection also turns
  `recursive_triggers` on.
- A refusal built its answer before its request was rolled back, so a stored
  "balance too low" could show a balance that no longer existed. Caught by
  reading the order of steps and confirmed with a two-charge request. The
  answer is now built after the rollback.
- Every request without a cookie created a player, so a page that loaded the
  session and the history together made two. Caught by sending the two
  requests at once. Only `GET /api/session` creates a player now; the rest
  answer 401 `no_session`.
- The history counted a refunded bet as money staked and lost. Caught by
  abandoning a round and reading its history line. Refunded bets are now
  shown apart.
- The database let a ledger row and its balloon disagree, a round use a
  nonce its seed never gave, and a balloon jump rungs. The schema was
  rewritten (no database existed yet) so each of these is refused, and
  writing a ledger row now moves the balance in the same statement.

Left for later, on purpose: the server picks the next server seed while it
already knows the player's client seed (a locked rule, so it is the lead's
decision); old idempotency keys are never removed; `reconcile()` does not
replay rounds from their seeds.

## 2026-11-20: engine tests after an independent review

An independent review checked the engine (math.ts and PumpEngine.ts) two
ways. A second engine written from the rules alone played 3.6 million
rounds beside the real one: every result matched. Then 19 small bugs were
planted in the engine one at a time. The tests did not notice any of the
19.

Turned out wrong: nothing in the engine, but the tests had holes. Each
planted bug was a rule with no test behind it. The ones that would have
cost money or a grader's trust:

- A Patch bought on the pump that reaches the top rung could have been
  given away free. The test bought that Patch and never looked at the
  charge.
- The Patch balance check and the quotes shown to the player could have
  used a hard-coded 97%. Those tests ran at 9700 only, against the rule
  that everything parametrised runs at 9400, 9700 and 9900.
- The boot check could have looked at the first difficulty only, or
  skipped the last pump of a ladder, a two-rung ladder, or a pump exactly
  as risky as the one before.
- A Patch price could have been worked out in ordinary numbers. The test
  meant to prove it is exact used a value nowhere near a cent edge, so it
  passed either way. It now also uses one that ordinary numbers get one
  cent too low.

How it was caught: by the review planting the bugs, not by me. Tests were
added for all 19, and the test helpers now freeze every round they hand to
the engine, so any change made in place throws. Then each of the 19 bugs
was planted again in a scratch copy: all 19 are now caught. No engine code
changed.

Raised by the review and not settled, because they are rule questions for
the lead: an RTP of 100.00% to 100.99% passes the boot check on Easy; a
roll outside its range throws a RangeError and not an EngineError; and
`replayBalloon` cannot express a refund.

## 2026-11-20: verify page merged (web)

- The provably fair chat committed verifyRound (746db0a) with the shapes
  the page was written against, so branch `verify-page` merged into main
  unchanged and without conflicts on top of the day's gameplay commits
  (58e53cb). The page is at #verify, from Settings or a history row.
- Checked after the merge: typecheck, lint and 82 web tests (40 demo rounds
  verified by verifyRound with the new gameplay); in the browser a round
  with a Patch and a cash-out verifies, and no game key works on the
  verify view.
- Still open: the page's independent review was stopped before it
  finished; CheckedDraw.message is the block-0 message, so the page
  rebuilds the message for the rare roll from block 1 or later.

## 2026-11-20: engine comments and one test, after the second engine review

A second review of the engine (five reviewers, each claim checked again by
a skeptic) found no wrong number and no return above the RTP: every chance,
6.6 million payouts, 18.6 million Patch prices and a best-strategy search,
at 9400, 9700 and 9900. The engine tests added earlier today (the entry
"engine tests after an independent review") are committed as 7e05f16.

Turned out wrong, all in comments and one test, all caught by that review:

- PumpEngine.ts is the file the brief names, and it held no formula, only a
  line pointing at math.ts. Its header now has the math in short, and the
  README says which file to read first.
- The comment on cash-out gave a reason the project spec had dropped, and
  the header said "one to three balloons" where the config sets the number.
- The test that pins the worst rounding cases made its percentage with an
  ordinary number. Easy's worst Patch is exactly 50.045%, which only came
  out as 50.05 by luck. It is now rounded in whole numbers.

No engine code changed. Still for the lead to decide, unchanged from the
entry above: whether to refuse an RTP of 100% or more at boot, and whether
`replayBalloon` should be able to express a refund (the server and the
verify page work round that today).

## 2026-11-20: the game refuses an RTP of 100% or more

The lead said yes to the rule, so the first open question above is closed.
The game will not start with RTP_BP at 10000 or more; 9999 is the highest
that runs. The lead chat built the rule (38595e6) and put it in CLAUDE.md
(8e6d821). The maths chat added a test for every ladder (efe3281), the line
in game-spec.json (35488f0) and the paragraph in the math document.

Turned out wrong, and how it was caught:

- Two chats started the same change in math.ts at the same moment: the
  lead's yes reached the maths chat while the lead chat was already
  building the rule. Caught by the maths chat reading the file a second
  time before editing and finding the rule already there. It stopped and
  took only the parts nobody had done.
- The rule's first test looked at Easy only. Seven small bugs were planted
  in the rule in a scratch copy, and three got past: the rule applied only
  to a ladder starting at 1.01x, only when no other RTP rule fired, or only
  up to the first multiplier. The added test catches all seven.
- The math document still said the game refuses an RTP of 101% or more, and
  gave the old reason for no cash-out before the first pump. Both fixed.

Still for the lead to decide: whether `replayBalloon` should be able to
express a refund, and whether to apply the proposed ladders.

## 2026-11-20: new ladders applied, and ladders made cheap to change

The lead said yes to the proposed ladders (the entry "ladder redesign,
proposed and not applied" has the numbers). They are in `config.ts` now
(23cc9b5): Easy 32 rungs to 50x, Medium 20 to 100x, Hard 15 to 1,000x,
Expert 10 to 5,000x. The whole suite and `npm run rtp` pass at 9400, 9700
and 9900.

Turned out wrong, and how it was caught:

- Changing four arrays turned 38 tests red, though nothing was wrong. The
  tests quoted numbers from the live ladders. Caught by trying the new
  ladders on a separate working copy first. The lead expects to tune the
  ladders many times, so those tests now use fixed ladders kept in
  `packages/engine/test/fixtures.ts` (5c6babf). A ladder change is now one
  edit in `config.ts` and one run of `npm run rtp`.
- `game-spec.json` held a second copy of the ladders and of numbers worked
  out from them. Caught the same way. The copies are gone (9ba5867).
- I started a three-reviewer check of the ladders, and the lead stopped it
  as too much for numbers that will change again. It was cancelled. The
  exact checks that did run are the ones above.

Known and not done: the math document on Claude Docs still shows the old
ladders in its examples and tables; it will be redone once the ladders
settle. The rule that the pop chance rises holds from an RTP of 93.59%
with these ladders (91.91% before), so 94% starts and 93% does not.

## 2026-11-20: the simulator measured the engine against itself

An independent review of `npm run rtp` and `npm run sim` found that every
line they print today is true, but that the simulator could not be trusted
to notice a wrong engine.

Turned out wrong, and how it was caught (all by the review, which planted
bugs in the engine and ran both programs):

- The simulator took each pump's "exact chance" and its expected RTP from
  the engine. So an engine drawing pump 1 five points under the RTP
  printed "92.581% simulated; 92.737% is the exact figure ... PASS" at a
  configured 97%. A doubled Patch price passed too. Every yardstick now
  comes from `cli/rules.ts`, which works the rules out from the
  configuration and never calls the engine (34c0b3f, 8d21551).
- One-cent mistakes in PumpEngine.ts passed both programs: payouts rounded
  up, payouts one cent short, a Patch one cent too cheap. The total hides
  them, and the RTP check never calls the play functions. The simulator
  now checks every draw's chance, every outcome, every payout, every Patch
  charge and every top rung against the rules, with no luck involved.
- The top of each ladder was hardly played, and a bet stopped by the cap
  never was. A second, smaller run now takes every balloon to its top
  rung, with the largest bet included.
- Two lines of the RTP check, "No cash-out returns more than the RTP" and
  the same for Patches, could not fail by themselves. They now work out
  the real return from the engine's own chances (12b19fa). A cap test
  written with "<" was caught by nothing; it is now.

How the fix was checked: the review's bugs were planted again in a scratch
copy, seven of them. The simulator says FAIL for all seven, and the RTP
check for the four that sit in math.ts (it does not call the play
functions, so the other three are the simulator's to catch). Both say PASS
for the real engine at 9400, 9700 and 9900. The tests now hand the
simulator engines that are wrong on purpose.

Left as it is: the volatility printed for Expert moves from run to run,
because rare huge wins decide it. The line now says so.

## 2026-11-20: the game screen plays against the real server

Built:

- The server hands out the built screen, so one address serves the game
  and its API (`npm start`). `npm run dev` runs server and screen together
  for working on the game.
- `apps/web/src/api/httpClient.ts`: the screen's real client. The demo is
  no longer part of the app. The API types moved to `packages/contract`,
  shared by both halves.
- The verify answer now carries each pump's draw and the payout cap the
  round was played under (`rounds.max_payout_cents`), which the verify page
  needs to check a round stopped by the cap.
- `apps/server/test/screenClient.test.ts` runs the very file the browser
  runs against the real routes. `apps/server/test/verifyRounds.test.ts`
  plays rounds that end in every way a round can end, at 9400, 9700 and
  9900, and checks each with `verifyRound`.

Turned out wrong, and how it was caught:

- Three readers compared the screen (built against the demo) with the
  server. The worst find: with the cookie gone, the client opened a new
  session and sent the request again as that new player, while the screen
  still showed the old balance and round. Bet then answered "Set a client
  seed" for ever. The client now passes the refusal on and the player is
  told to reload (2d96a94).
- In development React runs the first load twice, which made two players
  on every first visit. A session load already on its way is now shared.
- Playing in a real browser showed the settings sheet's buttons running
  off the right edge once the history had a real row in it. One wide table
  row widened the whole column (2c64a59). The demo history had the same
  row, so this was there before; nobody had opened the sheet after a round
  at that width.
- A build left in `dist` shows the RTP it was built with. Under
  `npm run dev` the server handed that build out on port 3000 while
  playing rounds at the new RTP. The dev server is now API-only (d137ef6).

Checked in a real browser against the real server: bet, pump, Patch +
pump, cash-out, a refresh mid-round, a second tab acting on an
out-of-date screen (409, no double pay), seed rotation, and the verify
page on the finished round. No answer held a result before its pump.

Left open, all in the screen, for its chat to fix: a round closed by
the 24-hour rule shows a refunded bet as lost; "next round uses nonce N"
does not move after a round; the screen does not start over by itself
after a lost session; before a bet the screen shows the RTP and ladders
from its own build, not from the server.

Note for later: migration 1 was edited in place to add the cap column.
That was safe only because no database existed anywhere. Once a live
site has a database, schema changes must be new migration steps.

## 2026-11-20: hostile review of the ladders and the Patch: designs, nothing applied

A hostile review sent four points. Its numbers were checked and are right.
Designs were worked out for the lead to say yes or no to; `config.ts` and
the locked rules are unchanged.

- Easy's first rung is 1.01x, and Easy's pop chance hardly builds (7.3% to
  16.5%). Design "Easy B", checked with the whole engine suite and `npm run
  rtp` at 9400, 9700 and 9900 on a scratch copy:

  ```
  102 112 123 137 154 175 200 230 266 309 361 424 500 591 701 835 1000
  1210 1492 1894 2500 3452 5000
  ```

  23 rungs (today 32), pump 1 pops 4.9% (4.0%), later pumps 8.9% to 31.0%,
  rungs at 2x, 5x, 10x, 25x and 50x, starts from an RTP of 92.90% (Easy
  today: 93.59%). A balloon never cashed out climbs 7.6 rungs (9.9).
- What limits the design: every later pump must pop more often than pump 1
  does at the lowest RTP the game must start at. So a higher first rung
  forces a steeper ladder; at 1.05x Easy would be Medium. And with
  multipliers in hundredths, a gentle start can only rise in tiny steps.
- A Patch costs (1 - pop chance) / RTP of what the step can win, on any
  ladder. On today's Easy at a $1 bet the price is the whole gain on pumps
  2 to 8. Proposed: do not sell a Patch that costs at least what its step
  can win.
- Patch spend has no limit: the largest single Patch is $25,773.20 (Hard,
  $500 bet, pump 13). Options given to the lead: no limit; no Patch priced
  above the largest bet ($1,000); no Patch priced above the balloon's own
  bet; no Patch priced above ten times the bet. The RTP is the same under
  all of them, because every Patch returns the RTP by itself.

Turned out wrong while designing: two searches for an evenly rising Easy
ladder found nothing. The cause was the constraint, not the search: five
round rungs, whole hundredths and a strictly rising pop chance leave very
few ladders. Caught by counting how long Easy can be for each first rung.
## 2026-11-20: fixes from the hostile critique (round panel, Patch, wording)

A team of hostile critics (veteran player, design lead, regulator, art
director, cheat) reviewed the game. Their chat handed each fix to the chat
holding those files; this entry covers the ones given to the "Hostile agent
game fix" chat, built on branch `critique-fixes`.

Built:

- Round panel with 2-3 balloons: Total bet showed only the picked
  balloon's stake ($1.00 shown, $3.00 riding). It now adds up every
  balloon's bet and Patches. Cash out and Patch + Pump carry the picked
  balloon's colour dot, the same dot the bet panel uses, so the panel says
  which balloon they act on. Cash out all sits beside Pump all, and the big
  button says Pump once only one balloon is left. Which buttons exist is
  fixed for the whole round, so nothing moves under a finger when a balloon
  ends; only labels change.
- The keyboard Patch now takes Shift+P. A single stray P bought a Patch,
  and on Expert at the top bet after pump 1 that costs $696.72.
- The working Patch + Pump button had a dashed edge and stripes, which read
  as "locked". It now has a solid edge and a filled panel; the tape icon
  still marks it.
- Game info says Patches are paid on top of the bet, so the bet limits do
  not cap them, and that late Patches can cost many times the bet.
- `npm run rtp` said cent rounding "only shows on tiny bets". Patch prices
  round up too, and an early Patch can cost a few cents at a $1 bet, so the
  note now says rounding costs most on small amounts: tiny bets and cheap
  Patches at any bet.

Turned out wrong, and how it was caught:

- The entry "auto-play, sound, review fixes and graphics (web)" above says
  the strain cues, the top seal and the Patch tape sticker are off. Commit 9148fb2,
  46 minutes after that entry, turned those three back on, and the game
  shows them. The ghost outline, the scrap after a pop and the cash-out
  tick are still off (balloon-app.css). The art director critic caught the
  mismatch; it was checked against BalloonCard.tsx and git blame.

How it was checked: screen tests, lint and typecheck pass. The round panel
was drawn from the real component and styles at desktop width and about
260 px wide (a 320 px phone gives it 304 px), with one balloon, three
balloons, and three balloons with one left. The full game was not played in a browser:
other chats were already running the most preview servers this folder
allows.
## 2026-11-20: pumps on the floor, bigger pictures on phones (branch `one-screen-layout`)

Two fixes to the game screen after a hostile review, both CSS, both in the
stage and background rules only. Built on the branch `one-screen-layout`
and moved into main after the user approved them.

- The pumps stand on the floor line again. The floor's height counted the
  two lines of numbers under a balloon but not the Pump button row that was
  added under them later, so the pumps stood among the hills and the horizon
  ran under the money line. The row's height is now one shared value
  (`--action-h`) that the row and the floor both use.
- Balloon pictures are bigger where the slot is narrow. A picture was capped
  at its slot's width. The art keeps empty room at its sides for a balloon
  at full size, so a picture may now be one and a half slots wide. At
  375x812 with three balloons a picture went from 117x187 to 175x281 px, and
  the empty sky above it from 260 px (32% of the screen) to 166 px (20%).
  Pictures take no clicks, so a tap still picks the slot under the finger.

Checked on the real server, at 19 sizes from 1920x1080 to 320x568 and
sideways, in four states with three balloons (a live round, a finished
round, the bet screen with every bet capped, the Auto tab). At every size
the pump's base is 4 to 14 px below the horizon, no art passes the screen
edge and no text is cut. Also checked: all three balloons forced to full
size (they just touch), two popped balloons beside a live one (the limp
hoses don't cross a neighbour's pump), and taps on the strips where a
neighbour's empty picture corner lies over a slot (the right slot is
picked each time).

Turned out wrong, and how it was caught:

- The floor line was tied to one row's height by hand. When another chat
  added a second row, nothing made the floor follow. Caught by the hostile
  review's screenshots. The size check from the earlier session could not
  have caught it: it looked for scrolling and cut text, not for where the
  pump stands. It now measures the gap between the pump's base and the
  horizon.
- Main was moving every few minutes, and another chat merged this branch
  into main while it was being merged here. One of the merges kept another
  chat's worklog entry twice: the two sides had it in different places, so
  git saw no clash, and main carried the double entry for about three
  minutes. Caught by reading line by line what main gained from the move,
  which should have been one sentence. The copies were identical; one was
  removed in a commit of its own. Before moving main, the worklog is now
  checked for repeated headings.

Found and left alone, because they are not these two fixes:

- Since 6c28a85 upright phones may scroll. Measured on this branch: the bet
  screen with three balloons scrolls at 375x667 (the page is 689 px tall)
  and at 320x568 (610 px), and the Auto tab with three capped bets scrolls
  on every phone up to 390x844. That goes against the no-scroll rule this
  layout was built on. It needs the user's call, so it was not changed.
- An upright tablet (768x1024) still gets the side-by-side layout, so half
  its stage is empty sky. Moving the upright breakpoint up would fix it, but
  that rule now also carries the scrolling above.
- The 20% of sky left on a phone can only be used by taller art (a longer
  hose, say). That belongs to the graphics.

## 2026-11-20: Easy stays as it is

The lead looked at "Easy B" next to today's Easy and chose to keep today's
ladder (32 rungs, first rung 1.01x). Easy B stays on record in the entry
"hostile review of the ladders and the Patch" and was not applied. Still
open, and the lead's call: whether to limit Patch prices, and whether to
stop selling a Patch that costs at least what its step can win.

## 2026-11-20: Patch prices stay without a limit

The lead chose no limit on Patch prices (first clicked the $1,000 cap, then
corrected it to no limit). The Patch rule in CLAUDE.md is unchanged, and so
is the engine. The idea of not selling a Patch that costs at least what its
step can win was offered twice and not taken up, so it is not being done.
What the review found stays true and is shown in the open: the largest
single Patch is $25,773.20 (Hard, $500 bet, pump 13), and the price is on
the button before the player buys.

## 2026-11-20: hostile critique of the gameplay and graphics, and two merges

From the "hostile agents critique" chat.

What was done:
- Five critic agents reviewed the live game and its code: a veteran
  player, the studio's design lead, a gambling regulator, an exploit
  hunter and an art director. Each had to point to a file, a screenshot
  or a number it worked out. Scores: feel 4/10, design 5/10, player
  protection 4/10, graphics 4/10, the server on its own 9/10.
- Every claim passed on was checked against the code first. At the
  user's word the fixes went to the chats that hold the files: "Agents
  finishing" (balloon looks, strain, hold and cash-out, bet panel,
  auto-play hint, verify hash), "Hostile agent game fix" (round panel,
  Shift+P, Patch button, Game info text, RTP-check note), "Maths game
  design" (Easy ladder and Patch limit, design only), "Game background
  design" (floor and phone stage) and "Game graphics list" (pump art).
- Merged critique-fixes (f236442) and one-screen-layout (7a2d764) on the
  user's "Merge both". In a clean copy of the merged main, 1072 tests,
  lint, typecheck and build passed, and a 3-balloon round against the
  real server showed the real total bet, Cash out all paying $3.03 for
  three 1.01x balloons, and the pumps standing on the floor.

Turned out wrong, and how it was caught:
- The two worst findings (the game ran only in the browser; the server's
  verify answer failed the verify page) were already fixed by the time
  the critics reported (320634a, e05258a): another chat changed the same
  code during the review. Caught by re-running the exploit critic's own
  probe on current main, where it passed.
- I first told "Takehome originals pump" that the uncommitted
  balloon.css, risk.ts and useGame.ts edits were its own. They belonged
  to "Agents finishing". Caught when "Hostile agent game fix" asked every
  chat what it held; a correction went out before anyone started.
- The critique leaned on the rule "No 'would have popped' reveal". It is
  not in the brief or CLAUDE.md, only in graphics/README.md (untracked,
  written by the graphics chat), and it contradicts the reveal being
  built on branch cashout-reveal. The Patch-save item that rested on it
  is on hold until the user decides.
- A UK rule (at least 5 s between rounds) was cited. The user ruled UK
  rules out of scope, so it is not being built.

## 2026-11-20: upright phones fit on one screen again, no scrolling

The user's call: "Make it fit". Commit 6c28a85 had let upright phones
scroll the page when the bet panel did not fit. That went against the
no-scroll rule the screen was built on. One CSS change, in the upright
phone rule of `styles.css`:

- The page is one fixed, clipped screen again on upright phones, as at
  every other size.
- When no balloon has a Pump button (before a round, after it, and while
  auto-play runs) the button row under the balloons is closed and the
  pictures get its height. It was an empty strip exactly when the bet
  panel is tallest. During a round the row never comes and goes: it is
  there as long as one balloon is in play.
- The stage keeps at least its two lines of numbers and a small picture.
  Only if even that does not fit does the panel scroll inside itself.

Checked on the real server with the size check, which also tries to scroll
the page by code. 22 sizes, from 1920x1080 down to 320x568, plus 628x832
and phones sideways. Seven states with three balloons: a live round, a
finished round, the bet screen with every bet capped, the Auto tab,
auto-play running, auto-play done. At 21 sizes nothing scrolls, nothing is
off screen, no text is cut and the pumps stand on the floor. The one left
is the known 568x320 (a very small phone sideways), where the panel still
scrolls inside itself.

What it costs: before a round the balloon pictures are small when the
panel is tall. With three balloons at 375x667 they are 158 px tall on the
bet screen and 62 px on the Auto tab; at 320x568, 146 px and 62 px. In a
round they are as big as before (281 px and 237 px).

Why the earlier fit broke, so it does not happen again: the first version
of this layout was measured to fit, then a Pump button row was added under
each balloon. That made the stage 54 px taller at its smallest, with
nothing checking small phones afterwards. Any change that adds height to
the stage or the panel needs the size check run on small upright phones.

Left open: an upright tablet (768x1024) still gets the side-by-side
layout, so half its stage is empty sky.

## 2026-11-20: merging main into `cashout-reveal`

Main had connected the screen to the real server while this branch added
the after-round reveal. Main's contract, web contract and verify fields won;
the branch kept only its reveal additions.

Turned out wrong, and how it was caught:

- Both sides stored the payout cap per round: main in the first migration
  (`rounds.max_payout_cents NOT NULL`), the branch again in its migration 2.
  Git merged both without a conflict, so the merged schema added the column
  twice. Caught by reading `migrations.ts` after the merge. Migration 2 now
  holds only the reveals.
- The branch used "no stored cap" to spot rounds that ended before reveals
  were stored. Under main every round has a cap, so that test no longer
  meant anything. Replaced by `rounds.reveals_recorded`: 0 for rounds
  already in the database when migration 2 runs (set by the column default,
  no UPDATE), 1 for every round started after (a trigger refuses anything
  else, and another keeps it fixed). The verify answer works out a missing
  reveal from the public seed only for rounds marked 0, and reconcile
  forgives a missing reveal only for those.
- On upright phones main closes the row under the balloons when no balloon
  has a Pump button. That is exactly when the reveal line is shown, so the
  line would have been hidden. Caught by reading main's new phone rule next
  to the branch's `.slot-after`. A finished round with a reveal line now
  keeps the row open (`.stage-after-round`). Checked at 375x812 and 320x568
  with three balloons: the lines fit at the 9 px floor on two lines, nothing
  scrolls. The cost: on the bet screen after such a round the pictures are
  46 to 54 px smaller than main had them.

Checked: typecheck, lint, all tests, the hammer against a server started by
hand, and an upgrade: a database made by main's own code (hammer rounds plus
a round left in play) opened by the merged server. The open round finished
with its reveals stored, all 55 old rounds pass `verifyRound`, and reconcile
is clean.
## 2026-11-20: upright tablets get the stacked layout

The user's call: "Yes, fix tablets". One CSS change in `styles.css`.

- Every screen that is taller than it is wide now has the stage on top at
  full width and the panel underneath. Before, only screens up to 760 px
  wide did; an upright tablet got the side panel, which left the stage a
  narrow strip with half of it empty sky. On a tablet the panel keeps a
  phone's width (560 px) in the middle, so its buttons don't stretch.
- The two outer balloon pictures get side room that grows with the screen.

At 768x1024 with three balloons a picture went from 203x325 px to 287x459
on the bet screen and 359x574 in a round.

Checked on the real server with the size check: 36 sizes (the earlier ones
plus 761x1000, 810x1080, 820x1180, 834x1194, 900x1200, 1024x1366 and four
large upright windows), five states with three balloons (a live round, a
finished round, the bet screen with every bet capped, the Auto tab,
auto-play running). 35 sizes: nothing scrolls, nothing is off screen, no
text is cut, the pumps stand on the floor. The one left is still 568x320.

Turned out wrong, and how it was caught:

- With the stage at a tablet's full width, the right-hand pump's shadow was
  cut by about 6 px at the screen's edge. A picture may be one and a half
  slots wide, so what is drawn reaches past its slot by an amount that
  grows with the picture, while the room at the screen's edge was a fixed
  8 px. On phones it had fitted by 1 to 2 px, by luck. Caught by the size
  check's rule that no art may pass the screen edge. The check now uses
  where the drawing really ends (14% and 87% across the picture), and the
  side room is 2.8% of the stage's width.
- That side room first shrank the pictures on a wide desktop by 8%, where
  the balloons already have wide empty margins. Caught by comparing picture
  sizes before and after in the same check (762 px became 704 px at
  1920x1080). The margins now count as that room.
- The first cut-off, "upright and at most 1100 px wide", left a window of
  1101x1400 with the old half-empty layout. Caught by testing one pixel
  past the limit. The rule is now just "upright".

Not changed: a very large upright screen (1440x2560) shows the balloons at
their largest size (762 px) with sky above them. The balloons stop growing
at 960 px of stage width on every screen.

## 2026-11-20: the stats page (branch `stats-page`)

Built the brief's optional stats page: profit over time, best win, rounds
by difficulty. It opens from settings ("Your results" → Stats) at `#stats`.

- Server: `GET /api/stats` (contract type `PlayerStats`). A repository
  query sums each finished round; `services/stats.ts` adds them up in a
  pure `summarize` function. No game rule lives there: it only counts money
  the game already settled.
- What counts: bets played, Patches bought, payouts. A bet handed back by
  the 24-hour rule is void and left out, the same as in the RTP figures; a
  round whose bets were all handed back is not counted as a round.
- Best win is the round with the biggest gain (payout minus bets and
  Patches). A round that only got its money back, or less, is never called
  a win. On a tie the earlier round keeps it. It shows its top multiplier
  and opens on the verify page once its seed is revealed.
- The profit line keeps every round up to 300. Past that it keeps the
  lowest, highest and last point of each of 100 groups, so the overall peak
  and dip and the latest round are always on the chart.
- Screen: four headline numbers, one line chart (pointer or arrow keys show
  the net after any round), the best win, a table by difficulty. Mint only
  for a real gain. Like the verify page it scrolls inside its own box; the
  game screen still never scrolls.

Checked: 25 server tests, including 40 rounds of real play at RTP 9400,
9700 and 9900 where the stats' net equals the wallet's change and the
wagered and paid-out totals equal the ledger's, and the real 24-hour rule
at all three RTPs: a round refunded unplayed shows as nothing at all, and
after a pump only the pumped balloon counts. In the browser, 150 rounds
played on a local server: net +$25.74 on the page and in the wallet, the
best win's Verify button opened that round and it checked out, no console
errors, no sideways scroll at 375x812 or 320x568.

Turned out wrong, and how it was caught:

- The first bars in the difficulty table were measured against the wrong
  width, so a bar for half the rounds was not half as long. Caught on
  re-reading the CSS before the first run; each bar now sits in its own
  track.
- The headline numbers cut a long amount short with "…" on a 320 px phone.
  Caught by putting a seven-figure amount into the tiles at that size. They
  now shrink and wrap only after a thousands comma.
- One test check ("some round has the top gain") could never fail. Caught
  on reading the test back; it now names the exact round.
- A new 24-hour test first expected "no best win" for a round where one
  balloon cashed out at 1.04x and the other bet was refunded. That was the
  test's mistake: $10.40 back on the $10 really played is a real win; only
  counting the refunded $5 as stake would make it a loss. Caught when the
  test failed against the code; the test now expects the win.
- The browser tool's hover and click did not move the chart's readout,
  which looked like a bug. Real pointer and key events did move it; the
  tool moves the pointer off the chart right after a click.
## 2026-11-20: the Pump row stays through a round

Found while running the size check on the merge coordinator's batch before
it was committed (its files were copied into this branch's working folder;
main was only read).

- The batch hides a balloon's own Pump button when only one balloon is
  still in play. The layout's rule for upright screens closed the button
  row whenever no balloon had such a button. Together: in a round of two
  or three, when the second-last balloon ended, the row closed and the
  floor, the pumps and the last live balloon dropped 54 px mid-round.
  Measured at 375x812: the horizon moved from 491 to 545 px.
- The rule now says when the row is not needed at all: no balloon in play
  (before a round, after it), a round of one balloon, or auto-play running.
  In a round of two or three played by hand the row stays to the end.

Checked with the batch and the fix together: 36 sizes, eight states with
the new one "round of three down to its last balloon". At every size the
picture and the horizon are the same with three balloons in play as with
one left. The row was also watched at 375x812 through a one-balloon round
(closed all the way), a three-balloon round (open all the way) and six
looks during auto-play across rounds and the gaps between them (closed all
the way). 35 sizes pass every state; the one left is still 568x320.

Turned out wrong, and how it was caught:

- The size check passed the batch at first, because it had no state for a
  round that is down to its last balloon. The clash was caught by reading
  the batch's rule for the button (`showOwnPump`) next to the layout's
  rule, then measuring. The check now has that state, and compares the
  stage with three balloons in play against the stage with one left.
- The first rule ("closed when no balloon has a button") described a side
  effect, not the reason. It broke as soon as another change gave the
  button a second reason to be absent. The new rule names the cases.
## 2026-11-20: the game is made ready for a live site on Render

Built:

- `render.yaml`: Render sets the whole site up from this file. One web
  service, one 1 GB disk at `/var/data`, Node 26, one copy of the server,
  the database at `/var/data/pump.db`, and a deploy only after the checks
  on GitHub pass. Each setting was read against Render's own pages today.
- `apps/server/src/db/location.ts`: on a host the server will not start
  unless `DATABASE_PATH` is set and its folder is already there, and the
  server no longer makes that folder itself. Every wallet is in that one
  file, and a host keeps only its attached disk across deploys.
- The server's start line in the log now says whether it opened an
  existing database file (and how many players are in it) or made a new,
  empty one.
- `tsx` is now a dependency of the server: it is the start command.

How the host was chosen: five options were researched at today's prices
(Fly.io, Render, Railway, a rented server, Northflank), each by one reader
and then checked by a second against the official pages. Render costs
about $7.25 a month and was picked because it never sleeps, the disk is
set up from a file in the repo, and it deploys from GitHub.

Turned out wrong, and how it was caught (four reviewers, each finding then
attacked by a second reader; one reviewer ran everything Render will run,
in a clean copy):

- The old `openDatabase` made the database folder if it was missing. With
  a mistyped path or a disk that was not attached, the server would have
  started happily on the throwaway disk and lost every wallet at the next
  deploy. Seen while writing the guard; now a refusal with the reason.
- Started through `npm run start`, the server was three processes deep.
  The tsx launcher waits about 30 ms for the server to answer a stop
  signal and then kills it, so under load the clean close of the database
  did not always run. No money was lost in any of 26 trials (SQLite
  recovers), but `render.yaml` now starts the server directly, the way the
  hammer test already does, and the stop handler ignores a second signal
  instead of dying on it.
- A `DATABASE_PATH` that named a folder died with SQLite's bare "unable
  to open database file". The error now names the path and says why.
- The README told the owner to look for "a disk named pump-data". Render
  does not show a disk's name. It also read as if the daily disk snapshot
  were a backup; Render itself warns against restoring a database that
  way. Both reworded, and the steps now say what to check after the
  first deploy.

Known and left as it is: the guard proves that the folder exists, not
that it is the disk. With `render.yaml` unchanged that cannot go wrong. A
check for "is a mount point" was turned down for now, because it cannot
be tried on Render before going live and a wrong refusal would take the
site down. The log line and the "deploy again and see the same balance"
step in the README cover it.

Not done by anyone yet: the deploy itself. Nothing here has run on
Render; the dry run was on a Mac. The first deploy is the real test.

## 2026-11-20: `cashout-reveal` merged with main again, and the review's fixes

Main had moved on (stats page, database location rule, Render, new balloon
look, saved seed hashes, new Pump row rules), so main was merged into the
branch again, up to f7eedde. Five files clashed; both sides were kept. The
verify page now checks both things this browser saved: the seed hash shown
before the round (main) and the reveal lines shown after it (this branch).
Main's new Pump row rule closes the row after every round and in one-balloon
rounds; a finished round with a reveal line keeps it open, except while
auto-play runs.

Turned out wrong, and how it was caught (a review that ran everything):

- From the repo root, `npm run hammer -- --url=... --db=...` never reached
  the hammer. The inner `npm run` kept the options as its own settings, and
  the hammer quietly started its own server and said PASS. Caught by
  pointing it at a port with nothing on it. The root script now ends in
  `--` (like `sim`), and the hammer stops with a clear message when npm
  kept an option, an option is unknown, or `--db` comes without `--url`.
- A database made by this branch before the first merge has a step 2 with
  another name and another shape. The server counted steps by number only,
  skipped the new step 2 and died at start on a missing column. Caught by
  building such a database from the old commit. `migrate()` now checks every
  recorded step's name first and refuses, before changing anything, with a
  message that says to delete the file.
- `verifyRound` takes a balloon's top rung from the record's own payout cap.
  A record with a lower cap, the top that gives and a reveal worked out
  against it checked out against itself, and the saved reveal line could not
  tell either. Caught by a review test that built such a record. The screen
  now also keeps each balloon's top rung as it first saw the round, and the
  verify page says when the record gives another one ("does not match what
  this device showed"). `verifyRound` is unchanged: the cap stays per-round
  config, like the RTP.
- The worktree's own `node_modules` lacked `@fastify/static`, so its server
  and tests used the main checkout's copy. `npm ci` in the worktree fixed it.

Checked: typecheck, lint, all 1,447 tests, the hammer against a server
started by hand (from the repo root, with the options) and on its own, a
database from the old branch code refused at start, and the built screen at
375x812: three balloons and one balloon, reveal lines in the row after the
round, no scrolling. On the verify page an honest round checks out, and one
whose saved top was changed by hand is flagged.

Not done: main moved again during this work (to 297760c: the balloon art and
the air pocket in the hose). It merges with this branch with no conflict but
was not merged here.
## 2026-11-20: the air pocket is the hose swelling, and it no longer flashes

The user could not see the air pocket in play and asked for one. It was
there (since bc07ff7), but as a pale dot 5 to 18 pixels across that was
on screen for about 0.35 s. Recorded frame by frame in a real round on a
local server: it ran on every pump, just too small and pale to notice.
A test page with the real balloon (speed down to 1/10, a freeze slider,
every answer, late answers, phone size) let the user try versions:

- A bigger, white, glowing dot was easy to see but sat on top of the
  hose. The user asked for the pipe itself to spread open instead.
- A lemon-shaped bulge in the hose's colour, moved by the old keyframes,
  stuck out of the curve at the bend: the user spotted it. A stiff shape
  can only follow a curved hose by luck.
- What shipped: the bulge is drawn on the hose's own line. Six dashes of
  that line, long and thin to short and fat, all centred on one point,
  make a round bulge that tapers into the hose; a paler, blurred middle
  and the hose's shine go over it. The keyframes now move one number,
  how far along the hose the bulge is (`--pb-air-s`, a registered
  property so it can animate), and the opacity. Nothing can leave the
  hose. The old timing was kept by measuring the old keyframe points
  along the hose line.
- The wait no longer flashes. In another chat the user asked to keep the
  pocket but stop the flashing dot; the wait loop (`pb-air-wait`) is
  gone and the rush just holds its last frame.
- The swell by tension went from 1 / 1.07 / 1.14 / 1.22 (too small to
  see) to 1 / 1.25 / 1.5 / 1.8 of the extra width, with the user's yes
  and the base size the user picked ("Now"). It still comes only from the
  published pop chance. "Biggest" (2.2x) was too big, the user said.

Kept on purpose: a new swell still waits until the pocket has gone in
(now a delayed `stroke-width` transition instead of a delayed `scale`),
so the pocket never changes size on the frame the answer shows, where a
pop and a survive could have looked different. Checked in a real round:
the answer frame changes data-strain, the pocket goes in at its old
width, and the new width lands about 200 ms later, hidden.

Tests in `apps/web/test/pressTiming.test.ts` were rewritten for the new
drawing: the swell is never read in a keyframe, a change of width waits
for the entry, there is no wait loop, the keyframes move only along the
hose and only forwards, and the entry starts where the rush ends.

Found on the way: in Chrome, a paused animation of an inherited
registered property that is seeked (`currentTime`) does not always
redraw the children until their style is read. Running animations are
fine; only freeze-frame tools are affected.
## 2026-11-20: balloon art: strain sheen, a real knot, latex depth

From the "Hostile agent game fix" chat, on branch `strain-sheen`, after
the user's own picks ("Fix the odd shine", "Yes, use it", "now do the
knot and latex depth"). Balloon.tsx and balloon.css only.

Built:

- The strain spot is now a sheen. It was an oval with a dark rim on the
  upper right that read as a dent or an eye, and on Expert it showed
  before the first pump. The rubber over the upper right now goes paler
  as the pop chance rises, with a bright band along the curve and no
  edge. On the pearl balloon, where nothing is paler than its white, the
  patch is a cool see-through grey. Strain levels and the level-3 pulse
  are unchanged.
- The knot shown at a cash-out tie-off is a wrapped lump with its crease
  and a little light, the neck's end flaring out below, and a rolled lip.
  It was a cone and a flat oval.
- Latex depth: the balloon's own deeper colour towards the bottom, a
  lighter black underside, light bounced up the lower left edge, creases
  where the rubber gathers into the neck, a broad soft light on the
  upper left, and a fuller rolled lip on the pumping neck.
- Every new layer is drawn on the body outline or inside it. Masks and
  gradients are black and white only, so their ids can repeat on every
  balloon, like pb-shade; the colour comes from the fill.

Turned out wrong, and how it was caught:

- The user asked to "remove flashing dot". I hid the whole air pocket,
  but another chat was building that same pocket at the user's request.
  Caught by listing the running chats before going further; the user
  then chose "Keep it, stop flashing", so the hide was reverted
  (3780203) and the change went to the "Air pocket balloon animation"
  chat, which owns the pocket.
- The soft light was first a tilted ellipse whose measured box reached
  x 22, past the 14-87% limit the phone layout relies on. Caught by
  measuring every new shape's box with motion off; it is now the body
  path with an elliptical gradient (c05cc7c). With motion off, every new
  shape sits inside the body, x 28 to 172.
- I built a fix for the round panel's readouts overflowing at 320 px
  while the coordinator built the same fix on main; our messages
  crossed. Mine was dropped (main has 3b02d33).

How it was checked: typecheck, lint and all tests after merging main
(1211 tests, including balloonLook.test.ts and pressTiming.test.ts,
which read balloon.css). Every slot drawn at strain 0 to 3, Patch on,
before the first pump, popped, cashed and tied, from the real component
next to the merged coordinator art (grey shards, slate tape, pop scrap
on the hose). Live in the game before the merge: 3 Expert balloons at
375x667, no page scroll, same picture sizes, and a cash-out lifting off
with the new knot. Layout files (styles.css, App.tsx, components) are
identical to main.

## 2026-11-20: a new round's pumps set up instead of snapping back

When a round ends its balloons stay on screen as they ended: after a pop
the hose lies on the floor with the torn scrap on its end, after a
cash-out it is shrunk back to the pump. The next bet swapped that for a
fresh pump in one frame. The user asked for an animation so the pump
does not snap back.

Now each new pump sets up from the picture that was in its place
(`game/setUp.ts` works out which, per slot, from the round that was on
screen; `data-setup` on the art; the "Set-up" section of balloon.css):
after a pop the hose lifts off the floor (upright by 150 ms, a 4 degree
swing past, still by 300 ms) while the scrap fades and the dimmed number
plate comes back; after a cash-out the hose stretches back out. The new
balloon then grows in from the end of the hose (150 to 390 ms). Each
starts from exactly the end picture's transform, and a test holds the
two together. With motion off the hose is simply there and the balloon
fades in. Display only: the round is live at once, nothing waits.

Two things decided on the way:

- The air pocket moved inside the hose layer. Auto-play pumps straight
  after the bet, so a pocket can run while the hose is still lifting;
  outside the layer it ran up a hose that was not there yet. Inside, it
  rides the hose (also on a pop or cash-out, where it is already hidden).
- `data-setup` stays while the balloon is in play and goes in the same
  update as its pop or cash-out. The first version dropped it after the
  first pump; checking in the game showed that a quick first answer then
  cut the set-up short and the picture jumped. Removing it at the end is
  still needed: when the pop or cash-out motion is over, the hose would
  otherwise pick the set-up rule back up and replay it. The set-up rules
  also come before Pop and Cash-out in the file, so those always win.

Checked in a real game on a local server (127.0.0.1, not localhost:
every local server shares the localhost cookie, and another chat's game
server on the same machine logged this one out mid-test): the cash-out
set-up live, frame by frame; the pop set-up by stepping its animations
(hose -82, -41, -12, 0, +3.8, 0 degrees at 0 to 300 ms); a pump 115 ms
after the bet; the popped and cashed end pictures afterwards with no
set-up running. A page refresh gets no set-up (nothing was on screen
before), and neither does the first round after loading.
## 2026-11-20: upright screens scroll down to bet, and Bet is at the top

Two user decisions, both newer than "Make it fit" (the entry "upright
phones fit on one screen again"), which they replace for upright screens.

1. "Lets scroll down for manual and auto please dont pop up", then the
   choice "Scroll down to bet" (made in the merge coordinator's chat).
   After a round the tall bet panel had popped up and squeezed the stage.
2. "bet should be at top reverse the order" (in the layout chat, with a
   screenshot of the bet panel).

Built, on the branch `one-screen-layout`:

- On an upright screen the stage has one height: the screen minus the top
  bar and the room the round panel needs (`--round-room`). It is the same
  on the bet screen, in a round, after a round and during auto-play.
- In a round the panel fills that room, so a round is one screen with no
  scrolling. What is spare goes to the big Pump button.
- The bet panel and the auto-play form are taller. They start in the same
  place and run on below the screen; the page scrolls down to them. The
  top bar stays at the top while scrolled, so the balance and the settings
  button are always there. The page cannot move sideways.
- The Pump row under the balloons depends only on the number of balloons:
  closed with one, open with two or three.
- The panel's order is reversed, in the markup: Bet (or Start auto-play),
  the amounts, the number of balloons, the ladder line, the difficulty,
  Manual or Auto. So on an upright screen Bet sits where Pump sits in a
  round and needs no scrolling; scrolling is only for changing the bet.
- Wide screens and phones on their side keep the panel beside the stage and
  do not scroll. Their panel has the new order too.

Checked on the real server: 32 sizes, nine states with three balloons
unless said (one-balloon round, after it, three-balloon round, the same
round down to its last balloon, after it, the bet screen with every bet
capped, the bet screen with three error notes, the Auto form, auto-play
running). 31 sizes pass; the one left is still 568x320 on its side.
What "pass" means now: a round never scrolls; the page never moves
sideways; on an upright screen the stage's height, the picture's size and
the horizon are the same in every state; the main button (Bet, Start
auto-play, Pump or Stop) is on screen without scrolling; after scrolling
to the end the last control is on screen and the top bar is still at the
top; no two controls overlap; the pumps stand on the floor.
Also checked by hand at 375x812: scrolled to the end of the bet screen,
pressed Bet, and the page was back at the top by itself with Pump on
screen, because a round's page is exactly one screen tall.

Numbers at 375x812: the stage is 550 px tall in every state (it was
squeezed to as little as 104 px on the bet screen before). The bet screen
is 939 px tall with one balloon, so it scrolls 127 px.

Turned out wrong, and how it was caught:

- The round panel's room was first a guess (206 px) and 24 px too much.
  Measured instead: the panel was laid out at its natural height at 13
  upright sizes, with one and three balloons and with the largest numbers
  ($1,000 bets on Expert). It needs 181, 171 and 150 px at the three
  button sizes; the room is now 192, 182 and 160.
- The first measuring run stopped with an error: its one-balloon round had
  popped on the first pump, so there was no round panel to measure. The
  run now starts again when that happens.
- Not checked: the screen after an auto-play run has ended (its result
  line under Start). The run was stopped mid-round in the check, which
  leaves the balloons for the player.

Applies to upright tablets as well as phones, since they share the stacked
layout. Not asked for and not done: a smooth opening of the Pump row.
## 2026-11-20: the game is live on Render

The site is at https://pump-wysj.onrender.com. Render built it from commit
8562809 in 44 seconds, on Node 26.13.1, from `render.yaml` with nothing
typed in by hand except the Blueprint's name. It was set up from the
repository's public address, so Render was given no access to GitHub.

Checked on the live site:

- From outside: the health check answers, the game page loads, the player
  cookie is HttpOnly and Secure, a request without a session gets 401, and
  plain http is sent on to https.
- Render's Disk page shows 1 GB mounted at `/var/data`, and the first start
  logged "the database file is /var/data/pump.db: made a NEW, EMPTY file".
- The deploy test: a bet was placed and the balloon pumped once, the round
  left open. Then the service was deployed again from Render's page. After
  it, the same balance and the same open round came back, the log said
  "opened the existing file, 3 players", and the round was cashed out.

Turned out different from what was written, and how it was seen:

- The README said a push goes live by itself once the checks pass. With
  the public-address setup it does not: another chat's push (297760c) got
  its green check and Render started nothing. The README and `render.yaml`
  now say a new version goes live with Manual Deploy.
- "A Blueprint file was found, but there was an issue" on Render's page
  meant only that no payment card was on file yet. It cleared after the
  card was added.
- In Render's Manual Deploy menu, a click made while the menu was still
  sliding open landed on "Deploy a specific commit", which would have
  switched automatic deploys off. It was cancelled before anything was
  chosen. The README now warns about that entry.

Cost: $7.25 a month (Render's own figure on the review page), counted by
the second. The owner's limit is $10 in total, so the service has to be
deleted by about 20 December 2026.

Left as it is: Render calls the health check every five seconds and the
server logs each call, so the log is mostly health checks. Search the log
for `the database file is` to find the start line.

## 2026-11-20: README: the math, rounding, tradeoffs and more time

The brief asks the README for the pop curves and Patch pricing with the
reasoning, which way money is rounded and why, the tradeoffs, and what we
would do with more time. None of it was there. Four sections were added at
the end of the README: "The math: pop curves and Patch prices" (with the
payout cap, rounding and how the math is checked), "Tradeoffs" and "With more
time". The reasoning comes from this worklog and `config.ts`; nothing in the
game changed.

Every number in them was worked out again by a separate scratch script from
`config.ts` alone, in BigInt, and matched against `npm run rtp`: the first
pump's pop chance at 94%, 97% and 99%, the lowest RTP the ladders allow
(93.59%, set by Easy), the largest single Patch ($25,773.20, Hard, $500 bet,
pump 13), the Hard Patch example ($10.53, worth 96.96% of its price) and the
Easy $1 Patches that cost their whole step (pumps 2 to 8). The numbers are
labelled as being at 97% with the ladders of this date, and point to `npm run
rtp` for the current ones.

Turned out wrong in the first draft, and how it was caught:

- "Rounding toward the house is the only rule that never pays more than the
  RTP" claimed too much: rounding down by two cents never pays more either.
  It now says "the only direction", as `math.ts` does. Caught on re-reading.
- "The tests run at 94%, 97% and 99%": only the tests that depend on the RTP
  do. Caught by checking the test files.
- "The bet panel shows each balloon's top": it shows the top only when the
  cap cuts the ladder. Caught by reading `BetPanel.tsx`.

Left for the owner: "Tradeoffs" and "With more time" are drafted from the
record and should be read in the owner's own words before submitting. The
README intro on main ("is live") and on `cashout-reveal` ("Not live yet")
already clash when merged; the new sections add no clash of their own
(checked with `git merge-file`).

## 2026-11-20: the phone's bet panel is a sheet you swipe up

The user, in the layout chat: "Make it so you can like swipe up on it.
Like on an iphone opening an page or something on iphone also make sure
like iphone and webbrowser are not identical."

Built on the branch `one-screen-layout`, in `styles.css` only, on top of
"upright screens scroll down to bet":

- On an upright screen the panel is a sheet: docked at the bottom, as wide
  as the phone (560 px in the middle on a tablet), rounded at the top, with
  a shadow and a handle. With the sheet down, its top is on screen: the
  handle, Bet and the amount.
- Swipe up and it slides up over the balloons; swipe down and it goes back.
  The swipe is the page's own scroll, so it moves the way every sheet on
  the phone does and needs no script. The stage is stuck in place under
  the top bar (`position: sticky`), so the scroll moves only the sheet. The
  page comes to rest in one of two places (`scroll-snap`): sheet down or
  sheet up.
- The handle shows only while there is something to pull: not in a round
  and not while auto-play runs.
- A wide screen (a desktop browser, a phone on its side) is deliberately
  different: the panel is a card beside the stage, nothing scrolls, there
  is no sheet and no handle.

Checked on the real server, 32 sizes, the same nine states as the entry
before. 31 pass; 568x320 on its side fails as before. New in what "pass"
means: on an upright screen the sheet is the full width (or 560 px and
centred); in a round it is docked at the bottom and has no handle; with
the sheet up the stage has not moved or changed size, the top bar is still
at the top, the sheet's end is at the bottom of the screen, its last
control is on screen and it does not go under the top bar; a wide screen
has no handle. At 375x812 by hand: a nudge of 40 px falls back to sheet
down, a nudge of 100 px goes on to sheet up (135 px), and with the sheet
up the stage is at the same place and size (558 px) with the sheet over
its lowest 125 px.

Known limits:

- Checked in Chromium only. The swipe itself, the snap, and how a phone's
  browser hides its bars while the page scrolls are exactly the things
  that differ in Safari on a real iPhone, and they have not been tried
  there. The stage's height is taken from the screen at its smallest
  (`svh`) so that it should not grow when the bars hide; that is by the
  rules of the browser, not by a test on a phone.
- The handle is a picture, not a button: tapping it does nothing. The
  sheet is moved by swiping, by the Tab key (the browser brings the focused
  control into view) or by any scroll.
- With the sheet up the lower part of the balloons is covered (up to 341
  of 558 px on the Auto form with three bets). That is what a sheet does.
## 2026-11-21: the after-round reveal lands on main

From the "Agents finishing and game compilation" chat, which coordinates
merges. The user approved changing the locked Provably fair rule ("yes", then
"Keep building it") and said "merge it when the builder says ok".

Built: after a round is over, each balloon that was cashed out below its top
shows where further plain pumps would have taken it ("Next pump would have
popped", "Would have reached 1.37×, then popped", "Would have reached the top
(25.00×)"). The draws are made only in the transaction that finishes the
round, stored in their own append-only table (migration 2), never sent while
the round is in progress, and checked by the verify page and the independent
Python reference. With one balloon on an upright phone the line floats in the
empty sky where the balloon was, so nothing on the stage moves.

Review: the build had its own adversarial review and fixer; then the server
chat ran four independent reviewers (leaks, database and upgrade, engine and
fairness, wallet and load). All passed, including an upgrade of a database
made by the live version with rounds in progress.

Turned out wrong, and how it was caught:
- The upgrade is one-way, and going back is exploitable. On a database that
  has step 2, an older server can't close a round that is due a reveal (the
  triggers refuse), so a pump that would end the round answers 500 and is
  rolled back with its draw still waiting: the player resends it with a Patch
  and dodges the pop. A reviewer turned $1 into $1,000 that way on a test
  copy. Caught by the server chat's reviewers. Fix (6f5e3ff, by the server
  chat): a server refuses to start on a database with a step it doesn't know,
  and the README says never to put an older version back on the live site.
- Design note so nobody "fixes" it the wrong way: a reveal that throws rolls
  back the action that ends the round, payout included. That is right (no
  round may close without its reveals), but any future bug that throws only
  when a round ends would be the same kind of oracle. Never swallow such an
  error; fix the cause.
- My first refusal for a renamed migration step told the reader to delete the
  database file; on the host that file holds every wallet. Reworded: delete
  it only if it is a test database on your own computer.
- The fairness recipe worked out the top rung with a fixed $100,000 cap; it
  now says the cap saved with the round. The hammer counted the same reveal
  several times (winner, repeat, late 409s); it now counts each once.
## 2026-11-20: review of the after-round reveal, and a guard against going back

The newest version (297760c) was put live by hand after its checks passed.
It changes no database step; the same player kept their balance and history.

Then the cashout-reveal branch (09319e2) was checked before its merge, as
agreed with the chat that built it:

- Its own checks in a clean copy: lint, typecheck, 1,448 tests, the build,
  the RTP check and the hammer all pass.
- An upgrade shaped like the live site: a database made by the live
  version's server, with three rounds left in progress, then the branch's
  server started on the same file. Balances and open rounds came back as
  left; the old rounds were finished by cash-out and by the 24-hour rule;
  every round, old and new, passed `verifyRound`; reconcile was clean,
  also after the hammer had been run against the upgraded database.
- Four reviewers (leaks, database, engine and fairness, wallet), each
  finding attacked by a second reader. All four passed the code.

Turned out wrong, and how it was caught:

- All four reviewers ran the opposite direction, which nobody had tried:
  the OLD server started again on the upgraded database. It starts without
  complaint, cannot start or close rounds, and, worse, a pump that would end
  the round answers 500 and is rolled back, so the same draw is still
  waiting. A player can then send it again with a Patch. One reader took a
  $1 balloon from rung 1 to rung 14 that way. The ledger stayed exact; the
  money was real. Nothing in the branch is wrong: old code on a new
  database is.
- So `migrate()` now refuses to start on a database that holds a step the
  code does not know (6f5e3ff), with words that say not to delete the file.
  It was run on the very database the branch had upgraded and refuses it.
  The README says never to put an older version back on the live site.
  This guard version has to be live before the reveal version is, so that
  the version just behind the reveal refuses instead of running.
- My first upgrade run "failed" for a reason of my own making: I had given
  the reviewers the same port range I then used, and my script talked to a
  reviewer's server. Seen from "address already in use" in the log; rerun
  on a free port.

A note for whoever touches the round-ending code: a reveal that throws
rolls back the action that ends the round. That is right, but it means any
bug that throws only when a round ends tells the player the outcome, the
same way. Never swallow such an error to "fix" it.

## 2026-11-20: a better picture after a pop

The user sent a screenshot of a popped balloon in another chat with "This
can be better" and approved four changes there ("Yes, send them"). They
were handed to this chat because the new-balloon set-up starts from that
picture.

- The hose lies loose on the floor. It used to be the standing hose
  turned over, which made a stiff hook at the nozzle with its end in the
  air. Now a separate lying shape (`FLAT_HOSE_PATH`) shows. The standing
  hose still turns down, out of sight, because it carries the fitting and
  the torn neck; at the new angle (-87 degrees, was -82) its end lands on
  the floor exactly where the lying hose ends, pointing the same way. A
  test holds the two ends together. During the fall the standing hose
  hands over to the lying one in the last 60 ms. Safari cannot animate a
  path's shape, so it is a hand-over, not a morph.
- The grey star became the balloon's torn neck: its rolled lip and three
  ragged flaps in a dull, darker shade of the balloon's own colour, with
  a pale edge. The edge keeps the old scrap's contrast (3.1 to 1 on the
  hose, 9.4 to 1 on the floor) on all three colours; violet's lands
  exactly on it. The flying pieces stay grey.
- Three small grey pieces stay on the floor, still, between the hose end
  and the pump.
- The pump number stays at full strength after a pop (it was dimmed to
  0.6, which made the pump look switched off).

Found on the way: fading the hose's tube and shine one by one would have
lifted the shine from its own 30% to full for a moment; they now sit in
one group that fades as a whole. With "Animations off" the torn neck
would have flashed at the top of the standing hose during the set-up;
it is in the motion-off list now.

`balloonLook.test.ts` asked for the old grey scrap; it now checks the
torn neck's colours on every balloon and that the number is not dimmed.

## 2026-11-20: public wins, the server half (branch public-wins)

Built, from the owner's competitor notes ("you can see other people's wins,
and lucky wins. Want to show other people's biggest wins too", and "make it
easy to turn off"):

- `GET /api/wins`: three lists of at most ten wins across all players: the
  latest, the largest gains and the highest multipliers. A win is a finished
  round that paid out more than its played bets plus Patches; refunded bets
  are left out, as on the stats page. It needs no cookie and makes no player.
- Nothing in the answer identifies a player or a round. A player is a
  six-character tag, a one-way hash of the player's id. No round id is sent,
  so nobody can ask for another player's round.
- The off switch: `PUBLIC_WINS=off` when the server starts. The answer is
  then `enabled: false` with empty lists and nothing is read. A word that is
  neither `on` nor `off` switches it off too, with a warning in the log.
- One answer is reused for five seconds, because the address is open to
  anyone and each fresh answer reads every finished round.
- No database step and no change to any money path: it only reads.

Checked: 15 tests at 9400, 9700 and 9900. They play real rounds whose
outcomes are chosen in advance from the real draw code: a win, a pop, a
cash-out that only returns the bet (not a win), a round ended by the 24-hour
rule with one bet handed back (a win on the bet that was played), and a round
still in progress with a balloon already cashed out for a gain (not shown).
They search the raw answer for every player id, round id, seed, seed hash,
client seed, token hash and cookie in the database.

Not built here: the screen half. The shape is `PublicWinsResponse` in
`packages/contract`.

Known and left: the three lists are read with a full pass over finished
rounds. That is fine for a demo and is why the answer is reused for five
seconds. With real traffic it wants an index or a small table kept up to
date when a round finishes.

## 2026-11-20: public wins after its review (branch public-wins)

Three reviewers (privacy and abuse, correctness, whether the tests can fail),
each finding attacked by a second reader. The lists themselves were right in
every case they built; an independent recount of 160 hammered rounds matched
the answer byte for byte. What turned out wrong, and how it was caught:

- The check that a round in progress never shows could not fail. The round
  in my test had two bets of 1000 and one balloon cashed for 1180, so it was
  not ahead by the numbers and was hidden for that reason, not because it was
  still open. A reviewer deleted the "finished only" line from the query and
  all 15 tests still passed. The open round now has bets of 1000 and 10 with
  5000 cashed, so only its being open keeps it out.
- No test bought a Patch, so leaving Patches out of the stake passed. And
  "ten", "five seconds" and the tag recipe were only ever compared with the
  constants and the function under test. There are now hand-made rounds for
  Patches, for the highest of two cashed multipliers and for the finishing
  time, and the promised numbers are written out in the tests. The tests are
  also worked out from whatever the first ladder is, because four valid
  retunes of the ladders broke the first version.
- I had written that nothing identifies a player. A reviewer played as a
  player, matched one own win to its public row by time, stake and payout,
  and from the tag followed every other win of that player. The id, cookie
  and seeds were never exposed (none of 349 secrets was in any answer), but a
  tag that never changes is a pseudonym. The tag now changes every day, and
  the README says what the lists give away.
- A fresh answer was three full reads of every finished round, and SQLite is
  synchronous, so nothing else is served meanwhile: about 0.4 s at 100,000
  rounds on a laptop, and the five seconds of reuse were counted from before
  the read, so a read of five seconds or more would have been repeated on
  every request. The three lists are now cut from one read, and the answer is
  kept from the END of the read for five seconds or twenty times the read,
  whichever is longer.
- The switch failed open on the likeliest mistake: an empty value, or a typo
  in the variable's NAME, left it on with nothing in the log. The server now
  says "public wins: ON" or "OFF" at every start with the value it read, and
  the switch has to be handed to the runtime (leaving it out is a type
  error; before, the server could have ignored the setting unnoticed).

Left as it is, on purpose:

- One visitor's script can fill the "recent" list with tiny wins from free
  wallets. Every row is still a real win; it is a question of what the list
  should be worth, for the owner to decide (a floor on the gain is one line).
- Any visitor can make the table of rounds grow, for free. The longer rest
  after a slow read bounds what that costs. The real cure is an index and a
  small table of wins written as a round finishes, which is a database step.
- It is on unless switched off. That is right for someone running the game
  from the repo. On the live site it shows past wins of existing players
  with no notice on the screen yet, so going live with it is the owner's
  call, to be made when the screen half exists.
- One engine test (the sweep over every bet in math.test.ts) timed out once
  while this Mac was running many agents at a load of 18. It passes alone
  and on GitHub. Nothing in it was changed.
## 2026-11-20: auto-bet, cash out during auto-play, and three panel fixes

From the user's notes on a competitor: "Auto-bet: more control. It can
change the bet size by itself on win or on loss", "Off switch: some of
this might not be allowed in Ontario", and "Auto mode: it goes by itself,
but you still have the cash out option". Built on the `auto-bet` branch.

- Auto-bet. Two new auto-play settings, On win and On loss: Reset (back
  to the bets entered) or Increase by a whole percent, 0 to 1000. A round
  is a win only if it paid more than it cost (refunds void), the same
  test as the win effects. The next bet is floor(bet * (100 + N) / 100) in
  whole cents, held at the $0.10 and $1,000 limits; the screen says when a
  bet was held. Every round still goes through checkBeforeRound with the
  new bets, so the loss limit looks ahead at the grown bets. Defaults are
  Reset both ways, and the percent box starts empty: the game never
  suggests a number. The running line shows the round's bet.
- Off switch. `autoBetSizing` in market.ts: on for default, off for gb
  and for any market the file doesn't know. Off hides On win and On loss
  and forces Reset both ways, so the bets never change.
- Cash out during auto-play. Cash out per balloon (and Cash out all) sit
  under Stop while it runs. The press goes through auto-play, which sends
  it as that balloon's next step. Sending it straight to the server
  would have broken the run: auto-play's next pump would find the balloon
  busy or already cashed out and stop with an error. Found by reading
  useGame before building, not by a failure.
- Fixes from the critique: the bet panel's info line shows the top the
  entered bets can reach (it said 5,000x on Expert at a $1,000 bet that
  tops out at 100x); ½ and 2× no longer take focus, so Enter bets; the
  Pumps box says what the count reaches ("3 = 1.18×").

Caught while trying it live (desktop and 375x812): choosing Increase
focused the percent box a moment too late, so a fast first keystroke was
lost (now drawn at once with flushSync); and the Cash out row vanished
between rounds, so the panel jumped every round (it now stays, greyed).

Worth knowing: rounding down means a small bet with a small percent can
stay put. $0.10 up 5% is $0.105, so it stays $0.10 every round.

## 2026-11-21: fixes from the review of auto-bet

A review of the `auto-bet` branch found six things. Four are fixed:

- The Pumps box hid the typed count. The reach text ("= 5,000.00×") sat
  inside the box and could not shrink, so the count could not be seen on
  the desktop card (7 of 77 counts) or on a 320-wide phone (28 of 77).
  The text now sits under the box. Checked live at seven sizes, every
  count of every difficulty: all fit.
- The reach text ignored the max payout. On Expert at $1,000 it said
  "= 5,000.00×", while the info line said top 100.00×. It now says
  "top 7 = 100.00×", using the same top as the info line.
- A Cash out pressed after Stop could be lost. If it came while auto-play
  was sending an earlier one, the button said "queued" but nothing was
  sent. Auto-play now reads the list again after each send. Seen live:
  both cash-outs went, all answers 200, wallet equal to the ledger.
- A press on an older round could wipe the current round's presses. The
  App can't reach this today. Auto-play now names the round it plays, and
  a press on any other round is ignored. The reviewer's fuzzer, which
  failed when the screen could lag into the previous round, now passes.

Two are left for the user. The Cash out amount during auto-play is often
one step behind what it pays (a product call). The Ontario market entry
waits for the user's answer. The off path itself was tried live on a
scratch build: no On win or On loss, and every round used the bets
entered.

Found while checking: a $1,000 bet capped by the max payout shows as
"$ 100" in its box, because the "Top 100.00×" label takes the room. This
is on main too, so it is reported, not fixed here.
## 2026-11-20: a new balloon starts flat on the floor until its first pump

Item 2 of the user's competitor list, the start animation. Two of the
user's notes pulled different ways: from Stake, "starts from a flat, empty
balloon that pumps up by itself, and it zooms out slowly"; from SmartSoft,
"starts at the bottom: lying on the floor, then rises slowly"; and, later
while playing, "attach a new undeflated, very small balloon, and then the
first pump will pump it up". Asked in this chat, the user chose: the
balloon appears at the bet, "have to pump seperately to get off florr",
and it stays flat until the first pump.

What it does now (balloon.css "First pump" and "Set-up";
`game/setUp.ts` balloonFirst):

- Before any bet the pump stands with its hose on the floor, no balloon.
- At the bet a small flat balloon goes onto the end of the hose, on the
  floor, and the view moves a little closer (8%). After a pop the torn
  neck and bits go first; after a cash-out the shrunk hose lays itself
  down first.
- The first press runs its air pocket along the lying hose (a second
  pocket, on FLAT_HOSE_PATH, with the same keyframes).
- If the first pump holds, its answer lifts the hose off the floor, the
  flat balloon comes up with it and blows up to its first size, and the
  view eases back out over 900 ms: the Stake zoom. If it pops, the flat
  balloon bursts on the floor: no fall (the hose is already down) and no
  pieces in the air, just the burst, the torn neck and the bits.
- The first pump's answer is never shown early: the lift and the burst
  only come with the answer. The handle and the press timing (PRESS_MS)
  are unchanged.

Kept inside the layout's rules: the viewBox is still 0 0 200 320, nothing
is added under the floor, and the closer view is anchored at the right
edge of the pump's shadow (174, 314), so the drawing only grows left and
up; its leftmost point, the hose fitting at x 41, comes to x 30.4, inside
the 14% (x 28). A test measures this. With motion off: no zoom, no
movement; the blown-up balloon fades in.

Decided on the way: the lift is quick (280 ms) and the slow part is the
zoom, so a held Pump button's next press (about 250 ms after the answer)
finds the hose already up. The "lift" state lasts the whole first rung
so it plays once and is never cut; a balloon restored after a page load
shows the floor picture at once, with no set-up.

Not seen yet: a live round on this branch. All five preview slots in the
folder were taken by other chats, so the frames were checked from the
branch's real markup and CSS in headless Chrome, with the animations
stepped.
## 2026-11-20: the swipe-up sheet, checked again on top of the reveal and the new pump set-up

The sheet waited for two other merges (the after-round reveal and the
new-balloon set-up with the popped picture). With both in main, main was
merged into `one-screen-layout` (no conflicts, 1461 tests pass) and the
size check was run again on the real server before main was moved.

Result, 32 sizes and eight states (a one-balloon round and the screen
after it, a three-balloon round, the same round down to its last balloon,
the screen after it, capped bets, the Auto form, auto-play running):
31 pass, and nothing moves between the states on any upright screen.
568x320 on its side fails as before (the panel scrolls inside itself).
The after-round line passes everywhere except with three balloons on the
three phones on their side (667x375, 640x360, 568x320), where it runs
into the numbers. That was already so on main before the sheet and is
the reveal's own fix, not a change from the sheet.

What went wrong, and how it was caught: the first run of the check died
part-way ("Cannot read properties of undefined (reading 'click')") after
one state. The check drives the game in a hidden frame inside the preview
tab, and the user was playing in that same tab at the same time. Both
were the same player (one cookie for `localhost`), so each kept ending
the other's round. The fix is the one the pump set-up entry above found
for a different reason: run the check in its own tab on `127.0.0.1`,
which is a different player from `localhost`. The script now also waits
for a button and says which one is missing, instead of clicking nothing.

## 2026-11-20: the after-round line on phones on their side

The sheet's size check found the last gap in the after-round line: with
three balloons on a phone on its side (667x375, 640x360, 568x320) each
slot is only 64 to 70 px wide. The line, at its 9px floor, wrapped to
four lines there and ran up into the numbers above it.

Built: a second, shorter wording of the same facts ("Would pop next",
"Would pop after 1.37×", "Would reach top (25.00×)"). The card writes
both, and a container query on the slot shows the short one only below
104 px. The full line stays as the title. Upright phones (about 120 px a
slot) still show the full line.

Checked live on its own server at all three sizes after a real
three-balloon round: no overlap, two lines. Then the longest wording any
ladder can produce (the 5,000× top) was put in by hand: three lines at
9px, still clear of the numbers. A test now wraps every short line word
by word at 12 characters, for every ladder's top multiplier, and asks for
three lines at most, so a new ladder with a bigger top fails the test
instead of the screen. 1465 tests pass.

Nothing turned out wrong in this step.

## 2026-11-20: the multiplier steps go with each balloon

From the user's competitor notes (#5 on their list): "Multipliers on top.
In auto mode it shows the multipliers growing and the ones coming next,
and it scrolls along the top", "We have a lot of space at the top ...
Maybe put the rows up there", and "Three balloons: harder for us with
three balloons, especially on a phone. Need to figure out how to fit it."
Then, in the competitor chat, the rule for phones: "It only go if there's
like space clearly available", and a plan they approved ("Yes, send it"):
on a computer one row per balloon in the top space; on an iPhone a row
under the balloon for one balloon and a small "next 1.23×" for two or
three; nothing over the balloons or the sky above them, which is where
they grow.

Built on `one-screen-layout`:

- `game/stepRow.ts` (pure, tested): every step of a balloon's ladder with
  its state: passed, current, next, ahead, locked (above the top its bet
  can reach) or popped (the step it was going for). It reads only the
  balloon's own state and the round's own ladder, so it cannot hint at a
  pump that was not made.
- `components/StepRow.tsx` and `steps.css`: one row per balloon, drawn
  three ways.
  - A computer (wide, at least 560 px tall): a line of its own along the
    top of the balloon's slot. One passed step stays in view, then the
    current one in the balloon's colour, then what is coming; it slides
    along as the balloon climbs. A short ladder sits in the middle and does
    not move. The Net badge and messages moved down under the rows.
  - An upright slot at least 300 px wide (one balloon on a phone): the
    steps run left and right of the amount under the balloon, in the band
    those two lines already have. The big multiplier is the current step.
    Shown only while the balloon can still be pumped.
  - A narrower upright slot (two or three balloons on a phone): no row.
    Each balloon in play says "next 1.28×" small, inside its own Pump
    button, or alone in that row when it has no button.
  - A phone on its side: nothing.
- `BalloonCard.tsx`: the row is the first child of both cards; the Pump
  row takes the next step (the server's own number). `App.tsx` gives the
  preview its ladder and the top its bet can reach.

One thing is not as the approved plan worded it. The plan put the phone's
row "in the gap between the amount and the bet panel (~100px free)". That
gap is the empty Pump row, which exists only with two or three balloons;
with one balloon it is closed and the round panel starts right under the
amount. A row of its own there would take about 34 px from the picture.
Beside the amount it takes nothing. The coordinator agreed and will show
the user this difference before it lands.

Checked on the real server, 32 sizes, twelve states (bet screen with one
and three balloons, both again with a bet the payout cap cuts short, a
one-balloon round after four pumps, after it, a pop on the first pump, a
three-balloon round, the same round down to its last balloon, after it,
the Auto form, auto-play running). 31 sizes pass as before; 568x320 on its
side still scrolls inside its panel. New in what "pass" means: on a wide
screen the row is at the top of its slot, inside it, above the picture,
with the current and the next step in view and no message on it; on an
upright screen the steps are inside the label band, level with the big
multiplier, never on the amount, and hidden once the balloon is over; in
a narrow slot each balloon in play has exactly one "next" line, inside
its host, at 9 px or more, and the Pump button is no taller than before.
The after-round line now passes everywhere (the coordinator's fix).

The balloons' size, old build against new at all 32 sizes with one and
three balloons: identical on every upright screen and every phone on its
side (51 of 64 measurements). On a wide screen the picture is 34 px
shorter, the row's own line: 3% at 1500x1400, 5% at 1440x900, 8% at
1024x600. 1474 tests pass.

What went wrong, and how it was caught:

- The step width is set smaller on the row itself for the phone band, but
  the distance from one step to the next was first worked out on the
  stage, above it. A custom property is worked out where it is written, so
  the row would have slid by the computer's distance. Seen on reading the
  file before the first run; the distance is now worked out on the row.
- The first run of the size check said steps lay on the amount at nineteen
  upright sizes. They did not: the check resizes its frame and measures at
  once, and the row takes 280 ms to slide to its new place. The check now
  switches the slide off in its own frame; with that it finds none. In
  the game a step cannot cross the amount in any case: the row is cut away
  around the middle, so steps slide in under the amount and out the other
  side.
- The same run measured "bet screen, one balloon" with three balloons on
  the stage: the stage keeps the last round until the next bet, and a
  round from an earlier try was still there. The check now ends any round
  and loads the page again before it starts.
- A fifth preview server was refused (five per folder, four belong to
  other chats), and rebuilding the one build would have changed the game
  the user was playing in the same server's tab. The trial build is now
  served beside it, under /wip/, from the same server.

- Found before the merge, after the user's yes, on reading the check
  itself: its three-balloon round had every balloon one pump in, so no
  row had slid, and "the next step is in view" only asked that it was
  inside the row. With three balloons in a 1024 px wide window a slot is
  213 px and its row 193 px. Kept as "one passed, current, next", the next
  step sat at 160 to 222 px: cut off at the row's edge once a balloon was
  three pumps up. Measured both ways in the game at 1024x768 (balloon 1 at
  1.28×): before, next at 160 to 222 of 193; now, current at 24 to 86 and
  next at 92 to 154. The fix: a row under 246 px gives up the passed step,
  one under 178 px also has smaller steps and fades, and a slot under
  158 px (a window about 800 px wide with three balloons) has no row; the
  panel's "Next" still names the step. The check now has a round with one
  balloon four pumps up, asks that the current and the next step are clear
  of the faded edges, and has two smaller windows (900x700, 800x600):
  34 sizes, thirteen states, 33 pass, the row checks all pass.
- One test run just before the merge showed 13 failed tests in 7 files.
  Nothing had been changed that a test reads, and the same run passed
  three times straight after (1474 tests). Two things were going on at
  that moment: the machine was very busy (load average 17, several chats
  running their own tests), and another chat's reviewer had just put a
  throwaway test file into this worktree. Which of the two it was is not
  known; the failing names were not kept. That file is not part of this
  work and was neither committed nor deleted here.

Not built, not checked:

- "The balloon needs to grow more." The picture already has the stage's
  whole height; what stays small is the balloon inside it
  (`balloonSize()` in Balloon.tsx: 0.45 before the first pump, 0.56 after
  three pumps on Easy). That file is being changed for the flat start by
  another chat, so the numbers went there instead of a second edit here.
- Stake shows a step's cash-out and chance when it is tapped. Not in the
  approved plan, not built.
- Chromium only. The rows use container queries, `:has()` and a mask; none
  has been tried in Safari or on a real iPhone.

## 2026-11-20: a player can keep their wins private (branch public-wins)

The owner's answer to "past wins of people who already played become visible
to everyone" was: "You can keep your wins private." So each player now has
that choice.

Built:

- Database step 3: one column on `players`, `wins_private`, 0 or 1, starting
  at 0 for everyone, also for players who were there before the step.
- `GET /api/settings` and `PUT /api/settings` with `{ winsPrivate }`. The
  change needs the player's cookie and an idempotency key like every other
  change, and moves no money.
- The public lists leave out every win of a player who chose private, past
  wins included. It takes effect at once: the answer being reused has that
  player's rows taken out of it in memory, with no new read of the rounds,
  so switching it on and off cannot be used to make the server read more
  often. Showing them again takes until the next read, a few seconds.

Checked:

- Tests at 9400, 9700 and 9900: two players win, one goes private and is
  gone from all three lists with no time passed, stays gone after the next
  read and for a new win, still sees their own stats, and is back after
  switching it off. The change is refused without a cookie, without a key,
  with a wrong body; a repeat gets the same answer; the ledger does not move.
- An older database (steps 1 and 2 with a player in it) is brought up to
  step 3 and that player starts with wins shown.
- On a database made by the live version (8562809) with rounds left in
  progress, started the way the host starts it: the server came up, steps 2
  and 3 were applied, the old rounds were finished and all verify, a player
  from before the upgrade switched to private and was out of the lists in
  the next answer, and reconcile found no problems.
- 27 bugs were planted one at a time in the public wins and settings code
  (a private player still listed, the change not stored, not applied until
  the next read, hiding everyone, no cookie needed, the body unchecked, and
  the 21 from before). The tests caught all 27.

Turned out wrong, and how it was caught: two tests of the reveal work
counted the database steps as exactly 2 and failed when the third was
added. They now compare with a fresh database's count instead of a number,
so the next step will not break them.

For the owner to decide: wins are shown unless a player chooses private. If
it should be private unless a player chooses to show them, it is the default
of that one column.

## 2026-11-21: the private setting after its review (branch public-wins)

Two reviewers (the database step and the upgrade; the setting itself), each
finding attacked by a second reader. A third reader, from the chat that
coordinates merges, read the earlier fix commits. The code held: the upgrade
from the live version's database with rounds in progress left every row the
same, all old rounds verified and reconciled, nobody could read or change
another player's choice, and no moment was found where a private player's
row is served. What turned out wrong, and how it was caught:

- The lists would have gone public before anyone could choose. The screen has
  no switch yet, and the server showed the lists unless told not to, so a
  deploy would have shown every existing player's past wins with no way for
  them to say no. On a host the lists are now OFF unless PUBLIC_WINS is set
  to "on" (a forgotten or misnamed entry shows nothing), `render.yaml` says
  "off" in so many words, and run from the repo they are still on.
- A clock jump during a read froze the lists. The read was timed with the
  wall clock, so an hour's jump (a laptop waking, a time correction) counted
  as an hour's read and a rest of twenty hours. A read now counts for a
  minute at most. Found by the coordinator's reader with a throwaway test.
- Two tests were blind. The "no cookie" test ran in a world with no players,
  so a bug that fell back on an existing player still got 401; a planted
  fallback passed all tests. And nothing checked the claim that switching the
  setting never re-reads the rounds: a planted hide() that threw the kept
  answer away passed too, at 501 reads for 1,000 switches. Both are now
  tested, the second by counting reads over 200 switches.
- No test pinned the names of the database steps. A rename passes every test
  and would make the live database refuse to start. They are pinned now.
- The words were ahead of the code in four places: "all players' wins" (it is
  all who have not chosen private), "shows them again within a few seconds"
  (it is at the next read, up to twenty minutes after a very slow one), "one
  default in one place" (only until the step has run on a database), and "and
  no further" about the day tag (a player who goes private has all their rows
  leave together, which ties their days together for anyone comparing two
  answers). All four now say what the code does.

Database steps are one-way. Step 3, like step 2, cannot be undone on a
database it has run on: once it has run on the live database, no version from
before it may be deployed there. A server with the guard refuses to start on
such a file. The live site was put on the guard version (8d9c901) on
2026-11-20, so the version behind this one refuses instead of running; the
older deploys still in the host's list (8562809, 297760c) have no guard and
must never be put back.

Left as it is, and why:

- Going private can be seen by someone polling the lists. Hiding the rows at
  once is the point; hiding them slowly would leave a private player listed
  for longer. The README says so.
- After someone goes private the lists can be shorter than ten until the next
  read. Filling them would need the read that this is built to avoid.
- Everyone starts with wins shown. With the lists off on the live site
  nobody's wins are shown until the owner switches them on, so the other
  default can still be chosen then, as a new database step.
## 2026-11-21: the step row after an independent review

The coordinator had the step row read by a second checker, apart from
the chat that built it. Its verdict: the numbers are right (checked
against the engine at 9400, 9700 and 9900 on all four ladders, with bets
at every cap edge: locked steps are exactly where bet x multiplier is over
the cap, current and next match the server, nothing shows early). It
found four smaller things, each confirmed by a second tester. All four
were real, and all four are fixed here on `one-screen-layout`.

What was wrong, and what was done:

1. No test covered how the cards hand a balloon to its row. The reviewer
   broke the payout-cap wiring on purpose and all 296 web tests still
   passed: the tests only knew the pure rules in `stepRow.ts`. New
   `test/stepRowCards.test.ts` reads the markup the cards write: a card
   locks exactly the steps above its balloon's own top (every ladder, the
   cap-edge bets, three RTPs); a preview card locks what `topRungForBet`
   says; "next" is the server's own number, inside the Pump button or
   alone, and never on a balloon that is over, even one that still
   carries a next pump; a result that is being held back shows nothing.
   To make the preview's cap testable at all, `PreviewCard` now works out
   its own top from the bet and the cap (it was worked out in `App.tsx`,
   which no test can draw). Checked the way the reviewer did: five
   wrong versions of the card (the ladder's length as the top, the cap
   ignored in the preview, "next" on finished balloons, a wrong "next",
   no next step in the button's label) each fail the new tests. A test
   named for "every status" that only tried a refund was renamed and
   widened to every ladder. The three widths at which a row along the top
   changes are now tested against the step width, gap and fade in
   `steps.css`, so one cannot be changed without the other.
2. On an upright phone the row jumped when a Patch stopped a pop. The
   hole around the amount was as wide as the longer of the two lines, and
   "Patch stopped a pop" is longer than any amount, so the hole grew and
   shrank with words that have nothing to do with the steps. The hole now
   follows the big multiplier only, and is never narrower than a
   five-character one, so "—" turning into "1.01×" does not move it
   either. A step is now no taller than the big line (it was 24 px on a
   21 px line on the smallest phones), so it cannot reach the small line
   under it.
3. On an upright phone the row did not slide on the first pump, and on
   later pumps the next step blinked out instead of sliding under the
   amount. The place in view was a wide, hidden item, and the item before
   the first step was only there before the first pump, so the first pump
   swapped two items in place. Now every place is one step wide, the
   place before the first step is always there, and the rest of the hole
   is a margin on the step after the current one. On a pump the row moves
   one place and that margin moves on to the following step, with the
   same time and curve, so every step simply moves one place and the next
   one goes in under the amount. Measured at 390x844 by stopping the
   slide at five points, for the first and for the second pump: the next
   step goes from 62 px right of the middle to 55 px left of it (inside
   the hole, hidden), the one after it from 124 to 62, the step before
   comes out to 117 px left.
4. A screen reader got all 32 steps of the ladder for every balloon, with
   "out of reach" and "popped" only as labels on list items, which most
   readers skip. The row is now hidden from screen readers. Each card has
   one short hidden line instead ("Next 1.18×. Top at this bet 50.00×.",
   or "First step ..." before the round), outside the live region, so
   auto-play stays quiet. The Pump button's label names its next step,
   since a label replaces the button's own text.

Judged by the reviewer to be as meant, and left alone: the row stays on a
computer after a pop or cash-out, and the stage shows the last round
until the next bet.

Checked: 34 sizes, thirteen states, on the real server. 33 pass, 568x320
on its side as always; the row checks all pass, with new ones for the
hole (as wide as the multiplier, centred on it, the place in view inside
it) and for the small line (no step reaches it). The picture sizes are
unchanged. 1500 tests, lint and typecheck pass.

What went wrong on the way, and how it was caught:

- The size check failed at 40 size-and-state pairs on its first run. It
  was the check again, the same way as before: the row now has a second
  slide (the margin), and the check only switched off the first, so it
  measured mid-slide. With both off it finds nothing. The smallest phone
  was then looked at by eye.
- One full test run failed one engine test that this work does not touch
  (`math.test.ts`, cashOutCents "for every bet swept"), with the machine
  at load average 26. It passes alone (1.1 s; the limit is 5 s) and in
  the next full run. The failure's own message was not kept, so "it ran
  out of time" is a guess. This is probably what the 13 failures in the
  entry before were.
- The browser pane was closed in the middle of a run, which ended that
  run; it was started again.

Not checked: Safari and a real iPhone, as before. The slide was measured
in Chromium by stepping its animations, not watched on a phone.
## 2026-11-20: live stats beside the game

Built on `live-stats`: a chart button in the top bar, next to the session
net, opens this visit's Profit, Wagered, Wins, Losses and profit line,
with Reset and Close. Closed at the start of every visit, kept in memory
only (a refresh starts it afresh, as Stake's does).

- The figures come from `stats/liveTally.ts`, pure and tested: a round is
  added once by its id, refunded bets are left out as on the stats page,
  a round of refunds only is not a round, Patches count as wagered, and a
  round that breaks even is neither a win nor a loss. Reset keeps the ids,
  so a round counted before it can't come back.
- A round counts when the screen shows its end (the round as drawn, with
  a pop, top or cash-out beat), so nothing shows before the balloon does,
  and only if it was seen in play on this screen: a round closed by the
  24-hour rule while the player was away is left out.
- Computer: its own card in the side column under the controls, laid over
  the layout so the stage keeps its size. Upright phone: the top of the
  sheet, pushing the bet panel down, short enough that Bet stays in sight;
  it steps aside in a round and during auto-play, when the round panel
  needs all the room. Sideways phones and windows under 560px tall: no
  room, so the button is hidden.
- The stats page's chart got a `compact` prop instead of a copy.

What went wrong, and how it was caught:
- `liveStats.ts` and `LiveStats.tsx` are one name on macOS's disk; the
  compiler picked up the wrong file. Caught by `npm run typecheck`; the
  tally module is `liveTally.ts` now.
- The opener first took a React ref through the hook's result object;
  the React lint rule flagged every read of that object as a ref read
  during render. Caught by `npm run lint`; the opener is found by its id.
- The live check could not be done: the `live-stats` server was started
  before this worktree had a build, so it serves the API only (its log
  says so, and the page is a 404). It reads the build folder only when it
  starts, and stopping it was not allowed from this session.

## 2026-11-21: live stats, review fixes

Three reviews of the live stats branch (money logic, the live screen,
trying to break it). Fixed:
- A round now counts once it shows as finished, after being seen in play,
  unless it came to the screen finished in a refusal (`endedElsewhere` in
  useGame: the 24-hour rule, or an end elsewhere). It no longer needs a
  pop, top or cash-out beat, which goes back to idle after 1.5 s: a round
  whose last answer was lost could be missed for good.
- A round that leaves the screen before its end shows (its answer lost
  twice, then the catch-up finds no round in play) is counted from its
  line in the history list, unless the line shows the 24-hour rule (a
  refund, or a round that lasted a day). Live stats and the session net
  agreed to the cent after both lost-answer cases, played on the server.
- Upright phone: during a round or auto-play the strip is left out (the
  round panel needs all the room), and the button now says so: unlit,
  unavailable, "Live stats after this round". Before, a tap lit it and
  showed nothing.
- Upright phone: the strip has a fixed height and the line takes what the
  figures leave, so six-figure amounts no longer push Bet off the screen.
- Computer: with the card open the layout is a grid; the controls keep
  their own height and the card takes the room left. Before, a fixed card
  cut the Manual/Auto toggle at 1024x560, and the auto form with three
  balloons at 1440x730, 1280x720 and 1024x768. No card under 600px tall.
- The small chart shows no "$0.00" twice and no lone dot before a round.

What went wrong, and how it was caught:
- The beat rule was the first version's own choice; the money review
  found the 1.5 s gap by feeding a held round through `shownRound` by hand.
  Tests now run `shownRound` into `watchShown` for that case.
- The auto form with three balloons being cut was wider than the review
  said: found by measuring every control against the controls card at
  eight window sizes in four panel states.
- The `live-stats` server still serves the API only, so the live checks
  ran in a headless Chrome with no port, the page files served from
  `apps/web/dist` and every /api call going to that server.
## 2026-11-20: the hose falls as one line, pops leave nothing, start fixes

Three requests from the user, then the coordinator's live check of the
start animation.

- "make it after you cash out. The pipe will also fall into the same
  position as it would if it would break": after a cash-out the hose now
  falls to the floor like after a pop (it used to curl back to the pump),
  so every new balloon starts on the floor and its first pump lifts it.
- "I don't like the torn rubber bits on the hose nor them on the floor.
  Just make it pop like blast into oblivion", then "gray into shards and
  then floats down": the torn neck and the floor bits are gone from the
  art. The grey shards fly out, float down and fade (900 ms). A popped
  and a cashed-out pump now end as the same picture; the label under the
  balloon says which it was.
- "It falls and then when it hits the floor it crumples. It's not fluid":
  the fall was the standing hose turned over as a stiff piece and swapped
  for the lying shape as it landed. Now the hose line itself bends, frame
  by frame (`balloon/hoseShape.ts`, drawn by `useHoseMotion` in
  Balloon.tsx): at each moment it is the standing hose turned partway
  around the nozzle, blended more and more into the lying shape and kept
  above the floor. Safari (iPhones included) cannot animate a path's
  shape in CSS, so this is done in code; it works everywhere. The air
  pocket's lines are hose lines too, so the pocket runs along whatever
  shape the hose has, and the fitting and the flat balloon ride its end.

The live check found, and this fixes:
- (blocker) the bet's set-up replayed on the second pump, because
  data-setup stayed for the balloon's whole life. It now ends at the
  first answer.
- the lift replayed after a reload or a return from another page. It now
  plays only when this screen sees the first pump hold (`useFirstLift`).
- a quick next pump or cash-out cut the lift short with a jump. The lift
  is now kept for its whole length (FIRST_LIFT_MS, 900 ms) whatever comes
  next, and runs on layers nothing else moves (the blow-up on the grow
  layer's own scale, the view on the scene).
- with motion off a first-pump pop showed a blown-up balloon for 200 ms;
  a 24-hour refund jumped to a blown-up balloon on a standing hose. Both
  now stay flat on the floor ("floor-void" for the refund).
- smaller: the flat balloon now sits on the floor line; no push-in with
  2 or 3 balloons (balloon-app.css); a slot that had no balloon before
  gets the "idle" set-up; with motion off the balloon fades in at once.
- auto-play pumped during the set-up: `SET_UP_MS` (320) is exported from
  game/setUp.ts for the auto-bet branch to wait out.

Checked in headless Chrome against the branch's own server (the session's
browser pane was hidden, so it would not draw): two rounds on Easy and
four on Expert, every frame recorded. The set-up never ran after a first
answer; the lift ran once per first pump and cleared after about 900 ms;
the hose moved in 12 to 18 frames per fall or lift, ending exactly in
the lying or standing shape; the cash-out fall waited for the release.
Tests now pin the unhappy paths too (findings 1 to 3).

## 2026-11-20: the balloon grows more in its early pumps

"We have a lot of space at the top. Zoom out, the balloon needs to grow
more" (relayed from the layout chat). The picture already had the whole
stage height; the size curve was the limit. The layout chat suggested
0.45 + 0.55 * p^0.4, but on its own that broke the floor under late pumps
(a test from an earlier fix: no pump may grow the balloon by less than
half an even share; p^0.4 gives 0.40 at the top). The approved blend,
0.45 + 0.55 * (0.2p + 0.8p^0.4), keeps 0.52 there and most of the early
growth: Easy 0.56 / 0.63 / 0.68 / 0.76 after 1 / 3 / 5 / 10 pumps (was
0.51 / 0.56 / 0.60 / 0.69), Expert 0.64 after one. Full size is still
the top rung only, so the biggest balloon, its top at y = 22 and three
balloons side by side at their biggest are unchanged.

## 2026-11-21: the balloon points out of the nozzle; the re-check's fixes

"make baloon in direction of nozzle": the small flat balloon now comes
straight out of the hose's end, in line with it, and points left on the
floor. It did not fit where the hose lay (its end at x 47.3 left 2 units
before the 14% line under the push-in, and about 2 before the next pump
with three balloons), so the lying hose now comes off the nozzle in a
small arc and rests flat on the floor out to x 56 (66.6 long; standing
79.2). The coordinator asked whether the length change would look like
a stretch: it did, 76% of it in 3 of 27 frames. hoseAt now scales each
frame to an even share of the length, so no frame carries more than
0.8 units (a test holds it under 2.5 times the even share).

The coordinator's re-check of f1a4fab found two majors, both in the
hose motion: a cash-out during the first pump's lift snapped the hose
upright (the old clean-up drew the old motion's end shape, and the fall
started from there), and turning animations off mid-round left the hose
standing (the clean-up redrew it after React drew the lying one). Every
motion now starts from the pose drawn last (`hoseFrame`), and the
clean-up only stops the frames. Live in headless Chrome: a cash-out 100
ms into the lift turned the hose back to the floor in 34 frames, no step
over 13.8 units; with motion off the hose lay down at once and stayed
down at the next bet.

Minor fixes from the same check: going to the stats or verify page and
back no longer replays the set-up; with motion off the flat balloon
fades; pop shards fly mostly up and down (a third of their old sideways
travel) and fade from early on, so none leaves a phone screen still
showing; the balloon hidden while a new one waits is not drawn at all,
so its sway and strain loops stop. The fitting at the hose's end rests
on the floor too, lifting the very end 1.5 units: dead flat, it poked
1.5 units below the floor line (caught by the floor-line test).
## 2026-11-21: the difficulty on the pump

From the user's competitor notes, item 6: "Level on the pump ... Don't
want red dots, but some small colour that shows the level." Stake puts
four dots on its pump's foot, one red; this is our own take.

What was built:
- Each difficulty has a colour (apps/web/src/game/level.ts, keyed by its
  id; display only, the engine never sees it). Easy is lime #8ac157,
  Medium aqua #74ddee, Hard orchid #d07ed5, Expert gold #f6d156. They were
  picked by measuring how far each is (in OKLab) from every colour that
  already means something here: the win mint, the pop grey, the warning
  orange, the error red and the three balloon colours. Also from each
  other, with colour blindness simulated too. Each is at least 3 to 1
  against the pump's barrel. A difficulty added later still draws, in
  the pump's own light grey, until it is given a colour.
- The pump shows it as thin rings round the foot of its barrel, under
  the number dial: one ring on Easy, up to four on Expert. So the level
  never rests on colour alone. It shows before a bet too, and changes
  with the difficulty switch. Nothing moves; no timing changed.
- The Easy / Medium / Hard / Expert switch has a small dot of the same
  colour under each name, so the player learns which is which.

What turned out wrong, and how it was caught:
- The dot first sat beside the name. On a wide screen those buttons are
  only 70 px wide, and "Medium" wrapped with its dot on a line of its
  own. Caught in a static render of the screen; the dot now sits under
  the name.
- The first gold (#fad779) looked cream next to the pearl balloon's dial
  on a phone with three balloons. Caught in the same render; it is a
  deeper gold now.

Checked in headless Chrome on a static render (react-dom/server and the
real CSS files) at 390 x 844 and 1440 x 900, animations on and off. Not
yet checked on the live server.

## 2026-11-21: the difficulty on the pump, after review

A review of the entry above found four things wrong. All fixed here.

- After the first round, picking another difficulty did not change the
  pumps. The stage keeps a finished round's balloons beside the bet panel
  until the next bet, and their pumps showed that round's level. So "it
  changes with the difficulty switch" held only before the first bet of a
  visit. Caught by building the real app with the demo client and playing
  a round in headless Chrome; the tests had only rendered the cards on
  their own. Now, once a round is over, its pumps show the difficulty
  picked for the next round (game/level.ts, stageLevelId); while it runs,
  its own. One catch to know: the finished round's step row still shows
  the ladder it was played on, so for a moment the rings and that row can
  name different levels.
- On short screens (buttons 30 px tall) the dot under "Easy" and "Expert"
  touched the "y" and the "p". It was placed a fixed gap from the button's
  bottom. Now the name and the dot are stacked and centred together:
  about 3.5 px apart at 320 to 1440 px wide, buttons no taller. Caught by
  measuring the letters against the dot at 360 x 640; the first check had
  used only 390 x 844 and 1440 x 900.
- Expert's gold #f6d156 looked too like the sand and orange steps the page
  keeps for the pop chance (OKLab distance 6 to 8). The colour test only
  compared exact hex codes, so it could not catch that. It now measures
  how different colours look, against every colour with a meaning (pop
  chance included, at least 9 apart) and between the levels (at least 12).
  Expert is a soft lemon now, #dee053.
- The code said the four colours differ in lightness. Medium and Expert do
  not, and with red-green colour blindness Easy and Expert look alike, and
  so do Medium and Hard. The ring count (1 to 4) is what tells every
  player the level; the comment now says so.

Still for the user to judge: Easy's lime is the closest of the four to the
win mint (OKLab 10.4). On an Easy cash-out its one thin ring sits under
the mint "Paid" line. If it reads as a win, Easy needs a new colour.
## 2026-11-21: Bet and Pump in one spot

The user: "Bet and pump must be on top of each other". The player presses
Bet and keeps pressing in the same place to pump.

Built on `bet-pump-spot`:

- The round panel now starts with the big button (Pump, or Pump all with
  two or three balloons) in exactly the Bet button's box. Under it Cash
  out | Patch + Pump, then Cash out all, then the numbers. Patch + Pump
  keeps its filled panel, tape icon and stitches; with three buttons in a
  row it sits between the two outline Cash outs.
- Auto-play: the progress line moved under Stop, so Stop sits where
  Start auto-play was.
- A guard (`BET_GUARD_MS` = 350 in game/controls.ts, tested as a pure
  `pressGuard`): the button that appears in that spot ignores any press
  that began before it appeared or less than 350 ms after. It is on the
  big Pump (so the second tap of a double-tap on Bet never pumps) and on
  Bet and Start auto-play (so a quick tap on Pump as the balloon pops
  never places a bet). Stop has none: stopping always works at once.
  (Changed in the re-check below: Stop has it too.)
  Enter still bets and Space still pumps, so the keys can't double up.
- BetPanel.tsx and AutoPlayPanel.tsx changed by one tag each
  (`<button>` to `<GuardedButton>`) plus its import; nothing else there.

What turned out wrong, and how it was caught:

- Moving only the button was not enough: on a phone the sheet's handle
  is hidden in a round, which put Pump 9 px above where Bet was. Caught
  by measuring both boxes; the handle now keeps its place, hidden.
- Cash out all on a row of its own does not fit the phone's round room
  (192 px): the page scrolled. It joins the Cash out and Patch + Pump row
  on upright screens only. The first try also left 10 px between Pump and
  the row, 1 px too many at 192 px; the buttons are back in one grid with
  6 px between them.
- At 320 px wide with three balloons, "Patch + Pump" wrapped and "$1,090.00"
  ran into the button's edge. A narrow Patch + Pump drops its colour dot
  and uses 11 px text; the cash-out amounts shrink to fit by length, as
  the Patch price already did.
- Found while planning, not in the brief: the same spot works both ways.
  Without a guard on Bet, quick Pump taps as the balloon pops would land
  on Bet and start a new round.

Checked: the panel and stage rendered statically (renderToStaticMarkup
with the real CSS) and measured in headless Chrome at 1440x900, 1280x720,
1024x768, 390x844, 375x667, 430x932, 320x568, 768x1024, 667x375 and
640x360, with 1, 2 and 3 balloons and $1 and $1,000 bets. In all 60
bet/round pairs the big button's box is the same as Bet's (0 px apart),
the stage is the same in both states, nothing scrolls and no button's
text spills. Start and Stop: the same box in all 30 pairs.

Not checked: the live game (no server was free). The guard's timing with
real taps on a phone, the round's answer time on Render, and Safari or a
real iPhone (`:has()`, container queries and event time stamps).

### Re-check fixes (Bet and Pump in one spot)

A review drove the real panels in headless Chrome with real mouse and
touch events. Two holes in the guard, both fixed on `bet-pump-spot`:

- Start auto-play stays in the page, hidden, while a round is finished by
  hand after Stop (so the typed settings are kept). Its guard started when
  it was put in the page, not when it could be seen. When the last
  balloon popped, Start showed up in Pump's place with its guard long
  over, and a quick extra tap on Pump started a new run of 10 rounds.
  Now every guarded button watches its own box (`useShownGuard`, with
  ResizeObserver) and starts its guard when it goes from hidden to seen.
- Stop sits in Start's box and had no guard, so a double-click on Start
  stopped the run at once and left one bet in a round to finish by hand.
  Stop now has the same guard; Esc still stops at once. The first try
  failed in the harness: Start and Stop were the same kind of button in
  the same place, so React kept one button and its old guard. Each now
  has its own key.
- No test failed if a guard was taken off a button. What the buttons do
  with each event now lives in plain functions in game/controls.ts
  (tested directly), and guarded buttons carry `data-guard-ms`, which
  the tests look for on Pump, Bet, Start and Stop. Checked by taking each
  guard off in turn: a test failed every time.
- Fixed a stale comment on Cash out all, and the count above (60
  bet/round pairs, not 90).

Checked again in the static harness: the 16 tap and key cases (double
tap on Bet, hold from Bet, tap as the balloon pops, Stop mid-round then
finish by hand, double-click on Start, Enter on a focused Stop, touch on
a phone) all behave, and the 60 bet/round pairs at ten sizes still give
the same boxes for Bet, Pump, Start and Stop and the same stage.

Not checked: the live game, real phones, Safari (ResizeObserver timing
there), and that `useShownGuard` really calls watchShown (only the
harness shows that; there is no DOM in the tests).

## 2026-11-21: d35abe8 deployed to the live site

The compile chat called main final at d35abe8 (without the public-wins
screen, on the user's word). Checks were kept light at the user's request
("Do minimal testing"): `npm run typecheck` and `npm run build` here, then
GitHub's own check on the push (green, 1m 5s) before any deploy.

- Render: Manual Deploy > Deploy latest commit. Live 40 seconds after the
  click. The log said `opened the existing file, 6 players`, so no wallet was
  lost, and `public wins: OFF` as `render.yaml` intends.
- This deploy ran database steps 2 and 3 on the live database. They are
  one-way: nothing older than d35abe8 may be deployed there again. The user
  was told this before the deploy.
- On the live site: the page's script and style files have the same names as
  the local build of d35abe8; `/api/wins` and `/api/settings` now answer
  (before: 404). A new test player set a client seed, bet 10 cents on Easy,
  pumped once (survived), cashed out 10 cents and got the after-round reveal;
  the balance came back to 1,000,000 cents.

Turned out wrong: my first test round reused an idempotency key, because
`$RANDOM` inside a zsh `$(...)` gives the same number each time. The server
rightly refused it as `key_reused`. Fixed by using `uuidgen` for keys.

## 2026-11-21: the stage follows the settings at once

The user: "make it when you switch in setting to 3 pumps or other
difficulty it instantly changes to them on the screen."

Why it did not: the stage showed the next round's set-up only when there
had never been a round. After the first round it kept that round's
balloons until the next bet, so picking 3 balloons or another difficulty
changed nothing on screen. Only the pump's colour followed (stageLevelId),
and the step row still showed the old ladder.

Built on `claude/competent-jemison-9d0e5b` (the fix is 95512e2, first
made on `claude/instant-settings-7f5ff1`), screen only:

- `game/stage.ts`, `stageRound`: a round in play always stays on the
  stage. A round that is over stays until the bet panel picks another
  number of balloons or another difficulty; then the set-up shows at once
  (pumps, level rings, step row of that ladder, each bet's top). Bet
  amounts alone do not swap it.
- Picking the round's own set-up again (say 3, then back to 1) brings the
  finished round and its Net back. A choice, not an accident: the stage is
  worked out from the round and the panel, with nothing to keep in step.
- The next round's set-up starts from empty pumps when the set-up was on
  screen, not from the old round's ends, which were no longer shown.
- `stageLevelId` is gone: a finished round now shows only while its own
  difficulty is picked, so it had nothing left to do.
- Test: `apps/web/test/stagePreview.test.ts`.

Checked in the browser against a local server built from the branch, at
1440 x 900 and 390 x 844, with 1 and 3 balloons and all four
difficulties: every click changed the stage before the next frame and
sent no request. A 3-balloon round started from the set-up hid the bet
panel until it was over.

Turned out wrong, in my checks, not the game: my first read of the page
came straight after the click and saw no change. React applies a click's
change a moment later (still before the next frame), so the check now
waits that moment and also proves no frame passed. And two clicks fired
by script in the same moment use the old settings for the second one, as
React has not drawn between them; a real player cannot click that fast.

Not checked: real phones, Safari, the live site.

## 2026-11-21: auto-play's target, easy to change

The user: "make it easy to change the target multiplier", then "Make it
flow like when you change pumps or dificulties". Asked how, they picked
− and + buttons. Built on `auto-target-steps`, screen only:

- The auto-play panel's Pumps box is now a Target row like a bet row: the
  box shows the multiplier the target reaches (big) and the pump count
  (still typed; ↑ and ↓ step it too), with − and + beside it. Each moves
  one step along the ladder. + stops at the top the bets can reach; a
  count typed past it comes back to the top on − (`game/targetSteps.ts`).
  A topped-out target shows the top's multiplier in the warning colour.
- The target sits first in the form (it changes most), Rounds under it,
  the two stops side by side under that. The old line under the Pumps
  box is gone; the box says it all now.
- The flow: the target is kept by the game screen, not the panel, so the
  stage follows it at once. On the Auto tab each balloon's row of steps
  rings the target step in that balloon's colour and slides to it with
  each − or +. While auto-play runs, the target its balloons play to stays
  ringed (the row still follows the balloon). On a phone with two or
  three balloons there is no row, so nothing shows there.
- Tests: `apps/web/test/autoTarget.test.ts`; the old Pumps-line tests now
  check the box.

Checked lightly at the user's word ("you dont need to test everything so
thorouhly"): typecheck, lint, web tests, and one look in the browser at
1440 x 900 (3 balloons) and 390 x 844 (1 balloon).

Not checked: a full auto-play run with the target ringed, real phones,
Safari, the live site.

## 2026-11-21: the last balloon keeps its own Pump

The user, with a phone screenshot of the last balloon in play showing no
button: "currently disapears after other two pumps are broken". It was on
purpose: `showOwnPump` gave a balloon its own Pump only while two or more
were in play, so the button left from under the player's finger.

Now, in a round of two or three, every balloon keeps its own Pump (with
"next ×.××" in it) until that balloon ends, the last one included. A round
of one still has only the panel's big Pump. The big button still turns
from Pump all to plain Pump when one balloon is left. Branch
`last-balloon-pump`; comments and the `showOwnPump` test updated.

Checked lightly: typecheck, lint, web tests (one run stalled for four
minutes and failed three tests by time; a clean re-run passed all 536),
and one look at 390 x 844 with 3 balloons on Expert after two popped.

## 2026-11-21: 21fffd3 deployed to the live site

Six screen-only commits since d35abe8 (the stage follows the settings at
once, the auto-play Target − / +, the last balloon keeps its own Pump, and
the deploy worklog). Nothing under `apps/server`, `packages` or
`render.yaml` changed, so no database step ran. Same light checks as
before: typecheck and build here, GitHub's check green, then Manual Deploy >
Deploy latest commit. Live 41 seconds later; the page serves the new
build's files and the log says `opened the existing file, 7 players`.

## 2026-11-21: the stage flows into a new set-up

The user: "Make it flow better. Like flow into 3 pumps." (relayed by the
deploy chat). Before a round, picking another number of balloons or
difficulty used to cut straight to the new stage.

Built on `stage-flow` (`apps/web/src/stageFlow.ts`, `flow.css`):

- Each pump and the line under it glide from where they were to their
  new place, 320 ms, the step row's own calm curve, no bounce. A new
  balloon's slot rises in; one that goes sinks away (an inert copy in a
  layer over the slots, cleared after). A typed bet just changes.
- The page itself changes at once; only the pieces move back and glide.
  So a click mid-way never meets a half-drawn stage: it measures the
  pieces where they are and glides on from there.
- Animations off (the player's setting, or the device's reduced motion):
  nothing moves, as before. Starting a round and the round itself are
  untouched.
- Not done: the rings fading to a new difficulty's colour. balloon.css
  says the rings are "Never animated", so they still change at once
  (the pump under them glides). One CSS line if the user wants it.

Turned out wrong: the first build used the browser's view transitions.
They glide nicely, but while one runs every tap lands on the page itself,
not on a button (`elementFromPoint` gave HTML mid-way, even with
`pointer-events: none` on the transition layer), so a quick Bet or second
click after a switch would be lost for 320 ms. Replaced with Web
Animations on the real elements; a tap mid-glide now reaches its button.
Also: the browser pane was hidden, so no frames ran and copies of gone
slots stayed until their finish event; they now also clear on a timer.

Checked lightly: typecheck, lint, web tests (36 files, 541). In the
browser the pane was hidden, so the glide was stepped by hand: at
1440 x 900 pump 1 starts exactly where it was and ends in its new place,
new slots fade in from 0, two copies sink and clear on 3 to 1, and with
Animations off nothing moves. At 390 x 844 a picture halfway through 1 to
3 shows pump 1 shrinking left with its line, pumps 2 and 3 rising in.
Not seen running at full speed on a screen, nor on a real phone or Safari.

## 2026-11-21: c416258 deployed to the live site

The stage glide (a new balloon count or difficulty glides into place before
a round), three screen-only commits since 21fffd3. Typecheck and build here,
GitHub's check green, Manual Deploy > Deploy latest commit; live 50 seconds
later, serving the new build's files, and the log says `opened the existing
file, 7 players`. The difficulty rings stay instant: the user chose "Keep
them instant".

## 2026-11-21: public wins on the screen (branch public-wins-screen)

Built the screen half of the public wins; the server half was already in.
- Client: `getPublicWins`, `getSettings` and `setSettings` on GameClient,
  the HttpClient and the demo. `/api/wins` goes out at once (it needs no
  player); the settings go as the player, the PUT with its
  Idempotency-Key and only `winsPrivate` in the body. The demo lists its
  own player's wins and hides them while private.
- Panel (`apps/web/src/wins/`): a "Wins" heading, three tabs (Recent,
  Biggest, Lucky; arrow keys, Home, End) and one table: player tag,
  difficulty (config label, else the id), bet, multiplier, payout, gain.
  The payout column drops out on a card under 480px. Mint only on the
  gain. No live region. Nothing at all while the server says off.
- Where: at the very end of the page. Computer: a card under the game;
  the page now scrolls down to it, and the top bar and layout are still
  exactly one screen (svh), so the game keeps its size and place.
  Upright: the sheet's last part; its end is a third resting place, the
  two sheet places are where they were. During play on an upright or a
  touch screen it is hidden, so a round stays one screen that never
  scrolls and a drag on a held Pump cannot scroll the page.
- When it asks (`wins/polling.ts`, pure): once at page load; never again
  in that page if off; otherwise only while on screen with the tab in
  front, every 10 s, or 5 s after the last request when something new is
  wanted (it came into view, the tab came back, a round of the player's
  ended, the private switch changed). Never two within 5 s.
- Settings: "Keep my wins private", read when the menu opens, saved per
  press, a plain message on failure.

Measured in my own headless Chrome (stage, slots, controls, top bar, before
and after, at the top and with the sheet up): the same to the pixel at
1440x900, 1024x768, 390x844 and 375x667. Live, against the worktree's
server: one request in 22 s with the panel out of sight, then 0/10/10 s on
screen, none while the tab was hidden, one at once when it came back; my
round's end brought the next refresh 5 s after the last instead of 10.
Private on: my rows left the list 1.3 s after the press; off again: back
at the next refresh, 4 s later. With the answer replaced by "off": no
panel, one request per load, the page exactly as before.

What went wrong, and how it was caught:
- On a computer the card starts exactly at the screen's bottom edge, and
  an IntersectionObserver counts a box that only touches the edge as on
  screen, so it would have polled out of sight. Seen in the measurements
  (card top 900 at 900 high) before the polling check; the observer's
  root is now cut by a pixel, and the live check confirmed it.
- My headless driver kept touch emulation on after a phone size, so a
  1440x900 round showed the card hidden (pointer: coarse). Caught because
  the check printed the media query; the driver now turns touch off.
- The browser pane reset its size mid-measurement when its width changed,
  so every live check ran in an own headless Chrome instead.

## 2026-11-21: public wins, fixes after the review (branch public-wins-screen)

Fixed what the review of the public wins screen found:
- Phones: a quick flick up from sheet down flew past the bet panel to the
  end of the wins table. The whole app is a snap area and its end is the
  wins' end, so scroll-snap-stop could not stop it. Now the wins wait off
  the page while the sheet is down and join it once the page rests with
  the sheet up (`wins/sheetFirst.ts`, pure rule tested). Every flick and
  slow drag from sheet down rests at sheet up, a second one goes on to the
  wins; most flicks back down stop at sheet up (scroll-snap-stop on the
  sheet), hard ones go to the top.
- Computer: the page shows no scrollbar while the wins are on it, so
  where scrollbars take room the game no longer gets 15px narrower when
  the wins arrive. The top bar is sticky there, with the page's sky fixed
  behind it, so the balance and settings stay in reach.
- A wide table now scrolls inside its card (the card's grid column could
  grow past the card); long difficulty names are cut.
- The panel itself shows nothing for an off answer, with a test (the only
  guard was in an effect no test ran).
- The multiplier column is "Best ×": a round's best balloon, so Bet times
  it is not the payout with two or three balloons.
- Settings row: its rule is a pure reducer with tests (never shows a value
  the server did not send); no switch role before the value is known;
  busy only while a request is on its way; the failure line lines up.
- Polling uses performance.now(), so a clock jump does not stall it.

Left as built, for the user: with a mouse the page can still scroll down
to the wins during a round (the top comment of styles.css now says so).

Checked live in my own headless Chrome at pwfix.localhost:3220: touch
flicks at 390x844 and 375x667 (135/543 and 113/517), forced 15px
scrollbars at 1440x900 and 1024x768 (page width and game rects the same
as with the wins off), the top bar's pixels at the top of the page (at
most 1 of 255 off, the same noise a scrollable page has without the
sticky bar), a 320x568 table, a forced 500 on the settings read and save.

What went wrong, and how it was caught:
- Staging one CSS file by hunks with no context put the sheet-down rule
  after the file's last block in the first commit. Caught by reading the
  diff left after that commit; the next commit moves it back. Later
  commits were staged from whole files.
- Moving the "page start" snap from the app to the sticky top bar was
  tried and dropped: Chrome then let the page rest anywhere.

## 2026-11-21: the compile, overnight

The coordinator ("Agents finishing and game compilation") merged the
user's competitor to-do list into one game. Into main, in this order:
auto-bet, the step-row follow-ups, live stats, the public-wins server
half (with "Keep my wins private", database step 3), the start
animation (flat balloon on the floor until the first pump, the nozzle
fix, the bigger early balloon), the level colour on the pump, Bet and
Pump in one spot, and the public-wins screen. Three later user asks
from other chats came in between: the stage following the settings at
once, auto-play's Target − / +, the last balloon keeping its own Pump,
and the stage glide. Each piece had its own review before it landed.

Built here, in the compile copy:
- The bet box's "Top" label moved under the box. In the box it squeezed
  the input until a $1,000 bet read as "$ 100" (found by the auto-bet
  fixer; it was already on main).
- During auto-play the hand Cash out buttons say "after pump" instead of
  an amount that was usually one step behind what the press paid.
- Auto-play's first press of a round waits for the set-up (SET_UP_MS).
- README: one list of every feature switch.
- The public wins hide during a round on every screen, not only on
  phones, so a round is always one screen (decided without the user).

What went wrong, and how it was caught:
- A formatter with default settings was run on a merge and rewrapped
  hundreds of unrelated lines in App.tsx. Caught by the merge's diff
  size (673 lines for a 2-line change); the files were put back with
  only the merge's real changes, as a new commit.
- A test server kept running old server code after a merge (tsx does not
  reload), so a live check of the wins panel first saw nothing (the
  endpoint answered 404). Caught by asking the endpoint directly; the
  server was restarted.
- With load averages up to 100 from many chats at once, heavy tests (the
  math sweeps, the roll count, the Python reference) timed out. Each
  passed when run alone; they are timeouts, not failures.
- The Mac slept for about two hours overnight and stalled three
  builders; they restarted on their own.

## 2026-11-21: 21841cf deployed to the live site

The public-wins screen and the "Keep my wins private" switch, with public
wins left off (the user: "Deploy, wins hidden"). Nineteen screen-only
commits since c416258. Typecheck and build here, GitHub's check green,
Manual Deploy > Deploy latest commit; live 41 seconds later, serving the new
build's files. The log says `opened the existing file, 7 players`.
`/api/wins` answers `"enabled": false` and the live page shows no wins lists.

Turned out different from what `render.yaml` suggests: the log says
`PUBLIC_WINS is not set`, although `render.yaml` sets it to "off". Render
did not copy that value onto the service (a Manual Deploy builds the code;
it does not re-read the Blueprint's settings). Off either way today, but
turning the lists on later takes more than editing `render.yaml` and
deploying: the value has to reach the service, through a Blueprint sync or
the service's Environment page. Ask the user before either.
