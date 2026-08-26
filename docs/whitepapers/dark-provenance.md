# Dark Provenance: Tracing Intent in AI-Augmented Development

**Whitepaper — Speckl by Greybeard Holdings**
*Scott Scoble | speckl.dev (forthcoming) | arXiv submission pending*

---

## Outline

### 1. The Problem
When AI agents generate code, who owns the intent? Traditional traceability breaks down when authorship is distributed across human decisions and LLM outputs.

### 2. What Is Dark Provenance
A methodology where every behavior in a system is traced back to its original source — an academic paper, a design decision, a regulatory requirement, a human conversation. The "dark" means you don't think about it until you need it, but the graph is always there.

### 3. The Speckl Approach
Specification-first development with formal verification boundaries. How Speckl implements dark provenance through the SpeckDL language, Z3 compilation, and the tiered agent harness.

### 4. Semantic Preservation and SA-11 (RTCA DO-178C)
The key insight: if the Speck-to-WASM compilation preserves semantics, then human review at the Speck boundary satisfies assurance requirements without needing to review every line of generated code.

### 5. Implications for AI-Augmented Development
Dark provenance makes AI-generated code auditable. Without it, LLM outputs in regulated environments are unacceptable. With it, we unlock a future where agents generate the majority of production code without sacrificing accountability.

### 6. Call to Action
Join the Speckl community. Adopt specification-first. Make provenance a first-class artifact.

---

## Section 1: The Problem

Software traceability has a dirty secret: it was already broken before AI showed up.

Requirements documents, design specs, pull requests, issue tickets, Slack conversations — the "paper trail" of a modern codebase is scattered across a dozen tools, most of which don't talk to each other. Every senior engineer has lived the nightmare of tracing a production bug back through three Jira tickets, a stale Notion doc, and a year-old Slack thread that ends with "actually let's go with option B" and nothing else.

In practice, the real provenance of software has always been oral tradition. Ask any team: "Why does this function exist?" The answer is usually someone squinting at a diff from 14 months ago and saying, "I think Sarah was dealing with a race condition?" That's not traceability. That's folklore.

**AI makes this crisis existential.**

When you add LLM-generated code to the mix, the traditional traceability model doesn't just break — it becomes incoherent. Consider what happens in a typical AI-assisted workflow today:

1. A developer pastes a prompt into an IDE: "Write a retry handler with exponential backoff for the payment gateway, max 3 retries."
2. The LLM returns 40 lines of TypeScript.
3. The developer reads it, nods, and accepts it.
4. Six months later, an auditor asks: "Who decided on 3 retries? Where is the design decision documented?"

The honest answer is: *nobody knows*. The developer provided the intent, the LLM filled in the specifics, and neither party has a clean claim to "authorship." The decision about retry count — was it the developer's instinct, a pattern the LLM learned from training data, some unarticulated expectation in the prompt, or a bug? We have no way to tell.

This is not a corner case. As LLMs move from autocomplete assistants to autonomous coding agents generating entire functions, services, and systems, the provenance problem moves from "occasionally frustrating" to "systemically disqualifying."

**Regulated environments already feel the pain.**

Organizations operating under DO-178C, ISO 26262, FDA 21 CFR Part 820, SOC 2, or FedRAMP require demonstrable traceability from requirements through code. Today's compliance strategies treat LLM outputs the same way they treat code from a freshly-hired junior developer: subject it to the same review, testing, and documentation processes. This works when AI generates 10% of the codebase. When it generates 70%? The review pipeline collapses.

More fundamentally, these standards assume a human author who can be questioned about intent. An LLM has no intent. It has no memory of why it chose one approach over another. It has a probability distribution over tokens and a fleeting context window. When the auditor asks "why," the machine has nothing to say.

**The false promise of "just document it."**

A common reaction is: "Just have the AI generate documentation alongside the code." This sounds reasonable until you think about it for thirty seconds. If the AI generated the code and the AI generated the docs, you've created a closed loop. The documentation describes what the code does — it cannot explain *why the code should exist in the first place*. That "why" lives in the spec, the requirement, the conversation. The AI was never in that room.

**The real problem is structural.**

Traceability requires a chain of custody for intent: Requirement → Design Decision → Specification → Implementation → Verification. Each link requires a human decision point where intent is *formally captured*. LLMs don't participate in this chain — they short-circuit it. They go from a natural language prompt directly to code, skipping every intermediate artifact that traceability depends on.

