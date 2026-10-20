// Compile test: every example's generated Go module builds with `go build`
// (offline: no module proxy, local toolchain). See helpers/toolchains.ts.
import { dirname } from 'node:path';
import { filesUnder, generate, probe, run, targetSuite } from './helpers/toolchains.js';

targetSuite({
  target: 'go',
  name: 'go build: generated Go modules',
  toolchain: probe('go', ['version']),
  check: (example) => {
    const mods = filesUnder(generate(example, 'go'), 'go.mod');
    if (mods.length !== 1) return { ok: false, output: `expected one go.mod, found ${mods.length}` };
    return run('go', ['build', './...'], dirname(mods[0]), { GOFLAGS: '-mod=mod', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off' });
  },
});
