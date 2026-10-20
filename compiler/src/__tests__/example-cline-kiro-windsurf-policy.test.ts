// End-to-end: examples/ClaudeCodePolicy.speckdl compiled, installed with
// adapter.mjs install cline|kiro|windsurf, and driven through the generated
// wiring itself: Cline's executable .clinerules/hooks/<Event> scripts are run
// with /bin/sh exactly as Cline spawns them (payload on stdin, verdict read
// from stdout); Kiro and Windsurf hook commands are run with `sh -c` as
// written in their hook config.
// Payload shapes: Cline CLI 3.0.73 (captured live) and the VS Code extension
// (cline/cline 8248643 apps/vscode/src/sdk/hooks-adapter.ts); see
// fixtures/harness/README.md and docs/harness-adapters.md.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const fixtures = join(compilerDir, 'src', '__tests__', 'fixtures', 'harness');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

interface Run { status: number | null; stdout: string; stderr: string }

function sh(command: string, cwd: string, env: Record<string, string> = {}, input?: string): Run {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd, input, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '', ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixtureText(harness: string, name: string, project: string): string {
  return readFileSync(join(fixtures, harness, name + '.json'), 'utf-8').replace(/__PROJECT__/g, project);
}

function setup(harness: string) {
  const project = mkdtempSync(join(tmpdir(), `speckl-${harness}-proj-`));
  const keyDir = mkdtempSync(join(tmpdir(), 'speckl-key-outside-'));
  const key = join(keyDir, 'state.key');
  mkdirSync(join(project, 'src'));
  cpSync(example, join(project, 'policy.speckdl'));
  const c = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), 'policy.speckdl', '-t', 'agent', '-o', '.speckl'],
    { cwd: project, encoding: 'utf-8' });
  if (c.status !== 0) throw new Error(c.stderr || c.stdout);
  const init = sh(`node .speckl/agent/signal.mjs init --state .speckl/state.json --key ${key} --dev`, project);
  if (init.status !== 0) throw new Error(init.stderr);
  const inst = sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${key}`, project);
  if (inst.status !== 0) throw new Error(inst.stderr);
  return { project, key, inst };
}

const stateOf = (project: string) => JSON.parse(readFileSync(join(project, '.speckl', 'state.json'), 'utf-8'));
const approve = (ctx: { project: string; key: string }) => {
  const ap = sh(`node .speckl/agent/signal.mjs apply --state .speckl/state.json --key ${ctx.key} --verifier cli --outcome approve --as alice --claim_reviewer alice`, ctx.project);
  expect(ap.status, ap.stderr).toBe(0);
};

const BROKEN_HOOK: Record<string, string> = {
  crash: "throw new Error('boom');\n",
  exit1: "process.stdout.write('{\"decision\":\"allow\"}\\n'); process.exit(1);\n",
  garbage: "process.stdout.write('not json at all\\n'); process.exit(0);\n",
  killed: "process.kill(process.pid, 'SIGKILL');\n",
  hang: 'setInterval(() => {}, 1000);\n',
};
const BROKEN_ADAPTER: Record<string, string> = {
  crash: "throw new Error('adapter crashed');\n",
  exit1: 'process.exit(1);\n',
  exit0Empty: 'process.exit(0);\n',
  allowThenExit1: "process.stdout.write('{\"cancel\":false}\\n'); process.exit(1);\n",
  garbage: "process.stdout.write('{\"cancel\":false} trailing\\n');\n",
  killed: "process.kill(process.pid, 'SIGKILL');\n",
};

describe('Cline wiring (real payloads through the generated .clinerules/hooks/ scripts)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeAll(() => { ctx = setup('cline'); }, 60_000);
  const hookFile = (ev: string) => join(ctx.project, '.clinerules', 'hooks', ev);
  // Cline spawns the hook file itself with the payload on stdin.
  const run = (ev: string, payload: string, env: Record<string, string> = {}) => sh(JSON.stringify(hookFile(ev)), ctx.project, env, payload);
  const verdict = (r: Run) => {
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  };
  const allow = (name: string) => expect(verdict(run('PreToolUse', fixtureText('cline', name, ctx.project)))).toEqual({ cancel: false });
  const deny = (name: string, re: RegExp) => {
    const v = verdict(run('PreToolUse', fixtureText('cline', name, ctx.project)));
    expect(v.cancel).toBe(true);
    expect(v.errorMessage).toMatch(re);
  };
  const posted = (name: string) => expect(verdict(run('PostToolUse', fixtureText('cline', name, ctx.project)))).toEqual({ cancel: false });

  it('writes five executable scripts with absolute paths and --project', () => {
    expect(ctx.inst.stdout).toContain('Speckl cline hooks written to ' + join(ctx.project, '.clinerules', 'hooks'));
    for (const ev of ['PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'TaskError']) {
      expect(statSync(hookFile(ev)).mode & 0o111).toBe(0o111);
      expect(readFileSync(hookFile(ev), 'utf-8')).toContain(`--project ${ctx.project}`);
    }
    // Reference copies next to the adapter.
    expect(statSync(join(ctx.project, '.speckl', 'agent', 'harness', 'cline', 'PreToolUse')).mode & 0o111).toBe(0o111);
  });

  it('CLI payloads: walks edit → failing test → green test → commit → HNTL → approval → push', () => {
    allow('cli-pre-editor');
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: 'src/app.js' } });
    posted('cli-post-editor');
    expect(stateOf(ctx.project).pending).toBeNull();
    // A failed edit (output success: false) is recorded as failed.
    allow('cli-pre-editor-2');
    posted('cli-post-editor-error');
    expect(stateOf(ctx.project).machine.state.stage).toBe(0);
    // A call that never reports (another hook cancelled the task, Ctrl-C):
    // Cline runs TaskError / TaskCancel, which records it as failed so the
    // next call is not refused as parallel.
    allow('cli-pre-patch');
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: 'src/app.js' } });
    const end = run('TaskError', fixtureText('cline', 'cli-task-error', ctx.project));
    expect(end).toMatchObject({ status: 0, stdout: '' });
    expect(stateOf(ctx.project).pending).toBeNull();

    allow('cli-pre-npm-test');
    posted('cli-post-npm-test-exit1');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny('cli-pre-commit', /Speckl denied run_commands \(spec tool request_review\): can\(\) refused/);

    allow('cli-pre-npm-test-2');
    posted('cli-post-npm-test-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow('cli-pre-commit-2');
    posted('cli-post-commit-2');
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny('cli-pre-push', /HNTL/);
    allow('cli-pre-read');
    posted('cli-post-read');
    deny('cli-pre-read-state', /Speckl-protected path/);
    deny('cli-pre-edit-hooks', /Speckl-protected path \(\.clinerules\/hooks\)/);
    deny('cli-pre-unmapped', /unmapped harness tool "fetch_web_content"/);
    deny('cli-pre-chained', /shell control characters/);
    deny('cli-pre-multi', /unmapped harness tool "run_commands"/);

    approve(ctx);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    allow('cli-pre-push-2');
    posted('cli-post-push-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
    const done = run('TaskComplete', fixtureText('cline', 'cli-task-complete', ctx.project));
    expect(done).toMatchObject({ status: 0, stdout: '' });
  }, 120_000);

  it('a post-hook problem goes back to the model as contextModification, never as a cancel', () => {
    const v = verdict(run('PostToolUse', fixtureText('cline', 'cli-post-npm-test-2', ctx.project)));
    expect(v.cancel).toBe(false);
    expect(v.contextModification).toMatch(/Speckl could not record run_commands \(spec tool run_tests\): post: no matching pending call_id/);
  });

  it('VS Code payloads (string parameters, no call id): a shell result never counts as a success', () => {
    const c2 = setup('cline');
    const r = (ev: string, name: string) => verdict(sh(JSON.stringify(join(c2.project, '.clinerules', 'hooks', ev)), c2.project, {}, fixtureText('cline', name, c2.project)));
    expect(r('PreToolUse', 'vscode-pre-editor')).toEqual({ cancel: false });
    expect(r('PostToolUse', 'vscode-post-editor')).toEqual({ cancel: false });
    expect(stateOf(c2.project).log.filter((e: any) => e.kind === 'post').map((e: any) => e.ok)).toEqual([true]);
    expect(r('PreToolUse', 'vscode-pre-npm-test')).toEqual({ cancel: false });
    expect(r('PostToolUse', 'vscode-post-npm-test')).toEqual({ cancel: false });
    expect(stateOf(c2.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    expect(r('PreToolUse', 'vscode-pre-read-state').cancel).toBe(true);
    expect(sh(JSON.stringify(join(c2.project, '.clinerules', 'hooks', 'TaskCancel')), c2.project, {}, fixtureText('cline', 'vscode-task-cancel', c2.project))).toMatchObject({ status: 0, stdout: '' });
  }, 60_000);

  it('cancels when hook.mjs crashes, exits 1, prints garbage, is killed or hangs', () => {
    const hook = join(ctx.project, '.speckl', 'agent', 'hook.mjs');
    const good = readFileSync(hook, 'utf-8');
    try {
      for (const [name, body] of Object.entries(BROKEN_HOOK)) {
        writeFileSync(hook, body);
        const v = verdict(run('PreToolUse', fixtureText('cline', 'cli-pre-read', ctx.project), { SPECKL_HOOK_TIMEOUT_MS: '700' }));
        expect(v.cancel, name).toBe(true);
        expect(v.errorMessage, name).toMatch(/^Speckl denied read_files/);
      }
    } finally { writeFileSync(hook, good); }
  }, 60_000);

  it('cancels when the adapter crashes, exits non-zero, prints anything but an exact allow, or is killed', () => {
    const a = join(ctx.project, '.speckl', 'agent', 'adapter.mjs');
    copyFileSync(a, a + '.good');
    try {
      for (const [name, body] of Object.entries(BROKEN_ADAPTER)) {
        writeFileSync(a, body);
        const v = verdict(run('PreToolUse', fixtureText('cline', 'cli-pre-read', ctx.project)));
        expect(v, name).toMatchObject({ cancel: true });
        expect(v.errorMessage, name).toMatch(/^Speckl: the adapter failed \(exit \d+\)/);
        // A broken post never cancels the task.
        expect(verdict(run('PostToolUse', fixtureText('cline', 'cli-post-read', ctx.project))).cancel, name).toBe(false);
        expect(run('TaskComplete', fixtureText('cline', 'cli-task-complete', ctx.project)), name).toMatchObject({ status: 0, stdout: '' });
      }
    } finally { copyFileSync(a + '.good', a); }
    // Corrupt config: the adapter's own fail-closed path, passed through.
    const cfg = join(ctx.project, '.speckl', 'agent', 'agent-config.json');
    const goodCfg = readFileSync(cfg, 'utf-8');
    try {
      writeFileSync(cfg, '{corrupt');
      expect(verdict(run('PreToolUse', fixtureText('cline', 'cli-pre-read', ctx.project))).cancel).toBe(true);
    } finally { writeFileSync(cfg, goodCfg); }
    for (const bad of ['', 'not json', '[]', '{"hookName":"tool_result"}']) {
      expect(verdict(run('PreToolUse', bad)).cancel, bad).toBe(true);
    }
  }, 60_000);

  it('cancels when node is missing', () => {
    const v = verdict(run('PreToolUse', fixtureText('cline', 'cli-pre-read', ctx.project), { PATH: '/nonexistent' }));
    expect(v.cancel).toBe(true);
    expect(v.errorMessage).toMatch(/the adapter failed \(exit 127\)/);
  });

  it('cancels when the adapter hangs (timeout 25 inside Cline\'s 30 s hook timeout)', () => {
    const a = join(ctx.project, '.speckl', 'agent', 'adapter.mjs');
    copyFileSync(a, a + '.good');
    try {
      writeFileSync(a, 'setInterval(() => {}, 1000);\n');
      const t = Date.now();
      const v = verdict(run('PreToolUse', fixtureText('cline', 'cli-pre-read', ctx.project)));
      expect(v.cancel).toBe(true);
      expect(v.errorMessage).toMatch(/exit 124/);
      expect(Date.now() - t).toBeLessThan(30_000);
    } finally { copyFileSync(a + '.good', a); }
  }, 60_000);

  it('install refuses a hook file Speckl did not write', () => {
    writeFileSync(hookFile('TaskStart'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(ctx.project, '.clinerules', 'hooks', 'PostToolUse.sh'), '#!/bin/sh\necho mine\n');
    const r = sh(`node .speckl/agent/adapter.mjs install cline --project . --state .speckl/state.json --key ${ctx.key}`, ctx.project);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PostToolUse.sh exists and was not written by Speckl');
  });
});

describe('Kiro wiring (real-format payloads through .kiro/hooks/speckl.json; not live-tested)', () => {
  let ctx: ReturnType<typeof setup>;
  let cmds: Record<string, string>;
  beforeAll(() => {
    ctx = setup('kiro');
    const doc = JSON.parse(readFileSync(join(ctx.project, '.kiro', 'hooks', 'speckl.json'), 'utf-8'));
    cmds = Object.fromEntries(doc.hooks.map((h: any) => [h.trigger, h.action.command]));
  }, 60_000);
  // Kiro runs the action command through a shell in the project root, payload on stdin.
  const run = (trigger: string, name: string, env: Record<string, string> = {}) => sh(cmds[trigger], ctx.project, env, fixtureText('kiro', name, ctx.project));
  const allow = (name: string) => { const r = run('PreToolUse', name); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };
  const deny = (name: string, re: RegExp) => { const r = run('PreToolUse', name); expect(r.status).toBe(2); expect(r.stdout).toBe(''); expect(r.stderr).toMatch(re); };
  const posted = (name: string) => { const r = run('PostToolUse', name); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(''); };

  it('writes PreToolUse / PostToolUse / Stop with absolute paths, a blocking pre and no matcher', () => {
    expect(Object.keys(cmds)).toEqual(['PreToolUse', 'PostToolUse', 'Stop']);
    expect(cmds.PreToolUse).toMatch(/^\[ "\$\(node \S+adapter\.mjs kiro pre .*--project \S+\)" = '\{"decision":"allow"\}' \] \|\| exit 2$/);
    expect(ctx.inst.stdout).toContain('Speckl kiro hooks written to ' + join(ctx.project, '.kiro', 'hooks', 'speckl.json'));
  });

  it('walks write → failed edit → failing test → green test → commit → HNTL → approval → push (empty post inputs)', () => {
    allow('pre-fs-write');
    posted('post-fs-write');
    expect(stateOf(ctx.project).pending).toBeNull();
    allow('pre-str-replace');
    posted('post-str-replace-error');
    expect(stateOf(ctx.project).log.filter((e: any) => e.kind === 'post').map((e: any) => e.ok)).toEqual([true, false]);
    allow('pre-str-replace-2');
    posted('post-str-replace-2');
    allow('pre-bash-npm-test');
    posted('post-bash-npm-test-exit1');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny('pre-bash-git-commit', /Speckl denied execute_bash \(spec tool request_review\): can\(\) refused/);
    allow('pre-bash-npm-test-2');
    posted('post-bash-npm-test-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow('pre-bash-git-commit-2');
    posted('post-bash-git-commit-2');
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);
    deny('pre-bash-git-push', /HNTL/);
    allow('pre-read');
    posted('post-read');
    deny('pre-read-state', /Speckl-protected path/);
    deny('pre-write-hooks', /Speckl-protected path \(\.kiro\/hooks\)/);
    deny('pre-unmapped', /unmapped harness tool "mcp_fetch_fetch"/);
    deny('pre-bash-chained', /shell control characters/);
    deny('pre-bash-elsewhere', /sets cwd "\/tmp"/);
    approve(ctx);
    // A call that never reports is recorded as failed at Stop, silently.
    allow('pre-bash-git-push-2');
    const stop = run('Stop', 'stop');
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    allow('pre-bash-git-push-2');
    posted('post-bash-git-push-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
    // CLI 2.x camelCase event names are accepted (and judged: tests are refused after the PR).
    deny('pre-legacy-camel', /Speckl denied execute_bash \(spec tool run_tests\): can\(\) refused/);
  }, 120_000);

  it('a post that cannot be recorded is a warning (exit 1), not a block', () => {
    const r = run('PostToolUse', 'post-bash-git-commit-2');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Speckl could not record execute_bash \(spec tool request_review\): post: no matching pending call_id/);
  });

  it('crash, exit 1, malformed output, SIGKILL, timeout, corrupt config, bad payloads and missing node all exit 2', () => {
    const hook = join(ctx.project, '.speckl', 'agent', 'hook.mjs');
    const good = readFileSync(hook, 'utf-8');
    try {
      for (const [name, body] of Object.entries(BROKEN_HOOK)) {
        writeFileSync(hook, body);
        const r = run('PreToolUse', 'pre-read', { SPECKL_HOOK_TIMEOUT_MS: '700' });
        expect(r.status, `${name}: ${r.stderr}`).toBe(2);
        expect(r.stderr, name).toMatch(/Speckl denied read_file/);
      }
    } finally { writeFileSync(hook, good); }
    const a = join(ctx.project, '.speckl', 'agent', 'adapter.mjs');
    copyFileSync(a, a + '.good');
    try {
      for (const [name, body] of Object.entries(BROKEN_ADAPTER)) {
        writeFileSync(a, body);
        const r = run('PreToolUse', 'pre-read');
        // Even an adapter that exits 0 blocks unless it printed the allow line.
        expect(r.status, name).toBe(2);
      }
    } finally { copyFileSync(a + '.good', a); }
    expect(sh(cmds.PreToolUse, ctx.project, { PATH: '/nonexistent' }, fixtureText('kiro', 'pre-read', ctx.project)).status).toBe(2);
    for (const bad of ['', 'not json', '[]', '{"hook_event_name":"PostToolUse"}']) {
      expect(sh(cmds.PreToolUse, ctx.project, {}, bad).status, bad).toBe(2);
    }
    const cfg = join(ctx.project, '.speckl', 'agent', 'agent-config.json');
    const goodCfg = readFileSync(cfg, 'utf-8');
    try {
      writeFileSync(cfg, '{corrupt');
      const r = run('PreToolUse', 'pre-read');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Speckl adapter error');
      expect(run('Stop', 'stop')).toMatchObject({ status: 0, stdout: '' });
    } finally { writeFileSync(cfg, goodCfg); }
  }, 60_000);
});
