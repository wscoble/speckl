// Limits of a direct generateZ3 call: a missing or unknown member type is an
// error, an unknown next: action is an error, and invariants come from the
// AST when no _invariants list is attached.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { generateZ3 } from '../generators/z3.js';

function out(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-guard-z3-'));
}

function parse(src: string, dir: string): AST {
  const file = join(dir, 'S.speckdl');
  writeFileSync(file, src);
  return parseSpeckContent(src, file);
}

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
    invariant Pos { n >= 0 }
}
`;

describe('direct Z3 limits', () => {
  it('rejects a missing member list, an unknown type, and oneof', () => {
    const dir = out();
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateZ3(noMembers, dir)).toThrow(/members are missing on speck "S"/);
    expect(existsSync(join(dir, 'S.smt2'))).toBe(false);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateZ3(odd, dir)).toThrow(/no handler for AST node type "not-a-member"/);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateZ3(oneof, dir)).toThrow(/z3 backend rejects AST node type "oneof"/);
    expect(existsSync(join(dir, 'S.smt2'))).toBe(false);
  });

  it('reads an invariant from the AST when no list is attached', () => {
    const dir = out();
    generateZ3(parse(machine, dir), dir);
    const smt = readFileSync(join(dir, 'S.smt2'), 'utf8');
    expect(smt).toMatch(/define-fun Pos/);
    expect(smt).toContain('(>= n 0)');
  });

  it('uses an attached invariant list instead of the AST member', () => {
    const dir = out();
    const ast = parse(machine, dir);
    (ast.specks[0] as { _invariants?: unknown[] })._invariants = [{
      type: 'invariant',
      name: 'AttachedBound',
      statements: [{ type: 'require', expr: 'n < 9' }],
    }];
    generateZ3(ast, dir);
    const smt = readFileSync(join(dir, 'S.smt2'), 'utf8');
    expect(smt).toMatch(/define-fun AttachedBound/);
    expect(smt).toContain('(< n 9)');
    expect(smt).not.toMatch(/define-fun Pos/);
  });

  it('rejects an unknown next: action and writes no SMT file', () => {
    const dir = out();
    const src = machine.replace('invariant Pos { n >= 0 }', 'next: Go | Missing\n    invariant Pos { n >= 0 }');
    expect(() => generateZ3(parse(src, dir), dir)).toThrow(/S: next: references unknown action\(s\): Missing/);
    expect(existsSync(join(dir, 'S.smt2'))).toBe(false);
  });

  it('accepts a speck with no members', () => {
    const dir = out();
    generateZ3(parse('speck S {\n}\n', dir), dir);
    expect(existsSync(join(dir, 'S.smt2'))).toBe(true);
  });
});