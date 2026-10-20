# Changelog

All notable changes to the Speckl compiler (npm package `speckl`). The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/) (0.x: minor versions
may change generated output).

## [0.4.0] - unreleased

First npm release. The package was renamed from the unpublished
`speckl-compile` to `speckl`; `speckl-compile` stays as a bin alias.

### Added

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
- Examples: `AgentPolicy`, `ReviewGate`, `ClaudeCodePolicy`.

### Removed

- **Elm `component` blocks** (#13). The component path in the Elm generator
  and parser had no users. A `component` block is now a parse error
  ("component blocks are no longer supported"). The Go generator's `COND-GUARD` debug print and the unused
  `lowerParserActionStatement` are gone too. Generated output for all
  examples is byte-identical, and the coverage floor rises to 88% lines and
  statements, 86% branches and 97% functions.

### Fixed

- **Vacuous BMC proofs** (#3). The Z3 backend scraped `next:` from raw source
  and read past it into `verify` blocks, so BMC only stuttered and every
  `Always` obligation "proved". Multi-line relations lost alternatives
  (KafkaKRaft, SQLitePager, OAuth2), and SQLiteWAL had no transitions. Unknown
  action names in `next:` now fail the compile.
- `verify-z3` checks every `(check-sat)` obligation against its own
  `speckl-expect` marker, not only the last one per file (#2).

### Known issues (tracked for the next release)

- The AST Z3 output still ends with `(get-model)` after an `unsat` answer,
  which makes a raw `z3` run exit 1. `speckl verify` handles this.
- The IR Z3 backend does not yet emit `Always` invariants, so it reports fewer
  obligations than the AST backend.
- Deny messages from generated guards show stage numbers, not names.

## [0.3.1] and earlier

Unreleased development versions published only as source (#1).

[0.4.0]: https://github.com/wscoble/speckl/releases/tag/v0.4.0
