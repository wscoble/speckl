import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AST, MemberNode } from '../parser.js';
import { parseImportStatement, parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import {
  BACKENDS, COVERAGE, MEMBER_NODE_TYPES, conservationLog, guardAst, memberNodeTypesMatchUnion,
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
import { generateTypeScriptFromIR } from '../generators/typescript-from-ir.js';
import { compileSpec } from '../compile.js';

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

function run(backend: BackendId, ast: AST, out: string, source?: string): void {
  const file = join(out, 'S.speckdl');
  writeFileSync(file, source ?? 'speck S {\n}\n');
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

  it('every backend declares emit, reject, or n/a for every node type', () => {
    for (const backend of BACKENDS) {
      expect(Object.keys(COVERAGE[backend]).sort()).toEqual([...MEMBER_NODE_TYPES].sort());
      for (const type of MEMBER_NODE_TYPES) {
        const cell = COVERAGE[backend][type];
        expect(cell.disposition, `${backend} ${type}`).toMatch(/^(emit|reject|n\/a)$/);
        if (cell.disposition === 'n/a') expect(cell.reason, `${backend} ${type}`).toBeTruthy();
      }
    }
  });

  it('a backend emits the node, rejects it by name, or marks it n/a', () => {
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
        const decision = COVERAGE[backend][type].disposition;
        if (decision === 'reject') {
          expect(thrown?.message, `${backend} ${type}`).toMatch(
            new RegExp(`${backend} backend rejects AST node type "${type}"`),
          );
        } else if (decision === 'emit') {
          if (thrown) {
            expect(thrown.message, `${backend} ${type}`).not.toMatch(/rejects AST node type/);
          }
          expect(conservationLog, `${backend} ${type}`).toContain(`${backend}:emit:${type}`);
        } else if (thrown) {
          expect(thrown.message, `${backend} ${type}`).not.toMatch(/rejects AST node type/);
        }
      }
    }
  });

});

const FIXTURE = `
import "./MarkerImport.speckdl" as MarkerAlias
speck MarkerSpeck {
    input: { markerInput: Nat }
    output: { markerOutput: Bool }
    constraint MarkerConstraint: markerState >= 0
    verify Always(MarkerVerify) { depth 2 }
    interface MarkerInterface { Red, Green }
    interface MarkerKindSpec { markerSpecField: Nat }
    interface MarkerKindStatus { markerStatusField: String }
    interface MarkerKind { markerKindField: String }
    event OnlyEvent { onlyEventField: String }
    oneof MarkerOneof { markerTick: MarkerReq }
    transition MarkerTransition { payload: MarkerOneof }
    provenance {
        regulation "MarkerRegulation" :: "note"
        design_decision "MarkerDecision" :: "why"
    }
    review: hybrid
    derives from MarkerDerives
    satisfies MarkerSatisfies
    author: "MarkerAuthor" <"ada@example.com">
    source: document ref "MarkerSource"
    bom {
        compiler { name: "MarkerBom", version: "1.2.3" }
        license: "MarkerLicense"
    }
    state { markerState: Nat; onlyStateField: Nat }
    init { markerState := 4242 }
    action OnlyAction {
        markerState := markerState + 1
    }
    action MarkerAction {
        markerState := markerState + 1
    }
    service MarkerService {
        rpc MarkerRpc(MarkerReq) returns (MarkerReq);
    }
    conditions: ["MarkerCondition"]
    finalizers: ["MarkerFinalizer"]
    ownerReferences: true
    invariant MarkerInvariant { markerState >= 0 }
    next: MarkerAction
    agent {
        stages markerState {
            Idle = 0
            AwaitingReview = 1
        }
        tool markerTool -> MarkerAction effect act
    }
}
`;

