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
yet lowered to Z3 (see §3.4).

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

event MarketTick external {
    price: Nat
}
```

Events are emitted from actions (`emit RetryAttempted { attemptNumber: 1 }`)
and recorded in the provenance graph. `external` marks an event that enters
from outside the compilation. A domain may consume an external event without
any domain producing it. An event is either external or internal: declaring
it both ways is a compile error.

Completion signals and trace IDs on events are **not yet implemented**.

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

An import is a file path, resolved relative to the file that contains it
(absolute paths are taken as written). The lower pass reads that file,
lowers it, and merges its specks into the compilation unit. A file-level
import is attached to every speck in the importing file; an import written
inside one speck is attached to that speck. `as` names the import: one
speck uses the alias, several specks use `alias.SpeckName`. With no alias
the speck's own name is used.

Failures name the file and stop the compile:

- the path cannot be read (missing file, or a directory);
- the import graph cycles (`a.speckdl -> b.speckdl -> a.speckdl`);
- `hash "sha256:..."` (or a bare hex digest) does not match the file bytes;
- the same speck name is declared in two files.

`version` is stored on the resolved import. Looking that pin up in a
package registry is **not yet implemented**. Requiring a version when
`review` is `manual` or `hybrid` is **not yet implemented** — a missing
version is not an error today.

Merging does not inline the imported speck's members into the importer,
and it does not rewrite expressions that mention an imported name. That
name resolution is **not yet implemented**. Each merged speck stays one
speck.

### 2.9 Domains

```
domain Billing {
    members: Invoice, Ledger;
    language: "An invoice is issued before a ledger posts it";
}

domain Fulfillment {
    members: Shipment;
    language: "A shipment leaves the warehouse";
    consumes InvoiceIssued;
    produces ShipmentLeft;
    budget 10 per tick;
}
```

A `domain` is a bounded context: a name, the specks that belong to it, and
an optional ubiquitous-language note. It is file-level. It is not a member
of a speck, and it does not fuse those specks into one agent. Each member
is still one speck.

`members` is required and lists speck names (local, or merged in from
imports). `language` is a quoted string or bare text up to the semicolon.
`consumes` and `produces` name events that are already declared with
`event` (in this file or a merged import). Repeat the clause, or separate
names with commas. `budget <n> per tick` is one non-negative integer; zero
is a real budget. The same failures are compile errors:

- a member listed twice in one domain;
- a speck that is a member of two domains;
- a member that is not a speck in this compilation;
- the same domain name declared twice;
- `consumes` or `produces` names an event that is not declared;
- the same event is listed twice in one domain's `consumes` or `produces`;
- `budget` is not a non-negative integer `per tick`, or it is declared twice;
- an action declares `cost` more than once, or `cost` is not a non-negative integer.

Contracts are checked after imports are merged, and the compile stops
before any output is written:

- every consumed event is produced by some domain, or the event is
  declared `external`;
- a domain does not `produces` an event that is declared `external`
  (one origin: inside the compilation, or outside it);
- no member action emits an event its domain does not list in `produces`,
  including an `emit` written inside an `if` block.

A produces/consumes cycle between domains is allowed. The check is a
lookup, not a walk, so the cycle terminates. Two domains may produce the
same event. Which domain delivers it at runtime is **not yet implemented**.

`cost <n>` on an action is a non-negative integer literal. A trailing
`//` comment on that line is ignored (`cost 3 // per call`). It is a
verification annotation. It is not a runtime throttle. An action with no
`cost` is not treated as cost 0.

`priority <Name>` on an action, or on the domain, is an identifier such as
`P0`. The action's label is used when both are set. It is stored on a
completion signal. It does not create a queue, and a name that no
scheduler knows is not rejected in this pass.

`kpi "<name>"` tags an event. The name is a JSON string of 1 to 200
characters with no control characters. Two declarations of the same event
cannot carry different tags (including one tagged and one not). A
straight-line `emit` of the event puts that tag on the action's completion
signal. An `emit` inside an `if`, a `for`, or a comment does not. The Camel
target does not copy the tag onto the Java class.

The IR records each one as an `IRDomain`. Provenance appends a domain
entity to each member's PROV-O graph: a `prov:Collection` whose
`prov:hadMember` links the member specks. Specks that are not in a domain
keep the same provenance graph as before.

`speckl doctor <file>` resolves imports and domains, then fails when a
domain member declares an `effect act` tool that is not the target of a
`map` rule in every `harness` block on that member (no harness block
counts as not mapped). Observe tools are not checked. An act tool on a
speck that is not in a domain is not checked. This is a spec check. It is
not the generated adapter's `doctor` probe, which runs an installed hook.

Listing an event in `produces` does not require any member to emit it.
The clause is the domain's permission to emit that event. An emit the
domain did not list is an error. A listed event that nobody emits is not.

On `post` of an `effect act` tool the generated hook appends a completion
signal on that decision-log line (`signal` is `prime`): `trace_id` from
the ingress `pre` (a missing or ill-formed `trace_id` is a fresh root and
`trace_flagged` is true), `branch_id` unique per branch (the matching post
reuses it), `parent_branch_id`, `call_id`, `ok`, `ts`, and `priority` from
the action or the domain. A `parent_branch_id` that is present but not an
id is flagged and stored as null. An absent parent is an unflagged root.
An act `post` with no matching `pre` is a deny, and that deny is still a
completion signal. It does not keep the caller's `ok`, `kpis`, or
`trace_id`: `ok` is false, `kpis` is empty, and the trace is a fresh
flagged root. Observe tools do not get one. The `kpis` on a tool are the
tags of events that action emits with a straight-line `emit Name { }`.
An `emit` inside an `if`, a `for`, a `//` comment, or a `/* */` comment
is not tagged. `while` and `match` blocks that contain `emit` are a parse
error, and so is a bare `emit Name`. `emit Name { } // comment` and
`/* comment */ emit Name { }` are real emits. An `emit Name {` whose `}` is on a later line is not a statement and is not tagged. The generated agent machine
does not run `if` or `for` bodies.

