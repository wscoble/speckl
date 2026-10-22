// Unit tests for the harness adapter runtime (emitted verbatim into adapter.mjs).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  hasShellControl, parseToolInput, mapHarnessCall, findProtectedMention, interpretHook,
  formatPre, formatPost, postSucceeded, harnessEventName, parseAdapterFlags, shellQuote,
  buildHarnessHooks, mergeHarnessSettings, installHarness, runAdapter, ADAPTER_FUNCTIONS,
  normalizeToolInput, harnessCallId, harnessConfigFile,
  HarnessRule, AdapterDeps, HookResult,
} from '../generators/agent/harness-runtime.js';

const rules: HarnessRule[] = [
  { tools: ['Edit', 'Write'], target: 'edit_code', inputs: [{ param: 'path', field: 'file_path' }] },
  { tools: ['Bash'], field: 'command', pattern: 'npm (run )?test', target: 'run_tests', inputs: [] },
  { tools: ['Bash'], field: 'command', pattern: 'git push origin [a-z/]+', target: 'open_pr', inputs: [] },
  { tools: ['Read'], target: 'read_file', inputs: [{ param: 'path', field: 'path' }] },
];

describe('hasShellControl', () => {
  it('flags chaining, substitution, redirects and newlines', () => {
    for (const s of ['a;b', 'a && b', 'a | b', 'a `b`', 'echo $(x)', 'a > f', 'a < f', 'a\nb', 'a\rb']) {
      expect(hasShellControl(s), s).toBe(true);
    }
    expect(hasShellControl('npm test -- --grep=x')).toBe(false);
  });
});

describe('parseToolInput', () => {
  it('accepts objects, JSON strings, missing input; refuses the rest', () => {
    expect(parseToolInput({ a: 1 })).toEqual({ ok: true, input: { a: 1 } });
    expect(parseToolInput('{"a":1}')).toEqual({ ok: true, input: { a: 1 } });
    expect(parseToolInput(undefined)).toEqual({ ok: true, input: {} });
    expect(parseToolInput(null)).toEqual({ ok: true, input: {} });
    expect(parseToolInput('nope').ok).toBe(false);
    expect(parseToolInput('[1]').ok).toBe(false);
    expect(parseToolInput(5).ok).toBe(false);
  });
});

describe('mapHarnessCall', () => {
  it('maps by tool name and renames inputs', () => {
    expect(mapHarnessCall(rules, 'Write', { file_path: '/p/a.js', content: 'x' }))
      .toEqual({ ok: true, tool: 'edit_code', input: { path: '/p/a.js' }, rule: 0 });
  });
  it('matches patterns against the whole value, first match wins', () => {
    expect(mapHarnessCall(rules, 'Bash', { command: 'npm run test' })).toMatchObject({ ok: true, tool: 'run_tests', rule: 1 });
    expect(mapHarnessCall(rules, 'Bash', { command: 'git push origin feature/x' })).toMatchObject({ ok: true, tool: 'open_pr' });
    expect(mapHarnessCall(rules, 'Bash', { command: 'xnpm test' }).ok).toBe(false);
    expect(mapHarnessCall(rules, 'Bash', { command: 'npm testx' }).ok).toBe(false);
  });
  it('denies unmapped tools and non-string fields (fail closed)', () => {
    const r = mapHarnessCall(rules, 'WebFetch', {});
    expect(r).toMatchObject({ ok: false });
    expect((r as any).reason).toContain('unmapped harness tool "WebFetch"');
    expect(mapHarnessCall(rules, 'Bash', { command: 42 }).ok).toBe(false);
    expect(mapHarnessCall(rules, '', {}).ok).toBe(false);
    expect(mapHarnessCall(rules, undefined, {}).ok).toBe(false);
  });
  it('refuses a match that chains a second command', () => {
    const wide: HarnessRule[] = [{ tools: ['Bash'], field: 'command', pattern: 'npm test.*', target: 'run_tests', inputs: [] }];
    const r = mapHarnessCall(wide, 'Bash', { command: 'npm test; git push origin main' });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain('shell control characters');
  });
  it('explains a chained command that matches nothing', () => {
    const r = mapHarnessCall(rules, 'Bash', { command: 'npm test && git push origin main' });
    expect((r as any).reason).toContain('matches no map line');
  });
  it('denies when a required input field is missing', () => {
    const r = mapHarnessCall(rules, 'Read', { file_path: 'x' });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain('read_file needs path but tool_input has no path');
  });
  it('reports an invalid pattern instead of throwing', () => {
    const bad: HarnessRule[] = [{ tools: ['Bash'], field: 'command', pattern: '(', target: 't', inputs: [] }];
    expect((mapHarnessCall(bad, 'Bash', { command: 'x' }) as any).reason).toContain('invalid pattern');
  });
});

