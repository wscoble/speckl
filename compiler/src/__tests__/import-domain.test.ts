// Import resolution.
// On main, a resolved import warned "import resolution not yet implemented
// in lower pass". These tests fail on that compiler and pass once imports merge.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';
import { generateGo } from '../generators/go.js';
import { lower } from '../ir/lower.js';
import { canonical } from '../ir/resolve-imports.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';
import { compileSpec } from '../compile.js';
import { exitProcess, isCliEntry, main, reportFatal } from '../index.js';
import type { IR } from '../ir/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures');
const EXAMPLES = path.resolve(__dirname, '..', '..', '..', 'examples');
const OLD_IMPORT_WARNING = 'import resolution not yet implemented in lower pass';

function load(file: string, resolveImports = true): IR {
  return lower(parseSpeckFile(file), { filePath: file, resolveImports });
}

function errors(ir: IR): string[] {
  return ir.diagnostics.filter(d => d.level === 'error').map(d => d.message);
}

function normalizeProv(text: string): string {
  const graph = JSON.parse(text);
  for (const node of graph['@graph']) {
    const activity = node['prov:wasGeneratedBy'];
    if (activity && typeof activity === 'object' && 'prov:startTime' in activity) {
      activity['prov:startTime'] = 'TIMESTAMP';
    }
  }
  return JSON.stringify(graph, null, 2) + '\n';
}

describe('import fixtures', () => {
  it('ok: reads, lowers, and merges the imported speck under its alias', () => {
    const file = join(FIX, 'import', 'ok', 'root.speckdl');
    const ir = load(file);
    expect(errors(ir)).toEqual([]);
    expect(ir.diagnostics.map(d => d.message)).not.toContain(OLD_IMPORT_WARNING);
    expect(ir.specks.map(s => s.name)).toEqual(['Invoice', 'Ledger']);
    expect(ir.imports).toEqual([
      expect.objectContaining({
        path: 'lib.speckdl',
        alias: 'ledger',
        version: '1.2.0',
        resolved: expect.objectContaining({ name: 'Ledger' }),
      }),
    ]);
    expect(ir.specks[0].imports.map(i => i.alias)).toEqual(['ledger']);
    expect(ir.specks[0].imports[0].resolved.facets.behavior.actions.map(a => a.name)).toEqual(['Post']);
    expect(ir.domains).toEqual([]);
  });

  it('missing: the error names the import path and the resolved file', () => {
    const file = join(FIX, 'import', 'missing', 'root.speckdl');
    const message = errors(load(file)).join('\n');
    expect(message).toMatch(/import: cannot read "no-such\.speckdl"/);
    expect(message).toContain(file);
    expect(message).toContain('no-such.speckdl');
  });

  it('cycle: the error names every file in the cycle', () => {
    const a = join(FIX, 'import', 'cycle', 'a.speckdl');
    const b = join(FIX, 'import', 'cycle', 'b.speckdl');
    const message = errors(load(a)).join('\n');
    expect(message).toMatch(/import: cycle involving /);
    expect(message).toContain(canonical(a));
    expect(message).toContain(canonical(b));
  });
});

