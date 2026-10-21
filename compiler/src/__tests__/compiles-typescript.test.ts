// Compile tests: generated TypeScript (`-t typescript`) and the agent rails
// (`-t agent`: the generated machine plus the .mjs hook scripts), checked
// with this repo's own `tsc` under --strict and with `node --check`.
// See helpers/toolchains.ts.
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_HARNESSES } from '../ir/lower.js';
import { filesUnder, FIXTURES_DIR, generate, run, targetSuite, Probe } from './helpers/toolchains.js';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');
const typesDir = join(dirname(require.resolve('@types/node/package.json')), '..');
const tsc: Probe = { ok: true, version: `tsc ${require('typescript/package.json').version}` };

function typecheck(files: string[]) {
  return run(process.execPath, [
    tscBin, '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
    '--lib', 'es2022', '--typeRoots', typesDir, '--types', 'node', '--skipLibCheck', ...files,
  ]);
}

targetSuite({
  target: 'typescript',
  name: 'tsc --strict: generated TypeScript',
  toolchain: tsc,
  check: (example) => {
    const files = filesUnder(generate(example, 'typescript'), '.ts');
    if (files.length === 0) return { ok: false, output: 'no .ts output' };
    return typecheck(files);
  },
});

// fixtures/LoopSplit.speckdl: an action whose for-loop (with an if, a map
// write and an accumulator inside) must be translated, not dropped. Its
// runtime behaviour is checked in for-loop-fail-closed.test.ts.
describe('tsc --strict: fixture LoopSplit (for-loop in an action body)', () => {
  it('compiles', () => {
    const files = filesUnder(generate(join(FIXTURES_DIR, 'LoopSplit.speckdl'), 'typescript'), '.ts');
    expect(files.length).toBeGreaterThan(0);
    const r = typecheck(files);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  }, 120_000);
});

/**
 * Syntax-check every file in a generated agent/ directory: the machine
 * (tsc --strict), the hook scripts and harness plugins (node --check), the
 * harness configs (JSON / YAML parse) and the Cline hook scripts (sh -n).
 * A file of any other kind fails the check, so a new output type has to
 * get a checker here before it can ship.
 */
export function checkAgentDir(agentDir: string): { ok: boolean; output: string; checked: string[] } {
  const checked: string[] = [];
  const fail = (f: string, output: string) => ({ ok: false, output: `${relative(agentDir, f)}\n${output}`, checked });
  const ts = typecheck(filesUnder(agentDir, '.ts'));
  if (!ts.ok) return { ...ts, checked };
  const scratch = mkdtempSync(join(tmpdir(), 'speckl-agent-js-'));
  for (const f of filesUnder(agentDir, '')) {
    const rel = relative(agentDir, f);
    const text = readFileSync(f, 'utf-8');
    if (f.endsWith('.ts')) {
      // Checked above.
    } else if (f.endsWith('.mjs')) {
      const r = run(process.execPath, ['--check', f]);
      if (!r.ok) return fail(f, r.output);
    } else if (f.endsWith('.js')) {
      // Harness plugins are ES modules (OpenClaw ships "type": "module";
      // Pi and OpenCode load them as ESM). Check them as such on any Node.
      const copy = join(scratch, `${rel.replace(/[\\/]/g, '__')}.mjs`);
      writeFileSync(copy, text);
      const r = run(process.execPath, ['--check', copy]);
      if (!r.ok) return fail(f, r.output);
    } else if (f.endsWith('.json')) {
      try { JSON.parse(text); } catch (e) { return fail(f, String(e)); }
    } else if (f.endsWith('.yaml') || f.endsWith('.yml')) {
      try { yaml.load(text); } catch (e) { return fail(f, String(e)); }
    } else if (text.startsWith('#!/bin/sh')) {
      const r = run('sh', ['-n', f]);
      if (!r.ok) return fail(f, r.output);
    } else if (f.endsWith('.md') || f.endsWith('.sha256')) {
      continue; // prose and a digest: nothing to compile
    } else {
      return fail(f, 'no syntax check for this kind of file');
    }
    checked.push(rel);
  }
  return { ok: true, output: '', checked };
}

targetSuite({
  target: 'agent',
  name: 'tsc --strict + node --check + config parse: agent rails and harness adapters',
  toolchain: tsc,
  check: (example) => {
    const out = generate(example, 'agent');
    const agentDir = join(out, 'agent');
    // Specks without an agent block get no rails; their machine is the
    // TypeScript target's and is covered above.
    if (!existsSync(agentDir)) return { ok: true, output: '' };
    return checkAgentDir(agentDir);
  },
});

describe('agent rails syntax checks cover every harness adapter', () => {
  it('ClaudeCodePolicy generates and checks the output of every supported harness', () => {
    const r = checkAgentDir(join(generate('ClaudeCodePolicy', 'agent'), 'agent'));
    const harnesses = new Set(r.checked.filter((f) => f.startsWith('harness/')).map((f) => f.split(/[\\/]/)[1]));
    expect([...SUPPORTED_HARNESSES].filter((h) => !harnesses.has(h))).toEqual([]);
    expect(r.checked).toEqual(expect.arrayContaining(['adapter.mjs', 'hook.mjs', 'signal.mjs', 'ClaudeCodePolicy.ts']));
  });

  it('a syntax error in a harness plugin, config or hook script fails the check', () => {
    const agentDir = join(generate('ClaudeCodePolicy', 'agent'), 'agent');
    const broken: [string, string][] = [
      ['harness/pi/speckl.js', 'export default function ('],
      ['harness/cursor/hooks.json', '{"hooks": '],
      ['harness/hermes/config.yaml', 'hooks:\n  - a\n b: ['],
      ['harness/cline/PreToolUse', '#!/bin/sh\nif then\n'],
      ['harness/unknown.bin', 'x'],
    ];
    for (const [file, text] of broken) {
      const target = join(agentDir, file);
      const original = existsSync(target) ? readFileSync(target, 'utf-8') : undefined;
      writeFileSync(target, text);
      const r = checkAgentDir(agentDir);
      expect(r.ok, file).toBe(false);
      expect(r.output).toContain(file.split('/').pop());
      if (original === undefined) rmSync(target); else writeFileSync(target, original);
    }
    expect(checkAgentDir(agentDir).ok).toBe(true);
  });
});
