// Key paths that only show up once a symlink is followed, and Node errors that
// name the path they opened, must not reach a deny sentence or the decision log.
// Exit codes and allow/deny decisions stay what main's hook and adapter produce,
// except a key path under 8 characters, which this branch denies.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { compileSpec } from '../compile.js';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';
import { runAdapter, type AdapterDeps } from '../generators/agent/harness-runtime.js';

const SHORT_KEY = 'Speckl denied (internal error, fail closed): the state key path is shorter than 8 characters, so it cannot be redacted. Next: the call stays denied. Use a longer key path. Do not retry this call.';
const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const keyFile = useStateKey();
const keyHex = readFileSync(keyFile, 'utf-8').trim();

let agent = '';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-secret-paths-'));
  const spec = join(dir, 'ClaudeCodePolicy.speckdl');
  writeFileSync(spec, readFileSync(example, 'utf-8'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    compileSpec(spec, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'cdx', verifyDepth: 0 });
  } finally { log.mockRestore(); }
  agent = join(dir, 'out', 'agent');
}, 120_000);

function initState(dir?: string, bin = agent): string {
  const state = join(dir ?? mkdtempSync(join(tmpdir(), 'speckl-st-')), 'state.json');
  const r = spawnSync(process.execPath, [join(bin, 'signal.mjs'), 'init', '--state', state, '--key', keyFile], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return state;
}

function hookRun(state: string, cmd: string, msg: object | string, opts?: { key?: string | null; envKey?: string; cwd?: string; bin?: string }) {
  const args = [join(opts?.bin ?? agent, 'hook.mjs'), cmd, '--state', state];
  if (opts?.key) args.push('--key', opts.key);
  const env = { ...process.env };
  if (opts?.key === null) delete env.SPECKL_STATE_KEY_FILE;
  if (opts?.envKey !== undefined) env.SPECKL_STATE_KEY_FILE = opts.envKey;
  const input = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const r = spawnSync(process.execPath, args, { input, encoding: 'utf-8', env, cwd: opts?.cwd });
  const stdout = r.stdout || '';
  let decision = '';
  const line = stdout.trim().split('\n').pop();
  if (line) {
    try { decision = JSON.parse(line).decision || ''; } catch { /* not JSON */ }
  }
  return { status: r.status, stdout, stderr: r.stderr || '', decision };
}

function logText(state: string): string {
  const log = state + '.decisions/log.jsonl';
  return existsSync(log) ? readFileSync(log, 'utf-8') : '';
}

/** A file whose path is under 8 characters, removed when the test finishes. */
function claimShortFile(): { path: string; release: () => void } {
  for (const name of ['q7', 'm2', 'k9', 'p4', 'n5', 'w3', 'r8', 'ab', 'xy', 'zz']) {
    const p = '/tmp/' + name;
    if (p.length >= 8) continue;
    try {
      writeFileSync(p, readFileSync(keyFile), { flag: 'wx' });
      return { path: p, release: () => { try { rmSync(p); } catch { /* already gone */ } } };
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : '';
      if (code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('could not create a temp path under 8 characters');
}

function longLink(target: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-long-link-'));
  const link = join(dir, 'state.key');
  symlinkSync(target, link);
  if (link.length < 8) throw new Error('symlink path is under 8 characters');
  return link;
}

function absent(text: string, secrets: string[]) {
  for (const secret of secrets) {
    expect(secret.length, secret).toBeGreaterThanOrEqual(8);
    expect(text, secret).not.toContain(secret);
  }
}

/** A real key file, a symlink to that file, and a symlink to its directory. */
function linkedKey() {
  const realDir = mkdtempSync(join(tmpdir(), 'real-sekret-dir-'));
  const realKey = join(realDir, 'state.key');
  writeFileSync(realKey, readFileSync(keyFile));
  const linkParent = mkdtempSync(join(tmpdir(), 'link-sekret-'));
  const linkKey = join(linkParent, 'key.link');
  symlinkSync(realKey, linkKey);
  const linkDir = join(linkParent, 'dir.link');
  symlinkSync(realDir, linkDir);
  const dirKey = join(linkDir, 'state.key');
  return { realDir, realKey, linkKey, linkDir, dirKey };
}

describe('symlink targets and OS errors stay out of deny text', () => {
  it('redacts a symlinked key file and a symlinked key directory on a recorded deny', () => {
    const { realDir, realKey, linkKey, dirKey } = linkedKey();
    for (const [name, key] of [['file symlink', linkKey], ['directory symlink', dirKey]] as const) {
      const state = initState();
      const tool = [realKey, realDir, key].join(' ');
      const denied = hookRun(state, 'pre', { tool, input: { leak: tool }, call_id: key }, { key });
      expect(denied.status, name + ' ' + denied.stderr).toBe(2);
      const shown = denied.stdout + denied.stderr + logText(state);
      absent(shown, [realKey, realDir, key, keyHex]);
      expect(shown, name).toContain('unknown tool');
      expect(shown, name).toContain('<keyfile>');
      expect(logText(state), name).toContain('unknown tool');
    }
  });

  it('a missing or unreadable state file does not print the path or the file bytes', () => {
    const { realDir, realKey, linkKey } = linkedKey();
    const marker = 'KEYBYTES-VISIBLE';
    const junk = join(realDir, 'not-state.json');
    writeFileSync(junk, marker + ' ' + realKey + ' ' + linkKey);
    const parsed = hookRun(junk, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
    expect(parsed.status).toBe(1);
    expect(parsed.stdout).toContain('state file is not JSON');
    absent(parsed.stdout + parsed.stderr + logText(junk), [marker, realKey, realDir, linkKey, keyHex]);

    const missingPath = join(realDir, 'no-state.json');
    const missing = hookRun(missingPath, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('state file missing');
    absent(missing.stdout + missing.stderr, [missingPath, realDir, realKey, linkKey]);

    const dir = hookRun(realDir, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
    expect(dir.status).toBe(1);
    expect(dir.stdout).toContain('state file could not be read');
    absent(dir.stdout + dir.stderr, [realDir, realKey, linkKey]);
    expect(dir.stdout + dir.stderr).not.toContain('EISDIR');
  });

  it('a missing, malformed, or unreadable key does not print the path', () => {
    const { realDir, realKey, linkKey } = linkedKey();
    const state = initState();
    const gone = join(realDir, 'gone.key');
    const broken = join(path.dirname(linkKey), 'broken.key');
    symlinkSync(gone, broken);
    const missing = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: broken });
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain('state key not found');
    absent(missing.stdout + missing.stderr + logText(state), [broken, gone, realDir, realKey, linkKey]);
    expect(missing.stdout).not.toContain('ENOENT');

    const badPath = join(realDir, 'bad.key');
    writeFileSync(badPath, 'NOT-A-KEY ' + realKey);
    const badLink = join(path.dirname(linkKey), 'bad.link');
    symlinkSync(badPath, badLink);
    const bad = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: badLink });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain('64 hex chars');
    absent(bad.stdout + bad.stderr, ['NOT-A-KEY', badPath, badLink, realKey, realDir]);

    chmodSync(realKey, 0o000);
    try {
      const locked = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
      expect(locked.status).toBe(2);
      expect(locked.stdout).toContain('state key could not be read');
      absent(locked.stdout + locked.stderr, [linkKey, realKey, realDir]);
      expect(locked.stdout + locked.stderr).not.toContain('EACCES');
    } finally { chmodSync(realKey, 0o600); }
  });

  it('a lock error does not print the state path or the key directory', () => {
    const { realDir, realKey, linkKey } = linkedKey();
    const state = initState(realDir);
    chmodSync(realDir, 0o555);
    try {
      const denied = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
      expect(denied.status).toBe(1);
      expect(denied.stdout).toContain('state lock could not be taken');
      absent(denied.stdout + denied.stderr + logText(state), [state, realDir, realKey, linkKey, state + '.lock']);
      expect(denied.stdout + denied.stderr).not.toContain('EACCES');
    } finally { chmodSync(realDir, 0o755); }
  });

  it('a decision-record write error does not print the log path', () => {
    const { realDir, realKey, linkKey } = linkedKey();
    const state = initState(realDir);
    const first = hookRun(state, 'pre', { tool: 'open_pr', input: {}, call_id: 'd' }, { key: linkKey });
    expect(first.status, first.stderr).toBe(2);
    const log = state + '.decisions/log.jsonl';
    chmodSync(log, 0o444);
    try {
      const denied = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
      expect(denied.status).toBe(2);
      expect(denied.stdout).toContain('decision record unavailable');
      absent(denied.stdout + denied.stderr + readFileSync(log, 'utf-8'), [log, realDir, realKey, linkKey, keyHex]);
      expect(denied.stdout + denied.stderr).not.toContain('EACCES');
    } finally { chmodSync(log, 0o644); }
  });

  it('a log kind that is the key path is not copied into the replay sentence', () => {
    const { realKey, linkKey } = linkedKey();
    const state = initState();
    const st = JSON.parse(readFileSync(state, 'utf-8')) as { head: string; log: unknown[] };
    const body = { kind: realKey, seq: 0, prev: st.head };
    const hash = crypto.createHash('sha256').update(canonical(body)).digest('hex');
    st.log = [{ ...body, hash }];
    (st as { head: string }).head = hash;
    writeSigned(state, st as unknown as Record<string, unknown>);
    const denied = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: linkKey });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('unknown log entry');
    absent(denied.stdout + denied.stderr, [realKey, linkKey]);
  });

  it('a key path whose realpath throws is still redacted from the given path', () => {
    const state = initState();
    const broken = join(mkdtempSync(join(tmpdir(), 'env-broken-sekret-')), 'env-broken-sekret.key');
    symlinkSync(join(path.dirname(broken), 'missing-target.key'), broken);
    const denied = hookRun(state, 'pre', { tool: broken, input: {}, call_id: '1' }, { key: keyFile, envKey: broken });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('unknown tool');
    absent(denied.stdout + denied.stderr + logText(state), [broken, keyHex]);
  });

  it('the adapter redacts a symlinked key on a protected-path deny', () => {
    const project = mkdtempSync(join(tmpdir(), 'speckl-adapter-proj-'));
    const { realDir, realKey, linkKey, dirKey } = linkedKey();
    const state = initState();
    const run = (key: string, toolName: string, filePath: string) => spawnSync(
      process.execPath,
      [join(agent, 'adapter.mjs'), 'claude-code', 'pre', '--state', state, '--key', key, '--project', project],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: { file_path: filePath },
          tool_use_id: 't',
          cwd: project,
        }),
        encoding: 'utf-8',
        env: { ...process.env, SPECKL_STATE_KEY_FILE: key, CLAUDE_PROJECT_DIR: project },
      },
    );
    for (const [name, key] of [['file symlink', linkKey], ['directory symlink', dirKey]] as const) {
      const out = run(key, realKey + ' ' + realDir, key);
      expect(out.status, name + ' ' + out.stderr).toBe(2);
      const shown = (out.stdout || '') + (out.stderr || '') + logText(state);
      absent(shown, [realKey, realDir, key, keyHex]);
      expect(out.stderr, name).toContain('Speckl-protected path');
      expect(out.stderr, name).toContain('<keyfile>');
    }
  });
});

