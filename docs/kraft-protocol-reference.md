# Kafka KRaft Protocol Reference

> Source material for writing `examples/KafkaKRaft.speck` (Kafka KRaft example reference)

## Scope

This reference covers the **consensus core** of KRaft — the state machine for leader election, log replication, and commit advancement. It does NOT cover:

- Full broker functionality (topic creation, partition assignment, consumer group coordination)
- Data plane (produce/fetch request handling)
- Controller-specific logic (metadata quorums, configuration management)
- Network transport (this is a logical model, not a network protocol spec)

The boundary: if it touches `currentTerm`, `votedFor`, `log`, `commitIndex`, or `state` transitions, it's in scope.

**In scope (M1.1):** Core Raft consensus — leader election, log replication, commit advancement, and all 6 safety invariants, including KRaft's extensions (Unattached, Resigned, Prospective states, Pre-Vote, snapshots).

**Deferred to M1.3:** Producer ack semantics, consumer group rebalancing, transaction coordinator.

**Out of scope:** Full Kafka broker (produce/fetch handling), controller-specific logic, network layer.

## Sources

1. **Raft TLA+ Specification** — Diego Ongaro, 2014. The canonical formal spec. Available at: `github.com/ongardie/raft.tla`
2. **"In Search of an Understandable Consensus Algorithm"** — Ongaro & Ousterhout, 2014 (USENIX ATC). Includes safety proof.
3. **"Consensus: Bridging Theory and Practice"** — Ongaro, 2014 (PhD dissertation). Extended TLA+ spec, implementation concerns.
4. **KIP-595: A Raft Protocol for the Metadata Quorum** — The foundational KIP that introduced KRaft. `cwiki.apache.org/confluence/display/KAFKA/KIP-595`
5. **KIP-630: Kafka Raft Snapshot** — Snapshot mechanism for KRaft metadata log. Status: Adopted.
6. **KIP-996: Pre-Vote for KRaft** — Adds Pre-Vote phase to prevent disruptive servers. Status: Implementing.
7. **KIP-853: KRaft Controller Membership Changes** — Dynamic quorum membership changes. Status: Implemented.
8. **Apache Kafka source** — `kafka/raft/` package. Key files: `KafkaRaftClient.java`, `QuorumState.java`, `LeaderState.java`, `CandidateState.java`, `FollowerState.java`, `UnattachedState.java`, `ProspectiveState.java`, `ResignedState.java`, `EpochState.java`
9. **Red Hat Deep Dive** — "A Deep Dive into Apache Kafka's KRaft Protocol" (developers.redhat.com, 2025). Covers KRaft v1 based on Kafka 4.1.0.

---

## 1. Raft State Machine (from TLA+ Spec)

*Reference: Source [1], [3]*

### 1.1 State Variables

Per server (`i ∈ Server`):

| Variable | Type | Description |
|----------|------|-------------|
| `currentTerm` | Nat | Current term number (monotonically increasing) |
| `state` | {Follower, Candidate, Leader} | Server role |
| `votedFor` | Server ∪ {Nil} | Candidate voted for in current term, or Nil |
| `log` | Seq(LogEntry) | Sequence of log entries (index = position) |
| `commitIndex` | Nat | Index of highest log entry known to be committed |
| `nextIndex` | Server → Nat | (Leader only) Next log index to send to each follower |
| `matchIndex` | Server → Nat | (Leader only) Highest log index replicated on each follower |
| `votesResponded` | Set(Server) | (Candidate only) Servers that responded to RequestVote |
| `votesGranted` | Set(Server) | (Candidate only) Servers that granted vote |

Global:

| Variable | Type | Description |
|----------|------|-------------|
| `messages` | Bag(Message) | In-flight messages (requests/responses) |

### 1.2 LogEntry Type

```
LogEntry == { term: Nat, value: Value }
```

### 1.3 Quorum

```
Quorum == {i ∈ SUBSET(Server) : Cardinality(i) * 2 > Cardinality(Server)}
```

Simple majority. The key property: any two quorums overlap.

### 1.4 Initial State

