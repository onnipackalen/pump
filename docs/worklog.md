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
- The purity guards were checked with a throwaway file that imported
  `node:fs` and used `console`, `Math.random`, `Date` and `any`. The compiler
  and the linter rejected all of it. The file was deleted, not committed.
