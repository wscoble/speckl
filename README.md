# Speckl

A compiler for SpeckDL — a specification language for state machines. Write what your system should do. Get TypeScript, Z3 verification output, and provenance artifacts from a single source.

## What It Does

```
.speckdl spec ──→ TypeScript          ← typed, importable state machine classes  ✓ tested
              ├── Z3 SMT-LIB2         ← formal verification (bounded model checking)  ✓ verified in CI
              ├── Rust                ← state machine crate  ✓ cargo check on every example
              ├── Protobuf            ← message definitions  ✓ tested
              ├── K8s CRDs            ← Kubernetes custom resources  ✓ tested
              ├── OpenAPI 3.1         ← REST API surface  ✓ tested
              ├── PROV-O (RDF)         ← W3C provenance standard  ✓ tested
              ├── CycloneDX SBOM       ← OWASP software bill of materials  ✓ tested
              └── SPDX SBOM            ← Linux Foundation SBOM standard  ✓ tested
```

No LLMs in the compilation path. Same spec, same output, every time.

## Install

```bash
npm install -g speckl        # Node.js 20+
speckl --help
speckl spec.speckdl -t all -o out
speckl verify spec.speckdl   # Z3 check of every verify block (needs the z3 binary)
```

Or without installing: `npx speckl spec.speckdl -t agent -o .speckl`.
`speckl-compile` is the same CLI under its older name. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

For agent rails in Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot
CLI, Goose, Hermes Agent, Pi, OpenCode, OpenClaw, Cline, Kiro or Windsurf, see
[docs/harness-adapters.md](docs/harness-adapters.md).

## Verification

The Z3 backend emits SMT-LIB2 with bounded model checking, and `npm run verify` (also the CI job) runs a **real Z3 solver** over every example spec:

```bash
cd compiler
npm run build
npm run verify          # compiles examples, runs z3, checks solver results
```

Installed from npm, the same verifier runs on your own specs: `speckl verify <spec.speckdl|dir>`.

Every obligation that is not proven fails the run, with one exception: an
unchecked baseline (`.speckl-unchecked.json`) is read only when you run the
verifier **without spec paths**, over an examples directory: the repository's
`examples/`, or `speckl verify --examples <dir>` (also `SPECKL_EXAMPLES`).
Obligations listed there are reported as UNCHECKED, never as passed, and an
entry that is now proven or no longer exists fails as stale. Named specs or
directories (`speckl verify spec.speckdl`, `speckl verify specs/`) get no
baseline, so any UNCHECKED obligation fails. An npm install does not ship
`examples/`, so use `--examples <dir>` to verify a directory against its own
baseline.

Each generated `.smt2` file carries a `; speckl-expect:` marker declaring what the solver should return. When a property is violated, the verifier renders a human-readable counterexample — a per-step state trace from the solver model. Constructs the translators cannot yet handle are skipped with visible comments rather than emitted as invalid SMT.

Requires the `z3` binary (`pacman -S z3`, `apt-get install z3`, or set `Z3_BIN`).

## Compile tests

Generated code goes through real compilers and validators. `compiler/src/__tests__/compiles-*.test.ts` checks the output for every example:

| Target | Checked with | Toolchain |
|---|---|---|
| TypeScript (`-t typescript`) | `tsc --noEmit --strict` | bundled (dev dependency) |
| Agent rails (`-t agent`) | `tsc --strict` on the machine, `node --check` on the hook scripts | bundled |
| Camel (Java) | `javac --release 21` against Camel 4.8.0 and Jakarta CDI/Inject APIs | JDK 21+, plus pinned jars |
| Go | `go build ./...` (offline) | Go 1.22+ |
| Rust | `cargo check --offline` | Rust toolchain |
| Elm | `elm make` | Elm 0.19.1, plus a cached package set |
| Protobuf | `protoc` | protoc |
| OpenAPI 3.1 | `@apidevtools/swagger-parser` validate | bundled (dev dependency) |
| Kubernetes CRDs | the official Kubernetes v1.31 `apiextensions.k8s.io/v1` schema, strict (unknown fields fail) | bundled ajv, plus the pinned schema |

