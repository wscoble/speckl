# Swarm tick

`compiler/src/ir/swarm-tick.ts` admits one tick of work for each domain. The per-domain `budgetPerTick` is the tick. A missing budget is no cap. Zero is a real budget, and cost 0 still fits. An item whose cost equals the remaining budget runs. An item whose own cost is greater than the budget does not run. The tick does not skip a head that does not fit in order to run a cheaper item behind it. A later tick starts each budget from zero. Waiting work is not dropped.

`compileSpec` does not call `runTick`. This module does not route events and it does not apply backpressure.

Tests: `compiler/src/__tests__/swarm-tick.test.ts`.
