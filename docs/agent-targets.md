# Agent targets (`-t agent`)

Compiles an `agent { }` block into:

```
<out>/agent/
  AGENTS.md          readable rails
  tools.json         tool names + JSON Schema + x-speckl
  hook.mjs           generic pre/post gate
  signal.mjs         init / apply / timeout
  verifiers/         cli + file-drop
  <Speck>.ts|.mjs    machine with can()/serialize() + __signal_* actions
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
    await AwaitingReview {
        signal review
        mode near          // near = HNTL, in = HITL
        require outcome in { approve, reject }
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
