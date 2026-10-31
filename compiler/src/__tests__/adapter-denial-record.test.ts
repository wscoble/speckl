// Adapter-stage denials (unmapped tool, shell metacharacters, a protected
// path, a bad payload) are appended to the decision record by hook.mjs deny.
// The call stays denied when the state is tampered or the recorder crashes.
// An allowed call is still only the hook's pre/post lines, with no class.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { useStateKey } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

useStateKey();

const HARNESSES = [
  'claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'goose', 'hermes',
  'pi', 'opencode', 'openclaw', 'cline', 'kiro', 'windsurf',
] as const;

const SHELL: Record<string, string> = {
  'claude-code': 'Bash', cursor: 'Shell', codex: 'Bash', gemini: 'run_shell_command',
  copilot: 'bash', goose: 'shell', hermes: 'terminal', pi: 'bash', opencode: 'bash',
  openclaw: 'exec', cline: 'run_commands', kiro: 'shell', windsurf: 'run_command',
};

const PRE: Record<string, string> = {
  'claude-code': 'PreToolUse', cursor: 'preToolUse', codex: 'PreToolUse', gemini: 'BeforeTool',
  copilot: 'preToolUse', goose: 'PreToolUse', hermes: 'pre_tool_call', pi: 'tool_call',
  opencode: 'tool.execute.before', openclaw: 'before_tool_call', cline: 'PreToolUse',
  kiro: 'PreToolUse', windsurf: 'pre_tool',
};

const POST: Record<string, string> = {
  'claude-code': 'PostToolUse', cursor: 'postToolUse', codex: 'PostToolUse', gemini: 'AfterTool',
  copilot: 'postToolUse', goose: 'PostToolUse', hermes: 'post_tool_call', pi: 'tool_result',
  opencode: 'tool.execute.after', openclaw: 'after_tool_call', cline: 'PostToolUse',
  kiro: 'PostToolUse', windsurf: 'post_tool',
};

type R = { status: number | null; stdout: string; stderr: string };
let agentDir = '';

function run(file: string, args: string[], input?: string): R {
  const r = spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function linesOf(state: string): Record<string, unknown>[] {
  const log = state + '.decisions/log.jsonl';
  if (!existsSync(log)) return [];
  const text = readFileSync(log, 'utf-8');
  if (!text.trim()) return [];
  return text.trimEnd().split('\n').map(l => JSON.parse(l));
}

function newState(): { project: string; state: string; key: string } {
  const project = mkdtempSync(join(tmpdir(), 'speckl-deny-proj-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'speckl-deny-key-'));
  const key = join(keyDir, 'state.key');
  mkdirSync(join(project, '.speckl'), { recursive: true });
  const state = join(project, '.speckl', 'state.json');
  const init = run(join(agentDir, 'signal.mjs'), ['init', '--state', state, '--key', key]);
  expect(init.status, init.stderr).toBe(0);
  return { project, state, key };
}

function payload(harness: string, event: string, tool: string, input: unknown, id = 'c1'): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    session_id: 'sess-denials',
    cwd: '',
  });
}

function adapter(ctx: { project: string; state: string; key: string }, harness: string, event: string, stdin: string): R {
  return run(join(agentDir, 'adapter.mjs'), [
    harness, event, '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
  ], stdin.replace(/"cwd":""/g, '"cwd":' + JSON.stringify(ctx.project)));
}

function pre(ctx: { project: string; state: string; key: string }, harness: string, tool: string, input: unknown, id = 'c1'): R {
  return adapter(ctx, harness, 'pre', payload(harness, PRE[harness], tool, input, id));
}

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-deny-out-'));
  const r = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), example, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  agentDir = join(out, 'agent');
}, 120_000);

