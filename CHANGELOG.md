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

- **Domain contract check.** Lowering copies `cost` onto the action, including `cost 0`. A speck with no `cost` and no domain still lowers, and that action has no `cost` field. A domain with no contract clauses still lowers. This check rejects a consumed event that nobody produces and that is not external, a produce of a name that is not an event, a produce of an external event (`declared external`, which is a different rejection), and an emit the domain does not produce. It does not route events, queue work, or schedule a tick. `compiler/src/__tests__/domain-contract-syntax-each.test.ts` covers the non-regression cases. `compiler/src/__tests__/domain-contracts.test.ts` covers the wiring rejections.
- **Domain checks.** `lower` rejects a member that is not a speck, a member listed twice, a speck in two domains, and a domain name declared twice. Imported domains are part of the check. A file with no domain has no domain diagnostic. `compileSpec` creates the output directory before it reports a domain error, and it does not write the generated file. `speckl doctor` fails when an `effect act` tool is not a `map` target in every harness. An observe tool is not checked. This check does not route events, queue work, or schedule a tick. `compiler/src/__tests__/domain-check-each.test.ts` covers each case.
- **Domain blocks (parser).** A file may declare `domain Name { members: ...; language: "..."; }`. The block is not a speck. `members` is required. This parser does not check that a member names a speck. `language` is optional. A `}` or a `;` inside a closed string does not end the block. An unclosed block whose source has no `}` is `missing final "}"`. A `}` after an unclosed quote is counted by the brace check, and the domain scanner then reports `unclosed domain`. This parser does not route events, queue work, or schedule a tick, and it does not check harnesses. `compiler/src/__tests__/domain.test.ts` covers each case.
- **Comment- and string-aware brace scan.** Brace counts skip a `{` or `}`
  inside a finished `"` string, a `//` comment, or a `/* */` comment, so
  that brace cannot end a speck, a member, an `if`, or a `for`. The same
  skip covers agent advisory strings (`instruction`, `prompt tool`, and
  `tool … description`), so a brace inside that text does not end the agent
  block. A brace in a comment or a string does not hide the next speck. A
  one-line action closes on the structural `}` of its header line, so a
  trailing `// }` is not a brace and does not take the next action's
  statements. A line that is only `speck`, with `Name {` on a later line,
  is `speck name must be on the same line as "speck"`. The same skip is
  used when Go emits an `if` or a `for`, so a brace in a comment or a
  string does not drop that body. `'` is post-state prime notation, not a
  string quote. A block comment may continue onto the next line, including
  one that opens on a speck's closing line and closes later. A `"` string
  may not: an unclosed `"` is `unterminated string` on the line where it
  opened, at file level, after the last speck, or inside domain text. An
  unclosed `/*` is `unterminated block comment` on the line where it opened,
  in those same places. A `/*` written inside an already-open block comment
  is comment text, not a nested comment. When `*/` is the first text on a
  line and the code after it is a `speck`, `action`, `invariant`, `state`,
  or `init` header, that header is `header is not at the start of the
  line`. A header later on the line, after other text or after `/* ... */`,
  is outside this scan. A speck written entirely inside a block comment is
  not a speck. Go still drops an `else if`, a nested `if`, a `for` inside
  an `if`, and a `require` inside an `if`. That is unchanged from before
  this scan.
- **Token lexer.** `compiler/src/speck-lex.ts` tokenizes a file. A `{` or `}`
  inside a finished `"` string, a `//` comment, or a `/* */` comment is not
  a token. `'` is prime notation, not a string quote. An unclosed string or
  block comment is an error on the line and column where it opened. A
  non-ASCII identifier is `identifier must be ASCII`. A `\r\n` break and a
  tab are whitespace. A `"` that reaches `\r`, `\n`, or the end of the file
  before its closer is `unterminated string` on the line where it opened.
  Non-ASCII text inside a string or a comment stays in that text. `1e5`, `0x1F`,
  `1_000`, and `5min` are `unsupported numeric literal`. Durations such as
  `24h` and `500ms` stay a number plus a unit.
  `compiler/src/__tests__/speck-lex.test.ts` calls the lexer directly.
  `parseSpeck` calls this lexer.
