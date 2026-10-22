// Release readiness: `npm pack` the compiler, install that local tarball into an
// empty project, and run the bins with `npx --no-install` (the tarball is local;
// this does not fetch speckl from the npm registry).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(compilerDir, 'package.json'), 'utf-8'));
const hasZ3 = spawnSync('z3', ['--version']).status === 0;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('local package tarball', () => {
  let files: string[] = [];
  let project = '';

  beforeAll(() => {
    const dest = mkdtempSync(join(tmpdir(), 'speckl-pack-'));
    // `npm pack` runs `prepack` (the build), so the tarball holds a fresh dist/.
    const p = run(npm, ['pack', '--json', '--pack-destination', dest], compilerDir);
    if (p.status !== 0) throw new Error(p.stderr || p.stdout);
    const info = JSON.parse(p.stdout.slice(p.stdout.indexOf('[')))[0];
    files = info.files.map((f: { path: string }) => f.path);
    project = mkdtempSync(join(tmpdir(), 'speckl-install-'));
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'try-speckl', private: true }));
    const i = run(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', join(dest, info.filename)], project);
    if (i.status !== 0) throw new Error(i.stderr || i.stdout);
  }, 300_000);

  it('is named speckl, with both bins, an exports map and an engines floor', () => {
    expect(pkg.name).toBe('speckl');
    expect(pkg.bin).toEqual({ speckl: './dist/index.js', 'speckl-compile': './dist/index.js' });
    expect(pkg.exports).toEqual({ './package.json': './package.json' });
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.scripts.prepack).toBe('npm run build');
  });

  it('ships dist, the verifier, README and LICENSE; not sources or tests', () => {
    for (const f of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/generators/agent/harness-runtime.js',
      'scripts/verify-z3.mjs', 'scripts/lib/obligations.mjs']) {
      expect(files, f).toContain(f);
    }
    expect(files.some(f => f.startsWith('src/') || f.includes('__tests__') || f.startsWith('coverage/') || f.startsWith('test-output/'))).toBe(false);
    expect(files.some(f => f.endsWith('.test.js'))).toBe(false);
  });

  it('local tarball: speckl --help / --version and the speckl-compile alias', () => {
    const help = run(npx, ['--no-install', 'speckl', '--help'], project);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('speckl verify [paths..]');
    expect(help.stdout).toContain('--target');
    const v = run(npx, ['--no-install', 'speckl', '--version'], project);
    expect(v.stdout.trim()).toBe(pkg.version);
    const alias = run(npx, ['--no-install', 'speckl-compile', '--help'], project);
    expect(alias.status, alias.stderr).toBe(0);
  });

  it('compiles an agent spec with the installed CLI', () => {
    cpSync(join(compilerDir, '..', 'examples', 'ClaudeCodePolicy.speckdl'), join(project, 'policy.speckdl'));
    const c = run(npx, ['--no-install', 'speckl', 'policy.speckdl', '-t', 'agent', '-o', '.speckl'], project);
    expect(c.status, c.stderr).toBe(0);
    for (const f of ['AGENTS.md', 'hook.mjs', 'adapter.mjs', 'harness/claude-code/settings.json']) {
      expect(existsSync(join(project, '.speckl', 'agent', f)), f).toBe(true);
    }
  });

  it.skipIf(!hasZ3)('speckl verify runs the bundled Z3 verifier on a user spec', () => {
    cpSync(join(compilerDir, '..', 'examples', 'ReviewGate.speckdl'), join(project, 'gate.speckdl'));
    const r = run(npx, ['--no-install', 'speckl', 'verify', 'gate.speckdl'], project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\d+\/\d+ checks passed, 0 failed/);
  }, 120_000);

  it('speckl verify: missing spec exits 1, missing z3 exits 2', () => {
    const missing = run(npx, ['--no-install', 'speckl', 'verify', 'nope.speckdl'], project);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('does not exist');
    const noZ3 = run(npx, ['--no-install', 'speckl', 'verify', 'nope.speckdl'], project, { Z3_BIN: '/nonexistent/z3' });
    expect(noZ3.status).toBe(2);
    expect(noZ3.stderr).toContain('z3 binary not found');
  });
});
