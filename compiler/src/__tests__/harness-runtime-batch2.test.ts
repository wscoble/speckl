// Unit tests for the Copilot CLI, Goose and Hermes branches of the harness
// adapter runtime (emitted verbatim into adapter.mjs).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  formatPre, formatPost, postSucceeded, harnessEventName, normalizePayload, normalizeToolInput,
  harnessCallId, harnessConfigFile, harnessProtectedDirs, buildHarnessHooks, mergeHarnessSettings,
  hermesYaml, installHarness, runAdapter, ADAPTER_FUNCTIONS, findProtectedMention,
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
  { tools: ['bash', 'shell', 'terminal'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
  { tools: ['create', 'write', 'write_file'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
];
const config = { harness: { copilot: { rules }, goose: { rules }, hermes: { rules } } };
const argv = (h: string, ev: string, more: string[] = []) => [h, ev, '--state', '.speckl/state.json', '--project', '/p', ...more];

describe('event names and config files', () => {
  it('names every adapter event per harness; unknown events are null', () => {
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('copilot', e))).toEqual(['preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop']);
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('goose', e))).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
    expect(['pre', 'post', 'post-failure', 'turn-end'].map(e => harnessEventName('hermes', e))).toEqual(['pre_tool_call', 'post_tool_call', null, 'on_session_end']);
    expect(harnessEventName('copilot', 'batch')).toBeNull();
    expect(harnessConfigFile('copilot')).toBe('.github/hooks/speckl.json');
    expect(harnessConfigFile('goose')).toBe('.agents/plugins/speckl/hooks/hooks.json');
    expect(harnessConfigFile('hermes')).toBe('config.yaml');
  });
  it('protects the config directories of the declared harnesses only', () => {
    expect(harnessProtectedDirs(['claude-code'])).toEqual(['.claude', '.cursor', '.codex', '.gemini', '.speckl/harness-install']);
    expect(harnessProtectedDirs(['goose', 'copilot', 'goose'])).toEqual(['.claude', '.cursor', '.codex', '.gemini', '.agents/plugins', '.config/goose', '.github/hooks', '.speckl/harness-install']);
    expect(harnessProtectedDirs(['hermes'])).toContain('.hermes');
  });
});

describe('normalizePayload', () => {
  it('Copilot camelCase → snake_case; PascalCase events → camelCase names', () => {
    const p = normalizePayload('copilot', { sessionId: 's', toolName: 'bash', toolArgs: '{"command":"ls"}', cwd: '/p' });
    expect(p).toMatchObject({ tool_name: 'bash', tool_input: '{"command":"ls"}', session_id: 's' });
    expect(p.hook_event_name).toBeUndefined();
    expect(normalizePayload('copilot', { hook_event_name: 'PreToolUse' }).hook_event_name).toBe('preToolUse');
    expect(normalizePayload('copilot', { hook_event_name: 'Stop' }).hook_event_name).toBe('agentStop');
    expect(normalizePayload('copilot', { hook_event_name: 'UserPromptSubmit' }).hook_event_name).toBe('UserPromptSubmit');
    // Existing snake_case fields win.
    expect(normalizePayload('copilot', { tool_name: 'view', toolName: 'bash' }).tool_name).toBe('view');
  });
  it('Goose event/tool_call_id/working_dir; a missing event is a mismatch, not a pass', () => {
    expect(normalizePayload('goose', { event: 'PreToolUse', tool_call_id: 'c1', working_dir: '/w' }))
      .toMatchObject({ hook_event_name: 'PreToolUse', tool_use_id: 'c1', cwd: '/w' });
    expect(normalizePayload('goose', { tool_name: 'shell' }).hook_event_name).toBeNull();
    expect(normalizePayload('goose', { event: 'Stop', cwd: '/x', working_dir: '/w' }).cwd).toBe('/x');
  });
  it('Hermes call id from extra; a bad extra is ignored', () => {
    expect(normalizePayload('hermes', { extra: { tool_call_id: 'call_1' } }).tool_use_id).toBe('call_1');
    expect(normalizePayload('hermes', { extra: [1] }).tool_use_id).toBeUndefined();
    expect(normalizePayload('hermes', {}).tool_use_id).toBeUndefined();
  });
});

