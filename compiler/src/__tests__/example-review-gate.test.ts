// Executes examples/ReviewGate.speckdl end to end: compile with the CLI,
// prove the invariant with z3, show a weakened guard yields a counterexample,
// then drive the generated TypeScript machine through can()/serialize()/restore().
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ReviewGate.speckdl');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;

function compile(spec: string, target: string, out: string): void {
  const r = spawnSync(process.execPath, [join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs'),
    join(compilerDir, 'src', 'index.ts'), spec, '-t', target, '-o', out], { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
}

function z3Verdicts(smtFile: string): string[] {
  // Raw file, as a user would run it: no (get-model) after unsat, so z3 exits 0.
  const r = spawnSync('z3', [smtFile], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`z3 exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout.split('\n').map(l => l.trim()).filter(l => /^(un)?sat$/.test(l));
}

let out = '';
let Machine: any;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'speckl-reviewgate-'));
  compile(example, 'all', out);
  const src = readFileSync(join(out, 'ReviewGate.ts'), 'utf-8');
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  writeFileSync(join(out, 'ReviewGate.mjs'), js);
  Machine = (await import(pathToFileURL(join(out, 'ReviewGate.mjs')).href)).ReviewGateMachine;
}, 60_000);

describe('examples/ReviewGate.speckdl', () => {
  it('unrolls every next: action in BMC', () => {
    const smt = readFileSync(join(out, 'ReviewGate.smt2'), 'utf-8');
    expect(smt).toContain('; Next transition relation: RunTests | RequestReview | Approve | Merge');
    expect(smt.match(/; Action: Merge/g)?.length).toBe(8);
  });

  it.skipIf(!hasZ3)('z3 proves MergeNeedsApproval to depth 8', () => {
    expect(z3Verdicts(join(out, 'ReviewGate.smt2'))).toEqual(['unsat']);
  });

  it.skipIf(!hasZ3)('weakening Merge to skip approval yields a counterexample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-reviewgate-weak-'));
    const weak = join(dir, 'ReviewGate.speckdl');
    writeFileSync(weak, readFileSync(example, 'utf-8').replace('require stage == 3\n        stage := 4', 'require stage == 2\n        stage := 4'));
    compile(weak, 'z3', join(dir, 'out'));
    expect(z3Verdicts(join(dir, 'out', 'ReviewGate.smt2'))).toEqual(['sat']);
  }, 60_000);

  it('runs the happy path, refusing out-of-order actions without side effects', () => {
    const m = new Machine();
    expect(m.can('Merge')).toBe('Guard failed: this.stage === 3');
    expect(m.stage).toBe(0);
    for (const a of ['RunTests', 'RequestReview', 'Approve']) {
      expect(m.can(a)).toBe(true);
      m[a]();
    }
    expect(m.can('RunTests')).toMatch(/^Guard failed/);
    expect(m.can('Merge')).toBe(true);
    m.Merge();
    expect(m.stage).toBe(4);
    expect(m.approved && m.testsPassed).toBe(true);
  });

  it('persists and resumes mid-review via serialize/restore', () => {
    const m = new Machine();
    m.RunTests();
    m.RequestReview();
    const saved = JSON.stringify(m.serialize());
    const resumed = Machine.restore(JSON.parse(saved));
    expect(resumed.can('Merge')).toMatch(/^Guard failed/);
    resumed.Approve();
    expect(resumed.can('Merge')).toBe(true);
    expect(m.stage).toBe(2); // original untouched
  });
});
