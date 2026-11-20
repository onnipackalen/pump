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