describe('call ids', () => {
  it('Copilot derives a stable id from session + tool, preferring tool_use_id', () => {
    const a = harnessCallId('copilot', { session_id: 's', tool_name: 'bash' });
    expect(a).toMatch(/^copilot-[0-9a-f]{8}$/);
    expect(harnessCallId('copilot', { session_id: 's', tool_name: 'bash' })).toBe(a);
    expect(harnessCallId('copilot', { session_id: 't', tool_name: 'bash' })).not.toBe(a);
    expect(harnessCallId('copilot', { tool_use_id: 'tu_1', tool_name: 'bash' })).toBe('tu_1');
    expect(harnessCallId('copilot', { session_id: 's' })).toBeNull();
    expect(harnessCallId('gemini', { session_id: 's', tool_name: 'x' })).toMatch(/^gemini-/);
  });
  it('Goose and Hermes need an explicit id', () => {
    expect(harnessCallId('goose', { tool_use_id: 'c' })).toBe('c');
    expect(harnessCallId('hermes', { tool_use_id: '' })).toBeNull();
  });
});

describe('postSucceeded', () => {
  const cp = (tool: string, tr: unknown) => postSucceeded('copilot', 'post', { tool_name: tool, toolResult: tr });
  it('Copilot: resultType success; shell needs `<exited with exit code 0>` at the end', () => {
    expect(cp('view', { resultType: 'success', textResultForLlm: 'x' })).toBe(true);
    expect(cp('view', { resultType: 'failure', textResultForLlm: 'x' })).toBe(false);
    expect(cp('view', undefined)).toBe(false);
    expect(cp('view', [1])).toBe(false);
    expect(cp('bash', { resultType: 'success', textResultForLlm: 'ok\n<exited with exit code 0>' })).toBe(true);
    expect(cp('powershell', { resultType: 'success', textResultForLlm: 'ok\n<exited with exit code 0>\n' })).toBe(true);
    expect(cp('bash', { resultType: 'success', textResultForLlm: 'ok\n<exited with exit code 1>' })).toBe(false);
    expect(cp('bash', { resultType: 'success', textResultForLlm: '<exited with exit code 0>\nmore' })).toBe(false);
    expect(cp('bash', { resultType: 'success', textResultForLlm: '<command started in background with shellId: 2>' })).toBe(false);
    expect(cp('bash', { resultType: 'success' })).toBe(false);
    expect(postSucceeded('copilot', 'post', { tool_name: 'bash', tool_result: { result_type: 'success', text_result_for_llm: '<exited with exit code 0>' } })).toBe(true);
    expect(postSucceeded('copilot', 'post-failure', { tool_name: 'view', toolResult: { resultType: 'success' } })).toBe(false);
  });
  it('Goose: PostToolUse is a success, PostToolUseFailure is not', () => {
    expect(postSucceeded('goose', 'post', {})).toBe(true);
    expect(postSucceeded('goose', 'post-failure', {})).toBe(false);
  });
  it('Hermes: status ok, and exit_code 0 for terminal', () => {
    const h = (tool: string, extra: unknown) => postSucceeded('hermes', 'post', { tool_name: tool, extra });
    expect(h('terminal', { status: 'ok', result: '{"output":"","exit_code":0,"error":null}' })).toBe(true);
    expect(h('terminal', { status: 'ok', result: '{"output":"","exit_code":null}' })).toBe(false);
    expect(h('terminal', { status: 'ok', result: '{"output":"","exit_code":0,"error":"x"}' })).toBe(false);
    expect(h('terminal', { status: 'error', result: '{"exit_code":1}' })).toBe(false);
    expect(h('terminal', { status: 'ok', result: 'plain text' })).toBe(false);
    expect(h('terminal', { status: 'ok' })).toBe(false);
    expect(h('terminal', { status: 'ok', result: { exit_code: 0 } })).toBe(true);
    expect(h('write_file', { status: 'ok', result: '{"bytes_written":3}' })).toBe(true);
    expect(h('write_file', { status: 'ok', result: '{"success":false}' })).toBe(false);
    expect(h('write_file', { status: 'ok', result: 'not json' })).toBe(true);
    expect(h('write_file', { status: 'blocked', result: '{}' })).toBe(false);
    expect(h('write_file', undefined)).toBe(false);
  });
});

