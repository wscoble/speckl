// The compile pipeline (src/compile.ts) run in-process.
//
// Before this file, every test that drove the full pipeline spawned
// `vite-node src/index.ts` as a child process, so the pipeline, the AST Z3
// backend, and the Go/Elm generators were exercised but never measured. These
// tests run the same pipeline in the test process and pin its behaviour:
//   - the in-process pipeline and the CLI produce identical files;
//   - every example's output for `-t all` and `-t all-ir` matches a committed
//     digest hash (any change to generated output changes the hash);
//   - invalid input fails the compile and leaves no rails behind.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpec, type CompileOptions } from '../compile.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const examplesDir = join(compilerDir, '..', 'examples');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const examples = readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  }).sort();
}

/**
 * File contents with the run-specific parts masked: the output dir, the
 * checkout location (generators embed the absolute spec path) and
 * wall-clock timestamps. Digests must match on any machine (CI included).
 */
const repoDir = path.resolve(compilerDir, '..');
function normalized(out: string, file: string): string {
  return readFileSync(file, 'utf-8')
    .split(out).join('<OUT>')
    .split(repoDir).join('<REPO>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TIME>');
}

function digests(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const f of walk(out)) r[relative(out, f)] = createHash('sha256').update(normalized(out, f)).digest('hex').slice(0, 16);
  return r;
}

function run(spec: string, target: CompileOptions['target'], out = mkdtempSync(join(tmpdir(), 'speckl-pipe-'))): string {
  compileSpec(spec, { outputDir: out, target, bomFormat: 'both', verifyDepth: 10 });
  return out;
}

beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

describe('in-process pipeline matches the CLI', () => {
  for (const name of ['ReviewGate.speckdl', 'ClaudeCodePolicy.speckdl']) {
    it(`${name} -t all: same files, same bytes`, () => {
      const inproc = run(join(examplesDir, name), 'all');
      const cli = mkdtempSync(join(tmpdir(), 'speckl-pipe-cli-'));
      const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), join(examplesDir, name), '-t', 'all', '-o', cli],
        { cwd: compilerDir, encoding: 'utf-8' });
      expect(r.status, r.stderr).toBe(0);
      const a = walk(inproc).map(f => relative(inproc, f));
      expect(walk(cli).map(f => relative(cli, f))).toEqual(a);
      for (const f of a) expect(normalized(cli, join(cli, f)), f).toBe(normalized(inproc, join(inproc, f)));
    }, 120_000);
  }
});

// One hash of every example's `-t all` and `-t all-ir` digests. The previous
// snapshot file was the full digest map (about 86k characters) and made any
// output change pull that whole file into review.
//
// Update this constant only in the PR that intentionally changes generated
// output. Run this test, replace the constant with the hash it prints, and
// say in that PR why the old bytes were wrong. A whitespace-only edit and a
// reordered file move the hash and are not a reason to update it.
const OUTPUT_SHA256 = '4d432ac8c74e6ad7371ac85d09f0266acd7e76cc9ae971b9ad858e8ee41f7c2a';

describe('generated output is pinned for every example', () => {
  it('pins -t all and -t all-ir for every example', () => {
    const pinned: Record<string, Record<string, string>> = {};
    for (const name of examples) {
      for (const target of ['all', 'all-ir'] as const) {
        pinned[`${name} -t ${target}`] = digests(run(join(examplesDir, name), target));
      }
    }
    const hash = createHash('sha256').update(JSON.stringify(pinned)).digest('hex');
    expect(hash).toBe(OUTPUT_SHA256);
  }, 180_000);

  it('a one-byte change in generated output changes that file digest and the pin', () => {
    const spec = join(examplesDir, 'ReviewGate.speckdl');
    const out = run(spec, 'z3');
    const before = digests(out);
    const file = walk(out)[0];
    const rel = relative(out, file);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
    const after = digests(out);
    expect(after[rel]).not.toBe(before[rel]);
    const beforeHash = createHash('sha256').update(JSON.stringify({ 'ReviewGate.speckdl -t z3': before })).digest('hex');
    const afterHash = createHash('sha256').update(JSON.stringify({ 'ReviewGate.speckdl -t z3': after })).digest('hex');
    expect(afterHash).not.toBe(beforeHash);
    expect(afterHash).not.toBe(OUTPUT_SHA256);
  }, 60_000);

  it('whitespace-only output and reordered output each move the pin', () => {
    const spec = join(examplesDir, 'ReviewGate.speckdl');
    const out = run(spec, 'z3');
    const before = digests(out);
    const file = walk(out)[0];
    const rel = relative(out, file);
    const text = readFileSync(file, 'utf8');
    const pin = (map: Record<string, string>) => createHash('sha256')
      .update(JSON.stringify({ 'ReviewGate.speckdl -t z3': map }))
      .digest('hex');
    const beforePin = pin(before);

    const lines = text.split('\n');
    const spaced = lines[0] + ' ' + (lines.length > 1 ? '\n' + lines.slice(1).join('\n') : '');
    writeFileSync(file, spaced);
    const afterSpace = digests(out);
    expect(afterSpace[rel]).not.toBe(before[rel]);
    expect(pin(afterSpace)).not.toBe(beforePin);

    let i = 0;
    let j = 1;
    while (j < lines.length && lines[i] === lines[j]) j++;
    expect(j).toBeLessThan(lines.length);
    const reordered = lines.slice();
    const hold = reordered[i];
    reordered[i] = reordered[j];
    reordered[j] = hold;
    writeFileSync(file, reordered.join('\n'));
    const afterOrder = digests(out);
    expect(afterOrder[rel]).not.toBe(before[rel]);
    expect(pin(afterOrder)).not.toBe(beforePin);

    // OUTPUT_SHA256 is this same hash over every example. A one-file map is a
    // different JSON value, so comparing it to OUTPUT_SHA256 does not show
    // that the corpus pin moved. Replace one digest inside a corpus-shaped
    // map instead. That is the update the pin sees.
    const corpus = {
      'ReviewGate.speckdl -t z3': before,
      'Other.speckdl -t all': { 'kept.ts': 'abc' },
    };
    const pinOf = (map: Record<string, Record<string, string>>) => createHash('sha256')
      .update(JSON.stringify(map))
      .digest('hex');
    const base = pinOf(corpus);
    expect(pinOf({ ...corpus, 'ReviewGate.speckdl -t z3': afterSpace })).not.toBe(base);
    expect(pinOf({ ...corpus, 'ReviewGate.speckdl -t z3': afterOrder })).not.toBe(base);
    expect(base).not.toBe(OUTPUT_SHA256);

    const missing = { 'ReviewGate.speckdl -t z3': corpus['ReviewGate.speckdl -t z3'] };
    expect(pinOf(missing)).not.toBe(base);
    const extra = { ...corpus, 'Extra.speckdl -t all': { 'extra.ts': 'fff' } };
    expect(pinOf(extra)).not.toBe(base);
    expect(pinOf(missing)).not.toBe(OUTPUT_SHA256);
    expect(pinOf(extra)).not.toBe(OUTPUT_SHA256);
  }, 60_000);
});

