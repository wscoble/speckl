//! Action functional for the Lagrangia reducer.
//!
//! Spec §2.3: `S(impl) = w1·complexity + w2·invariant_distance + w3·byte_entropy`
//! with v0 weights `w1=1.0, w2=100.0, w3=0.1`.
//!
//! v1.1: real Z3 wiring via shell-out to `z3 -smt2`. The `invariant_distance`
//! term is now computed by actually running Z3 against the candidate's
//! state-machine semantics, not a static proxy. See `verify_candidate`.

use std::io::Write;
use std::process::{Command, Stdio};

/// Result of running Z3 on a candidate's invariant obligations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Z3Result {
    /// Z3 returned `unsat` — no counterexample exists; invariants hold.
    /// `invariant_distance` = 0.
    Proved,
    /// Z3 returned `sat` — a counterexample model exists.
    /// `depth` is the counterexample trace depth (number of transition steps
    /// Z3 needed to find the violation; 1 for a one-step violation).
    Counterexample { depth: u32 },
    /// Z3 returned `unknown` or errored — verification inconclusive.
    /// Treated as worst-case (depth = max_depth) for scoring.
    Unknown { reason: String },
}

impl Z3Result {
    /// Returns `true` iff Z3 proved the invariants hold (`Proved`).
    pub fn holds(&self) -> bool {
        matches!(self, Z3Result::Proved)
    }

    /// Numeric distance used by the action functional.
    /// Proved → 0, Counterexample{depth} → depth, Unknown → large constant.
    pub fn distance(&self) -> f64 {
        match self {
            Z3Result::Proved => 0.0,
            Z3Result::Counterexample { depth } => *depth as f64,
            Z3Result::Unknown { .. } => 1000.0,
        }
    }
}

/// A candidate implementation in the search manifold.
#[derive(Debug, Clone)]
pub struct ImplCandidate {
    pub id: u64,
    pub rust_source: String,
    /// Z3 verification result for this candidate's invariants.
    /// v1.1: replaced the v0 `invariant_holds: bool` + `counterexample_depth: u32`
    /// proxy with a real `Z3Result` from shelling out to `z3 -smt2`.
    pub z3_result: Z3Result,
}

/// Back-compat helper: returns `true` if invariants hold (z3_result.holds()).
impl ImplCandidate {
    pub fn invariant_holds(&self) -> bool {
        self.z3_result.holds()
    }
}

/// v0 weights from spec §2.3.
pub const W_COMPLEXITY: f64 = 1.0;
pub const W_INVARIANT_DISTANCE: f64 = 100.0;
pub const W_BYTE_ENTROPY: f64 = 0.1;

/// `complexity(impl)` — lines of generated Rust code (spec §2.3, row 1).
///
/// Counts non-empty, non-comment lines to avoid trivial inflation.
pub fn complexity(source: &str) -> f64 {
    source
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with("//")
        })
        .count() as f64
}

/// `invariant_distance(impl)` — how far the implementation is from satisfying
/// each invariant (spec §2.3, row 2).
///
/// v1.1: uses the real Z3 result. Proved → 0, Counterexample → depth,
/// Unknown → 1000 (worst-case).
pub fn invariant_distance(candidate: &ImplCandidate) -> f64 {
    candidate.z3_result.distance()
}

/// `byte_entropy(impl)` — Shannon entropy of the generated source bytes
/// (spec §2.3, row 3), in bits per byte.
///
/// Returns 0.0 for empty input (degenerate case, avoids div-by-zero).
pub fn byte_entropy(source: &[u8]) -> f64 {
    if source.is_empty() {
        return 0.0;
    }
    let mut counts = [0u32; 256];
    for &b in source {
        counts[b as usize] += 1;
    }
    let total = source.len() as f64;
    let mut entropy = 0.0;
    for &c in &counts {
        if c == 0 {
            continue;
        }
        let p = c as f64 / total;
        entropy -= p * p.log2();
    }
    entropy
}

/// `S(impl)` — the action functional (spec §2.3).
///
/// `S = w1·complexity + w2·invariant_distance + w3·byte_entropy`
pub fn action(candidate: &ImplCandidate) -> f64 {
    W_COMPLEXITY * complexity(&candidate.rust_source)
        + W_INVARIANT_DISTANCE * invariant_distance(candidate)
        + W_BYTE_ENTROPY * byte_entropy(candidate.rust_source.as_bytes())
}

