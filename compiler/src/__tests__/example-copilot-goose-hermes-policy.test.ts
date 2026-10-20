// End-to-end: examples/ClaudeCodePolicy.speckdl compiled, installed with
// adapter.mjs install copilot|goose|hermes, and driven with real-format hook
// payloads through the exact command each harness runs:
//   - Copilot CLI runs the `bash` field of .github/hooks/speckl.json with bash;
//   - Goose runs plugin hooks with `sh -c` and PLUGIN_ROOT set;
//   - Hermes splits `command` into argv and runs it without a shell.
// Payload shapes: docs.github.com/en/copilot/reference/hooks-reference,
// aaif-goose/goose crates/goose/src/hooks/mod.rs (HookContext), and
// NousResearch/hermes-agent agent/shell_hooks.py (_serialize_payload).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const fixtures = join(compilerDir, 'src', '__tests__', 'fixtures', 'harness');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

interface Run { status: number | null; stdout: string; stderr: string }
type Harness = 'copilot' | 'goose' | 'hermes';

function sh(command: string, cwd: string, env: Record<string, string>, input = '', shell = '/bin/sh'): Run {
  const r = spawnSync(shell, ['-c', command], { cwd, input, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Hermes: split on whitespace (the generated paths hold none), no shell. */
function argvRun(command: string, cwd: string, env: Record<string, string>, input = ''): Run {
  const argv = command.split(/\s+/).filter(Boolean);
  const r = spawnSync(argv[0], argv.slice(1), { cwd, input, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || String(r.error || '') };
}

function fixture(harness: string, name: string, project: string): string {
  return readFileSync(join(fixtures, harness, name + '.json'), 'utf-8').replace(/__PROJECT__/g, project);
}

/** `command: "..."` lines of the generated Hermes block, per event. */
function hermesCommands(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let ev = '';
  for (const line of yaml.split('\n')) {
    const e = line.match(/^ {2}([a-z_]+):$/);
    if (e) ev = e[1];
    const c = line.match(/^ {4}- command: (".*")$/);
    if (c && ev) out[ev] = JSON.parse(c[1]);
  }
  return out;
}

function setup(harness: Harness) {
  const project = mkdtempSync(join(tmpdir(), `speckl-${harness}-proj-`));
  const keyDir = mkdtempSync(join(tmpdir(), 'speckl-key-outside-'));
  const key = join(keyDir, 'state.key');
  mkdirSync(join(project, 'src'));
  cpSync(example, join(project, 'policy.speckdl'));
  const c = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), 'policy.speckdl', '-t', 'agent', '-o', '.speckl'],
    { cwd: project, encoding: 'utf-8' });
  if (c.status !== 0) throw new Error(c.stderr || c.stdout);
  const env: Record<string, string> = { SPECKL_STATE_KEY_FILE: '' };
  const init = sh(`node .speckl/agent/signal.mjs init --state .speckl/state.json --key ${key} --dev`, project, env);
  if (init.status !== 0) throw new Error(init.stderr);
  const hermesHome = harness === 'hermes' ? mkdtempSync(join(tmpdir(), 'speckl-hermes-home-')) : '';
  const extra = hermesHome ? ` --hermes-home ${hermesHome}` : '';
  const inst = sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${key}${extra}`, project, env);
  if (inst.status !== 0) throw new Error(inst.stderr);
  let commands: Record<string, string>;
  let config: Record<string, any> = {};
  if (harness === 'copilot') {
    config = JSON.parse(readFileSync(join(project, '.github', 'hooks', 'speckl.json'), 'utf-8'));
    commands = Object.fromEntries(Object.entries(config.hooks).map(([ev, hs]) => [ev, (hs as any[])[0].bash as string]));
  } else if (harness === 'goose') {
    config = JSON.parse(readFileSync(join(project, '.agents', 'plugins', 'speckl', 'hooks', 'hooks.json'), 'utf-8'));
    commands = Object.fromEntries(Object.entries(config.hooks).map(([ev, gs]) => [ev, (gs as any[])[0].hooks[0].command as string]));
  } else {
    commands = hermesCommands(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8'));
  }
  const run = (event: string, input: string, cwd = project, more: Record<string, string> = {}): Run => {
    const e = { ...env, ...more };
    if (harness === 'copilot') return sh(commands[event], cwd, e, input, '/bin/bash');
    if (harness === 'goose') return sh(commands[event], cwd, { ...e, PLUGIN_ROOT: join(project, '.agents', 'plugins', 'speckl') }, input);
    return argvRun(commands[event], cwd, e, input);
  };
  return { project, key, env, config, commands, hermesHome, inst, run };
}

const stateOf = (project: string) => JSON.parse(readFileSync(join(project, '.speckl', 'state.json'), 'utf-8'));
const approve = (ctx: { project: string; key: string; env: Record<string, string> }) => {
  const ap = sh(`node .speckl/agent/signal.mjs apply --state .speckl/state.json --key ${ctx.key} --verifier cli --outcome approve --as alice --claim_reviewer alice`, ctx.project, ctx.env);
  expect(ap.status, ap.stderr).toBe(0);
};

describe('GitHub Copilot CLI wiring (real payloads through .github/hooks/speckl.json)', () => {
  let ctx: ReturnType<typeof setup>;
  // Copilot runs hooks from the repository root; a subdirectory cwd must work too.
  const send = (event: string, name: string) => ctx.run(event, fixture('copilot', name, ctx.project), join(ctx.project, 'src'));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
  const deny = (r: Run, why: RegExp) => {
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    const out = JSON.parse(r.stdout);
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(why);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  };
  const posted = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };

  beforeAll(() => { ctx = setup('copilot'); }, 90_000);

  it('installs camelCase preToolUse / postToolUse / postToolUseFailure / agentStop command hooks', () => {
    expect(ctx.config.version).toBe(1);
    expect(Object.keys(ctx.config.hooks)).toEqual(['preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop']);
    expect(ctx.config.hooks.preToolUse[0]).toMatchObject({ type: 'command', timeoutSec: 30 });
    expect(ctx.config.hooks.preToolUse[0].matcher).toBeUndefined();
    expect(ctx.commands.preToolUse).toBe(`node ${ctx.project}/.speckl/agent/adapter.mjs copilot pre --state ${ctx.project}/.speckl/state.json --key ${ctx.key} --project ${ctx.project} || exit 2`);
    expect(ctx.commands.postToolUse).not.toContain('|| exit 2');
    for (const f of ['copilot/speckl.json', 'goose/hooks.json']) {
      expect(() => JSON.parse(readFileSync(join(ctx.project, '.speckl', 'agent', 'harness', f), 'utf-8')), f).not.toThrow();
    }
    expect(readFileSync(join(ctx.project, '.speckl', 'agent', 'harness', 'hermes', 'config.yaml'), 'utf-8')).toMatch(/^# >>> speckl hermes hooks/);
  });

  it('walks create → failing test → green test → commit → HNTL → approval → rejected push → push', () => {
    allow(send('preToolUse', 'pre-create'));
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: `${ctx.project}/src/app.js` } });
    posted(send('postToolUse', 'post-create'));
    expect(stateOf(ctx.project).pending).toBeNull();

    // A non-zero exit is reported through postToolUse with the exit status in
    // the text: `<exited with exit code 1>` is not a success.
    allow(send('preToolUse', 'pre-bash-npm-test'));
    posted(send('postToolUse', 'post-bash-npm-test-exit1'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    // An async shell reports no exit status: not a success either.
    allow(send('preToolUse', 'pre-bash-npm-test-async'));
    posted(send('postToolUse', 'post-bash-npm-test-async'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('preToolUse', 'pre-bash-git-commit'), /Speckl denied bash \(spec tool request_review\): can\(\) refused/);

    allow(send('preToolUse', 'pre-bash-npm-test-2'));
    posted(send('postToolUse', 'post-bash-npm-test-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow(send('preToolUse', 'pre-bash-git-commit'));
    posted(send('postToolUse', 'post-bash-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny(send('preToolUse', 'pre-bash-git-push'), /HNTL/);
    allow(send('preToolUse', 'pre-view'));
    posted(send('postToolUse', 'post-view'));
    deny(send('preToolUse', 'pre-view-state'), /Speckl-protected path/);
    deny(send('preToolUse', 'pre-edit-hooks'), /Speckl-protected path \(.*\.github\/hooks\)/);
    deny(send('preToolUse', 'pre-mcp'), /unmapped harness tool "github-mcp-server-create_pull_request"/);
    deny(send('preToolUse', 'pre-bash-chained'), /shell control characters/);
    // The VS Code-compatible payload shape is accepted too.
    allow(send('preToolUse', 'pre-vscode-bash'));
    posted(send('postToolUse', 'post-vscode-bash'));
    expect(stateOf(ctx.project).pending).toBeNull();

    approve(ctx);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    // The user rejects the push: postToolUseFailure records it as failed.
    allow(send('preToolUse', 'pre-bash-git-push'));
    posted(send('postToolUseFailure', 'post-failure-bash-git-push'));
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    // A call that never reports is cleared at agentStop, which never blocks.
    allow(send('preToolUse', 'pre-bash-git-push'));
    const stop = send('agentStop', 'agent-stop');
    expect(stop).toMatchObject({ status: 0, stdout: '' });
    expect(stop.stderr).toMatch(/cleared pending call copilot-[0-9a-f]{8}/);
    expect(stateOf(ctx.project).pending).toBeNull();

    allow(send('preToolUse', 'pre-bash-git-push-2'));
    posted(send('postToolUse', 'post-bash-git-push-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
    expect(send('agentStop', 'agent-stop')).toMatchObject({ status: 0, stdout: '', stderr: '' });
  }, 120_000);
});

describe('Goose wiring (real payloads through .agents/plugins/speckl/hooks/hooks.json)', () => {
  let ctx: ReturnType<typeof setup>;
  const send = (event: string, name: string) => ctx.run(event, fixture('goose', name, ctx.project));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
  const deny = (r: Run, why: RegExp) => {
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(r.stdout).reason).toMatch(why);
  };
  const posted = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); expect(r.stderr).toBe(''); };

  beforeAll(() => { ctx = setup('goose'); }, 90_000);

  it('installs a project plugin with on_failure "block" and regex matchers', () => {
    const manifest = JSON.parse(readFileSync(join(ctx.project, '.agents', 'plugins', 'speckl', 'plugin.json'), 'utf-8'));
    expect(manifest).toMatchObject({ name: 'speckl', version: '1.0.0' });
    expect(Object.keys(ctx.config.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
    expect(ctx.config.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(ctx.config.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 30, on_failure: 'block' });
    expect(ctx.config.hooks.PostToolUse[0].hooks[0].on_failure).toBeUndefined();
    expect(ctx.config.hooks.Stop[0].matcher).toBeUndefined();
    expect(ctx.commands.PreToolUse).toMatch(/ goose pre --state .* --project .* \|\| exit 2$/);
  });

  it('walks write → failing test → green test → commit → HNTL → approval → push', () => {
    allow(send('PreToolUse', 'pre-write'));
    posted(send('PostToolUse', 'post-write'));
    allow(send('PreToolUse', 'pre-shell-npm-test'));
    posted(send('PostToolUseFailure', 'post-failure-shell-npm-test'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('PreToolUse', 'pre-shell-git-commit'), /can\(\) refused/);

    allow(send('PreToolUse', 'pre-shell-npm-test-2'));
    posted(send('PostToolUse', 'post-shell-npm-test-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow(send('PreToolUse', 'pre-shell-git-commit'));
    posted(send('PostToolUse', 'post-shell-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny(send('PreToolUse', 'pre-shell-git-push'), /HNTL/);
    allow(send('PreToolUse', 'pre-tree'));
    posted(send('PostToolUse', 'post-tree'));
    deny(send('PreToolUse', 'pre-edit-plugin'), /Speckl-protected path \(\.agents\/plugins\)/);
    deny(send('PreToolUse', 'pre-shell-disable-plugin'), /Speckl-protected path \(\.config\/goose\)/);
    deny(send('PreToolUse', 'pre-shell-chained'), /shell control characters/);
    deny(send('PreToolUse', 'pre-mcp'), /unmapped harness tool "github__create_pull_request"/);

    approve(ctx);
    allow(send('PreToolUse', 'pre-shell-git-push'));
    const stop = send('Stop', 'stop');
    expect(stop).toMatchObject({ status: 0, stdout: '' });
    expect(stop.stderr).toContain('cleared pending call toolu_01Goose0005');
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    allow(send('PreToolUse', 'pre-shell-git-push-2'));
    posted(send('PostToolUse', 'post-shell-git-push-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });

    // A payload that is not the event this hook is wired for is refused.
    const wrong = ctx.run('PreToolUse', fixture('goose', 'post-write', ctx.project));
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('payload is "PostToolUse" but this hook is wired as PreToolUse');
  }, 120_000);
});

describe('Hermes Agent wiring (real payloads through the config.yaml hooks block)', () => {
  let ctx: ReturnType<typeof setup>;
  const send = (event: string, name: string) => ctx.run(event, fixture('hermes', name, ctx.project));
  const allow = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
  const deny = (r: Run, why: RegExp) => {
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
  };
  const posted = (r: Run) => { expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };

  beforeAll(() => { ctx = setup('hermes'); }, 90_000);

  it('writes the hooks block with fail_closed and records consent for exactly these commands', () => {
    const yaml = readFileSync(join(ctx.hermesHome, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('  pre_tool_call:\n    - command: ');
    expect(yaml).toMatch(/pre_tool_call:\n {4}- command: .*\n {6}timeout: 30\n {6}fail_closed: true\n/);
    expect(yaml).not.toMatch(/post_tool_call:\n[^\n]*\n[^\n]*\n {6}fail_closed/);
    expect(Object.keys(ctx.commands)).toEqual(['pre_tool_call', 'post_tool_call', 'on_session_end']);
    expect(ctx.commands.pre_tool_call).not.toContain('||');
    expect(ctx.commands.pre_tool_call).toContain(`--hermes-home ${ctx.hermesHome}`);
    const allowlist = JSON.parse(readFileSync(join(ctx.hermesHome, 'shell-hooks-allowlist.json'), 'utf-8'));
    expect(allowlist.approvals.map((a: any) => [a.event, a.command])).toEqual(Object.entries(ctx.commands));
    expect(ctx.inst.stdout).toContain('Recorded consent for these 3 hook commands');
  });

  it('walks write → failing test → background test → green test → commit → HNTL → approval → push', () => {
    allow(send('pre_tool_call', 'pre-write-file'));
    posted(send('post_tool_call', 'post-write-file'));
    allow(send('pre_tool_call', 'pre-terminal-npm-test-exit1'));
    posted(send('post_tool_call', 'post-terminal-npm-test-exit1'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    allow(send('pre_tool_call', 'pre-terminal-npm-test-bg'));
    posted(send('post_tool_call', 'post-terminal-npm-test-bg'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny(send('pre_tool_call', 'pre-terminal-git-commit'), /can\(\) refused/);

    allow(send('pre_tool_call', 'pre-terminal-npm-test-2'));
    posted(send('post_tool_call', 'post-terminal-npm-test-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow(send('pre_tool_call', 'pre-terminal-git-commit'));
    posted(send('post_tool_call', 'post-terminal-git-commit'));
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    // Our block: Hermes still fires post_tool_call with status "blocked"; nothing is pending.
    deny(send('pre_tool_call', 'pre-terminal-git-push'), /HNTL/);
    expect(send('post_tool_call', 'post-terminal-git-push-blocked')).toMatchObject({ status: 0, stdout: '', stderr: '' });
    allow(send('pre_tool_call', 'pre-read-file'));
    posted(send('post_tool_call', 'post-read-file'));
    deny(send('pre_tool_call', 'pre-read-config'), /Speckl-protected path \(\.hermes\)/);
    deny(send('pre_tool_call', 'pre-read-state'), /Speckl-protected path/);
    deny(send('pre_tool_call', 'pre-terminal-chained'), /shell control characters/);
    deny(send('pre_tool_call', 'pre-mcp'), /unmapped harness tool "mcp_github_create_pull_request"/);
    deny(send('pre_tool_call', 'pre-no-call-id'), /no tool_use_id/);

    approve(ctx);
    // Another hook blocks after ours allowed: the pending call is recorded as failed.
    allow(send('pre_tool_call', 'pre-terminal-git-push-other-block'));
    posted(send('post_tool_call', 'post-terminal-git-push-other-block'));
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    // A call that never reports is cleared at the end of the turn.
    allow(send('pre_tool_call', 'pre-terminal-git-push'));
    const end = send('on_session_end', 'session-end');
    expect(end).toMatchObject({ status: 0, stdout: '' });
    expect(end.stderr).toContain('cleared pending call call_hermes0006');

    allow(send('pre_tool_call', 'pre-terminal-git-push-2'));
    posted(send('post_tool_call', 'post-terminal-git-push-2'));
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
  }, 120_000);

  it('reinstall replaces its own block; a foreign hooks: block is never touched', () => {
    const cfg = join(ctx.hermesHome, 'config.yaml');
    writeFileSync(cfg, 'model:\n  default: hermes-4\n' + readFileSync(cfg, 'utf-8') + 'display:\n  compact: true\n');
    const again = sh(`node .speckl/agent/adapter.mjs install hermes --project . --state .speckl/state.json --key ${ctx.key} --hermes-home ${ctx.hermesHome}`, ctx.project, ctx.env);
    expect(again.status, again.stderr).toBe(0);
    const text = readFileSync(cfg, 'utf-8');
    expect(text.match(/# >>> speckl hermes hooks/g)).toHaveLength(1);
    expect(text).toMatch(/^model:\n {2}default: hermes-4\n# >>> speckl/);
    expect(text).toMatch(/# <<< speckl hermes hooks\ndisplay:\n {2}compact: true\n$/);
    expect(JSON.parse(readFileSync(join(ctx.hermesHome, 'shell-hooks-allowlist.json'), 'utf-8')).approvals).toHaveLength(3);

    const other = mkdtempSync(join(tmpdir(), 'speckl-hermes-home-'));
    writeFileSync(join(other, 'config.yaml'), 'hooks:\n  on_session_start:\n    - command: "~/bin/hello"\n');
    const refused = sh(`node .speckl/agent/adapter.mjs install hermes --project . --state .speckl/state.json --hermes-home ${other}`, ctx.project, ctx.env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already has a hooks: block; not touching it');
    expect(refused.stdout).toContain('pre_tool_call:');
    expect(readFileSync(join(other, 'config.yaml'), 'utf-8')).toBe('hooks:\n  on_session_start:\n    - command: "~/bin/hello"\n');
    expect(existsSync(join(other, 'shell-hooks-allowlist.json'))).toBe(false);
    const usage = sh('node .speckl/agent/adapter.mjs install hermes --project . --state .speckl/state.json', ctx.project, ctx.env);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain('--hermes-home <profile dir');
  });
});

describe('fail closed when the hook or adapter fails (Copilot, Goose, Hermes)', () => {
  const broken: Record<string, string> = {
    crash: "throw new Error('boom');\n",
    exit1: "process.stdout.write('{\"decision\":\"allow\"}\\n'); process.exit(1);\n",
    garbage: "process.stdout.write('not json at all\\n'); process.exit(0);\n",
    killed: "process.kill(process.pid, 'SIGKILL');\n",
    hang: 'setInterval(() => {}, 1000);\n',
  };
  const pre: Record<Harness, [string, string, string]> = {
    copilot: ['preToolUse', 'pre-bash-npm-test', 'agentStop'],
    goose: ['PreToolUse', 'pre-shell-npm-test', 'Stop'],
    hermes: ['pre_tool_call', 'pre-terminal-npm-test-exit1', 'on_session_end'],
  };
  const endFixture: Record<Harness, string> = { copilot: 'agent-stop', goose: 'stop', hermes: 'session-end' };
  for (const harness of ['copilot', 'goose', 'hermes'] as const) {
    it(`${harness}: crash, exit 1, malformed output, SIGKILL, timeout, corrupt config and missing node all block`, () => {
      const ctx = setup(harness);
      const [ev, fx, endEv] = pre[harness];
      const payload = fixture(harness, fx, ctx.project);
      const more = { SPECKL_HOOK_TIMEOUT_MS: '700' };
      const hook = join(ctx.project, '.speckl', 'agent', 'hook.mjs');
      const good = readFileSync(hook, 'utf-8');
      for (const [name, body] of Object.entries(broken)) {
        writeFileSync(hook, body);
        const r = ctx.run(ev, payload, ctx.project, more);
        expect(r.status, `${name}: ${r.stderr}`).toBe(2);
        expect(r.stderr, name).toMatch(/Speckl denied/);
        if (harness !== 'copilot') expect(JSON.parse(r.stdout).decision, name).toBe('block');
      }
      writeFileSync(hook, good);
      // node missing: Copilot and Goose get `|| exit 2` (and Copilot denies any
      // non-zero exit, Goose blocks on on_failure); Hermes cannot spawn the
      // command, which fail_closed turns into a block inside Hermes.
      const noNode = ctx.run(ev, payload, ctx.project, { ...more, PATH: '/nonexistent' });
      if (harness === 'hermes') expect(noNode.status).toBeNull();
      else expect(noNode.status).toBe(2);
      // Malformed and mismatched payloads.
      for (const bad of ['', 'not json', '[]', '{"hook_event_name":"something_else"}']) {
        const r = ctx.run(ev, bad, ctx.project, more);
        expect(r.status, `payload ${JSON.stringify(bad)}`).toBe(2);
      }
      writeFileSync(join(ctx.project, '.speckl', 'agent', 'agent-config.json'), '{corrupt');
      const r = ctx.run(ev, payload, ctx.project, more);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Speckl adapter error');
      // Turn-end hooks never block (Copilot and Goose would force another turn).
      const end = ctx.run(endEv, fixture(harness, endFixture[harness], ctx.project), ctx.project, more);
      expect(end.status).toBe(0);
      expect(end.stdout).toBe('');
    }, 120_000);
  }
});
