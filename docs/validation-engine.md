# Speckl Validation Engine Design

## Overview

The Validation Engine is the second stage of the Speckl pipeline:

```
Chaotic Conversation → [Extraction Layer] → [Validation Layer] → [Compilation Layer]
```

It takes a Structured Intermediate Representation (SIR) and produces a `ValidationReport` that determines whether the SIR is correct, complete, and consistent enough to compile. The engine is domain-agnostic at its core with pluggable domain-specific validators.

---

## 1. Architecture

```
                    ┌───────────────────────────┐
                    │     Validation Engine      │
                    │                            │
   SIR ──────────▶  │  ┌──────────────────────┐  │
                    │  │  Structural Validator │  │
                    │  └──────────┬───────────┘  │
                    │             │              │
                    │  ┌──────────▼───────────┐  │
                    │  │  Reference Validator  │  │
                    │  └──────────┬───────────┘  │
                    │             │              │
                    │  ┌──────────▼───────────┐  │
                    │  │  Constraint Solver    │  │
                    │  └──────────┬───────────┘  │
                    │             │              │
                    │  ┌──────────▼───────────┐  │   ┌──────────────────┐
                    │  │  Domain Validators   │◀─┼───│ Plugin Registry  │
                    │  │  (pluggable)         │  │   │                  │
                    │  └──────────┬───────────┘  │   │ state-machine    │
                    │             │              │   │ workflow         │
                    │  ┌──────────▼───────────┐  │   │ data-model       │
                    │  │  Completeness Check  │  │   │ api-spec         │
                    │  └──────────┬───────────┘  │   │ ...              │
                    │             │              │   └──────────────────┘
                    │  ┌──────────▼───────────┐  │
                    │  │  Confidence Filter   │  │
                    │  └──────────┬───────────┘  │
                    │             │              │
                    │  ┌──────────▼───────────┐  │
                    │  │   Report Assembler   │──┼──▶ ValidationReport
                    │  └──────────────────────┘  │
                    └───────────────────────────┘
```

### Core Principle: Fail Cheap First

Validation passes are ordered from cheapest to most expensive. A structural check rejecting the SIR avoids running an SMT solver. This matters because some checks (temporal logic model checking, constraint solving) can be NP-hard or PSPACE-complete.

---

## 2. The SIR (Recap)

The SIR is a typed graph. Key types:

```
SIR {
  domain: string                    // e.g. "state-machine"
  elements: Element[]               // all typed nodes
  constraints: Constraint[]         // cross-element constraints
  confidence: Confidence            // per-element confidence scores
  source: SourceMap                 // maps elements back to conversation spans
}

Element {
  id: string                        // unique, e.g. "state-idle"
  type: string                      // e.g. "state", "transition", "guard"
  properties: Map<string, Value>    // typed property bag
  metadata: {
    confidence: 0.0..1.0            // extraction confidence
    source: SourceSpan              // where in conversation this came from
    required: boolean               // is this element mandatory for compilation?
  }
}

Constraint {
  id: string
  type: "reference" | "invariant" | "type-check" | "domain"
  expression: ConstraintExpr        // structured expression tree
  severity: "error" | "warning"
}

Confidence {
  perElement: Map<string, 0.0..1.0>
  overall: 0.0..1.0                 // aggregate confidence
  threshold: 0.0..1.0               // configured threshold for blocking
}
```

---

## 3. Validation Categories

### 3.1 Structural Validation

Determines if the SIR is *well-formed* — independent of domain semantics.

**Checks:**

| Check | Rule | Severity |
|-------|------|----------|
| Unique IDs | No duplicate `Element.id` | ERROR |
| Required fields | Every element has `id`, `type`, `properties` | ERROR |
| Valid type registry | Every `Element.type` exists in the known type registry | ERROR |
| Property type correctness | Properties match their declared types | ERROR |
| No orphan references | Every `Constraint.expression` referencing an element ID must find that element | ERROR |
| Valid JSON/parsed form | SIR structure is parsable | ERROR |

**Example — State Machine SIR structural errors:**

```yaml
# This SIR has structural problems
domain: state-machine
elements:
  - id: "idle"
    type: "state"
    properties:
      name: "Idle"
      is_initial: "yes"        # ERROR: is_initial must be boolean, got string
  - id: "running"
    type: "stte"               # ERROR: unknown type "stte" (typo)
  # ERROR: transition references nonexistent element "stopped"
  - id: "t1"
    type: "transition"
    properties:
      from: "idle"
      to: "stopped"            # stopped not defined
      trigger: "start"
  - id: "idle"                 # ERROR: duplicate id "idle"
    type: "state"
    properties:
      name: "Duplicate Idle"
```

