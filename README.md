# Pump

A provably fair balloon game: a pure game engine, a server with a SQLite
wallet around it, and a React frontend.

The game itself is not built yet. This is the project skeleton.

## Run it locally

You need Node 26 (see `.nvmrc`).

```bash
npm install
npm run dev:server   # API on http://localhost:3000
npm run dev:web      # frontend on http://localhost:5173, forwards /api to the server
```

## Scripts

All of these run from the repo root.

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm test`          | Runs every test with Vitest                               |
| `npm run lint`      | ESLint; `any` is an error                                 |
| `npm run typecheck` | Strict TypeScript over every package                      |
| `npm run rtp`       | Exact RTP calculation (stub for now, fails on purpose)    |
| `npm run sim`       | Simulator, 10M rounds per difficulty (stub for now)       |
| `npm run hammer`    | Fires overlapping requests at a running server (stub)     |

## Layout

```
packages/engine   game rules, ladder config, RTP calculator, simulator
  src/            pure code: no Node, no DOM, no clock, no Math.random
  src/fair/       seeds to draws; imported as @pump/engine/fair
  cli/            npm run rtp and npm run sim (may use Node)
  test/
apps/server       HTTP API and SQLite; routes -> services -> repositories
  src/
  scripts/        npm run hammer
  test/
apps/web          React + Vite frontend
  src/
```

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
