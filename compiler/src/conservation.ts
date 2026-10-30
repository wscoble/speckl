// Every AST member type is emitted, rejected, or not applicable for every
// backend. `n/a` carries a reason: the backend compiles a spec that has
// the member and does not write it. A new member type that is not listed
// fails when this module loads and in the conservation test.

import type { AST, MemberNode } from './parser.js';
import type { IR } from './ir/types.js';

export const MEMBER_NODE_TYPES = [
  'import',
  'input',
  'output',
  'constraint',
  'verify',
  'interface',
  'event',
  'oneof',
  'transition',
  'provenance',
  'review',
  'derives',
  'satisfies',
  'author',
  'source',
  'bom',
  'state',
  'init',
  'action',
  'service',
  'lifecycle_metadata',
  'invariant',
  'next',
  'agent',
] as const;

export type MemberNodeType = typeof MEMBER_NODE_TYPES[number];

type _Exact =
  MemberNode['type'] extends MemberNodeType
    ? MemberNodeType extends MemberNode['type']
      ? true
      : never
    : never;
export const memberNodeTypesMatchUnion: _Exact = true;

export const BACKENDS = [
  'typescript',
  'z3',
  'z3-ir',
  'rust',
  'go',
  'elm',
  'protobuf',
  'k8s',
  'openapi',
  'camel',
  'agent',
  'cyclonedx',
  'spdx',
  'provenance',
] as const;

export type BackendId = typeof BACKENDS[number];

export type Disposition = 'emit' | 'reject' | 'n/a';

export interface CoverageCell {
  disposition: Disposition;
  /** Why the backend neither emits nor rejects this member. Set for `n/a`. */
  reason?: string;
}

const WIRE = 'oneof and transition are protobuf wire constructs; this backend does not emit them';
const IMPORT_NA = 'an import is inlined before generation; the import node is not written';

function cell(disposition: Disposition, reason?: string): CoverageCell {
  return reason ? { disposition, reason } : { disposition };
}

function row(
  emit: readonly MemberNodeType[],
  reject: Readonly<Partial<Record<MemberNodeType, string>>>,
  na: Readonly<Partial<Record<MemberNodeType, string>>>,
): Record<MemberNodeType, CoverageCell> {
  const out = {} as Record<MemberNodeType, CoverageCell>;
  for (const t of emit) out[t] = cell('emit');
  for (const t of Object.keys(reject) as MemberNodeType[]) {
    if (out[t]) throw new Error(`conservation: ${t} is listed twice`);
    out[t] = cell('reject', reject[t]);
  }
  for (const t of Object.keys(na) as MemberNodeType[]) {
    if (out[t]) throw new Error(`conservation: ${t} is listed twice`);
    const reason = na[t];
    if (!reason) throw new Error(`conservation: n/a ${t} needs a reason`);
    out[t] = cell('n/a', reason);
  }
  if (!out.import) out.import = cell('n/a', IMPORT_NA);
  for (const t of MEMBER_NODE_TYPES) {
    if (!out[t]) throw new Error(`conservation: AST node type "${t}" has no backend handling`);
  }
  return out;
}

const wireReject = { oneof: WIRE, transition: WIRE } as const;

