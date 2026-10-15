// Hardening cases for the generated agent hook and signal tooling: true
// replay, unsigned/malformed drops, timeout clock, stale locks, post
// mismatches, and the docs wiring example.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = join(compilerDir, '..');
const example = join(repoDir, 'examples', 'AgentPolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };

function compile(spec: string, out: string): void {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
}
function hook(dir: string, cmd: string, state: string, msg: unknown): R {
  const r = spawnSync(process.execPath, [join(dir, 'hook.mjs'), cmd, '--state', state],
    { input: typeof msg === 'string' ? msg : JSON.stringify(msg), encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function signal(dir: string, args: string[]): R {
  const r = spawnSync(process.execPath, [join(dir, 'signal.mjs'), ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function step(dir: string, state: string, tool: string, id: string): void {
  expect(hook(dir, 'pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
  expect(hook(dir, 'post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
}

let agentDir = '';
let loopDir = '';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

function newState(dir = agentDir): string {
  const state = join(mkdtempSync(join(tmpdir(), 'speckl-hard-')), 'state.json');
  expect(signal(dir, ['init', '--state', state]).status).toBe(0);
  return state;
}
function awaiting(dir = agentDir): string {
  const s = newState(dir);
  step(dir, s, 'run_tests', '1');
  step(dir, s, 'request_review', '2');
  return s;
}
function drop(dir: string, name: string, body: object, sign = true): { file: string; pub: string } {
  const file = join(dir, name);
  const buf = Buffer.from(JSON.stringify(body));
  writeFileSync(file, buf);
  if (sign) writeFileSync(file + '.sig', crypto.sign(null, buf, privateKey));
  const pub = join(dir, 'reviewer.pub');
  writeFileSync(pub, pubRaw.toString('hex'));
  return { file, pub };
}
const review = { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' }, subject: 'carol' };

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'speckl-hard-out-'));
  compile(example, join(base, 'a'));
  agentDir = join(base, 'a', 'agent');
  // Loop variant: reject sends the agent back to TestsGreen so the same await
  // is re-entered, which lets us test genuine replay of evidence.
  const loopSpec = join(base, 'Loop.speckdl');
  writeFileSync(loopSpec, readFileSync(example, 'utf-8').replace('on reject  -> Rejected', 'on reject  -> TestsGreen'));
  compile(loopSpec, join(base, 'l'));
  loopDir = join(base, 'l', 'agent');
}, 120_000);

describe('file-drop verifier hardening', () => {
  it('replayed evidence is refused when the await is re-entered', () => {
    const s = awaiting(loopDir);
    const d = path.dirname(s);
    const { file, pub } = drop(d, 'r.json', { ...review, outcome: 'reject' });
    expect(signal(loopDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]).status).toBe(0);
    step(loopDir, s, 'request_review', '3');
    const again = signal(loopDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('replay');
  });

  it('missing claim in a signed drop is refused', () => {
    const s = awaiting(); const d = path.dirname(s);
    const { file, pub } = drop(d, 'm.json', { ...review, claims: {} });
    const r = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing claim: reviewer');
  });

  it('a signed drop that does not name its signal is refused', () => {
    const s = awaiting(); const d = path.dirname(s);
    const { signal: _s, ...noSignal } = review;
    const { file, pub } = drop(d, 'n.json', noSignal);
    const r = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('payload missing signal');
  });

  it('unsigned drops are refused unless --allow-unsigned is set (DEV)', () => {
    const s = awaiting(); const d = path.dirname(s);
    const { file, pub } = drop(d, 'u.json', review, false);
    const noSig = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(noSig.status).toBe(2);
    expect(noSig.stderr).toContain('signature file not found');
    const noKey = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file]);
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain('requires --pubkey');
    const dev = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--allow-unsigned', 'true']);
    expect(dev.status).toBe(0);
    expect(dev.stderr).toContain('UNSIGNED');
    expect(JSON.parse(readFileSync(s, 'utf-8')).signalLog[0].verifier).toBe('file-drop-unsigned-DEV');
  });

  it('a body edited after signing fails verification', () => {
    const s = awaiting(); const d = path.dirname(s);
    const { file, pub } = drop(d, 't.json', { ...review, outcome: 'reject' });
    writeFileSync(file, JSON.stringify(review)); // tamper: reject → approve
    const r = signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bad signature');
  });

  it('malformed inputs are refused', () => {
    const s = awaiting(); const d = path.dirname(s);
    const bad = join(d, 'bad.json'); writeFileSync(bad, 'not json');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', bad, '--allow-unsigned', 'true']).stderr).toContain('not JSON');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', join(d, 'nope.json')]).stderr).toContain('file not found');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop']).stderr).toContain('requires --file');
    const { file } = drop(d, 'k.json', review);
    const junkKey = join(d, 'junk.pub'); writeFileSync(junkKey, 'xyz');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', junkKey]).stderr).toContain('pubkey must be');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', join(d, 'none.pub')]).stderr).toContain('pubkey not found');
    const { file: noOutcome } = drop(d, 'o.json', { signal: 'review' }, false);
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'file-drop', '--file', noOutcome, '--allow-unsigned', 'true']).stderr).toContain('missing outcome');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'jwt']).stderr).toContain('unknown verifier');
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--as', 'x']).stderr).toContain('requires --outcome');
    // state unchanged by all of the above
    expect(JSON.parse(readFileSync(s, 'utf-8')).machine.state.stage).toBe(2);
  });
});