```
currentTerm[i] = 1
state[i] = Follower
votedFor[i] = Nil
log[i] = <<>> (empty sequence)
commitIndex[i] = 0
```

### 1.5 Actions (State Transitions)

#### Action 1: Timeout → Start Election

**Preconditions:**
- `state[i] ∈ {Follower, Candidate}`

**Effects:**
- `state[i] ← Candidate`
- `currentTerm[i] ← currentTerm[i] + 1`
- `votedFor[i] ← Nil`
- `votesResponded[i] ← {}`
- `votesGranted[i] ← {}`

#### Action 2: RequestVote Request (Candidate → Peer)

**Preconditions:**
- `state[i] = Candidate`
- `j ∉ votesResponded[i]`

**Effects:**
- Send `RequestVoteRequest` with `{mterm: currentTerm[i], mlastLogTerm: LastTerm(log[i]), mlastLogIndex: Len(log[i]), msource: i, mdest: j}`

#### Action 3: HandleRequestVoteRequest (Peer → Candidate)

**Preconditions:**
- `m.mterm ≤ currentTerm[i]`

**Log check (`logOk`):**
```
logOk ≡ m.mlastLogTerm > LastTerm(log[i])
       ∨ (m.mlastLogTerm = LastTerm(log[i]) ∧ m.mlastLogIndex ≥ Len(log[i]))
```

**Grant conditions:**
```
grant ≡ m.mterm = currentTerm[i] ∧ logOk ∧ votedFor[i] ∈ {Nil, j}
```

**Effects (if grant):**
- `votedFor[i] ← j`

**Effects (always):**
- Reply with `RequestVoteResponse{mterm: currentTerm[i], mvoteGranted: grant}`

#### Action 4: HandleRequestVoteResponse (Candidate receives vote)

**Preconditions:**
- `m.mterm = currentTerm[i]`

**Effects:**
- `votesResponded[i] ← votesResponded[i] ∪ {j}`
- If `m.mvoteGranted`: `votesGranted[i] ← votesGranted[i] ∪ {j}`

#### Action 5: BecomeLeader (Candidate → Leader)

**Preconditions:**
- `state[i] = Candidate`
- `votesGranted[i] ∈ Quorum`

**Effects:**
- `state[i] ← Leader`
- `nextIndex[i] ← [j ∈ Server → Len(log[i]) + 1]` for all j
- `matchIndex[i] ← [j ∈ Server → 0]` for all j

#### Action 6: AppendEntries Request (Leader → Follower)

**Preconditions:**
- `i ≠ j`
- `state[i] = Leader`

**Effects:**
- Send `AppendEntriesRequest` with entries from `nextIndex[i][j]` to `min(Len(log[i]), nextIndex[i][j])` (at most 1 entry per message in the spec)
- Include `mprevLogIndex = nextIndex[i][j] - 1`, `mprevLogTerm`, `mcommitIndex`

#### Action 7: HandleAppendEntriesRequest (Follower receives entries)

**Preconditions:**
- `m.mterm ≤ currentTerm[i]`

**Log consistency check (`logOk`):**
```
logOk ≡ m.mprevLogIndex = 0
       ∨ (m.mprevLogIndex ≤ Len(log[i]) ∧ m.mprevLogTerm = log[i][m.mprevLogIndex].term)
```

**Effects (if logOk AND m.mterm ≥ currentTerm[i]):**
- Reset to Follower if Candidate
- Update `currentTerm[i] ← m.mterm` if needed
- Append/conflict resolution: if `mprevLogIndex > 0`, entries after `mprevLogIndex` that conflict are truncated
- `commitIndex[i] ← min(m.mcommitIndex, Len(log[i]))`
- Reply `AppendEntriesResponse{msuccess: TRUE, mmatchIndex: ...}`

**Effects (if !logOk OR m.mterm < currentTerm[i]):**
- Reply `AppendEntriesResponse{msuccess: FALSE, mmatchIndex: 0}`

#### Action 8: AdvanceCommitIndex (Leader)

**Preconditions:**
- `state[i] = Leader`

