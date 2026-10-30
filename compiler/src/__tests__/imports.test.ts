import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { expandImports } from '../imports.js';
import { compileSpec } from '../compile.js';

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

  it('keeps a // inside the quoted path', () => {
    const ast = parseSpeckContent('import ".//lib.speckdl" as Lib\nspeck S {\n    state { n: Nat }\n}\n');
    expect(ast.imports?.[0].path).toBe('.//lib.speckdl');
  });

  it('parses an import separated by a tab, including a hash pin', () => {
    const ast = parseSpeckContent('import\t"./lib.speckdl" hash "sha256:00"\nspeck S {\n    state { n: Nat }\n}\n', 'tab.speckdl');
    expect(ast.imports?.[0]).toMatchObject({ path: './lib.speckdl', hash: 'sha256:00' });
  });

  it('rejects an import inside init, an invariant, or a one-line state', () => {
    const cases = [
      '    init {\n        import "lib.speckdl"\n        n := 0\n    }',
      '    invariant Pos {\n        import "lib.speckdl"\n    }',
      '    state { import "lib.speckdl" hash "sha256:00" }',
    ];
    for (const body of cases) {
      const src = `speck S {\n    state { n: Nat }\n${body}\n}\n`;
      expect(() => parseSpeckContent(src, 'in.speckdl'), body).toThrow(/import is inside a block/);
    }
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
    mkdirSync(join(folder, 'nested'));
    write(folder, 'nested/leaf.speckdl', 'speck Leaf {\n    state { k: Nat }\n}\n');
    write(folder, 'mid.speckdl', 'import "nested/leaf.speckdl" as Leaf\nspeck Mid {\n    state { m: Nat }\n}\n');
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

  it('rejects a short hash pin instead of calling it a mismatch', () => {
    const folder = dir();
    write(folder, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n}\n');
    const root = write(folder, 'root.speckdl', 'import\t"./lib.speckdl" hash "sha256:00"\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(root), root)).toThrow(/must be 64 hex characters/);
  });

  it('rejects a duplicate alias and a speck declared twice in one imported file', () => {
    const folder = dir();
    write(folder, 'a.speckdl', 'speck A {\n    state { n: Nat }\n}\n');
    write(folder, 'b.speckdl', 'speck B {\n    state { n: Nat }\n}\n');
    const dupAlias = write(folder, 'root.speckdl', 'import "a.speckdl" as Lib\nimport "b.speckdl" as Lib\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(dupAlias), dupAlias)).toThrow(/import alias Lib is used twice/);
    const twice = write(folder, 'twice.speckdl', 'speck Q {\n    state { n: Nat }\n}\nspeck Q {\n    state { m: Nat }\n}\n');
    const root = write(folder, 'use.speckdl', 'import "twice.speckdl" as T\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(root), root)).toThrow(/speck Q is declared twice/);
  });

  it('rejects a chain that is too deep with a clear message', () => {
    const folder = dir();
    const n = 80;
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? `import "f${i + 1}.speckdl" as N${i}\n` : '';
      write(folder, `f${i}.speckdl`, `${next}speck S${i} {\n    state { n: Nat }\n}\n`);
    }
    expect(() => expandImports(parseSpeckFile(join(folder, 'f0.speckdl')), join(folder, 'f0.speckdl'))).toThrow(
      /import chain is too deep \(limit 64\)/,
    );
  });

  it('loads a diamond ladder without re-walking finished files', () => {
    const folder = dir();
    const levels = 20;
    for (let level = levels; level >= 0; level--) {
      const body = level === levels
        ? ''
        : `import "L${level + 1}.speckdl" as L${level}\nimport "R${level + 1}.speckdl" as R${level}\n`;
      for (const side of ['L', 'R']) {
        write(folder, `${side}${level}.speckdl`, `${body}speck ${side}${level} {\n    state { n: Nat }\n}\n`);
      }
    }
    const root = write(folder, 'root.speckdl', 'import "L0.speckdl" as L\nimport "R0.speckdl" as R\nspeck Root {\n    state { n: Nat }\n}\n');
    const t0 = performance.now();
    const ast = expandImports(parseSpeckFile(root), root);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(ast.specks.map(s => s.name)).toContain('L20');
    expect(ast.specks.map(s => s.name)).toContain('R20');
  });

  it('rejects ../, absolute paths, and symlinks that leave the entry directory', () => {
    const parent = dir();
    const folder = join(parent, 'in');
    mkdirSync(folder);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n}\n');
    const outside = write(folder, 'root.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(outside), outside)).toThrow(/outside the import root/);
    expect(expandImports(parseSpeckFile(outside), outside, { rootDir: parent }).specks.map(s => s.name)).toEqual(['Root', 'Out']);

    const abs = write(folder, 'abs.speckdl', `import "${join(parent, 'out.speckdl')}" as O\nspeck Root {\n    state { n: Nat }\n}\n`);
    expect(() => expandImports(parseSpeckFile(abs), abs, { rootDir: parent })).toThrow(/must be a relative path/);

    const elsewhere = dir();
    write(elsewhere, 'secret.speckdl', 'speck Secret {\n    state { n: Nat }\n}\n');
    symlinkSync(join(elsewhere, 'secret.speckdl'), join(folder, 'link.speckdl'));
    const linked = write(folder, 'linkroot.speckdl', 'import "link.speckdl" as S\nspeck Root {\n    state { n: Nat }\n}\n');
    expect(() => expandImports(parseSpeckFile(linked), linked)).toThrow(/outside the import root/);
  });

  it('does not treat one alias in a two-speck import as a duplicate', () => {
    const folder = dir();
    write(folder, 'lib.speckdl', 'speck Lib {\n    state { n: Nat }\n}\n');
    write(folder, 'two.speckdl', 'import "./lib.speckdl" as L\nspeck T1 {\n    state { n: Nat }\n}\nspeck T2 {\n    state { n: Nat }\n}\n');
    const root = write(folder, 'a.speckdl', 'import "./two.speckdl"\nspeck A {\n    state { n: Nat }\n}\n');
    expect(expandImports(parseSpeckFile(root), root).specks.map(s => s.name).sort()).toEqual(['A', 'Lib', 'T1', 'T2']);
  });

  it('allows a state field named import', () => {
    expect(() => parseSpeckContent('speck A {\n    state {\n        import: Nat\n    }\n}\n', 'p.speckdl')).not.toThrow();
  });

  it('accepts a file whose name starts with two dots inside the root', () => {
    const folder = dir();
    write(folder, '..lib.speckdl', 'speck Dots {\n    state { n: Nat }\n}\n');
    const root = write(folder, 'a.speckdl', 'import "./..lib.speckdl"\nspeck A {\n    state { n: Nat }\n}\n');
    expect(expandImports(parseSpeckFile(root), root).specks.map(s => s.name)).toContain('Dots');
  });

  it('hashes the raw file bytes', () => {
    const folder = dir();
    const raw = Buffer.concat([Buffer.from('speck U8 {\n    author: "a'), Buffer.from([0xff]), Buffer.from('"\n}\n')]);
    writeFileSync(join(folder, 'u8.speckdl'), raw);
    const pin = createHash('sha256').update(raw).digest('hex');
    const root = write(folder, 'a.speckdl', `import "./u8.speckdl" hash "sha256:${pin}"\nspeck A {\n    state { n: Nat }\n}\n`);
    expect(expandImports(parseSpeckFile(root), root).specks.map(s => s.name)).toContain('U8');
  });

  it('lower uses the bytes expandImports already verified', () => {
    const folder = dir();
    const libSrc = 'speck Lib {\n    state { n: Nat }\n    init { n := 0 }\n    action Tick {\n        n := n + 1\n    }\n}\n';
    const lib = write(folder, 'lib.speckdl', libSrc);
    const pin = createHash('sha256').update(libSrc).digest('hex');
    const entry = write(folder, 'pin.speckdl', `import "./lib.speckdl" hash "sha256:${pin}"\nspeck A {\n    state { n: Nat }\n}\n`);
    const fs = createRequire(import.meta.url)('node:fs');
    const orig = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (p: unknown, ...rest: unknown[]) {
      if (String(p) === lib && ++reads === 1) writeFileSync(lib, libSrc.replace('n := n + 1', 'n := n + 999'));
      return orig.call(this, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const ast = expandImports(parseSpeckFile(entry), entry);
      const ir = lower(ast, { filePath: entry, resolveImports: true });
      expect(JSON.stringify(ir.specks.find(s => s.name === 'Lib'))).not.toContain('999');
    } finally {
      fs.readFileSync = orig;
      syncBuiltinESMExports();
    }
  });

  it('throws when the entry path is missing', () => {
    const src = 'import "./lib.speckdl"\nspeck A {\n    state { n: Nat }\n}\n';
    expect(() => expandImports(parseSpeckContent(src, '/nonexistent/x.speckdl'), '/nonexistent/x.speckdl')).toThrow(/cannot read/);
  });

  it('compileSpec accepts --root as rootDir', () => {
    const parent = dir();
    const folder = join(parent, 'in');
    mkdirSync(folder);
    write(parent, 'out.speckdl', 'speck Out {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const file = write(folder, 'root.speckdl', 'import "../out.speckdl" as O\nspeck Root {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const out = join(parent, 'out');
    expect(() => compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'both', verifyDepth: 2 })).toThrow(/outside the import root/);
    compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'both', verifyDepth: 2, rootDir: parent });
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
  });

  it('compiles when /proc/self/fd is missing', () => {
    const folder = dir();
    const file = write(folder, 'plain.speckdl', 'speck Plain {\n    state { n: Nat }\n    init { n := 0 }\n}\n');
    const fs = createRequire(import.meta.url)('node:fs');
    const orig = fs.realpathSync;
    fs.realpathSync = function (this: unknown, p: unknown, ...rest: unknown[]) {
      if (String(p).startsWith('/proc/self/fd/')) {
        const e = new Error(`ENOENT: realpath '${p}'`) as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return orig.call(this, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      compileSpec(file, { outputDir: join(folder, 'out'), target: 'typescript', bomFormat: 'cdx', verifyDepth: 2 });
    } finally {
      fs.realpathSync = orig;
      syncBuiltinESMExports();
    }
  });

  it('rejects a FIFO import instead of blocking', () => {
    const folder = dir();
    execFileSync('mkfifo', [join(folder, 'fifo.speckdl')]);
    const file = write(folder, 'f.speckdl', 'import "./fifo.speckdl"\nspeck F {\n}\n');
    expect(() => expandImports(parseSpeckFile(file), file)).toThrow(/cannot read import/);
  }, 8000);

  it('lower on a fresh parse does not reuse an earlier expand', () => {
    const folder = dir();
    const file = write(folder, 'st.speckdl', 'speck St {\n    state { n: Nat }\n    init { n := 0 }\n    action Go {\n        n := n + 1\n    }\n}\n');
    expandImports(parseSpeckFile(file), file);
    writeFileSync(file, 'speck St {\n    state { n: Nat }\n    init { n := 0 }\n    action Go {\n        n := n + 42\n    }\n}\n');
    expect(JSON.stringify(lower(parseSpeckFile(file), { filePath: file, resolveImports: false }))).toContain('42');
  });

  it('the entry AST and the lowered action come from the same read', () => {
    const folder = dir();
    const file = write(folder, 'tw.speckdl', 'speck Tw {\n    state { n: Nat }\n    init { n := 0 }\n    action Go {\n        n := n + 1\n    }\n}\n');
    const fs = createRequire(import.meta.url)('node:fs');
    const orig = fs.openSync;
    let swapped = false;
    fs.openSync = function (this: unknown, p: unknown, ...rest: unknown[]) {
      if (String(p) === file && !swapped) {
        swapped = true;
        writeFileSync(file, 'speck Tw {\n    state { n: Nat }\n    init { n := 0 }\n    action Go {\n        n := n + 5\n    }\n}\n');
      }
      return orig.call(this, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const ast = parseSpeckFile(file);
      const ex = expandImports(ast, file);
      const ir = lower(ex, { filePath: file, resolveImports: true });
      const astSays5 = JSON.stringify(ex).includes('n + 5') || JSON.stringify(ex).includes('"value":5');
      const irSays5 = JSON.stringify(ir).includes('"value":5');
      expect(irSays5).toBe(astSays5);
      expect(astSays5).toBe(true);
    } finally {
      fs.openSync = orig;
      syncBuiltinESMExports();
    }
  });
});
