# Harness adapters (Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot CLI, Goose, Hermes Agent, Pi, OpenCode, OpenClaw, Cline, Kiro, Windsurf)

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
  harness/pi/speckl.js               reference .pi/extensions/speckl.js extension
  harness/opencode/speckl.js         reference .opencode/plugins/speckl.js plugin
  harness/openclaw/index.js          reference .openclaw/plugins/speckl/ plugin
  harness/openclaw/openclaw.plugin.json, package.json
  harness/cline/PreToolUse, PostToolUse, TaskComplete, TaskCancel, TaskError
                                     reference .clinerules/hooks/ scripts
  harness/kiro/speckl.json           reference .kiro/hooks/speckl.json hooks
  harness/windsurf/hooks.json        reference .devin/hooks.json (and .windsurf/hooks.json)
```

`node adapter.mjs install <harness> ...` merges the wiring into the project's
settings file with the right paths, keeping any hooks you already have.
`--dry-run` prints every file it would create or change, and writes nothing.
A file `install` modifies is copied into `.speckl/harness-install/backups/`
first; the copy of what it wrote, and the record of which paths it created,
live next to that. `uninstall` deletes a path only when that path is one
`install` writes for this harness, it is inside the project, its real path
stays inside the project, and neither it nor a parent directory is a symlink.
The bytes still have to match the saved copy; a modified file is then put
back from the backup. `status` reads the config, the key file and the state
file. `doctor` does that and then runs the installed pre hook on a tool the
spec does not map; it passes only when that hook denies the call.

Pi, OpenCode and OpenClaw have no command hooks; they load JavaScript plugins
in-process. For them `install` writes a small generated plugin that runs
`node adapter.mjs <harness> <event> ...` for every tool call and allows the
call only when the adapter exits 0 **and** prints `{"decision":"allow"}`.
It never overwrites a plugin file it did not write.

Cline runs executable files named after the event from `.clinerules/hooks/`;
`install cline` writes five small `sh` scripts there that pipe the payload to
the adapter and turn anything but an explicit allow into a cancel. Kiro and
Windsurf (Devin Desktop) run hook commands from JSON files, as the others do.

## Checking, previewing and removing the wiring

```bash
node adapter.mjs install <harness> --project <dir> --state <file> [--key <file>] [--dry-run]
node adapter.mjs status <harness> --project <dir> --state <file> [--key <file>]
node adapter.mjs doctor <harness> --project <dir> --state <file> [--key <file>]
node adapter.mjs uninstall <harness> --project <dir> [--key <file>]
```

Hermes still takes `--hermes-home`. Goose, Pi and OpenCode still take `--plugins-dir`
on `install`, `status` and `doctor`. `uninstall` does not read those paths out of
the record: it recomputes the paths `install` would write. A Hermes profile or a
`--plugins-dir` that is outside the project is not deleted.

- `--dry-run` prints `create` or `modify` for each harness file, a unified diff,
  the backup path, and `dry-run: no files written`.
- `install` copies the previous bytes of any file it changes to
  `.speckl/harness-install/backups/<harness>/` and keeps that first backup on a
  later install. It also saves exactly the bytes it wrote. It does not weaken
  the hook: a refusal (bad JSON, a file Speckl did not write, a record it does
  not understand) still writes nothing.
- `status` reports whether the Speckl pre hook is in the config, whether the
  key file is 64 hex characters (it does not print the key), and the state's
  run id, stage and pending tool. `mac=present` means the signature field is
  there. It does not replay the log.
- `doctor` does the same checks, then runs **the installed pre command** with
  a tool name the spec does not map. It exits 0 only when that command's output
  contains the adapter's unmapped-tool deny **and** the reply is the block that
  harness actually enforces. For an exit of 0 that means: Cline `cancel: true`
  (boolean), Pi, OpenCode and OpenClaw `decision: "block"`, Cursor
  `permission: "deny"`. Any other exit 0 is `FAIL OPEN`, even when the deny
  text appears somewhere in the output. Claude Code, Codex, Gemini, Copilot,
  Goose, Hermes, Kiro and Windsurf block with exit 2, so doctor treats every
  exit 0 from them as `FAIL OPEN`. Exit 0 with the right block field but
  without the unmapped-tool text is `NOT PROVED`, not a pass. `HOOK MISSING`
  and `NOT PROVED` (exit 2 with no deny text, which a `|| exit 2` wrapper
  prints when `node` never started) are failures too.
  Claude Code commands quote `${CLAUDE_PROJECT_DIR}` (Gemini relative commands
  quote `${GEMINI_PROJECT_DIR}` the same way) so a project path that contains
  a space stays one argument when the shell expands it. Doctor runs that
  installed command under `sh`, so the quote is part of proving the hook is
  wired.
- `uninstall` restores backups and deletes files only when every one of these
  holds: the path is inside the project, it is exactly one of the config paths
  `install` writes for that harness (recomputed, not taken from the record),
  the real path stays inside the project with no symlinked parent, and the
  path itself is not a symlink. The current bytes still have to match the
  saved copy (a file already restored to its backup is finished, not refused).
  A file it is unsure about is left untouched and kept in the record. If any
  file is refused, the record stays so a later `uninstall` can finish the
  rest; files it already restored or removed are not rolled back. It never
  deletes the runtime under `.speckl/agent/`. Empty directories it created
  may remain. When `install` could read a 64-hex state key it stores an
  HMAC of the record; `uninstall` of that record needs the same `--key` and
  does nothing if the mac does not match. A record with no mac, and no key
  file, is not authenticated. `.speckl/harness-install/` is a protected
  path, so a tool call cannot write the record, the backups or the saved
  copies. That does not stop a process outside the hook.

Pi, OpenCode and OpenClaw have no command hook to exec. `doctor` runs the
`node adapter.mjs <harness> pre ...` line stored in the generated plugin and
says so. That does not prove the host loaded the plugin.

> **Not live-tested: Kiro, Windsurf and the Cline VS Code extension.** Their
> wiring is built and tested against payloads taken from their documentation
> and source (see Sources and `compiler/src/__tests__/fixtures/harness/README.md`),
> run through the exact commands the harness would run. None of the three was
> run end to end: Kiro and Windsurf need a signed-in IDE or account, and the
> Cline extension needs VS Code. The Cline **CLI** (3.0.73) was run live (see
> Live runs).

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
  `.claude/`, `.cursor/`, `.codex/`, `.gemini/`, `.speckl/harness-install/`,
  and for each declared harness
  its own config (`.github/hooks/`; `.agents/plugins/` and `.config/goose/`;
  `.hermes/` and the `--hermes-home` directory; `.pi/`; `.opencode/`,
  `opencode.json` and `opencode.jsonc`; `.openclaw/`). A call that names one
  is denied, whatever the tool.
- OpenCode `bash` and OpenClaw `exec` take a `workdir`. A call whose `workdir`
  is set and is not the project root is denied: `npm test` run in another
  checkout must not advance this project's policy.

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
node .speckl/agent/adapter.mjs doctor claude-code --project . --state .speckl/state.json --key "$KEY"
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
Speckl hooks. Production setups drop `--dev`, pin reviewer keys with
`signal.mjs init --signer`, and approve with a signed `file-drop` verifier
(see `agent-signals.md`). A `--pubkey` that was not pinned is refused.

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

## Quickstart: Pi, OpenCode and OpenClaw

Same project and policy as above (steps 1 to 4). This session runs as written
too (the same test executes it).

```bash
# 5. Write the plugins. Pi loads .pi/extensions/ (trusted projects only, see
#    Limits); OpenCode loads .opencode/plugins/; OpenClaw loads the plugin
#    directory you list in its config (install prints the two settings).
node .speckl/agent/adapter.mjs install pi --project . --state .speckl/state.json --key "$KEY"
node .speckl/agent/adapter.mjs install opencode --project . --state .speckl/state.json --key "$KEY"
node .speckl/agent/adapter.mjs install openclaw --project . --state .speckl/state.json --key "$KEY"