**Generated Errors:**

```
ERROR [structural.type_mismatch] Element "idle": property "is_initial"
  expected type "boolean", got "yes" (string).
  → Fix: change "yes" to true.

ERROR [structural.unknown_type] Element "running": type "stte" is not
  in the type registry. Did you mean "state"?

ERROR [structural.missing_reference] Element "t1" (transition):
  target state "stopped" not found in element set.

ERROR [structural.duplicate_id] Element id "idle" appears more than once.
  ids must be unique.
```

### 3.2 Reference Validation

Cross-element reference integrity. After structural checks pass, we verify that the graph of references is coherent.

**Checks:**

| Check | Rule | Severity |
|-------|------|----------|
| Bidirectional consistency | If A references B, B's type must be compatible with A's expectation | ERROR |
| No dangling references | All `from`/`to`/`parent`/`child` fields resolve | ERROR |
| Circular reference detection | No fatal cycles (e.g. state A's parent is state B whose parent is state A) | WARNING |
| Cardinality | If a field declares `max: 1`, having 2+ references is an error | ERROR |

**Example — Coherent reference graph for state machines:**

```yaml
elements:
  - id: "idle"
    type: "state"
    properties: { name: "Idle", is_initial: true }
  - id: "running"
    type: "state"
    properties: { name: "Running" }
  - id: "t1"
    type: "transition"
    properties:
      from: "idle"
      to: "running"
      trigger: "start"
  - id: "t2"
    type: "transition"
    properties:
      from: "running"
      to: "idle"
      trigger: "stop"
```

This SIR passes both structural and reference validation.

### 3.3 Domain-Specific Validation

Domain validators are plugins that register with the engine. Each validator specifies:
- Which `domain` it applies to
- What checks it performs
- The cost of each check (cheap/moderate/expensive)

**State Machine Domain Validator Checks:**

| Check | Cost | Rule | Severity |
|-------|------|------|----------|
| Initial state exists | Cheap | Exactly one state has `is_initial: true` | ERROR |
| Reachable states | Moderate | Every non-initial state is reachable via some path of transitions | WARNING |
| No dead-end states | Cheap | Every state has at least one outgoing transition, or is marked `terminal` | WARNING |
| Deterministic transitions | Moderate | For a given (state, trigger) pair, at most one transition fires (or guards disambiguate) | WARNING for ambiguity |
| Guard completeness | Expensive | For a state with guarded transitions on the same trigger, guards must be exhaustive (sum of guard cases covers all possibilities) | WARNING |
| No livelock | Expensive | No infinite cycle of transitions without progress | ERROR |
| Terminal states | Cheap | Terminal states have no outgoing transitions | INFO (ok if intended) |
| Liveness | Expensive | Desired terminal states are reachable from all states (if spec'd) | WARNING |

**Example — State Machine with domain errors:**

```yaml
domain: state-machine
elements:
  - id: "idle"
    type: "state"
    properties: { name: "Idle" }
    # ERROR: missing is_initial — no initial state defined
  - id: "running"
    type: "state"
    properties: { name: "Running" }
  - id: "orphan"
    type: "state"
    properties: { name: "Orphan" }
    # WARNING: unreachable — no transition targets this state
  - id: "t1"
    type: "transition"
    properties:
      from: "idle"
      to: "running"
      trigger: "start"
  - id: "t2"
    type: "transition"
    properties:
      from: "running"
      to: "running"   # WARNING: self-loop, no progress
      trigger: "retry"
  - id: "t3"
    type: "transition"
    properties:
      from: "idle"
      to: "running"
      trigger: "start"
      guard: "is_admin == true"
    # WARNING: conflict with t1 — same (from, trigger), t1 has no guard, t3 has guard.
    # t1 fires unconditionally on "start", t3 never fires.
```

**Generated domain errors:**

```
ERROR   [domain.fsm.no_initial] No initial state defined.
        Mark one state with is_initial: true (e.g. state "idle").

WARNING [domain.fsm.unreachable] State "orphan" is unreachable.
        No transitions target it. Remove it or add a transition to it.

WARNING [domain.fsm.self_loop] Transition "t2": self-loop on state
        "running" with trigger "retry". This produces no state change.
        If intentional, mark the transition with `is_self_loop: true`.

WARNING [domain.fsm.guard_shadow] Transition "t3" is shadowed by "t1":
        both fire from "idle" on trigger "start", but "t1" has no guard
        (always matches), so "t3" (guard: is_admin == true) can never fire.
        → Add a guard to "t1", remove "t3", or use different triggers.
```

### 3.4 Consistency Validation

Checks that constraints and invariants are mutually satisfiable.

**Constraint types in the SIR:**

```
ConstraintExpr =
  | TypeConstraint(field, expectedType)
  | ReferenceConstraint(source, target, relation)
  | Invariant(temporalLogicExpr)         // e.g. "eventually(terminal)"
  | CrossConstraint(expr1, expr2, op)    // expr1 AND/OR/IMPLIES expr2
  | GuardExpr(field, operator, value)     // "counter < 5"
```

**Consistency checks (expensive):**

For state machines with temporal logic invariants, we use bounded model checking:

```
Invariant: "G (in_state('error') → F in_state('recovery'))"
           "Globally, if you enter error state, you eventually reach recovery"
```

If the model checker finds a counterexample trace where the SIR enters `error` but cannot reach `recovery`, it produces:

```
ERROR [consistency.invariant_violation] Invariant "G(error → F recovery)"
  is violated. Counterexample trace (depth=4):
    1. idle → running  (trigger: start)
    2. running → error  (trigger: fail)
    3. error → (no outgoing transitions)
  State "error" is a dead-end. Add a transition from "error" to "recovery"
  or remove the invariant.
```

**Cheap consistency pass** (always runs first):
- Contradictory property assignments: `{ is_terminal: true, outgoing_transitions: [t1] }`
- Mutually exclusive type constraints: `x must be string AND x must be number`

### 3.5 Confidence-Based Validation

Each SIR element carries a confidence score (0.0–1.0) from the extraction layer. Low confidence means the extraction was uncertain about what the human meant.

**Strategy:**

```
Element confidence thresholds:
  ≥ 0.9  → trusted (no validation flags on confidence)
  ≥ 0.7  → INFO: "Low confidence on element X. Verify: was this intended?"
  ≥ 0.5  → WARNING: "Uncertain element X — compilation will include a TODO marker"
  < 0.5  → ERROR: "Element X is too uncertain to compile. Clarify in conversation."
```

**Blocking logic:**

```typescript
function confidenceBlocks(confidence: Confidence, threshold: number): boolean {
  // Compilation is blocked if ANY error-severity element is below threshold
  // OR if overall confidence is below the configured threshold.
  return confidence.overall < threshold
    || Array.from(confidence.perElement.values())
           .some(c => c < 0.5);  // hard floor
}
```

**Example:**

```yaml
elements:
  - id: "idle"
    type: "state"
    properties: { name: "Idle", is_initial: true }
    metadata: { confidence: 0.95 }
  - id: "mystery"
    type: "state"
    properties: { name: "MaybeErrorHandling?" }
    metadata: { confidence: 0.42 }   # Very uncertain

confidence:
  perElement: { "idle": 0.95, "mystery": 0.42 }
  overall: 0.71
  threshold: 0.8
```

Generated:
```
ERROR   [confidence.below_floor] Element "mystery" (state "MaybeErrorHandling?")
        has confidence 0.42 (< 0.5 floor). Clarify what this state represents.

WARNING [confidence.overall] Overall SIR confidence (0.71) is below the
        configured compilation threshold (0.80). Consider clarifying
        uncertain elements before compiling.
```

---

## 4. Validation Timing

### 4.1 Continuous Validation (on every extraction)

Runs immediately after the Extraction Layer produces or updates the SIR. Uses only cheap checks:
- Structural validation
- Reference validation
- Confidence threshold checks
- Cheap domain checks (initial state exists, dead-end detection)

**Goal:** Give the agent immediate feedback to interject in the conversation.

> Agent: "I heard you describe a state machine with states 'idle', 'running', and 'error'. But 'error' has no way to recover. Would you like to add a recovery transition?"

### 4.2 Pre-Compilation Validation (batched)

Runs when the human requests compilation. Runs the full pipeline including expensive checks:
- Reachability analysis (BFS/DFS on state graph)
- Guard exhaustiveness
- Model checking (bounded, with configurable depth)
- SMT-based constraint solving (if invariants use arithmetic/logic)
- Completeness completeness analysis

### 4.3 Incremental Validation

When the extraction layer produces a delta (added/modified/removed elements), we re-validate only the affected subgraph:

```
Changed elements → find transitive closure of references → re-validate that subgraph
```

**Dependency tracking:**

```
Element "t1" depends on: ["idle", "running"]
Element "g1" (guard) depends on: ["t1"]
Invariant "inv1" depends on: ["error", "recovery"]
```

When `idle` changes, we re-check `t1` → re-check `g1`. When `error` changes, we re-check `inv1`.

### 4.4 Lazy vs. Eager

| Check Type | Timing | Rationale |
|------------|--------|-----------|
| Structural | Eager (continuous) | O(n), always cheap |
| Reference | Eager (continuous) | O(n), always cheap |
| Confidence | Eager (continuous) | O(n), always cheap |
| Reachability | Lazy (pre-compile) | O(V+E) — cheap but only needed before compile |
| Determinism | Lazy (pre-compile) | O(S×T) where S=states, T=transitions |
| Guard exhaustiveness | Lazy (pre-compile) | May require SAT/SMT |
| Model checking | Lazy (pre-compile) | PSPACE-complete for full LTL, bounded is O(|S|^k) |
| Invariant satisfiability | Lazy (pre-compile, opt-in) | Expensive SMT solving |

The human can also explicitly request expensive checks via conversation:

> Human: "Check if my state machine can deadlock."
> Agent: runs lazy checks on-demand, reports results.

---

## 5. Error Representation

### 5.1 ValidationReport Structure

```typescript
interface ValidationReport {
  // Overall verdict
  status: "pass" | "pass_with_warnings" | "fail";

  // All issues found
  issues: ValidationIssue[];

  // Statistics
  stats: {
    errors: number;
    warnings: number;
    infos: number;
    checksRun: number;
    checksSkipped: number;
    durationMs: number;
  };

  // Completeness
  completeness: CompletenessReport;

  // Suggestions for fixes
  suggestions: FixSuggestion[];

  // What blocked compilation (if status == "fail")
  blockers: BlockingIssue[];
}

interface ValidationIssue {
  id: string;                          // unique issue id
  severity: "error" | "warning" | "info";
  category: ValidationCategory;        // structural | domain | consistency | confidence | completeness
  code: string;                        // machine-readable code e.g. "domain.fsm.no_initial"
  message: string;                     // human-readable message
  location: SourceLocation[];          // precisely which SIR elements
  suggestion?: FixSuggestion;          // optional suggested fix
  trace?: Counterexample;              // for model checking failures
}

interface FixSuggestion {
  description: string;                 // "Mark state 'idle' as initial"
  action: "add" | "remove" | "modify" | "clarify";
  target: string;                      // element id
  patch?: Partial<Element>;           // concrete patch to apply
  conversationPrompt?: string;         // what the agent should say to the human
}

interface CompletenessReport {
  status: "complete" | "partial" | "incomplete";
  missingRequired: string[];           // element ids
  missingOptional: string[];           // element ids
  gaps: CompletenessGap[];            // described gaps
}

interface BlockingIssue {
  issueId: string;
  reason: string;                      // why this blocks compilation
}

type ValidationCategory =
  | "structural"
  | "domain"
  | "consistency"
  | "confidence"
  | "completeness";
```

### 5.2 Severity Semantics

| Severity | Meaning | Compilation Behavior |
|----------|---------|---------------------|
| ERROR | Definite problem, SIR is invalid | Blocks compilation |
| WARNING | Likely problem, SIR is valid but suspect | Compiles with caveats annotated |
| INFO | Suggestion or note | Compiles normally, annotation optional |

### 5.3 Error Localization

Every issue points to precise SIR elements:

```typescript
interface SourceLocation {
  elementId: string;
  propertyPath?: string;    // e.g. "properties.to" for transition target
  constraintId?: string;    // for constraint violations
  snippet?: string;         // the problematic value
}
```

### 5.4 Suggested Fixes — Agent Conversation Prompts

The fix suggestions are designed to flow back into conversation:

```
conversationPrompt: "State 'error' has no outgoing transitions.
  Would you like to add a recovery transition, or mark it as terminal?"

conversationPrompt: "I heard two different things about what happens when
  the system starts: one where it goes to 'running' unconditionally,
  and one where it only goes if 'is_admin' is true. Which one did you mean?"

conversationPrompt: "You mentioned a 'loading' state but I'm not sure
  when it should be entered. When does the system go to 'loading'?"
```

---

## 6. Constraint Checking System

### 6.1 Constraint Expression Language

Constraints in the SIR are structured expressions — never raw strings:

```typescript
// Type constraint: "property 'trigger' must be a string"
{
  type: "type-check",
  target: { elementId: "*", propertyPath: "trigger" },
  expected: "string"
}

// Reference constraint: "transition.target must be a valid state id"
{
  type: "reference",
  source: { elementId: "*", propertyPath: "to" },
  targetType: "state",
  relation: "must-exist"
}

// Invariant: "Globally, if in error, eventually in recovery"
{
  type: "invariant",
  formula: {
    op: "G_implies",       // Globally, φ → ψ
    left: { op: "in_state", state: "error" },
    right: { op: "F", formula: { op: "in_state", state: "recovery" } }
  }
}

// Cross-element: "every transition's 'from' must be a state"
{
  type: "for_each",
  iterator: { elementType: "transition" },
  body: {
    type: "reference",
    source: { elementId: "$it", propertyPath: "from" },
    targetType: "state",
    relation: "must-exist"
  }
}
```

### 6.2 Constraint Evaluator

```typescript
class ConstraintEvaluator {
  evaluate(constraint: Constraint, sir: SIR): ValidationIssue[] {
    switch (constraint.type) {
      case "type-check":
        return this.checkType(constraint, sir);
      case "reference":
        return this.checkReference(constraint, sir);
      case "invariant":
        return this.checkInvariant(constraint, sir);
      case "for_each":
        return this.checkForEach(constraint, sir);
    }
  }
}
```

**Type checking walks the element tree:**

```
For each element matching source pattern:
  get property at propertyPath
  if typeof(property.value) !== expected:
    emit type_mismatch issue
```

**Reference checking resolves the graph:**

```
For each element matching source pattern:
  get property at propertyPath (the referenced id)
  if id not in sir.elements:
    emit missing_reference issue
  if sir.elements[id].type !== targetType:
    emit type_mismatch issue ("expected state, got guard")
```

### 6.3 Invariant Checking Strategy

For state machines, invariants are temporal logic formulas. We use **bounded model checking** (BMC):

```
BMC(invariant, SIR, depth_k):
  Unroll state machine k steps
  Build SAT formula: (initial_state ∧ transitions[0..k-1]) ∧ ¬invariant_unrolled
  If SAT solver finds a model → counterexample exists → report trace
  If UNSAT → no counterexample within bound k → report "passed up to depth k"
```

For arithmetic/logic guards, we use an SMT solver (Z3 integration):

```
Guard exhaustiveness check:
  For state S with trigger T and guards g1, g2, ..., gn:
    Ask SMT solver: is (g1 ∨ g2 ∨ ... ∨ gn) a tautology?
    If no → report uncovered case with concrete counterexample values
```

### 6.4 Constraint Registration

Domain validators register constraints at load time:

```typescript
// state-machine-validator.ts
class StateMachineValidator implements DomainValidator {
  domain = "state-machine";

  registerConstraints(registry: ConstraintRegistry): void {
    // Structural constraints (always run)
    registry.add({
      id: "fsm.type.transition_target",
      type: "for_each",
      iterator: { elementType: "transition" },
      body: {
        type: "reference",
        source: { elementId: "$it", propertyPath: "to" },
        targetType: "state",
        relation: "must-exist"
      },
      severity: "error",
      category: "domain"
    });

    // Invariant constraints (lazy, pre-compile)
    registry.add({
      id: "fsm.invariant.no_deadlock",
      type: "invariant",
      formula: {
        op: "G_exists_next",     // Globally, every state has a next state
        except: { property: "is_terminal", value: true }
      },
      severity: "warning",
      category: "domain",
      timing: "lazy"
    });
  }
}
```

---

## 7. Plugin Architecture for Domain Validators

### 7.1 Plugin Interface

```typescript
interface DomainValidator {
  /** Which domain this validator handles */
  domain: string;

  /** Human-readable name */
  name: string;

  /** Register constraints with the engine */
  registerConstraints(registry: ConstraintRegistry): void;

  /** Run domain-specific checks that can't be expressed as constraints */
  customChecks(sir: SIR, options: CheckOptions): ValidationIssue[];

  /** Declare which elements are required for completeness */
  requiredElements(): RequiredElementSpec[];

  /** Declare which elements are optional */
  optionalElements(): OptionalElementSpec[];
}

interface CheckOptions {
  timing: "continuous" | "pre-compile";
  maxDepth: number;          // for BMC
  timeoutMs: number;         // for SMT
}
```

### 7.2 Plugin Registry

```typescript
class ValidationEngine {
  private validators: Map<string, DomainValidator> = new Map();
  private constraints: ConstraintRegistry = new ConstraintRegistry();

  register(validator: DomainValidator): void {
    this.validators.set(validator.domain, validator);
    validator.registerConstraints(this.constraints);
  }

  async validate(sir: SIR, options: ValidateOptions = {}): Promise<ValidationReport> {
    const timing = options.timing ?? "continuous";
    const issues: ValidationIssue[] = [];

    // Pass 1: Structural (always, first)
    issues.push(...this.runStructuralChecks(sir));

    // Early exit: if structural fails, don't bother with domain checks
    if (issues.some(i => i.severity === "error")) {
      return this.assembleReport("fail", issues, sir);
    }

    // Pass 2: Core constraint evaluation (filtered by timing)
    issues.push(...this.constraints.evaluate(sir, timing));

    // Pass 3: Domain-specific custom checks
    const domainValidator = this.validators.get(sir.domain);
    if (domainValidator) {
      issues.push(...domainValidator.customChecks(sir, { timing, ...options }));
    }

    // Pass 4: Consistency (lazy only)
    if (timing === "pre-compile") {
      issues.push(...this.runConsistencyChecks(sir));
      issues.push(...this.runCompletenessCheck(sir, domainValidator));
    }

    // Pass 5: Confidence filter
    issues.push(...this.runConfidenceFilter(sir));

    return this.assembleReport(issues, sir);
  }
}
```

### 7.3 Registration at Startup

```typescript
const engine = new ValidationEngine();

// Core validators (always loaded)
engine.register(new StateMachineValidator());
engine.register(new WorkflowValidator());
engine.register(new DataModelValidator());
engine.register(new ApiSpecValidator());

// Custom validators (loaded from config)
for (const plugin of loadPlugins("./validators/")) {
  engine.register(plugin);
}
```

---

## 8. Completeness Analysis

### 8.1 What Makes a Specification "Complete Enough"?

Different domains have different completeness thresholds. A validator declares:

```typescript
interface RequiredElementSpec {
  elementType: string;
  minCount: number;         // at least this many
  maxCount?: number;        // at most this many (if applicable)
  description: string;      // human-readable, for conversation
}

interface OptionalElementSpec {
  elementType: string;
  description: string;
  compiledAs: "stub" | "todo" | "omit";  // what to do when missing
}
```

**State Machine completeness spec:**

```typescript
requiredElements(): RequiredElementSpec[] {
  return [
    { elementType: "state", minCount: 2,
      description: "At least 2 states (start and end)" },
    { elementType: "transition", minCount: 1,
      description: "At least 1 transition" },
  ];
}

optionalElements(): OptionalElementSpec[] {
  return [
    { elementType: "guard", description: "Transition guards",
      compiledAs: "stub" },       // compile with guard: true (always pass)
    { elementType: "action", description: "Entry/exit actions",
      compiledAs: "stub" },       // compile with no-op actions
    { elementType: "invariant", description: "Temporal invariants",
      compiledAs: "omit" },       // skip invariant in compiled output
  ];
}
```

### 8.2 CompletenessReport Generation

```typescript
function runCompletenessCheck(
  sir: SIR,
  validator: DomainValidator | undefined
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!validator) {
    // Unknown domain — can't check completeness
    return [{
      severity: "warning",
      category: "completeness",
      code: "completeness.unknown_domain",
      message: `No validator registered for domain "${sir.domain}". Cannot verify completeness.`,
    }];
  }

  const required = validator.requiredElements();
  const optional = validator.optionalElements();

  // Count elements by type
  const counts = new Map<string, number>();
  for (const el of sir.elements) {
    counts.set(el.type, (counts.get(el.type) || 0) + 1);
  }

  // Check required
  for (const spec of required) {
    const count = counts.get(spec.elementType) || 0;
    if (count < spec.minCount) {
      issues.push({
        severity: "error",
        category: "completeness",
        code: "completeness.missing_required",
        message: `Missing ${spec.elementType}: need at least ${spec.minCount},
          found ${count}. ${spec.description}`,
        suggestion: {
          description: `Define ${spec.minCount - count} more ${spec.elementType}(s)`,
          action: "add",
          conversationPrompt: `You need at least ${spec.minCount - count}
            more ${spec.elementType}(s). ${spec.description}. What should they be?`,
        },
      });
    }
    if (spec.maxCount !== undefined && count > spec.maxCount) {
      issues.push({
        severity: "warning",
        category: "completeness",
        code: "completeness.too_many",
        message: `Too many ${spec.elementType}s: max ${spec.maxCount}, found ${count}.`,
      });
    }
  }

  // Check optional — informational only
  for (const spec of optional) {
    const count = counts.get(spec.elementType) || 0;
    if (count === 0) {
      issues.push({
        severity: "info",
        category: "completeness",
        code: "completeness.missing_optional",
        message: `No ${spec.elementType}s defined. ${spec.description}.
          Will compile with ${spec.compiledAs}.`,
        suggestion: {
          description: `Optionally define ${spec.elementType}s`,
          action: "add",
          conversationPrompt: `You can add ${spec.elementType}s (${spec.description})
            but they're optional. Want to add any?`,
        },
      });
    }
  }

  return issues;
}
```

### 8.3 Graduated Completeness

The compilation layer uses the completeness report to decide output quality:

| SIR Completeness | Compiled Output |
|-----------------|-----------------|
| Full (all required + all optional) | Production artifact |
| Required-only (all required, some optional missing) | Functional artifact with stubs |
| Partial (some required missing) | Skeleton with TODO markers |
| Incomplete (many required missing) | Compilation refused |

**Example — Partial state machine compiles to:**

```python
# COMPILED FROM PARTIAL SPEC — TODO markers indicate gaps
class TrafficLightFSM:
    def __init__(self):
        self.state = "red"  # initial state

    # TODO: Missing transition from "red" — need a trigger
    # TODO: State "yellow" has no incoming transitions
    # WARNING: State "green" has no outgoing transitions (may be terminal)

    def trigger_green_timer(self):  # STUB — guard not specified
        if self.state == "green":
            self.state = "yellow"