describe('realpath on the adapter secret list', () => {
  const bash = [{ tools: ['Bash'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] }];
  const config = { harness: { 'claude-code': { rules: bash } } };

  function deps(realpath: AdapterDeps['realpath']): AdapterDeps {
    return {
      runHook: () => ({ status: 0, stdout: '', stderr: '' }),
      resolvePath: (b, p) => path.resolve(b, p),
      relativePath: (a, b) => path.relative(a, b),
      dirname: p => path.dirname(p),
      cwd: '/proj',
      agentDir: '/proj/.speckl/agent',
      readFile: () => null,
      writeFile() {},
      realpath,
    };
  }

  it('adds the real path and its parent, and adds nothing when realpath throws', () => {
    const env = { SPECKL_STATE_KEY_FILE: '/proj/link.key', CLAUDE_PROJECT_DIR: '/proj' };
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: '/secret/real-sekret/state.key /secret/real-sekret', tool_use_id: 't', cwd: '/proj',
    });
    const followed = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', 'link.key'],
      env, payload, config,
      deps(() => '/secret/real-sekret/state.key'),
    );
    expect(followed.code).toBe(2);
    expect(followed.stderr).not.toContain('/secret/real-sekret');
    expect(followed.stderr).toContain('<keyfile>');

    const thrown = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', 'env-broken-sekret.key'],
      { SPECKL_STATE_KEY_FILE: 'env-broken-sekret.key', CLAUDE_PROJECT_DIR: '/proj' },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'env-broken-sekret.key', tool_use_id: 't', cwd: '/proj' }),
      config,
      deps(() => { throw new Error('ENOENT: no such file'); }),
    );
    expect(thrown.code).toBe(2);
    expect(thrown.stderr).not.toContain('env-broken-sekret.key');
    expect(thrown.stderr).not.toContain('ENOENT');
  });

  it('refuses a key path under 8 characters before any other deny', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'UNIQUE-SHORT-PATH-MARKER', tool_use_id: 't', cwd: '/proj',
    });
    const out = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', 'k'],
      { CLAUDE_PROJECT_DIR: '/proj' }, payload, config, deps(() => '/secret/real'),
    );
    expect(out.code).toBe(2);
    expect(out.stderr.trim()).toBe(SHORT_KEY);
    expect(out.stdout + out.stderr).not.toContain('UNIQUE-SHORT-PATH-MARKER');
    expect(out.stderr).not.toContain('/secret/real');
  });

  it('refuses a path that resolves under 8 characters only after the payload cwd is known', () => {
    const deep = '/l1/l2/l3/l4/l5/l6/l7/l8';
    const given = '../../../../k';
    expect(given.length).toBeGreaterThanOrEqual(8);
    expect(path.resolve(deep, given).length).toBeGreaterThanOrEqual(8);
    expect(path.resolve('/a', given).length).toBeLessThan(8);
    const out = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', given],
      {},
      JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: '/a',
      }),
      config,
      { ...deps(() => '/unused-long-dir/state.key'), cwd: deep },
    );
    expect(out.code).toBe(2);
    expect(out.stderr.trim()).toBe(SHORT_KEY);
    expect(out.stderr).not.toContain(given);
  });

  it('treats an empty key and a path resolve that throws as not short', () => {
    const empty = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', ''],
      { CLAUDE_PROJECT_DIR: '/proj' },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: '/proj' }),
      config,
      deps(() => '/unused-long-dir/state.key'),
    );
    expect(empty.stderr).not.toContain('shorter than 8');

    let blows = 0;
    const thrown = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', 'long-enough.key'],
      { CLAUDE_PROJECT_DIR: '/proj' },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'long-enough.key', tool_use_id: 't', cwd: '/proj' }),
      config,
      {
        ...deps(() => '/unused-long-dir/state.key'),
        resolvePath: (base, p) => {
          // The short-path check resolves the key against the project and the
          // cwd. Those two throws are ignored. Later resolves must succeed.
          if (p === 'long-enough.key' && blows++ < 2) throw new Error('nope');
          return path.resolve(base, p);
        },
      },
    );
    expect(thrown.code).toBe(2);
    expect(thrown.stderr).not.toContain('shorter than 8');
    expect(thrown.stderr).not.toContain('long-enough.key');

    let odd = 0;
    const notString = runAdapter(
      ['claude-code', 'pre', '--state', 's.json', '--key', 'long-enough.key'],
      { SPECKL_STATE_KEY_FILE: 'also-long.key', CLAUDE_PROJECT_DIR: '/from-env' },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: '/proj' }),
      config,
      {
        ...deps(() => '/from-cwd/also-long.key'),
        cwd: '/from-cwd',
        runHook: () => ({ status: 0, stdout: '{"decision":"allow"}\n', stderr: '' }),
        resolvePath: (base, p) => {
          // The short-path checks see a non-string and ignore it. Later
          // resolves of the same path return a real path.
          if ((p === 'long-enough.key' || p === 'also-long.key') && odd++ < 8) return 0 as unknown as string;
          return path.resolve(base, p);
        },
      },
    );
    expect(notString.stderr).not.toContain('shorter than 8');
    expect(notString.code, notString.stderr).toBe(0);
  });

  it('refuses a real path or its parent under 8 characters', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: '/proj',
    });
    const argv = ['claude-code', 'pre', '--state', 's.json', '--key', 'long-enough.key'];
    const env = { CLAUDE_PROJECT_DIR: '/proj' };
    const realShort = runAdapter(argv, env, payload, config, deps(() => '/tmp/ab'));
    expect(realShort.code).toBe(2);
    expect(realShort.stderr.trim()).toBe(SHORT_KEY);
    expect(realShort.stderr).not.toContain('/tmp/ab');

    const parentShort = runAdapter(argv, env, payload, config, deps(() => '/tmp/abcdefghij'));
    expect('/tmp/abcdefghij'.length).toBeGreaterThanOrEqual(8);
    expect(parentShort.stderr.trim()).toBe(SHORT_KEY);
    expect(parentShort.stderr).not.toContain('abcdefghij');

    const viaRealPath = runAdapter(argv, env, payload, config, {
      ...deps(() => { throw new Error('ENOENT'); }),
      realPath: () => '/tmp/ab',
    });
    expect(viaRealPath.stderr.trim()).toBe(SHORT_KEY);

    const emptyThenReal = runAdapter(argv, env, payload, config, {
      ...deps(() => ''),
      realPath: () => '/tmp/ab',
    });
    expect(emptyThenReal.stderr.trim()).toBe(SHORT_KEY);

    const onlyRealPath = deps(() => '/tmp/ab');
    delete (onlyRealPath as { realpath?: unknown }).realpath;
    onlyRealPath.realPath = () => '/tmp/ab';
    expect(runAdapter(argv, env, payload, config, onlyRealPath).stderr.trim()).toBe(SHORT_KEY);

    const dirThrows = runAdapter(argv, env, payload, config, {
      ...deps(() => '/tmp/abcdefghij'),
      dirname: (p) => {
        if (p === '/tmp/abcdefghij') throw new Error('nope');
        return path.dirname(p);
      },
    });
    expect(dirThrows.stderr).not.toContain('shorter than 8');
    expect(dirThrows.stderr).not.toContain('abcdefghij');
  });
});

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function encodingsOf(hex: string): Record<string, string> {
  const raw = Buffer.from(hex, 'hex');
  const b64 = raw.toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
  const der = Buffer.concat([SPKI_PREFIX, raw]).toString('base64');
  const pem = '-----BEGIN PUBLIC KEY-----\n' + der + '\n-----END PUBLIC KEY-----';
  return {
    'lowercase hex': hex.toLowerCase(),
    'uppercase hex': hex.toUpperCase(),
    base64: b64,
    'base64 without padding': b64.replace(/=+$/, ''),
    base64url: b64url,
    'base64url without padding': b64url.replace(/=+$/, ''),
    'SPKI DER base64': der,
    'SPKI DER base64 without padding': der.replace(/=+$/, ''),
    'SPKI PEM': pem,
    'SPKI PEM crlf': pem.replace(/\n/g, '\r\n'),
  };
}