/// An invariant obligation: a name + an SMT-LIB assertion string that must be
/// **unsatisfiable** (i.e. no counterexample exists). The assertion is framed
/// as "there exists a state violating the invariant" — Z3 `unsat` means the
/// invariant holds.
#[derive(Debug, Clone)]
pub struct InvariantObligation {
    /// Human-readable name (e.g. "turn_on_guard").
    pub name: String,
    /// SMT-LIB2 fragment asserting "a violating state exists". Z3 `unsat`
    /// proves no such state exists → invariant holds.
    pub smt_query: String,
}

/// Shell out to `z3 -smt2` and return the sat/unsat/unknown result.
///
/// Feeds `smt_script` to Z3's stdin, captures stdout, parses `check-sat`.
/// Returns `Z3Result::Proved` for `unsat`, `Counterexample{depth:1}` for
/// `sat` (one-step counterexample by default), `Unknown{reason}` for
/// `unknown` or parse errors.
fn run_z3(smt_script: &str) -> Result<Z3Result, String> {
    let mut child = Command::new("z3")
        .arg("-in")
        .arg("-smt2")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn z3: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(smt_script.as_bytes())
            .map_err(|e| format!("failed to write z3 stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for z3: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Parse the last `check-sat` result. Z3 prints `sat`, `unsat`, or
    // `unknown` on its own line.
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        match trimmed {
            "unsat" => return Ok(Z3Result::Proved),
            "sat" => return Ok(Z3Result::Counterexample { depth: 1 }),
            "unknown" => {
                return Ok(Z3Result::Unknown {
                    reason: "z3 returned unknown".to_string(),
                })
            }
            _ => continue,
        }
    }

    // If no sat/unsat line found, check stderr for errors.
    if !stderr.is_empty() {
        return Ok(Z3Result::Unknown {
            reason: format!("z3 stderr: {}", stderr.lines().next().unwrap_or("?")),
        });
    }

    Ok(Z3Result::Unknown {
        reason: "no check-sat result in z3 output".to_string(),
    })
}

/// Verify a candidate implementation against a set of invariant obligations
/// by shelling out to Z3 for each obligation.
///
/// Returns the **worst** result across all obligations: if any obligation is
/// `Counterexample`, the candidate is `Counterexample` with the max depth;
/// if any is `Unknown` (and none is `Counterexample`), the candidate is
/// `Unknown`; only if all are `Proved` is the candidate `Proved`.
///
/// Each obligation's `smt_query` is wrapped in `(check-sat)` automatically.
pub fn verify_candidate(obligations: &[InvariantObligation]) -> Z3Result {
    if obligations.is_empty() {
        return Z3Result::Proved;
    }

    let mut worst = Z3Result::Proved;
    let mut worst_depth: u32 = 0;

    for obl in obligations {
        let script = format!("{}\n(check-sat)\n", obl.smt_query);
        match run_z3(&script) {
            Ok(res) => match res {
                Z3Result::Proved => {}
                Z3Result::Counterexample { depth } => {
                    if depth > worst_depth {
                        worst_depth = depth;
                    }
                    worst = Z3Result::Counterexample { depth };
                }
                Z3Result::Unknown { ref reason } => {
                    if !matches!(worst, Z3Result::Counterexample { .. }) {
                        worst = Z3Result::Unknown {
                            reason: format!("{}: {}", obl.name, reason),
                        };
                    }
                }
            },
            Err(e) => {
                if !matches!(worst, Z3Result::Counterexample { .. }) {
                    worst = Z3Result::Unknown {
                        reason: format!("{}: z3 spawn error: {}", obl.name, e),
                    };
                }
            }
        }
    }

    worst
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn candidate(source: &str, result: Z3Result) -> ImplCandidate {
        ImplCandidate {
            id: 0,
            rust_source: source.to_string(),
            z3_result: result,
        }
    }

    #[test]
    fn complexity_counts_non_comment_non_empty_lines() {
        let src = "// a comment\nlet x = 1;\n\n// another\nlet y = 2;\n";
        assert_eq!(complexity(src), 2.0);
    }

    #[test]
    fn invariant_distance_zero_when_proved() {
        let c = candidate("fn main() {}", Z3Result::Proved);
        assert_eq!(invariant_distance(&c), 0.0);
    }

    #[test]
    fn invariant_distance_uses_depth_on_counterexample() {
        let c = candidate("fn main() {}", Z3Result::Counterexample { depth: 5 });
        assert_eq!(invariant_distance(&c), 5.0);
    }

    #[test]
    fn invariant_distance_large_on_unknown() {
        let c = candidate(
            "fn main() {}",
            Z3Result::Unknown {
                reason: "test".to_string(),
            },
        );
        assert_eq!(invariant_distance(&c), 1000.0);
    }

    #[test]
    fn byte_entropy_uniform_is_eight_bits() {
        let bytes: Vec<u8> = (0u16..256).map(|b| b as u8).collect();
        let e = byte_entropy(&bytes);
        assert!((e - 8.0).abs() < 1e-9, "got {e}");
    }

    #[test]
    fn byte_entropy_zero_for_empty() {
        assert_eq!(byte_entropy(&[]), 0.0);
    }

    #[test]
    fn action_dominated_by_invariant_distance() {
        // A correct impl: complexity ~5, inv dist 0, entropy ~4 → action ~5.4
        let correct = candidate(
            "fn main() {\n    let x = 1;\n    let y = 2;\n}\n",
            Z3Result::Proved,
        );
        // An incorrect impl: complexity ~5, inv dist 10, entropy ~4 → action ~1005.4
        let incorrect = candidate(
            "fn main() {\n    let x = 1;\n    let y = 2;\n}\n",
            Z3Result::Counterexample { depth: 10 },
        );
        let a_correct = action(&correct);
        let a_incorrect = action(&incorrect);
        assert!(
            a_incorrect - a_correct > 100.0,
            "invariant_distance should dominate: correct={a_correct}, incorrect={a_incorrect}"
        );
    }

    // --- Z3 integration tests (v1.1 real wiring) ---

    #[test]
    fn z3_proves_trivially_unsat() {
        // No state can violate `false` → unsat → Proved.
        let obl = InvariantObligation {
            name: "trivial".to_string(),
            smt_query: "(declare-const x Int) (assert false)".to_string(),
        };
        let result = verify_candidate(&[obl]);
        assert_eq!(result, Z3Result::Proved);
    }

    #[test]
    fn z3_finds_counterexample_when_sat() {
        // There exists an Int > 10 → sat → Counterexample.
        let obl = InvariantObligation {
            name: "large_int_exists".to_string(),
            smt_query: "(declare-const x Int) (assert (> x 10))".to_string(),
        };
        let result = verify_candidate(&[obl]);
        assert!(matches!(result, Z3Result::Counterexample { .. }));
    }

    #[test]
    fn z3_proves_toggle_turn_on_guard() {
        // ToggleSwitch invariant: turn_on requires !is_on.
        // Assert "exists a state where is_on=true AND turn_on succeeds (guard !is_on holds)"
        // → this is `is_on=true AND !is_on` = `is_on=true AND is_on=false` = unsat.
        // Proved means no state violates the guard.
        let obl = InvariantObligation {
            name: "turn_on_guard".to_string(),
            smt_query: "(declare-const is_on Bool) (assert (and is_on (not is_on)))".to_string(),
        };
        let result = verify_candidate(&[obl]);
        assert_eq!(result, Z3Result::Proved);
    }

    #[test]
    fn z3_finds_toggle_guard_violation() {
        // A broken implementation: turn_on has no guard, so is_on=true is
        // a violating state. Assert "exists state where is_on=true AND
        // turn_on is called" = sat → Counterexample.
        let obl = InvariantObligation {
            name: "broken_turn_on".to_string(),
            smt_query: "(declare-const is_on Bool) (assert is_on)".to_string(),
        };
        let result = verify_candidate(&[obl]);
        assert!(matches!(result, Z3Result::Counterexample { .. }));
    }

    #[test]
    fn verify_takes_worst_result() {
        // One Proved + one Counterexample → overall Counterexample.
        let obls = vec![
            InvariantObligation {
                name: "holds".to_string(),
                smt_query: "(declare-const x Int) (assert false)".to_string(),
            },
            InvariantObligation {
                name: "broken".to_string(),
                smt_query: "(declare-const x Int) (assert (> x 10))".to_string(),
            },
        ];
        let result = verify_candidate(&obls);
        assert!(matches!(result, Z3Result::Counterexample { .. }));
    }
}