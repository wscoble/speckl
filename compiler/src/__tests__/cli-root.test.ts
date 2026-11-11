import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(missingRun.stderr).toMatch(/cannot read import/);
    expect(missingRun.stderr).toContain(`${missing}:1`);
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
    const gone = run(linked, ['--root', join(dir, 'no-such-dir')]);
    expect(gone.status, gone.stderr).not.toBe(0);
    expect(gone.stderr).toMatch(/cannot read import root/);
    expect(gone.stderr).toContain(join(dir, 'no-such-dir'));
    mkdirSync(join(dir, 'in'));
    const parentFile = write(join(dir, 'in'), 'up.speckdl', 'import "../lib.speckdl" as L\n' + body);
    const noValue = spawnSync(process.execPath, [viteNode, cli, parentFile, '--root'], { cwd: compilerDir, encoding: 'utf-8' });
    expect(noValue.status, noValue.stderr).not.toBe(0);
    expect(noValue.stderr).toMatch(/outside the import root|Not enough arguments|missing required/);
  }, 120_000);

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
