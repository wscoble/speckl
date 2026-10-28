# Changelog

All notable changes to the Speckl compiler. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (0.x: minor versions may change
generated output).

## [0.4.0] - unreleased

0.4.0 is not published to npm. Install it from a source checkout, or from a
local `npm pack` tarball (see the [README](README.md)). The compiler was
renamed from `speckl-compile` to `speckl`; `speckl-compile` stays as a bin
alias.

### Added

- **`import` resolution.** `import "file.speckdl"` is read, lowered, and merged.
  A missing file, a cycle, a hash mismatch, and the same speck declared in
  two files are errors that name the file. `version` is stored and not looked
  up. There is no package registry, and expressions that name an imported
  speck are not rewritten. Contracts, cost, budgets, and runtime routing are
  not implemented. An empty `hash ""`, a mistyped clause (`hsh`, `verison`),
  and a `/* */` comment on the import line fail the parse. A trailing `//`
  comment is allowed. An `import` that is a direct member of a speck is
  attached to that speck. An `import` inside an action, an `if`, a multi-line
  state block, a `domain`, or any other brace block that is not the speck
  itself is `import is inside a block`.
- **Header and brace checks on scanner tokens.** After `lex.ts` masks
  comments and strings, those tokens decide where a speck starts and ends.
  A `speck` that is not a well-formed header is a parse error naming the file
  and line: `speck must be a header at the start of the line`,
  `expected "speck <Name> {"`, `speck name must be on the same line as "speck"`,
  `one speck per line: put members on their own lines`, or
  `"speck" is a reserved keyword`. A header at nonzero depth, depth below 0,
  or depth that is not 0 at the end of the file is `unbalanced braces`. A
  stray `}` is that error even when a later comment contains a `{`. A `{` or
  `}` inside a comment or a string does not count, so the next speck stays a
  separate speck. An extra `}` on a one-line member
  (`action Go { x := x + 1 } }`, `state { x: Nat } }`,
  `invariant P { x >= 0 } }`) closes that speck. The next speck is not
  absorbed. Non-comment text after the `}` that brings file depth to 0, or
  after a member's `}` while the speck stays open, is
  `text after a closing brace`. `})`, `},`, and `} else` / `} else if` are
  not that error. A Unicode Cf character outside a string or a comment is
  `invisible format character`, except a BOM at the start of the file. Other
  file-level text is `text outside a speck, domain, or import`. A string does
  not continue onto the next line. A nested `/*` is `nested block comment`.
  `domain` is recognized so its braces count, and the members inside it are
  not parsed. A speck written inside a domain is `unbalanced braces`. An
  unknown block on its own line inside a speck (`thing B {`, `Speck B {`) is
  not a member and is not an error. A colon-form `if` nested inside another
  colon-form `if` is never rewritten. One-line specks with members, a name
  on the next line, and two specks on one line stay errors until a later
  whole-file tokenizer.
- **Comment- and string-aware brace scan.** Brace counts skip a `{` or `}`
  inside a finished `"` string, a `//` comment, or a `/* */` comment, so
  that brace cannot end a speck or a member or hide the next speck.
  `'` is post-state prime notation, not a string quote.
- **One shared scanner.** `compiler/src/lex.ts` is the scanner every brace
  count uses. An unterminated block comment or string, or a stray `*/`, is
  a parse error naming the file and line. Code after `/* ... */` on the same
  line is kept. A trailing `//` comment is not part of a `require`, `let`,
  or invariant expression.
- **`examples/DeployGate.speckdl`.** The first example that uses `bind call on
  approve`: one signed approval covers one exact `deploy` call (tool plus
  arguments), once. Tested end to end in `example-deploy-gate.test.ts`.
- **Decision record.** After the state verifies, generated hooks append each
  allow and each deny (deny reason clipped at 500 characters) to
  `<state>.decisions/log.jsonl`. Each line is SHA-256 chained and HMAC-SHA256'd
  with the state key. The stored deny reason is the same redacted sentence the
  hook prints: a key path (given or resolved), the key file's contents, and a
  signer key are not written, including when they appear in the tool name or
  the call id. That HMAC is not a signature a third party can check;
  anyone who can read the key can rebuild the record. The line is the gate's
  verdict, not proof the tool ran. Denials are not written into `state.json`.
  Calls that fail before the state verifies (usage, stdin, lock timeout, a
  missing or bad key, a broken state signature) are denied and not appended.
  If the record cannot be written, the call is denied. While `log.jsonl` is
  within 256 KiB the hook rechecks the whole decision chain; past that it
  checks the keyed head and the last 64 KiB. `signal.mjs verify` always walks
  every line, so a same-length edit above that tail is caught there and not
  by the next hook call. A crash after the allow line is written and before
  `state.json` is replaced can leave an allow with no matching `state.log`
  entry; the process does not exit 0. A `signers` rotation and a call binding
  stay in `state.log`. A bound-call mismatch deny, and the later allow of the
  matching call, are decision lines and do not consume the binding on the
  deny. `rotate-signers` refuses to rotate when the decision chain does not
  verify. See `docs/agent-signals.md`.
