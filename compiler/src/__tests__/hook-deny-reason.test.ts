// The generated hook's deny sentence: class, next step, sign-off command,
// no secrets, and a throw while building the sentence still denies.
// The decision (exit code, and whether state advances) is what it was before.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { compileSpec } from '../compile.js';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';
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

function freshState(agentDir: string, signers: string[] = []): string {
  const f = join(mkdtempSync(join(tmpdir(), 'speckl-denystate-')), 'state.json');
  const args = [join(agentDir, 'signal.mjs'), 'init', '--state', f];
  for (const s of signers) args.push('--signer', s);
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return f;
}

type Key = { privateKey: crypto.KeyObject; hex: string; raw: Buffer };
function pair(): Key {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, raw, hex: raw.toString('hex') };
}
function signedDrop(state: string, body: Record<string, unknown>, key: Key): string {
  const full = {
    run: stateOf(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomUUID(),
    ...body,
  };
  const file = join(path.dirname(state), 'drop.json');
  const buf = Buffer.from(JSON.stringify(full));
  writeFileSync(file, buf);
  writeFileSync(file + '.sig', crypto.sign(null, buf, key.privateKey));
  return file;
}
function pubFile(state: string, key: Key): string {
  const file = join(path.dirname(state), 'signer.pub');
  writeFileSync(file, key.hex);
  return file;
}
/** Run the command the denial printed, with the human's drop file filled in. */
function runPrinted(command: string, dropFile: string, pubkeyFile?: string): { status: number | null; stderr: string } {
  let sh = command.replace('<drop.json>', "'" + dropFile.replace(/'/g, "'\\''") + "'");
  if (pubkeyFile) sh = sh.replace('<pubkey>', "'" + pubkeyFile.replace(/'/g, "'\\''") + "'");
  const r = spawnSync('sh', ['-c', sh], { encoding: 'utf-8' });
  return { status: r.status, stderr: r.stderr || '' };
}
function asLegacy(state: string): void {
  const st = stateOf(state);
  delete st.initialSigners;
  delete st.signers;
  const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
  let prev = sha('speckl-state-v1:' + canonical({
    run: st.runId, spec: st.specHash, dev: st.dev === true, keyId: st.keyId || null,
  }));
  st.log = st.log.map((e: { hash?: string; [k: string]: unknown }, i: number) => {
    const { hash: _h, ...body } = e;
    body.seq = i;
    body.prev = prev;
    const h = sha(canonical(body));
    prev = h;
    return { ...body, hash: h };
  });
  st.head = prev;
  writeSigned(state, st);
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

  it('a sign-off denial for one pinned signer names that signer and the command works', () => {
    const alice = pair();
    const state = freshState(agentDir, [`alice=${alice.hex}`]);
    toAwaitingReview(agentDir, state);
    const run = stateOf(state).runId as string;
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'apply', stateOf(state).signers);
    expect(command).toContain("--signer 'alice'");
    expect(command).not.toContain('--pubkey');
    const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: { leak: 'SECRET-INPUT-VALUE' }, call_id: '9' });
    expect(act.status).toBe(2);
    const reason = act.body!.reason!;
    expect(reason).toContain('waiting on a sign-off');
    expect(reason).toContain('HNTL: act tool refused while awaiting signal review');
    expect(reason).toContain('Sign-off "review"');
    expect(reason).toContain('outcomes: approve, reject');
    expect(reason).toContain('claims: reviewer: String');
    expect(reason).toContain('Pinned signer "alice"');
    expect(reason).toContain(command);
    expect(reason).toContain('"run":"' + run + '"');
    expect(reason).toContain('"outcome":"<approve or reject>"');
    expect(reason).toContain('The agent must not run that command');
    expect(reason).not.toContain('SECRET-INPUT-VALUE');
    expect(reason).not.toContain(alice.hex);
    expect(reason).not.toContain(crypto.createHash('sha256').update(alice.raw).digest('hex'));
    expect(reason).toContain('Do not pass --pubkey');
    expect(reason).not.toContain('--pubkey <pubkey>');
    expect(act.stderr).toContain(command);
    noSecrets(act.stdout + act.stderr, state);
    const obs = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'README.md' }, call_id: '10' });
    expect(obs.status).toBe(0);
    expect(stateOf(state).machine.state.stage).toBe(2);
    const drop = signedDrop(state, { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' } }, alice);
    const applied = runPrinted(command, drop);
    expect(applied.status, applied.stderr).toBe(0);
    expect(stateOf(state).machine.state.stage).toBe(3);
  });

  it('several pinned signers omit --pubkey, and a signature from any of them works', () => {
    const alice = pair();
    const bob = pair();
    const state = freshState(agentDir, [`bob=${bob.hex}`, `alice=${alice.hex}`]);
    toAwaitingReview(agentDir, state);
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'apply', stateOf(state).signers);
    expect(command).not.toContain('--pubkey');
    expect(command).not.toContain('--signer');
    const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '9' });
    expect(act.status).toBe(2);
    const reason = act.body!.reason!;
    expect(reason).toContain(command);
    expect(reason).toContain('Pinned signers "alice", "bob"');
    expect(reason).not.toContain(alice.hex);
    expect(reason).not.toContain(bob.hex);
    expect(reason).toContain('Omit --pubkey');
    expect(reason).not.toContain('--pubkey <pubkey>');
    const drop = signedDrop(state, { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' } }, bob);
    const applied = runPrinted(command, drop);
    expect(applied.status, applied.stderr).toBe(0);
    expect(stateOf(state).machine.state.stage).toBe(3);
  });

  it('an empty pin set does not tell the human to pass --pubkey', () => {
    const state = freshState(agentDir);
    toAwaitingReview(agentDir, state);
    const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '9' });
    expect(act.status).toBe(2);
    const reason = act.body!.reason!;
    expect(reason).toContain('No sign-off signers are pinned');
    expect(reason).toContain('init --signer');
    expect(reason).toContain('Do not pass --pubkey');
    expect(reason).not.toContain('--pubkey <pubkey>');
    expect(reason).not.toContain('A human runs:');
    expect(stateOf(state).machine.state.stage).toBe(2);
  });

  it('a legacy state still prints --pubkey and that command works', () => {
    const planted = pair();
    const other = pair();
    const state = freshState(agentDir, [`alice=${planted.hex}`]);
    toAwaitingReview(agentDir, state);
    asLegacy(state);
    expect(stateOf(state).signers).toBeUndefined();
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'apply', stateOf(state).signers);
    expect(command).toContain('--pubkey <pubkey>');
    expect(command).not.toContain('--signer');
    const act = hook(agentDir, 'pre', state, { tool: 'open_pr', input: {}, call_id: '9' });
    expect(act.status).toBe(2);
    const reason = act.body!.reason!;
    expect(reason).toContain(command);
    expect(reason).not.toContain('Pinned signer');
    expect(reason).not.toContain(planted.hex);
    expect(reason).not.toContain(other.hex);
    const drop = signedDrop(state, { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' } }, other);
    const applied = runPrinted(command, drop, pubFile(state, other));
    expect(applied.status, applied.stderr).toBe(0);
    expect(stateOf(state).machine.state.stage).toBe(3);
  });

  it('a pending call names clear-pending for the pinned signer and keeps the in-flight call', () => {
    const alice = pair();
    const state = freshState(agentDir, [`alice=${alice.hex}`]);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const r = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '2' });
    expect(r.status).toBe(2);
    expect(r.body!.reason).toContain('precondition failed');
    expect(r.body!.reason).toContain('already pending (1)');
    const command = applyCommand(join(agentDir, 'signal.mjs'), state, 'clear-pending', stateOf(state).signers);
    expect(command).toContain("--signer 'alice'");
    expect(r.body!.reason).toContain(command);
    expect(r.body!.reason).toContain('"signal":"clear-pending"');
    expect(r.body!.reason).toContain('"call_id":"1"');
    expect(r.body!.reason).not.toContain(alice.hex);
    expect(r.body!.reason).toContain('Do not pass --pubkey');
    expect(r.body!.reason).not.toContain('--pubkey <pubkey>');
    expect(stateOf(state).pending.call_id).toBe('1');
    noSecrets(r.stdout + r.stderr, state);
    const drop = signedDrop(state, { signal: 'clear-pending', outcome: 'clear', call_id: '1' }, alice);
    expect(runPrinted(command, drop).status).toBe(0);
    expect(stateOf(state).pending).toBeNull();
  });

  it('internal failures stay denied and a missing key path is not printed', () => {
    const state = freshState(agentDir);
    const badTool = hook(agentDir, 'pre', state, { tool: keyHex, input: {}, call_id: '1' });
    expect(badTool.status).toBe(2);
    expect(badTool.body!.reason).toContain('internal error (fail closed)');
    expect(badTool.body!.reason).toContain('unknown tool');
    expect(badTool.body!.reason).not.toContain(keyHex);
    expect(badTool.body!.reason).toContain('<keyfile>');

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
    expect(integrity.body!.reason).toContain('state key not found');
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
      runHook(cmd: 'pre' | 'post' | 'deny', msg: Record<string, unknown>, statePath: string, keyPath: string | null): HookResult {
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
    expect(deps.calls.map(c => (c as { cmd: string }).cmd)).toEqual(['pre', 'pre', 'deny']);
  });

  it('redacts a resolved key path, the key file contents, and a signer key on each adapter denial', () => {
    const rel = 'sekret/state.key';
    const abs = '/proj/sekret/state.key';
    const envRel = './env-sekret.key';
    const envAbs = '/proj/env-sekret.key';
    const contents = 'STATE-KEY-CONTENTS-NOT-HEX';
    const signer = 'SIGNER-KEY-MATERIAL';
    const secrets = [rel, abs, envRel, envAbs, contents, signer, '/proj/sekret', '/proj/<keyfile>'];
    const deps = {
      runHook() {
        return { status: 2, stdout: JSON.stringify({ decision: 'deny', reason: 'nope ' + abs + ' ' + contents + ' ' + signer }) + '\n', stderr: '' };
      },
      resolvePath: (b: string, p: string) => path.posix.resolve(b, p),
      relativePath: (a: string, b: string) => path.posix.relative(a, b),
      dirname: (p: string) => path.posix.dirname(p),
      cwd: '/proj',
      agentDir: '/proj/.speckl/agent',
      readFile(p: string) {
        if (p === abs || p === rel || p === envAbs || p === envRel) return contents + '\n';
        if (p.endsWith('s.json')) return JSON.stringify({ signers: [{ name: 'alice', key: signer }] });
        return null;
      },
      writeFile() {},
    } as AdapterDeps;
    const bash = [{ tools: ['Bash', 'bash'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] }];
    const config = { harness: { 'claude-code': { rules: bash }, opencode: { rules: bash } } };
    const env = { SPECKL_STATE_KEY_FILE: envRel, CLAUDE_PROJECT_DIR: '/proj' };
    const flags = ['--state', 's.json', '--project', '/proj', '--key', rel];
    const pre = (harness: string, event: string, payload: unknown, extra: string[] = flags) =>
      runAdapter([harness, event, ...extra], env, typeof payload === 'string' ? payload : JSON.stringify(payload), config, deps);
    const cases: [string, { code: number; stdout: string; stderr: string }][] = [
      ['unknown harness', pre(abs, 'pre', {})],
      ['unknown event', pre('claude-code', abs, {})],
      ['not json', pre('claude-code', 'pre', '{')],
      ['not an object', pre('claude-code', 'pre', [])],
      ['wrong event name', pre('claude-code', 'pre', { hook_event_name: abs })],
      ['missing state', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: abs }, ['--project', '/proj', '--key', rel])],
      ['protected path', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: contents, tool_input: { path: abs }, tool_use_id: 't', cwd: '/proj' })],
      ['unmapped tool', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: signer + ' ' + envAbs, tool_input: {}, tool_use_id: 't', cwd: '/proj' })],
      ['shell metacharacters', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test; ' + abs }, tool_use_id: 't', cwd: '/proj' })],
      ['foreign workdir', pre('opencode', 'pre', { hook_event_name: 'tool.execute.before', tool_name: 'bash', tool_input: { command: 'npm test', workdir: abs }, tool_use_id: 't', cwd: '/proj' })],
      ['no tool id', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/proj' })],
      ['forwarded hook deny', pre('claude-code', 'pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't', cwd: '/proj' })],
    ];
    for (const [name, out] of cases) {
      expect(out.code, name).toBe(2);
      const text = out.stdout + out.stderr;
      for (const secret of secrets) expect(text, name + ' leaked ' + secret).not.toContain(secret);
    }
    expect(cases.find(c => c[0] === 'protected path')![1].stderr).toContain('<keyfile>');
    expect(cases.find(c => c[0] === 'forwarded hook deny')![1].stderr).toContain('<keyfile>');
  });

  it('adapter main() prints a fixed line and not the exception text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-adapter-catch-'));
    const spec = join(dir, 'Mini.speckdl');
    writeFileSync(spec, [
      'speck Mini {',
      '    state {',
      '        stage: Nat',
      '    }',
      '    init {',
      '        stage := 0',
      '    }',
      '    action Go {',
      '        require stage == 0',
      '        stage := 1',
      '    }',
      '    agent {',
      '        stages stage {',
      '            Idle = 0',
      '            Done = 1',
      '        }',
      '        tool go -> Go effect act',
      '        harness claude-code {',
      '            map Bash command ~ "npm test" -> go',
      '        }',
      '    }',
      '    next: Go',
      '}',
      '',
    ].join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { compileSpec(spec, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'cdx', verifyDepth: 0 }); }
    finally { log.mockRestore(); }
    const agent = join(dir, 'out', 'agent');
    const keyDir = mkdtempSync(join(tmpdir(), 'speckl-adapter-key-'));
    const rel = './state-sekret.key';
    writeFileSync(join(keyDir, 'state-sekret.key'), keyHex + '\n');
    const abs = path.resolve(keyDir, rel);
    writeFileSync(join(agent, 'agent-config.json'), '{not-json ' + abs + ' ' + rel + ' ' + keyHex + ' SIGNER-KEY-MATERIAL');
    const run = (event: string) => spawnSync(process.execPath, [join(agent, 'adapter.mjs'), 'claude-code', event, '--key', rel], {
      cwd: keyDir, input: '{}', encoding: 'utf-8',
    });
    const denied = run('pre');
    expect(denied.status, denied.stderr).toBe(2);
    expect(denied.stderr).toContain('Speckl adapter error: the adapter failed closed. The call stays denied.');
    for (const secret of [abs, rel, keyHex, 'SIGNER-KEY-MATERIAL', 'not-json', 'SyntaxError']) {
      expect(denied.stderr, secret).not.toContain(secret);
      expect(denied.stdout, secret).not.toContain(secret);
    }
    const batch = run('batch');
    expect(batch.status, batch.stderr).toBe(0);
    expect(batch.stderr).toContain('failed closed');
    expect(batch.stderr).not.toContain(abs);
    expect(batch.stderr).not.toContain(keyHex);
    expect(batch.stdout).toBe('');
  });
});
