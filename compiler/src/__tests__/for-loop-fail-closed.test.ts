// Loops and other block statements in action bodies, across backends.
//
// Speckl's rule: a backend translates a statement or fails closed on it
// (SPECKL-UNTRANSLATED, the action refuses to run). The TypeScript backend
// used to drop `for` loops without a trace: the guards survived, the loop
// body did not, and the action "succeeded" with none of its effects.
// fixtures/LoopSplit.speckdl is the regression: a split action whose loop
// creates the children and sums their shares.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseSpeckContent, parseSpeckFile, ActionStatement } from '../parser.js';
import { parseActionStatements } from '../expr/stmt-parser.js';
import { lower } from '../ir/lower.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';
import { generateTypeScriptFromIR } from '../generators/typescript-from-ir.js';
import { generateGo } from '../generators/go.js';
import { generateElm } from '../generators/elm.js';
import { compileSpec } from '../compile.js';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { judge, accountObligations } from '../../scripts/lib/obligations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures', 'LoopSplit.speckdl'), 'utf-8');

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function action(src: string, name: string) {
  const speck = parseSpeckContent(src).specks[0];
  return speck.members.find((m: any) => m.type === 'action' && m.name === name) as any;
}

/** A one-action speck around `body` (indented 8 spaces). */
const withBody = (body: string, extra = '') => `speck Probe {
    state {
        items: Map(Nat, Nat)
        total: Nat
    }
    init {
        items := emptyMap
        total := 0
    }
${extra}
    action Run(xs: List(Nat)) {
${body.split('\n').map(l => '        ' + l).join('\n')}
    }
}
`;

function typecheck(source: string, file: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-tc-'));
  const path = join(dir, file);
  writeFileSync(path, source);
  const program = ts.createProgram([path], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, skipLibCheck: true });
  return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

async function load(source: string, cls: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-rt-'));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = join(dir, 'm.mjs');
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href))[cls];
}

function generateTs(src: string, file: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-ts-'));
  generateTypeScriptStateMachine(parseSpeckContent(src), dir);
  return readFileSync(join(dir, file), 'utf-8');
}

describe('parser: block statements in action bodies', () => {
  it('parses the fixture loop into a structured for-block with its whole body', () => {
    const split = action(FIXTURE, 'SplitLot');
    const loop = split.statements.find((s: ActionStatement) => s.type === 'forblock');
    expect(loop.loop).toMatchObject({ variable: 'i', from: '0', to: 'n - 1' });
    expect(loop.loop.body.map((s: ActionStatement) => s.type))
      .toEqual(['let', 'let', 'require', 'require', 'assign', 'ifblock', 'assign', 'assign']);
    expect(loop.loop.body[5].branches).toEqual([
      { cond: 'c.label != ""', body: [{ type: 'assign', target: 'labels[c.label]', expr: 'cid' }] },
    ]);
    // statements after the loop stay outside it
    const after = split.statements.slice(split.statements.indexOf(loop) + 1).map((s: ActionStatement) => s.type);
    expect(after).toEqual(['require', 'assign', 'assign', 'assign', 'emit']);
  });

  it('reads `forall v in S:` with an indented body as a loop over S, and if/else-if/else chains', () => {
    const a = action(withBody([
      'forall x in xs:',
      '    total := total + x',
      'if total > 10 {',
      '    total := 10',
      '} else if total > 5 {',
      '    total := 5',
      '} else {',
      '    total := 0',
      '}',
    ].join('\n')), 'Run');
    expect(a.statements[0]).toMatchObject({ type: 'forblock', loop: { variable: 'x', collection: 'xs' } });
    expect(a.statements[0].loop.body).toEqual([{ type: 'assign', target: 'total', expr: 'total + x' }]);
    expect(a.statements[1].branches.map((b: any) => b.cond)).toEqual(['total > 10', 'total > 5', null]);
  });

  it('keeps a statement it cannot read as `unparsed` instead of dropping it', () => {
    const a = action(withBody('notify(total)\ntotal := 1'), 'Run');
    expect(a.statements).toEqual([
      { type: 'unparsed', raw: 'notify(total)' },
      { type: 'assign', target: 'total', expr: '1' },
    ]);
  });
});

