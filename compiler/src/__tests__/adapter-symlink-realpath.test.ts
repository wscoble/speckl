// Protected-path checks follow symlinks. Path checks used to compare paths as
// written, so a symlink already in the project (shipped in a client repo, left
// by a dependency or an earlier tool) let a file tool reach the rails through
// an innocent-looking name: with `notes -> .speckl`, a Write to
// `notes/agent/hook.mjs` rewrites hook.mjs. Every path token is now also
// resolved to its real location (realpath of the deepest existing ancestor,
// plus the not-yet-existing remainder, dangling links followed via readlink);
// anything that cannot be resolved is denied.
//
// These run on the real filesystem through runAdapter with the same realPath
// the generated adapter uses, and end to end through a compiled adapter.mjs.
// Symlink cases skip only where the OS cannot create symlinks.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRealPath, runAdapter, HarnessRule, AdapterDeps, HookResult, RealPathOps,
} from '../generators/agent/harness-runtime.js';

const canSymlink = (() => {
  const d = fs.mkdtempSync(join(tmpdir(), 'speckl-symprobe-'));
  try { fs.symlinkSync('.', join(d, 'l'), 'dir'); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const nodeOps: RealPathOps = {
  realpath: q => fs.realpathSync.native(q),
  readlink: q => fs.readlinkSync(q),
  dirname: q => path.dirname(q),
  basename: q => path.basename(q),
  resolve: (b, q) => path.resolve(b, q),
  join: (...q) => path.join(...q),
};

// ---- resolveRealPath against stand-in filesystems: the error branches the
// real filesystem rarely produces on demand.
const err = (code: string) => Object.assign(new Error(code), { code });
function fakeOps(over: Partial<RealPathOps>): RealPathOps {
  return { ...nodeOps, dirname: path.posix.dirname, basename: path.posix.basename, resolve: path.posix.resolve, join: path.posix.join, ...over };
}

describe('resolveRealPath (stand-in filesystem)', () => {
  it('appends the missing remainder to the deepest existing ancestor', () => {
    const ops = fakeOps({
      realpath: p => { if (p === '/real' || p === '/link') return '/real'; throw err('ENOENT'); },
      readlink: () => { throw err('ENOENT'); },
    });
    expect(resolveRealPath('/link/a/b.txt', ops)).toBe('/real/a/b.txt');
    expect(resolveRealPath('/link', ops)).toBe('/real');
  });

  it('throws on any error other than plain non-existence', () => {
    for (const code of ['EACCES', 'ELOOP', 'EPERM', 'ENAMETOOLONG']) {
      const ops = fakeOps({ realpath: () => { throw err(code); } });
      expect(() => resolveRealPath('/p/x', ops), code).toThrow(code);
    }
  });

  it('throws when a dangling link cannot be read', () => {
    const ops = fakeOps({ realpath: () => { throw err('ENOENT'); }, readlink: () => { throw err('EACCES'); } });
    expect(() => resolveRealPath('/p/dangling', ops)).toThrow(/cannot read symlink \/p\/dangling \(EACCES\)/);
  });

  it('caps dangling-link chains (ELOOP) and needs an existing ancestor', () => {
    const loop = fakeOps({ realpath: () => { throw err('ENOENT'); }, readlink: p => (p === '/a' ? '/b' : '/a') });
    expect(() => resolveRealPath('/a', loop)).toThrow(/ELOOP/);
    const none = fakeOps({ realpath: () => { throw err('ENOENT'); }, readlink: () => { throw err('ENOENT'); } });
    expect(() => resolveRealPath('/x/y', none)).toThrow(/no existing ancestor/);
  });

  it('reports a thrown non-Error value', () => {
    const ops = fakeOps({ realpath: () => { throw 'boom'; } }); // eslint-disable-line no-throw-literal
    expect(() => resolveRealPath('/p', ops)).toThrow(/boom/);
  });
});

// ---- runAdapter on a real project directory.
const rules: HarnessRule[] = [
  { tools: ['Write', 'Edit', 'NotebookEdit'], target: 'edit_code', inputs: [] },
  { tools: ['Read'], target: 'read_file', inputs: [] },
  { tools: ['Bash'], field: 'command', pattern: 'cat [A-Za-z0-9_./-]+', target: 'inspect', inputs: [] },
];
const codexRules: HarnessRule[] = [{ tools: ['apply_patch'], target: 'edit_code', inputs: [] }];
const config = { harness: { 'claude-code': { rules }, codex: { rules: codexRules } } };

let project: string;
let keyDir: string;
let key: string;

function realDeps(projectDir = project) {
  const calls: string[] = [];
  const d: AdapterDeps & { calls: string[] } = {
    calls,
    runHook(cmd): HookResult { calls.push(cmd); return { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' }; },
    resolvePath: (b, p) => path.resolve(b, p),
    relativePath: (a, b) => path.relative(a, b),
    dirname: p => path.dirname(p),
    cwd: projectDir,
    agentDir: join(projectDir, '.speckl', 'agent'),
    readFile: () => null,
    writeFile: () => {},
    realPath: p => resolveRealPath(p, nodeOps),
  };
  return d;
}

function pre(tool: string, input: Record<string, unknown>, opts: { projectDir?: string; keyArg?: string; harness?: string } = {}) {
  const projectDir = opts.projectDir ?? project;
  const d = realDeps(projectDir);
  const harness = opts.harness ?? 'claude-code';
  const argv = [harness, 'pre', '--state', '.speckl/state.json', '--project', projectDir, '--key', opts.keyArg ?? key];
  const out = runAdapter(argv, {}, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1', session_id: 's', cwd: projectDir }), config, d);
  return { ...out, reachedHook: d.calls.length > 0 };
}
const denied = (r: ReturnType<typeof pre>, why: RegExp = /Speckl-protected path/) => {
  expect(r.code, r.stderr).toBe(2);
  expect(r.stderr).toMatch(why);
  expect(r.reachedHook).toBe(false);
};
const allowed = (r: ReturnType<typeof pre>) => {
  expect(r.code, r.stderr).toBe(0);
  expect(r.reachedHook).toBe(true);
};
const link = (target: string, name: string) => fs.symlinkSync(target, join(project, name));

beforeEach(() => {
  project = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-proj-'));
  keyDir = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-key-'));
  key = join(keyDir, 'state.key');
  fs.writeFileSync(key, 'k\n');
  fs.mkdirSync(join(project, '.speckl', 'agent'), { recursive: true });
  fs.writeFileSync(join(project, '.speckl', 'agent', 'hook.mjs'), '// hook\n');
  fs.writeFileSync(join(project, '.speckl', 'state.json'), '{}');
  fs.mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(join(project, '.git', 'config'), '[core]\n');
  fs.mkdirSync(join(project, '.claude'));
  fs.mkdirSync(join(project, 'src'));
});

describe.skipIf(!canSymlink)('file tools through symlinks are denied (real filesystem)', () => {
  it('Write through a symlinked dir to .speckl', () => {
    link('.speckl', 'notes');
    denied(pre('Write', { file_path: 'notes/agent/hook.mjs', content: 'x' }), /\.speckl\/agent \(via symlink notes\/agent\/hook\.mjs\)/);
    denied(pre('Write', { file_path: join(project, 'notes', 'state.json'), content: '{}' }));
  });

  it('Edit through a symlinked file to .git/config', () => {
    link('.git/config', 'cfg');
    denied(pre('Edit', { file_path: 'cfg', old_string: '[core]', new_string: '[core]\n hooksPath = x' }));
  });

  it('a new file written through a symlinked dir (.git/hooks/pre-commit does not exist yet)', () => {
    link('.git/hooks', 'scripts');
    expect(fs.existsSync(join(project, '.git', 'hooks', 'pre-commit'))).toBe(false);
    denied(pre('Write', { file_path: 'scripts/pre-commit', content: '#!/bin/sh\n' }));
    denied(pre('NotebookEdit', { notebook_path: 'scripts/new/deeper/x.ipynb', new_source: '' }));
  });

  it('a symlink chain (a -> b -> .claude)', () => {
    link('.claude', 'b');
    link('b', 'a');
    denied(pre('Write', { file_path: 'a/settings.json', content: '{}' }));
  });

  it('a dangling symlink is followed through its target', () => {
    link('.speckl/agent/not-yet', 'ghost'); // target does not exist
    denied(pre('Write', { file_path: 'ghost', content: 'x' }));
    denied(pre('Write', { file_path: 'ghost/sub/file.js', content: 'x' }));
  });

  it('a symlink loop is denied (ELOOP), not treated as absent', () => {
    link('l2', 'l1');
    link('l1', 'l2');
    denied(pre('Write', { file_path: 'l1/x.js', content: 'x' }), /unresolvable path "l1\/x\.js".*ELOOP.*fail closed/);
  });

  it('a case variant through a symlink (UP -> .SPECKL/agent on a case-sensitive fs)', () => {
    link('.SPECKL/Agent', 'UP');
    denied(pre('Write', { file_path: 'UP/hook.mjs', content: 'x' }));
  });

  it('a symlink out of the project to the key dir', () => {
    link(keyDir, 'k');
    denied(pre('Read', { file_path: 'k/state.key' }));
  });

  it('a project reached through a symlink (macOS /tmp -> /private/tmp) still protects the real rails', () => {
    const alias = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-alias-'));
    const projLink = join(alias, 'proj');
    fs.symlinkSync(project, projLink);
    link('.speckl', 'notes');
    // The rails are configured under the alias; `notes` resolves to the real
    // project path, so the rails must be compared at their real location too.
    denied(pre('Write', { file_path: 'notes/agent/hook.mjs', content: 'x' }, { projectDir: projLink }));
    allowed(pre('Write', { file_path: 'src/a.js', content: 'x' }, { projectDir: projLink }));
  });

  it('a literal symlinked path in a shell command is denied too', () => {
    link('.speckl', 'notes');
    denied(pre('Bash', { command: 'cat notes/agent/hook.mjs' }));
  });

  it('Codex apply_patch adding a file through a symlinked dir', () => {
    link('.git/hooks', 'scripts');
    const patch = '*** Begin Patch\n*** Add File: scripts/post-checkout\n+#!/bin/sh\n*** End Patch\n';
    denied(pre('apply_patch', { command: patch }, { harness: 'codex' }));
  });

  it('an unresolvable protected path denies every call (fail closed)', () => {
    link('kl2', 'kl1');
    link('kl1', 'kl2');
    denied(pre('Write', { file_path: 'src/a.js', content: 'x' }, { keyArg: join(project, 'kl1', 'state.key') }), /cannot resolve the Speckl-protected path .*ELOOP/);
  });
});

describe.skipIf(!canSymlink)('symlinks to harmless places still work', () => {
  it('allows writes through a symlink to src, and to a dir outside the project', () => {
    link('src', 'lib');
    allowed(pre('Write', { file_path: 'lib/index.ts', content: 'x' }));
    const outside = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-outside-'));
    link(outside, 'shared');
    allowed(pre('Write', { file_path: 'shared/new/file.txt', content: 'x' }));
    allowed(pre('Read', { file_path: 'README.md' })); // plain missing file
  });
});

describe.skipIf(isRoot)('unreadable paths deny', () => {
  it('denies a path under a directory it cannot search (EACCES)', () => {
    const locked = join(project, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      denied(pre('Read', { file_path: 'locked/secret.txt' }), /unresolvable path .*EACCES/);
    } finally { fs.chmodSync(locked, 0o755); }
  });
});

// ---- End to end: the compiled adapter.mjs, through the command line
// .claude/settings.json wires.
const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

describe.skipIf(!canSymlink)('generated adapter.mjs follows symlinks (Claude Code wiring)', () => {
  let proj: string;
  let cmd: string;
  const sh = (command: string, input = '') => {
    const r = spawnSync('sh', ['-c', command], { cwd: proj, input, encoding: 'utf-8', env: { ...process.env, SPECKL_STATE_KEY_FILE: '', CLAUDE_PROJECT_DIR: proj } });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const send = (tool: string, input: Record<string, unknown>) => sh(cmd, JSON.stringify({
    session_id: 's', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_' + Math.random().toString(36).slice(2),
  }));

  beforeAll(() => {
    proj = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-e2e-'));
    const kd = fs.mkdtempSync(join(tmpdir(), 'speckl-symlink-e2e-key-'));
    fs.mkdirSync(join(proj, 'src'));
    fs.mkdirSync(join(proj, '.git', 'hooks'), { recursive: true });
    fs.cpSync(example, join(proj, 'policy.speckdl'));
    const c = spawnSync(process.execPath, [viteNode, '--root', compilerDir, join(compilerDir, 'src', 'index.ts'), 'policy.speckdl', '-t', 'agent', '-o', '.speckl'], { cwd: proj, encoding: 'utf-8' });
    if (c.status !== 0) throw new Error(c.stderr || c.stdout);
    const k = join(kd, 'state.key');
    const init = sh(`node .speckl/agent/signal.mjs init --state .speckl/state.json --key ${k} --dev`);
    if (init.status !== 0) throw new Error(init.stderr);
    const inst = sh(`node .speckl/agent/adapter.mjs install claude-code --project . --state .speckl/state.json --key ${k}`);
    if (inst.status !== 0) throw new Error(inst.stderr);
    cmd = JSON.parse(fs.readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8')).hooks.PreToolUse[0].hooks[0].command;
    fs.symlinkSync('.speckl', join(proj, 'notes'));
    fs.symlinkSync('.git/hooks', join(proj, 'scripts'));
    fs.symlinkSync('loop2', join(proj, 'loop1'));
    fs.symlinkSync('loop1', join(proj, 'loop2'));
    fs.symlinkSync('src', join(proj, 'lib'));
  }, 90_000);

  it('denies rails writes through symlinks and lets a harmless one through', () => {
    const hook = fs.readFileSync(join(proj, '.speckl', 'agent', 'hook.mjs'), 'utf-8');
    for (const [tool, input, why] of [
      ['Write', { file_path: 'notes/agent/hook.mjs', content: 'process.exit(0)' }, /Speckl-protected path .*via symlink/],
      ['Edit', { file_path: join(proj, 'notes', 'state.json'), old_string: '{', new_string: '{' }, /Speckl-protected path/],
      ['Write', { file_path: 'scripts/pre-commit', content: '#!/bin/sh\n' }, /Speckl-protected path/],
      ['Write', { file_path: 'loop1/x.js', content: 'x' }, /unresolvable path .*ELOOP/],
    ] as const) {
      const r = send(tool, input);
      expect(r.status, JSON.stringify(input)).toBe(2);
      expect(r.stderr).toMatch(why);
    }
    expect(fs.readFileSync(join(proj, '.speckl', 'agent', 'hook.mjs'), 'utf-8')).toBe(hook);
    const ok = send('Write', { file_path: 'lib/greet.js', content: 'x' });
    expect(ok.status, ok.stderr).toBe(0);
  });
});
