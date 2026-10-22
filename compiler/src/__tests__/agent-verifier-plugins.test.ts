// Verifier plug-ins: `signal.mjs init --plugins <file>` pins each module by
// realpath + sha256 (and its config) in the signed state; `--verifier
// plugin:<name>` loads only the pinned bytes. Every load error, wrong shape,
// throw or timeout denies. Drives the generated scripts as real processes,
// with small fixture plug-ins and the HMAC webhook example from
// docs/verifier-plugins.md.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { useStateKey, writeSigned } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const hmacExample = join(compilerDir, '..', 'examples', 'verifier-plugins', 'hmac-webhook.mjs');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));

function run(file: string, args: string[], input?: string): R {
  const r = spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const signal = (args: string[]) => run(join(agentDir, 'signal.mjs'), args);
const hook = (cmd: string, state: string, msg: unknown) => run(join(agentDir, 'hook.mjs'), [cmd, '--state', state], JSON.stringify(msg));
function step(state: string, tool: string, id: string): void {
  expect(hook('pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
  expect(hook('post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
}

useStateKey();
let agentDir = '';
let work = '';

// A fixture plug-in whose behaviour is chosen by its pinned config.mode.
const SCRIPTED = `
export const name = 'scripted';
export function checkConfig(c) {
  if (c.mode === 'bad-config') return { ok: false, reason: 'mode bad-config' };
  if (c.mode === 'config-throws') throw new Error('checkConfig blew up');
  return { ok: true };
}
export async function verify(opts, expect, ctx) {
  const m = ctx.config.mode;
  if (m === 'throw') throw new Error('library exploded');
  if (m === 'hang') return new Promise(() => { setInterval(() => {}, 1000); });
  if (m === 'null') return null;
  if (m === 'reject') return { ok: false, reason: 'scripted says no' };
  if (m === 'truthy') return { ok: 'yes', signal: {} };
  if (m === 'no-evidence') return { ok: true, signal: { signal: expect.signal, outcome: opts.outcome, claims: {} } };
  return { ok: true, signal: {
    signal: expect.signal, outcome: opts.outcome, claims: { reviewer: 'carol' },
    subject: 'scripted-subject', verifier: 'self-chosen-label',
    evidence: 'scripted:' + (opts.evidence || Math.random()),
    run: m === 'wrong-run' ? 'not-this-run' : ctx.runId,
    nonce: opts.nonce, callId: opts.call_id,
  } };
}
`;

function writePlugin(name: string, src: string): string {
  const f = join(work, name);
  writeFileSync(f, src);
  return f;
}
let n = 0;
function pluginsFile(spec: unknown): string {
  const f = join(work, `plugins-${n++}.json`);
  writeFileSync(f, JSON.stringify(spec));
  return f;
}
function newState(): string {
  return join(mkdtempSync(join(tmpdir(), 'speckl-plug-')), 'state.json');
}
function initWith(spec: unknown, extra: string[] = []): { state: string; out: R } {
  const state = newState();
  return { state, out: signal(['init', '--state', state, '--plugins', pluginsFile(spec), ...extra]) };
}
function awaitingWith(spec: unknown): string {
  const { state, out } = initWith(spec);
  expect(out.status, out.stderr).toBe(0);
  step(state, 'run_tests', '1');
  step(state, 'request_review', '2');
  return state;
}

let scripted = '';
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'speckl-plug-work-'));
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), example, '-t', 'agent', '-o', join(work, 'out')],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
  agentDir = join(work, 'out', 'agent');
  scripted = writePlugin('scripted.mjs', SCRIPTED);
}, 120_000);

