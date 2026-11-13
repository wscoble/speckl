# Swarm routing

`compiler/src/ir/swarm-route.ts` records one hop from a domain that produces an event to each other domain that consumes it. An event declared `external` comes from `external`.

The Oct 26 PR D text is not in this repo. These are the assumptions:

- The hop is one step on `produces` and `consumes`. A cycle is two hops. Neither hop is followed.
- A domain that produces and consumes the same event is not a route to itself.
- The same hop listed twice is one route.
- An event nobody consumes is not a route.
- `planRoutes` does not repeat the errors in `compiler/src/ir/event-contracts.ts`.

`compileSpec` does not call `planRoutes`. This module does not enqueue, schedule a tick, or apply backpressure. A later module uses the priority number as a queue rank. A later module uses the per-domain budget as the tick. A later module treats backpressure as the budget stop.

Tests: `compiler/src/__tests__/swarm-route.test.ts` and `compiler/src/__tests__/swarm-route-docs.test.ts`.
