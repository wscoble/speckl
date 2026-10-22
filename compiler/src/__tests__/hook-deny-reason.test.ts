// The generated hook's deny sentence: class, next step, sign-off command,
// no secrets, and a throw while building the sentence still denies.
// The decision (exit code, and whether state advances) is what it was before.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpec } from '../compile.js';
import { useStateKey } from './helpers/agent-state.js';
import { formatPre, runAdapter, type AdapterDeps, type HookResult } from '../generators/agent/harness-runtime.js';
import { applyCommand } from '../generators/agent/deny-reason.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const keyFile = useStateKey();
const keyHex = readFileSync(keyFile, 'utf-8').trim();

function build(edit: (src: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-denyreason-'));
  const spec = join(dir, 'AgentPolicy.speckdl');
  writeFileSync(spec, edit(readFileSync(example, 'utf-8')));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    compileSpec(spec, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'both', verifyDepth: 10 });
  } finally { log.mockRestore(); }
  return join(dir, 'out', 'agent');
}

function hook(agentDir: string, cmd: 'pre' | 'post', state: string, msg: object | string, extra: string[] = []) {
  const input = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), cmd, '--state', state, ...extra], { input, encoding: 'utf-8' });
  const out = (r.stdout || '').trim();
  let body: { decision?: string; reason?: string } | null = null;
  if (out) body = JSON.parse(out.split('\n').pop()!);
  return { status: r.status, body, stderr: r.stderr || '', stdout: r.stdout || '' };
}

const stateOf = (f: string) => JSON.parse(readFileSync(f, 'utf-8'));

function freshState(agentDir: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'speckl-denystate-')), 'state.json');
  const r = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), 'init', '--state', f], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return f;
}

function toAwaitingReview(agentDir: string, state: string) {
  for (const [i, tool] of ['run_tests', 'request_review'].entries()) {
    expect(hook(agentDir, 'pre', state, { tool, input: {}, call_id: `c${i}` }).status).toBe(0);
    expect(hook(agentDir, 'post', state, { tool, call_id: `c${i}`, ok: true }).status).toBe(0);
  }
}

function noSecrets(text: string, stateFile: string) {
  const mac = stateOf(stateFile).mac as string;
  expect(text).not.toContain(keyFile);
  expect(text).not.toContain(keyHex);
  expect(text).not.toContain(mac);
  expect(text).not.toContain('"machine"');
  expect(text).not.toContain('--key');
}

