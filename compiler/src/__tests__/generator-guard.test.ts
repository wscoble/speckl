// A direct generator call runs the conservation check. compileSpec already
// does. These calls do not go through compileSpec.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AST, MemberNode } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateCamel } from '../generators/camel.js';
import { generateAgent } from '../generators/agent/index.js';
import { generateZ3FromIR } from '../generators/z3-from-ir.js';
import { generateProtobuf } from '../generators/protobuf.js';
import { generateK8sCRD } from '../generators/k8s-crd.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';

import { generateTypeScriptFromIR } from '../generators/typescript-from-ir.js';
import { OpenAPITarget } from '../generators/openapi.js';
import { generateCycloneDX } from '../generators/cyclonedx.js';
import { generateSPDX } from '../generators/spdx.js';

const oneof: MemberNode = { type: 'oneof', name: 'Payload', variants: [{ fieldName: 'tick', typeName: 'Ticked' }] };

function ast(): AST {
  return { specks: [{ type: 'speck', name: 'S', members: [oneof] }] };
}

function irWithOneof(out: string) {
  const file = join(out, 'S.speckdl');
  writeFileSync(file, 'speck S {\n}\n');
  const ir = lower(ast(), { filePath: file, resolveImports: false });
  ir.specks[0].sourceMemberTypes = ['oneof'];
  return ir;
}

describe('direct generator calls', () => {
  it('rejects oneof from a direct call', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-guard-'));
    const reject = /backend rejects AST node type "oneof"/;

    expect(() => generateCycloneDX(ast(), out)).toThrow(reject);
    expect(() => generateSPDX(ast(), out)).toThrow(reject);
    expect(() => generateTypeScriptFromIR(irWithOneof(out), out)).toThrow(reject);
    expect(() => generateK8sCRD(irWithOneof(out), { outputDir: out })).toThrow(reject);
    expect(() => generateProvenanceFromIR(irWithOneof(out), out)).toThrow(reject);
    let protobuf: Error | undefined;
    try { generateProtobuf(ast(), out); } catch (e) { protobuf = e as Error; }
    expect(protobuf?.message ?? '').not.toMatch(reject);
    expect(() => generateZ3FromIR(irWithOneof(out), { outputDir: out })).toThrow(reject);
    expect(() => generateAgent(ast(), { outputDir: out, sourcePath: join(out, 'S.speckdl') })).toThrow(reject);
    expect(() => generateCamel(irWithOneof(out), { outputDir: out })).toThrow(reject);
    expect(() => new OpenAPITarget().generate(irWithOneof(out), { outputDir: out })).toThrow(reject);
  });
});
