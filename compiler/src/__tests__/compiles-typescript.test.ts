// Compile tests: generated TypeScript (`-t typescript`) and the agent rails
// (`-t agent`: the generated machine plus the .mjs hook scripts), checked
// with this repo's own `tsc` under --strict and with `node --check`.
// See helpers/toolchains.ts.
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { filesUnder, generate, run, targetSuite, Probe } from './helpers/toolchains.js';

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

targetSuite({
  target: 'agent',
  name: 'tsc --strict + node --check: agent rails',
  toolchain: tsc,
  check: (example) => {
    const out = generate(example, 'agent');
    const agentDir = join(out, 'agent');
    // Specks without an agent block get no rails; their machine is the
    // TypeScript target's and is covered above.
    if (!existsSync(agentDir)) return { ok: true, output: '' };
    const ts = typecheck(filesUnder(agentDir, '.ts'));
    if (!ts.ok) return ts;
    for (const f of filesUnder(agentDir, '.mjs')) {
      const r = run(process.execPath, ['--check', f]);
      if (!r.ok) return { ok: false, output: `${f}\n${r.output}` };
    }
    return { ok: true, output: '' };
  },
});