describe('output formats', () => {
  it('Copilot deny carries both decision shapes and exits 2; allow is empty', () => {
    expect(formatPre('copilot', true, '')).toEqual({ code: 0, stdout: '', stderr: '' });
    const d = formatPre('copilot', false, 'no');
    expect(d.code).toBe(2);
    expect(JSON.parse(d.stdout)).toEqual({
      permissionDecision: 'deny', permissionDecisionReason: 'no',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    });
    expect(formatPost('copilot', null)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(JSON.parse(formatPost('copilot', 'p').stdout)).toEqual({ additionalContext: 'p' });
  });
  it('Goose / Hermes deny is exit 2 + {"decision":"block"}; post hooks only log', () => {
    for (const h of ['goose', 'hermes']) {
      expect(formatPre(h, true, '')).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(formatPre(h, false, 'no')).toEqual({ code: 2, stdout: '{"decision":"block","reason":"no"}\n', stderr: 'no\n' });
      expect(formatPost(h, null)).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(formatPost(h, 'p')).toEqual({ code: 0, stdout: '', stderr: 'p\n' });
    }
  });
});

describe('tool input', () => {
  it('Copilot apply_patch exposes the files it touches', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/b.js\n+z\n*** End Patch';
    expect(normalizeToolInput('copilot', 'apply_patch', { input: patch })).toMatchObject({ path: 'src/a.js', files: ['src/a.js', 'src/b.js'] });
    expect(normalizeToolInput('copilot', 'apply_patch', { patch })).toMatchObject({ path: 'src/a.js' });
    expect(normalizeToolInput('copilot', 'apply_patch', {})).toEqual({});
    expect(normalizeToolInput('goose', 'apply_patch', { command: patch })).toEqual({ command: patch });
  });
  it('Copilot/Goose edit content fields are not scanned for protected paths; their path is', () => {
    const prot = [{ abs: '/p/.github/hooks', rel: '.github/hooks' }];
    const r = (p: string, b: string) => path.posix.resolve(b, p);
    expect(findProtectedMention({ path: 'README.md', old_str: '.github/hooks', new_str: '.github/hooks/x', file_text: '.github/hooks' }, prot, '/p', r)).toBeNull();
    expect(findProtectedMention({ path: 'x', before: '.github/hooks', after: '.github/hooks' }, prot, '/p', r)).toBeNull();
    expect(findProtectedMention({ path: '.github/hooks/speckl.json' }, prot, '/p', r)).toBe('.github/hooks');
    expect(findProtectedMention({ command: 'cat ~/.github/hooks/a' }, prot, '/p', r)).toBe('.github/hooks');
  });
});

