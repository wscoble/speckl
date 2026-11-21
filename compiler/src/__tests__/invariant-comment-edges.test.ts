// A trailing comment is not part of an invariant. The line walker kept it.
// An invariant with no comment is unchanged. A comment-only body is an error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

const examplesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');

function expr(src: string, name: string): string {
  const ast = parseSpeckContent(src, 'inv.speckdl');
  const member = ast.specks[0].members.find(m => m.type === 'invariant' && m.name === name);
  if (member?.type !== 'invariant') throw new Error(`missing ${name}`);
  return member.expr;
}

const machine = (body: string) => [
  'speck S {',
  '    state {',
  '        n: Nat',
  '    }',
  '    init {',
  '        n := 0',
  '    }',
  body,
  '}',
  '',
].join('\n');

describe('invariant comments', () => {
  it('drops a trailing line comment and keeps an invariant that has none', () => {
    const src = machine([
      '    invariant Bound {',
      '        n <= 1  // max',
      '    }',
      '    invariant Plain {',
      '        n >= 0',
      '    }',
    ].join('\n'));
    // Before: the walker stored `n <= 1  // max`. Rust printed that comment
    // in the doc line. After: the expression is `n <= 1`. Plain is unchanged.
    expect(expr(src, 'Bound')).toBe('n <= 1');
    expect(expr(src, 'Bound')).not.toContain('//');
    expect(expr(src, 'Plain')).toBe('n >= 0');
  });

  it('drops the OAuth tails and keeps the expression', () => {
    const file = join(examplesDir, 'OAuth2AuthorizationCode.speckdl');
    const ast = parseSpeckContent(readFileSync(file, 'utf8'), 'OAuth2AuthorizationCode.speckdl');
    const text = (name: string) => {
      const member = ast.specks[0].members.find(m => m.type === 'invariant' && m.name === name);
      if (member?.type !== 'invariant') throw new Error(`missing ${name}`);
      return member.expr;
    };
    const bounded = text('TokenValidityBounded');
    expect(bounded.endsWith('7776000')).toBe(true);
    expect(bounded).not.toContain('90 days');
    const redirect = text('RedirectUriConsistency');
    expect(redirect.endsWith('true')).toBe(true);
    expect(redirect).not.toContain('ExchangeCode');
  });

  it('keeps a comment marker inside a string and drops a block comment', () => {
    const src = machine([
      '    invariant Quoted {',
      '        s = "a // b"',
      '    }',
      '    invariant Blocked {',
      '        n >= 0 /* note */',
      '    }',
    ].join('\n'));
    expect(expr(src, 'Quoted')).toContain('"a // b"');
    expect(expr(src, 'Blocked')).toBe('n >= 0');
    expect(expr(src, 'Blocked')).not.toContain('note');
  });

  it('rejects an empty invariant and a comment-only invariant', () => {
    expect(() => parseSpeckContent(machine('    invariant Empty { }'), 'inv.speckdl'))
      .toThrow(/invariant expression is empty/);
    expect(() => parseSpeckContent(machine('    invariant Only {\n        // nothing\n    }'), 'inv.speckdl'))
      .toThrow(/invariant expression is empty/);
  });
});
