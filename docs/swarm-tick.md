# Swarm tick

The assumptions are these. A route is one hop on `produces` and `consumes`. The trailing number on a priority label is the queue rank. The per-domain budget is the tick. Backpressure is the budget stop. This pull request implements only the tick.

`compiler/src/ir/swarm-tick.ts` admits one tick of work for each domain. The per-domain `budgetPerTick` is the tick. A missing budget is no cap. Zero is a real budget, and cost 0 still fits. An item whose cost equals the remaining budget runs. An item whose own cost is greater than the budget does not run. The tick does not skip a head that does not fit in order to run a cheaper item behind it. A later tick starts each budget from zero. Waiting work is not dropped.

A negative cost, or a cost that is not a number, waits and blocks the rest of that domain. An infinite cost is not negative. It does not fit a finite budget, so it waits and blocks the rest of that domain. It does not increase the remaining budget. An item after the one that fills the budget waits. Work for a domain the tick does not name waits, including when the tick names no domain. The caller's work list is not mutated.

`compileSpec` does not call `runTick`. This module does not route events and it does not apply backpressure.

Tests: `compiler/src/__tests__/swarm-tick.test.ts`.
