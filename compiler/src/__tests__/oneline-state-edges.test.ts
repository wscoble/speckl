// A one-line state and init store the field and the assignment. The line
// walker started on the next line and stored empty lists.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

function speck(src: string) {
  return parseSpeckContent(src, 'state.speckdl').specks[0];
}

function stateNames(src: string): string[] {
  const member = speck(src).members.find(m => m.type === 'state');
  if (member?.type !== 'state') throw new Error('missing state');
  return member.variables.map(v => v.name);
}

describe('one-line state and init', () => {
  it('stores the field and the assignment, where the walker stored empty lists', () => {
    const src = 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    const node = speck(src);
    const state = node.members.find(m => m.type === 'state');
    const init = node.members.find(m => m.type === 'init');
    if (state?.type !== 'state' || init?.type !== 'init') throw new Error('missing state or init');
    // Before: both lists were empty.
    expect(state.variables).not.toEqual([]);
    expect(init.assignments).not.toEqual([]);
    expect(state.variables.map(v => v.name)).toEqual(['x']);
    expect(init.assignments).toEqual([{ name: 'x', expr: '0' }]);
  });

  it('stores an empty state and an empty init', () => {
    const node = speck('speck A {\n    state { }\n    init { }\n}\n');
    const state = node.members.find(m => m.type === 'state');
    const init = node.members.find(m => m.type === 'init');
    if (state?.type !== 'state' || init?.type !== 'init') throw new Error('missing state or init');
    expect(state.variables).toEqual([]);
    expect(init.assignments).toEqual([]);
  });

  it('ignores a comment after the closing brace', () => {
    expect(stateNames('speck A {\n    state { x: Nat } // note\n}\n')).toEqual(['x']);
    const node = speck('speck A {\n    state { x: Nat }\n    init { x := 0 } // note\n}\n');
    const init = node.members.find(m => m.type === 'init');
    if (init?.type !== 'init') throw new Error('missing init');
    expect(init.assignments).toEqual([{ name: 'x', expr: '0' }]);
  });

  it('does not treat a brace inside a line comment as the close', () => {
    expect(() => parseSpeckContent('speck A {\n    state { x: Nat // note }\n}\n', 'state.speckdl'))
      .toThrow('Parse error at state.speckdl:1: missing final "}" (column 9)');
  });

  it('stores a nested record field and a comment inside a multi-line state', () => {
    const node = speck('speck A {\n    state { box: { a: Nat, b: Nat } }\n}\n');
    const state = node.members.find(m => m.type === 'state');
    if (state?.type !== 'state') throw new Error('missing state');
    expect(state.variables.map(v => v.name)).toEqual(['box']);
    expect(state.variables[0].typeExpr.type).toBe('record');
    expect(stateNames('speck A {\n    state {\n        x: Nat // note\n        y: Nat\n    }\n}\n')).toEqual(['x', 'y']);
  });

  it('keeps a comma on one line inside the type, and splits a one-line init on a comma', () => {
    // A comma is not a second field. Two fields are two lines.
    const node = speck('speck A {\n    state { x: Nat, y: Nat }\n    init { x := 0, y := 1 }\n}\n');
    const state = node.members.find(m => m.type === 'state');
    const init = node.members.find(m => m.type === 'init');
    if (state?.type !== 'state' || init?.type !== 'init') throw new Error('missing state or init');
    expect(state.variables.map(v => v.name)).toEqual(['x']);
    expect(init.assignments).toEqual([
      { name: 'x', expr: '0' },
      { name: 'y', expr: '1' },
    ]);
  });
});
