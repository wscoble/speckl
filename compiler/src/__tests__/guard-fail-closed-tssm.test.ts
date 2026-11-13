// The TypeScript state machine fails closed when member type info is missing.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
}
`;

describe('TypeScript state machine fails closed', () => {
  it('rejects a missing member list, an unknown type, and oneof, and writes no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-tssm-'));
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateTypeScriptStateMachine(noMembers, dir)).toThrow(/members are missing on speck "S"/);
    expect(existsSync(join(dir, 'S.ts'))).toBe(false);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateTypeScriptStateMachine(odd, dir)).toThrow(/no handler for AST node type "not-a-member"/);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateTypeScriptStateMachine(oneof, dir)).toThrow(/typescript backend rejects AST node type "oneof"/);
    expect(existsSync(join(dir, 'S.ts'))).toBe(false);
  });

  it('accepts an ordinary speck and a speck with no members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-tssm-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, machine);
    generateTypeScriptStateMachine(parseSpeckContent(machine, file), dir);
    expect(existsSync(join(dir, 'S.ts'))).toBe(true);
    const emptyDir = mkdtempSync(join(tmpdir(), 'speckl-guard-tssm-'));
    generateTypeScriptStateMachine(parseSpeckContent('speck S {\n}\n', file), emptyDir);
    expect(existsSync(join(emptyDir, 'S.ts'))).toBe(true);
  });
});
