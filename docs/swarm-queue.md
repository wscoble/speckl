# Swarm queue

The trailing integer is the rank. P0 comes before P1, and P2 comes before P10. A smaller number wins across prefixes, so B0 comes before A1. The same number is ordered by the prefix, and the same label keeps arrival order. An unnumbered label comes after every numbered label. A missing priority comes last. The input array is not mutated.

`compileSpec` does not call `orderByPriority`. This module does not route events, enqueue work, or stop on a budget. A later module uses the per-domain budget as the tick. A later module treats backpressure as the budget stop.

`compiler/src/__tests__/swarm-queue.test.ts` covers `runs P0 before P1 and P2 before P10`, `does not mutate the input array`, `does not sort a numbered label as text`, `orders the same number by prefix and keeps arrival order for one label`, `keeps arrival order when P0 and P00 are the same number`, and `compileSpec does not call the priority order`.
