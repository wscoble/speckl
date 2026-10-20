import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Measured source: the compiler (src/) and the verifier's shared
      // helpers (scripts/lib/), which tests import in-process.
      include: ['src/**/*.ts', 'scripts/lib/**/*.mjs'],
      exclude: [
        // Tests and their helpers/fixtures are not product code.
        'src/**/__tests__/**',
      ],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
