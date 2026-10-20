// Soundness of the AST Z3 backend (src/generators/z3.ts) against the real
// solver, run in-process.
//
// A verifier bug here is the worst kind: a wrong "proved". Each case pairs a
// spec where the property holds with a minimal change that breaks it, and
// checks the verdict the verifier would give (scripts/lib/obligations.mjs):
// proven, violated, or unchecked. Nothing that was not proven may count as a
// pass.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSpec } from '../compile.js';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { judge, accountObligations } from '../../scripts/lib/obligations.mjs';

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

interface Verdict {
  status: string;
  proven: string[];
  unchecked: string[];
  violated: string[];
}

/** Compile `src` with -t z3, run every emitted SMT file through z3, and account the obligations. */
function verify(name: string, src: string): Verdict {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-sound-'));
  const spec = join(dir, `${name}.speckdl`);
  writeFileSync(spec, src);
  const out = join(dir, 'out');
  compileSpec(spec, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 10 });
  const files = [];
  const violated: string[] = [];
  let status = 'OK';
  for (const f of [`${name}.smt2`, `${name}.ir.smt2`]) {
    const smt = readFileSync(join(out, f), 'utf-8');
    const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: smt, encoding: 'utf-8' });
    const v = judge(smt, r.stdout ?? '', r.stderr ?? '');
    if (v.status !== 'OK' && status === 'OK') status = v.status;
    for (const o of v.obligations) if (!o.ok && o.key) violated.push(o.key);
    files.push({ smt, obligations: v.obligations });
  }
  const acc = accountObligations(files);
  return { status, proven: acc.proven, unchecked: acc.unchecked.map((u: any) => u.key), violated };
}

const gate = (guard: string, prop = 'stage < 2 or approved', depth = 6) => `speck Gate {
    state {
        stage: Nat
        approved: Bool
    }
    init {
        stage := 0
        approved := false
    }
    invariant Safe {
        ${prop}
    }
    action Approve {
        require stage == 0
        approved := true
        stage := 1
    }
    action Ship {
        ${guard}
        stage := 2
    }
    next: Approve | Ship
    verify Always(Safe) {
        depth ${depth}
    }
}
`;

describe.skipIf(!hasZ3)('AST Z3 backend: proofs and counterexamples', () => {
  it('a guarded transition proves the invariant', () => {
    const v = verify('Gate', gate('require stage == 1'));
    expect(v.status).toBe('OK');
    expect(v.proven).toEqual(['Safe']);
    expect(v.unchecked).toEqual([]);
  }, 60_000);

  it('dropping the guard yields a counterexample, not a proof', () => {
    const v = verify('Gate', gate('require stage <= 1'));
    expect(v.status).toBe('VIOLATED');
    expect(v.violated).toContain('Safe');
    expect(v.proven).toEqual([]);
  }, 60_000);

  it('a violation reachable in one step is found even at depth 1', () => {
    const v = verify('Gate', gate('require stage <= 1', 'stage < 2 or approved', 1));
    expect(v.status).toBe('VIOLATED');
  }, 60_000);

  it('`not A or B` means (not A) or B', () => {
    // Holds: once shipped, it was approved.
    expect(verify('Gate', gate('require stage == 1', 'not (stage == 2) or approved')).status).toBe('OK');
    // Broken guard: shipping without approval must violate it.
    expect(verify('Gate', gate('require stage <= 1', 'not (stage == 2) or approved')).status).toBe('VIOLATED');
  }, 60_000);

  it('implies(P, Q) is directional', () => {
    expect(verify('Gate', gate('require stage == 1', 'implies(stage == 2, approved)')).status).toBe('OK');
    expect(verify('Gate', gate('require stage == 1', 'implies(approved, stage == 2)')).status).toBe('VIOLATED');
  }, 60_000);

  it('regression: infix `P implies Q` is never proved as just P', () => {
    // The typed expression parser stopped at `implies` and returned P, and
    // the Z3 backend then proved `stage >= 0`: a false "proved" for a
    // property Ship (stage := 2) breaks. Infix implies is now an operator, so
    // the property is checked as written and the counterexample is found.
    const v = verify('Gate', gate('require stage == 1', 'stage >= 0 implies stage < 2'));
    expect(v.proven).toEqual([]);
    expect(v.status).toBe('VIOLATED');
    expect(v.violated).toContain('Safe');
  }, 60_000);

  it('infix implies is directional, like implies(P, Q)', () => {
    expect(verify('Gate', gate('require stage == 1', 'stage == 2 implies approved')).status).toBe('OK');
    expect(verify('Gate', gate('require stage == 1', 'approved implies stage == 2')).status).toBe('VIOLATED');
  }, 60_000);

  it('a state variable named like an SMT keyword is renamed, and the proof still means something', () => {
    const src = (guard: string) => `speck Kw {
    state {
        exists: Nat
    }
    init {
        exists := 0
    }
    invariant Small {
        exists <= 3
    }
    action Inc {
        ${guard}
        exists := exists + 1
    }
    next: Inc
    verify Always(Small) {
        depth 6
    }
}
`;
    const ok = verify('Kw', src('require exists < 3'));
    expect(ok.status).toBe('OK');
    expect(ok.proven).toEqual(['Small']);
    expect(verify('Kw', src('require exists < 4')).status).toBe('VIOLATED');
  }, 60_000);
});

