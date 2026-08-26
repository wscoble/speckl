# Embedded Provenance: Proving What Ran Came From What You Wrote

**By Scott Scoble** · Published on [dev.to/Medium/HN] · Series: [Building Speckl](https://speckl.scoble.me) · Post 4 of 5

---

Most software teams can't answer a deceptively simple question: *"Where did this code come from?"*

Not "which repo" or "which team." I mean: who authored the requirement? What tools transformed it into executable code? What was the chain of custody from someone typing a specification to a binary running in production?

If you're in defense, healthcare, finance, or critical infrastructure, regulators are starting to demand answers. Executive Order 14028 requires software supply chain attestations. NIST SP 800-218 (SSDF) mandates provenance tracking. The EU Cyber Resilience Act will make SBOMs mandatory. The era of "trust me, it compiled" is ending.

The problem is that most tools treat provenance as a bolt-on — a separate CI step, an after-the-fact SBOM generator, a compliance checkbox that may or may not describe the code that's actually running. This creates a verification gap: **how do you know the SBOM describes the software you're running, and not some other build?**

Speckl takes a different approach: provenance by construction.

## Provenance as a Compiler Pass

In Speckl, provenance isn't something you add after compilation. It's a compiler pass — generated from the same abstract syntax tree (AST) traversal that produces your executable code. Every time you run `speckl compile`, you get five artifacts:

| Artifact | Format | Purpose | Standard |
|----------|--------|---------|----------|
| Executable code | TypeScript / WASM | Your actual software | — |
| Audit trail | `.prov.ttl` | Who, what, when, how | W3C PROV-O |
| Software bill of materials | `.cdx.json` | What's inside | OWASP CycloneDX 1.4 |
| License metadata | `.spdx.json` | Who owns it, what license | SPDX 2.3 |

Five files, one compilation event, one source of truth. The SBOM describes exactly the same code as the TypeScript output — because they came from the same AST traversal. There is no possibility of drift.

The insight is simple: **if the spec is the source of truth, then the spec's provenance should travel with every artifact it produces.**

## The Three Audiences

Each provenance format serves a different stakeholder, and the three together create a complete compliance picture:

**PROV-O answers "what happened?"** — for auditors and compliance officers. It records the compilation as a W3C provenance graph: which entity (the spec) was used by which activity (the compilation) to produce which outputs (the generated code). Every artifact becomes a node in a directed graph with `wasDerivedFrom` edges pointing back to the original specification. Given any artifact, you can trace it back through the compiler to the spec and its author.

**CycloneDX answers "what's inside?"** — for security teams and vulnerability scanners. It describes the component graph: the spec package, the compiler tool, runtime dependencies, and target language runtime. Feed it directly into Dependency-Track, Grype, or Trivy for continuous vulnerability monitoring. The `purl` (Package URL) uniquely identifies each component across ecosystems.

**SPDX answers "who owns it?"** — for legal teams and procurement. It captures the declared license, copyright, supplier, and originator. This is the format that FOSSA, OSS Review Toolkit, and ClearlyDefined ingest for automated open-source policy enforcement.

None of these are proprietary formats. They're all open standards. The provenance data is portable and consumable by any compliant tool.

## What PROV-O Looks Like in Practice

Here's a real PROV-O output from compiling Speckl's `ToggleSwitch` example:

```turtle
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix speckl: <https://speckl.io/ns#> .

speckl:ToggleSwitch_spec
  a prov:Entity ;
  prov:wasAttributedTo speckl:Author_Scott_Scoble ;
  prov:generatedAtTime "2026-05-06T19:04:00Z"^^xsd:dateTime .

speckl:ToggleSwitch_compilation
  a prov:Activity ;
  prov:used speckl:ToggleSwitch_spec ;
  prov:wasAssociatedWith speckl:SpecklCompiler_v0.3.1 ;
  prov:endedAtTime "2026-05-06T19:04:01Z"^^xsd:dateTime .

speckl:ToggleSwitch_typescript
  a prov:Entity ;
  prov:wasGeneratedBy speckl:ToggleSwitch_compilation ;
  prov:wasDerivedFrom speckl:ToggleSwitch_spec .
```

This is the audit trail. Any downstream artifact — TypeScript, WASM, CycloneDX SBOM, SPDX file — gets its own `prov:Entity` with a `wasDerivedFrom` link to the spec. If you're ever asked "was this TypeScript file generated from the v0.1.0 spec by compiler v0.3.1 on May 6, 2026?", the answer is right there, machine-verifiable.

## The NIST SA-11 Connection

This is where provenance becomes a concrete selling point. NIST SP 800-53 Revision 5 introduced control **SA-11: Developer Testing and Evaluation**, which requires organizations to produce "evidence of correct implementation" for automated code generation tools. Speckl's five-artifact output directly maps to SA-11's sub-controls:

- **SA-11(2) — Threat Modeling and Vulnerability Analysis:** The CycloneDX SBOM feeds directly into vulnerability scanners. You know exactly what dependencies are in your generated code.
- **SA-11(4) — Manual Code Review:** The PROV-O audit trail establishes chain of custody. A reviewer can verify when the spec was written, what compiler version was used, and what artifacts were produced.
- **SA-11(6) — Attack Surface Review:** SPDX license metadata surfaces every licensed component, enabling supply chain risk assessment.
- **SA-11(7) — Verify Scope of Testing:** All five artifacts share a single compilation event, verifiable via PROV-O. You know the tests ran against the same code that shipped.

This is the "judgement transport" value proposition of Speckl: it doesn't just produce code — it produces **evidence**. Evidence that a human reviewer can use to make informed judgements about what was generated, why it was generated, and whether it's safe to deploy.

## Five Design Decisions That Make This Work

**1. Zero-configuration.** There's no `--provenance` flag. No `provenance: true` in a config file. Every `speckl compile` produces all five artifacts, every time. Provenance isn't optional — it's the default.

**2. Guaranteed consistency.** Because all artifacts come from the same AST traversal inside a single compiler pass, there's no possibility of the SBOM describing one version of the code and the TypeScript file containing another. They're generated atomically.

**3. Deterministic and reproducible.** Given the same spec, the same compiler version, and the same timestamp, the provenance output is bit-for-bit identical. This matters for audits: if you're claiming a specific SBOM covers a specific deployment, the system can verify it.

**4. Open standards throughout.** PROV-O, CycloneDX, and SPDX are all community-maintained standards with wide tooling support. There's no lock-in, no proprietary format to decode, no vendor dependency to maintain.

**5. Regulatory readiness as a byproduct.** Organizations don't have to build a separate compliance pipeline. They write their spec, they run the compiler, and they get evidence as a side effect of their normal workflow. Compliance becomes a property of the system, not a separate process.

## What This Means for Development Teams

The shift from "provenance as afterthought" to "provenance as compiler pass" changes how teams think about their build pipeline:

**For developers:** You don't have to configure SBOM generators, set up attestation signing, or maintain a separate compliance toolchain. Write your spec, compile, commit all five artifacts. The evidence is just there.

**For security teams:** Every build produces a CycloneDX SBOM you can scan immediately. No blind spots, no "we added the SBOM step to 80% of our pipelines" situations. It's 100% coverage by construction.

**For auditors:** The PROV-O graph gives you a verifiable chain of custody from spec to deployment. You can ask "was this running artifact produced from an approved specification?" and get a machine-verifiable answer.

**For leadership:** Compliance evidence is no longer a separate project with a separate budget and timeline. It's a property of the development workflow. Ship a feature, ship its provenance alongside it.

## The Blog Post Series

This is post 4 of 5 in our series covering the Speckl compiler and methodology:

1. **Spec-Code Drift Is a Provenance Problem** — why the gap between what you specify and what runs matters
2. **Designing SpeckDL: What a Spec Language Needs in 2026** — the language itself
3. **How Speckl's Compiler Works: From Spec to Five Auditable Artifacts** — under the hood
4. **[This post] Embedded Provenance** — the evidence layer
5. **Consensus Protocols in SpeckDL** — Two-Phase Commit, Paxos, Raft (coming next)

## What's Next

The final post in this series will cover the hardest programs to get right: consensus protocols. We'll walk through Two-Phase Commit, Paxos, and Raft — all specified in SpeckDL, all compiling to the full five-artifact output, with WASM that validates through the WebAssembly reference interpreter.

In the meantime: the Speckl compiler is open source at [os.scoble.me/forgejo/sscoble/speckl](https://os.scoble.me/forgejo/sscoble/speckl) (MIT licensed). The v2 whitepaper is in the repo under `docs/whitepaper-v2.md`. And if you want to see provenance in action, clone the repo and run `speckl compile examples/ToggleSwitch.speck` — you'll have all five artifacts in under two seconds.

---

*Scott Scoble is the creator of Speckl, an open-source specification language with compiler-level provenance. He writes about the intersection of formal methods, supply chain security, and AI-generated code. Follow along at [speckl.scoble.me](https://speckl.scoble.me).*