export const COVERAGE: Record<BackendId, Record<MemberNodeType, CoverageCell>> = {
  typescript: row(
    ['verify', 'interface', 'event', 'state', 'init', 'action'],
    { ...wireReject },
    {
      input: 'the TypeScript machine does not declare formal-spec inputs',
      output: 'the TypeScript machine does not declare formal-spec outputs',
      constraint: 'constraint names are not rendered; a verify block is',
      provenance: 'provenance clauses are a CycloneDX, SPDX and provenance-graph concern',
      review: 'review policy is not part of the generated machine',
      derives: 'derives-from is not part of the generated machine',
      satisfies: 'satisfies is not part of the generated machine',
      author: 'author is not part of the generated machine',
      source: 'source is not part of the generated machine',
      bom: 'toolchain metadata is not part of the generated machine',
      service: 'the TypeScript machine has no RPC surface',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not part of the generated machine',
      invariant: 'invariant blocks are not rendered; a verify block is',
      next: 'the next-relation is a Z3 concern, not the TypeScript machine',
      agent: 'agent blocks are rendered by the agent target',
    },
  ),
  z3: row(
    ['input', 'output', 'constraint', 'verify', 'state', 'init', 'action', 'invariant', 'next'],
    { ...wireReject },
    {
      interface: 'the SMT file does not declare enum or record sorts for interfaces',
      event: 'events are not SMT sorts',
      provenance: 'provenance clauses are not SMT',
      review: 'review policy is not SMT',
      derives: 'derives-from is not SMT',
      satisfies: 'satisfies is not SMT',
      author: 'author is not SMT',
      source: 'source is not SMT',
      bom: 'toolchain metadata is not SMT',
      service: 'RPC services are not SMT',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not SMT',
      agent: 'agent blocks are not SMT',
    },
  ),
  'z3-ir': row(
    ['input', 'output', 'constraint', 'verify', 'interface', 'event', 'state', 'init'],
    { ...wireReject },
    {
      provenance: 'the IR SMT file does not render provenance clauses',
      review: 'review policy is not SMT',
      derives: 'derives-from is not SMT',
      satisfies: 'satisfies is not SMT',
      author: 'author is not SMT',
      source: 'source is not SMT',
      bom: 'toolchain metadata is not SMT',
      action: 'the IR SMT file checks constraints and verifies, not action steps',
      service: 'RPC services are not SMT',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not SMT',
      invariant: 'invariant blocks are not in the formal-spec facet this file renders',
      next: 'the next-relation is rendered by the AST Z3 backend',
      agent: 'agent blocks are not SMT',
    },
  ),
  rust: row(
    ['constraint', 'verify', 'interface', 'event', 'state', 'init', 'action', 'invariant'],
    { ...wireReject },
    {
      input: 'Rust does not declare formal-spec inputs',
      output: 'Rust does not declare formal-spec outputs',
      provenance: 'provenance clauses are not in the Rust crate',
      review: 'review policy is not in the Rust crate',
      derives: 'derives-from is not in the Rust crate',
      satisfies: 'satisfies is not in the Rust crate',
      author: 'author is not in the Rust crate',
      source: 'source is not in the Rust crate',
      bom: 'toolchain metadata is not in the Rust crate',
      service: 'the Rust crate has no RPC surface',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not in the Rust crate',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are rendered by the agent target',
    },
  ),
  go: row(
    ['constraint', 'interface', 'event', 'state', 'init', 'action'],
    { ...wireReject },
    {
      input: 'Go does not declare formal-spec inputs',
      output: 'Go does not declare formal-spec outputs',
      verify: 'verify blocks are not rendered; constraint checks are',
      provenance: 'provenance clauses are not in the Go package',
      review: 'review policy is not in the Go package',
      derives: 'derives-from is not in the Go package',
      satisfies: 'satisfies is not in the Go package',
      author: 'author is not in the Go package',
      source: 'source is not in the Go package',
      bom: 'toolchain metadata is not in the Go package',
      service: 'the Go package has no gRPC service',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not in the Go package',
      invariant: 'invariant blocks are not rendered; constraint checks are',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are rendered by the agent target',
    },
  ),
  elm: row(
    ['interface', 'state', 'action'],
    { ...wireReject },
    {
      input: 'the Elm client does not declare formal-spec inputs',
      output: 'the Elm client does not declare formal-spec outputs',
      constraint: 'constraint checks stay on the server',
      verify: 'verify blocks are a Z3 concern',
      event: 'events are not rendered in the Elm client',
      provenance: 'provenance clauses are not in the Elm client',
      review: 'review policy is not in the Elm client',
      derives: 'derives-from is not in the Elm client',
      satisfies: 'satisfies is not in the Elm client',
      author: 'author is not in the Elm client',
      source: 'source is not in the Elm client',
      bom: 'toolchain metadata is not in the Elm client',
      init: 'the initial value is not written into the Elm model',
      service: 'the Elm client has no RPC service',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not in the Elm client',
      invariant: 'invariant blocks are not rendered in the Elm client',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are rendered by the agent target',
    },
  ),
  protobuf: row(
    ['interface', 'event', 'oneof', 'transition', 'state', 'service'],
    {},
    {
      input: 'protobuf is a wire schema, not a formal-spec input',
      output: 'protobuf is a wire schema, not a formal-spec output',
      constraint: 'constraints are not proto messages',
      verify: 'verify blocks are not proto messages',
      provenance: 'provenance clauses are not proto messages',
      review: 'review policy is not a proto message',
      derives: 'derives-from is not a proto message',
      satisfies: 'satisfies is not a proto message',
      author: 'author is not a proto message',
      source: 'source is not a proto message',
      bom: 'toolchain metadata is not a proto message',
      init: 'initial values are not a wire schema',
      action: 'actions are behavior, not proto messages',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not proto messages',
      invariant: 'invariant blocks are not proto messages',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not proto messages',
    },
  ),
  k8s: row(
    ['interface', 'provenance'],
    { ...wireReject },
    {
      input: 'a CRD schema does not declare formal-spec inputs',
      output: 'a CRD schema does not declare formal-spec outputs',
      constraint: 'constraints are not CRD fields',
      verify: 'verify blocks are not CRD fields',
      event: 'events are not CRD resources',
      review: 'review policy is not a CRD field',
      derives: 'derives-from is not a CRD field',
      satisfies: 'satisfies is not a CRD field',
      author: 'author is not a CRD field',
      source: 'source is not a CRD field',
      bom: 'toolchain metadata is not a CRD field',
      state: 'state variables are not the CRD spec schema',
      init: 'initial values are not a CRD schema',
      action: 'actions are behavior, not a CRD schema',
      service: 'RPC services are not CRDs',
      lifecycle_metadata: 'lifecycle members are stored on the IR and not written into the CRD',
      invariant: 'invariant blocks are not a CRD schema',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not a CRD schema',
    },
  ),
  openapi: row(
    ['interface', 'event', 'provenance', 'service'],
    { ...wireReject },
    {
      input: 'OpenAPI does not declare formal-spec inputs',
      output: 'OpenAPI does not declare formal-spec outputs',
      constraint: 'constraints are not OpenAPI schemas',
      verify: 'verify blocks are not OpenAPI operations',
      review: 'review policy is not an OpenAPI field',
      derives: 'derives-from is not an OpenAPI field',
      satisfies: 'satisfies is not an OpenAPI field',
      author: 'author is not an OpenAPI field',
      source: 'source is not an OpenAPI field',
      bom: 'toolchain metadata is not an OpenAPI field',
      state: 'state variables are not OpenAPI schemas',
      init: 'initial values are not OpenAPI schemas',
      action: 'actions are not OpenAPI operations; services are',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not OpenAPI schemas',
      invariant: 'invariant blocks are not OpenAPI schemas',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not OpenAPI operations',
    },
  ),
  camel: row(
    ['interface', 'event', 'state', 'init', 'action'],
    { ...wireReject },
    {
      input: 'Camel routes do not declare formal-spec inputs',
      output: 'Camel routes do not declare formal-spec outputs',
      constraint: 'constraints are not Java route processors',
      verify: 'verify blocks are not Java route processors',
      provenance: 'provenance clauses are not Java types',
      review: 'review policy is not a Java type',
      derives: 'derives-from is not a Java type',
      satisfies: 'satisfies is not a Java type',
      author: 'author is not a Java type',
      source: 'source is not a Java type',
      bom: 'toolchain metadata is not a Java type',
      service: 'RPC services are not Camel routes; actions are',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not Java types',
      invariant: 'invariant blocks are not Java route processors',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are rendered by the agent target',
    },
  ),
  agent: row(
    ['verify', 'interface', 'event', 'state', 'init', 'action', 'agent'],
    { ...wireReject },
    {
      input: 'agent rails do not declare formal-spec inputs',
      output: 'agent rails do not declare formal-spec outputs',
      constraint: 'constraints are not agent rails',
      provenance: 'provenance clauses are not agent rails',
      review: 'review policy is not an agent rail',
      derives: 'derives-from is not an agent rail',
      satisfies: 'satisfies is not an agent rail',
      author: 'author is not an agent rail',
      source: 'source is not an agent rail',
      bom: 'toolchain metadata is not an agent rail',
      service: 'RPC services are not agent tools',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not agent rails',
      invariant: 'invariant blocks are not rendered; a verify block is',
      next: 'the next-relation is a Z3 concern',
    },
  ),
  cyclonedx: row(
    ['review', 'derives', 'satisfies', 'author', 'bom'],
    { ...wireReject },
    {
      input: 'a CycloneDX BOM does not list formal-spec inputs',
      output: 'a CycloneDX BOM does not list formal-spec outputs',
      constraint: 'constraints are not BOM components',
      verify: 'verify blocks are not BOM components',
      interface: 'types are not BOM components',
      event: 'events are not BOM components',
      provenance: 'a regulation clause is recorded only as a tag, not by its name',
      source: 'a source clause is recorded only as a tag, not by its ref',
      state: 'state variables are not BOM components',
      init: 'initial values are not BOM components',
      action: 'actions are not BOM components',
      service: 'RPC services are not BOM components',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not BOM components',
      invariant: 'invariant blocks are not BOM components',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not BOM components',
    },
  ),
  spdx: row(
    ['provenance', 'review', 'derives', 'satisfies', 'author', 'source', 'bom'],
    { ...wireReject },
    {
      input: 'an SPDX document does not list formal-spec inputs',
      output: 'an SPDX document does not list formal-spec outputs',
      constraint: 'constraints are not SPDX elements',
      verify: 'verify blocks are not SPDX elements',
      interface: 'types are not SPDX elements',
      event: 'events are not SPDX elements',
      state: 'state variables are not SPDX elements',
      init: 'initial values are not SPDX elements',
      action: 'actions are not SPDX elements',
      service: 'RPC services are not SPDX elements',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not SPDX elements',
      invariant: 'invariant blocks are not SPDX elements',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not SPDX elements',
    },
  ),
  provenance: row(
    ['constraint', 'verify', 'interface', 'event', 'provenance', 'review', 'satisfies', 'author', 'source', 'bom'],
    { ...wireReject },
    {
      input: 'the PROV-O graph does not list formal-spec inputs',
      output: 'the PROV-O graph does not list formal-spec outputs',
      derives: 'the PROV-O graph does not record the derives-from link',
      state: 'state variables are not PROV-O entities',
      init: 'initial values are not PROV-O entities',
      action: 'actions are not PROV-O entities',
      service: 'RPC services are not PROV-O entities',
      lifecycle_metadata: 'Kubernetes lifecycle fields are not PROV-O entities',
      invariant: 'invariant blocks are not PROV-O entities; verify blocks are',
      next: 'the next-relation is a Z3 concern',
      agent: 'agent blocks are not PROV-O entities',
    },
  ),
};