This is not about LLMs being "unreliable" or "hallucinating." It's about a structural gap in how we create software. The gap existed before AI — AI just made it impossible to ignore.

What we need is not better guardrails on LLM output. What we need is a methodology where intent is captured *before* code generation, in a form that machines can verify and humans can audit. We need a way to answer "why does this code exist?" without relying on oral tradition, stale Slack threads, or asking an LLM to guess.

We need dark provenance.

---

## Section 2: What Is Dark Provenance

Dark provenance is a methodology for software development where every behavior in a system — every function, every branch, every side effect — is traced back to its original source of intent. That source might be an academic paper describing an algorithm, a regulatory clause in DO-178C Annex A, a design decision captured in an architecture review, or a human conversation where a product owner said "we need this."

The word "dark" does not mean hidden or malicious. It means *ambient*. Like dark matter, it's always present, shaping the structure of the system, but you don't observe it directly until you go looking. The provenance graph exists from the moment a specification is written; it grows as the system is implemented; and it can be materialized on demand — for an audit, for a compliance report, or for a developer who asks "why is this here?"

**How it differs from traditional traceability.**

Conventional traceability links requirements to code through a chain of documents: requirement → design spec → code module → test case. This works when the chain is hand-maintained and all artifacts are human-authored. It breaks when LLMs generate code that bypasses the document chain.

Dark provenance inverts the model. Instead of *forward-tracing* from documents to code, it *backward-traces* from every runtime behavior to the specification that motivated it. The specification is the primary artifact — not the code. Code is a derived artifact, generated (or verified) against the spec.

This creates a fundamental asymmetry that works in our favor: specifications are small, human-readable, and stable. Code is large, machine-generated or machine-verified, and frequently regenerated. By anchoring provenance to the spec, we make the audit surface tractable regardless of how much code the system contains.

**The provenance graph.**

A dark provenance system maintains a directed graph where:

- **Nodes** are sources of intent: specifications, regulatory requirements, design decisions, constraints, verification results.
- **Edges** are derivation relationships: "spec A was decomposed into sub-specs B and C," "code module X was generated from spec A," "test case T verifies constraint K from spec A."
- **Each edge carries metadata:** who created it, when, what tool was used, what verification was performed.

The graph is *incremental*. It grows as the system evolves. It is *queryable*: "Show me every behavior derived from DO-178C section 6.3" is a graph traversal, not a manual search through Jira.

**Why "dark" matters.**

The key design decision is that the provenance graph is maintained *automatically* by the toolchain. Developers don't write provenance metadata by hand. The specification language (SpeckDL) encodes intent directly. The compilation pipeline records derivation edges automatically. The agent harness tags generated code with its source spec.

This means developers work with specifications, not with traceability documents. The provenance is dark — it accumulates behind the scenes. It becomes visible only when someone needs it: an auditor, a compliance officer, or a developer debugging a production incident.

**The analogy to financial accounting.**

Think of it like double-entry bookkeeping. Every financial transaction creates two entries that must balance. The system doesn't prevent fraud, but it makes fraud *detectable* and *traceable*. Dark provenance does the same for software intent. Every behavior must have a source. The system doesn't prevent bugs, but it makes every behavior's origin *traceable*.

No one argues that double-entry bookkeeping is too much overhead for a startup. It's just how accounting works. Dark provenance should be just how software development works — especially when AI agents are writing the code.

---

## Section 3: The Speckl Approach

Speckl implements dark provenance through three interlocking mechanisms: a specification language (SpeckDL), a formal verification pipeline, and a tiered agent architecture.

**SpeckDL: The specification language.**

SpeckDL is a domain-specific language for defining system behavior and interfaces. A SpeckDL specification (a "Speck") describes *what* a system should do, not *how* it should do it. Key constructs include:

- **Speck definitions:** Named behavioral units with typed inputs, outputs, and constraints.
- **Interfaces:** Contracts between Specks — what one Speck expects from another.
- **Constraints:** Invariants, preconditions, postconditions, and temporal properties expressed in a form compilable to Z3 (an SMT solver).
- **Verification boundaries:** Explicit markers indicating where human review is required versus where automated verification suffices.

A Speck is intentionally small — typically 20-80 lines. It captures a single behavioral unit at a level of abstraction that humans can read and reason about directly. Here is a simplified example:

```
speck RetryHandler {
  input: { operation: Operation, maxRetries: Nat }
  output: Result
  constraint: maxRetries <= 5
  constraint: backoff(delay(n)) == delay(n-1) * 2
  constraint: totalDelay < 30s
  verify: always(implies(attempt > 1, delay > 0))
}
```

