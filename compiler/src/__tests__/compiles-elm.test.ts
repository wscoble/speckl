// Compile test: every example's generated Elm app builds with `elm make`,
// using the package cache that scripts/fetch-compile-deps.mjs fills (Elm
// works offline once its cache has the packages). See helpers/toolchains.ts.
import { dirname, join } from 'node:path';
import { all, filesUnder, generate, probe, run, targetSuite, Probe } from './helpers/toolchains.js';
// @ts-ignore plain ESM script shared with `npm run test:compile`
import { elmHome, missingElmPackages } from '../../scripts/fetch-compile-deps.mjs';

const missing: string[] = missingElmPackages();
const packages: Probe = missing.length
  ? { ok: false, reason: `Elm packages not cached in ${elmHome()}: ${missing.join(', ')} (run \`node scripts/fetch-compile-deps.mjs\`)` }
  : { ok: true, version: 'packages cached' };

targetSuite({
  target: 'elm',
  name: 'elm make: generated Elm apps',
  toolchain: all(probe('elm', ['--version']), packages),
  check: (example) => {
    const projects = filesUnder(generate(example, 'elm'), 'elm.json');
    if (projects.length !== 1) return { ok: false, output: `expected one elm.json, found ${projects.length}` };
    return run('elm', ['make', join('src', 'Main.elm'), '--output=/dev/null'], dirname(projects[0]));
  },
});
