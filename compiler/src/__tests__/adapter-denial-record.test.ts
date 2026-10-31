// Adapter-stage denials (unmapped tool, shell metacharacters, a protected
// path, a bad payload) are appended to the decision record by hook.mjs deny.
// The call stays denied when the state is tampered or the recorder crashes.
// An allowed call is still only the hook's pre/post lines, with no class.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, chmodSync, utimesSync } from 'node:fs';
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

function run(file: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): R {
  const r = spawnSync(process.execPath, [file, ...args], {
    input, encoding: 'utf-8', env: env ? { ...process.env, ...env } : process.env,
  });
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

function adapter(ctx: { project: string; state: string; key: string }, harness: string, event: string, stdin: string, env?: NodeJS.ProcessEnv): R {
  return run(join(agentDir, 'adapter.mjs'), [
    harness, event, '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
  ], stdin.replace(/"cwd":""/g, '"cwd":' + JSON.stringify(ctx.project)), env);
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
    const uniLine = linesOf(ctx.state).at(-1)!;
    expect(uniLine).toMatchObject({ class: 'unmapped', verdict: 'deny' });
    expect(uniLine.tool).toBe('<tool name withheld>:' + crypto.createHash('sha256').update(name).digest('hex'));
    expect(JSON.stringify(uniLine)).not.toContain(name);

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
    expect(String(secretLine.tool)).toMatch(/^<tool name withheld>:[0-9a-f]{64}$/);

    const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const nullDigest = sha('null');
    const huge = pre(ctx, 'claude-code', 'WebFetch', { blob: 'a'.repeat(80_000) }, 'huge');
    expect(huge.status, huge.stderr).toBe(2);
    const hugeLine = linesOf(ctx.state).at(-1)!;
    expect(hugeLine.class).toBe('unmapped');
    const sizeDigest = sha('speckl:withheld:size');
    expect(hugeLine.input_sha256).toBe(sizeDigest);
    expect(hugeLine.input_withheld).toBe('size');
    expect(hugeLine.input_sha256).not.toBe(nullDigest);
    const asText = pre(ctx, 'claude-code', 'WebFetch', '<input too large>', 'marker-text');
    expect(asText.status, asText.stderr).toBe(2);
    const textLine = linesOf(ctx.state).at(-1)!;
    expect(textLine.input_sha256).toBe(sha(JSON.stringify('<input too large>')));
    expect(textLine.input_sha256).not.toBe(sizeDigest);
    expect(textLine.input_withheld).toBeUndefined();

    let deep: unknown = { command: 'nope' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const nested = pre(ctx, 'claude-code', 'WebFetch', deep, 'deep');
    expect(nested.status, nested.stderr).toBe(2);
    // Too deep to walk. That is a payload problem, not a protected path,
    // and its digest is not the digest of a real null input.
    expect(nested.stderr).toContain('nested too deeply');
    expect(nested.stderr).not.toContain('Speckl-protected path');
    const deepLine = linesOf(ctx.state).at(-1)!;
    expect(deepLine.class).toBe('bad-payload');
    expect(deepLine.input_withheld).toBe('depth');
    expect(deepLine.input_sha256).toBe(sha('speckl:withheld:depth'));
    expect(deepLine.input_sha256).not.toBe(sha(JSON.stringify('<input too deep>')));
    expect(deepLine.input_sha256).not.toBe(nullDigest);

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
    expect(String(line.call_id)).toMatch(/^<call id withheld>:[0-9a-f]{64}$/);
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

  it('key-path spellings are redacted, and a hostile tool name cannot pick the class', () => {
    const base = mkdtempSync(join(tmpdir(), 'speckl-keybase-'));
    const project = join(base, 'proj');
    const key = join(base, 'keys', 'state.key');
    mkdirSync(join(base, 'keys'), { recursive: true });
    mkdirSync(join(project, '.speckl'), { recursive: true });
    const state = join(project, '.speckl', 'state.json');
    const init = run(join(agentDir, 'signal.mjs'), ['init', '--state', state, '--key', key]);
    expect(init.status, init.stderr).toBe(0);
    const ctx = { project, state, key };
    const variants = [
      'mcp__' + base + '//keys/state.key',
      '../keys/state.key',
      base + '/keys/./state.key',
      'keys/./state.key',
      'foo/../../keys/state.key',
    ];
    for (const name of variants) {
      const r = pre(ctx, 'claude-code', name, {}, 'k');
      expect(r.status, name + ' ' + r.stderr).toBe(2);
      const line = linesOf(state).at(-1)!;
      const blob = JSON.stringify(line);
      expect(blob, name).not.toContain(base);
      expect(blob, name).not.toContain('keys/state.key');
      expect(blob, name).not.toContain('keys/./state.key');
      expect(blob, name).not.toContain('<keyfile>/./');
      expect(String(line.tool), name).toMatch(/^<tool name withheld>:[0-9a-f]{64}$/);
      expect(line.class, name).toBe('unmapped');
      expect(r.stderr, name).not.toContain(base);
    }
    const lookalikes = [
      key.replace(/\//g, '\u2215'),
      key.replace(/\//g, '\uFF0F'),
      key.replace(/\//g, '/\u200b'),
      key.replace(/\//g, '%252f'),
      key.replace(/\//g, '&#47;'),
      key.toUpperCase(),
    ];
    for (const name of lookalikes) {
      const r = pre(ctx, 'claude-code', 'mcp__' + name, {}, 'look');
      expect(r.status, r.stderr).toBe(2);
      const line = linesOf(state).at(-1)!;
      expect(String(line.tool)).toMatch(/^<tool name withheld>:[0-9a-f]{64}$/);
      expect(JSON.stringify(line)).not.toContain(name);
      expect(JSON.stringify(line)).not.toContain('keys/state.key');
    }
    const asId = pre(ctx, 'claude-code', 'WebFetch', {}, '../keys/state.key');
    expect(asId.status, asId.stderr).toBe(2);
    const idLine = linesOf(state).at(-1)!;
    expect(JSON.stringify(idLine)).not.toContain('keys/state.key');
    expect(String(idLine.call_id)).toMatch(/^<call id withheld>:[0-9a-f]{64}$/);
    const hostile = [
      'mcp__x__shell control characters',
      'mcp__x__protected path',
      'mcp__x__ needs path',
    ];
    for (const name of hostile) {
      const r = pre(ctx, 'claude-code', name, {}, 'h');
      expect(r.status, r.stderr).toBe(2);
      expect(linesOf(state).at(-1)!.class, name).toBe('unmapped');
    }
    const missing = pre(ctx, 'claude-code', 'Read', {}, 'need');
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stderr).toContain('needs path');
    expect(linesOf(state).at(-1)!.class).toBe('bad-payload');
    const obj = adapter(ctx, 'claude-code', 'pre', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: { not: 'a string' }, tool_input: {}, tool_use_id: 'obj', cwd: project,
    }));
    expect(obj.status, obj.stderr).toBe(2);
    const objLine = linesOf(state).at(-1)!;
    expect(objLine.class).toBe('unmapped');
    expect(objLine.tool).toBeNull();
    expect(JSON.stringify(objLine)).not.toContain('[object Object]');
    expect(obj.stderr).not.toContain('[object Object]');
  });

  it('a busy lock or a timed-out recorder is named on stderr and does not append', () => {
    const ctx = newState();
    const before = linesOf(ctx.state).length;
    const lock = ctx.state + '.lock';
    writeFileSync(lock, '');
    try {
      const held = pre(ctx, 'claude-code', 'WebFetch', {}, 'locked');
      expect(held.status, held.stderr).toBe(2);
      expect(held.stderr).toContain('unmapped harness tool "WebFetch"');
      expect(held.stderr).toContain('(denial not recorded: state lock timeout)');
      expect(linesOf(ctx.state)).toHaveLength(before);
    } finally {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
    const timed = adapter(ctx, 'claude-code', 'pre', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {}, tool_use_id: 't', cwd: ctx.project,
    }), { SPECKL_HOOK_TIMEOUT_MS: '1' });
    expect(timed.status, timed.stderr).toBe(2);
    expect(timed.stderr).toContain('(denial may not be recorded: hook.mjs timed out)');
    expect(timed.stderr).toContain('unmapped harness tool "WebFetch"');
  }, 20_000);

  it('a dead lock owner does not block the next allow, and a denial flood stays bounded', async () => {
    const ctx = newState();
    const lock = ctx.state + '.lock';
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.on('spawn', () => resolve());
    });
    writeFileSync(lock, String(holder.pid));
    holder.kill('SIGKILL');
    await new Promise<void>(resolve => holder.on('exit', () => resolve()));
    const t0 = Date.now();
    const allowed = pre(ctx, 'claude-code', 'Bash', { command: 'git status' }, 'after-dead-lock');
    const dt = Date.now() - t0;
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(dt, 'dead lock owner').toBeLessThan(2000);
    expect(existsSync(lock)).toBe(false);
    const clear = adapter(ctx, 'claude-code', 'post', payload('claude-code', 'PostToolUse', 'Bash', { command: 'git status' }, 'after-dead-lock'));
    expect(clear.status, clear.stderr).toBe(0);
    expect(JSON.parse(readFileSync(ctx.state, 'utf-8')).pending).toBeNull();

    const floodN = 40;
    const flood = Array.from({ length: floodN }, (_, i) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        join(agentDir, 'adapter.mjs'), 'claude-code', 'pre',
        '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', reject);
      child.on('exit', code => code === 2 ? resolve() : reject(new Error('flood ' + i + ' exit ' + code)));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {}, tool_use_id: 'f' + i, cwd: ctx.project,
      }));
    }));
    await new Promise(r => setTimeout(r, 50));
    const a0 = Date.now();
    const during = pre(ctx, 'claude-code', 'Bash', { command: 'git status' }, 'during-flood');
    const allowMs = Date.now() - a0;
    await Promise.all(flood);
    expect(during.status, during.stderr + ' after ' + allowMs + 'ms').toBe(0);
    expect(allowMs, 'allow latency under a denial flood').toBeLessThan(4000);
    const post = adapter(ctx, 'claude-code', 'post', payload('claude-code', 'PostToolUse', 'Bash', { command: 'git status' }, 'during-flood'));
    expect(post.status === 0 || post.status === 2, post.stderr).toBe(true);
    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
  }, 30_000);

  it('a short normalized key path is refused with a visible notice and no record', () => {
    const ctx = newState();
    const rel = join(ctx.project, 'k.key');
    writeFileSync(rel, readFileSync(ctx.key));
    const before = linesOf(ctx.state).length;
    const denied = run(join(agentDir, 'adapter.mjs'), [
      'claude-code', 'pre', '--project', ctx.project, '--state', ctx.state, '--key', './././k.key',
    ], JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'mcp__x__k.key', tool_input: {}, tool_use_id: 's', cwd: ctx.project,
    }), { ...process.env });
    expect(denied.status, denied.stderr).toBe(2);
    expect(denied.stderr).toContain('(denial not recorded: state key path too short)');
    expect(linesOf(ctx.state)).toHaveLength(before);
    expect(denied.stderr).not.toContain('mcp__x__k.key');
  });

  it('a published lock contains a pid, and a partial key is not stored', async () => {
    const ctx = newState();
    const lock = ctx.state + '.lock';
    let bad = 0;
    let samples = 0;
    const stop = { v: false };
    const watch = (async () => {
      while (!stop.v) {
        try {
          const text = readFileSync(lock, 'utf-8');
          samples++;
          if (!/^[1-9][0-9]*$/.test(text.trim())) bad++;
        } catch { /* lock absent */ }
        await new Promise(r => setTimeout(r, 1));
      }
    })();
    const kids: ReturnType<typeof spawn>[] = [];
    for (let i = 0; i < 24; i++) {
      const child = spawn(process.execPath, [
        join(agentDir, 'adapter.mjs'), 'claude-code', 'pre',
        '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      kids.push(child);
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {}, tool_use_id: 'atom' + i, cwd: ctx.project,
      }));
      if (i % 2 === 0) setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } }, 8);
    }
    await Promise.all(kids.map(child => new Promise<void>(resolve => {
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    })));
    stop.v = true;
    await watch;
    expect(samples, 'saw the lock').toBeGreaterThan(0);
    expect(bad, 'empty or non-pid lock').toBe(0);
    const next = pre(ctx, 'claude-code', 'WebFetch', {}, 'after-atom');
    expect(next.status, next.stderr).toBe(2);
    expect(next.stderr).toContain('unmapped harness tool');

    const keyHex = readFileSync(ctx.key, 'utf-8').trim();
    expect(keyHex).toMatch(/^[0-9a-fA-F]{64}$/);
    const sixteen = 'mcp__x__' + keyHex.slice(0, 16);
    const fifteen = 'mcp__x__' + keyHex.slice(0, 15);
    const hit = pre(ctx, 'claude-code', sixteen, {}, 'k16');
    expect(hit.status, hit.stderr).toBe(2);
    const hitLine = linesOf(ctx.state).at(-1)!;
    expect(String(hitLine.tool)).toMatch(/^<tool name withheld>:[0-9a-f]{64}$/);
    expect(JSON.stringify(hitLine).toLowerCase()).not.toContain(keyHex.slice(0, 16).toLowerCase());
    const miss = pre(ctx, 'claude-code', fifteen, {}, 'k15');
    expect(miss.status, miss.stderr).toBe(2);
    expect(linesOf(ctx.state).at(-1)!.tool).toBe(fifteen);
    const colon = pre(ctx, 'claude-code', 'dir:keys:state.key', {}, 'colon');
    expect(colon.status, colon.stderr).toBe(2);
    expect(linesOf(ctx.state).at(-1)!.tool).toBe('dir:keys:state.key');
  }, 20_000);

  it('parallel callers on a dead lock do not fork the decision chain', async () => {
    const ctx = newState();
    const lock = ctx.state + '.lock';
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.on('spawn', () => resolve());
    });
    const deadPid = holder.pid;
    holder.kill('SIGKILL');
    await new Promise<void>(resolve => holder.on('exit', () => resolve()));
    const burners = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', 'for(;;){}']));
    const bursts = 8;
    const width = 32;
    try {
      for (let b = 0; b < bursts; b++) {
        writeFileSync(lock, String(deadPid));
        const kids = Array.from({ length: width }, (_, i) => new Promise<void>((resolve) => {
          const child = spawn(process.execPath, [
            join(agentDir, 'adapter.mjs'), 'claude-code', 'pre',
            '--project', ctx.project, '--state', ctx.state, '--key', ctx.key,
          ], { stdio: ['pipe', 'pipe', 'pipe'] });
          child.on('exit', () => resolve());
          child.on('error', () => resolve());
          child.stdin.end(JSON.stringify({
            hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {},
            tool_use_id: 'race' + b + 'x' + i, cwd: ctx.project,
          }));
        }));
        await Promise.all(kids);
      }
      const lines = linesOf(ctx.state);
      const seqs = lines.map(l => l.seq);
      expect(new Set(seqs).size, 'duplicate seq ' + seqs.join(',')).toBe(seqs.length);
      for (let i = 0; i < seqs.length; i++) expect(seqs[i], 'gap at ' + i).toBe(i);
      expect(lines.length, 'dead lock was never broken').toBeGreaterThan(0);
      const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
      expect(verify.status, verify.stderr).toBe(0);
      const allowed = pre(ctx, 'claude-code', 'Bash', { command: 'git status' }, 'after-race');
      expect(allowed.status, allowed.stderr).toBe(0);
    } finally {
      for (const burner of burners) { try { burner.kill('SIGKILL'); } catch { /* exited */ } }
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }, 90_000);

  it('a dead-pid lock temp is removed on the next acquire and a live one is left', async () => {
    const ctx = newState();
    const lock = ctx.state + '.lock';
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const dead = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await Promise.all([live, dead].map(child => new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('spawn', () => resolve());
    })));
    dead.kill('SIGKILL');
    await new Promise<void>(resolve => dead.on('exit', () => resolve()));
    const deadTmp = lock + '.tmp.' + dead.pid + '.leftover';
    const liveTmp = lock + '.tmp.' + live.pid + '.leftover';
    const deadStale = lock + '.stale.' + dead.pid + '.leftover';
    writeFileSync(deadTmp, String(dead.pid));
    writeFileSync(liveTmp, String(live.pid));
    writeFileSync(deadStale, String(dead.pid));
    try {
      const denied = pre(ctx, 'claude-code', 'WebFetch', {}, 'sweep');
      expect(denied.status, denied.stderr).toBe(2);
      expect(existsSync(deadTmp), 'dead tmp swept').toBe(false);
      expect(existsSync(deadStale), 'dead stale swept').toBe(false);
      expect(existsSync(liveTmp), 'live tmp kept').toBe(true);
      expect(readFileSync(liveTmp, 'utf-8')).toBe(String(live.pid));
    } finally {
      try { live.kill('SIGKILL'); } catch { /* exited */ }
      try { unlinkSync(liveTmp); } catch { /* already gone */ }
    }
  }, 20_000);

  it('records a denial when link() cannot make a hard link', () => {
    const ctx = newState();
    const preload = join(ctx.project, 'no-link.cjs');
    const marker = join(ctx.project, 'link-marker.txt');
    writeFileSync(preload, [
      "const fs = require('fs');",
      "const marker = process.env.SPECKL_LINK_MARKER;",
      "fs.linkSync = function () {",
      "  if (marker) { try { fs.appendFileSync(marker, 'x'); } catch (e) {} }",
      "  const err = new Error('ENOTSUP');",
      "  err.code = 'ENOTSUP';",
      "  throw err;",
      "};",
      '',
    ].join('\n'));
    const recorded = adapter(ctx, 'claude-code', 'pre', payload('claude-code', 'PreToolUse', 'WebFetch', {}, 'nolink'), {
      NODE_OPTIONS: '--require ' + preload,
      SPECKL_LINK_MARKER: marker,
    });
    expect(recorded.status, recorded.stderr).toBe(2);
    expect(recorded.stderr).toContain('unmapped harness tool "WebFetch"');
    expect(recorded.stderr).not.toContain('denial not recorded');
    expect(existsSync(marker), 'linkSync was not called').toBe(true);
    const line = linesOf(ctx.state).at(-1)!;
    expect(line.class).toBe('unmapped');
    expect(line.tool).toBe('WebFetch');
    expect(existsSync(ctx.state + '.lock'), 'lock left behind').toBe(false);
    const leftovers = readdirSync(join(ctx.project, '.speckl')).filter(name => name.indexOf('state.json.lock') === 0);
    expect(leftovers, leftovers.join(',')).toEqual([]);
    const verify = run(join(agentDir, 'signal.mjs'), ['verify', '--state', ctx.state, '--key', ctx.key]);
    expect(verify.status, verify.stderr).toBe(0);
  });

  function denyStdin(id: string): string {
    return JSON.stringify({
      class: 'unmapped', reason: 'unmapped harness tool "WebFetch"', phase: 'pre',
      tool: 'WebFetch', call_id: id, input: {},
    });
  }
  function hookDeny(ctx: { state: string; key: string }, id: string, env?: NodeJS.ProcessEnv): R {
    return run(join(agentDir, 'hook.mjs'), ['deny', '--state', ctx.state, '--key', ctx.key], denyStdin(id), env);
  }
  function expectRefused(ctx: { project: string; state: string; key: string }, id: string, env?: NodeJS.ProcessEnv) {
    const before = JSON.stringify(linesOf(ctx.state));
    const hook = hookDeny(ctx, id + '-hook', env);
    expect(hook.status, hook.stderr).not.toBe(0);
    expect(hook.status, hook.stderr).not.toBeNull();
    expect(hook.stderr, hook.stderr).toContain('decision record unavailable');
    const via = adapter(ctx, 'claude-code', 'pre', payload('claude-code', 'PreToolUse', 'WebFetch', {}, id), env);
    expect(via.status, via.stderr).toBe(2);
    expect(via.stderr, via.stderr).toContain('(denial not recorded:');
    expect(JSON.stringify(linesOf(ctx.state)), id).toBe(before);
  }

  it('a failed append exits nonzero and the adapter prints a notice', async () => {
    const ctx = newState();
    const seeded = hookDeny(ctx, 'seed');
    expect(seeded.status, seeded.stderr).toBe(0);
    const log = ctx.state + '.decisions/log.jsonl';
    chmodSync(log, 0o444);
    try {
      expectRefused(ctx, 'ro');
    } finally {
      chmodSync(log, 0o644);
    }

    const lost = join(ctx.project, 'spoof-lock.cjs');
    writeFileSync(lost, [
      "const fs = require('fs');",
      "const orig = fs.readFileSync;",
      "fs.readFileSync = function (p, opts) {",
      "  const s = String(p);",
      "  if (s.endsWith('/state.json.lock') || s.endsWith('\\\\state.json.lock')) {",
      "    return typeof opts === 'string' || (opts && opts.encoding) ? '1' : Buffer.from('1');",
      "  }",
      "  return orig.call(this, p, opts);",
      "};",
      '',
    ].join('\n'));
    expectRefused(ctx, 'lost', { NODE_OPTIONS: '--require ' + lost });

    const tail = join(ctx.project, 'move-tail.cjs');
    writeFileSync(tail, [
      "const fs = require('fs');",
      "const crypto = require('crypto');",
      "const orig = fs.readFileSync;",
      "function canonical(v) {",
      "  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';",
      "  if (v !== null && typeof v === 'object') {",
      "    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()",
      "      .map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';",
      "  }",
      "  return JSON.stringify(v === undefined ? null : v);",
      "}",
      "function give(buf, opts) {",
      "  if (typeof opts === 'string') return buf.toString(opts);",
      "  if (opts && opts.encoding) return buf.toString(opts.encoding);",
      "  return buf;",
      "}",
      "let n = 0;",
      "fs.readFileSync = function (p, opts) {",
      "  const buf = orig.call(this, p);",
      "  if (!String(p).endsWith('log.jsonl')) return give(buf, opts);",
      "  n++;",
      "  if (n !== 2) return give(buf, opts);",
      "  const text = buf.toString('utf8');",
      "  const last = JSON.parse(text.trim().split('\\n').pop());",
      "  const body = {};",
      "  for (const k of Object.keys(last)) if (k !== 'hash' && k !== 'mac') body[k] = last[k];",
      "  body.seq = last.seq + 1;",
      "  body.prev = last.hash;",
      "  body.ts = new Date().toISOString();",
      "  const hash = crypto.createHash('sha256').update(canonical(body)).digest('hex');",
      "  const keyHex = orig.call(this, process.env.SPECKL_TAIL_KEY_FILE, 'utf8').trim();",
      "  const mac = crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(hash).digest('hex');",
      "  const extra = Buffer.from(text.replace(/\\n?$/, '\\n') + JSON.stringify(Object.assign({}, body, { hash: hash, mac: mac })) + '\\n');",
      "  return give(extra, opts);",
      "};",
      '',
    ].join('\n'));
    expectRefused(ctx, 'tail', { NODE_OPTIONS: '--require ' + tail, SPECKL_TAIL_KEY_FILE: ctx.key });

    const stop = join(ctx.project, 'stop-after-link.cjs');
    writeFileSync(stop, [
      "const fs = require('fs');",
      "const orig = fs.linkSync;",
      "fs.linkSync = function (src, dest) {",
      "  const r = orig.apply(this, arguments);",
      "  if (String(dest).endsWith('.lock')) process.kill(process.pid, 'SIGSTOP');",
      "  return r;",
      "};",
      '',
    ].join('\n'));
    const findStopped = (pid: number): number => {
      const stack = [pid];
      const seen = new Set<number>();
      while (stack.length) {
        const cur = stack.pop()!;
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        let status = '';
        try { status = readFileSync('/proc/' + cur + '/status', 'utf8'); } catch { continue; }
        const state = (status.match(/^State:\s+(\S+)/m) || [])[1] || '';
        if (state === 'T' || state === 't') return cur;
        let kids = '';
        try { kids = readFileSync('/proc/' + cur + '/task/' + cur + '/children', 'utf8'); } catch { continue; }
        for (const id of kids.trim().split(/\s+/)) if (id) stack.push(Number(id));
      }
      return 0;
    };
    const hold = async (file: string, args: string[], input: string): Promise<R> => {
      const child = spawn(process.execPath, [file, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--require ' + stop },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += String(c); });
      child.stderr.on('data', c => { stderr += String(c); });
      child.stdin.end(input);
      const deadline = Date.now() + 8000;
      let stopped = 0;
      while (Date.now() < deadline && !stopped) {
        if (child.pid) stopped = findStopped(child.pid);
        if (!stopped) await new Promise(r => setTimeout(r, 20));
      }
      if (!stopped) {
        try { child.kill('SIGKILL'); } catch { /* exited */ }
        throw new Error('holder did not pause: ' + stderr);
      }
      try {
        const past = new Date(Date.now() - 31000);
        utimesSync(ctx.state + '.lock', past, past);
        utimesSync(ctx.state + '.lock.break', past, past);
        const broke = hookDeny(ctx, 'pause-breaker-' + file.length);
        expect(broke.status, broke.stderr).toBe(0);
        process.kill(stopped, 'SIGCONT');
        const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
        return { status, stdout, stderr };
      } catch (e) {
        try { process.kill(stopped, 'SIGCONT'); } catch { /* already continued */ }
        try { child.kill('SIGKILL'); } catch { /* exited */ }
        throw e;
      }
    };
    const pausedHook = await hold(
      join(agentDir, 'hook.mjs'),
      ['deny', '--state', ctx.state, '--key', ctx.key],
      denyStdin('paused-hook'),
    );
    expect(pausedHook.status, pausedHook.stderr).not.toBe(0);
    expect(pausedHook.status, pausedHook.stderr).not.toBeNull();
    expect(pausedHook.stderr).toContain('decision record unavailable');
    expect(JSON.stringify(linesOf(ctx.state))).not.toContain('paused-hook');
    const pausedAdapter = await hold(
      join(agentDir, 'adapter.mjs'),
      ['claude-code', 'pre', '--project', ctx.project, '--state', ctx.state, '--key', ctx.key],
      payload('claude-code', 'PreToolUse', 'WebFetch', {}, 'paused-adapter').replace(/"cwd":""/g, '"cwd":' + JSON.stringify(ctx.project)),
    );
    expect(pausedAdapter.status, pausedAdapter.stderr).toBe(2);
    expect(pausedAdapter.stderr).toContain('(denial not recorded:');
    expect(JSON.stringify(linesOf(ctx.state))).not.toContain('paused-adapter');
  }, 40_000);

  it('empty lock temps and pid-less stale dirs older than 30s are swept', () => {
    const ctx = newState();
    const lock = ctx.state + '.lock';
    const old = new Date(Date.now() - 31000);
    const oldTmp = lock + '.tmp.empty.old';
    const youngTmp = lock + '.tmp.empty.young';
    const oldStale = lock + '.stale.empty.old';
    const oldGate = lock + '.break.stale.nopid.old';
    writeFileSync(oldTmp, '');
    writeFileSync(youngTmp, '');
    writeFileSync(oldStale, '');
    mkdirSync(oldGate);
    utimesSync(oldTmp, old, old);
    utimesSync(oldStale, old, old);
    utimesSync(oldGate, old, old);
    const denied = pre(ctx, 'claude-code', 'WebFetch', {}, 'sweep-empty');
    expect(denied.status, denied.stderr).toBe(2);
    expect(existsSync(oldTmp), 'old empty tmp').toBe(false);
    expect(existsSync(oldStale), 'old empty stale').toBe(false);
    expect(existsSync(oldGate), 'old pid-less gate').toBe(false);
    expect(existsSync(youngTmp), 'young empty tmp kept').toBe(true);
    try { unlinkSync(youngTmp); } catch { /* already gone */ }
  });

  it('a post-event unmapped call is recorded as phase post', () => {
    const ctx = newState();
    const post = adapter(ctx, 'claude-code', 'post', payload('claude-code', 'PostToolUse', 'WebFetch', {}, 'post-u'));
    expect(post.status, post.stderr).toBe(2);
    expect(post.stderr).toContain('without a Speckl mapping');
    expect(linesOf(ctx.state)).toMatchObject([{ class: 'unmapped', phase: 'post', verdict: 'deny', tool: 'WebFetch' }]);
  });
});
