// End-to-end: examples/AgentPolicy.speckdl → agent outputs, Z3 proof,
// weakened counterexample, real hook process, CLI + file-drop signals.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

function compile(spec: string, target: string, out: string): string {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', target, '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function z3Verdicts(smtFile: string): string[] {
  const smt = readFileSync(smtFile, 'utf-8').replace(/\(get-model\)/g, '');
  const r = spawnSync('z3', ['-smt2', '-in'], { input: smt, encoding: 'utf-8' });
  return r.stdout.split('\n').map(l => l.trim()).filter(l => /^(un)?sat$/.test(l));
}

function runHook(agentDir: string, cmd: 'pre' | 'post', state: string, msg: object): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), cmd, '--state', state], {
    input: JSON.stringify(msg),
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runSignal(agentDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let out = '';
let agentDir = '';

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'speckl-agentpolicy-'));
  compile(example, 'all', out);
  agentDir = join(out, 'agent');
}, 90_000);

describe('examples/AgentPolicy.speckdl', () => {
  it('emits agent outputs', () => {
    for (const f of ['AGENTS.md', 'tools.json', 'hook.mjs', 'signal.mjs', 'agent-config.json', 'spec.sha256', 'AgentPolicy.mjs', 'README.md']) {
      expect(existsSync(join(agentDir, f)), f).toBe(true);
    }
    expect(existsSync(join(agentDir, 'verifiers', 'cli.mjs'))).toBe(true);
    expect(existsSync(join(agentDir, 'verifiers', 'file-drop.mjs'))).toBe(true);
  });

  it('tools.json matches the agent block', () => {
    const tools = JSON.parse(readFileSync(join(agentDir, 'tools.json'), 'utf-8'));
    expect(tools.tools.map((t: any) => t.name).sort()).toEqual(['open_pr', 'read_file', 'request_review', 'run_tests']);
    const open = tools.tools.find((t: any) => t.name === 'open_pr');
    expect(open['x-speckl']).toEqual({ action: 'OpenPR', effect: 'act' });
    const read = tools.tools.find((t: any) => t.name === 'read_file');
    expect(read.inputSchema.properties.path).toEqual({ type: 'string' });
    expect(read['x-speckl'].effect).toBe('observe');
  });

  it('BMC unrolls synthetic signal actions', () => {
    const smt = readFileSync(join(out, 'AgentPolicy.smt2'), 'utf-8');
    expect(smt).toContain('__signal_review_approve');
    expect(smt).toContain('__signal_review_reject');
    expect(smt).toContain('; Next transition relation: RunTests | RequestReview | OpenPR | ReadFile | __signal_review_approve | __signal_review_reject');
  });

  it.skipIf(!hasZ3)('z3 proves PrNeedsApproval to depth 8', () => {
    expect(z3Verdicts(join(out, 'AgentPolicy.smt2'))).toEqual(['unsat', 'unsat']);
  });

  it.skipIf(!hasZ3)('weakening OpenPR to fire from AwaitingReview breaks HoldOnJudge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-weak2-'));
    const weak = join(dir, 'AgentPolicy.speckdl');
    const src = readFileSync(example, 'utf-8');
    expect(src).toContain('require stage == 3\n        prFromApproved');
    writeFileSync(weak, src.replace('require stage == 3\n        prFromApproved', 'require stage == 2\n        prFromApproved'));
    compile(weak, 'z3', join(dir, 'out'));
    // PrNeedsApproval still holds (tests passed), HoldOnJudge is violated.
    expect(z3Verdicts(join(dir, 'out', 'AgentPolicy.smt2'))).toEqual(['unsat', 'sat']);
  }, 60_000);

  it.skipIf(!hasZ3)('weakening OpenPR to skip approval yields a counterexample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-weak-'));
    const weak = join(dir, 'AgentPolicy.speckdl');
    // OpenPR from Idle skips both tests and approval → PrOpened with testsPassed=false.
    writeFileSync(weak, readFileSync(example, 'utf-8').replace(
      'require stage == 3\n        prFromApproved',
      'require stage == 0\n        prFromApproved',
    ));
    compile(weak, 'z3', join(dir, 'out'));
    expect(z3Verdicts(join(dir, 'out', 'AgentPolicy.smt2'))).toEqual(['sat', 'sat']);
  }, 60_000);

  it('non-agent backends do not grow __signal_* camel processors', () => {
    const camelOut = spawnSync('find', [join(out, 'camel'), '-name', '*signal*'], { encoding: 'utf-8' });
    expect((camelOut.stdout || '').trim()).toBe('');
  });
});

