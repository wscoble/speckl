# Dark Provenance: The Missing Layer for Trustworthy AI-Generated Software

> *A whitepaper on making AI-generated code verifiable, auditable, and explainable through provenance tracking of intent, constraints, and decisions.*

## Abstract

The accelerating adoption of AI code generation presents a fundamental trust problem: how do you verify that AI-generated code is correct, complete, and free of unintended behaviors when the reasoning that produced it is opaque? Existing approaches — tests, linters, formal verification — operate on the output but not the decision chain that produced it.

Dark Provenance proposes a new layer: a structured, machine-readable record of every intent, constraint, and design decision that led to the generated code. This provenance chain makes AI outputs auditable in the same way that build artifacts are reproducible from source.

## Outline

1. **The Trust Problem**
   - The asymmetry of generation vs. verification
   - Why tests alone aren't enough
   - The opacity of current AI code generation

2. **What Is Dark Provenance?**
   - Definition and core concept
   - Provenance as a first-class artifact
   - From spec → decisions → code: the complete trace

3. **Provenance Chain Specification**
   - Nodes: intents, constraints, decisions, derivations
   - Edges: dependency and justification links
   - Immutable append-only provenance graph

4. **Verification Through Provenance**
   - Checking that generated code satisfies stated intents
   - Detecting hallucinated or unwarranted assumptions
   - Ensuring no orphan code (code without provenance)

5. **Integration with Speckl**
   - Speckl specs as the root provenance node
   - Automatic provenance capture during agent generation
   - Verification at commit, PR, and release gates

6. **Case Studies**
   - Formal spec → verified implementation trace
   - Refactoring with full provenance preservation
   - Audit trail for regulated environments

7. **Challenges and Open Questions**
   - Storage and query efficiency for large provenance graphs
   - Balancing detail with human readability
   - Interoperability across different agent systems

8. **Roadmap**
   - Near-term: Provenance format spec and reference agent
   - Medium-term: Verified generation pipelines
   - Long-term: Ecosystem of provenance-aware tools

---

*This whitepaper is a placeholder. Full draft in progress.*
