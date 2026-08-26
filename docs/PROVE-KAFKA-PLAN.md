# Prove Kafka — Project Plan

> *Don't replace Kafka. Prove it. Then prove everything else.*

---

## Objective

Specify Apache Kafka's KRaft consensus protocol in SpeckDL, verify its safety invariants with Z3, and publish the findings. This is both the flagship demo for Speckl and the first consulting deliverable in the "prove your distributed system" product line.

---

## Guiding Principle

Dependencies only. No wall-time estimates. Each milestone lists what must be true before it can start.

---

## Phase 0 — Compiler Foundation

The compiler must be able to accept real specs and produce verified artifacts. Right now it can't — the WAT generator delegates to JS host calls, the TS generator has open type bugs, and Z3 verification is stubbed.

### M0.1 — TypeScript Reference Backend (Clean Build) ✅ DONE

**Target:** `speckl compile` produces idiomatic, runnable TypeScript from any `.speck` file. All 12 examples compile and pass generated tests.

**Dependencies:** None (starts now)

**Deliverables:** ✅
- ✅ Fix engineering#9 (spurious `this.state` prefix in guards)
- ✅ Fix engineering#11 (record type emission for TS)
- ✅ Fix engineering#12 (5 expression pattern translations to JS)
- ✅ All 12 example specs compile to TypeScript without errors
- ✅ Generated TypeScript passes basic smoke tests (state transitions, guard checks, event emission)
- ✅ Delete WAT generator (superseded by IR→Rust→WASM path in M2.1)

**Completed:** 2026-05-10. Branch `fix/ts-generator-bugs`, `fix/remove-wat-generator`. All 41 tests passing.

---

### M0.2 — Typed Intermediate Representation ✅ DONE

**Target:** Compiler produces a typed IR between AST and backend generators. No generator duplicates type logic or parses raw AST.

**Dependencies:** M0.1 complete

**Deliverables:** ✅
- ✅ Define IR schema: `SpeckIR` with typed state, actions, invariants, events, provenance annotations
- ✅ Full pipeline: Parse → AST → TypeCheck → SpeckIR → Optimize → Backend Selection
- ✅ 4 optimization passes: guard elision, dead state elimination, transition tables, invariant hoisting
- ✅ 5-phase incremental migration plan (each generator migrates one at a time)
- ✅ Z3 translation mapping (SpeckDL → SMT-LIB sorts, assertions, BMC unrolling)
- ✅ Provenance annotations (SourceSpan → IR node → artifact)

**Completed:** 2026-05-10. Branch `feat/ir-design-speckl-20`. 1,106-line design doc at `docs/ir-design.md`. Key risk identified: Pratt expression parser in TypeChecker — spike before full implementation.

---

### M0.3 — Z3 Verification Backend ✅ DONE

**Target:** `speckl verify` compiles `invariant` and `verify` blocks to Z3 SMT-LIB assertions and reports satisfiability.

**Dependencies:** M0.2 complete

**Deliverables:** ✅
- ✅ Z3 backend: translate `state` to sort declarations, `invariant` to define-fun assertions, `verify` to BMC unrolling
- ✅ `--target=z3` CLI option produces valid SMT-LIB2 that Z3 accepts
- ✅ `--verify-depth=N` configurable bounded model checking
- ✅ Zero errors on all specs (ToggleSwitch, TigerBeetleLedger, KafkaKRaft)
- ✅ Clean `sat` with model output from Z3
- ✅ BMC verify blocks in KRaft spec (3 invariants, depth 5)

**Completed:** 2026-05-10. Z3 backend: `compiler/src/generators/z3.ts` (1,037 lines). Z3 4.15.4 verified working.

---

## Phase 1 — Kafka KRaft Specification

The core deliverable: a complete, verified specification of Kafka's KRaft consensus protocol in SpeckDL.

### M1.1 — KRaft State Machine Specification ✅ RESEARCH DONE

