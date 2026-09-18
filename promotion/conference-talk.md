# Conference Plan

## Flagship talk - working title

**"AI Writes the Spec. The Solver Signs Off."**
(alt: "Proofs, Not Vibes: Conversational Specification Development")

## Abstract (draft, ~250 words - adapt per CFP)

> AI systems now write substantial portions of our software, but they write
> it into the same old artifact: code, checked by the tests we remembered to
> write. Speckl inverts the workflow. A conversational AI interviews a
> developer about a system's behavior - edge cases, failure modes, invariants
> - and writes a formal state-machine specification. A deterministic SMT
> solver (Z3) then *proves* those invariants within bounded model-checking
> depth, or returns a counterexample: a per-step state trace showing exactly
> how the design fails. No LLM participates in compilation; the same spec
> always produces the same proof.
>
> This talk demonstrates the full loop on a real specification suite
> (GreybeardConsole: tenants, VoIP call sessions, signal delivery, a record
> store with tombstone semantics, and a multi-source sync pipeline with a
> dead-letter queue). It includes the moment the solver rejected the
> tool's own design - a signal bus whose close operation stranded undelivered
> messages - as a counterexample trace, and the one-line guard that made all
> 16 properties provable. We cover where the approach works, where it
> degrades honestly (bounded depth, unlowered constructs reported as advisory
> rather than claimed as proofs), and what it means for AI-assisted
> engineering: the AI proposes, the solver disposes.

## Talk outline (25-30 min conference slot)

1. The verification gap in AI-written software (5 min) - tests vs proofs;
   the "who reviews the reviewer" problem
2. SpeckDL in 5 minutes (5 min) - states, actions, invariants, verify;
   deterministic compilation; provenance-native (PROV-O, SpeckBOM)
3. The live loop (10 min) - GreybeardConsole in the studio: interview →
   draft → compile → prove → **counterexample (SignalBus)** → one-line fix →
   16/16 proven. Show the honest degraded case too.
4. Under the hood (3 min) - no LLM in the compilation path; Z3 BMC; how
   counterexamples become plain-English tables
5. Where this breaks and what's next (2 min) - quantifier lowering,
   post-state unrolling, the plugin API for external harnesses

## CFP targets (verified windows)

| Venue | Fit | Deadline | Notes |
|---|---|---|---|
| **ICFEM 2026** (Southampton, Nov 17-20) | Excellent - "Formal methods for and with AI", tools, industrial case studies | **Full paper June 22, 2026** | LNCS; industrial case-study track fits GreybeardConsole story |
| **SEFM 2026** (Nov 23-27) | Excellent - dedicated tool-paper track (8pp + mandatory artifact) | Abstract June 16/23 · Paper June 30, 2026 | Artifact evaluation mandatory - repo must be clean; pairs with B-15 npm publish |
| **MEMOCODE 2026** (ESWEEK, Barcelona, Oct 8-9) | Good - "AI-assisted reasoning", tool presentations | Final deadline May 11 → June 1, 2026 | Tool presentation track is the lightest lift |
| Curry On / QCon / GOTO / YOW | Industry talks, wider audience | Rolling - check current windows | Pitch the "AI writes, solver signs off" angle |
| SREcon / platform conferences | "Spec-first operations" via Greybeard angle | Rolling | Weaker fit; hold until a second case study exists |

Strategy: MEMOCODE tool presentation (June 1) as the first conference
appearance; use its feedback to sharpen the ICFEM paper (June 22) and SEFM
tool paper (June 30). Local meetup run-through of the talk before MEMOCODE.

## Paper skeleton (shared across CFPs)

1. Motivation: AI-generated behavior, no formal contract
2. SpeckDL: human-readable state machines + provenance primitives
3. The conversational loop (interview → spec → compile → prove)
4. Real-solver BMC with honest degradation; counterexamples as readable traces
5. Case study: GreybeardConsole, 16/16 properties, the SignalBus catch
6. Limitations: bounded depth, unlowered constructs, advisory semantics
7. Tool + artifact (repo, spec corpus, verification scripts)