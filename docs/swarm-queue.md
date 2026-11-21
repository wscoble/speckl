# Swarm queue

The trailing integer is the rank. P0 comes before P1, and P2 comes before P10. A smaller number wins across prefixes, so B0 comes before A1. The same number is ordered by the prefix, and the same label keeps arrival order. An unnumbered label comes after every numbered label. A missing priority means the field is absent, and it comes last. An empty string is an unnumbered label, not a missing priority. The input array is not mutated.

The assumptions are these. A route is one hop on `produces` and `consumes`. The trailing number on a priority label is the queue rank. The per-domain budget is the tick. Backpressure is the budget stop. This pull request implements only the rank. This function only orders an array. Nothing is enqueued. `compileSpec` does not call `orderByPriority`. This module does not route events, enqueue work, or stop on a budget.

`compiler/src/__tests__/swarm-queue.test.ts` covers `runs P0 before P1 and P2 before P10`, `does not mutate the input array`, `does not sort a numbered label as text`, `orders the same number by prefix and keeps arrival order for one label`, `keeps arrival order when P0 and P00 are the same number`, `an empty priority is unnumbered and is not last`, and `compileSpec does not call the priority order`.
