# How Speckl's Compiler Works: From Spec to Five Auditable Artifacts

**Series:** Building Speckl — Part 3 of 5  
**Published:** [date]  
**Read time:** 8 minutes  
**Tags:** #compilers #specification #formal-methods #typescript #webassembly #compliance

---

You've seen *why* spec-code drift matters (Part 1) and *what* SpeckDL looks like (Part 2). Now let's look under the hood: how does a single `.speck` file become five independently auditable artifacts?

The Speckl compiler is a single-pass, multi-target compiler in TypeScript. It's deterministic, zero-dependency (beyond Node.js + wabt), and produces no network calls. Here's the pipeline:

```
.speck file → Parser → AST → [PROV-O | CycloneDX | SPDX | TypeScript | WASM]
```

Every generator walks the same AST independently. No generator ever talks to another. That shared AST is the single source of truth — if the spec says it, every artifact reflects it.

## The Parser: ~850 Lines of Recursive Descent

The parser is hand-written using recursive descent with a tokenizer. No parser generators. No PEG grammar files. Just a straightforward TypeScript tokenizer that handles:

**Keywords:** `speck`, `state`, `init`, `action`, `invariant`, `type`, `next`, `forall`, `let`, `emit`, `return`, `require`, `if`, `and`, `or`, `not`, `implies`, `in`, `notIn`, `union`, `subsetOf`, `emptySet`, `emptyMap`, `List`

**Operators:** `:=` (assignment/equality), `==`, `!=`, `<=`, `>=`, `+`, `-`, `*`, `/`, `\` (set difference), `|` (action composition)

**Types:** `Bool`, `Nat`, `Int`, `String`, `Set<T>`, `Map<K,V>`, `List<T>`, `Record{...}`, `Optional<T>`

The parser builds a typed AST with these node types:

- **SpeckNode** — top-level spec with name and member list
- **StateNode** — typed state variables
- **InitNode** — initial state assertions
- **ActionNode** — named actions with preconditions, body, and return type
- **InvariantNode** — boolean invariants checked after every action
- **NextNode** — action composition (`A | B | C` means "A or B or C may fire next")

Type aliases are fully resolved during parsing — generators never see them. A `type AccountID = Nat` becomes `Nat` everywhere it's referenced. This means generators operate on structurally complete types, never chasing references.

## Five Generators, One AST

### 1. PROV-O Generator — The Audit Trail

Emits a W3C PROV-O provenance graph in Turtle (`.ttl`). This is the foundation of Speckl's auditability:

- **Entities:** The `.speck` file, each generated output file
- **Activities:** Compilation as a whole, each generator invocation
- **Agents:** The compiler (version + commit hash), the human author, any AI contributor
- **Relations:** `wasGeneratedBy`, `wasDerivedFrom` (code → spec), `wasAttributedTo`, `used`

The PROV-O graph answers "Where did this code come from?" with a machine-readable chain. Feed it to a PROV validator and you get cryptographic certainty about provenance.

### 2. CycloneDX Generator — The Industry-Standard SBOM

Outputs CycloneDX v1.4 JSON. Each artifact declares:

- The generated module as a software component with SHA-256 hash
- The compiler as a build tool
- The source `.speck` file as a component dependency
- License metadata

CycloneDX is consumed by Dependency-Track, OWASP scanners, and compliance platforms (SOC 2, FedRAMP). Your spec doesn't just produce code — it ships with an audit-ready SBOM out of the box.

### 3. SPDX Generator — The ISO Standard SBOM

Outputs SPDX v2.3 JSON (ISO/IEC 5962:2021). Provides package-level license declarations, relationship mapping to the source spec, and creator attribution. SPDX is required by many enterprise procurement processes — Speckl generates it automatically.

Two SBOM generators might seem redundant, but they serve different ecosystems: CycloneDX for OWASP/devsecops toolchains, SPDX for enterprise legal review. Both from the same spec with zero extra effort.

### 4. TypeScript Generator — Runnable State Machines

This is the powerhouse. The TypeScript generator emits a class implementing the entire state machine:

- **Type aliases** become TypeScript `type` declarations
- **State** becomes a typed `State` interface
- **Actions** become public methods with guard clauses (preconditions throw `PreconditionError`)
- **Invariants** compile to a `_checkInvariants()` method that runs after every action
- **Events** (`emit`) route to an injected `EventEmitter` interface — decoupled from any logging/metrics/audit infrastructure
- **State is private** — only readable via snapshots, never directly mutable from outside

Here's what a ToggleSwitch spec produces:

```typescript
class ToggleSwitch {
  private _state = { on: false };

