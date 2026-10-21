// The writing-action rule shared by the Rust, Go and Camel targets: an
// action that can change state saves what it touches and puts it back when
// it fails. Reads (pure calls, field and index reads) do not count.
import { describe, it, expect } from 'vitest';
import { irExprMayWrite, irStmtsWrite } from '../writes.js';
import type { IRExpr, IRStmt } from '../../ir/types.js';

const id = (name: string): IRExpr => ({ kind: 'ident', name } as IRExpr);
const call = (fn: string, ...args: IRExpr[]): IRExpr => ({ kind: 'call', fn, args } as IRExpr);

describe('irExprMayWrite', () => {
  it('treats pure functions and pure methods as reads, anything else as a write', () => {
    expect(irExprMayWrite(call('min', id('a'), id('b')))).toBe(false);
    expect(irExprMayWrite(call('xs.contains', id('a')))).toBe(false);
    expect(irExprMayWrite(call('xs.push', id('a')))).toBe(true);
    expect(irExprMayWrite(call('settle', id('a')))).toBe(true);
    // A pure call whose argument writes still writes.
    expect(irExprMayWrite(call('min', call('bump'), id('b')))).toBe(true);
  });

  it('looks through operators, field reads and index reads', () => {
    expect(irExprMayWrite({ kind: 'unop', op: '!', operand: call('bump') } as IRExpr)).toBe(true);
    expect(irExprMayWrite({ kind: 'field', target: call('next'), field: 'x' } as IRExpr)).toBe(true);
    expect(irExprMayWrite({ kind: 'index', target: id('m'), index: call('next') } as IRExpr)).toBe(true);
    expect(irExprMayWrite({ kind: 'index', target: id('m'), index: id('k') } as IRExpr)).toBe(false);
    expect(irExprMayWrite({ kind: 'int_lit', value: 1 } as IRExpr)).toBe(false);
    expect(irExprMayWrite(undefined)).toBe(false);
  });
});

describe('irStmtsWrite', () => {
  it('guards, lets and returns of reads do not write; assignments, emits and untranslated text do', () => {
    const reads = [
      { kind: 'require', value: call('isEmpty', id('xs')) },
      { kind: 'let', name: 'n', value: id('count') },
      { kind: 'if', expr: id('open'), thenBlock: [{ kind: 'return', expr: id('n') }], elseBlock: [] },
    ] as unknown as IRStmt[];
    expect(irStmtsWrite(reads)).toBe(false);
    expect(irStmtsWrite([{ kind: 'assign', target: 'count', value: id('n') }] as unknown as IRStmt[])).toBe(true);
    expect(irStmtsWrite([{ kind: 'emit', event: 'Moved', args: [] }] as unknown as IRStmt[])).toBe(true);
    expect(irStmtsWrite([{ kind: 'let', name: 'x', value: id('a'), raw: 'x := a union b' }] as unknown as IRStmt[])).toBe(true);
    const nested = [{ kind: 'if', expr: id('open'), thenBlock: [], elseBlock: [{ kind: 'assign', target: 'count', value: id('n') }] }];
    expect(irStmtsWrite(nested as unknown as IRStmt[])).toBe(true);
  });
});
