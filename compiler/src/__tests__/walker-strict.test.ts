// The line walker used to accept these shapes. Each test is the message
// it reports now. The before-value is in compiler/review/findings-walker-strict.txt.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent } from '../parser.js';

function message(src: string, file = 'bad.speckdl'): string {
  try {
    parseSpeckContent(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('line walker rejects malformed structure', () => {
  it('rejects a missing close', () => {
    expect(message('speck A {\n')).toBe('Parse error at bad.speckdl:1: missing final "}" (column 9)');
  });

  it('rejects an extra close', () => {
    expect(message('speck A {\n}\n}\n')).toBe('Parse error at bad.speckdl:3: extra "}" (column 1)');
  });

  it('rejects text after a close', () => {
    expect(message('speck A {\n} junk\n')).toBe('Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)');
  });

  it('rejects an unrecognized member', () => {
    expect(message('speck A {\n    garbage line here\n}\n')).toBe(
      'Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)',
    );
  });

  it('rejects a section sign', () => {
    expect(message('speck A {\n §\n}\n')).toBe(
      'Parse error at bad.speckdl:2: unexpected character "§" (column 2)',
    );
  });

  it('rejects an unrecognized state field and an unrecognized init line, without a column', () => {
    expect(message('speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n', 'st.speckdl')).toBe(
      'Parse error at st.speckdl:2: unrecognized state field "y Nat"',
    );
    expect(message('speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n', 'in.speckdl')).toBe(
      'Parse error at in.speckdl:3: unrecognized init line "y = 0"',
    );
    expect(message('speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        garbage line\n    }\n}\n', 'in.speckdl')).toBe(
      'Parse error at in.speckdl:3: unrecognized init line "garbage line"',
    );
  });

  it('rejects a second speck, code after a block comment, a CR-only file, and a digit name', () => {
    expect(message('speck A { } speck B { }\n')).toBe(
      'Parse error at bad.speckdl:1: a second speck on one line (column 13)',
    );
    expect(message('speck A {\n    /* c */ action go {\n        x := 1\n    }\n}\n')).toBe(
      'Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13)',
    );
    expect(message('speck A {\r    state { x: Nat }\r}\r')).toBe(
      'Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10)',
    );
    expect(message('speck 9A {\n}\n')).toBe(
      'Parse error at bad.speckdl:1: identifier must not start with a digit (column 7)',
    );
  });

  it('rejects text after a member close, a misspelled member, and a brace on the next line', () => {
    expect(message('speck A {\n    invariant P { x >= 0 } junk\n}\n')).toBe(
      'Parse error at bad.speckdl:2: text after a member\'s "}" (column 28)',
    );
    expect(message('speck A {\n    actoin go {\n        x := 1\n    }\n}\n')).toBe(
      'Parse error at bad.speckdl:2: unrecognized member "actoin go {" (column 5)',
    );
    expect(message('speck A {\n    state { x: Nat }\n}\nspek B {\n}\n')).toBe(
      'Parse error at bad.speckdl:4: unrecognized top-level "spek B {" (column 1)',
    );
    expect(message('speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n', 'allman.speckdl')).toBe(
      'Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5)',
    );
  });

  it('keeps the same error when the speck name is on the next line', () => {
    expect(message('speck\nName {\n}\n')).toBe(
      'Parse error at bad.speckdl:1: speck name must be on the same line as "speck"',
    );
  });

  it('still parses a duration', () => {
    const src = 'speck A {\n    state { t: 24h }\n}\n';
    expect(message(src)).toBe('accept');
    const parsed = parseSpeckContent(src, 'dur.speckdl');
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
  });




  it('does not treat a brace inside a string as an extra close', () => {
    const parsed = parseSpeckContent(
      'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n',
      'ok.speckdl',
    );
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
  });

  it('still parses every example', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');
    const files = readdirSync(root).filter(name => name.endsWith('.speckdl'));
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8');
      expect(parseSpeckContent(text, name).specks.length, name).toBeGreaterThan(0);
    }
  });
});
