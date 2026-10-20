// Type aliases (`type ServerId = String`).
//
// The parser keeps an alias as a TypeAliasNode member. expandTypeAliases
// returns a copy of the AST in which every type reference to an alias is
// replaced by the alias's target, so every backend sees ordinary types:
// `leaderId: ServerId` reaches the generators as `leaderId: String`. The
// alias members stay in the AST (with expanded targets) so the IR can also
// record them as named types.
import type { AST, TypeExpr, TypeAliasNode } from './parser.js';

/** The aliases one speck declares, each resolved to a non-alias type. */
export function resolveAliases(members: { type: string }[]): Map<string, TypeExpr> {
  const declared = new Map<string, TypeExpr>();
  for (const m of members) {
    if (m.type === 'type_alias') declared.set((m as TypeAliasNode).name, (m as TypeAliasNode).target);
  }
  const resolved = new Map<string, TypeExpr>();
  const cyclic = new Set<string>();
  const resolve = (name: string, seen: string[]): TypeExpr | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    const target = declared.get(name);
    if (!target || cyclic.has(name)) return undefined;
    // A cycle (type A = B, type B = A) resolves to nothing: references to
    // its members stay as written and backends see unknown types.
    if (seen.includes(name)) {
      for (const n of seen.slice(seen.indexOf(name))) cyclic.add(n);
      return undefined;
    }
    const out = substitute(target, (n) => resolve(n, [...seen, name]));
    if (cyclic.has(name)) return undefined;
    resolved.set(name, out);
    return out;
  };
  for (const name of declared.keys()) resolve(name, []);
  return resolved;
}

/** A copy of `t` with every alias reference replaced by its target. */
function substitute(t: TypeExpr, lookup: (name: string) => TypeExpr | undefined): TypeExpr {
  if (t.type === 'ident' && t.name) {
    const target = lookup(t.name);
    if (target) return t.nullable ? { ...clone(target), nullable: true } : clone(target);
    return { ...t };
  }
  const out: TypeExpr = { ...t };
  if (t.elementType) out.elementType = substitute(t.elementType, lookup);
  if (t.keyType) out.keyType = substitute(t.keyType, lookup);
  if (t.valueType) out.valueType = substitute(t.valueType, lookup);
  if (t.fields) out.fields = t.fields.map((f) => ({ ...f, type: substitute(f.type, lookup) }));
  return out;
}

function clone(t: TypeExpr): TypeExpr {
  return JSON.parse(JSON.stringify(t)) as TypeExpr;
}

const TYPE_KINDS = new Set(['primitive', 'record', 'list', 'set', 'map', 'ident']);

/** True for an object shaped like a TypeExpr (statements and members use other `type` tags). */
function isTypeExpr(v: unknown): v is TypeExpr {
  return !!v && typeof v === 'object' && TYPE_KINDS.has((v as { type?: unknown }).type as string);
}

/** Deep-copy `v`, expanding every TypeExpr found anywhere inside it. */
function expandIn(v: unknown, lookup: (name: string) => TypeExpr | undefined): unknown {
  if (Array.isArray(v)) return v.map((x) => expandIn(x, lookup));
  if (isTypeExpr(v)) return substitute(v, lookup);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = expandIn(x, lookup);
    return out;
  }
  return v;
}

/**
 * A copy of the AST with alias references expanded in every speck. Specks
 * without aliases are returned unchanged (same objects).
 */
export function expandTypeAliases(ast: AST): AST {
  return {
    ...ast,
    specks: ast.specks.map((speck) => {
      const aliases = resolveAliases(speck.members);
      if (aliases.size === 0) return speck;
      const lookup = (name: string) => aliases.get(name);
      return {
        ...speck,
        members: speck.members.map((m) => (m.type === 'type_alias'
          ? { ...m, target: aliases.get(m.name) ?? m.target }
          : expandIn(m, lookup) as typeof m)),
      };
    }),
  };
}
