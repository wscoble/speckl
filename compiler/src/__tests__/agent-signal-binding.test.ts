// PR #4 hardening, round 2: DEV-only cli verifier, signed drops bound to a
// run/expiry/nonce, stuck pending calls (timeout + clear-pending), and the
// runtime side of the `!` reject marker. Drives the generated scripts as
// real processes.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { useStateKey, writeSigned } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };

function compile(spec: string, out: string): void {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
}
function hook(dir: string, cmd: string, state: string, msg: unknown): R {
  const r = spawnSync(process.execPath, [join(dir, 'hook.mjs'), cmd, '--state', state],
    { input: JSON.stringify(msg), encoding: 'utf-8' });
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
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
// Fixture edits play the trusted operator, so they are re-signed.
const write = (s: string, v: Record<string, unknown>) => writeSigned(s, v);
useStateKey();

let agentDir = '';
let vetoDir = '';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

function init(dir = agentDir, dev = false): { state: string; out: R } {
  const state = join(mkdtempSync(join(tmpdir(), 'speckl-bind-')), 'state.json');
  const out = signal(dir, ['init', '--state', state, ...(dev ? ['--dev'] : [])]);
  expect(out.status).toBe(0);
  return { state, out };
}
function awaiting(dir = agentDir, dev = false): string {
  const { state } = init(dir, dev);
  step(dir, state, 'run_tests', '1');
  step(dir, state, 'request_review', '2');
  return state;
}
let n = 0;
function drop(state: string, body: Record<string, unknown>, opts: { sign?: boolean; bind?: boolean } = {}): string[] {
  const dir = path.dirname(state);
  const full = opts.bind === false ? body : {
    run: read(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomUUID(),
    ...body,
  };
  const file = join(dir, `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(full));
  writeFileSync(file, buf);
  if (opts.sign !== false) writeFileSync(file + '.sig', crypto.sign(null, buf, privateKey));
  const pub = join(dir, 'reviewer.pub');
  writeFileSync(pub, pubRaw.toString('base64'));
  return opts.sign === false
    ? ['--verifier', 'file-drop', '--file', file]
    : ['--verifier', 'file-drop', '--file', file, '--pubkey', pub];
}
const approve = { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' } };

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'speckl-bind-out-'));
  compile(example, join(base, 'a'));
  agentDir = join(base, 'a', 'agent');
  // Custom reject name + spec-level pending timeout.
  const veto = join(base, 'Veto.speckdl');
  writeFileSync(veto, readFileSync(example, 'utf-8')
    .replace('require outcome in { approve, reject! }', 'require outcome in { approve, veto! }')
    .replace('on reject  -> Rejected', 'on veto -> Rejected')
    .replace('timeout 24h -> reject', 'timeout 24h -> veto')
    .replace('        await AwaitingReview {', '        pending timeout 2h\n\n        await AwaitingReview {'));
  compile(veto, join(base, 'v'));
  vetoDir = join(base, 'v', 'agent');
}, 120_000);

describe('1. cli verifier is DEV ONLY', () => {
  it('init records a run id and dev=false by default; --dev warns', () => {
    const { state, out } = init();
    const res = JSON.parse(out.stdout);
    expect(res.run).toMatch(/^[0-9a-f]{32}$/);
    expect(res.dev).toBe(false);
    expect(read(state)).toMatchObject({ runId: res.run, dev: false, usedNonces: [], pendingLog: [] });
    const dev = init(agentDir, true);
    expect(JSON.parse(dev.out.stdout).dev).toBe(true);
    expect(dev.out.stderr).toContain('DEV state');
    expect(init().out.stdout).not.toContain(res.run); // fresh run id per state
  });

  it('a production state refuses the cli verifier and leaves state unchanged', () => {
    const s = awaiting();
    const r = signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DEV ONLY');
    expect(r.stderr).toContain('self-approval');
    expect(read(s).machine.state.stage).toBe(2);
    expect(read(s).signalLog).toEqual([]);
  });

  it('a production state refuses unsigned drops even with --allow-unsigned', () => {
    const s = awaiting();
    const r = signal(agentDir, ['apply', '--state', s, ...drop(s, approve, { sign: false }), '--allow-unsigned', 'true']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unsigned drops are DEV ONLY');
  });

  it('a dev state accepts the cli verifier and labels it in the log', () => {
    const s = awaiting(agentDir, true);
    expect(signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']).status).toBe(0);
    expect(read(s).signalLog[0].verifier).toBe('cli-DEV');
  });

  it('the cli verifier refuses on its own without ctx.dev (defense in depth)', async () => {
    const mod = await import(join(agentDir, 'verifiers', 'cli.mjs'));
    expect(mod.devOnly).toBe(true);
    const expectSpec = { signal: 'review', outcomes: ['approve', 'reject'], claims: [] };
    expect((await mod.verify({ outcome: 'approve' }, expectSpec, {})).reason).toContain('DEV ONLY');
    expect((await mod.verify({ outcome: 'approve' }, expectSpec)).ok).toBe(false);
    const ok = await mod.verify({ outcome: 'approve', claim: 'reviewer=z' }, expectSpec, { dev: true, now: 0 });
    expect(ok.signal).toMatchObject({ outcome: 'approve', claims: { reviewer: 'z' }, at: '1970-01-01T00:00:00.000Z' });
    // a single expected outcome is the default; several require --outcome
    expect((await mod.verify({}, { signal: 'clear-pending', outcomes: ['clear'], claims: [] }, { dev: true })).signal.outcome).toBe('clear');
    expect((await mod.verify({}, expectSpec, { dev: true })).reason).toContain('requires --outcome');
  });

  it('generated docs label the cli verifier and note the self-approval risk', () => {
    const md = readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(md).toMatch(/DEV ONLY — `cli` verifier/);
    expect(md).toContain('init --dev');
    const readme = readFileSync(join(agentDir, 'README.md'), 'utf-8');
    expect(readme).toContain('DEV ONLY');
    expect(readme).toContain('agent with shell access');
    expect(readFileSync(join(agentDir, 'hook.mjs'), 'utf-8')).toContain('approve its own work');
    expect(readFileSync(join(agentDir, 'signal.mjs'), 'utf-8')).toContain('self-approval risk');
  });
});

describe('2. signed drops are bound to a run, an expiry and a nonce', () => {
  it('a bound, signed drop applies on a production state and burns its nonce', () => {
    const s = awaiting();
    const args = drop(s, { ...approve, nonce: 'nonce-0001' });
    const r = signal(agentDir, ['apply', '--state', s, ...args]);
    expect(r.status, r.stderr).toBe(0);
    const st = read(s);
    expect(st.machine.state.stage).toBe(3);
    expect(st.usedNonces).toEqual(['nonce-0001']);
    expect(st.signalLog[0]).toMatchObject({ verifier: 'file-drop', run: st.runId, nonce: 'nonce-0001' });
    expect(hook(agentDir, 'pre', s, { tool: 'open_pr', input: {}, call_id: '3' }).status).toBe(0);
  });

  it('a drop signed for another run is refused', () => {
    const other = awaiting();
    const s = awaiting();
    const args = drop(s, { ...approve, run: read(other).runId });
    const r = signal(agentDir, ['apply', '--state', s, ...args]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run mismatch');
    // ...and it still works on the run it was signed for
    expect(signal(agentDir, ['apply', '--state', other, ...args]).status).toBe(0);
  });

  it.each([
    ['missing run', { run: undefined }, /missing run/],
    ['empty run', { run: '' }, /missing run/],
    ['missing expires', { expires: undefined }, /missing expires/],
    ['bad expires', { expires: 'tomorrow-ish' }, /not a valid ISO-8601/],
    ['expired', { expires: new Date(Date.now() - 1000).toISOString() }, /expired at/],
    ['missing nonce', { nonce: undefined }, /nonce must be/],
    ['short nonce', { nonce: 'abc' }, /nonce must be/],
    ['long nonce', { nonce: 'x'.repeat(201) }, /nonce must be/],
    ['numeric nonce', { nonce: 12345678 }, /nonce must be/],
    ['array body', null, /must be a JSON object/],
  ])('refuses a signed drop with %s', (_name, patch, re) => {
    const s = awaiting();
    const st = read(s);
    const base: Record<string, unknown> = {
      ...approve, run: st.runId, expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(),
    };
    let body: any = base;
    if (patch === null) body = [base];
    else for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete body[k]; else body[k] = v; }
    const r = signal(agentDir, ['apply', '--state', s, ...drop(s, body, { bind: false })]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(re);
    expect(read(s).machine.state.stage).toBe(2);
  });

  it('a reused nonce is refused even in a different, validly signed drop', () => {
    const s = awaiting();
    // Loop the await: approve is terminal, so use clear-pending to burn a nonce first.
    expect(hook(agentDir, 'pre', s, { tool: 'read_file', input: { path: 'x' }, call_id: 'r' }).status).toBe(0);
    expect(signal(agentDir, ['clear-pending', '--state', s, ...drop(s, { signal: 'clear-pending', call_id: 'r', nonce: 'shared-nonce' })]).status).toBe(0);
    const r = signal(agentDir, ['apply', '--state', s, ...drop(s, { ...approve, nonce: 'shared-nonce' })]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nonce already used');
  });

  it('accepts hex and base64 signatures; refuses a malformed one', () => {
    for (const enc of ['hex', 'base64'] as const) {
      const s = awaiting();
      const args = drop(s, approve);
      const file = args[args.indexOf('--file') + 1];
      writeFileSync(file + '.sig', crypto.sign(null, readFileSync(file), privateKey).toString(enc));
      const r = signal(agentDir, ['apply', '--state', s, ...args]);
      expect(r.status, enc + r.stderr).toBe(0);
    }
    const s = awaiting();
    const args = drop(s, approve);
    writeFileSync(args[args.indexOf('--file') + 1] + '.sig', 'not a signature');
    const r = signal(agentDir, ['apply', '--state', s, ...args]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('signature must be 64-byte');
  });

  it('dev cli accepts --claim key=value through signal.mjs', () => {
    const s = awaiting(agentDir, true);
    const r = signal(agentDir, ['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim', 'reviewer=dana']);
    expect(r.status, r.stderr).toBe(0);
    expect(read(s).signalLog[0].claims).toEqual({ reviewer: 'dana' });
  });

  it('a state without a run id (older format) is refused with a migration hint', () => {
    const s = awaiting();
    const st = read(s);
    const args = drop(s, approve);
    delete st.runId;
    write(s, st);
    const r = signal(agentDir, ['apply', '--state', s, ...args]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('predates tamper-evident state');
    expect(r.stderr).toContain('signal.mjs init');
  });

  it('the file-drop verifier refuses when the caller has no run id', async () => {
    const s = awaiting();
    const args = drop(s, approve);
    const mod = await import(join(agentDir, 'verifiers', 'file-drop.mjs'));
    const r = await mod.verify({ file: args[args.indexOf('--file') + 1], pubkey: args[args.indexOf('--pubkey') + 1] },
      { signal: 'review', outcomes: ['approve', 'reject'], claims: [] }, {});
    expect(r.reason).toContain('state has no run id');
  });

  it('signal.mjs re-checks run and nonce returned by any verifier', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'speckl-plug-')), 'agent');
    cpSync(agentDir, dir, { recursive: true });
    // A careless plug-in that returns whatever the caller says.
    writeFileSync(join(dir, 'verifiers', 'cli.mjs'), `export async function verify(o, e) {
      return { ok: true, signal: { signal: e.signal, outcome: o.outcome || 'approve', claims: { reviewer: 'p' },
        verifier: 'plug', subject: 'p', at: 'now', evidence: 'plug:' + o.ev, run: o.run, nonce: o.nonce, callId: o.call_id } };
    }\n`);
    const s = awaiting(dir, true);
    const runId = read(s).runId;
    let r = signal(dir, ['apply', '--state', s, '--verifier', 'cli', '--run', 'elsewhere', '--nonce', 'n1', '--ev', '1']);
    expect(r.stderr).toContain('run mismatch');
    // Burn nonce n1 and evidence plug:0 legitimately via clear-pending.
    expect(hook(dir, 'pre', s, { tool: 'read_file', input: { path: 'x' }, call_id: 'r' }).status).toBe(0);
    r = signal(dir, ['clear-pending', '--state', s, '--verifier', 'cli', '--outcome', 'clear', '--call_id', 'r', '--run', runId, '--nonce', 'n1', '--ev', '0']);
    expect(r.status, r.stderr).toBe(0);
    r = signal(dir, ['apply', '--state', s, '--verifier', 'cli', '--run', runId, '--nonce', 'n1', '--ev', '2']);
    expect(r.stderr).toContain('nonce already used');
    r = signal(dir, ['apply', '--state', s, '--verifier', 'cli', '--run', runId, '--nonce', 'n2', '--ev', '0']);
    expect(r.stderr).toContain('replay');
    expect(read(s).machine.state.stage).toBe(2);
  });
});

describe('3. the ! reject marker at runtime', () => {
  it('a custom !-marked outcome (veto!) is the timeout target', () => {
    const cfg = JSON.parse(readFileSync(join(vetoDir, 'agent-config.json'), 'utf-8'));
    expect(cfg.awaits[0].rejects).toEqual(['veto']);
    const s = awaiting(vetoDir);
    const st = read(s); st.awaitingSince = new Date(Date.now() - 25 * 3600_000).toISOString(); write(s, st);
    const r = signal(vetoDir, ['timeout', '--state', s]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).outcome).toBe('veto');
    expect(read(s).machine.state.stage).toBe(4);
    expect(readFileSync(join(vetoDir, 'AGENTS.md'), 'utf-8')).toContain('`veto` (reject)');
  });

  it('a tampered config without the marker cannot fire a timeout', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'speckl-nomark-')), 'agent');
    cpSync(agentDir, dir, { recursive: true });
    const cfgPath = join(dir, 'agent-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    delete cfg.awaits[0].rejects; // name still says "reject"; the marker is what counts
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const s = awaiting(dir);
    const st = read(s); st.awaitingSince = new Date(Date.now() - 25 * 3600_000).toISOString(); write(s, st);
    const r = signal(dir, ['timeout', '--state', s]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('!-marked reject');
    expect(read(s).machine.state.stage).toBe(2);
  });
});

describe('4. stuck pending calls', () => {
  function age(s: string, ms: number): void {
    const st = read(s); st.pending.since = new Date(Date.now() - ms).toISOString(); write(s, st);
  }

  it('the default pending timeout is 10m and a spec can set its own', () => {
    expect(JSON.parse(readFileSync(join(agentDir, 'agent-config.json'), 'utf-8')).pendingTimeout)
      .toEqual({ durationMs: 600_000, durationText: '10m' });
    expect(JSON.parse(readFileSync(join(vetoDir, 'agent-config.json'), 'utf-8')).pendingTimeout)
      .toEqual({ durationMs: 7_200_000, durationText: '2h' });
    expect(readFileSync(join(vetoDir, 'AGENTS.md'), 'utf-8')).toContain('pending call older than `2h`');
  });

  it('pre stamps the pending call; a live one still blocks with a hint', () => {
    const { state } = init();
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(Date.parse(read(state).pending.since)).toBeGreaterThan(Date.now() - 60_000);
    age(state, 9 * 60_000);
    const r = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('clears as failed after 10m');
    expect(r.stdout).toContain('clear-pending');
  });

  it('an expired pending call is cleared as failed by the next pre; state does not advance', () => {
    const { state } = init();
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    age(state, 10 * 60_000 + 1);
    expect(hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' }).status).toBe(0);
    const st = read(state);
    expect(st.machine.state.stage).toBe(0);
    expect(st.machine.state.testsPassed).toBe(false);
    expect(st.pending.call_id).toBe('2');
    expect(st.pendingLog).toEqual([expect.objectContaining({ call_id: '1', tool: 'run_tests', cleared: 'timeout' })]);
  });

  it('the clear is persisted even when the new call is then denied', () => {
    const { state } = init();
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    age(state, 11 * 60_000);
    expect(hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '2' }).status).toBe(2);
    const st = read(state);
    expect(st.pending).toBeNull();
    expect(st.pendingLog).toHaveLength(1);
  });

  it('a late post for an expired call is denied and does not advance', () => {
    const { state } = init();
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    age(state, 11 * 60_000);
    const r = hook(agentDir, 'post', state, { tool: 'run_tests', input: {}, call_id: '1', ok: true });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('expired; cleared as failed');
    const st = read(state);
    expect(st.machine.state.stage).toBe(0);
    expect(st.pending).toBeNull();
  });

  it('respects a spec-level pending timeout (2h)', () => {
    const { state } = init(vetoDir);
    expect(hook(vetoDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    age(state, 60 * 60_000);
    expect(hook(vetoDir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' }).stdout).toContain('after 2h');
    age(state, 2 * 3600_000);
    expect(hook(vetoDir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' }).status).toBe(0);
  });

  it('an unstamped pending call (older state format) starts its clock instead of clearing', () => {
    const { state } = init();
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const st = read(state); delete st.pending.since; write(state, st);
    expect(hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' }).status).toBe(2);
    const after = read(state);
    expect(after.pending.call_id).toBe('1');
    expect(Date.parse(after.pending.since)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a tampered non-positive pendingTimeout falls back to the 10m default', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'speckl-pt-')), 'agent');
    cpSync(agentDir, dir, { recursive: true });
    const cfgPath = join(dir, 'agent-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.pendingTimeout = { durationMs: 0, durationText: '0s' };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const { state } = init(dir);
    expect(hook(dir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(hook(dir, 'pre', state, { tool: 'read_file', input: { path: 'a' }, call_id: '2' }).status).toBe(2);
  });
});

describe('4b. signal.mjs clear-pending', () => {
  function pendingState(dev = false): string {
    const { state } = init(agentDir, dev);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'c1' }).status).toBe(0);
    return state;
  }

  it('a signed clear-pending drop naming the call clears it as failed', () => {
    const s = pendingState();
    const r = signal(agentDir, ['clear-pending', '--state', s, ...drop(s, { signal: 'clear-pending', call_id: 'c1', subject: 'ops' })]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).cleared).toBe('c1');
    const st = read(s);
    expect(st.pending).toBeNull();
    expect(st.machine.state.stage).toBe(0);
    expect(st.pendingLog[0]).toMatchObject({ call_id: 'c1', cleared: 'signal', verifier: 'file-drop', subject: 'ops' });
    expect(st.usedNonces).toHaveLength(1);
    // the agent can call again afterwards
    step(agentDir, s, 'run_tests', 'c2');
    expect(read(s).machine.state.stage).toBe(1);
  });

  it('refuses without the right call_id, signal or outcome', () => {
    const s = pendingState();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ signal: 'clear-pending', call_id: 'other' }, /call_id does not match/],
      [{ signal: 'clear-pending' }, /call_id does not match/],
      [{ signal: 'review', call_id: 'c1' }, /wrong signal: expected clear-pending/],
      [{ signal: 'clear-pending', call_id: 'c1', outcome: 'approve' }, /disallowed outcome/],
    ];
    for (const [body, re] of cases) {
      const r = signal(agentDir, ['clear-pending', '--state', s, ...drop(s, body)]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(re);
    }
    expect(read(s).pending.call_id).toBe('c1');
  });

  it('a clear drop cannot be replayed', () => {
    const s = pendingState();
    const args = drop(s, { signal: 'clear-pending', call_id: 'c1' });
    expect(signal(agentDir, ['clear-pending', '--state', s, ...args]).status).toBe(0);
    expect(hook(agentDir, 'pre', s, { tool: 'run_tests', input: {}, call_id: 'c1' }).status).toBe(0);
    const again = signal(agentDir, ['clear-pending', '--state', s, ...args]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/nonce already used|replay/);
  });

  it('the cli verifier can clear only in a dev state', () => {
    const prod = pendingState();
    const r = signal(agentDir, ['clear-pending', '--state', prod, '--verifier', 'cli', '--call_id', 'c1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DEV ONLY');
    const dev = pendingState(true);
    expect(signal(agentDir, ['clear-pending', '--state', dev, '--verifier', 'cli', '--call_id', 'c1']).status).toBe(0);
    expect(read(dev).pendingLog[0].verifier).toBe('cli-DEV');
  });

  it('guards: no pending call, missing args, stale spec', () => {
    const { state } = init();
    expect(signal(agentDir, ['clear-pending', '--state', state, '--verifier', 'cli']).stderr).toContain('no pending tool call');
    expect(signal(agentDir, ['clear-pending', '--state', state]).stderr).toContain('missing --verifier');
    expect(signal(agentDir, ['clear-pending', '--verifier', 'cli']).stderr).toContain('missing --state');
    const s = pendingState();
    const st = read(s); st.specHash = 'x'; write(s, st);
    expect(signal(agentDir, ['clear-pending', '--state', s, '--verifier', 'cli']).stderr).toContain('specHash mismatch');
    expect(signal(agentDir, ['bogus']).stderr).toContain('clear-pending');
  });
});

describe('5. plain-JavaScript machine', () => {
  it('the emitted .mjs has no TypeScript syntax and runs without typescript installed', () => {
    const js = readFileSync(join(agentDir, 'AgentPolicy.mjs'), 'utf-8');
    expect(js).not.toMatch(/\binterface\s+\w+\s*\{/);
    expect(js).not.toMatch(/\bas const\b/);
    expect(js).not.toMatch(/^export type /m);
    // Run it from a directory with no node_modules anywhere above it.
    const iso = mkdtempSync(join(tmpdir(), 'speckl-nots-'));
    mkdirSync(join(iso, 'm'));
    writeFileSync(join(iso, 'm', 'machine.mjs'), js);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { AgentPolicyMachine as M } from ${JSON.stringify(join(iso, 'm', 'machine.mjs'))};
       const m = new M(); m.RunTests(); m.RequestReview(); m.__signal_review_approve();
       const r = M.restore(JSON.parse(JSON.stringify(m.serialize())));
       console.log(JSON.stringify([r.stage, r.can('OpenPR', {}), M.ACTIONS.ReadFile]));`],
      { cwd: iso, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([3, true, ['path']]);
  });
});
