import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSpeckContent } from '../parser.js';
import { lexSpeck } from '../speck-lex.js';
import { compileSpec } from '../compile.js';
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';

function walkerAccepted(src: string, file: string, strict: string): void {
  expect(() => parseWalker(src, file), src).not.toThrow();
  expect(() => parseSpeckContent(src, file), src).toThrow(strict);
}

function walkerThrew(src: string, file: string, walker: string, strict: string): void {
  expect(() => parseWalker(src, file), src).toThrow(walker);
  expect(() => parseSpeckContent(src, file), src).toThrow(strict);
}

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

const machine = [
  'speck Gate {',
  '    state { n: Nat }',
  '    init { n := 0 }',
  '    action Inc {',
  '        require n < 3',
  '        n := n + 1',
  '    }',
  '}',
  '',
].join('\n');

describe('token parser', () => {
  it('rejects a non-ASCII identifier the line walker accepted', () => {
    walkerAccepted(
      'speck Größe {\n    state { n: Nat }\n}\n',
      'id.speckdl',
      'Parse error at id.speckdl:1: identifier must be ASCII (column 9)',
    );
    walkerAccepted(
      'speck S {\n    state { n: Nat }\n    action Größe { n := 1 }\n}\n',
      'id.speckdl',
      'Parse error at id.speckdl:3: identifier must be ASCII (column 14)',
    );
  });

  it('allows non-ASCII inside comments and strings', () => {
    const src = [
      'speck S {',
      '    // Größe → ok',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go {',
      '        n := 1',
      '        /* Größe */',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(parseSpeckContent(src).specks.map(s => s.name)).toEqual(['S']);
  });

  it('adds the column to an unterminated string', () => {
    walkerThrew(
      'speck S {\n    state { n: Nat }\n    init { s := "abc }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unterminated string',
      'Parse error at bad.speckdl:3: unterminated string (column 17)',
    );
  });

  it('adds the column to an unterminated block comment', () => {
    walkerThrew(
      'speck S {\n    state { n: Nat }\n    /* never\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unterminated block comment',
      'Parse error at bad.speckdl:3: unterminated block comment (column 5)',
    );
  });

  it('rejects a next: alternative that is not a name, with its line', () => {
    const src = machine.replace('action Inc {', 'next: 1 +\n    action Inc {');
    expect(() => parseSpeckContent(src, 'next.speckdl')).toThrow(
      /Parse error at line \d+: next: alternative "1 \+" is not an action name/,
    );
  });

  it('rejects an unexpected non-ASCII mark the line walker skipped', () => {
    walkerAccepted(
      'speck S {\n    state { n: Nat }\n    →\n}\n',
      'mark.speckdl',
      'Parse error at mark.speckdl:3: unexpected character "→" (column 5)',
    );
  });

  it('lexes braces inside strings as string text, not structure', () => {
    const lexed = lexSpeck('speck S {\n    init { s := "{" }\n}\n');
    const braces = lexed.tokens.filter(t => t.kind === '{' || t.kind === '}');
    expect(braces.map(t => t.kind)).toEqual(['{', '{', '}', '}']);
  });

  it('parses a well-formed machine', () => {
    const ast = parseSpeckContent(machine, 'gate.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { type: string; expr?: string }[] };
    expect(action.statements.map(s => s.type)).toEqual(['require', 'assign']);
    expect(action.statements[0].expr).toBe('n < 3');
  });

  it('reads a one-line invariant and state from the header brace span', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    invariant Pos { x >= 0 }',
      '    invariant Small { x < 3 }',
      '    action Inc { x := x + 1 }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'one.speckdl');
    const state = ast.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    const inv = (name: string) => ast.specks[0].members.find(m => m.type === 'invariant' && (m as { name: string }).name === name) as { expr: string };
    expect(state.variables.map(v => v.name)).toEqual(['x']);
    expect(init.assignments).toEqual([{ name: 'x', expr: '0' }]);
    // A trailing comment is not part of the expression. The line walker
    // had kept reading into the next member.
    expect(inv('Pos').expr).toBe('x >= 0');
    expect(inv('Small').expr).toBe('x < 3');
  });

  it('compiles a one-line invariant into the z3 file instead of skipping it', () => {
    const src = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    invariant Pos {',
      '        x >= 0',
      '    }',
      '    invariant Small {',
      '        x < 3',
      '    }',
      '    action Inc { x := x + 1 }',
      '}',
      '',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-oneline-'));
    const file = join(dir, 'A.speckdl');
    writeFileSync(file, src);
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 4 });
    const smt = readFileSync(join(out, 'A.smt2'), 'utf8');
    expect(smt).not.toMatch(/skipped: references undeclared identifier\(s\): (Pos|Small)/);
    expect(smt).toMatch(/define-fun Pos/);
    expect(smt).toMatch(/define-fun Small/);
    expect(smt).toContain('(assert Pos)');
    expect(smt).toContain('(assert Small)');
  });

  it('rejects structure the line walker accepted', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:1: missing final "}" (column 9)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n}}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: extra "}" (column 2)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n} junk\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: text after a speck\'s "}" (column 3)',
    );
    walkerAccepted(
      'speck A { } speck B { }\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:1: a second speck on one line (column 13)',
    );
    walkerAccepted(
      'speck A {\n    /* c */ action go {\n        x := 1\n    }\n    state { x: Nat }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:2: code after */ on a line that starts with /* (column 13)',
    );
    walkerAccepted(
      '/* note */ speck A {\n    state { x: Nat }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:1: code after */ on a line that starts with /* (column 12)',
    );
    walkerAccepted(
      'speck A {\r    state { x: Nat }\r}\r',
      'bad.speckdl',
      'Parse error at bad.speckdl:1: CR-only line endings are not supported (column 10)',
    );
  });

  it('strips one leading BOM and still parses the speck', () => {
    const src = '\uFEFFspeck A {\n    state {\n        x: Nat\n    }\n    init {\n        x := 0\n    }\n}\n';
    const ast = parseSpeckContent(src, 'bom.speckdl');
    expect(ast.specks.map(s => s.name)).toEqual(['A']);
    const state = ast.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map(v => v.name)).toEqual(['x']);
  });

  it('treats an ideographic space after speck as a space and parses the name', () => {
    expect(parseSpeckContent('speck\u3000A {\n    state { x: Nat }\n}\n').specks.map(s => s.name)).toEqual(['A']);
  });

  it('reads a multi-line invariant from the brace span and rejects an empty one', () => {
    const cont = [
      'speck A {',
      '    state { x: Nat }',
      '    invariant P { x >= 0',
      '        && x < 0 }',
      '}',
      '',
    ].join('\n');
    const inv = parseSpeckContent(cont).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('x >= 0 && x < 0');
    const closed = 'speck A {\n    state { x: Nat }\n    invariant P { x >= 0\n    }\n}\n';
    const again = parseSpeckContent(closed).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(again.expr).toBe('x >= 0');
    expect(() => parseSpeckContent('speck A {\n    invariant P {}\n}\n', 'empty.speckdl')).toThrow(/invariant expression is empty/);
  });

  it('rejects text after a member close the line walker kept', () => {
    walkerAccepted(
      'speck A {\n    invariant P { x >= 0 } invariant Q { x < 0 }\n}\n',
      'two.speckdl',
      'Parse error at two.speckdl:2: text after a member\'s "}" (column 28)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat } init { x := 0 }\n}\n',
      'two.speckdl',
      'Parse error at two.speckdl:2: text after a member\'s "}" (column 22)',
    );
    walkerAccepted(
      'speck A {\n    invariant P { x >= 0 } junk\n}\n',
      'junk.speckdl',
      'Parse error at junk.speckdl:2: text after a member\'s "}" (column 28)',
    );
    walkerAccepted(
      'speck A {\n    state {\n        x: Nat\n    } junk\n}\n',
      'junk.speckdl',
      'Parse error at junk.speckdl:4: text after a member\'s "}" (column 7)',
    );
  });

  it('strips a block comment out of a one-line invariant', () => {
    const ast = parseSpeckContent('speck A {\n    invariant P { x >= 0 /* } */ }\n}\n');
    const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('x >= 0');
  });

  it('splits a one-line init on a top-level comma', () => {
    const ast = parseSpeckContent('speck A {\n    state { x: Nat }\n    init { x := 0, y := 1 }\n}\n');
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    expect(init.assignments).toEqual([{ name: 'x', expr: '0' }, { name: 'y', expr: '1' }]);
  });

  it('accepts a tab after speck and rejects a digit name the walker stored', () => {
    expect(parseSpeckContent('speck\tA {\n    state { x: Nat }\n}\n').specks.map(s => s.name)).toEqual(['A']);
    walkerAccepted(
      'speck 9A {\n}\n',
      'dig.speckdl',
      'Parse error at dig.speckdl:1: identifier must not start with a digit (column 7)',
    );
  });

  it('rejects an unrecognized member line the line walker skipped', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    actoin go {\n        x := 1\n    }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unrecognized member "actoin go {" (column 5)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    Action go {\n        x := 1\n    }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unrecognized member "Action go {" (column 5)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    invarient P { y >= 0 }\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unrecognized member "invarient P { y >= 0 }" (column 5)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    garbage line here\n}\n',
      'bad.speckdl',
      'Parse error at bad.speckdl:3: unrecognized member "garbage line here" (column 5)',
    );
  });

  it('rejects a member brace on the next line', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n',
      'allman.speckdl',
      'Parse error at allman.speckdl:3: opening "{" must be on the same line as the member header (column 5)',
    );
  });

  it('keeps a constraint block, including text on the closing line', () => {
    const one = parseSpeckContent('speck A {\n    state { x: Nat }\n    constraint C { x >= 0 }\n}\n');
    expect(one.specks[0].members.find(m => m.type === 'constraint')).toMatchObject({ name: 'C', expr: 'x >= 0' });
    const span = parseSpeckContent('speck A {\n    state { x: Nat y: Nat }\n    constraint C: { x >= 0\n        && y >= 0 }\n}\n');
    expect(span.specks[0].members.find(m => m.type === 'constraint')).toMatchObject({ name: 'C', expr: 'x >= 0 && y >= 0' });
  });

  it('does not treat a brace inside a block comment as the end of an invariant', () => {
    const src = 'speck A {\n    state { x: Nat }\n    invariant P { /* c\n        } */ x >= 0\n    }\n}\n';
    const inv = parseSpeckContent(src).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('x >= 0');
  });

  it('keeps spaces inside a string while collapsing the rest of an invariant', () => {
    const src = 'speck A {\n    state { s: String }\n    invariant P {\n        s != "a  b"\n    }\n}\n';
    const inv = parseSpeckContent(src).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('s != "a  b"');
  });

  it('rejects the member after a constraint or verify instead of skipping it', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    init { x := 0 }\n    constraint: x >= 0\n    actoin go {\n        x := 1\n    }\n    action ok {\n        x := 2\n    }\n}\n',
      'skip.speckdl',
      'Parse error at skip.speckdl:5: unrecognized member "actoin go {" (column 5)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    constraint: x >= 0\n    garbage line here\n}\n',
      'g.speckdl',
      'Parse error at g.speckdl:4: unrecognized member "garbage line here" (column 5)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    verify: always(x >= 0)\n    invarient P { x >= 0 }\n}\n',
      'v.speckdl',
      'Parse error at v.speckdl:4: unrecognized member "invarient P { x >= 0 }" (column 5)',
    );
    const kept = parseSpeckContent('speck A {\n    output: { y: Nat }\n    constraint: y >= 0\n    input: { x: Nat }\n}\n');
    expect(kept.specks[0].members.map(m => m.type)).toContain('input');
  });

  it('rejects the member after a named constraint instead of folding it in', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    constraint C: x >= 0\n    Action go {\n        x := 1\n    }\n}\n',
      'c.speckdl',
      'Parse error at c.speckdl:4: unrecognized member "Action go {" (column 5)',
    );
    const wal = parseSpeckContent('speck A {\n    state { x: Nat }\n    constraint ReadConsistency: forall r in [0..4]:\n        (x >= 0)\n    constraint WriteSerialization:\n        (x >= 0)\n}\n');
    const exprs = wal.specks[0].members.filter(m => m.type === 'constraint').map(m => (m as { expr: string }).expr);
    expect(exprs[0]).toBe('forall r in [0..4]: (x >= 0)');
    expect(exprs[1]).toBe('(x >= 0)');
  });

  it('rejects a malformed line inside state or init', () => {
    walkerAccepted(
      'speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n',
      'st.speckdl',
      'Parse error at st.speckdl:2: unrecognized state field "y Nat"',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        garbage line\n    }\n}\n',
      'in.speckdl',
      'Parse error at in.speckdl:3: unrecognized init line "garbage line"',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n',
      'in.speckdl',
      'Parse error at in.speckdl:3: unrecognized init line "y = 0"',
    );
  });

  it('rejects a misspelled top-level speck and a garbage type alias', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n}\nspek B {\n    state { y: Nat }\n}\n',
      'p.speckdl',
      'Parse error at p.speckdl:4: unrecognized top-level "spek B {" (column 1)',
    );
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    type T = this is not a type !!\n}\n',
      't.speckdl',
      'Parse error at t.speckdl:3: unrecognized member "type T = this is not a type !!" (column 5)',
    );
    expect(parseSpeckContent('speck A {\n    type State = Follower | Candidate | Leader\n    state { x: Nat }\n}\n').specks[0].name).toBe('A');
  });

  it('never drops later state fields without an error', () => {
    const bodies = [
      '    x: Nat // a |',
      '    s: "open" | "closed" // TODO: add |',
      '    s: "/*" | "b"',
      '    s: "/*"\n      | "b"',
      '    s: "a//b" |\n      "c"',
      '    u: "https://example.com" | "b"',
      '    u: "http://x" | "b"',
      '    s: "a\\"//b" | "c"',
      '    m: Map<\n            String, Nat\n        >',
      '    m: Map<String,\n            Nat>',
      '    m: "a"\n            | "b"',
      '    s: "a" |\n      // more\n      "b"',
      '    m: Map<String,\n      // key\n      Nat>',
      '    m: Map< // c\n      String, Nat>',
      '    r: { // c\n      a: Nat\n    }',
      '    x: Nat // note\n    s: "a" |\n      "b"',
      '    x: Nat /* a |\n    b */',
      '    x: Nat /* a <\n    b */',
      '    // only a comment\n    x: Nat',
    ];
    for (const body of bodies) {
      for (const nl of ['\n', '\r\n']) {
        const src = `speck A {${nl}  state {${nl}${body.split('\n').join(nl)}${nl}    y: Nat${nl}    z: Nat${nl}  }${nl}}${nl}`;
        let names: string[] | undefined;
        try {
          const state = parseSpeckContent(src).specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
          names = state.variables.map(v => v.name);
        } catch {
          continue;
        }
        expect(names, body).toEqual(expect.arrayContaining(['y', 'z']));
      }
    }
    const kept = parseSpeckContent('speck A {\n  state {\n    s: "/*" | "b"\n    y: Nat\n    z: Nat\n    u: "https://example.com"\n    v: "a//b"\n  }\n}\n');
    const state = kept.specks[0].members.find(m => m.type === 'state') as { variables: { name: string; typeExpr: { name?: string } }[] };
    expect(state.variables.map(v => v.name)).toEqual(['s', 'y', 'z', 'u', 'v']);
    expect(state.variables[0].typeExpr.name).toContain('/*');
    expect(state.variables[0].typeExpr.name).toContain('"b"');
    expect(state.variables.find(v => v.name === 'u')?.typeExpr.name).toBe('"https://example.com"');
    expect(state.variables.find(v => v.name === 'v')?.typeExpr.name).toBe('"a//b"');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-r6-'));
    const file = join(dir, 'Counter.speckdl');
    writeFileSync(file, 'speck Counter {\n  state {\n    s: "/*" | "b"\n    y: Nat\n    z: Nat\n  }\n  init { s := "b"; y := 0; z := 0 }\n}\n');
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 0 });
    const ts = readFileSync(join(out, 'Counter.ts'), 'utf8');
    expect(ts).toContain('y');
    expect(ts).toContain('z');
    expect(ts).not.toContain('s!: ";');
  });

  it('keeps later fields when a comment sits inside a multi-line state type', () => {
    const cases = [
      'speck Counter {\n  state {\n    s: "a" |\n      // more\n      "b"\n    y: Nat\n  }\n  init { s := "a"; y := 0 }\n}\n',
      'speck Counter {\n  state {\n    m: Map<String,\n      // key\n      Nat>\n    y: Nat\n  }\n  init { y := 0 }\n}\n',
      'speck Counter {\n  state {\n    m: Map< // c\n      String, Nat>\n    y: Nat\n  }\n}\n',
      'speck Counter {\n  state {\n    r: { // c\n      a: Nat\n    }\n    y: Nat\n  }\n}\n',
      'speck Counter {\n  state {\n    x: Nat // note\n    s: "a" |\n      "b"\n    y: Nat\n  }\n}\n',
      'speck Counter {\n  state {\n    x: Nat /* a |\n    b */\n    y: Nat\n  }\n}\n',
    ];
    for (const src of cases) {
      const state = parseSpeckContent(src).specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
      expect(state.variables.map(v => v.name), src).toContain('y');
    }
    const dir = mkdtempSync(join(tmpdir(), 'speckl-comment-field-'));
    const file = join(dir, 'Counter.speckdl');
    writeFileSync(file, cases[0]);
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 0 });
    const ts = readFileSync(join(out, 'Counter.ts'), 'utf8');
    expect(ts).toContain('y');
    expect(ts).not.toContain('"a" |;');
  });

  it('keeps the next field when a line comment ends with a bar', () => {
    const specs = [
      'speck A {\n    state {\n        x: Nat // a |\n        y: Nat\n    }\n    init { x := 0; y := 0 }\n}\n',
      'speck A {\n    state {\n        s: "open" | "closed" // TODO: add |\n        y: Nat\n    }\n}\n',
      'speck A {\n    state {\n        x: Nat /* a | */\n        y: Nat\n    }\n}\n',
    ];
    for (const src of specs) {
      const state = parseSpeckContent(src).specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
      expect(state.variables.map(v => v.name), src).toEqual(src.includes('s:') ? ['s', 'y'] : ['x', 'y']);
    }
  });

  it('keeps a state field type that continues onto the next line', () => {
    const specs = [
      'speck A {\n    state {\n        m: Map<\n            String, Nat\n        >\n        x: Nat\n    }\n}\n',
      'speck A {\n    state {\n        m: Map<String,\n            Nat>\n        x: Nat\n    }\n}\n',
      'speck A {\n    state {\n        m: "a"\n            | "b"\n        x: Nat\n    }\n}\n',
    ];
    for (const src of specs) {
      const state = parseSpeckContent(src).specks[0].members.find(m => m.type === 'state') as { variables: { name: string; typeExpr: { type: string } }[] };
      expect(state.variables.map(v => v.name), src).toEqual(['m', 'x']);
      expect(state.variables[0].typeExpr.type, src).not.toBeUndefined();
    }
  });

  it('accepts alias right-hand sides that are valid field types', () => {
    for (const t of ['Map<String, Set<Nat>>', '"a" | "b"', '0..10', 'Nat[]', '(Nat, Nat)', 'Map<String, String> | null', 'Map(String, Nat)', 'Follower | Candidate | Leader', '"a//b"', '"https://example.com"']) {
      expect(() => parseSpeckContent(`speck A {\n    state { m: ${t} }\n}\n`), 'field ' + t).not.toThrow();
      expect(() => parseSpeckContent(`speck A {\n    state { x: Nat }\n    type T = ${t}\n}\n`), 'alias ' + t).not.toThrow();
    }
    expect(() => parseSpeckContent('speck A {\n    state { x: Nat }\n    type T = Nat // c\n}\n')).not.toThrow();
  });

  it('rejects a brace on the next line after a block comment', () => {
    walkerAccepted(
      'speck A {\n    state { x: Nat }\n    invariant P\n    /* c\n    still */\n    { x >= 0 }\n}\n',
      'br.speckdl',
      'Parse error at br.speckdl:3: opening "{" must be on the same line as the member header (column 5)',
    );
  });

  it('rejects scientific, hex, and unit forms the line walker stored', () => {
    for (const lit of ['1e5', '1e3', '1.e5', '1.5e3', '0x1F', '0b101', '1_000', '5min', '2w', '7days', '10sec', '1hr', '1h30m']) {
      walkerAccepted(
        `speck A {\n    state { x: Nat }\n    invariant P { x <= ${lit} }\n}\n`,
        'num.speckdl',
        `Parse error at num.speckdl:3: unsupported numeric literal "${lit}" (column 24)`,
      );
    }
    for (const lit of ['24h', '500ms', '30s', '3d', '5m', '1.5h']) {
      const inv = parseSpeckContent(`speck A {\n    state { x: Nat }\n    invariant P {\n        x <= ${lit}\n    }\n}\n`).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
      expect(inv.expr, lit).toBe(`x <= ${lit}`);
    }
  });

  it('a contradictory invariant is unsat, not an empty (and true)', () => {
    const src = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    invariant P {',
      '        x >= 0 && x < 0',
      '    }',
      '}',
      '',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-unsat-'));
    const file = join(dir, 'A.speckdl');
    writeFileSync(file, src);
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 4 });
    const smt = readFileSync(join(out, 'A.smt2'), 'utf8');
    expect(smt).not.toMatch(/define-fun P \(\) Bool \(and true\)/);
    expect(smt).toContain('(assert P)');
    if (!hasZ3) return;
    const z3 = spawnSync('z3', ['-smt2', join(out, 'A.smt2')], { encoding: 'utf8' });
    expect(z3.stdout.trim()).toBe('unsat');
  });

  it('parses a long file in linear time', () => {
    const n = 20000;
    const lines = ['speck Big {', '    state {', '        x: Nat', '    }', '    init {', '        x := 0', '    }'];
    for (let i = 0; i < n; i++) lines.push(`    invariant I${i} {`, '        x >= 0', '    }');
    lines.push('}', '');
    const t0 = performance.now();
    const ast = parseSpeckContent(lines.join('\n'), 'big.speckdl');
    const ms = performance.now() - t0;
    const invs = ast.specks[0].members.filter(m => m.type === 'invariant') as { name: string; expr: string }[];
    expect(invs).toHaveLength(n);
    expect(invs[0].expr).toBe('x >= 0');
    expect(invs[n - 1].expr).toBe('x >= 0');
    expect(ms).toBeLessThan(2000);
  });
});

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });
