// One contract-syntax behavior per test. The bundled cases stay in domain-contracts.test.ts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lower } from '../ir/lower.js';
import { parseSpeckContent } from '../parser.js';

const domain = (body: string) => `domain D {\n    members: A;\n    ${body}\n}\n`;

describe('each contract syntax clause', () => {
  it('parses consumes', () => {
    const ast = parseSpeckContent(domain('consumes PaymentReceived;'));
    expect(ast.domains![0].consumes).toEqual(['PaymentReceived']);
  });

  it('parses produces', () => {
    const ast = parseSpeckContent(domain('produces InvoiceIssued, Receipt;'));
    expect(ast.domains![0].produces).toEqual(['InvoiceIssued', 'Receipt']);
  });

  it('parses an external event', () => {
    const ast = parseSpeckContent('speck A {\n    event PaymentReceived external { amount: Nat }\n}\n');
    const event = ast.specks[0].members.find(m => m.type === 'event');
    expect(event && event.type === 'event' && event.external).toBe(true);
  });

  it('parses an action cost, including zero', () => {
    const ast = parseSpeckContent('speck A {\n    action Go { cost 0 }\n}\n');
    const action = ast.specks[0].members.find(m => m.type === 'action');
    expect(action && action.type === 'action' && action.statements.some(s => s.type === 'cost' && s.amount === 0)).toBe(true);
  });

  it('parses a budget of zero per tick', () => {
    const ast = parseSpeckContent(domain('budget 0 per tick;'));
    expect(ast.domains![0].budgetPerTick).toBe(0);
  });

  it('rejects a negative cost', () => {
    expect(() => parseSpeckContent('speck A {\n    action Go { cost -1 }\n}\n')).toThrow(/non-negative integer/);
  });

  it('rejects a cost that is not an integer', () => {
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1.5 }\n}\n')).toThrow(/non-negative integer/);
  });

  it('rejects a duplicate cost', () => {
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1\n        cost 2 }\n}\n')).toThrow(/more than once/);
  });

  it('rejects a negative budget', () => {
    expect(() => parseSpeckContent(domain('budget -3 per tick;'))).toThrow(/non-negative integer per tick/);
  });

  it('rejects a budget that is not per tick', () => {
    expect(() => parseSpeckContent(domain('budget 1 per second;'))).toThrow(/non-negative integer per tick/);
  });

  it('rejects a duplicate budget', () => {
    expect(() => parseSpeckContent(domain('budget 1 per tick;\n    budget 2 per tick;'))).toThrow(/budget twice/);
  });

  it('rejects a duplicate consume', () => {
    expect(() => parseSpeckContent(domain('consumes Gone, Gone;'))).toThrow(/consumes Gone more than once/);
  });

  it('rejects a duplicate produce', () => {
    expect(() => parseSpeckContent(domain('produces Gone, Gone;'))).toThrow(/produces Gone more than once/);
  });

  it('rejects produces with no event', () => {
    expect(() => parseSpeckContent(domain('produces ;'))).toThrow(/produces has no event/);
  });

  it('skips cost while lowering and does not store it on the action', () => {
    const source = `speck A {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 2
        n := n + 1
    }
    next: Go
}
`;
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-cost-skip-')), 'a.speckdl');
    writeFileSync(file, source);
    const ir = lower(parseSpeckContent(source, file), { filePath: file, resolveImports: false });
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(ir.specks[0].facets.behavior.actions[0].cost).toBeUndefined();
    expect(ir.specks[0].facets.behavior.actions[0].statements.some(s => s.kind === 'assign')).toBe(true);
  });
});
