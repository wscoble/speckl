// One domain-check behavior per test. The bundled cases stay in domain.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileSpec } from '../compile.js';
import { doctorFile } from '../doctor.js';
import { lower } from '../ir/lower.js';
import { parseSpeckFile } from '../parser.js';

const speck = (name: string) => `speck ${name} {\n state { x: Nat }\n init { x := 0 }\n}\n`;

function write(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

function messages(file: string, dir: string): string {
  return lower(parseSpeckFile(file), { filePath: file, resolveImports: true, rootDir: dir })
    .diagnostics.map(d => d.message).join('\n');
}

describe('each domain check', () => {
  it('records one domain on the IR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-one-'));
    try {
      const file = write(dir, 'ok.speckdl', `domain D { members: A; language: "ab"; }\n${speck('A')}`);
      const ir = lower(parseSpeckFile(file), { filePath: file, resolveImports: true, rootDir: dir });
      expect(ir.domains).toEqual([{ name: 'D', members: ['A'], language: 'ab', sourcePath: file }]);
      expect(ir.diagnostics.filter(d => d.message.startsWith('domain:'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file with no domain has no domain diagnostic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-none-'));
    try {
      const file = write(dir, 'plain.speckdl', speck('A'));
      expect(messages(file, dir)).not.toMatch(/domain:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a member that is not a speck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-miss-'));
    try {
      const file = write(dir, 'missing.speckdl', `domain D { members: Missing; }\n${speck('A')}`);
      expect(messages(file, dir)).toMatch(/domain: D member Missing is not a speck/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a member listed twice in one domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-twice-'));
    try {
      const file = write(dir, 'twice.speckdl', `domain D { members: A, A; }\n${speck('A')}`);
      expect(messages(file, dir)).toMatch(/domain: D lists A more than once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a speck that belongs to two domains', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-owners-'));
    try {
      const file = write(dir, 'two.speckdl', `domain One { members: A; }\ndomain Two { members: A; }\n${speck('A')}`);
      expect(messages(file, dir)).toMatch(/domain: speck A is a member of One and Two/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the same domain name twice in one file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-again-'));
    try {
      const file = write(dir, 'again.speckdl', `domain D { members: A; }\ndomain D { members: B; }\n${speck('A')}${speck('B')}`);
      expect(messages(file, dir)).toMatch(/domain: D is declared more than once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a domain that arrived through import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-imp-ok-'));
    try {
      write(dir, 'a.speckdl', `${speck('A')}domain One { members: A; }\n`);
      const root = write(dir, 'root.speckdl', `import "a.speckdl"\n${speck('B')}domain Two { members: B; }\n`);
      const ir = lower(parseSpeckFile(root), { filePath: root, resolveImports: true, rootDir: dir });
      expect(ir.domains?.map(d => d.name).sort()).toEqual(['One', 'Two']);
      expect(ir.diagnostics.filter(d => d.message.startsWith('domain:'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a member that already belongs to an imported domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-imp-bad-'));
    try {
      write(dir, 'a.speckdl', `${speck('A')}domain One { members: A; }\n`);
      const root = write(dir, 'root.speckdl', `import "a.speckdl"\n${speck('B')}domain Two { members: A, B; }\n`);
      const ir = lower(parseSpeckFile(root), { filePath: root, resolveImports: true, rootDir: dir });
      expect(ir.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: speck A is a member of One and Two/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws the domain error, creates the output directory, and does not write the generated file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-fail-'));
    const out = join(dir, 'out');
    try {
      const file = write(dir, 'bad.speckdl', `domain D { members: Missing; }\n${speck('A')}`);
      expect(() => compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 1 }))
        .toThrow(/domain: D member Missing is not a speck/);
      expect(existsSync(out)).toBe(true);
      expect(() => readFileSync(join(out, 'A.ts'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag an observe tool that no harness maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-doctor-observe-'));
    try {
      const file = write(dir, 'obs.speckdl', [
        'speck Worker {',
        '    state { stage: Nat }',
        '    init { stage := 0 }',
        '    action Go { stage := 1 }',
        '    action Look { stage := stage }',
        '    agent {',
        '        tool go -> Go effect act',
        '        tool look -> Look effect observe',
        '        harness claude-code {',
        '            map Bash -> go',
        '        }',
        '    }',
        '}',
        'domain Ops { members: Worker; }',
        '',
      ].join('\n'));
      const result = doctorFile(file);
      expect(result.ok).toBe(true);
      expect(result.errors.filter(e => e.includes('look'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an act tool that every harness block maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-doctor-both-'));
    try {
      const file = write(dir, 'both.speckdl', [
        'speck Worker {',
        '    state { stage: Nat }',
        '    init { stage := 0 }',
        '    action Go { stage := 1 }',
        '    agent {',
        '        tool go -> Go effect act',
        '        harness claude-code {',
        '            map Bash -> go',
        '        }',
        '        harness codex {',
        '            map Shell -> go',
        '        }',
        '    }',
        '}',
        'domain Ops { members: Worker; }',
        '',
      ].join('\n'));
      expect(doctorFile(file).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a second harness block does not map the act tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-doctor-two-'));
    try {
      const file = write(dir, 'miss.speckdl', [
        'speck Worker {',
        '    state { stage: Nat }',
        '    init { stage := 0 }',
        '    action Go { stage := 1 }',
        '    agent {',
        '        tool go -> Go effect act',
        '        harness claude-code {',
        '            map Bash -> go',
        '        }',
        '        harness codex {',
        '            map Shell -> other',
        '        }',
        '    }',
        '}',
        'domain Ops { members: Worker; }',
        '',
      ].join('\n'));
      const result = doctorFile(file);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('doctor: domain Ops member Worker act tool go is not mapped in harness codex');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
