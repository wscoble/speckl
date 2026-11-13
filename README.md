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

Go still drops an `else if`, a nested `if`, a `for` inside an `if`, and a `require` inside an `if`. That is unchanged from before this scan.

`compiler/src/speck-lex.ts` tokenizes a file: a brace in a string or a comment is not a token, `'` is prime notation, and an unclosed string or block comment names the line and column where it opened. `\r\n` and a tab are whitespace. A non-ASCII identifier is an error. Non-ASCII text inside a string or a comment is kept. `parseSpeck` calls that lexer through `compiler/src/rd-parser.ts`.

`compiler/src/conservation.ts` marks every AST member type `emit`, `reject`, or `n/a` for every backend. `compileSpec` checks the table immediately before it calls that backend, and a reject throws. `oneof` and `transition` are rejected except by Protobuf, which emits them. `import` is `n/a` because `compileSpec` inlines it before generation. A direct call to a generator runs that same check before it writes. Protobuf emits `oneof` and `transition`. The other backends reject them. A missing member-type list, or a type the table does not name, is an error.

`parseSpeck` walks the token stream. A `}` on a speck's header line ends that speck, so the next speck is not absorbed. A `}` inside a string is not that close. A one-line `state { x: Nat }` stores that field. `state { }` stores no fields. A comment after the closing brace is not part of the field. A `}` inside `//` does not close the block. `x := 0` is stored. `x = 0` is `unrecognized init line`. `type LogEntry = { term: Nat, value: Value }` in KafkaKRaft is the record `{ term, value }`, and the following state fields stay on the state. Two OAuth invariants drop a trailing `//` comment. A missing `}`, an extra `}`, text after `}`, an unrecognized member, `§`, an unrecognized state field, and an unrecognized init line are the same error from this parser and from the line walker. There is no second result. An unterminated string is `unterminated string` plus ` (column N)`. File-level `import` is stored on the AST. `compiler/src/imports.ts` reads a relative path (`\` is `/`) whose real location stays inside the entry directory, checks a 64-digit hash pin against the raw bytes, rejects a symlink that leaves that directory, and names the importing file and line on failure. `compileSpec` calls that resolver before it generates. `speckl --root` widens the directory, and `speckl --root /` widens it to the whole filesystem. An absolute import path is still an error, and so is a root that does not contain the imported file. A spec with no import keeps the example output pin. Go still drops an `else if`, a nested `if`, a `for` inside an `if`, and a `require` inside an `if`. Example `-t all` and `-t all-ir` output is pinned as one sha256 in `compiler/src/__tests__/compile-pipeline.test.ts`. `generateAgent` calls `guardAst('agent', ast)` before it emits. A missing member list throws `members are missing on speck "S"`. An unknown type throws `no handler for AST node type "not-a-member"`. A `oneof` throws `agent backend rejects AST node type "oneof"`. A speck with no `agent` block logs `skip S: no agent { } block` and does not emit that speck's agent files. `compiler/src/__tests__/guard-fail-closed-agent.test.ts` checks those three throws. It does not check that the output directory is empty.

## Domain blocks

A file may declare `domain Name { members: Invoice, Ledger; language: "..."; }`. The block is not a speck and it is not a member of a speck. `members` is required. This parser does not check that a member names a speck. `language` is optional. A `}` or a `;` inside a closed string does not end the block. An unclosed block whose source has no `}` is `missing final "}"`. A `}` after an unclosed quote is counted by the brace check, and the domain scanner then reports `unclosed domain`. This parser does not route events, queue work, or schedule a tick, and it does not check harnesses. `compiler/src/__tests__/domain.test.ts` covers each case, including a member that is not a speck in the file, a semicolon inside the language string, and a hyphenated name. Checking that a member names a speck, doctor, and provenance are not part of the parser change.

## Domain checks

`lower` rejects a member that is not a speck, a member listed twice, a speck in two domains, and a domain name declared twice. Imported domains are part of the check. A file with no domain has no domain diagnostic. `compileSpec` creates the output directory before it reports a domain error, and it does not write the generated file. `speckl doctor` fails when an `effect act` tool has no harness block (`not mapped in a harness block`), and when a harness block does not map that tool. Zero harnesses is a failure, not a pass. An observe tool is not checked. This check does not route events, queue work, or schedule a tick. `compiler/src/__tests__/domain-check-each.test.ts` covers each case.

## Domain contract check

