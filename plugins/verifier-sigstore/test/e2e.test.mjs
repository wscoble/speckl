// End to end: compile examples/AgentPolicy.speckdl to agent rails, pin this
// plug-in with `signal.mjs init --plugins`, drive the hook into the review
// wait state, and apply Sigstore-signed drops through the generated
// signal.mjs. Bundles come from the offline mock Sigstore in support/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv, writeRoot } from './support/sigstore-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginModule = fs.realpathSync(path.join(here, '..', 'index.mjs'));
const repo = path.resolve(here, '..', '..', '..');
const compilerDir = path.join(repo, 'compiler');
const viteNode = path.join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const ISS = 'https://issuer.speckl.test';
const WHO = 'carol@example.com';

let env;
let work;
let agent;
let keyFile;
let pluginsFile;

function run(file, args, input) {
  const r = spawnSync(process.execPath, [file, ...args], {
    input, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, SPECKL_STATE_KEY_FILE: keyFile },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const signal = args => run(path.join(agent, 'signal.mjs'), args);
const hook = (cmd, state, msg) => run(path.join(agent, 'hook.mjs'), [cmd, '--state', state], JSON.stringify(msg));
const read = f => JSON.parse(fs.readFileSync(f, 'utf-8'));

function awaitingReview() {
  const state = path.join(fs.mkdtempSync(path.join(work, 's-')), 'state.json');
  const init = signal(['init', '--state', state, '--plugins', pluginsFile]);
  expect(init.status, init.stderr).toBe(0);
  for (const [tool, id] of [['run_tests', '1'], ['request_review', '2']]) {
    expect(hook('pre', state, { tool, input: {}, call_id: id }).status).toBe(0);
    expect(hook('post', state, { tool, input: {}, call_id: id, ok: true }).status).toBe(0);
  }
  return state;
}
let n = 0;
async function drop(state, over = {}, signOpts = {}) {
  const body = Buffer.from(JSON.stringify({
    signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' }, run: read(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(), ...over,
  }));
  const file = path.join(path.dirname(state), `drop-${n++}.json`);
  fs.writeFileSync(file, body);
  fs.writeFileSync(file + '.sigstore.json', JSON.stringify(await env.sign(body, { iss: ISS, sub: WHO, ...signOpts })));
  return file;
}
const apply = (state, file) => signal(['apply', '--state', state, '--verifier', 'plugin:sigstore', '--file', file]);

beforeAll(async () => {
  if (!fs.existsSync(viteNode)) throw new Error('run `npm ci` in compiler/ first (the e2e test compiles a spec)');
  env = await createEnv();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'speckl-sigstore-e2e-'));
  const c = spawnSync(process.execPath, [viteNode, path.join(compilerDir, 'src', 'index.ts'), path.join(repo, 'examples', 'AgentPolicy.speckdl'), '-t', 'agent', '-o', path.join(work, 'out')],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (c.status !== 0) throw new Error('compile failed: ' + (c.stderr || c.stdout));
  agent = path.join(work, 'out', 'agent');
  keyFile = path.join(work, 'state.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  const root = writeRoot(work, env.trustedRoot);
  pluginsFile = path.join(work, 'plugins.json');
  fs.writeFileSync(pluginsFile, JSON.stringify({
    sigstore: {
      module: pluginModule,
      config: {
        trustedRoot: root.path,
        trustedRootSha256: root.sha256,
        signals: { review: { issuer: ISS, identity: WHO } },
      },
    },
  }));
}, 120_000);
afterAll(() => env && env.close());

describe('Sigstore plug-in through the generated signal.mjs', () => {
  it('init refuses a config without an identity policy', () => {
    const bad = path.join(work, 'bad-plugins.json');
    fs.writeFileSync(bad, JSON.stringify({ sigstore: { module: pluginModule, config: { tuf: { cachePath: work }, signals: { review: { issuer: ISS } } } } }));
    const r = signal(['init', '--state', path.join(work, 'never.json'), '--plugins', bad]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('exactly one of identity');
  });

  it('applies a valid keyless approval and records the verified identity and Rekor entry', async () => {
    const state = awaitingReview();
    const r = apply(state, await drop(state));
    expect(r.status, r.stderr).toBe(0);
    const st = read(state);
    expect(st.machine.state.stage).toBe(3);
    expect(st.signalLog[0]).toMatchObject({ verifier: 'plugin:sigstore', subject: WHO, issuer: ISS, outcome: 'approve' });
    expect(st.signalLog[0].rekor.entryUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.stdout).evidence).toMatch(/^sigstore:[0-9a-f]{64}:rekor:\d+:[0-9a-f]{64}$/);
    // The open_pr tool is now allowed by the hook.
    expect(hook('pre', state, { tool: 'open_pr', input: {}, call_id: '3' }).status).toBe(0);
  });

  it('denies a wrong identity, a tampered drop and an identity flag, leaving the state unchanged', async () => {
    const state = awaitingReview();
    const wrong = apply(state, await drop(state, {}, { sub: 'mallory@example.com' }));
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('certificate identity error');
    const f = await drop(state);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('carol"}', 'mallory"}'));
    const tampered = apply(state, f);
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toContain('signature verification failed');
    const flag = signal(['apply', '--state', state, '--verifier', 'plugin:sigstore', '--file', await drop(state), '--identity', 'mallory@example.com']);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain('pinned in the state at init');
    const st = read(state);
    expect(st.machine.state.stage).toBe(2);
    expect(st.signalLog).toEqual([]);
    expect(st.usedNonces).toEqual([]);
  });

  it('denies a drop for another run and a drop whose outcome the wait state does not allow', async () => {
    const state = awaitingReview();
    expect(apply(state, await drop(state, { run: 'f'.repeat(32) })).stderr).toContain('run mismatch');
    expect(apply(state, await drop(state, { outcome: 'merge' })).stderr).toContain('disallowed outcome');
    expect(read(state).machine.state.stage).toBe(2);
  });
});