describe('init --plugins pins modules in the signed state', () => {
  it('records realpath, sha256, timeout and config, and prints the pins', () => {
    const { state, out } = initWith({ s: { module: scripted, config: { mode: 'ok' } } });
    expect(out.status, out.stderr).toBe(0);
    const digest = sha(readFileSync(scripted));
    expect(JSON.parse(out.stdout).plugins).toEqual({ s: digest });
    expect(read(state).plugins).toEqual({ s: { module: scripted, sha256: digest, timeoutMs: 30000, config: { mode: 'ok' } } });
    // hook.mjs accepts a state with pins (they are part of the genesis hash)
    step(state, 'run_tests', '1');
  });

  it('an explicit sha256 must match the module', () => {
    const good = initWith({ s: { module: scripted, sha256: sha(readFileSync(scripted)) } });
    expect(good.out.status, good.out.stderr).toBe(0);
    const bad = initWith({ s: { module: scripted, sha256: '0'.repeat(64) } });
    expect(bad.out.status).not.toBe(0);
    expect(bad.out.stderr).toContain('sha256 mismatch');
  });

  it('refuses unusable plug-in specs and creates no state', () => {
    const noVerify = writePlugin('no-verify.mjs', 'export const name = "x";');
    const importThrows = writePlugin('import-throws.mjs', 'throw new Error("top-level boom");');
    const devOnly = writePlugin('dev-only.mjs', 'export const devOnly = true; export async function verify() { return { ok: false, reason: "x" }; }');
    const notJson = join(work, 'not-json.json'); writeFileSync(notJson, '{');
    const cases: Array<[string[], string]> = [
      [['--plugins'], '--plugins needs a JSON file'],
      [['--plugins', join(work, 'missing.json')], 'cannot read'],
      [['--plugins', notJson], 'cannot read'],
      [['--plugins', pluginsFile({})], 'expected {'],
      [['--plugins', pluginsFile([1])], 'expected {'],
      [['--plugins', pluginsFile({ 'Bad Name': { module: scripted } })], 'invalid plug-in name'],
      [['--plugins', pluginsFile({ 'file-drop': { module: scripted } })], 'invalid plug-in name'],
      [['--plugins', pluginsFile({ s: {} })], 'module path required'],
      [['--plugins', pluginsFile({ s: { module: join(work, 'nope.mjs') } })], 'module not found'],
      [['--plugins', pluginsFile({ s: { module: scripted, timeoutMs: 5 } })], 'timeoutMs'],
      [['--plugins', pluginsFile({ s: { module: scripted, timeoutMs: 1.5 } })], 'timeoutMs'],
      [['--plugins', pluginsFile({ s: { module: noVerify } })], 'does not export verify'],
      [['--plugins', pluginsFile({ s: { module: importThrows } })], 'failed to load: top-level boom'],
      [['--plugins', pluginsFile({ s: { module: devOnly } })], 'DEV ONLY'],
      [['--plugins', pluginsFile({ s: { module: scripted, config: { mode: 'bad-config' } } })], 'config rejected: mode bad-config'],
      [['--plugins', pluginsFile({ s: { module: scripted, config: { mode: 'config-throws' } } })], 'config rejected: checkConfig blew up'],
    ];
    for (const [extra, msg] of cases) {
      const state = newState();
      const r = signal(['init', '--state', state, ...extra]);
      expect(r.status, msg).not.toBe(0);
      expect(r.stderr, msg).toContain(msg);
      expect(() => readFileSync(state), msg).toThrow();
    }
  });

  it('a DEV ONLY plug-in is accepted in a --dev state', () => {
    const devOnly = writePlugin('dev-only-ok.mjs', 'export const devOnly = true; export async function verify() { return { ok: false, reason: "x" }; }');
    expect(initWith({ d: { module: devOnly } }, ['--dev']).out.status).toBe(0);
  });

  it('editing the pins in state.json is detected, with or without the key', () => {
    const { state } = initWith({ s: { module: scripted, config: { mode: 'reject' } } });
    step(state, 'run_tests', '1');
    const raw = read(state);
    raw.plugins.s.config.mode = 'ok';
    writeFileSync(state, JSON.stringify(raw));
    const unsigned = hook('pre', state, { tool: 'request_review', input: {}, call_id: '2' });
    expect(unsigned.status).toBe(2);
    expect(unsigned.stdout + unsigned.stderr).toContain('signature mismatch');
    // Even a re-signed edit breaks the chain: the pins are in the genesis hash.
    const { mac: _m, ...rest } = raw;
    writeSigned(state, rest);
    const resigned = signal(['apply', '--state', state, '--verifier', 'plugin:s', '--outcome', 'approve']);
    expect(resigned.status).toBe(2);
    expect(resigned.stderr).toContain('log chain broken');
  });
});

