// Compile test: generated Effect (`-t effect`) for every example, plus the
// EffectTranslation fixture, typechecks with this repo's tsc against the
// pinned `effect` devDependency. See helpers/toolchains.ts.
import { dirname, join } from 'node:path';
import { symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { exampleNames, filesUnder, FIXTURES_DIR, generate, run, targetSuite, Probe } from './helpers/toolchains.js';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');
const nodeModules = join(dirname(require.resolve('effect/package.json')), '..');
const tsc: Probe = { ok: true, version: `tsc ${require('typescript/package.json').version} + effect ${require('effect/package.json').version}` };

function typecheck(projectDir: string) {
  symlinkSync(nodeModules, join(projectDir, 'node_modules'));
  return run(process.execPath, [tscBin, '--noEmit', '-p', projectDir]);
}

targetSuite({
  target: 'effect',
  name: 'tsc --strict: generated Effect',
  toolchain: tsc,
  examples: [...exampleNames(), join(FIXTURES_DIR, 'EffectTranslation.speckdl')],
  check: (example) => {
    const projects = filesUnder(generate(example, 'effect'), 'tsconfig.json').map((f) => dirname(f));
    if (projects.length === 0) return { ok: false, output: 'no Effect project (expected <Speck>/tsconfig.json)' };
    for (const project of projects) {
      const r = typecheck(project);
      if (!r.ok) return { ok: false, output: `${project}\n${r.output}` };
    }
    return { ok: true, output: '' };
  },
});
