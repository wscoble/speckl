// compileSpec and lower run the import resolver. A bad path, a cycle, a
// duplicate, or a root that does not contain the file is an error. A missing
// member-type list is an error after lowering.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSpec } from '../compile.js';
import { parseSpeckFile } from '../parser.js';
import { lower } from '../ir/lower.js';
import { OpenAPITarget } from '../generators/openapi.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';

const speck = (name: string, extra = '') =>
  `speck ${name} {\n    state { n: Nat }\n    init { n := 0 }\n${extra}}\n`;

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-wire-'));
}

function write(dir: string, name: string, src: string): string {
  const path = join(dir, name);
  writeFileSync(path, src);
  return path;
}

function compile(file: string, rootDir?: string): string {
  const out = join(file + '-out');
  compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 2, rootDir });
  return out;
}

describe('compileSpec import wiring', () => {
  it('compiles a relative import in the same directory', () => {
    const dir = tree();
    write(dir, 'lib.speckdl', speck('Lib'));
    const file = write(dir, 'root.speckdl', `import "./lib.speckdl" as L\n${speck('Root')}`);
    const out = compile(file);
    expect(readFileSync(join(out, 'Lib.ts'), 'utf8')).toContain('Lib');
    expect(readFileSync(join(out, 'Root.ts'), 'utf8')).toContain('Root');
  });

  it('rejects a missing file, a cycle, a duplicate alias, and an absolute path', () => {
    const dir = tree();
    const missing = write(dir, 'missing.speckdl', `import "./no-such.speckdl" as L\n${speck('Root')}`);
    expect(() => compile(missing)).toThrow(`Parse error: cannot read import "./no-such.speckdl" (resolved ${join(dir, 'no-such.speckdl')}) at ${missing}:1`);

    write(dir, 'a.speckdl', `import "./b.speckdl" as B\n${speck('A')}`);
    const b = write(dir, 'b.speckdl', `import "./a.speckdl" as A\n${speck('B')}`);
    expect(() => compile(b)).toThrow(/import cycle/);

    write(dir, 'one.speckdl', speck('One'));
    write(dir, 'two.speckdl', speck('Two'));
    const dup = write(dir, 'dup.speckdl', `import "./one.speckdl" as L\nimport "./two.speckdl" as L\n${speck('Dup')}`);
    expect(() => compile(dup)).toThrow(/import alias L is used twice/);

    const abs = write(dir, 'abs.speckdl', `import "/tmp/outside.speckdl" as L\n${speck('Abs')}`);
    expect(() => compile(abs, dir)).toThrow(/must be a relative path/);
  });

  it('rejects a root that does not contain the import, and accepts the parent', () => {
    const parent = tree();
    const inside = join(parent, 'in');
    const sibling = join(parent, 'other');
    mkdirSync(inside);
    mkdirSync(sibling);
    write(parent, 'out.speckdl', speck('Out'));
    const file = write(inside, 'root.speckdl', `import "../out.speckdl" as O\n${speck('Root')}`);
    expect(() => compile(file)).toThrow(/outside the import root/);
    expect(() => compile(file, sibling)).toThrow(/outside the import root/);
    const out = compile(file, parent);
    expect(readFileSync(join(out, 'Out.ts'), 'utf8')).toContain('Out');
  });

  it('lower records member types, and a missing list fails closed', () => {
    const dir = tree();
    write(dir, 'lib.speckdl', speck('Lib'));
    const file = write(dir, 'root.speckdl', `import "./lib.speckdl" as L\n${speck('Root')}`);
    const ir = lower(parseSpeckFile(file), { filePath: file, resolveImports: true });
    expect(ir.specks.map(s => s.name).sort()).toEqual(['Lib', 'Root']);
    for (const speckIr of ir.specks) expect(speckIr.sourceMemberTypes?.length).toBeGreaterThan(0);
    const bare = { ...ir, specks: ir.specks.map(s => ({ ...s, sourceMemberTypes: undefined })) };
    expect(() => new OpenAPITarget().generate(bare, { outputDir: dir })).toThrow(/sourceMemberTypes is missing/);
  });

  it('compiles a spec with no import to the same bytes as a direct generate', () => {
    const dir = tree();
    const file = write(dir, 'plain.speckdl', speck('Plain'));
    const out = compile(file);
    const direct = join(dir, 'direct');
    mkdirSync(direct);
    generateTypeScriptStateMachine(parseSpeckFile(file), direct);
    expect(readFileSync(join(out, 'Plain.ts'), 'utf8')).toBe(readFileSync(join(direct, 'Plain.ts'), 'utf8'));
  });

  it('compiles imported specks in source order and reads a backslash path', () => {
    const dir = tree();
    mkdirSync(join(dir, 'sub'));
    write(join(dir, 'sub'), 'c.speckdl', speck('C'));
    write(dir, 'a.speckdl', `import ".\\\\sub\\\\c.speckdl" as C\n${speck('A')}`);
    write(dir, 'b.speckdl', speck('B'));
    const file = write(dir, 'root.speckdl', `import "./a.speckdl" as A\nimport "./b.speckdl" as B\n${speck('Root')}`);
    const ir = lower(parseSpeckFile(file), { filePath: file, resolveImports: true });
    expect(ir.specks.map(s => s.name)).toEqual(['Root', 'A', 'C', 'B']);
    const out = compile(file);
    for (const name of ['Root', 'A', 'C', 'B']) {
      expect(readFileSync(join(out, `${name}.ts`), 'utf8')).toContain(name);
    }
  });

  it('example specs contain no import, so the output pin is the no-import pin', () => {
    const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');
    const files = readdirSync(examples).filter(name => name.endsWith('.speckdl'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const imported = readFileSync(join(examples, name), 'utf8').split('\n').some(line => /^\s*import\s+"/.test(line));
      expect(imported, name).toBe(false);
    }
  });
});
