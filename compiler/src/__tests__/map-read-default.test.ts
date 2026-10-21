// Reading a key a numeric map does not hold.
//
// The Z3 encoding models emptyMap as a constant array of 0, so every proof
// assumes `m[k]` is 0 for a key never written. Go's map read already returns
// the zero value. The TypeScript backend emitted `this.m.get(k)!`, which is
// undefined at runtime, so a running total `m[k] := m[k] + x` stored NaN
// and every later comparison with it was false. Rust indexed with
// `m[&k]` (panics) and Camel unboxed `m.get(k)` (NullPointerException).
// fixtures/MapTotals.speckdl is the regression: a per-period running total.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { filesUnder, generate } from './helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'MapTotals.speckdl');

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

/** Generate `spec` for `target`; returns the concatenated sources ending in `suffix`. */
function sources(spec: string, target: 'typescript' | 'rust' | 'camel' | 'go', suffix: string): string {
  return filesUnder(generate(spec, target), suffix).map(f => readFileSync(f, 'utf-8')).join('\n');
}

/** A temp spec file with numeric and non-numeric maps and a dot-access read. */
function probeSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-mapread-'));
  const file = join(dir, 'Probe.speckdl');
  writeFileSync(file, `speck Probe {
    state {
        totals: Map(Nat, Int)
        names: Map(Nat, String)
        last: Int
        label: String
    }
    init {
        totals := emptyMap
        names := emptyMap
        last := 0
        label := ""
    }
    action Peek(k: Nat) {
        last := totals.k + 1
        label := names[k]
    }
}
`);
  return file;
}

function strictErrors(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-mapread-tc-'));
  const path = join(dir, 'MapTotals.ts');
  writeFileSync(path, source);
  const program = ts.createProgram([path], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, skipLibCheck: true });
  return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

async function load(source: string, cls: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-mapread-rt-'));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = join(dir, 'm.mjs');
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href))[cls];
}

describe('TypeScript: a missing key of a numeric map reads 0', () => {
  const machine = () => sources(FIXTURE, 'typescript', 'MapTotals.ts');

  it('emits `(map.get(k) ?? 0)` around the whole receiver, and initialises maps', () => {
    const out = machine();
    expect(out).toContain('this.totals.set(period, (this.totals.get(period) ?? 0) + amount);');
    expect(out).toContain('this.counts.set(period, (this.counts.get(period) ?? 0) + 1);');
    expect(out).toContain('this.grand = this.grand - (this.totals.get(period) ?? 0);');
    expect(out).toContain('this.totals = new Map();');
    expect(out).not.toMatch(/this\.\(/);
    expect(out).not.toMatch(/(totals|counts)\.get\([^)]*\)!/);
    expect(out).not.toContain('emptyMap');
  });

  it('passes tsc --strict', () => {
    expect(strictErrors(machine())).toEqual([]);
  });

  it('keeps running totals as numbers (regression: new key gave NaN)', async () => {
    const MapTotals = await load(machine(), 'MapTotalsMachine');
    const m = new MapTotals();
    m.Record(3, 10);
    m.Record(3, 5);
    m.Record(4, 7);
    expect(m.totals.get(3)).toBe(15);
    expect(m.totals.get(4)).toBe(7);
    expect(m.counts.get(3)).toBe(2);
    expect(m.grand).toBe(22);
    // A guard on a key never written compares 0 > 0, not NaN > 0.
    expect(() => m.Reset(9)).toThrow('Guard failed');
    m.Reset(3);
    expect(m.grand).toBe(7);
    expect(m.totals.get(3)).toBe(0);
    expect([...m.totals.values()].some(Number.isNaN)).toBe(false);
  });

  it('applies to dot-access reads; non-numeric maps keep the non-null assertion', () => {
    const out = sources(probeSpec(), 'typescript', 'Probe.ts');
    expect(out).toContain('this.last = (this.totals.get(k) ?? 0) + 1;');
    expect(out).toContain('this.label = this.names.get(k)!;');
  });
});

describe('Rust, Camel and Go agree on 0 for a missing numeric key', () => {
  it('Rust reads numeric maps with unwrap_or_default and translates `:= emptyMap` in init', () => {
    const out = sources(FIXTURE, 'rust', '.rs');
    expect(out).toContain('self.totals.insert(period, (self.totals.get(&period).copied().unwrap_or_default() + amount));');
    expect(out).toContain('self.counts.insert(period, (self.counts.get(&period).copied().unwrap_or_default() + 1u64));');
    expect(out).not.toContain('SPECKL-UNTRANSLATED: init');
    expect(out).not.toMatch(/self\.(totals|counts)\[/);
  });

  it('Rust still indexes (fails closed) for a non-numeric value type', () => {
    expect(sources(probeSpec(), 'rust', '.rs')).toContain('self.label = self.names[&k].clone();');
  });

  it('Camel reads numeric maps with getOrDefault and translates `:= emptyMap` in init', () => {
    const out = sources(FIXTURE, 'camel', '.java');
    expect(out).toContain('mapTotalsState.getTotals().put(period, (mapTotalsState.getTotals().getOrDefault(period, 0L) + amount));');
    expect(out).toContain('mapTotalsState.getCounts().getOrDefault(period, 0L) + 1L');
    expect(out).not.toContain('SPECKL-UNTRANSLATED: init');
  });

  it('Go keeps its zero-value read and no longer assigns an undefined `emptyMap`', () => {
    const out = sources(FIXTURE, 'go', '.go');
    expect(out).toContain('m.Totals[period] = m.Totals[period] + amount');
    expect(out).toContain('m.Totals = map[int64]int64{}');
    expect(out).not.toContain('emptyMap');
  });
});
