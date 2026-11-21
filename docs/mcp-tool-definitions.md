# Pinning MCP tool definitions

A harness map allows a tool by name. The hook sees that name and the
arguments. It does not see the description or the input schema the server
returned from `tools/list`. A server can change an approved tool's
description after you approve the name. This page is the check for that.

Speckl writes a canonical snapshot of `tools/list`, you sign that file with
`cosign sign-blob --bundle`, and a session-start check compares the live
list to the snapshot and verifies the bundle. A failure denies every mapped
call to that server.

The generated rails (`hook.mjs`, `signal.mjs`, `mcp-tools.mjs`) stay on Node
built-ins. The Sigstore plug-in is the only piece that verifies the bundle,
and it keeps its own dependencies. Speckl does not sign. Cosign does.

## Snapshot

Compile the agent target, then snapshot the server you will actually run.
The command after `--` is the stdio server. The file is canonical JSON:
object keys sorted at every depth, tools sorted by name, no trailing
newline. `weather.tools.json.sha256` is the hex digest of those bytes.

```bash
node mcp-tools.mjs snapshot --server weather --out weather.tools.json -- \
  node weather-server.mjs
```

The client speaks newline-delimited JSON-RPC (MCP stdio as of the
2025-03-26 spec): `initialize`, `notifications/initialized`, then
`tools/list`, following `nextCursor`.

## Sign

Sign the snapshot the same way the Sigstore plug-in signs a signal drop.
Cosign v3 writes the bundle this plug-in reads. Cosign v2 needs
`--new-bundle-format`.

```bash
cosign sign-blob weather.tools.json --bundle weather.tools.json.sigstore.json
```

Copy the certificate identity cosign used. The policy below must be that
exact SAN, not a string that merely contains it.

## Pin

`plugins.json` names the verifier and the identity for this snapshot.
`artifacts.weather` is the policy. It is not taken from the command line.
A signal policy can sit next to it; signal checks are unchanged.

```json
{
  "sigstore": {
    "module": "/opt/speckl/verifier-sigstore/index.mjs",
    "config": {
      "tuf": { "cachePath": "/var/lib/speckl/sigstore-tuf" },
      "signals": {
        "review": { "issuer": "https://github.com/login/oauth", "identity": "carol@example.com" }
      },
      "artifacts": {
        "weather": { "issuer": "https://github.com/login/oauth", "identity": "carol@example.com" }
      }
    }
  }
}
```

Offline or private Sigstore uses `trustedRoot` and `trustedRootSha256`
instead of `tuf`, the same as for signal drops.

`mcp-tools.json` names how to reach the server and which files are the
signed list. Paths may be relative; `init` stores their realpaths and the
sha256 of both files. `policy` is the key under `artifacts`. `cwd` is the
working directory of the server command.

```json
{
  "weather": {
    "transport": "stdio",
    "command": "node",
    "args": ["weather-server.mjs"],
    "cwd": "/opt/mcp/weather",
    "snapshot": "weather.tools.json",
    "bundle": "weather.tools.json.sigstore.json",
    "verifier": "sigstore",
    "policy": "weather"
  }
}
```

```bash
node signal.mjs init --state ./state.json --key /etc/speckl/state.key \
  --plugins plugins.json --mcp-tools mcp-tools.json
```

The pin is covered by the state HMAC and by the log's genesis hash. A hand
edit fails the MAC. Re-signing the edited state still breaks the chain.
Create a new state to change the pin.

The child is started with the pinned `env` plus `PATH` from the process
that runs the check. The rest of the environment is not forwarded, so a
token in the harness environment is not sent unless you pin it.

## Check

At session start the harness runs `adapter.mjs <harness> session`, which
runs `hook.mjs session`. Claude Code's generated `SessionStart` hook and
Cursor's `sessionStart` hook do this. The check fetches `tools/list`,
compares the canonical digest to the pinned snapshot, and calls the pinned
plug-in's `verifyArtifact`. The verdict is stored for that session id.

```bash
echo '{"session_id":"demo-1"}' | node hook.mjs session --state ./state.json --key /etc/speckl/state.key
```

A later mapped call does not fetch the list again. It is denied unless this
session has a passing verdict whose digest is still the pinned snapshot:

```bash
echo '{"tool":"get_weather","input":{"city":"Lisbon"},"call_id":"c1","mcp_server":"weather","session_id":"demo-1"}' \
  | node hook.mjs pre --state ./state.json --key /etc/speckl/state.key
```

The same check without writing a verdict:

```bash
node mcp-tools.mjs verify --state ./state.json --key /etc/speckl/state.key
```

Exit 0 is a pass. Exit 2 is a deny. Any of these deny every mapped call to
that server: the live digest differs (description changed, tool added,
tool removed, schema changed), the snapshot or the bundle is missing or was
modified after `init`, the signature does not verify, the signer is not the
pinned identity, the plug-in throws, or the plug-in or the server times out.
A call with no session id is denied too. A server that is not pinned is
unchanged: unmapped tools are still denied by name, and mapped tools are
still judged by the spec.

`examples/mcp-tools/` is a small stdio server and a spec you can run through
these commands. Edit `description.txt`, start a new session, and the call
is denied.

## Limits

- **It is a session-start check, not a gateway.** The list is fetched once
  when the session check runs. A server that changes its list after that
  verdict is not seen until the next session. This is not the per-call
  refetch a gateway does.
- **Tool lists that vary by authorization are not covered.** The check uses
  the pinned command and env, not the end user's token. A list that is
  different for a different caller can pass this check and still not be the
  list that caller receives.
- **A publisher signing its own poison is not covered.** The signature
  proves that the pinned identity signed these bytes. It does not prove the
  tools are safe. If that identity signs a bad description, the check passes.
- **Code can change while the tool list stays the same.** A backdoored
  server that returns the same `tools/list` still matches the digest.
- **The harness must be talking to the pinned command.** Speckl fetches the
  server named in the pin. It does not inspect the harness's MCP config. A
  harness pointed at a different process is outside this check.
- **Stdio, newline-delimited JSON-RPC only.** A server that speaks only the
  older `Content-Length` framing, or HTTP, fails the check.
- **Speckl verifies. Cosign signs.** Signing still uses cosign, and the
  Sigstore plug-in still has its own dependencies. The generated rails do
  not. The plug-in entry file is pinned by sha256; its `node_modules` are
  trusted by install location and permissions, as with signal drops.
- **Not a sandbox.** If the agent can read the state key, write the plug-in,
  or skip the hook, none of this holds.
