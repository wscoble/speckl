// The Rust generator fails closed when member type info is missing or unknown.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { lower } from '../ir/lower.js';
import type { IR } from '../ir/types.js';
import { generateRust } from '../generators/rust.js';

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
}
`;

const bareIr = { specks: [{ name: 'S' }] } as unknown as IR;

describe('Rust fails closed', () => {
  it('rejects a missing member list, an unknown type, and oneof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-rust-'));
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateRust(bareIr, dir, noMembers)).toThrow(/members are missing on speck "S"/);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateRust(bareIr, dir, odd)).toThrow(/no handler for AST node type "not-a-member"/);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateRust(bareIr, dir, oneof)).toThrow(/rust backend rejects AST node type "oneof"/);
    expect(() => generateRust(bareIr, dir)).toThrow(/sourceMemberTypes is missing on speck "S"/);
  });

  it('accepts an ordinary speck and an empty IR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-rust-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, machine);
    const ast = parseSpeckContent(machine, file);
    const ir = lower(ast, { filePath: file, resolveImports: false });
    expect(() => generateRust(ir, dir, ast)).not.toThrow();
    expect(() => generateRust({ specks: [] } as unknown as IR, dir)).not.toThrow();
  });
});
