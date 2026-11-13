// Priority labels and kpi tags on the token parser.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { parseActionStatements } from '../expr/stmt-parser.js';
import { generateDomainBudgets } from '../generators/z3-budget.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';

const SPEC = `speck Trace {
    state {
        stage: Nat
        n: Nat
    }
    init {
        stage := 0
        n := 0
    }
    action Note {
        priority P0
        n := n + 1
        emit Noted { }
        if n == 1 {
            emit Extra { }
        }
    }
    action Ship {
        n := n + 1
        emit Shipped { }
    }
    action Look {
        return true
    }
    event Noted kpi "notes" { }
    event Extra kpi "extra" { }
    event Shipped kpi "shipments" { }
    next: Note | Ship | Look
}
domain Work {
    members: Trace;
    produces Noted, Extra, Shipped;
    priority P1;
}
`;

describe('priority and kpi syntax', () => {
  it('round-trips an action priority, a domain priority, and a kpi tag', () => {
    const ast = parseSpeckContent(SPEC);
    const again = parseSpeckContent(printAST(ast));
    const note = again.specks[0].members.find(m => m.type === 'action' && m.name === 'Note');
    expect(note && note.type === 'action' && note.statements.some(s => s.type === 'priority' && s.name === 'P0')).toBe(true);
    expect(again.domains![0].priority).toBe('P1');
    const noted = again.specks[0].members.find(m => m.type === 'event' && m.name === 'Noted');
    expect(noted && noted.type === 'event' && noted.kpi).toBe('notes');
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-signal-src-')), 't.speckdl');
    writeFileSync(file, SPEC);
    const ir = lower(parseSpeckContent(SPEC, file), { filePath: file, resolveImports: false });
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const action = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Note');
    expect(action?.priority).toBe('P0');
    expect(action?.statements.some(s => s.kind === 'emit' && s.event === 'Noted')).toBe(true);
    expect(ir.specks[0].facets.behavior.events.find(e => e.name === 'Shipped')?.kpi).toBe('shipments');
    expect(ir.domains![0].priority).toBe('P1');
    const provDir = join(path.dirname(file), 'prov');
    mkdirSync(provDir);
    generateProvenanceFromIR(ir, provDir);
    const prov = readFileSync(join(provDir, 'Trace.prov.jsonld'), 'utf8');
    expect(prov).toContain('"speckl:kpi": "notes"');
    expect(prov).toContain('"speckl:priority": "P1"');
  });

  it('rejects a domain priority that is not an identifier', () => {
    expect(() => parseSpeckContent('domain D { members: A; priority; }')).toThrow(/priority must be an identifier/);
    expect(() => parseSpeckContent('domain D { members: A; priority 1; }')).toThrow(/priority must be an identifier/);
  });

  it('rejects a domain priority declared twice', () => {
    expect(() => parseSpeckContent('domain D { members: A; priority P0; priority P1; }')).toThrow(/priority twice/);
  });

  it('rejects an action priority that is not an identifier', () => {
    expect(() => parseSpeckContent('speck S {\n    action Go {\n        priority\n    }\n}\n')).toThrow(/priority must be an identifier/);
    expect(() => parseActionStatements(['priority 1'])).toThrow(/identifier/);
  });

  it('rejects an action priority declared more than once', () => {
    expect(() => parseSpeckContent('speck S {\n    action Go {\n        priority P0\n        priority P1\n    }\n}\n')).toThrow(/priority more than once/);
    expect(() => parseActionStatements(['priority P0', 'priority P1'])).toThrow(/more than once/);
  });

  it('keeps priority := as an assignment', () => {
    expect(parseSpeckContent('speck S {\n    action Go {\n        priority := 1\n    }\n}\n').specks[0].members.find(m => m.type === 'action')).toMatchObject({
      statements: [{ type: 'assign', target: 'priority' }],
    });
  });

  it('rejects a kpi that is not a string', () => {
    expect(() => parseSpeckContent('speck S {\n    event E kpi "" { }\n}\n')).toThrow(/Failed to parse event/);
    expect(() => parseSpeckContent('speck S {\n    event E kpi notes { }\n}\n')).toThrow(/Failed to parse event/);
  });

  it('keeps the next speck when a brace sits in a // comment', () => {
    const src = `speck A {
    action Go {
        priority P0 // hot path {
        n := n + 1
    }
    event E kpi "x" { } // {
}
speck B {
    event F { }
}
`;
    const ast = parseSpeckContent(src);
    expect(ast.specks.map(s => s.name)).toEqual(['A', 'B']);
    const go = ast.specks[0].members.find(m => m.type === 'action' && m.name === 'Go');
    expect(go && go.type === 'action' && go.statements.some(s => s.type === 'priority' && s.name === 'P0')).toBe(true);
    const ev = ast.specks[0].members.find(m => m.type === 'event' && m.name === 'E');
    expect(ev && ev.type === 'event' && ev.kpi).toBe('x');
    const f = ast.specks[1].members.find(m => m.type === 'event' && m.name === 'F');
    expect(f && f.type === 'event').toBe(true);
  });

  it('keeps both specks when a kpi string contains a brace', () => {
    const src = `speck A {
    event E kpi "a{b" { }
}
speck B {
    event F kpi "a}b" { }
}
`;
    const ast = parseSpeckContent(src);
    expect(ast.specks.map(s => s.name)).toEqual(['A', 'B']);
    const e = ast.specks[0].members.find(m => m.type === 'event');
    const f = ast.specks[1].members.find(m => m.type === 'event');
    expect(e && e.type === 'event' && e.kpi).toBe('a{b');
    expect(f && f.type === 'event' && f.kpi).toBe('a}b');
  });

  it('rejects two kpi tags for one event name', () => {
    const src = `speck A {\n    event E kpi "one" { }\n}\nspeck B {\n    event E kpi "two" { }\n}\n`;
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-kpi-')), 'k.speckdl');
    writeFileSync(file, src);
    const msgs = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false }).diagnostics.map(d => d.message);
    expect(msgs.join('\n')).toMatch(/event E kpi differs/);
  });

  it('a priority label does not make a budget obligation unlowerable', () => {
    const src = `speck Meter {
    state { n: Nat }
    init { n := 0 }
    action Add {
        priority P0
        cost 1
        n := n + 1
    }
    next: Add
}
domain Books { members: Meter; budget 5 per tick; }
`;
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-pri-budget-')), 'm.speckdl');
    writeFileSync(file, src);
    const ast = parseSpeckContent(src, file);
    const ir = lower(ast, { filePath: file, resolveImports: false });
    const out = join(path.dirname(file), 'out');
    mkdirSync(out);
    generateDomainBudgets(ast, ir.domains ?? [], out, 4);
    const smt = readFileSync(join(out, 'Books.budget.smt2'), 'utf8');
    expect(smt).not.toMatch(/cannot be lowered/);
    expect(smt).toContain('speckl-expect: unsat');
  });

  it('does not copy labels onto tools or enforce a queue', () => {
    const src = readFileSync(new URL('../ir/lower.ts', import.meta.url), 'utf8') + readFileSync(new URL('../printer.ts', import.meta.url), 'utf8');
    expect(/orderByPriority|planRoutes|runTick/.test(src)).toBe(false);
  });
});
