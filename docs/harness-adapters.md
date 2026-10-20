# Harness adapters (Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot CLI, Goose, Hermes Agent)

`hook.mjs` only enforces a policy if the agent harness calls it before and
after every tool call. A `harness` block in the spec's `agent { }` makes
`-t agent` generate that wiring:

```
<out>/agent/
  adapter.mjs                      maps the harness's hook JSON onto hook.mjs
  harness/claude-code/settings.json  reference .claude/settings.json hooks
  harness/cursor/hooks.json          reference .cursor/hooks.json hooks
  harness/codex/hooks.json           reference .codex/hooks.json hooks
  harness/gemini/settings.json       reference .gemini/settings.json hooks
  harness/copilot/speckl.json        reference .github/hooks/speckl.json hooks
  harness/goose/hooks.json           reference .agents/plugins/speckl/hooks/hooks.json
  harness/hermes/config.yaml         reference hooks: block for the Hermes config.yaml
```

`node adapter.mjs install <harness> ...` merges the wiring into the project's
settings file with the right paths, keeping any hooks you already have.

## Declaring the mapping

Harness tool names (`Bash`, `Edit`, `mcp__github__create_pull_request`,
Cursor's `Shell`, `Write`, `MCP:<tool>`) are not spec tools. Each `map` line
says which spec tool a harness call becomes:

```
agent {
    tool run_tests -> RunTests effect act
    tool read_file -> ReadFile effect observe
    ...
    harness claude-code {
        map Read -> read_file { path = file_path }
        map Bash command ~ "npm (run )?test" -> run_tests
    }
    harness cursor {
        map Shell command ~ "npm (run )?test" -> run_tests
    }
}
```

- `map A|B` lists harness tool names, matched exactly as the harness reports them.
- `field ~ "regex"` tests one `tool_input` field. The regex (JavaScript syntax)
  must match the **whole** value. Inside the quotes only `\"` is an escape; keep
  any `{ }` in a pattern balanced.
- `{ param = field }` feeds an action parameter from a differently named
  `tool_input` field. Parameters not listed read the field of the same name; a
  missing field denies.
- First matching line wins. **A call that matches no line is denied.**
- A matched value containing `;`, `&`, `|`, a backtick, `$`, `<`, `>` or a
  newline is denied, so `npm test; git push` can't ride on the `npm test` line.
- Every tool input (except free-text fields such as `content`, `new_string`,
  `description`) is checked against the rails: the agent directory, the state
  file (and its directory when that is not the project root), the key file,
  `.claude/`, `.cursor/`, `.codex/`, `.gemini/`, and for each declared harness
  its own config (`.github/hooks/`; `.agents/plugins/` and `.config/goose/`;
  `.hermes/` and the `--hermes-home` directory). A call that names one is
  denied, whatever the tool.

The compiler rejects unknown harnesses, targets that are not declared tools,
parameters the action doesn't have, and patterns that don't compile.
`examples/ClaudeCodePolicy.speckdl` is a complete policy.

## Quickstart: Speckl + Claude Code in 10 minutes

This session runs as written (it is executed by
`compiler/src/__tests__/harness-docs-quickstart.test.ts`).

```bash
# 1. A project with a test suite.
mkdir greet && cd greet
git init -q
cat > package.json <<'JSON'
{ "name": "greet", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > greet.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
test('greets', () => assert.strictEqual('hello', 'hello'));
JS
npm test --silent

# 2. The policy: edit and test freely; commit for review only when green;
#    push only after a human approves; any edit throws the approval away.
curl -fsSL https://raw.githubusercontent.com/wscoble/speckl/main/examples/ClaudeCodePolicy.speckdl -o policy.speckdl

# 3. Compile it into .speckl/ (AGENTS.md, hook.mjs, adapter.mjs, ...).
speckl-compile policy.speckdl -t agent -o .speckl

# 4. Create the signed state. The key lives outside the project, where the
#    agent's tools can't reach it. --dev allows the terminal approval below.
mkdir -p "$HOME/.config/speckl"
KEY="$HOME/.config/speckl/greet.key"
node .speckl/agent/signal.mjs init --state .speckl/state.json --key "$KEY" --dev

# 5. Wire it into Claude Code and give Claude the rules.
node .speckl/agent/adapter.mjs install claude-code --project . --state .speckl/state.json --key "$KEY"
echo '@.speckl/agent/AGENTS.md' >> CLAUDE.md

# 6. Dry run: feed the hook what Claude Code sends before a push.
PRE="node .speckl/agent/adapter.mjs claude-code pre --state .speckl/state.json --key $KEY"
! echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push -u origin main"},"tool_use_id":"t1"}' | $PRE
! echo '{"hook_event_name":"PreToolUse","tool_name":"WebFetch","tool_input":{"url":"https://example.com"},"tool_use_id":"t2"}' | $PRE
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"t3"}' | $PRE
```

The first two calls print the reason and exit 2, which is how Claude Code is
told to block: the push needs green tests, a review and an approval, and
`WebFetch` has no `map` line. The third is allowed (exit 0, no output), so
Claude Code's normal permission flow decides as usual. Speckl never
auto-approves anything.

Now start Claude Code in the project (`claude`) and ask it to change the
greeting and push. It can edit and run `npm test`; `git commit -m "..."` moves
the run to review, and from then on act tools are refused until you approve
from **your own** terminal:

```sh
node .speckl/agent/signal.mjs apply --state .speckl/state.json --key "$KEY" \
  --verifier cli --outcome approve --as you --claim_reviewer you
```

Then the push goes through. Run `/hooks` inside Claude Code to see the four
Speckl hooks. Production setups drop `--dev` and approve with a signed
`file-drop` verifier (see `agent-signals.md`).

## Quickstart: GitHub Copilot CLI, Goose and Hermes

Same project and policy as above (steps 1 to 4), then wire the harness you
use. This session runs as written too (the same test executes it).

```bash
# 5. Wire the harnesses. Copilot reads .github/hooks/*.json; Goose loads
#    project plugins from .agents/plugins/; Hermes reads the hooks: block of
#    its profile's config.yaml (here a scratch profile) and needs consent,
#    which install records for exactly these commands.
node .speckl/agent/adapter.mjs install copilot --project . --state .speckl/state.json --key "$KEY"
node .speckl/agent/adapter.mjs install goose --project . --state .speckl/state.json --key "$KEY"
HERMES_PROFILE="$HOME/.hermes-greet"
node .speckl/agent/adapter.mjs install hermes --project . --state .speckl/state.json --key "$KEY" --hermes-home "$HERMES_PROFILE"

# 6. Dry run with what each harness sends before a push: all three deny
#    with exit 2 and say why on stderr (Copilot and Goose/Hermes also get
#    their deny JSON on stdout).
COPILOT="node .speckl/agent/adapter.mjs copilot pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"sessionId":"s1","timestamp":1792447961204,"cwd":"'"$PWD"'","toolName":"bash","toolArgs":"{\"command\":\"git push -u origin main\"}"}' | $COPILOT
GOOSE="node .speckl/agent/adapter.mjs goose pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"event":"PreToolUse","session_id":"s2","tool_name":"shell","tool_input":{"command":"git push -u origin main"},"tool_call_id":"g1","working_dir":"'"$PWD"'"}' | $GOOSE
HERMES="node .speckl/agent/adapter.mjs hermes pre --state .speckl/state.json --key $KEY --project $PWD --hermes-home $HERMES_PROFILE"
! echo '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"git push -u origin main"},"session_id":"s3","extra":{"tool_call_id":"h1"}}' | $HERMES
```

Then start the agent in the project: `copilot`, `goose session` (from the
project root, see Limits) or `HERMES_HOME="$HERMES_PROFILE" hermes`.
Approve from your own terminal with `signal.mjs apply` as above.

## What the adapter does

| Claude Code event | Adapter | hook.mjs |
| --- | --- | --- |
| `PreToolUse` | `pre` | `pre` with `{tool, input, call_id: tool_use_id}` |
| `PostToolUse` | `post` | `post` with `ok: true` (false if the response says interrupted / error) |
| `PostToolUseFailure` | `post-failure` | `post` with `ok: false` (a failing `npm test` lands here) |
| `PostToolBatch` | `batch` | `post` with `ok: false` for any call in the batch still pending |

| Cursor event | Adapter | hook.mjs |
| --- | --- | --- |
| `preToolUse` | `pre` | `pre` |
| `postToolUse` | `post` | `post`, `ok: false` when `tool_output.exitCode` is non-zero |
| `postToolUseFailure` | `post-failure` | `post` with `ok: false` (errors, timeouts, permission denials) |

Answers:

- **Claude Code** allow: exit 0, no output (normal permission flow applies).
  Deny: exit 2, reason on stderr. A post-hook problem exits 2 so Claude sees it.
  The batch hook always exits 0 (exit 2 there would stop the agent loop).
- **Cursor** allow: `{"permission":"allow"}`. Deny: `{"permission":"deny",
  "user_message", "agent_message"}` and exit 2 (both mean block).

| Codex CLI event | Adapter | hook.mjs |
| --- | --- | --- |
| `PreToolUse` | `pre` | `pre` with `call_id: tool_use_id`; `apply_patch` input gains `files` and `path` (first file) |
| `PostToolUse` | `post` | `post`; **`Bash` is always `ok: false`**, `apply_patch` needs `Exit code: 0`, MCP needs `isError` false |
| `Stop` | `turn-end` | `post` with `ok: false` for a call still pending (declined at the approval prompt) |

| Gemini CLI event | Adapter | hook.mjs |
| --- | --- | --- |
| `BeforeTool` | `pre` | `pre`; Gemini sends no call id, so the adapter derives one from `session_id` + `tool_name` |
| `AfterTool` | `post` | `post`; `ok: false` on `tool_response.error`, and for `run_shell_command` on an `Exit Code:` / `Signal:` / `Error:` line or a backgrounded command |
| `AfterAgent` | `turn-end` | `post` with `ok: false` for a call still pending (cancelled confirmation) |

- **Codex** allow: exit 0, no output (Codex's own approval flow applies). Deny:
  exit 2, reason on stderr. Post problems go to the model as
  `hookSpecificOutput.additionalContext` with exit 0. An exit 2 there would
  replace the tool output.
- **Gemini** allow: exit 0 and `{}`. Deny: exit 2, reason on stderr (sent to
  the model as the tool error). Post problems go out as `additionalContext`.
  The `AfterAgent` hook always exits 0, because exit 2 there forces a retry turn.

**Codex Bash calls never count as a success.** Codex gives `PostToolUse` the
command's output text without its exit status (`codex-rs/core/src/tools/context.rs`,
`ExecCommandToolOutput::post_tool_use_response`). A failing `npm test` would
look exactly like a passing one. So Speckl still allows or denies Bash calls,
but every one is recorded as not successful and never advances the policy.
The adapter tells the model so. Run gated steps (tests, review requests, PRs)
through MCP tools, whose results carry `isError`. See the `harness codex` block
in `examples/ClaudeCodePolicy.speckdl`.


| Copilot CLI event | Adapter | hook.mjs |
| --- | --- | --- |
| `preToolUse` | `pre` | `pre`; camelCase `toolName` / `toolArgs` (a JSON string or an object). No call id is sent, so one is derived from `sessionId` + `toolName` (a VS Code-shaped `tool_use_id` wins) |
| `postToolUse` | `post` | `post`; `ok: true` only for `toolResult.resultType: "success"`, and for `bash` / `powershell` only when the text ends in `<exited with exit code 0>` |
| `postToolUseFailure` | `post-failure` | `post` with `ok: false` (errors, rejected calls) |
| `agentStop` | `turn-end` | `post` with `ok: false` for a call still pending |

| Goose event | Adapter | hook.mjs |
| --- | --- | --- |
| `PreToolUse` | `pre` | `pre` with `call_id: tool_call_id`; the payload names its event in `event` |
| `PostToolUse` | `post` | `post` with `ok: true` (Goose fires it only when the result is not an error; a non-zero shell exit is an error) |
| `PostToolUseFailure` | `post-failure` | `post` with `ok: false` |
| `Stop` | `turn-end` | `post` with `ok: false` for a call still pending |

| Hermes event | Adapter | hook.mjs |
| --- | --- | --- |
| `pre_tool_call` | `pre` | `pre` with `call_id: extra.tool_call_id` |
| `post_tool_call` | `post` | `post`; `ok: true` only for `extra.status: "ok"`, and for `terminal` only when the result has `exit_code: 0`. Status `blocked`: no-op, unless our own pending call was blocked by another hook (then `ok: false`) |
| `on_session_end` | `turn-end` | `post` with `ok: false` for a call still pending (fires at the end of every turn) |

- **Copilot** allow: exit 0, no output. Deny: exit 2, reason on stderr, and
  `{"permissionDecision":"deny","permissionDecisionReason",...}` on stdout
  (plus the VS Code `hookSpecificOutput` shape). Post problems go to the model
  as `additionalContext`. `agentStop` never blocks (a block forces another turn).
- **Goose** allow: exit 0, no output. Deny: exit 2, reason on stderr, and
  `{"decision":"block","reason"}` on stdout. Post and `Stop` hooks only log
  (Goose ignores their output; a `Stop` block would force the turn on).
- **Hermes** allow: exit 0, no output. Deny: exit 2, reason on stderr, and
  `{"decision":"block","reason"}` on stdout; the reason becomes the tool result.
  `post_tool_call` and `on_session_end` output is ignored, so they only log.

Install for all three writes absolute paths and `--project <root>`: Copilot,
Goose and Hermes report a working directory but no project root.

Install for Codex and Gemini writes absolute paths and `--project <root>`. Codex runs
hooks from the session cwd, and Gemini sets `GEMINI_PROJECT_DIR` to it, so a
session started in a subdirectory would otherwise resolve the rails wrong.
Codex also only runs project hooks after you review and trust them (`/hooks`).
Gemini fingerprints project hooks and asks again when they change.

### Fail closed

Both harnesses let a call through when a hook fails unless told otherwise
(Claude Code: exit codes other than 0/2, crashes and timeouts are non-blocking;
Cursor: crashes, timeouts and non-zero exits other than 2 fail open). So:

- The adapter answers **deny** for anything other than a well-formed allow from
  hook.mjs: exit 1, any other code, a crash, a kill, a timeout
  (`SPECKL_HOOK_TIMEOUT_MS`, default 20 s, below the 30 s hook timeout) or
  malformed output. Its own errors (bad payload, corrupt config) deny too.
- The generated Claude Code wiring sets `"onFailure": "block"` on `PreToolUse`
  (Claude Code v2.1.295 or later), so a missing node, a bad path or a timeout of
  the adapter itself blocks. The Cursor wiring sets `"failClosed": true` on
  every hook.
- Codex and Gemini have no fail-closed switch. Any exit code other than 2 lets
  the call through. The adapter therefore always exits 2 on error, and the
  generated pre command ends in `|| exit 2`. That way a missing `node` (exit
  127) or a crash before the adapter decides also blocks. What remains open is
  the harness killing the adapter at its own timeout (30 s, above the adapter's
  20 s hook budget).
- **Copilot CLI** `preToolUse` command hooks are fail-closed by design: exit 2,
  a crash or any other non-zero exit denies, whatever stdout says. Only a
  timeout lets the call through (documented, not configurable), so
  `timeoutSec` is 30 and the adapter's own hook.mjs budget stays at 20 s. The
  pre command still ends in `|| exit 2`.
- **Goose** lets a call through on any hook failure unless the action says
  otherwise. The generated `PreToolUse` action sets `"on_failure": "block"`
  (spawn error, timeout, signal, undecodable or decision-less output all deny;
  Goose 1.55.0) and the command ends in `|| exit 2` for older builds.
- **Hermes** runs hooks without a shell, so `|| exit 2` is not available; the
  generated `pre_tool_call` entry sets `fail_closed: true` (a missing command,
  a timeout, a non-zero exit without a directive and non-JSON stdout block;
  Hermes v0.22). `fail_closed` does not exist for other events.
- `example-copilot-goose-hermes-policy.test.ts` runs the same crash / `exit 1` /
  garbage / `SIGKILL` / hang / corrupt config / missing `node` matrix through
  the exact commands Copilot (bash), Goose (`sh -c`) and Hermes (argv, no
  shell) run, plus malformed and mismatched payloads.
- `compiler/src/__tests__/example-claude-code-policy.test.ts` and
  `example-codex-gemini-policy.test.ts` replace hook.mjs with a crash,
  `exit 1`, garbage output, `SIGKILL` and a hang, and check that each blocks
  in all four harnesses. The Codex and Gemini tests also run the wiring
  without `node` on `PATH`.

### Stuck calls

Speckl allows one tool call in flight. A call that Claude Code allowed but the
user then declined in the permission prompt never gets a `PostToolUse`; the
`PostToolBatch` hook clears it as failed (state not advanced). Cursor reports
declines through `postToolUseFailure`. Parallel tool calls are refused with
"another tool call is already pending"; the agent retries them one at a time
(AGENTS.md tells it to).

## Limits (read before relying on it)

- Speckl gates the **protocol** of tool calls; it is not a sandbox. A mapped
  `npm test` runs whatever the test script runs, and the agent can edit that
  script. Pair the policy with Claude Code's sandbox or a separate OS user if
  the agent must not reach the key or `signal.mjs` that way.
- `Grep`/`Glob` over the whole project can return lines from `.speckl/` (the
  state is integrity-protected, not secret). Keep the key outside the project.
- Path checks see paths as written; they don't follow symlinks.
- Cursor can also load Claude Code hooks ("third-party hooks"). Wire one
  harness per project, or Cursor may call the Claude Code adapter with Cursor
  tool names, which it will deny.
- Codex: hosted tools (web search) don't go through hooks, and
  `write_stdin` to a running session doesn't re-run `PreToolUse`. A command
  started in the background (`Process running with session ID`) gets no
  `PostToolUse` until it finishes. Until then it stays pending and later calls
  are refused, or `Stop` clears it as failed.
- Gemini: the derived call id relies on one call in flight (Speckl refuses
  parallel calls). Gemini's edit tools may correct their own arguments, which
  is why the id doesn't include them.
- Cursor documents MCP tool names as `MCP:<tool_name>` for matchers; check the
  Hooks output channel for the exact `tool_name` your build sends before
  writing `map` lines for MCP tools. Cursor runs `preToolUse` in cloud agents,
  but not `beforeMCPExecution`.

- Copilot CLI: a hook timeout always lets the call through (see Fail closed).
  The CLI also loads `.claude/settings.json` hooks and sends them Copilot
  payloads; with both `claude-code` and `copilot` installed, the Claude Code
  adapter sees calls without a `tool_use_id` and denies them all. Wire one of
  the two. VS Code's Copilot agent reads `.github/hooks/` too, but its own
  tool names differ and it treats exit codes other than 2 as warnings; this
  adapter is checked against the CLI / cloud agent only. Cloud-agent hooks run
  in an ephemeral sandbox: the state and key must be provisioned there.
- Goose loads project plugins only when it starts in the project root (the
  process cwd is the project root it uses). A session started in a
  subdirectory runs with **no** hooks. Install a user-scope plugin instead to
  cover that: `install goose ... --plugins-dir ~/.agents/plugins` writes
  `~/.agents/plugins/speckl-<hash>/`; it judges sessions whose working
  directory is inside the project, lets sessions elsewhere through, and still
  denies any call there that names the rails. Goose plugins listed in
  `disabledPlugins` do not run; `.config/goose/` is protected in the project,
  but a user-level `~/.config/goose/settings.json` is the user's to keep.
- Hermes: hooks are per profile, not per project. Use a dedicated profile
  (`--hermes-home`, `HERMES_HOME`) for the governed project, or every session
  of that profile is judged by this policy. A hook that is not in the
  profile's `shell-hooks-allowlist.json` is skipped (no rails); `install`
  records consent for its three commands, and `hermes hooks list` shows them.
  Revoking them, or editing `config.yaml` so the commands change, turns the
  rails off until consent is given again.

## Sources

- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
  (PreToolUse input and decision control, exit code 2, `onFailure`,
  PostToolUseFailure, PostToolBatch, `${CLAUDE_PROJECT_DIR}`). Checked 2026-10-19.
- Cursor hooks: <https://cursor.com/docs/agent/hooks> (`hooks.json` version 1,
  `preToolUse` / `postToolUse` / `postToolUseFailure` payloads, `permission`
  output, exit code 2, `failClosed`, project hooks run from the project root).
  Checked 2026-10-19.
