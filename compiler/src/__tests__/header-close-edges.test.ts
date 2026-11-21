// A `}` on the speck header ends that speck. The line walker stepped past
// it and parsed the next speck's members as part of the first speck.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

function shape(src: string) {
  const ast = parseSpeckContent(src, 'header.speckdl');
  return ast.specks.map(s => ({
    name: s.name,
    endLine: s.endLine,
    fields: s.members.flatMap(m => m.type === 'state' ? m.variables.map(v => v.name) : []),
  }));
}

describe('header-line close', () => {
  it('ends the speck on the header, where the walker absorbed the next state', () => {
    const src = 'speck A { state { x: Nat } }\nspeck B {\n    state {\n        y: Nat\n    }\n}\n';
    // Before: A ended on line 5 and stored y, and B stored y too.
    // After: A ends on line 1 and stores nothing. B stores y.
    const after = shape(src);
    expect(after).not.toEqual([
      { name: 'A', endLine: 5, fields: ['y'] },
      { name: 'B', endLine: 6, fields: ['y'] },
    ]);
    expect(after).toEqual([
      { name: 'A', endLine: 1, fields: [] },
      { name: 'B', endLine: 6, fields: ['y'] },
    ]);
  });

  it('closes an empty header and does not absorb a following speck', () => {
    expect(shape('speck A { }\nspeck B {\n    state {\n        y: Nat\n    }\n}\n')).toEqual([
      { name: 'A', endLine: 1, fields: [] },
      { name: 'B', endLine: 6, fields: ['y'] },
    ]);
  });

  it('does not treat a brace inside a string as the speck close', () => {
    const src = 'speck A { note := "}" }\nspeck B {\n    state {\n        y: Nat\n    }\n}\n';
    const after = shape(src);
    expect(after.map(s => s.name)).toEqual(['A', 'B']);
    expect(after[0].endLine).toBe(1);
    expect(after[1].fields).toEqual(['y']);
  });

  it('rejects a second speck on the same line', () => {
    expect(() => parseSpeckContent('speck A { } speck B { }\n', 'header.speckdl'))
      .toThrow(/a second speck on one line/);
  });
});