**Target:** Kafka KRaft consensus protocol specified in SpeckDL. Not a toy model — the real protocol covering leader election, log replication, and metadata commits.

**Dependencies:** M0.3 complete (need Z3 verification to validate the spec)

**Research deliverables:** ✅
- ✅ `docs/kraft-protocol-reference.md` — complete Raft TLA+ state machine reference with 10 actions, 6 safety invariants, KRaft extensions, producer ack semantics, and scope boundary
- ✅ All state variables with types, all transitions with preconditions
- ✅ Source citations for each element

**Remaining:** Write the actual `examples/KafkaKRaft.speck` spec (M1.2 dependency on Z3 backend M0.3, but spec can be written now)

---

### M1.2 — KRaft Verification Results ✅ BMC VERIFICATION RUNNING

**Target:** Z3 verification of KRaft invariants, with documented findings.

**Dependencies:** M1.1 complete

**Deliverables:** ✅
- ✅ `examples/KafkaKRaft.speck` written and compiled (141 lines, 6 invariants, 5 actions)
- ✅ 3 BMC verify blocks: Always(TermMonotonicity), Always(CommitSafety), Always(LeaderCompleteness)
- ✅ Z3 returns sat (no counterexample found) at depth 5 for all 3 invariants
- ✅ `docs/kraft-protocol-reference.md` — complete source documentation

**Remaining:** Run at deeper depths, document formal conclusions, fill blog findings section

---

### M1.3 — KRaft Producer Acks & Consumer Groups

**Target:** Extend the KRaft spec to cover producer acknowledgement semantics and consumer group coordination — the parts that actually cause production incidents.

**Dependencies:** M1.2 complete

**Deliverables:**
- `examples/KafkaProducer.speck` — producer ack levels (0=fire and forget, 1=leader ack, all=ISR ack), idempotent producer state, transaction coordinator
- `examples/KafkaConsumerGroup.speck` — consumer group state machine (join, sync, rebalance, heartbeat, leave), offset commit semantics, partition assignment
- Invariants: exactly-once delivery (with constraints), no data loss on leader failover, offset monotonicity
- Verification results for each

**Exit criteria:** Both specs compile and verify. Producer ack invariant proves that `acks=all` prevents data loss on leader failure (bounded). Consumer group rebalance is modeled and verified for safety (no concurrent assignments to same partition).

---

## Phase 2 — Rust Backend

The Rust backend is the path to production-runnable verified code and WASM as a byproduct.

### M2.1 — Rust Code Generation

**Target:** `speckl compile --target=rust` produces idiomatic Rust from SpeckDL IR.

**Dependencies:** M0.2 complete (consumes IR, not AST)

**Deliverables:**
- Rust backend: enums for state, structs for records, match-based dispatch for actions, guard functions for `require` blocks
- Generated Rust compiles with `cargo check` without warnings
- `wasm-pack build` produces a WASM module from the Rust output
- Map/Set types compile to appropriate Rust collections (HashMap, HashSet) with no host imports
- Provenance annotations become Rust doc comments tracing each generated line to its spec source

**Exit criteria:** `speckl compile examples/TigerBeetleLedger.speck --target=rust` produces Rust that compiles and passes basic state machine tests. `wasm-pack build` on the output produces a valid `.wasm` module.

---

### M2.2 — KRaft Reference Implementation in Rust

**Target:** Compile `KafkaKRaft.speck` to Rust, run the generated code, demonstrate it matches the spec's invariants at runtime.

**Dependencies:** M1.1 complete (need the spec), M2.1 complete (need the backend)

**Deliverables:**
- `speckl compile examples/KafkaKRaft.speck --target=rust` produces a runnable Rust module
- Runtime guard checks fire and prevent invariant violations
- Provenance trace: each Rust function has a doc comment pointing to the source `.speck` line
- Performance benchmarks: state transition throughput for generated Rust vs handwritten equivalent

