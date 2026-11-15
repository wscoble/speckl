# Operating principles

How we judge a change. Numbered so more principles can be added later.

## 1. Beat our last release, not someone else's

Nik Storonsky, co-founder and CEO of Revolut, on David Senra's podcast: "I don't really look at competition. I look at myself. What would I do to beat myself?" Speckl has no relationship with Revolut. The quote is only the idea behind this principle.

Every release is measured against the previous one. These bars can only hold or rise.

- The test suite. `.github/workflows/ci.yml` runs two jobs. `build-and-test` builds, type-checks with `tsc --noEmit`, and runs `npm test`, `npm run verify` (Z3 5.1.0, pinned by SHA-256), and `npm run coverage`. `compile-targets` runs `npm run test:compile` with JDK 21, Go 1.23, stable Rust, protoc 28.3, and Elm 0.19.1. Do not drop or skip a test to ship.
- Coverage floors, set in `compiler/vitest.config.ts` and enforced by `npm run coverage` (Vitest, v8 provider) on `src/**/*.ts` and `scripts/lib/**/*.mjs` under `compiler/`: 88% lines, 88% statements, 86% branches, and 97% functions. Raise a floor when coverage improves. Never lower one so a change passes.
- Verifier soundness. `npm run verify` runs the real Z3 binary. A skipped, degraded, or unlowered obligation is UNCHECKED, never passed. An entry in `examples/.speckl-unchecked.json` that is now proven, or no longer declared, fails as stale. `examples/.speckl-compile-baseline.json` is the same kind of ratchet: a listed example must still fail to compile, and an unlisted one must compile.
- The project's own quality review scores, compared with the last release.

Before shipping, ask how we would break it ourselves, and turn that attack into a test.

Study other tools for ideas. They are never the bar.
