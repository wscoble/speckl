// Each case is an input the line walker used to accept. `stored` is the AST
// it returned. `parseSpeckContent` is the error it reports now.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lexProblem, lexStart, setParseFile, type SpeckNode } from '../speck-part0.js';
import { maskLine, nextCodeIsNamedBlock, parseSpeck } from '../speck-part1.js';
import { parseSpeckContent } from '../parser.js';

function message(src: string, file = 'bad.speckdl'): string {
  try {
    parseSpeckContent(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

/** The line walker as it was before this check: a broken speck still returned an AST. */
function lineWalkerBefore(content: string, filePath: string): { specks: SpeckNode[] } {
  setParseFile(filePath);
  try {
    const specks: SpeckNode[] = [];
    const lines = content.split('\n');
    let scan = lexStart();
    for (let n = 0; n < lines.length; n++) scan = maskLine(lines[n], scan, n + 1).state;
    if (scan.block) throw lexProblem(scan.openLine, 'unterminated block comment');
    let i = 0;
    let lex = lexStart();
    while (i < lines.length) {
      const masked = maskLine(lines[i], lex, i + 1);
      lex = masked.state;
      const line = lines[i].trim();
      const code = masked.text.trim();
      if (line.startsWith('*/') && /^(speck|action|invariant|state|init)\b/.test(code)) {
        throw lexProblem(i + 1, 'header is not at the start of the line');
      }
      if (!line || !code || line.startsWith('//') || line.startsWith('/*')) {
        i++;
        continue;
      }
      if (line.startsWith('import ')) {
        i++;
        continue;
      }
      if (code === 'speck' && nextCodeIsNamedBlock(lines, i + 1, lex)) {
        throw lexProblem(i + 1, 'speck name must be on the same line as "speck"');
      }
      if (line.startsWith('speck ') && code.startsWith('speck ')) {
        const speck = parseSpeck(lines, i);
        if (speck) specks.push(speck);
        i++;
        continue;
      }
      i++;
    }
    return { specks };
  } finally {
    setParseFile('');
  }
}

function stored(src: string, file = 'bad.speckdl'): string {
  const ast = lineWalkerBefore(src, file);
  return JSON.stringify(ast.specks.map(s => ({
    name: s.name,
    endLine: s.endLine,
    members: s.members.map(m => {
      if (m.type === 'state') return { type: 'state', vars: m.variables.map(v => [v.name, v.typeExpr]) };
      if (m.type === 'init') return { type: 'init', asg: m.assignments };
      if (m.type === 'invariant') return { type: 'invariant', name: m.name, expr: m.expr };
      const named = m as { type: string; name?: string };
      return { type: named.type, name: named.name };
    }),
  })));
}

describe('line walker rejects malformed structure', () => {
  it('rejects a missing close', () => {
    const src = 'speck A {\n';
    expect(stored(src)).toBe(JSON.stringify([{ name: 'A', endLine: 1, members: [] }]));
    expect(message(src)).toBe('Parse error at bad.speckdl:1: missing final "}" (column 9)');
  });

  it('rejects an extra close', () => {
    const src = 'speck A {\n}\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":2,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:3: extra "}" (column 1)');
  });

  it('rejects text after a close', () => {
    const src = 'speck A {\n} junk\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":2,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)');
  });

  it('rejects a second speck on one line', () => {
    const src = 'speck A { } speck B { }\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":1,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:1: a second speck on one line (column 13)');
  });

  it('rejects an unrecognized member', () => {
    const garbage = 'speck A {\n    garbage line here\n}\n';
    expect(stored(garbage)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(garbage)).toBe('Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)');

    const actoin = 'speck A {\n    actoin go {\n        x := 1\n    }\n}\n';
    expect(stored(actoin)).toBe('[{"name":"A","endLine":5,"members":[]}]');
    expect(message(actoin)).toBe('Parse error at bad.speckdl:2: unrecognized member "actoin go {" (column 5)');

    const enumerated = 'speck NullableIdentTest {\n  enum Status { Active, Inactive }\n  type Foo = {\n    status: Status | null\n  }\n}\n';
    expect(stored(enumerated)).toBe('[{"name":"NullableIdentTest","endLine":6,"members":[{"type":"interface","name":"Foo"}]}]');
    expect(message(enumerated)).toBe('Parse error at bad.speckdl:2: unrecognized member "enum Status { Active, Inactive }" (column 3)');

    const described = 'speck A {\n    description: "} speck B {"\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    expect(stored(described)).toBe('[{"name":"A","endLine":5,"members":[{"type":"state","vars":[]},{"type":"init","asg":[]}]}]');
    expect(message(described)).toBe('Parse error at bad.speckdl:2: unrecognized member "description: "} speck B {"" (column 5)');

    const bare = 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n    x := x + 3\n}\n';
    expect(stored(bare)).toBe('[{"name":"A","endLine":5,"members":[{"type":"state","vars":[["x",{"type":"ident","name":"= x + 3"}]]},{"type":"init","asg":[{"name":"x","expr":"x + 3"}]}]}]');
    expect(message(bare)).toBe('Parse error at bad.speckdl:4: unrecognized member "x := x + 3" (column 5)');
  });

  it('rejects an unrecognized top-level name', () => {
    const spek = 'speck A {\n    state { x: Nat }\n}\nspek B {\n}\n';
    expect(stored(spek)).toBe('[{"name":"A","endLine":3,"members":[{"type":"state","vars":[]}]}]');
    expect(message(spek)).toBe('Parse error at bad.speckdl:4: unrecognized top-level "spek B {" (column 1)');

    const star = '*/ speck A {\n}\n';
    expect(stored(star)).toBe('[]');
    expect(message(star)).toBe('Parse error at bad.speckdl:1: unrecognized top-level "*/ speck A {" (column 1)');
  });

  it('rejects text after a member close', () => {
    const src = 'speck A {\n    invariant P { x >= 0 } junk\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[{"type":"invariant","name":"P","expr":""}]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: text after a member\'s "}" (column 28)');
  });

  it('rejects a brace on the next line', () => {
    const src = 'speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n';
    expect(stored(src, 'allman.speckdl')).toBe('[{"name":"A","endLine":7,"members":[{"type":"state","vars":[]}]}]');
    expect(message(src, 'allman.speckdl')).toBe('Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5)');
  });

  it('rejects an unrecognized state field', () => {
    const src = 'speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n';
    expect(stored(src, 'st.speckdl')).toBe('[{"name":"A","endLine":6,"members":[{"type":"state","vars":[["x",{"type":"ident","name":"Nat y Nat"}]]}]}]');
    expect(message(src, 'st.speckdl')).toBe('Parse error at st.speckdl:2: unrecognized state field "y Nat"');
  });

  it('rejects an unrecognized init line, without a column', () => {
    const eq = 'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n';
    expect(stored(eq, 'in.speckdl')).toBe('[{"name":"A","endLine":7,"members":[{"type":"state","vars":[]},{"type":"init","asg":[{"name":"x","expr":"0 y = 0"}]}]}]');
    expect(message(eq, 'in.speckdl')).toBe('Parse error at in.speckdl:3: unrecognized init line "y = 0"');

    const garbage = 'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        garbage line\n    }\n}\n';
    expect(stored(garbage, 'in.speckdl')).toBe('[{"name":"A","endLine":7,"members":[{"type":"state","vars":[]},{"type":"init","asg":[{"name":"x","expr":"0 garbage line"}]}]}]');
    expect(message(garbage, 'in.speckdl')).toBe('Parse error at in.speckdl:3: unrecognized init line "garbage line"');
  });

  it('rejects code after a block comment on the same line', () => {
    const src = 'speck A {\n    /* c */ action go {\n        x := 1\n    }\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":4,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13)');
  });

  it('rejects a CR-only file', () => {
    const src = 'speck A {\r    state { x: Nat }\r}\r';
    expect(stored(src)).toBe('[{"name":"A","endLine":1,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10)');
  });

  it('rejects a section sign', () => {
    const src = 'speck A {\n §\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: unexpected character "§" (column 2)');
  });

  it('rejects an arrow character', () => {
    const src = 'speck A {\n    x → y\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: unexpected character "→" (column 7)');
  });

  it('rejects a digit name', () => {
    const src = 'speck 9A {\n}\n';
    expect(stored(src)).toBe('[{"name":"9A","endLine":2,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:1: identifier must not start with a digit (column 7)');
  });

  it('rejects a non-ASCII identifier', () => {
    const src = 'speck A {\n    naïve x\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: identifier must be ASCII (column 7)');
  });

  it('rejects an unsupported numeric literal', () => {
    const src = 'speck A {\n    state { t: 1h30m }\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[{"type":"state","vars":[]}]}]');
    expect(message(src)).toBe('Parse error at bad.speckdl:2: unsupported numeric literal "1h30m" (column 16)');
  });

  it('still parses a duration', () => {
    const src = 'speck A {\n    state { t: 24h }\n}\n';
    const parsed = parseSpeckContent(src, 'dur.speckdl');
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
    const state = parsed.specks[0].members.find(m => m.type === 'state');
    if (!state || state.type !== 'state') throw new Error('missing state');
    expect(state.variables.map(v => v.name)).toEqual(['t']);
  });



  it('does not treat a brace inside a string as an extra close', () => {
    const parsed = parseSpeckContent(
      'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n',
      'ok.speckdl',
    );
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
  });

  it('keeps the same error when the speck name is on the next line', () => {
    const src = 'speck\nName {\n}\n';
    const old = (() => {
      try {
        lineWalkerBefore(src, 'bad.speckdl');
        return 'accept';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(old).toBe('Parse error at bad.speckdl:1: speck name must be on the same line as "speck"');
    expect(message(src)).toBe(old);
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