```

---

## 9. Complete Example: Validation Pipeline on a State Machine

### Input SIR (from extraction layer):

```yaml
domain: state-machine
elements:
  - id: "red"
    type: "state"
    properties: { name: "Red", is_initial: true }
    metadata: { confidence: 0.95 }

  - id: "green"
    type: "state"
    properties: { name: "Green" }
    metadata: { confidence: 0.90 }

  - id: "yellow"
    type: "state"
    properties: { name: "Yellow" }
    metadata: { confidence: 0.45 }       # LOW CONFIDENCE

  - id: "t1"
    type: "transition"
    properties: { from: "red", to: "green", trigger: "timer" }
    metadata: { confidence: 0.92 }

  - id: "t2"
    type: "transition"
    properties: { from: "green", to: "red", trigger: "timer" }
    metadata: { confidence: 0.50 }       # UNCERTAIN

  - id: "t3"
    type: "transition"
    properties: { from: "red", to: "green", trigger: "timer", guard: "emergency == false" }
    metadata: { confidence: 0.30 }       # VERY LOW — probably contradictory

constraints:
  - id: "inv_no_red_forever"
    type: "invariant"
    expression:
      op: "G_implies"
      left: { op: "in_state", state: "red" }
      right: { op: "F", formula: { op: "in_state", state: "green" } }

