// Runtime check of fixtures/MapTotals.speckdl with the real toolchains:
// opened periods keep running totals, and reading a period never opened
// fails loudly, naming the map and the key (SPEC.md 2.5): a Rust panic, a
// Go panic, a Java NoSuchElementException. The TypeScript side is in
// map-missing-key.test.ts. See helpers/toolchains.ts for how a missing
// toolchain is reported.
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
  it('opened periods keep running totals; an unopened one panics naming map and key', () => {
    expect(cargo.reason ?? 'ok').toBe('ok');
    const [manifest] = filesUnder(generate(FIXTURE, 'rust'), 'Cargo.toml');
    appendFileSync(join(dirname(manifest), 'src', 'lib.rs'), `
#[cfg(test)]
mod map_totals_runtime {
    use super::*;
    #[test]
    fn running_totals() {
        let mut m = MapTotalsMachine::new();
        m.open(3).unwrap();
        m.open(4).unwrap();
        m.record(3, 10).unwrap();
        m.record(3, 5).unwrap();
        m.record(4, 7).unwrap();
        assert_eq!(m.totals[&3], 15);
        assert_eq!(m.totals[&4], 7);
        assert_eq!(m.counts[&3], 2);
        assert_eq!(m.grand, 22);
        m.reset(3).unwrap();
        assert_eq!(m.grand, 7);
        assert!(m.reset(3).is_err());
    }
    #[test]
    #[should_panic(expected = "SPECKL-MISSING-KEY: totals[9] is not set")]
    fn unopened_period_panics() {
        let mut m = MapTotalsMachine::new();
        let _ = m.record(9, 1);
    }
}
`);
    const target = mkdtempSync(join(tmpdir(), 'speckl-cargo-target-'));
    const r = run('cargo', ['test', '--offline', '--quiet'], dirname(manifest), { CARGO_TARGET_DIR: target });
    expect(r.output).toMatch(/2 passed|test result: ok\. 2 passed/);
    expect(r.ok).toBe(true);
  }, 300_000);
});

const goTool = probe('go', ['version']);
const go = gate('go test: MapTotals running totals', goTool);
describe.skipIf(go.skip)(go.title, () => {
  it('opened periods keep running totals; an unopened one panics naming map and key', () => {
    expect(goTool.reason ?? 'ok').toBe('ok');
    const [mod] = filesUnder(generate(FIXTURE, 'go'), 'go.mod');
    writeFileSync(join(dirname(mod), 'runtime_test.go'), `package map_totals

import (
	"strings"
	"testing"
)

func TestRunningTotals(t *testing.T) {
	m := NewMapTotalsMachine()
	for _, p := range []int64{3, 4} {
		if err := m.Open(p); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range [][2]int64{{3, 10}, {3, 5}, {4, 7}} {
		if err := m.Record(r[0], r[1]); err != nil {
			t.Fatal(err)
		}
	}
	if m.Totals[3] != 15 || m.Totals[4] != 7 || m.Counts[3] != 2 || m.Grand != 22 {
		t.Fatalf("totals=%v counts=%v grand=%d", m.Totals, m.Counts, m.Grand)
	}
}

func TestUnopenedPeriodPanics(t *testing.T) {
	m := NewMapTotalsMachine()
	defer func() {
		r := recover()
		if s, _ := r.(string); !strings.Contains(s, "SPECKL-MISSING-KEY: totals[9] is not set") {
			t.Fatalf("want a missing-key panic, got %v", r)
		}
	}()
	_ = m.Record(9, 1)
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
  it('compiles, and SpecklRuntime.mustGet throws naming map and key', () => {
    expect(javaTool.reason ?? 'ok').toBe('ok');
    const classpath = (DEPS as { group: string }[]).filter((d) => d.group === 'java').map(depPath).join(delimiter);
    const sources = filesUnder(join(generate(FIXTURE, 'camel'), 'camel'), '.java');
    const classes = mkdtempSync(join(tmpdir(), 'speckl-javac-'));
    const r = run('javac', ['-proc:none', '-Xlint:none', '-encoding', 'UTF-8', '--release', '21', '-cp', classpath, '-d', classes, ...sources]);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
    // Run the read helper the processors call: a held key reads its value,
    // a missing one throws naming the map and the key.
    const check = join(mkdtempSync(join(tmpdir(), 'speckl-java-run-')), 'MissingKeyCheck.java');
    writeFileSync(check, `public class MissingKeyCheck {
    public static void main(String[] a) {
        java.util.Map<Long, Long> m = new java.util.HashMap<>();
        m.put(3L, 15L);
        if (maptotals.camel.SpecklRuntime.mustGet(m, 3L, "totals") != 15L) throw new AssertionError("held key");
        try {
            maptotals.camel.SpecklRuntime.mustGet(m, 9L, "totals");
            throw new AssertionError("no throw");
        } catch (java.util.NoSuchElementException e) {
            System.out.println(e.getMessage());
        }
    }
}
`);
    const cp = [classes, classpath].join(delimiter);
    const c = run('javac', ['-proc:none', '-Xlint:none', '--release', '21', '-cp', cp, '-d', classes, check]);
    expect(c.output).toBe('');
    const x = run('java', ['-cp', cp, 'MissingKeyCheck']);
    expect(x.output.trim()).toBe('SPECKL-MISSING-KEY: totals[9] is not set');
    expect(x.ok).toBe(true);
  }, 120_000);
});
