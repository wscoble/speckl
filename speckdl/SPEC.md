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

**Comments** — `//` line comments and `/* ... */` block comments. A `{` or `}`
inside a comment or a `"` string is not a structural brace, including when
Go emits an `if` or a `for`, and including a trailing `// }` after a one-line
action. That action closes on its own structural `}`. A brace in a comment
or a string does not hide the next speck. A line that is
only `speck`, with `Name {` on a later line, is `speck name must be on the
same line as "speck"`. `'` is post-state prime notation, not a string
quote. A block comment may continue onto the next line. A `"` string may
not: an unclosed `"` is `unterminated string` on the line where it opened,
including at file level, after the last speck, and inside domain text. An
unclosed `/*` is `unterminated block comment` on the line where it opened,
in those same places. A comment that opens on a speck's closing line and
closes on a later line is closed. A `/*` written inside an already-open
block comment is comment text, not a nested comment. When `*/` is the first text on a line and
the code after it is a `speck`, `action`, `invariant`, `state`, or `init`
header, that header is `header is not at the start of the line`. A header
later on the line is outside this scan. A speck written entirely inside a
block comment is not a speck. Go still drops an `else if`, a nested `if`,
a `for` inside an `if`, and a `require` inside an `if`. That is unchanged
from before this scan. `compiler/src/speck-lex.ts` tokenizes a file the same way (a brace in a comment or a string is not a token; `'` is prime notation; an unclosed string or block comment is an error on the opening line and column; `\r\n` and a tab are whitespace; a non-ASCII identifier is an error and non-ASCII text inside a string or a comment is kept). `parseSpeck` calls that lexer through `compiler/src/rd-parser.ts`. A `}` on the speck header ends that speck. A `}` inside a string does not end the speck. A one-line record stores its brace span. `type LogEntry = { term: Nat, value: Value }` is `{ term, value }`. A trailing `//` or block comment is not part of an invariant. A `//` inside a string stays. An empty invariant is an error. `state { x: Nat }` stores that field. `state { }` stores no fields. A `}` inside `//` does not close the block. `x := 0` is stored and `x = 0` is `unrecognized init line`. A missing `}`, an extra `}`, text after `}`, an unrecognized member, and `§` are the same error from this parser and from the line walker, with a line and column. An unrecognized state field and an unrecognized init line name the line and do not name a column. File-level `import` is stored on the AST. `compiler/src/imports.ts` resolves a relative path (`\` is `/`) inside the entry directory, checks the hash pin, and names the importing file and line on failure. `compileSpec` does not call it yet. `compiler/src/conservation.ts` records, for every backend, whether each member type is emitted, rejected, or not applicable. `compileSpec` checks that table before it calls the backend. Each generator also calls that check, so a direct call cannot drop a member type. A missing member-type list, or a type the table does not name, is an error. `generateAgent` calls that check before it emits. A missing member list, an unknown member type, and `oneof` are errors. A speck with no `agent` block logs `skip S: no agent { } block` and does not emit that speck's agent files.

### 2.2.1 Rejected structure

The line walker used to accept each input below and store a program that dropped or rewrote the text. That was a bug. The input is now a parse error.

- A speck that never closes. `speck A {` with no closing brace used to parse as speck A with no members, ending on line 1. The diagnostic is: Parse error at bad.speckdl:1: missing final "}" (column 9).
- An extra closing brace. `speck A {` then a line `}` then another `}` used to parse as speck A with no members, ending on line 2. The extra brace was ignored. The diagnostic is: Parse error at bad.speckdl:3: extra "}" (column 1). A `}` inside a string is still a string.
- Text after a speck's closing brace. `speck A {` then `} junk` used to parse as speck A with no members, ending on line 2. The word was ignored. The diagnostic is: Parse error at bad.speckdl:2: text after a speck's "}" (column 3).
- A second speck on the same line. `speck A { } speck B { }` used to parse as only speck A, with no members. Speck B was dropped. The diagnostic is: Parse error at bad.speckdl:1: a second speck on one line (column 13).
- An unrecognized member. `garbage line here` used to parse as speck A with no members. `actoin go {` dropped the action. `enum Status { Active, Inactive }` kept only interface Foo. A description line dropped the description. `x := x + 3` after init stored the state type as `= x + 3` and the init expression as `x + 3`. Each diagnostic is unrecognized member with the line and column. One of them is: Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5).
- Unrecognized top-level text. `spek B {` after a closed speck used to parse as only speck A. `*/ speck A {` used to parse as no specks. The diagnostics are: Parse error at bad.speckdl:4: unrecognized top-level "spek B {" (column 1), and Parse error at bad.speckdl:1: unrecognized top-level "*/ speck A {" (column 1).
- Text after a member's closing brace. `invariant P { x >= 0 } junk` used to parse as invariant P with an empty expression. The predicate was dropped. The diagnostic is: Parse error at bad.speckdl:2: text after a member's "}" (column 28).
- A member brace on the next line. `invariant P` with `{` on the following line used to parse as a speck whose only member was an empty state. The invariant was dropped. The diagnostic is: Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5).
- An unrecognized state field. Inside `state`, `y Nat` after `x: Nat` used to be stored as the type `Nat y Nat`. The diagnostic is: Parse error at st.speckdl:2: unrecognized state field "y Nat". The message names the state header's line and does not name a column.
- An unrecognized init line. `y = 0` after `x := 0` used to be stored as the expression `0 y = 0`. `garbage line` used to be stored as `0 garbage line`. The diagnostics are: Parse error at in.speckdl:3: unrecognized init line "y = 0", and unrecognized init line "garbage line". The message names the init header's line and does not name a column. `x := 0` is still an assignment.
- Code after a block comment on the same line. `/* c */ action go {` used to parse as speck A with no members. The action was dropped. The diagnostic is: Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13).
- A CR that is not part of CRLF. `speck A {` then a state, with a bare carriage return and no line feed, used to parse as speck A with no members, ending on line 1. The diagnostic is: Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10). CRLF is still whitespace.
- An unexpected non-ASCII character outside a string or a comment. A line containing `§` used to parse as speck A with no members. The diagnostic is: Parse error at bad.speckdl:2: unexpected character "§" (column 2). `→` is: Parse error at bad.speckdl:2: unexpected character "→" (column 7). Non-ASCII text inside a string or a comment is kept.
- An identifier that starts with a digit. `speck 9A` used to parse as a speck named `9A`. The diagnostic is: Parse error at bad.speckdl:1: identifier must not start with a digit (column 7). `state { t: 24h }` still parses.
- A non-ASCII identifier. `naïve` used to be dropped, and the file parsed as speck A with no members. The diagnostic is: Parse error at bad.speckdl:2: identifier must be ASCII (column 7). Non-ASCII text inside a string or a comment is kept.
- An unsupported numeric literal. `state { t: 1h30m }` used to parse as speck A whose state stored no fields. The diagnostic is: Parse error at bad.speckdl:2: unsupported numeric literal "1h30m" (column 16). `state { t: 24h }` still parses.
- The column of an unclosed string or comment. `x: "ab` with no closer was already Parse error at bad.speckdl:2: unterminated string. It is now Parse error at bad.speckdl:2: unterminated string (column 8). `/* c` with no closer was unterminated block comment and is now Parse error at bad.speckdl:2: unterminated block comment (column 5).

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

### 2.9 Expression Operators

Binary operators, from loosest to tightest binding:

| Operators | Notes |
|---|---|
| `implies` | right-associative: `a implies b implies c` is `a implies (b implies c)` |
| `or`, `\|\|` | |
| `and`, `&&` | binds tighter than `or`: `a or b and c` is `a or (b and c)` |
| `==`, `!=` | |
| `<`, `>`, `<=`, `>=` | |
| `in`, `notIn` | |
| `+`, `-`, `union`, `\` | |
| `*`, `/`, `%` | |
| `not`, unary `-` | prefix |
| `f(x)`, `x.y`, `x[y]` | postfix |

All other binary operators are left-associative. Use parentheses to mix
`and` and `or` readably.

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
5. `(check-sat)` with an expectation marker: `; speckl-expect: unsat`
   (property proven) or `; speckl-expect: sat` (consistency check). Each
   verify block's check is preceded by `; speckl-obligation: <verify name>`.
   No `(get-model)` is emitted (z3 rejects it after `unsat` and exits 1); the
   verify script requests counterexample models itself.
6. Verify blocks that cannot be checked are declared, never dropped:
   `; speckl-unchecked: <verify name>: <reason>`. The `.ir.smt2` backend does
   not unroll transitions, so it declares every verify block this way and
   leaves the proof to the `.smt2` backend.

### 3.2 The Verify Script

`npm run verify` (in `compiler/`) compiles every example and runs the real
Z3 binary on each emitted file:

- Solver **error** → failure (generator bug — Z3 rejects the file).
- Result matching the expectation → pass.
- Unexpected `sat` against an `unsat` expectation → **VIOLATED**: the script
  prints a counterexample state trace (per-BMC-step variable bindings).
- Unexpected `unsat` → contradictory constraints.
- A check-sat with no expectation marker → failure.
- **Fail closed on obligations.** Every verify block a spec declares must be
  proven by some backend: a non-degraded `unsat` check under its
  `speckl-obligation` key. A degraded check, a `speckl-unchecked` marker, or
  a verify block with no actions to unroll leaves it **UNCHECKED**, and
  UNCHECKED fails the run. It is never counted as passed.
- **Baseline.** A spec directory may list known unchecked obligations in
  `.speckl-unchecked.json` (`{ "<spec>.speckdl": { "<verify>": "<reason>" } }`).
  Listed ones are reported as UNCHECKED (acknowledged) and do not fail the run;
  an entry that is now proven or no longer declared fails as STALE-BASELINE.
  `examples/.speckl-unchecked.json` is the repo's ratchet.

Exit code is nonzero on failure. CI runs this for every example spec.

### 3.3 Graceful Degradation

Constructs without a well-defined SMT translation (unresolved type unions,
method calls like `List.empty` in unsupported positions, leaked source
syntax) are dropped from the output with `; skipped:` comments instead of
emitting invalid SMT. When any form is dropped, an `unsat` expectation is
downgraded to a consistency check (`degraded: model incomplete`). The solver
result is then advisory, not a proof, and the verify block is UNCHECKED.

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