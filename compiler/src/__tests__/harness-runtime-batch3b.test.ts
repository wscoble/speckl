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
    expect(harnessProtectedDirs(['cline']).slice(4)).toEqual(['.clinerules/hooks', '.cline', '.speckl/harness-install']);
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

describe('kiro', () => {
  const krules: HarnessRule[] = [
    { tools: ['execute_bash'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
    { tools: ['fs_write'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
  ];
  const kconfig = { harness: { kiro: { rules: krules } } };
  it('events, config file, protected paths, legacy camelCase names', () => {
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('kiro', e))).toEqual(['PreToolUse', 'PostToolUse', null, 'Stop']);
    expect(harnessConfigFile('kiro')).toBe('.kiro/hooks/speckl.json');
    expect(harnessProtectedDirs(['kiro']).slice(4)).toEqual(['.kiro/hooks', '.kiro/agents', '.kiro/settings', '.speckl/harness-install']);
    for (const [a, b] of [['preToolUse', 'PreToolUse'], ['postToolUse', 'PostToolUse'], ['stop', 'Stop'], ['PreToolUse', 'PreToolUse'], ['agentSpawn', 'agentSpawn']]) {
      expect(normalizePayload('kiro', { hook_event_name: a }).hook_event_name).toBe(b);
    }
    const id = harnessCallId('kiro', { session_id: 's', tool_name: 'fs_write' });
    expect(id).toMatch(/^kiro-[0-9a-f]{8}$/);
    expect(harnessCallId('kiro', { session_id: 's', tool_name: 'fs_write', tool_use_id: 'x' })).toBe(id);
  });
  it('postSucceeded: shell needs a final Exit Code 0; prose errors and objects with errors fail', () => {
    const ok = (tool: string, r: unknown) => postSucceeded('kiro', 'post', { tool_name: tool, tool_response: r });
    expect(ok('execute_bash', 'Output:\nPASS\n\nExit Code: 0')).toBe(true);
    expect(ok('execute_bash', 'Output:\nExit Code: 0 printed by the test\n\nExit Code: 1')).toBe(false);
    expect(ok('execute_pwsh', 'Output:\nok')).toBe(false);
    expect(ok('shell', { exit_status: 0 })).toBe(true);
    expect(ok('shell', { exit_status: '0' })).toBe(true);
    expect(ok('execute_cmd', { exit_code: 2 })).toBe(false);
    expect(ok('execute_bash', { exitCode: 0, error: 'x' })).toBe(false);
    expect(ok('execute_bash', {})).toBe(false);
    expect(ok('fs_write', 'Created the file.')).toBe(true);
    expect(ok('str_replace', 'Replaced text in src/a.js')).toBe(true);
    expect(ok('str_replace', 'Error: oldStr not found')).toBe(false);
    expect(ok('fs_write', 'Failed to write')).toBe(false);
    expect(ok('fs_write', '  ')).toBe(false);
    expect(ok('fs_write', { success: false })).toBe(false);
    expect(ok('fs_write', { isError: true })).toBe(false);
    expect(ok('fs_write', { content: 'x' })).toBe(true);
    expect(ok('fs_write', [])).toBe(false);
    expect(ok('fs_write', undefined)).toBe(false);
  });
  it('formatPre blocks with exit 2 and stderr only; a post problem is a warning (exit 1)', () => {
    expect(formatPre('kiro', true, '')).toEqual({ code: 0, stdout: '{"decision":"allow"}\n', stderr: '' });
    expect(formatPre('kiro', false, 'no')).toEqual({ code: 2, stdout: '', stderr: 'no\n' });
    expect(formatPost('kiro', null)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(formatPost('kiro', 'p')).toEqual({ code: 1, stdout: '', stderr: 'p\n' });
  });
  it('install writes a v1 hook file with a blocking pre, keeps other hooks and replaces its own', () => {
    const other = { name: 'lint', trigger: 'PostFileSave', action: { type: 'command', command: 'npm run lint' } };
    const d = fakeDeps({ '/p/.kiro/hooks/speckl.json': JSON.stringify({ version: 'v1', hooks: [other] }) });
    expect(installHarness('kiro', { project: '.', state: '.speckl/state.json', key: '/k' }, d).code).toBe(0);
    expect(installHarness('kiro', { project: '.', state: '.speckl/state.json', key: '/k' }, d).code).toBe(0);
    const doc = JSON.parse(d.files['/p/.kiro/hooks/speckl.json']);
    expect(doc.version).toBe('v1');
    expect(doc.hooks.map((h: any) => h.name)).toEqual(['lint', 'speckl-pre', 'speckl-post', 'speckl-stop']);
    expect(doc.hooks[1]).toMatchObject({ trigger: 'PreToolUse', timeout: 30, enabled: true, action: { type: 'command', command: '[ "$(node /p/.speckl/agent/adapter.mjs kiro pre --state /p/.speckl/state.json --key /k --project /p)" = \'{"decision":"allow"}\' ] || exit 2' } });
    expect(doc.hooks[1].matcher).toBeUndefined();
    expect(doc.hooks[2].action.command).not.toContain('|| exit 2');
    expect(doc.hooks[3]).toMatchObject({ trigger: 'Stop' });
    expect(doc.hooks[3].action.command).not.toContain('|| exit 2');
    const odd = fakeDeps({ '/p/.kiro/hooks/speckl.json': '{"hooks":{}}' });
    expect(installHarness('kiro', { project: '.', state: '.speckl/state.json' }, odd).code).toBe(0);
    expect(JSON.parse(odd.files['/p/.kiro/hooks/speckl.json']).hooks).toHaveLength(3);
  });
  it('runAdapter: a post with an empty tool_input is recorded against the pending call', () => {
    const pendingState = (call_id: string) => JSON.stringify({ pending: { call_id, tool: 'run_tests', input: {} } });
    const id = harnessCallId('kiro', { session_id: 's', tool_name: 'execute_bash' }) as string;
    const d = fakeDeps({ '/p/.speckl/state.json': pendingState(id) });
    const post = (resp: unknown, extra: Record<string, unknown> = {}) => runAdapter(argv('kiro', 'post'), {}, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'execute_bash', tool_input: {}, tool_response: resp, ...extra }), kconfig, d);
    expect(post('Output:\nPASS\n\nExit Code: 0')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls.at(-1).msg).toEqual({ tool: 'run_tests', input: {}, call_id: id, ok: true });
    post('Output:\nFAIL\n\nExit Code: 1');
    expect(d.calls.at(-1).msg.ok).toBe(false);
    // Not the pending call: falls through to mapping, which an empty input cannot satisfy.
    const other = post('x', { session_id: 'other' });
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/ran without a Speckl mapping/);
    const d2 = fakeDeps({ '/p/.speckl/state.json': pendingState(id) }, () => ({ status: 1, stdout: '', stderr: 'broken state' }));
    const bad = runAdapter(argv('kiro', 'post'), {}, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'execute_bash', tool_input: {} }), kconfig, d2);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Speckl could not record execute_bash \(spec tool run_tests\)/);
    const d3 = fakeDeps({ '/p/.speckl/state.json': '{not json' });
    expect(runAdapter(argv('kiro', 'post'), {}, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'execute_bash', tool_input: {} }), kconfig, d3).code).toBe(1);
  });
  it('runAdapter: a shell cwd outside the project root is denied; malformed input denies; Stop is silent', () => {
    const d = fakeDeps();
    const pre = (inp: unknown) => runAdapter(argv('kiro', 'pre'), {}, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'execute_bash', tool_input: inp }), kconfig, d);
    expect(pre({ command: 'npm test', cwd: '/p' }).code).toBe(0);
    expect(pre({ command: 'npm test', cwd: '.' }).code).toBe(0);
    const out = pre({ command: 'npm test', cwd: '/tmp' });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/sets cwd "\/tmp"; Speckl only accepts commands run in the project root/);
    expect(pre({ command: 'npm test', cwd: 7 }).code).toBe(2);
    expect(pre('nope').code).toBe(2);
    expect(runAdapter(argv('kiro', 'pre'), {}, '', kconfig, d)).toMatchObject({ code: 2, stdout: '' });
    expect(runAdapter(argv('kiro', 'turn-end'), {}, JSON.stringify({ hook_event_name: 'Stop' }), kconfig, d)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(runAdapter(argv('kiro', 'turn-end'), {}, 'garbage', kconfig, d)).toMatchObject({ code: 0, stdout: '' });
  });
});

