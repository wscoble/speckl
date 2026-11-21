// Tamper-evident agent state: HMAC over the state + hash-chained log that is
// replayed on load. Every hand edit must be denied (exit 2).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
type R = { status: number | null; stdout: string; stderr: string };

const KEY = useStateKey();
const noKeyEnv = () => { const e = { ...process.env }; delete e.SPECKL_STATE_KEY_FILE; return e; };

function run(file: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): R {
  const r = spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf-8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
let agentDir = '';
const hook = (cmd: string, s: string, msg: object, env?: NodeJS.ProcessEnv, extra: string[] = []) =>
  run(join(agentDir, 'hook.mjs'), [cmd, '--state', s, ...extra], JSON.stringify(msg), env);
const signal = (args: string[], env?: NodeJS.ProcessEnv) => run(join(agentDir, 'signal.mjs'), args, undefined, env);
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
/** An agent-style edit: plain write, no re-signing. */
const tamper = (s: string, f: (st: any) => void) => { const st = read(s); f(st); writeFileSync(s, JSON.stringify(st, null, 2)); };
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

function newState(opts: { dev?: boolean; env?: NodeJS.ProcessEnv; extra?: string[] } = {}): string {
  const s = join(mkdtempSync(join(tmpdir(), 'speckl-int-')), 'state.json');
  const r = signal(['init', '--state', s, ...(opts.dev ? ['--dev'] : []), ...(opts.extra ?? [])], opts.env);
  expect(r.status, r.stderr).toBe(0);
  return s;
}
function step(s: string, tool: string, id: string, env?: NodeJS.ProcessEnv, extra?: string[]) {
  expect(hook('pre', s, { tool, input: {}, call_id: id }, env, extra).status).toBe(0);
  expect(hook('post', s, { tool, input: {}, call_id: id, ok: true }, env, extra).status).toBe(0);
}
function awaiting(opts: { dev?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const s = newState(opts);
  step(s, 'run_tests', '1', opts.env);
  step(s, 'request_review', '2', opts.env);
  return s;
}
const openPr = (s: string, env?: NodeJS.ProcessEnv) => hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'x' }, env);
const readFile = (s: string, env?: NodeJS.ProcessEnv) => hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'rf' }, env);

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-int-out-'));
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), example, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr);
  agentDir = join(out, 'agent');
}, 60_000);