- **Backend conservation.** `compiler/src/conservation.ts` lists every AST
  member type. Each backend marks each type `emit`, `reject`, or `n/a`.
  `compileSpec` checks that table immediately before it calls the backend.
  A reject throws, and that backend does not write. `oneof` and `transition` are rejected by every backend except Protobuf,
  which emits them. `import` is `n/a`: `compileSpec` inlines it before
  generation. A direct call to a generator runs the same check.
  `compiler/src/__tests__/conservation.test.ts` checks the table.
- **Line walker files.** Member phrase parsers live in
  `compiler/src/speck-part0.ts` through `speck-part9.ts`, plus
  `speck-span.ts`. `compiler/src/__tests__/line-walker-move.test.ts` compares
  every example's member outline to `fixtures/line-walker-outline.txt`, the
  outline from before this move, and checks its sha256.
- **Example output pin.** `compiler/src/__tests__/compile-pipeline.test.ts` pins
  `-t all` and `-t all-ir` for every example as one sha256 of the file
  digests. The digest snapshot file is gone. The pin matches the previous
  snapshot, so compiled output is unchanged. Appending one byte to a
  generated file changes that file's digest and the pin.
- **Recursive-descent parser.** `compiler/src/parser.ts` calls
  `parseSpeckDocument` in `compiler/src/rd-parser.ts`, which calls the token
  lexer. A `{` or `}` in a string or a comment is not structure. A one-line
  record, a trailing invariant comment, a header-line `}`, and a one-line
  state are stored as the follow-up changes describe. Malformed structure is
  rejected; see "Fail closed on malformed spec structure" above. The example output pin
  is the pin those changes set.
  An opening `{` on the next line is `opening "{" must be on the same line as
  the member header`. A non-blank line that is not a known member is
  `unrecognized member`. A state field that is not `name: type` is
  `unrecognized state field`. `x = 0` inside `init` is
  `unrecognized init line`. `x := 0` is stored. File-level `import` is
  stored on the AST and inlined by `compileSpec` before generation. `type LogEntry = { term: Nat,
  value: Value }` in `examples/KafkaKRaft.speckdl` is the record
  `{ term, value }`. The state fields that follow stay on the state. Two
  invariants in `examples/OAuth2AuthorizationCode.speckdl` drop a trailing
  `//` comment, and the Rust output for that example changes. Go still
  drops an `else if`, a nested `if`, a `for` inside an `if`, and a
  `require` inside an `if`.
  `compiler/src/__tests__/parser-rd.test.ts`,
  `parser-main-corpus.test.ts`, and `parser-intended-diff.test.ts` cover
  this. `compiler/review/findings-rd-parser.txt` records that the output matches.
- **One-line record span.** A `type Name = { ... }` that closes on its header
  stores only that brace span. The line walker had kept the following state
  fields, so KafkaKRaft `LogEntry` was not `{ term, value }` and a probe's
  TypeScript contained `currentTerm: = 0`. The new output is
  `{ term, value }`. An empty record stores no fields. A comment after the
  closing brace is not a field. The example output pin moved for that
  reason, from `9bdc5a8a21f64044b1200534581f67a08a8fb8aea206cdb61c365a8b1ca18bc1`
  to `d30665709817d54e85536f899f569a874c46b2ebd3f30d14dae7ae0539188e73`. See
  `compiler/review/findings-record-span.txt`.
- **Invariant comments.** A trailing `//` or a block comment is not part of
  an invariant expression. The line walker had kept it, so two OAuth
  invariants carried comment text and a Rust doc line contained `// max`.
  The new expression is the text before the comment. A `//` inside a string
  stays. An empty or comment-only invariant is an error. An invariant with
  no comment is unchanged. The example output pin moved for that reason,
  from `d30665709817d54e85536f899f569a874c46b2ebd3f30d14dae7ae0539188e73`
  to `4d432ac8c74e6ad7371ac85d09f0266acd7e76cc9ae971b9ad858e8ee41f7c2a`. See
  `compiler/review/findings-invariant-comment.txt`.
