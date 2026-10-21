// Reading a key a map does not hold (SPEC.md 2.5).
//
// Generated code fails loudly: TypeScript throws, Rust and Go panic, Camel
// throws, each with `SPECKL-MISSING-KEY: <map>[<key>] is not set`. Nothing
// reads as 0, and the Z3 encoding assumes no value for such a key either
// (`x := emptyMap` leaves the array unconstrained). Before, TypeScript read
// `undefined` (a running total became NaN), Rust panicked without naming
// the map, Camel unboxed null, and Go read the zero value.
// fixtures/MapTotals.speckdl is the regression: a per-period running total
// whose periods must be opened first.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { filesUnder, generate } from './helpers/toolchains.js';
import { wrapMapReads } from '../generators/go.js';
import { isEmptyMapExpr } from '../generators/z3.js';

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

const MISSING = /SPECKL-MISSING-KEY: (totals|counts)\[9\] is not set/;

describe('TypeScript: a missing key throws, naming the map and the key', () => {
  const machine = () => sources(FIXTURE, 'typescript', 'MapTotals.ts');

  it('reads through specklMissing around the whole receiver, and initialises maps', () => {
    const out = machine();
    expect(out).toContain("this.totals.set(period, (this.totals.get(period) ?? specklMissing('totals', period)) + amount);");
    expect(out).toContain("this.counts.set(period, (this.counts.get(period) ?? specklMissing('counts', period)) + 1);");
    expect(out).toContain("this.grand = this.grand - (this.totals.get(period) ?? specklMissing('totals', period));");
    expect(out).toContain('this.totals = new Map();');
    expect(out).not.toMatch(/this\.\(/);
    expect(out).not.toMatch(/\?\? 0\b/);
    expect(out).not.toMatch(/(totals|counts)\.get\([^)]*\)!/);
    expect(out).not.toContain('emptyMap');
    expect(out).not.toContain('FIXME');
  });

  it('passes tsc --strict', () => {
    expect(strictErrors(machine())).toEqual([]);
  });

  it('opened periods keep running totals; an unopened one throws and changes nothing', async () => {
    const MapTotals = await load(machine(), 'MapTotalsMachine');
    const m = new MapTotals();
    m.Open(3);
    m.Open(4);
    m.Record(3, 10);
    m.Record(3, 5);
    m.Record(4, 7);
    expect(m.totals.get(3)).toBe(15);
    expect(m.totals.get(4)).toBe(7);
    expect(m.counts.get(3)).toBe(2);
    expect(m.grand).toBe(22);
    // Regression: a key never written used to read undefined (NaN totals,
    // guards silently false). It now throws before any write.
    expect(() => m.Record(9, 1)).toThrow(MISSING);
    expect(() => m.Reset(9)).toThrow(MISSING);
    expect(m.totals.has(9)).toBe(false);
    expect(m.grand).toBe(22);
    m.Reset(3);
    expect(m.grand).toBe(7);
    expect(m.totals.get(3)).toBe(0);
    // A stored 0 is a value, not a missing key: the guard fails, no throw of the missing kind.
    expect(() => m.Reset(3)).toThrow('Guard failed');
  });

  it('applies to dot-access reads and to every non-nullable value type', () => {
    const out = sources(probeSpec(), 'typescript', 'Probe.ts');
    expect(out).toContain("this.last = (this.totals.get(k) ?? specklMissing('totals', k)) + 1;");
    expect(out).toContain("this.label = (this.names.get(k) ?? specklMissing('names', k));");
  });
});

/** A temp spec with a Real-valued map and a nullable numeric map. */
function realAndNullableSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-mapread-'));
  const file = join(dir, 'RN.speckdl');
  writeFileSync(file, `speck RN {
    state {
        prices: Map(Nat, Real)
        maybe: Map(Nat, Int | null)
        sum: Real
        last: Int
    }
    init {
        prices := emptyMap
        maybe := emptyMap
        sum := 0.0
        last := 0
    }
    action Add(k: Nat, p: Real) {
        prices[k] := prices[k] + p
        sum := sum + prices[k]
    }
    action Peek(k: Nat) {
        require maybe[k] != null
        last := maybe[k]
    }
}
`);
  return file;
}

