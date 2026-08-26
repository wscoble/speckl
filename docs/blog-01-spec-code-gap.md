# Spec-Code Drift Is a Provenance Problem

**Every software project has specifications. And every specification eventually lies.**

Requirements documents. Architecture decision records. API contracts. RFCs. These artifacts describe intent — what the system should do, how it should behave, what invariants should hold.

And three months after you write them, they're wrong.

Not because the author was incompetent. Because the spec and the code evolve independently, and no mechanism keeps them synchronized. The spec becomes archaeology: interesting for historical context, irrelevant for current behavior. Engineers treat it as orientation, not authority.

This is the spec-code gap. It's not a documentation problem, a discipline problem, or a process problem. **It's a provenance problem.** And it's about to get much worse.

## The AI Accelerant

When a human writes code from a spec, there's at least a reasoning chain — however undocumented. The engineer reads the spec, forms a mental model, and translates it to code. If a bug exists, you can ask "what were you thinking?" and get an answer.

When an LLM writes code from a prompt, that chain disappears. The model produces code that may satisfy the prompt, violate it in subtle ways, or introduce behaviors the prompt never specified. The reasoning is opaque. The provenance is gone.

This isn't theoretical. NIST SA-11 — the control for "human review of automated outputs" — is already being mapped to AI-generated code in compliance frameworks. SOC 2 auditors are asking: "Who reviewed this code? What spec was it written against?" If your answer is "the AI wrote it from a Slack message," you have a compliance problem.

## The Formal Methods Gap

There is a solution. Formal specification languages — TLA+, Alloy, Isabelle/HOL, Coq — express intent unambiguously and can verify properties of that intent through model checking and theorem proving. Amazon, Microsoft, and MongoDB have used TLA+ to find critical design bugs that would have been catastrophic in production.

But formal methods create their own gap: **the verified spec and the running system are separate artifacts.**

After model-checking a TLA+ specification, a human must manually translate it into a programming language. That translation is:
- **Lossy** — the spec's invariants live in the TLA+ tool, not in the running code
- **Unverifiable** — no tool checks whether the implementation matches the verified spec
- **Drift-prone** — the implementation evolves, the spec doesn't, and the gap widens

You've verified the design. You haven't verified the implementation. The spec-code gap is exactly as wide as it was before.

## Provenance as the Missing Piece

Here's the shift: **we don't need the spec and the code to match. We need the code to come FROM the spec.**

Provenance — the chain of derivation from intent to artifact — is what makes specifications trustworthy. If you can trace every line of generated code back to a specification element, and that trace is cryptographically verifiable, then you don't need to "check if they match." The provenance IS the verification.

This is how Speckl approaches the problem. Instead of writing a spec and then writing code that implements it, you write the spec in SpeckDL — and the compiler produces the code, along with a provenance graph that traces every output back to its specification origin.

Here's a ToggleSwitch in SpeckDL:

```
state ToggleSwitch {
    on: Bool
}

init ToggleSwitch {
    on = false
}

action TurnOn for ToggleSwitch {
    require !on    // Can't turn on if already on
    on = true
}

action TurnOff for ToggleSwitch {
    require on     // Can't turn off if already off
    on = false
}
```

That's it. Fourteen lines. From this, `speckl compile` produces:

- **A TypeScript class** with typed `TurnOn()` and `TurnOff()` methods, runtime guard checks, and state accessors
- **A WebAssembly module** with exported functions and guard-validated state transitions
- **A PROV-O provenance graph** showing that `TurnOn()` method was derived from `action TurnOn` in the spec
- **A CycloneDX SBOM** declaring the generated module with its hash and provenance
- **An SPDX document** for license compliance

The spec is 14 lines. The generated artifacts are hundreds of lines of production code. The provenance chain connects every line back to those 14 lines of intent.

## Why This Matters Now

Three trends are converging:

### 1. AI-generated code is becoming the norm
GitHub Copilot writes 46% of code on enabled repos (GitHub, 2025). Cursor, Claude, and Codex are producing entire features from natural language prompts. The volume of code with no human reasoning chain is exploding.

### 2. Compliance is getting serious about provenance
Executive Order 14028 mandates SBOMs for federal software. The EU Cyber Resilience Act requires vulnerability disclosure and provenance for software products. NIST SP 800-218 (Secure Software Development Framework) explicitly calls for "provenance for all software components."

### 3. Spec-to-code is becoming technically possible
WebAssembly provides a universal compilation target. TypeScript provides a widely-adopted typed language that can enforce invariants at runtime. PROV-O provides a W3C standard for provenance representation. The pieces exist.

## The Alternative Is Drift

Without provenance, every specification is on a timer. Day one, it reflects reality. Day ninety, it's a historical document. Day three hundred and sixty-five, it's fiction.

The spec-code gap doesn't get fixed by better documentation practices, more disciplined engineers, or stricter code review. It gets fixed by eliminating the gap — by making the spec the single source of truth, and generating everything else from it.

That's what a provenance-first approach to specifications enables. It's not just about writing better specs. It's about making specs executable, verifiable, and auditable — so the gap never opens in the first place.

---

*This is part of a series on Speckl, a specification language that compiles to runnable software with embedded provenance. Read the [full whitepaper](https://os.scoble.me/forgejo/sscoble/speckl/src/branch/main/docs/whitepaper-v2.md), explore [Speckl by Example](https://os.scoble.me/forgejo/sscoble/speckl/src/branch/main/docs/speckl-by-example.md), or check out the [compiler](https://os.scoble.me/forgejo/sscoble/speckl).*

*Speckl is MIT-licensed and open source. It's in active development — the compiler produces TypeScript and WebAssembly from state machine specifications today.*
