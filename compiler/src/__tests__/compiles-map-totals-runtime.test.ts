// Runtime check of fixtures/MapTotals.speckdl with the real toolchains: a
// running total on a key the map does not hold yet starts at 0 in the
// generated Rust and Go, matching the Z3 encoding (emptyMap is a constant
// array of 0) and the TypeScript backend (map-read-default.test.ts). The
// Camel project is compiled with javac. See helpers/toolchains.ts for how a
// missing toolchain is reported.
import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { all, filesUnder, FIXTURES_DIR, gate, generate, probe, run, Probe } from './helpers/toolchains.js';
// @ts-ignore plain ESM script shared with `npm run test:compile`
import { DEPS, depPath, missingDeps } from '../../scripts/fetch-compile-deps.mjs';

const FIXTURE = join(FIXTURES_DIR, 'MapTotals.speckdl');

const cargo = all(probe('cargo', ['--version']), probe('rustc', ['--version']));
const rust = gate('cargo test: MapTotals running totals', cargo);
describe.skipIf(rust.skip)(rust.title, () => {
  it('a new key starts at 0, a missing key fails the guard instead of panicking', () => {
    expect(cargo.reason ?? 'ok').toBe('ok');
    const [manifest] = filesUnder(generate(FIXTURE, 'rust'), 'Cargo.toml');
    appendFileSync(join(dirname(manifest), 'src', 'lib.rs'), `
#[cfg(test)]
mod map_totals_runtime {
    use super::*;
    #[test]
    fn running_totals() {
        let mut m = MapTotalsMachine::new();
        m.record(3, 10).unwrap();
        m.record(3, 5).unwrap();
        m.record(4, 7).unwrap();
        assert_eq!(m.totals[&3], 15);
        assert_eq!(m.totals[&4], 7);
        assert_eq!(m.counts[&3], 2);
        assert_eq!(m.grand, 22);
        assert!(m.reset(9).is_err());
        m.reset(3).unwrap();
        assert_eq!(m.grand, 7);
    }
}
`);
    const target = mkdtempSync(join(tmpdir(), 'speckl-cargo-target-'));
    const r = run('cargo', ['test', '--offline', '--quiet'], dirname(manifest), { CARGO_TARGET_DIR: target });
    expect(r.output).toContain('1 passed');
    expect(r.ok).toBe(true);
  }, 300_000);
});

const goTool = probe('go', ['version']);
const go = gate('go test: MapTotals running totals', goTool);
describe.skipIf(go.skip)(go.title, () => {
  it('a new key starts at 0 (Go zero value) and init needs no emptyMap identifier', () => {
    expect(goTool.reason ?? 'ok').toBe('ok');
    const [mod] = filesUnder(generate(FIXTURE, 'go'), 'go.mod');
    writeFileSync(join(dirname(mod), 'runtime_test.go'), `package map_totals

import "testing"

func TestRunningTotals(t *testing.T) {
	m := NewMapTotalsMachine()
	for _, r := range [][2]int64{{3, 10}, {3, 5}, {4, 7}} {
		if err := m.Record(r[0], r[1]); err != nil {
			t.Fatal(err)
		}
	}
	if m.Totals[3] != 15 || m.Totals[4] != 7 || m.Counts[3] != 2 || m.Grand != 22 {
		t.Fatalf("totals=%v counts=%v grand=%d", m.Totals, m.Counts, m.Grand)
	}
	if m.Reset(9) == nil {
		t.Fatal("Reset on a key never written should fail its guard")
	}
}
`);
    const r = run('go', ['test', './...'], dirname(mod), { GOFLAGS: '-mod=mod', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off' });
    expect(r.output).toMatch(/^ok\s/m);
    expect(r.ok).toBe(true);
  }, 300_000);
});

function javaDeps(): Probe {
  const missing = missingDeps('java');
  if (missing.length) return { ok: false, reason: 'pinned Camel/Jakarta jars not cached (run `node scripts/fetch-compile-deps.mjs`)' };
  return { ok: true, version: 'Camel 4.8.0 API' };
}
const javaTool = all(probe('javac', ['-version']), javaDeps());
const java = gate('javac: MapTotals Camel project', javaTool);
describe.skipIf(java.skip)(java.title, () => {
  it('compiles with the getOrDefault reads', () => {
    expect(javaTool.reason ?? 'ok').toBe('ok');
    const classpath = (DEPS as { group: string }[]).filter((d) => d.group === 'java').map(depPath).join(delimiter);
    const sources = filesUnder(join(generate(FIXTURE, 'camel'), 'camel'), '.java');
    const classes = mkdtempSync(join(tmpdir(), 'speckl-javac-'));
    const r = run('javac', ['-proc:none', '-Xlint:none', '-encoding', 'UTF-8', '--release', '21', '-cp', classpath, '-d', classes, ...sources]);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  }, 120_000);
});
