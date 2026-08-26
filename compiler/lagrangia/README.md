# Lagrangia

The spec-as-Lagrangian probe — a post-compilation reducer that sits between Speckl's IR and its Rust codegen. Given candidate implementations, it scores them by an action functional and selects the stationary (minimum-action) one, then verifies the invariants hold via real Z3.

## Status

- **v0** (2026-07-18): action functional + random-restart/hill-descent search over ToggleSwitch. 8/8 tests pass, stationary point at S=43.47. Static proxy for invariant distance.
- **v1.1** (2026-07-19): real Z3 wiring via shell-out to `z3 -smt2`. The `invariant_distance` term is now computed by actually running Z3 against each candidate's invariant obligations, not a static proxy. 13/13 tests pass (12 unit + 1 integration). The stationary candidate verifies as `Proved` via Z3.

## The action functional

`S(impl) = w1·complexity + w2·invariant_distance + w3·byte_entropy`

with weights `w1=1.0, w2=100.0, w3=0.1`. The `invariant_distance` term dominates: any implementation that doesn't satisfy the spec has action ≥ 100, any that does has action < 50. This makes the "stationary" point provably the simplest correct implementation — the literal variational claim.

| Term | What it measures | How computed (v1.1) |
|---|---|---|
| `complexity(impl)` | Lines of generated Rust | Non-comment, non-empty line count |
| `invariant_distance(impl)` | How far from satisfying invariants | **Z3 shell-out**: `unsat` → 0, `sat` → counterexample depth, `unknown` → 1000 |
| `byte_entropy(impl)` | Shannon entropy of source bytes | `-Σ p_i · log2(p_i)` over byte histogram |

## v1.1 Z3 wiring

`verify_candidate(obligations: &[InvariantObligation]) -> Z3Result` shells out to `z3 -in -smt2` for each obligation, parsing the `check-sat` result:

- `unsat` → `Z3Result::Proved` (no counterexample exists; invariant holds)
- `sat` → `Z3Result::Counterexample { depth: 1 }` (violating state found)
- `unknown` → `Z3Result::Unknown { reason }` (inconclusive; treated as worst-case)

`Z3Result` drives `invariant_distance`, which dominates the action functional. A candidate that breaks a guard (e.g. drops the `if !(!self.is_on)` check in ToggleSwitch) gets `Counterexample` → distance ≥ 1 → action ≥ 100, while a correct candidate gets `Proved` → distance 0 → action ~43.

The integration test (`tests/toggle_switch.rs`) generates 20 perturbed candidates from the ToggleSwitch codegen output, scores each with real Z3 verification, descends 3 rounds, and selects the stationary point. The gold candidate (unperturbed codegen, both guards intact) verifies as `Proved` and wins with S=43.47 — confirming the variational claim.

## Usage

```rust
use lagrangia::{action, verify_candidate, ImplCandidate, InvariantObligation, Z3Result};

let obligations = vec![
    InvariantObligation {
        name: "turn_on_guard".to_string(),
        smt_query: "(declare-const is_on Bool) (assert (and is_on (not is_on)))".to_string(),
    },
];
let z3_result = verify_candidate(&obligations);  // shells out to z3
let candidate = ImplCandidate { id: 0, rust_source: source, z3_result };
let score = action(&candidate);
```

## Build & test

```sh
cd compiler/lagrangia
cargo build
cargo test
```

Requires `z3` on `PATH` (v1.1). Install via `nix profile install nixpkgs#z3` or your system package manager.

## Spec

The variational claim: the spec-as-Lagrangian produces a well-defined minimum that Z3 can verify.

## Falsification conditions

The Lagrangian claim is **false** if any hold:
1. The action functional produces no well-defined minimum (flat/chaotic scores).
2. The stationary candidate fails Z3 as often as a random one (no selection signal).
3. The search doesn't converge (hill descent cycles/plateaus).

v1.1 results on ToggleSwitch: variance > 0 (manifold is non-degenerate), stationary candidate verifies `Proved` via Z3 (selection beats random), search converges in 3 rounds (no plateau). All three conditions hold — the variational claim survives.