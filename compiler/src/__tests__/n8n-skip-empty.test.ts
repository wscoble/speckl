// The n8n skip on -t all / -t all-ir must not exit 0 when this run wrote
// nothing. A file that was already in the output directory does not count.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ write: false }));

vi.mock('../generators/k8s-crd.js', () => ({
  generateK8sCRD: (_ir: unknown, opts: { outputDir: string }) => {
    if (gate.write) writeFileSync(path.join(opts.outputDir, 'wrote-this-run.txt'), 'x\n');
  },
}));
vi.mock('../generators/openapi.js', () => ({
  OpenAPITarget: class { generate(): void {} },
}));
vi.mock('../generators/camel.js', () => ({ generateCamel: () => {} }));
vi.mock('../generators/provenance-from-ir.js', () => ({ generateProvenanceFromIR: () => {} }));
vi.mock('../generators/z3-from-ir.js', () => ({ generateZ3FromIR: () => {} }));
vi.mock('../generators/typescript-state-machine.js', () => ({ generateTypeScriptStateMachine: () => {} }));
vi.mock('../generators/cyclonedx.js', () => ({ generateCycloneDX: () => {} }));
vi.mock('../generators/spdx.js', () => ({ generateSPDX: () => {} }));
vi.mock('../generators/n8n.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../generators/n8n.js')>();
  return {
    ...actual,
    generateN8n: () => {
      throw new actual.N8nTranslateError('n8n backend: cannot translate invariant Odd on Odd');
    },
  };
});

import { compileSpec } from '../compile.js';

const SPEC = [
  'speck Odd {',
  '    state { n: Nat }',
  '    init { n := 0 }',
  '    action Go { n := n + 1 }',
  '}',
  '',
].join('\n');

function specFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'speckl-n8n-skip-src-'));
  const file = path.join(dir, 'Odd.speckdl');
  writeFileSync(file, SPEC);
  return file;
}

describe('n8n skip with no file from this run', () => {
  afterEach(() => {
    gate.write = false;
  });

  it('exits through the empty-output branch when the folder already has a file', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'speckl-n8n-skip-'));
    writeFileSync(path.join(out, 'already-there.txt'), 'leftover\n');
    expect(() => compileSpec(specFile(), { outputDir: out, target: 'all-ir', bomFormat: 'both', verifyDepth: 4 }))
      .toThrow(/Skipped backend: n8n, and no file was written/);
  });

  it('does not take the empty-output branch when this run writes a file', () => {
    gate.write = true;
    const out = mkdtempSync(path.join(tmpdir(), 'speckl-n8n-skip-'));
    writeFileSync(path.join(out, 'already-there.txt'), 'leftover\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      compileSpec(specFile(), { outputDir: out, target: 'all-ir', bomFormat: 'both', verifyDepth: 4 });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some(line => line.startsWith('Skipped backend: n8n'))).toBe(true);
    expect(lines.some(line => line.includes('Compilation complete'))).toBe(true);
  });
});
