// End-to-end: examples/DeployGate.speckdl, the call-bound sign-off example.
// One approval covers one exact deploy call (tool + arguments), once.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { canonical, useStateKey } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'DeployGate.speckdl');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };

function compile(spec: string, target: string, out: string): void {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', target, '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
}

function z3Verdicts(smtFile: string): string[] {
  const r = spawnSync('z3', [smtFile], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`z3 exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout.split('\n').map(l => l.trim()).filter(l => /^(un)?sat$/.test(l));
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

useStateKey();
let out = '';
let agentDir = '';
let n = 0;

function run(script: string, args: string[], input?: unknown): R {
  const r = spawnSync(process.execPath, [join(agentDir, script), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
const pre = (state: string, tool: string, input: unknown, id: string) =>
  run('hook.mjs', ['pre', '--state', state], { tool, input, call_id: id });
const post = (state: string, tool: string, input: unknown, id: string, ok: boolean) =>
  run('hook.mjs', ['post', '--state', state], { tool, input, call_id: id, ok });

function init(): string {
  const state = join(mkdtempSync(join(tmpdir(), 'speckl-deploygate-')), 'state.json');
  const r = run('signal.mjs', ['init', '--state', state, '--signer', 'approver=' + pubHex]);
  expect(r.status, r.stderr).toBe(0);
  return state;
}

function toAwaiting(state: string): void {
  for (const tool of ['run_checks', 'request_deploy']) {
    expect(pre(state, tool, {}, tool).status).toBe(0);
    expect(post(state, tool, {}, tool, true).status).toBe(0);
  }
  expect(read(state).machine.state.stage).toBe(2);
}

/** A signed approval drop; `call` is omitted when undefined. */
function approve(state: string, call: string | undefined): R {
  const body: Record<string, unknown> = {
    signal: 'approval', outcome: 'approve', claims: { approver: 'scott' },
    run: read(state).runId, expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(),
  };
  if (call !== undefined) body.call = call;
  const file = join(path.dirname(state), `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(body));
  writeFileSync(file, buf);
  writeFileSync(file + '.sig', crypto.sign(null, buf, privateKey));
  return run('signal.mjs', ['apply', '--state', state, '--verifier', 'file-drop', '--file', file, '--signer', 'approver']);
}

const staging = { env: 'staging' };
const prod = { env: 'prod' };

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'speckl-deploygate-out-'));
  compile(example, 'all', out);
  agentDir = join(out, 'agent');
}, 90_000);

describe('examples/DeployGate.speckdl', () => {
  it('declares the approve outcome call-bound in the generated config and docs', () => {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'agent-config.json'), 'utf-8'));
    expect(cfg.awaits).toHaveLength(1);
    expect(cfg.awaits[0].bindCall).toEqual(['approve']);
    expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toContain('Call-bound: `approve`');
  });

  it.skipIf(!hasZ3)('Z3 proves both invariants; deploying while still awaiting approval breaks DeployNeedsApproval', () => {
    expect(z3Verdicts(join(out, 'DeployGate.smt2'))).toEqual(['unsat', 'unsat']);
    const dir = mkdtempSync(join(tmpdir(), 'speckl-deploygate-weak-'));
    const weak = join(dir, 'DeployGate.speckdl');
    const src = readFileSync(example, 'utf-8');
    const weakened = src.replace(/(action Deploy\(env: String\) \{\n\s*)require stage == 3\n/, '$1require stage == 2\n');
    expect(weakened).not.toBe(src);
    writeFileSync(weak, weakened);
    compile(weak, 'z3', join(dir, 'out'));
    expect(z3Verdicts(join(dir, 'out', 'DeployGate.smt2'))).toEqual(['unsat', 'sat']);
  }, 90_000);

  it('a signed approval covers the one deploy it names, once', () => {
    const state = init();
    toAwaiting(state);

    // While waiting, the deny shows exactly what a human would sign.
    const waiting = pre(state, 'deploy', staging, 'd0');
    expect(waiting.status).toBe(2);
    const hint = waiting.stderr.match(/sign call ([0-9a-f]{64}) canonical (\S+)/);
    expect(hint, waiting.stderr).not.toBeNull();
    expect(hint![2]).toBe(canonical({ input: staging, tool: 'deploy' }));
    const shown = JSON.parse(run('signal.mjs', ['digest'], { tool: 'deploy', input: staging }).stdout);
    expect(hint![1]).toBe(shown.digest);

    const applied = approve(state, shown.digest);
    expect(applied.status, applied.stderr).toBe(0);
    expect(read(state).machine.state.stage).toBe(3);
    expect(read(state).boundCall).toEqual({ hash: shown.digest });

    // Same tool, different arguments: refused, and the approval is kept.
    const other = pre(state, 'deploy', prod, 'd1');
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('does not cover this call');
    expect(read(state).boundCall).toEqual({ hash: shown.digest });

    // A failed run of the signed call does not spend it.
    expect(pre(state, 'deploy', staging, 'd2').status).toBe(0);
    expect(post(state, 'deploy', staging, 'd2', false).status).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: shown.digest });
    expect(read(state).machine.state.stage).toBe(3);

    // The signed call succeeds: binding cleared, stage moves on.
    expect(pre(state, 'deploy', staging, 'd3').status).toBe(0);
    expect(post(state, 'deploy', staging, 'd3', true).status).toBe(0);
    expect(read(state).boundCall).toBeNull();
    expect(read(state).machine.state.stage).toBe(4);

    // It cannot run again under the spent approval.
    const again = pre(state, 'deploy', staging, 'd4');
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('can() refused');
  });

  it('an approval without a call hash is refused and the stage stays put', () => {
    const state = init();
    toAwaiting(state);
    const r = approve(state, undefined);
    expect(r.status).not.toBe(0);
    expect(read(state).machine.state.stage).toBe(2);
    expect(read(state).boundCall ?? null).toBeNull();
    expect(pre(state, 'deploy', staging, 'd0').status).toBe(2);
  });
});
