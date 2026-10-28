// Unterminated comments and strings must fail closed, and a brace or a
// prime must not move the next speck. `'` is post-state notation.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { compileSpec } from '../compile.js';
import { scanLine, setParseFile } from '../lex.js';
import { generateGo } from '../generators/go.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function actions(src: string, file = 'probe.speckdl') {
  const ast = parseSpeckContent(src, file);
  return ast.specks.map(s => ({
    name: s.name,
    members: s.members.map(m => {
      if (m.type === 'action') {
        const stmts = (m.statements ?? []).map(st => `${st.type}:${'expr' in st ? st.expr : ''}`);
        return { action: m.name, stmts };
      }
      if (m.type === 'invariant') return { inv: m.name, expr: m.expr };
      if (m.type === 'next') return { next: m.actions };
      return { t: m.type };
    }),
  }));
}

const tail = `
speck B {
    state { y: Nat }
    init { y := 0 }
    action Go() {
        y := y + 1
    }
}
`;

describe('unterminated comments and strings fail closed', () => {
  it('names a stray closer by line when no file is set', () => {
    setParseFile(undefined);
    expect(() => scanLine('*/')).toThrow(/Parse error at line 1: stray \*\//);
  });

  it('n3: an unterminated block comment names the file and the line', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        /*
        x := x + 2
    }
}
${tail}`;
    expect(() => parseSpeckContent(src, 'n3.speckdl')).toThrow(/Parse error at n3\.speckdl:6: unterminated block comment/);
  });

  it('n10: an unterminated string is a parse error, not a slice TypeError', () => {
    const src = `speck A {
    state { x: Nat s: String }
    init { x := 0 s := "a" }
    action Inc() {
        x := x + 1
        s := "unterminated
        x := x + 10
    }
}
${tail}`;
    expect(() => parseSpeckContent(src, 'n10.speckdl')).toThrow(/Parse error at n10\.speckdl:\d+: unterminated string/);
  });

  it('n18: a block comment that closes inside quotes then leaves a string open', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        /* "*/" { */
        x := x + 18
    }
}
${tail}`;
    expect(() => parseSpeckContent(src, 'n18.speckdl')).toThrow(/Parse error at n18\.speckdl:\d+: unterminated string/);
  });

  it('n13: a stray block-comment close is a parse error', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        */
        x := x + 13
    }
}
${tail}`;
    expect(() => parseSpeckContent(src, 'n13.speckdl')).toThrow(/Parse error at n13\.speckdl:\d+: stray \*\//);
  });
});

