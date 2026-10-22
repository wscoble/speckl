import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['index.mjs'],
      reporter: ['text', 'json-summary'],
      // Same floors as the compiler.
      thresholds: { lines: 88, statements: 88, branches: 86, functions: 97 },
    },
  },
});
