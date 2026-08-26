# Consensus Protocols in SpeckDL: From TLA+ to Runnable Code

**By Scott Scoble** · Published on [dev.to/Medium/HN] · Series: [Building Speckl](https://speckl.scoble.me) · Post 5 of 5

---

Consensus protocols are the hardest programs to get right. Leslie Lamport called them "the most important contribution of computer science to distributed systems" — and also the most frequently implemented incorrectly.

The pattern is depressingly familiar: a team formally verifies a consensus protocol in TLA+, finds it correct, then manually translates the spec to production code — and introduces new bugs in the translation. The spec is verified. The code is not. This is the spec-code gap at its most dangerous.

Speckl was designed to close that gap. This post walks through three consensus protocols — Two-Phase Commit, Paxos, and Raft — all specified in SpeckDL, all compiling to runnable TypeScript and WASM. No manual translation. No gap.

## Why Consensus Protocols?

Distributed consensus powers databases (TigerBeetle, Spanner), coordination services (etcd, ZooKeeper), and blockchain protocols. Getting it wrong means data loss, split-brain, or silent corruption. TLA+ specifications of Paxos have found bugs in production implementations *years* after deployment.

Consensus protocols also exercise every corner of a specification language: record types for messages and ballots, Map and Set types for membership and quorums, quantified invariants for safety properties, and non-deterministic action interleaving. If your spec language can handle consensus, it can handle almost anything.

## Two-Phase Commit

Two-Phase Commit (2PC) is the simplest consensus protocol: a transaction manager coordinates multiple resource managers to agree on whether a transaction commits or aborts. It's a classic TLA+ example from Lamport himself.

**The SpeckDL spec** — 45 lines, 5 actions:

```
spec TwoPhaseCommit

state {
    rm_state: Map(String, String)         // working | prepared | committed | aborted
    tm_state: String                       // init | committed | aborted
    msgs: Set(String)                      // "Prepared" | "Commit" | "Abort"
}

init {
    tm_state = "init"
    forall rm in rms:
        rm_state[rm] = "working"
}

action RMPrepare {
    require rm_state[self] == "working"
    rm_state[self] = "prepared"
    msgs += "Prepared"
}

action TMCommit {
    require tm_state == "init"
    require forall rm in rms: rm_state[rm] == "prepared"
    tm_state = "committed"
    msgs += "Commit"
}

action TMAbort {
    require tm_state == "init"
    require exists rm in rms: rm_state[rm] != "prepared"
    tm_state = "aborted"
    msgs += "Abort"
}
```

The key safety invariant — `TPConsistency` — ensures that committed RMs imply a committed TM, and that no RM is committed when TM is aborted. `next` captures the non-deterministic interleaving: any action can fire at any time subject to its preconditions.

## Paxos

Paxos is the canonical consensus protocol — and famously difficult to implement correctly. Lamport's original 1998 paper presented it as a parable about a Greek parliament precisely because the algorithm's subtlety resists informal description.

**The SpeckDL spec** — 120 lines, 6 actions — captures the full two-phase protocol:

- **Phase 1a (Prepare):** A proposer sends a Prepare message with a unique ballot number. Ballot numbers provide total ordering.
- **Phase 1b (Promise):** Acceptors promise not to accept lower-numbered ballots and report any previous votes.
- **Phase 2a (Propose):** The proposer collects a quorum of promises and proposes a value — either the value from the highest-numbered previous vote, or any value of its choice.
- **Phase 2b (Vote):** Acceptors vote for the proposal if its ballot number is at least as high as the one they promised.
- **Learn:** Once a quorum of acceptors has voted for the same value, that value is chosen.

SpeckDL's record types make the data model clear:

```
type Ballot = { number: Nat, value: String | null, proposer: String | null }
type AcceptorSlot = { acceptor: String, slot: Nat }

state {
    ballots: Map(Ballot, String)
    promises: Map(AcceptorSlot, Ballot)
    votes: Map(AcceptorSlot, Map(Ballot, String))
    chosen: Map(Ballot, String)
}
```

The three safety invariants capture exactly what makes Paxos correct:

- **BallotUniqueness:** No two ballots share the same number.
- **SingleValuePerBallot:** At most one value per ballot number.
- **PaxosSafety:** If a value is chosen, no other value can be proposed for that ballot.

All three compile as runtime checks in the generated TypeScript and WASM. They're not just documentation — they're executable verification.

## Raft

Raft is the consensus protocol that powers etcd, Consul, and dozens of production systems. Designed by Ongaro and Ousterhout in 2014 as an "understandable" alternative to Paxos, Raft decomposes consensus into three sub-problems: leader election, log replication, and safety.

**The SpeckDL spec** — 230 lines, 8 actions, 3 safety invariants — is the largest in our example suite:

| Action | Purpose |
|--------|---------|
| `StartElection` | Follower times out → becomes candidate |
| `GrantVote` | Follower votes for candidate with sufficiently complete log |
| `BecomeLeader` | Candidate with majority votes becomes leader |
| `AppendEntries` | Leader replicates log, checks consistency, truncates conflicts |
| `ApplyEntries` | Each server applies committed entries to state machine |
| `AdvanceCommit` | Leader increments commitIndex on majority replication |

### Record types that mirror the paper

Raft exercises SpeckDL's nested record types extensively:

```
type LogEntry = { term: Term, index: LogIndex, command: String }
type ServerState = {
    role: String,
    currentTerm: Term,
    votedFor: String | null,
    log: List(LogEntry),
    commitIndex: LogIndex,
    lastApplied: LogIndex
}
type AppendEntriesReq = {
    term: Term, leaderId: ServerId,
    prevLogIndex: LogIndex, prevLogTerm: Term,
    entries: List(LogEntry), leaderCommit: LogIndex
}
```

These are the same structures from the Raft paper — expressed directly in SpeckDL, with nullable fields for optional values and `List` types for ordered sequences.

### Three safety invariants

**SingleLeaderPerTerm:** At most one leader per term. For any two servers both claiming to be leader, their terms must differ. This prevents split-brain.

**LeaderCompleteness:** A leader's log contains all committed entries from previous terms. This ensures new leaders don't lose data.

**LogMatching:** If two logs have the same term at the same index, the entries match — no divergent histories.

These invariants are expressed as quantified expressions in SpeckDL and emitted as runtime assertions in the generated code:

```
invariant SingleLeaderPerTerm {
    forall s1 in servers:
        forall s2 in servers:
            serverState[s1].role == "leader" and
            serverState[s2].role == "leader" and
            s1 != s2 implies
                serverState[s1].currentTerm != serverState[s2].currentTerm
}
```

## TLA+ and SpeckDL: Side by Side

All three consensus examples exist as well-known TLA+ specifications. The SpeckDL versions are faithful ports that preserve the same state variables, actions, and safety properties while adding a capability TLA+ does not provide: **compilation to executable software.**

| Dimension | TLA+ | SpeckDL |
|-----------|------|--------|
| Model checking | Yes (TLC) | No (planned) |
| Compiles to code | No | Yes (TypeScript, WASM) |
| Generates SBOMs | No | Yes (CycloneDX, SPDX) |
| Generates provenance | No | Yes (PROV-O) |
| Type system | Sets, functions, tuples | Sets, Maps, Lists, Records, Optional |
| Invariants | Written, checked by TLC | Written, emitted as runtime checks |
| Learning curve | High (special notation) | Moderate (familiar types, if/emit/let) |
| Target audience | Researchers, verification engineers | Engineers, compliance teams, auditors |

**The key difference:** TLA+ produces a proof about a model of the system. SpeckDL produces the system itself. Both are valuable — but for organizations that need auditable, compilable specifications that serve as both documentation and compliance evidence, SpeckDL fills a gap that TLA+ deliberately leaves open.

## From Consensus to Production

The progression — Two-Phase Commit (learning), Paxos (theoretical bedrock), Raft (production consensus) — forms a complete curriculum. But there's a fourth entry that makes this real:

**TigerBeetle.** We wrote a naive TigerBeetle financial ledger spec in SpeckDL — 80 lines covering accounts, transfers, pending amounts, and debit/credit constraints. It parses, it compiles, and the WASM validates. This is the bridge from academic consensus to production financial systems — the kind of code where bugs cost real money.

The TigerBeetle spec compiles to TypeScript with 3 remaining type errors (all `Transfer` / `LogEntry` record references — the record type emitter doesn't yet emit record type declarations for fields used in action guards). This is tracked in our public issue tracker and being actively worked on.

## Where We Are

The compiler is open source ([os.scoble.me/forgejo/sscoble/speckl](https://os.scoble.me/forgejo/sscoble/speckl), MIT), at v0.3.1 with:
- 41 tests passing (100%)
- 11 example specs (5 producing zero TypeScript errors)
- All three consensus protocols compiling to the full 5-artifact output
- CLI, live demo, and comprehensive documentation

The gap between TLA+ verification and production code has existed for decades. Speckl won't replace TLA+ — but it gives teams an option that didn't exist before: **write your spec once, verify it, and compile it into the code that runs in production.**

## The Blog Post Series

This concludes our 5-part series on the Speckl compiler and methodology:

1. **Spec-Code Drift Is a Provenance Problem** — why the gap between spec and code matters
2. **Designing SpeckDL: What a Spec Language Needs in 2026** — the language design
3. **How Speckl's Compiler Works: From Spec to Five Auditable Artifacts** — under the hood
4. **Embedded Provenance: Proving What Ran Came From What You Wrote** — the evidence layer
5. **[This post] Consensus Protocols in SpeckDL** — Two-Phase Commit, Paxos, Raft

## What's Next

The Phase 2 content pipeline is complete. All 5 blog posts are drafted, ready for Scott to publish on a weekly cadence ahead of or following the Show HN launch (targeting May 12-13).

If you want to try Speckl today: clone the repo, run `speckl compile examples/ToggleSwitch.speck`, and you'll have five artifacts in under two seconds. The consensus examples are at `examples/TwoPhaseCommit.speck`, `examples/Paxos.speck`, `examples/Raft.speck`, and `examples/TigerBeetle.speck`.

If you'd like to follow Speckl's development or contribute, the repo is open and issues are tracked publicly. I'd love to hear what you're building with it — or what you wish it could do.

---

*Scott Scoble is the creator of Speckl, an open-source specification language with compiler-level provenance. He writes about the intersection of formal methods, supply chain security, and AI-generated code. Follow along at [speckl.scoble.me](https://speckl.scoble.me).*
