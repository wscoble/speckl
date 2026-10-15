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

## Timeout

`timeout <dur> -> reject` may only resolve to a reject-class outcome. Fire with:

```
node signal.mjs timeout --state ./state.json
```

## Wiring a runtime

See `out/agent/README.md` after `speckl-compile examples/AgentPolicy.speckdl -t agent`.
Adapters for Claude Code / Cursor / etc. are thin JSON translators outside Speckl.