describe('generated hook deny reasons', () => {
  let agentDir = '';
  beforeAll(() => { agentDir = build(s => s.replace(
    'action ReadFile(path: String) {\n        return true\n    }',
    'action ReadFile(path: String) {\n        precondition: path != ""\n        return true\n    }',
  )); }, 60_000);

  it('the emitted hook parses and still allows a call the spec allows', () => {
    const check = spawnSync(process.execPath, ['--check', join(agentDir, 'hook.mjs')], { encoding: 'utf-8' });
    expect(check.status, check.stderr).toBe(0);
    expect(readFileSync(join(agentDir, 'hook.mjs'), 'utf-8')).toContain('function renderDenyReason(');
    const state = freshState(agentDir);
    const ok = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe('{"decision":"allow"}');
    expect(stateOf(state).pending.call_id).toBe('1');
  });

  it('a stage guard names the stage and does not offer a sign-off command', () => {
    const state = freshState(agentDir);
    const r = hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.body!.reason).toContain('Speckl denied (not allowed in this stage): can() refused: Guard failed: stage == Approved (stage is Idle)');
    expect(r.body!.reason).toContain('do not retry this call in stage Idle');
    expect(r.body!.reason).not.toContain('signal.mjs');
    expect(r.stderr).toContain('not allowed in this stage');
    noSecrets(r.stdout + r.stderr, state);
    expect(stateOf(state).pending).toBeNull();
    expect(stateOf(state).machine.state.stage).toBe(0);
  });

  it('a precondition and a missing argument say how to fix the call', () => {
    const state = freshState(agentDir);
    const empty = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: '' }, call_id: '1' });
    expect(empty.status).toBe(2);
    expect(empty.body!.reason).toContain('precondition failed');
    expect(empty.body!.reason).toContain('Precondition failed:');
    expect(empty.body!.reason).toContain('do not retry the same input');
    expect(empty.body!.reason).not.toContain("node '");
    const missing = hook(agentDir, 'pre', state, { tool: 'read_file', input: {}, call_id: '2' });
    expect(missing.status).toBe(2);
    expect(missing.body!.reason).toContain('precondition failed');
    expect(missing.body!.reason).toContain('missing argument(s): path');
    expect(stateOf(state).pending).toBeNull();
  });

  it('a sign-off denial names the signal and the exact file-drop command', () => {
    const state = freshState(agentDir);
    toAwaitingReview(agentDir, state);
    const run = stateOf(state).runId as string;
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'apply');
    const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: { leak: 'SECRET-INPUT-VALUE' }, call_id: '9' });
    expect(act.status).toBe(2);
    const reason = act.body!.reason!;
    expect(reason).toContain('waiting on a sign-off');
    expect(reason).toContain('HNTL: act tool refused while awaiting signal review');
    expect(reason).toContain('Sign-off "review"');
    expect(reason).toContain('outcomes: approve, reject');
    expect(reason).toContain('claims: reviewer: String');
    expect(reason).toContain(command);
    expect(reason).toContain('"run":"' + run + '"');
    expect(reason).toContain('"outcome":"<approve or reject>"');
    expect(reason).toContain('The agent must not run that command');
    expect(reason).not.toContain('SECRET-INPUT-VALUE');
    expect(act.stderr).toContain(command);
    noSecrets(act.stdout + act.stderr, state);
    // Observe is still allowed in HNTL: the new sentence did not flip that.
    const obs = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'README.md' }, call_id: '10' });
    expect(obs.status).toBe(0);
    expect(stateOf(state).machine.state.stage).toBe(2);
  });

  it('a pending call names clear-pending and keeps the in-flight call', () => {
    const state = freshState(agentDir);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const r = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '2' });
    expect(r.status).toBe(2);
    expect(r.body!.reason).toContain('precondition failed');
    expect(r.body!.reason).toContain('already pending (1)');
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'clear-pending');
    expect(r.body!.reason).toContain(command);
    expect(r.body!.reason).toContain('"signal":"clear-pending"');
    expect(r.body!.reason).toContain('"call_id":"1"');
    expect(stateOf(state).pending.call_id).toBe('1');
    noSecrets(r.stdout + r.stderr, state);
  });

  it('internal failures stay denied and a missing key path is not printed', () => {
    const state = freshState(agentDir);
    const badTool = hook(agentDir, 'pre', state, { tool: keyHex, input: {}, call_id: '1' });
    expect(badTool.status).toBe(2);
    expect(badTool.body!.reason).toContain('internal error (fail closed)');
    expect(badTool.body!.reason).toContain('unknown tool');
    expect(badTool.body!.reason).not.toContain(keyHex);
    expect(badTool.body!.reason).toContain('<redacted>');

    const hash = stateOf(state);
    hash.specHash = 'deadbeef';
    writeFileSync(state, JSON.stringify(hash));
    // Re-sign is unnecessary: specHash is checked before the seal.
    const mismatch = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '2' });
    expect(mismatch.status).toBe(2);
    expect(mismatch.body!.reason).toContain('specHash mismatch');
    expect(mismatch.body!.reason).toContain('signal.mjs init');

    const gone = join(mkdtempSync(join(tmpdir(), 'speckl-nokey-')), 'missing.key');
    const sealed = freshState(agentDir);
    const integrity = hook(agentDir, 'pre', sealed, { tool: 'run_tests', input: {}, call_id: '3' }, ['--key', gone]);
    expect(integrity.status).toBe(2);
    expect(integrity.body!.reason).toContain('state integrity');
    expect(integrity.body!.reason).toContain('<keyfile>');
    expect(integrity.stdout + integrity.stderr).not.toContain(gone);
    expect(integrity.body!.reason).toContain('state seal failed');
    expect(stateOf(sealed).pending).toBeNull();
  });

  it('a throw while building the sign-off sentence still denies and does not advance', () => {
    const state = freshState(agentDir);
    toAwaitingReview(agentDir, state);
    const cfgPath = join(agentDir, 'agent-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const saved = cfg.awaits[0].outcomes;
    cfg.awaits[0].outcomes = 'approve';
    writeFileSync(cfgPath, JSON.stringify(cfg));
    try {
      const before = stateOf(state).machine;
      const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: 'z' });
      expect(act.status).toBe(2);
      expect(act.body!.reason).toBe('Speckl denied (internal error, fail closed): the explanation could not be built. Next: the call stays denied. Do not retry it.');
      expect(act.stdout + act.stderr).not.toContain('await outcomes');
      expect(stateOf(state).pending).toBeNull();
      expect(stateOf(state).machine).toEqual(before);
      // The same broken config does not turn an allowed observe call into a deny.
      const obs = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'README.md' }, call_id: 'ok' });
      expect(obs.status).toBe(0);
    } finally {
      cfg.awaits[0].outcomes = saved;
      writeFileSync(cfgPath, JSON.stringify(cfg));
    }
  });

  it('malformed input is an internal error and still exit 1', () => {
    const state = freshState(agentDir);
    const r = hook(agentDir, 'pre', state, 'not json');
    expect(r.status).toBe(1);
    expect(r.body!.decision).toBe('deny');
    expect(r.body!.reason).toContain('stdin is not JSON');
    expect(r.body!.reason).toContain('internal error (fail closed)');
    const missing = hook(agentDir, 'pre', join(path.dirname(state), 'none.json'), { tool: 'run_tests', input: {}, call_id: '1' });
    expect(missing.status).toBe(1);
    expect(missing.body!.reason).toContain('state file missing');
    expect(missing.body!.reason).toContain('signal.mjs init');
  });
});

