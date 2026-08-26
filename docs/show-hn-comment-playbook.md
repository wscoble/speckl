# Show HN Comment Response Playbook
**Prepared: May 9, 2026 — For launch May 12-13, 2026**

## Why This Exists
The first hour of a Show HN post makes or breaks it. Quick, thoughtful replies signal that the project has a real builder behind it. This playbook pre-writes responses to the 12 most likely objections/questions so Scott can copy-paste-adapt in real time.

---

## RESPONSE 1: "How is this different from TLA+?"

**Response:**
TLA+ is a mathematical modeling language — you write specs, run TLC to check invariants, and that's where it stops. SpeckDL starts at the same place (state machines, invariants, actions) but compiles *forward* into production artifacts: TypeScript classes, WASM modules, SBOMs, and provenance metadata.

Think of it as: TLA+ proves your design is correct. SpeckDL ensures your implementation stays correct. They're complementary — you could model-check a SpeckDL spec with TLA+ concepts, and you can't compile a TLA+ spec to runnable code.

I wrote a detailed comparison in the tutorial: [link to speckl-by-example.md#tla-comparison]

---

## RESPONSE 2: "Why not just use property-based testing or fuzzing?"

**Response:**
Property-based testing and fuzzing are *runtime* verification — they catch bugs by exploring the state space. Speckl is *compile-time* verification — the spec IS the implementation, so there's nothing to drift from.

That said, they're complementary. You could use SpeckDL specs to generate property-based test harnesses. The WASM output already validates state transitions at runtime. I'd love to add QuickCheck-style test generation from spec invariants as a future feature.

---

## RESPONSE 3: "This seems overengineered for CRUD apps. When would I actually use this?"

**Response:**
Fair question! You wouldn't use Speckl for a basic CRUD app. The sweet spot is systems where correctness matters and state transitions are complex:
- Financial ledgers (double-entry accounting, payment systems)
- Distributed consensus (Raft, Paxos, 2PC)
- Workflow engines with audit requirements
- Compliance-critical systems (NIST SA-11, SOC 2 evidence)
- Any system where you're already writing state machine diagrams on a whiteboard

If your state transitions fit on a napkin, skip Speckl. If you're drawing sequence diagrams for 5 failure modes, that's where it shines.

---

## RESPONSE 4: "The language looks like it was designed in a weekend. Why create yet another DSL?"

**Response:**
It WAS designed iteratively — but over weeks, not a weekend. The constraint was: it has to be readable by non-programmers (compliance officers, auditors, domain experts) while being precise enough to compile.

I looked hard at using existing languages (TLA+, Alloy, P, PlusCal) but none of them compile to production code + provenance metadata. SpeckDL is deliberately minimal — ~15 keywords. The complexity lives in the compiler, not the language.

That said, I'm actively seeking feedback on the syntax. If you see awkward patterns, I want to hear about them.

---

## RESPONSE 5: "41 tests? That's nothing. How do I know this works?"

**Response:**
41 unit tests cover the parser, type checker, and all 5 generators. The real validation is the example suite: 10 specs (from ToggleSwitch to Raft) that all compile to all 5 artifacts with zero errors.

The WASM output is validated through `wabt` (WebAssembly binary toolkit) — parse → resolve → validate → binary roundtrip. The TypeScript output passes `tsc --noEmit`.

You're right that 41 isn't a lot. More tests are being added as the compiler matures. The roadmap includes property-based testing and differential testing against TLC models.

---

## RESPONSE 6: "What about formal verification? Can you prove invariants hold?"

**Response:**
Not yet — that's on the roadmap. Right now Speckl does *runtime* invariant checking (assertions in generated code) rather than *static* verification.

The architecture supports it though: the AST preserves all invariant expressions, and the WASM generator already emits guard checks. Adding Z3/SMT-based invariant proving is a natural next step — the spec already has all the information a solver would need.

Targeting bounded model checking via Z3 as a Phase 3 feature.

---

## RESPONSE 7: "Why TypeScript? Why not Rust or Go?"

**Response:**
TypeScript was the fastest path to a working compiler and generated code that's immediately useful (most web backends run Node.js). The compiler architecture is language-agnostic — generators are pluggable modules that walk the AST.

Rust and Go generators are planned. The WASM output already works cross-language (you can embed it in Rust via wasmtime, Go via wazero, etc.). I picked the starting point that maximized reach with minimum effort.

---

## RESPONSE 8: "Self-hosted Forgejo? Why not GitHub?"

**Response:**
I believe developer tools should practice what they preach about infrastructure independence. The canonical repo lives on my own Forgejo instance. There's a Codeberg mirror for redundancy. GitHub mirror coming soon.

The license is MIT — you can fork it wherever you want.

---

## RESPONSE 9: "What's the business model? Is this going to become paid?"

**Response:**
The core compiler and language are MIT-licensed and will stay open source. The business model ladder:
1. **Consulting** — Help teams adopt spec-driven development (now)
2. **Managed service** — Hosted spec validation + compliance dashboards (later)
3. **Enterprise features** — SSO, audit logging, compliance report generation (future)

But the language and compiler are forever free. I'm not pulling an Oracle.

---

## RESPONSE 10: "How does provenance work exactly? What's in the PROV-O output?"

**Response:**
Every artifact generated by the compiler includes embedded provenance in PROV-O (W3C PROV Ontology, RDF/Turtle format). Each line of generated code is linked back to a specific line in the source `.speckdl` file.

The provenance graph includes:
- `prov:wasGeneratedBy` — which compiler pass produced this output
- `prov:used` — which source file and line was consumed
- `prov:wasAttributedTo` — which author/agent wrote the spec
- `prov:generatedAtTime` — timestamp of compilation

This creates an auditable chain: auditor sees generated code → traces to spec line → traces to author and timestamp. That's the NIST SA-11 compliance angle — human-in-the-loop for automated outputs with a verifiable trail.

---

## RESPONSE 11: "How mature is this? Would you use it in production?"

**Response:**
Honest answer: it's not production-ready yet. The compiler is stable (41/41 tests, 10 example specs compiling clean), but there are known gaps:
- Parser doesn't handle `precondition:`/`postcondition:` assertions yet
- Generated TypeScript doesn't emit record type aliases yet
- No JS API wrapper for WASM modules

I'm targeting production-readiness for the compiler pipeline by end of May. Right now it's best for experimentation, learning, and providing feedback that shapes the roadmap.

---

## RESPONSE 12: "What's the most surprising thing you learned building this?"

**Response:**
That the compiler architecture matters more than the language design. I spent way more time on the generator pipeline (AST → 5 artifacts) than on the parser and syntax.

The "aha" moment was realizing that WASM codegen and TypeScript codegen are fundamentally the same operation — walking an AST and emitting target code. Once the AST is right, adding new output formats is mostly mechanical.

Also: wabt (WebAssembly Binary Toolkit) is an incredible piece of software. Being able to validate generated WAT through a real assembler instead of writing my own binary encoder saved weeks.

---

## RESPONSE 13 (SEEDED QUESTION): "Could this be used for smart contract development?"

**Response:**
Absolutely — that's one of the most exciting use cases. Smart contracts are state machines with money at stake, and bugs are irreversible.

SpeckDL specs could compile to Solidity or Move, with the provenance trail serving as audit evidence for DeFi protocols. The WASM output already works for chains that support WASM smart contracts (Polkadot, NEAR, Cosmos).

This is on the roadmap — if anyone's interested in a Solidity generator, I'd love to collaborate.

---

## RESPONSE 14 (SEEDED QUESTION): "How does this compare to AWS IAM policy-as-code or Open Policy Agent?"

**Response:**
Different layer of the stack! OPA and IAM policy-as-code are about *authorization rules* — who can do what. Speckl is about *system behavior* — what happens when they do it.

You could use SpeckDL to specify the state machine of an authorization system (e.g., "a user in pending-approval state cannot access resources"), and OPA to enforce the policy. They're complementary — Speckl specifies behavior, OPA enforces access.

---

## Engagement Rules

1. **Reply within 15 minutes** — HN's algorithm rewards early engagement
2. **Be genuine** — don't copy-paste verbatim, adapt to the actual question
3. **Link to evidence** — always point to the repo, tutorial, or specific code
4. **Accept criticism gracefully** — "You're right, that's a gap. Here's the plan"
5. **Don't argue** — if someone hates it, thank them for the feedback and move on
6. **Upvote thoughtful replies** — even critical ones, if they're substantive
7. **First comment** — post immediately after the Show HN with: "I built this because [origin story]. Happy to answer questions about the compiler architecture, the language design decisions, or the distribution roadmap."

---

## Timing Notes

- **HN front page velocity peaks:** 7-10 AM PT, 12-2 PM PT
- **Stay on for 90 minutes** after posting — that's the window for hitting the front page
- **If it hits front page:** expect 50-200 comments. Triaging which to reply to matters more than replying to everything
- **Don't check votes obsessively** — it's visible to you but not others