- **Header-line close.** A `}` on the speck header ends that speck. The
  line walker stepped past it, so `speck A { state { x: Nat } }` followed
  by `speck B` stored B's state field on A as well as on B. A now ends on
  line 1 with no members, and B keeps its own state. A `}` inside a string
  is not that close. Example output does not change, so the output pin stays
  `4d432ac8c74e6ad7371ac85d09f0266acd7e76cc9ae971b9ad858e8ee41f7c2a`. See
  `compiler/review/findings-header-close.txt`.
- **One-line state.** `state { x: Nat }` and `init { x := 0 }` store the
  field and the assignment. The line walker left both lists empty. An empty
  `state { }` stores no fields. A comment after the closing brace is not
  part of the field. A `}` inside `//` does not close the block. A comma in
  `state { x: Nat, y: Nat }` stays in the type. Example output does not
  change, so the output pin stays
  `4d432ac8c74e6ad7371ac85d09f0266acd7e76cc9ae971b9ad858e8ee41f7c2a`. See
  `compiler/review/findings-oneline-state.txt`.
- **Direct generator check.** `generate` for OpenAPI, CycloneDX, SPDX, and
  the TypeScript IR backend calls the conservation check before it writes.
  A direct call cannot drop a `oneof`. A missing member list
  (`sourceMemberTypes` on IR, `members` on an AST) is an error, and so is a
  type the table does not name. An empty list is a speck with no members.
  `lower` records `sourceMemberTypes`. `compiler/src/__tests__/generator-guard.test.ts`
  and `guard-fail-closed-small.test.ts` call those generators without `compileSpec`.
- **Direct schema check.** Provenance, Kubernetes CRDs, and Protobuf call the conservation check before they write. Protobuf emits `oneof`. The other two reject it. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` and `guard-fail-closed-schema.test.ts` call them without `compileSpec`.
- **Direct Z3 IR check.** `generateZ3FromIR` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` and `guard-fail-closed-z3ir.test.ts` call it without `compileSpec`.
- **Direct agent check.** `generateAgent` calls `guardAst('agent', ast)` before it emits. A missing member list throws `members are missing on speck "S"`. An unknown type throws `no handler for AST node type "not-a-member"`. A `oneof` throws `agent backend rejects AST node type "oneof"`. A speck with no `agent` block logs `skip S: no agent { } block` and does not emit that speck's agent files. `guard-fail-closed-agent.test.ts` checks the three throws. It does not check that the output directory is empty.
- **Direct Camel check.** `generateCamel` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` and `guard-fail-closed-camel.test.ts` call it without `compileSpec`.
- **Direct Rust check.** `generateRust` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` calls it without `compileSpec`.
- **Direct TypeScript state-machine check.** `generateTypeScriptStateMachine` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` calls it without `compileSpec`.
- **Direct Z3 check.** `generateZ3` calls the conservation check before it writes, and a direct call reads invariant members from the AST unless an `_invariants` list is attached. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `next:` naming an unknown action is an error and writes no SMT file. `generator-guard.test.ts` and `guard-z3-limits.test.ts` call it without `compileSpec`.
- **Direct Elm check.** `generateElm` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` calls it without `compileSpec`.
- **Direct Go check.** `generateGo` calls the conservation check before it writes. A direct call cannot drop a `oneof`. A missing member-type list, or a type the table does not name, is an error. `generator-guard.test.ts` calls it without `compileSpec`.
- **Import paths.** `compiler/src/imports.ts` reads a relative import. The real
  path has to stay inside the root (the entry file's directory, unless a
  caller passes `rootDir`). The hash pin is the raw bytes, 64 hex digits,
  with an optional `sha256:` prefix. A symlink that leaves the root, a
  directory, a FIFO, a cycle, and a file that changes while it is read are
  errors. `/proc/self/fd` is an extra check when that path exists. There is
  no package registry. File-level `import` is stored on the AST.
  `compiler/src/__tests__/imports.test.ts` covers the resolver.
