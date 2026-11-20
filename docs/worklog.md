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
