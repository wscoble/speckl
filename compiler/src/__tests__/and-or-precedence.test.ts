// `and` binds tighter than `or` everywhere an expression is read.
//
// The typed expression parser gave or/and one precedence level, and the AST
// Z3 backend's legacy string translator split on `and` first, so
// `a or b and c` meant `(a or b) and c` there, while the TypeScript, Rust, Go
// and Elm generators (which transcribe to `||`/`&&`) meant `a or (b and c)`.
// Every path now uses the usual convention.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExpressionComplete } from '../expr/index.js';
import { parseStringToIRExpr } from '../ir/lower.js';
import { translateExpr } from '../generators/z3-from-ir.js';
import { compileSpec } from '../compile.js';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { judge, accountObligations } from '../../scripts/lib/obligations.mjs';

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

const smt = (src: string) => translateExpr(parseStringToIRExpr(src));

describe('expression parser', () => {
  it('a or b and c is a or (b and c)', () => {
    expect(parseExpressionComplete('a or b and c')).toMatchObject({ op: 'or', left: { name: 'a' }, right: { op: 'and' } });
  });

  it('a and b or c is (a and b) or c', () => {
    expect(parseExpressionComplete('a and b or c')).toMatchObject({ op: 'or', left: { op: 'and' }, right: { name: 'c' } });
  });

  it('symbolic forms follow the same rule (a || b && c)', () => {
    expect(parseExpressionComplete('a || b && c')).toMatchObject({ op: 'or', right: { op: 'and' } });
    expect(parseExpressionComplete('a or b && c')).toMatchObject({ op: 'or', right: { op: 'and' } });
  });

  it('chains keep left associativity within a level', () => {
    expect(parseExpressionComplete('a and b and c or d or e')).toMatchObject({
      op: 'or',
      left: { op: 'or', left: { op: 'and', left: { op: 'and' } }, right: { name: 'd' } },
      right: { name: 'e' },
    });
  });

  it('parentheses still override', () => {
    expect(parseExpressionComplete('(a or b) and c')).toMatchObject({ op: 'and', left: { kind: 'parens', expr: { op: 'or' } } });
  });

  it('or and and still bind looser than comparisons and tighter than implies', () => {
    expect(parseExpressionComplete('x == 1 or y < 2 and z implies w')).toMatchObject({
      op: 'implies',
      left: { op: 'or', left: { op: 'eq' }, right: { op: 'and', left: { op: 'lt' } } },
    });
  });
});

describe('IR and SMT translation', () => {
  it('lowers mixed and/or with and grouped first', () => {
    expect(smt('p or q and r')).toBe('(or p (and q r))');
    expect(smt('p and q or r')).toBe('(or (and p q) r)');
    expect(smt('not p or q and r')).toBe('(or (not p) (and q r))');
  });
});

/** Compile a one-speck spec with -t z3 and return the AST backend's SMT text. */
function astSmt(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-andor-'));
  const spec = join(dir, 'Gate.speckdl');
  writeFileSync(spec, src);
  const out = join(dir, 'out');
  compileSpec(spec, { outputDir: out, target: 'z3', bomFormat: 'both', verifyDepth: 6 });
  return readFileSync(join(out, 'Gate.smt2'), 'utf-8');
}

const gate = (prop: string) => `speck Gate {
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
    action Approve() {
        require stage == 0
        approved := true
        stage := 1
    }
    action Ship() {
        require stage == 1
        stage := 2
    }
    next: Approve | Ship
    verify Always(Safe) {
        depth 6
    }
}
`;

describe('AST Z3 backend', () => {
  it('the legacy string translator (used for post-state invariants) groups and first', () => {
    // `stage'` keeps this invariant on the legacy translator.
    const text = astSmt(gate("stage' >= stage or approved and stage == 0"));
    expect(text).toMatch(/\(or \(>= stage_post stage\) \(and approved \(= stage 0\)\)\)/);
  });

  it.skipIf(!hasZ3)('proves `stage == 0 or stage >= 1 and approved`, which only holds with and grouped first', () => {
    // Read as (stage == 0 or stage >= 1) and approved it is false in the
    // initial state (approved is false), so a wrong grouping is a violation.
    const text = astSmt(gate('stage == 0 or stage >= 1 and approved'));
    const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: text, encoding: 'utf-8' });
    const v = judge(text, r.stdout ?? '', r.stderr ?? '');
    expect(v.status).toBe('OK');
    expect(accountObligations([{ smt: text, obligations: v.obligations }]).proven).toEqual(['Safe']);
  }, 60_000);
});
