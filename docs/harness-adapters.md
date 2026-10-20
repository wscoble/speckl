# Harness adapters (Claude Code, Cursor)

`hook.mjs` only enforces a policy if the agent harness calls it before and
after every tool call. A `harness` block in the spec's `agent { }` makes
`-t agent` generate that wiring:

```
<out>/agent/
  adapter.mjs                      maps the harness's hook JSON onto hook.mjs
  harness/claude-code/settings.json  reference .claude/settings.json hooks
  harness/cursor/hooks.json          reference .cursor/hooks.json hooks
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
  `.claude/` and `.cursor/`. A call that names one is denied, whatever the tool.

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
- `compiler/src/__tests__/example-claude-code-policy.test.ts` replaces hook.mjs
  with a crash, `exit 1`, garbage output, `SIGKILL` and a hang, and checks that
  each blocks in both harnesses.

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
- Cursor documents MCP tool names as `MCP:<tool_name>` for matchers; check the
  Hooks output channel for the exact `tool_name` your build sends before
  writing `map` lines for MCP tools. Cursor runs `preToolUse` in cloud agents,
  but not `beforeMCPExecution`.

## Sources

- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>
  (PreToolUse input and decision control, exit code 2, `onFailure`,
  PostToolUseFailure, PostToolBatch, `${CLAUDE_PROJECT_DIR}`). Checked 2026-10-19.
- Cursor hooks: <https://cursor.com/docs/agent/hooks> (`hooks.json` version 1,
  `preToolUse` / `postToolUse` / `postToolUseFailure` payloads, `permission`
  output, exit code 2, `failClosed`, project hooks run from the project root).
  Checked 2026-10-19.