describe.skipIf(!hasZ3)('AST Z3 backend: what it cannot check is never a pass', () => {
  it('verify Always(X) for an undeclared invariant is unchecked', () => {
    const v = verify('Gate', gate('require stage == 1').replace('verify Always(Safe)', 'verify Always(Missing)'));
    expect(v.proven).toEqual([]);
    expect(v.unchecked).toContain('Missing');
  }, 60_000);

  it('a verify form the parser does not know fails the compile instead of vanishing', () => {
    // `verify Eventually(stage == 2) { ... }` used to be dropped silently:
    // no obligation, no unchecked marker, and verification passed.
    expect(() => verify('Gate', gate('require stage == 1').replace('verify Always(Safe)', 'verify Eventually(stage == 2)')))
      .toThrow(/unsupported verify form "verify Eventually\(stage == 2\) \{"/);
  });

  it('a quoted free-form verify block is unchecked, not proved', () => {
    const v = verify('Gate', gate('require stage == 1').replace('verify Always(Safe) {\n        depth 6\n    }', 'verify "ships" { Eventually(stage == 2) }'));
    expect(v.proven).toEqual([]);
    expect(v.unchecked).toEqual(['ships']);
  }, 60_000);

  it('an English-language constraint is skipped with a warning and proves nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-sound-'));
    const spec = join(dir, 'Eng.speckdl');
    writeFileSync(spec, gate('require stage == 1').replace('    next:', '    constraint Unique: ids must be unique\n    next:'));
    const out = join(dir, 'out');
    compileSpec(spec, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 10 });
    const smt = readFileSync(join(out, 'Gate.smt2'), 'utf-8');
    expect(smt).toContain('; WARNING: English-language constraint skipped: ids must be unique');
    expect(smt).not.toMatch(/speckl-obligation: Unique/);
  });
});

describe('whole-expression parsing for the Z3 typed path', () => {
  it('leftover input is a parse failure, not a shorter expression', async () => {
    const { parseExpression, parseExpressionComplete } = await import('../expr/index.js');
    const { parseStringToIRExpr } = await import('../ir/lower.js');
    // The lenient parser still stops early (other callers rely on it)...
    expect(parseExpression('totalDelay <= 30s')).toEqual(parseExpression('totalDelay <= 30'));
    // ...the strict one refuses, and the Z3 entry point reports a failure
    // that carries the source text.
    expect(() => parseExpressionComplete('totalDelay <= 30s')).toThrow(/trailing input/);
    expect(parseStringToIRExpr('totalDelay <= 30s')).toMatchObject({ parseFailed: true, source: 'totalDelay <= 30s' });
    expect(parseExpressionComplete('stage < 2 or approved')).toEqual(parseExpression('stage < 2 or approved'));
  });

  it('infix implies lowers to the same IR as the call form', async () => {
    const { parseStringToIRExpr } = await import('../ir/lower.js');
    expect(parseStringToIRExpr('stage >= 0 implies stage < 2'))
      .toEqual(parseStringToIRExpr('implies(stage >= 0, stage < 2)'));
  });
});
