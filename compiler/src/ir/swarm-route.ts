// One hop from a domain that produces an event to a domain that consumes it.
//
// event-contracts.ts rejects a contract that cannot be wired. It does not
// walk the graph. This walk is one hop: a cycle is two routes, and the
// function does not follow either of them. A domain that produces and
// consumes the same event is not a route to itself. An external event is
// a route from `external`. This does not enqueue, schedule, or apply
// backpressure.

import type { IR } from './types.js';

export const EXTERNAL = 'external';

export interface RouteDomain {
  name: string;
  consumes?: readonly string[];
  produces?: readonly string[];
}

export interface SwarmRoute {
  from: string;
  to: string;
  event: string;
}

export function planRoutes(
  domains: readonly RouteDomain[],
  externalEvents: readonly string[] = [],
): SwarmRoute[] {
  const consumers = new Map<string, string[]>();
  for (const domain of domains) {
    for (const event of domain.consumes ?? []) {
      const list = consumers.get(event) ?? [];
      list.push(domain.name);
      consumers.set(event, list);
    }
  }
  const routes: SwarmRoute[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, event: string): void => {
    if (from === to) return;
    const key = `${from}\0${to}\0${event}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ from, to, event });
  };
  for (const domain of domains) {
    for (const event of domain.produces ?? []) {
      for (const to of consumers.get(event) ?? []) add(domain.name, to, event);
    }
  }
  for (const event of externalEvents) {
    for (const to of consumers.get(event) ?? []) add(EXTERNAL, to, event);
  }
  return routes;
}

/** Routes for a lowered file. External events are those marked `external`. */
export function routesFromIR(ir: IR): SwarmRoute[] {
  const external: string[] = [];
  const seen = new Set<string>();
  for (const speck of ir.specks) {
    for (const event of speck.facets.behavior.events) {
      if (event.external !== true || seen.has(event.name)) continue;
      seen.add(event.name);
      external.push(event.name);
    }
  }
  return planRoutes(ir.domains ?? [], external);
}
