# SpeckDL Language Specification v0.2-DP

> The specification-first language for auditable software.
> **This version adds Dark Provenance primitives (`provenance`, `review`, `derives`, `satisfies`, `author`, `source`), SpeckBOM (`bom` + import pinning), and dual-output BOM format (CycloneDX v1.6 + SPDX 3.0.1).**
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

Members are drawn from: `input`, `output`, `constraint`, `verify`, `interface`, `import`, `event`, **Dark Provenance primitives**: `provenance`, `review`, `derives`, `satisfies`, `author`, `source`, and **SpeckBOM primitives**: `bom`.

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

import_stmt    = "import" STRING ["as" IDENT]

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

---

## 3.6 Dark Provenance Semantics (NEW)

Dark Provenance primitives make intent sources and verification boundaries explicit in the specification language. They compile to JSON-LD provenance graph nodes and edges.

### 3.6.1 `provenance` Block Semantics

The `provenance` block declares where a Speck's intent originates:

| Clause | Meaning | JSON-LD Output |
|--------|---------|----------------|
| `regulation: "DO-178C"` | Compliance requirement | `prov:wasInformedBy` → Regulation node |
| `design_decision: "ADR-0017"` | Architecture decision record | `prov:wasDerivedFrom` → Decision node |
| `parent_spec: ParentSpeck` | Decomposition from another Speck | `prov:wasDerivedFrom` → Parent Speck node |
| `external_doc: "RFC 8446" at "https://..."` | External reference | `prov:wasInformedBy` → Document node |

Multiple clauses may appear; each creates a separate provenance edge.

### 3.6.2 `review` Directive Semantics

The `review` directive marks verification boundaries:

- `review: manual` — Requires human sign-off before deployment. Compiler emits a `ManualReviewRequired` node in the provenance graph.
- `review: auto` — Fully automated verification. No human gate required.
- `review: hybrid` — Automated verification with spot-check sampling. Compiler emits sampling parameters.

Review status is checked at compile time; `manual` Specks without sign-off block the pipeline.

### 3.6.3 `derives` / `satisfies` Semantics

These primitives create explicit edges in the provenance graph:

**`derives from SpecName via "rationale"`**
- Creates a `prov:wasDerivedFrom` edge from the current Speck to `SpecName`
- Optional `via` clause records the derivation rationale as `rdfs:comment`
- Used for: refactoring, decomposition, specialization

**`satisfies RequirementId clause "3.2.1"`**
- Creates a `speckl:satisfies` edge to a requirement node
- Optional `clause` specifies the exact subsection
- Used for: tracing to regulatory requirements, user stories, specs

### 3.6.4 `author` / `source` Metadata Semantics

These primitives capture "who" and "why":

**`author: "Name" <"email@example.com">`**
- Binds the Speck to an `prov:Agent` node
- Compiles to `prov:wasAttributedTo` edge
- Optional email used for agent deduplication in the provenance graph

**`source: kind ref "identifier"`**
- Records what drove the creation of this Speck
- `kind`: `conversation`, `meeting`, `document`, `regulation`, `architecture_review`, `threat_model`, `compliance_audit`
- `ref`: Optional identifier (meeting ID, document URL, ticket number)
- Compiles to `prov:wasInformedBy` → Source node with `prov:type`

### 3.6.5 Provenance-Aware Event Semantics

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

### 3.6.6 SpeckBOM: Bill of Materials

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

  import "retry-handler.speck" as retry

  // ... constraints, verify, provenance, etc.
}
```

The `bom` block is **declarative** — it says what the spec *expects* from its toolchain. At compile time, the compiler verifies that the declared versions match the actual versions used, and the compilation manifest (§4.5) records any discrepancies.

### 3.6.7 Import Version Pinning

The existing `import` statement includes a file path but no version or content hash. For SpeckBOM completeness, imports are extended to support version pinning:

```
import "retry-handler.speck" as retry
  hash: "sha256:a1b2c3..."
  version: "1.2.0"