describe('comments do not drop statements or the next speck', () => {
  it('n8: a statement after a block comment on the same line is kept', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        /* c */ x := x + 8
    }
}
${tail}`;
    const ast = actions(src);
    expect(ast.map(s => s.name)).toEqual(['A', 'B']);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:x + 1', 'assign:x + 8']);
  });

  it('a multi-line block comment with a lone brace does not end the speck', () => {
    const src = `speck Counter {
    state { n: Nat }
    init { n := 0 }
    /* note
    }
    still
    */
    action Inc() {
        n := n + 1
    }
}
${tail}`;
    const ast = actions(src);
    expect(ast.map(s => s.name)).toEqual(['Counter', 'B']);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:n + 1']);
    const go = ast[1].members.find(m => 'action' in m && m.action === 'Go') as { stmts: string[] };
    expect(go.stmts).toEqual(['assign:y + 1']);
  });

  it('a block comment inside a multi-line state block is not a field', () => {
    const src = `speck Counter {
    state {
        n: Nat
        /* note
        }
        still
        */
        m: Nat
    }
    init {
        n := 0
    }
    action Inc() {
        n := n + 1
    }
}
${tail}`;
    const ast = parseSpeckContent(src, 'probe.speckdl');
    const state = ast.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map(v => v.name)).toEqual(['n', 'm']);
    expect(ast.specks.map(s => s.name)).toEqual(['Counter', 'B']);
    const inc = ast.specks[0].members.find(m => m.type === 'action' && m.name === 'Inc') as { statements: { type: string; expr: string }[] };
    expect(inc.statements.map(s => `${s.type}:${s.expr}`)).toEqual(['assign:n + 1']);
  });
});

describe('primes and trailing comments', () => {
  it('invariant Mono { n\' >= n } closes on that line', () => {
    const src = `speck Counter {
    state { n: Nat }
    init { n := 0 }
    invariant Mono { n' >= n }
    action Inc() {
        n := n + 1
    }
}
${tail}`;
    const ast = actions(src);
    expect(ast.map(s => s.name)).toEqual(['Counter', 'B']);
    expect(ast[0].members).toContainEqual({ inv: 'Mono', expr: "n' >= n" });
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:n + 1']);
  });

  it('a prime then a set that spans lines stays inside the invariant', () => {
    const src = `speck Counter {
    state { n: Nat }
    init { n := 0 }
    invariant Mono {
        n' >= n and n in {
        0,1,2,3 }
    }
    action Inc() {
        n := n + 1
    }
}
${tail}`;
    const ast = actions(src);
    expect(ast[0].members).toContainEqual({ inv: 'Mono', expr: "n' >= n and n in { 0,1,2,3 }" });
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:n + 1']);
    expect(ast.map(s => s.name)).toEqual(['Counter', 'B']);
  });

  it('empty string and escaped backslash close before a trailing comment', () => {
    const src = `speck Counter {
    state { n: Nat s: String }
    init { n := 0 s := "a" }
    action Inc() {
        s := "" // reset }
        s := "\\\\" // reset }
        n := n + 1
    }
}
${tail}`;
    const ast = actions(src);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:""', 'assign:"\\\\"', 'assign:n + 1']);
    expect(ast.map(s => s.name)).toEqual(['Counter', 'B']);
  });

  it('require n\' >= n // look } keeps the comment out of the guard and the Go error', () => {
    const src = `speck Counter {
    state { n: Nat }
    init { n := 0 }
    action Peek() {
        require n' >= n // look }
        n := n
    }
}
`;
    const ast = actions(src, 'peek.speckdl');
    const peek = ast[0].members.find(m => 'action' in m && m.action === 'Peek') as { stmts: string[] };
    expect(peek.stmts[0]).toBe("require:n' >= n");
    const dir = mkdtempSync(join(tmpdir(), 'speckl-lex-go-'));
    const file = join(dir, 'Peek.speckdl');
    writeFileSync(file, src);
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'go', bomFormat: 'cdx', verifyDepth: 3 });
    const go = readdirSync(out, { recursive: true }).map(String).find(f => f.endsWith('.go'));
    expect(go).toBeTruthy();
    const text = readFileSync(join(out, go!), 'utf-8');
    expect(text).toContain("guard failed: n' >= n");
    expect(text).not.toContain('look');
  });
});

describe('scanner paths used by the other block forms', () => {
  it('keeps a same-line state-as name and a license', () => {
    const ast = parseSpeckContent(`speck S {
    license: "MIT"
    k8s_group: "ex.dev"
    k8s_version: "v1"
    ownerReferences: false
    state as Proto { n: Nat }
    init { n := 0 }
}
`, 'meta.speckdl');
    const speck = ast.specks[0];
    expect(speck.license).toBe('MIT');
    expect(speck.k8sGroup).toBe('ex.dev');
    expect(speck.k8sVersion).toBe('v1');
    const state = speck.members.find(m => m.type === 'state') as { messageName?: string; variables: { name: string }[] };
    expect(state.messageName).toBe('Proto');
    expect(state.variables.map(v => v.name)).toEqual(['n']);
    const life = (speck.members as unknown as { type: string; key?: string; value?: unknown }[])
      .find(m => m.type === 'lifecycle_metadata');
    expect(life).toMatchObject({ key: 'ownerReferences', value: false });
  });

  it('rejects a next block that is not empty, on one line and across lines', () => {
    expect(() => parseSpeckContent('speck S {\n  next: { Inc }\n}\n', 'n.speckdl')).toThrow(/next: \{ \.\.\. \} must be empty/);
    expect(() => parseSpeckContent('speck S {\n  next: {\n    Inc\n  }\n}\n', 'n.speckdl')).toThrow(/next: \{ \.\.\. \} must be empty/);
  });

  it('rejects a verify line that is not a known form', () => {
    expect(() => parseSpeckContent('speck S {\n  verify nope\n}\n', 'v.speckdl')).toThrow(/unsupported verify form/);
  });

  it('parses a one-line stages block and a service method', () => {
    const ast = parseSpeckContent(`speck S {
    state { n: Nat }
    init { n := 0 }
    action Go() { n := n }
    agent {
        stages empty { }
        stages stage { Idle = 0 }
        tool go -> Go effect observe
    }
    interface Svc {
        Get(id: Nat) -> String
    }
}
`, 'svc.speckdl');
    const agent = ast.specks[0].members.find(m => m.type === 'agent') as { stages?: { labels: { name: string }[] } };
    expect(agent.stages?.labels.map(l => l.name)).toEqual(['Idle']);
    const iface = ast.specks[0].members.find(m => m.type === 'interface') as { methods: { name: string }[] };
    expect(iface.methods.map(m => m.name)).toEqual(['Get']);
  });

  it('joins an init value that stays open onto the next assignment', () => {
    const ast = parseSpeckContent(`speck S {
    state { n: Nat }
    init {
        n := Rec {
        m := 1
    }
}
`, 'init.speckdl');
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    expect(init.assignments[0].expr).toContain('Rec {');
    expect(init.assignments[0].expr).toContain('m := 1');
  });

  it('a brace inside a block comment does not close a for or an if', () => {
    const src = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go() {
        for x in xs {
            /* note
            }
            */
            n := n + 1
        }
        if n > 0 {
            /* note
            }
            */
            n := n
        } else {
            n := 0
        }
    }
}
`;
    const ast = parseSpeckContent(src, 'loop.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { type: string; raw?: string }[] };
    const fors = action.statements.filter(s => s.type === 'forblock');
    const ifs = action.statements.filter(s => s.type === 'ifblock');
    expect(fors).toHaveLength(1);
    expect(ifs).toHaveLength(1);
    expect(fors[0].raw).toContain('n := n + 1');
    expect(fors[0].raw).not.toContain('note');
    expect(ifs[0].raw).toContain('n := n');
    expect(ifs[0].raw).toContain('else');
    expect(ifs[0].raw).not.toContain('note');
  });

  it('keeps a multi-line constraint: and ignores a brace inside its comment', () => {
    const ast = parseSpeckContent(`speck S {
    state { n: Nat }
    constraint: (
        /* note
        }
        */
        n > 0
    )
    action Go() { n := n }
}
`, 'c.speckdl');
    const c = ast.specks[0].members.find(m => m.type === 'constraint') as { expr: string };
    expect(c.expr).toContain('n > 0');
    expect(c.expr).not.toContain('note');
    expect(ast.specks[0].members.some(m => m.type === 'action')).toBe(true);
  });
});

