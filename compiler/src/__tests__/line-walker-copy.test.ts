// compiler/src/line-walker is a callable copy of the line walker.
// parseSpeckContent in parser.ts still calls the live walker. The copy is
// what walker-vs-rd.test.ts compares against once that call switches to the
// token parser. Delete compiler/src/line-walker and the tests that import it
// (this file and walker-vs-rd.test.ts) after that comparison is no longer run.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lower } from '../ir/lower.js';
import { parseSpeckContent as copy } from '../line-walker/parser.js';
import { parseSpeckContent as live } from '../parser.js';

function speckdlFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) speckdlFiles(path, out);
    else if (name.endsWith('.speckdl')) out.push(path);
  }
}

function errorOf(parse: (src: string, file?: string) => unknown, src: string, file: string): string {
  try {
    parse(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

// The same inputs walker-strict.test.ts rejects, one per rejection class.
const rejections: { name: string; file: string; src: string; error: string }[] = [
  { name: 'missing close', file: 'bad.speckdl', src: 'speck A {\n', error: 'Parse error at bad.speckdl:1: missing final "}" (column 9)' },
  { name: 'extra close', file: 'bad.speckdl', src: 'speck A {\n}\n}\n', error: 'Parse error at bad.speckdl:3: extra "}" (column 1)' },
  { name: 'text after a close', file: 'bad.speckdl', src: 'speck A {\n} junk\n', error: 'Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)' },
  { name: 'second speck', file: 'bad.speckdl', src: 'speck A { } speck B { }\n', error: 'Parse error at bad.speckdl:1: a second speck on one line (column 13)' },
  { name: 'unrecognized member', file: 'bad.speckdl', src: 'speck A {\n    garbage line here\n}\n', error: 'Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)' },
  { name: 'mistyped action', file: 'bad.speckdl', src: 'speck A {\n    actoin go {\n        x := 1\n    }\n}\n', error: 'Parse error at bad.speckdl:2: unrecognized member "actoin go {" (column 5)' },
  { name: 'enum member', file: 'bad.speckdl', src: 'speck NullableIdentTest {\n  enum Status { Active, Inactive }\n  type Foo = {\n    status: Status | null\n  }\n}\n', error: 'Parse error at bad.speckdl:2: unrecognized member "enum Status { Active, Inactive }" (column 3)' },
  { name: 'description member', file: 'bad.speckdl', src: 'speck A {\n    description: "} speck B {"\n    state { x: Nat }\n    init { x := 0 }\n}\n', error: 'Parse error at bad.speckdl:2: unrecognized member "description: "} speck B {"" (column 5)' },
  { name: 'bare assignment', file: 'bad.speckdl', src: 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n    x := x + 3\n}\n', error: 'Parse error at bad.speckdl:4: unrecognized member "x := x + 3" (column 5)' },
  { name: 'unrecognized top-level', file: 'bad.speckdl', src: 'speck A {\n    state { x: Nat }\n}\nspek B {\n}\n', error: 'Parse error at bad.speckdl:4: unrecognized top-level "spek B {" (column 1)' },
  { name: 'closer then speck', file: 'bad.speckdl', src: '*/ speck A {\n}\n', error: 'Parse error at bad.speckdl:1: unrecognized top-level "*/ speck A {" (column 1)' },
  { name: 'text after a member close', file: 'bad.speckdl', src: 'speck A {\n    invariant P { x >= 0 } junk\n}\n', error: 'Parse error at bad.speckdl:2: text after a member\'s "}" (column 28)' },
  { name: 'brace on the next line', file: 'allman.speckdl', src: 'speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n', error: 'Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5)' },
  { name: 'unrecognized state field', file: 'st.speckdl', src: 'speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n', error: 'Parse error at st.speckdl:2: unrecognized state field "y Nat"' },
  { name: 'unrecognized init line', file: 'in.speckdl', src: 'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n', error: 'Parse error at in.speckdl:3: unrecognized init line "y = 0"' },
  { name: 'garbage init line', file: 'in.speckdl', src: 'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        garbage line\n    }\n}\n', error: 'Parse error at in.speckdl:3: unrecognized init line "garbage line"' },
  { name: 'code after a block comment', file: 'bad.speckdl', src: 'speck A {\n    /* c */ action go {\n        x := 1\n    }\n}\n', error: 'Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13)' },
  { name: 'CR-only file', file: 'bad.speckdl', src: 'speck A {\r    state { x: Nat }\r}\r', error: 'Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10)' },
  { name: 'section sign', file: 'bad.speckdl', src: 'speck A {\n §\n}\n', error: 'Parse error at bad.speckdl:2: unexpected character "§" (column 2)' },
  { name: 'arrow character', file: 'bad.speckdl', src: 'speck A {\n    x → y\n}\n', error: 'Parse error at bad.speckdl:2: unexpected character "→" (column 7)' },
  { name: 'digit name', file: 'bad.speckdl', src: 'speck 9A {\n}\n', error: 'Parse error at bad.speckdl:1: identifier must not start with a digit (column 7)' },
  { name: 'non-ASCII identifier', file: 'bad.speckdl', src: 'speck A {\n    naïve x\n}\n', error: 'Parse error at bad.speckdl:2: identifier must be ASCII (column 7)' },
  { name: 'unsupported numeric literal', file: 'bad.speckdl', src: 'speck A {\n    state { t: 1h30m }\n}\n', error: 'Parse error at bad.speckdl:2: unsupported numeric literal "1h30m" (column 16)' },
  { name: 'unclosed string', file: 'bad.speckdl', src: 'speck A {\n    x: "ab\n}\n', error: 'Parse error at bad.speckdl:2: unterminated string (column 8)' },
  { name: 'unclosed block comment', file: 'bad.speckdl', src: 'speck A {\n    /* c\n', error: 'Parse error at bad.speckdl:2: unterminated block comment (column 5)' },
];

describe('line walker copy', () => {
  it('lowers every speck in the repo to the same IR as the live parser', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    const files: string[] = [];
    speckdlFiles(root, files);
    expect(files.filter(path => path.includes('/examples/')).length).toBeGreaterThanOrEqual(16);
    expect(files.length).toBeGreaterThanOrEqual(22);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const copyIr = lower(copy(text, path), { filePath: path, resolveImports: false });
      const liveIr = lower(live(text, path), { filePath: path, resolveImports: false });
      expect(JSON.stringify(copyIr), path).toBe(JSON.stringify(liveIr));
    }
  }, 120_000);

  it('reports the same error as the live parser for each rejection fixture', () => {
    expect(rejections.length).toBe(25);
    for (const fixture of rejections) {
      const fromCopy = errorOf(copy, fixture.src, fixture.file);
      const fromLive = errorOf(live, fixture.src, fixture.file);
      expect(fromCopy, fixture.name).toBe(fixture.error);
      expect(fromLive, fixture.name).toBe(fromCopy);
    }
  });
});
