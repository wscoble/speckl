// End-to-end: examples/ClaudeCodePolicy.speckdl compiled, installed with
// adapter.mjs install pi|opencode|openclaw, and driven through the generated
// plugin itself: the test imports the plugin module the harness would load,
// registers it against a stand-in for the host API, and calls its handlers
// with real-format events. The plugin then runs `node adapter.mjs ...`
// exactly as it does inside the harness.
// Event shapes: pi 1.3.0 packages/coding-agent/src/core/extensions/types.ts
// (ToolCallEvent, ToolResultEvent), opencode 1.19.3 @opencode-ai/plugin Hooks
// and packages/opencode/src/session/tools.ts, openclaw 2026.10.5
// src/plugins/hook-types.ts (PluginHookBeforeToolCallEvent, ...); all three
// were also captured live (docs/harness-adapters.md, "Live runs").
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const fixtures = join(compilerDir, 'src', '__tests__', 'fixtures', 'harness');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type Harness = 'pi' | 'opencode' | 'openclaw';
interface Run { status: number | null; stdout: string; stderr: string }
type Fn = (...a: any[]) => any;

function sh(command: string, cwd: string, env: Record<string, string> = {}): Run {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '', ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixture(harness: Harness, name: string, project: string): any {
  return JSON.parse(readFileSync(join(fixtures, harness, name + '.json'), 'utf-8').replace(/__PROJECT__/g, project));
}

const pluginPath: Record<Harness, string> = {
  pi: '.pi/extensions/speckl.js',
  opencode: '.opencode/plugins/speckl.js',
  openclaw: '.openclaw/plugins/speckl/index.js',
};

/** Load the plugin as the harness does and return its handlers by event name. */
async function load(harness: Harness, project: string, bust = ''): Promise<Record<string, Fn>> {
  const url = pathToFileURL(join(project, pluginPath[harness])).href + '?v=' + bust + Date.now();
  const mod = await import(/* @vite-ignore */ url);
  const handlers: Record<string, Fn> = {};
  if (harness === 'pi') {
    mod.default({ on: (ev: string, fn: Fn) => { handlers[ev] = fn; } });
  } else if (harness === 'opencode') {
    const fns = Object.values(mod).filter(v => typeof v === 'function') as Fn[];
    expect(fns).toHaveLength(1);
    Object.assign(handlers, await fns[0]({ directory: project, worktree: project }));
  } else {
    const warned: string[] = [];
    mod.default.register({ on: (ev: string, fn: Fn, opts: unknown) => { handlers[ev] = fn; handlers['opts:' + ev] = (() => opts) as Fn; }, logger: { warn: (t: string) => warned.push(t) } });
    handlers.warned = (() => warned) as Fn;
    expect(mod.default.id).toBe('speckl');
  }
  return handlers;
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

/** Swap adapter.mjs for a misbehaving script for the duration of fn. */
async function withAdapter(project: string, body: string, fn: () => Promise<void>) {
  const a = join(project, '.speckl', 'agent', 'adapter.mjs');
  copyFileSync(a, a + '.good');
  writeFileSync(a, body);
  try { await fn(); } finally { copyFileSync(a + '.good', a); }
}
const BROKEN = {
  crash: "throw new Error('adapter crashed');\n",
  exit1: 'process.exit(1);\n',
  exit0Empty: 'process.exit(0);\n',
  exit0NoAllow: "process.stdout.write('{}\\n');\n",
  garbage: "process.stdout.write('allow\\n');\n",
  killed: "process.kill(process.pid, 'SIGKILL');\n",
};

describe('Pi wiring (real events through the generated .pi/extensions/speckl.js)', () => {
  let ctx: ReturnType<typeof setup>;
  let h: Record<string, Fn>;
  const pre = (name: string) => { const f = fixture('pi', name, ctx.project); return h.tool_call(f.event, f.ctx); };
  const post = (name: string) => { const f = fixture('pi', name, ctx.project); return h.tool_result(f.event, f.ctx); };
  const allow = async (name: string) => expect(await pre(name)).toBeUndefined();
  const deny = async (name: string, why: RegExp) => {
    const r = await pre(name);
    expect(r).toMatchObject({ block: true });
    expect(r.reason).toMatch(why);
  };
  const posted = async (name: string) => expect(await post(name)).toBeUndefined();

  beforeAll(async () => { ctx = setup('pi'); h = await load('pi', ctx.project); }, 90_000);

  it('writes a project extension with absolute paths and --project, registering tool_call / tool_result / agent_end', () => {
    expect(ctx.inst.stdout).toMatch(/Speckl pi plugin written to .*\.pi\/extensions\/speckl\.js/);
    expect(ctx.inst.stdout).toMatch(/\/trust once, or pass --approve/);
    const src = readFileSync(join(ctx.project, pluginPath.pi), 'utf-8');
    expect(src).toMatch(/^\/\/ Generated by speckl adapter\.mjs install pi;/);
    expect(src).toContain(`const ARGV = [${JSON.stringify(ctx.project + '/.speckl/agent/adapter.mjs')}, "--state", ${JSON.stringify(ctx.project + '/.speckl/state.json')}, "--key", ${JSON.stringify(ctx.key)}, "--project", ${JSON.stringify(ctx.project)}];`);
    expect(Object.keys(h).sort()).toEqual(['agent_end', 'tool_call', 'tool_result']);
    // The reference copy next to the adapter resolves paths from its install location.
    const ref = readFileSync(join(ctx.project, '.speckl', 'agent', 'harness', 'pi', 'speckl.js'), 'utf-8');
    expect(ref).toContain('const ROOT = fileURLToPath(new URL("../../", import.meta.url));');
    expect(ref).toContain('resolve(ROOT, ".speckl/agent/adapter.mjs")');
  });

  it('walks write → failing test → green test → commit → HNTL → approval → push', async () => {
    await allow('pre-write');
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: 'src/app.js' } });
    await posted('post-write');
    expect(stateOf(ctx.project).pending).toBeNull();

    // A tool that throws reaches tool_result with isError: recorded as failed.
    await allow('pre-edit');
    await posted('post-edit-error');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(0);

    await allow('pre-bash-npm-test');
    await posted('post-bash-npm-test-exit1');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    await deny('pre-bash-git-commit', /Speckl denied bash \(spec tool request_review\): can\(\) refused/);

    await allow('pre-bash-npm-test-2');
    await posted('post-bash-npm-test-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    await allow('pre-bash-git-commit-2');
    await posted('post-bash-git-commit-2');
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    await deny('pre-bash-git-push', /HNTL/);
    await allow('pre-read');
    await posted('post-read');
    await deny('pre-read-state', /Speckl-protected path/);
    await deny('pre-edit-extension', /Speckl-protected path \(\.pi\)/);
    await deny('pre-unmapped', /unmapped harness tool "web_fetch"/);
    await deny('pre-bash-chained', /shell control characters/);

    approve(ctx);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    // A call that never reports (blocked by another extension, aborted) is cleared at agent_end.
    await allow('pre-bash-git-push-2');
    const f = fixture('pi', 'agent-end', ctx.project);
    expect(await h.agent_end(f.event, f.ctx)).toBeUndefined();
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);

    await allow('pre-bash-git-push-2');
    await posted('post-bash-git-push-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
  }, 120_000);

  it('appends a post-hook problem to the tool result the model sees, keeping structuredContent', async () => {
    const f = fixture('pi', 'post-bash-npm-test-2', ctx.project);
    const r = await h.tool_result(f.event, f.ctx);
    expect(r.content[0]).toEqual(f.event.content[0]);
    expect(r.content[1].text).toMatch(/Speckl could not record bash \(spec tool run_tests\): post: no matching pending call_id/);
    expect(r.structuredContent).toEqual(f.event.structuredContent);
  });

  for (const [what, body] of Object.entries(BROKEN)) {
    it(`blocks when the adapter misbehaves (${what})`, async () => {
      await withAdapter(ctx.project, body, async () => {
        const r = await pre('pre-read');
        expect(r).toMatchObject({ block: true });
        expect(r.reason).toMatch(/^Speckl/);
      });
    });
  }

  it('blocks when node is missing, and when the payload cannot be serialised', async () => {
    const PATH = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const r = await pre('pre-read');
      expect(r).toMatchObject({ block: true });
      expect(r.reason).toMatch(/Speckl adapter failed: .*ENOENT/);
    } finally { process.env.PATH = PATH; }
    const f = fixture('pi', 'pre-read', ctx.project);
    f.event.input.limit = 10n;
    const r = await h.tool_call(f.event, f.ctx);
    expect(r).toMatchObject({ block: true });
    expect(r.reason).toMatch(/could not be serialised/);
  });

  it('blocks when the adapter hangs (spawn timeout)', async () => {
    await withAdapter(ctx.project, 'setInterval(() => {}, 1000);\n', async () => {
      const t = Date.now();
      const r = await pre('pre-read');
      expect(r).toMatchObject({ block: true });
      expect(r.reason).toMatch(/Speckl adapter failed: .*ETIMEDOUT/);
      expect(Date.now() - t).toBeLessThan(40_000);
    });
  }, 60_000);
});