describe('CRLF', () => {
  const cr = (src: string) => src.replace(/\n/g, '\r\n');

  it('n3, n10, n18, and n13 still name the file', () => {
    expect(() => parseSpeckContent(cr(`speck A {
    state { x: Nat }
    action Inc() {
        /*
        x := x + 2
    }
}
${tail}`), 'n3.speckdl')).toThrow(/Parse error at n3\.speckdl:\d+: unterminated block comment/);
    expect(() => parseSpeckContent(cr(`speck A {
    state { s: String }
    action Inc() {
        s := "unterminated
        x := x + 10
    }
}
${tail}`), 'n10.speckdl')).toThrow(/Parse error at n10\.speckdl:\d+: unterminated string/);
    expect(() => parseSpeckContent(cr(`speck A {
    action Inc() {
        /* "*/" { */
        x := x + 18
    }
}
${tail}`), 'n18.speckdl')).toThrow(/Parse error at n18\.speckdl:\d+: unterminated string/);
    expect(() => parseSpeckContent(cr(`speck A {
    action Inc() {
        */
        x := x + 13
    }
}
${tail}`), 'n13.speckdl')).toThrow(/Parse error at n13\.speckdl:\d+: stray \*\//);
  });

  it('n8 keeps the assignment after a block comment', () => {
    const ast = actions(cr(`speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        /* c */ x := x + 8
    }
}
${tail}`));
    expect(ast.map(s => s.name)).toEqual(['A', 'B']);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:x + 1', 'assign:x + 8']);
  });

});

describe('code after a comment that closed on a later line', () => {
  it('keeps an invariant, a field, an init, and an action statement', () => {
    const src = [
      'speck A {',
      '    invariant Pos { /* a',
      '        b */ n >= 0 }',
      '    state { /* a',
      '        b */ n: Nat }',
      '    init { /* a',
      '        b */ n := 0 }',
      '    action Go { n := n + 1 /* a',
      '        b */ }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'keep.speckdl');
    const inv = ast.specks[0].members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr.replace(/\s+/g, ' ')).toContain('n >= 0');
    const state = ast.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map(v => v.name)).toContain('n');
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    expect(init.assignments.map(a => a.name)).toContain('n');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { type: string; expr?: string }[] };
    expect(action.statements.some(s => s.type === 'assign' && String(s.expr).includes('n + 1'))).toBe(true);
  });

  it('keeps a constraint and a verify whose comment closes on the next line', () => {
    const src = [
      'speck A {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    constraint Bound: { /* a',
      '        b */ n >= 0 }',
      '    verify Always(Bound) { /* a',
      '        b */ depth 2 }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 's12.speckdl');
    const c = ast.specks[0].members.find(m => m.type === 'constraint') as { expr: string };
    expect(c.expr).toContain('n >= 0');
    const v = ast.specks[0].members.find(m => m.type === 'verify') as { depth?: number };
    expect(v.depth).toBe(2);
  });

  it('rejects a header that follows a comment closer from an earlier line', () => {
    expect(() => parseSpeckContent([
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '} /*',
      '*/ speck B {',
      '    invariant Canary { false }',
      '}',
      '',
    ].join('\n'), 'p09.speckdl')).toThrow(/Parse error at p09\.speckdl:5: header is not at the start of the line/);
    expect(() => parseSpeckContent([
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    /*',
      '    */ action Evil { x := 99 }',
      '}',
      '',
    ].join('\n'), 'b02.speckdl')).toThrow(/Parse error at b02\.speckdl:5: header is not at the start of the line/);
  });

  it('keeps an if body when a comment closes on the line with the statement', () => {
    const src = [
      'speck A {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go {',
      '        if n > 5 {',
      '            /* a',
      '            b */ n := 0',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'h11.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { raw?: string }[] };
    expect(action.statements[0].raw).toContain('n := 0');
  });

  it('keeps a field or assignment that follows a comment on the next line', () => {
    const src = [
      'speck A {',
      '    state {',
      '        /* a',
      '        b */ n: Nat',
      '        m: Nat /* a',
      '        b */ p: Nat',
      '    }',
      '    init {',
      '        /* a',
      '        b */ n := 0',
      '        m := 0 /* a',
      '        b */ q := 7',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'fields.speckdl');
    const state = ast.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map(v => v.name)).toEqual(['n', 'm', 'p']);
    const init = ast.specks[0].members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    expect(init.assignments.map(a => `${a.name}=${a.expr}`)).toEqual(['n=0', 'm=0', 'q=7']);
  });

  it('keeps the if body when a comment sits between the condition and the brace', () => {
    const src = [
      'speck A {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go {',
      '        if n > 3 /* a',
      '        b */ {',
      '            n := 0',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'x09.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as {
      statements: { type: string; raw?: string }[];
    };
    expect(action.statements.map(s => s.type)).toEqual(['ifblock']);
    expect(action.statements[0].raw).toContain('n := 0');
    expect(action.statements[0].raw).toContain('{');
    const out = mkdtempSync(join(tmpdir(), 'speckl-x09-'));
    generateGo(ast, out);
    const go = readFileSync(join(out, 'a', 'a.go'), 'utf8');
    expect(go).not.toContain('TODO: conditional not lowered');
    expect(go).toMatch(/if .*> 3[\s\S]*m\.N = 0/);
  });
});

describe('a block comment opened on a member header', () => {
  it('is not a stray closer, and a later line is still the member', () => {
    const src = [
      'speck A {',
      '    invariant Mono { /* a',
      '        b */ }',
      '    state { /* c',
      '        d */',
      '        y: Nat',
      '    }',
      '    init { /* e',
      '        f */',
      '        x := 1',
      '    }',
      '    action Go { /* g',
      '        h */',
      '        x := x + 1',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'span.speckdl');
    const members = ast.specks[0].members;
    const inv = members.find(m => m.type === 'invariant') as { name: string };
    expect(inv.name).toBe('Mono');
    const state = members.find(m => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map(v => v.name)).toEqual(['y']);
    const init = members.find(m => m.type === 'init') as { assignments: { name: string; expr: string }[] };
    expect(init.assignments.map(a => `${a.name}=${a.expr}`)).toEqual(['x=1']);
    const action = members.find(m => m.type === 'action') as { statements: { type: string; expr?: string }[] };
    expect(action.statements.map(s => s.type)).toContain('assign');
  });
});
