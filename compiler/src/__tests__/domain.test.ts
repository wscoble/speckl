import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSpec } from '../compile.js';
import { parseDomain } from '../domain-parse.js';
import { doctorFile, runDoctor } from '../doctor.js';
import { lower } from '../ir/lower.js';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { printAST } from '../printer.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/domain/two-domain.speckdl');

function parse(src: string) {
  return parseSpeckContent(src, 'domain.speckdl');
}

describe('domain blocks', () => {
  it('parses two domains and keeps each speck separate', () => {
    const ast = parseSpeckFile(fixture);
    expect(ast.domains?.map(d => d.name)).toEqual(['Billing', 'Fulfillment']);
    expect(ast.domains?.[0].members).toEqual(['Invoice', 'Ledger']);
    expect(ast.domains?.[0].language).toBe('An invoice is issued before a ledger posts it');
    expect(ast.domains?.[1].members).toEqual(['Shipment']);
    expect(ast.specks.map(s => s.name)).toEqual(['Invoice', 'Ledger', 'Shipment']);
    expect(ast.specks[0].members.map(m => m.type)).toEqual(['state', 'init', 'action']);
  });

  it('rejects a domain that is not a named block', () => {
    expect(() => parse('domain { members: A; }\n')).toThrow(/expected "domain <Name> \{/);
  });

  it('reports a missing brace before an unclosed domain body', () => {
    expect(() => parse('domain D {\n    members: A;\n')).toThrow(/missing final "\}"/);
  });

  it('rejects an empty members clause', () => {
    expect(() => parse('domain D { members: ; }\n')).toThrow(/has no members/);
  });

  it('rejects a domain that omits members', () => {
    expect(() => parse('domain D { language: "only"; }\n')).toThrow(/must declare members/);
  });

  it('rejects a member that is not a speck name', () => {
    expect(() => parse('domain D { members: A, A+B; }\n')).toThrow(/not a speck name/);
  });

  it('rejects members declared twice', () => {
    expect(() => parse('domain D { members: A; members: B; }\n')).toThrow(/declares members twice/);
  });

  it('rejects language declared twice', () => {
    expect(() => parse('domain D { members: A; language: "a"; language: "b"; }\n')).toThrow(/declares language twice/);
  });

  it('rejects an empty language clause', () => {
    expect(() => parse('domain D { members: A; language: ; }\n')).toThrow(/language is empty/);
  });

  it('rejects a language string with trailing text', () => {
    expect(() => parse('domain D { members: A; language: "hi" trailing; }\n')).toThrow(/language string is invalid/);
  });

  it('rejects an unexpected clause', () => {
    expect(() => parse('domain D { members: A; owner: A; }\n')).toThrow(/unexpected clause/);
  });

  it('rejects a domain nested inside a speck', () => {
    const src = 'speck A {\n state { x: Nat }\n init { x := 0 }\n domain Inner { members: A; }\n}\n';
    expect(() => parse(src)).toThrow(/domain blocks are file-level/);
  });

  it('does not check that a member names a speck in this file', () => {
    const ast = parse('domain D { members: Missing; }\n');
    expect(ast.domains?.[0].members).toEqual(['Missing']);
    expect(ast.specks).toEqual([]);
  });

  it('keeps a semicolon that sits inside the language string', () => {
    const ast = parse('domain D { members: A; language: "a; b"; }\n');
    expect(ast.domains?.[0].language).toBe('a; b');
    expect(ast.domains?.[0].members).toEqual(['A']);
  });

  it('ignores a comment between clauses', () => {
    const ast = parse('domain D {\n    members: A;\n    // owner: nope\n    language: "x";\n}\n');
    expect(ast.domains?.[0].members).toEqual(['A']);
    expect(ast.domains?.[0].language).toBe('x');
  });

  it('keeps a closing brace that sits inside the language string', () => {
    const ast = parse('domain D { members: A; language: "a}b"; }\n');
    expect(ast.domains?.[0].members).toEqual(['A']);
    expect(ast.domains?.[0].language).toBe('a}b');
  });

  it('omits the language field when the clause is absent', () => {
    const ast = parse('domain D { members: A; }\n');
    expect(ast.domains?.[0].members).toEqual(['A']);
    expect(Object.prototype.hasOwnProperty.call(ast.domains?.[0], 'language')).toBe(false);
  });

  it('rejects a members list that is only commas', () => {
    expect(() => parse('domain D { members: , , ; }\n')).toThrow(/has no members/);
  });

  it('rejects a member name that contains a space', () => {
    expect(() => parse('domain D { members: A B; }\n')).toThrow(/not a speck name/);
  });

  it('rejects a language string with a bad escape', () => {
    expect(() => parse('domain D { members: A; language: "say \\q"; }\n')).toThrow(/language string is invalid/);
  });

  it('keeps a single-quoted language with trailing text as the raw clause', () => {
    const ast = parse("domain D { members: A; language: 'hi' extra; }\n");
    expect(ast.domains?.[0].language).toBe("'hi' extra");
  });

  it('a brace after an unclosed quote is unclosed domain', () => {
    expect(() => parse("domain D { members: A; language: 'hi; }\n")).toThrow(/unclosed domain/);
  });

  it('the domain scanner reports unclosed domain when no brace check runs first', () => {
    expect(() => parseDomain(['domain D { members: A;'], 0)).toThrow(/unclosed domain/);
  });

  it('parses a hyphenated domain name and a hyphenated member', () => {
    const ast = parse('domain pay-ops { members: inv-oice; }\n');
    expect(ast.domains?.[0].name).toBe('pay-ops');
    expect(ast.domains?.[0].members).toEqual(['inv-oice']);
  });

  it('round-trips domains through printAST', () => {
    const src = [
      'domain Billing {',
      '    members: Invoice,',
      '             Ledger;',
      '    // note',
      '    language: "say \\"hi\\" and {braces}";',
      '}',
      'domain Other { members: Note; language: payments }',
      "domain Quoted { members: Note; language: 'plain text'; }",
      'speck Invoice {',
      '    state { id: String }',
      '    init { id := "" }',
      '}',
      'speck Ledger {',
      '    state { posted: Bool }',
      '    init { posted := false }',
      '}',
      'speck Note {',
      '    state { t: String }',
      '    init { t := "" }',
      '}',
      '',
    ].join('\n');
    const ast = parse(src);
    const again = parse(printAST(ast));
    expect(again.domains?.map(d => ({ name: d.name, members: d.members, language: d.language }))).toEqual(
      ast.domains?.map(d => ({ name: d.name, members: d.members, language: d.language })),
    );
    expect(again.domains?.find(d => d.name === 'Billing')?.language).toBe('say "hi" and {braces}');
    expect(again.domains?.find(d => d.name === 'Quoted')?.language).toBe('plain text');
    expect(again.specks.map(s => s.name)).toEqual(['Invoice', 'Ledger', 'Note']);
  });
});

describe('domain IR', () => {
  function write(dir: string, name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  const speck = (name: string) => `speck ${name} {\n state { x: Nat }\n init { x := 0 }\n}\n`;

  it('records domains and rejects a missing member, a duplicate, and two owners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-'));
    try {
      const ok = write(dir, 'ok.speckdl', `domain D { members: A, B; language: "ab"; }\n${speck('A')}${speck('B')}`);
      const ir = lower(parseSpeckFile(ok), { filePath: ok, resolveImports: true, rootDir: dir });
      expect(ir.domains).toEqual([{ name: 'D', members: ['A', 'B'], language: 'ab', sourcePath: ok }]);
      expect(ir.diagnostics.filter(d => d.message.startsWith('domain:'))).toEqual([]);

      const missing = write(dir, 'missing.speckdl', `domain D { members: Missing; }\n${speck('A')}`);
      const missingIr = lower(parseSpeckFile(missing), { filePath: missing, resolveImports: true, rootDir: dir });
      expect(missingIr.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: D member Missing is not a speck/);

      const twice = write(dir, 'twice.speckdl', `domain D { members: A, A; }\n${speck('A')}`);
      const twiceIr = lower(parseSpeckFile(twice), { filePath: twice, resolveImports: true, rootDir: dir });
      expect(twiceIr.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: D lists A more than once/);

      const two = write(dir, 'two.speckdl', `domain One { members: A; }\ndomain Two { members: A; }\n${speck('A')}`);
      const twoIr = lower(parseSpeckFile(two), { filePath: two, resolveImports: true, rootDir: dir });
      expect(twoIr.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: speck A is a member of One and Two/);

      const again = write(dir, 'again.speckdl', `domain D { members: A; }\ndomain D { members: B; }\n${speck('A')}${speck('B')}`);
      const againIr = lower(parseSpeckFile(again), { filePath: again, resolveImports: true, rootDir: dir });
      expect(againIr.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: D is declared more than once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an imported domain and rejects a member that already belongs to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-import-'));
    try {
      write(dir, 'a.speckdl', `${speck('A')}domain One { members: A; }\n`);
      const root = write(dir, 'root.speckdl', `import "a.speckdl"\n${speck('B')}domain Two { members: A, B; }\n`);
      const ir = lower(parseSpeckFile(root), { filePath: root, resolveImports: true, rootDir: dir });
      expect(ir.domains?.map(d => d.name).sort()).toEqual(['One', 'Two']);
      expect(ir.specks.map(s => s.name).sort()).toEqual(['A', 'B']);
      expect(ir.diagnostics.map(d => d.message).join('\n')).toMatch(/domain: speck A is a member of One and Two/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds a prov:Collection for a domain member', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-prov-'));
    const out = join(dir, 'out');
    mkdirSync(out);
    try {
      compileSpec(fixture, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 1 });
      const graph = JSON.parse(readFileSync(join(out, 'Invoice.prov.jsonld'), 'utf8'));
      const domain = graph['@graph'].find((node: { '@id'?: string }) => node['@id'] === 'domain:Billing');
      expect(domain).toMatchObject({
        '@type': ['prov:Entity', 'prov:Collection'],
        'speckl:kind': 'domain',
        'speckl:language': 'An invoice is issued before a ledger posts it',
        'prov:hadMember': ['speck:Invoice', 'speck:Ledger'],
      });
      const shipment = JSON.parse(readFileSync(join(out, 'Shipment.prov.jsonld'), 'utf8'));
      const fulfillment = shipment['@graph'].find((node: { '@id'?: string }) => node['@id'] === 'domain:Fulfillment');
      expect(fulfillment?.['prov:hadMember']).toEqual(['speck:Shipment']);
      const invoiceBilling = graph['@graph'].filter((node: { '@id'?: string }) => node['@id'] === 'domain:Fulfillment');
      expect(invoiceBilling).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a domain error and does not write the generated file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-domain-fail-'));
    const out = join(dir, 'out');
    try {
      const file = write(dir, 'bad.speckdl', `domain D { members: Missing; }\n${speck('A')}`);
      expect(() => compileSpec(file, { outputDir: out, target: 'typescript', bomFormat: 'cdx', verifyDepth: 1 }))
        .toThrow(/domain: D member Missing is not a speck/);
      expect(() => readFileSync(join(out, 'A.ts'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('speckl doctor', () => {
  function agent(members: string, harness: string): string {
    return [
      'speck Worker {',
      '    state { stage: Nat }',
      '    init { stage := 0 }',
      '    action Go { stage := 1 }',
      '    action Look { stage := stage }',
      '    agent {',
      '        tool go -> Go effect act',
      '        tool look -> Look effect observe',
      harness,
      '    }',
      '}',
      'speck Note {',
      '    state { t: String }',
      '    init { t := "" }',
      '}',
      `domain Ops { members: ${members}; language: "ops"; }`,
      '',
    ].join('\n');
  }

  it('fails when an act tool is not a harness map target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-doctor-'));
    try {
      const mapped = join(dir, 'mapped.speckdl');
      writeFileSync(mapped, agent('Worker', '        harness claude-code {\n            map Bash -> go\n        }'));
      const good = doctorFile(mapped);
      expect(good.ok).toBe(true);
      expect(good.errors).toEqual([]);

      const bare = join(dir, 'bare.speckdl');
      writeFileSync(bare, agent('Worker', ''));
      const bad = doctorFile(bare);
      expect(bad.ok).toBe(false);
      expect(bad.errors.filter(e => e.startsWith('doctor:'))).toEqual([
        'doctor: domain Ops member Worker act tool go is not mapped in a harness block',
      ]);

      const partial = join(dir, 'partial.speckdl');
      writeFileSync(partial, agent('Worker', '        harness claude-code {\n            map Bash -> look\n        }'));
      const half = doctorFile(partial);
      expect(half.errors.filter(e => e.startsWith('doctor:'))).toEqual([
        'doctor: domain Ops member Worker act tool go is not mapped in harness claude-code',
      ]);

      const dup = join(dir, 'dup.speckdl');
      writeFileSync(dup, agent('Worker, Worker', '        harness claude-code {\n            map Bash -> go\n        }'));
      const doubled = doctorFile(dup);
      expect(doubled.ok).toBe(false);
      expect(doubled.errors.some(e => e.startsWith('domain:'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runDoctor prints ok, usage, and a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-doctor-cli-'));
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      expect(runDoctor(['--help'])).toBe(0);
      expect(logs.join('\n')).toMatch(/Usage: speckl doctor/);
      expect(runDoctor([])).toBe(1);
      const file = join(dir, 'ok.speckdl');
      writeFileSync(file, 'speck A {\n state { x: Nat }\n init { x := 0 }\n}\n');
      expect(runDoctor([file])).toBe(0);
      expect(logs.some(line => line === `doctor: ${file} ok`)).toBe(true);
      expect(runDoctor([join(dir, 'missing.speckdl')])).toBe(1);
      expect(errors.some(line => line.startsWith('doctor: cannot read'))).toBe(true);
    } finally {
      console.log = log;
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
