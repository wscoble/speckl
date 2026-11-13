import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { routesFromIR } from '../ir/swarm-route.js';
import { deliver, type Arrival } from '../ir/swarm-backpressure.js';

const routes = [
  { from: 'Left', to: 'Right', event: 'Note' },
  { from: 'Left', to: 'Audit', event: 'Note' },
];

describe('swarm backpressure', () => {
  it('does not name backpressure for a delivery that fits', () => {
    const result = deliver(
      [{ name: 'Right', budgetPerTick: 5 }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [{ id: 'go', from: 'Left', event: 'Note', cost: 2, priority: 'P0' }],
    );
    expect(result.ran.map(item => item.id)).toEqual(['go->Right']);
    expect(result.waiting).toEqual([]);
    expect(result.backpressure).toEqual([]);
  });

  it('compileSpec does not call deliver', () => {
    const src = readFileSync(new URL('../compile.ts', import.meta.url), 'utf8');
    expect(src.includes('deliver')).toBe(false);
    expect(src.includes('swarm-backpressure')).toBe(false);
  });

  it('names the consumer that cannot take the delivery and keeps that delivery waiting', () => {
    const arrival: Arrival = { id: 'go', from: 'Left', event: 'Note', cost: 2, priority: 'P0' };
    const result = deliver([{ name: 'Right', budgetPerTick: 1 }, { name: 'Audit', budgetPerTick: 5 }], routes, [arrival]);
    expect(result.ran.map(item => item.id)).toEqual(['go->Audit']);
    expect(result.waiting.map(item => item.id)).toEqual(['go->Right']);
    expect(result.backpressure).toEqual([
      { domain: 'Right', event: 'Note', id: 'go->Right', reason: 'budget' },
    ]);
  });

  it('names the blocked head and the cheaper item behind it', () => {
    const result = deliver(
      [{ name: 'Right', budgetPerTick: 3 }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [
        { id: 'head', from: 'Left', event: 'Note', cost: 2, priority: 'P0' },
        { id: 'block', from: 'Left', event: 'Note', cost: 2, priority: 'P1' },
        { id: 'cheap', from: 'Left', event: 'Note', cost: 1, priority: 'P2' },
      ],
    );
    expect(result.ran.map(item => item.id)).toEqual(['head->Right']);
    expect(result.backpressure.map(item => item.id)).toEqual(['block->Right', 'cheap->Right']);
    expect(result.waiting.map(item => item.id)).toEqual(['block->Right', 'cheap->Right']);
  });

  it('runs the waiting delivery on a later tick and reports no backpressure', () => {
    const domains = [{ name: 'Right', budgetPerTick: 3 }];
    const hop = [{ from: 'Left', to: 'Right', event: 'Note' }];
    const first = deliver(domains, hop, [
      { id: 'a', from: 'Left', event: 'Note', cost: 2, priority: 'P0' },
      { id: 'b', from: 'Left', event: 'Note', cost: 2, priority: 'P1' },
    ]);
    const second = deliver(domains, hop, [
      { id: 'b', from: 'Left', event: 'Note', cost: 2, priority: 'P1' },
    ]);
    expect(first.backpressure.map(item => item.id)).toEqual(['b->Right']);
    expect(second.ran.map(item => item.id)).toEqual(['b->Right']);
    expect(second.backpressure).toEqual([]);
    expect(second.waiting).toEqual([]);
  });

  it('keeps a delivery that can never fit, and does not invent a route', () => {
    const stuck = deliver(
      [{ name: 'Right', budgetPerTick: 1 }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [{ id: 'go', from: 'Left', event: 'Note', cost: 4, priority: 'P0' }],
    );
    expect(stuck.ran).toEqual([]);
    expect(stuck.waiting).toHaveLength(1);
    expect(stuck.backpressure[0].reason).toBe('budget');
    const again = deliver(
      [{ name: 'Right', budgetPerTick: 1 }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [{ id: 'go', from: 'Left', event: 'Note', cost: 4, priority: 'P0' }],
    );
    expect(again.backpressure).toEqual(stuck.backpressure);
    const quiet = deliver(
      [{ name: 'Right', budgetPerTick: 1 }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [{ id: 'go', from: 'Left', event: 'Quiet', cost: 1, priority: 'P0' }],
    );
    expect(quiet.ran).toEqual([]);
    expect(quiet.waiting).toEqual([]);
    expect(quiet.backpressure).toEqual([]);
  });

  it('does not report backpressure for a domain that declares no budget', () => {
    const result = deliver(
      [{ name: 'Right' }],
      [{ from: 'Left', to: 'Right', event: 'Note' }],
      [{ id: 'go', from: 'Left', event: 'Note', cost: 9, priority: 'P0' }],
    );
    expect(result.ran.map(item => item.id)).toEqual(['go->Right']);
    expect(result.backpressure).toEqual([]);
  });

  it('names backpressure for a lowered route whose action cost exceeds the consumer budget', () => {
    const source = `speck Maker {
    state {
        n: Nat
    }
    init {
        n := 0
    }
    action Go {
        cost 2
        priority P0
        n := n + 1
        emit Note { n: n }
    }
    event Note { n: Nat }
    next: Go
}
speck Taker {
    state {
        n: Nat
    }
    init {
        n := 0
    }
    event Note { n: Nat }
}
domain Left {
    members: Maker;
    produces Note;
}
domain Right {
    members: Taker;
    consumes Note;
    budget 1 per tick;
}
`;
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-swarm-pressure-')), 'swarm.speckdl');
    writeFileSync(file, source);
    const ir = lower(parseSpeckContent(source, file), { filePath: file, resolveImports: false });
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const action = ir.specks[0].facets.behavior.actions.find(item => item.name === 'Go');
    expect(action?.cost).toBe(2);
    expect(action?.priority).toBe('P0');
    const result = deliver(
      (ir.domains ?? []).map(domain => ({ name: domain.name, budgetPerTick: domain.budgetPerTick })),
      routesFromIR(ir),
      [{ id: 'go', from: 'Left', event: 'Note', cost: action!.cost!, priority: action!.priority }],
    );
    expect(result.ran).toEqual([]);
    expect(result.waiting).toHaveLength(1);
    expect(result.backpressure).toEqual([
      { domain: 'Right', event: 'Note', id: 'go->Right', reason: 'budget' },
    ]);
  });
});
