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
  // opts: verifier CLI options. expect: { signal, outcomes, claims, bindCall }.
  // ctx: { runId, dev, now, usedNonces } from the state file.
  verify(opts: Record<string, unknown>, expect: AwaitSpec, ctx: VerifierContext):
    Promise<{ ok: true; signal: VerifiedSignal } | { ok: false; reason: string }>;
}
// VerifiedSignal: { signal, outcome, claims, verifier, subject, at, evidence,
//                   run?, expires?, nonce?, callId?, call? }
// If a verifier returns run/nonce, signal.mjs re-checks them against the state.
// call is the sha256 hex of one canonical tool call. Required when the await
// outcome is in expect.bindCall; refused on every other outcome.
```

Documented shapes (not shipped):

- **JWT-bearing API call** — JWKS, `iss`/`aud`/`exp`, claim mapping; evidence = `jti`.
- **OAuth flow** — authorization code → `id_token` claims.
- **Signed API calls** — HMAC-SHA256 shared secret or ed25519 over the body.
- **Webhooks / chat** — wrap any of the above.

## Signed drops are bound to a run

`signal.mjs init --key <file>` creates a random **run id** per state file and prints it.
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

## Call-bound sign-off

A sign-off normally advances the stage. After that, any later call that
`can()` allows may run, with any arguments. An await can opt in to a narrower
sign-off that covers **one exact call, once**.

### How the spec declares it

Inside the `await` block:

```
bind call                    # every accepting (non-!) outcome
bind call on approve         # only these outcomes
bind call on approve, ship
```

The clause names outcomes, not tools. The signed hash names the tool. A
reject outcome (`name!`) cannot be listed: a reject authorizes no call.
Timeouts are never call-bound. Leaving the clause out keeps today's
stage-level sign-off, and those specs do not change.

### Canonical arguments

`call` is the sha256 hex digest of `canonical({ tool, input })`, using the
same canonical form as the state log:

- object keys are sorted at every depth;
- array order is kept;
- `undefined` is omitted; `null` is kept;
- strings are exact (no Unicode normalization);
- nothing is truncated.

`tool` is the **spec** tool name (`open_pr`), not the harness tool name
(`Bash`). `input` is the arguments object the hook sees **after** a harness
adapter has mapped the call. Two harnesses that map to the same spec tool
and the same arguments share a digest; harness-only spelling that the map
drops is not part of the hash. The hook already treats a missing or null
`input` as `{}`, and the digest is of that value.

`node signal.mjs digest` and the hook both call `callDigest` in
`state-integrity.mjs`. Key order in the JSON does not change the digest.

### How the human sees the call

While the machine is still waiting on a call-bound outcome, a refused call's
reason ends with the exact preimage and its digest:

```
sign call <64 hex> canonical {"input":{...},"tool":"open_pr"}
```

The same pair is printed without touching state:

```
echo '{"tool":"open_pr","input":{"branch":"main"}}' | node signal.mjs digest
# {"ok":true,"digest":"<64 hex>","canonical":"{\"input\":{\"branch\":\"main\"},\"tool\":\"open_pr\"}"}
```

`canonical` is the exact string that was hashed. Put `digest` in the signed
JSON as `call`, beside `run`, `expires` and `nonce`, and sign the whole
file. The human is approving that mapped spec call, not a raw harness
command and not a truncated preview.

### A mismatch denies

The hook allows a later call only when its digest equals the signed `call`
**and** `can()` allows it. Anything else is exit 2, the state is not
written, and the approval is kept:

- a different tool, a different argument, or a different array order;
- an arguments value that is not a JSON object;
- a `call` that is missing, not 64 hex characters, or attached to an
  outcome that is not call-bound (including `clear-pending` and a
  stage-level sign-off).

Those last cases are refused at `signal.mjs apply`, before the stage moves.
A verifier that returns a bad `call` is a deny. There is no path that
ignores a bad hash and continues.

The approval is consumed only when that matching call's `post` reports
`ok: true`. A failed post or an expired pending call leaves the binding in
place, so a failed attempt cannot become permission for a different call.
An observe call that was already in flight when the sign-off was applied
(near / HNTL) can finish; it does not consume the binding.

The binding is re-derived from the log (`signal` entries carry `call`; a
successful matching `post` clears it). Editing `boundCall` in `state.json`
without that log entry is denied.

### Stage-level sign-offs stay

No `bind call` means no `call` field. A drop that carries one is refused, so
a hash cannot be attached to a stage-level approval and ignored. After a
stage-level sign-off the hook does not keep a binding. State files written
before this field existed have no `boundCall`; they verify as unbound.

Run id, expiry, nonce and evidence replay are unchanged, and they are
checked when `call` is present too.

### Limits

- The hash gate is in the hook, not in Z3. BMC still covers the stage
  transition. It does not prove which arguments were signed. The gate only
  narrows what the hook allows, so existing proofs stay sound.
- Expiry is enforced when the drop is applied, not again when the bound
  call later runs.
- After the one successful call, later calls follow `can()` only. If that
  action's guard stays true, a later call with different arguments is not
  covered by the spent sign-off. Move the stage in the action when that
  one call should be the last one.
- The human approves the mapped spec call. A harness map that drops or
  renames fields changes what is signed.

## Who may record a signal

`signal.mjs` is the human channel; the agent must not be able to run it or
read the signing key. The `cli` verifier trusts whoever runs it, so an agent
that can run shell commands could approve itself. That is why it is **DEV
ONLY**: refused unless the state was created with `signal.mjs init --dev`
(and the verifier refuses on its own without that flag). Production states
are created without `--dev` and accept only signed verifiers.

## Tamper-evident state

`state.json` is written only by `hook.mjs` and `signal.mjs`, and both refuse a
state they can't verify. Two layers:

1. **Hash-chained log.** Every change (`pre`, `post`, `expire`, `signal`,
   `timeout`, `clear`) is appended to `state.log`. Each entry's hash covers
   the previous one; the first links to a genesis hash over the run id, spec
   hash, dev flag and key id. On load the log is replayed from a fresh
   machine, and the stored machine, pending call, used nonces, applied
   evidence and any call-bound sign-off must equal the replayed ones.
   Editing any of them, or truncating,
   reordering or splicing the log, is detected.
2. **HMAC-SHA256** over the whole canonical state (`state.mac`), with a 32-byte
   key in a file (`--key <file>` or `SPECKL_STATE_KEY_FILE`). This also covers
   fields the log can't derive (timestamps, audit logs) and stops anyone
   without the key from rebuilding a consistent log.

The hook and `signal.mjs` deny (exit 2) on a signature or chain mismatch, a
missing signature, a key that doesn't match the state's key id, or a missing
key for a non-dev state. If a key is configured, the signature is required
even for dev states, so flipping `dev` can't downgrade a signed state.

**Deploying the key.** `signal.mjs init --key <file>` creates the key (mode
0600) if it doesn't exist. Put it where the hook and signal tooling can read
it and the agent can't: for example run the hook as a separate user (or via
a sudo rule / small daemon) that owns `/etc/speckl/state.key`, and set
`SPECKL_STATE_KEY_FILE` only in that user's environment. If the agent can
read the key, it can forge state; if it can write `state.json` without the
key, it is caught.

**Dev mode.** `init --dev` without a key makes an unsigned state. The hook
warns on every call and checks only the log chain (which a determined editor
can rebuild). Never use it where the agent can edit the state.

**Old state files** (no `log`/run id) are refused with a message to
re-create them with `signal.mjs init`.

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
