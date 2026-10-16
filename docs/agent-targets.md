# Agent targets (`-t agent`)

Compiles an `agent { }` block into:

```
<out>/agent/
  AGENTS.md          readable rails
  tools.json         tool names + JSON Schema + x-speckl
  hook.mjs           generic pre/post gate
  signal.mjs         init / apply / timeout / clear-pending
  verifiers/         cli + file-drop
  <Speck>.ts|.mjs    machine with can()/serialize() + __signal_* actions
                     (.mjs is plain JavaScript; no TypeScript needed at runtime)
  agent-config.json  runtime config
  spec.sha256
  README.md
```

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
```
