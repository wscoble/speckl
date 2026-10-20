// End-to-end: examples/ClaudeCodePolicy.speckdl compiled, installed with
// adapter.mjs install codex|gemini, and driven with real-format Codex CLI and
// Gemini CLI hook payloads through the exact command lines each harness runs.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const fixtures = join(compilerDir, 'src', '__tests__', 'fixtures', 'harness');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

interface Run { status: number | null; stdout: string; stderr: string }

function sh(command: string, cwd: string, env: Record<string, string>, input = ''): Run {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd, input, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixture(harness: string, name: string, project: string): string {
  return readFileSync(join(fixtures, harness, name + '.json'), 'utf-8').replace(/__PROJECT__/g, project);
}

function setup(harness: 'codex' | 'gemini') {
  const project = mkdtempSync(join(tmpdir(), `speckl-${harness}-proj-`));
  const keyDir = mkdtempSync(join(tmpdir(), 'speckl-key-outside-'));
  const key = join(keyDir, 'state.key');
  mkdirSync(join(project, 'src'));
  cpSync(example, join(project, 'policy.speckdl'));
  const c = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), 'policy.speckdl', '-t', 'agent', '-o', '.speckl'],
    { cwd: project, encoding: 'utf-8' });
  if (c.status !== 0) throw new Error(c.stderr || c.stdout);
  const env = { SPECKL_STATE_KEY_FILE: '' };
  const init = sh(`node .speckl/agent/signal.mjs init --state .speckl/state.json --key ${key} --dev`, project, env);
  if (init.status !== 0) throw new Error(init.stderr);
  const inst = sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${key}`, project, env);
  if (inst.status !== 0) throw new Error(inst.stderr);
  const file = harness === 'codex' ? '.codex/hooks.json' : '.gemini/settings.json';
  const config = JSON.parse(readFileSync(join(project, file), 'utf-8'));
  return { project, key, env, config };
}

const stateOf = (project: string) => JSON.parse(readFileSync(join(project, '.speckl', 'state.json'), 'utf-8'));
const approve = (ctx: { project: string; key: string; env: Record<string, string> }) => {
  const ap = sh(`node .speckl/agent/signal.mjs apply --state .speckl/state.json --key ${ctx.key} --verifier cli --outcome approve --as alice --claim_reviewer alice`, ctx.project, ctx.env);
  expect(ap.status, ap.stderr).toBe(0);
};

describe('Codex CLI wiring (real payloads through .codex/hooks.json)', () => {
  let ctx: ReturnType<typeof setup>;
  const cmd = (event: string) => ctx.config.hooks[event][0].hooks[0].command as string;
  // Codex runs hooks from the session cwd, which may be a subdirectory.
  const send = (event: string, name: string) => sh(cmd(event), join(ctx.project, 'src'), ctx.env, fixture('codex', name, ctx.project));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
  const deny = (r: Run, why: RegExp) => { expect(r.status).toBe(2); expect(r.stderr).toMatch(why); };
  const posted = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };

  beforeAll(() => { ctx = setup('codex'); }, 90_000);

  it('installs PreToolUse / PostToolUse / Stop with absolute paths and a blocking pre', () => {
    expect(Object.keys(ctx.config.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'Stop']);
    expect(ctx.config.hooks.PreToolUse[0].matcher).toBe('*');
    expect(cmd('PreToolUse')).toBe(`node ${ctx.project}/.speckl/agent/adapter.mjs codex pre --state ${ctx.project}/.speckl/state.json --key ${ctx.key} --project ${ctx.project} || exit 2`);
    expect(cmd('PostToolUse')).not.toContain('|| exit 2');
    expect(readFileSync(join(ctx.project, '.speckl', 'agent', 'README.md'), 'utf-8')).toContain('wires this hook into claude-code, cursor, codex, gemini, copilot, goose, hermes, pi, opencode, openclaw and cline:');
    // Reference wiring for every declared harness ships next to the adapter.
    for (const f of ['claude-code/settings.json', 'cursor/hooks.json', 'codex/hooks.json', 'gemini/settings.json']) {
      expect(() => JSON.parse(readFileSync(join(ctx.project, '.speckl', 'agent', 'harness', f), 'utf-8')), f).not.toThrow();
    }
  });

  it('walks patch → MCP tests (red, green) → review → approval → PR, with Bash never advancing', () => {
    allow(send('PreToolUse', 'pre-apply-patch'));
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: 'src/app.js' } });
    posted(send('PostToolUse', 'post-apply-patch'));
    expect(stateOf(ctx.project).pending).toBeNull();

    // A patch that touches the rails is refused whatever the file.
    deny(send('PreToolUse', 'pre-apply-patch-rails'), /Speckl-protected path/);

    // Bash is allowed by the policy but its exit status is unknown: not a success.
    allow(send('PreToolUse', 'pre-bash-npm-test'));
    const p = send('PostToolUse', 'post-bash-npm-test');
    expect(p.status).toBe(0);
    expect(JSON.parse(p.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse' });
    expect(JSON.parse(p.stdout).hookSpecificOutput.additionalContext).toMatch(/does not report a Bash exit status/);
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('PreToolUse', 'pre-bash-chained'), /shell control characters/);

    allow(send('PreToolUse', 'pre-mcp-run-tests'));
    posted(send('PostToolUse', 'post-mcp-run-tests-fail'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('PreToolUse', 'pre-mcp-request-review'), /can\(\) refused/);

    allow(send('PreToolUse', 'pre-mcp-run-tests-2'));
    posted(send('PostToolUse', 'post-mcp-run-tests-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });

    allow(send('PreToolUse', 'pre-mcp-request-review'));
    posted(send('PostToolUse', 'post-mcp-request-review'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny(send('PreToolUse', 'pre-mcp-create-pr'), /HNTL: act tool refused/);
    allow(send('PreToolUse', 'pre-bash-git-status'));
    send('PostToolUse', 'post-bash-git-status');
    deny(send('PreToolUse', 'pre-view-image'), /unmapped harness tool "view_image"/);

    approve(ctx);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    // The user declines the PR call at the approval prompt: no PostToolUse.
    // Stop clears it as failed so the next call is not refused as parallel.
    allow(send('PreToolUse', 'pre-mcp-create-pr'));
    expect(stateOf(ctx.project).pending.call_id).toBe('call_M4pr');
    const stop = send('Stop', 'stop');
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    expect(stop.stderr).toContain('cleared pending call call_M4pr');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    allow(send('PreToolUse', 'pre-mcp-create-pr-2'));
    posted(send('PostToolUse', 'post-mcp-create-pr-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });

    // Stop with nothing pending is a quiet no-op.
    const idle = send('Stop', 'stop');
    expect(idle).toMatchObject({ status: 0, stdout: '', stderr: '' });
  }, 120_000);
});

describe('Gemini CLI wiring (real payloads through .gemini/settings.json)', () => {
  let ctx: ReturnType<typeof setup>;
  const cmd = (event: string) => ctx.config.hooks[event][0].hooks[0].command as string;
  const send = (event: string, name: string) =>
    sh(cmd(event), ctx.project, { ...ctx.env, GEMINI_PROJECT_DIR: ctx.project }, fixture('gemini', name, ctx.project));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual({}); };
  const deny = (r: Run, why: RegExp) => { expect(r.status).toBe(2); expect(r.stdout).toBe(''); expect(r.stderr).toMatch(why); };
  const posted = allow;

  beforeAll(() => { ctx = setup('gemini'); }, 90_000);

  it('installs BeforeTool / AfterTool / AfterAgent with regex matchers and ms timeouts', () => {
    expect(Object.keys(ctx.config.hooks)).toEqual(['BeforeTool', 'AfterTool', 'AfterAgent']);
    expect(ctx.config.hooks.BeforeTool[0].matcher).toBe('.*');
    expect(ctx.config.hooks.BeforeTool[0].hooks[0]).toMatchObject({ type: 'command', timeout: 30000, name: 'speckl-pre' });
    expect(cmd('BeforeTool')).toMatch(/ gemini pre --state .* \|\| exit 2$/);
  });

  it('walks write → failing test → green test → review → approval → cancelled push → push', () => {
    allow(send('BeforeTool', 'pre-write-file'));
    posted(send('AfterTool', 'post-write-file'));
    allow(send('BeforeTool', 'pre-shell-npm-test'));
    posted(send('AfterTool', 'post-shell-npm-test-exit1'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('BeforeTool', 'pre-shell-git-commit'), /Speckl denied run_shell_command \(spec tool request_review\): can\(\) refused/);

    allow(send('BeforeTool', 'pre-shell-npm-test-2'));
    posted(send('AfterTool', 'post-shell-npm-test-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow(send('BeforeTool', 'pre-shell-git-commit'));
    posted(send('AfterTool', 'post-shell-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny(send('BeforeTool', 'pre-shell-git-push'), /HNTL/);
    allow(send('BeforeTool', 'pre-read-file'));
    posted(send('AfterTool', 'post-read-file'));
    deny(send('BeforeTool', 'pre-read-state'), /Speckl-protected path/);
    deny(send('BeforeTool', 'pre-read-settings'), /Speckl-protected path/);
    deny(send('BeforeTool', 'pre-mcp'), /unmapped harness tool "mcp_github_create_pull_request"/);
    deny(send('BeforeTool', 'pre-shell-chained'), /shell control characters/);

    approve(ctx);
    allow(send('BeforeTool', 'pre-shell-git-push'));
    const end = send('AfterAgent', 'after-agent');
    expect(end.status).toBe(0);
    expect(JSON.parse(end.stdout)).toEqual({});
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    allow(send('BeforeTool', 'pre-shell-git-push-2'));
    posted(send('AfterTool', 'post-shell-git-push-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
  }, 120_000);
});

describe('fail closed when the hook or adapter fails (Codex, Gemini)', () => {
  const broken: Record<string, string> = {
    crash: "throw new Error('boom');\n",
    exit1: "process.stdout.write('{\"decision\":\"allow\"}\\n'); process.exit(1);\n",
    garbage: "process.stdout.write('not json at all\\n'); process.exit(0);\n",
    killed: "process.kill(process.pid, 'SIGKILL');\n",
    hang: 'setInterval(() => {}, 1000);\n',
  };
  for (const harness of ['codex', 'gemini'] as const) {
    it(`${harness}: crash, exit 1, malformed output, SIGKILL, timeout, corrupt config and missing node all exit 2`, () => {
      const ctx = setup(harness);
      const ev = harness === 'codex' ? 'PreToolUse' : 'BeforeTool';
      const command = ctx.config.hooks[ev][0].hooks[0].command as string;
      const payload = harness === 'codex' ? fixture('codex', 'pre-mcp-run-tests', ctx.project) : fixture('gemini', 'pre-shell-npm-test', ctx.project);
      const env = { ...ctx.env, GEMINI_PROJECT_DIR: ctx.project, SPECKL_HOOK_TIMEOUT_MS: '700' };
      const hook = join(ctx.project, '.speckl', 'agent', 'hook.mjs');
      const good = readFileSync(hook, 'utf-8');
      for (const [name, body] of Object.entries(broken)) {
        writeFileSync(hook, body);
        const r = sh(command, ctx.project, env, payload);
        expect(r.status, `${name}: ${r.stderr}`).toBe(2);
        expect(r.stderr, name).toMatch(/Speckl denied/);
      }
      writeFileSync(hook, good);
      // node not on PATH: the shell exits 127, `|| exit 2` turns it into a block
      // (both harnesses would let any exit other than 2 through).
      const noNode = sh(command, ctx.project, { ...env, PATH: '/nonexistent' }, payload);
      expect(noNode.status).toBe(2);
      writeFileSync(join(ctx.project, '.speckl', 'agent', 'agent-config.json'), '{corrupt');
      const r = sh(command, ctx.project, env, payload);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Speckl adapter error');
      // Turn-end hooks never block (Gemini would force a retry turn on exit 2).
      const end = sh(ctx.config.hooks[harness === 'codex' ? 'Stop' : 'AfterAgent'][0].hooks[0].command, ctx.project, env,
        harness === 'codex' ? fixture('codex', 'stop', ctx.project) : fixture('gemini', 'after-agent', ctx.project));
      expect(end.status).toBe(0);
      expect(end.stdout).toBe(harness === 'gemini' ? '{}\n' : '');
    }, 120_000);
  }
});