describe('IR statement parser: loops stay whole', () => {
  it('keeps a colon-form loop and its body as one raw statement', () => {
    const stmts = parseActionStatements([
      '        let n := 3',
      '        for i from 0 to n - 1:',
      '            total := total + i',
      '            items[i] := i',
      '        total := total + 1',
    ]);
    expect(stmts.map(s => s.type)).toEqual(['let', 'ifblock', 'assign']);
    expect((stmts[1] as any).raw).toBe('for i from 0 to n - 1: total := total + i items[i] := i');
  });

  it('keeps a brace-form forall block whole', () => {
    const stmts = parseActionStatements(['forall x in xs {', '  total := total + x', '}', 'total := 0']);
    expect(stmts.map(s => s.type)).toEqual(['ifblock', 'assign']);
    expect((stmts[0] as any).raw).toBe('forall x in xs { total := total + x }');
  });
});

describe('TypeScript backend: the fixture loop is translated', () => {
  let source = '';
  let Machine: any;
  beforeAll(async () => {
    source = generateTs(FIXTURE, 'LoopSplit.ts');
    Machine = await load(source, 'LoopSplitMachine');
  });

  it('emits the loop as an inclusive range loop with no untranslated marker', () => {
    expect(source).toContain('for (let i = 0, __i_to = n - 1; i <= __i_to; i++) {');
    expect(source).not.toContain('SPECKL-UNTRANSLATED');
    expect(source).not.toMatch(/TODO|FIXME/);
  });

  it('typechecks under --strict', () => {
    expect(typecheck(source, 'LoopSplit.ts')).toEqual([]);
  });

  it('creates every child, links it to the parent, and records the split', () => {
    const m = new Machine();
    m.AddLot(1, 100, 'parent');
    m.SplitLot(1, 10, [{ share: 60, label: 'a' }, { share: 40, label: '' }]);
    expect(m.lots.get(10)).toEqual({ id: 10, total: 60, label: 'a', parentId: 1, status: 'open' });
    expect(m.lots.get(11)).toEqual({ id: 11, total: 40, label: '', parentId: 1, status: 'open' });
    expect(m.lots.get(1).status).toBe('split');
    expect(m.children.get(1)).toEqual([10, 11]);
    expect([...m.labels.entries()]).toEqual([['a', 10]]);   // the if inside the loop
    expect(m.splitCount).toBe(1);
    expect(m.decisionLog).toEqual([{ parentId: 1, childCount: 2 }]);
  });

  it('rejects shares that do not add up and rolls back the children the loop created', () => {
    const m = new Machine();
    m.AddLot(1, 100, 'parent');
    expect(() => m.SplitLot(1, 10, [{ share: 60, label: 'a' }, { share: 30, label: 'b' }]))
      .toThrow('Guard failed: allocSum === p.total');
    expect([...m.lots.keys()]).toEqual([1]);
    expect(m.labels.size).toBe(0);
    expect(m.lots.get(1).status).toBe('open');
    expect(m.splitCount).toBe(0);
  });

  it('rejects a child id that is taken, mid-loop, without partial effects', () => {
    const m = new Machine();
    m.AddLot(1, 100, 'parent');
    m.AddLot(11, 5, 'taken');
    expect(() => m.SplitLot(1, 10, [{ share: 60, label: 'a' }, { share: 40, label: 'b' }]))
      .toThrow('Guard failed: !this.lots.has(cid)');
    expect([...m.lots.keys()].sort((x, y) => x - y)).toEqual([1, 11]);
    expect(m.labels.size).toBe(0);
  });
});