```

The `hash` is checked at compile time against the content of the imported file. If the hash doesn't match, compilation fails with a dependency integrity error. The `version` is informational but must match a version declared in the imported Speck's `bom` block.

Import version pinning makes SpeckBOMs **reproducible**: given the same source files and toolchain versions, compilation produces bit-identical artifacts.

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

### 4.4 Provenance Graph Construction (UPDATED)

At each compilation stage, the pipeline records derivation edges. **Dark Provenance primitives** in the SpeckDL source generate explicit provenance nodes and edges:

```
Speck "RetryHandler"
  ├── compiled_to → Z3 assertion set (sha256:abc...)
  ├── verified_by → Z3 result: SAT
  ├── compiled_to → DST (sha256:def...)
  ├── compiled_to → WASM module (sha256:789...)
  ├── **provenance: {**
  │     **regulation: "ISO 26262-6"**
  │     **design_decision: "ADR-0042"**
  │     **parent_spec: "FaultHandler"**
  │     **author: "scott"**
  │     **source: conversation ref "slack://C123/456"**
  │     **review: manual**
  │     **derives_from: "FaultHandler"**
  │     **satisfies: "ASIL-D-REQ-17"**
  │   **}**
  ├── **attributed_to → Agent("scott")**
  ├── **wasDerivedFrom → Speck("FaultHandler")**
  ├── **satisfies → Requirement("ASIL-D-REQ-17")**
  ├── **wasInformedBy → Regulation("ISO 26262-6")**
  ├── **wasInformedBy → Decision("ADR-0042")**
  └── **requiresReview → ManualReviewRequired**