# 6. Dry run with what each plugin sends before a push: each answer is exit 2
#    and {"decision":"block",...}, so the plugin blocks the call.
PI="node .speckl/agent/adapter.mjs pi pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"type":"tool_call","toolName":"bash","toolCallId":"p1","input":{"command":"git push -u origin main"},"cwd":"'"$PWD"'"}' | $PI
OC="node .speckl/agent/adapter.mjs opencode pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"hook":"tool.execute.before","input":{"tool":"bash","sessionID":"s4","callID":"o1"},"output":{"args":{"command":"git push -u origin main"}},"directory":"'"$PWD"'"}' | $OC
CLAW="node .speckl/agent/adapter.mjs openclaw pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"hook":"before_tool_call","event":{"toolName":"exec","params":{"command":"git push -u origin main"},"toolCallId":"c1"},"ctx":{"sessionId":"s5"}}' | $CLAW
```

Then start the agent in the project: `pi` (run `/trust` once, or `pi --approve`
in print mode), `opencode`, or OpenClaw with
`plugins.load.paths` containing `.openclaw/plugins/speckl`,
`plugins.entries.speckl.enabled: true` and the agent workspace set to the
project (`openclaw agent exec --cwd .`). Approve from your own terminal with
`signal.mjs apply` as above.

## Quickstart: Cline, Kiro and Windsurf

Same project and policy as above (steps 1 to 4). This session runs as written
too (the same test executes it).

```bash
# 5. Wire the harnesses. Cline (CLI and VS Code) runs .clinerules/hooks/<Event>;
#    Kiro reads .kiro/hooks/*.json; Windsurf / Devin Desktop reads
#    .devin/hooks.json (install also writes the legacy .windsurf/hooks.json).
node .speckl/agent/adapter.mjs install cline --project . --state .speckl/state.json --key "$KEY"
node .speckl/agent/adapter.mjs install kiro --project . --state .speckl/state.json --key "$KEY"
node .speckl/agent/adapter.mjs install windsurf --project . --state .speckl/state.json --key "$KEY"