describe('agent hook process', () => {
  function freshState(): string {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-hook-'));
    const state = join(dir, 'state.json');
    const r = runSignal(agentDir, ['init', '--state', state]);
    expect(r.status).toBe(0);
    return state;
  }

  it('unknown tool → deny', () => {
    const state = freshState();
    const r = runHook(agentDir, 'pre', state, { tool: 'rm_rf', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('"deny"');
  });

  it('open_pr from Idle → deny', () => {
    const state = freshState();
    const r = runHook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/can\(\) refused|Guard failed/);
  });

  it('happy path → allow and advance', () => {
    const state = freshState();
    expect(runHook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(runHook(agentDir, 'post', state, { tool: 'run_tests', input: {}, call_id: '1', ok: true }).status).toBe(0);
    expect(runHook(agentDir, 'pre', state, { tool: 'request_review', input: {}, call_id: '2' }).status).toBe(0);
    expect(runHook(agentDir, 'post', state, { tool: 'request_review', input: {}, call_id: '2', ok: true }).status).toBe(0);
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    expect(snap.machine.state.stage).toBe(2);
  });

  it('act tool while awaiting → deny; observe tool → allow (near/HNTL)', () => {
    const state = freshState();
    for (const [tool, id] of [['run_tests', '1'], ['request_review', '2']] as const) {
      expect(runHook(agentDir, 'pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
      expect(runHook(agentDir, 'post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
    }
    const act = runHook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '3' });
    expect(act.status).toBe(2);
    expect(act.stdout).toContain('HNTL');
    const obs = runHook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'x' }, call_id: '4' });
    expect(obs.status).toBe(0);
  });

  it('HITL (mode in) refuses observe tools while awaiting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-hitl-'));
    const spec = join(dir, 'AgentPolicy.speckdl');
    writeFileSync(spec, readFileSync(example, 'utf-8').replace('mode near', 'mode in'));
    compile(spec, 'agent', join(dir, 'out'));
    const ad = join(dir, 'out', 'agent');
    const state = join(dir, 'state.json');
    expect(runSignal(ad, ['init', '--state', state]).status).toBe(0);
    for (const [tool, id] of [['run_tests', '1'], ['request_review', '2']] as const) {
      expect(runHook(ad, 'pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
      expect(runHook(ad, 'post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
    }
    const obs = runHook(ad, 'pre', state, { tool: 'read_file', input: { path: 'x' }, call_id: '3' });
    expect(obs.status).toBe(2);
    expect(obs.stdout).toContain('HITL');
  }, 60_000);

  it('post with ok=false does not advance state', () => {
    const state = freshState();
    expect(runHook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(runHook(agentDir, 'post', state, { tool: 'run_tests', input: {}, call_id: '1', ok: false }).status).toBe(0);
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    expect(snap.machine.state.stage).toBe(0);
    expect(snap.pending).toBeNull();
  });

  it('specHash mismatch → deny', () => {
    const state = freshState();
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    snap.specHash = 'deadbeef';
    writeFileSync(state, JSON.stringify(snap));
    const r = runHook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('specHash mismatch');
  });

  it('concurrent hook calls do not corrupt state', async () => {
    const state = freshState();
    const run = (call_id: string) => new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [join(agentDir, 'hook.mjs'), 'pre', '--state', state], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(JSON.stringify({ tool: 'run_tests', input: {}, call_id }));
    });
    const results = await Promise.all([run('a'), run('b'), run('c')]);
    const allows = results.filter(r => r.status === 0);
    // Exactly one should win the pre (others may deny on pending conflict or lock); state must stay valid JSON.
    expect(allows.length).toBe(1);
    for (const r of results.filter(x => x.status !== 0)) expect(r.stdout).toContain('already pending');
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    expect(snap.machine.state.stage).toBe(0);
    expect(snap.specHash).toBeTruthy();
    expect(results.map(r => r.status).filter(c => c === 0).length).toBe(1);
    expect(['a', 'b', 'c']).toContain(snap.pending.call_id);
    expect(existsSync(state + '.lock')).toBe(false);
  }, 20_000);
});

describe('agent signals', () => {
  function awaitState(): string {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-sig-'));
    const state = join(dir, 'state.json');
    // --dev: these cases use the DEV-only cli verifier.
    expect(runSignal(agentDir, ['init', '--state', state, '--dev']).status).toBe(0);
    for (const [tool, id] of [['run_tests', '1'], ['request_review', '2']] as const) {
      expect(runHook(agentDir, 'pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
      expect(runHook(agentDir, 'post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
    }
    return state;
  }

  it('CLI approve → open_pr allowed', () => {
    const state = awaitState();
    const sig = runSignal(agentDir, ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'approve', '--as', 'alice', '--reviewer', 'alice']);
    expect(sig.status).toBe(0);
    expect(runHook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '9' }).status).toBe(0);
  });

  it('CLI reject → open_pr denied permanently', () => {
    const state = awaitState();
    expect(runSignal(agentDir, ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'reject', '--as', 'bob', '--reviewer', 'bob']).status).toBe(0);
    const r = runHook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '9' });
    expect(r.status).toBe(2);
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    expect(snap.machine.state.stage).toBe(4); // Rejected
  });

  it('CLI missing claim → rejected', () => {
    const state = awaitState();
    const r = runSignal(agentDir, ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'approve', '--as', 'alice']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing claim');
  });

  it('file-drop: good signature applies; bad sig / wrong signal / replay rejected', () => {
    const state = awaitState();
    const dir = path.dirname(state);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const pubFile = join(dir, 'reviewer.pub');
    writeFileSync(pubFile, pubRaw);

    const bodyObj = {
      signal: 'review',
      outcome: 'approve',
      claims: { reviewer: 'carol' },
      subject: 'carol',
      at: new Date().toISOString(),
      run: JSON.parse(readFileSync(state, 'utf-8')).runId,
      expires: new Date(Date.now() + 3600_000).toISOString(),
      nonce: crypto.randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(bodyObj));
    const file = join(dir, 'review.json');
    writeFileSync(file, body);
    const sig = crypto.sign(null, body, privateKey);
    writeFileSync(file + '.sig', sig);

    const good = runSignal(agentDir, ['apply', '--state', state, '--verifier', 'file-drop', '--file', file, '--pubkey', pubFile]);
    expect(good.status).toBe(0);

    // replay same evidence
    const replay = runSignal(agentDir, ['apply', '--state', state, '--verifier', 'file-drop', '--file', file, '--pubkey', pubFile]);
    expect(replay.status).toBe(2);
    expect(replay.stderr).toMatch(/replay|not in an await/);

    // fresh await for bad-sig / wrong-signal checks
    const state2 = awaitState();
    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, body);
    writeFileSync(badFile + '.sig', crypto.randomBytes(64));
    const bad = runSignal(agentDir, ['apply', '--state', state2, '--verifier', 'file-drop', '--file', badFile, '--pubkey', pubFile]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/bad signature|verifier rejected/);

    const wrongObj = { ...bodyObj, signal: 'deploy', run: JSON.parse(readFileSync(state2, 'utf-8')).runId, nonce: crypto.randomUUID() };
    const wrongBody = Buffer.from(JSON.stringify(wrongObj));
    const wrongFile = join(dir, 'wrong.json');
    writeFileSync(wrongFile, wrongBody);
    writeFileSync(wrongFile + '.sig', crypto.sign(null, wrongBody, privateKey));
    const wrong = runSignal(agentDir, ['apply', '--state', state2, '--verifier', 'file-drop', '--file', wrongFile, '--pubkey', pubFile]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/wrong signal/);
  });

  it('timeout resolves only to reject', () => {
    const state = awaitState();
    // Force awaitingSince into the past beyond 24h
    const snap = JSON.parse(readFileSync(state, 'utf-8'));
    snap.awaitingSince = new Date(Date.now() - 25 * 3600_000).toISOString();
    writeFileSync(state, JSON.stringify(snap));
    const r = runSignal(agentDir, ['timeout', '--state', state]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).outcome).toBe('reject');
    expect(JSON.parse(readFileSync(state, 'utf-8')).machine.state.stage).toBe(4);
  });

  it('disallowed outcome rejected', () => {
    const state = awaitState();
    const r = runSignal(agentDir, ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'ship_it', '--as', 'x', '--reviewer', 'x']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('disallowed outcome');
  });
});
