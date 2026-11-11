import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
    const allowed = run(['--root', parent]);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
  }, 60_000);
});
