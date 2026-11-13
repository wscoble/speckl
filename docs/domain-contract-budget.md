# Domain budget

`unsat` proves the budget only inside the BMC depth. The IR budget file is `speckl-unchecked` and is not a proof. This file does not route events, queue work, run a tick, or emit a runtime throttle.

A budget with no costs, or a tick this encoding cannot lower, is the `speckl-unchecked` marker and nothing else. Unchecked is never a proof. `compiler/src/__tests__/domain-contracts.test.ts` covers an in-budget tick and the unchecked IR file.
