import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';
import { generateGo } from '../generators/go.js';

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
      expect(go, body[0]).toMatch(/m\.[Xx] = 1/);
      if (body.some(l => l.includes('else'))) expect(go).toMatch(/m\.[Xx] = 2/);
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