describe('target selection', () => {
  const spec = join(examplesDir, 'ReviewGate.speckdl');
  it('-t z3 emits only SMT (no TypeScript, BOMs or provenance)', () => {
    const files = walk(run(spec, 'z3')).map(f => path.basename(f));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => f.endsWith('.smt2'))).toBe(true);
  });
  it('-t rust emits no provenance graph', () => {
    const files = walk(run(spec, 'rust')).map(f => path.basename(f));
    expect(files.some(f => f.endsWith('.rs'))).toBe(true);
    expect(files.some(f => f.endsWith('.prov.jsonld'))).toBe(false);
  });
  it('-t typescript with bomFormat cdx emits no SPDX', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-pipe-'));
    compileSpec(spec, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 10 });
    const files = walk(out).map(f => path.basename(f));
    expect(files).toContain('ReviewGate.specbom.cdx.json');
    expect(files.some(f => f.includes('spdx'))).toBe(false);
  });
  it('a non-agent spec never gets agent rails, even with -t agent', () => {
    expect(existsSync(join(run(spec, 'agent'), 'agent'))).toBe(false);
  });
  it('creates a missing nested output directory', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'speckl-pipe-')), 'a', 'b');
    run(spec, 'z3', out);
    expect(existsSync(join(out, 'ReviewGate.smt2'))).toBe(true);
  });
});

describe('invalid input fails the compile', () => {
  function specFile(src: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-pipe-bad-'));
    const f = join(dir, 'Bad.speckdl');
    writeFileSync(f, src);
    return f;
  }
  it('an unknown action in next: is an error, not a silently dropped alternative', () => {
    const f = specFile(`speck Bad {
    state {
        x: Nat
    }
    init {
        x := 0
    }
    action Inc {
        x := x + 1
    }
    next: Inc | Missing
}
`);
    expect(() => run(f, 'z3')).toThrow(/Missing/);
  });
  it('an invalid agent block emits no rails', () => {
    const f = specFile(`speck Bad {
    state {
        stage: Nat
    }
    init {
        stage := 0
    }
    action Go {
        require stage == 0
        stage := 1
    }
    next: Go
    agent {
        stages stage {
            Idle = 0
            Done = 1
        }
        tool go -> Missing effect act
    }
}
`);
    const out = mkdtempSync(join(tmpdir(), 'speckl-pipe-'));
    expect(() => compileSpec(f, { outputDir: out, target: 'agent', bomFormat: 'both', verifyDepth: 10 }))
      .toThrow(/agent block is invalid:[\s\S]*agent tool go: unknown action "Missing"/);
    expect(existsSync(join(out, 'agent', 'hook.mjs'))).toBe(false);
  });
});

describe('removed syntax is rejected, not ignored', () => {
  const base = (member: string) => `speck C {
    state {
        x: Nat
    }
    init {
        x := 0
    }
    action Inc {
        x := x + 1
    }
${member}
    next: Inc
}
`;
  function compileText(src: string) {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-pipe-comp-'));
    const f = join(dir, 'C.speckdl');
    writeFileSync(f, src);
    return () => run(f, 'elm');
  }
  it('a component block is a parse error', () => {
    expect(compileText(base('    component Board {\n        state: x\n        actions: Inc\n    }'))).toThrow(/component blocks are no longer supported/);
  });
  it('a single-line component is a parse error', () => {
    expect(compileText(base('    component Board { state: x; actions: Inc }'))).toThrow(/component blocks are no longer supported/);
  });
  it('a bare component line is a parse error', () => {
    expect(compileText(base('    component Board'))).toThrow(/component blocks are no longer supported/);
  });
});
