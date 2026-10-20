// Shared plumbing for the compile tests (compiles-*.test.ts), which feed
// generated code for every example to a real compiler or validator.
//
// In `npm test` a missing toolchain skips that target loudly: a warning
// is printed and the describe block's name says SKIPPED and why. With
// SPECKL_REQUIRE_TOOLCHAINS=1 (`npm run test:compile`) a missing
// toolchain is a failure instead.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compileSpec, CompileOptions } from '../../compile.js';

export const REQUIRE_TOOLCHAINS = process.env.SPECKL_REQUIRE_TOOLCHAINS === '1';

export const EXAMPLES_DIR = join(__dirname, '..', '..', '..', '..', 'examples');

/** Every bundled example, by base name. */
export function exampleNames(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.speckdl')).map((f) => f.replace(/\.speckdl$/, '')).sort();
}

export interface Probe {
  ok: boolean;
  /** First line of the tool's version output, when found. */
  version?: string;
  /** Why the toolchain is unusable, when it is. */
  reason?: string;
}

/** Run `cmd args` and report whether it works, with its version line. */
export function probe(cmd: string, args: string[] = ['--version']): Probe {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return { ok: false, reason: `\`${cmd}\` not found or not working` };
  const version = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0];
  return { ok: true, version };
}

/** Combine probes: usable only if all are. */
export function all(...ps: Probe[]): Probe {
  const bad = ps.filter((p) => !p.ok);
  if (bad.length) return { ok: false, reason: bad.map((p) => p.reason).join('; ') };
  return { ok: true, version: ps.map((p) => p.version).join(', ') };
}

/**
 * Decide how a target's compile tests run. Returns the describe title and
 * whether to skip. With REQUIRE_TOOLCHAINS a missing toolchain is not
 * skipped: the caller's first test asserts `toolchain.ok` and fails.
 */
export function gate(target: string, toolchain: Probe): { title: string; skip: boolean } {
  if (toolchain.ok) return { title: `${target} (${toolchain.version})`, skip: false };
  const how = REQUIRE_TOOLCHAINS ? 'MISSING' : 'SKIPPED';
  const title = `${target} (${how}: ${toolchain.reason})`;
  if (!REQUIRE_TOOLCHAINS) {
    console.warn(`[compile tests] ${target} SKIPPED: ${toolchain.reason}. Install it, or run \`npm run test:compile\` to make this a failure.`);
  }
  return { title, skip: !REQUIRE_TOOLCHAINS };
}

/** Fixture specs for the compile tests. */
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

/**
 * Compile one example (by name) or spec file (by path) to `target` in a
 * fresh temp dir; returns the dir.
 */
export function generate(example: string, target: CompileOptions['target']): string {
  const file = example.includes('/') ? example : join(EXAMPLES_DIR, `${example}.speckdl`);
  const out = mkdtempSync(join(tmpdir(), `speckl-cc-${example.replace(/.*\//, '')}-`));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    compileSpec(file, { outputDir: out, target, bomFormat: 'both', verifyDepth: 3 });
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return out;
}

/** All files under dir whose name ends with `suffix`. */
export function filesUnder(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, suffix));
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out;
}

/** Run a command; returns combined output and success. */
export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

// ─────────────────────────────────────────────────────────────────────
// Known failures
// ─────────────────────────────────────────────────────────────────────

/**
 * Examples whose generated code is known not to compile for a target, with
 * the reason. A listed example must still fail (so a fix has to delete its
 * entry); an unlisted one must compile. Like the verify baseline, this
 * records debt honestly instead of hiding it.
 */
export const COMPILE_BASELINE_FILE = join(EXAMPLES_DIR, '.speckl-compile-baseline.json');

export function knownFailures(target: string): Record<string, string> {
  const all = JSON.parse(readFileSync(COMPILE_BASELINE_FILE, 'utf-8')) as Record<string, unknown>;
  return (all[target] ?? {}) as Record<string, string>;
}

export interface CheckResult {
  ok: boolean;
  output: string;
}

/**
 * The compile tests for one target: a toolchain check, then one test per
 * example held to the known-failures baseline.
 */
export function targetSuite(opts: {
  target: string;
  name: string;
  toolchain: Probe;
  check: (example: string) => CheckResult | Promise<CheckResult>;
  examples?: string[];
  timeout?: number;
}): void {
  const { title, skip } = gate(opts.name, opts.toolchain);
  const known = knownFailures(opts.target);
  const examples = opts.examples ?? exampleNames();
  describe.skipIf(skip)(title, () => {
    it('toolchain is available', () => {
      expect(opts.toolchain.reason ?? 'ok').toBe('ok');
    });

    it('the known-failures baseline names only real examples', () => {
      expect(Object.keys(known).filter((e) => !exampleNames().includes(e))).toEqual([]);
    });

    it.each(examples)('%s', async (example) => {
      expect(opts.toolchain.ok).toBe(true);
      const r = await opts.check(example);
      if (known[example]) {
        expect(r.ok, `${example} now compiles for ${opts.target}: delete its entry from examples/.speckl-compile-baseline.json`).toBe(false);
      } else {
        expect(r.ok, `${opts.target} output for ${example} does not compile:\n${r.output.slice(0, 4000)}`).toBe(true);
      }
    }, opts.timeout ?? 120_000);
  });
}
