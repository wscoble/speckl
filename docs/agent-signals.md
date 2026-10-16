# Agent signals (HITL / HNTL)

SpeckDL `agent { }` blocks never name a human action. A wait-state **awaits a
signal**; anything verifiable can produce one through a pluggable verifier.

## Shipped verifiers

| Kind | Assurance | How |
| --- | --- | --- |
| `file-drop` | Medium | ed25519-signed JSON file bound to a run, an expiry and a nonce. Evidence = file sha256. |
| `cli` | **DEV ONLY** | `--outcome` / `--as` / claims on the CLI. Evidence = local user + timestamp. Refused unless the state was created with `signal.mjs init --dev`. |

Unsigned file drops (`--allow-unsigned true`) are also DEV ONLY and need an
`init --dev` state.

## Plug-in verifiers (interface only)

Implement:

```ts
interface SignalVerifier {
  // opts: verifier CLI options. expect: { signal, outcomes, claims }.
  // ctx: { runId, dev, now, usedNonces } from the state file.
  verify(opts: Record<string, unknown>, expect: AwaitSpec, ctx: VerifierContext):
    Promise<{ ok: true; signal: VerifiedSignal } | { ok: false; reason: string }>;
}
// VerifiedSignal: { signal, outcome, claims, verifier, subject, at, evidence,
//                   run?, expires?, nonce?, callId? }
// If a verifier returns run/nonce, signal.mjs re-checks them against the state.
```

Documented shapes (not shipped):

- **JWT-bearing API call** — JWKS, `iss`/`aud`/`exp`, claim mapping; evidence = `jti`.
- **OAuth flow** — authorization code → `id_token` claims.
- **Signed API calls** — HMAC-SHA256 shared secret or ed25519 over the body.
- **Webhooks / chat** — wrap any of the above.

## Signed drops are bound to a run

`signal.mjs init` creates a random **run id** per state file and prints it.
A signed drop must carry:

```json
{
  "signal": "review",
  "outcome": "approve",
  "claims": { "reviewer": "carol" },
  "run": "<run id from init>",
  "expires": "2026-10-16T17:00:00Z",
  "nonce": "4f1c9a7e-…"
}
```

The verifier refuses a drop whose `run` is for another state file, whose
`expires` has passed (or is not a valid time), or whose `nonce` was already
used in this state file (8–200 chars). `signal` is never defaulted. Every
applied `evidence` id is also single-use. An approval therefore can't be
replayed or carried over to a new run.

## Who may record a signal

`signal.mjs` is the human channel; the agent must not be able to run it or
read the signing key. The `cli` verifier trusts whoever runs it, so an agent
that can run shell commands could approve itself. That is why it is **DEV
ONLY**: refused unless the state was created with `signal.mjs init --dev`
(and the verifier refuses on its own without that flag). Production states
are created without `--dev` and accept only signed verifiers.

## Stuck tool calls

A `pre` without a `post` (the tool crashed) blocks every later call. It
clears itself as failed after `pending timeout` (default `10m`; the state is
not advanced), or sooner with a verified signal naming the pending call:

```
node signal.mjs clear-pending --state ./state.json --verifier file-drop \
  --file ./inbox/clear.json --pubkey ./keys/reviewer.pub
# {"signal":"clear-pending","call_id":"<pending id>","run":"…","expires":"…","nonce":"…"}
```

`clear-pending` goes through the same checks as `apply` (dev gate, run,
expiry, nonce, replay). Clears are logged in `state.pendingLog`.

## Timeout

`timeout <dur> -> reject` may only resolve to an outcome marked reject with
`!` (`require outcome in { approve, reject! }`), and no `!` outcome may lead to
a stage an unmarked outcome also reaches (both are compile errors; the runtime
re-checks the marker). The clock starts when the machine enters the wait state; if no
start was recorded, `timeout` starts it instead of firing. Fire with:

```
node signal.mjs timeout --state ./state.json
```

## Wiring a runtime

See `out/agent/README.md` after `speckl-compile examples/AgentPolicy.speckdl -t agent`.
Adapters for Claude Code / Cursor / etc. are thin JSON translators outside Speckl.