describe('TypeScript backend: what it cannot translate fails closed', () => {
  it('a statement the parser could not read throws SPECKL-UNTRANSLATED at runtime and still compiles', async () => {
    const src = withBody('notify(total)\ntotal := total + 1');
    const source = generateTs(src, 'Probe.ts');
    expect(source).toContain('// SPECKL-UNTRANSLATED: Run: notify(total)');
    expect(typecheck(source, 'Probe.ts')).toEqual([]);
    const m = new (await load(source, 'ProbeMachine'))();
    expect(() => m.Run([])).toThrow('SPECKL-UNTRANSLATED: Run: notify(total)');
    expect(m.total).toBe(0);
  });

  it('a name nothing declares (an untranslated binding) throws instead of becoming a placeholder value', async () => {
    const src = withBody('if total == Missing {\n    total := 1\n}');
    const source = generateTs(src, 'Probe.ts');
    expect(source).not.toMatch(/Missing = \{\} as any/);
    const m = new (await load(source, 'ProbeMachine'))();
    expect(() => m.Run([])).toThrow('SPECKL-UNTRANSLATED: Run: unresolved name(s) Missing');
  });

  it('a loop over a whole map (key or value iteration is ambiguous) fails closed', async () => {
    const source = generateTs(withBody('for k in items {\n    total := total + 1\n}'), 'Probe.ts');
    const m = new (await load(source, 'ProbeMachine'))();
    expect(() => m.Run([])).toThrow(/SPECKL-UNTRANSLATED: Run: .*items/);
  });

  it('a loop over a list or a map\'s keys is translated', async () => {
    const source = generateTs(withBody([
      'for x in xs {',
      '    items[x] := x * 2',
      '}',
      'for k in items.keys {',
      '    total := total + k',
      '}',
    ].join('\n')), 'Probe.ts');
    expect(typecheck(source, 'Probe.ts')).toEqual([]);
    const m = new (await load(source, 'ProbeMachine'))();
    m.Run([2, 3]);
    expect([...m.items.entries()]).toEqual([[2, 4], [3, 6]]);
    expect(m.total).toBe(5);
  });
});

describe('IR TypeScript backend: raw statements throw', () => {
  it('turns the loop it cannot lower into a SPECKL-UNTRANSLATED throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-ir-'));
    const specFile = join(dir, 'LoopSplit.speckdl');
    writeFileSync(specFile, FIXTURE);
    generateTypeScriptFromIR(lower(parseSpeckFile(specFile), { filePath: specFile, resolveImports: false }), dir);
    const out = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(out).toMatch(/throw new Error\("SPECKL-UNTRANSLATED: for i from 0 to n - 1: let c := parts\[i\]/);
    // every marker comes with its throw
    const markers = out.match(/\/\/ SPECKL-UNTRANSLATED/g) ?? [];
    expect(markers.length).toBeGreaterThan(0);
    expect((out.match(/throw new Error\("SPECKL-UNTRANSLATED/g) ?? []).length).toBe(markers.length);
  });
});

describe('Go backend', () => {
  function goSource(src: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-go-'));
    generateGo(parseSpeckContent(src), dir);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.go')) files.push(readFileSync(join(d, e.name), 'utf-8'));
      }
    };
    walk(dir);
    return files.join('\n');
  }

  it('lowers the fixture range loop and the if inside it', () => {
    const go = goSource(FIXTURE);
    expect(go).toContain('for i, iTo := int64(0), int64(n - 1); i <= iTo; i++ {');
    expect(go).toMatch(/\t\tif c\.Label != "" \{\n\t\t\tm\.Labels\[c\.Label\] = cid\n\t\t\}/);
    expect(go).toContain('\t\tkids = append(kids, cid)');
    expect(go).not.toMatch(/TODO: (for-loop|conditional) not lowered/);
  });

  it('fails closed on a statement it cannot lower', () => {
    const go = goSource(withBody('notify(total)\ntotal := total + 1'));
    expect(go).toContain('err = fmt.Errorf("SPECKL-UNTRANSLATED: Run: notify(total)")\n\treturn');
    expect(go).not.toContain('_ = notify');
  });
});

describe('Elm backend', () => {
  it('applies no part of a transition it cannot fully translate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-elm-'));
    generateElm(parseSpeckContent(FIXTURE), dir);
    const elmDir = join(dir, readdirSync(dir).find(d => d.endsWith('-elm'))!, 'src');
    const machine = readFileSync(join(elmDir, 'LoopSplitMachine.elm'), 'utf-8');
    const split = machine.slice(machine.indexOf('        SplitLot parentId'), machine.indexOf('\n\n', machine.indexOf('        SplitLot parentId')));
    expect(split).toContain('-- SPECKL-UNTRANSLATED (transition applied server-side only): for i from 0 to n - 1');
    expect(split).toContain('|> guard');
    expect(split).not.toContain('thenSet');
    expect(split).not.toContain('logEvent');
  });
});