const MARKERS: Record<MemberNodeType, string[]> = {
  import: ['MarkerImport'],
  input: ['markerInput'],
  output: ['markerOutput'],
  constraint: ['MarkerConstraint'],
  verify: ['MarkerVerify'],
  interface: ['MarkerInterface', 'markerSpecField'],
  event: ['OnlyEvent'],
  oneof: ['markerTick'],
  transition: ['MarkerTransition'],
  provenance: ['MarkerRegulation', 'MarkerDecision'],
  review: ['hybrid'],
  derives: ['MarkerDerives'],
  satisfies: ['MarkerSatisfies'],
  author: ['MarkerAuthor'],
  source: ['MarkerSource'],
  bom: ['MarkerBom', 'MarkerLicense'],
  state: ['onlyStateField'],
  init: ['4242'],
  action: ['OnlyAction'],
  service: ['MarkerService'],
  lifecycle_metadata: ['MarkerCondition', 'MarkerFinalizer'],
  invariant: ['MarkerInvariant'],
  next: ['Next transition'],
  agent: ['markerTool'],
};

function hasMarker(text: string, marker: string): boolean {
  if (text.includes(marker)) return true;
  if (!/[A-Z]/.test(marker) || /\s/.test(marker)) return false;
  const flat = (s: string) => s.replace(/_/g, '').toLowerCase();
  return flat(text).includes(flat(marker));
}

function readTree(dir: string): string {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name.endsWith('.speckdl')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return acc.join('\n');
}

describe('conservation markers', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => { vi.restoreAllMocks(); });

  it('compiles one fixture of every member type and finds each emit marker', () => {
    const parsed = parseSpeckContent(FIXTURE, 'MarkerSpeck.speckdl');
    for (const type of ['state', 'event', 'action'] as const) {
      const marker = MARKERS[type][0];
      for (const member of parsed.specks[0].members) {
        if (member.type === type) continue;
        expect(JSON.stringify(member), `${type} marker ${marker}`).not.toContain(marker);
      }
    }
    const present = new Set(parsed.specks[0].members.map(m => m.type));
    for (const type of MEMBER_NODE_TYPES) {
      if (type === 'import') continue;
      expect(present.has(type), type).toBe(true);
    }
    const imported = parseImportStatement('import "./MarkerImport.speckdl" as MarkerAlias');
    const full: AST = {
      specks: [{ ...parsed.specks[0], members: [imported, ...parsed.specks[0].members] }],
    };

    for (const backend of BACKENDS) {
      const rejected = MEMBER_NODE_TYPES.filter(t => COVERAGE[backend][t].disposition === 'reject');
      expect(rejected.length, backend).toBeGreaterThan(0);
      expect(() => guardAst(backend, full), backend).toThrow(/rejects AST node type/);

      const kept = full.specks[0].members.filter(m => COVERAGE[backend][m.type].disposition !== 'reject');
      const ast: AST = { specks: [{ ...full.specks[0], members: kept }] };
      const out = mkdtempSync(join(tmpdir(), 'speckl-mark-'));
      run(backend, ast, out, FIXTURE);
      const text = readTree(out);
      for (const type of MEMBER_NODE_TYPES) {
        if (COVERAGE[backend][type].disposition !== 'emit') continue;
        const markers = MARKERS[type];
        expect(markers.some(m => hasMarker(text, m)), `${backend} ${type}`).toBe(true);
      }
    }
  });

  it('compileSpec clears the conservation log so compiles do not accumulate', () => {
    conservationLog.push('stale');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-log-'));
    const file = join(dir, 'S.speckdl');
    writeFileSync(file, 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := 1 }\n}\n');
    compileSpec(file, { outputDir: join(dir, 'out'), target: 'go', bomFormat: 'both', verifyDepth: 2 });
    expect(conservationLog).not.toContain('stale');
    expect(conservationLog).toContain('go:emit:action');
  });

  it('generateTypeScriptFromIR rejects a type the typescript backend does not emit', () => {
    const ast = parseSpeckContent('speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := 1 }\n}\n', 's.speckdl');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-tsir-'));
    const file = join(dir, 's.speckdl');
    writeFileSync(file, 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := 1 }\n}\n');
    const ir = lower(ast, { filePath: file, resolveImports: false });
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    generateTypeScriptFromIR(ir, out);
    expect(readFileSync(join(out, 'S.ts'), 'utf8')).toContain('Go');
    ir.specks[0].sourceMemberTypes = ['oneof'];
    expect(() => generateTypeScriptFromIR(ir, out)).toThrow(/typescript backend rejects AST node type "oneof"/);
    delete ir.specks[0].sourceMemberTypes;
    expect(() => generateTypeScriptFromIR(ir, out)).not.toThrow();
  });
});
