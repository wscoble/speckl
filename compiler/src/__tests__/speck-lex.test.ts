import { describe, expect, it } from 'vitest';
import { lexSpeck } from '../speck-lex.js';

function kinds(src: string): string[] {
  return lexSpeck(src).tokens.map(t => t.kind === 'punct' || t.kind === '{' || t.kind === '}' ? t.text : `${t.kind}:${t.text}`);
}

describe('speck lexer', () => {
  it('does not emit a brace that sits in a string, a line comment, or a block comment', () => {
    const src = [
      'speck S {',
      '  // brace } here',
      '  state { n: Nat }',
      '  action Go { n := "{}" }',
      '  /* } { */',
      '}',
      '',
    ].join('\n');
    const braces = lexSpeck(src).tokens.filter(t => t.kind === '{' || t.kind === '}').map(t => `${t.kind}@${t.line}`);
    expect(braces).toEqual(['{@1', '{@3', '}@3', '{@4', '}@4', '}@6']);
  });

  it('treats a prime as prime notation, not a string quote', () => {
    expect(kinds("n' >= n")).toEqual(['ident:n', "prime:'", '>', '=', 'ident:n']);
  });

  it('keeps a duration suffix as a number plus a unit, and rejects other numeric forms', () => {
    expect(kinds('24h 500ms 1.5h')).toEqual(['number:24', 'ident:h', 'number:500', 'ident:ms', 'number:1.5', 'ident:h']);
    expect(() => lexSpeck('1e5')).toThrow(/unsupported numeric literal "1e5"/);
    expect(() => lexSpeck('0x1F')).toThrow(/unsupported numeric literal "0x1F"/);
    expect(() => lexSpeck('1_000')).toThrow(/unsupported numeric literal "1_000"/);
    expect(() => lexSpeck('5min')).toThrow(/unsupported numeric literal "5min"/);
    expect(() => lexSpeck('9A')).toThrow(/identifier must not start with a digit/);
  });

  it('reports an unclosed string on the line where it opened', () => {
    expect(() => lexSpeck('speck S {\n  s := "abc\n}\n', 'open.speckdl')).toThrow(
      /Parse error at open\.speckdl:2: unterminated string \(column 8\)/,
    );
  });

  it('reports an unclosed block comment on the line where it opened', () => {
    expect(() => lexSpeck('speck S {\n  /* oops\n}\n', 'open.speckdl')).toThrow(
      /Parse error at open\.speckdl:2: unterminated block comment \(column 3\)/,
    );
  });

  it('treats a slash-star inside an open block comment as comment text', () => {
    const lexed = lexSpeck('/* outer /* still */ speck S {\n}\n');
    expect(lexed.tokens.map(t => t.text)).toEqual(['speck', 'S', '{', '}']);
    expect(lexed.headerAfterComment).toEqual([]);
  });

  it('records a header that follows a comment closer at the start of the line', () => {
    const lexed = lexSpeck('/* note\n*/ speck S {\n}\n');
    expect(lexed.headerAfterComment).toEqual([2]);
    const later = lexSpeck('keep /* note */ speck S {\n}\n');
    expect(later.headerAfterComment).toEqual([]);
  });

  it('rejects a non-ASCII identifier and keeps non-ASCII inside a comment or a string', () => {
    expect(() => lexSpeck('speck Größe {\n}\n', 'id.speckdl')).toThrow(
      /Parse error at id\.speckdl:1: identifier must be ASCII \(column 9\)/,
    );
    const kept = lexSpeck('// Größe\nspeck S { s := "Größe" }\n');
    expect(kept.tokens.find(t => t.kind === 'string')?.text).toBe('"Größe"');
  });

  it('strips a leading byte-order mark before the first token', () => {
    expect(lexSpeck('\uFEFFspeck S {\n}\n').tokens[0]).toMatchObject({ kind: 'ident', text: 'speck', column: 1 });
  });

  it('treats CRLF as a line break and does not let a comment swallow the next line', () => {
    const src = 'speck S {\r\n  // brace }\r\n  state { n: Nat }\r\n}\r\n';
    const braces = lexSpeck(src).tokens.filter(t => t.kind === '{' || t.kind === '}').map(t => `${t.kind}@${t.line}`);
    expect(braces).toEqual(['{@1', '{@3', '}@3', '}@4']);
    expect(lexSpeck(src).tokens.filter(t => t.kind === 'ident').map(t => t.text)).toContain('state');
  });

  it('skips a tab as whitespace and keeps a tab inside a string', () => {
    const src = 'speck\tS\t{\n\tstate { n: Nat }\n}\n';
    expect(lexSpeck(src).tokens.filter(t => t.kind === 'ident' || t.kind === '{' || t.kind === '}').map(t => t.text))
      .toEqual(['speck', 'S', '{', 'state', '{', 'n', 'Nat', '}', '}']);
    expect(lexSpeck('s := "a\tb"\n').tokens.find(t => t.kind === 'string')?.text).toBe('"a\tb"');
  });

  it('rejects an unterminated string that stops at CR, and a string that never closes', () => {
    expect(() => lexSpeck('s := "abc\r\n', 'cr.speckdl')).toThrow(
      /Parse error at cr\.speckdl:1: unterminated string \(column 6\)/,
    );
    expect(() => lexSpeck('s := "abc', 'eof.speckdl')).toThrow(
      /Parse error at eof\.speckdl:1: unterminated string \(column 6\)/,
    );
  });

  it('rejects a non-ASCII identifier after a tab, and keeps a non-ASCII string on a CRLF line', () => {
    expect(() => lexSpeck('\tspeck Größe {\r\n}\r\n', 'id.speckdl')).toThrow(
      /Parse error at id\.speckdl:1: identifier must be ASCII \(column 10\)/,
    );
    expect(lexSpeck('s := "Größe"\r\n').tokens.find(t => t.kind === 'string')?.text).toBe('"Größe"');
    expect(lexSpeck('// Größe\r\nspeck S {\r\n}\r\n').tokens.map(t => t.text)).toEqual(['speck', 'S', '{', '}']);
  });
});