describe('findProtectedMention', () => {
  const prot = [
    { abs: '/p/.speckl/agent', rel: '.speckl/agent' },
    { abs: '/p/.speckl/state.json', rel: '.speckl/state.json' },
    { abs: '/home/u/.config/speckl/k.key', rel: '' },
    { abs: '/p/.claude', rel: '.claude' },
  ];
  const f = (input: unknown, cwd = '/p') => findProtectedMention(input, prot, cwd, path.posix.resolve);
  it('finds absolute, relative and resolved mentions', () => {
    expect(f({ file_path: '/p/.speckl/state.json' })).toBe('/p/.speckl/state.json');
    expect(f({ command: 'cat .claude/settings.json' })).toBe('.claude');
    expect(f({ command: 'cat /home/u/.config/speckl/k.key' })).toBe('/home/u/.config/speckl/k.key');
    expect(f({ file_path: '../.speckl/state.json' }, '/p/src')).not.toBeNull();
    expect(f({ file_path: '../../p/.speckl/state.json' }, '/p/src')).toBe('/p/.speckl/state.json');
    expect(f({ nested: [{ x: 'see /p/.speckl/agent/hook.mjs' }] })).toBe('/p/.speckl/agent');
    expect(f({ file_path: 'C:\\p\\.claude\\settings.json'.replace(/C:/, '') })).toBe('/p/.claude');
  });
  it('ignores free-text content fields and unrelated paths', () => {
    expect(f({ file_path: '/p/README.md', content: 'edit .claude/settings.json to install' })).toBeNull();
    expect(f({ command: 'npm test' })).toBeNull();
    expect(f(42)).toBeNull();
  });
  it('fails closed on absurdly deep input', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 30; i++) deep = [deep];
    expect(f(deep)).toContain('nested too deeply');
  });
});

describe('interpretHook', () => {
  it('allows only exit 0', () => {
    expect(interpretHook({ status: 0, stdout: '{"decision":"allow"}\n', stderr: '' })).toEqual({ allow: true, reason: '' });
    expect(interpretHook({ status: 2, stdout: '{"decision":"deny","reason":"nope"}\n', stderr: 'nope' })).toEqual({ allow: false, reason: 'nope' });
    expect(interpretHook({ status: 2, stdout: '', stderr: '' })).toEqual({ allow: false, reason: 'denied' });
  });
  it('turns errors and crashes into denies', () => {
    expect(interpretHook({ status: 1, stdout: '{"decision":"deny","reason":"boom"}', stderr: '' }).reason).toBe('speckl hook error (exit 1): boom');
    expect(interpretHook({ status: null, stdout: '', stderr: 'killed\nmore' }).reason).toBe('speckl hook error (exit null): killed');
    expect(interpretHook({ status: null, stdout: '', stderr: 'hook.mjs killed by SIGKILL\n' }).reason).toBe('speckl hook error (exit null): hook.mjs killed by SIGKILL');
    expect(interpretHook({ status: 1, stdout: '', stderr: 'Error: spawn /secret/state.key\n    at hook.mjs:1' }).reason).toBe('speckl hook error (exit 1): hook.mjs failed');
    expect(interpretHook({ status: 1, stdout: '', stderr: '/tmp/hook.mjs:1\nError: boom' }).reason).toBe('speckl hook error (exit 1): hook.mjs failed');
    expect(interpretHook({ status: 1, stdout: '', stderr: 'C:\\secret\\state.key\n' }).reason).toBe('speckl hook error (exit 1): hook.mjs failed');
    expect(interpretHook({ status: 1, stdout: '', stderr: '    at /secret/hook.mjs:1:1\n' }).reason).toBe('speckl hook error (exit 1): hook.mjs failed');
    expect(interpretHook({ status: 1, stdout: '', stderr: 'at noon\n' }).reason).toBe('speckl hook error (exit 1): at noon');
    expect(interpretHook({ status: 1, stdout: '', stderr: 'Speckl denied (internal error (fail closed)): hook failed closed\n' }).reason)
      .toBe('speckl hook error (exit 1): Speckl denied (internal error (fail closed)): hook failed closed');
    expect(interpretHook({ status: 7, stdout: 'not json', stderr: '' }).reason).toBe('speckl hook error (exit 7): no output');
  });
  it('exit 0 without a well-formed allow decision denies (malformed output)', () => {
    for (const stdout of ['', 'garbage', '{"decision":"deny"}', '{"decision":"allow"']) {
      expect(interpretHook({ status: 0, stdout, stderr: '' }).allow, stdout).toBe(false);
    }
  });
});