describe('Z3 backend: block assignments are not framed as unchanged', () => {
  const hasZ3 = spawnSync('z3', ['--version']).status === 0;
  const spec = (inLoop: boolean) => `speck Fill {
    state {
        stage: Nat
        bad: Nat
    }
    init {
        stage := 0
        bad := 0
    }
    invariant Safe {
        bad == 0
    }
    action Run(k: Nat) {
        require stage == 0
${inLoop ? '        for i from 0 to k:\n            bad := bad + 1' : ''}
        stage := 1
    }
    next: Run
    verify Always(Safe) {
        depth 3
    }
}
`;
  function verify(src: string) {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-loop-z3-'));
    const file = join(dir, 'Fill.speckdl');
    writeFileSync(file, src);
    compileSpec(file, { outputDir: join(dir, 'out'), target: 'z3', bomFormat: 'both', verifyDepth: 10 });
    const smt = readFileSync(join(dir, 'out', 'Fill.smt2'), 'utf-8');
    const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: smt, encoding: 'utf-8' });
    const v = judge(smt, r.stdout ?? '', r.stderr ?? '');
    const acc = accountObligations([{ smt, obligations: v.obligations }]);
    return { smt, proven: acc.proven as string[], violated: v.obligations.filter((o: any) => !o.ok && o.key).map((o: any) => o.key) };
  }

  it('leaves a variable assigned inside a loop unconstrained in the step', () => {
    const { smt } = verify(spec(true));
    expect(smt).toContain('; speckl: Run assigns bad inside if/for blocks; the step leaves them unconstrained (over-approximation)');
    const step0 = smt.match(/\(and ; Action: Run\n([\s\S]*?)\n    \)/)![1];
    expect(step0).toContain('(= stage_1 1)');
    expect(step0).not.toContain('bad_1');   // no frame, no assignment: havoc
  });

  it.skipIf(!hasZ3)('does not prove an invariant the loop breaks (it used to: the frame said bad was unchanged)', () => {
    const broken = verify(spec(true));
    expect(broken.proven).not.toContain('Fill.speckdl:Safe');
    expect(broken.proven.some(p => p.endsWith('Safe'))).toBe(false);
    const fine = verify(spec(false));
    expect(fine.proven.some(p => p.endsWith('Safe'))).toBe(true);
  });
});

describe('TypeScript backend: members of one-line union types', () => {
  // Two one-line unions (#24 parses `type X = A | B` as an enum). Each member
  // must be qualified with the enum that declares it; they used to be
  // qualified with the state enum (`ProbeMode.Done`) or, before #24, left
  // undeclared.
  const SRC = `speck Probe {
    type Mode = Idle | Busy
    type Kind = Small | Large
    type Job = { size: Nat, kind: Kind }

    state {
        mode: Mode
        jobs: Map(Nat, Job)
        peak: Nat
    }
    init {
        mode := Idle
        jobs := emptyMap
        peak := 0
    }
    action Add(id: Nat, size: Nat) {
        require mode == Idle
        require id notIn jobs.keys
        let k := Small
        if size > 10 {
            k := Large
        }
        jobs[id] := { size: size, kind: k }
        peak := max(peak, size)
        if k == Large {
            mode := Busy
        }
    }
}
`;
  it('declares each union, qualifies members with their own enum, and runs', async () => {
    const source = generateTs(SRC, 'Probe.ts');
    expect(source).toContain('ProbeKind.Large');
    expect(source).not.toContain('ProbeMode.Large');
    expect(source).toContain('Math.max(this.peak, size)');
    expect(source).not.toContain('SPECKL-UNTRANSLATED');
    expect(typecheck(source, 'Probe.ts')).toEqual([]);
    const m = new (await load(source, 'ProbeMachine'))();
    m.Add(1, 4);
    expect(m.jobs.get(1)).toEqual({ size: 4, kind: 'small' });
    expect(m.mode).toBe('idle');
    m.Add(2, 20);
    expect(m.jobs.get(2).kind).toBe('large');
    expect(m.mode).toBe('busy');
    expect(m.peak).toBe(20);
    expect(() => m.Add(3, 1)).toThrow('Guard failed');
  });
});
