// Import resolution and `domain` blocks.
// On main, a resolved import warned "import resolution not yet implemented
// in lower pass" and there was no construct above one speck. These tests
// fail on that compiler and pass once imports merge and domains are checked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { canonical } from '../ir/resolve-imports.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';
import { compileSpec } from '../compile.js';
import { doctorFile, runDoctor } from '../doctor.js';
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
    expect(ir.domains.map(d => d.name)).toEqual(['Books']);
    expect(ir.domains[0].members).toEqual(['Invoice', 'Ledger']);
    expect(ir.domains[0].language).toBe('A ledger posts an invoice');
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
    writeFileSync(join(root, 'bad.speckdl'), 'domain {\n');
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
    writeFileSync(join(root, 'lib.speckdl'), 'domain Broken {\n    members: Missing;\n    language: "x";\n}\nspeck Lib {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    writeFileSync(join(root, 'twice.speckdl'), 'import "lib.speckdl"\nimport "lib.speckdl" as again\nspeck Twice {\n    state { y: Nat }\n    init { y := 0 }\n}\n');
    const msgs = errors(load(join(root, 'twice.speckdl')));
    expect(msgs.filter(m => m.includes('member Missing is not a speck'))).toHaveLength(1);
  });

  it('canonical() returns a resolved path for a file that is not there', () => {
    const missing = join(tmpdir(), 'speckl-missing', 'nope.speckdl');
    expect(canonical(missing)).toBe(path.resolve(missing));
  });
});

describe('domain', () => {
  it('lowers two domains and rejects a duplicate member, two owners, an unknown member, and a repeated name', () => {
    const file = join(FIX, 'domain', 'two-domain.speckdl');
    const ir = load(file);
    expect(errors(ir)).toEqual([]);
    expect(ir.domains.map(d => ({ name: d.name, members: d.members, language: d.language }))).toEqual([
      { name: 'Billing', members: ['Invoice', 'Ledger'], language: 'An invoice is issued before a ledger posts it' },
      { name: 'Fulfillment', members: ['Shipment'], language: 'A shipment leaves the warehouse' },
    ]);

    const scratch = mkdtempSync(join(tmpdir(), 'speckl-domain-'));
    const lowerSrc = (name: string, src: string) => {
      const file = join(scratch, name);
      writeFileSync(file, src);
      return errors(load(file)).join('\n');
    };
    expect(lowerSrc('dup.speckdl', 'domain D {\n    members: A, A;\n    language: "x";\n}\nspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n')).toMatch(/domain: D lists A more than once/);
    expect(lowerSrc('two.speckdl', 'domain One {\n    members: A;\n    language: "one";\n}\ndomain Two {\n    members: A;\n    language: "two";\n}\nspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n')).toMatch(/domain: speck A is a member of One and Two/);
    expect(lowerSrc('unknown.speckdl', 'domain D {\n    members: Missing;\n}\nspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n')).toMatch(/domain: D member Missing is not a speck/);
    expect(lowerSrc('again.speckdl', 'domain D {\n    members: A;\n}\ndomain D {\n    members: A;\n}\nspeck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n')).toMatch(/domain: D is declared more than once/);
  });

  it('rejects a member that already belongs to an imported domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'speckl-domain-'));
    writeFileSync(join(root, 'a.speckdl'), 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\ndomain One {\n    members: A;\n    language: "one";\n}\n');
    const file = join(root, 'root.speckdl');
    writeFileSync(file, 'import "a.speckdl"\nspeck B {\n    state { y: Nat }\n    init { y := 0 }\n}\ndomain Two {\n    members: A, B;\n    language: "two";\n}\n');
    const message = errors(load(file)).join('\n');
    expect(message).toMatch(/domain: speck A is a member of One and Two/);
  });

  it('parses and round-trips domain and import syntax', () => {
    const src = [
      'import "lib.speckdl" as lib version "1" hash "sha256:abc" // pin',
      'domain Billing {',
      '    // ubiquitous language',
      '    members:',
      '        Invoice,',
      '        Ledger;',
      '    language: "say \\"hi\\" and {braces}";',
      '}',
      'domain Other { members: Shipment; language: payments; }',
      'domain Quoted { members: Host; language: \'plain text\'; }',
      'speck Invoice {',
      '    import "extra.speckdl"',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '}',
      'speck Ledger { state { x: Nat } init { x := 0 } }',
      'speck Shipment { state { x: Nat } init { x := 0 } }',
      'speck Host { state { x: Nat } init { x := 0 } }',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'round.speckdl');
    expect(ast.imports[0]).toMatchObject({ path: 'lib.speckdl', alias: 'lib', version: '1', hash: 'sha256:abc' });
    expect(ast.domains.map(d => ({ name: d.name, members: d.members, language: d.language }))).toEqual([
      { name: 'Billing', members: ['Invoice', 'Ledger'], language: 'say "hi" and {braces}' },
      { name: 'Other', members: ['Shipment'], language: 'payments' },
      { name: 'Quoted', members: ['Host'], language: 'plain text' },
    ]);
    expect(ast.specks[0].members.some(m => m.type === 'import' && m.path === 'extra.speckdl')).toBe(true);
    const once = printAST(ast);
    const twice = printAST(parseSpeckContent(once));
    expect(twice).toBe(once);
    expect(parseSpeckContent(once).domains.map(d => d.language)).toEqual(ast.domains.map(d => d.language));
  });

  it('rejects domain syntax that is not a bounded context', () => {
    expect(() => parseSpeckContent('domain { members: A; }\n')).toThrow(/expected "domain <Name> \{/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n')).toThrow(/unclosed domain/);
    expect(() => parseSpeckContent('domain D {\n    members: ;\n}\n')).toThrow(/has no members/);
    expect(() => parseSpeckContent('domain D {\n    language: "x";\n}\n')).toThrow(/must declare members/);
    expect(() => parseSpeckContent('domain D {\n    members: A, A+B;\n}\n')).toThrow(/not a speck name/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    members: B;\n}\n')).toThrow(/declares members twice/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    language: "x";\n    language: "y";\n}\n')).toThrow(/declares language twice/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    language: ;\n}\n')).toThrow(/language is empty/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    language: "hi" trailing;\n}\n')).toThrow(/language string is invalid/);
    expect(() => parseSpeckContent('domain D {\n    members: A;\n    owner: A;\n}\n')).toThrow(/unexpected clause/);
    expect(() => parseSpeckContent('import nope\n')).toThrow(/Failed to parse import statement/);
    expect(() => parseSpeckContent('speck S {\n    domain Inner {\n        members: S;\n    }\n}\n')).toThrow(/domain blocks are file-level/);
  });
});

