// Runtime check of fixtures/MapTotals.speckdl with the real toolchains:
// opened periods keep running totals, and reading a period never opened
// fails loudly, naming the map and the key (SPEC.md 2.5): an Err from the
// Rust method, an error from the Go method, a Java NoSuchElementException.
// Move writes totals[src] before it reads totals[dst]; when dst is missing
// every target puts totals[src] back. The TypeScript side is in
// map-missing-key.test.ts. See helpers/toolchains.ts for how a missing
// toolchain is reported.
import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { all, filesUnder, FIXTURES_DIR, gate, generate, probe, run, Probe } from './helpers/toolchains.js';
// @ts-ignore plain ESM script shared with `npm run test:compile`
import { DEPS, depPath, missingDeps } from '../../scripts/fetch-compile-deps.mjs';

const FIXTURE = join(FIXTURES_DIR, 'MapTotals.speckdl');

const cargo = all(probe('cargo', ['--version']), probe('rustc', ['--version']));
const rust = gate('cargo test: MapTotals running totals', cargo);
describe.skipIf(rust.skip)(rust.title, () => {
  it('opened periods keep running totals; an unopened one is an Err naming map and key, with earlier writes undone', () => {
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
    fn unopened_period_is_an_err() {
        let mut m = MapTotalsMachine::new();
        let e = m.record(9, 1).unwrap_err();
        assert_eq!(e, "SPECKL-MISSING-KEY: totals[9] is not set");
        assert!(!m.totals.contains_key(&9));
    }
    #[test]
    fn move_to_unopened_period_undoes_the_debit() {
        let mut m = MapTotalsMachine::new();
        m.open(1).unwrap();
        m.record(1, 10).unwrap();
        let e = m.r#move(1, 9, 4).unwrap_err();
        assert_eq!(e, "SPECKL-MISSING-KEY: totals[9] is not set");
        assert_eq!(m.totals[&1], 10);
        m.open(2).unwrap();
        m.r#move(1, 2, 4).unwrap();
        assert_eq!(m.totals[&1], 6);
        assert_eq!(m.totals[&2], 4);
    }
}
`);
    const target = mkdtempSync(join(tmpdir(), 'speckl-cargo-target-'));
    const r = run('cargo', ['test', '--offline', '--quiet'], dirname(manifest), { CARGO_TARGET_DIR: target });
    expect(r.output).toMatch(/3 passed|test result: ok\. 3 passed/);
    expect(r.ok).toBe(true);
  }, 300_000);
});

const goTool = probe('go', ['version']);
const go = gate('go test: MapTotals running totals', goTool);
describe.skipIf(go.skip)(go.title, () => {
  it('opened periods keep running totals; an unopened one is an error naming map and key, with earlier writes undone', () => {
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

func TestUnopenedPeriodIsAnError(t *testing.T) {
	m := NewMapTotalsMachine()
	err := m.Record(9, 1)
	if err == nil || err.Error() != "SPECKL-MISSING-KEY: totals[9] is not set" {
		t.Fatalf("want the missing-key error, got %v", err)
	}
	if _, ok := m.Totals[9]; ok {
		t.Fatal("totals[9] was written")
	}
}

func TestMoveToUnopenedPeriodUndoesTheDebit(t *testing.T) {
	m := NewMapTotalsMachine()
	if err := m.Open(1); err != nil {
		t.Fatal(err)
	}
	if err := m.Record(1, 10); err != nil {
		t.Fatal(err)
	}
	err := m.Move(1, 9, 4)
	if err == nil || !strings.Contains(err.Error(), "SPECKL-MISSING-KEY: totals[9] is not set") {
		t.Fatalf("want the missing-key error, got %v", err)
	}
	if m.Totals[1] != 10 {
		t.Fatalf("totals[1] = %d, want 10 (the debit undone)", m.Totals[1])
	}
	if err := m.Open(2); err != nil {
		t.Fatal(err)
	}
	if err := m.Move(1, 2, 4); err != nil {
		t.Fatal(err)
	}
	if m.Totals[1] != 6 || m.Totals[2] != 4 {
		t.Fatalf("totals=%v", m.Totals)
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
  it('compiles, SpecklRuntime.mustGet throws naming map and key, and Move undoes its debit on a miss', () => {
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
    // Run the Move processor itself against a header-only Exchange: a move
    // to a period never opened throws and leaves totals[1] at 10.
    const moveDir = join(mkdtempSync(join(tmpdir(), 'speckl-java-move-')), 'maptotals', 'camel', 'processor');
    mkdirSync(moveDir, { recursive: true });
    const moveCheck = join(moveDir, 'MoveRollbackCheck.java');
    writeFileSync(moveCheck, `package maptotals.camel.processor;

import java.lang.reflect.Proxy;
import java.util.Map;
import org.apache.camel.Exchange;
import org.apache.camel.Message;
import maptotals.camel.MapTotalsState;

public class MoveRollbackCheck {
    static Exchange exchange(Map<String, Long> headers) {
        Message in = (Message) Proxy.newProxyInstance(Message.class.getClassLoader(), new Class<?>[] { Message.class },
            (p, m, args) -> m.getName().equals("getHeader") ? headers.get((String) args[0]) : null);
        return (Exchange) Proxy.newProxyInstance(Exchange.class.getClassLoader(), new Class<?>[] { Exchange.class },
            (p, m, args) -> m.getName().equals("getIn") || m.getName().equals("getMessage") ? in : null);
    }
    public static void main(String[] a) throws Exception {
        MapTotalsState state = new MapTotalsState();
        state.getTotals().put(1L, 10L);
        MoveProcessor move = new MoveProcessor();
        move.mapTotalsState = state;
        try {
            move.process(exchange(Map.of("src", 1L, "dst", 9L, "amount", 4L)));
            throw new AssertionError("no throw");
        } catch (java.util.NoSuchElementException e) {
            System.out.println(e.getMessage());
        }
        if (state.getTotals().get(1L) != 10L || state.getTotals().containsKey(9L)) throw new AssertionError("not undone: " + state.getTotals());
        state.getTotals().put(2L, 0L);
        move.process(exchange(Map.of("src", 1L, "dst", 2L, "amount", 4L)));
        if (state.getTotals().get(1L) != 6L || state.getTotals().get(2L) != 4L) throw new AssertionError("move: " + state.getTotals());
        System.out.println("rollback ok");
    }
}
`);
    const m = run('javac', ['-proc:none', '-Xlint:none', '--release', '21', '-cp', cp, '-d', classes, moveCheck]);
    expect(m.output).toBe('');
    const mx = run('java', ['-cp', cp, 'maptotals.camel.processor.MoveRollbackCheck']);
    expect(mx.output.trim()).toBe('SPECKL-MISSING-KEY: totals[9] is not set\nrollback ok');
    expect(mx.ok).toBe(true);
  }, 120_000);
});
