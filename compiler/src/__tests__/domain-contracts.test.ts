import { describe, it, expect } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';

describe('syntax', () => {
  const src = `
domain Billing {
    members: Invoice;
    language: "invoices";
    consumes PaymentReceived;
    produces InvoiceIssued, Receipt;
    budget 0 per tick;
}
speck Invoice {
    state { n: Nat }
    init { n := 0 }
    event PaymentReceived external { amount: Nat }
    event InvoiceIssued { amount: Nat }
    event Receipt { amount: Nat }
    action Issue {
        cost 0
        n := n + 1
        emit InvoiceIssued { amount: n }
    }
    next: Issue
}
`;

  it('parses and round-trips consumes, produces, external, cost, and budget', () => {
    const ast = parseSpeckContent(src);
    const domain = ast.domains![0];
    expect(domain.consumes).toEqual(['PaymentReceived']);
    expect(domain.produces).toEqual(['InvoiceIssued', 'Receipt']);
    expect(domain.budgetPerTick).toBe(0);
    const again = parseSpeckContent(printAST(ast));
    expect(again.domains!.map(d => ({
      name: d.name, members: d.members, language: d.language,
      consumes: d.consumes, produces: d.produces, budgetPerTick: d.budgetPerTick,
    }))).toEqual(ast.domains!.map(d => ({
      name: d.name, members: d.members, language: d.language,
      consumes: d.consumes, produces: d.produces, budgetPerTick: d.budgetPerTick,
    })));
    const events = again.specks[0].members.filter(m => m.type === 'event');
    expect(events.map(e => e.type === 'event' ? [e.name, e.external ?? false] : [])).toEqual([
      ['PaymentReceived', true],
      ['InvoiceIssued', false],
      ['Receipt', false],
    ]);
    const issue = again.specks[0].members.find(m => m.type === 'action' && m.name === 'Issue');
    expect(issue?.type === 'action' && issue.statements.some(s => s.type === 'cost' && s.amount === 0)).toBe(true);
  });

  it('rejects a negative cost, a negative budget, a duplicate cost, and a duplicate consume', () => {
    expect(() => parseSpeckContent('speck A {\n    action Go { cost -1 }\n}\n')).toThrow(/non-negative integer/);
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1.5 }\n}\n')).toThrow(/non-negative integer/);
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1\n        cost 2 }\n}\n')).toThrow(/more than once/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget -3 per tick;\n}\n')).toThrow(/non-negative integer per tick/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget 1 per second;\n}\n')).toThrow(/non-negative integer per tick/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget 1 per tick;\n    budget 2 per tick;\n}\n')).toThrow(/budget twice/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    consumes Gone, Gone;\n}\n')).toThrow(/consumes Gone more than once/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    produces ;\n}\n')).toThrow(/produces has no event/);
  });

  it('parses a generic state field whose type contains commas', () => {
    const ast = parseSpeckContent(`speck Meter {
    state {
        m: Map<String, Set<Nat>>
        k: Nat
    }
    init { k := 0 }
}
`);
    const state = ast.specks[0].members.find(m => m.type === 'state');
    expect(state && state.type === 'state' ? state.variables.map(v => v.name) : []).toEqual(['m', 'k']);
    const vars = state && state.type === 'state' ? state.variables : [];
    expect(vars[0].typeExpr).toEqual({
      type: 'map',
      keyType: { type: 'primitive', name: 'String' },
      valueType: { type: 'set', elementType: { type: 'primitive', name: 'Nat' } },
    });
    expect(vars[1].typeExpr).toEqual({ type: 'primitive', name: 'Nat' });
  });
});