describe('hook wiring', () => {
  const paths = { adapter: '/p/.speckl/agent/adapter.mjs', state: '/p/.speckl/state.json', key: '/k/state.key', relative: false, project: '/p' };
  it('Copilot: camelCase events, bash commands, timeoutSec above the adapter timeout, blocking pre', () => {
    const h = buildHarnessHooks('copilot', paths) as any;
    expect(h.version).toBe(1);
    expect(h.hooks.preToolUse).toEqual([{ type: 'command', bash: 'node /p/.speckl/agent/adapter.mjs copilot pre --state /p/.speckl/state.json --key /k/state.key --project /p || exit 2', timeoutSec: 30 }]);
    expect(h.hooks.agentStop[0].bash).toMatch(/ copilot turn-end .*--project \/p$/);
  });
  it('Goose: regex matchers, on_failure block on PreToolUse only, no matcher on Stop', () => {
    const h = buildHarnessHooks('goose', paths) as any;
    expect(h.hooks.PreToolUse[0]).toMatchObject({ matcher: '.*', hooks: [{ type: 'command', timeout: 30, on_failure: 'block' }] });
    expect(h.hooks.PreToolUse[0].hooks[0].command).toMatch(/ \|\| exit 2$/);
    expect(h.hooks.PostToolUseFailure[0].hooks[0].on_failure).toBeUndefined();
    expect(h.hooks.Stop[0]).not.toHaveProperty('matcher');
  });
  it('Hermes: fail_closed on pre_tool_call only, exec-form commands, YAML between markers', () => {
    const h = buildHarnessHooks('hermes', { ...paths, hermesHome: '/home/u/.hermes' }) as any;
    expect(h.hooks.pre_tool_call[0]).toMatchObject({ timeout: 30, fail_closed: true });
    expect(h.hooks.pre_tool_call[0].command).toBe('node /p/.speckl/agent/adapter.mjs hermes pre --state /p/.speckl/state.json --key /k/state.key --project /p --hermes-home /home/u/.hermes');
    expect(h.hooks.post_tool_call[0].fail_closed).toBeUndefined();
    const y = hermesYaml(h);
    expect(y.split('\n')[0]).toMatch(/^# >>> speckl hermes hooks/);
    expect(y).toContain('  on_session_end:\n    - command: "node /p/.speckl/agent/adapter.mjs hermes turn-end');
    expect(y.endsWith('# <<< speckl hermes hooks\n')).toBe(true);
    expect(hermesYaml({})).toBe('# >>> speckl hermes hooks (generated by adapter.mjs install hermes; do not edit)\nhooks:\n# <<< speckl hermes hooks\n');
  });
  it('merging replaces earlier Copilot entries (bash field) and keeps foreign ones', () => {
    const ours = buildHarnessHooks('copilot', paths);
    const existing = { version: 1, hooks: { preToolUse: [{ type: 'command', bash: './audit.sh' }, { type: 'command', bash: 'node /old/adapter.mjs copilot pre --state s || exit 2' }] } };
    const m = mergeHarnessSettings('copilot', existing, ours) as any;
    expect(m.hooks.preToolUse.map((e: any) => e.bash)).toEqual(['./audit.sh', (ours as any).hooks.preToolUse[0].bash]);
    expect(mergeHarnessSettings('copilot', {}, ours).version).toBe(1);
  });
});

describe('install', () => {
  it('Copilot and Goose write absolute paths with --project; Goose adds plugin.json', () => {
    const d = fakeDeps({ '/k/state.key': 'cd'.repeat(32) + '\n' });
    const r = installHarness('copilot', { project: '.', state: '.speckl/state.json', key: '/k/state.key' }, d);
    expect(r.code).toBe(0);
    expect(JSON.parse(d.files['/p/.github/hooks/speckl.json']).hooks.preToolUse[0].bash).toContain('--project /p || exit 2');
    const g = installHarness('goose', { project: '.', state: '.speckl/state.json' }, d);
    expect(g.code).toBe(0);
    expect(g.stderr).toContain('no --key');
    expect(JSON.parse(d.files['/p/.agents/plugins/speckl/plugin.json']).name).toBe('speckl');
    expect(JSON.parse(d.files['/p/.agents/plugins/speckl/hooks/hooks.json']).hooks.PreToolUse[0].hooks[0].command).toContain('/p/.speckl/agent/adapter.mjs goose pre');
  });
  it('Hermes needs --hermes-home and refuses broken allowlists or a foreign hooks block', () => {
    expect(installHarness('hermes', { project: '.', state: 's' }, fakeDeps()).stderr).toContain('--hermes-home');
    const bad = fakeDeps({ '/h/shell-hooks-allowlist.json': '{nope' });
    expect(installHarness('hermes', { project: '.', state: 's', 'hermes-home': '/h' }, bad)).toMatchObject({ code: 1 });
    expect(bad.files['/h/config.yaml']).toBeUndefined();
    const noList = fakeDeps({ '/h/shell-hooks-allowlist.json': '{"approvals":{}}' });
    expect(installHarness('hermes', { project: '.', state: 's', 'hermes-home': '/h' }, noList).stderr).toContain('no approvals list');
    const foreign = fakeDeps({ '/h/config.yaml': 'model: x\nhooks:\n  on_session_start: []\n' });
    const f = installHarness('hermes', { project: '.', state: 's', 'hermes-home': '/h' }, foreign);
    expect(f.code).toBe(1);
    expect(foreign.files['/h/config.yaml']).toBe('model: x\nhooks:\n  on_session_start: []\n');
  });
  it('Hermes appends to an existing config, keeps foreign approvals, replaces its own', () => {
    const d = fakeDeps({
      '/k': 'cd'.repeat(32) + '\n',
      '/h/config.yaml': 'model: x',
      '/h/shell-hooks-allowlist.json': JSON.stringify({ approvals: [{ event: 'on_session_start', command: '~/hello.sh' }, { event: 'pre_tool_call', command: 'node /old/adapter.mjs hermes pre --state s' }] }),
    });
    const r = installHarness('hermes', { project: '.', state: 's', key: '/k', 'hermes-home': '/h' }, d);
    expect(r.code, r.stderr).toBe(0);
    expect(d.files['/h/config.yaml']).toMatch(/^model: x\n# >>> speckl hermes hooks/);
    const approvals = JSON.parse(d.files['/h/shell-hooks-allowlist.json']).approvals;
    expect(approvals).toHaveLength(4);
    expect(approvals[0]).toEqual({ event: 'on_session_start', command: '~/hello.sh' });
    expect(approvals[1]).toMatchObject({ event: 'pre_tool_call', approved_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), script_mtime_at_approval: null });
    // Reinstall: the marker block is replaced even at the very end of the file.
    d.files['/h/config.yaml'] = d.files['/h/config.yaml'].trimEnd();
    expect(installHarness('hermes', { project: '.', state: 's', key: '/k', 'hermes-home': '/h' }, d).code).toBe(0);
    expect(d.files['/h/config.yaml'].match(/>>> speckl/g)).toHaveLength(1);
    expect(JSON.parse(d.files['/h/shell-hooks-allowlist.json']).approvals).toHaveLength(4);
  });
});

describe('Goose user-scope plugin (--plugins-dir)', () => {
  it('installs speckl-<hash of project> with --outside allow', () => {
    const d = fakeDeps({ '/k': 'cd'.repeat(32) + '\n' });
    const r = installHarness('goose', { project: '.', state: '.speckl/state.json', key: '/k', 'plugins-dir': '/home/u/.agents/plugins' }, d);
    expect(r.code).toBe(0);
    const dir = Object.keys(d.files).find(f => f.endsWith('/plugin.json'))!;
    expect(dir).toMatch(/^\/home\/u\/\.agents\/plugins\/speckl-[0-9a-f]{8}\/plugin\.json$/);
    expect(JSON.parse(d.files[dir]).name).toBe(dir.split('/')[5]);
    const hooks = JSON.parse(d.files[dir.replace('plugin.json', 'hooks/hooks.json')]);
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toMatch(/--project \/p --outside allow \|\| exit 2$/);
    expect(Object.keys(d.files).some(f => f.startsWith('/p/.agents'))).toBe(false);
  });
  it('outside the project: allow without hook.mjs, but never the rails; inside: judged as usual', () => {
    const a = (cwd: string, input: unknown, ev = 'pre') => {
      const d = fakeDeps();
      const out = runAdapter(argv('goose', ev, ['--outside', 'allow']), {},
        JSON.stringify({ event: ev === 'pre' ? 'PreToolUse' : 'PostToolUse', tool_name: 'shell', tool_input: input, tool_call_id: 'g1', working_dir: cwd }), config, d);
      return { out, calls: d.calls.length };
    };
    expect(a('/elsewhere', { command: 'rm -rf build' })).toEqual({ out: { code: 0, stdout: '', stderr: '' }, calls: 0 });
    expect(a('/elsewhere', { command: 'rm -rf build' }, 'post')).toEqual({ out: { code: 0, stdout: '', stderr: '' }, calls: 0 });
    expect(a('/elsewhere', { command: 'cat /p/.speckl/state.json' }).out.code).toBe(2);
    expect(a('/elsewhere', { command: 'cat ~/.agents/plugins/speckl-1/hooks/hooks.json' }).out.stderr).toContain('.agents/plugins');
    expect(a('/elsewhere', 'not json').out.code).toBe(2);
    expect(a('/p/src', { command: 'rm -rf build' }).out.code).toBe(2);
    expect(a('/p/src', { command: 'npm test' })).toMatchObject({ out: { code: 0 }, calls: 1 });
    expect(a('/p', { command: 'npm test' }).calls).toBe(1);
  });
});

describe('runAdapter (Copilot, Goose, Hermes)', () => {
  it('Copilot camelCase pre with toolArgs as a JSON string reaches hook.mjs with a derived id', () => {
    const d = fakeDeps();
    const r = runAdapter(argv('copilot', 'pre'), {}, JSON.stringify({ sessionId: 's', timestamp: 1, cwd: '/p', toolName: 'bash', toolArgs: '{"command":"npm test"}' }), config, d);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls[0].msg).toMatchObject({ tool: 'run_tests', call_id: expect.stringMatching(/^copilot-/) });
    expect(d.calls[0].statePath).toBe('/p/.speckl/state.json');
  });
  it('Copilot deny output for an unmapped tool and for a PascalCase payload sent to the wrong hook', () => {
    const r = runAdapter(argv('copilot', 'pre'), {}, JSON.stringify({ sessionId: 's', toolName: 'web_fetch', toolArgs: {} }), config, fakeDeps());
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).permissionDecision).toBe('deny');
    const w = runAdapter(argv('copilot', 'pre'), {}, JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'bash' }), config, fakeDeps());
    expect(w.stderr).toContain('payload is "postToolUse" but this hook is wired as preToolUse');
  });
  it('Goose pre: tool_call_id is the call id; a missing one is denied', () => {
    const d = fakeDeps();
    const ok = runAdapter(argv('goose', 'pre'), {}, JSON.stringify({ event: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'npm test' }, tool_call_id: 'g1', working_dir: '/p' }), config, d);
    expect(ok.code).toBe(0);
    expect(d.calls[0].msg.call_id).toBe('g1');
    const no = runAdapter(argv('goose', 'pre'), {}, JSON.stringify({ event: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'npm test' } }), config, fakeDeps());
    expect(no).toMatchObject({ code: 2 });
    expect(JSON.parse(no.stdout).decision).toBe('block');
  });
  it('Hermes protects the profile directory named by --hermes-home', () => {
    const r = runAdapter(argv('hermes', 'pre', ['--hermes-home', '/srv/hermes']), {},
      JSON.stringify({ hook_event_name: 'pre_tool_call', tool_name: 'write_file', tool_input: { path: '/srv/hermes/config.yaml' }, extra: { tool_call_id: 'h1' } }), config, fakeDeps());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Speckl-protected path (/srv/hermes)');
  });
  it('Hermes blocked post: no-op unless it is our pending call; a hook error is reported', () => {
    const blocked = (id: string) => JSON.stringify({ hook_event_name: 'post_tool_call', tool_name: 'terminal', tool_input: { command: 'npm test' }, extra: { tool_call_id: id, status: 'blocked' } });
    const none = fakeDeps();
    expect(runAdapter(argv('hermes', 'post'), {}, blocked('h1'), config, none)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(none.calls).toHaveLength(0);
    const state = { '/p/.speckl/state.json': JSON.stringify({ pending: { tool: 'run_tests', input: {}, call_id: 'h1' } }) };
    const other = fakeDeps({ ...state });
    expect(runAdapter(argv('hermes', 'post'), {}, blocked('h2'), config, other).stderr).toBe('');
    expect(other.calls).toHaveLength(0);
    const ours = fakeDeps({ ...state });
    expect(runAdapter(argv('hermes', 'post'), {}, blocked('h1'), config, ours)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(ours.calls[0].msg).toEqual({ tool: 'run_tests', input: {}, call_id: 'h1', ok: false });
    const err = fakeDeps({ ...state }, () => ({ status: 1, stdout: '', stderr: 'state MAC mismatch' }));
    expect(runAdapter(argv('hermes', 'post'), {}, blocked('h1'), config, err).stderr).toMatch(/could not record blocked call h1: .*state MAC mismatch/);
    const broken = fakeDeps({ '/p/.speckl/state.json': '{' });
    expect(runAdapter(argv('hermes', 'post'), {}, blocked('h1'), config, broken).code).toBe(0);
  });
  it('Hermes has no post-failure event; asking for one is denied', () => {
    const r = runAdapter(argv('hermes', 'post-failure'), {}, '{}', config, fakeDeps());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown event "post-failure" for hermes');
  });
  it('every new function is emitted into adapter.mjs', () => {
    const names = ADAPTER_FUNCTIONS.map(f => f.name);
    for (const n of ['normalizePayload', 'harnessProtectedDirs', 'hermesYaml', 'installHermes']) expect(names).toContain(n);
  });
});