Lowering copies `cost` onto the action, including `cost 0`. A speck with no `cost` and no domain still lowers, and that action has no `cost` field. A domain with no contract clauses still lowers. This check rejects a consumed event that nobody produces and that is not external, a produce of a name that is not an event, a produce of an external event (`declared external`, which is a different rejection), and an emit the domain does not produce. It does not route events, queue work, or schedule a tick. Provenance omits empty `consumes` and `produces`. `compiler/src/__tests__/domain-contract-syntax-each.test.ts` covers the non-regression cases. `compiler/src/__tests__/domain-contracts.test.ts` covers the wiring rejections. `docs/domain-contract-syntax.md` says the same thing.

## Domain budget

`unsat` proves the budget only inside the BMC depth. The IR budget file is `speckl-unchecked` and is not a proof. This file does not route events, queue work, run a tick, or emit a runtime throttle. A domain that declares no budget writes no budget file. `compiler/src/__tests__/domain-contracts.test.ts` covers an in-budget tick and the unchecked IR file. `docs/domain-contract-budget.md` says the same thing.

## Camel contract class

The class has no runtime method. A speck with no domain emits no contract class. A domain with no contract clauses emits no contract class. The contract class does not throttle, queue, or route messages. The Camel target still emits a RouteBuilder for the speck's actions. This class does not run a tick and does not call Z3. Camel generation does not run Z3. The RouteBuilder emits one route per action. `compiler/src/__tests__/domain-contracts.test.ts` covers the comment, the empty class, the speck with no domain, `emits one route per action`, and `does not run Z3 while generating Camel`. `docs/domain-contract-camel.md` says the same thing.

## Trace report

`speckl trace report` reads a decision log offline. When the log parses, it checks the hash chain. A torn file, a blank line, or a line that is not JSON is refused before that check. With `--state`, `head.json` is required when `<state>.decisions/` exists. An empty log prints `macs not checked`. The report does not run the hook and it does not enforce a queue. `compiler/src/__tests__/trace-report.test.ts` covers the golden report, the hash chain, a missing path, `--state`, and an empty record. `docs/trace-report.md` says the same thing.

## Tool signal fields

The agent generator copies an action `priority` onto the tool, or the domain `priority` when the action declares none and the domain's members include the speck. `kpis` are the `kpi` tags of events that action emits with a straight-line `emit`, in source order, each distinct tag once, stopping at `return`. That stop is a `return` expression such as `return stage`. A line that is only `return` does not stop the scan. An emit after `return` is not tagged. A domain priority is not used when the speck is not a member of that domain. An observe tool gets the same fields. An `emit` inside an `if` or a `for`, or an `emit` in a comment, is not tagged. Both fields are omitted when absent. This does not write the decision line, and it does not route, queue, or run a tick. `compiler/src/__tests__/agent-signal-fields.test.ts` covers each case. `docs/signal-fields.md` says the same thing.

## Completion signals

An `effect act` post writes `signal` `prime` on that decision line. `trace_id` comes from the matching allow pre. `priority` and `kpis` are copied from the tool. The hook does not scan the action body. A bad `trace_id` is replaced and the call is not denied for that alone. A post with no matching pre is a deny and does not keep the caller's `ok`, `kpis`, or `trace_id`. An observe tool does not get these fields. The hook does not enforce a queue and it does not run the agent. `compiler/src/__tests__/hook-completion-signal.test.ts` covers each case. `docs/agent-signals.md` says the same thing.

## Swarm routes

A one hop from a domain that produces an event to each other domain that consumes it. An external event comes from `external`. A cycle is two hops, and neither hop is followed. A domain does not route to itself. `compileSpec` does not call `planRoutes`. This module does not enqueue, schedule a tick, or apply backpressure. The priority number as a queue rank, the per-domain budget as the tick, and backpressure as the budget stop are later modules. `docs/swarm-routing.md` says the same thing. `compiler/src/__tests__/swarm-route.test.ts` covers each case.

## Swarm queue

The trailing integer is the rank. P0 comes before P1, and P2 comes before P10. A smaller number wins across prefixes, so B0 comes before A1. The same number is ordered by the prefix, and the same label keeps arrival order. An unnumbered label comes after every numbered label. A missing priority means the field is absent, and it comes last. An empty string is an unnumbered label, not a missing priority. This function only orders an array. The assumptions are these. A route is one hop on `produces` and `consumes`. The trailing number on a priority label is the queue rank. The per-domain budget is the tick. Backpressure is the budget stop. This pull request implements only the rank. The input array is not mutated. `compileSpec` does not call `orderByPriority`. This module does not route events, enqueue work, or stop on a budget. `docs/swarm-queue.md` says the same thing. `compiler/src/__tests__/swarm-queue.test.ts` covers each case.