  TurnOn(): void {
    if (!this._state.on) throw new PreconditionError("TurnOn requires !on but on is true");
    this._state.on = true;
    this._checkInvariants();
  }

  TurnOff(): void {
    if (this._state.on) throw new PreconditionError("TurnOff requires on but on is false");
    this._state.on = false;
    this._checkInvariants();
  }

  private _checkInvariants(): void {
    // Runtime invariant checks
  }

  getState(): Readonly<State> { return { ...this._state }; }
}
```

It also handles `forall` loops over sets, `if` branches, `let` bindings, and compound types (`Set<T>` → `Set<T>`, `Map<K,V>` → `Map<K,V>`, `List<T>` → `T[]`).

### 5. WASM Generator — Specs in the Browser

Emits WebAssembly Text Format (`.wat`) that assembles to `.wasm` via `wat2wasm`:

- One exported function per action
- State stored in linear memory with type-specific encodings
- Guard failures cause WASM `unreachable` traps
- Invariants validated with trap-on-failure

This means Speckl specs run in browsers, edge functions, embedded systems — anywhere with a WASM runtime. And because the output is human-readable `.wat` before assembly, you can grep it, verify it, and feed it to formal verification tools.

## The Test Suite: 41 Tests, 2 Seconds

The compiler runs 41 tests across parser correctness, generator output format compliance, and end-to-end WASM instantiation. All tests complete in under 2 seconds. The suite is designed to make the compiler safe to refactor — break spec semantics, and tests catch it instantly.

Key test categories:
- **Parser:** Every language construct, nested generics, operator precedence, edge cases
- **Generators:** PROV-O structure, CycloneDX schema compliance, SPDX completeness, TypeScript type checking (`tsc --noEmit`), WAT assembly validity
- **E2E:** Full pipeline → validate TypeScript compiles → validate WAT assembles → instantiate WASM → run actions → verify state + guards

## Design Decisions That Matter

**Zero external services.** The compiler never makes network calls. Reads from disk, writes to disk. Deterministic, reproducible, air-gappable.

**Independent generators.** Adding a new target language (Rust, Python, C, SQL schema) means writing one new 200-400 line module. The parser and other generators don't change.

**Text-first WASM.** We emit `.wat` (text) not binary `.wasm`. Human-readable. Grep-able. Assembly is deferred to `wat2wasm`, keeping dependency surface minimal.

**DIST DESYNC guard.** A `check-dist.sh` + Makefile guard prevents stale compiled JavaScript from masking real bugs. The compiler refuses to run if `dist/` is out of date relative to `src/`. This eliminated an entire class of false-positive test passes.

**CLI-first.** The compiler is `speckl compile file.speck`. Internal API is stable but the primary interface is the command line — easy to drop into Makefiles, CI/CD pipelines, and build scripts.

## What This Means

The Speckl compiler transforms a specification from prose to proof. One `.speck` file becomes: a provenance graph, two industry-standard SBOMs, a type-safe TypeScript class, and a deployable WASM module. All independently auditable. All from a shared AST with zero external dependencies.

In the next post, we'll look at Speckl's embedded provenance system — how the compiler proves that the code you're running is the code you specified.

---

**Next: Part 4 — "Embedded Provenance: Proving What Ran Came From What You Wrote"**

*Read Part 1: [Spec-Code Drift Is a Provenance Problem](./blog-01-spec-code-gap.md)*  
*Read Part 2: [Designing SpeckDL: What a Spec Language Needs in 2026](./blog-02-designing-speckdl.md)*  
*Speckl repo: [os.scoble.me/forgejo/sscoble/speckl](https://os.scoble.me/forgejo/sscoble/speckl)*