describe('harness formats', () => {
  it('Claude Code: silent allow, exit 2 + stderr deny', () => {
    expect(formatPre('claude-code', true, '')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(formatPre('claude-code', false, 'no')).toEqual({ code: 2, stdout: '', stderr: 'no\n' });
    expect(formatPost('claude-code', null)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(formatPost('claude-code', 'bad')).toEqual({ code: 2, stdout: '', stderr: 'bad\n' });
  });
  it('Cursor: permission JSON', () => {
    expect(JSON.parse(formatPre('cursor', true, '').stdout)).toEqual({ permission: 'allow' });
    const d = formatPre('cursor', false, 'no');
    expect(d.code).toBe(2);
    expect(JSON.parse(d.stdout)).toEqual({ permission: 'deny', user_message: 'no', agent_message: 'no' });
    expect(formatPost('cursor', null).stdout).toBe('{}\n');
    expect(JSON.parse(formatPost('cursor', 'bad').stdout)).toEqual({ additional_context: 'bad' });
  });
  it('event names', () => {
    expect(harnessEventName('claude-code', 'batch')).toBe('PostToolBatch');
    expect(harnessEventName('cursor', 'post-failure')).toBe('postToolUseFailure');
    expect(harnessEventName('cursor', 'batch')).toBeNull();
    expect(harnessEventName('nope', 'pre')).toBeNull();
  });
});

describe('postSucceeded', () => {
  it('only an explicit success counts', () => {
    expect(postSucceeded('claude-code', 'post-failure', {})).toBe(false);
    expect(postSucceeded('claude-code', 'post', { tool_response: { stdout: 'ok', interrupted: false } })).toBe(true);
    expect(postSucceeded('claude-code', 'post', { tool_response: { interrupted: true } })).toBe(false);
    expect(postSucceeded('claude-code', 'post', { tool_response: { isError: true } })).toBe(false);
    expect(postSucceeded('claude-code', 'post', { tool_response: 'plain text' })).toBe(true);
    expect(postSucceeded('cursor', 'post', { tool_output: '{"exitCode":0}' })).toBe(true);
    expect(postSucceeded('cursor', 'post', { tool_output: '{"exitCode":1}' })).toBe(false);
    expect(postSucceeded('cursor', 'post', { tool_output: '{"is_error":true}' })).toBe(false);
  });
});

describe('flags and quoting', () => {
  it('parses flags', () => {
    expect(parseAdapterFlags(['--state', 's', '--key', 'k', '--project'])).toEqual({ state: 's', key: 'k', project: '' });
  });
  it('quotes placeholders and characters the shell would split', () => {
    expect(shellQuote('${CLAUDE_PROJECT_DIR}/.speckl/state.json')).toBe('"${CLAUDE_PROJECT_DIR}/.speckl/state.json"');
    expect(shellQuote('/a b/"c"')).toBe('"/a b/\\"c\\""');
    expect(shellQuote('/k/s.key')).toBe('/k/s.key');
  });
});

describe('hook wiring', () => {
  it('Claude Code settings use the project placeholder and block on failure', () => {
    const h = buildHarnessHooks('claude-code', { adapter: '.speckl/agent/adapter.mjs', state: '.speckl/state.json', key: '/k/s.key', relative: true }) as any;
    const pre = h.hooks.PreToolUse[0];
    expect(pre.matcher).toBe('*');
    expect(pre.hooks[0]).toEqual({
      type: 'command',
      command: 'node "${CLAUDE_PROJECT_DIR}/.speckl/agent/adapter.mjs" claude-code pre --state "${CLAUDE_PROJECT_DIR}/.speckl/state.json" --key /k/s.key',
      timeout: 30,
      onFailure: 'block',
    });
    expect(h.hooks.PostToolBatch[0].matcher).toBeUndefined();
    expect(Object.keys(h.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch']);
  });
  it('Cursor hooks.json is version 1 and fail closed', () => {
    const h = buildHarnessHooks('cursor', { adapter: '.speckl/agent/adapter.mjs', state: '.speckl/state.json', key: null, relative: true }) as any;
    expect(h.version).toBe(1);
    expect(h.hooks.preToolUse[0]).toEqual({ command: 'node .speckl/agent/adapter.mjs cursor pre --state .speckl/state.json', timeout: 30, failClosed: true });
    expect(Object.keys(h.hooks)).toEqual(['preToolUse', 'postToolUse', 'postToolUseFailure']);
  });
  it('merge keeps foreign hooks and replaces older Speckl ones', () => {
    const ours = buildHarnessHooks('claude-code', { adapter: 'a/adapter.mjs', state: 's', key: null, relative: true });
    const existing = {
      model: 'x',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'node old/adapter.mjs claude-code pre --state s' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
      },
    };
    const m = mergeHarnessSettings('claude-code', existing, ours) as any;
    expect(m.model).toBe('x');
    expect(m.hooks.Stop).toHaveLength(1);
    expect(m.hooks.PreToolUse).toHaveLength(2);
    expect(m.hooks.PreToolUse[0].hooks[0].command).toBe('lint.sh');
    expect(m.hooks.PreToolUse[1].hooks[0].command).toContain('a/adapter.mjs');
    const c = mergeHarnessSettings('cursor', { hooks: { stop: [{ command: 'x' }], preToolUse: [{ command: 'node a/adapter.mjs cursor pre' }] } },
      buildHarnessHooks('cursor', { adapter: 'b/adapter.mjs', state: 's', key: null, relative: true })) as any;
    expect(c.version).toBe(1);
    expect(c.hooks.preToolUse).toHaveLength(1);
    expect(c.hooks.preToolUse[0].command).toContain('b/adapter.mjs');
  });
});

function fakeDeps(over: Partial<AdapterDeps> = {}, files: Record<string, string> = {}): AdapterDeps & { calls: any[]; files: Record<string, string> } {
  const calls: any[] = [];
  const d = {
    calls,
    files,
    runHook(cmd: 'pre' | 'post', msg: Record<string, unknown>, statePath: string, keyPath: string | null): HookResult {
      calls.push({ cmd, msg, statePath, keyPath });
      return { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' };
    },
    resolvePath: (b: string, p: string) => path.posix.resolve(b, p),
    relativePath: (a: string, b: string) => path.posix.relative(a, b),
    dirname: (p: string) => path.posix.dirname(p),
    cwd: '/p',
    agentDir: '/p/.speckl/agent',
    readFile: (p: string) => (p in files ? files[p] : null),
    writeFile: (p: string, t: string) => { files[p] = t; },
    mac(keyText: string, text: string) {
      const hex = String(keyText || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      return createHmac('sha256', Buffer.from(hex, 'hex')).update(text).digest('hex');
    },
    ...over,
  };
  return d;
}

const config = { harness: { 'claude-code': { rules }, cursor: { rules: [{ tools: ['Shell'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] }] } } };
const ccPre = (tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1', cwd: '/p', ...extra });

describe('runAdapter', () => {
  it('pre: maps, calls hook.mjs with the generic message, allows silently', () => {
    const d = fakeDeps();
    const out = runAdapter(['claude-code', 'pre', '--state', '.speckl/state.json', '--key', '/k/s.key'], { CLAUDE_PROJECT_DIR: '/p' }, ccPre('Bash', { command: 'npm test' }), config, d);
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls).toEqual([{ cmd: 'pre', msg: { tool: 'run_tests', input: {}, call_id: 't1' }, statePath: '/p/.speckl/state.json', keyPath: '/k/s.key' }]);
  });
  it('pre: a hook deny becomes exit 2 with the reason', () => {
    const d = fakeDeps({ runHook: () => ({ status: 2, stdout: '{"decision":"deny","reason":"HNTL: act tool refused"}\n', stderr: '' }) });
    const out = runAdapter(['claude-code', 'pre', '--state', 's.json'], {}, ccPre('Bash', { command: 'npm test' }), config, d);
    expect(out.code).toBe(2);
    expect(out.stderr).toBe('Speckl denied Bash (spec tool run_tests): HNTL: act tool refused\n');
  });
  it('pre: hook crash denies', () => {
    const d = fakeDeps({ runHook: () => ({ status: 1, stdout: '', stderr: 'Error: spawn /k/state.key\n    at hook.mjs:1' }) });
    const out = runAdapter(['claude-code', 'pre', '--state', 's.json', '--key', '/k/state.key'], {}, ccPre('Bash', { command: 'npm test' }), config, d);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('speckl hook error (exit 1): hook.mjs failed');
    expect(out.stdout + out.stderr).not.toContain('/k/state.key');
    expect(out.stderr).not.toContain('spawn /k');
  });
  it('pre: a timed-out or killed hook (status null) blocks in both harnesses', () => {
    const d = fakeDeps({ runHook: () => ({ status: null, stdout: '', stderr: 'hook.mjs timed out after 20000ms' }) });
    const cc = runAdapter(['claude-code', 'pre', '--state', 's.json'], {}, ccPre('Bash', { command: 'npm test' }), config, d);
    expect(cc.code).toBe(2);
    expect(cc.stderr).toContain('timed out');
    const cu = runAdapter(['cursor', 'pre', '--state', 's.json'], {},
      JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 'x' }), config, d);
    expect(cu.code).toBe(2);
    expect(JSON.parse(cu.stdout).permission).toBe('deny');
  });
  it('pre: denies without calling the hook on bad input', () => {
    const d = fakeDeps();
    const cases: [string[], string, string][] = [
      [['claude-code', 'pre', '--state', 's'], 'not json', 'not JSON'],
      [['claude-code', 'pre', '--state', 's'], '[1]', 'not a JSON object'],
      [['claude-code', 'pre', '--state', 's'], ccPre('WebFetch', {}), 'unmapped harness tool'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Bash', { command: 'npm test' }, { tool_use_id: '' }), 'no tool_use_id'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Bash', 'bad'), 'not JSON'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Bash', { command: 'npm test' }, { hook_event_name: 'PostToolUse' }), 'wired as PreToolUse'],
      [['claude-code', 'pre'], ccPre('Bash', { command: 'npm test' }), 'missing --state'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Read', { path: '/p/.speckl/agent/hook.mjs' }), 'Speckl-protected path'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Edit', { file_path: '/p/.claude/settings.json' }), 'Speckl-protected path'],
      [['claude-code', 'pre', '--state', 's'], ccPre('Edit', { file_path: '/p/.speckl/harness-install/claude-code.json' }), 'Speckl-protected path'],
      [['claude-code', 'nope', '--state', 's'], ccPre('Bash', {}), 'unknown event'],
      [['gemini', 'pre', '--state', 's'], ccPre('Bash', {}), 'not declared in the spec'],
    ];
    for (const [argv, stdin, want] of cases) {
      const out = runAdapter(argv, { CLAUDE_PROJECT_DIR: '/p' }, stdin, config, d);
      expect(out.code, want).toBe(2);
      expect(out.stderr, want).toContain(want);
    }
    expect(d.calls).toHaveLength(0);
  });
  it('protects the key named by SPECKL_STATE_KEY_FILE and an out-of-project state dir', () => {
    const d = fakeDeps();
    const env = { CLAUDE_PROJECT_DIR: '/p', SPECKL_STATE_KEY_FILE: '/etc/speckl/k.key' };
    expect(runAdapter(['claude-code', 'pre', '--state', '/var/speckl/state.json'], env, ccPre('Read', { path: '/etc/speckl/k.key' }), config, d).code).toBe(2);
    expect(runAdapter(['claude-code', 'pre', '--state', '/var/speckl/state.json'], env, ccPre('Read', { path: '/var/speckl/other' }), config, d).code).toBe(2);
  });
  it('post: success and failure are reported to hook.mjs', () => {
    const d = fakeDeps();
    const post = (ev: string, extra: Record<string, unknown>) => runAdapter(['claude-code', ev, '--state', 's'], {},
      JSON.stringify({ hook_event_name: ev === 'post' ? 'PostToolUse' : 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', ...extra }), config, d);
    expect(post('post', { tool_response: { stdout: 'ok' } })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(post('post-failure', { error: 'Exit code 1' }).code).toBe(0);
    expect(d.calls.map(c => c.msg.ok)).toEqual([true, false]);
  });
  it('post: an unrecorded result and an unmapped tool are surfaced to the agent', () => {
    const d = fakeDeps({ runHook: () => ({ status: 2, stdout: '{"decision":"deny","reason":"post: no matching pending call_id"}', stderr: '' }) });
    const p = (tool: string) => runAdapter(['claude-code', 'post', '--state', 's'], {}, JSON.stringify({ tool_name: tool, tool_input: { command: 'npm test' }, tool_use_id: 't1' }), config, d);
    expect(p('Bash').stderr).toContain('could not record Bash (spec tool run_tests): post: no matching pending call_id');
    expect(p('Bash').code).toBe(2);
    expect(p('WebFetch').stderr).toContain('ran without a Speckl mapping');
  });
  it('batch: clears calls that never posted, never stops the loop', () => {
    let n = 0;
    const d = fakeDeps({ runHook: (cmd, msg) => { n++; return msg.call_id === 'a' ? { status: 0, stdout: '', stderr: '' } : { status: 2, stdout: '', stderr: '' }; } });
    const batch = JSON.stringify({
      hook_event_name: 'PostToolBatch',
      tool_calls: [
        { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'a' },
        { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b' },
        { tool_name: 'WebFetch', tool_input: {}, tool_use_id: 'c' },
        { tool_name: 'Bash', tool_input: 'bad', tool_use_id: 'd' },
        { tool_name: 'Bash', tool_input: {} },
        null,
      ],
    });
    const out = runAdapter(['claude-code', 'batch', '--state', 's'], {}, batch, config, d);
    expect(out.code).toBe(0);
    expect(n).toBe(2);
    expect(JSON.parse(out.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolBatch' });
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('cleared 1 tool call');
    expect(runAdapter(['claude-code', 'batch', '--state', 's'], {}, '{"tool_calls":[]}', config, d)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(runAdapter(['claude-code', 'batch', '--state', 's'], {}, 'junk', config, d).code).toBe(0);
  });
  it('cursor: allow JSON, deny JSON + exit 2, exitCode-aware post', () => {
    const d = fakeDeps();
    const pre = runAdapter(['cursor', 'pre', '--state', 's'], { CURSOR_PROJECT_DIR: '/p' },
      JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 'c1' }), config, d);
    expect(JSON.parse(pre.stdout)).toEqual({ permission: 'allow' });
    const deny = runAdapter(['cursor', 'pre', '--state', 's'], {}, JSON.stringify({ tool_name: 'Delete', tool_input: {}, tool_use_id: 'c2' }), config, d);
    expect(deny.code).toBe(2);
    expect(JSON.parse(deny.stdout).permission).toBe('deny');
    const bad = runAdapter(['cursor', 'pre', '--state', 's'], {}, 'x', config, d);
    expect(JSON.parse(bad.stdout).permission).toBe('deny');
    runAdapter(['cursor', 'post', '--state', 's'], {}, JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 'c1', tool_output: '{"exitCode":1}' }), config, d);
    expect(d.calls[d.calls.length - 1].msg.ok).toBe(false);
    expect(runAdapter(['cursor', 'batch', '--state', 's'], {}, '{}', config, d).stderr).toContain('unknown event');
  });
});

describe('install', () => {
  it('writes project-relative Claude Code wiring and merges existing settings', () => {
    const files = {
      '/p/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
      '/home/u/k.key': 'ab'.repeat(32) + '\n',
    };
    const d = fakeDeps({}, files);
    const out = runAdapter(['install', 'claude-code', '--project', '.', '--state', '.speckl/state.json', '--key', '/home/u/k.key'], {}, '', config, d);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    const s = JSON.parse(d.files['/p/.claude/settings.json']);
    expect(s.permissions.allow).toEqual(['Bash(npm test)']);
    expect(s.hooks.PreToolUse[0].hooks[0].command)
      .toBe('node "${CLAUDE_PROJECT_DIR}/.speckl/agent/adapter.mjs" claude-code pre --state "${CLAUDE_PROJECT_DIR}/.speckl/state.json" --key /home/u/k.key');
  });
  it('writes Cursor wiring; absolute paths when the rails live outside the project', () => {
    const d = fakeDeps({ agentDir: '/opt/rails/agent' });
    expect(runAdapter(['install', 'cursor', '--project', '/p', '--state', '/opt/rails/state.json'], {}, '', config, d).stderr).toContain('no --key');
    const h = JSON.parse(d.files['/p/.cursor/hooks.json']);
    expect(h.hooks.preToolUse[0].command).toBe('node /opt/rails/agent/adapter.mjs cursor pre --state /opt/rails/state.json');
  });
  it('warns about a key inside the project and refuses to clobber bad JSON', () => {
    const d = fakeDeps({}, { '/p/.claude/settings.json': '{oops' });
    expect(installHarness('claude-code', { project: '/p', state: '/p/.speckl/state.json' }, d).stderr).toContain('not valid JSON');
    const d2 = fakeDeps({}, { '/p/.claude/settings.json': '[]' });
    expect(installHarness('claude-code', { project: '/p', state: '/p/s.json' }, d2).stderr).toContain('not a JSON object');
    const d3 = fakeDeps({}, { '/p/.claude/settings.json': '  ', '/p/k.key': 'ab'.repeat(32) + '\n' });
    expect(installHarness('claude-code', { project: '/p', state: '/p/s.json', key: '/p/k.key' }, d3).stderr).toContain('inside the project');
    expect(installHarness('claude-code', { project: '/p' }, d3).stderr).toContain('usage');
    expect(runAdapter(['install', 'gemini'], {}, '', config, d3).stderr).toContain('undeclared harness');
  });
});

describe('emission', () => {
  it('every emitted function is self-contained source', () => {
    for (const fn of ADAPTER_FUNCTIONS) {
      const src = fn.toString();
      expect(src.startsWith('function ' + fn.name + '(')).toBe(true);
      expect(src).not.toMatch(/__vite|import\(|require\(/);
    }
  });
});

describe('Codex CLI and Gemini CLI', () => {
  const cxRules: HarnessRule[] = [
    { tools: ['apply_patch'], target: 'edit_code', inputs: [{ param: 'path', field: 'path' }] },
    { tools: ['Bash'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
    { tools: ['mcp__ci__run_tests'], target: 'run_tests', inputs: [] },
  ];
  const gmRules: HarnessRule[] = [
    { tools: ['run_shell_command'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] },
  ];
  const cfg = { harness: { codex: { rules: cxRules }, gemini: { rules: gmRules } } };
  const cx = (ev: string, tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: ev, tool_name: tool, tool_input: input, tool_use_id: 'call_1', cwd: '/p/src', turn_id: 't', ...extra });
  const gm = (ev: string, tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: ev, session_id: 's1', tool_name: tool, tool_input: input, cwd: '/p', timestamp: 'x', ...extra });

  it('event names, config files', () => {
    expect(harnessEventName('codex', 'pre')).toBe('PreToolUse');
    expect(harnessEventName('codex', 'turn-end')).toBe('Stop');
    expect(harnessEventName('codex', 'post-failure')).toBeNull();
    expect(harnessEventName('gemini', 'pre')).toBe('BeforeTool');
    expect(harnessEventName('gemini', 'post')).toBe('AfterTool');
    expect(harnessEventName('gemini', 'turn-end')).toBe('AfterAgent');
    expect(harnessEventName('gemini', 'batch')).toBeNull();
    expect(harnessConfigFile('codex')).toBe('.codex/hooks.json');
    expect(harnessConfigFile('gemini')).toBe('.gemini/settings.json');
    expect(harnessConfigFile('claude-code')).toBe('.claude/settings.json');
    expect(harnessConfigFile('nope')).toBe('');
  });

  it('normalizeToolInput: apply_patch exposes the files it touches', () => {
    const patch = '*** Begin Patch\n*** Add File: a.js\n+x\n*** Update File: b/c.js\n*** Move to: b/d.js\n*** Delete File: e.js\n*** End Patch\n';
    expect(normalizeToolInput('codex', 'apply_patch', { command: patch })).toEqual({ command: patch, files: ['a.js', 'b/c.js', 'b/d.js', 'e.js'], path: 'a.js' });
    expect(normalizeToolInput('codex', 'apply_patch', { command: 'garbage' })).toEqual({ command: 'garbage', files: [] });
    expect(normalizeToolInput('codex', 'apply_patch', { command: 5 })).toEqual({ command: 5 });
    expect(normalizeToolInput('codex', 'Bash', { command: 'x' })).toEqual({ command: 'x' });
    expect(normalizeToolInput('claude-code', 'apply_patch', { command: patch })).toEqual({ command: patch });
  });

  it('harnessCallId: tool_use_id, or a stable id per Gemini session and tool', () => {
    expect(harnessCallId('codex', { tool_use_id: 'call_9' })).toBe('call_9');
    expect(harnessCallId('codex', { tool_use_id: '' })).toBeNull();
    expect(harnessCallId('claude-code', {})).toBeNull();
    const a = harnessCallId('gemini', { session_id: 's1', tool_name: 'read_file', tool_input: { file_path: 'a' } });
    expect(a).toMatch(/^gemini-[0-9a-f]{8}$/);
    expect(harnessCallId('gemini', { session_id: 's1', tool_name: 'read_file', tool_input: { file_path: 'b' } })).toBe(a);
    expect(harnessCallId('gemini', { session_id: 's2', tool_name: 'read_file' })).not.toBe(a);
    expect(harnessCallId('gemini', { session_id: 's1', tool_name: 'write_file' })).not.toBe(a);
    expect(harnessCallId('gemini', { session_id: 's1' })).toBeNull();
  });

  it('formats: Codex like Claude Code; Gemini prints {} on allow; posts surface problems as context', () => {
    expect(formatPre('codex', true, '')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(formatPre('codex', false, 'no')).toEqual({ code: 2, stdout: '', stderr: 'no\n' });
    expect(formatPre('gemini', true, '')).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(formatPre('gemini', false, 'no')).toEqual({ code: 2, stdout: '', stderr: 'no\n' });
    expect(formatPost('codex', null)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(formatPost('gemini', null)).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    const p = formatPost('gemini', 'bad');
    expect(p.code).toBe(0);
    expect(JSON.parse(p.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: 'bad' } });
    expect(JSON.parse(formatPost('codex', 'bad').stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('postSucceeded: Codex Bash never; apply_patch needs Exit code 0; MCP isError counts', () => {
    expect(postSucceeded('codex', 'post', { tool_name: 'Bash', tool_response: '# pass 3' })).toBe(false);
    expect(postSucceeded('codex', 'post', { tool_name: 'apply_patch', tool_response: 'Exit code: 0\nOutput:\nSuccess.' })).toBe(true);
    expect(postSucceeded('codex', 'post', { tool_name: 'apply_patch', tool_response: 'Exit code: 1\nOutput:\nfailed' })).toBe(false);
    expect(postSucceeded('codex', 'post', { tool_name: 'apply_patch', tool_response: { x: 1 } })).toBe(false);
    expect(postSucceeded('codex', 'post', { tool_name: 'mcp__ci__run_tests', tool_response: { content: [], isError: true } })).toBe(false);
    expect(postSucceeded('codex', 'post', { tool_name: 'mcp__ci__run_tests', tool_response: { content: [], isError: false } })).toBe(true);
    expect(postSucceeded('codex', 'post', { tool_name: 'update_plan', tool_response: 'Plan updated' })).toBe(true);
  });

  it('postSucceeded: Gemini needs an error-free response; shell needs a clean Output block', () => {
    const sh = (llm: unknown, extra: Record<string, unknown> = {}) =>
      postSucceeded('gemini', 'post', { tool_name: 'run_shell_command', tool_response: { llmContent: llm, returnDisplay: '', ...extra } });
    expect(sh('Output: 3 passing')).toBe(true);
    expect(sh('Output: 2 passing\nExit Code: 1')).toBe(false);
    expect(sh('Output: (empty)\nSignal: 9')).toBe(false);
    expect(sh('Output: (empty)\nError: spawn failed')).toBe(false);
    expect(sh('Command moved to background (PID: 7). Output hidden.')).toBe(false);
    expect(sh(42)).toBe(false);
    expect(sh('Output: ok', { error: { message: 'x' } })).toBe(false);
    expect(postSucceeded('gemini', 'post', { tool_name: 'read_file', tool_response: { llmContent: 'x' } })).toBe(true);
    expect(postSucceeded('gemini', 'post', { tool_name: 'read_file', tool_response: { llmContent: 'x', error: null } })).toBe(true);
    expect(postSucceeded('gemini', 'post', { tool_name: 'read_file', tool_response: 'x' })).toBe(false);
    expect(postSucceeded('gemini', 'post', { tool_name: 'read_file' })).toBe(false);
  });

  it('wiring: three events, blocking pre, absolute install paths', () => {
    const c = buildHarnessHooks('codex', { adapter: 'a/adapter.mjs', state: 's.json', key: '/k', relative: true }) as any;
    expect(Object.keys(c.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'Stop']);
    expect(c.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'node a/adapter.mjs codex pre --state s.json --key /k || exit 2', timeout: 30 });
    expect(c.hooks.Stop[0].matcher).toBeUndefined();
    const g = buildHarnessHooks('gemini', { adapter: 'a/adapter.mjs', state: 's.json', key: null, relative: true }) as any;
    expect(g.hooks.BeforeTool[0]).toEqual({ matcher: '.*', hooks: [{ type: 'command', command: 'node "${GEMINI_PROJECT_DIR}/a/adapter.mjs" gemini pre --state "${GEMINI_PROJECT_DIR}/s.json" || exit 2', timeout: 30000, name: 'speckl-pre' }] });
    expect(g.hooks.AfterAgent[0].hooks[0].command).not.toContain('exit 2');
    for (const h of ['codex', 'gemini']) {
      const d = fakeDeps({}, { '/k/s.key': 'ab'.repeat(32) + '\n' });
      expect(installHarness(h, { project: '.', state: '.speckl/state.json', key: '/k/s.key' }, d).code).toBe(0);
      const file = h === 'codex' ? '/p/.codex/hooks.json' : '/p/.gemini/settings.json';
      const pre = JSON.parse(d.files[file]).hooks[h === 'codex' ? 'PreToolUse' : 'BeforeTool'][0].hooks[0].command;
      expect(pre).toBe(`node /p/.speckl/agent/adapter.mjs ${h} pre --state /p/.speckl/state.json --key /k/s.key --project /p || exit 2`);
    }
  });

  it('runAdapter codex: apply_patch maps to its first file; rails in a patch are refused', () => {
    const d = fakeDeps();
    const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** End Patch\n';
    const out = runAdapter(['codex', 'pre', '--state', '/p/.speckl/state.json'], {}, cx('PreToolUse', 'apply_patch', { command: patch }), cfg, d);
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(d.calls[0].msg).toEqual({ tool: 'edit_code', input: { path: 'src/a.js' }, call_id: 'call_1' });
    const rails = '*** Begin Patch\n*** Update File: ../.codex/hooks.json\n*** End Patch\n';
    const r = runAdapter(['codex', 'pre', '--state', '/p/.speckl/state.json'], {}, cx('PreToolUse', 'apply_patch', { command: rails }), cfg, fakeDeps());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Speckl-protected path (.codex)');
    // An absolute path from a subdirectory session is caught once --project pins the root.
    const abs = '*** Begin Patch\\n*** Update File: /p/.codex/hooks.json\\n*** End Patch\\n';
    const r2 = runAdapter(['codex', 'pre', '--state', '/p/.speckl/state.json', '--project', '/p'], {}, cx('PreToolUse', 'apply_patch', { command: abs }), cfg, fakeDeps());
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain('Speckl-protected path (/p/.codex)');
  });

  it('runAdapter codex: a Bash post is recorded as failed and says why', () => {
    const d = fakeDeps();
    const out = runAdapter(['codex', 'post', '--state', '/p/s.json'], {}, cx('PostToolUse', 'Bash', { command: 'npm test' }, { tool_response: 'ok' }), cfg, d);
    expect(d.calls[0].msg).toMatchObject({ tool: 'run_tests', ok: false });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('does not report a Bash exit status');
    const m = fakeDeps();
    const ok = runAdapter(['codex', 'post', '--state', '/p/s.json'], {}, cx('PostToolUse', 'mcp__ci__run_tests', {}, { tool_response: { isError: false } }), cfg, m);
    expect(m.calls[0].msg).toMatchObject({ ok: true });
    expect(ok).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('runAdapter gemini: derived call id pairs BeforeTool with AfterTool; GEMINI_PROJECT_DIR is the project', () => {
    const d = fakeDeps();
    const pre = runAdapter(['gemini', 'pre', '--state', '.speckl/state.json'], { GEMINI_PROJECT_DIR: '/p' }, gm('BeforeTool', 'run_shell_command', { command: 'npm test' }), cfg, d);
    expect(pre).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    const post = runAdapter(['gemini', 'post', '--state', '.speckl/state.json'], { GEMINI_PROJECT_DIR: '/p' },
      gm('AfterTool', 'run_shell_command', { command: 'npm test' }, { tool_response: { llmContent: 'Output: ok' } }), cfg, d);
    expect(post).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    expect(d.calls[0].msg.call_id).toBe(d.calls[1].msg.call_id);
    expect(d.calls[1].msg.ok).toBe(true);
    expect(d.calls[0].statePath).toBe('/p/.speckl/state.json');
    const bad = runAdapter(['gemini', 'pre', '--state', 's.json'], {}, gm('BeforeTool', 'web_fetch', {}), cfg, fakeDeps());
    expect(bad).toMatchObject({ code: 2, stdout: '' });
    expect(bad.stderr).toContain('unmapped harness tool "web_fetch"');
    const wrong = runAdapter(['gemini', 'pre', '--state', 's.json'], {}, gm('AfterTool', 'run_shell_command', { command: 'npm test' }), cfg, fakeDeps());
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('wired as BeforeTool');
  });

  it('runAdapter turn-end: clears a pending call as failed, quiet otherwise, never blocks', () => {
    const state = '/p/.speckl/state.json';
    const pending = JSON.stringify({ pending: { call_id: 'c7', tool: 'open_pr', input: { a: 1 } } });
    const d = fakeDeps({}, { [state]: pending });
    const out = runAdapter(['codex', 'turn-end', '--state', state], {}, JSON.stringify({ hook_event_name: 'Stop', cwd: '/p' }), cfg, d);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('cleared pending call c7');
    expect(d.calls).toEqual([{ cmd: 'post', msg: { tool: 'open_pr', input: { a: 1 }, call_id: 'c7', ok: false }, statePath: state, keyPath: null }]);
    // Nothing pending, no state, a broken state: no hook call, exit 0.
    const variants: Record<string, string>[] = [{ [state]: JSON.stringify({ pending: null }) }, {}, { [state]: '{broken' }];
    for (const files of variants) {
      const q = fakeDeps({}, files);
      expect(runAdapter(['gemini', 'turn-end', '--state', state], {}, JSON.stringify({ hook_event_name: 'AfterAgent' }), cfg, q))
        .toEqual({ code: 0, stdout: '{}\n', stderr: '' });
      expect(q.calls).toEqual([]);
    }
    // hook.mjs refusing the clear is reported, still exit 0.
    const f = fakeDeps({ runHook: () => ({ status: 2, stdout: '{"decision":"deny","reason":"post: no matching pending call_id"}\n', stderr: '' }) }, { [state]: pending });
    const r = runAdapter(['gemini', 'turn-end', '--state', state], {}, JSON.stringify({ hook_event_name: 'AfterAgent' }), cfg, f);
    expect(r).toMatchObject({ code: 0, stdout: '{}\n' });
    expect(r.stderr).toContain('could not clear the pending call: post: no matching pending call_id');
    // Malformed turn-end payloads also exit 0 (a Gemini exit 2 would force a retry).
    expect(runAdapter(['gemini', 'turn-end', '--state', state], {}, 'nope', cfg, fakeDeps())).toMatchObject({ code: 0, stdout: '{}\n' });
    expect(runAdapter(['codex', 'turn-end', '--state', state], {}, 'nope', cfg, fakeDeps())).toMatchObject({ code: 0, stdout: '' });
  });
});
