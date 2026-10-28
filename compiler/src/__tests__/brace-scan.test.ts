import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';
import { generateGo } from '../generators/go.js';
import { lower } from '../ir/lower.js';

describe('braces in comments and strings', () => {
  const second = [
    'speck PreconditionTest {',
    '    state { balance: Integer active: Boolean }',
    '    init { balance := 0 active := true }',
    '    action SetBalance(newBalance: Integer) {',
    '        require newBalance >= 0',
    '        balance := newBalance',
    '    }',
    '    action Deactivate() {',
    '        require balance == 0',
    '        active := false',
    '    }',
    '}',
  ];

  it('keeps the next speck when a comment or a string contains a brace, on LF and CRLF', () => {
    const bodies = [
      ['speck A {', '    state { x: Nat }', '    init { x := 0 }', '}', '// note: {'],
      ['speck A {', '    state { x: Nat }', '    // Pending transfers: transfer ID → { from, to, amount }', '    init { x := 0 }', '    // {status: "completed", exitCode: 0}.', '}'],
      ['speck A {', '    state { s: String }', '    init { s := "{" }', '}'],
      ['speck A {', '    state { x: Nat }', '    init { x := 0 }', '}', '/* note: {', '   still open', '*/'],
      ['speck A {', '    state { x: Nat } // note: {', '    init { x := 0 }', '}'],
      ['speck A {', '    state { n: Nat }', '    invariant Grow {', "        n' >= n", '    }', '}'],
      ['speck A {', '    description: "} speck B {"', '    state { x: Nat }', '    init { x := 0 }', '}'],
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const head of bodies) {
        const src = [...head, ...second, ''].join(nl);
        const ast = parseSpeckContent(src);
        expect(ast.specks.map(s => s.name), head[head.length - 1]).toEqual(['A', 'PreconditionTest']);
        const actions = ast.specks[1].members.filter(m => m.type === 'action').map(m => (m as { name: string }).name);
        expect(actions, head[0]).toEqual(['SetBalance', 'Deactivate']);
      }
    }
  });

  it('a comment brace on the line that closes a speck does not absorb the next speck, on LF and CRLF', () => {
    const next = [
      'speck B {',
      '    state { y: Nat }',
      '    init { y := 0 }',
      '    action Inc { y := y + 1 }',
      '    invariant Canary { false }',
      '}',
    ];
    const closes = [
      '} // {',
      '} /* { */',
      '} // speck B { follows',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const close of closes) {
        const src = [
          'speck A {',
          '    state { x: Nat }',
          '    init { x := 0 }',
          close,
          ...next,
          '',
        ].join(nl);
        const ast = parseSpeckContent(src);
        expect(ast.specks.map(s => s.name), close).toEqual(['A', 'B']);
        const membersOf = (name: string) => ast.specks.find(s => s.name === name)!.members.map(m => (m as { name?: string }).name);
        expect(membersOf('A'), close).not.toContain('Inc');
        expect(membersOf('A'), close).not.toContain('Canary');
        expect(membersOf('B'), close).toEqual(expect.arrayContaining(['Inc', 'Canary']));
      }
    }
  });

  it('keeps a require when a trailing comment contains a closing brace, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck Gate {',
        '    state { n: Nat }',
        '    init { n := 0 }',
        '    action Inc() {',
        '        require n < 3 // a } b',
        '        n := n + 1',
        '    }',
        '    invariant Canary { false }',
        '    next: Inc',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(src);
      const action = ast.specks[0].members.find(m => m.type === 'action') as { statements?: { type: string; expr?: string }[] };
      const stmts = action.statements ?? [];
      expect(stmts.map(s => s.type)).toEqual(['require', 'assign']);
      expect(stmts[0].expr).toContain('n < 3');
      const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { name: string };
      expect(inv.name).toBe('Canary');
    }
  });

  it('a comment brace inside an if does not drop the following invariant, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      for (const line of ['        if x > 5 { // }', '        if x > 5 { /* } */']) {
        const src = [
          'speck A {',
          '    state {',
          '        x: Nat',
          '    }',
          '    init {',
          '        x := 0',
          '    }',
          '    action Go {',
          line,
          '            x := 1',
          '        }',
          '    }',
          '    invariant Canary {',
          '        false',
          '    }',
          '}',
          '',
        ].join(nl);
        const ast = parseSpeckContent(src);
        const action = ast.specks[0].members.find(m => m.type === 'action') as { statements?: { type: string; raw?: string }[] };
        const raw = action.statements?.find(s => s.type === 'ifblock')?.raw ?? '';
        expect(raw, line).toContain('x := 1');
        const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { name: string; expr: string } | undefined;
        expect(inv?.name, line).toBe('Canary');
        expect(inv?.expr, line).toBe('false');
      }
    }
  });

  it('reprints an if whose comment has no brace so the following brace is not commented out', () => {
    const src = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    action Go {',
      '        if x > 5 { // note',
      '            x := 1',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const printed = printAST(parseSpeckContent(src));
    expect(printed).toContain('// note');
    expect(printed).not.toMatch(/\/\/ note.*\}/);
    const again = parseSpeckContent(printed);
    const action = again.specks[0].members.find(m => m.type === 'action') as { statements?: { type: string; raw?: string }[] };
    const raw = action.statements?.find(s => s.type === 'ifblock')?.raw ?? '';
    expect(raw).toContain('x := 1');
  });

  it('an unclosed string or block comment is an error and does not drop later members', () => {
    const head = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
    ];
    const tail = [
      '    invariant Canary { false }',
      '}',
      '',
    ];
    const cases: [string, number, string][] = [
      ['    action Go { log := "abc', 4, 'unterminated string'],
      ['    action Go { log := "abc\\', 4, 'unterminated string'],
      ['    action Go { log := "abc\\"', 4, 'unterminated string'],
      ['    description: "oops', 4, 'unterminated string'],
      ['    description: "oops {', 4, 'unterminated string'],
      ['    action Go {\n        log := "a {\n        b }"\n    }', 5, 'unterminated string'],
      ['    action Go { x := 1 /* oops', 4, 'unterminated block comment'],
      ['    /* oops', 4, 'unterminated block comment'],
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const [bad, line, detail] of cases) {
        const src = [...head, ...bad.split('\n'), ...tail].join(nl);
        expect(() => parseSpeckContent(src, 'open.speckdl'), bad).toThrow(
          new RegExp(`Parse error at open\\.speckdl:${line}: ${detail}`),
        );
        expect(() => parseSpeckContent(src), bad).toThrow(
          new RegExp(`Parse error at line ${line}: ${detail}`),
        );
      }
    }
  });

  it('a brace in a comment or a string does not drop an if or for body in Go', () => {
    const goOf = (actionLines: string[]) => {
      const src = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go {',
        ...actionLines,
        '    }',
        '}',
        '',
      ].join('\n');
      const ast = parseSpeckContent(src, 'go.speckdl');
      const out = mkdtempSync(join(tmpdir(), 'speckl-brace-'));
      generateGo(ast, out);
      return readFileSync(join(out, 'a', 'a.go'), 'utf8');
    };
    for (const body of [
      ['        if x > 5 { // }', '            x := 1', '        }'],
      ['        if x > 5 { /* } */', '            x := 1', '        }'],
      ['        if x > 5 {', '            log := "}"', '            x := 1', '        }'],
      ['        if x > 0 {', '            x := 1', '        } else { // b', '            x := 2', '        }'],
      ['        for i in xs { // }', '            x := 1', '        }'],
    ]) {
      const go = goOf(body);
      expect(go, body[0]).toContain('m.x = 1');
      if (body.some(l => l.includes('else'))) expect(go).toContain('m.x = 2');
    }
  });

  it('a block comment that opens on a member header and closes on the next line is that member', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    invariant Mono { /* a',
      '        b */ }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'span.speckdl');
    const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { name: string };
    expect(inv.name).toBe('Mono');
  });

  it('a comment that opens on a speck close and closes later is closed', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '} /* trailing',
      'still in the comment',
      '*/',
      'speck B {',
      '    state { y: Nat }',
      '    init { y := 0 }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'a08.speckdl');
    expect(ast.specks.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('an unclosed string or comment at file level, at EOF, or in domain text is an error', () => {
    const cases: [string, string][] = [
      ['"\n', 'unterminated string'],
      ['/*\n', 'unterminated block comment'],
      ['speck A " {\n}\n', 'unterminated string'],
      ['speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n"\n', 'unterminated string'],
      ['speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n/*\n', 'unterminated block comment'],
      ['domain D {\n    "\n}\n', 'unterminated string'],
      ['domain D {\n    /*\n}\n', 'unterminated block comment'],
    ];
    for (const [src, detail] of cases) {
      expect(() => parseSpeckContent(src, 'open.speckdl'), src).toThrow(new RegExp(detail));
      expect(() => parseSpeckContent(src, 'open.speckdl'), src).toThrow(/Parse error at open\.speckdl:\d+:/);
    }
  });

  it('a header on the line that closes a comment is an error, on LF and CRLF', () => {
    const prefix = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    /* hide',
    ];
    const headers = [
      '    */ speck B {',
      '    */ action Evil { x := 99 }',
      '    */ invariant P { false }',
      '    */ state { y: Nat }',
      '    */ init { y := 0 }',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const header of headers) {
        const src = [...prefix, header, '}'].join(nl);
        expect(() => parseSpeckContent(src, 'mid.speckdl'), header).toThrow(
          /Parse error at mid\.speckdl:5: header is not at the start of the line/,
        );
        expect(() => parseSpeckContent(src), header).toThrow(
          /Parse error at line 5: header is not at the start of the line/,
        );
      }
      const afterClose = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '} /*',
        'comment',
        '*/ speck B {',
        '    state { y: Nat }',
        '    init { y := 0 }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(afterClose, 'p09.speckdl')).toThrow(
        /Parse error at p09\.speckdl:6: header is not at the start of the line/,
      );
    }
  });

  it('a speck inside a file-level block comment is not a speck, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '/*',
        'speck Evil {',
        '    action Bad { z := 99 }',
        '}',
        '*/',
        'speck B {',
        '    state { y: Nat }',
        '    init { y := 0 }',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(src, 's15.speckdl');
      expect(ast.specks.map(s => s.name)).toEqual(['A', 'B']);
    }
  });

  it('n1: a one-line action keeps its own statement when a later comment has a brace, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action One { x := x + 3 }',
        '    action Two { x := x + 2 } // }',
        '    x := x + 3',
        '    // }',
        '    x := x + 1',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(src, 'n1.speckdl');
      const exprs = (name: string) => {
        const action = ast.specks[0].members.find(m => m.type === 'action' && (m as { name: string }).name === name) as { statements: { expr?: string }[] };
        return (action.statements ?? []).map(s => s.expr);
      };
      expect(exprs('One'), nl).toEqual(['x + 3']);
      expect(exprs('Two'), nl).toEqual(['x + 2']);
      expect(exprs('Two').join(' '), nl).not.toContain('x + 1');

      const dir = mkdtempSync(join(tmpdir(), 'speckl-n1-'));
      const file = join(dir, 'n1.speckdl');
      writeFileSync(file, src);
      const ir = lower(ast, { filePath: file, resolveImports: false });
      const two = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Two')!;
      expect(two.statements[0].value, nl).toEqual({
        kind: 'binop', op: '+',
        left: { kind: 'ident', name: 'x' },
        right: { kind: 'int_lit', value: 2 },
      });

      // A `// }` inside a still-open action is a comment, not a close.
      const open = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Two {',
        '        x := x + 3',
        '        // }',
        '        x := x + 1',
        '    }',
        '}',
        '',
      ].join(nl);
      const kept = parseSpeckContent(open, 'n1-open.speckdl');
      const body = kept.specks[0].members.find(m => m.type === 'action') as { statements: { expr?: string }[] };
      expect(body.statements.map(s => s.expr), nl).toEqual(['x + 3', 'x + 1']);
    }
  });

  it('p11: a one-line action keeps its guard when a trailing comment has a brace, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck A {',
        '    state { n: Nat }',
        '    init { n := 0 }',
        '    action Inc { require n < 3 } // } trailing',
        '    action Dec {',
        '        require n > 0',
        '        n := n - 1',
        '    }',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(src, 'p11.speckdl');
      const action = (name: string) => ast.specks[0].members.find(m => m.type === 'action' && (m as { name: string }).name === name) as { statements: { type: string; expr?: string; target?: string }[] };
      const inc = action('Inc').statements;
      const dec = action('Dec').statements;
      expect(inc, nl).toEqual([{ type: 'require', expr: 'n < 3' }]);
      expect(dec.map(s => s.type), nl).toEqual(['require', 'assign']);
      expect(dec[0].expr, nl).toBe('n > 0');
      expect(dec[1].target, nl).toBe('n');
      expect(dec[1].expr, nl).toBe('n - 1');

      const dir = mkdtempSync(join(tmpdir(), 'speckl-p11-'));
      const file = join(dir, 'p11.speckdl');
      writeFileSync(file, src);
      const ir = lower(ast, { filePath: file, resolveImports: false });
      const incIr = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Inc')!;
      expect(incIr.statements[0].value, nl).toEqual({
        kind: 'binop', op: '<',
        left: { kind: 'ident', name: 'n' },
        right: { kind: 'int_lit', value: 3 },
      });
    }
  });

  it('speck with Name { on the next line is an error, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = ['speck', 'Name {', '    state { x: Nat }', '    init { x := 0 }', '}', ''].join(nl);
      expect(() => parseSpeckContent(src, 'split.speckdl'), nl).toThrow(
        /Parse error at split\.speckdl:1: speck name must be on the same line as "speck"/,
      );
      const blank = ['speck', '', '// later', 'Name {', '    state { x: Nat }', '}'].join(nl);
      expect(() => parseSpeckContent(blank, 'split.speckdl'), nl).toThrow(
        /Parse error at split\.speckdl:1: speck name must be on the same line as "speck"/,
      );
      const same = ['speck Name {', '    state { x: Nat }', '    init { x := 0 }', '}', ''].join(nl);
      expect(parseSpeckContent(same, 'ok.speckdl').specks.map(s => s.name), nl).toEqual(['Name']);
    }
  });

  it('a /* inside an open block comment is comment text', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    /* outer /* still comment */',
      '    invariant Canary { false }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'nest.speckdl');
    const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { name: string };
    expect(inv.name).toBe('Canary');
  });
});
