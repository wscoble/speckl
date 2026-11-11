// The line walker silently accepted broken structure. This parser rejects
// it and names the line and column. Each case records both results.
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';

function walkerSummary(src: string, file = 'bad.speckdl'): string {
  try {
    const ast = parseWalker(src, file);
    const specks = ast.specks.map(s => `${s.name}:${s.members.length}@${s.endLine}`);
    return `accept ${specks.join(',') || '(no specks)'}`;
  } catch (err) {
    return `throw ${(err as Error).message}`;
  }
}

function strictMessage(src: string, file = 'bad.speckdl'): string {
  try {
    parseSpeckContent(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('malformed spec structure fails closed', () => {
  it('rejects a missing close the walker stored as an empty speck', () => {
    const src = 'speck A {\n';
    expect(walkerSummary(src)).toBe('accept A:0@1');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:1: missing final "}" (column 9)');
  });

  it('rejects an extra close the walker ignored', () => {
    const src = 'speck A {\n}\n}\n';
    expect(walkerSummary(src)).toBe('accept A:0@2');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:3: extra "}" (column 1)');
  });

  it('rejects text after a close the walker ignored', () => {
    const src = 'speck A {\n} junk\n';
    expect(walkerSummary(src)).toBe('accept A:0@2');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)');
  });

  it('rejects an unrecognized member the walker skipped', () => {
    const src = 'speck A {\n    garbage line here\n}\n';
    expect(walkerSummary(src)).toBe('accept A:0@3');
    expect(strictMessage(src)).toBe(
      'Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)',
    );
  });

  it('rejects a section sign the walker skipped', () => {
    const src = 'speck A {\n §\n}\n';
    expect(walkerSummary(src)).toBe('accept A:0@3');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:2: unexpected character "§" (column 2)');
  });

  it('adds the column to an unterminated string the walker already rejected', () => {
    const src = 'speck A {\n    x: "ab\n}\n';
    expect(walkerSummary(src)).toBe('throw Parse error at bad.speckdl:2: unterminated string');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:2: unterminated string (column 8)');
  });

  it('rejects a second speck on one line', () => {
    const src = 'speck A { } speck B { }\n';
    expect(walkerSummary(src)).toBe('accept A:0@1');
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:1: a second speck on one line (column 13)');
  });

  it('rejects code after */ on a line that starts with /*', () => {
    const src = 'speck A {\n    /* c */ action go {\n        x := 1\n    }\n}\n';
    expect(walkerSummary(src)).toMatch(/^accept /);
    expect(strictMessage(src)).toBe(
      'Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13)',
    );
  });

  it('rejects a CR-only line ending', () => {
    const src = 'speck A {\r    state { x: Nat }\r}\r';
    expect(walkerSummary(src)).toMatch(/^accept /);
    expect(strictMessage(src)).toBe(
      'Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10)',
    );
  });

  it('rejects text after a member close', () => {
    const src = 'speck A {\n    invariant P { x >= 0 } junk\n}\n';
    expect(walkerSummary(src)).toMatch(/^accept /);
    expect(strictMessage(src)).toBe('Parse error at bad.speckdl:2: text after a member\'s "}" (column 28)');
  });

  it('rejects a misspelled member, a misspelled top-level name, and a digit name', () => {
    const actoin = 'speck A {\n    actoin go {\n        x := 1\n    }\n}\n';
    expect(walkerSummary(actoin)).toMatch(/^accept /);
    expect(strictMessage(actoin)).toBe(
      'Parse error at bad.speckdl:2: unrecognized member "actoin go {" (column 5)',
    );
    const spek = 'speck A {\n    state { x: Nat }\n}\nspek B {\n}\n';
    expect(walkerSummary(spek)).toMatch(/^accept /);
    expect(strictMessage(spek)).toBe(
      'Parse error at bad.speckdl:4: unrecognized top-level "spek B {" (column 1)',
    );
    const digit = 'speck 9A {\n}\n';
    expect(walkerSummary(digit)).toBe('accept 9A:0@2');
    expect(strictMessage(digit)).toBe(
      'Parse error at bad.speckdl:1: identifier must not start with a digit (column 7)',
    );
  });

  it('rejects an opening brace on the next line', () => {
    const src = 'speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n';
    expect(walkerSummary(src, 'allman.speckdl')).toMatch(/^accept /);
    expect(strictMessage(src, 'allman.speckdl')).toBe(
      'Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5)',
    );
  });

  it('rejects an unrecognized state field and an unrecognized init line, without a column', () => {
    const field = 'speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n';
    expect(walkerSummary(field, 'st.speckdl')).toMatch(/^accept /);
    expect(strictMessage(field, 'st.speckdl')).toBe(
      'Parse error at st.speckdl:2: unrecognized state field "y Nat"',
    );
    const init = 'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n';
    expect(walkerSummary(init, 'in.speckdl')).toMatch(/^accept /);
    expect(strictMessage(init, 'in.speckdl')).toBe(
      'Parse error at in.speckdl:3: unrecognized init line "y = 0"',
    );
  });

  it('rejects an unsupported numeric literal the walker stored', () => {
    const src = 'speck A {\n    state { x: Nat }\n    invariant P { x <= 1e5 }\n}\n';
    expect(walkerSummary(src, 'num.speckdl')).toMatch(/^accept /);
    expect(strictMessage(src, 'num.speckdl')).toBe(
      'Parse error at num.speckdl:3: unsupported numeric literal "1e5" (column 24)',
    );
  });

  it('keeps the same error when the speck name is on the next line', () => {
    const src = 'speck\nName {\n}\n';
    const message = 'Parse error at bad.speckdl:1: speck name must be on the same line as "speck"';
    expect(walkerSummary(src)).toBe(`throw ${message}`);
    expect(strictMessage(src)).toBe(message);
  });

  it('does not treat a brace inside a string as an extra close', () => {
    const src = 'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n';
    const parsed = parseSpeckContent(src, 'ok.speckdl');
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
    const action = parsed.specks[0].members.find(m => m.type === 'action');
    expect(action?.type).toBe('action');
  });
});
