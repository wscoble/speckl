# Agent signals (HITL / HNTL)

SpeckDL `agent { }` blocks never name a human action. A wait-state **awaits a
signal**; anything verifiable can produce one through a pluggable verifier.

## Shipped verifiers

| Kind | Assurance | How |
| --- | --- | --- |
| `file-drop` | Medium | ed25519-signed JSON file bound to a run, an expiry and a nonce. The signing key must be one pinned at `init`. Evidence = file sha256. |
| `cli` | **DEV ONLY** | `--outcome` / `--as` / claims on the CLI. Evidence = local user + timestamp. Refused unless the state was created with `signal.mjs init --dev`. |

Unsigned file drops (`--allow-unsigned true`) are also DEV ONLY and need an
`init --dev` state.

## Plug-in verifiers (interface only)

Implement:

```ts
interface SignalVerifier {
  // opts: verifier CLI options. expect: { signal, outcomes, claims }.
  // ctx: { runId, dev, now, usedNonces, signers? } from the state file.
  // signers is absent on a legacy state and the pinned file-drop set otherwise.
  // file-drop enforces it. A plug-in must enforce its own trust anchor;
  // signal.mjs does not re-check the signature against signers.
  verify(opts: Record<string, unknown>, expect: AwaitSpec, ctx: VerifierContext):
    Promise<{ ok: true; signal: VerifiedSignal } | { ok: false; reason: string }>;
}
// VerifiedSignal: { signal, outcome, claims, verifier, subject, at, evidence,
//                   run?, expires?, nonce?, callId?, signer? }
// If a verifier returns run/nonce, signal.mjs re-checks them against the state.
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

## Pinned sign-off signers

`init` records who may sign a `file-drop` approval. Repeat the flag for each
approver. The value is a file (raw 32 bytes, 64 hex chars, or base64 of those
32 bytes — the same shapes `--pubkey` accepts) or the key material inline:

```
node signal.mjs init --state ./state.json --key /etc/speckl/state.key \
  --signer carol=./keys/carol.pub \
  --signer dave=./keys/dave.pub
```

The command prints each name with the sha256 of the raw public key. Names
match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`. Two signers may not share a name or
a key. At most 32 are stored. The set is sorted by name.

What is stored:

- `initialSigners` — the set from `init`. It is part of the **genesis** hash,
  so editing it breaks the log chain even if the state is re-signed.
- `signers` — the set in force now. With no rotation it equals
  `initialSigners`. The HMAC covers it, and load replays the log to re-derive
  it, the same way it re-derives the machine.

`apply` and `clear-pending` with `--verifier file-drop` then accept a
signature only from `signers`:

- Omit `--pubkey` and the signature may verify under any pinned key.
- `--pubkey <file>` must be exactly one of those keys. Any other file is
  refused (`pubkey is not a pinned sign-off signer`), whether or not its
  signature is valid.
- `--signer <name>` checks that one pin. A name that was not pinned is refused.
- Passing both requires that they are the same pin.
- An empty set refuses every signature (`no sign-off signers pinned for this
  run`), including on a `--dev` state. `--dev` still allows the `cli`
  verifier and `--allow-unsigned`; it does not let a per-call key stand in
  for a pin.

Any one pinned key is enough. That is several approvers, not an M-of-N
threshold and not a per-await role: one compromised signer can approve and
can rotate the others out.

### Rotating the set

`rotate-signers` appends a `signers` log entry. The drop is an ordinary
file-drop body signed by a key that is pinned **now** (not by a key that
only appears in the new set):

```json
{
  "signal": "rotate-signers",
  "outcome": "rotate",
  "signers": [{ "name": "carol", "key": "<64 hex chars>" }],
  "run": "<run id>",
  "expires": "2026-10-16T17:00:00Z",
  "nonce": "4f1c9a7e-…"
}
```

`key` is inline bytes (hex or base64), not a path: the path would not be
covered by the signature.

```
node signal.mjs rotate-signers --state ./state.json --verifier file-drop \
  --file ./inbox/rotate.json
```

The command refuses a legacy state, an empty set (nothing can authorize the
change), the `cli` verifier, and `--allow-unsigned`. The new set must name
at least one signer. After it lands, only the new keys verify, and the hook
still accepts the state: replay applies the entry and checks `state.signers`
against it. `initialSigners` does not change.