describe('short key paths and other key encodings stay out of deny text', () => {
  it('refuses 1–3 character key paths, relative and through a symlink', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'real-short-key-'));
    const realKey = join(realDir, 'state.key');
    writeFileSync(realKey, readFileSync(keyFile));
    const cwd = mkdtempSync(join(tmpdir(), 'link-short-key-'));
    for (const name of ['k', 'ab', 'xyz']) symlinkSync(realKey, join(cwd, name));
    const state = initState();
    for (const key of ['k', 'ab', 'xyz', './k']) {
      const denied = hookRun(state, 'pre', { tool: 'run_tests', input: { leak: realKey }, call_id: '1' }, { key, cwd });
      expect(denied.status, key + ' ' + denied.stderr).toBe(1);
      expect(JSON.parse(denied.stdout).reason, key).toBe(SHORT_KEY);
      expect(denied.stderr, key).toContain(SHORT_KEY);
      expect(denied.stdout + denied.stderr + logText(state), key).not.toContain(realKey);
      expect(denied.stdout + denied.stderr, key).not.toContain(realDir);
    }
    const envDenied = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: keyFile, envKey: 'ab', cwd });
    expect(JSON.parse(envDenied.stdout).reason).toBe(SHORT_KEY);
    expect(envDenied.stdout + envDenied.stderr).not.toContain(realKey);
    expect(envDenied.stdout + envDenied.stderr).not.toContain(keyFile);

    const given = '../../../../k';
    expect(given.length).toBeGreaterThanOrEqual(8);
    expect(path.resolve(cwd, given).length).toBeLessThan(8);
    const resolved = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: given, cwd });
    expect(resolved.status).toBe(1);
    expect(JSON.parse(resolved.stdout).reason).toBe(SHORT_KEY);
    expect(resolved.stdout + resolved.stderr).not.toContain(given);
  });

  it('the adapter refuses the same short paths', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'real-short-adapter-'));
    const realKey = join(realDir, 'state.key');
    writeFileSync(realKey, readFileSync(keyFile));
    const cwd = mkdtempSync(join(tmpdir(), 'link-short-adapter-'));
    for (const name of ['k', 'ab', 'xyz']) symlinkSync(realKey, join(cwd, name));
    const state = initState(cwd);
    const run = (key: string, envKey?: string) => spawnSync(
      process.execPath,
      [join(agent, 'adapter.mjs'), 'claude-code', 'pre', '--state', state, '--key', key, '--project', cwd],
      {
        cwd,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd,
        }),
        encoding: 'utf-8',
        env: { ...process.env, SPECKL_STATE_KEY_FILE: envKey ?? key, CLAUDE_PROJECT_DIR: cwd },
      },
    );
    for (const key of ['k', 'ab', 'xyz', './k']) {
      const out = run(key);
      expect(out.status, key + ' ' + out.stderr).toBe(2);
      expect((out.stderr || '').trim(), key).toBe(SHORT_KEY);
      expect((out.stdout || '') + (out.stderr || '') + logText(state), key).not.toContain(realKey);
    }
    const envOnly = run(keyFile, 'ab');
    expect((envOnly.stderr || '').trim()).toBe(SHORT_KEY);
    expect((envOnly.stdout || '') + (envOnly.stderr || '')).not.toContain(keyFile);
    expect((envOnly.stdout || '') + (envOnly.stderr || '')).not.toContain(realKey);

    const given = '../../../../k';
    const resolved = run(given);
    expect((resolved.stderr || '').trim()).toBe(SHORT_KEY);
    expect((resolved.stdout || '') + (resolved.stderr || '')).not.toContain(given);
  });

  it('refuses a long symlink whose real path or parent is under 8 characters', () => {
    const held = claimShortFile();
    const link = longLink(held.path);
    const parentFile = join('/tmp', 'specklpk' + process.pid);
    writeFileSync(parentFile, readFileSync(keyFile));
    const parentLink = longLink(parentFile);
    const cwd = mkdtempSync(join(tmpdir(), 'speckl-adapter-short-real-'));
    const adapterState = initState(cwd);
    const run = (key: string, envKey: string) => spawnSync(
      process.execPath,
      [join(agent, 'adapter.mjs'), 'claude-code', 'pre', '--state', adapterState, '--key', key, '--project', cwd],
      {
        cwd,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd,
        }),
        encoding: 'utf-8',
        env: { ...process.env, SPECKL_STATE_KEY_FILE: envKey, CLAUDE_PROJECT_DIR: cwd },
      },
    );
    try {
      expect(held.path.length).toBeLessThan(8);
      expect(link.length).toBeGreaterThanOrEqual(8);
      expect(parentFile.length).toBeGreaterThanOrEqual(8);
      expect(path.dirname(parentFile).length).toBeLessThan(8);
      const state = initState();
      const byKey = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: link });
      expect(byKey.status, byKey.stderr).toBe(1);
      expect(JSON.parse(byKey.stdout).reason).toBe(SHORT_KEY);
      expect(byKey.stdout + byKey.stderr + logText(state)).not.toContain(held.path);
      expect(byKey.stdout + byKey.stderr).not.toContain(link);

      const byEnv = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: keyFile, envKey: link });
      expect(byEnv.status, byEnv.stderr).toBe(1);
      expect(JSON.parse(byEnv.stdout).reason).toBe(SHORT_KEY);
      expect(byEnv.stdout + byEnv.stderr).not.toContain(held.path);
      expect(byEnv.stdout + byEnv.stderr).not.toContain(link);
      expect(byEnv.stdout + byEnv.stderr).not.toContain(keyFile);

      const byParent = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { key: parentLink });
      expect(byParent.status, byParent.stderr).toBe(1);
      expect(JSON.parse(byParent.stdout).reason).toBe(SHORT_KEY);
      expect(byParent.stdout + byParent.stderr).not.toContain(parentFile);

      const adapterKey = run(link, keyFile);
      expect(adapterKey.status, adapterKey.stderr).toBe(2);
      expect((adapterKey.stderr || '').trim()).toBe(SHORT_KEY);
      expect((adapterKey.stdout || '') + (adapterKey.stderr || '')).not.toContain(held.path);
      expect((adapterKey.stdout || '') + (adapterKey.stderr || '')).not.toContain(link);

      const adapterEnv = run(keyFile, link);
      expect(adapterEnv.status, adapterEnv.stderr).toBe(2);
      expect((adapterEnv.stderr || '').trim()).toBe(SHORT_KEY);
      expect((adapterEnv.stdout || '') + (adapterEnv.stderr || '')).not.toContain(held.path);
      expect((adapterEnv.stdout || '') + (adapterEnv.stderr || '')).not.toContain(link);
      expect((adapterEnv.stdout || '') + (adapterEnv.stderr || '')).not.toContain(keyFile);
    } finally {
      held.release();
      try { rmSync(parentFile); } catch { /* already gone */ }
    }
  });

  it('replaces a hook stack that names the key path, and keeps the fixed spawn sentences', () => {
    const src = readFileSync(join(agent, 'adapter.mjs'), 'utf-8');
    expect(src).toContain('hook.mjs could not be started');
    expect(src).toContain('hook.mjs killed by ');
    expect(src).toContain('hook.mjs failed');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-hook-stack-'));
    const state = initState(dir);
    const hook = join(agent, 'hook.mjs');
    const saved = readFileSync(hook);
    const spawnAdapter = () => spawnSync(
      process.execPath,
      [join(agent, 'adapter.mjs'), 'claude-code', 'pre', '--state', state, '--key', keyFile, '--project', dir],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: dir,
        }),
        encoding: 'utf-8',
        env: process.env,
      },
    );
    try {
      writeFileSync(hook, 'process.stderr.write(' + JSON.stringify(keyFile + '\nError: boom\n') + ');\nprocess.exit(1);\n');
      const crashed = spawnAdapter();
      expect(crashed.status, crashed.stderr).toBe(2);
      expect(crashed.stderr).toContain('hook.mjs failed');
      expect((crashed.stdout || '') + (crashed.stderr || '')).not.toContain(keyFile);
      writeFileSync(hook, 'process.kill(process.pid, "SIGKILL");\n');
      const killed = spawnAdapter();
      expect(killed.status, killed.stderr).toBe(2);
      expect(killed.stderr).toContain('hook.mjs killed by SIGKILL');
      expect((killed.stdout || '') + (killed.stderr || '')).not.toContain(keyFile);
    } finally {
      writeFileSync(hook, saved);
    }
  });

  it('redacts every encoding of the state key and of a pinned signer key', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const signerDer = publicKey.export({ type: 'spki', format: 'der' });
    const signerHex = signerDer.subarray(-32).toString('hex');
    expect(signerDer.toString('base64')).toBe(Buffer.concat([SPKI_PREFIX, Buffer.from(signerHex, 'hex')]).toString('base64'));
    const dir = mkdtempSync(join(tmpdir(), 'speckl-enc-'));
    const state = join(dir, 'state.json');
    const init = spawnSync(process.execPath, [
      join(agent, 'signal.mjs'), 'init', '--state', state, '--key', keyFile, '--signer', 'alice=' + signerHex,
    ], { encoding: 'utf-8' });
    expect(init.status, init.stderr).toBe(0);
    const planted = { 'state key': encodingsOf(keyHex), 'signer key': encodingsOf(signerHex) };
    for (const [owner, forms] of Object.entries(planted)) {
      for (const [name, form] of Object.entries(forms)) {
        const denied = hookRun(state, 'pre', { tool: form, input: { leak: form }, call_id: form }, { key: keyFile });
        expect(denied.status, owner + ' ' + name + ' ' + denied.stderr).toBe(2);
        const lines = logText(state).trim().split('\n').filter(Boolean);
        const shown = denied.stdout + denied.stderr + (lines[lines.length - 1] || '');
        expect(shown, owner + ' ' + name).not.toContain(form);
        expect(denied.stdout, owner + ' ' + name).toContain('unknown tool');
        expect(lines[lines.length - 1], owner + ' ' + name).toContain('unknown tool');
      }
    }
  });
});

