// install --dry-run, backups, uninstall, and status/doctor.
// The in-process functions are the ones emitted into adapter.mjs.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { emitAdapterMjs } from '../generators/agent/adapter-template.js';
import {
  ADAPTER_FUNCTIONS, parseAdapterFlags, doctorProbe, classifyProbe, hookCommandResult, pathInside, unifiedDiff,
  installFilePaths, installRecordPayload, installHarness, uninstallHarness, inspectHarness, runAdapter,
  AdapterDeps, HookResult,
} from '../generators/agent/harness-runtime.js';

const HARNESSES = [
  'claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'goose', 'hermes',
  'pi', 'opencode', 'openclaw', 'cline', 'kiro', 'windsurf',
] as const;

const rule = { tools: ['Bash'], field: 'command', pattern: 'npm test', target: 'run_tests', inputs: [] as { param: string; field: string }[] };
const config = {
  stageVariable: 'stage',
  stages: { Idle: 0, Approved: 1 },
  awaits: [{ state: 'Approved', stateValue: 1, signal: 'review', mode: 'in' }],
  harness: Object.fromEntries(HARNESSES.map(h => [h, { rules: [rule] }])),
};

const MAC = 'ab'.repeat(32);
const KEY = 'cd'.repeat(32) + '\n';

function stateBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: 'run-1', dev: false, log: [], machine: { stage: 1 }, pending: null, mac: MAC, ...over,
  });
}