If every pinned private key is lost, rotation is impossible. `init` a new
run. Re-signing the state file with the HMAC key is not a supported way to
swap signers; a hand edit of `signers` fails the replay check, and a hand
edit of `initialSigners` fails the chain. Someone who already holds the state
HMAC key and rebuilds a consistent log can still append a forged `signers`
entry, the same way they can forge any other entry. The pin stops whoever
runs `apply` from choosing a key. It does not add a second seal on top of
the state key.

### States created before pinning

A state file with no `initialSigners` / `signers` fields keeps the previous
genesis (the field is omitted from the hash) and still trusts the `--pubkey`
passed to that call. `signal.mjs` warns when it does. Re-init to pin keys.
There is no in-place upgrade: a rotation has no current signer to authorize
it, and letting the state-key holder insert a pin would hand the same choice
back to whoever runs the command.

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
   hash, dev flag, key id and, when the run recorded one, the initial
   sign-off signer set. On load the log is replayed from a fresh machine, and
   the stored machine, pending call, used nonces, applied evidence and
   current signer set must equal the replayed ones. Editing any of them, or
   truncating, reordering or splicing the log, is detected. A `signers` entry
   (from `rotate-signers`) replaces the current set and does not move the
   machine.
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
re-create them with `signal.mjs init`. Files that already have a log but no
signer fields stay verifiable; see "States created before pinning" above.

## Stuck tool calls

A `pre` without a `post` (the tool crashed) blocks every later call. It
clears itself as failed after `pending timeout` (default `10m`; the state is
not advanced), or sooner with a verified signal naming the pending call:

```
node signal.mjs clear-pending --state ./state.json --verifier file-drop \
  --file ./inbox/clear.json
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

## What a denial says

`hook.mjs` decides allow or deny first. The reason is only the explanation.
Each harness keeps its own output shape (see
[harness-adapters.md](harness-adapters.md)); the sentence below is what that
shape carries. Exit codes stay 0 allow, 2 deny, 1 error (also a deny).

The sentence names one of four situations, then the next step. It does not
include the state key, the key file path, or the contents of `state.json`.
The run id is included when a signed drop needs it. A throw while building
the sentence still denies, with a fixed fail-closed line and none of the
exception text.

**Not allowed in this stage.** The spec's guard refused the action where the
machine is now. Do not retry it in this stage, and do not edit the state file
to skip ahead.

```
Speckl denied (not allowed in this stage): can() refused: Guard failed: stage == Approved (stage is Idle). Next: do not retry this call in stage Idle. The spec does not allow it here. Use a tool this stage permits, or wait until an allowed step or a human sign-off moves the stage. Do not edit the state file to skip ahead.
```

**Waiting on a sign-off.** The machine is in an `await` state. `mode in`
(HITL) refuses every tool. `mode near` (HNTL) refuses act tools and still
allows an observe tool the spec permits. The sentence names the signal, its
outcomes and claims, and the command a human runs. The agent must not run
that command. Placeholders `<drop.json>` and `<pubkey>` are the human's
files; the hook does not know them, and it does not print `--key`.

```
Speckl denied (waiting on a sign-off): HNTL: act tool refused while awaiting signal review. Next: Act tools stay refused until this sign-off is recorded; an observe tool may still run when the spec allows it. Sign-off "review" (outcomes: approve, reject; claims: reviewer: String). A human runs: node '/path/to/agent/signal.mjs' apply --state '/path/to/state.json' --verifier file-drop --file <drop.json> --pubkey <pubkey> . The signed drop is {"signal":"review","outcome":"<approve or reject>","claims":{"reviewer":"<String>"},"run":"<run id from init>","expires":"<ISO-8601>","nonce":"<unique>"}. The agent must not run that command or read the state key.
```

The same command with `mode in` starts from `HITL: no tools while awaiting signal review` and says that no tool call runs until the sign-off is recorded.

**Precondition failed.** A `precondition:` (or a `require` that is not the
stage) did not hold, a required argument is missing, or another call is
still in flight. Fix the input, or have a human clear the stuck call:

```
node '/path/to/agent/signal.mjs' clear-pending --state '/path/to/state.json' --verifier file-drop --file <drop.json> --pubkey <pubkey>
```

```json
{"signal":"clear-pending","call_id":"<pending id>","run":"<run id>","expires":"<ISO-8601>","nonce":"<unique>"}
```

**Internal error (fail closed).** The payload was not usable, the tool is not
in the spec, the spec hash does not match, or the state seal failed. Do not
retry the same call. A human re-inits or restores the state with
`signal.mjs init`. The key path from a missing-key error is replaced with
`<keyfile>`.
