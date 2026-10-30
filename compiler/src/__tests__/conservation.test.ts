import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { AST, MemberNode } from '../parser.js';
import { lower } from '../ir/lower.js';
import {
  BACKENDS, COVERAGE, MEMBER_NODE_TYPES, conservationLog, memberNodeTypesMatchUnion,
  type BackendId, type MemberNodeType,
} from '../conservation.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';
import { generateZ3 } from '../generators/z3.js';
import { generateZ3FromIR } from '../generators/z3-from-ir.js';
import { generateRust } from '../generators/rust.js';
import { generateGo } from '../generators/go.js';
import { generateElm } from '../generators/elm.js';
import { generateProtobuf } from '../generators/protobuf.js';
import { generateK8sCRD } from '../generators/k8s-crd.js';
import { OpenAPITarget } from '../generators/openapi.js';
import { generateCamel } from '../generators/camel.js';
import { generateAgent } from '../generators/agent/index.js';
import { generateCycloneDX } from '../generators/cyclonedx.js';
import { generateSPDX } from '../generators/spdx.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';

function sample(type: MemberNodeType): MemberNode {
  switch (type) {
    case 'import': return { type: 'import', path: 'lib.speckdl', alias: 'lib' };
    case 'input': return { type: 'input', typeExpr: { type: 'primitive', name: 'Nat' } };
    case 'output': return { type: 'output', typeExpr: { type: 'primitive', name: 'Bool' } };
    case 'constraint': return { type: 'constraint', name: 'Pos', expr: 'n >= 0' };
    case 'verify': return { type: 'verify', name: 'Pos', temporalExpr: 'Always(Pos)' };
    case 'interface': return { type: 'interface', name: 'Color', kind: 'enum', methods: [], fields: [] };
    case 'event': return { type: 'event', name: 'Ticked', fields: [] };
    case 'oneof': return { type: 'oneof', name: 'Payload', variants: [{ fieldName: 'tick', typeName: 'Ticked' }] };
    case 'transition': return { type: 'transition', name: 'Envelope', fields: [] };
    case 'provenance': return { type: 'provenance', clauses: [] };
    case 'review': return { type: 'review', kind: 'auto' };
    case 'derives': return { type: 'derives', from: 'Base' };
    case 'satisfies': return { type: 'satisfies', requirement: 'REQ-1' };
    case 'author': return { type: 'author', name: 'Ada' };
    case 'source': return { type: 'source', kind: 'document' };
    case 'bom': return { type: 'bom' };
    case 'state': return { type: 'state', variables: [{ name: 'n', typeExpr: { type: 'primitive', name: 'Nat' } }] };
    case 'init': return { type: 'init', assignments: [{ name: 'n', expr: '0' }] };
    case 'action': return { type: 'action', name: 'Inc', params: [], statements: [{ type: 'assign', target: 'n', expr: 'n + 1' }] };
    case 'service': return { type: 'service', name: 'Svc', rpcs: [] };
    case 'lifecycle_metadata': return { type: 'lifecycle_metadata', key: 'ownerReferences', value: false };
    case 'invariant': return { type: 'invariant', name: 'Pos', expr: 'n >= 0' };
    case 'next': return { type: 'next', actions: ['Inc'] };
    case 'agent': return { type: 'agent', tools: [], awaits: [] };
    default: {
      const _never: never = type;
      throw new Error(`sample missing for ${String(_never)}`);
    }
  }
}

function astOf(type: MemberNodeType): AST {
  return { specks: [{ type: 'speck', name: 'S', members: [sample(type)] }] };
}

function run(backend: BackendId, ast: AST, out: string): void {
  const file = join(out, 'S.speckdl');
  writeFileSync(file, 'speck S {\n}\n');
  const ir = () => lower(ast, { filePath: file, resolveImports: false });
  switch (backend) {
    case 'typescript': return generateTypeScriptStateMachine(ast, out);
    case 'z3': return generateZ3(ast, out);
    case 'z3-ir': return generateZ3FromIR(ir(), { outputDir: out });
    case 'rust': return generateRust(ir(), out, ast);
    case 'go': return generateGo(ast, out);
    case 'elm': return generateElm(ast, out);
    case 'protobuf': return generateProtobuf(ast, out);
    case 'k8s': return void generateK8sCRD(ir(), { outputDir: out });
    case 'openapi': return void new OpenAPITarget().generate(ir(), { outputDir: out });
    case 'camel': return generateCamel(ir(), { outputDir: out });
    case 'agent': return generateAgent(ast, { outputDir: out, sourcePath: file });
    case 'cyclonedx': return generateCycloneDX(ast, out);
    case 'spdx': return generateSPDX(ast, out);
    case 'provenance': return generateProvenanceFromIR(ir(), out);
    default: {
      const _never: never = backend;
      throw new Error(String(_never));
    }
  }
}

describe('backend conservation', () => {
  it('lists every AST member type exactly once', () => {
    expect(memberNodeTypesMatchUnion).toBe(true);
    expect(new Set(MEMBER_NODE_TYPES).size).toBe(MEMBER_NODE_TYPES.length);
  });

  it('every backend declares emit or reject for every node type', () => {
    for (const backend of BACKENDS) {
      expect(Object.keys(COVERAGE[backend]).sort()).toEqual([...MEMBER_NODE_TYPES].sort());
      for (const type of MEMBER_NODE_TYPES) {
        expect(COVERAGE[backend][type], `${backend} ${type}`).toMatch(/^(emit|reject)$/);
      }
    }
  });

  it('a backend emits the node or rejects it by name', () => {
    for (const type of MEMBER_NODE_TYPES) {
      for (const backend of BACKENDS) {
        const out = mkdtempSync(join(tmpdir(), 'speckl-cons-'));
        conservationLog.length = 0;
        let thrown: Error | undefined;
        try {
          run(backend, astOf(type), out);
        } catch (e) {
          thrown = e as Error;
        }
        const decision = COVERAGE[backend][type];
        if (decision === 'reject') {
          expect(thrown?.message, `${backend} ${type}`).toMatch(
            new RegExp(`${backend} backend rejects AST node type "${type}"`),
          );
        } else {
          if (thrown) {
            expect(thrown.message, `${backend} ${type}`).not.toMatch(/rejects AST node type/);
          }
          expect(conservationLog, `${backend} ${type}`).toContain(`${backend}:emit:${type}`);
        }
      }
    }
  });
});
