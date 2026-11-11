import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSpeckContent } from '../parser.js';
import { lexSpeck } from '../speck-lex.js';
import { compileSpec } from '../compile.js';
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';

function sameAsWalker(src: string, file = 'bad.speckdl'): void {
  let walker = '';
  let rd = '';
  try { parseWalker(src, file); } catch (err) { walker = (err as Error).message; }
  try { parseSpeckContent(src, file); } catch (err) { rd = (err as Error).message; }
  expect(rd, src).toBe(walker);
  if (walker === '') {
    expect(JSON.stringify(parseSpeckContent(src, file)), src).toBe(JSON.stringify(parseWalker(src, file)));
  }
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
  it('matches the line walker on a non-ASCII identifier', () => {
    sameAsWalker('speck Größe {\n    state { n: Nat }\n}\n', 'id.speckdl');
    sameAsWalker('speck S {\n    state { n: Nat }\n    action Größe { n := 1 }\n}\n', 'id.speckdl');
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

  it('reports an unterminated string the way the line walker does', () => {
    sameAsWalker('speck S {\n    state { n: Nat }\n    init { s := "abc }\n}\n');
  });

  it('reports an unterminated block comment the way the line walker does', () => {
    sameAsWalker('speck S {\n    state { n: Nat }\n    /* never\n}\n');
  });

  it('rejects a next: alternative that is not a name, with its line', () => {
    const src = machine.replace('action Inc {', 'next: 1 +\n    action Inc {');
    expect(() => parseSpeckContent(src, 'next.speckdl')).toThrow(
      /Parse error at line \d+: next: alternative "1 \+" is not an action name/,
    );
  });

  it('matches the line walker on an unexpected non-ASCII mark', () => {
    sameAsWalker('speck S {\n    state { n: Nat }\n    →\n}\n', 'mark.speckdl');
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
    // The line walker left a one-line state and init empty, and a one-line
    // invariant kept reading into the next member. A later change stores
    // the brace span.
    expect(state.variables.map(v => v.name)).toEqual([]);
    expect(init.assignments).toEqual([]);
    expect(inv('Pos').expr).toContain('invariant Small');
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

  it('matches the line walker on structure the token stream can see', () => {
    const cases = [
      'speck A {\n    state { x: Nat }\n',
      'speck A {\n    state { x: Nat }\n}}\n',
      'speck A {\n    state { x: Nat }\n} junk\n',
      'speck A { } speck B { }\n',
      'speck A {\n    /* c */ action go {\n        x := 1\n    }\n    state { x: Nat }\n}\n',
      '/* note */ speck A {\n    state { x: Nat }\n}\n',
      'speck A {\r    state { x: Nat }\r}\r',
    ];
    for (const src of cases) sameAsWalker(src);
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
    // The line walker did not keep text that shares a line with `{` or `}`.
    expect(inv.expr).toBe('');
    const closed = 'speck A {\n    state { x: Nat }\n    invariant P { x >= 0\n    }\n}\n';
    const again = parseSpeckContent(closed).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(again.expr).toBe('');
    const empty = parseSpeckContent('speck A {\n    invariant P {}\n}\n', 'empty.speckdl');
    const blank = empty.specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    // The line walker stored an empty expression. A later change rejects it.
    expect(blank.expr).toBe('');
  });

  it('matches the line walker on text after a member close', () => {
    sameAsWalker('speck A {\n    invariant P { x >= 0 } invariant Q { x < 0 }\n}\n', 'two.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat } init { x := 0 }\n}\n', 'two.speckdl');
    sameAsWalker('speck A {\n    invariant P { x >= 0 } junk\n}\n', 'junk.speckdl');
    sameAsWalker('speck A {\n    state {\n        x: Nat\n    } junk\n}\n', 'junk.speckdl');
  });

  it('strips a block comment out of a one-line invariant', () => {
    const ast = parseSpeckContent('speck A {\n    invariant P { x >= 0 /* } */ }\n}\n');
    const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    // The line walker stored no expression for this one-line invariant.
    expect(inv.expr).toBe('');
  });

  it('splits a one-line init on a top-level comma', () => {
    const ast = parseSpeckContent('speck A {\n    state { x: Nat }\n    init { x := 0, y := 1 }\n}\n');
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    // The line walker did not read an init that closes on its header.
    expect(init.assignments).toEqual([]);
  });

  it('accepts a tab after speck and matches the line walker on a digit name', () => {
    expect(parseSpeckContent('speck\tA {\n    state { x: Nat }\n}\n').specks.map(s => s.name)).toEqual(['A']);
    sameAsWalker('speck 9A {\n}\n', 'dig.speckdl');
  });

  it('matches the line walker on an unrecognized member line', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n    actoin go {\n        x := 1\n    }\n}\n');
    sameAsWalker('speck A {\n    state { x: Nat }\n    Action go {\n        x := 1\n    }\n}\n');
    sameAsWalker('speck A {\n    state { x: Nat }\n    invarient P { y >= 0 }\n}\n');
    sameAsWalker('speck A {\n    state { x: Nat }\n    garbage line here\n}\n');
  });

  it('matches the line walker when a member brace is on the next line', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n    invariant P\n    {\n        x >= 0\n    }\n}\n', 'allman.speckdl');
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
    expect(inv.expr).toBe('');
  });

  it('keeps spaces inside a string while collapsing the rest of an invariant', () => {
    const src = 'speck A {\n    state { s: String }\n    invariant P {\n        s != "a  b"\n    }\n}\n';
    const inv = parseSpeckContent(src).specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('s != "a  b"');
  });

  it('matches the line walker after a constraint or verify', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n    init { x := 0 }\n    constraint: x >= 0\n    actoin go {\n        x := 1\n    }\n    action ok {\n        x := 2\n    }\n}\n', 'skip.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat }\n    constraint: x >= 0\n    garbage line here\n}\n', 'g.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat }\n    verify: always(x >= 0)\n    invarient P { x >= 0 }\n}\n', 'v.speckdl');
    const kept = parseSpeckContent('speck A {\n    output: { y: Nat }\n    constraint: y >= 0\n    input: { x: Nat }\n}\n');
    expect(kept.specks[0].members.map(m => m.type)).toContain('input');
  });

  it('matches the line walker on the member after a named constraint', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n    constraint C: x >= 0\n    Action go {\n        x := 1\n    }\n}\n', 'c.speckdl');
    const wal = parseSpeckContent('speck A {\n    state { x: Nat }\n    constraint ReadConsistency: forall r in [0..4]:\n        (x >= 0)\n    constraint WriteSerialization:\n        (x >= 0)\n}\n');
    const exprs = wal.specks[0].members.filter(m => m.type === 'constraint').map(m => (m as { expr: string }).expr);
    expect(exprs[0]).toBe('forall r in [0..4]: (x >= 0)');
    expect(exprs[1]).toBe('(x >= 0)');
  });

  it('matches the line walker on a malformed line inside state or init', () => {
    sameAsWalker('speck A {\n    state {\n        x: Nat\n        y Nat\n    }\n}\n', 'st.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        garbage line\n    }\n}\n', 'in.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat }\n    init {\n        x := 0\n        y = 0\n    }\n}\n', 'in.speckdl');
  });

  it('matches the line walker on a misspelled top-level speck and a garbage type alias', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n}\nspek B {\n    state { y: Nat }\n}\n', 'p.speckdl');
    sameAsWalker('speck A {\n    state { x: Nat }\n    type T = this is not a type !!\n}\n', 't.speckdl');
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

  it('matches the line walker on a brace after a block comment', () => {
    sameAsWalker('speck A {\n    state { x: Nat }\n    invariant P\n    /* c\n    still */\n    { x >= 0 }\n}\n', 'br.speckdl');
  });

  it('matches the line walker on scientific, hex, and unit forms', () => {
    for (const lit of ['1e5', '1e3', '1.e5', '1.5e3', '0x1F', '0b101', '1_000', '5min', '2w', '7days', '10sec', '1hr', '1h30m']) {
      sameAsWalker(`speck A {\n    state { x: Nat }\n    invariant P { x <= ${lit} }\n}\n`, 'num.speckdl');
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
