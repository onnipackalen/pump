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
