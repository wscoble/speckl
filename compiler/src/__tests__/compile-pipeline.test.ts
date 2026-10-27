// The compile pipeline (src/compile.ts) run in-process.
//
// Before this file, every test that drove the full pipeline spawned
// `vite-node src/index.ts` as a child process, so the pipeline, the AST Z3
// backend, and the Go/Elm generators were exercised but never measured. These
// tests run the same pipeline in the test process and pin its behaviour:
//   - the in-process pipeline and the CLI produce identical files;
//   - every example's output for `-t all` and `-t all-ir` matches a committed
//     digest (any change to generated output shows up as a snapshot diff);
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

const outputBaseline = JSON.parse(readFileSync(join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trace', 'example-output-baseline.json'), 'utf8')) as {
  allow: string[];
  digests: Record<string, Record<string, string>>;
};

/** Example artifacts other than the hook, its decision-record module, and the agent docs stay byte-identical once paths and timestamps are masked. */
function assertExampleOutput(name: string, target: string, got: Record<string, string>) {
  const key = `${name} -t ${target}`;
  const expected = outputBaseline.digests[key];
  expect(expected, key).toBeTruthy();
  const allow = new Set(outputBaseline.allow);
  for (const [file, hash] of Object.entries(expected)) {
    if (allow.has(file)) continue;
    expect(got[file], `${key} ${file}`).toBe(hash);
  }
  for (const file of Object.keys(got)) {
    if (allow.has(file)) continue;
    expect(expected, `${key} unexpected file ${file}`).toHaveProperty(file);
  }
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

describe('generated output is pinned for every example', () => {
  for (const name of examples) {
    for (const target of ['all', 'all-ir'] as const) {
      it(`${name} -t ${target}`, () => {
        const got = digests(run(join(examplesDir, name), target));
        assertExampleOutput(name, target, got);
        expect(got).toMatchSnapshot();
      }, 60_000);
    }
  }
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
