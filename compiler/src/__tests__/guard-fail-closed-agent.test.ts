// The agent generator fails closed when member type info is missing or unknown.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { generateAgent } from '../generators/agent/index.js';

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
}
`;

describe('agent fails closed', () => {
  it('rejects a missing member list, an unknown type, and oneof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-agent-'));
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateAgent(noMembers, { outputDir: dir })).toThrow(/members are missing on speck "S"/);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateAgent(odd, { outputDir: dir })).toThrow(/no handler for AST node type "not-a-member"/);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateAgent(oneof, { outputDir: dir })).toThrow(/agent backend rejects AST node type "oneof"/);
  });

  it('accepts an ordinary speck and a speck with no members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-agent-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, machine);
    expect(() => generateAgent(parseSpeckContent(machine, file), { outputDir: dir, sourcePath: file })).not.toThrow();
    const empty = parseSpeckContent('speck S {\n}\n', file);
    expect(() => generateAgent(empty, { outputDir: dir, sourcePath: file })).not.toThrow();
  });
});
