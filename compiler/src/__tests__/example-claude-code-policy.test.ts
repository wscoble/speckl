// End-to-end: examples/ClaudeCodePolicy.speckdl compiled, installed into a
// project with adapter.mjs install, and driven with real-format Claude Code
// and Cursor hook payloads through the exact command lines the harness runs.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const fixtures = join(compilerDir, 'src', '__tests__', 'fixtures', 'harness');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;

interface Run { status: number | null; stdout: string; stderr: string }

function sh(command: string, cwd: string, env: Record<string, string>, input = ''): Run {
  const r = spawnSync('sh', ['-c', command], { cwd, input, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixture(harness: string, name: string, project: string): string {
  return readFileSync(join(fixtures, harness, name + '.json'), 'utf-8').replace(/__PROJECT__/g, project);
}

function setup(harness: 'claude-code' | 'cursor') {
  const project = mkdtempSync(join(tmpdir(), `speckl-${harness}-proj-`));
  const keyDir = mkdtempSync(join(tmpdir(), 'speckl-key-outside-'));
  const key = join(keyDir, 'state.key');
  mkdirSync(join(project, 'src'));
  cpSync(example, join(project, 'policy.speckdl'));
  const c = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), 'policy.speckdl', '-t', 'all', '-o', '.speckl'],
    { cwd: project, encoding: 'utf-8' });
  if (c.status !== 0) throw new Error(c.stderr || c.stdout);
  const env = { SPECKL_STATE_KEY_FILE: '' };
  const init = sh(`node .speckl/agent/signal.mjs init --state .speckl/state.json --key ${key} --dev`, project, env);
  if (init.status !== 0) throw new Error(init.stderr);
  const inst = sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${key}`, project, env);
  if (inst.status !== 0) throw new Error(inst.stderr);
  return { project, key, env };
}

function stateOf(project: string) {
  return JSON.parse(readFileSync(join(project, '.speckl', 'state.json'), 'utf-8'));
}

describe('examples/ClaudeCodePolicy.speckdl — proofs', () => {
  it.skipIf(!hasZ3)('both invariants hold at depth 8', () => {
    const { project } = setup('claude-code');
    const smt = readFileSync(join(project, '.speckl', 'ClaudeCodePolicy.smt2'), 'utf-8').replace(/\(get-model\)/g, '');
    const r = spawnSync('z3', ['-smt2', '-in'], { input: smt, encoding: 'utf-8' });
    const verdicts = r.stdout.split('\n').map(l => l.trim()).filter(l => /^(un)?sat$/.test(l));
    expect(verdicts).toEqual(['unsat', 'unsat']);
  }, 90_000);
});

describe('Claude Code wiring (real payloads through .claude/settings.json)', () => {
  let ctx: ReturnType<typeof setup>;
  let settings: any;
  const cmd = (event: string) => settings.hooks[event][0].hooks[0].command as string;
  const send = (event: string, name: string) =>
    sh(cmd(event), ctx.project, { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.project }, fixture('claude-code', name, ctx.project));

  beforeAll(() => {
    ctx = setup('claude-code');
    settings = JSON.parse(readFileSync(join(ctx.project, '.claude', 'settings.json'), 'utf-8'));
  }, 90_000);

  it('installs the four hook events with fail-closed pre', () => {
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch']);
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    expect(cmd('PreToolUse')).toBe(`node "\${CLAUDE_PROJECT_DIR}/.speckl/agent/adapter.mjs" claude-code pre --state "\${CLAUDE_PROJECT_DIR}/.speckl/state.json" --key ${ctx.key}`);
  });

  it('walks edit → failing test → green test → review → approval → push', () => {
    const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
    const deny = (r: Run, why: RegExp) => { expect(r.status).toBe(2); expect(r.stderr).toMatch(why); };

    allow(send('PreToolUse', 'pre-edit'));
    allow(send('PostToolUse', 'post-edit'));

    allow(send('PreToolUse', 'pre-npm-test'));
    allow(send('PostToolUseFailure', 'post-failure-npm-test'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });

    deny(send('PreToolUse', 'pre-git-commit'), /Speckl denied Bash \(spec tool request_review\): Speckl denied \(not allowed in this stage\): can\(\) refused/);

    allow(send('PreToolUse', 'pre-npm-test-2'));
    allow(send('PostToolUse', 'post-npm-test-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });

    allow(send('PreToolUse', 'pre-git-commit'));
    allow(send('PostToolUse', 'post-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    // Waiting on the judge: act tools refused, observe tools allowed.
    deny(send('PreToolUse', 'pre-git-push'), /HNTL: act tool refused while awaiting signal review/);
    deny(send('PreToolUse', 'pre-edit'), /HNTL/);
    allow(send('PreToolUse', 'pre-read'));
    allow(send('PostToolUse', 'post-read'));

    // The rails are off limits, whatever the tool.
    deny(send('PreToolUse', 'pre-read-state'), /Speckl-protected path/);
    deny(send('PreToolUse', 'pre-edit-settings'), /Speckl-protected path/);
    deny(send('PreToolUse', 'pre-bash-signal'), /Speckl-protected path/);
    // Unmapped or chained calls fail closed.
    deny(send('PreToolUse', 'pre-chained'), /shell control characters/);
    deny(send('PreToolUse', 'pre-webfetch'), /unmapped harness tool "WebFetch"/);
    deny(send('PreToolUse', 'pre-mcp'), /unmapped harness tool "mcp__github__create_pull_request"/);

    // A human approves from their own terminal (DEV cli verifier).
    const ap = sh(`node .speckl/agent/signal.mjs apply --state .speckl/state.json --key ${ctx.key} --verifier cli --outcome approve --as alice --claim_reviewer alice`, ctx.project, ctx.env);
    expect(ap.status, ap.stderr).toBe(0);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    // A push the user declines in the permission prompt never posts; the
    // batch hook clears it as failed so it neither sticks nor advances.
    allow(send('PreToolUse', 'pre-declined-push'));
    expect(stateOf(ctx.project).pending.call_id).toBe('toolu_14Push');
    const b = send('PostToolBatch', 'post-tool-batch');
    expect(b.status).toBe(0);
    expect(JSON.parse(b.stdout).hookSpecificOutput.additionalContext).toContain('cleared 1 tool call');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    allow(send('PreToolUse', 'pre-git-push-2'));
    allow(send('PostToolUse', 'post-git-push-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, testsPassed: true, prFromApproved: true });
  }, 120_000);

  it('malformed input and a wrong event both deny', () => {
    const bad = sh(cmd('PreToolUse'), ctx.project, { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.project }, '{not json');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('hook payload is not JSON');
    const wrong = sh(cmd('PreToolUse'), ctx.project, { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.project }, fixture('claude-code', 'post-edit', ctx.project));
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('wired as PreToolUse');
  });

  it('a missing key fails closed', () => {
    const r = sh(cmd('PreToolUse').replace(ctx.key, ctx.key + '.missing'), ctx.project, { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.project },
      fixture('claude-code', 'pre-read', ctx.project));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Speckl denied Read/);
  });
});

describe('Cursor wiring (real payloads through .cursor/hooks.json)', () => {
  let ctx: ReturnType<typeof setup>;
  let hooks: any;
  const send = (event: string, name: string) =>
    sh(hooks.hooks[event][0].command, ctx.project, { ...ctx.env, CURSOR_PROJECT_DIR: ctx.project }, fixture('cursor', name, ctx.project));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual({ permission: 'allow' }); };
  const deny = (r: Run, why: RegExp) => {
    expect(r.status).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body.permission).toBe('deny');
    expect(body.agent_message).toMatch(why);
  };
  const posted = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe('{}\n'); };

  beforeAll(() => {
    ctx = setup('cursor');
    hooks = JSON.parse(readFileSync(join(ctx.project, '.cursor', 'hooks.json'), 'utf-8'));
  }, 90_000);

  it('installs version 1 hooks, all fail closed', () => {
    expect(hooks.version).toBe(1);
    for (const ev of ['preToolUse', 'postToolUse', 'postToolUseFailure']) expect(hooks.hooks[ev][0].failClosed).toBe(true);
  });

  it('walks write → failing test → green test → review → approval → declined push', () => {
    allow(send('preToolUse', 'pre-write'));
    posted(send('postToolUse', 'post-write'));
    allow(send('preToolUse', 'pre-shell-npm-test'));
    posted(send('postToolUse', 'post-shell-npm-test-exit1'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    allow(send('preToolUse', 'pre-shell-npm-test-2'));
    posted(send('postToolUse', 'post-shell-npm-test-2'));
    allow(send('preToolUse', 'pre-shell-git-commit'));
    posted(send('postToolUse', 'post-shell-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);
    deny(send('preToolUse', 'pre-shell-git-push'), /HNTL/);
    deny(send('preToolUse', 'pre-read-hooks'), /Speckl-protected path/);
    deny(send('preToolUse', 'pre-mcp'), /unmapped harness tool "MCP:create_pull_request"/);
    deny(send('preToolUse', 'pre-shell-chained'), /shell control characters/);

    const ap = sh(`node .speckl/agent/signal.mjs apply --state .speckl/state.json --key ${ctx.key} --verifier cli --outcome approve --as alice --claim_reviewer alice`, ctx.project, ctx.env);
    expect(ap.status, ap.stderr).toBe(0);
    allow(send('preToolUse', 'pre-shell-git-push'));
    posted(send('postToolUseFailure', 'post-failure-shell-git-push'));
    const st = stateOf(ctx.project);
    expect(st.pending).toBeNull();
    expect(st.machine.state.stage).toBe(3);
  }, 120_000);
});

describe('fail closed when the hook itself fails (real adapter, both harnesses)', () => {
  const broken: Record<string, string> = {
    crash: "throw new Error('boom');\n",
    exit1: "process.stdout.write('{\"decision\":\"allow\"}\\n'); process.exit(1);\n",
    garbage: "process.stdout.write('not json at all\\n'); process.exit(0);\n",
    killed: "process.kill(process.pid, 'SIGKILL');\n",
    hang: 'setInterval(() => {}, 1000);\n',
  };
  for (const harness of ['claude-code', 'cursor'] as const) {
    it(`${harness}: crash, exit 1, malformed output, SIGKILL and timeout all block`, async () => {
      const { writeFileSync } = await import('node:fs');
      const ctx = setup(harness);
      const settings = JSON.parse(readFileSync(join(ctx.project, harness === 'cursor' ? '.cursor/hooks.json' : '.claude/settings.json'), 'utf-8'));
      const command = harness === 'cursor' ? settings.hooks.preToolUse[0].command : settings.hooks.PreToolUse[0].hooks[0].command;
      const payload = harness === 'cursor' ? fixture('cursor', 'pre-shell-npm-test', ctx.project) : fixture('claude-code', 'pre-npm-test', ctx.project);
      const env = { ...ctx.env, CLAUDE_PROJECT_DIR: ctx.project, CURSOR_PROJECT_DIR: ctx.project, SPECKL_HOOK_TIMEOUT_MS: '700' };
      const hook = join(ctx.project, '.speckl', 'agent', 'hook.mjs');
      const good = readFileSync(hook, 'utf-8');
      for (const [name, body] of Object.entries(broken)) {
        writeFileSync(hook, body);
        const t0 = Date.now();
        const r = sh(command, ctx.project, env, payload);
        expect(r.status, `${name}: ${r.stderr}`).toBe(2);
        if (harness === 'cursor') expect(JSON.parse(r.stdout).permission, name).toBe('deny');
        if (name === 'hang') {
          expect(r.stderr).toContain('timed out after 700ms');
          expect(Date.now() - t0).toBeLessThan(10_000);
        }
      }
      // The adapter failing before it can decide (corrupt config) blocks too.
      writeFileSync(hook, good);
      writeFileSync(join(ctx.project, '.speckl', 'agent', 'agent-config.json'), '{corrupt');
      const r = sh(command, ctx.project, env, payload);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Speckl adapter error');
    }, 120_000);
  }
});
