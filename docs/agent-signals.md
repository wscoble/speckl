# Agent signals (HITL / HNTL)

SpeckDL `agent { }` blocks never name a human action. A wait-state **awaits a
signal**; anything verifiable can produce one through a pluggable verifier.

## Shipped verifiers

| Kind | Assurance | How |
| --- | --- | --- |
| `cli` | Low | `--outcome` / `--as` / claims on the CLI. Evidence = local user + timestamp. |
| `file-drop` | Medium | ed25519-signed JSON file. Evidence = file sha256. Unsigned drops are **off** by default (`--allow-unsigned true` is DEV-only). |

## Plug-in verifiers (interface only)

Implement:

```ts
interface SignalVerifier {
  kind: string;
  verify(raw: unknown, expect: AwaitSpec): Promise<VerifiedSignal | Rejection>;
}
```

Documented shapes (not shipped):

- **JWT-bearing API call** — JWKS, `iss`/`aud`/`exp`, claim mapping; evidence = `jti`.
- **OAuth flow** — authorization code → `id_token` claims.
- **Signed API calls** — HMAC-SHA256 shared secret or ed25519 over the body.
- **Webhooks / chat** — wrap any of the above.

## Replay protection

Every `VerifiedSignal.evidence` id may be applied only once per state file.
A signed file-drop body must name its `signal`; it is never defaulted.
Evidence is scoped to one state file: a signed drop is not bound to a
particular run, so keep drops single-use (move them out of the inbox) or add
a nonce/expiry in a plug-in verifier if one run's approval must not carry
over to another.

## Who may record a signal

`signal.mjs apply` is the human channel. The `cli` verifier trusts whoever runs
it, so an agent that can run shell commands could approve itself. Use `cli`
only where the agent cannot execute it, and prefer a signed verifier
(`file-drop` or a plug-in) where it can.

## Timeout

`timeout <dur> -> reject` may only resolve to a reject-class outcome, and that
outcome may not lead to a stage an accepting outcome also reaches (both are
compile errors). The clock starts when the machine enters the wait state; if no
start was recorded, `timeout` starts it instead of firing. Fire with:

```
node signal.mjs timeout --state ./state.json
```

## Wiring a runtime

See `out/agent/README.md` after `speckl-compile examples/AgentPolicy.speckdl -t agent`.
Adapters for Claude Code / Cursor / etc. are thin JSON translators outside Speckl.
