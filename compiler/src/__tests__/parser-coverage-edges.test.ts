// Error and shape paths the example corpus does not reach.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';
import { isAliasTypeText, stripInvariantExpr } from '../speck-span.js';

describe('parser edges the examples do not reach', () => {
  it('accepts a record alias, a decimal, a string, and a nested argument list', () => {
    expect(isAliasTypeText('{ a: Nat, b: { c: Int } }')).toBe(true);
    expect(isAliasTypeText('1.5')).toBe(true);
    expect(isAliasTypeText('"a\\"b"')).toBe(true);
    expect(isAliasTypeText('Map<Nat, List(Int)>')).toBe(true);
    expect(isAliasTypeText('not a type !!!')).toBe(false);
  });

  it('stores lifecycle values, a file-level import, and a constraint without its comments', () => {
    const src = [
      'import "./lib.speckdl" as L',
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    finalizers: ["a", "b"]',
      '    conditions: true',
      '    status: false',
      '    constraint C: {',
      '        x >= 0  // tail',
      '        && s != "a  b" /* block */ && t != "q\\"r"',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'a.speckdl');
    const life = ast.specks[0].members.filter(m => m.type === 'lifecycle_metadata') as { key: string; value: unknown }[];
    expect(life.map(m => [m.key, m.value])).toEqual([
      ['finalizers', ['a', 'b']],
      ['conditions', true],
      ['status', false],
    ]);
    expect(stripInvariantExpr('x  /* c */  >= 0 // t\n && s != "a  b"')).toContain('"a  b"');
  });

  it('rejects a top-level line that is not a speck or an import, as the line walker does', () => {
    const expected = 'Parse error at h.speckdl:1: unrecognized top-level "hello" (column 1)';
    expect(() => parseWalker('hello\n', 'h.speckdl')).toThrow(expected);
    expect(() => parseSpeckContent('hello\n', 'h.speckdl')).toThrow(expected);
  });
});
