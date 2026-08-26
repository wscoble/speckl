# SpeckDL Language Specification v0.2

> The specification-first language for auditable software.
> Part of the [Speckl](https://github.com/wscoble/speckl) project. MIT License.

---

## 1. Introduction

SpeckDL is a domain-specific language for defining system behavior and interfaces. A SpeckDL specification (a **Speck**) describes *what* a system should do, not *how* it should do it. Specks compile through a deterministic pipeline — SpeckDL → Z3 → DST → WASM — producing verified artifacts with full dark provenance.

### Design Goals

- **Human-readable first.** A Speck should be understandable by a domain expert who doesn't write code.
- **Machine-verifiable.** Every constraint in a Speck compiles to Z3 (SMT solver) input. Verification is automatic.
- **Provenance-native.** The compilation pipeline records derivation edges automatically. Provenance is not bolted on — it's structural.
- **Composable.** Specks compose via interfaces. Large systems are built from small, verified Specks.
- **Deterministic.** Same input, same output. No LLMs in the compilation path.

---

## 2. Syntax

### 2.1 Top-Level Structure

A SpeckDL file consists of one or more Speck definitions:

```
speck <Name> {
  <members>
}
```

Members are drawn from: `input`, `output`, `constraint`, `verify`, `interface`, `import`, `event`, and the Dark Provenance primitives: `provenance`, `review`, `derives`, `satisfies`, `author`, `source`, and the SpeckBOM primitive: `bom`.

### 2.2 EBNF Grammar

```ebnf
file           = { speck_def | import_stmt }

speck_def      = "speck" IDENT "{" { member } "}"

member         = input_def | output_def | constraint_def
               | verify_def | interface_def | event_def
               | provenance_def | review_def | derives_def
               | satisfies_def | author_def | source_def
               | bom_def

input_def      = "input" ":" type_expr
output_def     = "output" ":" type_expr

type_expr      = primitive | compound | IDENT
primitive      = "Nat" | "Int" | "Real" | "Bool" | "String" | "Bytes"
compound       = "{" { IDENT ":" type_expr [","] } "}"
               | "[" type_expr "]"

constraint_def = "constraint" ":" expr
verify_def     = "verify" ":" temporal_expr

expr           = literal | IDENT | expr op expr | expr "." IDENT
               | func_call | "(" expr ")"
op             = "==" | "!=" | "<=" | ">=" | "<" | ">"
               | "+" | "-" | "*" | "/" | "mod"
               | "and" | "or" | "not" | "implies"
func_call      = IDENT "(" [expr { "," expr }] ")"

temporal_expr  = "always" "(" expr ")"
               | "eventually" "(" expr ")"
               | "implies" "(" expr "," expr ")"

interface_def  = "interface" IDENT "{" { method_sig } "}"
method_sig     = IDENT "(" [ { IDENT ":" type_expr "," } ] ")" ":" type_expr

event_def      = "event" IDENT "{" { IDENT ":" type_expr [","] } "}"

provenance_def = "provenance" "{" { provenance_clause } "}"
provenance_clause = "regulation" ":" STRING
                  | "design_decision" ":" STRING
                  | "parent_spec" ":" IDENT
                  | "external_doc" ":" STRING [ "at" STRING ]

review_def     = "review" ":" review_kind
review_kind    = "manual" | "auto" | "hybrid"

derives_def    = "derives" "from" IDENT [ "via" STRING ]

satisfies_def  = "satisfies" IDENT [ "clause" STRING ]

author_def     = "author" ":" STRING [ "<" STRING ">" ]

source_def     = "source" ":" source_kind [ "ref" STRING ]
source_kind    = "conversation" | "meeting" | "document" | "regulation"
               | "architecture_review" | "threat_model" | "compliance_audit"

bom_def        = "bom" "{" { bom_clause } "}"
bom_clause     = "compiler" ":" STRING ["version" STRING]
               | "solver" ":" STRING ["version" STRING]
               | "runtime" ":" STRING ["version" STRING]
               | "license" ":" STRING
               | "hash" ":" STRING

import_stmt    = "import" STRING ["as" IDENT] ["version" STRING] ["hash" STRING]

literal        = NAT_LIT | INT_LIT | REAL_LIT | BOOL_LIT | STRING_LIT
IDENT          = letter { letter | digit | "_" }
```

### 2.3 Type System

| Type | Meaning | Z3 Mapping |
|------|---------|------------|
| `Nat` | Non-negative integer | `Int` with constraint `>= 0` |
| `Int` | Signed integer | `Int` |
| `Real` | Real number | `Real` |
| `Bool` | Boolean | `Bool` |
| `String` | UTF-8 string | Uninterpreted sort |
| `Bytes` | Byte sequence | Uninterpreted sort |
| `{ ... }` | Record/tuple | Datatype |
| `[T]` | List of T | Seq(T) |

---

## 3. Semantics

### 3.1 Speck Definitions

A Speck defines a behavioral unit with:
- **Inputs:** Typed parameters the Speck accepts.
- **Outputs:** Typed results the Speck produces.
- **Constraints:** Invariants that must hold for all valid inputs and outputs.
- **Verification conditions:** Temporal properties that the Z3 solver must prove.

A Speck is *well-formed* if:
1. All referenced identifiers are in scope.
2. No two constraints are contradictory (Z3 must report SAT for the conjunction of all constraints).
3. All verification conditions are provable from the constraints.

### 3.2 Constraint Semantics

A `constraint` defines an invariant that must hold across all valid executions of the Speck. Constraints are compiled to Z3 assertions:

```
constraint: maxRetries <= 5
```

becomes:

```smt2
(assert (<= maxRetries 5))
```

Constraints are **universally quantified** over all inputs unless explicitly scoped.

### 3.3 Verification Semantics

A `verify` clause defines a property that must be provable from the Speck's constraints:

```
verify: always(implies(attempt > 1, delay > 0))
```

becomes:

```smt2
(assert (=> (> attempt 1) (> delay 0)))
(check-sat)
```

If Z3 returns `UNSAT` when asked to negate a verification condition, the condition is proven. If Z3 returns `SAT`, the Speck contains a counterexample — it can be violated.

### 3.4 Interface Semantics

An interface defines a contract between Specks. A Speck that provides an interface must satisfy all constraints of that interface:

```
interface PaymentProcessor {
  charge(amount: Real, currency: String): Result
  refund(transactionId: Nat): Result
}

speck StripeProcessor {
  interface: PaymentProcessor
  input: { apiKey: String }
  output: Result
  constraint: amount > 0
  constraint: currency in ["USD", "EUR", "GBP"]
}
```

### 3.5 Event Semantics

Events define state transitions that the provenance graph records:

```
event RetryAttempted {
  attemptNumber: Nat
  delay: Real
  remainingRetries: Nat
}
```

Events are emitted during execution and recorded as nodes in the provenance graph. They do not affect the verification pipeline — they exist for observability.

### 3.6 Dark Provenance Semantics

Dark Provenance primitives make intent sources and verification boundaries explicit in the specification language. They compile to JSON-LD provenance graph nodes and edges. These primitives are optional — bare Specks (without any provenance annotations) still compile — but they are recommended for safety-critical and regulated systems.

#### 3.6.1 `provenance` Block Semantics

The `provenance` block declares where a Speck's intent originates:

| Clause | Meaning | JSON-LD Output |
|--------|---------|----------------|
| `regulation: "DO-178C"` | Compliance requirement | `prov:wasInformedBy` → Regulation node |
| `design_decision: "ADR-0017"` | Architecture decision record | `prov:wasDerivedFrom` → Decision node |
| `parent_spec: ParentSpeck` | Decomposition from another Speck | `prov:wasDerivedFrom` → Parent Speck node |
| `external_doc: "RFC 8446" at "https://..."` | External reference | `prov:wasInformedBy` → Document node |

Multiple clauses may appear; each creates a separate provenance edge.

#### 3.6.2 `review` Directive Semantics

The `review` directive marks verification boundaries:

- `review: manual` — Requires human sign-off before deployment. Compiler emits a `ManualReviewRequired` node in the provenance graph.
- `review: auto` — Fully automated verification. No human gate required.
- `review: hybrid` — Automated verification with spot-check sampling. Compiler emits sampling parameters.

Review status is checked at compile time; `manual` Specks without sign-off block the pipeline.

#### 3.6.3 `derives` / `satisfies` Semantics

These primitives create explicit edges in the provenance graph:

**`derives from SpecName via "rationale"`**
- Creates a `prov:wasDerivedFrom` edge from the current Speck to `SpecName`
- Optional `via` clause records the derivation rationale as `rdfs:comment`
- Used for: refactoring, decomposition, specialization

**`satisfies RequirementId clause "3.2.1"`**
- Creates a `speckl:satisfies` edge to a requirement node
- Optional `clause` specifies the exact subsection
- Used for: tracing to regulatory requirements, user stories, specs

#### 3.6.4 `author` / `source` Metadata Semantics

These primitives capture "who" and "why":

**`author: "Name" <"email@example.com">`**
- Binds the Speck to a `prov:Agent` node
- Compiles to `prov:wasAttributedTo` edge
- Optional email used for agent deduplication in the provenance graph

**`source: kind ref "identifier"`**
- Records what drove the creation of this Speck
- `kind`: `conversation`, `meeting`, `document`, `regulation`, `architecture_review`, `threat_model`, `compliance_audit`
- `ref`: Optional identifier (meeting ID, document URL, ticket number)
- Compiles to `prov:wasInformedBy` → Source node with `prov:type`

#### 3.6.5 Provenance-Aware Event Semantics

Events declared with the standard `event` syntax gain provenance edges automatically:

```
event DoseCalculated { volume: Real, safe: Bool }
```

When this event fires at runtime, the provenance graph records:
- The event instance node (`prov:Activity`)
- An edge to the declaring Speck (`prov:wasInformedBy`)
- An edge to the Speck's `provenance` sources (transitive intent tracing)
- An edge to the runtime WASM module that emitted it (`prov:wasGeneratedBy`)

This creates complete audit trails: Event → Speck → Intent Source → Regulatory Requirement.

#### 3.6.6 SpeckBOM: Bill of Materials

A **SpeckBOM** is the specification analog of a Software Bill of Materials (SBOM). Where an SBOM lists software components, versions, and licenses, a SpeckBOM lists the complete dependency and artifact tree for a Speck system.

The `bom` block declares **toolchain dependencies** — what compiler, solver, and runtime a Speck requires. Combined with `import`, `derives`, and `satisfies`, it provides a full bill of materials:

| SpeckBOM concern | SpeckDL primitive | What it captures |
|---|---|---|
| **Spec dependencies** | `import` | Which other Specks this one depends on (with content hashes) |
| **Toolchain** | `bom { compiler, solver, runtime }` | What tools produced the verified artifacts |
| **Intent lineage** | `derives from`, `satisfies` | Which specs/requirements this one traces to |
| **Authorship** | `author`, `source` | Who wrote it and what drove it |
| **Artifact hashes** | `bom { hash }` | Content hash of the Speck source itself |
| **License** | `bom { license }` | Under what terms this spec can be used |
| **Compilation output** | *(auto-generated)* | Z3, DST, WASM hashes and solver results (see §4.5) |

**Why this matters.** In regulated environments (DO-178C, IEC 62304), an auditor needs to know not just "what code runs" but "what was the complete chain from requirement to deployed artifact." The SpeckBOM answers this declaratively — it's machine-readable, hash-pinned, and queriable.

**Example:**

```
speck DrugDosageCalculator {
  bom {
    compiler: "speckl-compile" version "0.2.0"
    solver: "z3" version "4.12.5"
    runtime: "wasm-runtime" version "1.0.0"
    license: "MIT"
    hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }

  import "retry-handler.speckdl" as retry
  ...
}
```

#### 3.6.7 Import Version Pinning

The `import` statement supports optional `version` and `hash` fields for reproducible builds:

```
import "retry-handler.speckdl" as retry
  version "1.2.0"
  hash "sha256:abcdef1234567890..."
```

- **`version`**: Semantic version of the imported Speck. The compiler verifies the imported file declares this version in its `bom` block.
- **`hash`**: Content hash of the imported file. The compiler computes the hash at parse time and fails if it doesn't match.

Version pinning is optional for local development but required for Specks with `review: manual` or `review: hybrid` — the compiler enforces that all imports are hash-pinned before allowing manual review sign-off.

---

## 4. Compilation Pipeline

### 4.1 Stage 1: SpeckDL → Z3

Each Speck is compiled to SMT-LIB2 format:

1. Type declarations become Z3 sort declarations.
2. Input/output declarations become Z3 constants.
3. Constraints become `assert` statements.
4. Verification conditions become `check-sat` queries.

The compiler checks for:
- **Contradictory constraints:** If the conjunction of all constraints is UNSAT, the Speck is impossible to implement.
- **Unsatisfiable verification conditions:** If a verify clause can be violated, the compiler reports the counterexample.

### 4.2 Stage 2: Z3 → DST (Decision Structures)

When Z3 reports SAT for a Speck, the model (assignment of values satisfying all constraints) is compiled into a **Decision Structure Tree**:

```
DSTNode {
  condition: expr       // branching predicate
  if_true: DSTNode      // subtree when condition holds
  if_false: DSTNode     // subtree when condition doesn't hold
  result: value?        // leaf value (if terminal)
}
```

A DST represents the complete behavioral space of a verified Speck. Every possible input maps to exactly one path through the DST, terminating at a leaf with the verified output.

### 4.3 Stage 3: DST → WASM

DSTs compile to WebAssembly via a direct translation:

- Each DST node becomes a `br_if` / `br` instruction pair.
- Leaf values become `i32.const`, `f64.const`, or structured return values.
- The resulting WASM module exports a single function matching the Speck's input/output signature.

This compilation is *semantics-preserving by construction*: the WASM module implements exactly the behaviors encoded in the DST, which represents exactly the satisfiable space of the Speck.

### 4.4 Provenance Graph Construction

At each compilation stage, the pipeline records derivation edges:

```
Speck "RetryHandler"
  ├── compiled_to → Z3 assertion set (sha256:abc...)
  ├── verified_by → Z3 result: SAT
  ├── compiled_to → DST (sha256:def...)
  ├── compiled_to → WASM module (sha256:789...)
  └── provenance: {
        author: "scott",
        timestamp: "2026-04-28T09:00:00Z",
        tool: "speckl-compiler v0.2",
        z3_version: "4.12.5"
      }
```

The provenance graph is serialized as **JSON-LD using the W3C PROV-O vocabulary** and stored alongside the compiled artifacts.

#### 4.4.1 PROV-O Namespace and Context

The JSON-LD output uses the standard PROV-O namespace:

```json
{
  "@context": {
    "prov": "http://www.w3.org/ns/prov#",
    "speckl": "https://speckl.scoble.me/ns/v0.2#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
  }
}
```

#### 4.4.2 Provenance Node Types

| Node Type | PROV-O Class | Description |
|-----------|---------------|-------------|
| Speck | `prov:Entity` | The specification itself |
| Z3 Assertion Set | `prov:Entity` | Compiled SMT-LIB2 |
| DST | `prov:Entity` | Decision structure tree |
| WASM Module | `prov:Entity` | Compiled binary |
| Z3 Solver | `prov:Agent` | The verification tool |
| Compiler | `prov:Agent` | The compilation tool |
| Compilation Act | `prov:Activity` | A compilation stage |
| Author | `prov:Agent` | Person (from `author` primitive) |
| Source | `prov:Activity` | Intent origin (from `source` primitive) |
| Regulation | `prov:Entity` | Compliance requirement |
| Design Decision | `prov:Entity` | Architecture decision record |

#### 4.4.3 Provenance Edge Types

| Edge | PROV-O Property | From → To |
|------|-----------------|-----------|
| Compiled to | `prov:wasGeneratedBy` | Artifact → Compilation Act |
| Used tool | `prov:used` | Compilation Act → Tool (Agent) |
| Derived from | `prov:wasDerivedFrom` | Speck → Parent Speck |
| Informed by | `prov:wasInformedBy` | Speck → Regulation / Source |
| Attributed to | `prov:wasAttributedTo` | Speck → Author |
| Satisfies | `speckl:satisfies` | Speck → Requirement |

### 4.5 Compilation Manifest: Dual BOM Output

The compiler produces a **compilation manifest** containing both provenance and bill-of-materials data. The manifest supports two output formats:

- **CycloneDX v1.6** (JSON) — OWASP standard, ECMA-424
- **SPDX 3.0.1** (JSON-LD) — ISO 5962:2023

The `--bom-format` flag controls output: `cdx`, `spdx`, or `both` (default: `both`).

#### 4.5.1 Output Files

For a Speck named `Name`, the compiler produces:

| File | Format | Content |
|------|--------|---------|
| `Name.prov.jsonld` | JSON-LD / PROV-O | Intent provenance graph |
| `Name.specbom.cdx.json` | CycloneDX v1.6 JSON | Composition BOM (CycloneDX) |
| `Name.specbom.spdx.json` | SPDX 3.0.1 JSON-LD | Composition BOM (SPDX) |

#### 4.5.2 CycloneDX v1.6 Mapping

| SpeckDL Primitive | CycloneDX Location | Field |
|---|---|---|
| `bom { compiler }`, `bom { solver }`, `bom { runtime }` | `metadata.tools[]` | Standard tool entries |
| `bom { license }` | `metadata.component.licenses[]` | SPDX expression |
| `bom { hash }` | `metadata.component.hashes[]` | SHA-256 |
| `import "X" as Y hash H version V` | `components[]` | Component entry with purl, hashes, properties |
| `derives from X` | `component.properties[]` | `speckl:derivesFrom` |
| `satisfies X clause Y` | `component.properties[]` | `speckl:satisfies` |
| `author: Name <email>` | `annotations[]` | `speckl:provenanceType: author` |
| `source: kind ref X` | `annotations[]` | `speckl:provenanceType: source` |
| `provenance { regulation: X }` | `annotations[]` | `speckl:provenanceType: regulation` |
| `review: manual` | `annotations[]` | `speckl:reviewType: manual` |
| `review: auto` | No additional annotation | N/A |
| `review: hybrid` | `annotations[]` | `speckl:reviewType: hybrid` |
| Compilation artifacts (Z3, DST, WASM) | `components[]` (nested) | Type + hash |
| Verification results (SAT/UNSAT) | `metadata.component.properties[]` | `speckl:verificationResult` |
| Reproducibility status | `metadata.component.properties[]` | `speckl:reproducible` |

#### 4.5.3 SPDX 3.0.1 Mapping

| SpeckDL Primitive | SPDX Location | Field |
|---|---|---|
| `bom { compiler }`, `bom { solver }`, `bom { runtime }` | `spdx:Build` (in `builtBy`) | Tool name + version |
| `bom { license }` | `spdx:licenseConcluded` | SPDX expression (native) |
| `bom { hash }` | `spdx:hash` | SHA-256 |
| `import "X" hash H version V` | `spdx:Software` element | Package with version + hash |
| `derives from X` | `spdx:Relationship` (derivesFrom) | Standard SPDX relationship |
| `satisfies X clause Y` | `speckl:satisfies` property | Extension on element |
| `author: Name <email>` | `spdx:Relationship` (wasAttributedTo) | Agent element |
| `source: kind ref X` | `spdx:Relationship` (wasInformedBy) | Activity element |
| `provenance { regulation: X }` | `spdx:Relationship` + element | Regulation node |
| `review: manual` | `spdx:Annotation` (REVIEW) | Standard annotation |
| `review: auto` | No additional annotation | N/A |
| `review: hybrid` | `spdx:Annotation` (REVIEW) | `speckl:reviewType: hybrid` |
| Compilation artifacts (Z3, DST, WASM) | `spdx:SoftwareArtifact` elements | With hashes |
| Verification results (SAT/UNSAT) | `speckl:verificationResult` | Extension property |
| Reproducibility status | `speckl:reproducible` | Extension property |

#### 4.5.4 Two-Layer Architecture

Speckl produces **three complementary outputs**:

| Layer | Format | Concern | Standard |
|---|---|---|---|
| **Intent provenance** | JSON-LD / PROV-O | Who, why, what drove this specification | W3C PROV-O |
| **Composition BOM (CycloneDX)** | CycloneDX v1.6 JSON | What this spec depends on, builds with, produces | OWASP CycloneDX (ECMA-424) |
| **Composition BOM (SPDX)** | SPDX 3.0.1 JSON-LD | Same composition data, ISO-normative format | ISO 5962:2023 |

These layers are orthogonal:
- The provenance graph answers *"Why does this constraint exist?"* (regulatory, design decision, conversation)
- The SpeckBOM answers *"What is this spec made of, and can I reproduce it?"* (dependencies, toolchain, artifacts)

Together they form the complete audit trail: **intent** (PROV-O) + **composition** (CycloneDX or SPDX) = **full accountability**.

---

## 5. Examples

### 5.1 Simple: API Rate Limiter

```
speck RateLimiter {
  input: { requests: [Request], window: Nat, maxRequests: Nat }
  output: { allowed: [Bool], remaining: Nat }
  constraint: maxRequests > 0
  constraint: window > 0
  constraint: count(allowed, true) <= maxRequests
  constraint: remaining == maxRequests - count(allowed, true)
  verify: always(implies(remaining == 0, not(allowed[current])))
}
```

### 5.2 Medium: Data Pipeline with Constraints

```
speck ETLTransform {
  input: { source: DataSource, schema: Schema, dedup: Bool }
  output: { result: Dataset, rejected: Nat }
  constraint: result.schema == schema
  constraint: rejected >= 0
  constraint: implies(dedup, count(result) <= count(source))
  constraint: implies(not dedup, count(result) == count(source))
  verify: always(implies(dedup, no_duplicates(result)))
}
```

### 5.3 Complex: Regulated Medical Device Function

```
speck DrugDosageCalculator {
  provenance {
    regulation: "FDA 21 CFR 820.30"
    regulation: "IEC 62304 Class C"
    design_decision: "ADR-0017: Separate dose calculation from administration"
  }
  review: manual
  author: "Scott Scoble" <"scott@scoble.me">
  source: regulation ref "FDA 21 CFR 820.30"

  bom {
    compiler: "speckl-compile" version "0.2.0"
    solver: "z3" version "4.12.5"
    runtime: "wasm-runtime" version "1.0.0"
    license: "MIT"
    hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }

  input: {
    patientWeight: Real,
    drugConcentration: Real,
    prescribedDose: Real,
    minDose: Real,
    maxDose: Real,
    frequency: Nat
  }
  output: {
    volume: Real,
    safe: Bool
  }
  constraint: patientWeight > 0
  constraint: drugConcentration > 0
  constraint: minDose > 0
  constraint: maxDose > minDose
  constraint: frequency >= 1
  constraint: frequency <= 6
  constraint: implies(safe, volume >= minDose / drugConcentration)
  constraint: implies(safe, volume <= maxDose / drugConcentration)
  constraint: implies(not safe, volume == 0)
  verify: always(implies(
    prescribedDose >= minDose and prescribedDose <= maxDose,
    safe
  ))
  verify: always(implies(not safe, volume == 0))
  event DoseCalculated { volume: Real, safe: Bool }
  event DoseRejected { reason: String }
}
```

### 5.4 Edge: Self-Referential Spec

```
speck SpeckValidator {
  input: { spec: SpeckDefinition, references: [SpeckDefinition] }
  output: { valid: Bool, errors: [String] }
  constraint: implies(valid, count(errors) == 0)
  constraint: implies(not valid, count(errors) > 0)
  constraint: forall(ref in references, ref.is_well_formed)
  verify: always(implies(
    spec.is_well_formed and forall(r in references, r.is_well_formed),
    valid
  ))
}
```

### 5.5 Composed: Multi-Speck System with Import Pinning

```
speck PaymentService {
  import "rate-limiter.speckdl" as limiter
    version "1.0.0"
    hash "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  import "retry-handler.speckdl" as retry
    version "2.1.0"
    hash "sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"

  provenance {
    regulation: "PCI DSS 4.0 Requirement 6"
    design_decision: "ADR-0022: Payment isolation with rate limiting"
  }
  review: hybrid
  author: "Scott Scoble" <"scott@scoble.me">
  source: compliance_audit ref "PCI-DSS-AUDIT-2026-Q2"

  bom {
    compiler: "speckl-compile" version "0.2.0"
    solver: "z3" version "4.12.5"
    runtime: "wasm-runtime" version "1.0.0"
    license: "MIT"
    hash: "sha256:9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef"
  }

  input: { payment: Payment, apiKey: String }
  output: Result

  constraint: limiter.maxRequests == 100
  constraint: limiter.window == 60
  constraint: retry.maxRetries == 3
  constraint: implies(not limiter.allowed, output == RateLimited)
  constraint: implies(limiter.allowed, output in [Success, Failed, RetryExhausted])

  verify: always(implies(
    limiter.remaining == 0,
    output == RateLimited
  ))
}
```

---

## 6. Tooling

### Reference Compiler

The reference compiler (`speckl-compile`) is a Node.js/TypeScript application that:

1. Parses SpeckDL files into an AST.
2. Type-checks the AST against the type system defined in §3.
3. Compiles constraints and verification conditions to SMT-LIB2.
4. Invokes Z3 and interprets results.
5. Compiles verified models to DSTs.
6. Compiles DSTs to WASM.
7. Emits provenance graph metadata (JSON-LD / PROV-O) at each stage.
8. Emits SpeckBOM (CycloneDX v1.6 and/or SPDX 3.0.1) per §4.5.

### CLI

```
speckl-compile <file.speckdl> --output-dir <dir> --bom-format <cdx|spdx|both>
```

- `--output-dir`: Directory for output artifacts (default: `./out`)
- `--bom-format`: BOM output format — `cdx` (CycloneDX), `spdx` (SPDX), or `both` (default: `both`)

### Planned Tooling

| Tool | Purpose | Status |
|------|---------|--------|
| `speckl-compile` | Reference compiler | In progress |
| `speckl-lsp` | Language Server Protocol (IDE support) | Planned |
| `speckl-playground` | Browser-based spec editor + live verification | Planned |
| `speckl-fmt` | Formatter | Planned |
| `speckl-doc` | Documentation generator from Specks | Planned |

---

## Appendix A: Z3 Mapping Reference

| SpeckDL Construct | SMT-LIB2 |
|---|---|
| `Nat n` | `(declare-const n Int)` + `(assert (>= n 0))` |
| `Int n` | `(declare-const n Int)` |
| `Real r` | `(declare-const r Real)` |
| `Bool b` | `(declare-const b Bool)` |
| `constraint: e` | `(assert e)` |
| `verify: always(e)` | `(assert (not e))` + `(check-sat)` — expect UNSAT |
| `verify: eventually(e)` | Not directly expressible; requires bounded model checking |
| `a == b` | `(= a b)` |
| `a implies b` | `(=> a b)` |
| `a and b` | `(and a b)` |
| `forall(x in S, e)` | `(forall ((x T)) (=> (member x S) e))` |

---

## Appendix B: Provenance and BOM Reference Mappings

### B.1 PROV-O JSON-LD Reference

| SpeckDL Primitive | PROV-O Class/Property | JSON-LD Key |
|---|---|---|
| `provenance { regulation: X }` | `prov:wasInformedBy` → `prov:Entity` (type: Regulation) | `wasInformedBy` |
| `provenance { design_decision: X }` | `prov:wasDerivedFrom` → `prov:Entity` (type: DesignDecision) | `wasDerivedFrom` |
| `provenance { parent_spec: X }` | `prov:wasDerivedFrom` → `prov:Entity` (type: Speck) | `wasDerivedFrom` |
| `provenance { external_doc: X }` | `prov:wasInformedBy` → `prov:Entity` (type: Document) | `wasInformedBy` |
| `author: Name <email>` | `prov:wasAttributedTo` → `prov:Agent` | `wasAttributedTo` |
| `source: kind ref X` | `prov:wasInformedBy` → `prov:Activity` (type: kind) | `wasInformedBy` |
| `derives from X via Y` | `prov:wasDerivedFrom` + `rdfs:comment` | `wasDerivedFrom`, `comment` |
| `satisfies X clause Y` | `speckl:satisfies` → `prov:Entity` | `speckl:satisfies` |
| `review: manual` | `prov:Activity` (type: ManualReview) | `speckl:reviewType` |
| `review: auto` | *(no node)* | N/A |
| `review: hybrid` | `prov:Activity` (type: HybridReview) | `speckl:reviewType` |

### B.2 SpeckBOM — CycloneDX v1.6

| SpeckDL Primitive | CycloneDX Location | Field |
|---|---|---|
| `bom { compiler }`, `bom { solver }`, `bom { runtime }` | `metadata.tools[]` | Standard tool entries |
| `bom { license }` | `metadata.component.licenses[]` | SPDX expression |
| `bom { hash }` | `metadata.component.hashes[]` | SHA-256 |
| `import "X" as Y hash H version V` | `components[]` | Component entry with purl, hashes, properties |
| `derives from X` | `component.properties[]` | `speckl:derivesFrom` |
| `satisfies X clause Y` | `component.properties[]` | `speckl:satisfies` |
| `author: Name <email>` | `annotations[]` | `speckl:provenanceType: author` |
| `source: kind ref X` | `annotations[]` | `speckl:provenanceType: source` |
| `provenance { regulation: X }` | `annotations[]` | `speckl:provenanceType: regulation` |
| `review: manual` | `annotations[]` | `speckl:reviewType: manual` |
| `review: auto` | No additional annotation | N/A |
| `review: hybrid` | `annotations[]` | `speckl:reviewType: hybrid` |
| Compilation artifacts (Z3, DST, WASM) | `components[]` (nested) | Type + hash |
| Verification results (SAT/UNSAT) | `metadata.component.properties[]` | `speckl:verificationResult` |
| Reproducibility status | `metadata.component.properties[]` | `speckl:reproducible` |

### B.3 SpeckBOM — SPDX 3.0.1

| SpeckDL Primitive | SPDX Location | Field |
|---|---|---|
| `bom { compiler }`, `bom { solver }`, `bom { runtime }` | `spdx:Build` (in `builtBy`) | Tool name + version |
| `bom { license }` | `spdx:licenseConcluded` | SPDX expression (native) |
| `bom { hash }` | `spdx:hash` | SHA-256 |
| `import "X" hash H version V` | `spdx:Software` element | Package with version + hash |
| `derives from X` | `spdx:Relationship` (derivesFrom) | Standard SPDX relationship |
| `satisfies X clause Y` | `speckl:satisfies` property | Extension on element |
| `author: Name <email>` | `spdx:Relationship` (wasAttributedTo) | Agent element |
| `source: kind ref X` | `spdx:Relationship` (wasInformedBy) | Activity element |
| `provenance { regulation: X }` | `spdx:Relationship` + element | Regulation node |
| `review: manual` | `spdx:Annotation` (REVIEW) | Standard annotation |
| `review: auto` | No additional annotation | N/A |
| `review: hybrid` | `spdx:Annotation` (REVIEW) | `speckl:reviewType: hybrid` |
| Compilation artifacts (Z3, DST, WASM) | `spdx:SoftwareArtifact` elements | With hashes |
| Verification results (SAT/UNSAT) | `speckl:verificationResult` | Extension property |
| Reproducibility status | `speckl:reproducible` | Extension property |

### B.4 Two-Layer Architecture

| Layer | Format | Concern | Standard |
|---|---|---|---|
| **Intent provenance** | JSON-LD / PROV-O | Who, why, what drove this specification | W3C PROV-O |
| **Composition BOM (CycloneDX)** | CycloneDX v1.6 JSON | Dependencies, toolchain, artifacts | OWASP CycloneDX (ECMA-424) |
| **Composition BOM (SPDX)** | SPDX 3.0.1 JSON-LD | Same data, ISO-normative format | ISO 5962:2023 |

---

*This is a v0.2 specification. Dark Provenance and SpeckBOM primitives are optional but recommended for safety-critical and regulated systems. Feedback and contributions are welcome via the [Speckl repository](https://github.com/wscoble/speckl).*