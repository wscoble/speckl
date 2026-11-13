// One tick of a swarm.
//
// Each domain spends its own budget. `budgetPerTick` absent means no cap.
// Zero is a real budget. Cost 0 is a real cost and still fits in a zero
// budget. The tick does not skip a head that does not fit in order to run
// a cheaper item behind it. Work left waiting is not dropped. A later tick
// starts each budget again from zero. Work for a domain that is not in the
// tick waits.

import { orderByPriority } from './swarm-queue.js';

export interface TickDomain {
  name: string;
  /** Absent means no cap. Zero is a real budget. */
  budgetPerTick?: number;
}

export interface TickWork {
  domain: string;
  id: string;
  cost: number;
  priority?: string;
}

export interface TickResult {
  ran: TickWork[];
  waiting: TickWork[];
}

export function runTick(domains: readonly TickDomain[], work: readonly TickWork[]): TickResult {
  const known = new Set(domains.map(domain => domain.name));
  const ran: TickWork[] = [];
  const waiting: TickWork[] = [];
  for (const domain of domains) {
    const items = orderByPriority(work.filter(item => item.domain === domain.name));
    const cap = domain.budgetPerTick;
    let spent = 0;
    let blocked = false;
    for (const item of items) {
      const fits = cap === undefined || spent + item.cost <= cap;
      if (blocked || !fits) {
        blocked = true;
        waiting.push(item);
        continue;
      }
      ran.push(item);
      spent += item.cost;
    }
  }
  for (const item of work) {
    if (!known.has(item.domain)) waiting.push(item);
  }
  return { ran, waiting };
}
