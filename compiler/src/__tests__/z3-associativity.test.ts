// Associativity of arithmetic in the AST Z3 backend's legacy string
// translator (used for quantified invariants, `let` sugar and post-state
// invariants, and as the fallback when the typed parser cannot read an
// expression).
//
// It split every binary operator at its FIRST top-level occurrence, which
// is right-associative: `stage - 1 - 1` became (- stage (- 1 1)), i.e.
// `stage`, so the false invariant `stage - 1 - 1 == stage` was "proved".
// Subtraction and the multiplicative operators are now left-associative,
// the usual convention (SPEC.md §2.9, added in #17), and a leading unary minus applies to its
// operand only.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSpec } from '../compile.js';
import { parseStringToIRExpr } from '../ir/lower.js';
import { translateExpr } from '../generators/z3-from-ir.js';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { judge, accountObligations } from '../../scripts/lib/obligations.mjs';

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

// `forall i in [0..1]:` keeps the body on the legacy translator.
const gate = (body: string) => `speck Gate {
    state {
        stage: Int
        approved: Bool
    }
    init {
        stage := 0
        approved := false
    }
    invariant Safe {
        forall i in [0..1]: ${body}
    }
    action Approve() {
        require stage == 0
        approved := true
        stage := 1
    }
    next: Approve
    verify Always(Safe) {
        depth 3
    }
}
`;

function compileGate(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-assoc-'));
  const spec = join(dir, 'Gate.speckdl');
  writeFileSync(spec, gate(body));
  const out = join(dir, 'out');
  compileSpec(spec, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 3 });
  return readFileSync(join(out, 'Gate.smt2'), 'utf-8');
}

/** The translated invariant body, as emitted in `(define-fun Safe () Bool ...)`. */
function safeBody(body: string): string {
  const m = compileGate(body).match(/\(define-fun Safe \(\) Bool\s+\(and\s+\(forall \(\(i Int\)\) (.*)\)\s*\)\s*\)/);
  if (!m) throw new Error('Safe not emitted');
  return m[1];
}

function verdict(body: string) {
  const smt = compileGate(body);
  const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: smt, encoding: 'utf-8' });
  const v = judge(smt, r.stdout ?? '', r.stderr ?? '');
  const acc = accountObligations([{ smt, obligations: v.obligations }]);
  return { status: v.status, proven: acc.proven as string[] };
}

describe('legacy translator: grouping', () => {
  it('subtraction is left-associative', () => {
    expect(safeBody('stage - 1 - 1 == stage')).toBe('(= (- (- stage 1) 1) stage)');
  });

  it('mixed + and - keep source order', () => {
    expect(safeBody('stage - 1 + 2 - 3 == stage')).toBe('(= (- (+ (- stage 1) 2) 3) stage)');
  });

  it('*, / and % share one left-associative level and bind tighter than + and -', () => {
    expect(safeBody('stage / 2 * 3 == stage')).toBe('(= (* (div stage 2) 3) stage)');
    expect(safeBody('stage - 6 % 4 == stage')).toBe('(= (- stage (mod 6 4)) stage)');
  });

  it('a leading unary minus applies to its operand only', () => {
    expect(safeBody('- stage - 1 == stage')).toBe('(= (- (- stage) 1) stage)');
  });
});

describe.skipIf(!hasZ3)('legacy translator: a wrong grouping must not prove a false property', () => {
  it('`stage - 1 - 1 == stage` is violated (main proved it)', () => {
    const v = verdict('stage - 1 - 1 == stage');
    expect(v.proven).toEqual([]);
    expect(v.status).toBe('VIOLATED');
  }, 60_000);

  it('`stage - 1 - 1 == stage - 2` is proved', () => {
    expect(verdict('stage - 1 - 1 == stage - 2').proven).toEqual(['Safe']);
  }, 60_000);

  it('`- stage - 1 == 1 - stage` is violated (main read it as -(stage - 1) and proved it)', () => {
    const v = verdict('- stage - 1 == 1 - stage');
    expect(v.proven).toEqual([]);
    expect(v.status).toBe('VIOLATED');
  }, 60_000);

  it('`8 / 4 / 2 == 4` is violated (right-associative it would be true)', () => {
    const v = verdict('8 / 4 / 2 == 4 + stage * 0');
    expect(v.proven).toEqual([]);
    expect(v.status).toBe('VIOLATED');
  }, 60_000);
});

describe('typed path: grouping follows the usual precedence (SPEC.md §2.9 in #17)', () => {
  const smt = (src: string) => translateExpr(parseStringToIRExpr(src));
  it('every binary arithmetic level is left-associative', () => {
    expect(smt('a - b - c')).toBe('(- (- a b) c)');
    expect(smt('a - b + c')).toBe('(+ (- a b) c)');
    expect(smt('a / b * c')).toBe('(* (div a b) c)');
    expect(smt('a % b % c')).toBe('(mod (mod a b) c)');
  });
  it('multiplicative binds tighter than additive; unary minus tightest', () => {
    expect(smt('a - b * c')).toBe('(- a (* b c))');
    expect(smt('-a - b')).toBe('(- (- a) b)');
    expect(smt('a - -1')).toBe('(- a -1)');
  });
  it('comparisons bind looser than arithmetic and equality looser than comparisons', () => {
    expect(smt('a - 1 < b == c')).toBe('(= (< (- a 1) b) c)');
  });
});