# 6. Dry run with what each harness sends before a push. Cline gets a
#    {"cancel":true,...} line (exit 0, as Cline reads stdout); Kiro and
#    Windsurf get exit 2 with the reason on stderr.
echo '{"hookName":"tool_call","taskId":"t1","workspaceRoots":["'"$PWD"'"],"tool_call":{"id":"k1","name":"run_commands","input":{"commands":["git push -u origin main"]}}}' \
  | .clinerules/hooks/PreToolUse | grep -q '"cancel":true'
KIRO="node .speckl/agent/adapter.mjs kiro pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"hook_event_name":"PreToolUse","session_id":"s6","cwd":"'"$PWD"'","tool_name":"execute_bash","tool_input":{"command":"git push -u origin main","cwd":"'"$PWD"'"}}' | $KIRO
WS="node .speckl/agent/adapter.mjs windsurf pre --state .speckl/state.json --key $KEY --project $PWD"
! echo '{"agent_action_name":"pre_run_command","trajectory_id":"w1","tool_info":{"command_line":"git push -u origin main","cwd":"'"$PWD"'"}}' | $WS
```

Then start the agent in the project: `cline "..."` or the Cline extension
(hooks are on by default), Kiro IDE or `kiro-cli` (hooks in `.kiro/hooks/`
load at session start), or Windsurf / Devin Desktop with the workspace
trusted (hooks do not run in Restricted Mode). Approve from your own terminal
with `signal.mjs apply` as above.

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

| Pi event | Adapter | hook.mjs |
| --- | --- | --- |
| `tool_call` | `pre` | `pre` with `call_id: toolCallId` |
| `tool_result` | `post` | `post`; `ok: true` only for `isError: false`, and for `bash` only with `structuredContent.exit_code: 0`. Fires for every executed call, including tools that throw |
| `agent_end` | `turn-end` | `post` with `ok: false` for a call still pending |

| OpenCode hook / event | Adapter | hook.mjs |
| --- | --- | --- |
| `tool.execute.before` | `pre` | `pre` with `tool: input.tool`, `input: output.args`, `call_id: input.callID`; `apply_patch` `patchText` gains `files` and `path` |
| `tool.execute.after` | `post` | `post`; fires only on success; `bash` needs `metadata.exit: 0` (`null` after a timeout) |
| `message.part.updated` (tool part, `state.status: "error"`) | `post-failure` | `post` with `ok: false` for our pending call; ignored for any other call (it also fires for calls Speckl denied) |
| `session.idle` | `turn-end` | `post` with `ok: false` for a call still pending |

| OpenClaw hook | Adapter | hook.mjs |
| --- | --- | --- |
| `before_tool_call` | `pre` | `pre` with `tool: event.toolName`, `input: event.params`, `call_id: event.toolCallId`; `apply_patch` `input` gains `files` and `path` |
| `after_tool_call` | `post` | `post`; `ok: true` only with no `error`, a result that is not `isError`, and for `exec` `details.status: "completed"` with `exitCode: 0` (a yielded `running` exec is a failure). `details.status: "blocked"`: no-op, unless it is our pending call |
| `session_end` | `turn-end` | `post` with `ok: false` for a call still pending |

- **Pi, OpenCode, OpenClaw** allow: exit 0 and `{"decision":"allow"}`. Deny:
  exit 2, `{"decision":"block","reason"}` and the reason on stderr. The plugin
  turns a deny into Pi's `{block: true, reason}`, an OpenCode `throw`, or
  OpenClaw's `{block: true, blockReason}`; the reason reaches the model as the
  tool error. Post problems come back as `{"additionalContext"}`: appended to
  the tool result (Pi, OpenCode) or logged (OpenClaw's `after_tool_call` is
  observe-only).

| Cline hook file | Adapter | hook.mjs |
| --- | --- | --- |
| `PreToolUse` (CLI `hookName: "tool_call"`, VS Code `"PreToolUse"`) | `pre` | `pre` with `tool: tool_call.name`, `input: tool_call.input`, `call_id: tool_call.id`. The VS Code extension sends only `preToolUse: {toolName, parameters}` with every value as a string: JSON-looking values are parsed back and the call id is derived from `taskId` + tool name. `run_commands` exposes a single plain command as `command`; several commands map to nothing (deny) |
| `PostToolUse` (`tool_result` / `PostToolUse`) | `post` | `post`; `ok: true` only with no `error` and, for an output array (`run_commands`, `read_files`), every entry `success: true`. A failing command is `{success: false}` inside an otherwise successful result. VS Code sends `String(output)` (`[object Object]`), so a `run_commands` result there never counts |
| `TaskComplete`, `TaskCancel`, `TaskError` (`agent_end` / `agent_abort` / `agent_error`) | `turn-end` | `post` with `ok: false` for a call still pending |

| Kiro trigger | Adapter | hook.mjs |
| --- | --- | --- |
| `PreToolUse` (CLI 2.x `preToolUse`) | `pre` | `pre`; Kiro sends no call id, so one is derived from `session_id` + `tool_name`. A shell `cwd` other than the project root is denied |
| `PostToolUse` | `post` | `post`. Kiro IDE often sends an empty `tool_input`; then the pending call (same derived id) supplies the spec tool and input. `tool_response` has no success flag: a shell call needs a final `Exit Code: 0`; other tools count unless the text starts like an error (`Error`, `Failed`, `Cannot`, ...) |
| `Stop` | `turn-end` | `post` with `ok: false` for a call still pending |

| Windsurf / Devin Desktop event | Adapter | hook.mjs |
| --- | --- | --- |
| `pre_read_code`, `pre_write_code`, `pre_run_command`, `pre_mcp_tool_use` | `pre` | `pre` with a synthetic tool name (`read_code`, `write_code`, `run_command`, `mcp__<server>__<tool>`) and `tool_info` as input (`command_line` as `command`; MCP: `mcp_tool_arguments`). Call id derived from `trajectory_id` + tool name. A `run_command` `cwd` other than the project root is denied |
| `post_read_code`, `post_write_code`, `post_mcp_tool_use` | `post` | `post` with `ok: true` (Cascade runs them after a successful read or MCP call and after the write) |
| `post_run_command` | `post` | `post`; **always `ok: false`**: Cascade reports the command line and cwd, not the exit status. The adapter tells the agent (exit 2, stderr) |
| `pre_user_prompt` | `turn-end` | `post` with `ok: false` for a call still pending; always exits 0 |

- **Cline** allow: `{"cancel":false}`. Deny: `{"cancel":true,"errorMessage"}`;
  Cline then **cancels the whole task**, not only the call (the reason is in
  the task's hook status). Post problems come back as `{"cancel":false,
  "contextModification"}`, which Cline adds to the conversation. A post never
  cancels.
- **Kiro** allow: exit 0. Deny: exit 2, reason on stderr only (Kiro passes
  stderr to the model and ignores stdout). Post problems exit 1 with the reason
  on stderr, which Kiro shows the user as a warning. `Stop` always exits 0 with
  no output (exit 1 or a `block` decision there asks Kiro to keep going).
- **Windsurf** allow: exit 0. Deny: exit 2, reason on stderr (the agent sees
  it). Post problems also exit 2 so the agent sees them; post hooks cannot block.

**Windsurf terminal commands never count as a success**, for the same reason as
Codex Bash: `post_run_command` has no exit status, so a failing `npm test`
looks like a passing one. Run gated steps through MCP tools (`mcp__ci__run_tests`
in the `harness windsurf` block of `examples/ClaudeCodePolicy.speckdl`). The
MCP test tool must fail the call (an MCP error) when tests fail: Cascade runs
`post_mcp_tool_use` only for a successful call and its result text is not read.

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
- **Pi, OpenCode and OpenClaw** plugins call the adapter with `spawnSync`
  (25 s timeout) and allow only on exit 0 plus a `{"decision":"allow"}` line.
  A crash, any other exit, a signal, a timeout, a missing `node` (`ENOENT`),
  empty or unparsable output, an allow-less answer and a payload that can't be
  serialised all block. The hosts add their own safety net: a Pi `tool_call`
  handler that throws blocks the call; an OpenCode `tool.execute.before` that
  throws stops it; an OpenClaw `before_tool_call` handler that throws or
  passes its `timeoutMs` (set to 30 s) blocks. What the plugin cannot cover is
  the plugin not loading at all; see Limits.
- **Cline** treats a hook timeout, a crash, any exit code and unparsable
  output as "continue" (CLI: `sdk/packages/core/src/hooks/subprocess-runner.ts`;
  VS Code: `HookProcess.ts`, a non-zero exit without JSON is logged and
  allowed). Only a `{"cancel":true}` line blocks. The generated `PreToolUse`
  script therefore prints `{"cancel":false}` only when the adapter exits 0
  with exactly that line, passes the adapter's own cancel through, and prints
  a cancel for anything else: a crash, a non-zero exit, a kill, a missing
  `node` (exit 127), empty or extra output. It runs the adapter under
  `timeout 25` when `timeout` exists, inside Cline's 30 s (VS Code) and 120 s
  (CLI) hook timeouts.
- **Kiro**: only exit 2 blocks a `PreToolUse` call; other exits warn and
  proceed, and a timeout is not documented as blocking. The generated pre
  command is `[ "$(node adapter.mjs kiro pre ...)" = '{"decision":"allow"}' ] || exit 2`:
  the adapter prints `{"decision":"allow"}` on allow (stdout is captured, so
  Kiro sees none), and anything else, including an adapter that exits 0 with
  no output, exits 2. `timeout` is 30 s, above the adapter's 20 s hook budget.
- **Windsurf** uses the same `[ "$(...)" = ... ] || exit 2` form under
  `bash -c` (only exit 2 blocks; other exits proceed). On Windows Cascade runs
  the `powershell` command instead, and would run `command` through PowerShell
  if `powershell` were missing, where the sh syntax would fail open; the
  generated pre hooks' `powershell` command therefore always blocks with a
  message.
- `example-cline-kiro-windsurf-policy.test.ts` runs the installed Cline scripts
  with `/bin/sh` and the Kiro / Windsurf commands with `sh -c` / `bash -c`,
  replacing hook.mjs (crash, `exit 1`, garbage, `SIGKILL`, hang) and
  adapter.mjs (crash, `exit 1`, empty `exit 0`, allow then `exit 1`, garbage,
  `SIGKILL`, and for Cline a hang past `timeout 25`), corrupting the config,
  removing `node` from `PATH` and sending malformed payloads: every case blocks
  (Cline: cancels), and no turn-end hook ever blocks.
- `example-pi-opencode-openclaw-policy.test.ts` imports each installed plugin
  with a stand-in host API and runs crash / `exit 1` / empty / allow-less /
  garbage / `SIGKILL` / missing `node` / unserialisable payload (and a hang for
  Pi) through it; every case blocks.
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
- Pi loads project extensions (`.pi/extensions/`) only for a **trusted**
  project. Untrusted, `pi -p` skips the extension silently and nothing is
  checked. Run `/trust` once, pass `--approve`, or install at user level:
  `install pi ... --plugins-dir ~/.pi/agent/extensions` writes
  `speckl-<hash>.js` there, which loads regardless of trust, judges sessions
  inside the project and lets others through (still denying calls that name
  the rails). A plugin file that fails to load stops Pi from starting
  (fail-closed). Pi runs tool calls in parallel by default; the second one
  is refused as pending and retried.
- OpenCode and OpenClaw: **a plugin that fails to load is skipped and tool
  calls run unchecked** (OpenCode silently; OpenClaw logs `[plugins] speckl
  failed during load`). The plugin files are protected from the agent, but
  check the startup log after editing anything by hand, and rerun `install`
  rather than editing the generated file.
- Plugins run in order. A plugin loaded after Speckl's can still change a
  call's arguments after it was checked (Pi `event.input`, OpenCode
  `output.args`, OpenClaw `params`). Don't combine Speckl with plugins that
  rewrite tool arguments.
- OpenCode: checked against the released 1.19.3 (`opencode-ai` on npm,
  plugin API V1). The `dev` branch (`@opencode/cli` 2.x) has a new plugin
  API without `tool.execute.*`; this plugin does not work there yet.
  `install opencode --plugins-dir ~/.config/opencode/plugins` installs it for
  every session.
- OpenClaw: `agent_end` needs conversation access, so `session_end` clears
  a stuck call; set the agent workspace to the project, or the `workdir` and
  path checks resolve against another directory. OpenClaw ships its own
  `node` on `PATH`, so the missing-`node` case is only covered in the
  in-process test.

- Cline: **a Speckl deny cancels the whole task**, not only the call; the
  agent cannot retry it in the same task. Cline's own plugin hooks
  (`beforeTool` in SDK plugins) fail open by default and are not used. The
  hook scripts are `sh`; on Windows Cline looks for `<Event>.ps1`, which
  `install` does not write, so **Windows has no rails**. If the system has
  no `timeout` command (stock macOS), an adapter that hangs is killed by
  Cline's own timeout, which lets the call through (hook.mjs itself is still
  bounded at 20 s). Hooks in `~/Documents/Cline/Hooks` or `~/.cline/hooks`
  also run; Speckl only protects the project's `.clinerules/hooks` and
  `.cline`. Cline CLI runs tool calls one at a time in the observed runs; a
  parallel call would be refused as pending, which cancels the task.
- Kiro: derived from documentation and published captures, **not run**. A
  `PostToolUse` that is not ours (another session, an empty input that does
  not match the pending call) is reported as a warning and records nothing;
  the call stays pending until `Stop`. Success of non-shell tools is inferred
  from the result text. Kiro runs every `PreToolUse` hook even after one
  blocks, and other hooks run alongside Speckl's. Global hooks in
  `~/.kiro/hooks/` are not protected. The commands use `sh` syntax; Kiro on
  Windows is not covered. `read_file` maps need a `path` field; a call
  without one is denied.
- Windsurf / Devin Desktop: derived from the documentation, **not run**.
  Hooks do not run in Restricted Mode (untrusted workspaces): no rails there.
  `pre_read_code` may name a directory that Cascade then reads recursively;
  only the directory path itself is checked against the protected paths.
  Terminal commands never advance the policy (above). User, system and cloud
  hooks (`~/.codeium/windsurf/hooks.json`, `/etc/devin/hooks.json`) also run
  and are not protected. Windows blocks every tool call (above).
- `doctor` proves the installed command is wired and that the adapter denies
  the probe. It does not prove that `hook.mjs` ran, that the state HMAC or
  the replay checks held, or that a plugin host loaded the plugin. Pi,
  OpenCode and OpenClaw skip a plugin that fails to load, and doctor only
  runs the adapter command stored in the plugin file. Kiro and Windsurf
  doctor runs the shell command `install` wrote; it was not run inside those
  IDEs. Shell-wrapper harnesses need `sh` on `PATH` (the same requirement as
  the hooks themselves). Exit 0 is treated as a block only for Cline
  (`cancel: true`), Pi, OpenCode and OpenClaw (`decision: "block"`) and
  Cursor (`permission: "deny"`), and only together with the adapter's
  unmapped-tool text. Claude Code, Codex, Gemini, Copilot, Goose, Hermes,
  Kiro and Windsurf are fail-open on every exit 0.
- The install record is authenticated only when `install` could read a 64-hex
  state key and wrote `mac` (HMAC-SHA256 over the compact `{v, harness, files}`
  JSON, not over the pretty-printed file). Without that key the record is
  not authenticated: `uninstall` still refuses a path it does not own, and it
  still refuses a symlink, but a process that can write the record can name
  any owned path whose bytes match a saved copy it also planted.
  `.speckl/harness-install/` is protected from tool calls. `uninstall` will
  not delete a Hermes profile or a `--plugins-dir` outside the project, even
  though `install` wrote them; those entries stay in the record. An install
  made before this record existed has nothing for `uninstall` to restore; it
  refuses rather than deleting files it cannot prove it created. `uninstall`
  does not restore file modes, and it does not remove directories.

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
- Pi extensions: `badlogic/pi-mono` commit 73f8de8 (npm
  `@earendil-works/pi-coding-agent` 1.3.0)
  `packages/coding-agent/docs/extensions.md` (`tool_call` `{block, reason}`,
  "a `tool_call` handler failure blocks the tool as a fail-safe",
  `tool_result`, `agent_end`, project trust, `~/.pi/agent/extensions`),
  `packages/coding-agent/src/core/extensions/types.ts` (event shapes),
  `packages/coding-agent/src/core/tools/bash.ts` (`structuredContent.exit_code`).
  Checked 2026-10-19.
- OpenCode plugins: <https://opencode.ai/docs/plugins/> and `sst/opencode`
  tag v1.19.3 (commit e3c4eb2): `packages/plugin/src/index.ts` (`Hooks`:
  `tool.execute.before` / `after`, `event`),
  `packages/opencode/src/session/prompt.ts` (call sites, error parts),
  `packages/opencode/src/tool/shell.ts` (`metadata.exit`, `null` on timeout,
  `workdir`), `packages/opencode/src/plugin/index.ts` (a plugin that fails to
  load is logged and skipped). Checked 2026-10-19 against `opencode-ai` 1.19.3.
- OpenClaw plugin hooks: <https://docs.openclaw.ai/plugins/hooks/tool-policy>,
  <https://docs.openclaw.ai/plugins/manifest> and `openclaw/openclaw` commit
  55a44329 (npm `openclaw` 2026.10.5): `docs/plugins/hooks/tool-policy.md`,
  `src/plugins/hooks.ts` (`before_tool_call` block, per-hook `timeoutMs`,
  `session_end`), `src/agents/agent-tools.before-tool-call.policy.ts` (a hook
  that throws or times out blocks: "Tool call blocked because
  before_tool_call hook failed"), `src/agents/agent-tool-definition-adapter.ts`
  (`after_tool_call`, also for blocked calls; `details.status: "blocked"` in
  `agent-tool-definition-adapter.after-tool-call.fires-once.test.ts`).
  Checked 2026-10-19.

- Cline hooks: `cline/cline` commit 8248643 (2026-10-19). CLI / SDK:
  `sdk/packages/core/src/hooks/hook-file-hooks.ts` (payload with `tool_call`
  / `tool_result` and the legacy `preToolUse` / `postToolUse` fields, cancel
  handling), `hook-file-config.ts` (file names per event),
  `subprocess-runner.ts` (timeout and errors continue),
  `sdk/packages/shared/src/storage/paths.ts` (`resolveHooksConfigSearchPaths`:
  `~/Documents/Cline/Hooks`, `~/.cline/hooks`, `<ws>/.clinerules/hooks`,
  `<ws>/.cline/hooks`), `sdk/packages/core/src/extensions/tools/schemas.ts`
  (`run_commands`, `editor`, `read_files`, `apply_patch` inputs). VS Code:
  `apps/vscode/src/sdk/hooks-adapter.ts` (string `parameters`,
  `String(output)`, `success: !isError`), `src/core/hooks/hook-factory.ts`
  (30 s timeout, common fields), `src/core/hooks/utils.ts` and `HookProcess.ts`
  (`.clinerules/hooks` + `~/Documents/Cline/Hooks`, `.ps1` on Windows, the
  file is run directly). Docs: <https://docs.cline.bot/customization/plugins>,
  <https://docs.cline.bot/sdk/plugins>. Checked 2026-10-19; live against npm
  `cline` 3.0.73.
- Kiro hooks: <https://kiro.dev/docs/hooks.md> (`.kiro/hooks/*.json` `version:
  "v1"`, fields, `timeout` in seconds), <https://kiro.dev/docs/hooks/types.md>
  (`PreToolUse` exit 0 / 2 / other, `Stop` exit 1 and `decision` continue the
  turn, tool IDs, MCP event example), <https://kiro.dev/docs/hooks/actions.md>,
  <https://kiro.dev/docs/ide/whats-new-v1/hooks.md> and
  <https://kiro.dev/docs/cli/v3/hooks-migration.md> (camelCase CLI 2.x triggers).
  Payload details from the empirical captures in awslabs/aidlc-workflows,
  <https://awslabs.github.io/aidlc-workflows/reference/kiro-ide-hook-payload/>
  (IDE 1.0.165 to 1.2.37: refusal only via stderr + exit 2, stdout ignored,
  empty PostToolUse `tool_input`, prose `tool_response`, shell and `fs_write`
  inputs). Checked 2026-10-19.
- Windsurf / Devin Desktop Cascade hooks:
  <https://docs.windsurf.com/windsurf/cascade/hooks> (mirror on docs.devin.ai):
  `.devin/hooks.json` with legacy `.windsurf/hooks.json`, user and system
  locations, `command` via `bash -c`, `powershell` on Windows, `show_output`,
  common fields, every event's `tool_info`, exit 2 blocks pre hooks only,
  Restricted Mode. Checked 2026-10-19.

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

Pi 1.3.0, OpenCode 1.19.3 and OpenClaw 2026.10.5 (npm releases) each ran
headless (`pi -p --approve`, `opencode run`, `openclaw agent exec`) against the
same mock model server with the plugin `install` wrote. In all three: the
failing test did not advance the policy, the early commit was denied (`can()
refused`), the green test and commit advanced it, the push was denied
(`HNTL`), reading `.speckl/state.json`, editing the plugin's own directory,
`;` chains and unmapped tools were denied, and an adapter that crashed, hung
or answered without an allow blocked the call. OpenCode and OpenClaw also
denied `npm test` with a foreign `workdir`; OpenCode loaded the plugin in a
session started in `src/`; a tool that threw was recorded as failed. Pi
without `--approve` skipped the project extension (see Limits); the
`--plugins-dir` install covered it. A plugin replaced with a syntax error
stopped Pi at startup but let OpenCode and OpenClaw run the call unchecked
(see Limits).

Cline CLI 3.0.73 (npm `cline`) ran headless (`cline --json "..."`,
provider `openai-compatible` pointed at the same mock server) with the scripts
`install cline` wrote in `.clinerules/hooks/`. The run captured the payload
shape used for the `cli-*` fixtures; then the walk: the edit and the failing
`npm test` ran (the test was recorded as failed, its result entry `success:
false` under a top-level `success: true`), the early commit was cancelled,
and in a second task the edit, green test, `git add` and commit advanced the
policy to review. Reading `.speckl/state.json`, editing
`.clinerules/hooks/PreToolUse`, `npm test; true`, a two-command
`run_commands` and an unmapped `fetch_web_content` were each cancelled before
running, and every cancel ended the task (`finishReason: "aborted"`). With
`node` missing from `PATH`, or hook.mjs crashing, exiting 1, printing a bad
allow, killed, or hanging (20 s), a corrupt `agent-config.json`, or
adapter.mjs printing garbage or hanging (25 s, `timeout`), the first call was
cancelled and never ran. Kiro, Windsurf and the Cline VS Code extension were
not run.