```

The provenance graph is serialized as JSON-LD and stored alongside the compiled artifacts.

**Dark Provenance JSON-LD Output:**

```json
{
  "@context": {
    "prov": "http://www.w3.org/ns/prov#",
    "speckl": "https://wscoble.github.io/speckl/ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
  },
  "@id": "speck:RetryHandler",
  "@type": "speckl:Speck",
  "prov:wasAttributedTo": {
    "@id": "agent:scott",
    "@type": "prov:Agent",
    "rdfs:label": "scott"
  },
  "prov:wasInformedBy": [
    { "@id": "reg:ISO-26262-6", "@type": "speckl:Regulation" },
    { "@id": "decision:ADR-0042", "@type": "speckl:DesignDecision" },
    { "@id": "conv:slack-C123-456", "@type": "speckl:Conversation" }
  ],
  "prov:wasDerivedFrom": { "@id": "speck:FaultHandler" },
  "speckl:satisfies": {
    "@id": "req:ASIL-D-REQ-17",
    "speckl:clause": "4.3.2"
  },
  "speckl:reviewRequired": {
    "@type": "speckl:ManualReview",
    "speckl:status": "pending"
  }
}
```

### 4.5 Compilation Manifest (SpeckBOM Output)

At compile time, the compiler produces a **SpeckBOM** — a specification-level bill of materials. The Speckl compiler supports **two output formats**:

| Format | Standard | Best for |
|---|---|---|
| **CycloneDX v1.6 JSON** | OWASP / ECMA-424 | Security tooling (Dependency-Track, OWASP ecosystem), BOM-type extensibility |
| **SPDX 3.0.1 JSON-LD** | ISO 5962:2023 | Regulated industries (DO-178C, IEC 62304), audit compliance, semantic web tooling |

Both formats capture the same information. The choice depends on downstream tooling and regulatory context. Neither CycloneDX nor SPDX currently defines a **specification-level BOM type** — SpeckBOM (`specBOM`) fills this gap.

#### Why Both Standards

| Concern | CycloneDX v1.6 | SPDX 3.0.1 |
|---|---|---|
| Component inventory | `components[]` | `Package` + `SoftwareArtifact` |
| Dependency graph | `dependencies[]` | `Relationship` (dependsOn, prerequisite) |
| Toolchain provenance | `metadata.tools[]` | `Build` profile (from SLSA integration) |
| Content integrity | `hashes[]` on components | `hash` + `verificationCode` on Packages |
| Attestations | CycloneDX Attestations (CDXA) | `Element` + `Relationship` (attest) |
| Citations/annotations | `annotations[]` | `Annotation` class |
| Cross-BOM linking | BOM-Link | `ExternalDocumentRef` + `SpdxDocument` |
| Extensibility | `properties[]` with namespace | `Extension` + `Property` |
| Licensing | `licenses[]` (SPDX expressions) | Native (SPDX is the license standard) |
| Normative status | OWASP community standard, ECMA-424 | ISO 5962:2023 (international standard) |
| BOM type taxonomy | SBOM, HBOM, MBOM, OBOM, AI-BOM, CBOM | Software-focused, profiles for AI, security, build |
| Provenance model | Properties + annotations | Native PROV-O alignment (JSON-LD) |

CycloneDX offers a richer BOM type taxonomy (making `specBOM` a natural addition) and a simpler extension model. SPDX offers native JSON-LD, ISO standard status, and tighter PROV-O alignment — critical for regulated environments where auditors expect ISO-normative formats.

#### CycloneDX Output Format

The compiler emits a valid CycloneDX v1.6 JSON document with `bomType: specBOM` and `speckl:` property extensions:

#### Output Format

The compiler emits a single CycloneDX JSON document per Speck:

```json
{
  "$schema": "https://cyclonedx.org/schema/bom-1.6.schema.json",
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "bomType": "specBOM",
  "serialNumber": "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",

  "metadata": {
    "timestamp": "2026-04-28T16:00:00Z",
    "component": {
      "type": "application",
      "name": "DrugDosageCalculator",
      "version": "1.0.0",
      "purl": "pkg:speckl/DrugDosageCalculator@1.0.0",
      "hashes": [
        { "alg": "SHA-256", "content": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
      ],
      "licenses": [{ "expression": "MIT" }],
      "properties": [
        { "name": "speckl:reproducible", "value": "true" },
        { "name": "speckl:verificationResult", "value": "SAT" }
      ]
    },
    "tools": [
      { "name": "speckl-compile", "version": "0.2.0" },
      { "name": "z3", "version": "4.12.5" },
      { "name": "wasm-runtime", "version": "1.0.0" }
    ]
  },

  "components": [
    {
      "type": "library",
      "name": "RetryHandler",
      "version": "1.2.0",
      "purl": "pkg:speckl/RetryHandler@1.2.0",
      "hashes": [
        { "alg": "SHA-256", "content": "a1b2c3..." }
      ],
      "properties": [
        { "name": "speckl:importAlias", "value": "retry" },
        { "name": "speckl:integrity", "value": "verified" },
        { "name": "speckl:derivesFrom", "value": "pkg:speckl/FaultHandler@2.0.0" },
        { "name": "speckl:satisfies", "value": "REQ-ASYNC-001" }
      ]
    }
  ],

  "dependencies": [
    {
      "ref": "pkg:speckl/DrugDosageCalculator@1.0.0",
      "dependsOn": ["pkg:speckl/RetryHandler@1.2.0"]
    }
  ],

  "annotations": [
    {
      "bomRef": "provenance-regulation",
      "subjects": ["pkg:speckl/DrugDosageCalculator@1.0.0"],
      "text": "FDA 21 CFR 820.30",
      "properties": [
        { "name": "speckl:provenanceType", "value": "regulation" }
      ]
    },
    {
      "bomRef": "provenance-author",
      "subjects": ["pkg:speckl/DrugDosageCalculator@1.0.0"],
      "text": "Dr. Sarah Chen",
      "properties": [
        { "name": "speckl:provenanceType", "value": "author" },
        { "name": "speckl:authorEmail", "value": "s.chen@meddevice.example" }
      ]
    },
    {
      "bomRef": "review-requirement",
      "subjects": ["pkg:speckl/DrugDosageCalculator@1.0.0"],
      "text": "Manual review required before deployment",
      "properties": [
        { "name": "speckl:reviewType", "value": "manual" },
        { "name": "speckl:reviewStatus", "value": "pending" }
      ]
    }
  ]
}
```

The manifest includes:
- **Spec hash** — verified against the `bom { hash }` declaration
- **Dependency integrity** — all `import` hashes verified
- **Toolchain versions** — actual versions used, flagged if they differ from `bom` declarations
- **Artifact hashes** — Z3 output, DST, and WASM module hashes
- **Verification results** — SAT/UNSAT for each verify clause
- **Reproducibility flag** — `true` only if all toolchain versions match declarations and all imports hash-verify

An auditor can:
1. Verify the spec hash matches the source file
2. Verify all dependency hashes match their imports
3. Verify toolchain versions match the declared ones
4. Re-run compilation and verify artifact hashes match
5. Load the SpeckBOM into any CycloneDX-compatible tool (Dependency-Track, OWASP ecosystem)

#### CycloneDX Field Mapping

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
| Compilation artifacts (Z3, DST, WASM) | `components[]` (nested) | Type + hash |
| Verification results (SAT/UNSAT) | `metadata.component.properties[]` | `speckl:verificationResult` |
| Reproducibility status | `metadata.component.properties[]` | `speckl:reproducible` |

#### SPDX 3.0.1 Output Format

The compiler also emits a valid SPDX 3.0.1 JSON-LD document using the SPDX `Sbom` class with `speckl:` extension properties. This format aligns with ISO 5962:2023 and is preferred for regulated environments:

```json
{
  "@context": [
    "https://spdx.github.io/spdx-spec/v3.0.1/context.jsonld",
    {
      "speckl": "https://wscoble.github.io/speckl/ns#"
    }
  ],
  "@id": "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  "@type": ["spdx:Sbom", "speckl:SpecBOM"],
  "spdx:element": [
    {
      "@id": "speckl:DrugDosageCalculator-1.0.0",
      "@type": "spdx:Software",
      "spdx:name": "DrugDosageCalculator",
      "spdx:softwareVersion": "1.0.0",
      "spdx:packageVersion": "1.0.0",
      "spdx:downloadLocation": "pkg:speckl/DrugDosageCalculator@1.0.0",
      "spdx:hash": { "@type": "spdx:Hash", "spdx:algorithm": "sha256", "spdx:hashValue": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      "spdx:licenseConcluded": "MIT",
      "speckl:verificationResult": "SAT",
      "speckl:reproducible": true,
      "spdx:builtBy": [
        { "@type": "spdx:Build", "spdx:buildType": "speckl:compile", "speckl:toolVersion": "0.2.0" },
        { "@type": "spdx:Build", "spdx:buildType": "speckl:solve", "speckl:toolVersion": "4.12.5" },
        { "@type": "spdx:Build", "spdx:buildType": "speckl:runtime", "speckl:toolVersion": "1.0.0" }
      ]
    },
    {
      "@id": "speckl:RetryHandler-1.2.0",
      "@type": "spdx:Software",
      "spdx:name": "RetryHandler",
      "spdx:softwareVersion": "1.2.0",
      "spdx:downloadLocation": "pkg:speckl/RetryHandler@1.2.0",
      "spdx:hash": { "@type": "spdx:Hash", "spdx:algorithm": "sha256", "spdx:hashValue": "a1b2c3..." },
      "speckl:integrity": "verified",
      "speckl:derivesFrom": "speckl:FaultHandler-2.0.0",
      "speckl:satisfies": "REQ-ASYNC-001"
    }
  ],
  "spdx:relationship": [
    {
      "@type": "spdx:Relationship",
      "spdx:from": "speckl:DrugDosageCalculator-1.0.0",
      "spdx:relationshipType": "spdx:dependsOn",
      "spdx:to": ["speckl:RetryHandler-1.2.0"]
    },
    {
      "@type": "spdx:Relationship",
      "spdx:from": "speckl:DrugDosageCalculator-1.0.0",
      "spdx:relationshipType": "speckl:satisfies",
      "spdx:to": ["req:FDA-21-CFR-820-30"]
    },
    {
      "@type": "spdx:Relationship",
      "spdx:from": "speckl:DrugDosageCalculator-1.0.0",
      "spdx:relationshipType": "spdx:wasAttributedTo",
      "spdx:to": ["agent:sarah-chen"]
    }
  ],
  "spdx:annotation": [
    {
      "@type": "spdx:Annotation",
      "spdx:annotationType": "REVIEW",
      "spdx:statement": "Manual review required before deployment",
      "speckl:reviewType": "manual",
      "speckl:reviewStatus": "pending"
    }
  ]
}
```

#### SPDX Field Mapping

| SpeckDL Primitive | SPDX 3.0.1 Location | Field |
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
| Compilation artifacts (Z3, DST, WASM) | `spdx:SoftwareArtifact` elements | With hashes |
| Verification results (SAT/UNSAT) | `speckl:verificationResult` | Extension property |
| Reproducibility status | `speckl:reproducible` | Extension property |

#### Compiler Output

The `speckl-compile` tool produces both formats by default:

```
$ speckl compile drug-dosage.speck --output-dir out/

  out/
  ├── drug-dosage.prov.jsonld      # Provenance graph (PROV-O / JSON-LD)
  ├── drug-dosage.specbom.cdx.json   # SpeckBOM (CycloneDX v1.6)
  ├── drug-dosage.specbom.spdx.json  # SpeckBOM (SPDX 3.0.1 JSON-LD)
  ├── drug-dosage.z3.smt2           # Z3 assertions
  ├── drug-dosage.dst.json          # Decision Structure Tree
  └── drug-dosage.wasm              # WASM module
```

Use `--bom-format cdx|spdx|both` to select output format. Default is `both`.

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

### 5.5 Composed: Multi-Speck System

```
speck PaymentService {
  import "rate-limiter.speck" as limiter
    hash: "sha256:f7a1..." version: "2.1.0"
  import "retry-handler.speck" as retry
    hash: "sha256:b3c9..." version: "1.4.0"

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

### 5.6 Dark Provenance: Regulated Medical Device (NEW)

This example demonstrates all Dark Provenance primitives in a safety-critical context:

```
speck InfusionPumpController {
  // SpeckBOM
  bom {
    compiler: "speckl-compile" version "0.2.0"
    solver: "z3" version "4.12.5"
    runtime: "wasm-runtime" version "1.0.0"
    license: "MIT"
    hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }

  // Intent sources
  provenance {
    regulation: "FDA 21 CFR 820.30"
    regulation: "IEC 62304 Class C"
    design_decision: "ADR-0023 Infusion Safety Architecture"
    external_doc: "AAMI TIR32" at "https://www.aami.org/tir32"
  }

  // Traceability to system requirements
  satisfies SYS-REQ-042
  satisfies SYS-REQ-043 clause "5.2.1"

  // Authorship and origin
  author: "Dr. Sarah Chen" <"s.chen@meddevice.example">
  source: architecture_review ref "AR-2024-0315"

  // Verification boundary
  review: manual

  // Parent spec relationship
  derives from SafetyCriticalController via "decomposition of dosing logic"

  input: {
    prescribedRate: Real,
    vtbi: Real,           // Volume to be infused
    drugLibraryEntry: DrugProfile,
    patientWeight: Real,
    airInLineSensor: Bool
  }

  output: {
    motorSpeed: Real,
    occlusionAlarm: Bool,
    airInLineAlarm: Bool,
    complete: Bool
  }

  // Safety constraints
  constraint: prescribedRate > 0
  constraint: prescribedRate <= drugLibraryEntry.maxRate
  constraint: vtbi > 0
  constraint: patientWeight > 0
  constraint: implies(airInLineSensor, motorSpeed == 0)
  constraint: implies(occlusionAlarm, motorSpeed == 0)

  // Therapeutic constraint: dose must match prescription
  constraint: motorSpeed == prescribedRate * drugLibraryEntry.conversionFactor

  verify: always(implies(
    airInLineSensor or occlusionAlarm,
    motorSpeed == 0
  ))

  verify: always(implies(
    complete,
    vtbi == 0
  ))

  event DoseStarted {
    rate: Real
    remainingVolume: Real
    timestamp: Nat
  }

  event AlarmTriggered {
    alarmType: String
    severity: Nat
    automaticResponse: String
  }

  event InfusionComplete {
    totalVolumeDelivered: Real
    duration: Real
  }
}
```

### 5.7 Dark Provenance: Auto-Verified Service (NEW)

This example shows `review: auto` for internal services with no manual gate:

```
speck InternalMetricsCollector {
  provenance {
    parent_spec: ObservabilityPlatform
    design_decision: "ADR-0056 Unified Telemetry"
  }

  author: "Platform Team" <"platform@example.com">
  source: meeting ref "zoom://2024-04-15/platform-sync"

  satisfies PLATFORM-REQ-12
  derives from ObservabilityPlatform via "metrics ingestion path"

  review: auto

  input: {
    serviceName: String,
    metricBatch: [Metric],
    apiKey: String
  }

  output: { accepted: Nat, rejected: Nat, latencyMs: Nat }

  constraint: count(metricBatch) <= 1000
  constraint: accepted + rejected == count(metricBatch)
  constraint: latencyMs <= 100

  verify: always(implies(
    count(metricBatch) > 0,
    accepted + rejected == count(metricBatch)
  ))
}
```

### 5.8 Dark Provenance: Compliance Audit Trail (NEW)

This example demonstrates provenance for audit and compliance scenarios:

```
speck AuditLogValidator {
  provenance {
    regulation: "SOX Section 404"
    regulation: "PCI-DSS v4.0 Requirement 10"
  }

  author: "Compliance Engineering"
  source: compliance_audit ref "AUDIT-2024-Q1"

  satisfies COMPLIANCE-REQ-08 clause "10.3"
  review: hybrid

  input: {
    logEntry: LogEntry,
    previousHash: String,
    validatorKeys: [String]
  }

  output: { valid: Bool, tamperDetected: Bool, newHash: String }

  constraint: implies(tamperDetected, not valid)
  constraint: newHash == hash(logEntry, previousHash)
  constraint: implies(valid, signatureValid(logEntry, validatorKeys))

  verify: always(implies(
    logEntry.hash != hash(logEntry.payload),
    tamperDetected
  ))

  event IntegrityCheckFailed {
    logId: String
    expectedHash: String
    actualHash: String
    severity: Nat
  }
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
7. Emits provenance graph metadata (JSON-LD) at each stage.

### Planned Tooling

| Tool | Purpose | Status |
|------|---------|--------|
| `speckl-compile` | Reference compiler | Spec only |
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

## Appendix B: Dark Provenance JSON-LD Reference (NEW)

### B.1 Provenance Graph — JSON-LD / PROV-O

The provenance graph (§4.4) is serialized as JSON-LD using PROV-O vocabulary. This is the **intent provenance** layer — who, why, and what drove a specification.

| SpeckDL Primitive | JSON-LD Output | PROV-O Mapping |
|---|---|---|
| `provenance { regulation: X }` | Node with `prov:wasInformedBy` → Regulation | `prov:Entity` → `prov:Activity` |
| `provenance { design_decision: X }` | Node with `prov:wasInformedBy` → Decision | `prov:Entity` → `prov:Activity` |
| `provenance { parent_spec: X }` | Node with `prov:wasDerivedFrom` → Speck | `prov:Entity` → `prov:Entity` |
| `provenance { external_doc: X at Y }` | Node with `prov:wasInformedBy` → Document | `prov:Entity` → `prov:Activity` |
| `author: Name <email>` | Agent node + `prov:wasAttributedTo` | `prov:Agent` |
| `source: kind ref X` | Source node + `prov:wasInformedBy` | `prov:Activity` with `prov:type` |
| `derives from X via Y` | `prov:wasDerivedFrom` edge | `prov:wasDerivedFrom` |
| `satisfies X clause Y` | `speckl:satisfies` edge + clause property | Extension property |
| `review: manual` | `speckl:ManualReview` requirement node | Extension |
| `review: auto` | No additional nodes (default path) | N/A |
| `review: hybrid` | `speckl:HybridReview` with sampling params | Extension |

### B.2 SpeckBOM — CycloneDX v1.6

The compilation manifest (§4.5) supports CycloneDX v1.6 JSON with `bomType: specBOM` and `speckl:` property extensions. Preferred for security tooling and OWASP ecosystem integration.

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

The compilation manifest (§4.5) also supports SPDX 3.0.1 JSON-LD using the `Sbom` class with `speckl:` extension properties. Preferred for regulated environments (DO-178C, IEC 62304) where ISO 5962:2023 compliance is required.

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

*This is a v0.2-DP specification. Dark Provenance and SpeckBOM primitives are optional but recommended for safety-critical and regulated systems. SpeckBOM compilation output supports both CycloneDX v1.6 (OWASP/ECMA-424) and SPDX 3.0.1 (ISO 5962:2023). Feedback welcome via the [Speckl repository](https://github.com/wscoble/speckl).*