// Scalar type aliases (`type ServerId = String`). The parser used to drop
// one-line `type` declarations, so every backend saw `ServerId` as an
// unknown type: protoc rejected it, OpenAPI fell back to `object`, the
// TypeScript output referenced an undeclared name. These tests pin the
// parse, the expansion and the generated output.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent, type AST, type InterfaceNode, type TypeAliasNode, type StateNode } from '../parser.js';
import { printAST } from '../printer.js';
import { expandTypeAliases, resolveAliases } from '../aliases.js';
import { lower } from '../ir/lower.js';
import { compileSpec } from '../compile.js';

const SPEC = `speck Cluster {
    type ServerId = String   // a server's address
    type Term = Nat
    type Index = Term
    type MaybeLeader = ServerId | null
    type Role = Follower | Candidate | Leader
    type Entry = { term: Term, payload: String }
    type Peers = List(ServerId)

    state {
        role: Role
        currentTerm: Term
        commitIndex: Index
        leader: MaybeLeader
        votedFor: Option(ServerId)
        peers: Peers
        log: List(Entry)
        nextIndex: Map(ServerId, Index)
    }

    action Heartbeat(from: ServerId, term: Term) {
        require term >= currentTerm
        currentTerm := term
    }
}
`;

const members = (ast: AST) => ast.specks[0].members;
const named = (ast: AST, name: string) => members(ast).find((m) => (m as { name?: string }).name === name);
const stateVar = (ast: AST, name: string) =>
  (members(ast).find((m) => m.type === 'state') as StateNode).variables.find((v) => v.name === name)!.typeExpr;

describe('type alias parsing', () => {
  const ast = parseSpeckContent(SPEC);

  it('keeps a one-line alias as a type_alias member, comment stripped', () => {
    expect(named(ast, 'ServerId')).toMatchObject({ type: 'type_alias', target: { type: 'primitive', name: 'String' } });
    expect(named(ast, 'Index')).toMatchObject({ type: 'type_alias', target: { type: 'ident', name: 'Term' } });
    expect(named(ast, 'Peers')).toMatchObject({ type: 'type_alias', target: { type: 'list', elementType: { type: 'ident', name: 'ServerId' } } });
  });

  it('reads `T | null` as a nullable alias, not an enum', () => {
    expect(named(ast, 'MaybeLeader')).toMatchObject({ type: 'type_alias', target: { type: 'ident', name: 'ServerId', nullable: true } });
  });

  it('reads `A | B | C` as an enum', () => {
    const role = named(ast, 'Role') as InterfaceNode;
    expect(role).toMatchObject({ type: 'interface', kind: 'enum' });
    expect(role.methods.map((m) => m.name)).toEqual(['Follower', 'Candidate', 'Leader']);
  });

  it('reads a one-line `{ ... }` as a record with only its own fields', () => {
    const entry = named(ast, 'Entry') as InterfaceNode;
    expect(entry).toMatchObject({ type: 'interface', kind: 'record', startLine: 7, endLine: 7 });
    expect(entry.fields.map((f) => f.name)).toEqual(['term', 'payload']);
    // The state block after it is still its own member.
    expect(members(ast).some((m) => m.type === 'state')).toBe(true);
  });

  it('reads Option(T) as a nullable T', () => {
    expect(stateVar(ast, 'votedFor')).toEqual({ type: 'ident', name: 'ServerId', nullable: true });
  });

  it('prints aliases back as `type X = T`', () => {
    const printed = printAST(ast);
    expect(printed).toContain('type ServerId = String');
    expect(printed).toContain('type MaybeLeader = ServerId | null');
    expect(printed).toContain('type Peers = List(ServerId)');
    const again = parseSpeckContent(printed);
    expect(named(again, 'ServerId')).toMatchObject({ type: 'type_alias', target: { type: 'primitive', name: 'String' } });
  });
});

