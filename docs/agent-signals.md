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
  // opts: verifier CLI options. expect: { signal, outcomes, claims, bindCall }.
  // ctx: { runId, dev, now, usedNonces, signers? } from the state file.
  // signers is absent on a legacy state and the pinned file-drop set otherwise.
  // file-drop enforces it. A plug-in must enforce its own trust anchor;
  // signal.mjs does not re-check the signature against signers.
  verify(opts: Record<string, unknown>, expect: AwaitSpec, ctx: VerifierContext):
    Promise<{ ok: true; signal: VerifiedSignal } | { ok: false; reason: string }>;
}
// VerifiedSignal: { signal, outcome, claims, verifier, subject, at, evidence,
//                   run?, expires?, nonce?, callId?, call?, signer?, signers? }
// If a verifier returns run/nonce, signal.mjs re-checks them against the state.
// call is the sha256 hex of one canonical tool call. Required when the await
// outcome is in expect.bindCall; refused on every other outcome.
// A call hash is not a trust anchor. file-drop still accepts the signature
// only from ctx.signers.
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
`expires` is not a valid time, or whose `expires` instant is at or before
now (`now >= expires`), or whose `nonce` was already used in this state
file (8–200 chars). `signal` is never defaulted. Every applied `evidence`
id is also single-use. An approval therefore can't be replayed or carried
over to a new run. Those checks run when the drop is applied. They are not
run again when a call authorized by that drop later executes.

## Call-bound sign-off

A sign-off normally advances the stage. After that, any later call that
`can()` allows may run, with any arguments. An await can opt in to a narrower
sign-off that covers **one exact call, once**.

### How the spec declares it

Inside the `await` block. The parser accepts the clause on any line of the
body. The printer writes it after the `require` lines and before `on`:

```
bind call                    # every accepting (non-!) outcome, in declaration order
bind call on approve         # only these outcomes, in the order written
bind call on approve, ship
```

The clause names outcomes, not tools. The signed hash names the tool and its
arguments. A reject outcome (`name!`) cannot be listed: a reject authorizes
no call. A bare `bind call` with no accepting outcome is a parse error.
Timeout outcomes are not in `bindCall`. Leaving the clause out stores
`bindCall: []`. That is a stage-level sign-off, and those specs do not
require a `call` field.

### Canonical arguments

`call` is the lowercase sha256 hex digest of `canonical({ tool, input })`
from `state-integrity.mjs`. `canonical` is the same function as the state log:

- object keys are sorted at every depth;
- an object key whose value is `undefined` is omitted; `null` is kept;
- array order is kept; an `undefined` array element is encoded as `null`;
- strings, numbers, and booleans go through `JSON.stringify` (no Unicode
  normalization, nothing truncated).

`tool` is the **spec** tool name (`open_pr`), not the harness tool name
(`Bash`). `input` is the arguments object the hook sees **after** a harness
adapter has mapped the call. Two harnesses that map to the same spec tool
and the same arguments share a digest. Fields the map drops are not hashed.

On `pre`, the hook sets `input` to `msg.input || {}` before hashing. A
missing, `null`, `false`, `0`, or `""` input is therefore hashed as `{}`.
An array is left as-is and `callDigest` refuses it (`call digest needs an
arguments object`). `callDigest` also refuses an empty tool name and a
non-object input.

`node signal.mjs digest` calls the same `callDigest` and `canonical`. It
does not apply the hook's `|| {}` coercion and it does not read or write
state. Stdin must be a JSON object with a non-empty string `tool` and an
own `input` property. Anything else exits 1 and prints no digest.

### How the human sees the call

While the machine is in an await whose `bindCall` is non-empty, a denied
`pre` keeps its HITL or HNTL reason and appends one suffix:

- plain object arguments: `; call-bound sign-off: sign call <64 lowercase hex> canonical <preimage>`
- anything `callDigest` refuses: `; call-bound sign-off refused: <error>`

`<preimage>` is the exact `canonical({ tool, input })` string, with the
hook's coercion already applied. The same pair, without coercion, is:

```
echo '{"tool":"open_pr","input":{"branch":"main"}}' | node signal.mjs digest
# {"ok":true,"digest":"<64 hex>","canonical":"{\"input\":{\"branch\":\"main\"},\"tool\":\"open_pr\"}"}
```

Put `digest` in the signed JSON as `call`, beside `run`, `expires`, and
`nonce`, and sign the whole file. Uppercase hex is accepted and stored
lowercase. The human is approving that mapped spec call, not a raw harness
command and not a truncated preview.

### A mismatch denies

