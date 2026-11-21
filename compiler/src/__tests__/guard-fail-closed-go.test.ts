// The Go generator fails closed when member type info is missing or unknown.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { generateGo } from '../generators/go.js';

const machine = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go { n := n + 1 }
}
`;

describe('Go fails closed', () => {
  it('rejects a missing member list, an unknown type, and oneof, and writes no module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-go-'));
    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateGo(noMembers, dir)).toThrow(/members are missing on speck "S"/);
    expect(existsSync(join(dir, 's', 's.go'))).toBe(false);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateGo(odd, dir)).toThrow(/no handler for AST node type "not-a-member"/);
    const oneof = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] } as MemberNode] }] } as AST;
    expect(() => generateGo(oneof, dir)).toThrow(/go backend rejects AST node type "oneof"/);
    expect(existsSync(join(dir, 's', 's.go'))).toBe(false);
  });

  it('accepts an ordinary speck and a speck with no members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-go-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, machine);
    generateGo(parseSpeckContent(machine, file), dir);
    expect(existsSync(join(dir, 's', 's.go'))).toBe(true);
    const emptyDir = mkdtempSync(join(tmpdir(), 'speckl-guard-go-'));
    generateGo(parseSpeckContent('speck Empty {\n}\n', file), emptyDir);
    expect(existsSync(join(emptyDir, 'empty', 'empty.go'))).toBe(true);
  });

  it('still drops an else-if, which this backend does not emit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-guard-go-'));
    const src = `speck S {
    state { n: Nat }
    init { n := 0 }
    action Go {
        if n > 0 {
            n := 1
        } else if n > 1 {
            n := 2
        }
    }
}
`;
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, src);
    generateGo(parseSpeckContent(src, file), dir);
    const go = readFileSync(join(dir, 's', 's.go'), 'utf8');
    expect(go).toContain('m.N = 1');
    expect(go).not.toContain('else if');
  });
});