confidence:
  perElement:
    red: 0.95
    green: 0.90
    yellow: 0.45
    t1: 0.92
    t2: 0.50
    t3: 0.30
  overall: 0.67
  threshold: 0.80
```

### Validation Pass 1 — Structural:

```
✅ PASS: All elements have valid types, unique ids, correct property types.
```

### Validation Pass 2 — Reference:

```
✅ PASS: All transition from/to references resolve to existing states.
```

### Validation Pass 3 — Domain (continuous, cheap):

```
WARNING [domain.fsm.unreachable] State "yellow" is unreachable.
  No transitions target it.

WARNING [domain.fsm.guard_shadow] Transition "t3" is shadowed by "t1":
  both fire from "red" on "timer", but "t1" has no guard (always matches),
  so "t3" (guard: emergency == false) can never fire.
```

### Validation Pass 4 — Confidence:

```
ERROR   [confidence.below_floor] Element "t3" has confidence 0.30 (< 0.5 floor).
  Clarify: was "emergency == false" actually intended?

ERROR   [confidence.below_floor] Element "yellow" has confidence 0.45 (< 0.5 floor).
  Clarify: is "Yellow" a real state in this machine?

WARNING [confidence.below_threshold] Element "t2" has confidence 0.50.
  "green → red on timer" is uncertain. Verify this transition.

