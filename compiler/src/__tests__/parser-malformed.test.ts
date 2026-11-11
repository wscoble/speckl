// Malformed input fails closed at a line and column. A brace inside a
// string is not that error.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

function at(src: string, message: string): string {
  let caught = '';
  try {
    parseSpeckContent(src, 'bad.speckdl');
  } catch (err) {
    caught = (err as Error).message;
  }
  expect(caught).toBe(message);
  return caught;
}

describe('malformed SpeckDL names the line and column', () => {
  it('reports a missing close on the opening brace', () => {
    const line = 'speck A {';
    at(`${line}\n`, `Parse error at bad.speckdl:1: missing final "}" (column ${line.indexOf('{') + 1})`);
  });

  it('reports an extra close on the extra brace', () => {
    at('speck A {\n}\n}\n', 'Parse error at bad.speckdl:3: extra "}" (column 1)');
  });

  it('reports text after a close at that text', () => {
    const line = '} junk';
    at(`speck A {\n${line}\n`, `Parse error at bad.speckdl:2: text after a speck's "}" (column ${line.indexOf('j') + 1})`);
  });

  it('reports an unrecognized member at its column', () => {
    at(
      'speck A {\n    state {\n        x: Nat\n    }\n    garbage line here\n}\n',
      'Parse error at bad.speckdl:5: unrecognized member "garbage line here" (column 5)',
    );
  });

  it('reports an unterminated string at the opening quote', () => {
    const line = '    x: "ab';
    at(
      `speck A {\n${line}\n}\n`,
      `Parse error at bad.speckdl:2: unterminated string (column ${line.indexOf('"') + 1})`,
    );
  });

  it('does not treat a brace inside a string as an extra close', () => {
    const src = 'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n';
    const ast = parseSpeckContent(src, 'ok.speckdl');
    expect(ast.specks.map(s => s.name)).toEqual(['A']);
    const action = ast.specks[0].members.find(m => m.type === 'action');
    expect(action?.type).toBe('action');
  });
});
