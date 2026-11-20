import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in a test/ folder next to each package's src/.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
  },
});