- Codex hooks: <https://learn.chatgpt.com/docs/hooks> (hook locations,
  PreToolUse / PostToolUse / Stop payloads, `permissionDecision`, exit code 2,
  timeout in seconds, tool coverage, trust). Source: `openai/codex`
  `codex-rs/hooks/src/events/pre_tool_use.rs`, `codex-rs/core/src/tools/context.rs`.
  Checked 2026-10-19 against `@openai/codex` 0.163.0.
- Gemini CLI hooks: <https://geminicli.com/docs/hooks/reference/> and
  <https://geminicli.com/docs/hooks/> (BeforeTool / AfterTool / AfterAgent,
  regex matchers, timeout in ms, exit code 2, `GEMINI_PROJECT_DIR`). Shell
  tool output format checked in the `@google/gemini-cli` 0.64.0 bundle.
- GitHub Copilot hooks reference:
  <https://docs.github.com/en/copilot/reference/hooks-reference> (`.github/hooks/*.json`
  `version: 1`, camelCase and VS Code-compatible payloads, `preToolUse`
  `permissionDecision`, exit 2, fail-closed `preToolUse` except timeouts,
  `postToolUse` success-only, `postToolUseFailure`, `agentStop`, tool names) and
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks>
  (`toolArgs` as a JSON string). Shell result format `<exited with exit code N>`:
  `microsoft/vscode` `extensions/copilot/src/extension/chatSessions/copilotcli/common/copilotCLITools.ts`.
  Tool argument names (`create.file_text`, `edit.old_str`/`new_str`,
  `apply_patch.input`) from the same file. Checked 2026-10-19 (`@github/copilot` 1.0.100).
