// parseSpeckContent calls the token parser. The line-walker copy must
// report the same error. This call does not add a second result.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';

function message(parse: (src: string, file?: string) => unknown, src: string, file = 'bad.speckdl'): string {
  try {
    parse(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

function same(src: string, expected: string, file = 'bad.speckdl'): void {
  const walker = message(parseWalker, src, file);
  const rd = message(parseSpeckContent, src, file);
  expect(walker, src).toBe(expected);
  expect(rd, src).toBe(expected);
}

describe('malformed SpeckDL matches the line walker', () => {
  it('rejects a missing close', () => {
    same('speck A {\n', 'Parse error at bad.speckdl:1: missing final "}" (column 9)');
  });

  it('rejects an extra close', () => {
    same('speck A {\n}\n}\n', 'Parse error at bad.speckdl:3: extra "}" (column 1)');
  });

  it('rejects text after a close', () => {
    same('speck A {\n} junk\n', 'Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)');
  });

  it('rejects an unrecognized member', () => {
    same(
      'speck A {\n    garbage line here\n}\n',
      'Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)',
    );
  });

  it('rejects a section sign', () => {
    same('speck A {\n §\n}\n', 'Parse error at bad.speckdl:2: unexpected character "§" (column 2)');
  });

  it('rejects an unrecognized state field and an unrecognized init line, without a column', () => {
    same(
      'speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n',
      'Parse error at st.speckdl:2: unrecognized state field "y Nat"',
      'st.speckdl',
    );
    same(
      'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n',
      'Parse error at in.speckdl:3: unrecognized init line "y = 0"',
      'in.speckdl',
    );
  });

  it('reports an unterminated string with the column', () => {
    same('speck A {\n    x: "ab\n}\n', 'Parse error at bad.speckdl:2: unterminated string (column 8)');
  });

  it('does not treat a brace inside a string as an extra close', () => {
    const src = 'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n';
    const parsed = parseSpeckContent(src, 'ok.speckdl');
    const walker = parseWalker(src, 'ok.speckdl');
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(walker));
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
  });
});
