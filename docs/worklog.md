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

Left open, all in the screen and handed to its chat: a round closed by
the 24-hour rule shows a refunded bet as lost; "next round uses nonce N"
does not move after a round; the screen does not start over by itself
after a lost session; before a bet the screen shows the RTP and ladders
from its own build, not from the server.

Note for later: migration 1 was edited in place to add the cap column.
That was safe only because no database existed anywhere. Once a live
site has a database, schema changes must be new migration steps.

## 2026-11-20: pumps on the floor, bigger pictures on phones (branch `one-screen-layout`)

Two fixes to the game screen after a hostile review, both CSS, both in the
stage and background rules only. On the branch `one-screen-layout`; not in
main until the user says so.

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
