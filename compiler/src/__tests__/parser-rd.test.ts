import { describe, it, expect } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { lexSpeck } from '../speck-lex.js';

function firstNonAsciiColumn(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) > 127) return i + 1;
  }
  throw new Error(`no non-ASCII character in ${JSON.stringify(line)}`);
}

const machine = [
  'speck Gate {',
  '    state { n: Nat }',
  '    init { n := 0 }',
  '    action Inc {',
  '        require n < 3',
  '        n := n + 1',
  '    }',
  '}',
  '',
].join('\n');

describe('token parser', () => {
  it('rejects a non-ASCII identifier with line and column', () => {
    const src = 'speck Größe {\n    state { n: Nat }\n}\n';
    const column = firstNonAsciiColumn(src.split('\n')[0]);
    expect(() => parseSpeckContent(src, 'id.speckdl')).toThrow(
      new RegExp(`Parse error at id\\.speckdl:1: identifier must be ASCII \\(column ${column}\\)`),
    );
    const action = '    action Größe { n := 1 }';
    expect(() => parseSpeckContent(`speck S {\n    state { n: Nat }\n${action}\n}\n`)).toThrow(
      new RegExp(`Parse error at line 3: identifier must be ASCII \\(column ${firstNonAsciiColumn(action)}\\)`),
    );
  });

  it('allows non-ASCII inside comments and strings', () => {
    const src = [
      'speck S {',
      '    // Größe → ok',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go {',
      '        n := 1',
      '        /* Größe */',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(parseSpeckContent(src).specks.map(s => s.name)).toEqual(['S']);
  });

  it('reports an unterminated string with line and column', () => {
    const src = 'speck S {\n    state { n: Nat }\n    init { s := "abc }\n}\n';
    expect(() => parseSpeckContent(src, 'bad.speckdl')).toThrow(
      /Parse error at bad\.speckdl:3: unterminated string \(column /,
    );
  });

  it('reports an unterminated block comment with line and column', () => {
    const src = 'speck S {\n    state { n: Nat }\n    /* never\n}\n';
    expect(() => parseSpeckContent(src, 'bad.speckdl')).toThrow(
      /Parse error at bad\.speckdl:3: unterminated block comment \(column 5\)/,
    );
  });

  it('rejects a next: alternative that is not a name, with its line', () => {
    const src = machine.replace('action Inc {', 'next: 1 +\n    action Inc {');
    expect(() => parseSpeckContent(src, 'next.speckdl')).toThrow(
      /Parse error at line \d+: next: alternative "1 \+" is not an action name/,
    );
  });

  it('rejects an unexpected non-ASCII mark outside a comment', () => {
    const src = 'speck S {\n    state { n: Nat }\n    →\n}\n';
    expect(() => parseSpeckContent(src, 'mark.speckdl')).toThrow(
      /Parse error at mark\.speckdl:3: unexpected character "→" \(column 5\)/,
    );
  });

  it('lexes braces inside strings as string text, not structure', () => {
    const lexed = lexSpeck('speck S {\n    init { s := "{" }\n}\n');
    const braces = lexed.tokens.filter(t => t.kind === '{' || t.kind === '}');
    expect(braces.map(t => t.kind)).toEqual(['{', '{', '}', '}']);
  });

  it('parses a well-formed machine', () => {
    const ast = parseSpeckContent(machine, 'gate.speckdl');
    const action = ast.specks[0].members.find(m => m.type === 'action') as { statements: { type: string; expr?: string }[] };
    expect(action.statements.map(s => s.type)).toEqual(['require', 'assign']);
    expect(action.statements[0].expr).toBe('n < 3');
  });
});
