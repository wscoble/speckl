import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AST, MemberNode } from '../parser.js';
import type { IR } from '../ir/types.js';
import {
  BACKENDS, COVERAGE, MEMBER_NODE_TYPES, conservationLog, guardAst, guardIr, memberNodeTypesMatchUnion,
} from '../conservation.js';
import { compileSpec } from '../compile.js';

function ast(type: string): AST {
  return { specks: [{ type: 'speck', name: 'S', members: [{ type } as MemberNode] }] };
}

describe('backend conservation', () => {
  it('lists every parser member type', () => {
    expect(memberNodeTypesMatchUnion).toBe(true);
    expect(new Set(MEMBER_NODE_TYPES).size).toBe(MEMBER_NODE_TYPES.length);
  });

  it('every backend marks every listed type emit, reject, or n/a', () => {
    for (const backend of BACKENDS) {
      expect(Object.keys(COVERAGE[backend]).sort()).toEqual([...MEMBER_NODE_TYPES].sort());
      for (const type of MEMBER_NODE_TYPES) {
        const cell = COVERAGE[backend][type];
        expect(cell.disposition, `${backend} ${type}`).toMatch(/^(emit|reject|n\/a)$/);
        if (cell.disposition === 'n/a') expect(cell.reason, `${backend} ${type}`).toBeTruthy();
      }
    }
  });

  it('rejects oneof for Go and emits it for Protobuf', () => {
    expect(() => guardAst('go', ast('oneof'))).toThrow(/go backend rejects AST node type "oneof"/);
    conservationLog.length = 0;
    guardAst('protobuf', ast('oneof'));
    expect(conservationLog).toContain('protobuf:emit:oneof');
  });

  it('skips an IR speck that did not record its member types', () => {
    expect(() => guardIr('go', { specks: [{}] } as IR)).not.toThrow();
    expect(() => guardIr('go', { specks: [{ sourceMemberTypes: ['oneof'] }] } as IR)).toThrow(/rejects AST node type "oneof"/);
  });

  it('compileSpec still emits a state machine for an ordinary speck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cons-'));
    const file = join(dir, 's.speckdl');
    writeFileSync(file, 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := n + 1 }\n}\n');
    compileSpec(file, { outputDir: join(dir, 'out'), target: 'typescript', bomFormat: 'cdx', verifyDepth: 2 });
    expect(conservationLog).toContain('typescript:emit:state');
    expect(conservationLog).toContain('typescript:emit:action');
  });
});
