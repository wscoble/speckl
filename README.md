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

Speckl is not published to npm. Build it from this repository. `compiler/package.json` `engines` declares Node.js `>=20`. These steps were run on Node 20.20.2 and Node 22.23.4.

```bash
git clone https://github.com/wscoble/speckl.git
cd speckl/compiler
npm ci
npm run build
```

`npm ci` installs the lockfile, including the TypeScript compiler used by `npm run build`. If `NODE_ENV=production`, that compiler is skipped and the build cannot find `tsc`; run `npm ci --include=dev` instead.

Run it from `compiler/`:

```bash
node dist/index.js --help
node dist/index.js ../examples/ToggleSwitch.speckdl -t all -o out
node dist/index.js verify ../examples/ToggleSwitch.speckdl   # Z3 check of every verify block (needs the z3 binary)
node dist/index.js doctor ../examples/ToggleSwitch.speckdl   # imports, domains, act-tool harness maps
```

`speckl` and `speckl-compile` are that same program (`speckl-compile` is the older name). To put both on your `PATH`, pack the checkout and install the tarball into a user prefix. The tarball stays on your machine:

```bash
npm pack
npm install -g --prefix "$HOME/.local" ./speckl-*.tgz
export PATH="$HOME/.local/bin:$PATH"
speckl --help
speckl-compile --help
speckl ../examples/ToggleSwitch.speckdl -t all -o out
speckl verify ../examples/ToggleSwitch.speckdl
```

Add `$HOME/.local/bin` to your shell profile if you want the commands in new terminals. `npm pack` writes `speckl-<version>.tgz` in `compiler/`; delete it when you are done. `speckl verify` needs the `z3` binary (`pacman -S z3`, `apt-get install z3`, or set `Z3_BIN`).

The packed `speckl` does not include `examples/`. `speckl verify` with no spec paths looks for that directory next to the installed package and fails. Pass a spec file or directory, or `--examples <dir>` to use that directory's `.speckl-unchecked.json`. In a checkout, `node dist/index.js verify` with no paths uses this repository's `examples/`.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

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

After the build in [Install](#install), the same verifier runs on your own specs: `node dist/index.js verify <spec.speckdl|dir>`, or `speckl verify <spec.speckdl|dir>` once `speckl` is on your `PATH`.

Every obligation that is not proven fails the run, with one exception: an
unchecked baseline (`.speckl-unchecked.json`) is read only when you run the
verifier **without spec paths**, over an examples directory: the repository's
`examples/`, or `speckl verify --examples <dir>` (also `SPECKL_EXAMPLES`).
Obligations listed there are reported as UNCHECKED, never as passed, and an
entry that is now proven or no longer exists fails as stale. Named specs or
directories (`speckl verify spec.speckdl`, `speckl verify specs/`) get no
baseline, so any UNCHECKED obligation fails. A checkout includes `examples/`,
so `node dist/index.js verify` with no paths uses that directory. The packed
`speckl` command does not include it: with no spec paths it cannot find the
directory. Pass a spec, or `--examples <dir>`, to verify a directory against
its own baseline.

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
npm ci
npm run build
npm test

# Same compiler as in Install
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
| DeployGate | Call-bound sign-off: `bind call on approve` covers one exact deploy, once |

Browse all in [examples/](examples/).

## Imports and domains

A file can `import` another SpeckDL file. The path is resolved from the
directory of the file that writes the import, including imports inside a
file that was itself imported. The compiler reads it, lowers it, and merges
its specks into the compilation. A missing file, an import cycle, a hash
mismatch, an empty hash, a file that declares no specks and no domains, or
the same speck name in two files is a compile error, and the message names
the file. `hash "SHA256:..."` and `hash "sha256:..."` are the same check.

```
import "ledger.speckdl" as ledger version "1.2.0" hash "sha256:..."

domain Billing {
    members: Invoice, Ledger;
    language: "An invoice is issued before a ledger posts it";
}
```

A `domain` groups specks into a bounded context. Each member is still one
speck (and at most one agent). The IR records an `IRDomain`. Provenance
adds a `prov:Collection` whose `prov:hadMember` links those specks. A
duplicate member, or a speck in two domains, is a compile error. A domain
declared in an imported file comes in with that file, and its members
cannot be claimed again by a domain in the importer.

`speckl doctor <file>` fails when a domain member declares an `act` tool
that its harness blocks do not map. That is separate from the adapter
`doctor` probe, which runs an installed hook.

**Not yet implemented:** a package registry for `version` pins (the pin is
stored, and `hash` is checked); rewriting expressions that name an imported
speck; `consumes` / `produces` contracts, per-action cost, and a domain
budget; runtime routing between domains.

## Documentation

- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [Agent targets](docs/agent-targets.md) — `agent { }` → AGENTS.md, tools.json, generic hook
- [Agent signals](docs/agent-signals.md) — HITL/HNTL verified signals (signed file-drop with pinned signers, optional call-bound sign-off, plug-ins; CLI is dev-only)
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics, including `import` and `domain`

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