WARNING [confidence.overall] Overall SIR confidence (0.67) < threshold (0.80).
  Consider clarifying uncertain elements before compiling.
```

### Validation Pass 5 — Consistency (pre-compile, lazy):

```
✅ PASS: Invariant "no_red_forever" holds up to bounded depth 10.
  Transition t1 (red → green) satisfies the invariant.
```

### Validation Pass 6 — Completeness:

```
✅ PASS: Required elements present:
  - states: 3 (min 2) ✓
  - transitions: 3 (min 1) ✓

INFO  [completeness.missing_optional] No "action" elements defined.
  Entry/exit actions are optional. Will compile with no-ops.

INFO  [completeness.missing_optional] No "guard" elements (as standalone
  definitions) — guard on t3 is inline. Guards are optional.
```

### Final ValidationReport:

```json
{
  "status": "fail",
  "issues": [...all above...],
  "stats": {
    "errors": 2,
    "warnings": 4,
    "infos": 2,
    "checksRun": 8,
    "checksSkipped": 1,
    "durationMs": 12
  },
  "completeness": {
    "status": "partial",
    "missingRequired": [],
    "missingOptional": ["action", "guard"],
    "gaps": [
      { "type": "low_confidence", "elements": ["t3", "yellow", "t2"] },
      { "type": "guard_shadow", "elements": ["t3"] }
    ]
  },
  "blockers": [
    { "issueId": "conf-b1", "reason": "Element t3 below confidence floor" },
    { "issueId": "conf-b2", "reason": "Element yellow below confidence floor" }
  ],
  "suggestions": [
    {
      "description": "Remove t3 or add a guard to t1",
      "action": "modify",
      "target": "t3",
      "conversationPrompt": "I see two transitions from 'red' to 'green' on 'timer' — one with a guard and one without. The unguarded one always matches, so the guarded one never fires. Which behavior do you want?"
    },
    {
      "description": "Clarify yellow state purpose",
      "action": "clarify",
      "target": "yellow",
      "conversationPrompt": "I'm not sure about the 'yellow' state — it has no transitions to or from it. Is this a real state in your traffic light, or was it mentioned in passing?"
    }
  ]
}
```

### Agent Response in Conversation:

> **I validated your state machine spec. Here's what I found:**
>
> **2 issues blocking compilation:**
> - The transition from red→green with guard `emergency==false` conflicts with the unguarded one — the guarded one can never fire. Which did you intend?
> - I'm not confident about the "yellow" state — it's disconnected from everything. Is this intentional?
>
> **4 warnings (won't block, but worth checking):**
> - Yellow has no transitions to it
> - The green→red transition is uncertain
> - Overall confidence is at 67% — below the 80% threshold
>
> **Missing optional things (no action needed):**
> - No entry/exit actions defined (will compile as no-ops)
>
> **Want me to fix the guard conflict, or do you want to clarify yellow first?**

---

## 10. API Reference

### `validate(sir: SIR, options?: ValidateOptions): ValidationReport`

```typescript
interface ValidateOptions {
  /** Validation timing mode */
  timing?: "continuous" | "pre-compile";

