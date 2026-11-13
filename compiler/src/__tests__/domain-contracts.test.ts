// Domain consumes/produces contracts, per-action cost, and budget per tick.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { compileSpec } from '../compile.js';
import { doctorFile } from '../doctor.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const indexTs = join(compilerDir, 'src', 'index.ts');
const verifyScript = join(compilerDir, 'scripts', 'verify-z3.mjs');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-contract-'));
}

function write(root: string, name: string, src: string): string {
  const file = join(root, name);
  writeFileSync(file, src);
  return file;
}

function load(file: string) {
  return lower(parseSpeckFile(file), {
    filePath: file,
    resolveImports: true,
    rootDir: path.dirname(file),
  });
}

function errorsOf(file: string): string[] {
  return load(file).diagnostics.filter(d => d.level === 'error').map(d => d.message);
}

function compile(file: string, target: 'z3' | 'camel' | 'all' | 'all-ir' = 'z3', depth = 6): string {
  const out = join(path.dirname(file), 'out-' + target + '-' + depth);
  compileSpec(file, { outputDir: out, target, bomFormat: 'both', verifyDepth: depth });
  return out;
}

function runZ3(smt: string): { verdict: { status: string; obligations: { got?: string; expect?: string }[] }; model: string } {
  const res = spawnSync('z3', ['-smt2', '-in', '-T:20'], { input: smt, encoding: 'utf-8' });
  const verdict = judge(smt, res.stdout ?? '', res.stderr ?? '');
  const model = spawnSync('z3', ['-smt2', '-in', '-T:20'], {
    input: smt.replace(/\(check-sat\)/, '(check-sat)\n(get-model)'),
    encoding: 'utf-8',
  });
  return { verdict, model: (model.stdout ?? '') + (model.stderr ?? '') };
}

function machine(name: string, actionBody: string, extra = '', next = 'Go'): string {
  return `speck ${name} {
    state { n: Nat }
    init { n := 0 }
    ${extra}
    action Go {
        ${actionBody}
    }
    next: ${next}
}
`;
}