Third-party inputs are pinned by SHA-256 in `compiler/scripts/fetch-compile-deps.mjs`: the Camel and Jakarta jars, and the Kubernetes schema. `node scripts/fetch-compile-deps.mjs` downloads them once into `compiler/.cache/compile-deps`, or into `$SPECKL_COMPILE_DEPS_DIR` if set. It also fills Elm's package cache (`$ELM_HOME`). The tests themselves never use the network.

- `npm test` runs these tests for every toolchain it finds. A missing toolchain prints a warning, and the test group's name reads `SKIPPED: <reason>`.
- `npm run test:compile` fetches the pinned inputs if they are missing, then runs only the compile tests. Here a missing toolchain is a **failure**. Use it before a release or in CI.

`examples/.speckl-compile-baseline.json` lists the examples whose output does not compile yet for each target, each with its first compiler error. A listed example must keep failing, so a fix has to delete its entry. An unlisted example must compile.

## Quick Start

```bash
git clone https://github.com/wscoble/speckl.git
cd speckl/compiler
npm install
npm test

# Compile a spec
node dist/index.js ../examples/ToggleSwitch.speckdl -o out/switch
ls out/switch/
```

## Examples

Formal methods specs from a toggle switch through Raft consensus:

| Example | What it demonstrates |
|---------|----------------------|
| ToggleSwitch | Basic states, actions, invariants |
| AccountLedger | Banking ledger with debit/credit |
| TwoPhaseCommit | Distributed transaction coordinator |
| Paxos | Consensus with 3 safety invariants |
| Raft | Leader election, log replication |
| KafkaKRaft | KRaft consensus with Z3 verification |
| TigerBeetleLedger | Financial ledger (ports TigerBeetle core) |
| OAuth2AuthorizationCode | OAuth 2.0 flow with PKCE |
| RetryHandler | Error handling with backoff |
| SQLitePager | SQLite page cache state machine |
| SQLiteWAL | SQLite write-ahead log |
| tef | Complex product spec with K8s CRDs |
| ReviewGate | `next:` BMC + can()/serialize()/restore() |
| AgentPolicy | agent { } → AGENTS.md, tools, hooks, HITL/HNTL signals |

Browse all in [examples/](examples/).

## Documentation

- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [Agent targets](docs/agent-targets.md) — `agent { }` → AGENTS.md, tools.json, generic hook
- [Agent signals](docs/agent-signals.md) — HITL/HNTL verified signals (signed file-drop with pinned signers, optional call-bound sign-off, plug-ins; CLI is dev-only)
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics

## Status

- About 700 vitest tests (run `npm test` for the current count). The real-solver Z3 cases run when `z3` is installed. `npm run coverage` enforces a floor of 88% lines/statements, 86% branches and 97% functions.
- Compile tests run against every example (see [Compile tests](#compile-tests)). Camel, Rust and Kubernetes CRDs pass for all 16 examples. The other targets have known failures recorded in `examples/.speckl-compile-baseline.json`.
- `npm run verify` compiles every example and checks it with Z3. Today: 48 of 79 checks pass, 0 fail, and 31 unproven obligations are acknowledged in the baseline (see below).
- CI (`.github/workflows/ci.yml`) runs on GitHub-hosted `ubuntu-latest` and has two jobs:
  - **build-and-test:** build, `tsc --noEmit`, `npm test`, `npm run verify` against a pinned z3 release, and coverage with the floors above.
  - **compile-targets:** installs JDK 21, Go 1.23, stable Rust, protoc and Elm 0.19.1, then runs `npm run test:compile`.
- Tested backends: TypeScript, Z3, Protobuf, K8s CRDs, OpenAPI, CycloneDX, SPDX, PROV-O, Rust, Camel
- Round-trip property tested: parse → print → parse is identity for all examples
- Known limitation: BMC over invariants using post-state notation (`x'`) degrades to a consistency check; quantifier sugar (`forall x in coll:`) is not yet lowered to Z3 — such constraints are skipped with visible comments
- Verification fails closed: a verify block that is skipped, degraded or not lowered is reported UNCHECKED, never passed. Today 3 of 34 example verify blocks are proven (AgentPolicy ×2, ReviewGate); the other 31 are listed in `examples/.speckl-unchecked.json`
- TLA+ models: Two-Phase Commit, Paxos, and Raft are ported as `.speckdl` specs (inspired by the original TLA+ models, not TLA+ output)

## License

MIT