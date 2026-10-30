import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { expandImports } from '../imports.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-imp-'));
}

function write(folder: string, name: string, src: string): string {
  const path = join(folder, name);
  writeFileSync(path, src);
  return path;
}

describe('import parsing', () => {
  it('parses a file-level import with alias, version, and hash', () => {
    const ast = parseSpeckContent([
      'import "lib.speckdl" as Lib version "1.2.0" hash "sha256:abc"',
      'speck S {',
      '    state { n: Nat }',
      '}',
      '',
    ].join('\n'), 'root.speckdl');
    expect(ast.imports).toEqual([{
      type: 'import', path: 'lib.speckdl', alias: 'Lib', version: '1.2.0', hash: 'sha256:abc',
    }]);
    expect(ast.specks.map(s => s.name)).toEqual(['S']);
  });

  it('parses an import that is a member of a speck', () => {
    const ast = parseSpeckContent([
      'speck S {',
      '    import "lib.speckdl" as Lib',
      '    state { n: Nat }',
      '}',
      '',
    ].join('\n'));
    const imp = ast.specks[0].members.find(m => m.type === 'import');
    expect(imp).toMatchObject({ type: 'import', path: 'lib.speckdl', alias: 'Lib' });
  });

  it('accepts a trailing line comment and rejects a broken clause', () => {
    const ok = parseSpeckContent('import "lib.speckdl" // note\nspeck S {\n    state { n: Nat }\n}\n');
    expect(ok.imports?.[0].path).toBe('lib.speckdl');
    expect(() => parseSpeckContent('import nope\nspeck S {\n}\n', 'bad.speckdl')).toThrow(
      /Parse error at bad\.speckdl:1: Failed to parse import statement: import nope/,
    );
    expect(() => parseSpeckContent('import "lib.speckdl" hash ""\nspeck S {\n}\n', 'bad.speckdl')).toThrow(
      /Failed to parse import statement/,
    );
    expect(() => parseSpeckContent('/* c */ import "lib.speckdl"\nspeck S {\n}\n', 'bad.speckdl')).toThrow(
      /Failed to parse import statement/,
    );
  });

  it('rejects an import inside an action or a state block', () => {
    expect(() => parseSpeckContent([
      'speck S {',
      '    state { n: Nat }',
      '    action Go {',
      '        import "lib.speckdl"',
      '        n := 1',
      '    }',
      '}',
      '',
    ].join('\n'), 'in.speckdl')).toThrow(/import is inside a block/);
    expect(() => parseSpeckContent([
      'speck S {',
      '    state {',
      '        import "lib.speckdl"',
      '        n: Nat',
      '    }',
      '}',
      '',
    ].join('\n'))).toThrow(/import is inside a block/);
  });

  it('round-trips a file-level import', () => {
    const src = 'import "lib.speckdl" as Lib version "1"\nspeck S {\n    state { n: Nat }\n}\n';
    const printed = printAST(parseSpeckContent(src));
    expect(printed.startsWith('import "lib.speckdl" as Lib version "1"\n')).toBe(true);
    expect(parseSpeckContent(printed).imports?.[0]).toMatchObject({ path: 'lib.speckdl', alias: 'Lib', version: '1' });
  });
});

describe('import resolution', () => {
  it('loads a relative import and records the lowered speck', () => {
    const folder = dir();
    write(folder, 'lib.speckdl', 'speck Lib {\n    state {\n        ready: Bool\n    }\n    init {\n        ready := false\n    }\n}\n');
    const root = write(folder, 'root.speckdl', 'import "lib.speckdl" as Lib\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const ir = lower(parseSpeckFile(root), { filePath: root, resolveImports: true });
    expect(ir.specks.map(s => s.name)).toEqual(['Root', 'Lib']);
    const lib = ir.specks[1];
    expect(lib.facets.behavior.stateVars.map(v => v.name)).toEqual(['ready']);
    expect(ir.specks[0].imports).toEqual([
      expect.objectContaining({ path: 'lib.speckdl', alias: 'Lib', resolved: lib }),
    ]);
  });

  it('resolves a nested import from the imported file', () => {
    const folder = dir();
    const nested = dir();
    write(nested, 'leaf.speckdl', 'speck Leaf {\n    state { k: Nat }\n}\n');
    write(folder, 'mid.speckdl', `import "${join(nested, 'leaf.speckdl')}" as Leaf\nspeck Mid {\n    state { m: Nat }\n}\n`);
    const root = write(folder, 'root.speckdl', 'import "mid.speckdl" as Mid\nspeck Root {\n    state { n: Nat }\n}\n');
    const ir = lower(parseSpeckFile(root), { filePath: root, resolveImports: true });
    expect(ir.specks.map(s => s.name)).toEqual(['Root', 'Mid', 'Leaf']);
  });

  it('names the missing path', () => {
    const folder = dir();
    const root = write(folder, 'root.speckdl', 'import "missing.speckdl" as M\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(root), root)).toThrow(
      /cannot read import "missing\.speckdl" \(resolved .*missing\.speckdl\)/,
    );
  });

  it('names every file in a cycle', () => {
    const folder = dir();
    write(folder, 'a.speckdl', 'import "b.speckdl" as B\nspeck A {\n    state { n: Nat }\n}\n');
    const b = write(folder, 'b.speckdl', 'import "a.speckdl" as A\nspeck B {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(b), b)).toThrow(/import cycle: .*b\.speckdl -> .*a\.speckdl -> .*b\.speckdl/);
  });

  it('rejects a hash that does not match the file bytes', () => {
    const folder = dir();
    const lib = write(folder, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n}\n');
    const hash = createHash('sha256').update(Buffer.from('nope')).digest('hex');
    const root = write(folder, 'root.speckdl', `import "lib.speckdl" hash "sha256:${hash}"\nspeck Root {\n    state { n: Nat }\n}\n`);
    expect(() => expandImports(parseSpeckFile(root), root)).toThrow(/hash mismatch for import "lib\.speckdl"/);
    const good = createHash('sha256').update(readFileSync(lib)).digest('hex');
    const ok = write(folder, 'ok.speckdl', `import "lib.speckdl" hash "${good}"\nspeck Ok {\n    state { n: Nat }\n}\n`);
    expect(expandImports(parseSpeckFile(ok), ok).specks.map(s => s.name)).toEqual(['Ok', 'Lib']);
  });

  it('rejects the same speck name in two files', () => {
    const folder = dir();
    write(folder, 'lib.speckdl', 'speck Shared {\n    state { n: Nat }\n}\n');
    const root = write(folder, 'root.speckdl', 'import "lib.speckdl" as L\nspeck Shared {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(root), root)).toThrow(/speck Shared is declared in/);
  });
});
