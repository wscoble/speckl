// Key paths that only show up once a symlink is followed, and Node errors that
// name the path they opened, must not reach a deny sentence or the decision log.
// Exit codes and allow/deny decisions stay what main's hook and adapter produce.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { compileSpec } from '../compile.js';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';
import { runAdapter, type AdapterDeps } from '../generators/agent/harness-runtime.js';

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

function initState(dir?: string): string {
  const state = join(dir ?? mkdtempSync(join(tmpdir(), 'speckl-st-')), 'state.json');
  const r = spawnSync(process.execPath, [join(agent, 'signal.mjs'), 'init', '--state', state, '--key', keyFile], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return state;
}

function hookRun(state: string, cmd: string, msg: object | string, opts?: { key?: string | null; envKey?: string }) {
  const args = [join(agent, 'hook.mjs'), cmd, '--state', state];
  if (opts?.key) args.push('--key', opts.key);
  const env = { ...process.env };
  if (opts?.key === null) delete env.SPECKL_STATE_KEY_FILE;
  if (opts?.envKey !== undefined) env.SPECKL_STATE_KEY_FILE = opts.envKey;
  const input = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const r = spawnSync(process.execPath, args, { input, encoding: 'utf-8', env });
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
});

describe('allow and deny decisions match main', () => {
  // Exit code and decision only. Reason text is this branch's. These are the
  // verdicts of origin/main at 09eb03c for the same calls: 0 allow, 2 deny,
  // 1 error (still a deny). Checked against a hook and adapter generated from
  // that commit.
  const pre = (tool: string, command: string, id: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: command ? { command } : { file_path: 'README.md' },
    tool_use_id: id,
    cwd: '/tmp',
  });

  function adapterRun(state: string, event: string, payload: object | string) {
    const r = spawnSync(
      process.execPath,
      [join(agent, 'adapter.mjs'), 'claude-code', event, '--state', state, '--key', keyFile, '--project', path.dirname(state)],
      {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: path.dirname(state) },
      },
    );
    const decision = r.status === 0 ? 'allow' : 'deny';
    return { status: r.status, decision };
  }

  const hookCases: { name: string; cmd: string; msg: object | string; exit: number; decision: string; key?: string | null; missing?: boolean }[] = [
    { name: 'pre run_tests', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, exit: 0, decision: 'allow' },
    { name: 'pre open_pr in Idle', cmd: 'pre', msg: { tool: 'open_pr', input: {}, call_id: '1' }, exit: 2, decision: 'deny' },
    { name: 'pre unknown tool', cmd: 'pre', msg: { tool: 'nope', input: {}, call_id: '1' }, exit: 2, decision: 'deny' },
    { name: 'pre missing call id', cmd: 'pre', msg: { tool: 'run_tests', input: {} }, exit: 2, decision: 'deny' },
    { name: 'pre not json', cmd: 'pre', msg: 'not json', exit: 1, decision: 'deny' },
    { name: 'pre missing state', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, exit: 1, decision: 'deny', missing: true },
    { name: 'usage', cmd: 'nope', msg: {}, exit: 1, decision: 'deny' },
    { name: 'post without pending', cmd: 'post', msg: { tool: 'run_tests', call_id: '1', ok: true }, exit: 2, decision: 'deny' },
    { name: 'missing key', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, exit: 2, decision: 'deny', key: null },
    { name: 'bad key', cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: '1' }, exit: 2, decision: 'deny', key: '' },
  ];

  it.each(hookCases)('hook $name is exit $exit $decision', (row) => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-verdict-'));
    const state = row.missing ? join(dir, 'missing.json') : initState(dir);
    let key = row.key;
    if (row.key === '') {
      key = join(dir, 'bad.key');
      writeFileSync(key, 'short');
    }
    const got = hookRun(state, row.cmd, row.msg, key === undefined ? undefined : { key });
    expect(got.status, got.stderr).toBe(row.exit);
    expect(got.decision).toBe(row.decision);
  });

  it('hook post of an allowed call is exit 0 allow', () => {
    const state = initState();
    expect(hookRun(state, 'pre', { tool: 'run_tests', input: {}, call_id: '1' })).toMatchObject({ status: 0, decision: 'allow' });
    expect(hookRun(state, 'post', { tool: 'run_tests', call_id: '1', ok: true })).toMatchObject({ status: 0, decision: 'allow' });
  });

  const adapterCases: { name: string; event: string; payload: object | string; exit: number; decision: string }[] = [
    { name: 'pre npm test', event: 'pre', payload: pre('Bash', 'npm test', 'a'), exit: 0, decision: 'allow' },
    { name: 'pre open_pr command', event: 'pre', payload: pre('Bash', 'git push origin main', 'b'), exit: 2, decision: 'deny' },
    { name: 'pre unmapped', event: 'pre', payload: pre('WebFetch', '', 'c'), exit: 2, decision: 'deny' },
    { name: 'pre not json', event: 'pre', payload: '{', exit: 2, decision: 'deny' },
    { name: 'pre protected state', event: 'pre', payload: {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '' }, tool_use_id: 'd', cwd: '/tmp',
    }, exit: 2, decision: 'deny' },
    { name: 'post without pending', event: 'post', payload: {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'e',
      tool_response: { stdout: 'ok', interrupted: false },
    }, exit: 2, decision: 'deny' },
  ];

  it.each(adapterCases)('adapter $name is exit $exit $decision', (row) => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-adapter-verdict-'));
    const state = initState(dir);
    const payload = row.name === 'pre protected state'
      ? { ...(row.payload as object), tool_input: { file_path: state }, cwd: dir }
      : row.payload;
    const got = adapterRun(state, row.event, payload);
    expect(got).toEqual({ status: row.exit, decision: row.decision });
  });

  it('adapter pre then post of npm test is exit 0 allow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-adapter-allow-'));
    const state = initState(dir);
    const payload = (event: string, name: string) => ({
      hook_event_name: name,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'same',
      cwd: dir,
      tool_response: { stdout: 'ok', interrupted: false },
    });
    expect(adapterRun(state, 'pre', payload('pre', 'PreToolUse'))).toEqual({ status: 0, decision: 'allow' });
    expect(adapterRun(state, 'post', payload('post', 'PostToolUse'))).toEqual({ status: 0, decision: 'allow' });
  });
});