**Exit criteria:** Generated KRaft Rust module compiles, runs, and enforces all invariants from the spec. Benchmark shows generated code within 2x of hand-optimized Rust for state transitions.

---

## Phase 3 — Publish & Market

The spec and verification results become marketing assets.

### M3.1 — Blog Post: "We Formally Verified Kafka's Consensus" ✅ DRAFT DONE

**Target:** Long-form technical blog post documenting the KRaft specification and verification findings.

**Dependencies:** M1.2 complete (need results), M0.3 complete (need Z3 to explain)

**Deliverables:** ✅
- ✅ `docs/blog-06-prove-kafka.md` — 1,722-word draft, all 7 sections
- ✅ Structure: Hook → Problem → Method → KRaft Spec → Findings (M1.2 placeholder) → Implications → CTA
- ✅ Written in Scott's voice (semicolons, no em dashes, evidence over assertion)

**Remaining:** Fill M1.2 verification results into findings section, then publish

---

### M3.2 — Show HN Launch

**Target:** Speckl launches on Hacker News with a compelling demo.

**Dependencies:** M0.3 complete (Z3 verification works), M1.2 complete (KRaft results), M3.1 published (blog post is the landing target)

**Deliverables:**
- Speckl landing page updated with: live KRaft spec, verification results, "Try it" playground
- Show HN post with: "Speckl: A specification language that compiles to verified code — we proved Kafka's consensus"
- Comment playbook: prepared answers for "how is this different from TLA+/P/Alloy", "what about real-world complexity", "why not just write tests"
- Playground: browser-based SpeckDL editor → TypeScript output + Z3 verification results (can be mocked initially)

**Exit criteria:** Show HN post live. Landing page live. Playground functional enough for visitors to type a spec and see output.

---

### M3.3 — Consulting One-Pager: "Prove Your Distributed System"

**Target:** Sales asset for Phase B consulting engagements.

**Dependencies:** M1.2 complete (KRaft results are the proof case), M3.1 published (blog post is the credibility anchor)

**Deliverables:**
- PDF one-pager: "We formally verify your distributed system's invariants. Here's what we proved about Kafka."
- Pricing tiers: Audit ($15K — specify + verify one subsystem), Verify ($30K — specify + verify + reference implementation), Embed ($50K+ — ongoing specification partnership)
- Case study: KRaft verification results as proof point
- Target companies: Chainguard, Anchore, VC portfolio companies running Kafka at scale

**Exit criteria:** One-pager PDF ready to send. Blog post is live and linkable.

---

## Phase 4 — Expand the Proof Catalog

Once Kafka is proven, extend to other high-value targets.

### M4.1 — Raft Specification (etcd/Consul)

**Target:** Specify and verify the Raft consensus algorithm (the protocol behind etcd, Consul, CockroachDB, TiKV).

**Dependencies:** M1.2 complete (proven methodology), M0.3 complete (Z3 verification)

**Deliverables:**
- `examples/Raft.speck` updated to full Raft spec (not the current toy example)
- Verification results: leader election safety, log matching, commit safety
- Comparison: "What Raft proves vs what KRaft adds"

**Exit criteria:** Full Raft spec compiles and verifies. Written analysis comparing Raft vs KRaft verification results.

---

### M4.2 — TigerBeetle Ledger Deep Verification

**Target:** Extend the existing TigerBeetle spec to full verification, including the two-phase commit and overdraft protection invariants that TigerBeetle is famous for.

**Dependencies:** M0.3 complete, M2.1 complete (Rust backend for performance comparison)

**Deliverables:**
- `examples/TigerBeetleLedger.speck` extended with: two-phase commit, balance invariants, transfer idempotency
- Z3 verification of "no account goes negative" invariant under all failure modes
- Rust compilation + benchmark vs TigerBeetle's reference implementation
- Blog post: "We proved TigerBeetle's invariants with Speckl — and found [X]"

