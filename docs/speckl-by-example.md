# Speckl by Example

A guided tour of SpeckDL through working examples — from a toggle switch to distributed consensus.

## What is SpeckDL?

SpeckDL is the specification language for Speckl. It lets you write formal, verifiable specifications that compile to:

- **TypeScript** — typed state machine classes you can run
- **WASM** — WebAssembly modules for embedded verification
- **PROV-O** — W3C provenance ontology (audit trail)
- **CycloneDX** — Software Bill of Materials (SBOM)
- **SPDX** — Standard license/material metadata

Every speck carries **embedded provenance**: where it came from, what regulations it fulfills, and who authored it. This is what we call **dark provenance** — always present, never in the way.

---

## 1. ToggleSwitch — Your First State Machine

**File:** `examples/ToggleSwitch.speck`

```speck
speck ToggleSwitch {
    state {
        isOn: Bool
    }

    init {
        isOn == false
    }

    invariant SwitchConsistent {
        isOn in {true, false}
    }

    action TurnOn {
        require not isOn
        isOn := true
        return isOn
    }

    action TurnOff {
        require isOn
        isOn := false
        return isOn
    }

    next: TurnOn | TurnOff
}
```

### What's happening here?

**State** declares the state variables. A toggle switch has one boolean.

**Init** sets the initial state — the switch starts off.

**Invariant** declares a property that must hold in every reachable state. `isOn in {true, false}` looks trivial, but invariants become critical in distributed systems (see Raft).

**Actions** are the only way to change state:
- `require` is a guard — the action fails if the condition isn't met
- `:=` is assignment
- `return` makes the result observable

**Next** defines which actions can fire. `TurnOn | TurnOff` means either can happen at any time — it's nondeterministic. The model checker explores all interleavings.

### What this compiles to

ToggleSwitch generates a TypeScript class with typed `turnOn()` and `turnOff()` methods, each containing the guard check. The WASM output can be embedded in a browser for client-side state validation.

---

## 2. AccountLedger — Collections and Financial Safety

**File:** `examples/AccountLedger.speck`

```speck
speck AccountLedger {
    state {
        balances: Map(Nat, Int)
        accounts: Set(Nat)
        pendingTransfers: Map(Nat, PendingTransfer)
        inFlight: Set(Nat)
    }

    init {
        balances == emptyMap
        accounts == emptySet
        pendingTransfers == emptyMap
        inFlight == emptySet
    }

    invariant NoNegativeBalancesWithoutOverdraft {
        forall id in accounts:
            balances[id] >= 0
    }

    invariant PendingConsistent {
        forall tid in inFlight:
            tid in pendingTransfers.keys
    }

    action CreateTransfer(tid: Nat, from: Nat, to: Nat, amount: Nat) {
        require tid notIn inFlight
        require from in accounts
        require to in accounts
        require from != to
        require balances[from] >= amount

        let pt := { from: from, to: to, amount: amount }
        pendingTransfers[tid] := pt
        inFlight := inFlight union {tid}
        balances[from] := balances[from] - amount
        emit TransferCreated { id: tid, from: from, to: to, amount: amount }
    }
    // ... CommitTransfer, VoidTransfer, OpenAccount
}
```

### New concepts

