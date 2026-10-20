// Unit tests for the Cline, Kiro and Windsurf branches of the harness adapter
// runtime (emitted verbatim into adapter.mjs).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  formatPre, formatPost, postSucceeded, harnessEventName, normalizePayload, normalizeToolInput,
  harnessCallId, harnessConfigFile, harnessProtectedDirs, buildHarnessHooks, clineScripts,
  installHarness, runAdapter, ADAPTER_FUNCTIONS,
  HarnessRule, AdapterDeps, HookResult,
} from '../generators/agent/harness-runtime.js';

function fakeDeps(files: Record<string, string> = {}, hook?: (cmd: string, msg: any) => HookResult) {
  const calls: any[] = [];
  const modes: Record<string, number> = {};
  const d: AdapterDeps & { calls: any[]; files: Record<string, string>; modes: Record<string, number> } = {
    calls,
    files,
    modes,
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
    writeFile: (p: string, t: string, mode?: number) => { files[p] = t; if (mode) modes[p] = mode; },
  };
  return d;
}

const rules: HarnessRule[] = [
  { tools: ['run_commands'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
  { tools: ['editor', 'apply_patch'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
];
const config = { harness: { cline: { rules } } };
const argv = (h: string, ev: string, more: string[] = []) => [h, ev, '--state', '.speckl/state.json', '--project', '/p', ...more];

describe('cline', () => {
  it('events, hook directory, protected paths', () => {
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('cline', e))).toEqual(['PreToolUse', 'PostToolUse', null, 'TaskComplete']);
    expect(harnessConfigFile('cline')).toBe('.clinerules/hooks/PreToolUse');
    expect(harnessProtectedDirs(['cline']).slice(4)).toEqual(['.clinerules/hooks', '.cline']);
  });

  it('normalizes the CLI shape (tool_call / tool_result) and the VS Code shape (string parameters)', () => {
    const cli = normalizePayload('cline', { hookName: 'tool_call', taskId: 't', workspaceRoots: ['/p'], tool_call: { id: 'c1', name: 'editor', input: { path: 'a' } }, preToolUse: { toolName: 'editor', parameters: { path: 'a' } } });
    expect(cli).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'editor', tool_input: { path: 'a' }, tool_use_id: 'c1', session_id: 't', cwd: '/p' });
    expect(harnessCallId('cline', cli)).toBe('c1');
    const res = normalizePayload('cline', { hookName: 'tool_result', tool_result: { id: 'c1', name: 'editor', input: { path: 'a' } } });
    expect(res).toMatchObject({ hook_event_name: 'PostToolUse', tool_name: 'editor', tool_use_id: 'c1' });
    const vs = normalizePayload('cline', { hookName: 'PreToolUse', taskId: 't', preToolUse: { toolName: 'run_commands', parameters: { commands: '["npm test"]', path: 'x', bad: '[oops', n: 3 } } });
    expect(vs).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'run_commands', tool_input: { commands: ['npm test'], path: 'x', bad: '[oops', n: 3 } });
    expect(vs.tool_use_id).toBeUndefined();
    // No call id: derived from the task and tool name, the same on pre and post.
    const id = harnessCallId('cline', vs);
    expect(id).toMatch(/^cline-[0-9a-f]{8}$/);
    expect(harnessCallId('cline', normalizePayload('cline', { hookName: 'PostToolUse', taskId: 't', postToolUse: { toolName: 'run_commands', parameters: {} } }))).toBe(id);
    expect(harnessCallId('cline', normalizePayload('cline', { hookName: 'PreToolUse' }))).toBeNull();
    for (const [h, ev] of [['agent_end', 'TaskComplete'], ['agent_abort', 'TaskComplete'], ['agent_error', 'TaskComplete'], ['TaskCancel', 'TaskComplete'], ['TaskError', 'TaskComplete'], ['UserPromptSubmit', 'UserPromptSubmit']]) {
      expect(normalizePayload('cline', { hookName: h }).hook_event_name).toBe(ev);
    }
    expect(normalizePayload('cline', {}).hook_event_name).toBeNull();
    expect(normalizePayload('cline', { preToolUse: { toolName: 'x', parameters: [] } }).tool_input).toBeUndefined();
  });

  it('run_commands maps only a single plain command; apply_patch exposes the touched files', () => {
    expect(normalizeToolInput('cline', 'run_commands', { commands: ['npm test'] })).toMatchObject({ command: 'npm test' });
    expect(normalizeToolInput('cline', 'run_commands', { commands: 'npm test' })).toMatchObject({ command: 'npm test' });
    expect(normalizeToolInput('cline', 'run_commands', { command: 'npm test' })).toMatchObject({ command: 'npm test' });
    expect(normalizeToolInput('cline', 'run_commands', { cmd: 'npm test' })).toMatchObject({ command: 'npm test' });
    expect(normalizeToolInput('cline', 'run_commands', { commands: ['npm test', 'echo hi'] }).command).toBeUndefined();
    expect(normalizeToolInput('cline', 'run_commands', { commands: [{ command: 'npm', args: ['test'] }] }).command).toBeUndefined();
    expect(normalizeToolInput('cline', 'run_commands', { commands: [], command: 'npm test' }).command).toBeUndefined();
    const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** End Patch';
    expect(normalizeToolInput('cline', 'apply_patch', { input: patch })).toMatchObject({ files: ['src/a.js'], path: 'src/a.js' });
    expect(normalizeToolInput('cline', 'editor', { path: 'a' })).toEqual({ path: 'a' });
  });

  it('postSucceeded: every run_commands entry must report success; VS Code shell results never count', () => {
    const cli = (tool: string, output: unknown, error?: unknown) => postSucceeded('cline', 'post', { tool_name: tool, tool_result: { output, error } });
    expect(cli('run_commands', [{ query: 'npm test', success: true }])).toBe(true);
    expect(cli('run_commands', [{ success: true }, { success: false }])).toBe(false);
    expect(cli('run_commands', [])).toBe(false);
    expect(cli('run_commands', [null])).toBe(false);
    expect(cli('run_commands', 'text')).toBe(false);
    expect(cli('editor', { success: true })).toBe(true);
    expect(cli('editor', { success: false })).toBe(false);
    expect(cli('editor', { error: 'x' })).toBe(false);
    expect(cli('editor', { isError: true })).toBe(false);
    expect(cli('editor', 'ok')).toBe(true);
    expect(cli('editor', { success: true }, 'boom')).toBe(false);
    const vs = (tool: string, result: unknown, success: unknown) => postSucceeded('cline', 'post', { tool_name: tool, postToolUse: { result, success } });
    expect(vs('editor', '[object Object]', true)).toBe(true);
    expect(vs('editor', '[object Object]', false)).toBe(false);
    expect(vs('run_commands', '[object Object]', true)).toBe(false);
    expect(vs('run_commands', '[{"success":true}]', true)).toBe(true);
    expect(vs('read_files', '{"success":false}', true)).toBe(false);
    expect(postSucceeded('cline', 'post', { tool_name: 'editor' })).toBe(false);
    expect(postSucceeded('cline', 'turn-end', { tool_name: 'editor', tool_result: { output: 'x' } })).toBe(false);
  });

  it('formatPre / formatPost speak the cancel JSON; a post problem never cancels', () => {
    expect(formatPre('cline', true, '')).toEqual({ code: 0, stdout: '{"cancel":false}\n', stderr: '' });
    expect(formatPre('cline', false, 'no')).toEqual({ code: 2, stdout: '{"cancel":true,"errorMessage":"no"}\n', stderr: 'no\n' });
    expect(formatPost('cline', null)).toEqual({ code: 0, stdout: '{"cancel":false}\n', stderr: '' });
    expect(formatPost('cline', 'p')).toEqual({ code: 0, stdout: '{"cancel":false,"contextModification":"p"}\n', stderr: 'p\n' });
  });

  it('writes five executable hook scripts and refuses to overwrite hooks it did not write', () => {
    const d = fakeDeps();
    const r = installHarness('cline', { project: '.', state: '.speckl/state.json', key: '/k/key' }, d);
    expect(r.code, r.stderr).toBe(0);
    const names = ['PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'TaskError'];
    for (const n of names) {
      expect(d.files['/p/.clinerules/hooks/' + n]).toMatch(/^#!\/bin\/sh\n# Generated by speckl adapter.mjs install cline/);
      expect(d.modes['/p/.clinerules/hooks/' + n]).toBe(0o755);
    }
    expect(d.files['/p/.clinerules/hooks/PreToolUse']).toContain('node /p/.speckl/agent/adapter.mjs cline pre --state /p/.speckl/state.json --key /k/key --project /p');
    // Rerun replaces our own files.
    expect(installHarness('cline', { project: '.', state: '.speckl/state.json' }, d).code).toBe(0);
    for (const other of ['PreToolUse', 'TaskError.sh', 'PostToolUse.py', 'TaskCancel.ps1']) {
      const d2 = fakeDeps({ ['/p/.clinerules/hooks/' + other]: 'echo mine\n' });
      const r2 = installHarness('cline', { project: '.', state: '.speckl/state.json' }, d2);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toContain('was not written by Speckl');
      expect(Object.keys(d2.files)).toEqual(['/p/.clinerules/hooks/' + other]);
    }
    // An empty placeholder is not someone else's hook.
    expect(installHarness('cline', { project: '.', state: '.speckl/state.json' }, fakeDeps({ '/p/.clinerules/hooks/PreToolUse': '\n' })).code).toBe(0);
  });

  it('clineScripts: the pre wrapper only passes an exact allow, passes the adapter cancel, else cancels', () => {
    const s = clineScripts(buildHarnessHooks('cline', { adapter: '/a.mjs', state: '/s', key: null, relative: false, project: '/p' }));
    expect(Object.keys(s)).toEqual(['PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'TaskError']);
    expect(s.PreToolUse).toContain('[ "$last" = \'{"cancel":false}\' ]');
    expect(s.PreToolUse).toContain('\'{"cancel":true,\'*)');
    expect(s.TaskComplete).toContain('node /a.mjs cline turn-end --state /s --project /p >/dev/null');
    expect(clineScripts({}).PreToolUse).toContain('out=$($T undefined)');
  });

  it('runAdapter: a denied pre is a cancel; a post maps CLI tool_result success', () => {
    const d = fakeDeps({}, (cmd) => cmd === 'pre' ? { status: 2, stdout: '{"decision":"deny","reason":"nope"}\n', stderr: '' } : { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' });
    const pre = runAdapter(argv('cline', 'pre'), {}, JSON.stringify({ hookName: 'tool_call', taskId: 't', tool_call: { id: 'c1', name: 'run_commands', input: { commands: ['npm test'] } } }), config, d);
    expect(pre.code).toBe(2);
    expect(JSON.parse(pre.stdout)).toEqual({ cancel: true, errorMessage: 'Speckl denied run_commands (spec tool run_tests): nope' });
    const multi = runAdapter(argv('cline', 'pre'), {}, JSON.stringify({ hookName: 'tool_call', tool_call: { id: 'c2', name: 'run_commands', input: { commands: ['npm test', 'echo'] } } }), config, d);
    expect(JSON.parse(multi.stdout).cancel).toBe(true);
    const post = runAdapter(argv('cline', 'post'), {}, JSON.stringify({ hookName: 'tool_result', tool_result: { id: 'c1', name: 'run_commands', input: { commands: ['npm test'] }, output: [{ success: false }] } }), config, d);
    expect(post).toEqual({ code: 0, stdout: '{"cancel":false}\n', stderr: '' });
    expect(d.calls.at(-1).msg).toEqual({ tool: 'run_tests', input: {}, call_id: 'c1', ok: false });
    const bad = runAdapter(argv('cline', 'pre'), {}, 'not json', config, d);
    expect(JSON.parse(bad.stdout)).toEqual({ cancel: true, errorMessage: 'Speckl: hook payload is not JSON' });
    const end = runAdapter(argv('cline', 'turn-end'), {}, JSON.stringify({ hookName: 'agent_error' }), config, d);
    expect(end).toEqual({ code: 0, stdout: '', stderr: '' });
    const wrong = runAdapter(argv('cline', 'pre'), {}, JSON.stringify({ hookName: 'tool_result', tool_result: { id: 'x', name: 'editor', input: {} } }), config, d);
    expect(JSON.parse(wrong.stdout).errorMessage).toMatch(/payload is "PostToolUse" but this hook is wired as PreToolUse/);
  });

  it('every new runtime function is emitted', () => {
    expect(ADAPTER_FUNCTIONS).toContain(clineScripts);
  });
});