`speckl trace report` reads the log offline and prints, per priority,
drain latency (ingress to the last leaf allow completion), completion-signal
lag (allow pre to that allow post), and queue depth (an allow pre that no
allow post has closed). Drain and the KPI list count only an allow post
that matched an allow pre. Each KPI line shows the verdict. A deny post
is not a drain leaf and is not a KPI line. A null priority is printed as
`(none)`.

With `--state`, if `<state>.decisions/head.json` exists the report checks
its `seq` and `hash`, and the head mac when `--key` is passed. A log
shorter than that head, or a missing log when the head is not empty,
fails. A log longer than the head is an uncommitted suffix and is
accepted. If `<state>.decisions/` exists and `head.json` does not, the
report and `signal.mjs verify` fail with `decision head missing`. If that
directory is absent, there is no record. `--log`
alone checks the hash chain of the bytes it was given and does not know
the head, so a shortened prefix that still hashes can pass. A line with
no trailing newline is torn and fails. The report prints `macs checked`
only when `--key` checked at least one line. Otherwise, including an
empty log, it prints `macs not checked`. A chain rebuilt without the key
can have a valid hash. That is not a verified seal. Replacing the log
and head with an older pair from the same run, or restoring an older
snapshot of the state and the decisions directory together, still
verifies. There is no anchor outside that directory.

A `//` brace is ignored only when that line has not already opened a
`{`. `action Go { // }`, a `{` after `//` on an event or action line that
already opened a brace, and `} /* { */` between specks are not handled
here. A single quote is not a string quote.

The report does not run the agent and does not enforce a queue. Those
durations are a throughput signal, not a risk signal. The seal on the line
is unchanged: HMAC-SHA256 with the shared state key. It proves nothing to
an outside auditor. Anyone who can read the key can forge a line, and
someone without the key cannot check the mac.

**Not yet implemented:** a tick scheduler, queues, and runtime routing of
events between domains. A domain does
not fuse member specks into one state machine. The budget check assumes
the model in §3.5 (BMC depth only; each member stutters or takes exactly
one `next` action per tick; members are independent; each firing chooses
fresh parameters; no runtime scheduler enforces the model). The Camel
target records each contract as a comment block and a typed event class.
It does not throttle, queue, or route. Apache Camel's Throttle and Circuit
Breaker enterprise integration patterns limit traffic while a route runs.
The budget here is complementary: it is checked before deploy. Speckl is
not part of Apache Camel and is not affiliated with the Apache Software
Foundation.

### 2.10 Expression Operators

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

### 3.5 Domain budgets

A domain that declares `budget <n> per tick` adds one Z3 obligation,
`<Domain>.budget`. One tick is one step of the domain. Each member
stutters (cost 0) or takes one action from its `next` relation. The cost
of the tick is the sum of those costs. Members are separate machines, so
each member's witness is a state of its own, reachable within the BMC
depth from its initial state.

The solver is asked whether any such sum is greater than the budget.
`unsat` proves the bound inside that depth, and only under the assumptions
below. `sat` is a counterexample trace: per-step state, `Member_choice`
(0 is stutter; then the `next` actions in order), and `tick_cost`. An
action that is not in `next` does not fire, so its cost is not part of the
sum. A guard that is never true inside the depth does not contribute. The
depth is the same `--verify-depth` / `-d` bound as other BMC checks. A cost
that becomes enabled only past that depth is outside the proof.

The proof assumes all of the following:

- It is bounded by the BMC depth. A run longer than that depth is not a
  counterexample this query can find, and it is not covered by `unsat`.
- Each member either stutters or takes exactly one `next` action in the
  tick. It does not take two actions, and it does not take an action that
  is outside `next`.
- Members are independent. One member's witness is a state reachable for
  that member alone. It is not required to be the same step index as
  another member's witness.
- Each firing of an action chooses its parameters fresh. A parameter at
  one step is not the same value as that parameter at another step, a
  parameter of one action is not the same value as a parameter of the same
  name on another action, and the values that show the tick's action is
  enabled are not the values used to step the state.
- Nothing at runtime enforces this model. There is no scheduler that makes
  a tick match the query. The bound is a check before deploy, not a limit
  applied while the system runs.

The obligation is **UNCHECKED**, and never counted as passed, when the
tick cannot be lowered. That includes a member with no `next` relation, a
`next` action with no `cost` (including a synthetic signal action), a
state sort or expression this encoding does not translate, a parameter
whose name is also a state variable, and an `if` or `let` in a tick action. The IR backend does not unroll transitions, so it
declares the obligation unchecked and leaves the proof to the state-machine
backend, the same way it treats other verify blocks. A domain with no
`budget` adds no obligation and does not change the SMT output.

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
strings), resolved (`import` paths are read and merged at lower time; using
an imported name inside an expression is not yet implemented), and
provenanced (missing provenance is synthesized from file metadata). A
`domain` is an `IRDomain` on that IR, not a ninth facet of one speck.

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
| `speckl doctor` | Import, domain, and act-tool harness check | Working |
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