describe('provenance golden files', () => {
  it('records a domain entity linked to its member specks', () => {
    const file = join(FIX, 'domain', 'two-domain.speckdl');
    const out = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    generateProvenanceFromIR(load(file), out);
    for (const name of ['Invoice', 'Ledger', 'Shipment']) {
      const got = normalizeProv(readFileSync(join(out, `${name}.prov.jsonld`), 'utf8'));
      const golden = join(FIX, 'domain', `${name}.prov.jsonld`);
      expect(got).toBe(readFileSync(golden, 'utf8'));
    }
    const billing = JSON.parse(readFileSync(join(FIX, 'domain', 'Invoice.prov.jsonld'), 'utf8'));
    const domain = billing['@graph'].find((n: { '@id'?: string }) => n['@id'] === 'domain:Billing');
    expect(domain).toMatchObject({
      '@type': ['prov:Entity', 'prov:Collection'],
      'speckl:kind': 'domain',
      'prov:hadMember': ['speck:Invoice', 'speck:Ledger'],
    });
  });
});

describe('doctor', () => {
  function writeAgent(root: string, harness: string, domainMembers: string): string {
    const file = join(root, 'agent.speckdl');
    writeFileSync(file, `speck Worker {
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
    action Look(path: String) {
        return true
    }
    agent {
        stages stage {
            Idle = 0
            Done = 1
        }
        tool go -> Go effect act
        tool look -> Look effect observe
${harness}
    }
    next: Go | Look
}
speck Note {
    state { x: Nat }
    init { x := 0 }
}
domain Ops {
    members: ${domainMembers};
    language: "ops";
}
`);
    return file;
  }

  it('fails when a domain member act tool is not mapped, and passes when every harness maps it', () => {
    const root = mkdtempSync(join(tmpdir(), 'speckl-doctor-'));
    const unmapped = writeAgent(root, '', 'Worker, Worker');
    const bad = doctorFile(unmapped);
    expect(bad.ok).toBe(false);
    expect(bad.errors.filter(e => e.startsWith('doctor:'))).toEqual([
      'doctor: domain Ops member Worker act tool go is not mapped in a harness block',
    ]);

    const mapped = writeAgent(mkdtempSync(join(tmpdir(), 'speckl-doctor-')), `        harness claude-code {
            map Bash -> go
        }
        harness cursor {
            map Shell -> go
        }`, 'Worker, Note');
    expect(doctorFile(mapped)).toEqual({ ok: true, errors: [] });

    const half = writeAgent(mkdtempSync(join(tmpdir(), 'speckl-doctor-')), `        harness claude-code {
            map Bash -> go
        }
        harness cursor {
            map Read -> look
        }`, 'Worker');
    expect(doctorFile(half).errors).toContain(
      'doctor: domain Ops member Worker act tool go is not mapped in harness cursor',
    );
  });

  it('does not require a harness for an act tool outside every domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'speckl-doctor-'));
    const file = writeAgent(root, '', 'Note');
    expect(doctorFile(file).ok).toBe(true);
  });

  it('runDoctor reports usage, missing files, success, and failure', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runDoctor(['--help'])).toBe(0);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/usage: speckl doctor/);
    expect(runDoctor([])).toBe(1);
    expect(runDoctor([tmpdir()])).toBe(1);
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/doctor: cannot read /);
    const root = mkdtempSync(join(tmpdir(), 'speckl-doctor-'));
    const ok = join(root, 'ok.speckdl');
    writeFileSync(ok, 'speck Ok {\n    state { x: Nat }\n    init { x := 0 }\n}\n');
    expect(runDoctor([ok])).toBe(0);
    const missing = join(FIX, 'import', 'missing', 'root.speckdl');
    expect(runDoctor([missing])).toBe(1);
    expect(doctorFile(join(root, 'nope.speckdl')).ok).toBe(false);
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
    const prov = JSON.parse(readFileSync(join(okOut, 'Invoice.prov.jsonld'), 'utf8'));
    expect(prov['@graph'].some((n: { '@id'?: string }) => n['@id'] === 'domain:Books')).toBe(true);
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

describe('speckl doctor and compile entry', () => {
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

  it('main dispatches doctor and compiles a file', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['node', 'speckl', 'doctor', '--help'])).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'speckl-main-'));
    const file = join(root, 'Tiny.speckdl');
    writeFileSync(file, 'speck Tiny {\n    state { x: Nat }\n    init { x := 0 }\n    action Inc { x := x + 1 }\n}\n');
    const out = join(root, 'out');
    expect(await main(['node', 'speckl', file, '-o', out, '-t', 'typescript', '-b', 'cdx'])).toBe(0);
    expect(existsSync(join(out, 'Tiny.ts'))).toBe(true);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/usage: speckl doctor/);
  });
});
