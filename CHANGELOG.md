# Changelog

All notable changes to the Speckl compiler (npm package `speckl`). The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/) (0.x: minor versions
may change generated output).

## [0.4.0] - unreleased

First npm release. The package was renamed from the unpublished
`speckl-compile` to `speckl`; `speckl-compile` stays as a bin alias.

### Added

- **Compile tests** (#20, #21). `src/__tests__/compiles-*.test.ts` checks every
  example's generated code with a real toolchain:
  - `tsc --strict` for TypeScript and the agent machines, plus `node --check` for the hook scripts;
  - `javac` for Camel;
  - `go build`, `cargo check`, `elm make` and `protoc`;
  - swagger-parser for OpenAPI;
  - the official Kubernetes CRD schema (strict) for k8s.

  `npm test` skips a missing toolchain with a visible reason.
  `npm run test:compile` fetches the pinned jars and schema, fills the Elm
  package cache, and fails if a toolchain is missing.
  `examples/.speckl-compile-baseline.json` records the current failures:

  | Target | Compiling today |
  |---|---|
  | TypeScript | 4/16 |
  | Agent rails | 0/2 |
  | Go | 4/16 |
  | Rust | 1/16 |
  | Elm | 0/16 |
  | Protobuf | 7/16 |
  | OpenAPI | 15/16 |
  | Camel | 16/16 |
  | k8s | 16/16 |
- **Agent targets** (#4). `-t agent` (also part of `-t all`) compiles an
  `agent { }` block into `AGENTS.md`, `tools.json`, a runtime-agnostic
  `hook.mjs` (pre/post, exit 0 allow, 2 deny, 1 error), `signal.mjs` with
  pluggable verifiers, the generated machine and `spec.sha256`.
  - `await` states wait for a verified signal and refuse act tools, near or in
    the loop.
  - State is tamper-evident: an HMAC-signed, hash-chained log.
  - One call in flight, with a pending timeout and `clear-pending`.
- **Harness adapters** (#5, #6, #9, #10, #11). A `harness <name> { map ... }` block maps a
  harness's own tool calls onto spec tools. Unmapped calls are denied.
  - Generates `adapter.mjs` and reference wiring for Claude Code
    (`.claude/settings.json`), Cursor (`.cursor/hooks.json`), Codex CLI
    (`.codex/hooks.json`), Gemini CLI (`.gemini/settings.json`), GitHub
    Copilot CLI (`.github/hooks/speckl.json`), Goose (a project or user
    plugin under `.agents/plugins/`) and Hermes Agent (the profile's
    `config.yaml` `hooks:` block plus its consent allowlist).
  - Pi, OpenCode and OpenClaw get a generated in-process plugin
    (`.pi/extensions/speckl.js`, `.opencode/plugins/speckl.js`,
    `.openclaw/plugins/speckl/`) that runs the adapter for every tool call and
    blocks on anything but an explicit allow (crash, timeout, missing `node`,
    bad output). `--plugins-dir` installs a user-level Pi or OpenCode plugin.
    OpenCode `bash` / OpenClaw `exec` with a `workdir` outside the project
    root are denied.
  - Cline (CLI and VS Code), Kiro and Windsurf / Devin Desktop (#11):
    `install cline` writes `sh` scripts in `.clinerules/hooks/` that turn
    anything but an explicit `{"cancel":false}` into a cancel; `install kiro`
    merges `.kiro/hooks/speckl.json`; `install windsurf` writes
    `.devin/hooks.json` and the legacy `.windsurf/hooks.json`. Their pre
    commands exit 2 unless the adapter printed an explicit allow. Kiro,
    Windsurf and the Cline VS Code extension are built from documented and
    source formats and are not live-tested.
  - `adapter.mjs install` merges the wiring into an existing config.
  - Fails closed: hook crashes, timeouts, malformed output and adapter errors
    all block. The wiring sets `onFailure: "block"` (Claude Code) or
    `failClosed: true` (Cursor), `on_failure: "block"` (Goose) or
    `fail_closed: true` (Hermes), and adds `|| exit 2` for Codex, Gemini,
    Copilot and Goose. Copilot CLI hook timeouts stay fail-open (documented,
    not configurable).
  - Includes `docs/harness-adapters.md`, with an executed 10-minute quickstart.
- `next:` is a first-class IR member (#3). The generated TypeScript machine
  gains `ACTIONS`, a side-effect-free `can(action, args)`, and
  `serialize()` / `restore()`.
- `speckl verify [<spec.speckdl|dir> ...]` runs the bundled Z3 verifier
  (`scripts/verify-z3.mjs`) on your specs. It needs the `z3` binary.
- **Coverage floor** (#12). `npm run coverage` measures the compile pipeline
  in-process (it moved from `index.ts` to `src/compile.ts`, so the CLI, the
  AST Z3 backend and the Go/Elm generators are now measured) and includes the
  verifier helpers in `scripts/lib/`. It fails below 80% lines/statements,
  85% branches and 95% functions. The old 54% line figure came from what was
  measured, not from missing tests. Generated example output is pinned by a
  digest snapshot.
- Examples: `AgentPolicy`, `ReviewGate`, `ClaudeCodePolicy`.

### Changed

- **CI runs on GitHub-hosted runners** (#23). The self-hosted runner had stopped picking up jobs, so `ci.yml` now uses `ubuntu-latest`. It cancels a superseded run on the same ref and has two jobs:
  - **build-and-test:** `npm ci`, build, `tsc --noEmit`, `npm test`, `npm run verify` against z3 5.1.0 (pinned by SHA-256 and cached), and coverage with its floors.
  - **compile-targets:** installs and caches JDK 21, Go 1.23, stable Rust, protoc 28.3 and Elm 0.19.1, then runs `npm run test:compile`.

- **`and` binds tighter than `or`** (#17). `a or b and c` now means
  `a or (b and c)` in the typed expression parser (used by the IR and by the
  AST Z3 backend) and in the AST Z3 legacy translator. Before, both read it
  as `(a or b) and c`, while the TypeScript, Go and Elm generators already
  used the usual reading. None of the bundled examples mixes the two without
  parentheses, so their output is unchanged. The precedence table is now in
  SPEC.md section 2.9.

### Removed

- **Elm `component` blocks** (#13). The component path in the Elm generator
  and parser had no users. A `component` block is now a parse error
  ("component blocks are no longer supported"). The Go generator's `COND-GUARD` debug print and the unused
  `lowerParserActionStatement` are gone too. Generated output for all
  examples is byte-identical, and the coverage floor rises to 88% lines and
  statements, 86% branches and 97% functions.

### Fixed

- **A missing key of a numeric map read as NaN in TypeScript** (#27). The
  Z3 encoding treats `emptyMap` as a constant array of 0, so proofs assume
  `m[k]` is 0 for a key never written, and Go's map read already returns 0.
  The TypeScript target emitted `this.m.get(k)!`, which is `undefined` at
  runtime: a running total `m[k] := m[k] + x` stored NaN, and later guards
  on it were silently false. Rust indexed with `m[&k]` (panic) and Camel
  unboxed `m.get(k)` (NullPointerException).
  - Numeric-valued maps now read `(m.get(k) ?? 0)` (TypeScript),
    `m.get(&k).copied().unwrap_or_default()` (Rust) and
    `m.getOrDefault(k, 0L)` (Camel). Maps of other value types are unchanged
    (non-null assertion, panic, null).
  - `x := emptyMap` (bare, without parentheses) in `init` is now translated
    by the TypeScript, Rust, Camel and Go targets; before, it was emitted
    verbatim (TypeScript, Go: undefined identifier) or marked
    `SPECKL-UNTRANSLATED` (Rust, Camel: the machine could not be constructed).
  - Regression fixture `src/__tests__/fixtures/MapTotals.speckdl`: checked
    with `tsc --strict` and run in `npm test`; run with `cargo test` and
    `go test` and compiled with `javac` in `npm run test:compile`.

- **Rust output did not compile** (#22). Before this change, 1 of 16 example crates passed `cargo check`. The generator rewrote spec text with regular expressions, which left behind `and`/`or`, undefined type names, keyword field names (`continue`), invariant names used as values and `if x return` without braces.

  It now works from the IR, like the Camel target, and translates expressions with their types:
  - numeric widening, Option and nil;
  - map and list reads and writes, `in`/`notIn`;
  - `old()`, built from a clone taken at the start of the action;
  - `append`, `min`/`max`, `has`/`contains`, `length` and string concatenation.

  Untranslated forms fail closed:
  - an action with an untranslated statement returns `Err("SPECKL-UNTRANSLATED: ...")` before it touches state;
  - an untranslated init, invariant or temporal property panics through `speckl_untranslated`.

  Types the spec uses without declaring become `SPECKL-UNRESOLVED` placeholder structs. Events live in `mod events`, so an event may share a type's name. All 16 examples compile. In 62 of their 88 actions an untranslated form makes the whole action fail closed (Camel has the same count).

  Output changes:
  - `check_<name>` methods for invariant blocks;
  - `verify_N` checks the state predicate of `always(...)`;
  - the invented `<Speck>State` enum is gone.

- **Camel output did not compile** (#20). Processors used state variables
  as bare Java names instead of the injected state bean, `return x` was
  emitted inside `void process()`, untranslated set algebra and inline
  records were pasted in as Java, and type aliases or generic primitives
  (`List<long>`) produced invalid types. Only 2 of 16 examples' Camel projects
  compiled, and only because their processors were empty. Now:
  - all 16 compile with `javac`;
  - processors read and write state through the state bean;
  - parameters come from message headers;
  - `return x` sets the reply body;
  - events go through `SpecklRuntime.emit`;
  - postconditions are checked after the effects.

  Expressions are translated with their types. Anything without a typed
  Java form calls `SpecklRuntime.untranslated("<source>")`. An action
  containing such a statement throws `UnsupportedOperationException` before
  it reads or writes state. It used to skip the check or apply only part of
  its effects. 62 of the 88 example processors fail closed this way today.
  The causes are spec forms the IR does not lower yet: `if` blocks, record
  literals, set literals and algebra, scalar type aliases, and dotted
  assignments.
- **Parameterless actions had empty bodies in the IR** (#16). The IR found
  action bodies by scanning the source for `action Name(`, so `action Approve {`
  lowered with no statements. Every IR backend then saw an action with no
  guard and no effect, for example a Camel processor that never checked its
  `require`. This affected ToggleSwitch, TwoPhaseCommit, ReviewGate,
  AgentPolicy and ClaudeCodePolicy. Bodies now come from the parser's line
  range for each action. This also stops two specks in one file from sharing
  the last same-named action's body.
- **IR backends acted on truncated expressions** (#14). The IR's expression
  parser stopped at the first token it could not use (`P implies Q` became
  `P`, `x := a union {b}` swallowed the next statement, record constructors
  became their type name) in AccountLedger, Paxos, Raft, RetryHandler,
  SQLiteWAL and tef. Expressions and statements now parse in full or become
  explicit placeholders that carry their source: skipped with the source in
  IR Z3, a throwing expression in TypeScript, and a marked fail-closed
  `false` in Camel. Infix `implies` is now an operator. `n-1` is a
  subtraction. An operator after a call keeps its precedence
  (`a <= f(x) && c`). RetryHandler's `30s` is now `30` (seconds), because
  SpeckDL has no duration literals.
- **Z3 arithmetic grouped right to left** (#19). The AST Z3 backend's
  fallback string translator, used for quantified invariants (`forall`), `let`
  sugar, post-state invariants and expressions the typed parser cannot read,
  split each operator at its first occurrence. So `stage - 1 - 1 == stage` was
  translated as `stage - (1 - 1) == stage` and **proved**, although it is
  false. A leading unary minus took the whole rest of the expression
  (`- s - 1` became `-(s - 1)`). Subtraction, `*`, `/` and `%` are now
  left-associative. `*`/`/`/`%` are translated (`div`/`mod`) instead of
  leaking as infix, and unary minus applies to its operand only. No bundled
  example hit this: every generated file and every verify result is
  unchanged. The typed path was already correct.
- **Vacuous BMC proofs** (#3). The Z3 backend scraped `next:` from raw source
  and read past it into `verify` blocks, so BMC only stuttered and every
  `Always` obligation "proved". Multi-line relations lost alternatives
  (KafkaKRaft, SQLitePager, OAuth2), and SQLiteWAL had no transitions. Unknown
  action names in `next:` now fail the compile.
- **`speckl verify` fails closed** (#8). Before, any check the verifier could
  not actually run still counted as a pass.
  - Each verify block declares `; speckl-obligation: <name>`. A degraded check
    (model incomplete, post-state invariant, invariant not found, free-form
    temporal property) is reported UNCHECKED, and UNCHECKED fails.
  - Verify blocks in a spec with no actions are declared unchecked instead of
    being dropped. A `(check-sat)` with no `speckl-expect` marker fails.
  - The IR Z3 backend no longer runs a stuttering "BMC" that proved nothing.
    It declares each verify block `speckl-unchecked` and the verifier fails it
    unless the AST backend proves it.
  - `examples/.speckl-unchecked.json` acknowledges the 31 example obligations
    that are not yet proven. They print as UNCHECKED and never count as
    passed. An entry that becomes proven or no longer exists fails as
    `STALE-BASELINE`. Today 3 of 34 example verify blocks are proven.
  - `-t agent` refuses to emit rails if a guard still contains an
    untranslated placeholder (the bogus `const x = {}` lines are gone).
  - The AST Z3 output no longer ends with `(get-model)` after `unsat`, so a
    raw `z3` run exits 0. Deny messages name stages
    (`stage == Approved (stage is Idle)`), not numbers.
- **False "proved" for infix `P implies Q`** (#12). The AST Z3 backend's typed
  expression path parsed only `P`, so `stage >= 0 implies stage < 2` was
  proved as `stage >= 0` although an action breaks it. A partial parse is now
  a failure, and the property degrades to UNCHECKED instead of proving.
  (RetryHandler.smt2 no longer asserts `totalDelay <= 30s` as `<= 30` for the
  same reason.)
- **Unknown `verify` forms vanished** (#12). `verify Eventually(...) { ... }`
  produced no obligation and verification stayed green. It is now a parse
  error that names the supported forms.
- `verify-z3` checks every `(check-sat)` obligation against its own
  `speckl-expect` marker, not only the last one per file (#2).
- **Docs** (#18). `speckl verify --help` now lists `--examples <dir>` and
  explains when the unchecked baseline applies, along with `--depth` and
  `--keep`. The README Status section has the real test and verify numbers
  and says the self-hosted CI runner is not currently picking up jobs.

### Known issues (tracked for the next release)

- The IR Z3 backend does not unroll transitions, so it cannot prove `Always`
  or other verify obligations. Since #8 it declares each one unchecked
  (visible, and failing unless the AST backend proves it) rather than
  reporting fewer obligations.
- 31 of the 34 example verify blocks are not yet proven (see
  `examples/.speckl-unchecked.json`), mostly because the AST Z3 sanitizer
  drops forms it cannot translate (model incomplete).

## [0.3.1] and earlier

Unreleased development versions published only as source (#1).

[0.4.0]: https://github.com/wscoble/speckl/releases/tag/v0.4.0
