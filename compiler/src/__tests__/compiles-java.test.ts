// Compile test: every example's generated Camel project must compile with
// javac against the pinned Camel 4.8.0 / Jakarta APIs it imports
// (scripts/fetch-compile-deps.mjs). See helpers/toolchains.ts for how a
// missing toolchain is reported.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { all, exampleNames, filesUnder, FIXTURES_DIR, gate, generate, probe, run, Probe } from './helpers/toolchains.js';
// @ts-ignore plain ESM script shared with `npm run test:compile`
import { DEPS, depPath, missingDeps } from '../../scripts/fetch-compile-deps.mjs';

function javaDeps(): Probe {
  const missing = missingDeps('java');
  if (missing.length) return { ok: false, reason: `pinned Camel/Jakarta jars not cached (run \`node scripts/fetch-compile-deps.mjs\`)` };
  return { ok: true, version: 'Camel 4.8.0 API' };
}

const toolchain = all(probe('javac', ['-version']), javaDeps());
const { title, skip } = gate('javac: generated Camel projects', toolchain);
const classpath = (DEPS as { group: string }[]).filter((d) => d.group === 'java').map(depPath).join(delimiter);

describe.skipIf(skip)(title, () => {
  it('toolchain is available', () => {
    expect(toolchain.reason ?? 'ok').toBe('ok');
  });

  // The examples, plus a fixture with every form the translator handles.
  const cases: [string, string][] = [
    ...exampleNames().map((e): [string, string] => [e, e]),
    ['fixture CamelTranslation', join(FIXTURES_DIR, 'CamelTranslation.speckdl')],
  ];
  it.each(cases)('%s', (_label, example) => {
    expect(toolchain.ok).toBe(true);
    const out = generate(example, 'camel');
    const sources = filesUnder(join(out, 'camel'), '.java');
    expect(sources.length).toBeGreaterThan(0);
    const classes = mkdtempSync(join(tmpdir(), 'speckl-javac-'));
    const r = run('javac', ['-proc:none', '-Xlint:none', '-encoding', 'UTF-8', '--release', '21', '-cp', classpath, '-d', classes, ...sources]);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
    expect(existsSync(classes)).toBe(true);
  }, 120_000);
});