**Effects:**
- Find highest `N` such that `N > commitIndex[i]` and a quorum of `matchIndex[i][k] ≥ N`
- Only commit entries from current term: `log[i][N].term = currentTerm[i]`
- `commitIndex[i] ← N`

#### Action 9: ClientRequest (Leader appends entry)

**Preconditions:**
- `state[i] = Leader`

**Effects:**
- Append `[term: currentTerm[i], value: v]` to `log[i]`

#### Action 10: Restart (Server crash recovery)

**Effects:**
- `state[i] ← Follower`
- Reset volatile state (`votesResponded`, `votesGranted`, `nextIndex`, `matchIndex`, `commitIndex`)
- Preserve persistent state (`currentTerm`, `votedFor`, `log`)

---

## 2. KRaft Extensions Over Vanilla Raft

*References: Sources [4], [5], [6], [7], [8], [9]*

KRaft is Kafka's adaptation of Raft for metadata management. Key differences from vanilla Raft:

1. **No ZooKeeper:** KRaft replaces the ZooKeeper-based metadata quorum with a Raft-based one.
2. **Metadata log:** The replicated log contains metadata records (topic configs, partition assignments), not user data.
3. **Controller node:** KRaft has an "active controller" concept — the leader of the metadata quorum acts as the controller for the Kafka cluster.
4. **Snapshotting:** KRaft supports snapshot-based log compaction (KIP-630).
5. **Voters and observers:** Not all nodes are voters; some are observer nodes that replicate but don't vote.
6. **Resignation:** A leader can voluntarily step down (immediate or graceful).
7. **Pre-Vote:** KRaft implements Pre-Vote (KIP-996) to prevent disruptive servers from forcing unnecessary elections.
8. **Epochs instead of terms:** KRaft uses "epoch" terminology instead of "term" (functionally equivalent).
9. **Additional states:** KRaft adds Unattached, Prospective, Resigned, and Detached states beyond Follower/Candidate/Leader.

### 2.1 KRaft State Machine

The KRaft state machine is implemented in `QuorumState.java`. Unlike vanilla Raft's three-state model (Follower/Candidate/Leader), KRaft has a richer set of epoch-based states, all implementing the `EpochState` interface.

#### State Hierarchy

```
EpochState (interface)
├── UnattachedState      — Known epoch, unknown leader (initial startup or learned higher epoch)
├── ProspectiveState      — Pre-Vote candidate; gathering pre-votes before becoming Candidate
├── CandidateState         — Standard Raft candidate; actively requesting votes
├── FollowerState          — Standard Raft follower; replicating from a leader
├── LeaderState            — Standard Raft leader; accepting client writes
├── ResignedState          — Gracefully stepped-down leader; still processing resignations
└── DetachedState          — Observer or non-voter; replicating but cannot vote
```

#### Transition Diagram

```
                    ┌──────────────────────────────┐
                    │                              │
                    ▼                              │
              ┌──────────┐    Pre-Vote OK          │
              │Unattached│────────────────┐         │
              └──────────┘                │         │
                    │                      ▼         │
                    │              ┌────────────┐    │
         Discover   │              │ Prospective│    │
         Leader     │              │  (Pre-Vote)│    │
                    │              └────────────┘    │
                    │                    │           │
                    │         Pre-Vote   │           │
                    │         succeeded  │           │
                    │                    ▼           │
                    │           ┌────────────┐       │
                    │           │ Candidate  │───────┤ Won election
                    │           └────────────┘       │
                    │                 │               │
                    │       Lost      │ Won election  │
                    │       election  │ (quorum)      │
                    │                 ▼               │
                    │         ┌────────────┐          │
                    └───────► │  Follower  │◄────────┤
                              └────────────┘          │
                                    │                  │
                              Become leader             │
                                    │                  │
                                    ▼                  │
                              ┌────────────┐           │
                              │   Leader   │───────────┘ Higher term
                              └────────────┘
                                    │
                              Resign (graceful)
                                    │
                                    ▼
                              ┌────────────┐
                              │  Resigned  │
                              └────────────┘
```

