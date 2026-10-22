# Agent targets (`-t agent`)

Compiles an `agent { }` block into:

```
<out>/agent/
  AGENTS.md          readable rails
  tools.json         tool names + JSON Schema + x-speckl
  hook.mjs           generic pre/post gate
  signal.mjs         init / apply / timeout / clear-pending / rotate-signers
  state-integrity.mjs  hash-chained log + HMAC check shared by hook and signal
  verifiers/         cli + file-drop
  <Speck>.ts|.mjs    machine with can()/serialize() + __signal_* actions
                     (.mjs is plain JavaScript; no TypeScript needed at runtime)
  agent-config.json  runtime config
  spec.sha256
  README.md
  adapter.mjs        harness adapter (only with a `harness` block)
  harness/           Claude Code / Cursor hook wiring (only with a `harness` block)
```

To enforce the policy inside Claude Code or Cursor, declare a `harness` block;
see [harness-adapters.md](harness-adapters.md).

Included in `-t all`.

## Block syntax

```
agent {
    stages stage { Idle = 0  AwaitingReview = 2  Approved = 3  Rejected = 4 }
    tool run_tests -> RunTests effect act
    tool read_file -> ReadFile effect observe
    pending timeout 10m    // optional; default 10m
    await AwaitingReview {
        signal review
        mode near          // near = HNTL, in = HITL
        require outcome in { approve, reject! }
        require claims { reviewer: String }
        // optional; omit the next line for a stage-level sign-off
        bind call on approve
        on approve -> Approved
        on reject  -> Rejected
        timeout 24h -> reject
    }
}
```

`stages` maps labels onto a Nat state variable so Z3 BMC stays sound (enum /
string stages are not BMC-complete in the current Z3 backend).

Effect keywords are **`act`** and **`observe`** (not side/read).

### Reject outcomes: `name!`

Mark reject outcomes with a trailing `!` in `require outcome in { ... }`:

```
require outcome in { approve, reject! }
require outcome in { approve, request_changes!, veto! }
```

Speckl never guesses from names. The marker drives two compile-time checks:

- `timeout <dur> -> X` is an error unless `X` is marked `!`.
- A `!` outcome may not lead to a stage that an unmarked (accepting) outcome
  also reaches, so a reject (or a timeout) can't approve under another name.

An unmarked outcome whose name looks like a rejection (`reject`, `deny`,
`decline`) gets a warning suggesting the marker.

### Call-bound sign-off: `bind call`

`bind call` on an await makes each accepting outcome cover one exact tool
call. `bind call on approve` limits that to the named outcomes, in the order
written. The signed drop then carries `call`, the sha256 of
`canonical({ tool, input })` for the spec tool name and mapped arguments.
The hook allows that call once and denies any other call while the approval
is outstanding. A mismatch is exit 2 and does not consume the approval.
Reject outcomes and timeouts are never call-bound. An await without the
clause is unchanged: after the stage advances, any later call `can()` allows
may run, and a drop that carries `call` is refused.

A call-bound `file-drop` is still accepted only from the current pinned
signer set. Expiry (`now >= expires`) and that signer check run when the
drop is applied. Neither is checked again when the bound call runs, and
rotating signers does not revoke a binding already stored. See
[agent-signals.md](agent-signals.md) for the canonical form, how a human
reads the preimage (`signal.mjs digest`), and the other limits.

### Stuck tool calls: `pending timeout`

`pending timeout <dur>` (default `10m`) bounds how long a `pre` may wait for
its `post`. An older pending call is cleared as **failed** (the state is not
advanced) by the next `pre`, or rejected at `post`. `signal.mjs clear-pending`
clears one sooner, through the same verified path as signals.

## Wiring example

This session runs as written (it is executed by
`compiler/src/__tests__/agent-docs-wiring.test.ts`):

```bash
speckl-compile examples/AgentPolicy.speckdl -t agent -o out
cd out/agent
# The state key signs state.json; init creates it if missing. In production it
# lives where the agent can't read it (see agent-signals.md, "Tamper-evident state").
export SPECKL_STATE_KEY_FILE="$PWD/state.key"
# --dev allows the low-assurance cli verifier below. DEV ONLY: anyone who can
# run signal.mjs (an agent with a shell, too) can approve. Production omits
# --dev and records signals with a signed verifier (see agent-signals.md).
node signal.mjs init --state ./state.json --dev

# Each tool call: pre before it runs (exit 0 allow, 2 deny), post after.
echo '{"tool":"run_tests","input":{},"call_id":"1"}' | node hook.mjs pre --state ./state.json
echo '{"tool":"run_tests","input":{},"call_id":"1","ok":true}' | node hook.mjs post --state ./state.json
echo '{"tool":"request_review","input":{},"call_id":"2"}' | node hook.mjs pre --state ./state.json
echo '{"tool":"request_review","input":{},"call_id":"2","ok":true}' | node hook.mjs post --state ./state.json

# Now waiting on the judge: act tools are refused until a signal lands.
! echo '{"tool":"open_pr","input":{},"call_id":"3"}' | node hook.mjs pre --state ./state.json

# A verified signal (here the DEV-only CLI verifier) moves it on.
node signal.mjs apply --state ./state.json --verifier cli \
  --outcome approve --as alice --claim_reviewer alice
echo '{"tool":"open_pr","input":{},"call_id":"3"}' | node hook.mjs pre --state ./state.json

# Hand-editing state.json is refused: the signature and log no longer match.
cp state.json state.bak
sed -i 's/"stage": 3/"stage": 5/' state.json
! echo '{"tool":"read_file","input":{"path":"x"},"call_id":"4"}' | node hook.mjs pre --state ./state.json
mv state.bak state.json
```
