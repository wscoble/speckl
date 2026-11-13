# Swarm backpressure

`compiler/src/ir/swarm-backpressure.ts` turns one route hop into a delivery at the consumer. Backpressure is the budget stop. The delivery stays in `waiting` and is not dropped. A domain with no budget does not report backpressure. An arrival with no matching route creates no delivery. A delivery that fits is not named. A delivery whose cost is greater than the budget stays named on a later tick.

`compileSpec` does not call `deliver`. `deliver` does not throttle. The Camel target still emits a RouteBuilder for the speck's actions. A negative cost waits and is named.

Tests: `compiler/src/__tests__/swarm-backpressure.test.ts`.