describe('deny text keeps each harness format', () => {
  const reason = 'Speckl denied (waiting on a sign-off): say "review".\nNext: node \'/tmp/signal.mjs\' apply --state \'/tmp/state.json\' --verifier file-drop';
  const harnesses = ['claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'goose', 'hermes', 'pi', 'opencode', 'openclaw', 'cline', 'kiro', 'windsurf'];

  function recovered(harness: string, out: { stdout: string; stderr: string }): string {
    if (harness === 'cursor') {
      const body = JSON.parse(out.stdout);
      expect(body.permission).toBe('deny');
      expect(body.user_message).toBe(body.agent_message);
      return body.user_message;
    }
    if (harness === 'copilot') {
      const body = JSON.parse(out.stdout);
      expect(body.permissionDecision).toBe('deny');
      expect(body.hookSpecificOutput.permissionDecisionReason).toBe(body.permissionDecisionReason);
      return body.permissionDecisionReason;
    }
    if (harness === 'cline') {
      const body = JSON.parse(out.stdout);
      expect(body.cancel).toBe(true);
      return body.errorMessage;
    }
    if (['goose', 'hermes', 'pi', 'opencode', 'openclaw'].includes(harness)) {
      const body = JSON.parse(out.stdout);
      expect(body.decision).toBe('block');
      return body.reason;
    }
    expect(out.stdout).toBe('');
    return out.stderr.replace(/\n$/, '');
  }

  it('every harness carries the full reason and an unchanged allow', () => {
    const allow: Record<string, { code: number; stdout: string; stderr: string }> = {
      cursor: { code: 0, stdout: '{"permission":"allow"}\n', stderr: '' },
      copilot: { code: 0, stdout: '', stderr: '' },
      goose: { code: 0, stdout: '', stderr: '' },
      hermes: { code: 0, stdout: '', stderr: '' },
      pi: { code: 0, stdout: '{"decision":"allow"}\n', stderr: '' },
      opencode: { code: 0, stdout: '{"decision":"allow"}\n', stderr: '' },
      openclaw: { code: 0, stdout: '{"decision":"allow"}\n', stderr: '' },
      kiro: { code: 0, stdout: '{"decision":"allow"}\n', stderr: '' },
      windsurf: { code: 0, stdout: '{"decision":"allow"}\n', stderr: '' },
      cline: { code: 0, stdout: '{"cancel":false}\n', stderr: '' },
      gemini: { code: 0, stdout: '{}\n', stderr: '' },
      'claude-code': { code: 0, stdout: '', stderr: '' },
      codex: { code: 0, stdout: '', stderr: '' },
    };
    for (const harness of harnesses) {
      const denied = formatPre(harness, false, reason);
      expect(denied.code, harness).toBe(2);
      expect(recovered(harness, denied), harness).toBe(reason);
      expect(formatPre(harness, true, reason), harness).toEqual(allow[harness]);
    }
  });

  it('the adapter forwards a hook denial and hides a key path on its own denials', () => {
    const reasonLine = 'Speckl denied (waiting on a sign-off): HNTL: act tool refused while awaiting signal review. Next: human runs signal.mjs apply';
    const calls: unknown[] = [];
    const deps = {
      calls,
      runHook(cmd: 'pre' | 'post', msg: Record<string, unknown>, statePath: string, keyPath: string | null): HookResult {
        calls.push({ cmd, msg, statePath, keyPath });
        return { status: 2, stdout: JSON.stringify({ decision: 'deny', reason: reasonLine }) + '\n', stderr: '' };
      },
      resolvePath: (b: string, p: string) => path.posix.resolve(b, p),
      relativePath: (a: string, b: string) => path.posix.relative(a, b),
      dirname: (p: string) => path.posix.dirname(p),
      cwd: '/p',
      agentDir: '/p/.speckl/agent',
      readFile: () => null,
      writeFile: () => {},
    } as AdapterDeps & { calls: unknown[] };
    const rules = [{ tools: ['Bash', 'Shell'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] }];
    const config = { harness: { 'claude-code': { rules }, cursor: { rules: [{ tools: ['Shell'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] }] } } };
    const cc = runAdapter(['claude-code', 'pre', '--state', 's.json'], { CLAUDE_PROJECT_DIR: '/p' },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', cwd: '/p' }),
      config, deps);
    expect(cc.code).toBe(2);
    expect(cc.stdout).toBe('');
    expect(cc.stderr).toContain(reasonLine);
    expect(cc.stderr).toContain('signal.mjs apply');
    const cu = runAdapter(['cursor', 'pre', '--state', 's.json'], {},
      JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 't1' }),
      config, deps);
    expect(cu.code).toBe(2);
    const body = JSON.parse(cu.stdout);
    expect(body.permission).toBe('deny');
    expect(body.user_message).toContain(reasonLine);
    expect(body.agent_message).toBe(body.user_message);

    const key = '/etc/speckl/k.key';
    const blocked = runAdapter(['claude-code', 'pre', '--state', 's.json', '--key', key],
      { CLAUDE_PROJECT_DIR: '/p', SPECKL_STATE_KEY_FILE: key },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { path: key }, tool_use_id: 't2', cwd: '/p' }),
      config, deps);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('Speckl-protected path');
    expect(blocked.stderr).toContain('off limits');
    expect(blocked.stderr).not.toContain(key);
    expect(blocked.stderr).toContain('<keyfile>');
    expect(deps.calls).toHaveLength(2);
  });
});
