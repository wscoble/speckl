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
        // Verbatim copy of the line walker. parseSpeck does not call it.
        // line-walker-copy.test.ts checks it against the live parser.
        'src/line-walker/**',
        // The token parser is not called until the swap. The swap PR removes
        // these two lines, and its tests cover the files.
        'src/rd-parser.ts',
        'src/speck-span.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      // Floor at the level reached in fix/coverage (rounded down), so a drop
      // fails `npm run coverage`. Raise it as coverage improves; never lower
      // it to make a change pass.
      thresholds: {
        lines: 88,
        statements: 88,
        branches: 86,
        functions: 97,
      },
    },
  },
});
