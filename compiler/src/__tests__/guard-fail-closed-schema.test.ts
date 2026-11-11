// Provenance, Kubernetes, and Protobuf fail closed when member type info
// is missing or unknown. Protobuf still emits oneof.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateProtobuf } from '../generators/protobuf.js';
import { generateK8sCRD } from '../generators/k8s-crd.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';

const missing = /cannot check member types/;
const unknown = /no handler for AST node type "not-a-member"/;
const rejectOneof = /backend rejects AST node type "oneof"/;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-guard-schema-'));
}

describe('provenance, Kubernetes, and Protobuf fail closed', () => {
  it('rejects a missing list and an unknown type, and Protobuf still emits oneof', () => {
    const out = dir();
    const file = join(out, 'S.speckdl');
    const src = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := n + 1 }\n}\n';
    writeFileSync(file, src);
    const ast = parseSpeckContent(src, file);
    const ir = lower(ast, { filePath: file, resolveImports: false });
    const bare = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: undefined }] };
    const unnamed = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['not-a-member'] }] };
    const oneofIr = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['oneof'] }] };

    expect(() => generateProvenanceFromIR(bare, out)).toThrow(missing);
    expect(() => generateK8sCRD(bare, { outputDir: out })).toThrow(missing);
    expect(() => generateProvenanceFromIR(unnamed, out)).toThrow(unknown);
    expect(() => generateK8sCRD(unnamed, { outputDir: out })).toThrow(unknown);
    expect(() => generateProvenanceFromIR(oneofIr, out)).toThrow(rejectOneof);
    expect(() => generateK8sCRD(oneofIr, { outputDir: out })).toThrow(rejectOneof);

    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateProtobuf(noMembers, out)).toThrow(/members are missing on speck "S"/);
    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as MemberNode] }] } as AST;
    expect(() => generateProtobuf(odd, out)).toThrow(unknown);
    const oneofAst = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'oneof', name: 'Payload', variants: [] }] }] } as AST;
    let protobuf: Error | undefined;
    try { generateProtobuf(oneofAst, out); } catch (e) { protobuf = e as Error; }
    expect(protobuf?.message ?? '').not.toMatch(rejectOneof);

    expect(() => generateProvenanceFromIR(ir, out)).not.toThrow();
    expect(() => generateK8sCRD(ir, { outputDir: out })).not.toThrow();
    expect(() => generateProtobuf(ast, out)).not.toThrow();
  });
});