// Fail-closed hardening of the harness adapter runtime (emitted verbatim into
// adapter.mjs). Two bypass classes, each with a case that fails before the fix
// and passes after:
//   1. Case-insensitive rails protection. On macOS (APFS, case-insensitive by
//      default) and Windows, `.Claude/settings.json` IS `.claude/settings.json`,
//      so a case-sensitive check let the agent edit its own hook config and the
//      state/key file by changing the case.
//   2. `.git/hooks` and `.git/config` are off limits. A `.git/hooks/*` script
//      runs as real shell on the next commit/checkout, so an agent allowed to
//      edit files and run `git commit` could plant one that executes outside
//      the policy; `.git/config` can redirect `core.hooksPath` to the same end.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  findProtectedMention, vcsProtectedDirs, harnessProtectedDirs, runAdapter,
  HarnessRule, AdapterDeps, HookResult,
} from '../generators/agent/harness-runtime.js';

const prot = [
  { abs: '/p/.claude', rel: '.claude' },
  { abs: '/p/.speckl/state.json', rel: '.speckl/state.json' },
  { abs: '/home/u/.config/speckl/k.key', rel: '' },
];
const f = (input: unknown, cwd = '/p') => findProtectedMention(input, prot, cwd, path.posix.resolve);

describe('case-insensitive rails protection', () => {
  it('still flags the exact-case rails (regression)', () => {
    expect(f({ file_path: '.claude/settings.json' })).toBe('.claude');
    expect(f({ file_path: '/p/.speckl/state.json' })).toBe('/p/.speckl/state.json');
  });

  it('flags case-variant rails paths (macOS/Windows bypass)', () => {
    // Relative, upper and mixed case.
    expect(f({ file_path: '.Claude/settings.json' })).toBe('.claude');
    expect(f({ file_path: '.CLAUDE/settings.json' })).toBe('.claude');
    expect(f({ command: 'cat .Claude/settings.json' })).toBe('.claude');
    // Absolute, mixed case.
    expect(f({ file_path: '/p/.Claude/settings.json' })).toBe('/p/.claude');
    // The integrity-protected state file and the signing key.
    expect(f({ file_path: '.SPECKL/State.json' })).toBe('.speckl/state.json');
    expect(f({ command: 'cat /home/u/.config/Speckl/K.key' })).toBe('/home/u/.config/speckl/k.key');
  });

  it('does not flag unrelated paths', () => {
    expect(f({ file_path: 'src/claude-helper.ts' })).toBeNull(); // 'claude' mid-name, not the .claude dir
    expect(f({ file_path: 'README.md' })).toBeNull();
    expect(f({ file_path: '.gitignore' })).toBeNull();
  });
});

describe('version-control hook paths are protected', () => {
  it('lists .git/hooks and .git/config', () => {
    expect(vcsProtectedDirs()).toEqual(['.git/hooks', '.git/config']);
    // harnessProtectedDirs stays the harness-config set (unchanged contract).
    expect(harnessProtectedDirs(['claude-code'])).toEqual(['.claude', '.cursor', '.codex', '.gemini']);
  });
});

// ---- Integration through runAdapter: a Claude Code Write that targets a git
// hook is denied (exit 2), while an ordinary file write still reaches mapping.
const rules: HarnessRule[] = [
  { tools: ['Write'], target: 'edit_code', inputs: [{ param: 'path', field: 'file_path' }] },
];
const config = { harness: { 'claude-code': { rules } } };

function fakeDeps(allow = true) {
  const calls: { cmd: string }[] = [];
  const d: AdapterDeps & { calls: { cmd: string }[] } = {
    calls,
    runHook(cmd): HookResult {
      calls.push({ cmd });
      return allow ? { status: 0, stdout: '{"decision":"allow"}\n', stderr: '' } : { status: 2, stdout: '{"decision":"deny"}\n', stderr: 'no' };
    },
    resolvePath: (b, p) => path.posix.resolve(b, p),
    relativePath: (a, b) => path.posix.relative(a, b),
    dirname: p => path.posix.dirname(p),
    cwd: '/p',
    agentDir: '/p/.speckl/agent',
    readFile: () => null,
    writeFile: () => {},
  };
  return d;
}
const argv = ['claude-code', 'pre', '--state', '.speckl/state.json', '--project', '/p'];
const pre = (file: string, d = fakeDeps()) =>
  runAdapter(argv, {}, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 't1', cwd: '/p' }), config, d);

describe('planting a git hook is denied before it reaches hook.mjs', () => {
  it('denies a Write to .git/hooks/pre-commit (any case) without calling hook.mjs', () => {
    for (const file of ['.git/hooks/pre-commit', '.git/hooks/post-checkout', '.GIT/hooks/pre-commit', '/p/.git/hooks/pre-commit']) {
      const d = fakeDeps();
      const out = pre(file, d);
      expect(out.code, file).toBe(2);
      expect(out.stderr, file).toMatch(/Speckl-protected path/);
      expect(d.calls.length, file).toBe(0); // never reached hook.mjs
    }
  });

  it('denies a Write to .git/config (core.hooksPath redirect)', () => {
    const out = pre('.git/config');
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/Speckl-protected path/);
  });

  it('still lets an ordinary file write through to the gate (.gitignore, src)', () => {
    for (const file of ['.gitignore', 'src/index.ts', 'docs/.gitkeep']) {
      const d = fakeDeps();
      const out = pre(file, d);
      expect(d.calls.length, file).toBe(1); // reached hook.mjs
      expect(out.code, file).toBe(0);
    }
  });
});