Additionally, `DetachedState` is used for observers (non-voters) who track the leader but don't participate in elections.

---

## 3. KRaft State Variables (from Kafka Source)

*Reference: Source [8] — Apache Kafka `kafka/raft/` package*

### 3.1 Common State (QuorumState)

| Variable | Type | Description |
|----------|------|-------------|
| `localId` | Int | This node's replica ID |
| `voters` | Set(Int) | Set of voter replica IDs |
| `observers` | Set(Int) | Set of observer replica IDs |
| `epochState` | EpochState | Current state object (one of the states below) |
| `currentClaimedEpoch` | Int | Epoch this node last claimed (for persistence) |

### 3.2 UnattachedState

When a node knows about an epoch but hasn't discovered the leader yet, or is starting up.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | The epoch this node is in |
| `votedId` | Int? | Replica ID voted for in this epoch, or -1 (unvoted) |

### 3.3 ProspectiveState (Pre-Vote, KIP-996)

A node that has started Pre-Vote but hasn't transitioned to Candidate yet. This prevents disruptive servers from forcing elections.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | The epoch for which Pre-Vote is being conducted |
| `votedId` | Int? | Vote (always self during Pre-Vote) |
| `hasSufficientVote` | Bool | Whether a quorum of pre-votes has been received |
| `preVoteResponded` | Set(Int) | Voters that responded to Pre-Vote |
| `preVoteGranted` | Set(Int) | Voters that granted Pre-Vote |
| `gracePeriodExpired` | Bool | Whether the election timeout has expired |

**Transition to Candidate:** Only when `hasSufficientVote = true` AND `gracePeriodExpired = true`.

### 3.4 CandidateState

Standard Raft candidate with KRaft-specific additions.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | Current election epoch |
| `votedId` | Int | Always `localId` (votes for self) |
| `votes` | Set(Int) | Voter IDs that granted a vote |
| `isVoteGranted` | Bool | Whether a quorum of votes has been received |
| `isVoteRejected` | Bool | Whether the election is doomed (quorum impossible) |
| `highWatermark` | Long | Last known high watermark at election start |
| `retryVoteQuorumGracePeriod` | Bool | Whether to retry sending vote requests |

### 3.5 FollowerState

Standard Raft follower with KRaft-specific additions.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | Current epoch |
| `leaderId` | Int | ID of the current leader |
| `votedId` | Int? | Replica ID voted for (or -1) |
| `highWatermark` | Long | Last known high watermark |
| `lastCaughtUpTimeMs` | Long | Timestamp of last successful replication |
| `lingerHighWatermark` | Long | High watermark at which we started lingering |
| `isLingering` | Bool | Whether this follower is in linger mode (delaying transition) |

### 3.6 LeaderState

Standard Raft leader with KRaft-specific additions.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | Current epoch (same as currentTerm) |
| `leaderId` | Int | This node's ID |
| `highWatermark` | Long | Current high watermark (equivalent to commitIndex) |
| `voterStates` | Map(Int, VoterState) | Per-voter tracking: nextOffset, matchOffset, lastCaughtUpTime |
| `localId` | Int | This node's replica ID |
| `retryForVoterEnabled` | Bool | Whether to retry AppendEntries to slow voters |

**VoterState sub-structure:**

| Variable | Type | Description |
|----------|------|-------------|
| `nextOffset` | Long | Next log offset to send to this voter (= nextIndex) |
| `matchOffset` | Long | Highest offset known to be replicated on this voter (= matchIndex) |
| `lastCaughtUpTimeMs` | Long | Timestamp of last successful catch-up |
| `lastSentTimeMs` | Long | Timestamp of last AppendEntries sent |
| `isVoter` | Bool | Whether this replica is a voter |

### 3.7 ResignedState

A leader that has gracefully stepped down. Not present in vanilla Raft.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | The epoch when the leader resigned |
| `leaderId` | Int | Former leader's ID |

*Key behavior:* A resigned leader does not accept new client writes. It continues to process in-flight requests until they complete or time out. It then transitions to Unattached or Follower depending on what it learns about the new epoch.