describe('signal.mjs guards', () => {
  it('apply/timeout outside an await state are refused', () => {
    const s = newState();
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']).stderr).toContain('not in an await');
    expect(signal(agentDir, ['timeout', '--state', s]).stderr).toContain('not in an await');
  });

  it('timeout before the deadline does not fire', () => {
    const s = awaiting();
    const r = signal(agentDir, ['timeout', '--state', s]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not yet elapsed');
    expect(JSON.parse(readFileSync(s, 'utf-8')).machine.state.stage).toBe(2);
  });

  it('timeout with no recorded start starts the clock instead of firing', () => {
    const s = awaiting();
    const snap = JSON.parse(readFileSync(s, 'utf-8'));
    snap.awaitingSince = null;
    writeFileSync(s, JSON.stringify(snap));
    const r = signal(agentDir, ['timeout', '--state', s]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('clock started');
    const after = JSON.parse(readFileSync(s, 'utf-8'));
    expect(after.machine.state.stage).toBe(2);
    expect(after.awaitingSince).toBeTruthy();
  });

  it('a tampered config whose timeout approves is refused at runtime', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'speckl-tamper-')), 'agent');
    cpSync(agentDir, dir, { recursive: true });
    const cfgPath = join(dir, 'agent-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.awaits[0].timeout.outcome = 'approve';
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const s = awaiting(dir);
    const snap = JSON.parse(readFileSync(s, 'utf-8'));
    snap.awaitingSince = new Date(Date.now() - 48 * 3600_000).toISOString();
    writeFileSync(s, JSON.stringify(snap));
    const r = signal(dir, ['timeout', '--state', s]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('reject-class');
  });

  it('specHash mismatch blocks apply and timeout; init refuses to overwrite', () => {
    const s = awaiting();
    expect(signal(agentDir, ['init', '--state', s]).stderr).toContain('already exists');
    const snap = JSON.parse(readFileSync(s, 'utf-8'));
    snap.specHash = 'stale';
    writeFileSync(s, JSON.stringify(snap));
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']).stderr).toContain('specHash mismatch');
    expect(signal(agentDir, ['timeout', '--state', s]).stderr).toContain('specHash mismatch');
  });

  it('usage errors', () => {
    expect(signal(agentDir, ['bogus']).status).toBe(1);
    expect(signal(agentDir, ['init']).stderr).toContain('missing --state');
    expect(signal(agentDir, ['apply']).stderr).toContain('missing --state');
    expect(signal(agentDir, ['apply', '--state', 'x']).stderr).toContain('missing --verifier');
    expect(signal(agentDir, ['timeout']).stderr).toContain('missing --state');
  });

  it('a signal arriving while an observe tool is in flight keeps its pending call', () => {
    const s = awaiting();
    expect(hook(agentDir, 'pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'r1' }).status).toBe(0);
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']).status).toBe(0);
    expect(hook(agentDir, 'post', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'r1', ok: true }).status).toBe(0);
    expect(hook(agentDir, 'pre', s, { tool: 'open_pr', input: {}, call_id: 'p' }).status).toBe(0);
  });
});

describe('hook.mjs guards', () => {
  it('rejects bad usage and malformed input', () => {
    const s = newState();
    expect(hook(agentDir, 'nope', s, {}).status).toBe(1);
    const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), 'pre'], { input: '{}', encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(hook(agentDir, 'pre', s, 'not json').stdout).toContain('stdin is not JSON');
    expect(hook(agentDir, 'pre', s, { tool: 'run_tests' }).stdout).toContain('call_id are required');
    expect(hook(agentDir, 'post', s, { tool: 'run_tests' }).stdout).toContain('call_id are required');
    const missing = hook(agentDir, 'pre', join(path.dirname(s), 'none.json'), { tool: 'run_tests', input: {}, call_id: '1' });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('state file missing');
  });

  it('post must match the pending call id and tool', () => {
    const s = newState();
    expect(hook(agentDir, 'post', s, { tool: 'run_tests', call_id: '1', ok: true }).stdout).toContain('no matching pending');
    expect(hook(agentDir, 'pre', s, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(hook(agentDir, 'post', s, { tool: 'run_tests', call_id: '2', ok: true }).stdout).toContain('no matching pending');
    expect(hook(agentDir, 'post', s, { tool: 'open_pr', call_id: '1', ok: true }).stdout).toContain('does not match pending');
    expect(hook(agentDir, 'pre', s, { tool: 'request_review', input: {}, call_id: '9' }).stdout).toContain('already pending');
    expect(JSON.parse(readFileSync(s, 'utf-8')).machine.state.stage).toBe(0);
  });

  it('a stale lock from a crashed holder is broken; a fresh one times out', () => {
    const s = newState();
    const lock = s + '.lock';
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(hook(agentDir, 'pre', s, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, '');
    const r = hook(agentDir, 'post', s, { tool: 'run_tests', call_id: '1', ok: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('lock timeout');
  }, 20_000);

  it('a rejected run stays rejected: every act tool is refused', () => {
    const s = awaiting();
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'reject', '--claim_reviewer', 'b']).status).toBe(0);
    for (const tool of ['run_tests', 'request_review', 'open_pr']) {
      expect(hook(agentDir, 'pre', s, { tool, input: {}, call_id: tool }).status).toBe(2);
    }
  });
});

describe('docs/agent-targets.md wiring example', () => {
  it('runs as written', () => {
    const md = readFileSync(join(repoDir, 'docs', 'agent-targets.md'), 'utf-8');
    const block = md.split('## Wiring example')[1].match(/```bash\n([\s\S]*?)```/)![1];
    const work = mkdtempSync(join(tmpdir(), 'speckl-docs-'));
    cpSync(join(repoDir, 'examples', 'AgentPolicy.speckdl'), join(work, 'examples', 'AgentPolicy.speckdl'), { recursive: true });
    const prelude = `set -euo pipefail\nspeckl-compile() { "${process.execPath}" "${viteNode}" --root "${compilerDir}" "${join(compilerDir, 'src', 'index.ts')}" "$@"; }\n`;
    const r = spawnSync('bash', ['-c', prelude + block], { cwd: work, encoding: 'utf-8' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const state = JSON.parse(readFileSync(join(work, 'out', 'agent', 'state.json'), 'utf-8'));
    expect(state.pending.tool).toBe('open_pr');
    expect(state.machine.state.stage).toBe(3);
  }, 60_000);
});