describe('import resolution edges', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'speckl-import-'));

  it('checks a sha256 pin and accepts the bare hex form', () => {
    const root = dir();
    const body = 'speck Lib {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    writeFileSync(join(root, 'lib.speckdl'), body);
    const hex = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(root, 'pinned.speckdl'), `import "lib.speckdl" hash "sha256:${hex}"\nspeck Root {\n    state { y: Nat }\n    init { y := 0 }\n}\n`);
    expect(errors(load(join(root, 'pinned.speckdl')))).toEqual([]);
    writeFileSync(join(root, 'bare.speckdl'), `import "lib.speckdl" hash "${hex}"\nspeck Root {\n    state { y: Nat }\n    init { y := 0 }\n}\n`);
    expect(errors(load(join(root, 'bare.speckdl')))).toEqual([]);
    writeFileSync(join(root, 'bad.speckdl'), `import "lib.speckdl" hash "sha256:${'ab'.repeat(32)}"\nspeck Root {\n    state { y: Nat }\n    init { y := 0 }\n}\n`);
    expect(errors(load(join(root, 'bad.speckdl'))).join('\n')).toMatch(/import: hash mismatch for "lib\.speckdl"/);
  });

  it('names both files when the same speck is declared twice', () => {
    const root = dir();
    const speck = 'speck Shared {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    writeFileSync(join(root, 'a.speckdl'), speck);
    writeFileSync(join(root, 'b.speckdl'), `import "a.speckdl"\n${speck}`);
    const message = errors(load(join(root, 'b.speckdl'))).join('\n');
    expect(message).toMatch(/import: speck Shared is declared in both /);
    expect(message).toContain('a.speckdl');
    expect(message).toContain('b.speckdl');
  });

  it('merges a diamond once and aliases each speck in a multi-speck file', () => {
    const root = dir();
    writeFileSync(join(root, 'd.speckdl'), 'speck D {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'b.speckdl'), 'import "d.speckdl"\nspeck B {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'c.speckdl'), 'import "d.speckdl"\nspeck C {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'pair.speckdl'), 'speck P {\n    state { x: Nat }\n    init { x := 0 }\n}\nspeck Q {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'a.speckdl'), 'import "b.speckdl"\nimport "c.speckdl"\nimport "pair.speckdl" as pair\nspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    const ir = load(join(root, 'a.speckdl'));
    expect(errors(ir)).toEqual([]);
    expect(ir.specks.map(s => s.name)).toEqual(['A', 'B', 'D', 'C', 'P', 'Q']);
    expect(ir.imports.map(i => i.alias)).toEqual(['B', 'C', 'pair.P', 'pair.Q']);
  });

  it('reports a self-import, a directory, a parse failure, and a transitive miss', () => {
    const root = dir();
    writeFileSync(join(root, 'self.speckdl'), 'import "self.speckdl"\nspeck Self {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    expect(errors(load(join(root, 'self.speckdl'))).join('\n')).toMatch(/import: cycle involving /);
    mkdirSync(join(root, 'subdir'));
    writeFileSync(join(root, 'dir.speckdl'), 'import "subdir"\nspeck Dir {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    expect(errors(load(join(root, 'dir.speckdl'))).join('\n')).toMatch(/not a file/);
    writeFileSync(join(root, 'bad.speckdl'), 'import nope\n');
    writeFileSync(join(root, 'uses-bad.speckdl'), 'import "bad.speckdl"\nspeck Ok {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    expect(errors(load(join(root, 'uses-bad.speckdl'))).join('\n')).toMatch(/import: failed to parse "bad\.speckdl"/);
    writeFileSync(join(root, 'mid.speckdl'), 'import "missing-leaf.speckdl"\nspeck Mid {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'top.speckdl'), 'import "mid.speckdl"\nspeck Top {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    const transitive = errors(load(join(root, 'top.speckdl'))).join('\n');
    expect(transitive).toMatch(/import: cannot read "missing-leaf\.speckdl"/);
    expect(transitive).toContain('mid.speckdl');
  });

  it('merges an import declared inside a speck and one that sits between specks', () => {
    const root = dir();
    writeFileSync(join(root, 'lib.speckdl'), 'speck Lib {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    const inside = join(root, 'inside.speckdl');
    writeFileSync(inside, 'speck Host {\n    import "lib.speckdl" as lib\n    state { y: Nat }\n    init { y := 0 }\n}\n');
    const ir = load(inside);
    expect(errors(ir)).toEqual([]);
    expect(ir.specks.map(s => s.name)).toEqual(['Host', 'Lib']);
    expect(ir.imports).toEqual([]);
    expect(ir.specks[0].imports.map(i => i.alias)).toEqual(['lib']);

    const between = join(root, 'between.speckdl');
    writeFileSync(between, 'speck First {\n    state { y: Nat }\n    init { y := 0 }\n}\nimport "lib.speckdl"\nspeck Second {\n    state { z: Nat }\n    init { z := 0 }\n}\n');
    const both = load(between);
    expect(errors(both)).toEqual([]);
    expect(both.specks.map(s => s.name)).toEqual(['First', 'Second', 'Lib']);
    expect(both.imports.map(i => i.alias)).toEqual(['Lib']);
  });

  it('resolveImports: false does not read the file and does not warn', () => {
    const file = join(FIX, 'import', 'missing', 'root.speckdl');
    const ir = load(file, false);
    expect(ir.diagnostics.map(d => d.message)).not.toContain(OLD_IMPORT_WARNING);
    expect(errors(ir).some(m => m.startsWith('import:'))).toBe(false);
    expect(ir.specks.map(s => s.name)).toEqual(['Root']);
    expect(ir.imports).toEqual([]);
  });

  it('dedupes an imported diagnostic when the same file is imported twice', () => {
    const root = dir();
    writeFileSync(join(root, 'lib.speckdl'), 'import "missing-leaf.speckdl"\nspeck Lib {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'twice.speckdl'), 'import "lib.speckdl"\nimport "lib.speckdl" as again\nspeck Twice {\n    state { y: Nat }\n    init { y := 0 }\n}\n');
    const msgs = errors(load(join(root, 'twice.speckdl')));
    expect(msgs.filter(m => m.includes('cannot read "missing-leaf.speckdl"'))).toHaveLength(1);
  });

  it('canonical() returns a resolved path for a file that is not there', () => {
    const missing = join(tmpdir(), 'speckl-missing', 'nope.speckdl');
    expect(canonical(missing)).toBe(path.resolve(missing));
  });

  it('round-trips a file-level import and an import inside a speck', () => {
    const src = [
      'import "lib.speckdl" as lib version "1" hash "sha256:abc" // pin',
      'speck Invoice {',
      '    import "extra.speckdl"',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'round.speckdl');
    expect(ast.imports[0]).toMatchObject({ path: 'lib.speckdl', alias: 'lib', version: '1', hash: 'sha256:abc' });
    expect(ast.domains).toEqual([]);
    expect(ast.specks[0].members.some(m => m.type === 'import' && m.path === 'extra.speckdl')).toBe(true);
    const once = printAST(ast);
    expect(printAST(parseSpeckContent(once))).toBe(once);
    expect(() => parseSpeckContent('import nope\n')).toThrow(/Failed to parse import statement/);
  });
});

describe('compile and CLI', () => {
  it('compile fails closed on a missing import and emits a merged speck when it resolves', () => {
    const missing = join(FIX, 'import', 'missing', 'root.speckdl');
    const out = mkdtempSync(join(tmpdir(), 'speckl-compile-'));
    expect(() => compileSpec(missing, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 1 }))
      .toThrow(/no-such\.speckdl/);
    expect(existsSync(join(out, 'Root.ts'))).toBe(false);

    const okOut = mkdtempSync(join(tmpdir(), 'speckl-compile-'));
    compileSpec(join(FIX, 'import', 'ok', 'root.speckdl'), { outputDir: okOut, target: 'typescript', bomFormat: 'cdx', verifyDepth: 1 });
    expect(existsSync(join(okOut, 'Invoice.ts'))).toBe(true);
    expect(existsSync(join(okOut, 'Ledger.ts'))).toBe(true);
  });

  it('example specks and provenance stay the same whether or not import resolution is on', () => {
    for (const name of readdirSync(EXAMPLES).filter(f => f.endsWith('.speckdl')).sort()) {
      const file = join(EXAMPLES, name);
      const off = load(file, false);
      const on = load(file, true);
      expect(on.specks).toEqual(off.specks);
      expect(on.domains).toEqual([]);
      expect(on.imports).toEqual([]);
      const a = mkdtempSync(join(tmpdir(), 'speckl-ex-'));
      const b = mkdtempSync(join(tmpdir(), 'speckl-ex-'));
      generateProvenanceFromIR(off, a);
      generateProvenanceFromIR(on, b);
      for (const prov of readdirSync(a).filter(f => f.endsWith('.prov.jsonld'))) {
        expect(normalizeProv(readFileSync(join(b, prov), 'utf8'))).toBe(normalizeProv(readFileSync(join(a, prov), 'utf8')));
      }
    }
  });
});

describe('compile entry', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('isCliEntry accepts node, a bin symlink, and vite-node', () => {
    const self = fileURLToPath(new URL('../index.ts', import.meta.url));
    expect(isCliEntry(undefined, self)).toBe(false);
    expect(isCliEntry('', self)).toBe(false);
    expect(isCliEntry(self, self)).toBe(true);
    const linkDir = mkdtempSync(join(tmpdir(), 'speckl-cli-link-'));
    const link = join(linkDir, 'speckl');
    symlinkSync(self, link);
    expect(isCliEntry(link, self)).toBe(true);
    expect(isCliEntry(join(linkDir, 'missing', 'vite-node.mjs'), self)).toBe(true);
    expect(isCliEntry(join(linkDir, 'missing', 'vite-node.js'), self)).toBe(true);
    expect(isCliEntry(join(linkDir, 'missing', 'vite-node.cjs'), self)).toBe(true);
    expect(isCliEntry(join(linkDir, 'missing', 'vitest.mjs'), self)).toBe(false);
    expect(isCliEntry()).toBe(false);
  });

  it('exitProcess and reportFatal exit', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => exitProcess(4)).toThrow('exit:4');
    expect(() => reportFatal(new Error('boom'))).toThrow('exit:1');
    expect(err.mock.calls.flat().map(c => String(c)).join('\n')).toMatch(/Compilation failed:[\s\S]*boom/);
    exit.mockRestore();
  });

  it('b8 and b9: a brace in a comment or a string does not drop the next false invariant', () => {
    const bad = (nl: string) => [
      'speck B {',
      '    state { y: Nat }',
      '    init { y := 0 }',
      '    invariant Bad {',
      '        false',
      '    }',
      '}',
      '',
    ].join(nl);
    const sources = (nl: string) => [
      [
        'speck A {',
        '    state { x: Nat } // {',
        '    init { x := 0 }',
        '}',
        bad(nl),
      ].join(nl),
      [
        'speck A {',
        '    state { s: String }',
        '    init { s := "{" }',
        '}',
        bad(nl),
      ].join(nl),
      [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 } // " } "',
        '}',
        bad(nl),
      ].join(nl),
      [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '/* " } " */',
        bad(nl),
      ].join(nl),
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const src of sources(nl)) {
        const ast = parseSpeckContent(src, 'b.speckdl');
        expect(ast.specks.map(s => s.name), src).toEqual(['A', 'B']);
        const inv = ast.specks[1].members.find(m => m.type === 'invariant') as { name: string; expr: string };
        expect(inv.name, src).toBe('Bad');
        expect(inv.expr, src).toBe('false');
      }
    }
  });

  it('unclosed comments and strings are parse errors, on LF and CRLF', () => {
    const join = (lines: string[], nl: string) => lines.join(nl);
    for (const nl of ['\n', '\r\n'] as const) {
      const open = join([
        'speck A {',
        '    state { x: Nat }',
        '    /*',
        '}',
        'speck B {',
        '    invariant Bad {',
        '        false',
        '    }',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(open, 'n3.speckdl')).toThrow(/Parse error at n3\.speckdl:3: unterminated block comment/);
      expect(() => parseSpeckContent(open)).toThrow(/Parse error at line 3: unterminated block comment/);

      const nested = join([
        'speck A {',
        '    /*',
        '    /*',
        '    */',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(nested, 'nest.speckdl')).toThrow(/Parse error at nest\.speckdl:3: nested block comment/);

      const stray = join([
        'speck A {',
        '    state { x: Nat }',
        '    */',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(stray, 'n13.speckdl')).toThrow(/Parse error at n13\.speckdl:3: stray \*\//);

      const unclosed = join([
        'speck A {',
        '    state { s: String }',
        '    init { s := "unterminated }',
        '}',
        'speck B {',
        '    invariant Bad {',
        '        false',
        '    }',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(unclosed, 'n10.speckdl')).toThrow(/Parse error at n10\.speckdl:3: unterminated string/);

      const commentClosesInString = join([
        'speck A {',
        '    state { x: Nat }',
        '    /* "*/" { */',
        '}',
        'speck B {',
        '    invariant Bad {',
        '        false',
        '    }',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(commentClosesInString, 'n18.speckdl')).toThrow(/Parse error at n18\.speckdl:3: unterminated string/);

      const escaped = join([
        'speck A {',
        '    state { s: String }',
        '    init { s := "a\\" {" }',
        '}',
        'speck B {',
        '    invariant Bad {',
        '        false',
        '    }',
        '}',
        '',
      ], nl);
      const kept = parseSpeckContent(escaped, 'esc.speckdl');
      expect(kept.specks.map(s => s.name)).toEqual(['A', 'B']);
      const inv = kept.specks[1].members.find(m => m.type === 'invariant') as { expr: string };
      expect(inv.expr).toBe('false');

      // `\\` is one escaped backslash, so the following `"` closes and `{` stays inside.
      const doubled = join([
        'speck A {',
        '    state { s: String }',
        '    init { s := "a\\\\{" }',
        '}',
        'speck B {',
        '    invariant Bad {',
        '        false',
        '    }',
        '}',
        '',
      ], nl);
      const doubledAst = parseSpeckContent(doubled, 'esc2.speckdl');
      expect(doubledAst.specks.map(s => s.name)).toEqual(['A', 'B']);
      const doubledInv = doubledAst.specks[1].members.find(m => m.type === 'invariant') as { expr: string };
      expect(doubledInv.expr).toBe('false');

      // A backslash at the end of the line does not close the string.
      const trailing = join([
        'speck A {',
        '    state { s: String }',
        '    init { s := "unterminated\\',
        '}',
        '',
      ], nl);
      expect(() => parseSpeckContent(trailing, 'n10b.speckdl')).toThrow(/Parse error at n10b\.speckdl:3: unterminated string/);
    }
  });

  it('u05 and y03: unbalanced braces are a parse error, on LF and CRLF', () => {
    const canary = [
      'speck B {',
      '    invariant Canary {',
      '        false',
      '    }',
      '}',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      const u05 = [
        'speck A {',
        '    invariant Bad {',
        '        false',
        '}',
        ...canary,
        '',
      ].join(nl);
      expect(() => parseSpeckContent(u05, 'u05.speckdl')).toThrow(/Parse error at u05\.speckdl:5: unbalanced braces/);
      expect(() => parseSpeckContent(u05)).toThrow(/Parse error at line 5: unbalanced braces/);

      const u05eof = [
        'speck A {',
        '    invariant Bad {',
        '        false',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(u05eof, 'u05.speckdl')).toThrow(/Parse error at u05\.speckdl:1: unbalanced braces/);

      const y03 = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}{',
        ...canary,
        '',
      ].join(nl);
      expect(() => parseSpeckContent(y03, 'y03.speckdl')).toThrow(/Parse error at y03\.speckdl:4: text after a closing brace/);
      expect(() => parseSpeckContent(y03)).toThrow(/Parse error at line 4: text after a closing brace/);

      const extra = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(extra, 'extra.speckdl')).toThrow(/Parse error at extra\.speckdl:5: unbalanced braces/);
    }
  });

  it('r34: a domain block does not drop the specks inside it, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'domain D {',
        'speck A {',
        '    invariant Canary {',
        '        false',
        '    }',
        '}',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(src, 'r34.speckdl')).toThrow(/Parse error at r34\.speckdl:2: unbalanced braces/);
      expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 2: unbalanced braces/);
    }
  });

  it('s18: an unclosed quote errors on its own line, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck A {',
        '    state { s: String }',
        '    init { s := "open',
        '}',
        'speck B {',
        '    state { s: String }',
        '    init { s := "close" }',
        '    invariant Canary {',
        '        false',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(src, 's18.speckdl')).toThrow(/Parse error at s18\.speckdl:3: unterminated string/);
      expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 3: unterminated string/);
    }
  });

  it('a block comment before a speck header does not drop the speck, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      for (const header of ['/* x */ speck B {', '/**/ speck B {']) {
        const src = [
          'speck A {',
          '    state { x: Nat }',
          '    init { x := 0 }',
          '}',
          header,
          '    invariant Canary {',
          '        false',
          '    }',
          '}',
          '',
        ].join(nl);
        const ast = parseSpeckContent(src, 'lead.speckdl');
        expect(ast.specks.map(s => s.name), header).toEqual(['A', 'B']);
        const inv = ast.specks[1].members.find(m => m.type === 'invariant') as { name: string; expr: string };
        expect(inv.name, header).toBe('Canary');
        expect(inv.expr, header).toBe('false');
      }
    }
  });

  it('an empty hash, a mistyped clause, and a block comment on an import are parse errors', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const cases = [
        'import "lib.speckdl" hash ""',
        'import "lib.speckdl" hsh "abc"',
        'import "lib.speckdl" verison "1"',
        '/* c */ import "lib.speckdl"',
        'import "lib.speckdl" /* c */',
      ];
      for (const line of cases) {
        const src = line + nl;
        expect(() => parseSpeckContent(src, 'imp.speckdl'), line).toThrow(
          new RegExp(`Failed to parse import statement: ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
      }
      const ok = parseSpeckContent(`import "lib.speckdl" // note${nl}`, 'imp.speckdl');
      expect(ok.imports.map(i => i.path)).toEqual(['lib.speckdl']);
    }
  });

  it('e05 e03 e04 e06: a non-structural } does not balance an open file, on LF and CRLF', () => {
    const head = [
      'speck A {',
      '  state { x: Nat }',
      '  init { x := 0 }',
      '  invariant Pos { x >= 0',
      '  invariant Canary { false }',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      const e05 = [...head, '}', '// }', ''].join(nl);
      expect(() => parseSpeckContent(e05, 'e05.speckdl')).toThrow(/Parse error at e05\.speckdl:1: unbalanced braces/);
      expect(() => parseSpeckContent(e05)).toThrow(/Parse error at line 1: unbalanced braces/);

      const e03 = [...head, '  description: "}"', '}', ''].join(nl);
      expect(() => parseSpeckContent(e03, 'e03.speckdl')).toThrow(/Parse error at e03\.speckdl:1: unbalanced braces/);

      const e04 = [...head, '  /* } */', '}', ''].join(nl);
      expect(() => parseSpeckContent(e04, 'e04.speckdl')).toThrow(/Parse error at e04\.speckdl:1: unbalanced braces/);

      const e06 = [
        'speck A {',
        '  description: "}"',
        '  state { x: Nat }',
        '  init { x := 0 }',
        '  invariant Pos { x >= 0 }',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(e06, 'e06.speckdl')).toThrow(/Parse error at e06\.speckdl:1: unbalanced braces/);

      // A closed speck may still be followed by a comment that contains a brace.
      const closed = [
        'speck A {',
        '  state { x: Nat }',
        '  init { x := 0 }',
        '}',
        '// }',
        '',
      ].join(nl);
      expect(parseSpeckContent(closed, 'closed.speckdl').specks.map(s => s.name)).toEqual(['A']);
    }
  });

  it('speck headers match the trimmed masked line, on LF and CRLF', () => {
    const speckA = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '}',
    ];
    const canary = [
      '    invariant Canary {',
      '        false',
      '    }',
      '}',
    ];
    const headers = [
      ['  speck B {'],
      ['speck /* c */ B {'],
      ['speck B /* c */ {'],
      ['speck\tB {'],
      ['speck B', '{'],
      ['speck B', '', '{'],
      ['speck B', '// note', '{'],
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      for (const header of headers) {
        const src = [...speckA, ...header, ...canary, ''].join(nl);
        const ast = parseSpeckContent(src, 'hdr.speckdl');
        expect(ast.specks.map(s => s.name), header.join(' ')).toEqual(['A', 'B']);
        const inv = ast.specks[1].members.find(m => m.type === 'invariant') as { name: string; expr: string };
        expect(inv.name, header.join(' ')).toBe('Canary');
        expect(inv.expr, header.join(' ')).toBe('false');
      }
      const badHeaders: [string, string][] = [
        ['speck {', 'speck name must be on the same line as "speck"'],
        ['speck B extra', 'expected "speck <Name> {"'],
        ['speck B { trailing', 'one speck per line: put members on their own lines'],
      ];
      for (const [bad, detail] of badHeaders) {
        const src = [...speckA, bad, ...canary, ''].join(nl);
        expect(() => parseSpeckContent(src, 'bad.speckdl'), bad).toThrow(
          new RegExp(`Parse error at bad\\.speckdl:5: ${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
        expect(() => parseSpeckContent(src), bad).toThrow(
          new RegExp(`Parse error at line 5: ${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
      }
      const lone = [...speckA, 'speck', ...canary, ''].join(nl);
      expect(() => parseSpeckContent(lone, 'bad.speckdl')).toThrow(
        /Parse error at bad\.speckdl:5: speck name must be on the same line as "speck"/,
      );
      expect(() => parseSpeckContent(lone)).toThrow(
        /Parse error at line 5: speck name must be on the same line as "speck"/,
      );
      const missingBrace = [...speckA, 'speck B', ...canary, ''].join(nl);
      expect(() => parseSpeckContent(missingBrace, 'bad.speckdl')).toThrow(
        /Parse error at bad\.speckdl:\d+: expected "speck <Name> \{"/,
      );
    }
  });

  it('speck L { } is an empty speck, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      for (const header of ['speck L { }', 'speck L {}']) {
        const src = [
          header,
          'speck M {',
          '    invariant Canary {',
          '        false',
          '    }',
          '}',
          '',
        ].join(nl);
        const ast = parseSpeckContent(src, 'empty.speckdl');
        expect(ast.specks.map(s => s.name), header).toEqual(['L', 'M']);
        expect(ast.specks[0].members, header).toEqual([]);
        const inv = ast.specks[1].members.find(m => m.type === 'invariant') as { expr: string };
        expect(inv.expr, header).toBe('false');
      }
    }
  });

  it('an empty speck before an action lowers that action from its own lines, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      for (const header of ['speck L { }', 'speck L {}']) {
        const src = [
          header,
          'speck M {',
          '    state {',
          '        x: Nat',
          '    }',
          '    init {',
          '        x := 0',
          '    }',
          '    action Inc {',
          '        x := x + 1',
          '    }',
          '}',
          '',
        ].join(nl);
        const filePath = join(mkdtempSync(join(tmpdir(), 'speckl-empty-')), 'empty.speckdl');
        writeFileSync(filePath, src);
        const ast = parseSpeckContent(src, filePath);
        expect(ast.specks.map(s => s.name), header).toEqual(['L', 'M']);
        expect(ast.specks[0].members, header).toEqual([]);
        const ir = lower(ast, { filePath, resolveImports: false });
        expect(errors(ir), header).toEqual([]);
        const inc = ir.specks[1].facets.behavior.actions.find(a => a.name === 'Inc');
        expect(inc?.statements[0], header).toMatchObject({
          kind: 'assign',
          target: 'x',
          value: {
            kind: 'binop',
            op: '+',
            left: { kind: 'ident', name: 'x' },
            right: { kind: 'int_lit', value: 1 },
          },
        });
      }
    }
  });

  function expectLineError(src: string, file: string, line: number, detail: string) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(() => parseSpeckContent(src, file)).toThrow(
      new RegExp(`Parse error at ${esc(file)}:${line}: ${esc(detail)}`),
    );
    expect(() => parseSpeckContent(src)).toThrow(
      new RegExp(`Parse error at line ${line}: ${esc(detail)}`),
    );
  }

  it('f17 f10 and two specks on one line are a parse error, on LF and CRLF', () => {
    const members = 'one speck per line: put members on their own lines';
    const sameLine = 'speck name must be on the same line as "speck"';
    for (const nl of ['\n', '\r\n'] as const) {
      const canary = [
        'speck M {',
        '    invariant Canary {',
        '        false',
        '    }',
        '}',
        '',
      ].join(nl);

      expectLineError(`speck L { state { x: Nat } init { x := 0 } }${nl}` + canary, 'f17.speckdl', 1, members);

      const f10 = [
        'speck',
        'B {',
        '    state {',
        '        x: Nat',
        '    }',
        '    init {',
        '        x := 0',
        '    }',
        '    invariant Canary {',
        '        false',
        '    }',
        '}',
        '',
      ].join(nl);
      expectLineError(f10, 'f10.speckdl', 1, sameLine);

      const f10b = ['speck', 'B', '{', '    invariant Canary { false }', '}', ''].join(nl);
      expectLineError(f10b, 'f10.speckdl', 1, sameLine);

      expectLineError(
        `speck A { state { x: Nat } init { x := 0 } } speck B { invariant Canary { false } }${nl}`,
        'f13.speckdl',
        1,
        members,
      );

      const e29 = [
        'speck A { } speck B {',
        '    invariant Canary {',
        '        false',
        '    }',
        '}',
        '',
      ].join(nl);
      expectLineError(e29, 'e29.speckdl', 1, members);

      expectLineError(
        `speck A {} speck B { state { x: Nat } init { x := 0 } }${nl}`,
        'h06.speckdl',
        1,
        members,
      );

      expectLineError(
        `speck /* c */ L { state { x: Nat } init { x := 0 } }${nl}`,
        'c.speckdl',
        1,
        members,
      );
    }
  });

  it('packed specks and shifted action bodies are a parse error, on LF and CRLF', () => {
    const members = 'one speck per line: put members on their own lines';
    const sameLine = 'speck name must be on the same line as "speck"';
    const misplaced = 'speck must be a header at the start of the line';
    for (const nl of ['\n', '\r\n'] as const) {
      const speckB = [
        'speck B {',
        '    state {',
        '        y: Nat',
        '    }',
        '    init {',
        '        y := 0',
        '    }',
        '    action Inc {',
        '        y := y + 1',
        '    }',
        '    action Reset {',
        '        y := 0',
        '    }',
        '}',
      ];
      const speckC = [
        'speck C {',
        '    state {',
        '        z: Nat',
        '    }',
        '    init {',
        '        z := 0',
        '    }',
        '    action Wipe {',
        '        z := 42',
        '    }',
        '    action Hold {',
        '        z := z',
        '    }',
        '}',
      ];

      // m01: a one-line speck before a multi-line speck with actions.
      expectLineError(
        [`speck A { state { x: Nat } init { x := 0 } }`, ...speckB, ''].join(nl),
        'm01.speckdl',
        1,
        members,
      );
      // m02: the name on the next line used to shift the later action body.
      expectLineError(
        ['speck', 'A {', '    state { x: Nat }', '    init { x := 0 }', '}', ...speckB, ''].join(nl),
        'm02.speckdl',
        1,
        sameLine,
      );
      // m03: a one-line speck that itself contains an action.
      expectLineError(
        `speck A { state { x: Nat } init { x := 0 } action Go { x := x + 1 } }${nl}`,
        'm03.speckdl',
        1,
        members,
      );
      // m04: that one-line action speck placed before a multi-line speck.
      expectLineError(
        [`speck A { state { x: Nat } init { x := 0 } action Go { x := x + 1 } }`, ...speckB, ''].join(nl),
        'm04.speckdl',
        1,
        members,
      );
      // m05: enough trailing lines that a shifted read used to stay in range.
      expectLineError(
        [
          'speck A { state { x: Nat } init { x := 0 } }',
          ...speckB,
          ...speckC,
          ...Array.from({ length: 10 }, () => '// pad'),
          '',
        ].join(nl),
        'm05.speckdl',
        1,
        members,
      );

      expectLineError(
        `speck A { state { x: Nat } init { x := 0 } action Go { if x > 5 { x := 0 } else { x := 1 } } }${nl}`,
        'k02.speckdl',
        1,
        members,
      );
      expectLineError(
        `speck A { state { x: Nat } init { x := 0 } action Go { for i in {1, 2} { x := x + i } } }${nl}`,
        'k04.speckdl',
        1,
        members,
      );
      expectLineError(
        `speck A { /* } */ state { x: Nat } init { x := 0 } }${nl}`,
        'k07.speckdl',
        1,
        members,
      );
      expectLineError(
        `speck A {\tstate { x: Nat }\tinit { x := 0 }\t}${nl}`,
        'k37.speckdl',
        1,
        members,
      );

      const k15 = [
        'speck A {',
        '  state { x: Nat }',
        '} speck B { state { y: Nat }',
        '  init { y := 0 }',
        '}',
        '',
      ].join(nl);
      expectLineError(k15, 'k15.speckdl', 3, misplaced);

      const k16 = [
        'speck A {',
        '  init { x := 0 } } speck B {',
        '  init { y := 0 }',
        '}',
        '',
      ].join(nl);
      expectLineError(k16, 'k16.speckdl', 2, misplaced);

      const k40 = [
        'speck A {',
        '  state { x: Nat }',
        '  init { x := 0 }',
        '} speck B { init { y := 0 } } speck C {',
        '  init { z := 0 }',
        '}',
        '',
      ].join(nl);
      expectLineError(k40, 'k40.speckdl', 4, misplaced);

      expectLineError(
        `domain D { } speck A { state { x: Nat } init { x := 0 } }${nl}`,
        'k12.speckdl',
        1,
        misplaced,
      );

      const separate = [
        'domain D { }',
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(separate, 'domain.speckdl');
      expect(ast.specks.map(s => s.name)).toEqual(['A']);

      const commentedClose = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '} // speck B',
        '',
      ].join(nl);
      expect(parseSpeckContent(commentedClose, 'note.speckdl').specks.map(s => s.name)).toEqual(['A']);
    }
  });

  it('adv8 and adv8b: a speck word that is not a header is an error, on LF and CRLF', () => {
    const misplaced = 'speck must be a header at the start of the line';
    const stray = 'text outside a speck, domain, or import';
    const format = 'invisible format character';
    const zwsp = '\u200B';
    const body = [
      '    state { y: Nat }',
      '    init { y := 0 }',
      '    action Inc { y := y + 1 }',
      '    invariant Canary { false }',
      '}',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      const head = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 }',
      ];
      // D1: any character between } and the keyword, not only whitespace.
      for (const join of [
        '};speck B {',
        '},speck B {',
        '} ;speck B {',
        '}:speck B {',
        '})speck B {',
        '}"c"speck B {',
        '}speck B {',
        '}; speck B {',
        '} /* c */ speck B {',
        '}\tspeck B {',
        '}\u00A0speck B {',
        '}speck{',
        'foo speck',
        'foo speck{',
        '}\tspeck',
      ]) {
        const src = [...head, join, ...body, ''].join(nl);
        expectLineError(src, 'd1.speckdl', 5, misplaced);
      }
      expectLineError([...head, `}${zwsp}speck B {`, ...body, ''].join(nl), 'd1.speckdl', 5, format);

      // D2: the keyword partway through a member line.
      const d2 = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    description: "a" speck B {',
        '        state { y: Nat }',
        '        action Inc { y := y + 1 }',
        '        invariant Canary { false }',
        '    }',
        '}',
        '',
      ].join(nl);
      expectLineError(d2, 'd2.speckdl', 4, misplaced);

      // D3: a format character before a file-level header drops nothing quietly.
      expectLineError(`${zwsp}speck B {\n    invariant Canary { false }\n}\n`.replace(/\n/g, nl), 'd3.speckdl', 1, format);
      expectLineError(`speck A {\n}\n${zwsp}speck B {\n    invariant Canary { false }\n}\n`.replace(/\n/g, nl), 'd3b.speckdl', 3, format);
      for (const cf of ['\u00AD', '\u200C', '\u200D', '\u2060', '\u{E0001}']) {
        expectLineError(`${cf}speck B {\n}\n`.replace(/\n/g, nl), 'cf.speckdl', 1, format);
      }
      expectLineError(`speck A {\n}\n\uFEFFspeck B {\n}\n`.replace(/\n/g, nl), 'bommid.speckdl', 3, format);

      // D4: domain or a brace wrapper sharing the line with a header.
      expectLineError(`domain D { };speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n`.replace(/\n/g, nl), 'd4.speckdl', 1, misplaced);
      expectLineError(`{ speck A { state { x: Nat } init { x := 0 } action Go { x := 1 } invariant Canary { false } } }\n`.replace(/\n/g, nl), 'd4b.speckdl', 1, misplaced);

      // D5: members after an empty speck, and other file-level text, are not dropped.
      expectLineError(['speck E { }', '    state { x: Nat }', '    init { x := 0 }', ''].join(nl), 'd5.speckdl', 2, stray);
      expectLineError(['state { x: Nat }', 'speck A {', '    init { x := 0 }', '}', ''].join(nl), 'd5b.speckdl', 1, stray);
      expectLineError(['speck A { }', 'state { x: Nat }', 'speck B { }', ''].join(nl), 'd5c.speckdl', 2, stray);
      expectLineError(['speck E', '{ }', '    state { x: Nat }', ''].join(nl), 'brace.speckdl', 1, 'expected "speck <Name> {"');

      // A leading BOM is not a format error. A packed header after it still is.
      const bomOk = [
        '\uFEFFspeck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 }',
        '}',
        '',
      ].join(nl);
      expect(parseSpeckContent(bomOk, 'bom.speckdl').specks.map(s => s.name)).toEqual(['A']);
      expectLineError(`\uFEFFspeck A { state { x: Nat } init { x := 0 } }${nl}`, 'bompack.speckdl', 1, 'one speck per line: put members on their own lines');

      // Headers the file walker already accepts, including braces hidden from the mask.
      const kept = [
        ['speck My-Name {', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck A // {', '{', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck A { // }', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck A /* { */ {', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck A {', '    state { x: Nat }', '    init { x := 0 }', '}', '// speck B and speckled'],
        ['speck A {', '    description: "} speck B {"', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck A {', '    description: "a\u200Bb"', '    state { x: Nat }', '    init { x := 0 }', '}'],
        ['speck\tA\t{', '    state { x: Nat }', '    init { x := 0 }', '}'],
      ];
      for (const lines of kept) {
        const ast = parseSpeckContent([...lines, ''].join(nl), 'kept.speckdl');
        expect(ast.specks.map(s => s.name)[0]).toBe(lines[0].includes('My-Name') ? 'My-Name' : 'A');
      }
      expectLineError(`speck A {\tstate { x: Nat }\tinit { x := 0 }\t}${nl}`, 'tabpack.speckdl', 1, 'one speck per line: put members on their own lines');

      // The keyword is not an expression. A longer identifier is not the keyword.
      expectLineError(
        [
          'speck A {',
          '    state { x: Nat }',
          '    init { x := 0 }',
          '    action Go {',
          '        x := speck + 1',
          '    }',
          '}',
          '',
        ].join(nl),
        'expr.speckdl',
        5,
        misplaced,
      );
      const ident = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go {',
        '        x := specks + myspeck + speck_count',
        '        x := my-speck + 1',
        '    }',
        '}',
        '',
      ].join(nl);
      const ast = parseSpeckContent(ident, 'ident.speckdl');
      const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { expr?: string }[] };
      expect(action.statements.some(s => s.expr === 'specks + myspeck + speck_count')).toBe(true);
    }

    // A file whose lines are separated only by CR is one line, and it errors.
    const crOnly = 'speck A {\r    state { x: Nat }\r    init { x := 0 }\r}\r';
    expectLineError(crOnly, 'cr.speckdl', 1, 'one speck per line: put members on their own lines');
  });

  it('f02 and f08: speck used as a name is a reserved keyword, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const f02 = [
        'speck A {',
        '    state {',
        '        x: Nat',
        '    }',
        '    init {',
        '        x := 0',
        '    }',
        '    action Go {',
        '        speck := speck + 1',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(f02, 'f02.speckdl')).toThrow(
        /Parse error at f02\.speckdl:9: "speck" is a reserved keyword/,
      );
      expect(() => parseSpeckContent(f02)).toThrow(/Parse error at line 9: "speck" is a reserved keyword/);

      const f08 = [
        'speck A {',
        '    state {',
        '        x: Nat',
        '    }',
        '    init {',
        '        x := 0',
        '    }',
        '    invariant Pos {',
        '        speck >= 0',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(f08, 'f08.speckdl')).toThrow(
        /Parse error at f08\.speckdl:9: "speck" is a reserved keyword/,
      );

      expectLineError(
        [
          'speck A {',
          '    state {',
          '        x: Nat',
          '    }',
          '    init {',
          '        x := 0',
          '    }',
          '    action Go {',
          '        x := speck + 1',
          '    }',
          '}',
          '',
        ].join(nl),
        'name.speckdl',
        9,
        'speck must be a header at the start of the line',
      );
    }
  });

  it('adv9w and adv9t: a punctuated speck name, and text after a closing brace, are errors, on LF and CRLF', () => {
    const misplaced = 'speck must be a header at the start of the line';
    const after = 'text after a closing brace';
    const body = [
      '    state { y: Nat }',
      '    init { y := 0 }',
      '    action Inc { y := y + 1 }',
      '    invariant Canary { false }',
      '}',
    ];
    for (const nl of ['\n', '\r\n'] as const) {
      const head = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 }',
      ];
      // adv9w: speck followed by punctuation is not an expression.
      for (const join of [
        '}; speck -B {',
        '}; speck (B) {',
        '}; speck ~B {',
        '}; speck "B" {',
        '}; speck .B {',
        '}; speck :B {',
        '}; speck <B> {',
        '}; speck $B {',
        '}; speck *B {',
        '}; speck \u00E9B {',
        '};speck\u00E9B {',
      ]) {
        expectLineError([...head, join, ...body, ''].join(nl), 'adv9w.speckdl', 5, misplaced);
      }
      expectLineError(
        [...head, '    x := speck -B {', ...body, ''].join(nl),
        'w_inside.speckdl',
        5,
        misplaced,
      );
      expectLineError(`speck -B {\n}\n`.replace(/\n/g, nl), 'w_line.speckdl', 1, 'expected "speck <Name> {"');

      // adv9t, and the same close with a member after it.
      for (const join of [
        '}; thing B {',
        '} {',
        '} specks B {',
        '}; speck-B {',
        '} action Evil { x := 99 }',
        '} invariant Canary2 { false }',
        '} state { z: Nat }',
        '} x := 1',
      ]) {
        expectLineError([...head, join, ...body, ''].join(nl), 'adv9t.speckdl', 5, after);
      }

      const commented = [...head, '} // speck -B {', ''].join(nl);
      expect(parseSpeckContent(commented, 'note.speckdl').specks.map(s => s.name)).toEqual(['A']);
      const quoted = [
        'speck A {',
        '    description: "speck -B {"',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ].join(nl);
      expect(parseSpeckContent(quoted, 'str.speckdl').specks.map(s => s.name)).toEqual(['A']);
    }
  });

  it('an import inside a block that is not a speck is a parse error, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const domain = [
        'domain D {',
        '  import "missing.speckdl"',
        '}',
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(domain, 'e19.speckdl')).toThrow(
        /Parse error at e19\.speckdl:2: import is inside a block/,
      );
      expect(() => parseSpeckContent(domain)).toThrow(/Parse error at line 2: import is inside a block/);

      const bare = [
        '{',
        '  import "missing.speckdl"',
        '}',
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(bare, 'blk.speckdl')).toThrow(
        /Parse error at blk\.speckdl:1: text outside a speck, domain, or import/,
      );

      const inAction = [
        'speck A {',
        '    state {',
        '        x: Nat',
        '    }',
        '    init {',
        '        x := 0',
        '    }',
        '    action Go {',
        '        import "missing.speckdl"',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(inAction, 'f42.speckdl')).toThrow(
        /Parse error at f42\.speckdl:9: import is inside a block/,
      );

      const inIf = [
        'speck A {',
        '    state {',
        '        x: Nat',
        '    }',
        '    init {',
        '        x := 0',
        '    }',
        '    action Go {',
        '        if x > 0 {',
        '            import "missing.speckdl"',
        '        }',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(inIf, 'f43.speckdl')).toThrow(
        /Parse error at f43\.speckdl:10: import is inside a block/,
      );

      const inState = [
        'speck A {',
        '    state {',
        '        import "missing.speckdl"',
        '        x: Nat',
        '    }',
        '}',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(inState, 'f44.speckdl')).toThrow(
        /Parse error at f44\.speckdl:3: import is inside a block/,
      );
      expect(() => parseSpeckContent(inState)).toThrow(/Parse error at line 3: import is inside a block/);
    }
  });

  it('e11: a stray } that a later comment brace balances is a parse error, on LF and CRLF', () => {
    for (const nl of ['\n', '\r\n'] as const) {
      const src = [
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '}',
        '// {',
        '',
      ].join(nl);
      expect(() => parseSpeckContent(src, 'e11.speckdl')).toThrow(/Parse error at e11\.speckdl:5: unbalanced braces/);
      expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 5: unbalanced braces/);
    }
  });

  it('a for or if block with a trailing comment round-trips without hiding a brace', () => {
    const src = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    action Go {',
      '        for i from 1 to 2:',
      '            let replicated := 1  // leader counts itself',
      '            x := x + 1',
      '        if x > 0:',
      '            x := x + 1  // note',
      '    }',
      '}',
      '',
    ].join('\n');
    const printed = printAST(parseSpeckContent(src, 'raftish.speckdl'));
    expect(printed).toMatch(/\/\/ leader counts itself\n/);
    expect(printed).not.toMatch(/\/\/ leader counts itself[^\n]*\}/);
    expect(printed).toMatch(/\/\/ note\n/);
    expect(printed).not.toMatch(/\/\/ note[^\n]*\}/);
    expect(printAST(parseSpeckContent(printed))).toBe(printed);

    const quoted = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    action Go {',
      '        for i from 1 to 2:',
      '            let s := "a // b" /* c */ 1  // real',
      '            x := x + 1',
      '    }',
      '}',
      '',
    ].join('\n');
    const quotedPrint = printAST(parseSpeckContent(quoted));
    expect(quotedPrint).toMatch(/\/\/ real\n/);
    expect(printAST(parseSpeckContent(quotedPrint))).toBe(quotedPrint);
  });

  it('f54: a colon-form if inside a brace if does not run its body unconditionally', () => {
    const src = [
      'speck A {',
      '    state {',
      '        x: Nat',
      '    }',
      '    init {',
      '        x := 0',
      '    }',
      '    action Go {',
      '        if x > 5 {',
      '            if x > 9:',
      '                x := 0',
      '            x := x + 1',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'f54.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as {
      statements: { type: string; target?: string; raw?: string }[];
    };
    expect(action.statements.map(s => s.type)).toEqual(['ifblock']);
    expect(action.statements[0].raw).toContain('if x > 9');
    expect(action.statements[0].raw).not.toContain('\n');
    const out = mkdtempSync(join(tmpdir(), 'speckl-f54-'));
    generateGo(ast, out);
    const go = readFileSync(join(out, 'a', 'a.go'), 'utf8');
    const method = go.slice(go.indexOf('func (m *AMachine) Go()'));
    expect(method).toContain('if m.X > 5 {');
    expect(method).toContain('m.X = m.X + 1');
    expect(method).not.toContain('m.X = 0');
  });

  it('adv10: a one-line close attaches, text after a member close is an error, a dip is unbalanced', () => {
    const shape = (src: string) => parseSpeckContent(src, 'adv10.speckdl').specks.map(s => ({
      name: s.name,
      members: s.members.map(m => {
        if (m.type === 'action' || m.type === 'invariant') return `${m.type}:${m.name}`;
        return m.type;
      }),
    }));
    for (const nl of ['\n', '\r\n'] as const) {
      const join = (lines: string[]) => lines.join(nl);
      // An extra `}` on a one-line member closes that speck. The next speck is not absorbed.
      expect(shape(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 } }',
        'speck B {',
        '    invariant Canary { false }',
        '}',
        '',
      ]))).toEqual([
        { name: 'A', members: ['state', 'init', 'action:Go'] },
        { name: 'B', members: ['invariant:Canary'] },
      ]);
      expect(shape(join([
        'speck A {',
        '    state { x: Nat } }',
        'speck B {',
        '    invariant Canary { false }',
        '}',
        '',
      ]))).toEqual([
        { name: 'A', members: ['state'] },
        { name: 'B', members: ['invariant:Canary'] },
      ]);
      for (const close of ['    invariant P { x >= 0 } }', '    invariant P { x >= 0 }}']) {
        expect(shape(join([
          'speck A {',
          '    state { x: Nat }',
          '    init { x := 0 }',
          close,
          'speck B {',
          '    invariant Canary { false }',
          '}',
          '',
        ]))).toEqual([
          { name: 'A', members: ['state', 'init', 'invariant:P'] },
          { name: 'B', members: ['invariant:Canary'] },
        ]);
      }
      expect(shape(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 } }',
        '',
      ]))).toEqual([
        { name: 'A', members: ['state', 'init', 'action:Go'] },
      ]);

      // A comment brace does not pull the next speck inside this one.
      for (const close of ['} // {', '} /* { */', '} // speck B { follows', '} // speck B']) {
        expect(shape(join([
          'speck A {',
          '    state { x: Nat }',
          '    init { x := 0 }',
          close,
          'speck B {',
          '    invariant Canary { false }',
          '}',
          '',
        ])).map(s => s.name)).toEqual(['A', 'B']);
      }
      expect(shape(join([
        'speck A { // }',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        'speck B {',
        '    invariant Canary { false }',
        '}',
        '',
      ])).map(s => s.name)).toEqual(['A', 'B']);
      expect(shape(join([
        'speck A /* { */ {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ]))).toEqual([{ name: 'A', members: ['state', 'init'] }]);
      expect(shape(join([
        'speck A // {',
        '{',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ]))).toEqual([{ name: 'A', members: ['state', 'init'] }]);

      // Text after a member `}` while the speck stays open.
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 } action Evil { x := 99 }',
        '    invariant Canary { false }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'text after a closing brace');
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    invariant P { x >= 0 } invariant Evil { false }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'text after a closing brace');
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go { x := x + 1 } thing B { x := 1 }',
        '    invariant Canary { false }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'text after a closing brace');

      // `})`, `},`, and `} else` stay inside the member.
      const mapClose = parseSpeckContent(join([
        'speck A {',
        '    state {',
        '        sessions: Map(Id, {',
        '            used: Bool',
        '        })',
        '    }',
        '    init { sessions := Map.empty }',
        '}',
        '',
      ]), 'map.speckdl');
      const state = mapClose.specks[0].members.find(m => m.type === 'state') as { variables: { name: string }[] };
      expect(state.variables.map(v => v.name)).toEqual(['sessions']);
      const comma = parseSpeckContent(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    action Go {',
        '        let c := Rec {',
        '            a: 1,',
        '        },',
        '        x := x + 1',
        '    }',
        '}',
        '',
      ]), 'comma.speckdl');
      const commaAction = comma.specks[0].members.find(m => m.type === 'action') as { statements: { type: string }[] };
      expect(commaAction.statements.map(s => s.type)).toEqual(['let', 'assign']);
      const elseIf = parseSpeckContent(join([
        'speck A {',
        '    state { tokenType: String }',
        '    init { tokenType := "" }',
        '    action Go {',
        '        if tokenType == "access" {',
        '            tokenType := "x"',
        '        } else if tokenType == "refresh" {',
        '            tokenType := "y"',
        '        }',
        '    }',
        '}',
        '',
      ]), 'else.speckdl');
      const elseAction = elseIf.specks[0].members.find(m => m.type === 'action') as { statements: { raw?: string }[] };
      expect(elseAction.statements[0].raw).toContain('} else if tokenType == "refresh"');

      // Depth below 0.
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '}',
        'speck B {',
        '    invariant Canary { false }',
        '}',
        '',
      ]), 'adv10.speckdl', 5, 'unbalanced braces');
      expectLineError(join(['}', '{', '']), 'adv10.speckdl', 1, 'unbalanced braces');
      expectLineError(join([
        'speck A {',
        '    invariant P { x >= 0 }',
        '}',
        '}',
        'invariant Canary { false }',
        '',
      ]), 'adv10.speckdl', 4, 'unbalanced braces');

      // A member after the extra `}` is outside the speck.
      expectLineError(join([
        'speck A {',
        '    state { x: Nat } }',
        '    init { x := 0 }',
        '',
      ]), 'adv10.speckdl', 3, 'text outside a speck, domain, or import');

      // NBSP and ideographic space after `}` are whitespace.
      expect(shape('speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\u00A0\n'.replace(/\n/g, nl)))
        .toEqual([{ name: 'A', members: ['state', 'init'] }]);
      expect(shape('speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\u3000\n'.replace(/\n/g, nl)))
        .toEqual([{ name: 'A', members: ['state', 'init'] }]);

      // `domain` braces count. Members inside are not specks. A speck inside is unbalanced.
      expect(parseSpeckContent(join([
        'domain D {',
        '    state { x: Nat }',
        '    action Go { x := 1 }',
        '}',
        '',
      ]), 'domain.speckdl').specks).toEqual([]);
      expect(shape(join([
        'domain D {',
        '    name: String',
        '}',
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '}',
        '',
      ]))).toEqual([{ name: 'A', members: ['state', 'init'] }]);
      expectLineError(join([
        'domain D {',
        '    speck Inner {',
        '        state { x: Nat }',
        '        init { x := 0 }',
        '    }',
        '}',
        '',
      ]), 'adv10.speckdl', 2, 'unbalanced braces');

      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    thing B { x := 1 }',
        '    invariant Canary { false }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'unknown block');
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    Speck B {',
        '        invariant Canary { false }',
        '    }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'unknown block');
      expectLineError(join([
        'speck A {',
        '    state { x: Nat }',
        '    init { x := 0 }',
        '    \u0455peck B {',
        '        invariant Canary { false }',
        '    }',
        '}',
        '',
      ]), 'adv10.speckdl', 4, 'unknown block');
    }
  });

  it('a record parameter is not text after a brace, and a one-line action keeps its statement', () => {
    const pay = parseSpeckContent([
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    action Pay(p: {amount: Nat}) { x := p.amount }',
      '}',
      '',
    ].join('\n'), 'pay.speckdl');
    const payAction = pay.specks[0].members.find(m => m.type === 'action') as {
      name: string; statements: { type: string; expr?: string }[];
    };
    expect(payAction.name).toBe('Pay');
    expect(payAction.statements).toEqual([{ type: 'assign', target: 'x', expr: 'p.amount' }]);

    const one = parseSpeckContent([
      'speck A {',
      '    state { issued: Bool }',
      '    init { issued := false }',
      '    action Issue { issued := true }',
      '}',
      '',
    ].join('\n'), 'one.speckdl');
    const issue = one.specks[0].members.find(m => m.type === 'action') as {
      statements: { type: string; expr?: string }[];
    };
    expect(issue.statements).toEqual([{ type: 'assign', target: 'issued', expr: 'true' }]);

    expect(() => parseSpeckContent([
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    action Go {',
      '        x := x + 1 }',
      '}',
      '',
    ].join('\n'), 'close.speckdl')).toThrow(/Parse error at close\.speckdl:5: statement before the closing brace/);

    expect(() => parseSpeckContent('import nope\n', 'imp.speckdl')).toThrow(
      /Parse error at imp\.speckdl:1: Failed to parse import statement: import nope/,
    );
  });

  it('main compiles a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speckl-main-'));
    const file = join(root, 'Tiny.speckdl');
    writeFileSync(file, 'speck Tiny {\n    state { x: Nat }\n    init { x := 0 }\n    action Inc { x := x + 1 }\n}\n');
    const out = join(root, 'out');
    expect(await main(['node', 'speckl', file, '-o', out, '-t', 'typescript', '-b', 'cdx'])).toBe(0);
    expect(existsSync(join(out, 'Tiny.ts'))).toBe(true);
  });
});
