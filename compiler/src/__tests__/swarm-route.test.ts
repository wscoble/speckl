import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { EXTERNAL, planRoutes, routesFromIR } from '../ir/swarm-route.js';

describe('swarm routes', () => {
  it('routes a produced event to every other domain that consumes it', () => {
    const routes = planRoutes([
      { name: 'Left', produces: ['Note'] },
      { name: 'Right', consumes: ['Note'] },
      { name: 'Audit', consumes: ['Note'] },
    ]);
    expect(routes).toEqual([
      { from: 'Left', to: 'Right', event: 'Note' },
      { from: 'Left', to: 'Audit', event: 'Note' },
    ]);
  });

  it('keeps a cycle as two hops and does not follow either hop', () => {
    const routes = planRoutes([
      { name: 'Left', produces: ['Out'], consumes: ['Back'] },
      { name: 'Right', produces: ['Back'], consumes: ['Out'] },
    ]);
    expect(routes).toEqual([
      { from: 'Left', to: 'Right', event: 'Out' },
      { from: 'Right', to: 'Left', event: 'Back' },
    ]);
  });

  it('does not route a domain to itself and does not repeat a route', () => {
    const routes = planRoutes([
      { name: 'Left', produces: ['Note', 'Note'], consumes: ['Note'] },
      { name: 'Right', consumes: ['Note', 'Note'] },
    ]);
    expect(routes).toEqual([{ from: 'Left', to: 'Right', event: 'Note' }]);
  });

  it('routes an external event from external and ignores an event nobody consumes', () => {
    const routes = planRoutes(
      [
        { name: 'Right', consumes: ['Inbound'] },
        { name: 'Left', produces: ['Quiet'] },
      ],
      ['Inbound'],
    );
    expect(routes).toEqual([{ from: EXTERNAL, to: 'Right', event: 'Inbound' }]);
  });

  it('reads routes from a lowered contract, including an external event', () => {
    const source = `speck Maker {
    state {
        n: Nat
    }
    init {
        n := 0
    }
    action Go {
        cost 1
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
    event Inbound external { n: Nat }
}
domain Left {
    members: Maker;
    produces Note;
}
domain Right {
    members: Taker;
    consumes Note, Inbound;
}
`;
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-swarm-route-')), 'swarm.speckdl');
    writeFileSync(file, source);
    const ir = lower(parseSpeckContent(source, file), { filePath: file, resolveImports: false });
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(routesFromIR(ir)).toEqual([
      { from: 'Left', to: 'Right', event: 'Note' },
      { from: EXTERNAL, to: 'Right', event: 'Inbound' },
    ]);
  });
});
