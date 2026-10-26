// Builds the browser compiler bundle (real compiler, fs/crypto/child_process
// replaced by shims) and compiles DeployGate through that bundle.
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { playgroundConfig } from './vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = readFileSync(join(here, '..', '..', 'examples', 'DeployGate.speckdl'), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (statSync(child).isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out;
}

describe('playground bundle', () => {
  it('compiles DeployGate end to end with the browser shims', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'speckl-play-bundle-'));
    const config = playgroundConfig('lib');
    await build({
      ...config,
      configFile: false,
      logLevel: 'error',
      build: {
        ...config.build,
        outDir,
        emptyOutDir: true,
      },
    });
    const files = walk(outDir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    const bundled = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(bundled).not.toMatch(/from ["']fs["']/);
    expect(bundled).not.toMatch(/from ["']child_process["']/);
    expect(bundled).toMatch(/memfs|Volume/);

    const entry = files.find((f) => f.includes('playground-compiler')) ?? files[0];
    const mod = await import(pathToFileURL(entry).href) as {
      compileSource: (source: string, options?: { target?: string }) => {
        ok: boolean;
        files: { path: string; text: string }[];
        diagnostics: { message: string }[];
      };
    };
    const result = mod.compileSource(deploy, { target: 'all' });
    expect(result.ok, result.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    const agents = result.files.find((f) => f.path === 'agent/AGENTS.md');
    const hook = result.files.find((f) => f.path === 'agent/hook.mjs');
    expect(agents?.text).toContain('Call-bound');
    expect(hook?.text).toContain('pre');
  }, 120_000);
});
