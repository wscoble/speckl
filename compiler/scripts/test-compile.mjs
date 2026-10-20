#!/usr/bin/env node
// `npm run test:compile`: fetch the pinned compile deps if missing, then
// run the compile tests (src/__tests__/compiles-*.test.ts) with every
// toolchain required, so a missing compiler fails instead of skipping.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const step = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step(process.execPath, ['scripts/fetch-compile-deps.mjs']);
step('npx', ['vitest', 'run', 'compiles-', ...process.argv.slice(2)], { SPECKL_REQUIRE_TOOLCHAINS: '1' });