**Exit criteria:** Full TigerBeetle spec passes Z3 verification. Performance comparison documented. Blog post drafted.

---

### M4.3 — OAuth 2.0 / OIDC Flow Specification ✅ DONE

**Target:** Specify the OAuth 2.0 authorization code flow (including PKCE) as a state machine and verify its invariants.

**Dependencies:** M0.3 complete

**Deliverables:** ✅
- ✅ `examples/OAuth2AuthorizationCode.speck` — 6 actions, 7 invariants, PKCE modeled
- ✅ Invariants: NoTokenLeakage, StateCSRFProtection, AuthorizationCodeSingleUse, TokenValidityBounded, PKCECodeInterceptionPrevention, RedirectUriConsistency, ClientAuthenticationRequired
- Remaining: Z3 verification (depends on M0.3)

**Completed:** 2026-05-10. Branch `feature/oauth2-spec`.

---

## Dependency Graph

```
M0.1 (TS Backend Clean)
  └──→ M0.2 (Typed IR)
         └──→ M0.3 (Z3 Backend)
                ├──→ M1.1 (KRaft Spec)
                │      └──→ M1.2 (KRaft Verification)
                │             ├──→ M1.3 (Producer/Consumer)
                │             └──→ M3.1 (Blog Post)
                │                    ├──→ M3.2 (Show HN)
                │                    └──→ M3.3 (Consulting One-Pager)
                ├──→ M4.1 (Raft)
                └──→ M4.3 (OAuth 2.0)

M0.2 ──→ M2.1 (Rust Backend)
           └──→ M2.2 (KRaft Rust Reference)
                  └──→ M4.2 (TigerBeetle Deep)

M1.2 ──→ M4.1, M4.2, M4.3
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| KRaft spec lines | ≤ 300 lines of SpeckDL |
| Invariants verified | ≥ 8 (leader election, log matching, commit safety, etc.) |
| Gaps/vulnerabilities found | ≥ 1 (a gap is worth more than a proof) |
| Z3 verification depth | 20 transitions for core invariants |
| Rust backend performance | Within 2x of hand-optimized for state transitions |
| Show HN upvotes | ≥ 200 |
| Consulting inquiries from blog | ≥ 5 |
| Proof catalog entries | 4 (KRaft, Raft, TigerBeetle, OAuth) |

---

## Issue Tracking

Each milestone has an atomic Forgejo issue (one-shot, agent-friendly):

| Milestone | Issue |
|-----------|-------|
| M0.1: TS bugs | #18 |
| M0.1: Delete WAT | #19 |
| M0.2: Typed IR | #20 |
| M0.3: Z3 backend | #21 |
| M1.1: KRaft spec | #22 |
| M1.2: KRaft verify | #23 |
| M1.3: Producer/Consumer | #24 |
| M2.1: Rust backend | #25 |
| M2.2: KRaft Rust ref | #26 |
| M3.1: Blog post | #27 |
| M3.2: Show HN | #28 |
| M3.3: Consulting PDF | #29 |
| M4.1: Raft spec | #30 |
| M4.2: TigerBeetle | #31 |
| M4.3: OAuth 2.0 | #32 |

Epic #17 closed — superseded by #18–#32.

## Open Items

- **Z3 depth vs. completeness:** Bounded model checking at depth 20 is not exhaustive. Need a strategy for "verified up to N transitions" vs. "verified for all transitions." Document this honestly.
- **KRaft spec scope:** Kafka's KRaft is ~15K lines of Java. The SpeckDL spec must cover the consensus core, not the full broker. Need a clear scope boundary.
- **Show HN timing:** Coordinate with M3.1 publication. Don't launch the HN post until the blog post and playground are live.
- **Consulting pricing:** The one-pager has draft tiers ($15K/$30K/$50K+). Scott needs to review and approve before any outreach.