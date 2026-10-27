// Unterminated comments and strings must fail closed, and a brace or a
// prime must not move the next speck. `'` is post-state notation.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { compileSpec } from '../compile.js';
import { scanLine, setParseFile } from '../lex.js';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { judge } from '../../scripts/lib/obligations.mjs';

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
    expect(() => parseSpeckContent(src, 'n18.speckdl')).toThrow(/Parse error at n18\.speckdl:\d+: unterminated string: a block comment closed inside a string/);
  });

  it('a quote hard against a comment closer does not open a string when code follows', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        /*"*/ x := x + 8
    }
}
${tail}`;
    const ast = actions(src);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:x + 8']);
    expect(ast.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('a comment that closes inside quotes then a finished string is not an error', () => {
    const src = `speck A {
    state { x: Nat }
    init { x := 0 }
    action Inc() {
        x := x + 1
        /*"*/"ok"
        x := x + 2
    }
}
${tail}`;
    const ast = actions(src);
    const inc = ast[0].members.find(m => 'action' in m && m.action === 'Inc') as { stmts: string[] };
    expect(inc.stmts).toEqual(['assign:x + 1', 'assign:x + 2']);
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

describe('a one-line header keeps its body when } is on the next line', () => {
  const src = `speck Gate {
    state { n: Nat }
    init { n := 0 }
    event Pong {
        b: Bool
    }
    event Ping { a: Nat // note
    }
    action Inc() { n := n + 1 // note
    }
    action Guard() { require false // note
    }
    invariant Mono { false // note
    }
    constraint Bound: { false // note
    }
    constraint "Also" { false // note
    }
    verify "holds" { false // note
    }
    verify "with depth" { depth 2, false // note
    }
    verify "preset" depth 1 { false // note
    }
    verify Always(Mono) { depth 3 // note
    }
    verify Always(Mono) { // bare
    }
    agent { tool go -> Inc effect act // note
        pending timeout 24h
    }
    next: Inc | Guard
}
`;

  it('keeps false, the require, the action, the agent tool, and the event field', () => {
    const ast = parseSpeckContent(src, 'gate.speckdl');
    const speck = ast.specks[0];
    const inv = speck.members.find(m => m.type === 'invariant') as { expr: string };
    expect(inv.expr).toBe('false');
    const ping = speck.members.find(m => m.type === 'event' && m.name === 'Ping') as { fields: { name: string }[] };
    const pong = speck.members.find(m => m.type === 'event' && m.name === 'Pong') as { fields: { name: string }[] };
    expect(ping.fields.map(f => f.name)).toEqual(['a']);
    expect(pong.fields.map(f => f.name)).toEqual(['b']);
    const inc = speck.members.find(m => m.type === 'action' && m.name === 'Inc') as { statements: { type: string; expr: string }[] };
    const guard = speck.members.find(m => m.type === 'action' && m.name === 'Guard') as { statements: { type: string; expr: string }[] };
    expect(inc.statements.map(s => `${s.type}:${s.expr}`)).toEqual(['assign:n + 1']);
    expect(guard.statements.map(s => `${s.type}:${s.expr}`)).toEqual(['require:false']);
    const bound = speck.members.find(m => m.type === 'constraint' && m.name === 'Bound') as { expr: string };
    const also = speck.members.find(m => m.type === 'constraint' && m.name === 'Also') as { expr: string };
    expect(bound.expr).toBe('false');
    expect(also.expr).toBe('false');
    const verifies = speck.members.filter(m => m.type === 'verify') as { name: string; temporalExpr: string; depth?: number }[];
    expect(verifies.map(v => [v.name, v.temporalExpr, v.depth])).toEqual([
      ['holds', 'false', undefined],
      ['with depth', 'false', 2],
      ['preset', 'false', 1],
      ['Mono', 'Always(Mono)', 3],
      ['Mono', 'Always(Mono)', undefined],
    ]);
    const agent = speck.members.find(m => m.type === 'agent') as {
      tools: { name: string; action: string; effect: string }[];
      pendingTimeout?: { durationText: string };
    };
    expect(agent.tools).toEqual([{ name: 'go', action: 'Inc', effect: 'act' }]);
    expect(agent.pendingTimeout?.durationText).toBe('24h');
    expect(verifies.every(v => !v.temporalExpr.includes('note'))).toBe(true);
    expect(bound.expr).not.toContain('note');
  });

  it('a same-line agent closer does not take the header as a following line', () => {
    const ast = parseSpeckContent(`speck S {
    state { n: Nat }
    init { n := 0 }
    action Go() { n := n }
    agent { tool go -> Go effect observe }
}
`, 'same.speckdl');
    expect(ast.specks[0].members.some(m => m.type === 'action' && m.name === 'Go')).toBe(true);
    const agent = ast.specks[0].members.find(m => m.type === 'agent') as { tools: unknown[] };
    expect(agent.tools).toEqual([]);
  });

  it('an empty invariant, verify, or constraint body is a parse error', () => {
    const emptyInv = `speck S {\n    invariant Mono { // note\n    }\n}\n`;
    expect(() => parseSpeckContent(emptyInv, 'empty-inv.speckdl')).toThrow(/Parse error at empty-inv\.speckdl:\d+: empty invariant body/);
    expect(() => parseSpeckContent('speck S {\n    invariant Mono { }\n}\n', 'empty-inv.speckdl')).toThrow(/empty invariant body/);
    expect(() => parseSpeckContent('speck S {\n    verify "p" { // note\n    }\n}\n', 'empty-v.speckdl')).toThrow(/Parse error at empty-v\.speckdl:\d+: empty verify body/);
    expect(() => parseSpeckContent('speck S {\n    constraint Bound: { // note\n    }\n}\n', 'empty-c.speckdl')).toThrow(/Parse error at empty-c\.speckdl:\d+: empty constraint body/);
    expect(() => parseSpeckContent('speck S {\n    constraint "p" { }\n}\n', 'empty-c.speckdl')).toThrow(/empty constraint body/);
  });

  it('false with a trailing comment is a counterexample, not a passing proof', () => {
    const hasZ3 = spawnSync('z3', ['--version']).status === 0;
    if (!hasZ3) return;
    const falseSrc = `speck Gate {
    state { n: Nat }
    init { n := 0 }
    action Inc() {
        require true
        n := n + 1
    }
    invariant Mono { false // note
    }
    next: Inc
    verify Always(Mono) {
        depth 3
    }
}
`;
    const dir = mkdtempSync(join(tmpdir(), 'speckl-false-inv-'));
    const file = join(dir, 'Gate.speckdl');
    writeFileSync(file, falseSrc);
    const out = join(dir, 'out');
    compileSpec(file, { outputDir: out, target: 'z3', bomFormat: 'cdx', verifyDepth: 3 });
    const smt = readFileSync(join(out, 'Gate.smt2'), 'utf-8');
    expect(smt).toMatch(/define-fun Mono \(\) Bool\n {2}\(and\n {4}false/);
    expect(smt).not.toMatch(/define-fun Mono \(\) Bool\n {2}\(and\n {4}true/);
    const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: smt, encoding: 'utf-8' });
    const v = judge(smt, r.stdout ?? '', r.stderr ?? '');
    expect(v.status, smt + '\n' + (r.stdout ?? '')).toBe('VIOLATED');
    expect(v.obligations.some((o: { key?: string; ok?: boolean }) => o.key === 'Mono' && o.ok === false)).toBe(true);
  }, 60_000);
});
