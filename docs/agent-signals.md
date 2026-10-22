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
   machine, and the stored machine, pending call, used nonces and applied
   evidence must equal the replayed ones. Editing any of them, or truncating,
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

## Decision record

`state.log` records what the spec machine committed: allowed `pre`/`post`
pairs, expirations, signals, timeouts and clears. A denied tool call used to
exit before any of that was written, so a refusal left no trace.

Every hook verdict after the state verifies is now appended to
`<state>.decisions/log.jsonl`, next to a keyed `head.json`:

- The line carries `seq`, `prev`, `ts`, `phase` (`pre` or `post`), `tool`,
  `call_id`, the mapped `action` (or null), `verdict` (`allow` or `deny`),
  the deny `reason` (allows store null; reasons longer than 500 characters
  are clipped), and `input_sha256`. The raw tool input is not stored.
- `hash` is SHA-256 over the canonical line. `prev` links it to the previous
  hash, or to a genesis hash over the run id, spec hash and key id.
- `mac` is HMAC-SHA256 of that hash with the same key as `state.json`
  (`--key` / `SPECKL_STATE_KEY_FILE`). Unsigned `--dev` states (no key) keep
  the chain only, same as `state.json`. `head.json` is HMAC'd the same way,
  so truncating the log or moving the head without the key is detected.

The decision record is **not** replayed into the machine and a denial never
calls the state `append` / `save` path. A flood of denials therefore cannot
advance the spec, rewrite `state.json`, or make the next allow replay every
refusal. The hook holds the existing `state.json.lock` across the decision
append and any state update, so the two files cannot interleave.

If the record is missing its head, the chain or MAC does not check, or the
append fails, the hook **denies** and does not apply an allow. Calls that
fail before the state verifies (usage, stdin, lock timeout, a missing or
bad key, a broken state signature) are still denied, and are not appended:
there is no verified chain to extend. A spec-hash mismatch is reported as
such. It is appended only when the state chain still verifies (genesis
covers the spec hash, so a hand-edited hash usually fails the chain first
and is not appended).

While `log.jsonl` is at most 256 KiB, every hook call rechecks the whole
decision chain. Past that, each call rechecks the keyed head and the tail
(the last 64 KiB), so a flood cannot make every tool call re-read the entire
history. `signal.mjs verify --state <file>` always walks every line, and so
do `apply`, `timeout` and `clear-pending` before they change state. A
same-length edit to an older line in a log that has grown past 256 KiB is
caught by `verify` (and by those commands), not by the next hook call's tail
check. Deleting or editing the tail is caught on the next call either way.

```
node signal.mjs verify --state ./state.json
# {"ok":true,"decisions":4,"uncommitted":0,"head":"<sha256>"}
```

`uncommitted` is greater than zero only when a line was appended and the
process died before replacing `head.json`. The lines still chain; the next
hook call moves the head forward. Anything else (a bad hash, a bad MAC, a
truncated log, a head for a different run) exits 2.

The HMAC is not a signature a third party can check, and it is not an
external timestamp. Anyone who can read the key can rebuild the record.
The decision line is the gate's verdict, not proof the tool ran: `state.log`
is still what committed.

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