## Swarm tick

The per-domain `budgetPerTick` is the tick. A missing budget is no cap. Zero is a real budget, and cost 0 still fits. An item whose cost is greater than the budget does not run. The tick does not skip a head that does not fit in order to run a cheaper item behind it. A negative cost, or a cost that is not a number, waits and blocks the rest of that domain. An infinite cost is not negative. It does not fit a finite budget, so it waits and blocks the rest of that domain. It does not increase the remaining budget. An item after the one that fills the budget waits. Work for a domain the tick does not name waits. The caller's work list is not mutated. `compileSpec` does not call `runTick`. This module does not route events and it does not apply backpressure. This pull request implements only the tick. `docs/swarm-tick.md` says the same thing. `compiler/src/__tests__/swarm-tick.test.ts` covers each case.

## Swarm backpressure

One route hop becomes a delivery at the consumer. Backpressure is the budget stop. The delivery stays in `waiting` and is not dropped. A domain with no budget does not report backpressure. An arrival with no matching route creates no delivery. A delivery that fits is not named. A delivery whose cost is greater than the budget stays named on a later tick. `compileSpec` does not call `deliver`. `deliver` does not throttle. The Camel target still emits a RouteBuilder for the speck's actions. A negative cost waits and is named when the domain has a budget. A negative cost on a domain with no budget waits and is not named. The assumptions are these. A route is one hop on `produces` and `consumes`. The trailing number on a priority label is the queue rank. The per-domain budget is the tick. Backpressure is the budget stop. This pull request implements that stop. `docs/swarm-backpressure.md` says the same thing. `compiler/src/__tests__/swarm-backpressure.test.ts` covers each case.

## Token parser

`parseSpeckContent` calls `parseSpeckDocument` from `compiler/src/rd-parser.ts`. `compiler/src/speck-span.ts` holds the span helpers, and `parser.ts` re-exports them. Coverage includes both files. `parseSpeckContent calls the token parser` in `compiler/src/__tests__/walker-vs-rd.test.ts` asserts that `parser.ts` is the production file that imports `rd-parser.ts` and that the call passes the source and the file path. `lowers every speck in the repo to the same IR` in that file compares the live parser with the line-walker copy. The same statement is in [speckdl/SPEC.md](speckdl/SPEC.md).

## Rejected structure

These inputs used to parse. Each one is now an error. The same rule is in [speckdl/SPEC.md](speckdl/SPEC.md).

- `speck A {` with no closing brace is missing final "}" at column 9. It used to parse as an empty speck.
- An extra `}` after a closed speck is extra "}" at line 3 column 1. It used to be ignored.
- Text after a speck's `}` (`} junk`) is text after a speck's "}" at column 3. It used to be ignored.
- `speck A { } speck B { }` is a second speck on one line at column 13. Speck B used to be dropped.
- A member line the parser does not recognize (`garbage line here`, `actoin go {`, `enum`, a description line, a bare `x :=`) is unrecognized member. It used to be dropped or folded into a neighbor.
- `spek B {` and `*/ speck A {` are unrecognized top-level. The speck used to be dropped.
- `invariant P { x >= 0 } junk` is text after a member's "}" at column 28. The predicate used to be dropped.
- A member whose `{` is on the next line is opening "{" must be on the same line as the member header. The member used to be dropped.
- `y Nat` inside `state` is unrecognized state field "y Nat" on the state header's line, with no column. It used to be appended to the previous type.
- `y = 0` and `garbage line` inside `init` are unrecognized init line on the init header's line, with no column. They used to be appended to the previous expression. `x := 0` is still stored.
- `/* c */ action go {` is code after */ on a line that starts with /* at column 13. The action used to be dropped.
- A bare carriage return is CR-only line endings are not supported at column 10. The state used to be dropped. CRLF is still whitespace.
- `§` is unexpected character "§" at column 2, and `→` is unexpected character "→" at column 7. The speck used to be stored with no members. Text inside a string or a comment is kept.
- `speck 9A` is identifier must not start with a digit at column 7. It used to be stored under that name. `state { t: 24h }` still parses.
- `naïve` is identifier must be ASCII at column 7. It used to be dropped. Non-ASCII text inside a string or a comment is kept.
- `1h30m` is unsupported numeric literal "1h30m" at column 16. The state used to be stored with no fields.
- An unclosed quote is unterminated string (column 8). An unclosed `/*` is unterminated block comment (column 5). The old messages named the line and not the column.

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