describe('expandTypeAliases', () => {
  const ast = expandTypeAliases(parseSpeckContent(SPEC));

  it('replaces every alias reference with its resolved target', () => {
    expect(stateVar(ast, 'currentTerm')).toEqual({ type: 'primitive', name: 'Nat' });
    expect(stateVar(ast, 'commitIndex')).toEqual({ type: 'primitive', name: 'Nat' }); // Index -> Term -> Nat
    expect(stateVar(ast, 'peers')).toEqual({ type: 'list', elementType: { type: 'primitive', name: 'String' } });
    expect(stateVar(ast, 'nextIndex')).toEqual({
      type: 'map', keyType: { type: 'primitive', name: 'String' }, valueType: { type: 'primitive', name: 'Nat' },
    });
    // Enums and records are not aliases and stay named.
    expect(stateVar(ast, 'role')).toEqual({ type: 'ident', name: 'Role' });
    expect(stateVar(ast, 'log')).toEqual({ type: 'list', elementType: { type: 'ident', name: 'Entry' } });
  });

  it('carries nullability from the reference or the alias', () => {
    expect(stateVar(ast, 'leader')).toEqual({ type: 'primitive', name: 'String', nullable: true });
    expect(stateVar(ast, 'votedFor')).toEqual({ type: 'primitive', name: 'String', nullable: true });
  });

  it('expands record fields and action parameters', () => {
    const entry = named(ast, 'Entry') as InterfaceNode;
    expect(entry.fields[0].type).toEqual({ type: 'primitive', name: 'Nat' });
    const hb = named(ast, 'Heartbeat') as { params: { name: string; type: unknown }[] };
    expect(hb.params.map((p) => p.type)).toEqual([{ type: 'primitive', name: 'String' }, { type: 'primitive', name: 'Nat' }]);
  });

  it('stores each alias with its resolved target', () => {
    expect((named(ast, 'Index') as TypeAliasNode).target).toEqual({ type: 'primitive', name: 'Nat' });
  });

  it('does not touch the input AST', () => {
    const src = parseSpeckContent(SPEC);
    const before = JSON.stringify(src);
    expandTypeAliases(src);
    expect(JSON.stringify(src)).toBe(before);
  });

  it('returns a speck without aliases unchanged', () => {
    const src = parseSpeckContent('speck A {\n  state {\n    x: Nat\n  }\n}\n');
    expect(expandTypeAliases(src).specks[0]).toBe(src.specks[0]);
  });

  it('leaves a cycle unresolved instead of looping', () => {
    const src = parseSpeckContent('speck A {\n  type X = Y\n  type Y = X\n  state {\n    v: X\n  }\n}\n');
    expect(resolveAliases(src.specks[0].members).size).toBe(0);
    expect(stateVar(expandTypeAliases(src), 'v')).toEqual({ type: 'ident', name: 'X' });
  });
});

describe('aliases in the IR', () => {
  it('records each alias as a named type and resolves references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-alias-ir-'));
    const file = join(dir, 'Cluster.speckdl');
    writeFileSync(file, SPEC);
    const ir = lower(parseSpeckContent(SPEC), { filePath: file, resolveImports: false });
    const types = ir.specks[0].facets.typed_schema.types;
    expect(types.get('ServerId')).toEqual({ kind: 'alias', name: 'ServerId', target: expect.objectContaining({ kind: 'primitive' }) });
    expect(types.get('Role')).toMatchObject({ kind: 'enum', variants: ['Follower', 'Candidate', 'Leader'] });
    const entry = types.get('Entry');
    expect(entry?.kind).toBe('record');
    if (entry?.kind === 'record') expect(entry.fields[0].type.kind).toBe('primitive');
  });
});

describe('generated output uses the alias targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-alias-'));
  const spec = join(dir, 'Cluster.speckdl');
  writeFileSync(spec, SPEC);
  const out = join(dir, 'out');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  compileSpec(spec, { outputDir: out, target: 'all', bomFormat: 'cdx', verifyDepth: 3 });
  vi.restoreAllMocks();
  const read = (...p: string[]) => readFileSync(join(out, ...p), 'utf-8');

  it('protobuf: alias fields get scalar types', () => {
    const proto = read(readdirSync(out).find((f) => f.endsWith('.proto'))!);
    expect(proto).toMatch(/uint64 current_term = \d+;/);
    expect(proto).toMatch(/repeated string peers = \d+;/);
    expect(proto).toMatch(/map<string, uint64> next_index = \d+;/);
    expect(proto).not.toMatch(/\b(ServerId|Term|Index|Peers|MaybeLeader)\b/);
  });

  it('typescript: no alias name is left undeclared', () => {
    const ts = read('Cluster.ts');
    expect(ts).toMatch(/currentTerm!?: number;/);
    expect(ts).not.toMatch(/:\s*(ServerId|Term|Index|Peers|MaybeLeader)\b/);
  });

  it('openapi: aliases become components; fields get the target schema', () => {
    const doc = JSON.parse(read('openapi', 'cluster.openapi.json'));
    const schemas = doc.components.schemas;
    expect(schemas.ServerId).toEqual({ type: 'string' });
    expect(schemas.Term).toEqual({ type: 'integer', format: 'int64' });
    expect(schemas.Entry.properties.term).toEqual({ type: 'integer', format: 'int64' });
  });

  it('z3: no uninterpreted sort is declared for an alias', () => {
    const smt = read('Cluster.smt2');
    expect(smt).not.toMatch(/declare-sort (ServerId|Term|Index|Peers)\b/);
  });
});