function fakeDeps(files: Record<string, string> = {}, over: Partial<AdapterDeps> = {}) {
  const calls: { cmd: string; msg: unknown }[] = [];
  const commands: { command: string; stdin: string; cwd: string; env: Record<string, string> }[] = [];
  const modes: Record<string, number> = {};
  const links: Record<string, string> = {};
  const base: AdapterDeps & {
    calls: typeof calls; files: Record<string, string>; commands: typeof commands; modes: Record<string, number>;
    links: Record<string, string>;
  } = {
    calls, files, commands, modes, links,
    runHook(cmd, msg) {
      calls.push({ cmd, msg });
      return { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' };
    },
    resolvePath: (b, p) => path.posix.resolve(b, p),
    relativePath: (a, b) => path.posix.relative(a, b),
    dirname: p => path.posix.dirname(p),
    cwd: '/p',
    agentDir: '/p/.speckl/agent',
    readFile: p => (p in files ? files[p] : null),
    writeFile(p, text, mode) { files[p] = text; if (mode) modes[p] = mode; },
    removeFile(p) {
      if (p in links) return false;
      if (!(p in files)) return false;
      delete files[p];
      return true;
    },
    lstatKind(p) {
      if (p in links) return 'symlink';
      if (p in files) return 'file';
      const prefix = p.endsWith('/') ? p : p + '/';
      if (Object.keys(files).some(k => k.startsWith(prefix)) || Object.keys(links).some(k => k.startsWith(prefix))) return 'dir';
      return 'missing';
    },
    realPath(p) {
      if (p in links) return links[p];
      if (p in files) return p;
      const prefix = p.endsWith('/') ? p : p + '/';
      if (Object.keys(files).some(k => k.startsWith(prefix)) || Object.keys(links).some(k => k === p || k.startsWith(prefix))) return p;
      return null;
    },
    mac(keyText, text) {
      const hex = String(keyText || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      return createHmac('sha256', Buffer.from(hex, 'hex')).update(text).digest('hex');
    },
    runCommand(command, stdin, cwd, env) {
      commands.push({ command, stdin, cwd, env });
      return harnessDeny(command);
    },
    ...over,
  };
  return base;
}

function harnessDeny(command: string): HookResult {
  const marker = 'unmapped harness tool "__speckl_doctor__"';
  const wind = 'unmapped harness tool "mcp____speckl_doctor____probe"';
  const err = marker + '\n' + wind + '\n';
  if (/^sh /.test(command) && command.includes('PreToolUse')) {
    return { status: 0, stdout: JSON.stringify({ cancel: true, errorMessage: marker }) + '\n', stderr: err };
  }
  let harness = '';
  for (const h of HARNESSES) if (command.includes(' ' + h + ' pre')) harness = h;
  if (!harness) return { status: 0, stdout: '', stderr: '' };
  if (harness === 'cursor') {
    return { status: 2, stdout: JSON.stringify({ permission: 'deny', user_message: marker, agent_message: marker }) + '\n', stderr: err };
  }
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    return { status: 2, stdout: JSON.stringify({ decision: 'block', reason: marker }) + '\n', stderr: err };
  }
  return { status: 2, stdout: '', stderr: err };
}

function seed(files: Record<string, string> = {}): Record<string, string> {
  return {
    '/k/state.key': KEY,
    '/p/.speckl/state.json': stateBody(),
    '/h/config.yaml': 'model: x\n',
    '/h/shell-hooks-allowlist.json': '{"approvals":[]}\n',
    ...files,
  };
}

const flagsFor = (h: string) => ({
  project: '.', state: '.speckl/state.json', key: '/k/state.key',
  ...(h === 'hermes' ? { 'hermes-home': '/h' } : {}),
});
const un = { project: '.', key: '/k/state.key' };

describe('parseAdapterFlags', () => {
  it('treats --dry-run as a boolean and does not swallow the next argument', () => {
    expect(parseAdapterFlags(['--dry-run', '--project', '/p', '--state', 's'])).toEqual({
      'dry-run': 'true', project: '/p', state: 's',
    });
    expect(parseAdapterFlags(['--state', 's', '--key', 'k', '--project'])).toEqual({ state: 's', key: 'k', project: '' });
  });
});

describe('doctorProbe', () => {
  it('picks a tool name the spec does not map, including a second choice', () => {
    const taken = [{ tools: ['__speckl_doctor__', 'Bash'] }];
    const p = doctorProbe('claude-code', '/p', taken);
    expect(p.marker).toBe('unmapped harness tool "__speckl_doctor_2__"');
    expect(p.body.tool_name).toBe('__speckl_doctor_2__');
    expect(p.body.hook_event_name).toBe('PreToolUse');
  });
  it('uses Windsurf\'s synthetic mcp tool name and skips one the spec maps', () => {
    const first = doctorProbe('windsurf', '/p', []);
    expect(first.marker).toBe('unmapped harness tool "mcp____speckl_doctor____probe"');
    expect((first.body.tool_info as { mcp_tool_name: string }).mcp_tool_name).toBe('probe');
    const taken = [{ tools: ['__speckl_doctor__', 'mcp____speckl_doctor____probe', 'mcp____speckl_doctor_2____probe'] }];
    const p = doctorProbe('windsurf', '/p', taken);
    expect(p.marker).toBe('unmapped harness tool "mcp____speckl_doctor_3____probe"');
  });
  it('still names a tool for an unknown harness', () => {
    expect(doctorProbe('no-such', '/p', []).body).toEqual({ tool_name: '__speckl_doctor__' });
  });
});

describe('hookCommandResult', () => {
  it('keeps an exit code when the child closes stdin unread (EPIPE)', () => {
    expect(hookCommandResult(2, 'EPIPE', 'Error: spawnSync sh EPIPE', '', '', '', 20000))
      .toEqual({ status: 2, stdout: '', stderr: '' });
    expect(hookCommandResult(0, 'EPIPE', 'Error: spawnSync sh EPIPE', '', 'out', 'err', 20000))
      .toEqual({ status: 0, stdout: 'out', stderr: 'err' });
  });
  it('drops the exit code for a timeout, a signal, or a spawn error', () => {
    expect(hookCommandResult(null, 'ETIMEDOUT', 'Error: spawnSync sh ETIMEDOUT', '', '', '', 20000).stderr)
      .toBe('command timed out after 20000ms');
    expect(hookCommandResult(null, 'ETIMEDOUT', 'Error: spawnSync sh ETIMEDOUT', '', '', '', 20000).status).toBe(null);
    expect(hookCommandResult(null, 'ENOENT', 'Error: spawnSync sh ENOENT', '', '', '', 20000))
      .toEqual({ status: null, stdout: '', stderr: 'Error: spawnSync sh ENOENT' });
    expect(hookCommandResult(null, '', 'Error: empty command', '', '', '', 20000))
      .toEqual({ status: null, stdout: '', stderr: 'Error: empty command' });
    expect(hookCommandResult(1, 'EACCES', '', '', 'out', 'err', 20000))
      .toEqual({ status: null, stdout: 'out', stderr: 'EACCES' });
    expect(hookCommandResult(null, 'EPIPE', 'Error: spawnSync sh EPIPE', '', '', '', 20000))
      .toEqual({ status: null, stdout: '', stderr: 'Error: spawnSync sh EPIPE' });
    expect(hookCommandResult(null, '', '', 'SIGKILL', 'out', '', 20000))
      .toEqual({ status: null, stdout: 'out', stderr: 'command killed by SIGKILL' });
    expect(hookCommandResult(2, 'EPIPE', 'Error: spawnSync sh EPIPE', 'SIGKILL', '', '', 20000))
      .toEqual({ status: null, stdout: '', stderr: 'Error: spawnSync sh EPIPE' });
    expect(hookCommandResult(0, '', '', '', '', 'hook said no', 20000))
      .toEqual({ status: 0, stdout: '', stderr: 'hook said no' });
  });
});

describe('classifyProbe', () => {
  const marker = 'unmapped harness tool "__speckl_doctor__"';
  const denyErr = { status: 2, stdout: '', stderr: 'Speckl: ' + marker + '\n' };
  it('accepts only a deny the adapter itself printed', () => {
    expect(classifyProbe('claude-code', denyErr, marker).kind).toBe('denied');
    expect(classifyProbe('claude-code', { status: 0, stdout: '', stderr: 'Speckl: ' + marker }, marker).kind).toBe('open');
    expect(classifyProbe('claude-code', { status: 2, stdout: '', stderr: 'wrapper only' }, marker).line).toContain('NOT PROVED');
    expect(classifyProbe('claude-code', { status: null, stdout: '', stderr: 'Error: spawn node ENOENT' }, marker).line).toContain('HOOK MISSING');
    expect(classifyProbe('claude-code', { status: 127, stdout: '', stderr: 'sh: node: not found' }, marker).kind).toBe('missing');
    expect(classifyProbe('claude-code', { status: null, stdout: '', stderr: '' }, marker).line).toContain('no output');
    expect(classifyProbe('claude-code', { status: 2, stdout: 'plain', stderr: '' }, marker).line).toContain('plain');
  });
  it('reads each harness\'s own allow signal, and the marker does not hide an allow', () => {
    expect(classifyProbe('cline', { status: 0, stdout: '{"cancel":false}\n', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('cline', {
      status: 0,
      stdout: JSON.stringify({ cancel: true, errorMessage: 'Speckl: ' + marker }) + '\n',
      stderr: 'Speckl: ' + marker + '\n',
    }, marker).kind).toBe('denied');
    expect(classifyProbe('cline', { status: 0, stdout: 'not-json', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('cline', { status: 0, stdout: '{"cancel":true}\n', stderr: '' }, marker).kind).toBe('unproved');
    expect(classifyProbe('cline', { status: 0, stdout: '{"cancel":"true"}\n', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('pi', { status: 0, stdout: '{"decision":"allow"}\n', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('pi', { status: 0, stdout: '{"decision":"deny"}\n', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('pi', { status: 0, stdout: '{"decision":"block"}\n', stderr: '' }, marker).kind).toBe('unproved');
    expect(classifyProbe('opencode', { status: 0, stdout: '{"decision":"block"}\n', stderr: marker }, marker).kind).toBe('denied');
    expect(classifyProbe('openclaw', { status: 0, stdout: '', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('openclaw', { status: 0, stdout: '{"decision":"block"}\n', stderr: marker }, marker).kind).toBe('denied');
    expect(classifyProbe('cursor', { status: 0, stdout: '', stderr: marker }, marker).kind).toBe('open');
    expect(classifyProbe('cursor', { status: 0, stdout: '{"permission":"deny"}\n', stderr: marker }, marker).kind).toBe('denied');
    expect(classifyProbe('cursor', { status: 0, stdout: '{"permission":"deny"}\n', stderr: '' }, marker).kind).toBe('unproved');
    expect(classifyProbe('cursor', { status: 0, stdout: '{"permission":"allow"}\n', stderr: marker }, marker).kind).toBe('open');
    for (const h of ['codex', 'gemini', 'copilot', 'goose', 'hermes', 'kiro', 'windsurf']) {
      expect(classifyProbe(h, { status: 0, stdout: '', stderr: marker }, marker).kind, h).toBe('open');
    }
    expect(classifyProbe('gemini', { status: 2, stdout: '', stderr: marker }, marker).kind).toBe('denied');
  });
});

describe('pathInside and unifiedDiff', () => {
  const deps = fakeDeps();
  it('pathInside is the directory, not a prefix or a parent', () => {
    expect(pathInside('/p/.speckl/harness-install', '/p/.speckl/harness-install', deps)).toBe(true);
    expect(pathInside('/p/.speckl/harness-install', '/p/.speckl/harness-install/backups/a', deps)).toBe(true);
    expect(pathInside('/p/.speckl/harness-install', '/p/.speckl/harness-install-evil', deps)).toBe(false);
    expect(pathInside('/p/.speckl/harness-install', '/p/.claude/settings.json', deps)).toBe(false);
    expect(pathInside('/p', '/etc/passwd', deps)).toBe(false);
  });
  it('unifiedDiff shows only the changed lines, and nothing when the text matches', () => {
    expect(unifiedDiff('/p/a', 'same\n', 'same\n')).toBe('');
    const created = unifiedDiff('/p/a', null, 'new\n');
    expect(created).toContain('--- /dev/null');
    expect(created).toContain('+new');
    const changed = unifiedDiff('/p/a', 'keep\nold\nkeep\n', 'keep\nnew\nkeep\n');
    expect(changed).toContain('-old');
    expect(changed).toContain('+new');
    expect(changed).not.toContain('-keep');
    expect(unifiedDiff('/p/a', 'a\nb\n', 'a\n')).toContain('-b');
  });
});

describe('an unmapped doctor probe never reaches hook.mjs', () => {
  for (const h of HARNESSES) {
    it(h + ' denies the probe before runHook', () => {
      const d = fakeDeps();
      const probe = doctorProbe(h, '/p', config.harness[h].rules);
      const out = runAdapter([h, 'pre', '--state', '.speckl/state.json', '--key', '/k/state.key'], {}, JSON.stringify(probe.body), config, d);
      expect(out.code, out.stderr + out.stdout).not.toBe(0);
      expect(out.stdout + out.stderr).toContain(probe.marker);
      expect(d.calls).toHaveLength(0);
    });
  }
});

describe('install, status and doctor', () => {
  it('new setup functions are emitted with the adapter', () => {
    const names = ADAPTER_FUNCTIONS.map(f => f.name);
    for (const n of ['installRecordPayload', 'commitInstallWrites', 'uninstallHarness', 'doctorProbe', 'classifyProbe', 'inspectHarness']) {
      expect(names).toContain(n);
    }
  });

  it('installs every harness and doctor proves the installed command would deny', () => {
    const d = fakeDeps(seed());
    for (const h of HARNESSES) {
      const inst = runAdapter(['install', h, '--project', '.', '--state', '.speckl/state.json', '--key', '/k/state.key', ...(h === 'hermes' ? ['--hermes-home', '/h'] : [])], {}, '', config, d);
      expect(inst.code, h + ' ' + inst.stderr).toBe(0);
      const paths = installFilePaths(h, '/p', {
        hermesHome: h === 'hermes' ? '/h' : '',
        pluginsDir: '',
        pluginName: 'speckl',
      }, d);
      for (const p of paths) expect(d.files[p], p).toBeTruthy();
      if (h === 'cline') for (const p of paths) expect(d.modes[p]).toBe(0o755);
      const before = d.commands.length;
      const doc = runAdapter(['doctor', h, '--project', '.', '--state', '.speckl/state.json', '--key', '/k/state.key', ...(h === 'hermes' ? ['--hermes-home', '/h'] : [])], {}, '', config, d);
      expect(doc.code, h + '\n' + doc.stdout + doc.stderr).toBe(0);
      expect(doc.stdout).toContain('probe: denied (');
      expect(doc.stdout).toContain('stage=Approved (1)');
      expect(doc.stdout).toContain('awaiting review (in)');
      expect(doc.stdout).toContain('mac=present (not replayed; hook.mjs checks it on a real call)');
      expect(doc.stdout).toContain('key: present <keyfile>');
      expect(doc.stdout).not.toContain('/k/state.key');
      expect(doc.stdout).not.toContain('inside the project');
      expect(doc.stderr).toBe('');
      expect(d.commands.length).toBe(before + 1);
      const ran = d.commands[d.commands.length - 1];
      expect(JSON.parse(ran.stdin)).toEqual(doctorProbe(h, '/p', config.harness[h].rules).body);
      expect(ran.cwd).toBe('/p');
      if (h === 'cline') {
        expect(ran.command).toMatch(/^sh /);
        expect(ran.command).toContain('PreToolUse');
        expect(ran.command).not.toContain('||');
      } else {
        expect(ran.command).toContain(h + ' pre');
      }
      const wrapped = ['codex', 'gemini', 'copilot', 'goose', 'kiro', 'windsurf'].includes(h);
      if (wrapped) expect(ran.command).toContain('|| exit 2');
      else if (h !== 'cline') expect(ran.command).not.toContain('||');
      if (h === 'kiro' || h === 'windsurf') expect(ran.command).toContain('[');
      if (h === 'claude-code') expect(ran.env.CLAUDE_PROJECT_DIR).toBe('/p');
      if (h === 'gemini') expect(ran.env.GEMINI_PROJECT_DIR).toBe('/p');
      if (h === 'cursor') expect(ran.env.CURSOR_PROJECT_DIR).toBe('/p');
      if (h === 'pi' || h === 'opencode' || h === 'openclaw') expect(doc.stdout).toContain('does not prove ' + h + ' loaded the plugin');
      const st = runAdapter(['status', h, '--project', '.', '--state', '.speckl/state.json', '--key', '/k/state.key', ...(h === 'hermes' ? ['--hermes-home', '/h'] : [])], {}, '', config, d);
      expect(st.code, st.stdout + st.stderr).toBe(0);
      expect(st.stdout).toContain('probe: not run');
      expect(d.commands.length).toBe(before + 1);
    }
  });

  it('a user-scope plugin is the one doctor runs', () => {
    const d = fakeDeps(seed());
    const inst = installHarness('pi', { ...flagsFor('pi'), 'plugins-dir': '/home/u/plugins' }, d);
    expect(inst.code, inst.stderr).toBe(0);
    const doc = inspectHarness('pi', { ...flagsFor('pi'), 'plugins-dir': '/home/u/plugins' }, config.harness.pi.rules, config, d, {}, true);
    expect(doc.code, doc.stdout + doc.stderr).toBe(0);
    expect(doc.stdout).toContain('/home/u/plugins/speckl-');
    expect(d.commands[0].command).toContain(' pi pre ');
    expect(d.commands[0].command).toContain('--outside allow');
    expect(d.commands[0].command).not.toContain('/p/--');
  });

  it('--dry-run prints the diff and writes nothing; a later install keeps the first backup', () => {
    const original = '{"permissions":{"allow":["Bash(npm test)"]}}\n';
    const files = seed({ '/p/.claude/settings.json': original, '/p/notes.txt': 'keep\n' });
    const d = fakeDeps(files);
    const snap = { ...files };
    const dry = installHarness('claude-code', { ...flagsFor('claude-code'), 'dry-run': 'true' }, d);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('modify /p/.claude/settings.json');
    expect(dry.stdout).toContain('backup /p/.speckl/harness-install/backups/claude-code/');
    expect(dry.stdout).toContain('snapshot ');
    expect(dry.stdout).toContain('-{"permissions"');
    expect(dry.stdout).toContain('record /p/.speckl/harness-install/claude-code.json');
    expect(dry.stdout).toContain('dry-run: no files written');
    expect(d.files).toEqual(snap);
    const real = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(real.code, real.stderr).toBe(0);
    expect(real.stdout).toContain('backed up 1 file');
    const rec = JSON.parse(d.files['/p/.speckl/harness-install/claude-code.json']);
    expect(rec.v).toBe(1);
    expect(rec.files).toHaveLength(1);
    expect(rec.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.files[0].action).toBe('modify');
    expect(d.files[rec.files[0].backup]).toBe(original);
    expect(d.files[rec.files[0].written]).toBe(d.files['/p/.claude/settings.json']);
    expect(d.files['/p/notes.txt']).toBe('keep\n');
    const again = installHarness('claude-code', { ...flagsFor('claude-code'), 'dry-run': 'true' }, d);
    expect(again.stdout).toContain('unchanged /p/.claude/settings.json');
    expect(again.stdout).not.toContain('\nrecord ');
    expect(again.stdout).toContain('dry-run: no files written');
    const edited = JSON.parse(d.files['/p/.claude/settings.json']);
    edited.model = 'sonnet';
    d.files['/p/.claude/settings.json'] = JSON.stringify(edited);
    const preview = installHarness('claude-code', { ...flagsFor('claude-code'), 'dry-run': 'true' }, d);
    expect(preview.stdout).toContain('keep existing');
    expect(d.files[rec.files[0].backup]).toBe(original);
    const second = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(second.code).toBe(0);
    expect(d.files[rec.files[0].backup]).toBe(original);
    expect(second.stdout).not.toContain('backed up');
  });

  it('a created file is not backed up, and a second install still records it as created', () => {
    const d = fakeDeps(seed());
    expect(installHarness('cline', flagsFor('cline'), d).code).toBe(0);
    const rec = JSON.parse(d.files['/p/.speckl/harness-install/cline.json']);
    expect(rec.files.every((f: { action: string; backup: string | null }) => f.action === 'create' && f.backup === null)).toBe(true);
    const pre = '/p/.clinerules/hooks/PreToolUse';
    d.files[pre] = d.files[pre].replace('do not edit', 'do not edit ');
    expect(installHarness('cline', flagsFor('cline'), d).code).toBe(0);
    const rec2 = JSON.parse(d.files['/p/.speckl/harness-install/cline.json']);
    const entry = rec2.files.find((f: { path: string }) => f.path === pre);
    expect(entry.action).toBe('create');
    expect(entry.backup).toBeNull();
    expect(Object.keys(d.files).some(p => p.includes('/backups/'))).toBe(false);
  });

  it('refuses a record it does not own, and a dry-run of a refused install writes nothing', () => {
    const foreign = 'export default () => {}\n';
    let d = fakeDeps(seed({ '/p/.pi/extensions/speckl.js': foreign }));
    const before = { ...d.files };
    expect(installHarness('pi', { ...flagsFor('pi'), 'dry-run': 'true' }, d).code).toBe(1);
    expect(d.files).toEqual(before);
    d = fakeDeps(seed({ '/h/config.yaml': 'hooks:\n  pre_tool_call: []\n', '/h/shell-hooks-allowlist.json': '{"approvals":[]}\n' }));
    const yaml = d.files['/h/config.yaml'];
    expect(installHarness('hermes', { ...flagsFor('hermes'), 'dry-run': 'true' }, d).stderr).toContain('already has a hooks:');
    expect(d.files['/h/config.yaml']).toBe(yaml);
    expect(d.files['/p/.speckl/harness-install/hermes.json']).toBeUndefined();
    d = fakeDeps(seed({ '/p/.speckl/harness-install/claude-code.json': '{nope' }));
    d.files['/p/.claude/settings.json'] = '{}\n';
    expect(installHarness('claude-code', flagsFor('claude-code'), d).stderr).toContain('not valid JSON');
    expect(d.files['/p/.claude/settings.json']).toBe('{}\n');
    d.files['/p/.speckl/harness-install/claude-code.json'] = '{"v":2,"harness":"claude-code","files":[]}\n';
    expect(installHarness('claude-code', flagsFor('claude-code'), d).stderr).toContain('not a Speckl install record');
    expect(d.files['/p/.claude/settings.json']).toBe('{}\n');
  });

  it('refuses to record a backup or a saved copy outside the install directory', () => {
    const files = [{ path: '/p/.claude/settings.json', action: 'modify', backup: '/evil/orig', written: '/p/.speckl/harness-install/written/claude-code/old' }];
    const d = fakeDeps(seed({ '/p/.claude/settings.json': '{}\n' }));
    d.files['/p/.speckl/harness-install/claude-code.json'] = JSON.stringify({
      v: 1, harness: 'claude-code', files, mac: d.mac!(KEY, installRecordPayload('claude-code', files)),
    }) + '\n';
    const r = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refusing to back up');
    expect(d.files['/p/.claude/settings.json']).toBe('{}\n');
    const outside = fakeDeps(seed({ '/p/.claude/settings.json': '{}\n' }));
    const real = outside.resolvePath;
    outside.resolvePath = (b, p) => (p.startsWith('written/') ? '/evil/copy' : real(b, p));
    const r2 = installHarness('claude-code', flagsFor('claude-code'), outside);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain('refusing to record a copy');
  });

  it('refuses an install-record entry it is not rewriting', () => {
    const d = fakeDeps(seed());
    installHarness('claude-code', flagsFor('claude-code'), d);
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    const rec = JSON.parse(d.files[manifest]);
    rec.files.push({ path: '/p/extra.txt', action: 'create', backup: null, written: '/p/.speckl/harness-install/written/claude-code/extra' });
    rec.mac = d.mac!(KEY, installRecordPayload('claude-code', rec.files));
    d.files[manifest] = JSON.stringify(rec) + '\n';
    d.files['/p/.claude/settings.json'] += '\n';
    const settings = d.files['/p/.claude/settings.json'];
    const record = d.files[manifest];
    const refused = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('not rewriting');
    expect(d.files['/p/.claude/settings.json']).toBe(settings);
    expect(d.files[manifest]).toBe(record);
    const dry = installHarness('claude-code', { ...flagsFor('claude-code'), 'dry-run': 'true' }, d);
    expect(dry.code).toBe(1);
    expect(d.files[manifest]).toBe(record);
    rec.files = [null];
    delete rec.mac;
    d.files[manifest] = JSON.stringify(rec) + '\n';
    const noKey = installHarness('claude-code', { project: '.', state: '.speckl/state.json' }, d);
    expect(noKey.stderr).toContain('an entry with no path');
    expect(d.files['/p/.claude/settings.json']).toBe(settings);
  });

  it('refuses a record whose mac does not match the state key and writes nothing', () => {
    const d = fakeDeps(seed());
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    const settings = d.files['/p/.claude/settings.json'];
    const rec = JSON.parse(d.files[manifest]);
    rec.mac = 'ab'.repeat(32);
    d.files[manifest] = JSON.stringify(rec) + '\n';
    const stale = d.files[manifest];
    let r = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mac does not match');
    expect(r.stderr).not.toContain(rec.mac);
    expect(d.files['/p/.claude/settings.json']).toBe(settings);
    expect(d.files[manifest]).toBe(stale);
    delete rec.mac;
    d.files[manifest] = JSON.stringify(rec) + '\n';
    r = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(r.stderr).toContain('mac does not match');
    expect(d.files['/p/.claude/settings.json']).toBe(settings);
    const bare = fakeDeps(seed());
    delete bare.mac;
    expect(installHarness('claude-code', flagsFor('claude-code'), bare).stderr).toContain('cannot be authenticated');
    expect(bare.files['/p/.claude/settings.json']).toBeUndefined();
    const unsigned = fakeDeps(seed());
    unsigned.mac = () => null;
    expect(installHarness('claude-code', flagsFor('claude-code'), unsigned).stderr).toContain('could not authenticate');
    expect(unsigned.files['/p/.speckl/harness-install/claude-code.json']).toBeUndefined();
    const weak = fakeDeps(seed({ '/k/state.key': 'not-a-key\n' }));
    const weakOut = installHarness('claude-code', flagsFor('claude-code'), weak);
    expect(weakOut.code).toBe(1);
    expect(weakOut.stderr).toContain('not 64 hex');
    expect(weakOut.stderr).not.toContain('not-a-key');
    expect(weak.files['/p/.speckl/harness-install/claude-code.json']).toBeUndefined();
    expect(weak.files['/p/.claude/settings.json']).toBeUndefined();
    const signed = fakeDeps(seed());
    expect(installHarness('claude-code', flagsFor('claude-code'), signed).code).toBe(0);
    const signedSettings = signed.files['/p/.claude/settings.json'];
    delete signed.mac;
    expect(installHarness('claude-code', flagsFor('claude-code'), signed).stderr).toContain('cannot be authenticated');
    expect(signed.files['/p/.claude/settings.json']).toBe(signedSettings);
    signed.mac = () => null;
    expect(uninstallHarness('claude-code', un, signed).stderr).toContain('mac does not match');
    expect(signed.files['/p/.claude/settings.json']).toBe(signedSettings);
    const dropped = fakeDeps(seed());
    expect(installHarness('claude-code', flagsFor('claude-code'), dropped).code).toBe(0);
    const droppedRecord = dropped.files['/p/.speckl/harness-install/claude-code.json'];
    dropped.files['/p/.claude/settings.json'] += ' ';
    const tweaked = dropped.files['/p/.claude/settings.json'];
    const sign = dropped.mac!.bind(dropped);
    dropped.mac = (key, text) => { delete dropped.mac; return sign(key, text); };
    const left = uninstallHarness('claude-code', un, dropped);
    expect(left.stderr).toContain('left the previous record in place');
    expect(dropped.files['/p/.speckl/harness-install/claude-code.json']).toBe(droppedRecord);
    expect(dropped.files['/p/.claude/settings.json']).toBe(tweaked);
  });
});

describe('status and doctor failures', () => {
  function installed(over: Record<string, string> = {}) {
    const d = fakeDeps(seed(over));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    return d;
  }
  const flags = flagsFor('claude-code');

  it('reports a missing hook without running a command', () => {
    const d = fakeDeps(seed());
    const r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, d, {}, true);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('HOOK MISSING');
    expect(r.stdout).toContain('probe: not run');
    expect(d.commands).toHaveLength(0);
  });

  it('reports fail-open, a wrapper exit, and a missing binary', () => {
    const open = installed();
    open.runCommand = () => ({ status: 0, stdout: '', stderr: 'unmapped harness tool "__speckl_doctor__"' });
    const state = open.files['/p/.speckl/state.json'];
    let r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, open, {}, true);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL OPEN');
    expect(open.files['/p/.speckl/state.json']).toBe(state);
    const wrapped = installed();
    wrapped.runCommand = () => ({ status: 2, stdout: '', stderr: 'wrapper only\n' });
    r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, wrapped, {}, true);
    expect(r.stdout).toContain('NOT PROVED');
    expect(r.code).toBe(1);
    const missing = installed();
    missing.runCommand = () => ({ status: null, stdout: '', stderr: 'Error: spawn node ENOENT\n' });
    r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, missing, {}, true);
    expect(r.stdout).toContain('HOOK MISSING');
    const noRun = installed();
    delete (noRun as { runCommand?: unknown }).runCommand;
    r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, noRun, {}, true);
    expect(r.stdout).toContain('NOT RUN');
    expect(r.code).toBe(1);
  });

  it('Cline cancel:false and a plugin allow are fail-open even when the marker is present', () => {
    const marker = 'unmapped harness tool "__speckl_doctor__"';
    const cline = fakeDeps(seed());
    expect(installHarness('cline', flagsFor('cline'), cline).code).toBe(0);
    cline.runCommand = () => ({ status: 0, stdout: '{"cancel":false}\n', stderr: marker });
    expect(inspectHarness('cline', flagsFor('cline'), config.harness.cline.rules, config, cline, {}, true).stdout).toContain('FAIL OPEN');
    const pi = fakeDeps(seed());
    expect(installHarness('pi', flagsFor('pi'), pi).code).toBe(0);
    pi.runCommand = () => ({ status: 0, stdout: '{"decision":"allow"}\n', stderr: marker });
    expect(inspectHarness('pi', flagsFor('pi'), config.harness.pi.rules, config, pi, {}, true).stdout).toContain('FAIL OPEN');
  });

  it('exit 0 with the deny text but without the harness block field is fail-open', () => {
    const marker = 'unmapped harness tool "__speckl_doctor__"';
    const cases: { h: string; stdout: string }[] = [
      { h: 'cline', stdout: JSON.stringify({ errorMessage: marker }) + '\n' },
      { h: 'cline', stdout: JSON.stringify({ cancel: 'true', errorMessage: marker }) + '\n' },
      { h: 'pi', stdout: JSON.stringify({ reason: marker }) + '\n' },
      { h: 'pi', stdout: JSON.stringify({ decision: 'deny', reason: marker }) + '\n' },
      { h: 'opencode', stdout: JSON.stringify({ decision: 'allow', reason: marker }) + '\n' },
      { h: 'opencode', stdout: '{"decision":"block","reason":"' + marker + '"}\n' },
      { h: 'openclaw', stdout: '{}\n' },
      { h: 'openclaw', stdout: JSON.stringify({ decision: 'deny' }) + '\n' },
      { h: 'cursor', stdout: JSON.stringify({ user_message: marker, agent_message: marker }) + '\n' },
      { h: 'cursor', stdout: JSON.stringify({ permission: 'allow' }) + '\n' },
    ];
    for (const c of cases) {
      const d = fakeDeps(seed());
      expect(installHarness(c.h, flagsFor(c.h), d).code, c.h).toBe(0);
      d.runCommand = () => ({ status: 0, stdout: c.stdout, stderr: marker + '\n' });
      const r = inspectHarness(c.h, flagsFor(c.h), config.harness[c.h].rules, config, d, {}, true);
      expect(r.code, c.h + ' ' + c.stdout + r.stdout).toBe(1);
      expect(r.stdout, c.h + ' ' + c.stdout).toContain('FAIL OPEN');
    }
  });

  it('Hermes without an allowlist entry is fail-open and is not probed', () => {
    const d = fakeDeps(seed());
    expect(installHarness('hermes', flagsFor('hermes'), d).code).toBe(0);
    d.files['/h/shell-hooks-allowlist.json'] = '{"approvals":[]}\n';
    const r = inspectHarness('hermes', flagsFor('hermes'), config.harness.hermes.rules, config, d, {}, true);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL OPEN');
    expect(r.stdout).toContain('probe: not run');
    expect(d.commands).toHaveLength(0);
    d.files['/h/shell-hooks-allowlist.json'] = '{';
    expect(inspectHarness('hermes', flagsFor('hermes'), config.harness.hermes.rules, config, d, {}, true).stdout).toContain('FAIL OPEN');
    delete d.files['/h/config.yaml'];
    expect(inspectHarness('hermes', flagsFor('hermes'), config.harness.hermes.rules, config, d, {}, true).stdout).toContain('HOOK MISSING');
  });

  it('uses a later Windsurf file when the first is not JSON, and reads a relative plugin argv', () => {
    const d = fakeDeps(seed());
    expect(installHarness('windsurf', flagsFor('windsurf'), d).code).toBe(0);
    d.files['/p/.devin/hooks.json'] = '{';
    const r = inspectHarness('windsurf', flagsFor('windsurf'), config.harness.windsurf.rules, config, d, {}, true);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('config: ok /p/.windsurf/hooks.json');
    d.files['/p/.windsurf/hooks.json'] = '{';
    expect(inspectHarness('windsurf', flagsFor('windsurf'), config.harness.windsurf.rules, config, d, {}, false).stdout).toContain('is not valid JSON');
    const pi = fakeDeps(seed());
    pi.files['/p/.pi/extensions/speckl.js'] = [
      '// Generated by speckl adapter.mjs install pi; do not edit (rerun install).',
      'const ARGV = [resolve(ROOT, ".speckl/agent/adapter.mjs"), "--state", resolve(ROOT, ".speckl/state.json")];',
    ].join('\n');
    const doc = inspectHarness('pi', flagsFor('pi'), config.harness.pi.rules, config, pi, {}, true);
    expect(doc.code, doc.stdout + doc.stderr).toBe(0);
    expect(pi.commands[0].command).toBe('node /p/.speckl/agent/adapter.mjs pi pre --state /p/.speckl/state.json');
    pi.commands.length = 0;
    pi.files['/p/.pi/extensions/speckl.js'] = '// Generated by speckl adapter.mjs install pi\nconst ARGV = ["C:\\\\agent\\\\adapter.mjs", "--state", "C:\\\\state.json", "--outside", "allow"];\n';
    const win = inspectHarness('pi', flagsFor('pi'), config.harness.pi.rules, config, pi, {}, true);
    expect(win.code, win.stdout + win.stderr).toBe(0);
    expect(pi.commands[0].command).toContain('"C:\\\\agent\\\\adapter.mjs"');
    expect(pi.commands[0].command).toContain('--outside allow');
    expect(pi.commands[0].command).not.toContain('/p/C:');
    pi.files['/p/.pi/extensions/speckl.js'] = '// Generated by speckl adapter.mjs install pi\nconst ARGV = ["\\q"];\n';
    expect(inspectHarness('pi', flagsFor('pi'), config.harness.pi.rules, config, pi, {}, true).stdout).toContain('HOOK MISSING');
    pi.files['/p/.pi/extensions/speckl.js'] = '// Generated by speckl adapter.mjs install pi\nconst ARGV = [];\n';
    expect(inspectHarness('pi', flagsFor('pi'), config.harness.pi.rules, config, pi, {}, true).stdout).toContain('HOOK MISSING');
  });

  it('checks the key and the state without printing the key', () => {
    const secret = 'SECRET-not-hex';
    // Install does not take this file as --key: a non-hex key is refused.
    // Status is what reports it, and it must not print the bytes.
    const d = fakeDeps(seed({ '/k/state.key': secret }));
    expect(installHarness('claude-code', { project: '.', state: '.speckl/state.json' }, d).code).toBe(0);
    let r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, d, {}, false);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('not 64 hex characters');
    expect(r.stdout).not.toContain('SECRET');
    expect(r.stderr).not.toContain('SECRET');
    delete d.files['/k/state.key'];
    r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, d, {}, false);
    expect(r.stdout).toContain('key: MISSING <keyfile>');
    expect(r.stdout).not.toContain('/k/state.key');
    const inside = installed({ '/p/.speckl/secret.key': KEY });
    r = inspectHarness('claude-code', { ...flags, key: '.speckl/secret.key' }, config.harness['claude-code'].rules, config, inside, {}, false);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain('WARN: the state key is inside the project');
    expect(r.stdout).toContain('(inside the project)');
    const dev = fakeDeps(seed({ '/p/.speckl/state.json': stateBody({ dev: true, mac: undefined }) }));
    delete dev.files['/k/state.key'];
    installHarness('claude-code', { project: '.', state: '.speckl/state.json' }, dev);
    r = inspectHarness('claude-code', { project: '.', state: '.speckl/state.json' }, config.harness['claude-code'].rules, config, dev, {}, false);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('key: none (dev state');
    expect(r.stdout).toContain('mac=absent');
    const envKey = installed();
    r = inspectHarness('claude-code', { project: '.', state: '.speckl/state.json' }, config.harness['claude-code'].rules, config, envKey, { SPECKL_STATE_KEY_FILE: '/k/state.key' }, false);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('key: present <keyfile>');
    expect(r.stdout).not.toContain('/k/state.key');
    const noKey = installed();
    r = inspectHarness('claude-code', { project: '.', state: '.speckl/state.json' }, config.harness['claude-code'].rules, config, noKey, {}, false);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('key: MISSING (pass --key');
  });

  it('redacts a symlinked key path, its real directory, and the key bytes', () => {
    const real = '/real/secret-dir/state.key';
    const d = fakeDeps(seed());
    d.files[real] = KEY;
    d.links['/k/state.key'] = real;
    const r = inspectHarness('claude-code', flags, config.harness['claude-code'].rules, config, d, {}, false);
    const shown = r.stdout + r.stderr;
    expect(shown).toContain('key: present <keyfile>');
    expect(shown).toContain('/p/.speckl/state.json');
    expect(shown).not.toContain('/k/state.key');
    expect(shown).not.toContain(real);
    expect(shown).not.toContain('/real/secret-dir');
    expect(shown).not.toContain(KEY.trim());
    const b64 = Buffer.from(KEY.trim(), 'hex').toString('base64');
    expect(shown).not.toContain(b64);
    const short = fakeDeps(seed());
    const missing = inspectHarness('claude-code', { project: '.', state: '.speckl/state.json', key: 'ab' }, config.harness['claude-code'].rules, config, short, {}, false);
    const text = missing.stdout + missing.stderr;
    expect(text).not.toContain('/p/ab');
    expect(text).not.toMatch(/(^|[\s"'=:])ab($|[\s"'=:])/m);
    expect(text).toContain('<keyfile>');
    expect(text).toContain('/p/.speckl/state.json');
  });

  it('rejects a state file that is not a signed run', () => {
    const d = installed();
    d.files['/p/.speckl/state.json'] = '{';
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('not a JSON object');
    d.files['/p/.speckl/state.json'] = '[]';
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('not a JSON object');
    d.files['/p/.speckl/state.json'] = '{"log":[],"machine":{}}';
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('missing runId');
    delete d.files['/p/.speckl/state.json'];
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('state: MISSING');
    d.files['/p/.speckl/state.json'] = stateBody({ mac: 'abcd', pending: { tool: 'run_tests' } });
    const badMac = inspectHarness('claude-code', flags, [], config, d, {}, false);
    expect(badMac.stdout).toContain('mac=MISSING on a non-dev state');
    expect(badMac.stdout).toContain('pending=run_tests');
    expect(badMac.code).toBe(1);
    d.files['/p/.speckl/state.json'] = stateBody({ machine: { stage: 'later' } });
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('stage=later');
    d.files['/p/.speckl/state.json'] = stateBody({ machine: {} });
    expect(inspectHarness('claude-code', flags, [], config, d, {}, false).stdout).toContain('stage=(absent)');
  });

  it('usage names the command and the hermes home', () => {
    const d = fakeDeps();
    expect(runAdapter(['doctor', 'claude-code'], {}, '', config, d).stderr).toContain('usage: adapter.mjs doctor claude-code');
    expect(runAdapter(['status', 'hermes', '--project', '.'], {}, '', config, d).stderr).toContain('--hermes-home');
    expect(runAdapter(['uninstall', 'claude-code'], {}, '', config, d).stderr).toContain('usage: adapter.mjs uninstall');
    expect(runAdapter(['install', 'nope'], {}, '', config, d).stderr).toContain('undeclared harness');
    expect(runAdapter(['doctor', 'nope'], {}, '', config, d).stderr).toContain('undeclared harness');
    expect(installHarness('claude-code', { ...flags, 'dry-run': 'true', key: '/p/k.key' }, fakeDeps(seed({ '/p/k.key': KEY }))).stderr).toContain('inside the project');
  });
});

describe('uninstall', () => {
  it('restores a modified file, deletes created files, and leaves everything else', () => {
    const original = '{"permissions":{"allow":["Bash(npm test)"]}}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original, '/p/notes.txt': 'keep\n' }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    expect(installHarness('cline', flagsFor('cline'), d).code).toBe(0);
    const installed = d.files['/p/.claude/settings.json'];
    expect(installed).not.toBe(original);
    d.files['/p/.claude/settings.json'] = installed + ' ';
    let r = uninstallHarness('claude-code', { project: '.' }, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mac does not match');
    expect(d.files['/p/.claude/settings.json']).toBe(installed + ' ');
    r = uninstallHarness('claude-code', un, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no longer match');
    expect(r.stderr).toContain('install record kept');
    expect(d.files['/p/.claude/settings.json']).toBe(installed + ' ');
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeTruthy();
    d.files['/p/.claude/settings.json'] = installed;
    r = uninstallHarness('claude-code', un, d);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('restored /p/.claude/settings.json');
    expect(r.stdout).toContain('removed install record');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files['/p/notes.txt']).toBe('keep\n');
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeUndefined();
    const pre = '/p/.clinerules/hooks/PreToolUse';
    delete d.files[pre];
    r = uninstallHarness('cline', un, d);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('already absent ' + pre);
    expect(d.files['/p/.clinerules/hooks/PostToolUse']).toBeUndefined();
    expect(d.files['/p/notes.txt']).toBe('keep\n');
    expect(uninstallHarness('cline', { project: '.' }, d).stderr).toContain('no install record');
    expect(d.files['/p/notes.txt']).toBe('keep\n');
  });

  it('finishes a restore that already happened when an earlier attempt could not delete the backup', () => {
    const original = '{}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const backup = JSON.parse(d.files['/p/.speckl/harness-install/claude-code.json']).files[0].backup as string;
    let blocked = true;
    d.removeFile = p => {
      if (blocked && p === backup) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    const first = uninstallHarness('claude-code', un, d);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain('restored /p/.claude/settings.json');
    expect(first.stderr).toContain('could not remove backup');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeTruthy();
    blocked = false;
    const second = uninstallHarness('claude-code', un, d);
    expect(second.code, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain('already restored');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files[backup]).toBeUndefined();
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeUndefined();
  });

  it('refuses to delete a path it did not create, a missing copy, or a file this runtime cannot remove', () => {
    const neighbor = '/p/notes.txt';
    const root = '/p/.speckl/harness-install';
    const manifest = root + '/claude-code.json';
    const written = root + '/written/claude-code/settings';
    const base = () => fakeDeps(seed({
      [neighbor]: 'keep\n',
      '/p/.claude/settings.json': 'installed\n',
      [written]: 'installed\n',
      '/p/.speckl/agent/hook.mjs': 'runtime\n',
    }));
    const put = (d: ReturnType<typeof base>, files: unknown, signed = false) => {
      const body: { v: number; harness: string; files: unknown; mac?: string } = { v: 1, harness: 'claude-code', files };
      if (signed) body.mac = d.mac!(KEY, installRecordPayload('claude-code', files))!;
      d.files[manifest] = JSON.stringify(body) + '\n';
    };
    let d = base();
    put(d, [{ path: '/p/.speckl/agent/hook.mjs', action: 'create', backup: null, written }]);
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('not a file install writes');
    expect(d.files['/p/.speckl/agent/hook.mjs']).toBe('runtime\n');
    expect(d.files[neighbor]).toBe('keep\n');
    d = base();
    put(d, [{ path: root + '/planted', action: 'create', backup: null, written }]);
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('not a file install writes');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'create', backup: null, written: '/evil/copy' }], true);
    expect(uninstallHarness('claude-code', un, d).stderr).toContain('outside');
    expect(d.files['/p/.claude/settings.json']).toBe('installed\n');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'modify', backup: '/evil/bak', written }], true);
    expect(uninstallHarness('claude-code', un, d).stderr).toContain('outside');
    d = base();
    put(d, [{ nope: true }]);
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('does not understand');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'modify', backup: null, written }], true);
    expect(uninstallHarness('claude-code', un, d).stderr).toContain('no backup path');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'modify', backup: root + '/backups/claude-code/missing', written }], true);
    expect(uninstallHarness('claude-code', un, d).stderr).toContain('backup missing');
    expect(d.files['/p/.claude/settings.json']).toBe('installed\n');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'create', backup: null, written: root + '/written/claude-code/gone' }], true);
    expect(uninstallHarness('claude-code', un, d).stderr).toContain('saved copy');
    d = base();
    d.files[manifest] = '{';
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('not valid JSON');
    d.files[manifest] = '{"v":1,"harness":"other","files":[]}\n';
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('not a Speckl install record');
    expect(d.files[neighbor]).toBe('keep\n');
    d = base();
    put(d, [{ path: '/p/.claude/settings.json', action: 'create', backup: null, written }]);
    delete d.removeFile;
    expect(uninstallHarness('claude-code', { project: '.' }, d).stderr).toContain('cannot remove files');
    expect(d.files['/p/.claude/settings.json']).toBe('installed\n');
    expect(d.files[manifest]).toBeTruthy();
  });

  it('keeps the record when a remove fails, and retries once the file can be removed', () => {
    const d = fakeDeps(seed());
    expect(installHarness('cline', flagsFor('cline'), d).code).toBe(0);
    const pre = '/p/.clinerules/hooks/PreToolUse';
    d.removeFile = p => {
      if (p === pre) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    const r = uninstallHarness('cline', un, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not remove ' + pre);
    expect(d.files[pre]).toBeTruthy();
    expect(d.files['/p/.speckl/harness-install/cline.json']).toBeTruthy();
    d.removeFile = p => { if (p in d.files) { delete d.files[p]; return true; } return false; };
    const again = uninstallHarness('cline', un, d);
    expect(again.code, again.stderr).toBe(0);
    expect(d.files[pre]).toBeUndefined();
  });

  it('does not claim a restore that did not land, and reports a record it could not delete', () => {
    const original = '{}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const installed = d.files['/p/.claude/settings.json'];
    const write = d.writeFile.bind(d);
    d.writeFile = (p, text, mode) => { if (p === '/p/.claude/settings.json') return; write(p, text, mode); };
    const failed = uninstallHarness('claude-code', un, d);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('restore failed');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeTruthy();
    d.writeFile = write;
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    d.removeFile = p => {
      if (p === manifest) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    const kept = uninstallHarness('claude-code', un, d);
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain('could not remove install record');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files[manifest]).toBeTruthy();
    // The backup and the saved copy were already removed. A retry must not
    // overwrite the restored file, and it must not drop the record: without
    // the backup it can no longer prove what belonged there.
    d.removeFile = p => { if (p in d.files) { delete d.files[p]; return true; } return false; };
    const retry = uninstallHarness('claude-code', un, d);
    expect(retry.code).toBe(1);
    expect(retry.stderr).toContain('backup missing');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files[manifest]).toBeTruthy();
  });

  it('puts a modified file back when it has gone missing, and skips a saved copy it cannot delete', () => {
    const original = '{}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const rec = JSON.parse(d.files['/p/.speckl/harness-install/claude-code.json']);
    d.files['/p/.claude/.keep'] = '';
    delete d.files['/p/.claude/settings.json'];
    let blocked = true;
    d.removeFile = p => {
      if (blocked && p === rec.files[0].written) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    const first = uninstallHarness('claude-code', un, d);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain('restored /p/.claude/settings.json');
    expect(first.stderr).toContain('could not remove saved copy');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    blocked = false;
    expect(uninstallHarness('claude-code', un, d).code).toBe(0);
    expect(d.files['/p/.claude/settings.json']).toBe(original);
  });

  it('does not delete or restore a path the record invented', () => {
    const root = '/p/.speckl/harness-install';
    const outside = '/outside/victim';
    const secret = '/outside/secret';
    const notes = '/p/notes.txt';
    const d = fakeDeps(seed({
      [outside]: 'secret\n',
      [secret]: 'safe\n',
      [notes]: 'keep\n',
      '/p/.claude/settings.json': '{}\n',
    }));
    const written = root + '/written/claude-code/planted';
    const backup = root + '/backups/claude-code/planted';
    d.files[written] = 'secret\n';
    d.files[backup] = 'pwned\n';
    const manifest = root + '/claude-code.json';
    const put = (files: unknown, mac?: string) => {
      const body: { v: number; harness: string; files: unknown; mac?: string } = { v: 1, harness: 'claude-code', files };
      if (mac) body.mac = mac;
      d.files[manifest] = JSON.stringify(body) + '\n';
    };
    put([{ path: outside, action: 'create', backup: null, written }]);
    let r = uninstallHarness('claude-code', { project: '.' }, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('outside the project');
    expect(d.files[outside]).toBe('secret\n');
    expect(d.files[written]).toBe('secret\n');
    put([{ path: secret, action: 'modify', backup, written }]);
    d.files[written] = 'safe\n';
    r = uninstallHarness('claude-code', { project: '.' }, d);
    expect(r.stderr).toContain('outside the project');
    expect(d.files[secret]).toBe('safe\n');
    expect(d.files[backup]).toBe('pwned\n');
    const owned = [{ path: notes, action: 'create', backup: null, written }];
    d.files[written] = 'keep\n';
    const noteMac = d.mac!(KEY, installRecordPayload('claude-code', owned));
    put(owned, noteMac ?? undefined);
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('not a file install writes');
    expect(d.files[notes]).toBe('keep\n');
    delete d.files[manifest];
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const installed = d.files['/p/.claude/settings.json'];
    d.links['/p/.claude'] = '/somewhere';
    r = uninstallHarness('claude-code', un, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('a parent directory is a symlink');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    delete d.links['/p/.claude'];
    d.links['/p/.claude/settings.json'] = '/tmp/elsewhere';
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('the path is a symlink');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    delete d.links['/p/.claude/settings.json'];
    const real = d.realPath!.bind(d);
    d.realPath = p => (p === '/p/.claude/settings.json' ? '/outside/settings.json' : real(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('resolves outside the project');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    d.realPath = p => (p === '/p/.claude/settings.json' ? '/p/.claude-real/settings.json' : real(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('a parent directory is a symlink');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    d.realPath = real;
    const dir = d.dirname.bind(d);
    d.dirname = p => (p === '/p/.claude' ? '/p/.claude' : dir(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('outside the project');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    d.dirname = dir;
    const kind = d.lstatKind!.bind(d);
    d.lstatKind = p => (p === '/p/.claude/settings.json' ? 'dir' : kind(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('not a regular file');
    d.lstatKind = p => (p === '/p/.claude' ? 'file' : kind(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('a parent is not a directory');
    d.lstatKind = p => (p === '/p' ? 'missing' : kind(p));
    d.realPath = p => (p === '/p' ? null : real(p));
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('the project cannot be resolved');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    delete d.lstatKind;
    delete d.realPath;
    r = uninstallHarness('claude-code', un, d);
    expect(r.stderr).toContain('cannot resolve the path');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
  });

  it('refuses a Hermes profile outside the project even when the path is one install writes', () => {
    const d = fakeDeps(seed());
    expect(installHarness('hermes', flagsFor('hermes'), d).code).toBe(0);
    const yaml = d.files['/h/config.yaml'];
    const r = uninstallHarness('hermes', { ...un, 'hermes-home': '/h' }, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('outside the project');
    expect(d.files['/h/config.yaml']).toBe(yaml);
    expect(d.files['/p/.speckl/harness-install/hermes.json']).toBeTruthy();
  });

  it('leaves the previous record in place when the remaining entries cannot be re-signed', () => {
    const d = fakeDeps(seed());
    expect(installHarness('cline', flagsFor('cline'), d).code).toBe(0);
    const manifest = '/p/.speckl/harness-install/cline.json';
    const before = d.files[manifest];
    const pre = '/p/.clinerules/hooks/PreToolUse';
    const sign = d.mac!.bind(d);
    d.mac = (key, text) => {
      const body = JSON.parse(text) as { files: { path: string }[] };
      if (body.files.length === 1) return null;
      return sign(key, text);
    };
    d.removeFile = p => {
      if (p === pre) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    const r = uninstallHarness('cline', un, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('left the previous record in place');
    expect(d.files[manifest]).toBe(before);
    expect(d.files[pre]).toBeTruthy();
  });

  it('does not restore a modify when the mac has been stripped and no key is passed', () => {
    const original = '{"permissions":{}}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    const installed = d.files['/p/.claude/settings.json'];
    const rec = JSON.parse(d.files[manifest]);
    const evil = '/p/.speckl/harness-install/backups/claude-code/evil';
    d.files[evil] = 'PWNED\n';
    delete rec.mac;
    rec.files[0].backup = evil;
    d.files[manifest] = JSON.stringify(rec) + '\n';
    const r = uninstallHarness('claude-code', { project: '.' }, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('re-run with --key');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    expect(d.files[evil]).toBe('PWNED\n');
  });

  it('refuses a --key that is not 64 hex, and an unsigned modify backup is not applied', () => {
    const original = '{"permissions":{}}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original, '/k/state.key': 'not-a-key\n' }));
    const refused = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('not 64 hex');
    expect(refused.stderr).not.toContain('not-a-key');
    expect(d.files['/p/.claude/settings.json']).toBe(original);
    expect(d.files['/p/.speckl/harness-install/claude-code.json']).toBeUndefined();
    delete d.files['/k/state.key'];
    const missing = installHarness('claude-code', flagsFor('claude-code'), d);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('is missing');
    expect(d.files['/p/.claude/settings.json']).toBe(original);

    // The unsigned record a non-hex --key used to leave behind, with a planted backup.
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    const evil = '/p/.speckl/harness-install/backups/claude-code/evil';
    const written = '/p/.speckl/harness-install/written/claude-code/settings';
    d.files[evil] = 'PWNED\n';
    d.files[written] = 'installed\n';
    d.files['/p/.claude/settings.json'] = 'installed\n';
    d.files[manifest] = JSON.stringify({
      v: 1, harness: 'claude-code',
      files: [{ path: '/p/.claude/settings.json', action: 'modify', backup: evil, written }],
    }) + '\n';
    const planted = uninstallHarness('claude-code', { project: '.' }, d);
    expect(planted.code).toBe(1);
    expect(planted.stderr).toContain('re-run with --key');
    expect(d.files['/p/.claude/settings.json']).toBe('installed\n');
    expect(d.files[evil]).toBe('PWNED\n');

    delete d.files[manifest];
    delete d.files[evil];
    delete d.files[written];
    d.files['/p/.claude/settings.json'] = original;
    const flags = { project: '.', state: '.speckl/state.json' };
    const dry = installHarness('claude-code', { ...flags, 'dry-run': 'true' }, d);
    expect(dry.code).toBe(0);
    expect(dry.stderr).toContain('WARN: the install record is unsigned');
    expect(d.files[manifest]).toBeUndefined();
    const inst = installHarness('claude-code', flags, d);
    expect(inst.code, inst.stderr).toBe(0);
    expect(inst.stderr).toContain('WARN: the install record is unsigned');
    const rec = JSON.parse(d.files[manifest]);
    expect(rec.mac).toBeUndefined();
    const installed = d.files['/p/.claude/settings.json'];
    d.files[evil] = 'PWNED\n';
    rec.files[0].backup = evil;
    d.files[manifest] = JSON.stringify(rec) + '\n';
    const u = uninstallHarness('claude-code', { project: '.' }, d);
    expect(u.stderr).toContain('re-run with --key');
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    expect(d.files[evil]).toBe('PWNED\n');
  });

  it('refuses a stripped record when the correct key is passed', () => {
    const original = '{"permissions":{}}\n';
    const d = fakeDeps(seed({ '/p/.claude/settings.json': original }));
    expect(installHarness('claude-code', flagsFor('claude-code'), d).code).toBe(0);
    const manifest = '/p/.speckl/harness-install/claude-code.json';
    const installed = d.files['/p/.claude/settings.json'];
    const rec = JSON.parse(d.files[manifest]);
    const want = d.mac!(KEY, installRecordPayload('claude-code', rec.files))!;
    expect(rec.mac).toBe(want);
    delete rec.mac;
    const stripped = JSON.stringify(rec) + '\n';
    d.files[manifest] = stripped;
    const r = uninstallHarness('claude-code', un, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mac does not match');
    expect(r.stderr).not.toContain(want);
    expect(d.files['/p/.claude/settings.json']).toBe(installed);
    expect(d.files[manifest]).toBe(stripped);
  });

  it('deletes an unsigned create only when the bytes match a fresh install', () => {
    const flags = { project: '.', state: '.speckl/state.json' };
    const hooks = '/p/.cursor/hooks.json';
    const manifest = '/p/.speckl/harness-install/cursor.json';
    const install = () => {
      const d = fakeDeps(seed());
      const r = installHarness('cursor', flags, d);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('unsigned');
      expect(JSON.parse(d.files[manifest]).mac).toBeUndefined();
      return d;
    };
    let d = install();
    const generated = d.files[hooks];
    const written = JSON.parse(d.files[manifest]).files[0].written as string;
    d.files[written] = 'EVIL\n';
    let r = uninstallHarness('cursor', flags, d);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('matched the generated config');
    expect(d.files[hooks]).toBeUndefined();
    expect(d.files[written]).toBeUndefined();
    expect(d.files[manifest]).toBeUndefined();

    d = install();
    const snap = JSON.parse(d.files[manifest]).files[0].written as string;
    d.files[hooks] = 'EVIL\n';
    d.files[snap] = 'EVIL\n';
    r = uninstallHarness('cursor', flags, d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('re-run with --key');
    expect(d.files[hooks]).toBe('EVIL\n');

    d = install();
    const stayed = d.files[hooks];
    r = uninstallHarness('cursor', { project: '.' }, d);
    expect(r.stderr).toContain('re-run with --key');
    expect(d.files[hooks]).toBe(stayed);

    d = install();
    d.files['/p/.cursor/.keep'] = '';
    delete d.files[hooks];
    r = uninstallHarness('cursor', flags, d);
    expect(r.stderr).toContain('re-run with --key');
    expect(d.files[hooks]).toBeUndefined();

    d = install();
    const rec = JSON.parse(d.files[manifest]);
    const outside = '/evil/copy';
    d.files[outside] = 'NO\n';
    rec.files[0].written = outside;
    d.files[manifest] = JSON.stringify(rec) + '\n';
    r = uninstallHarness('cursor', flags, d);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(d.files[hooks]).toBeUndefined();
    expect(d.files[outside]).toBe('NO\n');
    expect(generated).toContain('adapter.mjs');

    d = install();
    const body = JSON.parse(d.files[manifest]);
    body.files.push({ path: '/p/notes.txt', action: 'create', backup: null, written: body.files[0].written });
    d.files['/p/notes.txt'] = 'keep\n';
    d.files[manifest] = JSON.stringify(body) + '\n';
    const before = d.files[hooks];
    r = uninstallHarness('cursor', flags, d);
    expect(r.stderr).toContain('re-run with --key');
    expect(d.files[hooks]).toBe(before);
    expect(d.files['/p/notes.txt']).toBe('keep\n');

    d = install();
    const blocked = d.files[hooks];
    d.removeFile = p => {
      if (p === hooks) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    r = uninstallHarness('cursor', flags, d);
    expect(r.stderr).toContain('could not remove ' + hooks);
    expect(d.files[hooks]).toBe(blocked);

    d = install();
    const snap2 = JSON.parse(d.files[manifest]).files[0].written as string;
    d.removeFile = p => {
      if (p === snap2) return false;
      if (!(p in d.files)) return false;
      delete d.files[p];
      return true;
    };
    r = uninstallHarness('cursor', flags, d);
    expect(r.stderr).toContain('could not remove saved copy');
    expect(d.files[hooks]).toBeUndefined();
    expect(d.files[snap2]).toBeTruthy();
    expect(d.files[manifest]).toBeTruthy();
  });
});

describe('emitted adapter.mjs', () => {
  it('dry-run, install, doctor, fail-open, and uninstall round-trip on disk', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'speckl-setup-'));
    const project = path.join(parent, 'proj');
    const hermesHome = path.join(parent, 'hermes-home');
    const key = path.join(parent, 'state.key');
    mkdirSync(path.join(project, '.speckl', 'agent'), { recursive: true });
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    mkdirSync(hermesHome, { recursive: true });
    const adapter = path.join(project, '.speckl', 'agent', 'adapter.mjs');
    writeFileSync(adapter, emitAdapterMjs('Setup', [...HARNESSES]));
    const checked = spawnSync(process.execPath, ['--check', adapter], { encoding: 'utf-8' });
    expect(checked.status, checked.stderr).toBe(0);
    writeFileSync(path.join(project, '.speckl', 'agent', 'agent-config.json'), JSON.stringify(config, null, 2) + '\n');
    const statePath = path.join(project, '.speckl', 'state.json');
    const state = stateBody() + '\n';
    writeFileSync(statePath, state);
    writeFileSync(key, KEY);
    const original = '{"permissions":{"allow":["Bash(npm test)"]}}\n';
    const settings = path.join(project, '.claude', 'settings.json');
    writeFileSync(settings, original);
    writeFileSync(path.join(project, 'notes.txt'), 'keep\n');
    writeFileSync(path.join(hermesHome, 'config.yaml'), 'model: x\n');
    writeFileSync(path.join(hermesHome, 'shell-hooks-allowlist.json'), '{"approvals":[]}\n');
    const run = (args: string[]) => spawnSync(process.execPath, [adapter, ...args], {
      cwd: project, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '' },
    });
    const common = ['--project', project, '--state', statePath, '--key', key];
    const dry = run(['install', 'claude-code', '--dry-run', ...common]);
    expect(dry.status, dry.stderr + dry.stdout).toBe(0);
    expect(dry.stdout).toContain('modify ');
    expect(dry.stdout).toContain('dry-run: no files written');
    expect(readFileSync(settings, 'utf-8')).toBe(original);
    expect(readFileSync(path.join(project, 'notes.txt'), 'utf-8')).toBe('keep\n');
    const inst = run(['install', 'claude-code', ...common]);
    expect(inst.status, inst.stderr + inst.stdout).toBe(0);
    const manifestPath = path.join(project, '.speckl', 'harness-install', 'claude-code.json');
    const rec = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(readFileSync(rec.files[0].backup, 'utf-8')).toBe(original);
    expect(readFileSync(settings, 'utf-8')).toContain('adapter.mjs');
    const doc = run(['doctor', 'claude-code', ...common]);
    expect(doc.status, doc.stderr + doc.stdout).toBe(0);
    expect(doc.stdout).toContain('probe: denied (');
    expect(doc.stdout).toContain('stage=Approved (1)');
    expect(doc.stdout).not.toContain(KEY.trim());
    expect(readFileSync(statePath, 'utf-8')).toBe(state);
    expect(run(['status', 'claude-code', ...common]).status).toBe(0);

    for (const h of HARNESSES) {
      if (h === 'claude-code') continue;
      const extra = h === 'hermes' ? ['--hermes-home', hermesHome] : [];
      const i = run(['install', h, ...common, ...extra]);
      expect(i.status, h + '\n' + i.stderr + i.stdout).toBe(0);
      const d = run(['doctor', h, ...common, ...extra]);
      expect(d.status, h + '\n' + d.stderr + d.stdout).toBe(0);
      expect(d.stdout, h).toContain('probe: denied (');
      expect(readFileSync(statePath, 'utf-8')).toBe(state);
    }
    expect(readFileSync(path.join(project, '.clinerules', 'hooks', 'PreToolUse'), 'utf-8')).toContain('cline pre');
    expect(readFileSync(path.join(project, '.kiro', 'hooks', 'speckl.json'), 'utf-8')).toContain('|| exit 2');

    const hooked = JSON.parse(readFileSync(settings, 'utf-8'));
    const group = hooked.hooks.PreToolUse.find((g: { hooks?: { command?: string }[] }) => String(g.hooks?.[0]?.command).includes('adapter.mjs'));
    group.hooks[0].command += '; true';
    writeFileSync(settings, JSON.stringify(hooked, null, 2) + '\n');
    const open = run(['doctor', 'claude-code', ...common]);
    expect(open.status).toBe(1);
    expect(open.stdout).toContain('FAIL OPEN');
    expect(readFileSync(statePath, 'utf-8')).toBe(state);
    expect(run(['install', 'claude-code', ...common]).status).toBe(0);
    expect(run(['doctor', 'claude-code', ...common]).status, 'reinstall should repair the hook').toBe(0);

    writeFileSync(settings, readFileSync(settings, 'utf-8') + '\n');
    const tweaked = readFileSync(settings, 'utf-8');
    const refused = run(['uninstall', 'claude-code', '--project', project, '--key', key]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('no longer match');
    expect(readFileSync(settings, 'utf-8')).toBe(tweaked);
    expect(readFileSync(rec.files[0].backup, 'utf-8')).toBe(original);

    const after = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const entry = after.files.find((f: { path: string }) => f.path === settings);
    writeFileSync(settings, readFileSync(entry.written));
    const removed = run(['uninstall', 'claude-code', '--project', project, '--key', key]);
    expect(removed.status, removed.stderr + removed.stdout).toBe(0);
    expect(readFileSync(settings, 'utf-8')).toBe(original);
    expect(readFileSync(path.join(project, 'notes.txt'), 'utf-8')).toBe('keep\n');
    expect(() => readFileSync(manifestPath, 'utf-8')).toThrow();
    const gone = run(['doctor', 'claude-code', ...common]);
    expect(gone.status).toBe(1);
    expect(gone.stdout).toContain('HOOK MISSING');
    const second = run(['uninstall', 'claude-code', '--project', project]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('refusing to delete');
    expect(readFileSync(settings, 'utf-8')).toBe(original);
    expect(readFileSync(path.join(project, 'notes.txt'), 'utf-8')).toBe('keep\n');

    const pi = path.join(project, '.pi', 'extensions', 'speckl.js');
    const real = pi + '.real';
    writeFileSync(real, readFileSync(pi, 'utf-8'));
    rmSync(pi);
    symlinkSync(real, pi);
    const sym = run(['uninstall', 'pi', '--project', project, '--key', key]);
    expect(sym.status).toBe(1);
    expect(sym.stderr).toContain('the path is a symlink');
    expect(readlinkSync(pi)).toBe(real);
    expect(readFileSync(path.join(project, '.speckl', 'harness-install', 'pi.json'), 'utf-8')).toContain('speckl.js');

    expect(run(['install', 'claude-code', ...common]).status).toBe(0);
    const hidden = spawnSync(process.execPath, [adapter, 'doctor', 'claude-code', ...common], {
      cwd: project, encoding: 'utf-8', env: { ...process.env, PATH: '/nonexistent', SPECKL_STATE_KEY_FILE: '' },
    });
    expect(hidden.status, hidden.stdout + hidden.stderr).toBe(1);
    expect(hidden.stdout).toContain('HOOK MISSING');

    const notProvedSettings = JSON.parse(readFileSync(settings, 'utf-8'));
    const g = notProvedSettings.hooks.PreToolUse.find((x: { hooks?: { command?: string }[] }) => String(x.hooks?.[0]?.command).includes('adapter.mjs'));
    g.hooks[0].command = 'sh -c "exit 2" # adapter.mjs claude-code pre';
    writeFileSync(settings, JSON.stringify(notProvedSettings, null, 2) + '\n');
    // The saved copy must match or doctor still runs the command it finds.
    // jsonPre only needs the string to be in the file, which it is.
    const unproved = run(['doctor', 'claude-code', ...common]);
    expect(unproved.status, unproved.stdout + unproved.stderr).toBe(1);
    expect(unproved.stdout).toContain('NOT PROVED');
    expect(readFileSync(statePath, 'utf-8')).toBe(state);

    const claudeDir = path.join(project, '.claude');
    const realDir = claudeDir + '-real';
    const hookedBytes = readFileSync(settings, 'utf-8');
    renameSync(claudeDir, realDir);
    symlinkSync(realDir, claudeDir);
    const symParent = run(['uninstall', 'claude-code', '--project', project, '--key', key]);
    expect(symParent.status, symParent.stderr + symParent.stdout).toBe(1);
    expect(symParent.stderr).toContain('a parent directory is a symlink');
    expect(readFileSync(path.join(realDir, 'settings.json'), 'utf-8')).toBe(hookedBytes);
    expect(readlinkSync(claudeDir)).toBe(realDir);
  }, 60_000);

  it('quotes absolute paths that contain a space when it runs the installed command', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'speckl-setup-'));
    const project = path.join(parent, 'my project');
    const hermesHome = path.join(parent, 'hermes home');
    const key = path.join(parent, 'state.key');
    mkdirSync(path.join(project, '.speckl', 'agent'), { recursive: true });
    mkdirSync(hermesHome, { recursive: true });
    const adapter = path.join(project, '.speckl', 'agent', 'adapter.mjs');
    writeFileSync(adapter, emitAdapterMjs('Setup', ['hermes', 'codex']));
    writeFileSync(path.join(project, '.speckl', 'agent', 'agent-config.json'), JSON.stringify({
      ...config,
      harness: { hermes: config.harness.hermes, codex: config.harness.codex },
    }, null, 2) + '\n');
    const statePath = path.join(project, '.speckl', 'state.json');
    writeFileSync(statePath, stateBody() + '\n');
    writeFileSync(key, KEY);
    writeFileSync(path.join(hermesHome, 'config.yaml'), 'model: x\n');
    writeFileSync(path.join(hermesHome, 'shell-hooks-allowlist.json'), '{"approvals":[]}\n');
    const run = (args: string[]) => spawnSync(process.execPath, [adapter, ...args], {
      cwd: project, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '' },
    });
    const common = ['--project', project, '--state', statePath, '--key', key];
    expect(run(['install', 'hermes', ...common, '--hermes-home', hermesHome]).status).toBe(0);
    const hermes = run(['doctor', 'hermes', ...common, '--hermes-home', hermesHome]);
    expect(hermes.status, hermes.stderr + hermes.stdout).toBe(0);
    expect(hermes.stdout).toContain('probe: denied (');
    expect(run(['install', 'codex', ...common]).status).toBe(0);
    const codex = run(['doctor', 'codex', ...common]);
    expect(codex.status, codex.stderr + codex.stdout).toBe(0);
    expect(codex.stdout).toContain('probe: denied (');
  }, 30_000);

  it('quotes ${CLAUDE_PROJECT_DIR} so a project path with a space stays one argument', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'speckl-setup-'));
    const project = path.join(parent, 'my project');
    const key = path.join(parent, 'state.key');
    mkdirSync(path.join(project, '.speckl', 'agent'), { recursive: true });
    const adapter = path.join(project, '.speckl', 'agent', 'adapter.mjs');
    writeFileSync(adapter, emitAdapterMjs('Setup', ['claude-code']));
    writeFileSync(path.join(project, '.speckl', 'agent', 'agent-config.json'), JSON.stringify({
      ...config,
      harness: { 'claude-code': config.harness['claude-code'] },
    }, null, 2) + '\n');
    const statePath = path.join(project, '.speckl', 'state.json');
    const state = stateBody() + '\n';
    writeFileSync(statePath, state);
    writeFileSync(key, KEY);
    const run = (args: string[]) => spawnSync(process.execPath, [adapter, ...args], {
      cwd: project, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '' },
    });
    const common = ['--project', project, '--state', statePath, '--key', key];
    const inst = run(['install', 'claude-code', ...common]);
    expect(inst.status, inst.stderr + inst.stdout).toBe(0);
    const settings = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf-8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(command).toContain('"${CLAUDE_PROJECT_DIR}/.speckl/agent/adapter.mjs"');
    expect(command).toContain('"${CLAUDE_PROJECT_DIR}/.speckl/state.json"');
    expect(command).not.toMatch(/node \$\{CLAUDE_PROJECT_DIR\}/);
    const doc = run(['doctor', 'claude-code', ...common]);
    expect(doc.status, doc.stderr + doc.stdout).toBe(0);
    expect(doc.stdout).toContain('probe: denied (');
    expect(readFileSync(statePath, 'utf-8')).toBe(state);
  }, 30_000);
});