### 3.8 DetachedState (Observer)

Used for observer (non-voter) nodes.

| Variable | Type | Description |
|----------|------|-------------|
| `epoch` | Int | Current epoch |
| `leaderId` | Int | ID of the leader being followed |
| `highWatermark` | Long | Last known high watermark |

*Key behavior:* Detached observers replicate the log but never vote or become candidates. They can transition to Follower or Unattached if they learn about a new epoch.

---

## 4. KRaft State Transitions (Detailed)

*Reference: Source [8], [9]*

### 4.1 Complete Transition Table

| From | To | Trigger | Preconditions |
|------|----|---------|--------------|
| Unattached | Prospective | Election timeout + Pre-Vote enabled | `votedId == -1`, `hasSufficientVote == false` |
| Unattached | Follower | DiscoverLeader with valid leader | `leaderId` known, `epoch` matches |
| Prospective | Candidate | Pre-Vote quorum reached + grace period expired | `hasSufficientVote ∧ gracePeriodExpired` |
| Prospective | Follower | DiscoverLeader OR higher AppendEntries | `leaderId` known or higher term received |
| Candidate | Leader | Election won (quorum of votes) | `isVoteGranted == true` |
| Candidate | Follower | DiscoverLeader OR higher term AppendEntries | `leaderId` known or higher term received |
| Follower | Prospective | Election timeout + no heartbeat | `votedId == -1`, Pre-Vote enabled |
| Follower | Candidate | Election timeout + Pre-Vote disabled | `votedId == -1` |
| Leader | Resigned | Graceful shutdown / Resign RPC | Leader decides to step down |
| Leader | Follower | Higher term received | `m.epoch > currentEpoch` |
| Resigned | Unattached | Resign processing complete + no leader known | All in-flight requests handled |
| Resigned | Follower | Learn about new leader | `leaderId` known in new epoch |
| Detached | Follower | Promoted to voter | Node gains voting right |
| Any | Unattached | Higher epoch learned (no leader known) | `m.epoch > currentEpoch` |

### 4.2 Pre-Vote Protocol (KIP-996)

*Reference: Source [6]*

Pre-Vote prevents disruptive servers (those that are partitioned or have stale logs) from forcing unnecessary elections.

**Protocol:**

1. **Before becoming Candidate**, a server first enters Prospective state and sends Pre-Vote requests.
2. **Pre-Vote Request:** `{lastOffset: Long, lastEpoch: Int}` — the prospective candidate advertises its log position.
3. **Pre-Vote Response:** `{granted: Bool}` — a server grants Pre-Vote only if:
   - The prospective candidate's log is at least as up-to-date as the responder's
   - The responder has not heard from a valid leader recently (within election timeout)
4. **Transition to Candidate:** Only after receiving a quorum of Pre-Vote grants AND the grace period expires.

**Why Pre-Vote matters for verification:**
- Prevents a partitioned node with a stale term from disrupting the cluster
- The invariant is: a node only enters Candidate state if it could potentially win an election
- This eliminates a class of livelock scenarios where nodes continuously force elections they can't win

### 4.3 Resignation Protocol

*Reference: Source [8], [9]*

A KRaft leader can gracefully resign (step down) without crashing. This is not in vanilla Raft.

**Resign process:**
1. Leader transitions to Resigned state
2. Stops accepting new client writes
3. Continues to serve in-flight AppendEntries responses
4. Other nodes see an election timeout and start a new election
5. Resigned leader may learn about the new leader and transition to Follower

**Verification concern:** During the resign window, the old leader's committed entries are still valid, but no new entries can be committed. This is a liveness property (eventually a new leader is elected), not a safety concern.

---

## 5. Safety Invariants

*References: Sources [1], [2], [3]*

These are the invariants we need to prove in SpeckDL/Z3.

### 5.1 Raft Paper Invariants (vanilla Raft)

**I1: Election Safety.** At most one leader per term.
```
∀ i, j ∈ Server:
  state[i] = Leader ∧ state[j] = Leader ∧ currentTerm[i] = currentTerm[j] → i = j
```