describe('happy path', () => {
  it('every change is logged, chained and signed; signals and clears re-sign', () => {
    const s = awaiting();
    let st = read(s);
    expect(st.keyId).toBe(sha(Buffer.from(readFileSync(KEY, 'utf-8').trim(), 'hex') as any).slice(0, 16));
    expect(st.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(st.log.map((e: any) => [e.kind, e.seq])).toEqual([['pre', 0], ['post', 1], ['pre', 2], ['post', 3]]);
    expect(st.head).toBe(st.log[3].hash);
    expect(st.log[1].prev).toBe(st.log[0].hash);
    // clear-pending and apply (cli verifier, so a dev state) re-sign
    const d = awaiting({ dev: true });
    expect(readFile(d).status).toBe(0);
    expect(signal(['clear-pending', '--state', d, '--verifier', 'cli', '--call_id', 'rf']).status).toBe(0);
    expect(signal(['apply', '--state', d, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']).status).toBe(0);
    st = read(d);
    expect(st.log.slice(-3).map((e: any) => e.kind)).toEqual(['pre', 'clear', 'signal']);
    expect(st.mac).toBeTruthy();
    expect(openPr(d).status).toBe(0);
    // timeout re-signs too
    const t = awaiting();
    writeSigned(t, { ...read(t), awaitingSince: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect(signal(['timeout', '--state', t]).status).toBe(0);
    expect(read(t).log.at(-1)).toMatchObject({ kind: 'timeout', outcome: 'reject' });
    expect(readFile(t).status).toBe(0);
  });

  it('init creates the key file (0600) when missing; --key works without the env var', () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), 'speckl-newkey-')), 'nested', 'k.key');
    const s = newState({ env: noKeyEnv(), extra: ['--key', keyFile] });
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(hook('pre', s, { tool: 'run_tests', input: {}, call_id: '1' }, noKeyEnv(), ['--key', keyFile]).status).toBe(0);
    expect(hook('post', s, { tool: 'run_tests', input: {}, call_id: '1', ok: true }, noKeyEnv(), ['--key', keyFile]).status).toBe(0);
    expect(read(s).machine.state.stage).toBe(1);
    // and the hook denies when it isn't given the key
    const r = hook('pre', s, { tool: 'request_review', input: {}, call_id: '2' }, noKeyEnv());
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('missing state key');
  });

  it('init refuses a non-dev state without a key', () => {
    const s = join(mkdtempSync(join(tmpdir(), 'speckl-int-')), 'state.json');
    const r = signal(['init', '--state', s], noKeyEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('init needs a state key');
    expect(existsSync(s)).toBe(false);
  });
});

describe('tampering is denied (exit 2)', () => {
  it('hand-setting stage=3 does not let open_pr through (the reported hole)', () => {
    const s = awaiting();
    tamper(s, st => { st.machine.state.stage = 3; });
    const r = openPr(s);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('state signature mismatch');
  });

  it('…even if the attacker strips the signature', () => {
    const s = awaiting();
    tamper(s, st => { st.machine.state.stage = 3; delete st.mac; });
    const r = openPr(s);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('state signature missing');
  });

  it('a deleted signature alone is denied', () => {
    const s = awaiting();
    tamper(s, st => { delete st.mac; });
    expect(readFile(s).status).toBe(2);
  });

  it('a tampered pending call is denied', () => {
    const s = newState();
    expect(hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'p' }).status).toBe(0);
    tamper(s, st => { st.pending.tool = 'run_tests'; st.pending.action = 'RunTests'; });
    const r = hook('post', s, { tool: 'run_tests', input: {}, call_id: 'p', ok: true });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('state integrity');
    const s2 = newState();
    expect(hook('pre', s2, { tool: 'run_tests', input: {}, call_id: 'p' }).status).toBe(0);
    tamper(s2, st => { st.pending = null; });
    expect(hook('pre', s2, { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }).status).toBe(2);
  });

  it('a tampered nonce list is denied', () => {
    const s = awaiting({ dev: true });
    expect(readFile(s).status).toBe(0);
    expect(signal(['clear-pending', '--state', s, '--verifier', 'cli', '--call_id', 'rf']).status).toBe(0);
    tamper(s, st => { st.usedNonces = []; st.appliedEvidence = []; });
    const r = signal(['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('state integrity');
  });

  it('a state signed with a different key is denied', () => {
    const s = awaiting();
    const other = join(mkdtempSync(join(tmpdir(), 'speckl-k2-')), 'k');
    writeFileSync(other, crypto.randomBytes(32).toString('hex'));
    const r = hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }, { ...process.env, SPECKL_STATE_KEY_FILE: other });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('different key');
    // re-signed with the other key but keyId left alone: still caught
    writeSigned(s, read(s), other);
    expect(hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }).stdout).toContain('signature mismatch');
  });

  it('a missing or malformed key file is denied', () => {
    const s = awaiting();
    const missing = hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }, { ...process.env, SPECKL_STATE_KEY_FILE: '/nonexistent/k' });
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain('state key not found');
    const bad = join(mkdtempSync(join(tmpdir(), 'speckl-k3-')), 'k');
    writeFileSync(bad, 'short');
    const malformed = hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }, { ...process.env, SPECKL_STATE_KEY_FILE: bad });
    expect(malformed.status).toBe(2);
    expect(malformed.stdout).toContain('64 hex chars');
  });

  // The remaining cases are re-signed with the real key, to prove the log
  // chain catches them on its own (e.g. an operator mistake or a key leak
  // without full understanding of the chain).
  it('log truncation is denied', () => {
    const s = awaiting();
    const st = read(s);
    st.log = st.log.slice(0, 2);
    writeSigned(s, st);
    expect(readFile(s).stdout).toContain('head mismatch');
    st.head = st.log[1].hash; // consistent truncation: machine no longer matches the log
    writeSigned(s, st);
    expect(readFile(s).stdout).toContain('machine state does not match the log');
  });

  it('log reordering and edited entries are denied', () => {
    const s = awaiting();
    const st = read(s);
    [st.log[0], st.log[2]] = [st.log[2], st.log[0]];
    writeSigned(s, st);
    expect(readFile(s).stdout).toContain('log chain broken at entry 0');
    const s2 = awaiting();
    const st2 = read(s2);
    st2.log[1].ok = false;
    writeSigned(s2, st2);
    expect(readFile(s2).stdout).toContain('log chain broken at entry 1');
  });

  it('a rebuilt, internally consistent chain still fails without the key', () => {
    // Forge: append a fake approve signal with correct hashes; can't sign.
    const s = awaiting();
    const st = read(s);
    const body = { kind: 'signal', signal: 'review', outcome: 'approve', evidence: 'forged', seq: st.log.length, prev: st.head };
    const hash = sha(canonical(body));
    st.log.push({ ...body, hash }); st.head = hash; st.appliedEvidence.push('forged'); st.machine.state.stage = 3;
    writeFileSync(s, JSON.stringify(st));
    expect(openPr(s).stdout).toContain('signature mismatch');
    // with the key it would verify — showing the chain/replay itself is consistent
    writeSigned(s, st);
    expect(openPr(s).status).toBe(0);
  });

  it('replay rejects impossible logs', () => {
    const mk = (entries: object[]) => {
      const s = newState();
      const st = read(s);
      let prev = st.head;
      st.log = entries.map((e, i) => { const b = { ...e, seq: i, prev }; const h = sha(canonical(b)); prev = h; return { ...b, hash: h }; });
      st.head = prev;
      writeSigned(s, st);
      return readFile(s).stdout;
    };
    expect(mk([{ kind: 'post', call_id: 'a', ok: true }])).toContain('post without pending');
    expect(mk([{ kind: 'clear', call_id: 'a' }])).toContain('clear without pending');
    expect(mk([{ kind: 'pre', call_id: 'a', tool: 'run_tests', action: 'RunTests', input: {} }, { kind: 'pre', call_id: 'b', tool: 'run_tests', action: 'RunTests', input: {} }])).toContain('pre while pending');
    expect(mk([{ kind: 'pre', call_id: 'a', tool: 'open_pr', action: 'RunTests', input: {} }, { kind: 'post', call_id: 'a', ok: true }])).toContain('unknown tool in log');
    expect(mk([{ kind: 'signal', signal: 'deploy', outcome: 'approve' }])).toContain('unknown signal outcome');
    expect(mk([{ kind: 'bogus' }])).toContain('unknown log entry');
    expect(mk([{ kind: 'signers' }])).toContain('signers entry missing set');
    expect(mk([{ kind: 'signers', signers: [{ name: 1, key: 'ab'.repeat(32) }] }])).toContain('signers entry is malformed');
    expect(mk([{ kind: 'signers', signers: [{ name: 'a', key: 'ab'.repeat(32) }] }])).toContain('pinned signers do not match the log');
  });

  it('signal.mjs refuses a tampered state too', () => {
    const s = awaiting({ dev: true });
    tamper(s, st => { st.awaitingSince = new Date(0).toISOString(); });
    const r = signal(['timeout', '--state', s]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('state signature mismatch');
  });

  it('old state files are refused with a migration message', () => {
    const s = newState();
    writeFileSync(s, JSON.stringify({ specHash: read(s).specHash, machine: read(s).machine, pending: null }));
    const r = readFile(s);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('predates tamper-evident state');
    expect(r.stdout).toContain('signal.mjs init');
    writeFileSync(s, 'null');
    expect(readFile(s).status).not.toBe(0);
  });
});

describe('dev mode', () => {
  it('an unsigned dev state works with a warning; the chain is still enforced', () => {
    const env = noKeyEnv();
    const s = awaiting({ dev: true, env });
    expect(read(s).mac).toBeUndefined();
    const ok = readFile(s, env);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain('DEV state: no state key configured');
    tamper(s, st => { st.pending = null; st.machine.state.stage = 3; });
    const r = openPr(s, env);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('does not match the log');
  });

  it('init --dev without a key warns that the state is unsigned', () => {
    const s = join(mkdtempSync(join(tmpdir(), 'speckl-int-')), 'state.json');
    const r = signal(['init', '--state', s, '--dev'], noKeyEnv());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).signed).toBe(false);
    expect(r.stderr).toContain('unsigned');
  });

  it('flipping a signed state to dev and stripping the MAC is denied when a key is configured', () => {
    const s = awaiting();
    tamper(s, st => { st.dev = true; delete st.mac; });
    const r = readFile(s);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('a key is configured');
  });

  it('a non-dev state cannot be used without the key', () => {
    const s = awaiting();
    const r = readFile(s, noKeyEnv());
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('missing state key');
    expect(signal(['timeout', '--state', s], noKeyEnv()).stderr).toContain('missing state key');
  });
});