describe('allow and deny decisions match a hook and adapter generated from 09eb03c', () => {
  // The other side is the agent compiled from that commit (checked in under
  // fixtures/main-09eb03c). Same calls, compared on exit code and allow/deny.
  // Each side reads a state its own signal.mjs created, so each checks its own spec hash.
  const mainAgent = join(compilerDir, 'src', '__tests__', 'fixtures', 'main-09eb03c');
  const pre = (tool: string, command: string, id: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: command ? { command } : { file_path: 'README.md' },
    tool_use_id: id,
    cwd: '/tmp',
  });

  function adapterRun(bin: string, state: string, event: string, payload: object | string, key = keyFile) {
    const r = spawnSync(
      process.execPath,
      [join(bin, 'adapter.mjs'), 'claude-code', event, '--state', state, '--key', key, '--project', path.dirname(state)],
      {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: path.dirname(state) },
      },
    );
    const decision = r.status === 0 ? 'allow' : 'deny';
    return { status: r.status, decision };
  }

  function hookVerdict(bin: string, row: { cmd: string; msg: object | string; key?: string | null; missing?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-verdict-'));
    const state = row.missing ? join(dir, 'missing.json') : initState(dir, bin);
    let key = row.key;
    if (row.key === '') {
      key = join(dir, 'bad.key');
      writeFileSync(key, 'short');
    }
    const got = hookRun(state, row.cmd, row.msg, { bin, ...(key === undefined ? {} : { key }) });
    return { status: got.status, decision: got.decision, stderr: got.stderr };
  }

  const hookCases: { name: string; cmd: string; msg: object | string; key?: string | null; missing?: boolean }[] = [
    { name: 'pre run_tests', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' } },
    { name: 'pre open_pr in Idle', cmd: 'pre', msg: { tool: 'open_pr', input: {}, call_id: '1' } },
    { name: 'pre unknown tool', cmd: 'pre', msg: { tool: 'nope', input: {}, call_id: '1' } },
    { name: 'pre missing call id', cmd: 'pre', msg: { tool: 'run_tests', input: {} } },
    { name: 'pre not json', cmd: 'pre', msg: 'not json' },
    { name: 'pre missing state', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, missing: true },
    { name: 'usage', cmd: 'nope', msg: {} },
    { name: 'post without pending', cmd: 'post', msg: { tool: 'run_tests', call_id: '1', ok: true } },
    { name: 'missing key', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, key: null },
    { name: 'bad key', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, key: '' },
  ];

  it('hook exit codes and allow/deny match the 09eb03c hook', () => {
    const got = hookCases.map(row => {
      const ours = hookVerdict(agent, row);
      const main = hookVerdict(mainAgent, row);
      expect({ status: ours.status, decision: ours.decision }, row.name + '\nours ' + ours.stderr + '\nmain ' + main.stderr)
        .toEqual({ status: main.status, decision: main.decision });
      return ours;
    });
    expect(got.some(r => r.status === 0 && r.decision === 'allow')).toBe(true);
    expect(got.some(r => r.decision === 'deny')).toBe(true);
  });

  it('hook post of an allowed call matches the 09eb03c hook', () => {
    const run = (bin: string) => {
      const state = initState(undefined, bin);
      const pre = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { bin });
      const post = hookRun(state, 'post', { tool: 'run_tests', call_id: '1', ok: true }, { bin });
      return { pre: pre.status, post: post.status, preDecision: pre.decision, postDecision: post.decision };
    };
    const ours = run(agent);
    expect(ours).toEqual(run(mainAgent));
    expect(ours.preDecision).toBe('allow');
    expect(ours.postDecision).toBe('allow');
  });

  const adapterCases: { name: string; event: string; payload: object | string }[] = [
    { name: 'pre npm test', event: 'pre', payload: pre('Bash', 'npm test', 'a') },
    { name: 'pre open_pr command', event: 'pre', payload: pre('Bash', 'git push origin main', 'b') },
    { name: 'pre unmapped', event: 'pre', payload: pre('WebFetch', '', 'c') },
    { name: 'pre not json', event: 'pre', payload: '{' },
    { name: 'pre protected state', event: 'pre', payload: {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '' }, tool_use_id: 'd', cwd: '/tmp',
    } },
    { name: 'post without pending', event: 'post', payload: {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'e',
      tool_response: { stdout: 'ok', interrupted: false },
    } },
  ];

  it('adapter exit codes and allow/deny match the 09eb03c adapter', () => {
    const got = adapterCases.map(row => {
      const dirOurs = mkdtempSync(join(tmpdir(), 'speckl-adapter-verdict-'));
      const dirMain = mkdtempSync(join(tmpdir(), 'speckl-adapter-verdict-'));
      const oursState = initState(dirOurs, agent);
      const mainState = initState(dirMain, mainAgent);
      const payloadFor = (state: string, dir: string) => row.name === 'pre protected state'
        ? { ...(row.payload as object), tool_input: { file_path: state }, cwd: dir }
        : row.payload;
      const ours = adapterRun(agent, oursState, row.event, payloadFor(oursState, dirOurs));
      const main = adapterRun(mainAgent, mainState, row.event, payloadFor(mainState, dirMain));
      expect(ours, row.name).toEqual(main);
      return ours;
    });
    expect(got.some(r => r.status === 0 && r.decision === 'allow')).toBe(true);
    expect(got.some(r => r.decision === 'deny')).toBe(true);
  });

  it('adapter pre then post of npm test matches the 09eb03c adapter', () => {
    const run = (bin: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'speckl-adapter-allow-'));
      const state = initState(dir, bin);
      const payload = (name: string) => ({
        hook_event_name: name,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'same',
        cwd: dir,
        tool_response: { stdout: 'ok', interrupted: false },
      });
      return {
        pre: adapterRun(bin, state, 'pre', payload('PreToolUse')),
        post: adapterRun(bin, state, 'post', payload('PostToolUse')),
      };
    };
    const ours = run(agent);
    expect(ours).toEqual(run(mainAgent));
    expect(ours.pre).toEqual({ status: 0, decision: 'allow' });
    expect(ours.post).toEqual({ status: 0, decision: 'allow' });
  });

  it('a long symlink to a key path under 8 characters is an expected difference from 09eb03c', () => {
    const held = claimShortFile();
    const link = longLink(held.path);
    try {
      const hookSide = (bin: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'speckl-verdict-short-'));
        const state = initState(dir, bin);
        const got = hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' }, { bin, key: link });
        return { status: got.status, decision: got.decision, stderr: got.stderr };
      };
      const oursHook = hookSide(agent);
      const mainHook = hookSide(mainAgent);
      expect(oursHook.status, oursHook.stderr).toBe(1);
      expect(oursHook.decision).toBe('deny');
      expect({ status: mainHook.status, decision: mainHook.decision }, mainHook.stderr).toEqual({ status: 0, decision: 'allow' });
      expect({ status: oursHook.status, decision: oursHook.decision }).not.toEqual({ status: mainHook.status, decision: mainHook.decision });

      const adapterSide = (bin: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'speckl-verdict-short-ad-'));
        const state = initState(dir, bin);
        return adapterRun(bin, state, 'pre', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_use_id: 'short-real',
          cwd: dir,
        }, link);
      };
      const oursAdapter = adapterSide(agent);
      const mainAdapter = adapterSide(mainAgent);
      expect(oursAdapter).toEqual({ status: 2, decision: 'deny' });
      expect(mainAdapter).toEqual({ status: 0, decision: 'allow' });
    } finally {
      held.release();
    }
  });
});
