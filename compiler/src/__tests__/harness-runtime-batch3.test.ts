// Unit tests for the Pi, OpenCode and OpenClaw branches of the harness
// adapter runtime (emitted verbatim into adapter.mjs) and the generated plugin.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  formatPre, formatPost, postSucceeded, harnessEventName, normalizePayload, normalizeToolInput,
  harnessCallId, harnessConfigFile, harnessProtectedDirs, buildHarnessHooks, pluginSource, pluginFiles,
  installHarness, runAdapter, ADAPTER_FUNCTIONS,
  HarnessRule, AdapterDeps, HookResult,
} from '../generators/agent/harness-runtime.js';

function fakeDeps(files: Record<string, string> = {}, hook?: (cmd: string, msg: any) => HookResult) {
  const calls: any[] = [];
  const d: AdapterDeps & { calls: any[]; files: Record<string, string> } = {
    calls,
    files,
    runHook(cmd, msg, statePath, keyPath) {
      calls.push({ cmd, msg, statePath, keyPath });
      return hook ? hook(cmd, msg) : { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' };
    },
    resolvePath: (b: string, p: string) => path.posix.resolve(b, p),
    relativePath: (a: string, b: string) => path.posix.relative(a, b),
    dirname: (p: string) => path.posix.dirname(p),
    cwd: '/p',
    agentDir: '/p/.speckl/agent',
    readFile: (p: string) => (p in files ? files[p] : null),
    writeFile: (p: string, t: string) => { files[p] = t; },
    mac(keyText, text) {
      const hex = String(keyText || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      return createHmac('sha256', Buffer.from(hex, 'hex')).update(text).digest('hex');
    },
  };
  return d;
}

const rules: HarnessRule[] = [
  { tools: ['bash', 'exec'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
  { tools: ['write'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
  { tools: ['apply_patch'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
];
const config = { harness: { pi: { rules }, opencode: { rules }, openclaw: { rules } } };
const argv = (h: string, ev: string, more: string[] = []) => [h, ev, '--state', '.speckl/state.json', '--project', '/p', ...more];
const pending = (call_id: string, tool = 'run_tests') => JSON.stringify({ pending: { call_id, tool, input: {} } });

describe('event names, config files, protected paths', () => {
  it('names every adapter event per harness', () => {
    const ev = (h: string) => ['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName(h, e));
    expect(ev('pi')).toEqual(['tool_call', 'tool_result', null, 'agent_end']);
    expect(ev('opencode')).toEqual(['tool.execute.before', 'tool.execute.after', 'message.part.updated', 'session.idle']);
    expect(ev('openclaw')).toEqual(['before_tool_call', 'after_tool_call', null, 'session_end']);
    expect(harnessConfigFile('pi')).toBe('.pi/extensions/speckl.js');
    expect(harnessConfigFile('opencode')).toBe('.opencode/plugins/speckl.js');
    expect(harnessConfigFile('openclaw')).toBe('.openclaw/plugins/speckl/index.js');
  });
  it('protects .pi, .opencode + opencode.json(c), .openclaw', () => {
    expect(harnessProtectedDirs(['pi', 'opencode', 'openclaw']).slice(4)).toEqual(['.pi', '.opencode', 'opencode.json', 'opencode.jsonc', '.openclaw', '.speckl/harness-install']);
  });
});

describe('normalizePayload and call ids', () => {
  it('pi: type / toolName / input / toolCallId', () => {
    const p = normalizePayload('pi', { type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' }, cwd: '/p' });
    expect(p).toMatchObject({ hook_event_name: 'tool_call', tool_name: 'bash', tool_input: { command: 'ls' }, tool_use_id: 'c1' });
    expect(normalizePayload('pi', {}).hook_event_name).toBeNull();
    expect(harnessCallId('pi', p)).toBe('c1');
    expect(harnessCallId('pi', normalizePayload('pi', { type: 'tool_call', toolName: 'bash' }))).toBeNull();
  });
  it('opencode: before reads output.args, after reads input.args, part events read the tool part', () => {
    const b = normalizePayload('opencode', { hook: 'tool.execute.before', input: { tool: 'bash', sessionID: 's', callID: 'c' }, output: { args: { command: 'x' } }, directory: '/p' });
    expect(b).toMatchObject({ hook_event_name: 'tool.execute.before', tool_name: 'bash', tool_input: { command: 'x' }, tool_use_id: 'c', session_id: 's', cwd: '/p' });
    const a = normalizePayload('opencode', { hook: 'tool.execute.after', input: { tool: 'bash', callID: 'c', args: { command: 'y' } }, output: {} });
    expect(a.tool_input).toEqual({ command: 'y' });
    const e = normalizePayload('opencode', { type: 'message.part.updated', properties: { part: { tool: 'edit', callID: 'c2', sessionID: 's', state: { status: 'error', input: { filePath: 'a' } } } } });
    expect(e).toMatchObject({ hook_event_name: 'message.part.updated', tool_name: 'edit', tool_input: { filePath: 'a' }, tool_use_id: 'c2', session_id: 's' });
    expect(normalizePayload('opencode', { type: 'message.part.updated', properties: [] }).tool_input).toBeUndefined();
    expect(normalizePayload('opencode', { type: 'session.idle' }).hook_event_name).toBe('session.idle');
    expect(normalizePayload('opencode', {}).hook_event_name).toBeNull();
  });
  it('openclaw: event.toolName / params / toolCallId (or ctx.toolCallId)', () => {
    const p = normalizePayload('openclaw', { hook: 'before_tool_call', event: { toolName: 'exec', params: { command: 'x' } }, ctx: { toolCallId: 'k', sessionId: 's' } });
    expect(p).toMatchObject({ hook_event_name: 'before_tool_call', tool_name: 'exec', tool_input: { command: 'x' }, tool_use_id: 'k', session_id: 's' });
    expect(normalizePayload('openclaw', { event: { toolCallId: 'e' }, ctx: { toolCallId: 'k' } }).tool_use_id).toBe('e');
    expect(normalizePayload('openclaw', {}).hook_event_name).toBeNull();
  });
  it('apply_patch: OpenCode patchText and OpenClaw input expose the touched files', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/b.js\n+z\n*** End Patch';
    expect(normalizeToolInput('opencode', 'apply_patch', { patchText: patch })).toMatchObject({ files: ['src/a.js', 'src/b.js'], path: 'src/a.js' });
    expect(normalizeToolInput('openclaw', 'apply_patch', { input: patch })).toMatchObject({ files: ['src/a.js', 'src/b.js'], path: 'src/a.js' });
    expect(normalizeToolInput('pi', 'apply_patch', { input: patch })).toEqual({ input: patch });
  });
});

describe('postSucceeded', () => {
  it('pi: isError false; bash also needs structuredContent.exit_code 0', () => {
    expect(postSucceeded('pi', 'post', { tool_name: 'write', isError: false })).toBe(true);
    expect(postSucceeded('pi', 'post', { tool_name: 'write' })).toBe(false);
    expect(postSucceeded('pi', 'post', { tool_name: 'write', isError: true })).toBe(false);
    expect(postSucceeded('pi', 'post', { tool_name: 'bash', isError: false, structuredContent: { exit_code: 0 } })).toBe(true);
    expect(postSucceeded('pi', 'post', { tool_name: 'bash', isError: false, structuredContent: { exit_code: 1 } })).toBe(false);
    expect(postSucceeded('pi', 'post', { tool_name: 'bash', isError: false })).toBe(false);
    expect(postSucceeded('pi', 'post', { tool_name: 'powershell', isError: false, structuredContent: [] })).toBe(false);
  });
  it('opencode: output present; bash needs metadata.exit 0', () => {
    expect(postSucceeded('opencode', 'post', { tool_name: 'write', output: { output: 'ok' } })).toBe(true);
    expect(postSucceeded('opencode', 'post', { tool_name: 'write' })).toBe(false);
    expect(postSucceeded('opencode', 'post', { tool_name: 'bash', output: { metadata: { exit: 0 } } })).toBe(true);
    expect(postSucceeded('opencode', 'post', { tool_name: 'bash', output: { metadata: { exit: null } } })).toBe(false);
    expect(postSucceeded('opencode', 'post', { tool_name: 'bash', output: {} })).toBe(false);
    expect(postSucceeded('opencode', 'post-failure', { tool_name: 'write', output: {} })).toBe(false);
  });
  it('openclaw: no error, a result object; exec needs completed + exitCode 0', () => {
    const ok = (event: unknown, tool = 'read') => postSucceeded('openclaw', 'post', { tool_name: tool, event });
    expect(ok({ result: { content: [] } })).toBe(true);
    expect(ok(undefined)).toBe(false);
    expect(ok({})).toBe(false);
    expect(ok({ result: [] })).toBe(false);
    expect(ok({ result: { content: [] }, error: 'boom' })).toBe(false);
    expect(ok({ result: { content: [] }, error: '' })).toBe(true);
    expect(ok({ result: { isError: true } })).toBe(false);
    expect(ok({ result: { details: { status: 'error' } } })).toBe(false);
    expect(ok({ result: { details: { status: 'failed' } } }, 'exec')).toBe(false);
    expect(ok({ result: { details: { status: 'completed', exitCode: 0 } } }, 'exec')).toBe(true);
    expect(ok({ result: { details: { status: 'completed', exitCode: 2 } } }, 'exec')).toBe(false);
    expect(ok({ result: { details: { status: 'running' } } }, 'exec')).toBe(false);
    expect(ok({ result: {} }, 'bash')).toBe(false);
  });
});

describe('formatPre / formatPost', () => {
  it('allow is exit 0 + {"decision":"allow"}; deny is exit 2 + block JSON + stderr', () => {
    for (const h of ['pi', 'opencode', 'openclaw']) {
      expect(formatPre(h, true, '')).toEqual({ code: 0, stdout: '{"decision":"allow"}\n', stderr: '' });
      expect(formatPre(h, false, 'no')).toEqual({ code: 2, stdout: '{"decision":"block","reason":"no"}\n', stderr: 'no\n' });
      expect(formatPost(h, null)).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(formatPost(h, 'p')).toEqual({ code: 0, stdout: '{"additionalContext":"p"}\n', stderr: 'p\n' });
    }
  });
});

describe('runAdapter', () => {
  it('opencode post-failure for a call that is not pending is ignored; ours is recorded as failed', () => {
    const ev = (id: string) => JSON.stringify({ type: 'message.part.updated', properties: { part: { tool: 'bash', callID: id, state: { status: 'error', input: { command: 'npm test' } } } } });
    let d = fakeDeps({ '/p/.speckl/state.json': pending('other') });
    expect(runAdapter(argv('opencode', 'post-failure'), {}, ev('mine'), config, d)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls).toEqual([]);
    d = fakeDeps({});
    expect(runAdapter(argv('opencode', 'post-failure'), {}, ev('mine'), config, d).code).toBe(0);
    expect(d.calls).toEqual([]);
    d = fakeDeps({ '/p/.speckl/state.json': '{broken' });
    expect(runAdapter(argv('opencode', 'post-failure'), {}, ev('mine'), config, d).stdout).toBe('');
    d = fakeDeps({ '/p/.speckl/state.json': pending('mine') });
    expect(runAdapter(argv('opencode', 'post-failure'), {}, ev('mine'), config, d)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls).toEqual([expect.objectContaining({ cmd: 'post', msg: { tool: 'run_tests', input: {}, call_id: 'mine', ok: false } })]);
  });
  it('openclaw after_tool_call for a blocked call: ignored unless it was our pending call', () => {
    const ev = (id: string) => JSON.stringify({ hook: 'after_tool_call', event: { toolName: 'exec', params: { command: 'npm test' }, toolCallId: id, error: 'x', result: { details: { status: 'blocked' } } }, ctx: {} });
    let d = fakeDeps({ '/p/.speckl/state.json': pending('other') });
    expect(runAdapter(argv('openclaw', 'post'), {}, ev('mine'), config, d)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls).toEqual([]);
    d = fakeDeps({ '/p/.speckl/state.json': pending('mine') });
    runAdapter(argv('openclaw', 'post'), {}, ev('mine'), config, d);
    expect(d.calls[0].msg).toMatchObject({ call_id: 'mine', ok: false });
    // An after_tool_call without a result object is not a blocked report.
    d = fakeDeps({});
    const r = runAdapter(argv('openclaw', 'post'), {}, JSON.stringify({ hook: 'after_tool_call', event: { toolName: 'exec', params: { command: 'npm test' }, toolCallId: 'z' } }), config, d);
    expect(d.calls[0].msg).toMatchObject({ call_id: 'z', ok: false });
    expect(r.code).toBe(0);
  });
  it('workdir must be the project root (OpenCode bash, OpenClaw exec)', () => {
    const pre = (h: string, args: Record<string, unknown>) => {
      const p = h === 'opencode'
        ? { hook: 'tool.execute.before', input: { tool: 'bash', callID: 'c' }, output: { args }, directory: '/p' }
        : { hook: 'before_tool_call', event: { toolName: 'exec', params: args, toolCallId: 'c' } };
      return runAdapter(argv(h, 'pre'), {}, JSON.stringify(p), config, fakeDeps());
    };
    for (const h of ['opencode', 'openclaw']) {
      expect(pre(h, { command: 'npm test', workdir: '/elsewhere' }).stderr).toMatch(/sets workdir "\/elsewhere"; Speckl only accepts commands run in the project root \(\/p\)/);
      expect(pre(h, { command: 'npm test', workdir: 7 }).stderr).toMatch(/sets workdir 7/);
      expect(pre(h, { command: 'npm test', workdir: 'src' }).code).toBe(2);
      expect(pre(h, { command: 'npm test', workdir: '/p' }).code).toBe(0);
      expect(pre(h, { command: 'npm test', workdir: '.' }).code).toBe(0);
      expect(pre(h, { command: 'npm test', workdir: '' }).code).toBe(0);
      expect(pre(h, { command: 'npm test', workdir: null }).code).toBe(0);
    }
    // Pi bash has no workdir; the field means nothing there and is not checked.
    const p = { type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command: 'npm test', workdir: '/x' }, cwd: '/p' };
    expect(runAdapter(argv('pi', 'pre'), {}, JSON.stringify(p), config, fakeDeps()).code).toBe(0);
  });
  it('refuses a payload wired to the wrong event', () => {
    const r = runAdapter(argv('pi', 'pre'), {}, JSON.stringify({ type: 'tool_result', toolName: 'bash', toolCallId: 'c', input: {} }), config, fakeDeps());
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
    expect(r.stderr).toMatch(/payload is "tool_result" but this hook is wired as tool_call/);
  });
});

describe('buildHarnessHooks / pluginSource / pluginFiles', () => {
  it('argv carries state, key, project and --outside allow', () => {
    expect(buildHarnessHooks('pi', { adapter: '/a.mjs', state: '/s.json', key: '/k', relative: false, project: '/p', outsideAllow: true }))
      .toEqual({ plugin: 'pi', argv: ['/a.mjs', '--state', '/s.json', '--key', '/k', '--project', '/p', '--outside', 'allow'], relative: false });
    expect(buildHarnessHooks('openclaw', { adapter: 'a.mjs', state: 's.json', key: null, relative: true }))
      .toEqual({ plugin: 'openclaw', argv: ['a.mjs', '--state', 's.json'], relative: true });
  });
  it('relative paths resolve from the install location; absolute ones are left alone', () => {
    const src = pluginSource('openclaw', { argv: ['.speckl/agent/adapter.mjs', '--state', '/abs/state.json', '--key', 'k'], relative: true });
    expect(src).toContain('const ROOT = fileURLToPath(new URL("../../../", import.meta.url));');
    expect(src).toContain('const ARGV = [resolve(ROOT, ".speckl/agent/adapter.mjs"), "--state", "/abs/state.json", "--key", resolve(ROOT, "k")];');
    expect(pluginSource('pi', { argv: ['/a.mjs'] })).not.toContain('ROOT');
    expect(pluginSource('pi', {})).toContain('const ARGV = [];');
  });
  it('every generated plugin is valid JavaScript (node --check)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'speckl-plugin-check-'));
    for (const h of ['pi', 'opencode', 'openclaw']) {
      for (const relative of [false, true]) {
        const f = path.join(dir, `${h}-${relative}.mjs`);
        writeFileSync(f, pluginSource(h, { argv: ['/a.mjs', '--state', '/s'], relative }));
        const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf-8' });
        expect(r.status, h + ': ' + r.stderr).toBe(0);
      }
    }
  });
  it('OpenClaw ships a manifest and package.json next to index.js', () => {
    const files = pluginFiles('openclaw', { argv: [] });
    expect(Object.keys(files)).toEqual(['index.js', 'openclaw.plugin.json', 'package.json']);
    expect(Object.keys(pluginFiles('pi', { argv: [] }))).toEqual(['speckl.js']);
  });
  it('plugin functions are part of the emitted adapter', () => {
    expect(ADAPTER_FUNCTIONS).toContain(pluginSource);
    expect(ADAPTER_FUNCTIONS).toContain(pluginFiles);
  });
});

describe('installHarness (plugins)', () => {
  const flags = { project: '.', state: '.speckl/state.json', key: '/keys/k' };
  const keyFile = { '/keys/k': 'cd'.repeat(32) + '\n' };
  it('writes the project plugin with pinned absolute paths', () => {
    const d = fakeDeps({ ...keyFile });
    const r = installHarness('opencode', flags, d);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Speckl opencode plugin written to /p/.opencode/plugins/speckl.js\nOpenCode loads .opencode/plugins/ at startup; restart running sessions.\n');
    expect(d.files['/p/.opencode/plugins/speckl.js']).toContain('const ARGV = ["/p/.speckl/agent/adapter.mjs", "--state", "/p/.speckl/state.json", "--key", "/keys/k", "--project", "/p"];');
  });
  it('--plugins-dir installs a user-level plugin (pi, opencode) that allows calls outside the project', () => {
    for (const h of ['pi', 'opencode']) {
      const d = fakeDeps({ ...keyFile });
      const r = installHarness(h, { ...flags, 'plugins-dir': '/home/u/plugins' }, d);
      expect(r.code).toBe(0);
      const file = Object.keys(d.files).find(f => f.startsWith('/home/u/plugins/'))!;
      expect(file).toMatch(/^\/home\/u\/plugins\/speckl-[0-9a-f]{8}\.js$/);
      expect(d.files[file]).toContain('"--outside", "allow"');
      expect(r.stdout).toContain(h === 'pi' ? 'user-level extension in every session' : 'loads /home/u/plugins at startup');
    }
    // OpenClaw has no user-scope variant: --plugins-dir is ignored.
    const d = fakeDeps({ ...keyFile });
    installHarness('openclaw', { ...flags, 'plugins-dir': '/home/u/plugins' }, d);
    const written = Object.keys(d.files).filter(k => !k.includes('/.speckl/harness-install/') && k !== '/keys/k').sort();
    expect(written).toEqual(['/p/.openclaw/plugins/speckl/index.js', '/p/.openclaw/plugins/speckl/openclaw.plugin.json', '/p/.openclaw/plugins/speckl/package.json']);
    expect(Object.keys(d.files).some(k => k.endsWith('/openclaw.json'))).toBe(true);
  });
  it('never overwrites a plugin it did not write, nor a foreign manifest', () => {
    let d = fakeDeps({ ...keyFile, '/p/.pi/extensions/speckl.js': 'export default () => {}\n' });
    expect(installHarness('pi', flags, d)).toMatchObject({ code: 1, stderr: '/p/.pi/extensions/speckl.js exists and was not written by Speckl; not touching it\n' });
    d = fakeDeps({ ...keyFile, '/p/.openclaw/plugins/speckl/openclaw.plugin.json': '{"id":"mine"}' });
    expect(installHarness('openclaw', flags, d)).toMatchObject({ code: 1, stderr: '/p/.openclaw/plugins/speckl/openclaw.plugin.json exists and was not written by Speckl; not touching it\n' });
    // Its own files are replaced.
    d = fakeDeps({ ...keyFile });
    installHarness('openclaw', flags, d);
    d.files['/p/.openclaw/plugins/speckl/package.json'] = '{}';
    expect(installHarness('openclaw', flags, d).code).toBe(0);
    expect(JSON.parse(d.files['/p/.openclaw/plugins/speckl/package.json']).name).toBe('speckl-openclaw-rails');
  });
});