describe('--verifier plugin:<name> fails closed', () => {
  it('a well-formed result is applied with the pinned label', () => {
    const s = awaitingWith({ s: { module: scripted, config: { mode: 'ok' } } });
    const r = signal(['apply', '--state', s, '--verifier', 'plugin:s', '--outcome', 'approve', '--nonce', 'nonce-0001']);
    expect(r.status, r.stderr).toBe(0);
    const st = read(s);
    expect(st.machine.state.stage).toBe(3);
    expect(st.signalLog[0]).toMatchObject({ verifier: 'plugin:s', subject: 'scripted-subject', outcome: 'approve' });
    expect(st.usedNonces).toEqual(['nonce-0001']);
  });

  it('refuses unpinned, unknown and pin-less states', () => {
    const s = awaitingWith({ s: { module: scripted, config: { mode: 'ok' } } });
    expect(signal(['apply', '--state', s, '--verifier', 'plugin:other', '--outcome', 'approve']).stderr).toContain('plug-in not pinned in this state: other');
    expect(signal(['apply', '--state', s, '--verifier', 'plugin:constructor', '--outcome', 'approve']).stderr).toContain('not pinned');
    expect(signal(['apply', '--state', s, '--verifier', 'jwt']).stderr).toContain('plug-ins: plugin:<name>');
    const plain = newState();
    expect(signal(['init', '--state', plain]).status).toBe(0);
    step(plain, 'run_tests', '1');
    step(plain, 'request_review', '2');
    expect(signal(['apply', '--state', plain, '--verifier', 'plugin:s', '--outcome', 'approve']).stderr).toContain('not pinned');
    expect(read(s).machine.state.stage).toBe(2);
  });

  it('denies when the pinned module changed, vanished or became a symlink', () => {
    const mod = writePlugin('mutable.mjs', SCRIPTED);
    const spec = { m: { module: mod, config: { mode: 'ok' } } };
    const s1 = awaitingWith(spec);
    writeFileSync(mod, SCRIPTED + '\n// swapped\n');
    const changed = signal(['apply', '--state', s1, '--verifier', 'plugin:m', '--outcome', 'approve']);
    expect(changed.status).toBe(2);
    expect(changed.stderr).toContain('plug-in module sha256 mismatch');
    expect(read(s1).machine.state.stage).toBe(2);

    writeFileSync(mod, SCRIPTED);
    const s2 = awaitingWith(spec);
    unlinkSync(mod);
    const gone = signal(['apply', '--state', s2, '--verifier', 'plugin:m', '--outcome', 'approve']);
    expect(gone.status).toBe(2);
    expect(gone.stderr).toContain('plug-in module not found');

    // Same bytes behind a symlink: the realpath no longer matches the pin.
    const target = writePlugin('target.mjs', SCRIPTED);
    symlinkSync(target, mod);
    const linked = signal(['apply', '--state', s2, '--verifier', 'plugin:m', '--outcome', 'approve']);
    expect(linked.status).toBe(2);
    expect(linked.stderr).toContain('plug-in module path changed');
    expect(read(s2).machine.state.stage).toBe(2);
    rmSync(mod);
  });

  it('a throw, hang, null, truthy-but-not-true or malformed result denies', () => {
    const cases: Array<[string, string]> = [
      ['throw', 'plug-in s threw: library exploded'],
      ['null', 'returned no result'],
      ['reject', 'verifier rejected: scripted says no'],
      ['truthy', 'returned a malformed result'],
      ['no-evidence', 'returned a malformed signal'],
      ['wrong-run', 'run mismatch'],
    ];
    for (const [mode, msg] of cases) {
      const s = awaitingWith({ s: { module: scripted, config: { mode } } });
      const r = signal(['apply', '--state', s, '--verifier', 'plugin:s', '--outcome', 'approve']);
      expect(r.status, mode).toBe(2);
      expect(r.stderr, mode).toContain(msg);
      expect(read(s).machine.state.stage, mode).toBe(2);
      expect(read(s).signalLog, mode).toEqual([]);
    }
    const s = awaitingWith({ s: { module: scripted, timeoutMs: 300, config: { mode: 'hang' } } });
    const t0 = Date.now();
    const r = signal(['apply', '--state', s, '--verifier', 'plugin:s', '--outcome', 'approve']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('timed out after 300ms');
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(read(s).machine.state.stage).toBe(2);
  });

  it('signal.mjs still applies its own run/outcome/nonce/evidence checks to plug-in results', () => {
    const s = awaitingWith({ s: { module: scripted, config: { mode: 'ok' } } });
    expect(signal(['apply', '--state', s, '--verifier', 'plugin:s', '--outcome', 'merge']).stderr).toContain('disallowed outcome: merge');
    // clear-pending twice with the same nonce: the second is refused by signal.mjs.
    const p = newState();
    expect(signal(['init', '--state', p, '--plugins', pluginsFile({ s: { module: scripted, config: { mode: 'ok' } } })]).status).toBe(0);
    expect(hook('pre', p, { tool: 'run_tests', input: {}, call_id: 'c1' }).status).toBe(0);
    const ok = signal(['clear-pending', '--state', p, '--verifier', 'plugin:s', '--outcome', 'clear', '--call_id', 'c1', '--nonce', 'same-nonce-1']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(hook('pre', p, { tool: 'run_tests', input: {}, call_id: 'c2' }).status).toBe(0);
    const again = signal(['clear-pending', '--state', p, '--verifier', 'plugin:s', '--outcome', 'clear', '--call_id', 'c2', '--nonce', 'same-nonce-1']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('nonce already used: same-nonce-1');
    const replay = signal(['clear-pending', '--state', p, '--verifier', 'plugin:s', '--outcome', 'clear', '--call_id', 'c2', '--nonce', 'fresh-nonce-2', '--evidence', 'e1']);
    expect(replay.status, replay.stderr).toBe(0);
    expect(hook('pre', p, { tool: 'run_tests', input: {}, call_id: 'c3' }).status).toBe(0);
    expect(signal(['clear-pending', '--state', p, '--verifier', 'plugin:s', '--outcome', 'clear', '--call_id', 'c3', '--nonce', 'fresh-nonce-3', '--evidence', 'e1']).stderr)
      .toContain('replay: evidence already applied');
  });
});

describe('worked example: HMAC webhook plug-in (docs/verifier-plugins.md)', () => {
  let secretFile = '';
  let mod = '';
  const secret = crypto.randomBytes(32);
  beforeAll(() => {
    secretFile = join(work, 'webhook.secret');
    writeFileSync(secretFile, secret.toString('hex'));
    mod = join(work, 'hmac-webhook.mjs');
    copyFileSync(hmacExample, mod);
  });
  const spec = () => ({ 'hmac-webhook': { module: mod, config: { secretFile, sender: 'approvals.example.com' } } });
  function body(state: string, over: Record<string, unknown> = {}, key = secret): string {
    const b = Buffer.from(JSON.stringify({
      signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' }, run: read(state).runId,
      expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(), ...over,
    }));
    const f = join(path.dirname(state), `hook-${n++}.json`);
    writeFileSync(f, b);
    writeFileSync(f + '.sig', 'sha256=' + crypto.createHmac('sha256', key).update(b).digest('hex'));
    return f;
  }
  const apply = (s: string, f: string) => signal(['apply', '--state', s, '--verifier', 'plugin:hmac-webhook', '--file', f]);

  it('init refuses an incomplete config', () => {
    const r = initWith({ 'hmac-webhook': { module: mod, config: { secretFile } } });
    expect(r.out.stderr).toContain('sender is required');
  });

  it('a correctly signed body is applied; the subject is the configured sender', () => {
    const s = awaitingWith(spec());
    const r = apply(s, body(s, { subject: 'someone-else' }));
    expect(r.status, r.stderr).toBe(0);
    expect(read(s).signalLog[0]).toMatchObject({ verifier: 'plugin:hmac-webhook', subject: 'approvals.example.com' });
  });

  it('denies a wrong key, a tampered body, a wrong run, an expired body and a bad outcome', () => {
    const s = awaitingWith(spec());
    expect(apply(s, body(s, {}, crypto.randomBytes(32))).stderr).toContain('bad signature');
    const f = body(s);
    writeFileSync(f, readFileSync(f, 'utf-8').replace('approve', 'reject'));
    expect(apply(s, f).stderr).toContain('bad signature');
    expect(apply(s, body(s, { run: 'other' })).stderr).toContain('run mismatch');
    expect(apply(s, body(s, { expires: new Date(Date.now() - 1000).toISOString() })).stderr).toContain('expired');
    expect(apply(s, body(s, { outcome: 'merge' })).stderr).toContain('disallowed outcome');
    expect(apply(s, body(s, { signal: 'other' })).stderr).toContain('wrong signal');
    const noSig = body(s); unlinkSync(noSig + '.sig');
    expect(apply(s, noSig).stderr).toContain('signature not found');
    expect(read(s).machine.state.stage).toBe(2);
  });
});