describe('syntax', () => {
  const src = `
domain Billing {
    members: Invoice;
    language: "invoices";
    consumes PaymentReceived;
    produces InvoiceIssued, Receipt;
    budget 0 per tick;
}
speck Invoice {
    state { n: Nat }
    init { n := 0 }
    event PaymentReceived external { amount: Nat }
    event InvoiceIssued { amount: Nat }
    event Receipt { amount: Nat }
    action Issue {
        cost 0
        n := n + 1
        emit InvoiceIssued { amount: n }
    }
    next: Issue
}
`;

  it('parses and round-trips consumes, produces, external, cost, and budget', () => {
    const ast = parseSpeckContent(src);
    const domain = ast.domains![0];
    expect(domain.consumes).toEqual(['PaymentReceived']);
    expect(domain.produces).toEqual(['InvoiceIssued', 'Receipt']);
    expect(domain.budgetPerTick).toBe(0);
    const again = parseSpeckContent(printAST(ast));
    expect(again.domains!.map(d => ({
      name: d.name, members: d.members, language: d.language,
      consumes: d.consumes, produces: d.produces, budgetPerTick: d.budgetPerTick,
    }))).toEqual(ast.domains!.map(d => ({
      name: d.name, members: d.members, language: d.language,
      consumes: d.consumes, produces: d.produces, budgetPerTick: d.budgetPerTick,
    })));
    const events = again.specks[0].members.filter(m => m.type === 'event');
    expect(events.map(e => e.type === 'event' ? [e.name, e.external ?? false] : [])).toEqual([
      ['PaymentReceived', true],
      ['InvoiceIssued', false],
      ['Receipt', false],
    ]);
    const issue = again.specks[0].members.find(m => m.type === 'action' && m.name === 'Issue');
    expect(issue?.type === 'action' && issue.statements.some(s => s.type === 'cost' && s.amount === 0)).toBe(true);
  });

  it('rejects a negative cost, a negative budget, a duplicate cost, and a duplicate consume', () => {
    expect(() => parseSpeckContent('speck A {\n    action Go { cost -1 }\n}\n')).toThrow(/non-negative integer/);
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1.5 }\n}\n')).toThrow(/non-negative integer/);
    expect(() => parseSpeckContent('speck A {\n    action Go { cost 1\n        cost 2 }\n}\n')).toThrow(/more than once/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget -3 per tick;\n}\n')).toThrow(/non-negative integer per tick/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget 1 per second;\n}\n')).toThrow(/non-negative integer per tick/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    budget 1 per tick;\n    budget 2 per tick;\n}\n')).toThrow(/budget twice/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    consumes Gone, Gone;\n}\n')).toThrow(/consumes Gone more than once/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    produces ;\n}\n')).toThrow(/produces has no event/);
  });

  it('assigns state variables named cost and costTotal, and keeps a brace inside a string', () => {
    const src = `speck Meter {
    state {
        cost: Nat
        costTotal: Nat
    }
    init {
        cost := 0
        costTotal := 0
    }
    action Add {
        costTotal := costTotal + 1
        cost := cost + 1
    }
    action Say { require cost > "}" }
    next: Add
}
`;
    const ast = parseSpeckContent(src);
    const state = ast.specks[0].members.find(m => m.type === 'state');
    expect(state && state.type === 'state' ? state.variables.map(v => v.name) : []).toEqual(['cost', 'costTotal']);
    const types = state && state.type === 'state' ? state.variables.map(v => v.typeExpr.type === 'ident' || v.typeExpr.type === 'primitive' ? v.typeExpr.name : v.typeExpr.type) : [];
    expect(types).toEqual(['Nat', 'Nat']);
    const add = ast.specks[0].members.find(m => m.type === 'action' && m.name === 'Add');
    expect(add && add.type === 'action' ? add.statements.map(s => s.type === 'assign' ? s.target : s.type) : []).toEqual(['costTotal', 'cost']);
    const say = ast.specks[0].members.find(m => m.type === 'action' && m.name === 'Say');
    expect(say && say.type === 'action' ? say.statements : []).toEqual([{ type: 'require', expr: 'cost > "}"' }]);
    const root = dir();
    const file = write(root, 'cost.speckdl', src);
    const ir = load(file);
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const lowered = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Add');
    expect(lowered?.statements.some(s => s.kind === 'assign' && s.target === 'costTotal')).toBe(true);
    expect(lowered?.cost).toBeUndefined();
  });

  it('ignores a trailing line comment on a cost statement', () => {
    const src = `speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 3 // per call
        n := n + 1
    }
    action Inline { cost 0 } // zero is a real cost
    next: Go | Inline
}
`;
    const ast = parseSpeckContent(src);
    const amount = (name: string) => {
      const action = ast.specks[0].members.find(m => m.type === 'action' && m.name === name);
      const cost = action && action.type === 'action' ? action.statements.find(s => s.type === 'cost') : undefined;
      return cost && cost.type === 'cost' ? cost.amount : undefined;
    };
    expect(amount('Go')).toBe(3);
    expect(amount('Inline')).toBe(0);
    const go = ast.specks[0].members.find(m => m.type === 'action' && m.name === 'Go');
    expect(go && go.type === 'action' ? go.statements.map(s => s.type === 'assign' ? s.target : s.type) : []).toEqual(['cost', 'n']);
    const root = dir();
    const ir = load(write(root, 'cost-comment.speckdl', src));
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const lowered = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Go');
    expect(lowered?.cost).toBe(3);
  });

  it('parses a generic state field whose type contains commas', () => {
    const ast = parseSpeckContent(`speck Meter {
    state {
        m: Map<String, Set<Nat>>
        k: Nat
    }
    init { k := 0 }
}
`);
    const state = ast.specks[0].members.find(m => m.type === 'state');
    expect(state && state.type === 'state' ? state.variables.map(v => v.name) : []).toEqual(['m', 'k']);
    const vars = state && state.type === 'state' ? state.variables : [];
    expect(vars[0].typeExpr).toEqual({
      type: 'map',
      keyType: { type: 'primitive', name: 'String' },
      valueType: { type: 'set', elementType: { type: 'primitive', name: 'Nat' } },
    });
    expect(vars[1].typeExpr).toEqual({ type: 'primitive', name: 'Nat' });
  });
});

