// A gate must never default to green. Each test here pins one way the
// toolchain used to report success for something it never checked:
//   - z3 exited 1 on our own .smt2 files ((get-model) after unsat)
//   - degraded / skipped / unlowered verify blocks counted as passes
//   - the IR backend "verified" with a stuttering trace that proved nothing
//   - placeholder identifiers stood in for dropped let/forall in guards
//   - deny reasons spoke compiled numbers instead of spec names
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { untranslatedActions, transpileTsToMjs } from '../generators/agent/index.js';
// @ts-expect-error untyped .mjs helper shipped with the verifier
import { judge, obligationsOf, uncheckedOf, accountObligations } from '../../scripts/lib/obligations.mjs';
// @ts-expect-error untyped .mjs helper shipped with the verifier
import { loadBaseline } from '../../scripts/lib/baseline.mjs';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const examples = join(compilerDir, '..', 'examples');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;
const hasDist = existsSync(join(compilerDir, 'dist', 'index.js'));

function compile(spec: string, target: string, out: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', target, '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('generated SMT runs clean under raw z3', () => {
  for (const name of ['AgentPolicy', 'ReviewGate', 'KafkaKRaft']) {
    it(`${name}: no (get-model), z3 exits 0`, () => {
      const out = mkdtempSync(join(tmpdir(), `speckl-raw-${name}-`));
      expect(compile(join(examples, `${name}.speckdl`), 'z3', out).status).toBe(0);
      const files = readdirSync(out).filter(f => f.endsWith('.smt2'));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const smt = readFileSync(join(out, f), 'utf-8');
        expect(smt).not.toContain('(get-model)');
        if (hasZ3) {
          const r = spawnSync('z3', [join(out, f)], { encoding: 'utf-8' });
          expect(r.status, `${f}: ${r.stdout}`).toBe(0);
        }
      }
    }, 60_000);
  }
});

describe('obligation markers', () => {
  it('every verify block in an AST file carries a key', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-keys-'));
    expect(compile(join(examples, 'AgentPolicy.speckdl'), 'z3', out).status).toBe(0);
    const obs = obligationsOf(readFileSync(join(out, 'AgentPolicy.smt2'), 'utf-8'));
    expect(obs.map((o: any) => [o.key, o.expect, o.degraded])).toEqual([
      ['PrNeedsApproval', 'unsat', null],
      ['HoldOnJudge', 'unsat', null],
    ]);
  }, 60_000);

  it('a degraded check is parsed as a consistency check with its reason', () => {
    const smt = [
      '; speckl-obligation: Inv',
      '; speckl-expect: sat (degraded: model incomplete — 3 form(s) skipped)',
      '(check-sat)',
    ].join('\n');
    expect(obligationsOf(smt)).toEqual([
      { index: 0, line: 2, expect: 'sat', degraded: 'model incomplete — 3 form(s) skipped', key: 'Inv', label: 'check-sat #1' },
    ]);
  });

  it('unchecked markers keep keys that contain colons', () => {
    const smt = '; speckl-unchecked: a:b: no actions to unroll (BMC not run)\n; speckl-unchecked: Plain: x\n';
    expect(uncheckedOf(smt)).toEqual([
      { key: 'a:b', reason: 'no actions to unroll (BMC not run)' },
      { key: 'Plain', reason: 'x' },
    ]);
  });

  it('IR files declare their verify blocks as unchecked, never as checks', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-ir-'));
    expect(compile(join(examples, 'ReviewGate.speckdl'), 'all-ir', out).status).toBe(0);
    const ir = readFileSync(join(out, 'ReviewGate.ir.smt2'), 'utf-8');
    expect(uncheckedOf(ir).map((u: any) => u.key)).toEqual(['MergeNeedsApproval']);
    expect(obligationsOf(ir).filter((o: any) => o.key)).toEqual([]);
    // The old stuttering unroll left a silently dropped property behind.
    expect(ir).not.toMatch(/skipped: references undeclared identifier\(s\): Always/);
  }, 60_000);
});

describe('judge and accounting fail closed', () => {
  it('a check-sat without an expectation fails', () => {
    const v = judge('(check-sat)\n', 'sat\n');
    expect(v.status).toBe('VIOLATED');
    expect(v.obligations[0].ok).toBe(false);
  });

  const file = (smt: string, stdout: string) => ({ smt, obligations: judge(smt, stdout).obligations });
  const proof = (key: string) => `; speckl-obligation: ${key}\n; speckl-expect: unsat\n(check-sat)\n`;
  const degraded = (key: string) => `; speckl-obligation: ${key}\n; speckl-expect: sat (degraded: model incomplete — 2 form(s) skipped)\n(check-sat)\n`;

  it('a proven obligation is not unchecked, even when another backend delegated it', () => {
    const r = accountObligations([
      file(proof('A'), 'unsat\n'),
      file('; speckl-unchecked: A: IR backend does not unroll transitions; proof delegated to the AST backend\n; speckl-expect: sat\n(check-sat)\n', 'sat\n'),
    ]);
    expect(r).toEqual({ proven: ['A'], unchecked: [] });
  });

  it('a degraded check that answered sat is unchecked, not passed', () => {
    const r = accountObligations([file(degraded('A'), 'sat\n')]);
    expect(r.proven).toEqual([]);
    expect(r.unchecked).toEqual([{ key: 'A', reasons: ['model incomplete — 2 form(s) skipped'] }]);
  });

  it('delegation without a proof anywhere is unchecked', () => {
    const r = accountObligations([
      file('; speckl-unchecked: B: IR backend does not unroll transitions; proof delegated to the AST backend\n', ''),
    ]);
    expect(r.unchecked).toEqual([{ key: 'B', reasons: ['IR backend does not unroll transitions; proof delegated to the AST backend'] }]);
  });

  it('a violated obligation is left to the VIOLATED verdict, not double counted', () => {
    const r = accountObligations([file(proof('C'), 'sat\n')]);
    expect(r).toEqual({ proven: [], unchecked: [] });
  });
});