**Map and Set types** — `Map(Nat, Int)` is a key-value store. `Set(Nat)` is an unordered collection. Operations: `union`, `\` (difference), `in`, `notIn`.

**Quantified invariants** — `forall id in accounts: balances[id] >= 0` says "no account can have a negative balance." This is a safety property that the model checker verifies across all action sequences.

**Let bindings** — `let pt := { from: from, to: to, amount: amount }` creates a local value for readability.

**Emit** — produces a structured event observable by external systems. These become typed TypeScript events.

**Record types** — `PendingTransfer` is a record with named fields, defined elsewhere in the spec.

### Why this matters

Financial systems live and die by invariants. SpeckDL lets you state "transfers must be atomic" or "balances must never go negative" as first-class assertions, not comments that rot. The compiler checks them at compile time; the WASM runtime enforces them at execution time.

---

## 3. TwoPhaseCommit — Distributed Transactions

**File:** `examples/TwoPhaseCommit.speck`

This is a direct port of Lamport's TLA+ Two-Phase Commit spec.

```speck
speck TwoPhaseCommit {
    state {
        rmState: Map(String, String)
        tmState: String
        tmPrepared: Set(String)
        msgs: Set(Message)
        rms: Set(String)
    }

    invariant TPConsistency {
        tmState == "committed" implies
            forall rm in rms: rmState[rm] == "committed"
        tmState == "aborted" implies
            forall rm in rms: rmState[rm] == "aborted"
        forall rm in rms:
            rmState[rm] == "committed" implies tmState != "aborted"
    }

    action TMCommit {
        require tmState == "init"
        require tmPrepared == rms

        tmState := "committed"
        msgs := msgs union {{ type: "Commit" }}
        forall rm in rms:
            rmState[rm] := "committed"
        emit AllCommitted {}
    }
    // ... RMPrepare, TMRcvPrepared, TMAbort, RMChooseToAbort
}
```

### New concepts

**Multi-role state** — TwoPhaseCommit has a Transaction Manager and multiple Resource Managers. Each has its own state tracked in `rmState` and `tmState`.

**Safety invariants** — The TPConsistency invariant encodes the core guarantee of 2PC: if the TM commits, all RMs must have committed. If the TM aborts, all RMs must have aborted. No RM can be committed while the TM is aborted. These are not comments — they are verifiable assertions.

**Message passing** — `msgs` is a set of messages in transit. Actions add and consume messages, modeling the asynchronous communication between TM and RMs.

**Bulk state mutation** — `forall rm in rms: rmState[rm] := "committed"` updates every RM atomically within the action. This captures the "all or nothing" semantics of the commit decision.

### TLA+ lineage

This spec is structurally identical to the TLA+ version used to teach distributed systems at universities. The key difference: in SpeckDL, the same spec also generates runnable TypeScript and audit-trail provenance. You don't just verify — you deploy.

---

## 4. Raft — Production Consensus

**File:** `examples/Raft.speck`

Raft is the consensus algorithm behind etcd, Consul, and TiKV. This is a complete SpeckDL port with leader election, log replication, and safety invariants.

```speck
speck Raft {
    type LogEntry = {
        term: Term,
        index: LogIndex,
        command: String
    }

    type ServerState = {
        role: String,
        currentTerm: Term,
        votedFor: String | null,
        log: List(LogEntry),
        commitIndex: LogIndex,
        lastApplied: LogIndex
    }

    state {
        servers: Set(ServerId)
        serverState: Map(ServerId, ServerState)
        nextIndex: Map(Map(ServerId, ServerId), LogIndex)
        matchIndex: Map(Map(ServerId, ServerId), LogIndex)
    }

    // Safety: at most one leader per term
    invariant SingleLeaderPerTerm {
        forall s1 in servers:
            forall s2 in servers:
                serverState[s1].role == "leader" and
                serverState[s2].role == "leader" and
                s1 != s2 implies
                    serverState[s1].currentTerm != serverState[s2].currentTerm
    }

    // Safety: committed entries survive elections
    invariant LeaderCompleteness {
        forall s in servers:
            serverState[s].role == "leader" implies
                forall entry in serverState[s].log:
                    entry.index <= serverState[s].commitIndex implies
                        entry.term <= serverState[s].currentTerm
    }

    // Safety: if two logs have same term at same index, entries match
    invariant LogMatching {
        forall s1 in servers:
            forall s2 in servers:
                forall i in [1 .. length(serverState[s1].log)]:
                    i <= length(serverState[s2].log) and
                    serverState[s1].log[i].term == serverState[s2].log[i].term implies
                        serverState[s1].log[i].command == serverState[s2].log[i].command
    }

    action StartElection(server: ServerId) { /* ... */ }
    action GrantVote(voter: ServerId, req: RequestVoteReq) { /* ... */ }
    action BecomeLeader(server: ServerId) { /* ... */ }
    action AppendEntries(leader: ServerId, follower: ServerId, req: AppendEntriesReq) { /* ... */ }
    action AdvanceCommit(leader: ServerId) { /* ... */ }
    action ApplyEntries(server: ServerId) { /* ... */ }
}
```

### New concepts

**Type aliases** — `type LogIndex = Nat` and `type Term = Nat` make the spec self-documenting. The compiler treats them as their underlying types but preserves the alias names in generated code.

**Record types with optional fields** — `votedFor: String | null` uses union types for nullable fields. This is cleaner than sentinel values.

**List type** — `List(LogEntry)` is an ordered sequence, distinct from `Set`. List operations include indexing (`log[i]`), `take`, `concat`, and `length`.

**Nested map keys** — `Map(Map(ServerId, ServerId), LogIndex)` uses a compound key `{ leader, follower }` for per-leader-per-follower tracking.

**Three safety invariants** — Raft's correctness depends on these three properties. SpeckDL makes them verifiable assertions rather than paper proofs:
1. **SingleLeaderPerTerm** — no two servers can be leader in the same term
2. **LeaderCompleteness** — a leader's log contains all committed entries
3. **LogMatching** — consistent entries at matching (index, term) positions

**Control flow** — `if req.term > serverState[leader].currentTerm { ... return }` allows early exit. `for i from ... to ...` provides counted iteration.

---

## The SpeckDL Compilation Pipeline

Every speck goes through the same pipeline:

```
.speckdl ──► Parser ──► AST ──┬──► TypeScript Generator ──► .ts (runnable)
                              ├──► WASM Generator      ──► .wat (verifiable at runtime)
                              ├──► PROV-O Generator     ──► .ttl (audit trail)
                              ├──► CycloneDX Generator  ──► .xml (SBOM)
                              └──► SPDX Generator       ──► .json (license/material)
```

### What you get

**One spec, five outputs.** Write a state machine once and get:
- Runnable TypeScript you can import into any Node.js project
- Verifiable WASM you can embed in CI/CD pipelines
- Complete provenance chain for regulatory compliance (NIST SA-11)
- SBOMs for supply chain security
- License metadata for open source compliance

---

## Comparison: SpeckDL vs. TLA+

| Dimension | TLA+ | SpeckDL |
|-----------|------|---------|
| **Purpose** | Formal verification only | Spec → verify → compile → run |
| **Output** | Model checker results | Runnable code (TS + WASM) |
| **Provenance** | None | Embedded (PROV-O, CycloneDX) |
| **Learning curve** | Steep (untyped set theory) | Moderate (typed, familiar syntax) |
| **Industry adoption** | AWS, Microsoft (internal) | Target: compliance-driven orgs |
| **Tooling** | TLA+ Toolbox, TLC | Single CLI, standard formats |
| **Regulatory** | None built-in | NIST SA-11, SBOM-ready |

TLA+ proved that formal methods work at scale. SpeckDL makes them deployable.

---

## Next Steps

1. **Read the spec:** `SPEC.md` — full language reference
2. **Run the examples:** `cd compiler && npm run build && node dist/cli.js compile ../examples/ToggleSwitch.speck`
3. **Write your own:** Start with a toggle switch, add state variables, write invariants
4. **Target production:** See `examples/TigerBeetleLedger.speck` for a real financial system spec

---

*Speckl is an open standard (MIT). Contribute at os.scoble.me/forgejo/sscoble/speckl*