describe('contract checks fail closed before output', () => {
  it('rejects a consumed event that no domain produces and that is not external', () => {
    const root = dir();
    const file = write(root, 'bad.speckdl', `
event Note { n: Nat }
${machine('A', 'n := n + 1', 'event Note { n: Nat }')}
domain Billing {
    members: A;
    consumes Note;
}
`.replace('event Note { n: Nat }\n', ''));
    // The event lives on the speck. Nothing produces it.
    const src = `${machine('A', 'n := 1', 'event Note { n: Nat }')}
domain Billing {
    members: A;
    consumes Note;
}
`;
    writeFileSync(file, src);
    expect(errorsOf(file).join('\n')).toMatch(/domain: Billing consumes Note, which no domain produces and which is not external/);
    const out = join(root, 'out');
    expect(() => compileSpec(file, { outputDir: out, target: 'all', bomFormat: 'both', verifyDepth: 4 })).toThrow(/consumes Note/);
    expect(existsSync(out)).toBe(false);
  });

  it('rejects an unknown event, an emit the domain does not produce, and an emit hidden in if', () => {
    const root = dir();
    const unknown = write(root, 'unknown.speckdl', `${machine('A', 'n := 1')}
domain Billing { members: A; consumes Missing; }
`);
    expect(errorsOf(unknown).join('\n')).toMatch(/consumes Missing, which is not an event/);

    const emit = write(root, 'emit.speckdl', `${machine('A', 'emit Note { n: n }', 'event Note { n: Nat }')}
domain Billing { members: A; }
`);
    expect(errorsOf(emit).join('\n')).toMatch(/member A action Go emits Note, which Billing does not produce/);
    const out = join(root, 'emit-out');
    expect(() => compileSpec(emit, { outputDir: out, target: 'camel', bomFormat: 'both', verifyDepth: 4 })).toThrow(/does not produce/);
    expect(existsSync(out)).toBe(false);

    const hidden = write(root, 'if.speckdl', `${machine('A', 'if n > 0 { emit Hidden { n: n } }', 'event Hidden { n: Nat }')}
domain Billing { members: A; produces Note; event }
`.replace('event }', ''));
    writeFileSync(hidden, `${machine('A', 'if n > 0 { emit Hidden { n: n } }', 'event Hidden { n: Nat }\n    event Note { n: Nat }')}
domain Billing { members: A; produces Note; }
`);
    expect(errorsOf(hidden).join('\n')).toMatch(/emits Hidden, which Billing does not produce/);
  });

  it('accepts an external event, and rejects producing that same event', () => {
    const root = dir();
    const ok = write(root, 'ok.speckdl', `${machine('A', 'n := 1', 'event Tick external { price: Nat }')}
domain Billing { members: A; consumes Tick; }
`);
    expect(errorsOf(ok)).toEqual([]);

    const both = write(root, 'both.speckdl', `${machine('A', 'n := 1', 'event Tick external { price: Nat }')}
domain Billing { members: A; consumes Tick; produces Tick; }
`);
    expect(errorsOf(both).join('\n')).toMatch(/produces Tick, which is declared external/);
  });

  it('accepts a produces/consumes cycle and an event produced by an imported domain', () => {
    const root = dir();
    write(root, 'a.speckdl', `${machine('A', 'n := 1\n        emit E1 { n: n }', 'event E1 { n: Nat }\n    event E2 { n: Nat }')}
domain One { members: A; consumes E2; produces E1; }
`);
    const file = write(root, 'b.speckdl', `import "a.speckdl"
${machine('B', 'n := 1\n        emit E2 { n: n }', 'event E2 { n: Nat }')}
domain Two { members: B; consumes E1; produces E2; }
`);
    expect(errorsOf(file)).toEqual([]);
    const ir = load(file);
    expect(ir.domains!.map(d => d.name).sort()).toEqual(['One', 'Two']);
    // The library on its own still fails: E2 has no producer until the importer is compiled.
    expect(errorsOf(join(root, 'a.speckdl')).join('\n')).toMatch(/domain: One consumes E2, which no domain produces/);
  });

  it('rejects a member that already belongs to an imported domain when it emits outside produces', () => {
    const root = dir();
    write(root, 'a.speckdl', `${machine('A', 'emit Secret { n: n }', 'event Secret { n: Nat }')}
domain One { members: A; }
`);
    const file = write(root, 'b.speckdl', `import "a.speckdl"\n${machine('B', 'n := 1')}\ndomain Two { members: B; }\n`);
    expect(errorsOf(file).join('\n')).toMatch(/domain: One member A action Go emits Secret/);
  });

  it('lets a speck outside every domain emit, and doctor reports a broken contract', () => {
    const root = dir();
    const file = write(root, 'free.speckdl', `${machine('A', 'n := 1')}
${machine('B', 'emit Note { n: n }', 'event Note { n: Nat }')}
domain OnlyA { members: A; }
`);
    expect(errorsOf(file)).toEqual([]);
    const bad = write(root, 'doc.speckdl', `${machine('A', 'n := 1', 'event Note { n: Nat }')}
domain OnlyA { members: A; consumes Note; }
`);
    const result = doctorFile(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/consumes Note/);
  });

  it('rejects an event declared both external and internal, and two shapes of one consumed name', () => {
    const root = dir();
    const flags = write(root, 'flags.speckdl', `${machine('A', 'n := 1', 'event Tick external { n: Nat }')}
speck B {
    state { n: Nat }
    init { n := 0 }
    event Tick { n: Nat }
}
`);
    expect(errorsOf(flags).join('\n')).toMatch(/declared external and also as an internal event/);

    const shapes = write(root, 'shapes.speckdl', `speck A {
    state { n: Nat }
    init { n := 0 }
    event Tick { n: Nat }
}
speck B {
    state { n: Nat }
    init { n := 0 }
    event Tick { price: Nat }
}
domain D { members: A; consumes Tick; }
`);
    expect(errorsOf(shapes).join('\n')).toMatch(/event Tick is declared with different fields/);
  });
});

