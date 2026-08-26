# Designing SpeckDL: What a Spec Language Needs in 2026

> Blog Post #2/5 in the Speckl technical series. Extract from [Speckl Whitepaper v2](https://github.com/wscoble/speckl/blob/main/docs/whitepaper-v2.md), Section 2.

---

Specification languages have a design problem. Most are built for verification, not for production. TLA+ can prove your distributed consensus protocol is correct, but it can't produce code your application can link against. Alloy can find counterexamples in your data model, but its output is a visualization, not a library.

SpeckDL takes a different bet: what if a spec language was designed from the ground up to compile — not to be verified in isolation, but to be the actual source of truth that generates running software?

Here's how we designed it, and what we learned along the way.

## Four Principles, One File

SpeckDL is built on four design principles that distinguish it from both formal methods languages and general-purpose programming languages:

**1. Spec as source of truth.** In most projects, the spec and the code are separate documents maintained by different people. They drift. When they conflict, nobody knows which one is right. In SpeckDL, the `.speckdl` file IS the authoritative description. Generated code is derived, not co-equal. If the spec and the code disagree, the spec wins — and the compiler tells you they disagree.

**2. State machines, not procedures.** Every SpeckDL specification models a state machine: typed state variables, guarded transitions (actions), and invariants that must hold across every transition. This is the same mental model as TLA+. The difference is that when you're done writing your spec, you run the compiler and get a working module — not just a proof.

**3. Type-safe by construction.** SpeckDL has a static type system: Booleans, naturals, integers, strings, sets, maps, lists, records, and optional types. Every expression is type-checked before code generation. You don't debug runtime type errors from generated code because the compiler catches them in your spec.

**4. Emit for observability.** Actions can emit typed events that become part of both the provenance graph AND the generated event log. Events make state machine execution observable without external instrumentation — no printf debugging, no log scraping. The spec declares what's observable, and the compiler makes it so.

## What's In a Speck?

A SpeckDL file is structured, not stream-of-consciousness. Every spec has the same anatomy:

```
speck Name {
    type ...          // optional type aliases
    state { ... }     // state variables
    init { ... }      // initial state
    invariant ...     // safety properties
    action ...        // state transitions
    next: ...         // action composition
}
```

The constraints are deliberate. There are no global variables. No hidden state. No ambient context. Everything a speck can observe or modify is declared in its `state` block. This isn't restrictive — it's honest. It forces you to say what your system actually cares about.

## The Type System: Rich Enough to Model, Simple Enough to Compile

The type system is where most DSLs either overreach or underdeliver. Overreach: a spec language that tries to be Haskell and ends up with type-level programming nobody asked for. Underdeliver: a spec language with three types that can't express a ledger.

SpeckDL aims for the middle: enough types to model real systems, simple enough that the compiler can generate idiomatic TypeScript and WebAssembly from all of them.

| Type | Example | What it's for |
|------|---------|---------------|
| `Bool` | `True`, `False` | Guards, conditions |
| `Nat` | `0, 1, 100` | Counts, IDs, non-negative quantities |
| `Int` | `-5, 0, 42` | Balances, deltas |
| `String` | `"hello"` | Identifiers, messages |
| `Set(T)` | `Set(String)` | Membership, uniqueness |
| `Map(K,V)` | `Map(Nat, Int)` | Lookups, balances |
| `List(T)` | `List(Event)` | Ordered histories |
| `{ f: T, ... }` | `{ id: String, term: Nat }` | Structured data |
| `T \| null` | `String \| null` | Optional fields |

**Sets** are first-class. You can union them, intersect them, check membership, and ask for size. The literal `emptySet` starts everything off. If your spec needs to track "which nodes have voted," you use a set. If you need to check "was this ID already used," you check set membership. Sets make invariants readable:

```
invariant noDuplicateVotes: voteIds subsetOf acceptedIds
```

**Maps** give you keyed access without pointer arithmetic. `balances[from]` works like you'd expect. Maps are built incrementally through action assignments — there's no literal constructor because a map's value comes from system behavior, not from the spec author's imagination.

**Records** are structural, not nominal. Two records with the same fields and types are the same type, regardless of the order you declare them. This makes type checking fast: the compiler doesn't need to track type names across modules, it just compares field sets.

## Actions: Guard, Mutate, Emit

Actions are where specs come alive. An action in SpeckDL has four parts:

```
action Transfer(from: Nat, to: Nat, amount: Nat) {
    require from in accounts          // precondition
    require to in accounts
    require balances[from] >= amount

    balances[from] := balances[from] - amount   // mutation
    balances[to] := balances[to] + amount

    emit Transferred { from: from, to: to, amount: amount }  // observability
}
```

**Preconditions** (`require`) are the guard rails. If a precondition fails, the action doesn't execute. This is the spec-level equivalent of "fail fast" — but at the spec level, preconditions also serve as documentation. Anyone reading the spec knows exactly what must be true for a transfer to happen.

**Mutations** use `:=` (assignment), not `==` (equality). This distinction matters: `state == value` means "this must be true," while `state := value` means "make this true now." The compiler enforces the difference. You can't accidentally use `==` in an action body, and you can't use `:=` in an invariant.

**Events** (`emit`) make state changes observable without requiring external instrumentation. Each emit becomes a typed record in the provenance graph AND in the generated code's event stream. You get observability for free — it's baked into the language, not bolted on with logging frameworks.

## Invariants: What Must Always Be True

Invariants are boolean expressions the compiler evaluates at compile time (for structural properties) and the generated code checks at runtime (for state-dependent properties):

```
invariant nonNegativeBalances: all(b in balances.values, b >= 0)
invariant consistentTotal: sum(balances.values) == totalSupply
```

If you come from TLA+, this pattern is familiar. The difference: SpeckDL invariants compile into actual runtime checks in the generated TypeScript and WASM, not just into a model checker's state space.

## The Compile Target: Five Artifacts, One Spec

This is where SpeckDL earns its keep. One speck file produces five outputs:

| Artifact | Purpose | Consumer |
|----------|---------|----------|
| PROV-O graph | Provenance: who generated what, from which spec | Auditors, compliance |
| CycloneDX SBOM | Software bill of materials | Security tools, GRC |
| SPDX | License declarations | Open source compliance |
| TypeScript class | Runnable state machine | Applications, tests |
| WebAssembly module | Sandboxed execution | Browsers, edge, embedded |

The first three satisfy compliance requirements (NIST SA-11, supply chain transparency). The last two give you running code. The key insight: **all five come from the same source**. When an auditor asks "where did this code come from?", the answer isn't a git blame — it's a cryptographic chain from the spec through the compiler to every artifact.

## Why This Matters in 2026

Three trends converge:

1. **AI-generated code is everywhere.** Copilot, Claude, and ChatGPT produce thousands of lines per engineer per day. Nobody reads all of it. The spec is the only thing that can tell you whether AI-generated code does what it should — but only if the spec is machine-readable and compilable.

2. **Compliance isn't optional anymore.** NIST SA-11 requires "human-in-the-loop for automated outputs." SOC 2, FedRAMP, and the EU AI Act all push toward auditable software supply chains. A prose spec document isn't auditable. A compilable spec that produces provenance graphs is.

3. **Spec-first development is technically feasible.** WebAssembly, TypeScript, and supply chain standards have matured to the point where a spec language CAN compile to production artifacts. The pieces exist. SpeckDL connects them.

## What We Learned Building It

The biggest surprise: **simplicity beats expressiveness every time.** Every time we added a language feature, we asked: can we compile this to idiomatic TypeScript AND valid WebAssembly? If the answer was "yes, but with compromises," we cut the feature. The language is smaller than we first imagined, and better for it.

The second lesson: **compiler feedback is a spec quality tool.** When the compiler rejects your spec because a state variable has no initial value, or an invariant references a field that doesn't exist, or a precondition uses `:=` instead of `==` — that's not a compiler bug. That's the compiler catching spec bugs before they become code bugs.

The third lesson: **provenance changes the conversation.** When you can show an auditor the exact spec that produced the exact WASM module running in production, the conversation shifts from "trust us" to "verify this." That's the whole point.

---

**Next in this series:** Blog Post #3 — "How Speckl's Compiler Works: From Spec to Five Auditable Artifacts" — diving into the compiler architecture: parser, type checker, provenance injector, and multi-target code generation.

**Read the full whitepaper:** [Speckl Whitepaper v2](https://github.com/wscoble/speckl/blob/main/docs/whitepaper-v2.md)

**Previous post:** [Spec-Code Drift Is a Provenance Problem](https://github.com/wscoble/speckl/blob/main/docs/blog-01-spec-code-gap.md)

---

*Scott Scoble is building [Speckl](https://speckl.scoble.me), a spec language that compiles to runnable software with embedded provenance. Follow along at [speckl.scoble.me](https://speckl.scoble.me).*