`file-drop` checks the signature against the current pinned set **before**
`signal.mjs` looks at `call`. An unpinned key is refused (`pubkey is not a
pinned sign-off signer`, or `no sign-off signers pinned for this run` when
the set is empty). The stage does not move and the nonce is not stored.
The `call` value is not a trust anchor.

Then, still inside `apply`, before the stage moves:

- an outcome listed in `bindCall` with no `call` is refused
  (`call-bound sign-off requires call`);
- any other outcome, including a reject, a stage-level sign-off, and
  `clear-pending`, is refused if `call` is present
  (`stage-level sign-off must not carry a call hash`, or
  `clear-pending does not accept a call hash`);
- a `call` that is not 64 hex characters is refused by `file-drop`
  (`payload call must be a 64-char sha256 hex digest`) and, if a verifier
  returns that shape anyway, by `signal.mjs`
  (`call hash must be 64 hex chars`).

A matching hash does not skip `can()`. If `can()` refuses, the stage does
not move and no binding is stored.

After a call-bound apply, `state.boundCall` is `{ hash }` and the `signal`
log entry carries `call`. The hook's `pre` then:

1. denies when `boundCall.hash` is not a string (`call-bound sign-off is malformed`);
2. denies when this call's digest cannot be computed;
3. denies when the digest differs (`call-bound sign-off does not cover this call (denied): want <hash> got <hash> canonical <preimage>`).

Those three write nothing and leave the binding in place. A matching digest
continues to `can()`. If `can()` refuses, that write does not happen either,
and the binding stays.

The binding is cleared only when `post` has `ok: true` and the pending
call's digest equals `boundCall.hash`. A failed `post` does not clear it.
An observe `pre` that was already in flight when the sign-off was applied
(near / HNTL) may `post` successfully; that post does not match, so it does
not clear the binding and it is not denied. `clear-pending` clears the
pending call and does not clear the binding. An expired pending call is
cleared as failed (that clear is written) and the binding stays, so the
failure cannot become permission for a different call.

There is one binding. A later `signal` log entry replaces it: an entry with
a `call` sets the new hash, and an entry without `call` (a stage-level
sign-off, or a timeout that fires) sets `boundCall` to null. Starting a
timeout clock, when no start was recorded, does not clear it.

Replay re-derives `boundCall` from the log. A stored `boundCall` that
differs, including a hand edit that is re-signed with the state key, is
denied (`bound call does not match the log`). A `call` in the log that is
not 64 lowercase hex throws on replay (`signal call hash is not 64 hex
chars`). A state with no `boundCall` field verifies as unbound.

### Stage-level sign-offs stay

No `bind call` means `bindCall` is empty. `apply` then refuses a drop that
carries `call`, so a hash cannot be attached and ignored. The resulting
`boundCall` is null. State files written before this field existed have no
`boundCall`; they verify as unbound.

Run id, expiry, nonce, and evidence replay are the same checks as any other
drop, including when `call` is present. `cli` and `--allow-unsigned` remain
the DEV ONLY exceptions already documented. On a `--dev` state they can
carry `call`. They are not a production path, and `--dev` does not let an
unpinned key stand in for a pin.

### Limits

- The hash gate is in the hook, not in Z3. BMC still covers the stage
  transition. It does not prove which arguments were signed. The gate only
  narrows what the hook allows, so existing proofs stay sound.
- Expiry is checked when the drop is applied (`now >= expires` refuses).
  It is not checked again when the bound call's `pre` or `post` runs. A
  call can run after the drop's `expires` instant.
- The pinned-signer check also happens only at apply. Rotating the set
  afterwards does not revoke a binding already stored. Later drops use the
  new set; the outstanding call still runs if its digest matches.
- After the one successful matching `post`, later calls follow `can()` only.
  If that action's guard stays true, a later call with different arguments
  is not covered by the spent sign-off. Move the stage in the action when
  that one call should be the last one.
- The human approves the mapped spec call. A harness map that drops or
  renames fields changes what is signed. The hook hashes falsy `input` as
  `{}`; `signal.mjs digest` does not.
- A plug-in verifier is not re-checked against `signers`. It must enforce
  its own trust anchor. Returning `call` does not make `signal.mjs` pin a key.

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

- `initialSigners` — the set from `init`. The sha256 of its canonical form
  is part of the **genesis** hash, so editing it breaks the log chain even
  if the state is re-signed. Omitted from the hash when the field is absent.
- `signers` — the set in force now. With no rotation it equals
  `initialSigners`. The HMAC covers it, and load replays the log to re-derive
  it, the same way it re-derives the machine.

`apply` (including a call-bound drop), `clear-pending`, and `rotate-signers`
with `--verifier file-drop` accept a signature only from `signers`. The
`call` field does not add a key and does not skip this check:

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
against it. `initialSigners` does not change. An outstanding `boundCall`
is not cleared: the binding was checked against the set in force at apply,
and the hook does not re-check the signer when that call runs.

