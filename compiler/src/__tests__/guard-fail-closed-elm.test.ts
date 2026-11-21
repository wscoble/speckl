// The Elm generator fails closed when member type info is missing or unknown.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { generateElm } from '../generators/elm.js';

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
}
`;

describe('Elm fails closed', () => {
  it('rejects a missing member list, an unknown type, and oneof before creating the package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-elm-'));
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateElm(noMembers, dir)).toThrow(/members are missing on speck "S"/);
    expect(existsSync(join(dir, 's-elm'))).toBe(false);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateElm(odd, dir)).toThrow(/no handler for AST node type "not-a-member"/);
    expect(existsSync(join(dir, 's-elm'))).toBe(false);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateElm(oneof, dir)).toThrow(/elm backend rejects AST node type "oneof"/);
    expect(existsSync(join(dir, 's-elm'))).toBe(false);
  });

  it('accepts an ordinary speck and a speck with no members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-elm-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, machine);
    generateElm(parseSpeckContent(machine, file), dir);
    expect(existsSync(join(dir, 's-elm', 'src'))).toBe(true);
    const emptyDir = mkdtempSync(join(tmpdir(), 'speckl-guard-elm-'));
    generateElm(parseSpeckContent('speck Empty {\n}\n', file), emptyDir);
    expect(existsSync(join(emptyDir, 'empty-elm', 'src'))).toBe(true);
  });
});
