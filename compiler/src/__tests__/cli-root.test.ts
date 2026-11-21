import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('..', import.meta.url));
const compilerDir = join(srcDir, '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const cli = join(srcDir, 'index.ts');

function write(dir: string, name: string, src: string): string {
  const path = join(dir, name);
  writeFileSync(path, src);
  return path;
}

describe('speckl --root', () => {
  it('rejects a path outside the entry directory, and --root widens it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'speckl-cli-root-'));
    const folder = join(parent, 'in');
    mkdirSync(folder);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(folder, 'root.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(parent, 'gen');
    const run = (args: string[]) => spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', ...args], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    const denied = run([]);
    expect(denied.status, denied.stderr).not.toBe(0);
    expect(denied.stderr).toMatch(/outside the import root/);
    expect(denied.stderr).toContain(`${file}:1`);
    const allowed = run(['--root', parent]);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
  }, 60_000);

  it('rejects a missing file, a cycle, a duplicate alias, an absolute path, and a bad --root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-neg-'));
    const body = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n}\n';
    const run = (file: string, args: string[]) => spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', join(dir, 'gen'), '-b', 'cdx', ...args], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    const missing = write(dir, 'missing.speckdl', 'import "./no-such.speckdl" as L\n' + body);
    const missingRun = run(missing, []);
    expect(missingRun.status, missingRun.stderr).not.toBe(0);
    expect(missingRun.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: cannot read import "./no-such.speckdl" (resolved ${join(dir, 'no-such.speckdl')}) at ${missing}:1`,
    );
    const gen = join(dir, 'gen');
    const written = existsSync(gen) ? readdirSync(gen).filter(name => name.endsWith('.ts')) : [];
    expect(written).toEqual([]);

    write(dir, 'a.speckdl', 'import "./b.speckdl" as B\nspeck A {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const b = write(dir, 'b.speckdl', 'import "./a.speckdl" as A\nspeck B {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const cycle = run(b, ['--root', dir]);
    expect(cycle.status, cycle.stderr).not.toBe(0);
    expect(cycle.stderr).toMatch(/import cycle/);

    write(dir, 'one.speckdl', 'speck One {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    write(dir, 'two.speckdl', 'speck Two {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const dup = write(dir, 'dup.speckdl', 'import "./one.speckdl" as L\nimport "./two.speckdl" as L\n' + body);
    const dupRun = run(dup, []);
    expect(dupRun.status, dupRun.stderr).not.toBe(0);
    expect(dupRun.stderr).toMatch(/import alias L is used twice/);

    const abs = write(dir, 'abs.speckdl', 'import "/tmp/outside.speckdl" as L\n' + body);
    const absRun = run(abs, ['--root', dir]);
    expect(absRun.status, absRun.stderr).not.toBe(0);
    expect(absRun.stderr).toMatch(/must be a relative path/);
    expect(absRun.stderr).toContain(`${abs}:1`);

    write(dir, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const linked = write(dir, 'linked.speckdl', 'import "./lib.speckdl" as L\n' + body);
    const fileRoot = run(linked, ['--root', linked]);
    expect(fileRoot.status, fileRoot.stderr).not.toBe(0);
    expect(fileRoot.stderr).toMatch(/outside the import root/);
    const goneRoot = join(dir, 'no-such-dir');
    const gone = run(linked, ['--root', goneRoot]);
    expect(gone.status, gone.stderr).not.toBe(0);
    expect(gone.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: cannot read import root "${goneRoot}" (ENOENT)`,
    );
    const afterFail = existsSync(gen) ? readdirSync(gen).filter(name => name.endsWith('.ts')) : [];
    expect(afterFail).toEqual([]);
    mkdirSync(join(dir, 'in'));
    const parentFile = write(join(dir, 'in'), 'up.speckdl', 'import "../lib.speckdl" as L\n' + body);
    const noValue = spawnSync(process.execPath, [viteNode, cli, parentFile, '--root'], { cwd: compilerDir, encoding: 'utf-8' });
    expect(noValue.status, noValue.stderr).not.toBe(0);
    expect(noValue.stderr).toMatch(/outside the import root|Not enough arguments|missing required/);
  }, 120_000);

  it('accepts --root relative to the working directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'speckl-cli-rel-'));
    const folder = join(parent, 'in');
    mkdirSync(folder);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(folder, 'root.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(parent, 'gen');
    const rootArg = relative(compilerDir, parent);
    expect(rootArg.startsWith('/')).toBe(false);
    const result = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', rootArg], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
  }, 60_000);

  it('compiles an import through a symlink that stays inside the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-link-'));
    const lib = write(dir, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    symlinkSync(lib, join(dir, 'link.speckdl'));
    const file = write(dir, 'root.speckdl', 'import "./link.speckdl" as L\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(dir, 'gen');
    const result = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx'], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(out, 'Lib.ts'), 'utf8')).toContain('Lib');
  }, 60_000);

  it('rejects a --root directory that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-gone-'));
    const body = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n}\n';
    write(dir, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(dir, 'root.speckdl', 'import "./lib.speckdl" as L\n' + body);
    const gone = join(dir, 'no-such-dir');
    const out = join(dir, 'gen');
    const result = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', gone], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: cannot read import root "${gone}" (ENOENT)`,
    );
    const written = existsSync(out) ? readdirSync(out).filter(name => name.endsWith('.ts')) : [];
    expect(written).toEqual([]);
  }, 60_000);

  it('rejects --root when the path is a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-file-root-'));
    const body = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n}\n';
    write(dir, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(dir, 'root.speckdl', 'import "./lib.speckdl" as L\n' + body);
    const out = join(dir, 'gen');
    const result = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', file], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    const rootReal = realpathSync(file);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: import "./lib.speckdl" resolves outside the import root ${rootReal} at ${file}:1`,
    );
    const written = existsSync(out) ? readdirSync(out).filter(name => name.endsWith('.ts')) : [];
    expect(written).toEqual([]);
  }, 60_000);

  it('resolves a relative --root from the working directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'speckl-cli-rel2-'));
    const folder = join(parent, 'in');
    mkdirSync(folder);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(folder, 'root.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(parent, 'gen');
    const rootArg = relative(compilerDir, parent);
    expect(rootArg.startsWith('/')).toBe(false);
    const ok = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', `${rootArg}/in/..`], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
    const missing = 'no-such-relative-root';
    const gone = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', missing], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(gone.status, gone.stderr).not.toBe(0);
    expect(gone.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: cannot read import root "${missing}" (ENOENT)`,
    );
  }, 60_000);

  it('follows a symlink passed as --root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'speckl-cli-root-link-'));
    const real = join(parent, 'real');
    mkdirSync(join(real, 'in'), { recursive: true });
    write(real, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(join(real, 'in'), 'root.speckdl', 'import "../lib.speckdl" as L\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const link = join(parent, 'link-root');
    symlinkSync(real, link);
    const out = join(parent, 'gen');
    const allowed = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx', '--root', link], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(readFileSync(join(out, 'Lib.ts'), 'utf8')).toContain('Lib');
    const fileLink = join(parent, 'file-link');
    symlinkSync(file, fileLink);
    const denied = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', join(parent, 'gen2'), '-b', 'cdx', '--root', fileLink], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(denied.status, denied.stderr).not.toBe(0);
    expect(denied.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: import "../lib.speckdl" resolves outside the import root ${realpathSync(file)} at ${file}:1`,
    );
  }, 60_000);

  it('allows a --root outside the entry directory only for imports inside that root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'speckl-cli-outside-'));
    const entryDir = join(parent, 'in');
    const elsewhere = join(parent, 'elsewhere');
    mkdirSync(entryDir);
    mkdirSync(elsewhere);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    write(elsewhere, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const widened = write(entryDir, 'wide.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const sibling = write(entryDir, 'sib.speckdl', 'import "./wide.speckdl" as W\nspeck Sib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const intoElsewhere = write(entryDir, 'away.speckdl', 'import "../elsewhere/lib.speckdl" as L\nspeck Away {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const run = (file: string, root: string, outName: string) => spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', join(parent, outName), '-b', 'cdx', '--root', root], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    const ancestor = run(widened, parent, 'gen-ancestor');
    expect(ancestor.status, ancestor.stderr).toBe(0);
    expect(readFileSync(join(parent, 'gen-ancestor', 'Out.ts'), 'utf8')).toContain('Out');
    const missed = run(sibling, elsewhere, 'gen-miss');
    expect(missed.status, missed.stderr).not.toBe(0);
    expect(missed.stderr.split('\n')[0]).toBe(
      `Compilation failed: Error: Parse error: import "./wide.speckdl" resolves outside the import root ${realpathSync(elsewhere)} at ${sibling}:1`,
    );
    const reached = run(intoElsewhere, elsewhere, 'gen-away');
    expect(reached.status, reached.stderr).toBe(0);
    expect(readFileSync(join(parent, 'gen-away', 'Lib.ts'), 'utf8')).toContain('Lib');
  }, 90_000);

  it('compiles a same-directory import without --root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-local-'));
    write(dir, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(dir, 'root.speckdl', 'import "./lib.speckdl" as L\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(dir, 'gen');
    const result = spawnSync(process.execPath, [viteNode, cli, file, '-t', 'typescript', '-o', out, '-b', 'cdx'], {
      cwd: compilerDir, encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(out, 'Lib.ts'), 'utf8')).toContain('Lib');
  }, 60_000);
});