The rotation is not a decision-record line. `<state>.decisions/` is left as
it was, including its genesis (run id, spec hash, key id — not the current
signer set, so a rotation does not break that chain). `signal.mjs verify`
replays the `signers` entry on the state chain and then walks every decision
line. `rotate-signers` does that decision walk before it appends. If the
walk fails, the rotation is refused and `state.json` is unchanged.

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
   `timeout`, `clear`, `signers`) is appended to `state.log`. Each entry's
   hash covers the previous one; the first links to a genesis hash over the
   run id, spec hash, dev flag, key id and, when the field exists, the sha256
   of the canonical `initialSigners`. On load the log is replayed from a
   fresh machine, and the stored machine, pending call, used nonces, applied
   evidence, current signer set, and call-bound sign-off must equal the
   replayed ones. Editing any of them, or truncating, reordering or splicing
   the log, is detected. A `signers` entry replaces the current set and does
   not move the machine. A `signal` entry with `call` sets the binding; a
   `signal` without `call`, or a `timeout`, clears it. A successful `post`
   of the matching call clears it. A missing `boundCall` compares as unbound.
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
Files with no `boundCall` field verify as unbound.

## Decision record

`state.log` records what the spec machine committed: allowed `pre`/`post`
pairs, expirations, signals, timeouts, clears, signer rotations and call
bindings. A denied tool call used to exit before any of that was written.

`<state>.decisions/log.jsonl` (with a keyed `head.json`) is a second chain
for hook verdicts. It is an HMAC-SHA256 record under the same state key
(`--key` / `SPECKL_STATE_KEY_FILE`), not a signature a third party can check
and not an external timestamp. Anyone who can read the key can rebuild it.
A line is the gate's verdict, not proof the tool ran. `state.log` is still
what the machine committed. The decision log is not replayed into the
machine, so a denial cannot advance the spec or rewrite `state.json`.

A line is appended only after the state verifies (signature, log chain and
replay, including the current signer set and any call binding) and the
decision chain checks. Each such allow, and each such deny, is one line:

- `seq`, `prev`, `ts`, `phase` (`pre` or `post`), `tool`, `call_id`, the
  mapped `action` (or null), `verdict` (`allow` or `deny`), the deny
  `reason` (allows store null; reasons longer than 500 characters are
  clipped), and `input_sha256`. The raw tool input is not stored.
- `hash` is SHA-256 over the canonical line. `prev` links it to the previous
  hash, or to a genesis hash over the run id, spec hash and key id. That
  genesis does not include the current signer set or the call binding, so a
  rotation or a new binding does not move it.
- `mac` is HMAC-SHA256 of that hash. Unsigned `--dev` states (no key) keep
  the chain only, same as `state.json`. `head.json` is HMAC'd the same way.

A call-bound mismatch is one of those denials: the reason names the wanted
digest and the digest of this call, `state.boundCall` stays put, and
`state.log` does not grow. The later allow of the matching call, and the
`post` with `ok: true` that consumes the binding, are decision lines too.
The binding itself remains a `state.log` entry. A `signers` rotation is
also only a `state.log` entry; it leaves `<state>.decisions/` unchanged.

Calls that fail before the state verifies are denied and are not appended.
That includes usage, a stdin failure, a lock timeout, a missing or bad key,
and a broken state signature. A spec-hash mismatch is appended only when
the state chain and the decision chain both still verify. Genesis covers
the spec hash, so a hand-edited hash usually fails the chain first and is
not appended. If the decision record is missing its head, the chain or MAC
does not check, or the append fails, the hook denies and does not apply an
allow. That denial is not itself a new line: there is no trustworthy chain
to extend.

The hook holds `state.json.lock` across the decision append and any state
update, so the two files cannot interleave.

**256 KiB tail check.** While `log.jsonl` is at most 256 KiB, every hook
call rechecks the whole decision chain. Past that, each call rechecks the
keyed head and the tail (the last 64 KiB), so a flood cannot make every
tool call re-read the entire history. `signal.mjs verify --state <file>`
always walks every decision line and replays every state-log entry,
including `signers` and the call binding. So do `apply`, `timeout`,
`clear-pending` and `rotate-signers` before they change state. A
same-length edit to an older line in a log that has grown past 256 KiB is
caught by `verify` (and by those commands), not by the next hook call's
tail check. Deleting or editing the tail is caught on the next call either
way. Disk still grows by one clipped line per recorded verdict.

**Crash window.** The allow line is appended and fsynced before `state.json`
is replaced. If the process dies in between, the decision log can contain
an allow with no matching `state.log` `pre` or `post`, and the hook does
not exit 0, so the tool does not run. If the state save throws instead, a
following deny line is written when it can be (`state save failed: …`) and
the process still exits non-zero.

