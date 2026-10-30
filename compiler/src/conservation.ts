// Every AST member type is either emitted or rejected by every backend.
// A new member type that is not listed for a backend fails at load time
// and in the conservation test.

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

const COMMON_EMIT: MemberNodeType[] = [
  'import', 'input', 'output', 'constraint', 'verify', 'interface', 'event',
  'provenance', 'review', 'derives', 'satisfies', 'author', 'source', 'bom',
  'state', 'init', 'action', 'service', 'lifecycle_metadata', 'invariant', 'next', 'agent',
];

const COMMON_REJECT: MemberNodeType[] = ['oneof', 'transition'];

function row(emit: MemberNodeType[], reject: MemberNodeType[]): Record<MemberNodeType, 'emit' | 'reject'> {
  const out = {} as Record<MemberNodeType, 'emit' | 'reject'>;
  for (const t of emit) out[t] = 'emit';
  for (const t of reject) {
    if (out[t]) throw new Error(`conservation: ${t} is both emitted and rejected`);
    out[t] = 'reject';
  }
  for (const t of MEMBER_NODE_TYPES) {
    if (out[t] !== 'emit' && out[t] !== 'reject') {
      throw new Error(`conservation: AST node type "${t}" has no backend handling`);
    }
  }
  return out;
}

const common = row(COMMON_EMIT, COMMON_REJECT);
const protobuf = row(
  [...COMMON_EMIT, 'oneof', 'transition'],
  [],
);

export const COVERAGE: Record<BackendId, Record<MemberNodeType, 'emit' | 'reject'>> = {
  typescript: common,
  z3: common,
  'z3-ir': common,
  rust: common,
  go: common,
  elm: common,
  protobuf,
  k8s: common,
  openapi: common,
  camel: common,
  agent: common,
  cyclonedx: common,
  spdx: common,
  provenance: common,
};

export function disposition(backend: BackendId, type: string): 'emit' | 'reject' {
  const rowFor = COVERAGE[backend];
  const decision = rowFor[type as MemberNodeType];
  if (decision !== 'emit' && decision !== 'reject') {
    throw new Error(`${backend} backend has no handler for AST node type "${type}"`);
  }
  return decision;
}

/** Nodes the last guard call classified as emitted. Tests read this. */
export const conservationLog: string[] = [];

function note(backend: BackendId, type: string): void {
  const decision = disposition(backend, type);
  if (decision === 'reject') {
    throw new Error(`${backend} backend rejects AST node type "${type}": this backend does not emit it`);
  }
  conservationLog.push(`${backend}:emit:${type}`);
}

export function guardAst(backend: BackendId, ast: AST): void {
  for (const speck of ast.specks) {
    for (const member of speck.members) note(backend, member.type);
  }
}

export function guardIr(backend: BackendId, ir: IR): void {
  for (const speck of ir.specks) {
    for (const type of speck.sourceMemberTypes ?? []) note(backend, type);
  }
}
