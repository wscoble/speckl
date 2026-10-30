import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSpeckContent } from '../parser.js';
import { lexSpeck } from '../speck-lex.js';
import { compileSpec } from '../compile.js';

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

function firstNonAsciiColumn(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) > 127) return i + 1;
  }
  throw new Error(`no non-ASCII character in ${JSON.stringify(line)}`);
}

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
  it('rejects a non-ASCII identifier with line and column', () => {
    const src = 'speck Größe {\n    state { n: Nat }\n}\n';
    const column = firstNonAsciiColumn(src.split('\n')[0]);
    expect(() => parseSpeckContent(src, 'id.speckdl')).toThrow(
      new RegExp(`Parse error at id\\.speckdl:1: identifier must be ASCII \\(column ${column}\\)`),
    );
    const action = '    action Größe { n := 1 }';
    expect(() => parseSpeckContent(`speck S {\n    state { n: Nat }\n${action}\n}\n`)).toThrow(
      new RegExp(`Parse error at line 3: identifier must be ASCII \\(column ${firstNonAsciiColumn(action)}\\)`),
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

  it('reports an unterminated string with line and column', () => {
    const src = 'speck S {\n    state { n: Nat }\n    init { s := "abc }\n}\n';
    expect(() => parseSpeckContent(src, 'bad.speckdl')).toThrow(
      /Parse error at bad\.speckdl:3: unterminated string \(column /,
    );
  });

  it('reports an unterminated block comment with line and column', () => {
    const src = 'speck S {\n    state { n: Nat }\n    /* never\n}\n';
    expect(() => parseSpeckContent(src, 'bad.speckdl')).toThrow(
      /Parse error at bad\.speckdl:3: unterminated block comment \(column 5\)/,
    );
  });

  it('rejects a next: alternative that is not a name, with its line', () => {
    const src = machine.replace('action Inc {', 'next: 1 +\n    action Inc {');
    expect(() => parseSpeckContent(src, 'next.speckdl')).toThrow(
      /Parse error at line \d+: next: alternative "1 \+" is not an action name/,
    );
  });

  it('rejects an unexpected non-ASCII mark outside a comment', () => {
    const src = 'speck S {\n    state { n: Nat }\n    →\n}\n';
    expect(() => parseSpeckContent(src, 'mark.speckdl')).toThrow(
      /Parse error at mark\.speckdl:3: unexpected character "→" \(column 5\)/,
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
    expect(inv('Pos').expr).toBe('x >= 0');
    expect(inv('Small').expr).toBe('x < 3');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { expr?: string }[] };
    expect(action.statements.map(s => s.expr)).toEqual(['x + 1']);
  });

  it('compiles a one-line invariant into the z3 file instead of skipping it', () => {
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

  it('rejects structure the token stream can see', () => {
    const cases: [string, RegExp][] = [
      ['speck A {\n    state { x: Nat }\n', /missing final "}"/],
      ['speck A {\n    state { x: Nat }\n}}\n', /extra "}"/],
      ['speck A {\n    state { x: Nat }\n} junk\n', /text after a speck's "}"/],
      ['speck A { } speck B { }\n', /a second speck on one line/],
      ['speck A {\n    /* c */ action go {\n        x := 1\n    }\n    state { x: Nat }\n}\n', /code after \*\/ on a line that starts with \/\*/],
      ['/* note */ speck A {\n    state { x: Nat }\n}\n', /code after \*\/ on a line that starts with \/\*/],
      ['speck A {\r    state { x: Nat }\r}\r', /CR-only line endings are not supported/],
    ];
    for (const [src, re] of cases) {
      expect(() => parseSpeckContent(src, 'bad.speckdl'), src).toThrow(re);
    }
  });

  it('strips one leading BOM and still parses the speck', () => {
    const src = '\uFEFFspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
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

  it('rejects a second block or other text after a member close', () => {
    expect(() => parseSpeckContent('speck A {\n    invariant P { x >= 0 } invariant Q { x < 0 }\n}\n', 'two.speckdl')).toThrow(/text after a member's "}"/);
    expect(() => parseSpeckContent('speck A {\n    state { x: Nat } init { x := 0 }\n}\n', 'two.speckdl')).toThrow(/text after a member's "}"/);
    expect(() => parseSpeckContent('speck A {\n    invariant P { x >= 0 } junk\n}\n', 'junk.speckdl')).toThrow(/text after a member's "}"/);
    expect(() => parseSpeckContent('speck A {\n    state {\n        x: Nat\n    } junk\n}\n', 'junk.speckdl')).toThrow(/text after a member's "}"/);
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

  it('accepts a tab after speck and rejects a name that starts with a digit', () => {
    expect(parseSpeckContent('speck\tA {\n    state { x: Nat }\n}\n').specks.map(s => s.name)).toEqual(['A']);
    expect(() => parseSpeckContent('speck 9A {\n}\n', 'dig.speckdl')).toThrow(/identifier must not start with a digit/);
  });

  it('a contradictory invariant is unsat, not an empty (and true)', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    invariant P { x >= 0',
      '        && x < 0 }',
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
    const lines = ['speck Big {', '    state { x: Nat }', '    init { x := 0 }'];
    for (let i = 0; i < n; i++) lines.push(`    invariant I${i} { x >= 0 }`);
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
