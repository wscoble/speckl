// Regression + coverage for the `next:` transition relation.
//
// Bug: `next:` was scraped from raw source by the Z3 backend, ending only at
// `verify:` or a new speck. With a single alternative followed by a
// `verify Always(...) { ... }` block, the whole tail became one bogus action
// name, was filtered out, and BMC unrolled only stuttering steps, so every
// `Always` obligation was reported as proven (unsat) when it was not.
// Multi-alternative relations silently lost their last alternative the same way.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { printAST } from '../printer.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SINGLE = `speck Counter {
    state {
        x: Nat
    }

    init {
        x := 0
    }

    invariant StaysZero {
        x <= 0
    }

    action Inc {
        require x < 5
        x := x + 1
    }

    next: Inc

    verify Always(StaysZero) {
        depth 3
    }
}
`;

function compileZ3(src: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-next-'));
  try {
    const file = join(dir, `${name}.speckdl`);
    writeFileSync(file, src);
    const r = spawnSync(process.execPath, [join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs'),
      join(compilerDir, 'src', 'index.ts'), file, '-t', 'z3', '-o', join(dir, 'out')],
      { cwd: compilerDir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
    return readFileSync(join(dir, 'out', `${name}.smt2`), 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lowerSrc(src: string) {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-next-ir-'));
  const filePath = join(dir, 'spec.speckdl');
  writeFileSync(filePath, src);
  try {
    return lower(parseSpeckContent(src, filePath), { filePath, resolveImports: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

describe('next: single-action relation (false-proof regression)', () => {
  it('unrolls the single action in every BMC step', () => {
    const smt = compileZ3(SINGLE, 'Counter');
    expect(smt).toContain('; Next transition relation: Inc');
    expect(smt.match(/; Action: Inc/g)?.length).toBe(3);
  }, 60_000);

  it.skipIf(!hasZ3)('z3 finds the counterexample instead of a vacuous proof', () => {
    const smt = compileZ3(SINGLE, 'Counter').replace(/\(get-model\)/g, '');
    const r = spawnSync('z3', ['-smt2', '-in'], { input: smt, encoding: 'utf-8' });
    expect(r.stdout.trim().split('\n').filter(l => /^(un)?sat$/.test(l))).toEqual(['sat']);
  }, 60_000);

  it('keeps the last alternative of a multi-line relation followed by comments and verify', () => {
    const src = SINGLE.replace('next: Inc', `action Reset {
        require x > 0
        x := 0
    }

    next:
        Inc
        | Reset   // trailing comment

    // --- checks ---`).replace('speck Counter', 'speck Counter2');
    const smt = compileZ3(src, 'Counter2');
    expect(smt).toContain('; Next transition relation: Inc | Reset');
  }, 60_000);

  it('rejects next: names that are not declared actions', () => {
    expect(() => compileZ3(SINGLE.replace('next: Inc', 'next: Inc | Missing'), 'Counter')).toThrow(/unknown action\(s\): Missing/);
  }, 60_000);
});

describe('next: in the AST and IR', () => {
  it('parses single, multi-line, and trailing-pipe forms', () => {
    const forms: [string, string[]][] = [
      ['next: A', ['A']],
      ['next: A | B', ['A', 'B']],
      ['next:\n  A\n  | B\n  | C', ['A', 'B', 'C']],
      ['next: A |\n  B', ['A', 'B']],
    ];
    for (const [rel, expected] of forms) {
      const ast = parseSpeckContent(`speck S {\n  action A { require true }\n  ${rel}\n  verify Always(I) { depth 2 }\n}\n`);
      const next = ast.specks[0].members.find(m => m.type === 'next');
      expect(next && next.type === 'next' && next.actions).toEqual(expected);
    }
  });

  it('parses the empty block form as any action', () => {
    const ir = lowerSrc(`speck S {\n  action A { require true }\n  action B { require true }\n  next: {\n    // any action\n  }\n}\n`);
    expect(ir.specks[0].facets.behavior.next).toEqual(['A', 'B']);
  });

  it('rejects junk alternatives at parse time', () => {
    expect(() => parseSpeckContent(`speck S {\n  next: A B\n}\n`)).toThrow(/not an action name/);
  });

  it('lowers next into behavior.next and flags unknown names', () => {
    const ir = lowerSrc(SINGLE.replace('next: Inc', 'next: Inc | Nope'));
    expect(ir.specks[0].facets.behavior.next).toEqual(['Inc', 'Nope']);
    expect(ir.diagnostics.some(d => d.level === 'error' && /unknown action "Nope"/.test(d.message))).toBe(true);
  });

  it('omits behavior.next when no relation is declared', () => {
    const ir = lowerSrc(SINGLE.replace('next: Inc', ''));
    expect('next' in ir.specks[0].facets.behavior).toBe(false);
  });

  it('round-trips through the printer', () => {
    const ast = parseSpeckContent(SINGLE);
    const reparsed = parseSpeckContent(printAST(ast));
    const next = reparsed.specks[0].members.find(m => m.type === 'next');
    expect(next && next.type === 'next' && next.actions).toEqual(['Inc']);
  });
});