```
node signal.mjs verify --state ./state.json
# {"ok":true,"decisions":4,"uncommitted":0,"head":"<sha256>"}
```

`uncommitted` is greater than zero only when a line was appended and the
process died before replacing `head.json`. The lines still chain; the next
hook call moves the head forward. Anything else (a bad hash, a bad MAC, a
truncated log, a head for a different run) exits 2.

## Stuck tool calls

A `pre` without a `post` (the tool crashed) blocks every later call. It
clears itself as failed after `pending timeout` (default `10m`; the state is
not advanced), or sooner with a verified signal naming the pending call:

```
node signal.mjs clear-pending --state ./state.json --verifier file-drop \
  --file ./inbox/clear.json
# {"signal":"clear-pending","call_id":"<pending id>","run":"…","expires":"…","nonce":"…"}
```

`clear-pending` goes through the same checks as `apply` (dev gate, pinned
signer, run, expiry, nonce, replay) and refuses a `call` hash. It clears
the pending call and does not clear a call binding. Clears are logged in
`state.pendingLog`.

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
include the state key, the key file path (given, resolved with `path.resolve`,
or the path `realpath` follows through a symlink, including that key's real
parent directory), the key file's contents, a pinned signer key, or the
contents of `state.json`. A key path shorter than 8 characters — as given,
as `path.resolve` returns it, as `realpath` of the key file, or as that
real path's parent directory — is refused with a fixed sentence before the
hook runs. Commit 09eb03c allowed that call when the path named a real key;
this denial is an intended stricter change. The 32 key bytes are also
removed as base64, base64url, uppercase hex, and, for a pinned signer, as
SPKI DER-base64 and PEM.
The run id is included when a signed drop needs it. A call-bound denial
keeps the `sign call <digest>` suffix and the same pin-aware command.
`<state>.decisions/log.jsonl` stores that redacted sentence, not a second
copy of the raw reason. A throw while building the sentence still denies,
with a fixed fail-closed line and none of the exception text.

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
that command. It does not print `--key` or the pinned public keys.

A state created with `init --signer` names those signers. One pin uses
`--signer <name>` and does not pass `--pubkey` (a pubkey that is not that
pin is refused). Several pins omit both flags, so a signature from any of
them verifies, and the sentence lists the names. An empty pin set has no
working file-drop command; the sentence says to re-init with `--signer`.
`<drop.json>` is the human's file.

```
Speckl denied (waiting on a sign-off): HNTL: act tool refused while awaiting signal review. Next: Act tools stay refused until this sign-off is recorded; an observe tool may still run when the spec allows it. Sign-off "review" (outcomes: approve, reject; claims: reviewer: String). Pinned signer "carol". The drop must be signed by that key. Do not pass --pubkey. A human runs: node '/path/to/agent/signal.mjs' apply --state '/path/to/state.json' --verifier file-drop --file <drop.json> --signer 'carol' . The signed drop is {"signal":"review","outcome":"<approve or reject>","claims":{"reviewer":"<String>"},"run":"<run id from init>","expires":"<ISO-8601>","nonce":"<unique>"}. The agent must not run that command or read the state key.
```

With two pins the command stops at `--file <drop.json>` and the sentence says
`Pinned signers "carol", "dave"`.

A legacy state (no `signers` field) keeps the old command, with `<pubkey>`
standing for the human's public-key file:

```
node '/path/to/agent/signal.mjs' apply --state '/path/to/state.json' --verifier file-drop --file <drop.json> --pubkey <pubkey>
```

The same command with `mode in` starts from `HITL: no tools while awaiting signal review` and says that no tool call runs until the sign-off is recorded.

**Precondition failed.** A `precondition:` (or a `require` that is not the
stage) did not hold, a required argument is missing, or another call is
still in flight. Fix the input, or have a human clear the stuck call. The
clear-pending command follows the same pin rule. One pinned signer:

```
node '/path/to/agent/signal.mjs' clear-pending --state '/path/to/state.json' --verifier file-drop --file <drop.json> --signer 'carol'
```

```json
{"signal":"clear-pending","call_id":"<pending id>","run":"<run id>","expires":"<ISO-8601>","nonce":"<unique>"}
```

**Internal error (fail closed).** The payload was not usable, the tool is not
in the spec, the spec hash does not match, or the state seal failed. Do not
retry the same call. A human re-inits or restores the state with
`signal.mjs init`. A missing key, an unreadable key, a missing or unreadable
state file, a lock failure, and a decision record that cannot be written each
use a fixed sentence. The Node error, which names the path it opened, is not
appended.