**I2: Leader Completeness.** If a log entry is committed in term T, then all leaders for terms > T have that entry.
```
This is the core invariant. Proved via the "Leader Completeness Property" in the Raft paper.
Inductive argument: a new leader must have all committed entries from prior terms 
because it received votes from a quorum that overlaps with the quorum that committed 
those entries.
```

**I3: Log Matching.** If two entries in different logs have the same index and term, then all preceding entries are identical.
```
∀ i, j ∈ Server, idx:
  log[i][idx].term = log[j][idx].term → log[i][1..idx] = log[j][1..idx]
```

**I4: Leader Append-Only.** A leader never overwrites or deletes entries in its log.
```
∀ i: state[i] = Leader → log[i] only grows (entries appended, never removed)
```

**I5: Term Monotonicity.** Current term never decreases.
```
∀ i: currentTerm'[i] ≥ currentTerm[i]
```

**I6: Commit Safety.** An entry is committed only if a quorum has replicated it.
```
commitIndex[i] advances only when a quorum of matchIndex[i][k] ≥ N
Additionally: only entries from the current term can be committed via leader
advance (restriction from Raft paper Figure 8).
```

### 5.2 KRaft-Specific Invariants

**K1: Quorum Overlap.** Any two quorums in the same epoch share at least one voter.
```
∀ Q1, Q2 ∈ Quorum: Q1 ∩ Q2 ≠ ∅
```

**K2: High Watermark Monotonicity.** A node's highWatermark never decreases.
```
∀ i: highWatermark'[i] ≥ highWatermark[i]
```

**K3: High Watermark Validity.** A node's highWatermark is always ≤ the log end offset.
```
∀ i: highWatermark[i] ≤ logEndOffset[i]
```

**K4: Observer Consistency.** An observer's log is a prefix of some voter's log that was committed.
```
∀ observer o, voter v, offset idx:
  o.hasOffset(idx) → ∃v ∈ Voters: v.committed(idx) ∧ o.log[1..idx] = v.log[1..idx]
```

**K5: Leader Uniqueness (KRaft).** At most one leader per epoch across all nodes.
```
∀ i, j ∈ Replicas: 
  state[i] = Leader ∧ state[j] = Leader ∧ epoch[i] = epoch[j] → i = j
```

**K6: Vote Uniqueness.** A voter votes for at most one candidate per epoch.
```
∀ i ∈ Voters, epoch e: votedFor[i][e] is either Nil or a single replica ID
```

---

## 6. Snapshots (KIP-630)

*Reference: Source [5]*

KRaft supports snapshot-based log compaction for the metadata log.

### 6.1 Snapshot Mechanics