describe('Real and nullable value types', () => {
  it('a Real map fails loudly too in every backend', () => {
    const spec = realAndNullableSpec();
    expect(sources(spec, 'typescript', 'RN.ts')).toContain("this.prices.set(k, (this.prices.get(k) ?? specklMissing('prices', k)) + p);");
    expect(sources(spec, 'rust', '.rs')).toContain('(*self.prices.get(&k).unwrap_or_else(|| speckl_missing("prices", &k)))');
    expect(sources(spec, 'camel', '.java')).toMatch(/SpecklRuntime\.mustGet\(\w+\.getPrices\(\), k, "prices"\)/);
    expect(sources(spec, 'go', '.go')).toContain('specklGet(m.Prices, k, "prices")');
  });

  it('a nullable map keeps its stored null (TypeScript, Camel, Go): no throw for null, no 0', async () => {
    const spec = realAndNullableSpec();
    const tsOut = sources(spec, 'typescript', 'RN.ts');
    expect(tsOut).toContain('this.last = this.maybe.get(k)!;');
    expect(tsOut).not.toMatch(/specklMissing\('maybe'/);
    expect(sources(spec, 'camel', '.java')).toMatch(/getMaybe\(\)\.get\(k\)/);
    expect(sources(spec, 'go', '.go')).not.toContain('specklGet(m.Maybe');
    const RN = await load(tsOut, 'RNMachine');
    const m = new RN();
    m.maybe.set(1, null);
    expect(() => m.Peek(1)).toThrow('Guard failed');
    m.maybe.set(2, 5);
    m.Peek(2);
    expect(m.last).toBe(5);
  });
});

describe('Rust, Camel and Go fail loudly on a missing key', () => {
  it('Rust reads through speckl_missing (panics naming map and key) and translates `:= emptyMap` in init', () => {
    const out = sources(FIXTURE, 'rust', '.rs');
    expect(out).toContain('self.totals.insert(period, ((*self.totals.get(&period).unwrap_or_else(|| speckl_missing("totals", &period))) + amount));');
    expect(out).toContain('fn speckl_missing<K: std::fmt::Debug + ?Sized>(map: &str, key: &K) -> !');
    expect(out).not.toContain('SPECKL-UNTRANSLATED: init');
    expect(out).not.toContain('unwrap_or_default');
    expect(out).not.toMatch(/self\.(totals|counts)\[/);
  });

  it('Rust uses the same read for a non-numeric value type', () => {
    expect(sources(probeSpec(), 'rust', '.rs')).toContain('self.label = (*self.names.get(&k).unwrap_or_else(|| speckl_missing("names", &k))).clone();');
  });

  it('Camel reads through SpecklRuntime.mustGet and translates `:= emptyMap` in init', () => {
    const out = sources(FIXTURE, 'camel', '.java');
    expect(out).toContain('mapTotalsState.getTotals().put(period, (maptotals.camel.SpecklRuntime.mustGet(mapTotalsState.getTotals(), period, "totals") + amount));');
    expect(out).toContain('throw new java.util.NoSuchElementException("SPECKL-MISSING-KEY: " + name + "[" + key + "] is not set");');
    expect(out).not.toContain('getOrDefault');
    expect(out).not.toContain('SPECKL-UNTRANSLATED: init');
  });

  it('Go reads through specklGet (panics) and assigns no undefined `emptyMap`', () => {
    const out = sources(FIXTURE, 'go', '.go');
    expect(out).toContain('m.Totals[period] = specklGet(m.Totals, period, "totals") + amount');
    expect(out).toContain('if !(specklGet(m.Totals, period, "totals") > 0) {');
    expect(out).toContain('panic(fmt.Sprintf("SPECKL-MISSING-KEY: %s[%v] is not set", name, k))');
    expect(out).toContain('m.Totals = map[int64]int64{}');
    expect(out).not.toContain('emptyMap');
  });
});

describe('wrapMapReads (Go)', () => {
  it('wraps innermost reads first and leaves an unbalanced bracket alone', () => {
    const open = /(?<![\w.])(?:m\.Idx|idx)\[/;
    expect(wrapMapReads('idx[idx[a] + 1] + m.Idx[b[0]]', open, 'Idx', 'idx'))
      .toBe('specklGet(m.Idx, specklGet(m.Idx, a, "idx") + 1, "idx") + specklGet(m.Idx, b[0], "idx")');
    expect(wrapMapReads('idx[a', open, 'Idx', 'idx')).toBe('idx[a');
  });
});

describe('Z3: a map initialised to emptyMap assumes no value for any key', () => {
  it('leaves the array unconstrained in both encodings (no constant 0)', () => {
    const dir = generate(FIXTURE, 'z3');
    const ast = filesUnder(dir, 'MapTotals.smt2').map(f => readFileSync(f, 'utf-8')).join('\n');
    const ir = filesUnder(dir, 'MapTotals.ir.smt2').map(f => readFileSync(f, 'utf-8')).join('\n');
    expect(ast + ir).not.toMatch(/as const \(Array Int Int\)\) 0/);
    expect(ir).toContain('; init totals := emptyMap: no keys; values unconstrained');
    expect(ir).toContain('(assert (= grand 0))');
    expect(ir).not.toMatch(/skipped: references undeclared identifier\(s\): emptyMap/);
  });

  it('the bounded model check keeps the other init constraints (they were dropped with emptyMap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-mapread-z3-'));
    const file = join(dir, 'Z.speckdl');
    writeFileSync(file, `speck Z {
    state {
        totals: Map(Nat, Int)
        grand: Int
    }
    init {
        totals := emptyMap
        grand := 0
    }
    invariant ZeroStart {
        totals[3] == 0
    }
    action Bump {
        totals[1] := totals[1] + 1
    }
    verify Always(ZeroStart) {
        depth 2
    }
}
`);
    const ast = filesUnder(generate(file, 'z3'), 'Z.smt2').map(f => readFileSync(f, 'utf-8')).join('\n');
    const init = ast.slice(ast.indexOf('; Initial state constraints'), ast.indexOf('; Transition constraints'));
    expect(init).toContain('; totals := emptyMap: no keys; values unconstrained');
    expect(init).toContain('(= grand_0 0)');
    expect(init).not.toContain('skipped');
  });

  it('isEmptyMapExpr recognises emptyMap with or without parentheses', () => {
    expect(isEmptyMapExpr(' emptyMap ')).toBe(true);
    expect(isEmptyMapExpr('emptyMap()')).toBe(true);
    expect(isEmptyMapExpr('emptySet')).toBe(false);
  });
});