- Goose hooks: `aaif-goose/goose` `documentation/docs/guides/context-engineering/hooks.md`
  (plugin layout, `hooks.json`, payload fields, decision rules, `on_failure`,
  built-in tool input keys), `crates/goose/src/hooks/mod.rs` (`HookContext`,
  `tool_call_id`), `crates/goose/src/agents/agent.rs` (project root = process
  cwd). Checked 2026-10-19 against commit fb9e3c8 and run live with the
  goose 1.55.0 release binary (see below).
- Hermes Agent shell hooks: `NousResearch/hermes-agent`
  `website/docs/user-guide/features/hooks.md`, `agent/shell_hooks.py`
  (`_serialize_payload`, `_evaluate_result`, `fail_closed`, allowlist),
  `model_tools.py` (`post_tool_call` status, `blocked`), `agent/display.py`
  (`_detect_tool_failure`: terminal `exit_code`). Checked 2026-10-19 against
  tag v0.22.2 (PyPI's `hermes-agent` 0.19.0 predates `fail_closed`).

### Live runs (2026-10-19)

No credentials were used. Goose 1.55.0 (release binary) ran `goose run` against
a local mock OpenAI-compatible server that replays a fixed list of tool calls,
with this repo's example policy installed as a project plugin: the failing test
did not advance the policy, the early commit was denied (`can() refused`), the
push was denied (`HNTL`), reads of `.speckl/state.json` and edits of the plugin
were denied, `;` chains were denied, and crash / hang / corrupt config /
missing `node` all denied. With the plugin's `on_failure` removed, a hook that
printed garbage let the call through; with it, the call was blocked. A session
started in `src/` loaded no project plugin; the `--plugins-dir` install covered
it. Hermes v0.22.2 (source checkout) registered the hooks from the generated
`config.yaml` + allowlist and its real dispatcher (`model_tools.handle_function_call`)
ran `write_file`, `terminal` and `read_file` through them: the whole policy
walk to an approved push, the same denials, and crash / hang / missing `node`
/ corrupt config blocked (`fail_closed`). Without the allowlist entry the hook
was skipped. Copilot CLI needs a GitHub login, so it was not run live.