describe('OpenCode wiring (real hook arguments through the generated .opencode/plugins/speckl.js)', () => {
  let ctx: ReturnType<typeof setup>;
  let h: Record<string, Fn>;
  const call = async (name: string) => {
    const f = fixture('opencode', name, ctx.project);
    if (f.hook === 'event') return h.event({ event: f.event });
    return h[f.hook](f.input, f.output);
  };
  const allow = async (name: string) => expect(await call(name)).toBeUndefined();
  const deny = async (name: string, why: RegExp) => { await expect(call(name)).rejects.toThrow(why); };
  const posted = async (name: string) => {
    const f = fixture('opencode', name, ctx.project);
    const before = f.output.output;
    await h[f.hook](f.input, f.output);
    expect(f.output.output).toBe(before);
  };

  beforeAll(async () => { ctx = setup('opencode'); h = await load('opencode', ctx.project); }, 90_000);

  it('writes one plugin function with tool.execute.before / after and an event hook', () => {
    expect(ctx.inst.stdout).toMatch(/Speckl opencode plugin written to .*\.opencode\/plugins\/speckl\.js/);
    expect(Object.keys(h).sort()).toEqual(['event', 'tool.execute.after', 'tool.execute.before']);
  });

  it('walks write → failing test → green test → commit → HNTL → approval → push', async () => {
    await allow('pre-write');
    expect(stateOf(ctx.project).pending).toMatchObject({ tool: 'edit_code', input: { path: 'src/app.js' } });
    await posted('post-write');
    // The completed part event that follows is not a failure and is ignored.
    await call('event-write-completed');
    expect(stateOf(ctx.project).pending).toBeNull();

    // A tool that throws never reaches tool.execute.after; its error part event records it as failed.
    await allow('pre-edit');
    expect(stateOf(ctx.project).pending).toMatchObject({ call_id: 'call_e2' });
    await call('event-edit-error');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(0);

    await allow('pre-bash-npm-test');
    await posted('post-bash-npm-test-exit1');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    // workdir set to the project root itself is accepted (cleared unreported at session.idle).
    await allow('pre-bash-workdir-root');
    await call('session-idle');
    expect(stateOf(ctx.project).pending).toBeNull();
    await deny('pre-bash-git-commit', /Speckl denied bash \(spec tool request_review\): can\(\) refused/);

    await allow('pre-bash-npm-test-2');
    await posted('post-bash-npm-test-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    await allow('pre-bash-git-commit-2');
    await posted('post-bash-git-commit-2');
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    await deny('pre-bash-git-push', /HNTL/);
    // OpenCode then reports the denied call as an errored tool part: not ours, ignored.
    await call('event-denied-push-error');
    await allow('pre-read');
    await posted('post-read');
    await deny('pre-read-state', /Speckl-protected path/);
    await deny('pre-edit-plugin', /Speckl-protected path \(\.opencode\)/);
    await deny('pre-edit-config', /Speckl-protected path \(opencode\.json\)/);
    await deny('pre-unmapped', /unmapped harness tool "webfetch"/);
    await deny('pre-bash-chained', /shell control characters/);
    await deny('pre-bash-workdir', /sets workdir "\/tmp\/other-checkout"; Speckl only accepts commands run in the project root/);
    expect(stateOf(ctx.project).pending).toBeNull();

    approve(ctx);
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    // A call that never reports is cleared at session.idle.
    await allow('pre-bash-git-push-2');
    await call('session-idle');
    expect(stateOf(ctx.project).pending).toBeNull();

    await allow('pre-bash-git-push-2');
    await posted('post-bash-git-push-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
  }, 120_000);

  it('appends a post-hook problem to the output the model sees', async () => {
    const f = fixture('opencode', 'post-bash-npm-test-2', ctx.project);
    await h['tool.execute.after'](f.input, f.output);
    expect(f.output.output).toMatch(/^PASS test\/app\.test\.js\n\nSpeckl could not record bash/);
  });

  for (const [what, body] of Object.entries(BROKEN)) {
    it(`blocks when the adapter misbehaves (${what})`, async () => {
      await withAdapter(ctx.project, body, async () => {
        await expect(call('pre-read')).rejects.toThrow(/^Speckl/);
      });
    });
  }

  it('blocks when node is missing', async () => {
    const PATH = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try { await expect(call('pre-read')).rejects.toThrow(/Speckl adapter failed: .*ENOENT/); } finally { process.env.PATH = PATH; }
  });
});

describe('OpenClaw wiring (real hook events through the generated .openclaw/plugins/speckl/)', () => {
  let ctx: ReturnType<typeof setup>;
  let h: Record<string, Fn>;
  const pre = (name: string) => { const f = fixture('openclaw', name, ctx.project); return h.before_tool_call(f.event, f.ctx); };
  const post = (name: string) => { const f = fixture('openclaw', name, ctx.project); return h.after_tool_call(f.event, f.ctx); };
  const allow = (name: string) => expect(pre(name)).toBeUndefined();
  const deny = (name: string, why: RegExp) => {
    const r = pre(name);
    expect(r).toMatchObject({ block: true });
    expect(r.blockReason).toMatch(why);
  };
  const posted = (name: string) => {
    const n = h.warned().length;
    expect(post(name)).toBeUndefined();
    expect(h.warned().slice(n)).toEqual([]);
  };

  beforeAll(async () => { ctx = setup('openclaw'); h = await load('openclaw', ctx.project); }, 90_000);

  it('writes a native plugin (manifest + package.json + index.js) and says how to enable it', () => {
    const dir = join(ctx.project, '.openclaw', 'plugins', 'speckl');
    expect(JSON.parse(readFileSync(join(dir, 'openclaw.plugin.json'), 'utf-8'))).toMatchObject({ id: 'speckl', configSchema: { type: 'object' } });
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))).toMatchObject({ type: 'module', openclaw: { extensions: ['./index.js'] } });
    expect(ctx.inst.stdout).toContain(`plugins.load.paths += ["${dir}"], plugins.entries.speckl.enabled = true`);
    expect(h['opts:before_tool_call']()).toEqual({ timeoutMs: 30000 });
    for (const f of ['index.js', 'openclaw.plugin.json', 'package.json']) {
      expect(existsSync(join(ctx.project, '.speckl', 'agent', 'harness', 'openclaw', f)), f).toBe(true);
    }
  });

  it('walks write → failing test → yielded test → green test → commit → HNTL → approval → push', () => {
    allow('pre-write');
    posted('post-write');
    expect(stateOf(ctx.project).pending).toBeNull();

    // A failed tool arrives with error set: recorded as failed.
    allow('pre-edit');
    posted('post-edit-error');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(0);

    allow('pre-exec-npm-test');
    posted('post-exec-npm-test-exit1');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });
    deny('pre-exec-git-commit', /Speckl denied exec \(spec tool request_review\): can\(\) refused/);
    // A yielded command (details.status "running") is not a success.
    allow('pre-exec-npm-test-2');
    posted('post-exec-npm-test-yielded');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 0, testsPassed: false });

    allow('pre-exec-npm-test-3');
    posted('post-exec-npm-test-3');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 1, testsPassed: true });
    allow('pre-exec-git-commit-2');
    posted('post-exec-git-commit-2');
    expect(stateOf(ctx.project).machine.state.stage).toBe(2);

    deny('pre-exec-git-push', /HNTL/);
    allow('pre-read');
    posted('post-read');
    deny('pre-read-state', /Speckl-protected path/);
    // OpenClaw then reports the blocked call through after_tool_call
    // (details.status "blocked"): not pending, so nothing is logged.
    posted('post-read-state-blocked');
    deny('pre-edit-plugin', /Speckl-protected path \(\.openclaw\)/);
    deny('pre-unmapped', /unmapped harness tool "web_fetch"/);
    deny('pre-exec-chained', /shell control characters/);
    deny('pre-exec-workdir', /sets workdir "\.\.\/other-checkout"/);

    approve(ctx);
    // Another plugin blocks a push ours allowed: recorded as failed.
    allow('pre-exec-git-push-2');
    posted('post-exec-git-push-blocked-by-other');
    expect(stateOf(ctx.project).pending).toBeNull();
    expect(stateOf(ctx.project).machine.state.stage).toBe(3);
    allow('pre-exec-git-push-2');
    const f = fixture('openclaw', 'session-end', ctx.project);
    expect(h.session_end({}, f.ctx)).toBeUndefined();
    expect(stateOf(ctx.project).pending).toBeNull();
    allow('pre-exec-git-push-2');
    posted('post-exec-git-push-2');
    expect(stateOf(ctx.project).machine.state).toMatchObject({ stage: 5, prFromApproved: true });
  }, 120_000);

  it('logs a post-hook problem through api.logger.warn', () => {
    const n = h.warned().length;
    post('post-exec-git-push-2');
    expect(h.warned().slice(n).join('\n')).toMatch(/Speckl could not record exec \(spec tool open_pr\): post: no matching pending call_id/);
  });

  for (const [what, body] of Object.entries(BROKEN)) {
    it(`blocks when the adapter misbehaves (${what})`, async () => {
      await withAdapter(ctx.project, body, async () => {
        const r = pre('pre-read');
        expect(r).toMatchObject({ block: true });
        expect(r.blockReason).toMatch(/^Speckl/);
      });
    });
  }
});

describe('install refuses to overwrite a plugin Speckl did not write', () => {
  afterEach(() => { /* temp dirs are left for inspection */ });
  for (const harness of ['pi', 'opencode', 'openclaw'] as Harness[]) {
    it(harness, () => {
      const ctx = setup(harness);
      const p = join(ctx.project, pluginPath[harness]);
      writeFileSync(p, 'export default function mine() {}\n');
      const r = sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${ctx.key}`, ctx.project);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/exists and was not written by Speckl; not touching it/);
      expect(readFileSync(p, 'utf-8')).toBe('export default function mine() {}\n');
      // Re-running install over its own plugin is fine.
      writeFileSync(p, '');
      expect(sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${ctx.key}`, ctx.project).status).toBe(0);
      expect(sh(`node .speckl/agent/adapter.mjs install ${harness} --project . --state .speckl/state.json --key ${ctx.key}`, ctx.project).status).toBe(0);
    }, 90_000);
  }
});
