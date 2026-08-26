//! Lagrangia reducer — the spec-as-Lagrangian probe.
//!
//! Sits between Speckl's IR and its Rust codegen. Given candidate
//! implementations, scores them by an action functional and selects
//! the stationary (minimum-action) one.
//!
//! v1.1: real Z3 wiring via shell-out to `z3 -smt2`.
//! See `~/.hermes/plans/2026-07-18-lagrangia-reducer-spec.md`.
pub mod score;

pub use score::{
    action, byte_entropy, complexity, invariant_distance, verify_candidate, ImplCandidate,
    InvariantObligation, Z3Result,
};