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

Browse all in [examples/](examples/).

## Imports

A file can `import` another SpeckDL file. The compiler reads it, lowers it,
and merges its specks into the compilation. A missing file, an import cycle,
a hash mismatch, or the same speck name in two files is a compile error, and
the message names the file.

```
import "ledger.speckdl" as ledger version "1.2.0" hash "sha256:..."
```

**Not yet implemented:** a package registry for `version` pins (the pin is
stored, and `hash` is checked); rewriting expressions that name an imported
speck.

The file-level scan that finds the next speck skips a brace inside a
finished string or a comment. An unclosed `{` before the next speck, or a
file whose depth on that scan is not 0 at the end, is a parse error naming
the file and line (`unbalanced braces`). A stray `}` is that error on
the line where depth goes below 0, even when a later `{` or a later
comment would bring it back. `domain` is not parsed; a speck
inside a domain's braces is that error. Members written inside
`domain D { ... }` are dropped, the same as main. Domain blocks are a
later change. An `import` inside an action, an
`if` inside an action, a state block, a domain, or any other brace block
that is not the speck itself is `import is inside a block`. An import that
is a direct member of a speck is attached to that speck. A string does not
cross lines: an unclosed `"` is an error on that line. An unclosed block
comment, a nested `/*`, and a stray `*/` are parse errors naming the file
and line. A speck header is matched on the trimmed line with comments
masked: an indent, a tab, `speck /* c */ Name {`, `speck Name /* c */ {`,
`speck Name { }`, `speck Name {}`, and `speck Name` with `{` alone on
the next line are that speck. `{ }` on that next line is
`expected "speck <Name> {"`. `/* */` before `speck` on the same line is
parsed as that speck. After comments and strings are masked, a `speck`
written as a header has to be that header, at depth 0. A name starts
with a letter or `_`. The keyword followed by anything else is a parse
error naming the file and the line, including punctuation before the
name (`speck -B {`) and an expression (`x := speck + 1`). Mid-line, that
is `speck must be a header at the start of the line`. A line that starts
with `speck` and a bad name before `{` is `expected "speck <Name> {"`.
At nonzero depth a line that would otherwise be a header is
`unbalanced braces`. `speck` inside a string or a comment is not the
keyword. `specks`, `myspeck`, `speck_count`, and `my-speck` are
identifiers. `speck` with the name on the next line is
`speck name must be on the same line as "speck"`. A one-line speck with
members, and two specks on one line, are
`one speck per line: put members on their own lines`. On main the split
name was dropped, the one-line members were dropped, and the second
speck was dropped or its members were attached to the first. Those forms
are a parse error here. A line that is only `speck` is
`speck name must be on the same line as "speck"`. A format character
outside a string or a comment is `invisible format character`, except a
BOM at the start of the file. A line that starts at depth 0 and is not
a speck header, a `domain` line, an `import`, or blank is
`text outside a speck, domain, or import`. A lone `}` on that line is
`unbalanced braces`. Non-comment text after the
`}` that brings file-level depth back to 0, on that same line, is
`text after a closing brace`. The same error is reported for
other text after a member's `}` while the speck stays open. A
same-line `else` is still parsed, and so is a line that is `})` or
`},`. A line that takes depth to 0 has to
be `}` plus optional whitespace and an optional comment (`closing brace
must be alone on the line`). On a line that opens or closes a speck, a
`{` or `}` inside a comment is `comment contains a brace`. `speck Name`
with `// {` and `{` on the next line still parses. This check only
rejects that text. An unknown block that stays inside a speck is merged
into it, the same as main.
`speck` is a reserved keyword. On main, `speck := speck + 1`
and `speck >= 0` were accepted. They are now
`"speck" is a reserved keyword`.
A header `speck Name` whose `{` never appears is
`expected "speck <Name> {"`. A colon-form `if` nested inside another
colon-form `if` is never rewritten, the same as main. `hash ""`, a mistyped import clause, and a
`/* */` comment on an import line fail with
`Failed to parse import statement`. A trailing `//` on an import is
accepted. Inside a member, a `{` or `}` in a `//` comment, a `/* */`
comment, or a string can still decide where the member ends. That is the
same as main. `if x > 5 { // }` can run the following statements
unconditionally and drop invariant Canary. The same gap drops invariant
Canary in g07, g09, g26, and g27. `description: "{ } }}"` can
drop that speck's members, and `log := "}"` in an action can drop the
action's statements and a following invariant. Comment braces inside
member blocks are a known gap, fixed in #47, not here.

## Documentation

- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [Agent targets](docs/agent-targets.md) — `agent { }` → AGENTS.md, tools.json, generic hook
- [Agent signals](docs/agent-signals.md) — HITL/HNTL verified signals (signed file-drop with pinned signers, optional call-bound sign-off, plug-ins; CLI is dev-only)
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics, including `import`

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