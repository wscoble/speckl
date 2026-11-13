import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDomain } from '../domain-parse.js';
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
