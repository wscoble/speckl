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
import { generateDomainBudgets, sealBudgetSmt } from '../generators/z3-budget.js';
import { injectSignalActions } from '../generators/agent/inject-signals.js';
// @ts-expect-error untyped helper shared with the verifier
import { judge, accountObligations } from '../../scripts/lib/obligations.mjs';

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
    const domain = ast.domains[0];
    expect(domain.consumes).toEqual(['PaymentReceived']);
    expect(domain.produces).toEqual(['InvoiceIssued', 'Receipt']);
    expect(domain.budgetPerTick).toBe(0);
    const again = parseSpeckContent(printAST(ast));
    expect(again.domains.map(d => ({
      name: d.name, members: d.members, language: d.language,
      consumes: d.consumes, produces: d.produces, budgetPerTick: d.budgetPerTick,
    }))).toEqual(ast.domains.map(d => ({
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
    expect(ir.domains.map(d => d.name).sort()).toEqual(['One', 'Two']);
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

describe('budget obligation', () => {
  function budgetFile(out: string, name: string): string {
    return readFileSync(join(out, `${name}.budget.smt2`), 'utf8');
  }

  it('proves an in-budget tick and records the obligation on the IR backend as unchecked', () => {
    const root = dir();
    const file = write(root, 'Under.speckdl', `${machine('Meter', 'cost 3\n        require n < 2\n        n := n + 1')}
domain Books { members: Meter; budget 3 per tick; }
`);
    const out = compile(file, 'z3', 4);
    const smt = budgetFile(out, 'Books');
    expect(smt).toMatch(/speckl-obligation: Books\.budget/);
    expect(smt).toMatch(/speckl-expect: unsat/);
    expect(smt).not.toMatch(/\(throttle|circuitBreaker/);
    const ir = readFileSync(join(out, 'Books.budget.ir.smt2'), 'utf8');
    expect(ir).toMatch(/speckl-unchecked: Books\.budget: IR backend does not unroll/);
    expect(ir).not.toMatch(/\(check-sat/);
    if (!hasZ3) return;
    const { verdict } = runZ3(smt);
    expect(verdict.status).toBe('OK');
    expect(verdict.obligations[0].got).toBe('unsat');
    const files = readdirSync(out).filter(f => f.endsWith('.smt2')).map(f => {
      const text = readFileSync(join(out, f), 'utf8');
      const judged = text.includes('(check-sat') ? judge(text, spawnSync('z3', ['-smt2', '-in', '-T:20'], { input: text, encoding: 'utf-8' }).stdout ?? '', '') : { obligations: [] };
      return { smt: text, obligations: judged.obligations };
    });
    const acc = accountObligations(files);
    expect(acc.proven).toContain('Books.budget');
    expect(acc.unchecked.map((u: { key: string }) => u.key)).not.toContain('Books.budget');
  });

  it('fails an over-budget tick with a model that names the tick cost', () => {
    if (!hasZ3) return;
    const root = dir();
    const file = write(root, 'Over.speckdl', `${machine('Meter', 'cost 4\n        n := n + 1')}
domain Books { members: Meter; budget 3 per tick; }
`);
    const smt = budgetFile(compile(file, 'z3', 3), 'Books');
    const { verdict, model } = runZ3(smt);
    expect(verdict.status).toBe('VIOLATED');
    expect(verdict.obligations[0].expect).toBe('unsat');
    expect(verdict.obligations[0].got).toBe('sat');
    expect(model).toMatch(/tick_cost/);
    expect(model).toMatch(/Meter_choice/);
  });

  it('treats cost 0 as a real cost, and a budget with no costs as unchecked', () => {
    if (!hasZ3) return;
    const root = dir();
    const zero = write(root, 'Zero.speckdl', `${machine('Meter', 'cost 0\n        n := n')}
domain Books { members: Meter; budget 0 per tick; }
`);
    const proved = runZ3(budgetFile(compile(zero, 'z3', 2), 'Books'));
    expect(proved.verdict.obligations[0].got).toBe('unsat');

    const bare = write(root, 'Bare.speckdl', `${machine('Meter', 'n := n + 1')}
domain Books { members: Meter; budget 10 per tick; }
`);
    const text = budgetFile(compile(bare, 'z3', 2), 'Books');
    expect(text).toMatch(/speckl-unchecked: Books\.budget: action Meter\.Go has no cost/);
    expect(text).not.toMatch(/\(check-sat/);
    const ir = load(bare);
    expect(ir.domains[0].budgetPerTick).toBe(10);
    expect(ir.specks[0].facets.behavior.actions[0].cost).toBeUndefined();
  });

  it('sums members, ignores an action that is not in next, and ignores a guard that is never enabled', () => {
    if (!hasZ3) return;
    const root = dir();
    const summed = write(root, 'Sum.speckdl', `
${machine('A', 'cost 6\n        n := n')}
${machine('B', 'cost 6\n        n := n')}
domain Books { members: A, B; budget 10 per tick; }
`);
    expect(runZ3(budgetFile(compile(summed, 'z3', 2), 'Books')).verdict.obligations[0].got).toBe('sat');

    const each = write(root, 'Each.speckdl', `
${machine('A', 'cost 6\n        n := n')}
domain Books { members: A; budget 10 per tick; }
`);
    expect(runZ3(budgetFile(compile(each, 'z3', 2), 'Books')).verdict.obligations[0].got).toBe('unsat');

    const parked = write(root, 'Parked.speckdl', `speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Cheap {
        cost 1
        n := n
    }
    action Dear {
        cost 100
        n := n
    }
    next: Cheap
}
domain Books { members: Meter; budget 5 per tick; }
`);
    expect(runZ3(budgetFile(compile(parked, 'z3', 2), 'Books')).verdict.obligations[0].got).toBe('unsat');

    const asleep = write(root, 'Asleep.speckdl', `${machine('Meter', 'cost 100\n        require n < 0\n        n := n')}
domain Books { members: Meter; budget 1 per tick; }
`);
    expect(runZ3(budgetFile(compile(asleep, 'z3', 3), 'Books')).verdict.obligations[0].got).toBe('unsat');
  });

  it('does not prove a cost that is only enabled past the BMC depth', () => {
    if (!hasZ3) return;
    const root = dir();
    const src = `speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Inc {
        cost 1
        require n < 3
        n := n + 1
    }
    action Boom {
        cost 100
        require n >= 3
        n := n
    }
    next: Inc | Boom
}
domain Books { members: Meter; budget 10 per tick; }
`;
    const file = write(root, 'Depth.speckdl', src);
    expect(runZ3(budgetFile(compile(file, 'z3', 1), 'Books')).verdict.obligations[0].got).toBe('unsat');
    expect(runZ3(budgetFile(compile(file, 'z3', 4), 'Books')).verdict.obligations[0].got).toBe('sat');
  });

  it('is unchecked without next, with a string state, with an if, and for a synthetic signal action', () => {
    const root = dir();
    const noNext = write(root, 'NoNext.speckdl', `speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 1
        n := n
    }
}
domain Books { members: Meter; budget 1 per tick; }
`);
    expect(budgetFile(compile(noNext), 'Books')).toMatch(/no next relation/);

    const str = write(root, 'Str.speckdl', `speck Meter {
    state { label: String }
    init { label := "a" }
    action Go {
        cost 1
        label := "b"
    }
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`);
    expect(budgetFile(compile(str), 'Books')).toMatch(/sort the budget check does not lower/);

    const branched = write(root, 'If.speckdl', `${machine('Meter', 'cost 1\n        if n > 0 { n := 1 }')}
domain Books { members: Meter; budget 1 per tick; }
`);
    expect(budgetFile(compile(branched), 'Books')).toMatch(/cannot lower/);

    const agent = write(root, 'Agent.speckdl', `speck Mini {
    state { stage: Nat }
    init { stage := 0 }
    action Go {
        cost 1
        require stage == 0
        stage := 1
    }
    action Peek {
        cost 0
        return true
    }
    agent {
        stages stage {
            Idle = 0
            AwaitingReview = 1
            Approved = 2
            Rejected = 3
        }
        tool go -> Go effect act
        tool peek -> Peek effect observe
        await AwaitingReview {
            signal review
            mode near
            require outcome in { approve, reject! }
            require claims { reviewer: String }
            on approve -> Approved
            on reject -> Rejected
            timeout 24h -> reject
        }
    }
    next: Go | Peek
}
domain Ops { members: Mini; budget 5 per tick; }
`);
    const text = budgetFile(compile(agent), 'Ops');
    expect(text).toMatch(/speckl-unchecked: Ops\.budget: action Mini\.__signal_/);
    const ast = injectSignalActions(parseSpeckFile(agent));
    const names = ast.specks[0].members.filter(m => m.type === 'action').map(m => m.type === 'action' ? m.name : '');
    expect(names.some(n => n.startsWith('__signal_'))).toBe(true);
  });

  it('turns a dropped SMT form into an unchecked marker', () => {
    const text = sealBudgetSmt('(assert (not_a_real_function 1))\n; speckl-expect: unsat\n(check-sat)\n', 'Books.budget');
    expect(text).toMatch(/speckl-unchecked: Books\.budget:/);
    expect(text).not.toMatch(/\(check-sat/);
  });

  it('proves a budget declared on an imported domain', () => {
    if (!hasZ3) return;
    const root = dir();
    write(root, 'lib.speckdl', `${machine('Meter', 'cost 1\n        n := n + 1')}
domain Books { members: Meter; budget 5 per tick; }
`);
    const file = write(root, 'root.speckdl', 'import "lib.speckdl"\n');
    const smt = budgetFile(compile(file, 'z3', 2), 'Books');
    expect(runZ3(smt).verdict.obligations[0].got).toBe('unsat');
  });
});

describe('adversarial contracts and budgets', () => {
  function reason(src: string, domain = 'Books'): string {
    const root = dir();
    const file = write(root, 'c.speckdl', src);
    return readFileSync(join(compile(file), `${domain}.budget.smt2`), 'utf8');
  }

  it('rejects budgets the tick encoding cannot lower, and keeps a clean SMT file', () => {
    const head = `speck Meter {
    state { n: Nat }
    init { n := 0 }
`;
    const tail = `
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`;
    expect(reason(`${head}    action Go(n: Nat) {\n        cost 1\n        n := 1\n    }${tail}`)).toMatch(/parameter n collides with a state variable/);
    expect(reason(`${head}    action Go(s: String) {\n        cost 1\n        n := n\n    }${tail}`)).toMatch(/parameter s has a sort the budget check does not lower/);
    expect(reason(`speck Meter {
    state { n: Nat }
    init { n := 0 }
    action A(x: Nat) {
        cost 1
        n := n
    }
    action B(x: Bool) {
        cost 1
        n := n
    }
    next: A | B
}
domain Books { members: Meter; budget 4 per tick; }
`)).toMatch(/does not match an earlier parameter/);
    expect(reason(`${head}    action Go {\n        cost 1\n        missing := 1\n    }${tail}`)).toMatch(/assignment to missing cannot be lowered/);
    expect(reason(`${head}    action Go {\n        cost 1\n        n := 1\n        n := 2\n    }${tail}`)).toMatch(/assigns n more than once/);
    expect(reason(`${head}    action Go {\n        cost 1\n        let x := 1\n    }${tail}`)).toMatch(/cannot lower/);
    expect(reason(`${head}    action Go {\n        cost 1\n        require n == "a"\n        n := n\n    }${tail}`)).toMatch(/guard of Meter.Go cannot be lowered/);
    expect(reason(`${head}    action Go {\n        cost 1\n        n := n.foo\n    }${tail}`)).toMatch(/assignment in Meter.Go cannot be lowered/);
    expect(reason(`${head}    action Go {\n        cost 1\n        for v in n { n := 1 }\n    }${tail}`)).toMatch(/cannot lower/);
    expect(reason(`speck Meter {
    state { n: Nat | null }
    init { n := 0 }
    action Go {
        cost 1
        n := n
    }
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`)).toMatch(/sort the budget check does not lower/);
    expect(reason(`speck Meter {
    state { n: Nat }
    init { missing := 1 }
    action Go {
        cost 1
        n := n
    }
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`)).toMatch(/init of Meter.missing is not a state variable/);
    expect(() => reason(`speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 1
        n := n
    }
    next: Missing
}
domain Books { members: Meter; budget 1 per tick; }
`)).toThrow(/unknown action/);

    const kept = sealBudgetSmt('; speckl-expect: unsat\n(check-sat)\n', 'Books.budget');
    expect(kept).toMatch(/\(check-sat\)/);
    expect(kept).not.toMatch(/speckl-unchecked/);
  });

  it('proves a Bool state, a Nat with no init, and an empty member list', () => {
    if (!hasZ3) return;
    const root = dir();
    const boolFile = write(root, 'Bool.speckdl', `speck Meter {
    state { flag: Bool }
    init { flag := false }
    action Go {
        cost 1
        flag := true
    }
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`);
    expect(runZ3(readFileSync(join(compile(boolFile, 'z3', 2), 'Books.budget.smt2'), 'utf8')).verdict.obligations[0].got).toBe('unsat');

    const bare = write(root, 'BareNat.speckdl', `speck Meter {
    state { n: Nat }
    action Go {
        cost 1
        n := n
    }
    next: Go
}
domain Books { members: Meter; budget 1 per tick; }
`);
    const bareSmt = readFileSync(join(compile(bare, 'z3', 2), 'Books.budget.smt2'), 'utf8');
    expect(bareSmt).toMatch(/>= Meter__n_0 0/);
    expect(runZ3(bareSmt).verdict.obligations[0].got).toBe('unsat');

    const real = write(root, 'Real.speckdl', `speck Meter {
    state { r: Real }
    init { r := 1 }
    action Go {
        cost 2
        r := r
    }
    next: Go
}
domain Books { members: Meter; budget 2 per tick; }
`);
    expect(runZ3(readFileSync(join(compile(real, 'z3', 2), 'Books.budget.smt2'), 'utf8')).verdict.obligations[0].got).toBe('unsat');

    const out = join(root, 'direct');
    mkdirSync(out);
    const emptyAst = { specks: [], imports: [], domains: [] };
    generateDomainBudgets(emptyAst, [{
      name: 'Empty', members: [], consumes: [], produces: [], budgetPerTick: 0, sourcePath: 'x',
    }], out, 0);
    const emptySmt = readFileSync(join(out, 'Empty.budget.smt2'), 'utf8');
    expect(emptySmt).toMatch(/Bounded model checking depth: 1/);
    expect(runZ3(emptySmt).verdict.obligations[0].got).toBe('unsat');

    generateDomainBudgets(emptyAst, [{
      name: 'Bad', members: ['Missing'], consumes: [], produces: [], budgetPerTick: -1, sourcePath: 'x',
    }], out, 2);
    expect(readFileSync(join(out, 'Bad.budget.smt2'), 'utf8')).toMatch(/budget is not a non-negative integer/);

    const ast = parseSpeckContent(`speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 1
        n := n
    }
    next: Go
}
`);
    const action = ast.specks[0].members.find(m => m.type === 'action');
    if (action && action.type === 'action') action.statements.push({ type: 'cost', amount: 3 });
    generateDomainBudgets(ast, [{
      name: 'Books', members: ['Meter'], consumes: [], produces: [], budgetPerTick: 1, sourcePath: 'x',
    }], out, 2);
    expect(readFileSync(join(out, 'Books.budget.smt2'), 'utf8')).toMatch(/declares cost more than once/);
    generateDomainBudgets(ast, [{
      name: 'Gone', members: ['Nope'], consumes: [], produces: [], budgetPerTick: 1, sourcePath: 'x',
    }], out, 2);
    expect(readFileSync(join(out, 'Gone.budget.smt2'), 'utf8')).toMatch(/member Nope is not in this compilation/);
    const missingNext = parseSpeckContent(`speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 1
        n := n
    }
    next: Missing
}
`);
    generateDomainBudgets(missingNext, [{
      name: 'Books', members: ['Meter'], consumes: [], produces: [], budgetPerTick: 1, sourcePath: 'x',
    }], out, 2);
    expect(readFileSync(join(out, 'Books.budget.smt2'), 'utf8')).toMatch(/unknown action/);
  });

  it('compares list and nullable event shapes, and copies a foreign event into the Camel unit', () => {
    const root = dir();
    const clash = write(root, 'clash.speckdl', `speck A {
    state { n: Nat }
    init { n := 0 }
    event Tick { xs: List<Nat> }
}
speck B {
    state { n: Nat }
    init { n := 0 }
    event Tick { xs: List<Bool> }
}
domain D { members: A; consumes Tick; }
`);
    expect(errorsOf(clash).join('\n')).toMatch(/event Tick is declared with different fields/);

    const same = write(root, 'same.speckdl', `speck A {
    state { n: Nat }
    init { n := 0 }
    event Tick { xs: List<Nat> | null }
}
speck B {
    state { n: Nat }
    init { n := 0 }
    event Tick { xs: List<Nat> | null, ys: Map<Nat, Bool> }
}
domain D { members: A; consumes Tick; }
`);
    const sameErrors = errorsOf(same).join('\n');
    expect(sameErrors).toMatch(/different fields/);
    expect(sameErrors).toMatch(/no domain produces/);

    const file = write(root, 'foreign.speckdl', `speck Other {
    state { n: Nat }
    init { n := 0 }
    event Note { n: Nat }
}
speck Book {
    state { n: Nat }
    init { n := 0 }
    action Go {
        cost 1
        n := n
        emit Note { n: n }
    }
    next: Go
}
domain Trading {
    members: Book;
    produces Note;
    budget 3 per tick;
}
`);
    expect(errorsOf(file)).toEqual([]);
    const out = compile(file, 'camel');
    const files = readdirSync(join(out, 'camel'), { recursive: true }).map(String);
    const note = files.find(f => f.endsWith('Note.java'));
    const contract = files.find(f => f.endsWith('TradingContract.java'));
    expect(note).toBeTruthy();
    const noteSrc = readFileSync(join(out, 'camel', note!), 'utf8');
    expect(noteSrc).toContain('public class Note');
    expect(noteSrc).toContain('Speckl domain contract: Trading');
    expect(noteSrc).toContain('Book.Go = 1');
    expect(readFileSync(join(out, 'camel', contract!), 'utf8')).toContain('consumes: none');
    const routes = readFileSync(join(out, 'camel', files.find(f => f.endsWith('BookRoutes.java'))!), 'utf8');
    expect(routes).not.toMatch(/throttle|circuitBreaker/);
  });
});

describe('Camel contract output', () => {
  it('emits a comment block and a typed event class, and does not throttle', () => {
    const root = dir();
    const file = write(root, 'book.speckdl', readFileSync(join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'DomainContract.speckdl'), 'utf8'));
    const out = compile(file, 'camel');
    const javaRoot = join(out, 'camel');
    const files = readdirSync(javaRoot, { recursive: true }).map(String);
    const event = files.find(f => f.endsWith('Filled.java'));
    const external = files.find(f => f.endsWith('MarketTick.java'));
    const contract = files.find(f => f.endsWith('TradingContract.java'));
    expect(event).toBeTruthy();
    expect(external).toBeTruthy();
    expect(contract).toBeTruthy();
    const eventSrc = readFileSync(join(javaRoot, event!), 'utf8');
    const tickSrc = readFileSync(join(javaRoot, external!), 'utf8');
    const contractSrc = readFileSync(join(javaRoot, contract!), 'utf8');
    for (const src of [eventSrc, tickSrc, contractSrc]) {
      expect(src).toContain('Speckl domain contract: Trading');
      expect(src).toContain('does not');
      expect(src).toContain('not affiliated with the Apache Software Foundation');
      expect(src).toContain('consumes: MarketTick (external)');
      expect(src).toContain('produces: Filled');
      expect(src).toContain('budget: 5 per tick');
    }
    expect(eventSrc).toContain('public class Filled');
    expect(eventSrc).toContain('getQty');
    expect(tickSrc).toContain('public class MarketTick');
    expect(tickSrc).toContain('getPrice');
    const routes = readFileSync(join(javaRoot, files.find(f => f.endsWith('Routes.java'))!), 'utf8');
    expect(routes).not.toMatch(/throttle|circuitBreaker|CircuitBreaker/);
    expect(routes).not.toContain('budget');
    const provDir = out;
    const prov = readFileSync(join(provDir, 'Book.prov.jsonld'), 'utf8');
    expect(prov).toContain('"speckl:consumes"');
    expect(prov).toContain('MarketTick');
    expect(prov).toContain('"speckl:budgetPerTick": 5');
  });
});

describe('verifier counterexample trace', () => {
  it('prints a counterexample for an over-budget spec and UNCHECKED for a budget with no costs', () => {
    if (!hasZ3) return;
    const root = dir();
    mkdirSync(root, { recursive: true });
    write(root, 'Over.speckdl', `${machine('Meter', 'cost 4\n        n := n + 1')}
domain Books { members: Meter; budget 3 per tick; }
`);
    write(root, 'Under.speckdl', `${machine('Meter', 'cost 1\n        n := n + 1')}
domain Books { members: Meter; budget 5 per tick; }
`);
    write(root, 'NoCost.speckdl', `${machine('Meter', 'n := n + 1')}
domain Books { members: Meter; budget 5 per tick; }
`);
    const wrapper = join(root, 'speckl-bin.mjs');
    writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, [${JSON.stringify(viteNode)}, ${JSON.stringify(indexTs)}, ...process.argv.slice(2)], { encoding: 'utf-8', cwd: ${JSON.stringify(compilerDir)} });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 1);
`);
    const res = spawnSync(process.execPath, [verifyScript, root, '--depth', '4'], {
      encoding: 'utf-8',
      env: { ...process.env, SPECKL_BIN: wrapper },
    });
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(res.status, out).toBe(1);
    expect(out).toMatch(/Over\.speckdl \[ast\].*VIOLATED/);
    expect(out).toMatch(/counterexample state trace/);
    expect(out).toMatch(/tick_cost=/);
    expect(out).toMatch(/Under\.speckdl \[ast\].*unsat/);
    expect(out).toMatch(/NoCost\.speckdl · Books\.budget: UNCHECKED/);
    expect(out).not.toMatch(/NoCost\.speckdl.*Books\.budget: unsat/);
  }, 180_000);
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
