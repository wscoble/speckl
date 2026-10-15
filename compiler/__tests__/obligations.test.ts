import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
// @ts-ignore plain ESM helper shared with scripts/verify-z3.mjs
import { obligationsOf, judge, modelQueryFor } from '../scripts/lib/obligations.mjs';

const twoBlocks = `
(push)
(echo "Checking: Always(A) for 2 steps")
; speckl-expect: unsat
(check-sat)
(get-model)
(pop)
(push)
(echo "Checking: Always(B) for 2 steps")
; speckl-expect: unsat
(check-sat)
(get-model)
(pop)
`;

describe('per-obligation Z3 verdicts', () => {
  it('finds one obligation per check-sat with its own expectation', () => {
    const obs = obligationsOf(twoBlocks);
    expect(obs.map((o: any) => [o.label, o.expect])).toEqual([
      ['Always(A) for 2 steps', 'unsat'],
      ['Always(B) for 2 steps', 'unsat'],
    ]);
  });

  it('regression: an earlier violated property is NOT masked by a later proven one', () => {
    const v = judge(twoBlocks, 'Checking: Always(A) for 2 steps\nsat\nChecking: Always(B) for 2 steps\nunsat\n');
    expect(v.status).toBe('VIOLATED');
    expect(v.obligations.map((o: any) => o.ok)).toEqual([false, true]);
  });

  it('a later violation fails too', () => {
    expect(judge(twoBlocks, 'unsat\nsat\n').status).toBe('VIOLATED');
  });

  it('passes only when every obligation holds', () => {
    expect(judge(twoBlocks, 'unsat\nunsat\n').status).toBe('OK');
  });

  it('fewer answers than check-sats is not a pass', () => {
    expect(judge(twoBlocks, 'unsat\n').status).toBe('NO-RESULT');
  });

  it('unknown on any obligation is not a pass', () => {
    expect(judge(twoBlocks, 'unknown\nunsat\n').status).toBe('NO-RESULT');
  });

  it('solver errors fail the file', () => {
    expect(judge(twoBlocks, 'sat\n(error "boom")\n').status).toBe('Z3-ERROR');
  });

  it('model query stops at the violated obligation', () => {
    const q = modelQueryFor(twoBlocks, obligationsOf(twoBlocks)[0]);
    expect(q).toContain('Always(A)');
    expect(q).not.toContain('Always(B)');
    expect(q.trim().endsWith('(get-model)')).toBe(true);
  });

  const z3 = spawnSync('z3', ['--version']);
  it.skipIf(z3.error || z3.status !== 0)('end to end with real z3: first of two properties violated', () => {
    const smt = `
(push)
(declare-const x Int)
(assert (= x 1))
(echo "Checking: Always(XIsZero)")
; speckl-expect: unsat
(assert (not (= x 0)))
(check-sat)
(pop)
(push)
(declare-const y Int)
(assert (= y 0))
(echo "Checking: Always(YIsZero)")
; speckl-expect: unsat
(assert (not (= y 0)))
(check-sat)
(pop)
`;
    const r = spawnSync('z3', ['-smt2', '-in'], { input: smt, encoding: 'utf-8' });
    const v = judge(smt, r.stdout, r.stderr);
    expect(v.status).toBe('VIOLATED');
    expect(v.obligations.map((o: any) => [o.label, o.got])).toEqual([
      ['Always(XIsZero)', 'sat'],
      ['Always(YIsZero)', 'unsat'],
    ]);
  });
});
