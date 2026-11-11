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
| PodcastPublishing | Host-approved metadata automation (HITL await); [README](examples/PodcastPublishing.md) |

Browse all in [examples/](examples/).

## Brace scan

The parser counts `{` and `}` and skips a brace inside a finished `"` string, a `//` comment, or a `/* */` comment. That brace cannot end a speck, a member, an `if`, or a `for`. The same skip covers agent advisory strings (`instruction`, `prompt tool`, and `tool … description`), so a brace in that text does not end the agent block. A brace in a comment or a string does not hide the next speck. A one-line action closes on the structural `}` of its header line, so a trailing `// }` is not a brace and does not take the next action's statements. The same skip is used when Go emits an `if` or a `for`.

`'` is post-state prime notation, not a string quote. A block comment may continue onto the next line, including one that opens on a speck's closing line and closes later. A `"` string may not: an unclosed `"` is `unterminated string` on the line where it opened, at file level, after the last speck, or inside domain text. An unclosed `/*` is `unterminated block comment` on the line where it opened, in those same places. A `/*` written inside an already-open block comment is comment text, not a nested comment. When `*/` is the first text on a line and the code after it is a `speck`, `action`, `invariant`, `state`, or `init` header, that header is `header is not at the start of the line`. A header later on the line, after other text or after `/* ... */`, is outside this scan. A line that is only `speck`, with `Name {` on a later line, is `speck name must be on the same line as "speck"`. A speck written entirely inside a block comment is not a speck.

A one-line speck ends on the header line's closing `}`, so it does not absorb the next speck. Go still drops an `else if`, a nested `if`, a `for` inside an `if`, and a `require` inside an `if`. That is unchanged from before this scan.

`compiler/src/speck-lex.ts` tokenizes a file: a brace in a string or a comment is not a token, `'` is prime notation, and an unclosed string or block comment names the line and column where it opened. `parseSpeck` calls that lexer through `compiler/src/rd-parser.ts`.

`compiler/src/conservation.ts` marks every AST member type `emit`, `reject`, or `n/a` for every backend. `compileSpec` checks the table immediately before it calls that backend, and a reject throws. `oneof` and `transition` are rejected except by Protobuf, which emits them. `import` is `n/a` because `compileSpec` inlines it before generation. A direct call to a generator runs that same check before it writes. Protobuf emits `oneof` and `transition`. The other backends reject them.

`parseSpeck` walks the token stream. A block that opens and closes on its header line ends there, so a following speck is not absorbed. A one-line `state { x: Nat }` stores that field. `x := 0` is stored. `x = 0` is `unrecognized init line`. File-level `import` is stored on the AST. `compiler/src/imports.ts` reads a relative path whose real location stays inside the entry directory, checks a 64-digit hash pin against the raw bytes, and rejects a symlink that leaves that directory. `compileSpec` calls that resolver before it generates, and `rootDir` widens the directory. `type LogEntry = { term: Nat, value: Value }` in KafkaKRaft is the record `{ term, value }`, and the following state fields stay on the state. Two OAuth invariants drop a trailing `//` comment. Go still drops an `else if`, a nested `if`, a `for` inside an `if`, and a `require` inside an `if`. Example `-t all` and `-t all-ir` output is pinned as one sha256 in `compiler/src/__tests__/compile-pipeline.test.ts`.

## Documentation

- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [Agent targets](docs/agent-targets.md) — `agent { }` → AGENTS.md, tools.json, generic hook
- [Agent signals](docs/agent-signals.md) — HITL/HNTL verified signals (signed file-drop with pinned signers, optional call-bound sign-off, plug-ins; CLI is dev-only)
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics

## Status

- About 700 vitest tests (run `npm test` for the current count). The real-solver Z3 cases run when `z3` is installed. `npm run coverage` enforces a floor of 88% lines/statements, 86% branches and 97% functions.
- Compile tests run against every example (see [Compile tests](#compile-tests)). Known target failures are recorded in `examples/.speckl-compile-baseline.json`.
- `npm run verify` compiles every example and checks it with Z3; unproven obligations are acknowledged in the baseline (see below).
- CI (`.github/workflows/ci.yml`) runs on GitHub-hosted `ubuntu-latest` and has two jobs:
  - **build-and-test:** build, `tsc --noEmit`, `npm test`, `npm run verify` against a pinned z3 release, and coverage with the floors above.
  - **compile-targets:** installs JDK 21, Go 1.23, stable Rust, protoc and Elm 0.19.1, then runs `npm run test:compile`.
- Tested backends: TypeScript, Z3, Protobuf, K8s CRDs, OpenAPI, CycloneDX, SPDX, PROV-O, Rust, Camel
- Round-trip property tested: parse → print → parse is identity for all examples
- Known limitation: BMC over invariants using post-state notation (`x'`) degrades to a consistency check; quantifier sugar (`forall x in coll:`) is not yet lowered to Z3 — such constraints are skipped with visible comments
- Verification fails closed: a verify block that is skipped, degraded or not lowered is reported UNCHECKED, never passed; acknowledged obligations are listed in `examples/.speckl-unchecked.json`.
- TLA+ models: Two-Phase Commit, Paxos, and Raft are ported as `.speckdl` specs (inspired by the original TLA+ models, not TLA+ output)

## License

MIT