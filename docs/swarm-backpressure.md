# Swarm backpressure

`compiler/src/ir/swarm-backpressure.ts` turns one route hop into a delivery at the consumer. Backpressure is the budget stop. The delivery stays in `waiting` and is not dropped. A domain with no budget does not report backpressure. An arrival with no matching route creates no delivery. A delivery that fits is not named. A delivery whose cost is greater than the budget stays named on a later tick.

The assumptions are these. A route is one hop on `produces` and `consumes`. The trailing number on a priority label is the queue rank. The per-domain budget is the tick. Backpressure is the budget stop. This pull request implements that stop.

`compileSpec` does not call `deliver`. `deliver` does not throttle. The Camel target still emits a RouteBuilder for the speck's actions. A negative cost waits and is named when the domain has a budget. A negative cost on a domain with no budget waits and is not named.

Tests: `compiler/src/__tests__/swarm-backpressure.test.ts`.
