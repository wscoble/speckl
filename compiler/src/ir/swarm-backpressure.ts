// Backpressure on a routed delivery.
//
// A delivery is one hop from planRoutes, queued at the consumer in priority
// order, then admitted by runTick. When the consumer's budget stops the
// tick, each delivery still waiting is named `{ domain, event, id, reason:
// 'budget' }` and stays in `waiting`. Nothing is dropped. A domain with no
// budget does not report backpressure. An arrival with no route creates no
// delivery.

import type { SwarmRoute } from './swarm-route.js';
import { runTick, type TickDomain, type TickResult, type TickWork } from './swarm-tick.js';

export interface Arrival {
  id: string;
  from: string;
  event: string;
  cost: number;
  priority?: string;
}

export interface Backpressure {
  domain: string;
  event: string;
  id: string;
  reason: 'budget';
}

export interface DeliveryResult extends TickResult {
  backpressure: Backpressure[];
}

export function deliver(
  domains: readonly TickDomain[],
  routes: readonly SwarmRoute[],
  arrivals: readonly Arrival[],
): DeliveryResult {
  const work: TickWork[] = [];
  const eventOf = new Map<string, string>();
  for (const arrival of arrivals) {
    for (const route of routes) {
      if (route.from !== arrival.from || route.event !== arrival.event) continue;
      const id = `${arrival.id}->${route.to}`;
      work.push({
        domain: route.to,
        id,
        cost: arrival.cost,
        priority: arrival.priority,
      });
      eventOf.set(id, arrival.event);
    }
  }
  const tick = runTick(domains, work);
  const capped = new Set(
    domains.filter(domain => domain.budgetPerTick !== undefined).map(domain => domain.name),
  );
  const backpressure: Backpressure[] = [];
  for (const item of tick.waiting) {
    if (!capped.has(item.domain)) continue;
    backpressure.push({
      domain: item.domain,
      event: eventOf.get(item.id) ?? '',
      id: item.id,
      reason: 'budget',
    });
  }
  return { ran: tick.ran, waiting: tick.waiting, backpressure };
}
