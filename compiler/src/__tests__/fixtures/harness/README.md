# Harness payload fixtures

One JSON file per hook call, in the shape each harness hands its hook.
`__PROJECT__` stands for the project directory and is replaced in the tests.

| Directory | Provenance |
| --- | --- |
| `claude-code`, `cursor`, `codex`, `gemini`, `copilot` | Built from the official hooks references and harness source (see `docs/harness-adapters.md`, Sources); not captured live. |
| `goose` | Captured from goose 1.55.0 (`goose run` with a mock model), then trimmed. |
| `hermes` | Captured from the Hermes v0.22.2 dispatcher (`model_tools.handle_function_call`). |
| `pi` | Captured from `@earendil-works/pi-coding-agent` 1.3.0 (`pi -p --approve`, mock model): the `event` the extension receives, plus `ctx.cwd`. |
| `opencode` | Captured from `opencode-ai` 1.19.3 (`opencode run`, mock model): `{hook, input, output}` as the plugin passes them to the adapter, or `{hook: "event", event}` for bus events. |
| `openclaw` | Captured from `openclaw` 2026.10.5 (`openclaw agent exec`, mock model): `{hook, event, ctx}`; `ctx` is the subset the plugin forwards. |
| `cline` | `cli-*`: the payload shape captured from the Cline CLI 3.0.73 (`cline --json`, mock model), with ids and output shortened. `vscode-*`: built from the VS Code extension source (cline/cline 8248643, `apps/vscode/src/sdk/hooks-adapter.ts`, `src/core/hooks/hook-factory.ts`); not live-tested. |
| `kiro` | Built from kiro.dev/docs/hooks/types.md (event fields, MCP example) and the empirical Kiro IDE captures in awslabs/aidlc-workflows `reference/kiro-ide-hook-payload` (IDE 1.0.165 to 1.2.37: shell input `{command, cwd, run_in_background, timeout}`, `fs_write` `{path, text}`, PostToolUse with an empty `tool_input` and a prose `tool_response`). **Not live-tested.** |
| `windsurf` | Built from the Cascade hooks reference (docs.windsurf.com/windsurf/cascade/hooks, mirrored at docs.devin.ai): the common fields and the documented `tool_info` of each event. **Not live-tested.** |

Captured values that vary per run (ids, timestamps, durations, output text)
were kept as captured or shortened; field names and nesting are unchanged.