- **Snapshot trigger:** When the log grows beyond a configured threshold
- **Snapshot contents:** Full metadata state at a given offset (topic configs, partition assignments, etc.)
- **Snapshot delivery:** Leader sends snapshots to followers that are lagging (similar to Raft's InstallSnapshot)

### 6.2 State Changes for Snapshots

| Variable | Type | Description |
|----------|------|-------------|
| `snapshotId` | {epoch: Int, endOffset: Long} | Identifies a snapshot by epoch and end offset |
| `lastSnapshotOffset` | Long | Offset of the last snapshot on this node |
| `recoveryState` | Enum | {RECOVERING, COMPLETE} — whether snapshot recovery is in progress |

### 6.3 Invariants for Snapshots

**S1: Snapshot Offset Monotonicity.** Snapshot offsets increase monotonically.
```
snapshotId.endOffset[i]' ≥ snapshotId.endOffset[i]
```

**S2: Snapshot Consistency.** A snapshot at offset N contains all entries committed before N.
```
∀ i, snapshot at offset N: 
  snapshot.epoch = log[N].term ∧ snapshot contains all committed entries up to N
```

---

## 7. Known Verification Gaps and Bugs

*References: Smart Casual Verification blog, raft-dev Google Group, Source [6]*

### 7.1 Known Bugs in Raft Implementations

**Bug 1: Single-Server Membership Change Safety Bug (2015)**
- **Source:** raft-dev Google Group, reported by Ongaro
- **Issue:** The original Raft paper's algorithm for single-server membership changes has a safety bug. If two configuration changes overlap, the cluster can lose quorum overlap.
- **Mitigation:** Joint consensus (adding then removing in separate steps) is safe. KRaft uses joint consensus for membership changes (KIP-853).
- **Formal verification target:** Prove that KRaft's joint consensus approach maintains quorum overlap during membership changes.

**Bug 2: Stale Leader Committing Old-Term Entries (Figure 8 Bug)**
- **Source:** Raft paper, Figure 8
- **Issue:** A leader must not commit entries from previous terms directly. It can only commit entries from its current term, and previous-term entries are committed indirectly when the current-term entry is committed.
- **Status:** Correctly handled in KRaft (AdvanceCommitIndex only advances for current-term entries).
- **Formal verification target:** Prove that `AdvanceCommitIndex` only advances `commitIndex` when the entry at the target index has `term == currentTerm`.

**Bug 3: Log Truncation During Leader Change**
- **Source:** Common implementation bug across multiple Raft implementations
- **Issue:** When a new leader overwrites conflicting entries on a follower, the truncation must be atomic. If the node crashes mid-truncation, the log can be left in an inconsistent state.
- **Status:** KRaft handles this by truncating before appending, but edge cases around partial truncation exist.
- **Formal verification target:** Prove that log truncation is atomic (either fully applied or not at all).

**Bug 4: Disruptive Servers (Pre-Vote Target)**
- **Source:** KIP-996, Ongaro dissertation §9.6
- **Issue:** A server that is partitioned or has a stale network connection can repeatedly force elections, disrupting the cluster. Without Pre-Vote, a partitioned server increments its term and forces elections it can't win.
- **Status:** KIP-996 (Pre-Vote) addresses this by requiring a server to confirm it can win before starting an election.
- **Formal verification target:** Prove that with Pre-Vote, a node that cannot win an election never transitions to Candidate state.

### 7.2 Smart Casual Verification Findings

*Reference: Decentralized Thoughts blog, "Smart Casual Verification"*

In a systematic review of consensus protocol implementations, researchers found:

1. **5 safety bugs** — violations of agreement or integrity properties
2. **1 liveness bug** — violation of termination under expected conditions
3. All bugs were found through informal reasoning about protocol invariants, not formal proof
4. Key pattern: most bugs occur in edge cases around term changes and log conflicts

### 7.3 Open Verification Targets

These are properties that should be verified in the SpeckDL/Z3 spec:

1. **Election safety under network partitions:** Prove I1 (election safety) holds even during partitions.
2. **Log matching after truncation:** Prove I3 (log matching) holds after follower log truncation.
3. **Leader completeness after Pre-Vote:** Prove I2 (leader completeness) holds with the Pre-Vote extension.
4. **High watermark advancement:** Prove that `highWatermark` only advances when a quorum has replicated.
5. **Graceful resignation liveness:** Prove that after a leader resigns, a new leader is eventually elected (liveness, assuming fair loss and eventual delivery).
6. **Observer divergence:** Prove that observers cannot diverge from voters (K4).
7. **Joint consensus safety (KIP-853):** Prove that during membership changes, quorum overlap is maintained.

---

## 8. Producer Acknowledgement Semantics (for M1.3)

*Deferred — included here for reference only.*

### acks=0 (Fire and forget)
- Producer sends and doesn't wait for response
- No durability guarantee
- Invariant: **None** (messages can be lost)

### acks=1 (Leader acknowledgment)
- Producer waits for leader to write to local log
- Durability: survives leader failure, but NOT follower failure
- Invariant: **If ack received, entry exists in leader's log**

### acks=all (ISR acknowledgment)
- Producer waits for all in-sync replicas (ISR) to acknowledge
- Durability: survives any failure that leaves a quorum
- Invariant: **If ack received, entry is committed (quorum has replicated)**

### Exactly-once Semantics
- Requires idempotent producer + transaction coordinator
- Idempotent producer: assigns sequence numbers; broker deduplicates
- Transaction coordinator: two-phase commit across partitions

### Key Invariants for Producer Acks

1. `acks=all` → no data loss on leader failover (bounded to quorum availability)
2. Idempotent producer → no duplicate messages for same PID + sequence number
3. Transaction atomicity → all partitions in a transaction commit or none do

---

## 9. Consumer Group Rebalancing (for M1.3)

*Deferred — included here for reference only.*

### States
- Empty → Joining → Stable → Rebalancing → Stable

### Actions
- JoinGroup: consumer requests to join
- SyncGroup: consumer receives assignment
- Heartbeat: consumer indicates liveness
- LeaveGroup: consumer departs
- Rebalance: triggered by membership change or topic partition change

### Invariants
1. No concurrent assignments to the same partition
2. All partitions assigned when group is stable
3. Offset monotonicity: committed offsets never decrease
4. No two consumers assigned the same partition simultaneously

---

## 10. KIPs Reference

| KIP | Title | Status | Relevance |
|-----|-------|--------|-----------|
| KIP-500 | Next Generation Client Protocol | Adopted | Foundation for KRaft |
| KIP-595 | A Raft Protocol for the Metadata Quorum | Adopted | Core KRaft protocol design |
| KIP-630 | Kafka Raft Snapshot | Adopted | Snapshot/compaction for metadata log |
| KIP-642 | Dynamic Configuration in KRaft | Adopted | Dynamic config updates via KRaft |
| KIP-853 | KRaft Controller Membership Changes | Implemented | Joint consensus for membership changes |
| KIP-996 | Pre-Vote for KRaft | Implementing | Pre-Vote phase to prevent disruptive elections |
| KIP-830 | KRaft Metadata Quorum | Adopted | Metadata quorum implementation details |

---

## Appendix A: Message Types (KRaft)

### Internal KRaft RPC Messages

| Message | Direction | Fields |
|---------|-----------|--------|
| `VoteRequest` | Candidate → Voter | `candidateId`, `epoch`, `lastOffset`, `lastEpoch` |
| `VoteResponse` | Voter → Candidate | `epoch`, `voteGranted`, `leaderId` |
| `BeginQuorumEpoch` | Leader → Follower | `leaderId`, `epoch` |
| `EndQuorumEpoch` | Leader → Voter (resign) | `leaderId`, `epoch` |
| `FetchSnapshot` | Follower → Leader | `snapshotId`, `offset` |
| `Fetch` | Follower → Leader | `followerId`, `epoch`, `lastFetchedEpoch`, `lastFetchedOffset`, `maxBytes` |
| `FetchResponse` | Leader → Follower | `epoch`, `leaderId`, `highWatermark`, `records` |

*Note: KRaft uses `BeginQuorumEpoch` as the heartbeat mechanism (instead of vanilla Raft's empty AppendEntries).*

---

## Appendix B: Key Differences from Vanilla Raft

| Aspect | Vanilla Raft | KRaft |
|--------|-------------|-------|
| Term naming | "Term" | "Epoch" (functionally equivalent) |
| Heartbeat | Empty AppendEntries | BeginQuorumEpoch |
| Resignation | Not specified | EndQuorumEpoch (graceful shutdown) |
| Pre-Vote | Not in original paper | ProspectiveState (KIP-996) |
| States | Follower, Candidate, Leader | + Unattached, Prospective, Resigned, Detached |
| Snapshot | InstallSnapshot | FetchSnapshot (KIP-630) |
| Membership | Single-server or joint | Joint consensus only (KIP-853) |
| Log content | Arbitrary client values | Metadata records (topic configs, partition assignments) |
| Quorum | All servers vote | Voters vote, observers replicate |
| Client ID | Not specified | Replica ID (localId) |

---

*Document compiled from: Raft TLA+ spec (Ongaro 2014), Apache Kafka source code (`kafka/raft/`), KIP-595/630/642/853/996, Red Hat KRaft deep dive, Smart Casual Verification findings.*