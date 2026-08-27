# SpeckDL Language Specification v0.3

> The specification-first language for auditable software.
> Part of the [Speckl](https://github.com/wscoble/speckl) project. MIT License.

---

## 1. Introduction

SpeckDL is a domain-specific language for defining state machines and their
interfaces. A SpeckDL specification (a **Speck**) describes *what* a system
should do, not *how* it should do it. The compiler is a deterministic
pipeline — SpeckDL → IR → {TypeScript, Z3, Rust, Protobuf, K8s CRD, OpenAPI,
PROV-O, CycloneDX, SPDX} — with no LLMs in the compilation path.

### Design Goals

- **Human-readable first.** A Speck should be understandable by a domain expert who doesn't write code.
- **Machine-verifiable.** Invariants and verify blocks compile to Z3 (SMT solver) input. Verification runs against a real solver in CI.
- **Provenance-native.** The pipeline records derivation edges automatically. Provenance is not bolted on — it's structural.
- **Composable.** Specks compose via imports and interfaces.
- **Deterministic.** Same input, same output. Every time.

### v0.2 → v0.3

v0.2 defined behavior declaratively (`input:`/`output:`/`constraint:`). v0.3
adds the imperative state-machine form — `state`, `init`, `invariant`,
`action`, `next` — with TLA+-style nondeterministic action selection. The
declarative subset remains supported (see §2.7) and its constraints are
verified over the declared inputs and outputs.

---

## 2. Syntax

### 2.1 Top-Level Structure

```
speck Name {
  <members>
}
```

Members are drawn from: `state`, `init`, `invariant`, `action`, `next`,
`constraint`, `verify`, `event`, `type`, `import`, `interface`, `service`,
`oneof`, `transition`, `input`, `output`, and the provenance/BOM primitives:
`provenance`, `review`, `derives`, `satisfies`, `author`, `source`, and `bom`.

File-level directives (before or inside a speck): `version`, `author`,
`license`, `proto_package`, `go_package`, `event_suffix`, `k8s_group`,
`k8s_version`.

### 2.2 State Machines (v0.3)

The imperative core:

```speck
speck ToggleSwitch {
    state {
        isOn: Bool
    }

    init {
        isOn := false
    }

    invariant SwitchConsistent {
        isOn in {true, false}
    }

    action TurnOn {
        require not isOn
        isOn := true
        return isOn
    }

    action TurnOff {
        require isOn
        isOn := false
        return isOn
    }

    next: TurnOn | TurnOff
}
```

| Member | Meaning |
|--------|---------|
| `state { ... }` | State variable declarations: `name: Type`. Collections: `List(T)`, `Set(T)`, `Map(K, V)`. Nullable: `T | null`. |
| `init { ... }` | Initial state: `var := expr` (assignment form; `==` is also accepted in source but is not captured by the parser — prefer `:=`). |
| `invariant Name { ... }` | Properties that must hold in every reachable state. |
| `action Name(params) { ... }` | State transitions. `require` is a guard; `:=` assigns; `return` makes results observable. |
| `next: A | B | C` | Which actions may fire — nondeterministic choice, as in TLA+. |

**Post-state notation.** `x'` denotes the value of `x` after the transition:
`currentTerm' >= currentTerm` (see §3.4 for verification semantics of post-state invariants).

**Quantifier sugar.** Invariants and init blocks support
`forall v in collection: <expr>` where collection may be `var.keys`,
`var.values`, or a range. This sugar is recognized by the language but not
yet lowered to Z3 (see §3.5).

**Comments** — `//` line comments and `/* ... */` block comments.

### 2.3 Declarative Form (v0.2, still supported)

```
speck RetryHandler {
    input: { maxRetries: Nat, initialDelay: Real }
    output: { success: Bool, totalDelay: Real }
    constraint: maxRetries >= 0
    constraint: implies(attempt > 1, delay > 0)
    verify: always(implies(attempt > 1, delay > 0))
}
```

Constraints range over the input/output fields, which are declared as free
variables in the formal verification output. Constraints may be named:

```
constraint ReadConsistency: forall r in readers: (readerEndMark[r] == 0) or (readerEndMark[r] <= nFrames)
constraint "constraint names may contain spaces" : x > 0
```

### 2.4 Verification Blocks

Two forms:

```
verify Always(ReadConsistency) { depth 10 }     // named invariant + BMC depth
verify: always(implies(attempt > 1, delay > 0)) // free-form temporal expression
```

`Always(p)` is checked by bounded model checking: the state is unrolled
`depth` steps, transitions are constrained (action guards + assignments +
frames + stuttering), and the solver is asked whether `p` can be violated.
`Eventually(p)` is approximated similarly.

### 2.5 Types

| Type | Meaning | Z3 Mapping |
|------|---------|------------|
| `Nat` | Non-negative integer | `Int` with constraint `>= 0` |
| `Int` | Signed integer | `Int` |
| `Real` | Real number | `Real` |
| `Bool` | Boolean | `Bool` |
| `String` | UTF-8 string | Uninterpreted sort / `String` |
| `Bytes` | Byte sequence | Uninterpreted sort |
| `{ ... }` | Record | Datatype |
| `List(T)` | Ordered sequence | Array/`Seq` |
| `Set(T)` | Set | `(Array T Bool)` membership |
| `Map(K, V)` | Associative map | `(Array K V)` |
| `T \| null` | Optional | Lifted to underlying sort |
| `type X = ...` | Named alias | Uninterpreted sort or datatype |

### 2.6 Events

```
event RetryAttempted {
    attemptNumber: Nat
    delay: Real
}
```

Events are emitted from actions (`emit RetryAttempted { attemptNumber: 1 }`)
and recorded in the provenance graph. They do not affect verification.

### 2.7 Wire-Format Members

For serialization targets (Protobuf, K8s CRDs, OpenAPI):

```
interface PaymentProcessor {          // record (fields) | enum (variants) | service (signatures)
    kind: String
    apiVersion: String
}

service TEFService {
    rpc CreateCustomer(CreateCustomerRequest) returns (Customer);
}

oneof Payload { Customer customer }   // proto discriminated union
transition Transition { prior_state: String }
```

### 2.8 Imports

```
import "common.speckdl" as common
import "retry-handler.speckdl" as retry version "1.2.0" hash "sha256:..."
```

Version pinning is optional for local development and required for Specks
with `review: manual` or `review: hybrid`.

---

## 3. Verification

### 3.1 What the Z3 Backend Emits

Each Speck compiles to SMT-LIB2 (`.smt2`, state-machine-aware, and
`.ir.smt2`, formal-spec-only):

1. Sort declarations for state variables and named types.
2. Init assertions at step 0.
3. One assertion per invariant/constraint.
4. Bounded model checking for `verify` blocks: N copies of state, action
   transition predicates (guards, assignments, frames), stuttering, and the
   negated property.
5. `(check-sat)` + `(get-model)` with an expectation marker:
   `; speckl-expect: unsat` (property proven) or `; speckl-expect: sat`
   (consistency check).

### 3.2 The Verify Script

`npm run verify` (in `compiler/`) compiles every example and runs the real
Z3 binary on each emitted file:

- Solver **error** → failure (generator bug — Z3 rejects the file).
- Result matching the expectation → pass.
- Unexpected `sat` against an `unsat` expectation → **VIOLATED**: the script
  prints a counterexample state trace (per-BMC-step variable bindings).
- Unexpected `unsat` → contradictory constraints.

Exit code is nonzero on failure. CI runs this for every example spec.

### 3.3 Graceful Degradation

Constructs without a well-defined SMT translation (unresolved type unions,
method calls like `List.empty` in unsupported positions, leaked source
syntax) are dropped from the output with `; skipped:` comments instead of
emitting invalid SMT. When any form is dropped, an `unsat` expectation is
downgraded to a consistency check — the solver result is then advisory, not
a proof.

### 3.4 Known Limitations

- **Post-state invariants.** Invariants using `x'` notation are checked for
  consistency only (marked `degraded`); per-step unrolling of post-state
  references is not implemented.
- **Quantifier sugar.** `forall x in collection:` constraints are skipped
  pending IR quantifier support.
- **Free-form temporal expressions** other than `Always(InvariantName)` /
  `Eventually(InvariantName)` are not yet unrolled.

---

## 4. Compilation Pipeline

```
.speckdl ──→ AST ──→ IR ──┬→ TypeScript (.ts)      ✓ tested
                          ├→ Z3 (.smt2/.ir.smt2)   ✓ verified with real solver in CI
                          ├→ Rust (crate)          ✓ generated (text-tested)
                          ├→ Protobuf (.proto)     ✓ tested
                          ├→ K8s CRDs (.yaml)      ✓ tested
                          ├→ OpenAPI 3.1 (.json)   ✓ tested
                          ├→ PROV-O (.jsonld)      ✓ tested
                          ├→ CycloneDX (.cdx.json) ✓ tested
                          └→ SPDX (.spdx.json)     ✓ tested
```

Generators consume the IR, not the AST. The IR is complete (every fact in
the spec is in a named facet), lossless (expressions are typed trees, not
strings), resolved (cross-spec references resolved at lower time), and
provenanced (missing provenance is synthesized from file metadata).

### 4.1 Planned Stages (not implemented)

| Stage | Purpose | Status |
|-------|---------|--------|
| Z3 → DST | Decision Structure Trees from satisfiable models | Planned |
| DST → WASM | Semantics-preserving compilation to WebAssembly | Planned |

---

## 5. Dark Provenance and SpeckBOM

The provenance and BOM primitives make intent sources and verification
boundaries explicit in the specification language. They are optional — bare
Specks compile — but are recommended for safety-critical and regulated
systems.

```
speck DrugDosageCalculator {
    provenance {
        regulation "FDA 21 CFR 820.30"
        design_decision "ADR-0017: Separate dose calculation from administration"
        external_doc "RFC 8446" :: "https://www.rfc-editor.org/rfc/rfc8446"
    }
    review: manual
    author: "Scott Scoble" <"scott@scoble.me">
    source: regulation ref "FDA 21 CFR 820.30"

    bom {
        compiler: "speckl-compile" version "0.3.1"
        solver: "z3" version "4.12.5"
        runtime: "wasm-runtime" version "1.0.0"
        license: "MIT"
        hash: "sha256:e3b0c44298fc1c14..."
    }

    derives from BaseHandler via "specialization for dosage"
    satisfies REQ-001 clause "3.2.1"

    input: {
        patientWeight: Real,
        drugConcentration: Real,
        prescribedDose: Real,
        minDose: Real,
        maxDose: Real
    }
    output: { volume: Real, safe: Bool }

    constraint: implies(not safe, volume == 0)
    verify: always(implies(not safe, volume == 0))

    event DoseCalculated { volume: Real, safe: Bool }
}
```

### 5.1 Primitives

| Primitive | Meaning |
|---|---|
| `provenance { regulation: "..." }` | Compliance requirement → `prov:wasInformedBy` |
| `provenance { design_decision: "..." }` | ADR reference → `prov:wasDerivedFrom` |
| `provenance { parent_spec: "..." }` | Decomposition parent → `prov:wasDerivedFrom` |
| `provenance { external_doc: "..." :: "url" }` | External reference |
| `review: manual \| auto \| hybrid` | Verification boundary; `manual` blocks the pipeline without sign-off |
| `derives from X via "rationale"` | `prov:wasDerivedFrom` + rationale |
| `satisfies REQ clause "3.2.1"` | Requirement traceability edge |
| `author: "Name" <"email">` | `prov:wasAttributedTo` agent |
| `source: kind ref "id"` | Intent origin (`conversation`, `meeting`, `document`, `regulation`, `architecture_review`, `threat_model`, `compliance_audit`) |
| `bom { ... }` | Toolchain, license, and content-hash dependencies |

### 5.2 Compilation Manifest: Dual BOM Output

The compiler produces a compilation manifest in **CycloneDX v1.6** and/or
**SPDX 3.0.1** JSON (controlled by `--bom-format cdx|spdx|both`, default
`both`):

| File | Content |
|------|---------|
| `Name.prov.jsonld` | Intent provenance graph (JSON-LD / PROV-O) |
| `Name.specbom.cdx.json` | Composition BOM (CycloneDX) |
| `Name.specbom.spdx.json` | Composition BOM (SPDX) |

The layers are orthogonal: the provenance graph answers *"why does this
constraint exist?"*; the SpeckBOM answers *"what is this spec made of, and
can I reproduce it?"* Together: **intent** (PROV-O) + **composition**
(CycloneDX/SPDX) = **full accountability**.

---

## 6. Tooling

### Reference Compiler

```
speckl-compile <file.speckdl> [options]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `-o, --output-dir <dir>` | Output directory for artifacts | `./out` |
| `-t, --target <t>` | `typescript`, `z3`, `rust`, `protobuf`, `k8s`, `openapi`, `all`, `all-ir` | `typescript` |
| `-d, --verify-depth <n>` | BMC depth for Z3 verification | `10` |
| `-b, --bom-format <f>` | `cdx`, `spdx`, or `both` | `both` |

### Verification Script

```
node scripts/verify-z3.mjs [--examples <dir>] [--depth <n>] [--keep]
```

Environment: `Z3_BIN` (solver path), `SPECKL_BIN` (compiler), `SPECKL_EXAMPLES`.
Exit codes: `0` all verified, `1` failure, `2` z3 not available.

### Planned Tooling

| Tool | Purpose | Status |
|------|---------|--------|
| `speckl-compile` | Reference compiler | Working |
| Z3 verification script | Real-solver verification of example suite | Done |
| `speckl-lsp` | Language Server Protocol (IDE support) | Planned |
| `speckl-playground` | Browser-based spec editor + live verification | Planned |
| `speckl-fmt` | Formatter | Planned |
| `speckl-doc` | Documentation generator from Specks | Planned |

---

*This is a v0.3 specification. Dark Provenance and SpeckBOM primitives are
optional but recommended for safety-critical and regulated systems. Feedback
and contributions are welcome via the
[Speckl repository](https://github.com/wscoble/speckl).*