This Speck says: the retry handler takes an operation and a maximum retry count; retries may not exceed 5; delay doubles on each retry; total delay is bounded to 30 seconds; and the verifier must prove that every retry after the first has a positive delay. The implementation — the code that satisfies these constraints — is a derived artifact.

**The verification pipeline.**

SpeckDL compiles through a deterministic pipeline:

1. **SpeckDL → Z3:** Constraints and verification conditions are compiled into SMT-LIB format for the Z3 solver. If Z3 reports UNSAT, the Speck contains contradictory constraints — it's impossible to implement correctly.
2. **Z3 → DST (Decision Structures):** Z3's model is compiled into DSTs — deterministic decision trees that map inputs to verified outputs. DSTs represent the complete behavioral space of a verified Speck.
3. **DST → WASM:** DSTs compile to WebAssembly, producing an executable artifact that is *provably correct by construction* — it implements exactly the behaviors the Speck specifies, no more and no less.

This pipeline is deterministic. Given the same Speck, the same Z3 version, and the same compilation flags, it produces the same output. There is no non-determinism, no hallucination, no model variance. This property is essential for auditability.

**The tiered agent harness.**

Not all code can be generated from verified Specks. Real systems include glue code, integrations, UIs, and infrastructure that don't warrant formal specification. For these, Speckl provides a tiered agent architecture:

- **Orchestrator:** The client entry point. Accepts a Speck (or a natural language request), decomposes it into verification tasks, and assigns them to Team Leads.
- **Team Leads:** Manage specialized agents. A Team Lead for verification tasks routes Specks to the Z3 pipeline. A Team Lead for code generation routes verified DSTs to codegen agents. A Team Lead for integration routes glue-code tasks to appropriate SMEs.
- **SMEs (Subject Matter Experts):** Hyper-specialized single-task agents. A verification SME runs Z3. A codegen SME produces TypeScript or Rust from a DST. A documentation SME produces human-readable docs from the provenance graph.

Teams self-replicate: if a Team Lead's queue is saturated, it can request the Orchestrator to spawn another Team Lead of the same type. This gives the system elastic scaling without human intervention.

**TillDone: Condition-based task tracking.**

Traditional task trackers use status fields: "to do," "in progress," "done." Speckl replaces this with TillDone, a condition-based model. A task is not "done" when someone moves a card. A task is done when a *provable condition* is met: Z3 returns SAT, all generated code passes the test suite, the provenance graph is complete for this Speck.

This eliminates the most common failure mode in traditional traceability: the gap between "marked done" and "actually verified." In TillDone, the verification *is* the completion condition.

---

## Section 4: Semantic Preservation and SA-11 (RTCA DO-178C)

The most consequential application of dark provenance is in software assurance — specifically, in satisfying the intent of standards like RTCA DO-178C, IEC 62304, and ISO 26262 without the crushing cost of current compliance methods.

**The review boundary problem.**

DO-178C (and its European counterpart ED-12C) defines five levels of software assurance (DAL A through E). At the highest levels (DAL A and B), every line of code must be traceable to a requirement, verified against a test case, and reviewed by an independent assessor. For a modern codebase of hundreds of thousands of lines, this is enormously expensive — often 40-60% of total project cost.

The core challenge is the *review boundary*: where does human review happen? Current practice reviews code directly, line by line. This made sense when humans wrote every line. It makes no sense when an agent generates code from a verified specification.

**The Speck review boundary.**

Speckl proposes a different review boundary: **humans review Specks, not generated code.** This is defensible if and only if the compilation pipeline preserves semantics — that is, if the WASM artifact produced from a verified Speck implements exactly the behaviors the Speck specifies.

This property is called *semantic preservation*. If it holds, then:

1. Human review at the Speck boundary ensures that *intent* is correct.
2. The Z3 verification ensures that the Speck is *internally consistent* (no contradictions, all constraints satisfiable).
3. The deterministic compilation ensures that the *implementation matches the spec*.
4. The provenance graph provides the *traceability evidence* that auditors require.

The combination of (1)-(4) satisfies the *intent* of DO-178C's traceability objectives (Annex A, Tables A-2 through A-6) without requiring line-by-line code review.

**What semantic preservation requires.**

Semantic preservation is not automatic. It requires:

- A *formally defined* specification language with unambiguous semantics. SpeckDL must have a denotational semantics that maps every construct to a mathematical object.
- A *verified compiler* that preserves those semantics through each compilation stage. This is the hardest engineering challenge in Speckl. The compiler must be small enough to audit, and its correctness must be verified (potentially by a different verification tool — a bootstrapping problem we discuss below).
- *Deterministic compilation.* Given the same input, the compiler must always produce the same output. No randomness, no heuristics, no LLM in the compilation path.

The last point is critical and often misunderstood. Speckl uses LLMs for code generation in the *agent harness* — for glue code, UIs, and other non-critical paths. But the formal compilation pipeline (SpeckDL → Z3 → DST → WASM) contains no LLMs. It is purely deterministic. This is non-negotiable for semantic preservation.

**The bootstrapping problem.**

To trust the compiler, you must verify it. But the compiler is a program — verifying it requires a verification tool, which itself must be trusted. This is the classic bootstrapping problem in formal methods.

Speckl's approach is pragmatic, not purist:

1. The compiler is kept as small as possible — ideally under 5,000 lines of TypeScript.
2. The compiler is tested against a comprehensive suite of property-based tests.
3. The Z3 integration is the most trusted component — Z3 itself is extensively verified by Microsoft Research.
4. The DST and WASM codegen stages are simple enough for manual review.
5. As the Speckl ecosystem matures, the compiler can be formally verified using tools like Coq or Lean — but this is a Phase 3 objective, not a launch requirement.

**Implications for other standards.**

The same reasoning applies to other software assurance standards:

- **IEC 62304** (medical device software): Requires traceability from software requirements through unit tests. Dark provenance provides this automatically.
- **ISO 26262** (automotive functional safety): Requires demonstration that safety requirements are met. Verified Specks with semantic preservation provide stronger evidence than test-based verification alone.
- **SOC 2 / FedRAMP** (information security): Require evidence of change management and access controls. The provenance graph provides an immutable record of every change, its source, and its verification status.

In each case, the argument is the same: if humans review the specification, and the compilation pipeline preserves semantics, then the generated implementation inherits the specification's assurance properties. This is not a loophole — it's a stronger guarantee than current practice provides.

---

## Section 5: Implications for AI-Augmented Development

Dark provenance does not merely solve a compliance problem. It changes the economics of AI-augmented software development.

**The trust ceiling.**

Today, there is a trust ceiling on AI-generated code. Organizations adopt LLMs for autocomplete, boilerplate, and internal tooling — low-stakes contexts where bugs are acceptable. For production systems, safety-critical code, and regulated environments, LLMs are excluded or heavily constrained.

This ceiling exists because we cannot verify LLM output. We can test it, review it, and monitor it in production — but we cannot *prove* it correct. Testing is probabilistic; formal verification is categorical. Dark provenance, combined with the Speckl verification pipeline, moves AI-generated code from the probabilistic regime to the categorical regime.

**The provenance graph as competitive advantage.**

Organizations that adopt dark provenance accumulate a provenance graph — a detailed, queryable record of every decision, specification, and verification in their system's history. This graph becomes a strategic asset:

- **Onboarding:** New engineers can query the graph to understand why any piece of code exists, without relying on tribal knowledge.
- **Audit readiness:** Compliance evidence is always available, not assembled under deadline pressure.
- **Risk assessment:** The graph makes it trivial to identify which behaviors are affected by a change to a requirement, a regulation, or a design decision.
- **Insurance and liability:** Insurers and legal teams can evaluate software risk based on provenance coverage rather than guesswork.

No organization that has built a provenance graph will want to operate without one. This creates natural lock-in — the good kind, where staying is genuinely better than leaving.

**Agent economics.**

The tiered agent architecture changes the cost structure of software development. Today, the bottleneck is human review: humans must review AI-generated code, and this review capacity doesn't scale. In Speckl, the bottleneck moves to *specification authoring* — writing Specks is creative, intellectual work that humans do well and enjoy. The rest — verification, code generation, integration, documentation — is handled by agents operating within a verified framework.

This doesn't eliminate human work. It shifts it from review (low-value, error-prone, unscalable) to specification (high-value, creative, inherently human). The humans who used to spend 40% of their time reviewing AI-generated code can now spend that time on the work that matters: defining what the system should do, and why.

**The spectrum of formality.**

Not everything needs a verified Speck. A CRUD endpoint for an internal admin tool doesn't need Z3 verification. A patient monitoring system does. Dark provenance supports a spectrum:

- **Verified Specks** (full pipeline): For safety-critical and regulated behaviors. Z3-verified, DST-compiled, WASM-deployed. Full provenance graph.
- **Verified-by-test Specks** (spec + tests): For important but non-critical behaviors. Human-authored spec, human-written or agent-generated code, test-verified. Provenance graph links spec to code and tests.
- **Unspecified code** (agent-generated): For glue code, UIs, and low-stakes infrastructure. Agent-generated, human-reviewed. Provenance graph records that the code was generated by an agent without a formal spec.

This spectrum is crucial for adoption. Teams can start with unspecified code, adopt verified-by-test Specks for their most important behaviors, and move to fully verified Specks as confidence and compliance needs grow. Dark provenance is not an all-or-nothing methodology.

**The future: agents that prove, not just produce.**

The deepest implication is this: dark provenance enables a future where AI agents don't just generate code — they generate *verified* code. Not code that might work. Code that provably satisfies a specification.

This is a qualitative shift. Today's AI coding agents are productivity tools: they make developers faster. Tomorrow's verified agents are assurance tools: they make software trustworthy. The difference between "this code was generated by an AI" and "this code was proven correct against its specification" is the difference between a productivity claim and a trust guarantee.

Dark provenance is the methodology that makes this shift possible. Without it, AI-generated code will always hit the trust ceiling. With it, agents become the most trusted participants in the software development process — because their output is verified, not just reviewed.

---

## Section 6: Call to Action

The software industry faces a choice. AI agents will generate an increasing share of production code — this is certain. What's uncertain is whether we'll be able to trust that code.

Without a methodology for tracing intent, we're heading toward a world where most software is written by machines and understood by no one. Compliance becomes theater. Audits become approximations. And when something goes wrong — when an AI-generated system fails in a safety-critical context — we'll have no way to answer the most basic question: *why did it do that?*

Dark provenance is the alternative. It's not a product. It's not a framework. It's a methodology: capture intent before code, maintain provenance automatically, and verify behavior formally. The tools that implement this methodology — SpeckDL, the verification pipeline, the agent harness — are means, not ends.

**What you can do today.**

1. **Adopt specification-first development.** Before you write code — or prompt an LLM to write code — write a specification. Even an informal one. Make the spec the primary artifact, not the code. This single practice, adopted widely, would dramatically improve traceability in AI-augmented systems.

2. **Make provenance a first-class artifact.** Treat the provenance graph like you treat your test suite: something that grows with the system, runs in CI, and blocks deployment if it's incomplete. The graph doesn't have to be formal at first. Start with links between requirements, specs, and code. Make it queryable. Make it automatic.

3. **Contribute to Speckl.** The SpeckDL language spec and reference implementation are open source (MIT license). We need:
   - Language designers to help refine SpeckDL's syntax and semantics
   - Formal methods engineers to work on the verified compiler
   - Domain experts in DO-178C, IEC 62304, and ISO 26262 to validate the compliance model
   - Agent developers to build and test the tiered agent harness
   - Writers and educators to make dark provenance accessible to working developers

4. **Talk to your compliance team.** If you work in a regulated industry, show them this paper. Ask: "What would it take to prove — not just demonstrate — that our software satisfies its requirements?" The answer to that question is the starting point for dark provenance adoption.

5. **Publish your provenance.** If you adopt specification-first development, share your specs. Share your provenance graphs. Make the methodology visible. The more teams that practice dark provenance, the more valuable the methodology becomes for everyone.

**The standard is the strategy.**

Dark provenance is not proprietary. SpeckDL is not a moat. The Speckl project's commercial viability depends on *adoption*, not exclusion. We build the standard, publish the methodology, and let the market find us. The consulting, the SaaS, the compliance API — these are consequences of adoption, not prerequisites.

This is an unusual strategy for a startup. Most startups build a product, find customers, and grow. Speckl builds a standard, finds practitioners, and grows. The difference matters because standards compound: every team that adopts SpeckDL makes the ecosystem more valuable for every other team. Every provenance graph that exists makes the case for dark provenance stronger.

The software industry didn't adopt version control because someone sold it to them. They adopted it because it was obviously better than the alternative. Dark provenance is obviously better than the alternative — which is, let's be honest, no provenance at all.

Join us. Write specs. Build provenance. Make intent traceable.

---

*Scott Scoble is the creator of Speckl and the Dark Provenance methodology. He writes about the human side of software development at scoble.me.*

*Speckl is open source under the MIT license. Repository: github.com/sscoble/speckl*

*This whitepaper is a living document. Feedback, corrections, and contributions are welcome at speckl.dev (forthcoming) or via the repository issues.*
