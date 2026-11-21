// A domain with no budget must not gain a budget file.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateDomainBudgets } from '../generators/z3-budget.js';
import type { AST } from '../parser.js';
import type { IRDomain } from '../ir/types.js';

const ast = { specks: [] } as unknown as AST;

describe('domain budget file edges', () => {
  it('writes no budget file when the domain declares no budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-no-budget-'));
    generateDomainBudgets(ast, [{ name: 'D', members: ['A'] } as IRDomain], dir, 1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('records an unchecked file when the budget is not a safe integer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-bad-budget-'));
    generateDomainBudgets(ast, [{ name: 'D', members: ['A'], budgetPerTick: 1.5 } as IRDomain], dir, 1);
    const text = readFileSync(join(dir, 'D.budget.smt2'), 'utf8');
    expect(text).toContain('speckl-unchecked');
    expect(text).toContain('not a non-negative integer');
  });
});
