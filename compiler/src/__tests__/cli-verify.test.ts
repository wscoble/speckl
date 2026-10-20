// `speckl verify` and the compile CLI must fail closed: a missing verifier, a
// failing verifier, or a spec that does not compile is a non-zero exit, never
// a silent success. (The packed CLI is also covered end to end by
// package-pack.test.ts.)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerify, packageVersion } from '../cli-support.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

/** A fake install: <root>/dist/ (the "here" dir) and <root>/scripts/verify-z3.mjs. */
function fakeInstall(script: string | null, withSelf = true): { here: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'speckl-cli-'));
  const here = join(root, 'dist');
  mkdirSync(here);
  mkdirSync(join(root, 'scripts'));
  if (withSelf) writeFileSync(join(here, 'index.js'), '');
  if (script !== null) writeFileSync(join(root, 'scripts', 'verify-z3.mjs'), script);
  return { here, root };
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.SPECKL_BIN; });

describe('runVerify', () => {
  it('a missing verifier script is exit 1 with a message', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { here } = fakeInstall(null);
    expect(runVerify([], here)).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/verifier not found/);
  });

  it("propagates the verifier's exit code (a failing verify is a failing command)", () => {
    for (const code of [0, 1, 2]) {
      const { here } = fakeInstall(`process.exit(${code});`);
      expect(runVerify([], here)).toBe(code);
    }
  });

  it('a verifier killed by a signal is exit 1, not 0', () => {
    const { here } = fakeInstall(`process.kill(process.pid, 'SIGKILL');`);
    expect(runVerify([], here)).toBe(1);
  });

  it('passes arguments through and points SPECKL_BIN at this compiler', () => {
    const { here, root } = fakeInstall('');
    const out = join(root, 'seen.json');
    writeFileSync(join(root, 'scripts', 'verify-z3.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), bin: process.env.SPECKL_BIN }));\n`);
    expect(runVerify(['a.speckdl', '--depth', '3'], here)).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual({ argv: ['a.speckdl', '--depth', '3'], bin: join(here, 'index.js') });
  });

  it('keeps an explicit SPECKL_BIN', () => {
    const { here, root } = fakeInstall('');
    const out = join(root, 'bin.txt');
    writeFileSync(join(root, 'scripts', 'verify-z3.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, process.env.SPECKL_BIN ?? '');\n`);
    process.env.SPECKL_BIN = '/custom/speckl';
    expect(runVerify([], here)).toBe(0);
    expect(readFileSync(out, 'utf-8')).toBe('/custom/speckl');
  });

  it('reports the package version', () => {
    expect(packageVersion()).toBe(JSON.parse(readFileSync(join(compilerDir, 'package.json'), 'utf-8')).version);
  });
});

describe('compile CLI exit codes', () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), ...args], { cwd: compilerDir, encoding: 'utf-8' });
  }
  it('a spec that fails to compile exits 1 and writes no rails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cli-bad-'));
    const spec = join(dir, 'Bad.speckdl');
    writeFileSync(spec, 'speck Bad {\n    state {\n        x: Nat\n    }\n    init {\n        x := 0\n    }\n    verify Eventually(x == 1)\n}\n');
    const r = cli([spec, '-t', 'agent', '-o', join(dir, 'out')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Compilation failed: .*unsupported verify form/);
    expect(existsSync(join(dir, 'out', 'agent'))).toBe(false);
  }, 60_000);
  it('an unknown target is rejected', () => {
    const r = cli([join(compilerDir, '..', 'examples', 'ToggleSwitch.speckdl'), '-t', 'cobol']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Invalid values|Choices/);
  }, 60_000);
});