- **Import wiring.** `compileSpec` expands imports before it calls a backend.
  `lower` does the same when `resolveImports` is set, and it no longer warns
  that import resolution is not implemented. `import` is `n/a` in the
  conservation table. A missing file, a cycle, a duplicate alias, an absolute
  path, and a root that does not contain the import are errors. A missing
  member-type list after lowering is an error.
  `compiler/src/__tests__/import-wire-edges.test.ts` covers those cases.
- **Import CLI.** `speckl --root` sets the directory `compileSpec` already
  accepted. `--root /` widens it to the whole filesystem. An absolute import
  path, a missing file, a cycle, and a duplicate alias are errors.
  `--root` with no directory does not widen the root, so `import "../x"`
  still fails. `--root` set to the entry file itself does not contain an
  import. A same-directory import does not need the flag.
  `compiler/src/__tests__/cli-root.test.ts` runs the CLI.
- **Agent tool short form.** `tool FetchAssets effect act` infers the
  agent-facing name `fetch_assets` from its action; `tool FetchAssets ->
  custom_name effect act` specifies an alias. Effects remain required and the
  existing `tool custom_name -> FetchAssets effect act` form remains supported.
  Prompt tool references use the agent-facing name.
- **`prompt tool`.** `prompt tool NAME` attaches an advisory work brief to a
  declared agent-facing tool. NAME is that tool's agent-facing name, such as
  `draft_metadata`, not the action name. The brief may be inline text (a JSON
  string) or a relative file, and may also name a declared stage and/or await
  (`stage` before `await` when both are present). At compile time the text is
  written into that tool's `tools.json` description and the matching
  `AGENTS.md` section: the tool section, or the named await's section when an
  await is set. Hooks and Z3 do not execute the prompt text. Stage and await
  labels are associations on the compiled brief, not runtime filters. Unknown
  tool, stage, or await names are rejected at parse time. A stage qualifier
  requires a `stages` map. Prompt file paths are local and relative to the
  spec, not the current working directory; absolute paths and URLs are
  rejected at compile time. The spec hash fingerprints the spec text, not
  referenced prompt files. `instruction` remains for standing agent-level
  defaults. Existing tool `description` and `description file` remain
  supported.
- **`examples/PodcastPublishing.speckdl`.** A podcast metadata workflow
  with call-bound host approval for initial updates and corrections. Two
  model invariants are checked to depth 8, with a weakened-guard regression
  test. The example models the workflow; platform integrations and content
  validation remain the implementer's responsibility. See
  `examples/PodcastPublishing.md` and `example-podcast-publishing.test.ts`.
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
- **Token parser is called by `parseSpeckContent`.** `compiler/src/parser.ts` calls `parseSpeckDocument` from `compiler/src/rd-parser.ts`. Coverage includes `rd-parser.ts` and `speck-span.ts`. `parseSpeckContent calls the token parser` and `lowers every speck in the repo to the same IR` are in `compiler/src/__tests__/walker-vs-rd.test.ts`.

### Changed

- **Malformed spec structure is rejected.** The line walker used to accept a missing `}`, an extra `}`, text after `}`, an unrecognized member, and `§`, and it folded an unrecognized state field or init line into the previous text. It now rejects those. The message names the line and column, except an unrecognized state field and an unrecognized init line, which name the line only. The examples are well-formed, so the output pin is unchanged.

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

### Breaking

Parse errors below are breaking changes. A file that used to compile now fails, or the diagnostic text changed.

