// These inputs are what the output-hash line walker accepted or reported.
// parseSpeck matches that result. A later change rejects the accepted ones
// and names a line and column.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

function ast(src: string) {
  return parseSpeckContent(src, 'bad.speckdl');
}

describe('malformed SpeckDL matches the line walker', () => {
  it('accepts a missing close and stores the speck with no members', () => {
    const node = ast('speck A {\n');
    expect(node.specks).toEqual([
      expect.objectContaining({ name: 'A', members: [], startLine: 1, endLine: 1 }),
    ]);
  });

  it('accepts an extra close and stops the speck on the first one', () => {
    const node = ast('speck A {\n}\n}\n');
    expect(node.specks).toEqual([
      expect.objectContaining({ name: 'A', members: [], endLine: 2 }),
    ]);
  });

  it('accepts text after a close and does not store that text', () => {
    const node = ast('speck A {\n} junk\n');
    expect(node.specks).toEqual([
      expect.objectContaining({ name: 'A', members: [], endLine: 2 }),
    ]);
  });

  it('accepts an unrecognized member and does not store it', () => {
    const node = ast('speck A {\n    garbage line here\n}\n');
    expect(node.specks[0].members).toEqual([]);
    expect(node.specks[0].endLine).toBe(3);
  });

  it('accepts a section sign inside the speck', () => {
    const node = ast('speck A {\n §\n}\n');
    expect(node.specks[0].name).toBe('A');
    expect(node.specks[0].members).toEqual([]);
  });

  it('reports an unterminated string with no column', () => {
    expect(() => ast('speck A {\n    x: "ab\n}\n')).toThrow(
      'Parse error at bad.speckdl:2: unterminated string',
    );
  });

  it('does not treat a brace inside a string as an extra close', () => {
    const src = 'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n';
    const parsed = parseSpeckContent(src, 'ok.speckdl');
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
    const action = parsed.specks[0].members.find(m => m.type === 'action');
    expect(action?.type).toBe('action');
  });
});