describe('baseline file', () => {
  it('is optional, and malformed entries are rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-baseline-'));
    expect(loadBaseline(dir).path).toBeNull();
    writeFileSync(join(dir, '.speckl-unchecked.json'), JSON.stringify({ $comment: 'x', 'A.speckdl': { Inv: 'why' } }));
    const b = loadBaseline(dir);
    expect([...b.entries.keys()]).toEqual(['A.speckdl']);
    expect(b.entries.get('A.speckdl').get('Inv')).toBe('why');
    writeFileSync(join(dir, '.speckl-unchecked.json'), JSON.stringify({ 'A.speckdl': ['Inv'] }));
    expect(() => loadBaseline(dir)).toThrow(/must map verify names/);
  });
});

describe.skipIf(!hasZ3 || !hasDist)('speckl verify fails closed end to end', () => {
  const spec = `speck NoActions {
  state: {
    count: Int
  }
  init: {
    count := 0
  }
  invariant Bounded {
    count >= 0
  }
  verify Always(Bounded) {
    depth 3
  }
}
`;
  function verify(dir: string) {
    const r = spawnSync(process.execPath, [join(compilerDir, 'scripts', 'verify-z3.mjs'), '--examples', dir],
      { cwd: compilerDir, encoding: 'utf-8' });
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  }
  function specDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-verify-closed-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'NoActions.speckdl'), spec);
    return dir;
  }

  it('a verify block with nothing to unroll fails as UNCHECKED', () => {
    const r = verify(specDir());
    expect(r.out).toMatch(/NoActions\.speckdl · Bounded: UNCHECKED — no actions to unroll/);
    expect(r.status).toBe(1);
  }, 60_000);

  it('a baseline entry acknowledges it without counting it as passed', () => {
    const dir = specDir();
    writeFileSync(join(dir, '.speckl-unchecked.json'), JSON.stringify({ 'NoActions.speckdl': { Bounded: 'no actions yet' } }));
    const r = verify(dir);
    expect(r.out).toMatch(/1 unchecked obligation\(s\) acknowledged in baseline \(not passed\)/);
    expect(r.status).toBe(0);
  }, 60_000);

  it('a stale baseline entry fails', () => {
    const dir = specDir();
    writeFileSync(join(dir, '.speckl-unchecked.json'), JSON.stringify({ 'NoActions.speckdl': { Bounded: 'x', Gone: 'y' } }));
    const r = verify(dir);
    expect(r.out).toMatch(/STALE-BASELINE/);
    expect(r.status).toBe(1);
  }, 60_000);
});

describe('agent rails refuse untranslated guards', () => {
  const js = [
    'export class M {',
    '  Approve(reviewer) {',
    '    const reviewers = {}; // FIXME: parser dropped let/forall',
    '    if (!(reviewers.has(reviewer))) throw new Error("x");',
    '  }',
    '  Merge() {',
    '    return true;',
    '  }',
    '}',
  ].join('\n');

  it('finds the placeholder and the action it sits in', () => {
    expect(untranslatedActions(js)).toEqual([{ action: 'Approve', names: ['reviewers'] }]);
    expect(untranslatedActions(js.replace(/.*FIXME.*\n/, ''))).toEqual([]);
  });

  it('transpile throws instead of emitting a machine with a fake guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-fixme-'));
    writeFileSync(join(dir, 'M.ts'), js);
    expect(() => transpileTsToMjs(join(dir, 'M.ts'), join(dir, 'M.mjs'))).toThrow(/untranslated identifiers in Approve \(reviewers\)/);
    expect(existsSync(join(dir, 'M.mjs'))).toBe(false);
  });

  it('AgentPolicy and ReviewGate machines have no placeholders', () => {
    for (const name of ['AgentPolicy', 'ReviewGate']) {
      const out = mkdtempSync(join(tmpdir(), `speckl-ts-${name}-`));
      expect(compile(join(examples, `${name}.speckdl`), 'typescript', out).status).toBe(0);
      const ts = readdirSync(out).find(f => f.endsWith('.ts'))!;
      expect(readFileSync(join(out, ts), 'utf-8')).not.toContain('FIXME: parser dropped');
    }
  }, 60_000);
});
