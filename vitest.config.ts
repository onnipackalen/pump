import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in a test/ folder next to each package's src/.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    // Many tests check every legal bet, or every rung at three RTPs. They take
    // a few seconds each, close to vitest's default limit of 5 seconds, and
    // failed by running out of time on a busy computer. A test that really
    // hangs still fails, after a minute.
    testTimeout: 60_000,
  },
});