- **Pinned sign-off signers.** `signal.mjs init --signer name=pubkey` (repeatable)
  records the ed25519 public keys that may sign a `file-drop` approval. The
  sha256 of the canonical initial set is part of the log genesis hash, and
  the current set is covered by the state HMAC and re-derived from the log.
  Verification accepts a signature only from that set: a `--pubkey` that is
  not pinned is refused, on dev states as well as production. A state created
  before this field existed still trusts a per-call `--pubkey` (its genesis
  omits the field). `signal.mjs rotate-signers` appends a sealed log entry that
  replaces the current set; the drop must be signed by a key that is pinned
  now. Any one pinned key can sign or rotate (not a threshold). An empty set
  refuses every file-drop signature.
- **Call-bound sign-off.** An `await` may say `bind call` (or `bind call on approve`).
  The signed drop then carries `call`, the sha256 of one canonical spec tool call
  (tool name plus mapped arguments, full value, keys sorted). The hook allows
  that call once, on a matching `post` with `ok: true`, and denies any other
  call while the approval is outstanding. A `file-drop` signature is still
  accepted only from the current pinned signers; the hash is not a trust
  anchor. Run, expiry, nonce and replay checks are unchanged and run at
  apply. Expiry is not checked again when the bound call runs, and rotating
  signers does not revoke a binding already stored. An await without the
  clause stays a stage-level sign-off, and a `call` hash on one of those is
  refused. See `docs/agent-signals.md`.
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
- **Actionable deny reasons.** A generated hook's denial names why the call
  was refused — not allowed in this stage, waiting on a sign-off, a failed
  precondition, or an internal error (fail closed) — and the next step. A
  sign-off names the signal and the `signal.mjs apply` command a human runs
  (file-drop, with the drop shape and the run id). On a state created with
  `init --signer`, that command names the pinned signer and does not tell
  anyone to pass `--pubkey`; a legacy state (no pin field) still prints
  `--pubkey <pubkey>`. A call-bound await uses that same command and appends
  `sign call <digest> canonical <preimage>`, and the digest is left in the
  sentence. The text never includes the state key, the key file path as given,
  resolved, or followed through a symlink (and not the real directory that
  contains the key), the key file's contents, or a pinned signer key, and that
  same sentence is what `<state>.decisions/log.jsonl` stores. A state-load, key-read,
  lock, or decision-record failure prints a fixed sentence and not the Node error.
  A key path shorter than 8 characters is refused with a fixed sentence,
  including a long path whose symlink target or that target's parent
  directory is under 8 characters. The hook exits 2, the same as a missing
  or bad key. That is stricter than commit 09eb03c, which allowed the call
  when the path named a real key. The state key and
  each pinned signer key are also removed as base64, base64url, uppercase
  hex, and SPKI DER-base64 or PEM. `status` and `doctor` print the key path
  as `<keyfile>` after that same redaction. Plugin spawn failures, a
  hook.mjs that does not start, and a doctor probe report a fixed code or
  signal name (`spawn ENOENT`, `killed by SIGKILL`, `exit 1`,
  `hook.mjs could not be started`, `hook.mjs failed`, `command failed (ENOENT)`)
  rather than a Node stack.
  An adapter failure before it can decide prints a fixed line and not the exception. A throw while
  building the sentence still denies. Each harness keeps its own output shape. Adapter
  denials (unmapped tool, shell metacharacters, a protected path, a bad
  payload) gain the same fail-closed next step. Examples in
  `docs/agent-signals.md` and `docs/harness-adapters.md`.
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

- **Trailing comments are not part of the expression.** A `//` comment after
  a `require`, a `let`, or an invariant is dropped before generators run.
  Go guard errors no longer repeat that comment. SQLiteWAL's Go, Elm, and
  AST SMT output, and OAuth's Rust invariant text and Elm machine, change
  for that reason. Other bundled examples are unchanged.

- **Short key paths now deny.** A `--key` or `SPECKL_STATE_KEY_FILE` path
  shorter than 8 characters — as given, as `path.resolve` returns it, as
  `realpath` of the key file, or as that real path's parent directory — is
  refused before the hook runs. The hook exits 2, the same as a missing or
  bad key. Commit 09eb03c on `main` allowed the call when that path named a
  real key.

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