describe('adapter-stage denials are in the decision record', () => {
  it('every harness records unmapped, metachar, protected-path and bad-payload exactly once', () => {
    const ctx = newState();
    const before = readFileSync(ctx.state);
    for (const harness of HARNESSES) {
      const shell = SHELL[harness];
      const start = linesOf(ctx.state).length;
      const cases: [string, R][] = [
        ['unmapped', pre(ctx, harness, 'WebFetch', { url: 'https://example.com' }, harness + '-u')],
        ['metachar', pre(ctx, harness, shell, { command: 'npm test; echo pwned' }, harness + '-m')],
        ['protected-path', pre(ctx, harness, shell, { command: 'cat .claude/settings.json' }, harness + '-p')],
        ['bad-payload', adapter(ctx, harness, 'pre', '{')],
      ];
      for (const [cls, result] of cases) {
        expect(result.status, harness + ' ' + cls + ' ' + result.stderr).toBe(2);
        expect(result.stderr + result.stdout, harness + ' ' + cls).not.toContain('decision record unavailable');
      }
      const added = linesOf(ctx.state).slice(start);
      expect(added.map(l => l.class), harness).toEqual(['unmapped', 'metachar', 'protected-path', 'bad-payload']);
      expect(added.map(l => l.verdict), harness).toEqual(['deny', 'deny', 'deny', 'deny']);
      expect(added.map(l => l.phase), harness).toEqual(['pre', 'pre', 'pre', 'pre']);
      expect(added[0].tool, harness).toBe('WebFetch');
      expect(added[0].action, harness).toBeNull();
      expect(String(added[0].reason), harness).toContain('unmapped harness tool "WebFetch"');
      expect(String(added[1].reason), harness).toContain('shell control characters');
      expect(String(added[2].reason), harness).toContain('Speckl-protected path');
      expect(String(added[3].reason), harness).toContain('not JSON');
      expect(added[3].tool, harness).toBeNull();
      expect(added[3].call_id, harness).toBeNull();
      for (const line of added) {
        expect(line.reason === null || String(line.reason).length <= 500, harness).toBe(true);
      }
    }
    expect(readFileSync(ctx.state).equals(before)).toBe(true);
    expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).log).toEqual([]);
    expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).pending).toBeNull();
    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(JSON.parse(verify.stdout).decisions).toBe(HARNESSES.length * 4);
    const lines = linesOf(ctx.state);
    lines.forEach((line, i) => expect(line.seq, 'seq ' + i).toBe(i));
  });

  it('an allowed call is unchanged: one allow line, no class, same stdout on a repeat', () => {
    const ctx = newState();
    for (const harness of HARNESSES) {
      const shell = SHELL[harness];
      const first = pre(ctx, harness, shell, { command: 'git status' }, harness + '-ok');
      expect(first.status, harness + ' ' + first.stderr).toBe(0);
      expect(first.stderr, harness).toBe('');
      const allowLine = linesOf(ctx.state).at(-1)!;
      expect(allowLine.verdict, harness).toBe('allow');
      expect(allowLine.phase, harness).toBe('pre');
      expect(allowLine.class, harness).toBeUndefined();
      expect(allowLine.tool, harness).toBe('inspect');
      const again = pre(ctx, harness, shell, { command: 'git status' }, harness + '-ok2');
      // A second pre is refused while the first is pending. Clear it with post.
      expect(again.status, harness).toBe(2);
      const post = adapter(ctx, harness, 'post', payload(harness, POST[harness], shell, { command: 'git status' }, harness + '-ok'));
      // Windsurf's run_command post is exit 2 with a fixed note: Cascade never
      // reports an exit status, so the command is recorded and does not advance.
      // That note is the allow path, not an adapter-stage denial.
      if (harness === 'windsurf') {
        expect(post.status, post.stderr).toBe(2);
        expect(post.stderr).toContain('not successful');
      } else {
        expect(post.status, harness + ' post ' + post.stderr).toBe(0);
      }
      expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).pending, harness).toBeNull();
      const posted = linesOf(ctx.state).at(-1)!;
      expect(posted.verdict, harness).toBe('allow');
      expect(posted.class, harness).toBeUndefined();
      const third = pre(ctx, harness, shell, { command: 'git status' }, harness + '-ok3');
      expect(third.status, harness + ' ' + third.stderr).toBe(0);
      expect(third.stdout, harness).toBe(first.stdout);
      expect(third.stderr, harness).toBe('');
      const clear = adapter(ctx, harness, 'post', payload(harness, POST[harness], shell, { command: 'git status' }, harness + '-ok3'));
      expect(clear.status, harness + ' clear ' + clear.stderr).toBe(harness === 'windsurf' ? 2 : 0);
      expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).pending, harness).toBeNull();
    }
  });

  it('a tampered state still emits the denial and does not append', () => {
    const ctx = newState();
    const ok = pre(ctx, 'claude-code', 'WebFetch', {}, 'seed');
    expect(ok.status, ok.stderr).toBe(2);
    const logBefore = readFileSync(ctx.state + '.decisions/log.jsonl');
    const raw = readFileSync(ctx.state);
    const flipped = Buffer.from(raw);
    flipped[flipped.length - 2] ^= 0x1;
    writeFileSync(ctx.state, flipped);
    const denied = pre(ctx, 'claude-code', 'WebFetch', {}, 'tampered');
    expect(denied.status, denied.stderr).toBe(2);
    expect(denied.stderr).toContain('unmapped harness tool "WebFetch"');
    expect(denied.stderr).not.toContain('state integrity');
    expect(readFileSync(ctx.state + '.decisions/log.jsonl').equals(logBefore)).toBe(true);
    expect(readFileSync(ctx.state).equals(flipped)).toBe(true);
  });

  it('a decision record that cannot be written still denies, and a direct bad class is not appended', () => {
    const ctx = newState();
    const before = readFileSync(ctx.state);
    writeFileSync(ctx.state + '.decisions', 'not-a-directory\n');
    const denied = pre(ctx, 'cursor', 'WebFetch', {}, 'norecord');
    expect(denied.status, denied.stderr).toBe(2);
    expect(denied.stderr).toContain('unmapped harness tool "WebFetch"');
    expect(denied.stdout).toContain('"permission":"deny"');
    expect(readFileSync(ctx.state).equals(before)).toBe(true);
    expect(readFileSync(ctx.state + '.decisions', 'utf-8')).toBe('not-a-directory\n');

    const fresh = newState();
    const bad = run(join(agentDir, 'hook.mjs'), ['deny', '--state', fresh.state, '--key', fresh.key],
      JSON.stringify({ class: 'nope', reason: 'nope', phase: 'pre' }));
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain('not recorded');
    expect(linesOf(fresh.state)).toEqual([]);
    const empty = run(join(agentDir, 'hook.mjs'), ['deny', '--state', fresh.state, '--key', fresh.key],
      JSON.stringify({ class: 'unmapped', reason: '', phase: 'pre' }));
    expect(empty.status).toBe(2);
    expect(linesOf(fresh.state)).toEqual([]);
  });

  it('a hook that dies mid-record still denies, and the next denial chains', () => {
    const ctx = newState();
    const hookPath = join(agentDir, 'hook.mjs');
    const saved = readFileSync(hookPath);
    const killer = [
      "import fs from 'node:fs';",
      "const i = process.argv.indexOf('--state');",
      "const state = process.argv[i + 1];",
      "fs.mkdirSync(state + '.decisions', { recursive: true });",
      "fs.appendFileSync(state + '.decisions/log.jsonl', '{\"torn\":true');",
      "process.kill(process.pid, 'SIGKILL');",
      '',
    ].join('\n');
    writeFileSync(hookPath, killer);
    try {
      const denied = pre(ctx, 'claude-code', 'WebFetch', {}, 'killed');
      expect(denied.status, denied.stderr).toBe(2);
      expect(denied.stderr).toContain('unmapped harness tool "WebFetch"');
    } finally {
      writeFileSync(hookPath, saved);
    }
    expect(readFileSync(ctx.state + '.decisions/log.jsonl', 'utf-8')).toBe('{"torn":true');
    const next = pre(ctx, 'claude-code', 'WebFetch', { url: 'https://example.com' }, 'after-kill');
    expect(next.status, next.stderr).toBe(2);
    const lines = linesOf(ctx.state);
    expect(lines).toHaveLength(1);
    expect(lines[0].class).toBe('unmapped');
    expect(lines[0].seq).toBe(0);
    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
  });

  it('unicode, path tricks, a huge input and a deep input are recorded and still denied', () => {
    const ctx = newState();
    const name = '读取\u0301';
    const unicode = pre(ctx, 'claude-code', name, { note: 'café' }, 'uni');
    expect(unicode.status, unicode.stderr).toBe(2);
    expect(linesOf(ctx.state).at(-1)).toMatchObject({ class: 'unmapped', tool: name, verdict: 'deny' });

    const dotdot = pre(ctx, 'claude-code', 'Bash', { command: 'cat foo/../../.claude/settings.json' }, 'dots');
    expect(dotdot.status, dotdot.stderr).toBe(2);
    expect(linesOf(ctx.state).at(-1)!.class).toBe('protected-path');

    const nul = pre(ctx, 'claude-code', 'Bash', { command: 'cat .claude/settings.json\u0000extra' }, 'nul');
    expect(nul.status, nul.stderr).toBe(2);
    expect(linesOf(ctx.state).at(-1)!.class).toBe('protected-path');
    expect(readFileSync(ctx.state + '.decisions/log.jsonl', 'utf-8')).not.toContain('\u0000extra');

    const longName = 'WebFetch' + 'x'.repeat(400);
    const clipped = pre(ctx, 'claude-code', longName, {}, 'long');
    expect(clipped.status, clipped.stderr).toBe(2);
    const clippedLine = linesOf(ctx.state).at(-1)!;
    expect(clippedLine.class).toBe('unmapped');
    expect(String(clippedLine.tool).length).toBeLessThanOrEqual(200);
    expect(String(clippedLine.reason).length).toBeLessThanOrEqual(500);

    // The key path starts past the clip point. Redact first, then clip,
    // or the record keeps a prefix of the path.
    const secretTool = 'T'.repeat(180) + ctx.key + 'U'.repeat(80);
    const leaked = pre(ctx, 'claude-code', secretTool, {}, 'secret-tool');
    expect(leaked.status, leaked.stderr).toBe(2);
    expect(leaked.stderr).not.toContain(ctx.key);
    const secretLine = linesOf(ctx.state).at(-1)!;
    expect(secretLine.class).toBe('unmapped');
    expect(JSON.stringify(secretLine)).not.toContain(ctx.key);
    expect(String(secretLine.tool)).toContain('<keyfile>');
    expect(String(secretLine.tool).length).toBeLessThanOrEqual(200);

    const huge = pre(ctx, 'claude-code', 'WebFetch', { blob: 'a'.repeat(80_000) }, 'huge');
    expect(huge.status, huge.stderr).toBe(2);
    const hugeLine = linesOf(ctx.state).at(-1)!;
    expect(hugeLine.class).toBe('unmapped');
    const nullDigest = crypto.createHash('sha256').update('null').digest('hex');
    expect(hugeLine.input_sha256).toBe(nullDigest);

    let deep: unknown = { command: 'nope' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const nested = pre(ctx, 'claude-code', 'WebFetch', deep, 'deep');
    expect(nested.status, nested.stderr).toBe(2);
    // The path walk stops past depth 20 and treats that as a protected hit.
    // The recorder must still append, and must not hash the deep value.
    expect(nested.stderr).toContain('Speckl-protected path');
    const deepLine = linesOf(ctx.state).at(-1)!;
    expect(deepLine.class).toBe('protected-path');
    expect(deepLine.input_sha256).toBe(nullDigest);

    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).log).toEqual([]);
  });

  it('odd payloads and a missing state file still deny, and a cut-off call id does not keep a key', () => {
    const ctx = newState();
    const odd: [string, string][] = [
      ['null', 'bad-payload'],
      ['true', 'bad-payload'],
      ['{}', 'unmapped'],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: { bad: true }, tool_input: {}, tool_use_id: 'obj' }), 'unmapped'],
    ];
    for (const [stdin, cls] of odd) {
      const r = adapter(ctx, 'claude-code', 'pre', stdin);
      expect(r.status, stdin + ' ' + r.stderr).toBe(2);
      expect(linesOf(ctx.state).at(-1)!.class, stdin).toBe(cls);
    }
    const gone = { ...ctx, state: join(ctx.project, '.speckl', 'missing.json') };
    const missing = pre(gone, 'claude-code', 'WebFetch', {}, 'missing');
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stderr).toContain('unmapped harness tool "WebFetch"');
    expect(existsSync(gone.state + '.decisions/log.jsonl')).toBe(false);

    const id = 'C'.repeat(180) + ctx.key;
    const hidden = pre(ctx, 'claude-code', 'WebFetch', {}, id);
    expect(hidden.status, hidden.stderr).toBe(2);
    const line = linesOf(ctx.state).at(-1)!;
    expect(JSON.stringify(line)).not.toContain(ctx.key);
    expect(String(line.call_id)).toContain('<keyfile>');
    expect(String(line.call_id).length).toBeLessThanOrEqual(200);
  });

  it('overlapping denials serialize onto one chain', async () => {
    const ctx = newState();
    const once = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        join(agentDir, 'adapter.mjs'), 'claude-code', 'pre',
        '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 2 && stderr.includes('unmapped harness tool')) resolve();
        else reject(new Error(id + ' exit ' + code + ' ' + stderr));
      });
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {}, tool_use_id: id, cwd: ctx.project,
      }));
    });
    await Promise.all(['a', 'b', 'c', 'd'].map(once));
    const lines = linesOf(ctx.state);
    expect(lines.map(l => l.class)).toEqual(['unmapped', 'unmapped', 'unmapped', 'unmapped']);
    expect(lines.map(l => l.seq)).toEqual([0, 1, 2, 3]);
    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
  });

  it('a post-event unmapped call is recorded as phase post', () => {
    const ctx = newState();
    const post = adapter(ctx, 'claude-code', 'post', payload('claude-code', 'PostToolUse', 'WebFetch', {}, 'post-u'));
    expect(post.status, post.stderr).toBe(2);
    expect(post.stderr).toContain('without a Speckl mapping');
    expect(linesOf(ctx.state)).toMatchObject([{ class: 'unmapped', phase: 'post', verdict: 'deny', tool: 'WebFetch' }]);
  });
});