export function coverageCell(backend: BackendId, type: string): CoverageCell {
  const found = COVERAGE[backend][type as MemberNodeType];
  if (!found || (found.disposition !== 'emit' && found.disposition !== 'reject' && found.disposition !== 'n/a')) {
    throw new Error(`${backend} backend has no handler for AST node type "${type}"`);
  }
  if (found.disposition === 'n/a' && !found.reason) {
    throw new Error(`${backend} backend marks "${type}" n/a without a reason`);
  }
  return found;
}

export function disposition(backend: BackendId, type: string): Disposition {
  return coverageCell(backend, type).disposition;
}

/**
 * Nodes classified as emitted since the log was last cleared.
 * `compileSpec` clears it at the start of each compile so a long-lived
 * process does not accumulate one entry per file. Generators append, which
 * keeps a generator that calls another generator (the agent target calls
 * the TypeScript machine) from wiping the caller's entries.
 */
export const conservationLog: string[] = [];

function note(backend: BackendId, type: string): void {
  const decision = disposition(backend, type);
  if (decision === 'reject') {
    throw new Error(`${backend} backend rejects AST node type "${type}": this backend does not emit it`);
  }
  if (decision === 'emit') conservationLog.push(`${backend}:emit:${type}`);
}

export function guardAst(backend: BackendId, ast: AST): void {
  for (const speck of ast.specks) {
    for (const member of speck.members) note(backend, member.type);
  }
}

/**
 * Guard an IR. A speck with no `sourceMemberTypes` is skipped: hand-built
 * IR that never recorded the AST member types cannot be checked, and that
 * is the documented gap. Lowered IR always sets the field.
 */
export function guardIr(backend: BackendId, ir: IR): void {
  for (const speck of ir.specks) {
    for (const type of speck.sourceMemberTypes ?? []) note(backend, type);
  }
}
