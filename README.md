# Speckl

**A judgement transport utility for AI-generated specifications.** Fulfills NIST SA-11 (human-in-the-loop for automated outputs).

Speckl is a specification language (SpeckDL) with a compiler that produces runnable software — TypeScript and provenance artifacts (PROV-O, CycloneDX, SPDX) — from a single source of truth. Write what your system should do. Prove it. Ship it.

## The Core Insight

AI generates code at machine speed. Humans own specifications. **SpeckDL is the shared space where both can work.**

- **Human-judgeable** — SpeckDL is declarative enough that a person can inspect a spec and say "yes, this captures my intent." The compiled output is opaque; the spec is not.
- **AI-writable** — SpeckDL's constrained grammar and declarative semantics are tractable for LLMs to produce and reason about. Agents draft. Humans review. Both operate on the same semantic layer.
- **Compiled, not generated** — The SpeckDL compiler is deterministic. No LLMs in the compilation path. Same spec, same output — always.

## What Speckl Does Now

Speckl is a **working compiler** that turns formal specifications into multiple target representations:

```
.speckdl spec ──→ TypeScript             ← typed, importable classes
              ├── PROV-O (RDF)           ← W3C provenance standard
              ├── CycloneDX SBOM         ← OWASP software bill of materials
              └── SPDX SBOM              ← Linux Foundation SBOM standard
```

### State Machine Compilation (inspired by TLA+)

```speckdl
spec ToggleSwitch {
  state: Status = Off
  enum Status = On | Off

  init: {
    Status = Off
  }

  action FlipSwitch {
    require: true
    if Status == On {
      Status = Off
    } else {
      Status = On
    }
  }
}
```

This compiles to a runnable TypeScript class with verified state transitions + guards.

### Provenance Embedded at Compile Time

Every compilation embeds a complete provenance record — PROV-O RDF traces the spec → code derivation, CycloneDX and SPDX SBOMs capture the software supply chain. When an auditor asks "where did this behavior come from?", you query the graph, not Jira.

## Real-World Examples

The compiler has been validated against:

| Example | Source | Status |
|---------|--------|--------|
| **ToggleSwitch** | SpeckDL tutorial | ✅ All artifacts |
| **AccountLedger** | Banking ledger with debit/credit | ✅ All artifacts |
| **TwoPhaseCommit** | TLA+ port | ✅ All artifacts |
| **Paxos** | TLA+ port | ✅ All artifacts |
| **Raft** | TLA+ port | ✅ All artifacts |
| **TigerBeetleLedger** | Naive TigerBeetle core | ✅ All artifacts (3 TS type errors in progress) |

## Getting Started

```bash
git clone https://os.scoble.me/forgejo/sscoble/speckl
cd speckl/compiler
npm install

# Compile an example
node dist/index.js ../examples/ToggleSwitch.speck -o out/switch
ls out/switch/
# ToggleSwitch.ts  ToggleSwitch.prov-o.jsonld
# ToggleSwitch.cyclonedx.json  ToggleSwitch.spdx.json
```

### Key Documents

- **[Whitepaper v2](docs/whitepaper-v2.md)** — Complete: 8 sections, ~19,000 words. Covers the spec-code gap, SpeckDL language, compiler architecture, embedded provenance, consensus protocols, compliance applications, related work, and roadmap.
- **[Speckl by Example](docs/speckl-by-example.md)** — Guided tutorial from ToggleSwitch through Raft, with TLA+ comparison table.
- **[Distribution Strategy](docs/distribution-strategy.md)** — Prioritized roadmap: Show HN → arXiv → blog → consulting pipeline. Conference landscape for 2026-2027.
- **[Strategy Ladder](docs/strategy.md)** — Open standard → Consulting → Developer Tool/SaaS → Compliance API.
- **[SpeckDL Spec](speckdl/SPEC.md)** — Language definition v0.2.
- **[State Machine Extension](speckdl/STATE-MACHINE-SPEC.md)** — `state`/`init`/`action` keywords, Set/Map/List types.

## Strategy Ladder

| Phase | Focus | Status |
|-------|-------|--------|
| **A — Open Standard** | SpeckDL language, compiler, whitepaper, examples | ✅ **Complete** (compiler working, whitepaper done) |
| **B — Consulting** | Hands-on engagements with regulated-industry teams | 📋 One-pager drafted, awaiting review |
| **C — Developer Tool/SaaS** | Self-serve spec validation, provenance browser | 🔮 Future |
| **D — Compliance API** | Enterprise audit reports, traceability matrices | 🔮 Future |

## Validation Status

- **Compiler:** 41/41 tests passing (TypeScript codegen)
- **TypeScript:** Type-safe compilation from specs
- **TLA+ Trilogy:** TwoPhaseCommit, Paxos, Raft all compile
- **Compiler Self-Spec:** `speckl-compile.speckdl` defines the Speckl compiler in SpeckDL — generates all artifacts (known TypeScript errors tracked in engineering#9)

## Known Issues

The `rewriteExpr` function in the TypeScript generator applies spurious `this.state.` prefixes to function parameters in guard expressions. Tracked in [marcus/engineering#9](https://os.scoble.me/forgejo/marcus/engineering/issues/9). Parser also drops `precondition:`/`postcondition:` blocks on some action bodies.

## Contributing

Speckl is open source under the [MIT license](LICENSE). Contributions welcome:

- **Language design** — refine SpeckDL syntax and semantics
- **Compiler development** — TypeScript/Node.js, help fix open issues
- **Formal methods** — verify the compilation pipeline, add TLA+ examples
- **Compliance expertise** — validate regulatory models (NIST, IEC 62304, DO-178C)
- **Documentation** — tutorials, guides, case studies

Open an issue or submit a pull request.

## License

MIT © Scott Scoble / Greybeard Holdings, LLC

## Mirrors

- **Primary:** https://os.scoble.me/forgejo/sscoble/speckl
- **Mirror:** https://codeberg.org/sscoble/speckl
