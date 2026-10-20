// Compile test: every example's generated Rust crate type-checks with
// `cargo check --offline`. See helpers/toolchains.ts.
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { all, filesUnder, generate, probe, run, targetSuite } from './helpers/toolchains.js';

const targetDir = mkdtempSync(join(tmpdir(), 'speckl-cargo-target-'));

targetSuite({
  target: 'rust',
  name: 'cargo check: generated Rust crates',
  toolchain: all(probe('cargo', ['--version']), probe('rustc', ['--version'])),
  check: (example) => {
    const manifests = filesUnder(generate(example, 'rust'), 'Cargo.toml');
    if (manifests.length !== 1) return { ok: false, output: `expected one Cargo.toml, found ${manifests.length}` };
    return run('cargo', ['check', '--offline', '--quiet'], dirname(manifests[0]), { CARGO_TARGET_DIR: targetDir });
  },
});