describe('contract edges', () => {
  it('rejects a domain that names the same member twice, before writing output', () => {
    const root = dir();
    const file = write(root, 'twice.speckdl', `${machine('A', 'n := 1')}
domain Billing { members: A, A; }
`);
    expect(errorsOf(file).join('\n')).toMatch(/domain: Billing lists A more than once/);
    const out = join(root, 'out');
    expect(() => compileSpec(file, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 2 })).toThrow(/lists A more than once/);
    expect(existsSync(out)).toBe(false);
  });

  it('allows produces to name an event no member emits', () => {
    const root = dir();
    const file = write(root, 'quiet.speckdl', `${machine('A', 'n := 1', 'event Note { n: Nat }')}
domain Billing { members: A; produces Note; }
`);
    expect(errorsOf(file)).toEqual([]);
  });
});

describe('provenance keeps a domain without a contract unchanged in shape', () => {
  it('omits empty consumes and produces', () => {
    const root = dir();
    const file = write(root, 'plain.speckdl', `${machine('A', 'n := 1')}
domain Billing { members: A; language: "plain"; }
`);
    const ir = load(file);
    const out = join(root, 'prov');
    mkdirSync(out, { recursive: true });
    generateProvenanceFromIR(ir, out);
    const prov = JSON.parse(readFileSync(join(out, 'A.prov.jsonld'), 'utf8'));
    const domain = prov['@graph'].find((n: { '@id'?: string }) => n['@id'] === 'domain:Billing');
    expect(domain['speckl:consumes']).toBeUndefined();
    expect(domain['speckl:produces']).toBeUndefined();
    expect(domain['speckl:budgetPerTick']).toBeUndefined();
    expect(domain['prov:hadMember']).toEqual(['speck:A']);
  });
});