- **A speck that never closes is rejected.** `speck A {` with no closing brace used to parse as speck A with no members. The body was missing. The diagnostic is: Parse error at bad.speckdl:1: missing final "}" (column 9). `rejects a missing close` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An extra closing brace is rejected.** `speck A {` followed by `}` and another `}` used to parse as speck A with no members. The diagnostic is: Parse error at bad.speckdl:3: extra "}" (column 1). `rejects an extra close` in `compiler/src/__tests__/walker-strict.test.ts`.
- **Text after a speck's closing brace is rejected.** `} junk` used to parse as speck A with no members. The diagnostic is: Parse error at bad.speckdl:2: text after a speck's "}" (column 3). `rejects text after a close` in `compiler/src/__tests__/walker-strict.test.ts`.
- **A second speck on one line is rejected.** `speck A { } speck B { }` used to parse as only speck A. Speck B was dropped. The diagnostic is: Parse error at bad.speckdl:1: a second speck on one line (column 13). `rejects a second speck on one line` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unrecognized member is rejected.** `garbage line here`, `actoin go {`, `enum Status { Active, Inactive }`, a description line, and a bare `x := x + 3` used to be dropped or folded into a neighbor. Each diagnostic is unrecognized member with a line and column. `rejects an unrecognized member` in `compiler/src/__tests__/walker-strict.test.ts`.
- **Unrecognized top-level text is rejected.** `spek B {` after a closed speck used to leave only speck A. `*/ speck A {` used to leave no specks. Both diagnostics are unrecognized top-level at column 1. `rejects an unrecognized top-level name` in `compiler/src/__tests__/walker-strict.test.ts`.
- **Text after a member's closing brace is rejected.** `invariant P { x >= 0 } junk` used to store an empty expression. The diagnostic is: Parse error at bad.speckdl:2: text after a member's "}" (column 28). `rejects text after a member close` in `compiler/src/__tests__/walker-strict.test.ts`.
- **A member `{` on the next line is rejected.** `invariant P` with `{` on the next line used to drop the invariant and keep an empty state. The diagnostic is: Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5). `rejects a brace on the next line` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unrecognized state field is rejected.** `y Nat` after `x: Nat` used to be stored as the type `Nat y Nat`. The diagnostic is: Parse error at st.speckdl:2: unrecognized state field "y Nat", with no column. `rejects an unrecognized state field` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unrecognized init line is rejected.** `y = 0` after `x := 0` used to be stored as `0 y = 0`. `garbage line` used to be stored as `0 garbage line`. Each diagnostic is unrecognized init line on the init header's line, with no column. `rejects an unrecognized init line, without a column` in `compiler/src/__tests__/walker-strict.test.ts`.
- **Code after `*/` on a `/*` line is rejected.** `/* c */ action go {` used to drop the action. The diagnostic is: Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13). `rejects code after a block comment on the same line` in `compiler/src/__tests__/walker-strict.test.ts`.
- **CR-only line endings are rejected.** A file of `speck A {` and a state joined by a bare carriage return used to parse as speck A with no members. The diagnostic is: Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10). CRLF is still accepted. `rejects a CR-only file` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unexpected non-ASCII character is rejected.** `§` and `→` used to parse as speck A with no members. The diagnostics are unexpected character "§" at column 2 and unexpected character "→" at column 7. `rejects a section sign` and `rejects an arrow character` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An identifier that starts with a digit is rejected.** `speck 9A` used to parse as a speck named `9A`. The diagnostic is: Parse error at bad.speckdl:1: identifier must not start with a digit (column 7). `state { t: 24h }` still parses. `rejects a digit name` and `still parses a duration` in `compiler/src/__tests__/walker-strict.test.ts`.
- **A non-ASCII identifier is rejected.** `naïve` used to be dropped, leaving speck A with no members. The diagnostic is: Parse error at bad.speckdl:2: identifier must be ASCII (column 7). `rejects a non-ASCII identifier` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unsupported numeric literal is rejected.** `state { t: 1h30m }` used to store an empty state. The diagnostic is: Parse error at bad.speckdl:2: unsupported numeric literal "1h30m" (column 16). `rejects an unsupported numeric literal` in `compiler/src/__tests__/walker-strict.test.ts`.
- **An unclosed string or block comment names its column.** `x: "ab` was unterminated string with no column. It is now Parse error at bad.speckdl:2: unterminated string (column 8). `/* c` was unterminated block comment and is now Parse error at bad.speckdl:2: unterminated block comment (column 5). `names the column of an unclosed string and an unclosed block comment` in `compiler/src/__tests__/walker-strict.test.ts`.

## [0.3.1] and earlier

Unreleased development versions published only as source (#1).

[0.4.0]: https://github.com/wscoble/speckl/releases/tag/v0.4.0