describe('windsurf', () => {
  const wrules: HarnessRule[] = [
    { tools: ['run_command'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
    { tools: ['write_code'], target: 'edit_code', inputs: [{ param: 'path', field: 'file_path' }] },
  ];
  const wconfig = { harness: { windsurf: { rules: wrules } } };
  it('events, config files, protected paths', () => {
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('windsurf', e))).toEqual(['pre_tool', 'post_tool', null, 'pre_user_prompt']);
    expect(harnessConfigFile('windsurf')).toBe('.devin/hooks.json');
    expect(harnessProtectedDirs(['windsurf']).slice(4)).toEqual(['.devin', '.windsurf', '.speckl/harness-install']);
  });
  it('normalizes every tool event to a synthetic tool name and input', () => {
    const n = (ev: string, info: unknown) => normalizePayload('windsurf', { agent_action_name: ev, trajectory_id: 't', tool_info: info });
    expect(n('pre_read_code', { file_path: '/p/a' })).toMatchObject({ hook_event_name: 'pre_tool', tool_name: 'read_code', tool_input: { file_path: '/p/a' }, session_id: 't' });
    expect(n('post_write_code', { file_path: '/p/a', edits: [] })).toMatchObject({ hook_event_name: 'post_tool', tool_name: 'write_code' });
    expect(n('pre_run_command', { command_line: 'npm test', cwd: '/p', command: 'spoof' }).tool_input).toEqual({ command_line: 'npm test', cwd: '/p', command: 'npm test' });
    expect(n('pre_run_command', { cwd: '/p', command: 'spoof' }).tool_input).toEqual({ cwd: '/p' });
    expect(n('pre_mcp_tool_use', { mcp_server_name: 'ci', mcp_tool_name: 'run_tests', mcp_tool_arguments: { a: 1 } })).toMatchObject({ tool_name: 'mcp__ci__run_tests', tool_input: { a: 1 } });
    expect(n('post_mcp_tool_use', { mcp_server_name: 'ci', mcp_tool_name: 'x' }).tool_input).toEqual({});
    expect(n('pre_mcp_tool_use', { mcp_tool_name: 'x' }).tool_name).toBeNull();
    expect(n('pre_user_prompt', { user_prompt: 'hi' })).toMatchObject({ hook_event_name: 'pre_user_prompt' });
    expect(n('pre_user_prompt', {}).tool_name).toBeUndefined();
    expect(normalizePayload('windsurf', {}).hook_event_name).toBeNull();
    expect(harnessCallId('windsurf', n('pre_read_code', {}))).toBe(harnessCallId('windsurf', n('post_read_code', {})));
  });
  it('postSucceeded: reads, writes and MCP calls count; a terminal command never does', () => {
    for (const t of ['read_code', 'write_code', 'mcp__ci__run_tests']) expect(postSucceeded('windsurf', 'post', { tool_name: t })).toBe(true);
    expect(postSucceeded('windsurf', 'post', { tool_name: 'run_command' })).toBe(false);
    expect(postSucceeded('windsurf', 'post', { tool_name: null })).toBe(false);
    expect(postSucceeded('windsurf', 'post', {})).toBe(false);
  });
  it('builds pre hooks that need an explicit allow and block on Windows; turn-end never blocks', () => {
    const h = buildHarnessHooks('windsurf', { adapter: '/a.mjs', state: '/s', key: null, relative: false, project: '/p' }) as any;
    expect(Object.keys(h.hooks)).toEqual(['pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use', 'post_read_code', 'post_write_code', 'post_run_command', 'post_mcp_tool_use', 'pre_user_prompt']);
    expect(h.hooks.pre_run_command[0]).toEqual({
      command: '[ "$(node /a.mjs windsurf pre --state /s --project /p)" = \'{"decision":"allow"}\' ] || exit 2',
      powershell: "[Console]::Error.WriteLine('Speckl: the generated Cascade hooks support macOS and Linux only; blocking.'); exit 2",
      show_output: false,
    });
    expect(h.hooks.post_run_command[0]).toEqual({ command: 'node /a.mjs windsurf post --state /s --project /p', show_output: false });
    expect(h.hooks.pre_user_prompt[0].command).toBe('node /a.mjs windsurf turn-end --state /s --project /p || true');
  });
  it('install merges into .devin/hooks.json and .windsurf/hooks.json, keeping other hooks', () => {
    const mine = { command: 'python3 log.py', show_output: true };
    const d = fakeDeps({ '/p/.devin/hooks.json': JSON.stringify({ hooks: { pre_run_command: [mine] } }) });
    const r = installHarness('windsurf', { project: '.', state: '.speckl/state.json', key: '/k' }, d);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('/p/.devin/hooks.json and /p/.windsurf/hooks.json');
    expect(r.stdout).toContain('Restricted Mode');
    expect(installHarness('windsurf', { project: '.', state: '.speckl/state.json', key: '/k' }, d).code).toBe(0);
    const devin = JSON.parse(d.files['/p/.devin/hooks.json']);
    expect(devin.hooks.pre_run_command).toHaveLength(2);
    expect(devin.hooks.pre_run_command[0]).toEqual(mine);
    expect(JSON.parse(d.files['/p/.windsurf/hooks.json']).hooks.pre_write_code).toHaveLength(1);
    for (const bad of ['{nope', '[]']) {
      const d2 = fakeDeps({ '/p/.windsurf/hooks.json': bad });
      const r2 = installHarness('windsurf', { project: '.', state: '.speckl/state.json' }, d2);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toMatch(/\.windsurf\/hooks\.json is not (valid JSON|a JSON object)/);
      expect(d2.files['/p/.devin/hooks.json']).toBeUndefined();
    }
  });
  it('runAdapter: a terminal command is recorded as not successful with a note; cwd elsewhere is denied', () => {
    const d = fakeDeps();
    const send = (ev: string, info: unknown, adapterEv = ev.startsWith('pre') ? 'pre' : 'post') => runAdapter(argv('windsurf', adapterEv), {}, JSON.stringify({ agent_action_name: ev, trajectory_id: 't', tool_info: info }), wconfig, d);
    expect(send('pre_run_command', { command_line: 'npm test', cwd: '/p' })).toEqual({ code: 0, stdout: '{"decision":"allow"}\n', stderr: '' });
    const post = send('post_run_command', { command_line: 'npm test', cwd: '/p' });
    expect(post.code).toBe(2);
    expect(post.stderr).toMatch(/Cascade does not report a command's exit status/);
    expect(d.calls.at(-1).msg.ok).toBe(false);
    expect(send('post_write_code', { file_path: '/p/a' })).toEqual({ code: 0, stdout: '', stderr: '' });
    const out = send('pre_run_command', { command_line: 'npm test', cwd: '/elsewhere' });
    expect(out).toMatchObject({ code: 2, stdout: '' });
    expect(out.stderr).toMatch(/sets cwd "\/elsewhere"/);
    expect(send('pre_user_prompt', {}, 'pre').code).toBe(2);
    expect(send('pre_user_prompt', {}, 'turn-end')).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