  /** Max depth for bounded model checking (default: 10) */
  maxDepth?: number;

  /** Timeout for SMT solver (default: 5000ms) */
  solverTimeoutMs?: number;

  /** Skip expensive checks even in pre-compile mode */
  skipExpensive?: boolean;

  /** Only validate specific element ids (incremental) */
  scope?: string[];
}
```

### `register(validator: DomainValidator): void`

Register a domain validator plugin. Must be called before `validate()` for that domain.

### `getReport(sirId: string): ValidationReport | null`

Retrieve the last validation report for a given SIR (reports are cached).

### `validateIncremental(sir: SIR, delta: SIRDelta): ValidationReport`

Incremental validation. Only checks elements affected by the delta.

---

## 11. Design Decisions Summary

| Decision | Rationale |
|----------|-----------|
| Fail-cheap ordering | Avoids running SMT on malformed SIRs; structural checks are O(n) and catch 80% of issues |
| Plugin architecture | Domain validators are the extension point; core engine never knows about state machines |
| Constraint expression tree | Structured constraints are evaluable; raw strings ("trigger must be a string") require parsing |
| Confidence floor at 0.5 | Below 0.5, the extraction is essentially guessing; requiring clarification is better than wrong compilation |
| Continuous + pre-compile | Two-timing splits the workload: fast feedback in conversation, thorough checks before artifact generation |
| Bounded model checking | Full LTL model checking is PSPACE-complete; bounded is practical and catches most real-world bugs |
| Graduated completeness | Not all specs need to be "complete" — a skeleton with TODOs is often better than refusing to compile |
| Conversation-aware suggestions | Every error can produce a natural-language prompt; the validation engine feeds the conversation loop |

---

## 12. Open Questions for Review

1. **SMT solver dependency:** Z3 is ~30MB. Worth bundling, or should we make it optional and degrade gracefully (skip guard exhaustiveness, flag as INFO)?

2. **Confidence aggregation:** Currently uses a simple floor. Should we use a weighted average (by element importance)? A critical transition with 0.49 confidence probably matters more than a comment element with 0.3.

3. **Max depth for BMC:** Defaulting to 10 may miss deep counterexamples. Make it configurable per-domain? A state machine with 100 states might need depth 100.

4. **Incremental validation edge case:** If element A is removed, and element B references A, we re-validate B. But what if B had already been flagged and the human acknowledged it? Should incremental validation suppress re-reporting of known issues?

5. **Human-in-the-loop for expensive checks:** Should pre-compile validation ask before running expensive checks that might take >5 seconds? Or transparently run them with a timeout?
