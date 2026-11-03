// effect.ts — Effect (effect 3.x) target.
//
// Emits one module per speck: <outputDir>/<Speck>/src/index.ts plus
// package.json and tsconfig.json. The module is meant to be imported by
// other Effect programs:
//
//   - a Schema for every record, enum, alias, and inline union
//     (string unions are Schema.Literal, including the inline form the
//     TypeScript generator currently prints as an illegal type name)
//   - Schema.TaggedError classes for guards, preconditions, postconditions,
//     invariant failures, untranslated constructs, and index errors
//   - a Context.Tag (the capability) and a Layer (the adapter) over a Ref
//   - Effect-returning functions for actions (decisions) and for
//     invariants, constraints, and verify blocks (rules)
//   - a Context.Tag plus an unimplemented Layer for each `service`
//
// Generation fails closed. A type that cannot be mapped throws
// EffectTargetError — nothing is emitted for that speck. A statement or
// expression that has no Effect form does not become a guess: the action
// or rule fails with SpecklUntranslated before it changes state, and the
// original source is in the error and in a comment.
//
// `effect` is imported as a namespace the spec cannot collide with
// (`$$effect`). Spec identifiers are `\w+`, which does not include `$`.

import * as fs from 'fs';
import * as path from 'path';
import type {
  AST,
  SpeckNode,
  TypeExpr,
  InvariantMemberNode,
  InterfaceNode,
  EventNode,
  ServiceNode,
  OneofNode,
  TransitionNode,
  StateNode,
  ActionNode,
  InputNode,
  OutputNode,
} from '../parser.js';
import type {
  IR,
  IRSpeck,
  IRExpr,
  IRStmt,
  IRTypeRef,
  IRAction,
} from '../ir/types.js';
import { parseStringToIRExpr } from '../ir/lower.js';

/** Pinned to the effect 3.x line the compile tests typecheck against. */
export const EFFECT_VERSION = '3.22.4';

export class EffectTargetError extends Error {
  readonly speck: string;
  constructor(speck: string, message: string) {
    super(`speckl effect: ${speck}: ${message}`);
    this.name = 'EffectTargetError';
    this.speck = speck;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Effect-side types
// ─────────────────────────────────────────────────────────────────────

type ET =
  | { k: 'bool' }
  | { k: 'nat' }
  | { k: 'int' }
  | { k: 'real' }
  | { k: 'string' }
  | { k: 'bytes' }
  | { k: 'date' }
  | { k: 'unit' }
  | { k: 'unknown'; name: string; why: string }
  | { k: 'literal'; name?: string; values: string[] }
  | { k: 'record'; name: string }
  | { k: 'list'; elem: ET }
  | { k: 'set'; elem: ET }
  | { k: 'map'; key: ET; val: ET }
  | { k: 'nullable'; inner: ET }
  | { k: 'union'; members: ET[] }
  | { k: 'unbound'; name: string };

interface RecField {
  name: string;
  type: ET;
  optional: boolean;
}

const BOOL: ET = { k: 'bool' };
const NAT: ET = { k: 'nat' };
const INT: ET = { k: 'int' };
const REAL: ET = { k: 'real' };
const STRING: ET = { k: 'string' };

const PRIMITIVES: Record<string, ET> = {
  Bool: BOOL, Boolean: BOOL,
  Nat: NAT,
  Int: INT, Integer: INT, Long: INT,
  Real: REAL, Float: REAL, Double: REAL, Number: REAL,
  String: STRING, Str: STRING,
  Bytes: { k: 'bytes' },
  Date: { k: 'date' }, Timestamp: { k: 'date' },
  Void: { k: 'unit' },
};

const isNum = (t: ET): boolean => t.k === 'nat' || t.k === 'int' || t.k === 'real';

function sameType(a: ET, b: ET): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'literal':
      return a.values.length === (b as { values: string[] }).values.length
        && a.values.every((v, i) => v === (b as { values: string[] }).values[i]);
    case 'record':
    case 'unknown':
      return a.name === (b as { name: string }).name;
    case 'list':
    case 'set':
      return sameType(a.elem, (b as { elem: ET }).elem);
    case 'map':
      return sameType(a.key, (b as { key: ET }).key) && sameType(a.val, (b as { val: ET }).val);
    case 'nullable':
      return sameType(a.inner, (b as { inner: ET }).inner);
    case 'union':
      return a.members.length === (b as { members: ET[] }).members.length
        && a.members.every((m, i) => sameType(m, (b as { members: ET[] }).members[i]));
    default:
      return true;
  }
}

/** Names a generated binding may use. Spec identifiers cannot start with `$`. */
const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'implements', 'interface', 'let', 'package', 'private', 'protected',
  'public', 'static', 'yield', 'await', 'as', 'any', 'boolean', 'number', 'string', 'symbol',
  'unknown', 'never', 'object', 'undefined', 'bigint', 'override', 'readonly', 'unique', 'abstract',
  'declare', 'global', 'keyof', 'infer', 'is', 'satisfies', 'namespace', 'module', 'type', 'from',
  'of', 'async', 'using',
]);

/** Type names TypeScript rejects in type-alias position. */
const TS_TYPE_WORDS = new Set([
  'any', 'boolean', 'number', 'string', 'symbol', 'unknown', 'never', 'object', 'undefined', 'bigint',
  'void', 'null', 'undefined',
]);

class Ctx {
  readonly records = new Map<string, RecField[]>();
  readonly enums = new Map<string, string[]>();
  /** Variant name → literal-type names that own it. */
  readonly variants = new Map<string, string[]>();
  readonly aliases = new Map<string, string>();
  readonly aliasResolved = new Map<string, ET>();
  readonly opaque = new Map<string, string>();
  readonly events = new Set<string>();
  readonly stateVars = new Map<string, ET>();
  readonly inputFields = new Map<string, ET>();
  readonly outputFields = new Map<string, ET>();
  /** Invariant or constraint export name, for verify blocks that name one. */
  readonly rules = new Map<string, string>();
  readonly ruleNeedsOld = new Map<string, boolean>();
  readonly usedExports = new Set<string>();
  /** `==` / `:=` initializers read from this speck's source. Null when the speck has no init block. */
  sourceInits: { name: string; expr: IRExpr; raw: string }[] | null = null;
  servicePlans: { name: string; rpcs: { rpc: string; req: ET; res: ET }[] }[] = [];
  bootErr = 'never';

  constructor(readonly speck: IRSpeck, readonly ast: SpeckNode | undefined) {}

  fail(message: string): never {
    throw new EffectTargetError(this.speck.name, message);
  }

  ownVariant(owner: string, value: string): void {
    const cur = this.variants.get(value) ?? [];
    if (!cur.includes(owner)) cur.push(owner);
    this.variants.set(value, cur);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  let out = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (!out || /^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

function pascal(s: string): string {
  const cleaned = sanitize(s);
  return cleaned.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase()).replace(/_/g, '') || 'Anon';
}

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function exportIdent(base: string, used: Set<string>, asType = false): string {
  let name = sanitize(base);
  if (TS_RESERVED.has(name) || (asType && TS_TYPE_WORDS.has(name))) name = `${name}_`;
  const root = name;
  for (let i = 2; used.has(name); i++) name = `${root}_${i}`;
  used.add(name);
  return name;
}

function localIdent(base: string, used: Set<string>): string {
  let name = sanitize(base);
  if (TS_RESERVED.has(name) || name.startsWith('$$')) name = `${name.replace(/^\$+/, '') || 'local'}_`;
  if (TS_RESERVED.has(name)) name = `${name}_`;
  const root = name;
  for (let i = 2; used.has(name); i++) name = `${root}_${i}`;
  used.add(name);
  return name;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function jsDoc(s: string): string {
  return oneLine(s).replace(/\*\//g, '* /');
}

// ─────────────────────────────────────────────────────────────────────
// Type parsing (AST + source aliases the parser drops)
// ─────────────────────────────────────────────────────────────────────

type ScanIssue = 'unclosed-string' | 'unclosed-comment' | 'nested-comment';

/**
 * One walk for strings, `//` comments, and block comments. Code indexes skip
 * all three, so a `}` inside `"a}b"` or a comment cannot close a block.
 * Comments are blanked to spaces (newlines kept) without touching strings,
 * which is what used to happen in a separate regex before this walk.
 * A nested `/*` is reported rather than closed at the first star-slash:
 * the main tokenizer does not nest, and guessing would drop the rest of init.
 */
function scanSource(src: string): { indexes: number[]; blanked: string; issue: ScanIssue | null } {
  const indexes: number[] = [];
  const chars = [...src];
  let quote: '"' | "'" | null = null;
  let mode: 'code' | 'line' | 'block' = 'code';
  let issue: ScanIssue | null = null;
  const blankAt = (i: number) => { if (chars[i] !== '\n') chars[i] = ' '; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else blankAt(i);
      continue;
    }
    if (mode === 'block') {
      if (c === '/' && n === '*' && !issue) issue = 'nested-comment';
      if (c === '*' && n === '/') {
        blankAt(i);
        blankAt(i + 1);
        mode = 'code';
        i++;
        continue;
      }
      blankAt(i);
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      blankAt(i);
      blankAt(i + 1);
      mode = 'line';
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      blankAt(i);
      blankAt(i + 1);
      mode = 'block';
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    indexes.push(i);
  }
  if (!issue && quote) issue = 'unclosed-string';
  if (!issue && mode === 'block') issue = 'unclosed-comment';
  return { indexes, blanked: chars.join(''), issue };
}

function codeIndexes(src: string): number[] | null {
  const scanned = scanSource(src);
  if (scanned.issue) return null;
  return scanned.indexes;
}

function scanIssueMessage(issue: ScanIssue): string {
  if (issue === 'nested-comment') return 'a block comment contains a nested /*; refusing to guess where the comment ends';
  if (issue === 'unclosed-string') return 'a string literal is not closed';
  return 'a block comment is not closed';
}

function splitTop(src: string, sep: string): string[] | null {
  const idxs = codeIndexes(src);
  if (!idxs) return null;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let brace = 0;
  let bracket = 0;
  for (const i of idxs) {
    const c = src[i];
    if (c === '(' || c === '<') depth++;
    else if (c === ')' || c === '>') depth--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (depth === 0 && brace === 0 && bracket === 0 && src.startsWith(sep, i)) {
      parts.push(src.slice(start, i).trim());
      start = i + sep.length;
    }
  }
  if (depth !== 0 || brace !== 0 || bracket !== 0) return null;
  parts.push(src.slice(start).trim());
  return parts;
}

function unquote(src: string): string | null {
  const m = src.match(/^"((?:[^"\\]|\\.)*)"$/) ?? src.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (!m) return null;
  try {
    return JSON.parse(src.startsWith("'") ? `"${m[1].replace(/"/g, '\\"')}"` : src);
  } catch {
    return m[1];
  }
}

function speckText(speck: IRSpeck, ast: SpeckNode | undefined): string {
  let text = '';
  try {
    text = fs.readFileSync(speck.sourcePath, 'utf-8');
  } catch {
    return '';
  }
  if (ast?.startLine && ast.endLine) {
    text = text.split('\n').slice(ast.startLine - 1, ast.endLine).join('\n');
  }
  const scanned = scanSource(text);
  if (scanned.issue) {
    throw new EffectTargetError(speck.name, `cannot read source: ${scanIssueMessage(scanned.issue)}`);
  }
  return scanned.blanked;
}

/** Body of the first `state` or `init` block in this speck's source. */
function extractBlock(source: string, keyword: 'state' | 'init'): string | null {
  const idxs = codeIndexes(source);
  if (!idxs) return null;
  const code = new Set(idxs);
  const re = new RegExp(`(?:^|\\n)([ \\t]*)${keyword}\\s*(?::\\s*)?\\{`, 'g');
  let open = -1;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const kw = m.index + (source[m.index] === '\n' ? 1 : 0) + m[1].length;
    const braceAt = m.index + m[0].length - 1;
    if (code.has(kw) && code.has(braceAt)) { open = braceAt + 1; break; }
  }
  if (open < 0) return null;
  let depth = 1;
  for (const i of idxs) {
    if (i < open) continue;
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i);
    }
  }
  return null;
}

function stripInitializer(src: string): string {
  const idxs = codeIndexes(src);
  if (!idxs) return src.trim().replace(/,\s*$/, '');
  let depth = 0;
  let brace = 0;
  let bracket = 0;
  for (const i of idxs) {
    const c = src[i];
    if (c === '(' || c === '<') depth++;
    else if (c === ')' || c === '>') depth--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (depth === 0 && brace === 0 && bracket === 0 && (src.startsWith(':=', i) || src.startsWith('==', i))) {
      return src.slice(0, i).trim().replace(/,\s*$/, '');
    }
  }
  return src.trim().replace(/,\s*$/, '');
}

/** `name: Type` declarations, keeping commas that sit inside `Map(K, V)`. */
function readFieldTypes(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  let type = '';
  const flush = () => {
    if (name && type.trim()) out.set(name, stripInitializer(type));
  };
  for (const chunk of fieldChunks(body)) {
    const piece = chunk.trim();
    if (!piece || piece === '{' || piece === '}') continue;
    const m = piece.match(/^(\w+)\s*:\s*([\s\S]*)$/);
    if (m && (!name || balancedType(type))) {
      flush();
      name = m[1];
      type = m[2];
    } else if (name) {
      type += `\n${piece}`;
    }
  }
  flush();
  return out;
}

/** Init statements. `name == expr` is an initializer here, same as `name := expr`. */
function readInitAssignments(body: string): { name: string; expr: string; raw: string }[] {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && l !== '{' && l !== '}');
  const stmts: string[] = [];
  let cur: string | null = null;
  for (const line of lines) {
    if (/^\w+\s*(?::=|==)/.test(line) || cur === null) {
      if (cur) stmts.push(cur);
      cur = line;
    } else {
      cur += ` ${line}`;
    }
  }
  if (cur) stmts.push(cur);
  const out: { name: string; expr: string; raw: string }[] = [];
  for (const stmt of stmts) {
    const m = stmt.match(/^(\w+)\s*(?::=|==)\s*([\s\S]+)$/);
    if (!m) continue;
    const expr = m[2].replace(/,\s*$/, '').trim();
    out.push({ name: m[1], expr, raw: `${m[1]} ${stmt.includes(':=') ? ':=' : '=='} ${expr}` });
  }
  return out;
}

function stripCodeComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function balancedType(src: string): boolean {
  return splitTop(src, '\u0000') !== null;
}

/**
 * `type Name = ...` aliases. The parser drops a single-line record alias's
 * closing brace and then swallows the next members, so a record can arrive
 * as an enum. The source line is the authority for these aliases.
 */
function readSourceTypes(source: string): { aliases: Map<string, string>; records: Map<string, string> } {
  const aliases = new Map<string, string>();
  const records = new Map<string, string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let buf = stripCodeComment(lines[i]).trim();
    if (!/^type\s+\w+\s*=/.test(buf)) continue;
    while (!balancedType(buf) && i + 1 < lines.length) {
      i++;
      const more = stripCodeComment(lines[i]).trim();
      if (!more) continue;
      buf = `${buf}\n${more}`;
    }
    const m = buf.match(/^type\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (!m) continue;
    const rhs = m[2].trim().replace(/,\s*$/, '');
    if (rhs.startsWith('{') && rhs.endsWith('}') && balancedType(rhs)) records.set(m[1], rhs.slice(1, -1).trim());
    else if (!rhs.includes('{')) aliases.set(m[1], rhs);
  }
  return { aliases, records };
}

/**
 * A type expression this target cannot parse. That is a generator failure,
 * not a value. A bare name the spec never declares is different: see
 * `opaqueType`.
 */
function unresolved(ctx: Ctx, why: string): never {
  ctx.fail(`cannot map ${why}`);
}

function resolveTypeExpr(ctx: Ctx, t: TypeExpr | undefined, hint: string, seen: Set<string> = new Set()): ET {
  if (!t) ctx.fail(`missing type where ${hint} was expected`);
  const wrap = (inner: ET): ET => (t.nullable ? { k: 'nullable', inner } : inner);
  switch (t.type) {
    case 'primitive': {
      const p = PRIMITIVES[t.name ?? ''];
      if (!p) ctx.fail(`cannot map primitive ${(t.name ?? '(none)')} (${hint})`);
      return wrap(p);
    }
    case 'list':
      return wrap({ k: 'list', elem: resolveTypeExpr(ctx, t.elementType, `${hint} element`, seen) });
    case 'set':
      return wrap({ k: 'set', elem: resolveTypeExpr(ctx, t.elementType, `${hint} element`, seen) });
    case 'map':
      return wrap({
        k: 'map',
        key: resolveTypeExpr(ctx, t.keyType, `${hint} key`, seen),
        val: resolveTypeExpr(ctx, t.valueType, `${hint} value`, seen),
      });
    case 'record':
      return wrap(inlineRecord(ctx, t.fields ?? [], hint, seen));
    case 'ident':
      return wrap(resolveIdent(ctx, t.name ?? '', hint, seen));
    default:
      ctx.fail(`cannot map type form ${(t as { type?: string }).type ?? 'unknown'} (${hint})`);
  }
}

function inlineRecord(ctx: Ctx, fields: { name: string; type: TypeExpr }[], hint: string, seen: Set<string>): ET {
  let name = exportIdent(pascal(hint) || 'Inline', ctx.usedExports, true);
  if (!name.endsWith('Record') && ctx.records.has(name)) name = exportIdent(`${name}Record`, ctx.usedExports, true);
  ctx.records.set(name, []);
  const resolved: RecField[] = fields.map((f) => ({
    name: f.name,
    optional: false,
    type: resolveTypeExpr(ctx, f.type, `${name}.${f.name}`, seen),
  }));
  ctx.records.set(name, resolved);
  return { k: 'record', name };
}

function resolveIdent(ctx: Ctx, raw: string, hint: string, seen: Set<string>): ET {
  const name = raw.trim();
  if (!name) ctx.fail(`empty type name (${hint})`);
  if (PRIMITIVES[name]) return PRIMITIVES[name];
  if (ctx.enums.has(name)) return { k: 'literal', name, values: ctx.enums.get(name)! };
  if (ctx.records.has(name)) return { k: 'record', name };
  if (ctx.aliasResolved.has(name)) return ctx.aliasResolved.get(name)!;
  if (ctx.aliases.has(name)) return resolveAlias(ctx, name, seen);
  if (ctx.opaque.has(name)) return { k: 'unknown', name, why: ctx.opaque.get(name)! };

  const opt = name.match(/^Option\s*[(<]\s*([\s\S]+)\s*[)>]$/);
  if (opt) return { k: 'nullable', inner: resolveIdent(ctx, opt[1], hint, seen) };
  const array = name.match(/^(\w+)\[\]$/);
  if (array) return { k: 'list', elem: resolveIdent(ctx, array[1], hint, seen) };

  if (name.includes('|') || name.startsWith('"') || name.startsWith("'") || /^(List|Set|Map|Option)\b/.test(name)) {
    return parseTypeSource(ctx, name, hint, seen);
  }
  if (/^[A-Za-z_]\w*$/.test(name)) {
    const why = `type ${name} is not declared in this spec`;
    claimTypeName(ctx, name);
    ctx.opaque.set(name, why);
    return { k: 'unknown', name, why };
  }
  return unresolved(ctx, `type \`${oneLine(name)}\` (${hint}) is not a primitive, collection, record, enum, alias, nullable, or a string or identifier union`);
}

function resolveAlias(ctx: Ctx, name: string, seen: Set<string>): ET {
  if (seen.has(name)) ctx.fail(`alias ${name} is recursive (${[...seen, name].join(' -> ')})`);
  const rhs = ctx.aliases.get(name);
  if (rhs === undefined) ctx.fail(`alias ${name} has no right-hand side`);
  const resolved = parseTypeSource(ctx, rhs, `alias ${name}`, new Set([...seen, name]));
  const t = resolved.k === 'literal' && !resolved.name ? { ...resolved, name } : resolved;
  ctx.aliasResolved.set(name, t);
  if (t.k === 'literal') {
    for (const v of t.values) ctx.ownVariant(name, v);
  }
  return t;
}

function parseTypeSource(ctx: Ctx, src: string, hint: string, seen: Set<string>): ET {
  const expr = src.trim().replace(/,\s*$/, '');
  if (!expr) return unresolved(ctx, `empty type (${hint})`);
  const arms = splitTop(expr, '|');
  if (!arms) return unresolved(ctx, `type \`${oneLine(expr)}\` (${hint}) has unbalanced brackets`);
  if (arms.length > 1) {
    if (arms.some((a) => !a)) return unresolved(ctx, `type \`${oneLine(expr)}\` (${hint}) has an empty union arm`);
    const parsed = arms.map((a) => parseTypeAtom(ctx, a, `${hint} union`, seen));
    const nonNull = parsed.filter((p): p is ET => p !== 'null');
    const nulls = parsed.length - nonNull.length;
    if (nulls > 0 && nonNull.length === 1 && nonNull[0].k !== 'unbound') return { k: 'nullable', inner: nonNull[0] };
    if (nulls > 0) return unresolved(ctx, `type \`${oneLine(expr)}\` (${hint}) mixes null with more than one arm`);
    const unbound = nonNull.filter((p): p is { k: 'unbound'; name: string } => p.k === 'unbound');
    const bound = nonNull.filter((p) => p.k !== 'unbound');
    const bareLiteral = bound.every((p) => p.k === 'literal' && p.values.length === 1 && !p.name);
    // `Follower | Candidate | Leader` and `"red" | "blue"` are string literals.
    // `String | Ntoe` is a typo: Ntoe is not a variant just because it is a word.
    if (unbound.length === 0 && bound.every((p) => p.k === 'literal' && p.values.length === 1)) {
      return { k: 'literal', values: bound.flatMap((p) => (p as { values: string[] }).values) };
    }
    if (unbound.length > 0 && (bound.length === 0 || bareLiteral)) {
      const values = [
        ...bound.flatMap((p) => (p.k === 'literal' ? p.values : [])),
        ...unbound.map((p) => p.name),
      ];
      return { k: 'literal', values };
    }
    if (unbound.length > 0) {
      ctx.fail(`union arm ${unbound.map((p) => p.name).join(', ')} is not a declared type (${hint}); refusing to treat it as a string literal`);
    }
    return { k: 'union', members: bound };
  }
  const atom = parseTypeAtom(ctx, expr, hint, seen);
  if (atom === 'null') return unresolved(ctx, `type null (${hint})`);
  return atom;
}

function parseTypeAtom(ctx: Ctx, src: string, hint: string, seen: Set<string>): ET | 'null' {
  const expr = src.trim();
  if (expr === 'null') return 'null';
  const quoted = unquote(expr);
  if (quoted !== null && (expr.startsWith('"') || expr.startsWith("'"))) return { k: 'literal', values: [quoted] };
  if (PRIMITIVES[expr]) return PRIMITIVES[expr];

  const generic = expr.match(/^(List|Set|Map)\s*[(<]([\s\S]*)[)>]$/);
  if (generic) {
    const kind = generic[1];
    const inner = generic[2];
    if (kind === 'Map') {
      const parts = splitTop(inner, ',');
      if (!parts || parts.length !== 2) return unresolved(ctx, `type \`${oneLine(expr)}\` (${hint}) is a Map without a key and a value type`);
      return {
        k: 'map',
        key: parseTypeSource(ctx, parts[0], `${hint} key`, seen),
        val: parseTypeSource(ctx, parts[1], `${hint} value`, seen),
      };
    }
    const elem = parseTypeSource(ctx, inner, `${hint} element`, seen);
    return kind === 'Set' ? { k: 'set', elem } : { k: 'list', elem };
  }
  if (expr.startsWith('{') && expr.endsWith('}')) {
    const fields = parseRecordBody(ctx, expr.slice(1, -1), hint);
    return inlineRecord(ctx, fields, hint, seen);
  }
  const opt = expr.match(/^Option\s*[(<]\s*([\s\S]+)\s*[)>]$/);
  if (opt) return { k: 'nullable', inner: parseTypeSource(ctx, opt[1], hint, seen) };
  const array = expr.match(/^(\w+)\[\]$/);
  if (array) return { k: 'list', elem: resolveIdent(ctx, array[1], hint, seen) };
  if (/^[A-Za-z_]\w*$/.test(expr)) {
    if (ctx.enums.has(expr) || ctx.records.has(expr) || ctx.aliases.has(expr) || ctx.aliasResolved.has(expr) || PRIMITIVES[expr]) {
      return resolveIdent(ctx, expr, hint, seen);
    }
    // Held until the whole union is known. A word is a literal only when
    // every arm is a word or a quoted string (`Follower | Candidate`).
    if (hint.includes(' union')) return { k: 'unbound', name: expr };
    return resolveIdent(ctx, expr, hint, seen);
  }
  return unresolved(ctx, `type \`${oneLine(expr)}\` (${hint})`);
}

function parseRecordBody(ctx: Ctx, body: string, hint: string): { name: string; type: TypeExpr }[] {
  const parts = splitTop(body, ',');
  if (!parts) ctx.fail(`cannot map record \`${oneLine(body)}\` (${hint}): unbalanced brackets`);
  const fields: { name: string; type: TypeExpr }[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const m = part.trim().match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (!m) ctx.fail(`cannot map record field \`${oneLine(part)}\` (${hint})`);
    fields.push({ name: m[1], type: { type: 'ident', name: m[2].trim() } });
  }
  return fields;
}

function resolveIr(ctx: Ctx, ref: IRTypeRef | undefined, hint: string): ET {
  if (!ref) ctx.fail(`missing type where ${hint} was expected`);
  const wrap = (inner: ET): ET => (ref.nullable ? { k: 'nullable', inner } : inner);
  switch (ref.kind) {
    case 'primitive': {
      const p = PRIMITIVES[ref.primitive ?? ''];
      if (!p) ctx.fail(`cannot map primitive ${ref.primitive ?? '(none)'} (${hint})`);
      return wrap(p);
    }
    case 'list':
      return wrap({ k: 'list', elem: resolveIr(ctx, ref.elementType, `${hint} element`) });
    case 'set':
      return wrap({ k: 'set', elem: resolveIr(ctx, ref.elementType, `${hint} element`) });
    case 'map':
      if (ref.fields && (!ref.keyType || !ref.valueType)) {
        return wrap(inlineRecord(ctx, ref.fields.map((f) => ({
          name: f.name,
          type: { type: 'ident', name: schemaHint(f.type) },
        })), hint, new Set()));
      }
      if (!ref.keyType || !ref.valueType) ctx.fail(`cannot map map type (${hint}): missing key or value`);
      return wrap({
        k: 'map',
        key: resolveIr(ctx, ref.keyType, `${hint} key`),
        val: resolveIr(ctx, ref.valueType, `${hint} value`),
      });
    case 'ident':
      return wrap(resolveIdent(ctx, ref.name ?? '', hint, new Set()));
    default:
      ctx.fail(`cannot map IR type kind ${(ref as { kind?: string }).kind ?? 'unknown'} (${hint})`);
  }
}

/** A placeholder ident the IR-only path can re-parse. Prefer the AST. */
function schemaHint(ref: IRTypeRef): string {
  if (ref.kind === 'primitive') return ref.primitive ?? 'Unknown';
  if (ref.kind === 'ident') return ref.name ?? 'Unknown';
  return 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────
// Schema text
// ─────────────────────────────────────────────────────────────────────

function schemaExpr(t: ET): string {
  switch (t.k) {
    case 'bool': return '$$effect.Schema.Boolean';
    case 'nat': return '$$specklNat';
    case 'int': return '$$specklInt';
    case 'real': return '$$specklReal';
    case 'string': return '$$effect.Schema.String';
    case 'bytes': return '$$effect.Schema.Uint8ArrayFromSelf';
    case 'date': return '$$effect.Schema.DateFromSelf';
    case 'unit': return '$$effect.Schema.Void';
    case 'unknown': return t.name;
    case 'literal':
      if (t.values.length === 0) return '$$effect.Schema.Never';
      return `$$effect.Schema.Literal(${t.values.map((v) => JSON.stringify(v)).join(', ')})`;
    case 'record':
      return `$$effect.Schema.suspend(() => ${t.name})`;
    case 'list':
      return `$$effect.Schema.Array(${schemaExpr(t.elem)})`;
    case 'set':
      return `$$effect.Schema.HashSetFromSelf(${schemaExpr(t.elem)})`;
    case 'map':
      return `$$effect.Schema.HashMapFromSelf({ key: ${schemaExpr(t.key)}, value: ${schemaExpr(t.val)} })`;
    case 'nullable':
      return `$$effect.Schema.NullOr(${schemaExpr(t.inner)})`;
    case 'union':
      if (t.members.length === 0) return '$$effect.Schema.Never';
      if (t.members.length === 1) return schemaExpr(t.members[0]);
      return `$$effect.Schema.Union(${t.members.map(schemaExpr).join(', ')})`;
    case 'unbound':
      return ctxFailSchema(t.name);
  }
}

function ctxFailSchema(name: string): string {
  throw new Error(`speckl effect: unbound type ${name} reached schema emission`);
}

function tsType(t: ET): string {
  switch (t.k) {
    case 'bool': return 'boolean';
    case 'nat':
    case 'int':
    case 'real': return 'number';
    case 'string': return 'string';
    case 'bytes': return 'Uint8Array';
    case 'date': return 'Date';
    case 'unit': return 'void';
    case 'unknown': return 'unknown';
    case 'literal':
      if (t.values.length === 0) return 'never';
      return t.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'record': return t.name;
    case 'list': return `ReadonlyArray<${tsType(t.elem)}>`;
    case 'set': return `$$effect.HashSet.HashSet<${tsType(t.elem)}>`;
    case 'map': return `$$effect.HashMap.HashMap<${tsType(t.key)}, ${tsType(t.val)}>`;
    case 'nullable': return `${tsType(t.inner)} | null`;
    case 'union':
      if (t.members.length === 0) return 'never';
      return t.members.map(tsType).join(' | ');
    case 'unbound':
      return 'never';
  }
}

/** Schema expression that names a declared const instead of re-inlining it. */
function schemaRef(ctx: Ctx, t: ET): string {
  if (t.k === 'literal' && t.name && ctx.enums.has(t.name)) return t.name;
  if (t.k === 'literal' && t.name && ctx.aliasResolved.has(t.name)) return t.name;
  if (t.k === 'record') return `$$effect.Schema.suspend(() => ${t.name})`;
  if (t.k === 'unknown') return t.name;
  if (t.k === 'nullable') return `$$effect.Schema.NullOr(${schemaRef(ctx, t.inner)})`;
  if (t.k === 'list') return `$$effect.Schema.Array(${schemaRef(ctx, t.elem)})`;
  if (t.k === 'set') return `$$effect.Schema.HashSetFromSelf(${schemaRef(ctx, t.elem)})`;
  if (t.k === 'map') return `$$effect.Schema.HashMapFromSelf({ key: ${schemaRef(ctx, t.key)}, value: ${schemaRef(ctx, t.val)} })`;
  if (t.k === 'union') return `$$effect.Schema.Union(${t.members.map((m) => schemaRef(ctx, m)).join(', ')})`;
  return schemaExpr(t);
}

function fieldSchema(ctx: Ctx, f: RecField): string {
  const inner = schemaRef(ctx, f.type);
  return f.optional ? `$$effect.Schema.optional(${inner})` : inner;
}

function defaultValue(ctx: Ctx, t: ET, seen: Set<string> = new Set()): string {
  switch (t.k) {
    case 'bool': return 'false';
    case 'nat':
    case 'int':
    case 'real': return '0';
    case 'string': return '""';
    case 'bytes': return 'new Uint8Array()';
    case 'date': return 'new Date(0)';
    case 'unit': return 'undefined';
    case 'unknown': return 'undefined';
    case 'literal':
      if (t.values.length === 0) ctx.fail(`enum ${t.name ?? '(anonymous)'} has no variants, so it has no initial value`);
      return JSON.stringify(t.values[0]);
    case 'list': return `[] as ReadonlyArray<${tsType(t.elem)}>`;
    case 'set': return `$$effect.HashSet.empty<${tsType(t.elem)}>()`;
    case 'map': return `$$effect.HashMap.empty<${tsType(t.key)}, ${tsType(t.val)}>()`;
    case 'nullable': return 'null';
    case 'union': return defaultValue(ctx, t.members[0], seen);
    case 'unbound':
      ctx.fail(`cannot map unbound type ${t.name}`);
      break;
    case 'record': {
      if (seen.has(t.name)) ctx.fail(`cannot build a default ${t.name}: the record contains itself and init does not set it`);
      const fields = ctx.records.get(t.name) ?? [];
      const next = new Set([...seen, t.name]);
      const body = fields
        .filter((f) => !f.optional)
        .map((f) => `${propKey(f.name)}: ${defaultValue(ctx, f.type, next)}`)
        .join(', ');
      return `{ ${body} }`;
    }
  }
}

function propKey(name: string): string {
  // `{ __proto__: v }` sets the prototype. A computed key stores an own property.
  if (name === '__proto__') return '["__proto__"]';
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return JSON.stringify(name);
  return name;
}

function propRead(base: string, name: string): string {
  if (name === '__proto__' || !/^[A-Za-z_$][\w$]*$/.test(name)) return `${base}[${JSON.stringify(name)}]`;
  return `${base}.${name}`;
}

// ─────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────

interface TExpr { code: string; t: ET }

class Env {
  readonly locals = new Map<string, { js: string; t: ET }>();
  readonly failures: string[] = [];
  useOld = false;
  readingOld = false;
  /** Rule bodies may read input and output fields. Actions may not. */
  readonly rules: boolean;
  /** `old()` is a previous-state read. Rules that use it take that value as a parameter. */
  allowOld = false;
  /** Set while a formula is being read, so a failed atom does not parse itself again. */
  readingFormula = false;
  slot = 0;

  constructor(readonly ctx: Ctx, rules = false) {
    this.rules = rules;
  }

  fresh(prefix: string): string {
    const name = `$$${prefix}${this.slot++}`;
    return name;
  }

  declare(specName: string, t: ET): string {
    const js = localIdent(specName, new Set([...this.locals.values()].map((l) => l.js)));
    this.locals.set(specName, { js, t });
    return js;
  }
}

function lookup(name: string, env: Env): TExpr | null {
  const local = env.locals.get(name);
  if (local) return { code: local.js, t: local.t };
  const state = env.ctx.stateVars.get(name);
  if (state) return { code: propRead(env.readingOld ? '$$specklOld' : '$$state', name), t: state };
  if (env.rules) {
    const input = env.ctx.inputFields.get(name);
    const output = env.ctx.outputFields.get(name);
    if (input && output) return null;
    if (input) return { code: propRead('$$input', name), t: input };
    if (output) return { code: propRead('$$output', name), t: output };
  }
  return null;
}

/**
 * `{0: 0, 1: 0}` as a HashMap. Keys are expressions, except a bare word used
 * as a string key (`{idle: 0}`). A value that is not the map's value type
 * refuses the whole literal.
 */
function translateMapLiteral(src: string, env: Env, map: Extract<ET, { k: 'map' }>): TExpr | null {
  const body = src.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  const inner = body.slice(1, -1).trim();
  if (!inner) return { code: `$$effect.HashMap.empty<${tsType(map.key)}, ${tsType(map.val)}>()`, t: map };
  if (!inner.includes(':')) return null;
  const parts = splitTop(inner, ',');
  if (!parts) return null;
  const entries: string[] = [];
  for (const part of parts) {
    const colon = topLevelColon(part);
    if (colon < 0) return null;
    const keySrc = part.slice(0, colon).trim();
    const valSrc = part.slice(colon + 1).trim();
    if (!keySrc || !valSrc) return null;
    const key = translateMapKey(keySrc, env, map.key);
    const val = translate(parseStringToIRExpr(valSrc), env, map.val);
    const k = key && coerce(key, map.key);
    const v = val && coerce(val, map.val);
    if (k == null || v == null) return null;
    entries.push(`[${k}, ${v}]`);
  }
  return { code: `$$effect.HashMap.fromIterable([${entries.join(', ')}])`, t: map };
}

function translateMapKey(src: string, env: Env, keyT: ET): TExpr | null {
  if ((keyT.k === 'string' || keyT.k === 'literal') && /^[A-Za-z_]\w*$/.test(src)) {
    return { code: JSON.stringify(src), t: STRING };
  }
  return translate(parseStringToIRExpr(src), env, keyT);
}

function topLevelColon(src: string): number {
  const idxs = codeIndexes(src);
  if (!idxs) return -1;
  let depth = 0;
  for (const i of idxs) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && src[i + 1] !== '=') return i;
  }
  return -1;
}

/** `{true, false}` and `{"a", "b"}` as a HashSet. The IR has no set-literal node. */
function translateSetLiteral(src: string, env: Env, expected?: ET): TExpr | null {
  const body = src.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  const inner = body.slice(1, -1).trim();
  if (!inner) {
    if (expected?.k !== 'set') return null;
    return { code: `$$effect.HashSet.empty<${tsType(expected.elem)}>()`, t: expected };
  }
  if (splitTop(inner, ',')?.some((part) => part.includes(':') || part.includes('->'))) return null;
  const parts = splitTop(inner, ',');
  if (!parts || parts.length === 0) return null;
  const elemExpected = expected?.k === 'set' ? expected.elem : undefined;
  const elems: TExpr[] = [];
  for (const part of parts) {
    const v = translate(parseStringToIRExpr(part), env, elemExpected);
    if (!v || v.t.k === 'unit') return null;
    elems.push(v);
  }
  const elem = elems.reduce<ET>((acc, el) => (isNum(acc) && isNum(el.t) ? numJoin(acc, el.t) : acc), elems[0].t);
  if (!elems.every((el) => sameType(el.t, elem) || (isNum(el.t) && isNum(elem)))) return null;
  const codes = elems.map((el) => coerce(el, elem));
  if (codes.some((c) => c == null)) return null;
  return { code: `$$effect.HashSet.fromIterable([${codes.join(', ')}])`, t: { k: 'set', elem } };
}

type Formula =
  | { k: 'atom'; src: string }
  | { k: 'not'; inner: Formula }
  | { k: 'and' | 'or' | 'implies'; left: Formula; right: Formula }
  | { k: 'quant'; kind: 'forall' | 'exists'; name: string; domain: string; body: Formula };

function skipWsAt(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function keywordAt(src: string, i: number): string | null {
  const words = ['implies', 'forall', 'exists', 'subsetOf', 'and', 'or', 'not', 'in'];
  for (const kw of words) {
    if (!src.startsWith(kw, i)) continue;
    const before = i === 0 ? '' : src[i - 1];
    const after = src[i + kw.length] ?? '';
    if ((before === '' || !/[\w$]/.test(before)) && !/[\w$]/.test(after)) return kw;
  }
  if (src.startsWith('->', i)) return '->';
  if (src.startsWith('=>', i)) return '=>';
  if (src.startsWith('&&', i)) return '&&';
  if (src.startsWith('||', i)) return '||';
  return null;
}

function scanBalanced(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

function scanString(src: string, i: number): number {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** A comparison, membership, or arithmetic chain. `and` / `forall` stay outside it. */
function readFormulaAtom(src: string, i: number): { src: string; i: number } | null {
  const start = skipWsAt(src, i);
  const primaryEnd = (at: number): number => {
    at = skipWsAt(src, at);
    if (at >= src.length) return at;
    const c = src[at];
    if (c === '"' || c === "'") return scanString(src, at);
    if (c === '{') return scanBalanced(src, at, '{', '}');
    if (c === '[') return scanBalanced(src, at, '[', ']');
    if (c === '(') return scanBalanced(src, at, '(', ')');
    if (!/[\w$]/.test(c)) return at;
    let j = at;
    while (j < src.length && /[\w$]/.test(src[j])) j++;
    while (true) {
      if (src[j] === '.') {
        j++;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        continue;
      }
      if (src[j] === '[') { j = scanBalanced(src, j, '[', ']'); continue; }
      if (src[j] === '(') { j = scanBalanced(src, j, '(', ')'); continue; }
      break;
    }
    return j;
  };
  const infixLen = (at: number): number => {
    const j = skipWsAt(src, at);
    const words = ['subsetOf', 'notIn', 'in'];
    for (const w of words) {
      if (keywordAt(src, j) === w) return j + w.length - at;
    }
    const syms = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%'];
    for (const s of syms) {
      if (src.startsWith(s, j)) return j + s.length - at;
    }
    return 0;
  };
  let end = primaryEnd(start);
  if (end === start) return null;
  while (true) {
    const n = infixLen(end);
    if (n === 0) break;
    const afterOp = end + n;
    const next = primaryEnd(afterOp);
    if (next === skipWsAt(src, afterOp)) break;
    end = next;
  }
  const text = src.slice(start, end).trim();
  if (!text) return null;
  return { src: text, i: end };
}

function readDomain(src: string, i: number): { src: string; i: number } | null {
  const start = i;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) break;
    i++;
  }
  const text = src.slice(start, i).trim();
  if (!text || src[i] !== ':') return null;
  return { src: text, i: i + 1 };
}

function parseImpliesF(src: string, i: number): { node: Formula; i: number } | null {
  const left = parseOrF(src, i);
  if (!left) return null;
  const j = skipWsAt(src, left.i);
  const kw = keywordAt(src, j);
  if (kw !== 'implies' && kw !== '->' && kw !== '=>') return { node: left.node, i: j };
  const right = parseImpliesF(src, skipWsAt(src, j + kw.length));
  if (!right) return null;
  return { node: { k: 'implies', left: left.node, right: right.node }, i: right.i };
}

function parseOrF(src: string, i: number): { node: Formula; i: number } | null {
  let left = parseAndF(src, i);
  if (!left) return null;
  while (true) {
    const j = skipWsAt(src, left.i);
    const kw = keywordAt(src, j);
    if (kw !== 'or' && kw !== '||') return { node: left.node, i: j };
    const right = parseAndF(src, skipWsAt(src, j + kw.length));
    if (!right) return null;
    left = { node: { k: 'or', left: left.node, right: right.node }, i: right.i };
  }
}

function parseAndF(src: string, i: number): { node: Formula; i: number } | null {
  let left = parseUnaryF(src, i);
  if (!left) return null;
  while (true) {
    const j = skipWsAt(src, left.i);
    const kw = keywordAt(src, j);
    if (kw !== 'and' && kw !== '&&') return { node: left.node, i: j };
    const right = parseUnaryF(src, skipWsAt(src, j + kw.length));
    if (!right) return null;
    left = { node: { k: 'and', left: left.node, right: right.node }, i: right.i };
  }
}

function parseUnaryF(src: string, i: number): { node: Formula; i: number } | null {
  const j = skipWsAt(src, i);
  const kw = keywordAt(src, j);
  if (kw === 'not') {
    const inner = parseUnaryF(src, j + kw.length);
    if (!inner) return null;
    return { node: { k: 'not', inner: inner.node }, i: inner.i };
  }
  if (src[j] === '!' && src[j + 1] !== '=') {
    const inner = parseUnaryF(src, j + 1);
    if (!inner) return null;
    return { node: { k: 'not', inner: inner.node }, i: inner.i };
  }
  if (src[j] === '(') {
    const inner = parseImpliesF(src, j + 1);
    if (!inner) return null;
    const close = skipWsAt(src, inner.i);
    if (src[close] !== ')') return null;
    return { node: inner.node, i: close + 1 };
  }
  if (kw === 'forall' || kw === 'exists') {
    let k = skipWsAt(src, j + kw.length);
    const name = src.slice(k).match(/^(\w+)/);
    if (!name) return null;
    k = skipWsAt(src, k + name[1].length);
    if (keywordAt(src, k) !== 'in') return null;
    k = skipWsAt(src, k + 2);
    const domain = readDomain(src, k);
    if (!domain) return null;
    // The body is the following formula, including juxtaposed comparisons.
    // A later quantifier is a sibling conjunct, not part of this body:
    // `forall a: P(a)` over an empty domain must not swallow the next formula.
    const body = parseSeq(src, domain.i, true);
    if (!body) return null;
    return { node: { k: 'quant', kind: kw, name: name[1], domain: domain.src, body: body.node }, i: body.i };
  }
  const atom = readFormulaAtom(src, j);
  if (!atom) return null;
  return { node: { k: 'atom', src: atom.src }, i: atom.i };
}

/**
 * Adjacent formulas are a conjunction. `stopAtQuant` keeps a quantifier
 * body from absorbing the next `forall` / `exists`.
 */
function parseSeq(src: string, i: number, stopAtQuant: boolean): { node: Formula; i: number } | null {
  let cur = parseImpliesF(src, i);
  if (!cur) return null;
  while (true) {
    const j = skipWsAt(src, cur.i);
    if (j >= src.length || src[j] === ')') return { node: cur.node, i: j };
    const kw = keywordAt(src, j);
    if (stopAtQuant && (kw === 'forall' || kw === 'exists')) return { node: cur.node, i: j };
    if (kw === 'and' || kw === 'or' || kw === 'implies' || kw === '->' || kw === '=>' || kw === '&&' || kw === '||') return null;
    const next = parseImpliesF(src, j);
    if (!next || next.i === j) return null;
    cur = { node: { k: 'and', left: cur.node, right: next.node }, i: next.i };
  }
}

function parseRangeEnds(src: string): { start: string; end: string } | null {
  const t = src.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1);
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length - 1; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '.' && inner[i + 1] === '.') {
      const start = inner.slice(0, i).trim();
      const end = inner.slice(i + 2).trim();
      if (start && end) return { start, end };
      return null;
    }
  }
  return null;
}

function translateDomain(src: string, env: Env): { code: string; elem: ET } | null {
  const range = parseRangeEnds(src);
  if (range) {
    const start = translate(parseStringToIRExpr(range.start), env, NAT);
    const end = translate(parseStringToIRExpr(range.end), env, NAT);
    if (!start || !end || !isNum(start.t) || !isNum(end.t)) return null;
    const code = `Array.from({ length: Math.max(0, (${end.code}) - (${start.code}) + 1) }, (_, $$i) => (${start.code}) + $$i)`;
    return { code, elem: NAT };
  }
  const dotted = src.match(/^([\s\S]+)\.(keys|values|indices)$/);
  if (dotted) {
    const base = translate(parseStringToIRExpr(dotted[1].trim()), env);
    if (!base) return null;
    if (dotted[2] === 'keys' && base.t.k === 'map') return { code: `Array.from($$effect.HashMap.keys(${base.code}))`, elem: base.t.key };
    if (dotted[2] === 'values' && base.t.k === 'map') return { code: `Array.from($$effect.HashMap.values(${base.code}))`, elem: base.t.val };
    if (dotted[2] === 'indices' && (base.t.k === 'list' || base.t.k === 'string')) {
      return { code: `Array.from(${base.code}.keys())`, elem: NAT };
    }
    return null;
  }
  const base = translate(parseStringToIRExpr(src), env);
  if (!base) return null;
  if (base.t.k === 'list') return { code: base.code, elem: base.t.elem };
  if (base.t.k === 'set') return { code: `Array.from($$effect.HashSet.values(${base.code}))`, elem: base.t.elem };
  if (base.t.k === 'map') return { code: `Array.from($$effect.HashMap.keys(${base.code}))`, elem: base.t.key };
  return null;
}

function splitWord(src: string, kw: string): [string, string] | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && keywordAt(src, i) === kw) {
      const left = src.slice(0, i).trim();
      const right = src.slice(i + kw.length).trim();
      if (left && right) return [left, right];
      return null;
    }
  }
  return null;
}

function translateSubset(leftSrc: string, rightSrc: string, env: Env): TExpr | null {
  const left = translateDomain(leftSrc, env);
  const right = translate(parseStringToIRExpr(rightSrc), env);
  if (!left || !right || right.t.k !== 'set') return null;
  const elemOk = sameType(left.elem, right.t.elem)
    || (isNum(left.elem) && isNum(right.t.elem))
    || (left.elem.k === 'string' && (right.t.elem.k === 'string' || right.t.elem.k === 'literal'))
    || (left.elem.k === 'literal' && (right.t.elem.k === 'string' || right.t.elem.k === 'literal'));
  if (!elemOk) return null;
  const el = '$$el';
  return {
    code: `${left.code}.every((${el}: ${tsType(left.elem)}) => $$effect.HashSet.has(${right.code}, ${el}))`,
    t: BOOL,
  };
}

function evalFormula(node: Formula, env: Env): TExpr | null {
  if (node.k === 'atom') {
    const sub = splitWord(node.src, 'subsetOf');
    if (sub) return translateSubset(sub[0], sub[1], env);
    const v = translate(parseStringToIRExpr(node.src), env, BOOL);
    return v && v.t.k === 'bool' ? v : null;
  }
  if (node.k === 'not') {
    const inner = evalFormula(node.inner, env);
    return inner && inner.t.k === 'bool' ? { code: `(!${inner.code})`, t: BOOL } : null;
  }
  if (node.k === 'and' || node.k === 'or' || node.k === 'implies') {
    const left = evalFormula(node.left, env);
    const right = evalFormula(node.right, env);
    if (!left || !right || left.t.k !== 'bool' || right.t.k !== 'bool') return null;
    if (node.k === 'and') return { code: `(${left.code} && ${right.code})`, t: BOOL };
    if (node.k === 'or') return { code: `(${left.code} || ${right.code})`, t: BOOL };
    return { code: `(!${left.code} || ${right.code})`, t: BOOL };
  }
  if (node.k !== 'quant') return null;
  const domain = translateDomain(node.domain, env);
  if (!domain) return null;
  const js = env.declare(node.name, domain.elem);
  const body = evalFormula(node.body, env);
  env.locals.delete(node.name);
  if (!body || body.t.k !== 'bool') return null;
  const method = node.kind === 'forall' ? 'every' : 'some';
  return { code: `${domain.code}.${method}((${js}: ${tsType(domain.elem)}) => (${body.code}))`, t: BOOL };
}

function translateFormulaSource(src: string, env: Env): TExpr | null {
  if (env.readingFormula) return null;
  const text = src.trim();
  if (!text) return null;
  env.readingFormula = true;
  try {
    const parsed = parseSeq(text, 0, false);
    if (!parsed || skipWsAt(text, parsed.i) < text.length) return null;
    return evalFormula(parsed.node, env);
  } finally {
    env.readingFormula = false;
  }
}

function translate(expr: IRExpr | undefined, env: Env, expected?: ET): TExpr | null {
  if (!expr || typeof expr !== 'object' || !('kind' in expr)) return null;
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) {
        const src = expr.source?.trim() ?? '';
        if (src && env.ctx.stateVars.has(src)) return lookup(src, env);
        const setLit = translateSetLiteral(src, env, expected);
        if (setLit) return setLit;
        // `{0: 0}` is a map literal. The IR has no node for it, so the
        // source is replayed when the destination is a map.
        if (expected?.k === 'map') {
          const lit = translateMapLiteral(src, env, expected);
          if (lit) return lit;
        }
        if (!env.readingFormula) {
          const formula = translateFormulaSource(src, env);
          if (formula) return formula;
        }
        return null;
      }
      return { code: String(expr.value), t: BOOL };
    case 'int_lit':
      if (!Number.isSafeInteger(expr.value)) return null;
      if (expected?.k === 'nat' && expr.value < 0) return null;
      return { code: String(expr.value), t: expected && isNum(expected) ? expected : { k: 'int' } };
    case 'float_lit':
      if (!Number.isFinite(expr.value)) return null;
      return { code: String(expr.value), t: REAL };
    case 'string_lit':
      return { code: JSON.stringify(expr.value), t: STRING };
    case 'ident':
      return translateIdent(expr.name, env, expected);
    case 'field':
      return translateField(expr.target, expr.field, env);
    case 'index':
      return translateIndex(expr.target, expr.index, env);
    case 'unop':
      return translateUnop(expr.op, expr.operand, env);
    case 'binop':
      return translateBinop(expr.op, expr.left, expr.right, env);
    case 'call':
      return translateCall(expr.fn, expr.args, env, expected);
    default:
      return null;
  }
}

function translateIdent(name: string, env: Env, expected?: ET): TExpr | null {
  if (['nil', 'null', 'none', 'None'].includes(name) && !env.locals.has(name) && !env.ctx.stateVars.has(name)) {
    return { code: 'null', t: { k: 'nullable', inner: expected?.k === 'nullable' ? expected.inner : { k: 'unknown', name: 'null', why: 'null' } } };
  }
  if (name === 'true' || name === 'false') return { code: name, t: BOOL };
  if (['emptyList', 'emptySet', 'emptyMap', 'empty'].includes(name)) {
    return translateCall(name, [], env, expected);
  }
  const found = lookup(name, env);
  if (found) return found;
  const owners = env.ctx.variants.get(name);
  if (owners && owners.length > 0) {
    const exp = expected?.k === 'nullable' ? expected.inner : expected;
    const owner = exp?.k === 'literal' && exp.name && owners.includes(exp.name) ? exp.name
      : exp?.k === 'literal' && exp.values.includes(name) ? (exp.name ?? owners[0])
      : owners.length === 1 ? owners[0] : undefined;
    if (!owner && !(exp?.k === 'literal' && exp.values.includes(name))) return null;
    const values = env.ctx.enums.get(owner ?? '') ?? env.ctx.aliasResolved.get(owner ?? '');
    const lit: ET = values && 'values' in (values as ET) && (values as ET).k === 'literal'
      ? values as ET
      : env.ctx.enums.has(owner ?? '')
        ? { k: 'literal', name: owner, values: env.ctx.enums.get(owner!)! }
        : exp?.k === 'literal' ? exp
        : { k: 'literal', name: owner, values: [name] };
    if (lit.k === 'literal' && !lit.values.includes(name)) return null;
    return { code: JSON.stringify(name), t: lit };
  }
  if (expected?.k === 'literal' && expected.values.includes(name)) {
    return { code: JSON.stringify(name), t: expected };
  }
  return null;
}

function translateField(target: IRExpr, field: string, env: Env): TExpr | null {
  if (target.kind === 'ident' && target.name === 'this') return lookup(field, env);
  const obj = translate(target, env);
  if (!obj) return null;
  const inner = obj.t.k === 'nullable' ? null : obj.t;
  if (!inner) return null;
  if (inner.k === 'record') {
    const f = env.ctx.records.get(inner.name)?.find((x) => x.name === field);
    if (!f) return null;
    return { code: propRead(obj.code, field), t: f.type };
  }
  if (inner.k === 'map' && field === 'keys') return obj;
  return null;
}

function translateIndex(target: IRExpr, index: IRExpr, env: Env): TExpr | null {
  const obj = translate(target, env);
  if (!obj) return null;
  if (obj.t.k === 'map') {
    const key = translate(index, env, obj.t.key);
    if (!key || !sameType(key.t, obj.t.key) && !(isNum(key.t) && isNum(obj.t.key))) return null;
    const k = coerce(key, obj.t.key);
    if (k == null) return null;
    return { code: `$$specklMapGet(${obj.code}, ${k})`, t: obj.t.val };
  }
  if (obj.t.k === 'list') {
    const i = translate(index, env, NAT);
    if (!i || !isNum(i.t)) return null;
    return { code: `$$specklListGet(${obj.code}, ${i.code})`, t: obj.t.elem };
  }
  return null;
}

function translateUnop(op: string, operand: IRExpr, env: Env): TExpr | null {
  const v = translate(operand, env);
  if (!v) return null;
  if ((op === '!' || op === 'not') && v.t.k === 'bool') return { code: `(!${v.code})`, t: BOOL };
  if (op === '-' && isNum(v.t)) return { code: `(-${v.code})`, t: v.t.k === 'nat' ? INT : v.t };
  return null;
}

function translateBinop(op: string, left: IRExpr, right: IRExpr, env: Env): TExpr | null {
  if (op === 'in' || op === '!in' || op === 'notIn' || op === 'notin') {
    return translateIn(op, left, right, env);
  }
  const l0 = translate(left, env);
  const r0 = translate(right, env, l0?.t);
  const l = l0 ?? (r0 ? translate(left, env, r0.t) : null);
  const r = r0 ?? (l ? translate(right, env, l.t) : null);
  if (!l || !r) return null;
  const cmp = op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=';
  if ((op === '&&' || op === 'and' || op === '||' || op === 'or') && l.t.k === 'bool' && r.t.k === 'bool') {
    return { code: `(${l.code} ${op === '||' || op === 'or' ? '||' : '&&'} ${r.code})`, t: BOOL };
  }
  if ((op === 'implies' || op === '=>' || op === '->') && l.t.k === 'bool' && r.t.k === 'bool') {
    return { code: `(!${l.code} || ${r.code})`, t: BOOL };
  }
  if (op === '+' && isNum(l.t) && isNum(r.t)) {
    return { code: `(${l.code} + ${r.code})`, t: numJoin(l.t, r.t) };
  }
  if (op === '+' && (l.t.k === 'string' || r.t.k === 'string' || l.t.k === 'literal' || r.t.k === 'literal')) {
    return { code: `\`\${$$specklShow(${l.code})}\${$$specklShow(${r.code})}\``, t: STRING };
  }
  if ((op === '-' || op === '*' || op === '/' || op === '%') && isNum(l.t) && isNum(r.t)) {
    const t = op === '/' ? REAL : numJoin(l.t, r.t);
    return { code: `(${l.code} ${op} ${r.code})`, t };
  }
  if (cmp && isNum(l.t) && isNum(r.t)) return { code: `(${l.code} ${jsCmp(op)} ${r.code})`, t: BOOL };
  if (cmp && (l.t.k === 'string' || l.t.k === 'literal') && (r.t.k === 'string' || r.t.k === 'literal') && (op === '==' || op === '!=')) {
    return { code: `(${l.code} ${jsCmp(op)} ${r.code})`, t: BOOL };
  }
  if ((op === '==' || op === '!=') && (l.code === 'null' || r.code === 'null')) {
    if (l.code === 'null' && r.code === 'null') return { code: op === '==' ? 'true' : 'false', t: BOOL };
    const other = l.code === 'null' ? r : l;
    return { code: `(${other.code} ${op === '==' ? '===' : '!=='} null)`, t: BOOL };
  }
  if ((op === '==' || op === '!=') && (l.t.k === 'nullable' || r.t.k === 'nullable')) {
    const neg = op === '!=';
    return { code: `${neg ? '!' : ''}($$specklEqual(${l.code}, ${r.code}))`, t: BOOL };
  }
  if ((op === '==' || op === '!=') && sameType(l.t, r.t)) {
    const neg = op === '!=';
    return { code: `${neg ? '!' : ''}($$specklEqual(${l.code}, ${r.code}))`, t: BOOL };
  }
  if (op === 'union' && l.t.k === 'set' && r.t.k === 'set' && sameType(l.t.elem, r.t.elem)) {
    return { code: `$$effect.HashSet.union(${l.code}, ${r.code})`, t: l.t };
  }
  if ((op === 'diff' || op === '\\') && l.t.k === 'set' && r.t.k === 'set' && sameType(l.t, r.t)) {
    return { code: `$$effect.HashSet.difference(${l.code}, ${r.code})`, t: l.t };
  }
  return null;
}

function translateIn(op: string, left: IRExpr, right: IRExpr, env: Env): TExpr | null {
  const keysOf = right.kind === 'field' && right.field === 'keys' ? translate(right.target, env) : null;
  const coll = keysOf?.t.k === 'map' ? keysOf : translate(right, env);
  if (!coll) return null;
  let code: string | null = null;
  if (coll.t.k === 'map') {
    const item = translate(left, env, coll.t.key);
    const c = item && coerce(item, coll.t.key);
    if (c == null) return null;
    code = `$$effect.HashMap.has(${coll.code}, ${c})`;
  } else if (coll.t.k === 'set') {
    const item = translate(left, env, coll.t.elem);
    const c = item && coerce(item, coll.t.elem);
    if (c == null) return null;
    code = `$$effect.HashSet.has(${coll.code}, ${c})`;
  } else if (coll.t.k === 'list') {
    const item = translate(left, env, coll.t.elem);
    const c = item && coerce(item, coll.t.elem);
    if (c == null) return null;
    code = `$$specklIncludes(${coll.code}, ${c})`;
  } else if (coll.t.k === 'string') {
    const item = translate(left, env, STRING);
    if (!item || item.t.k !== 'string') return null;
    code = `${coll.code}.includes(${item.code})`;
  }
  if (!code) return null;
  const neg = op !== 'in';
  return { code: neg ? `(!${code})` : code, t: BOOL };
}

function numJoin(a: ET, b: ET): ET {
  if (a.k === 'real' || b.k === 'real') return REAL;
  if (a.k === 'int' || b.k === 'int') return INT;
  return NAT;
}

function jsCmp(op: string): string {
  if (op === '==') return '===';
  if (op === '!=') return '!==';
  return op;
}

function coerce(v: TExpr, target: ET): string | null {
  if (target.k === 'nullable') {
    if (v.code === 'null') return 'null';
    if (v.t.k === 'nullable') return sameType(v.t, target) ? v.code : null;
    const inner = coerce(v, target.inner);
    return inner;
  }
  if (sameType(v.t, target) || (isNum(v.t) && isNum(target))) return v.code;
  if (v.t.k === 'literal' && target.k === 'string') return v.code;
  if (v.t.k === 'string' && target.k === 'literal' && v.code.startsWith('"')) {
    try {
      const value = JSON.parse(v.code) as string;
      if (target.values.includes(value)) return v.code;
    } catch { /* not a string literal */ }
  }
  return null;
}

function translateCall(fn: string, args: IRExpr[], env: Env, expected?: ET): TExpr | null {
  if (['emptySet', 'emptyMap', 'emptyList', 'empty'].includes(fn)) {
    if (!expected || args.length > 0) return null;
    if ((fn === 'emptyList' || fn === 'empty') && expected.k === 'list') return { code: defaultValue(env.ctx, expected), t: expected };
    if ((fn === 'emptySet' || fn === 'empty') && expected.k === 'set') return { code: defaultValue(env.ctx, expected), t: expected };
    if ((fn === 'emptyMap' || fn === 'empty') && expected.k === 'map') return { code: defaultValue(env.ctx, expected), t: expected };
    return null;
  }
  if (fn === 'now' && args.length === 0) return { code: '$$specklNow()', t: NAT };
  if (fn === 'old' && args.length === 1) {
    if (!env.allowOld) return null;
    const prev = env.readingOld;
    env.readingOld = true;
    env.useOld = true;
    const v = translate(args[0], env, expected);
    env.readingOld = prev;
    return v;
  }
  if (/^always$/i.test(fn) && args.length === 1) {
    const v = translate(args[0], env, BOOL);
    return v && v.t.k === 'bool' ? v : null;
  }
  const translated: TExpr[] = [];
  for (const a of args) {
    const v = translate(a, env);
    if (!v) return null;
    translated.push(v);
  }
  const [a, b] = translated;
  switch (fn) {
    case 'length':
    case 'len':
    case 'size':
    case 'count':
      if (translated.length !== 1) return null;
      if (a.t.k === 'list' || a.t.k === 'string' || a.t.k === 'bytes') return { code: `${a.code}.length`, t: NAT };
      if (a.t.k === 'set') return { code: `$$effect.HashSet.size(${a.code})`, t: NAT };
      if (a.t.k === 'map') return { code: `$$effect.HashMap.size(${a.code})`, t: NAT };
      return null;
    case 'has': {
      if (translated.length !== 2 || a.t.k !== 'map') return null;
      const key = coerce(translate(args[1], env, a.t.key) ?? b, a.t.key);
      return key == null ? null : { code: `$$effect.HashMap.has(${a.code}, ${key})`, t: BOOL };
    }
    case 'contains': {
      if (translated.length !== 2) return null;
      if (a.t.k === 'set') {
        const item = coerce(translate(args[1], env, a.t.elem) ?? b, a.t.elem);
        return item == null ? null : { code: `$$effect.HashSet.has(${a.code}, ${item})`, t: BOOL };
      }
      if (a.t.k === 'list') {
        const item = coerce(translate(args[1], env, a.t.elem) ?? b, a.t.elem);
        return item == null ? null : { code: `$$specklIncludes(${a.code}, ${item})`, t: BOOL };
      }
      if (a.t.k === 'string' && b.t.k === 'string') return { code: `${a.code}.includes(${b.code})`, t: BOOL };
      return null;
    }
    case 'implies':
      if (translated.length !== 2 || a.t.k !== 'bool' || b.t.k !== 'bool') return null;
      return { code: `(!${a.code} || ${b.code})`, t: BOOL };
    case 'min':
    case 'max':
      if (translated.length !== 2 || !isNum(a.t) || !isNum(b.t)) return null;
      return { code: `Math.${fn}(${a.code}, ${b.code})`, t: numJoin(a.t, b.t) };
    case 'append': {
      if (translated.length !== 2 || a.t.k !== 'list') return null;
      if (sameType(b.t, a.t)) return { code: `[...${a.code}, ...${b.code}]`, t: a.t };
      const item = coerce(translate(args[1], env, a.t.elem) ?? b, a.t.elem);
      if (item == null) return null;
      return { code: `[...${a.code}, ${item}]`, t: a.t };
    }
    default:
      return null;
  }
}

function exprSource(expr: IRExpr | undefined): string {
  if (!expr || typeof expr !== 'object' || !('kind' in expr)) return '<unknown expression>';
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) return expr.source ?? '<unknown expression>';
      return String(expr.value);
    case 'int_lit':
    case 'float_lit':
      return String(expr.value);
    case 'string_lit':
      return JSON.stringify(expr.value);
    case 'ident':
      return expr.name;
    case 'field':
      return `${exprSource(expr.target)}.${expr.field}`;
    case 'index':
      return `${exprSource(expr.target)}[${exprSource(expr.index)}]`;
    case 'binop':
      return `${exprSource(expr.left)} ${expr.op} ${exprSource(expr.right)}`;
    case 'unop':
      return `${expr.op === '!' ? 'not ' : '-'}${exprSource(expr.operand)}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(exprSource).join(', ')})`;
    default:
      return '<unknown expression>';
  }
}

function stmtSource(stmt: IRStmt): string {
  if (stmt.raw) return stmt.raw;
  const v = stmt.value ?? stmt.expr;
  switch (stmt.kind) {
    case 'assign': {
      const target = stmt.targetIndex && stmt.target?.endsWith('[...]')
        ? `${stmt.target.slice(0, -5)}[${exprSource(stmt.targetIndex)}]`
        : stmt.target;
      return `${target} := ${exprSource(v)}`;
    }
    case 'let':
      return `let ${stmt.letName} := ${exprSource(v)}`;
    case 'emit':
      return `emit ${stmt.event} { ${(stmt.fields ?? []).map((f) => `${f.name}: ${exprSource(f.value)}`).join(', ')} }`;
    case 'return':
      return v ? `return ${exprSource(v)}` : 'return';
    case 'if':
      return stmt.raw ? stmt.raw : `if ${exprSource(v)} { ... }`;
    default:
      return `${stmt.kind} ${exprSource(v)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────────────

const ERRORS = {
  guard: '$$GuardFailed',
  pre: '$$PreconditionFailed',
  post: '$$PostconditionFailed',
  inv: '$$InvariantViolated',
  bad: '$$Untranslated',
  index: '$$IndexOutOfRange',
  adapter: '$$AdapterUnimplemented',
  schema: '$$SchemaViolation',
} as const;

function numericKind(t: ET): 'nat' | 'int' | 'real' | null {
  if (t.k === 'nullable') return numericKind(t.inner);
  if (t.k === 'nat' || t.k === 'int' || t.k === 'real') return t.k;
  return null;
}

function containsConstrained(env: Env, t: ET, seen = new Set<string>()): boolean {
  if (numericKind(t)) return true;
  if (t.k === 'nullable') return containsConstrained(env, t.inner, seen);
  if (t.k === 'list' || t.k === 'set') return containsConstrained(env, t.elem, seen);
  if (t.k === 'map') return containsConstrained(env, t.key, seen) || containsConstrained(env, t.val, seen);
  if (t.k === 'union') return t.members.some((m) => containsConstrained(env, m, seen));
  if (t.k === 'record') {
    if (seen.has(t.name)) return false;
    const next = new Set(seen);
    next.add(t.name);
    return (env.ctx.records.get(t.name) ?? []).some((f) => containsConstrained(env, f.type, next));
  }
  return false;
}

/** A Nat/Int/Real write that misses the schema filter fails the effect instead of being stored. */
function constrain(env: Env, t: ET, code: string, where: string, errors: Set<string>): { lines: string[]; value: string } {
  const kind = numericKind(t);
  if (!kind || code === 'null') return { lines: [], value: code };
  const id = env.fresh('chk');
  const pred = kind === 'nat'
    ? `!Number.isSafeInteger(${id}) || ${id} < 0`
    : kind === 'int'
      ? `!Number.isSafeInteger(${id})`
      : `!Number.isFinite(${id})`;
  errors.add(ERRORS.schema);
  return {
    lines: [
      `const ${id} = ${code};`,
      `if (${pred}) return ${failExpr(ERRORS.schema, { where: JSON.stringify(where), detail: JSON.stringify(`not a ${kind === 'nat' ? 'Nat' : kind === 'int' ? 'Int' : 'Real'}`) })};`,
    ],
    value: id,
  };
}

/**
 * A value stored into a List, Set, Map, or record is checked at every
 * numeric leaf. Assigning the collection itself is not enough: `append`
 * and a local map copy would otherwise carry a negative Nat in.
 */
function constrainStored(env: Env, t: ET, code: string, where: string, errors: Set<string>): { lines: string[]; value: string } {
  if (code.trim() === 'null' || !containsConstrained(env, t)) return { lines: [], value: code };
  if (numericKind(t)) return constrain(env, t, code, where, errors);
  const id = env.fresh('col');
  return { lines: [`const ${id} = ${code};`, ...checkStored(env, t, id, where, errors, new Set())], value: id };
}

function checkStored(env: Env, t: ET, id: string, where: string, errors: Set<string>, seen: Set<string>): string[] {
  const kind = numericKind(t);
  if (kind) return constrain(env, t, id, where, errors).lines;
  if (t.k === 'nullable') {
    if (!containsConstrained(env, t.inner, seen)) return [];
    // A fresh binding with an assertion stays non-null even in code that
    // follows an earlier return, where control-flow narrowing does not.
    const nn = env.fresh('nn');
    const inner = checkStored(env, t.inner, nn, where, errors, seen);
    if (inner.length === 0) return [];
    return [
      `if (${id} != null) {`,
      `  const ${nn} = ${id} as Exclude<typeof ${id}, null | undefined>;`,
      ...inner.map((l) => `  ${l}`),
      `}`,
    ];
  }
  if (t.k === 'list' || t.k === 'set') {
    if (!containsConstrained(env, t.elem)) return [];
    const item = env.fresh('item');
    const iter = t.k === 'list' ? id : `$$effect.HashSet.values(${id})`;
    const inner = checkStored(env, t.elem, item, `${where}[]`, errors, seen);
    return [`for (const ${item} of ${iter}) {`, ...inner.map((l) => `  ${l}`), `}`];
  }
  if (t.k === 'map') {
    const lines: string[] = [];
    if (containsConstrained(env, t.key)) {
      const item = env.fresh('key');
      const inner = checkStored(env, t.key, item, `${where} key`, errors, seen);
      lines.push(`for (const ${item} of $$effect.HashMap.keys(${id})) {`, ...inner.map((l) => `  ${l}`), `}`);
    }
    if (containsConstrained(env, t.val)) {
      const item = env.fresh('val');
      const inner = checkStored(env, t.val, item, `${where} value`, errors, seen);
      lines.push(`for (const ${item} of $$effect.HashMap.values(${id})) {`, ...inner.map((l) => `  ${l}`), `}`);
    }
    return lines;
  }
  if (t.k === 'record') {
    if (seen.has(t.name)) return [];
    const next = new Set(seen);
    next.add(t.name);
    const lines: string[] = [];
    for (const f of env.ctx.records.get(t.name) ?? []) {
      if (!containsConstrained(env, f.type, next)) continue;
      const item = env.fresh('fld');
      lines.push(`const ${item} = ${propRead(id, f.name)};`);
      lines.push(...checkStored(env, f.type, item, `${where}.${f.name}`, errors, next));
    }
    return lines;
  }
  if (t.k === 'union') {
    const numeric = t.members.map((m) => numericKind(m)).filter((k): k is 'nat' | 'int' | 'real' => k != null);
    if (numeric.length === 0) return [];
    const strict: 'nat' | 'int' | 'real' = numeric.includes('nat') ? 'nat' : numeric.includes('int') ? 'int' : 'real';
    const inner = constrain(env, { k: strict }, id, where, errors).lines;
    return [`if (typeof ${id} === "number") {`, ...inner.map((l) => `  ${l}`), `}`];
  }
  return [];
}

function failExpr(cls: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `yield* new ${cls}({ ${body} })`;
}

interface StmtOut {
  lines: string[];
  returned: boolean;
  errors: Set<string>;
}

function translateStmts(stmts: IRStmt[], env: Env, action: string, ret: ET | undefined): StmtOut {
  const lines: string[] = [];
  const errors = new Set<string>();
  let returned = false;
  for (const stmt of stmts) {
    const part = translateStmt(stmt, env, action, ret);
    lines.push(...part.lines);
    for (const e of part.errors) errors.add(e);
    if (part.returned) {
      returned = true;
      break;
    }
  }
  return { lines, returned, errors };
}

function nestUpdate(base: string, fields: string[], value: string): string {
  if (fields.length === 0) return value;
  const [head, ...rest] = fields;
  return `{ ...${base}, ${propKey(head)}: ${nestUpdate(propRead(base, head), rest, value)} }`;
}

/** `box.n := v` updates the record and checks a Nat field before it is stored. */
function assignDotted(path: string, value: IRExpr, env: Env, errors: Set<string>): StmtOut | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const rootName = parts[0];
  const local = env.locals.get(rootName);
  const stateT = env.ctx.stateVars.get(rootName);
  const rootT = local?.t ?? stateT;
  if (!rootT) return null;
  let t: ET = rootT;
  for (const field of parts.slice(1)) {
    if (t.k !== 'record') return null;
    const found = env.ctx.records.get(t.name)?.find((x) => x.name === field);
    if (!found) return null;
    t = found.type;
  }
  const translated = translate(value, env, t);
  const code = translated && coerce(translated, t);
  if (code == null) return null;
  const held = constrainStored(env, t, code, path, errors);
  const lines = [...held.lines];
  if (local && parts.length === 1) lines.push(`${local.js} = ${held.value};`);
  else if (local) lines.push(`${local.js} = ${nestUpdate(local.js, parts.slice(1), held.value)};`);
  else if (parts.length === 1) lines.push(`$$state = { ...$$state, ${propKey(rootName)}: ${held.value} };`);
  else lines.push(`$$state = { ...$$state, ${propKey(rootName)}: ${nestUpdate(propRead('$$state', rootName), parts.slice(1), held.value)} };`);
  return { lines, returned: false, errors };
}

function translateStmt(stmt: IRStmt, env: Env, action: string, ret: ET | undefined): StmtOut {
  const errors = new Set<string>();
  const bad = (source: string): StmtOut => {
    env.failures.push(oneLine(source));
    errors.add(ERRORS.bad);
    return { lines: [`// SPECKL-UNTRANSLATED: ${jsDoc(source)}`], returned: false, errors };
  };
  const value = stmt.value ?? stmt.expr;
  switch (stmt.kind) {
    case 'assign': {
      if (!value || !stmt.target) return bad(stmtSource(stmt));
      if (stmt.target.endsWith('[...]')) {
        const baseName = stmt.target.slice(0, -5);
        const base = lookup(baseName, env);
        if (!base || !stmt.targetIndex) return bad(stmtSource(stmt));
        if (base.t.k === 'map') {
          const key = translate(stmt.targetIndex, env, base.t.key);
          const val = translate(value, env, base.t.val);
          const k = key && coerce(key, base.t.key);
          const v = val && coerce(val, base.t.val);
          if (k == null || v == null) return bad(stmtSource(stmt));
          const held = constrainStored(env, base.t.val, v, `${baseName}[:]`, errors);
          const local = env.locals.get(baseName);
          const mapBase = local ? local.js : propRead('$$state', baseName);
          const next = `$$effect.HashMap.set(${mapBase}, ${k}, ${held.value})`;
          if (local) return { lines: [...held.lines, `${local.js} = ${next};`], returned: false, errors };
          return { lines: [...held.lines, `$$state = { ...$$state, ${propKey(baseName)}: ${next} };`], returned: false, errors };
        }
        if (base.t.k === 'list') {
          const index = translate(stmt.targetIndex, env, NAT);
          const val = translate(value, env, base.t.elem);
          const v = val && coerce(val, base.t.elem);
          if (!index || !isNum(index.t) || v == null) return bad(stmtSource(stmt));
          errors.add(ERRORS.index);
          const slot = env.fresh('idx');
          const next = env.fresh('next');
          const src = JSON.stringify(oneLine(stmtSource(stmt)));
          const held = constrainStored(env, base.t.elem, v, `${baseName}[${index.code}]`, errors);
          const lines = [
            ...held.lines,
            `const ${slot} = ${index.code};`,
            `if (!Number.isInteger(${slot}) || ${slot} < 0 || ${slot} >= ${base.code}.length) {`,
            `  return ${failExpr(ERRORS.index, { action: JSON.stringify(action), detail: src })};`,
            `}`,
            `const ${next} = ${base.code}.slice();`,
            `${next}[${slot}] = ${held.value};`,
          ];
          const local = env.locals.get(baseName);
          if (local) lines.push(`${local.js} = ${next};`);
          else lines.push(`$$state = { ...$$state, ${propKey(baseName)}: ${next} };`);
          return { lines, returned: false, errors };
        }
        return bad(stmtSource(stmt));
      }
      const targetName = stmt.target.startsWith('this.') ? stmt.target.slice(5) : stmt.target;
      if (targetName.includes('.')) {
        return assignDotted(targetName.replace(/^this\./, ''), value, env, errors) ?? bad(stmtSource(stmt));
      }
      const fromState = stmt.target.startsWith('this.');
      const local = fromState ? undefined : env.locals.get(targetName);
      const stateT = env.ctx.stateVars.get(targetName);
      const dest = local ? { js: local.js, t: local.t, state: false } : stateT ? { js: propKey(targetName), t: stateT, state: true } : null;
      if (!dest) return bad(stmtSource(stmt));
      const v = translate(value, env, dest.t);
      const code = v && coerce(v, dest.t);
      if (code == null) return bad(stmtSource(stmt));
      const held = constrainStored(env, dest.t, code, targetName, errors);
      if (!dest.state) return { lines: [...held.lines, `${dest.js} = ${held.value};`], returned: false, errors };
      return { lines: [...held.lines, `$$state = { ...$$state, ${dest.js}: ${held.value} };`], returned: false, errors };
    }
    case 'let': {
      if (!value || !stmt.letName) return bad(stmtSource(stmt));
      const v = translate(value, env);
      if (!v || v.t.k === 'unit') return bad(stmtSource(stmt));
      const js = env.declare(stmt.letName, v.t);
      return { lines: [`let ${js}: ${tsType(v.t)} = ${v.code};`], returned: false, errors };
    }
    case 'require':
    case 'precondition': {
      const c = translate(value, env, BOOL);
      if (!c || c.t.k !== 'bool') return bad(stmtSource(stmt));
      const cls = stmt.kind === 'require' ? ERRORS.guard : ERRORS.pre;
      errors.add(cls);
      const src = exprSource(value);
      return {
        lines: [
          `// ${stmt.kind}: ${jsDoc(src)}`,
          `if (!(${c.code})) {`,
          `  return ${failExpr(cls, { action: JSON.stringify(action), detail: JSON.stringify(oneLine(src)) })};`,
          `}`,
        ],
        returned: false,
        errors,
      };
    }
    case 'postcondition':
      return { lines: [`// postcondition is checked at each return: ${jsDoc(exprSource(value))}`], returned: false, errors };
    case 'emit': {
      const fields = stmt.event ? env.ctx.records.get(stmt.event) : undefined;
      if (!fields || !stmt.event || !env.ctx.events.has(stmt.event)) return bad(stmtSource(stmt));
      const given = new Map((stmt.fields ?? []).map((f) => [f.name, f.value]));
      if ([...given.keys()].some((k) => !fields.some((f) => f.name === k))) return bad(stmtSource(stmt));
      const inits: string[] = [];
      for (const f of fields) {
        if (f.name === '_tag') {
          inits.push(`_tag: ${JSON.stringify(stmt.event)}`);
          continue;
        }
        const g = given.get(f.name);
        const v = g ? translate(g, env, f.type) : null;
        const code = v && coerce(v, f.type);
        if (code == null) return bad(stmtSource(stmt));
        inits.push(`${propKey(f.name)}: ${code}`);
      }
      return {
        lines: [`// emit ${jsDoc(stmt.event)}`, `$$log = [...$$log, { ${inits.join(', ')} }];`],
        returned: false,
        errors,
      };
    }
    case 'return': {
      let valueCode = 'undefined';
      if (value) {
        const v = translate(value, env, ret && ret.k !== 'unit' ? ret : undefined);
        if (!v || v.t.k === 'unit') return bad(stmtSource(stmt));
        if (ret && ret.k !== 'unit') {
          const c = coerce(v, ret);
          if (c == null) return bad(stmtSource(stmt));
          valueCode = c;
        } else {
          valueCode = v.code;
        }
      } else if (ret && ret.k !== 'unit') return bad(stmtSource(stmt));
      const held = ret ? constrainStored(env, ret, valueCode, 'return', errors) : { lines: [] as string[], value: valueCode };
      return {
        lines: [...held.lines, `return { state: $$state, decisionLog: $$log, value: ${held.value} };`],
        returned: true,
        errors,
      };
    }
    case 'if': {
      const dotted = stmt.raw?.match(/^(?:this\.)?((?:\w+\.)*\w+)\s*:=\s*([\s\S]+)$/);
      if (dotted && !dotted[1].includes('[')) {
        const written = assignDotted(dotted[1], parseStringToIRExpr(dotted[2].trim()), env, errors);
        if (written) return written;
        return bad(stmt.raw ?? stmtSource(stmt));
      }
      if (stmt.raw || !value || !stmt.thenBlock) return bad(stmt.raw ?? stmtSource(stmt));
      const c = translate(value, env, BOOL);
      if (!c || c.t.k !== 'bool') return bad(stmtSource(stmt));
      const thenPart = translateStmts(stmt.thenBlock, env, action, ret);
      const elsePart = stmt.elseBlock ? translateStmts(stmt.elseBlock, env, action, ret) : null;
      for (const e of thenPart.errors) errors.add(e);
      for (const e of elsePart?.errors ?? []) errors.add(e);
      const thenBody = thenPart.lines.map((l) => `  ${l}`).join('\n');
      let code = `if (${c.code}) {\n${thenBody}\n}`;
      if (elsePart) code += ` else {\n${elsePart.lines.map((l) => `  ${l}`).join('\n')}\n}`;
      return { lines: [code], returned: false, errors };
    }
    default:
      return bad(stmtSource(stmt));
  }
}

function postLines(posts: IRStmt[], env: Env, action: string): { lines: string[]; errors: Set<string> } {
  const lines: string[] = [];
  const errors = new Set<string>();
  for (const stmt of posts) {
    const src = exprSource(stmt.value ?? stmt.expr);
    const c = translate(stmt.value ?? stmt.expr, env, BOOL);
    if (!c || c.t.k !== 'bool') {
      env.failures.push(oneLine(`postcondition: ${src}`));
      errors.add(ERRORS.bad);
      lines.push(`// SPECKL-UNTRANSLATED: postcondition: ${jsDoc(src)}`);
      continue;
    }
    errors.add(ERRORS.post);
    lines.push(
      `if (!(${c.code})) {`,
      `  return ${failExpr(ERRORS.post, { action: JSON.stringify(action), detail: JSON.stringify(oneLine(src)) })};`,
      `}`,
    );
  }
  return { lines, errors };
}

interface ActionEmit {
  name: string;
  exportName: string;
  params: { spec: string; js: string; t: ET }[];
  ret: ET;
  errors: string[];
  body: string[];
  failed: boolean;
}

function emitAction(ctx: Ctx, action: IRAction, exportName: string): ActionEmit {
  const posts = action.statements.filter((s) => s.kind === 'postcondition');
  const bodyStmts = action.statements.filter((s) => s.kind !== 'postcondition');
  const probe = new Env(ctx);
  for (const p of action.params) probe.declare(p.name, resolveParam(ctx, action, p.name));
  // Return type: first translated return, else unit. Lets are in scope,
  // so `let v := n - 10; return v` is a number and gets the Nat check.
  let ret: ET = { k: 'unit' };
  const findRet = (stmts: IRStmt[]): ET | undefined => {
    const added: string[] = [];
    const result = ((): ET | undefined => {
      for (const s of stmts) {
        if (s.kind === 'let' && s.letName && !probe.locals.has(s.letName)) {
          const bound = translate(s.value ?? s.expr, probe);
          if (bound && bound.t.k !== 'unit') {
            probe.declare(s.letName, bound.t);
            added.push(s.letName);
          }
        }
        if (s.kind === 'return') {
          if (!s.expr && !s.value) return { k: 'unit' };
          const v = translate(s.value ?? s.expr, probe);
          return v && v.t.k !== 'unit' ? v.t : undefined;
        }
        const nested = findRet(s.thenBlock ?? []) ?? findRet(s.elseBlock ?? []);
        if (nested) return nested;
      }
      return undefined;
    })();
    for (const name of added) probe.locals.delete(name);
    return result;
  };
  const found = findRet(bodyStmts);
  if (found) ret = found;

  const withPosts = new Env(ctx);
  withPosts.allowOld = true;
  const params = action.params.map((p) => {
    const t = resolveParam(ctx, action, p.name);
    const js = withPosts.declare(p.name, t);
    return { spec: p.name, js, t };
  });
  const rerun = translateStmtsCheckingPosts(bodyStmts, withPosts, action.name, ret, posts);
  const errors = new Set<string>([...rerun.errors, ...withPosts.failures.length ? [ERRORS.bad] : []]);
  const lines = [...rerun.lines];
  if (!rerun.returned) {
    const tail = postLines(posts, withPosts, action.name);
    for (const e of tail.errors) errors.add(e);
    lines.push(...tail.lines);
    if (ret.k === 'unit') lines.push(`return { state: $$state, decisionLog: $$log, value: undefined };`);
    else {
      withPosts.failures.push(`${action.name} ended without returning a value`);
      errors.add(ERRORS.bad);
      lines.push(`// SPECKL-UNTRANSLATED: ${action.name} ended without returning a value`);
    }
  }
  if (withPosts.failures.length > 0) {
    errors.add(ERRORS.bad);
    const detail = `${action.name}: ${withPosts.failures.length} untranslated statement${withPosts.failures.length === 1 ? '' : 's'}, first: ${withPosts.failures[0]}`;
    lines.unshift(
      `// This decision fails closed until every statement below is translated.`,
      `return ${failExpr(ERRORS.bad, { where: JSON.stringify(action.name), detail: JSON.stringify(oneLine(detail)) })};`,
    );
  }
  return {
    name: action.name,
    exportName,
    params,
    ret,
    errors: [...errors],
    body: lines,
    failed: withPosts.failures.length > 0,
  };
}

function resolveParam(ctx: Ctx, action: IRAction, name: string): ET {
  const astAction = ctx.ast?.members.find((m): m is ActionNode => m.type === 'action' && m.name === action.name);
  const astParam = astAction?.params.find((p) => p.name === name);
  if (astParam) return resolveTypeExpr(ctx, astParam.type, `${action.name}.${name}`);
  const ir = action.params.find((p) => p.name === name);
  return resolveIr(ctx, ir?.type, `${action.name}.${name}`);
}

function translateStmtsCheckingPosts(stmts: IRStmt[], env: Env, action: string, ret: ET, posts: IRStmt[]): StmtOut {
  const lines: string[] = [];
  const errors = new Set<string>();
  let returned = false;
  for (const stmt of stmts) {
    if (stmt.kind === 'return') {
      const part = translateStmt(stmt, env, action, ret);
      // translateStmt's return does not include posts (it looks them up
      // wrong). Prepend the real checks.
      const checks = postLines(posts, env, action);
      for (const e of checks.errors) errors.add(e);
      for (const e of part.errors) errors.add(e);
      const retLines = part.lines.filter((l) => !l.startsWith('// postcondition is checked'));
      lines.push(...checks.lines, ...retLines);
      returned = true;
      break;
    }
    if (stmt.kind === 'if' && stmt.thenBlock) {
      const c = translate(stmt.expr ?? stmt.value, env, BOOL);
      if (!c || c.t.k !== 'bool') {
        env.failures.push(oneLine(stmt.raw ?? stmtSource(stmt)));
        errors.add(ERRORS.bad);
        lines.push(`// SPECKL-UNTRANSLATED: ${jsDoc(stmt.raw ?? stmtSource(stmt))}`);
        continue;
      }
      const thenPart = translateStmtsCheckingPosts(stmt.thenBlock, env, action, ret, posts);
      const elsePart = stmt.elseBlock ? translateStmtsCheckingPosts(stmt.elseBlock, env, action, ret, posts) : null;
      for (const e of thenPart.errors) errors.add(e);
      if (elsePart) for (const e of elsePart.errors) errors.add(e);
      let code = `if (${c.code}) {\n${thenPart.lines.map((l) => `  ${l}`).join('\n')}\n}`;
      if (elsePart) code += ` else {\n${elsePart.lines.map((l) => `  ${l}`).join('\n')}\n}`;
      lines.push(code);
      continue;
    }
    const part = translateStmt(stmt, env, action, ret);
    lines.push(...part.lines);
    for (const e of part.errors) errors.add(e);
    if (part.returned) {
      returned = true;
      break;
    }
  }
  return { lines, returned, errors };
}

// ─────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────

interface RuleEmit {
  exportName: string;
  specName: string;
  source: string;
  body: string[];
  errors: string[];
  temporal: boolean;
  kind: 'invariant' | 'constraint' | 'verify';
  needsOld: boolean;
}

function emitRule(ctx: Ctx, exportName: string, specName: string, expr: IRExpr, source: string, temporal: 'state' | 'eventually' | 'other', kind: RuleEmit['kind']): RuleEmit {
  if (expr.kind === 'ident') {
    const named = ctx.rules.get(expr.name);
    if (named) {
      const needsOld = ctx.ruleNeedsOld.get(expr.name) ?? false;
      return {
        exportName,
        specName,
        source,
        temporal: false,
        kind,
        needsOld,
        errors: [ERRORS.inv, ERRORS.bad],
        body: [`// ${jsDoc(source)}`, `return yield* ${named}({ state: $$state }${needsOld ? ', $$specklOld' : ''});`],
      };
    }
  }
  const env = new Env(ctx, true);
  env.allowOld = true;
  if (temporal === 'eventually' || temporal === 'other') {
    return {
      exportName,
      specName,
      source,
      temporal: true,
      kind,
      needsOld: false,
      errors: [ERRORS.bad],
      body: [
        `// ${jsDoc(source)}`,
        `return ${failExpr(ERRORS.bad, { where: JSON.stringify(exportName), detail: JSON.stringify(oneLine(source)) })};`,
      ],
    };
  }
  const v = translate(expr, env, BOOL);
  const needsOld = env.useOld;
  if (!v || v.t.k !== 'bool' || env.failures.length > 0) {
    const detail = source;
    return {
      exportName,
      specName,
      source,
      temporal: false,
      kind,
      needsOld: false,
      errors: [ERRORS.bad],
      body: [
        `// SPECKL-UNTRANSLATED: ${jsDoc(detail)}`,
        `return ${failExpr(ERRORS.bad, { where: JSON.stringify(specName || exportName), detail: JSON.stringify(oneLine(detail)) })};`,
      ],
    };
  }
  // A verify that is only `yield* someRule(...)` is an effect, not a bool.
  if (v.code.startsWith('(yield*')) {
    return {
      exportName,
      specName,
      source,
      temporal: false,
      kind,
      needsOld,
      errors: [ERRORS.inv, ERRORS.bad],
      body: [`// ${jsDoc(source)}`, `return ${v.code.slice(1, -1)};`],
    };
  }
  return {
    exportName,
    specName,
    source,
    temporal: false,
    kind,
    needsOld,
    errors: [ERRORS.inv],
    body: [
      `// ${jsDoc(source)}`,
      `if (!(${v.code})) {`,
      `  return ${failExpr(ERRORS.inv, { name: JSON.stringify(specName || exportName), detail: JSON.stringify(oneLine(source)) })};`,
      `}`,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Module assembly
// ─────────────────────────────────────────────────────────────────────

function buildContext(speck: IRSpeck, ast: SpeckNode | undefined): Ctx {
  const ctx = new Ctx(speck, ast);
  const astInterfaces = (ast?.members ?? []).filter((m): m is InterfaceNode => m.type === 'interface');
  const astEvents = (ast?.members ?? []).filter((m): m is EventNode => m.type === 'event');
  let sourceTypes = { aliases: new Map<string, string>(), records: new Map<string, string>() };
  const text = speckText(speck, ast);
  if (text) sourceTypes = readSourceTypes(text);

  for (const [name, t] of speck.facets.typed_schema.types) {
    if (t.kind === 'enum' && !sourceTypes.records.has(name)) {
      const id = claimTypeName(ctx, name);
      if (id !== name) ctx.fail(`cannot map enum ${name}: \`${id}\` would rename it and the spec name is not a legal Effect export`);
      ctx.enums.set(name, t.variants);
      ctx.usedExports.add(name);
      for (const v of t.variants) ctx.ownVariant(name, v);
    }
  }

  const recordNames: string[] = [];
  for (const [name, t] of speck.facets.typed_schema.types) {
    if (t.kind === 'record' && !speck.facets.behavior.events.some((e) => e.name === name)) {
      claimTypeName(ctx, name);
      ctx.records.set(name, []);
      recordNames.push(name);
    }
  }
  for (const name of sourceTypes.records.keys()) {
    if (ctx.records.has(name) || ctx.events.has(name)) continue;
    claimTypeName(ctx, name);
    ctx.records.set(name, []);
    recordNames.push(name);
  }
  for (const ev of speck.facets.behavior.events) {
    claimTypeName(ctx, ev.name);
    ctx.records.set(ev.name, []);
    ctx.events.add(ev.name);
  }

  const taken = new Set<string>([...ctx.records.keys(), ...ctx.enums.keys(), ...ctx.events]);
  for (const [name, rhs] of sourceTypes.aliases) {
    if (taken.has(name)) continue;
    claimTypeName(ctx, name);
    ctx.aliases.set(name, rhs);
  }
  for (const name of ctx.aliases.keys()) resolveAlias(ctx, name, new Set());

  for (const name of recordNames) {
    const sourceBody = sourceTypes.records.get(name);
    const astIface = astInterfaces.find((i) => i.name === name);
    const ir = speck.facets.typed_schema.types.get(name);
    const fields: RecField[] = sourceBody !== undefined
      ? fieldsFromSource(ctx, name, sourceBody)
      : astIface
      ? astIface.fields.map((f) => ({
        name: f.name,
        optional: false,
        type: resolveTypeExpr(ctx, f.type, `${name}.${f.name}`),
      }))
      : (ir && ir.kind === 'record' ? ir.fields : []).map((f) => ({
        name: f.name,
        optional: f.optional,
        type: resolveIr(ctx, f.type, `${name}.${f.name}`),
      }));
    if (fields.some((f) => f.name === '_tag')) ctx.fail(`record ${name} field _tag collides with the tagged-event discriminant`);
    ctx.records.set(name, dedupeFields(ctx, name, fields));
  }
  for (const ev of speck.facets.behavior.events) {
    const astEv = astEvents.find((e) => e.name === ev.name);
    const payload: RecField[] = astEv
      ? astEv.fields.map((f) => ({ name: f.name, optional: false, type: resolveTypeExpr(ctx, f.type, `${ev.name}.${f.name}`) }))
      : ev.fields.map((f) => ({ name: f.name, optional: f.optional, type: resolveIr(ctx, f.type, `${ev.name}.${f.name}`) }));
    if (payload.some((f) => f.name === '_tag')) ctx.fail(`event ${ev.name} field _tag collides with the tagged-union discriminant`);
    ctx.records.set(ev.name, [
      { name: '_tag', optional: false, type: { k: 'literal', values: [ev.name] } },
      ...payload,
    ]);
  }

  const astState = ast?.members.find((m): m is StateNode => m.type === 'state');
  const stateBody = extractBlock(text, 'state');
  const stateTypes = stateBody !== null ? readFieldTypes(stateBody) : new Map<string, string>();
  const declared = new Set<string>();
  for (const sv of speck.facets.behavior.stateVars) {
    const fromSource = stateTypes.get(sv.name);
    const astVar = astState?.variables.find((v) => v.name === sv.name);
    const t = fromSource !== undefined
      ? parseTypeSource(ctx, fromSource, sv.name, new Set())
      : astVar
        ? resolveTypeExpr(ctx, astVar.typeExpr, sv.name)
        : resolveIr(ctx, sv.type, sv.name);
    ctx.stateVars.set(sv.name, t);
    declared.add(sv.name);
  }
  // A one-line `state { a: T, b: U }` is split on commas by the parser and
  // can arrive empty. The source field list is the one the module uses.
  for (const [name, typeText] of stateTypes) {
    if (declared.has(name)) continue;
    ctx.stateVars.set(name, parseTypeSource(ctx, typeText, name, new Set()));
  }
  const initBody = extractBlock(text, 'init');
  if (initBody !== null) {
    ctx.sourceInits = readInitAssignments(initBody).map((a) => ({
      name: a.name,
      raw: a.raw,
      expr: parseStringToIRExpr(a.expr),
    }));
  }
  for (const svc of (ast?.members ?? []).filter((m): m is ServiceNode => m.type === 'service')) {
    ctx.servicePlans.push({
      name: svc.name,
      rpcs: svc.rpcs.map((rpc) => ({
        rpc: rpc.name,
        req: resolveServiceType(ctx, rpc.requestType, `${svc.name}.${rpc.name} request`),
        res: resolveServiceType(ctx, rpc.responseType, `${svc.name}.${rpc.name} response`),
      })),
    });
  }

  const input = recordFromIo(ctx, ast, 'input');
  const output = recordFromIo(ctx, ast, 'output');
  for (const f of input) ctx.inputFields.set(f.name, f.type);
  for (const f of output) ctx.outputFields.set(f.name, f.type);

  for (const a of speck.facets.behavior.actions) {
    for (const p of a.params) resolveParam(ctx, a, p.name);
  }
  return ctx;
}

function dedupeFields(ctx: Ctx, record: string, fields: RecField[]): RecField[] {
  const byName = new Map<string, RecField>();
  for (const f of fields) {
    const prev = byName.get(f.name);
    if (!prev) {
      byName.set(f.name, f);
      continue;
    }
    // A second copy whose type did not parse is the parser reading past the
    // record. The unresolved marker stays on its own schema; the field keeps
    // the type that parsed.
    if (f.type.k === 'unknown') continue;
    if (prev.type.k === 'unknown') {
      byName.set(f.name, f);
      continue;
    }
    if (!sameType(prev.type, f.type)) {
      ctx.fail(`record ${record} field ${f.name} is declared twice with different types`);
    }
  }
  return [...byName.values()];
}

function fieldsFromSource(ctx: Ctx, record: string, body: string): RecField[] {
  const chunks = fieldChunks(body);
  const fields: RecField[] = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    fields.push({
      name: m[1],
      optional: false,
      type: parseTypeSource(ctx, m[2].trim(), `${record}.${m[1]}`, new Set()),
    });
  }
  return fields;
}

function fieldChunks(body: string): string[] {
  const commaParts = splitTop(body, ',') ?? [body];
  const chunks: string[] = [];
  for (const part of commaParts) {
    const lines = part.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length <= 1) {
      if (part.trim()) chunks.push(part.trim());
      continue;
    }
    // Keep commas. They separate fields of a record nested in this type
    // (`Map(K, { a: A, b: B })`). Stripping each line's comma glued the
    // record into one unreadable type.
    for (const line of lines) chunks.push(line);
  }
  return chunks;
}

function claimTypeName(ctx: Ctx, name: string): string {
  if (!/^[A-Za-z_]\w*$/.test(name) || TS_RESERVED.has(name) || TS_TYPE_WORDS.has(name)) {
    ctx.fail(`cannot map type ${name}: not a legal TypeScript export name`);
  }
  if (ctx.usedExports.has(name)) ctx.fail(`cannot map type ${name}: the export name is already used`);
  ctx.usedExports.add(name);
  return name;
}

function recordFromIo(ctx: Ctx, ast: SpeckNode | undefined, kind: 'input' | 'output'): RecField[] {
  const members = (ast?.members ?? []).filter((m): m is InputNode | OutputNode => m.type === kind);
  if (members.length > 1) ctx.fail(`cannot map ${kind}: more than one ${kind} block`);
  if (members.length === 0) return [];
  const t = members[0].typeExpr;
  if (t.type !== 'record' || !t.fields) ctx.fail(`cannot map ${kind}: expected a record type, got ${t.type}`);
  return t.fields.map((f) => ({
    name: f.name,
    optional: false,
    type: resolveTypeExpr(ctx, f.type, `${kind}.${f.name}`),
  }));
}

function emitModule(speck: IRSpeck, ast: SpeckNode | undefined): string {
  const ctx = buildContext(speck, ast);
  rejectUnsupported(ctx, ast);

  const stateName = exportIdent(`${pascal(speck.name)}State`, ctx.usedExports, true);
  const eventName = exportIdent(`${pascal(speck.name)}Event`, ctx.usedExports, true);
  const machineName = exportIdent(`${pascal(speck.name)}Machine`, ctx.usedExports, true);
  const decisionName = exportIdent(`${pascal(speck.name)}Decision`, ctx.usedExports, true);
  const capName = exportIdent(`${pascal(speck.name)}Capability`, ctx.usedExports, true);
  const liveName = exportIdent(`${camel(speck.name)}Live`, ctx.usedExports);
  const inputName = ctx.inputFields.size > 0 ? exportIdent(`${pascal(speck.name)}Input`, ctx.usedExports, true) : '';
  const outputName = ctx.outputFields.size > 0 ? exportIdent(`${pascal(speck.name)}Output`, ctx.usedExports, true) : '';

  const fnUsed = new Set<string>([...ctx.usedExports, 'getState', 'nextActions', 'lifecycle', 'agentConfig']);
  const actions = speck.facets.behavior.actions.map((a) => {
    const exportName = exportIdent(camel(a.name) || 'action', fnUsed);
    return emitAction(ctx, a, exportName);
  });

  const invariants = (ast?.members ?? []).filter((m): m is InvariantMemberNode => m.type === 'invariant');
  const rules: RuleEmit[] = [];
  for (const inv of invariants) {
    const exportName = exportIdent(`check${pascal(inv.name)}`, fnUsed);
    ctx.rules.set(inv.name, exportName);
    const expr = parseRuleExpr(inv.expr);
    const rule = emitRule(ctx, exportName, inv.name, expr, inv.expr, 'state', 'invariant');
    ctx.ruleNeedsOld.set(inv.name, rule.needsOld);
    rules.push(rule);
  }
  speck.facets.formal_spec.constraints.forEach((c, i) => {
    const specName = c.name ?? `constraint ${i + 1}`;
    const exportName = exportIdent(c.name ? `check${pascal(c.name)}` : `checkConstraint${i + 1}`, fnUsed);
    if (c.name) ctx.rules.set(c.name, exportName);
    rules.push(emitRule(ctx, exportName, specName, c.expr, exprSource(c.expr), 'state', 'constraint'));
  });
  const verifies: RuleEmit[] = speck.facets.formal_spec.verifies.map((v, i) => {
    const exportName = exportIdent(v.name ? `verify${pascal(v.name)}` : `verify${i + 1}`, fnUsed);
    const kind = temporalKind(v.temporalExpr);
    const inner = kind === 'state' ? unwrapAlways(v.temporalExpr) : v.temporalExpr;
    return emitRule(ctx, exportName, v.name, inner, exprSource(v.temporalExpr), kind, 'verify');
  });

  const sections: string[] = [];
  sections.push(header(speck));
  sections.push(helpers());
  sections.push(errorClasses());
  sections.push(...emitNamedSchemas(ctx));
  if (inputName) sections.push(emitStruct(ctx, inputName, [...ctx.inputFields].map(([name, type]) => ({ name, type, optional: false })), `Declared input of ${speck.name}.`));
  if (outputName) sections.push(emitStruct(ctx, outputName, [...ctx.outputFields].map(([name, type]) => ({ name, type, optional: false })), `Declared output of ${speck.name}.`));
  sections.push(emitStruct(ctx, stateName, [...ctx.stateVars].map(([name, type]) => ({ name, type, optional: false })), `State of ${speck.name}.`));
  sections.push(emitEventUnion(ctx, eventName));
  sections.push(emitMachineTypes(machineName, stateName, eventName, decisionName));
  sections.push(emitBoot(ctx, stateName, machineName));
  const skippedInvariants = rules.filter((r) => r.kind === 'invariant' && r.errors.includes(ERRORS.bad));
  if (skippedInvariants.length > 0) {
    // forall and the other untranslated forms are used by the shipped
    // examples, so generation still succeeds. An action must not commit
    // while one of those invariants was skipped.
    const detail = JSON.stringify(`untranslated invariant: ${skippedInvariants.map((r) => r.specName).join(', ')}`);
    const line = `return ${failExpr(ERRORS.bad, { where: JSON.stringify('invariant'), detail })};`;
    for (const a of actions) {
      a.body.unshift('// An invariant could not be translated, so this action cannot commit.', line);
      if (!a.errors.includes(ERRORS.bad)) a.errors.push(ERRORS.bad);
    }
  }
  const guards = rules
    .filter((r) => r.kind === 'invariant' && !r.errors.includes(ERRORS.bad))
    .map((r) => `yield* ${r.exportName}({ state: $$state }${r.needsOld ? ', $$specklOld' : ''});`);
  if (guards.length > 0) {
    for (const a of actions) if (!a.errors.includes(ERRORS.inv)) a.errors.push(ERRORS.inv);
  }
  for (const a of actions) sections.push(emitActionFn(ctx, a, machineName, decisionName, guards));
  for (const r of [...rules, ...verifies]) sections.push(emitRuleFn(ctx, r, stateName, inputName, outputName));
  sections.push(emitCapability(ctx, capName, liveName, machineName, stateName, actions, [...rules, ...verifies], inputName, outputName));
  sections.push(...emitServices(ctx));
  if (speck.facets.behavior.next) {
    sections.push(`/** Actions the spec allows at each step, in source order. */\nexport const nextActions = ${JSON.stringify(speck.facets.behavior.next)} as const;`);
  }
  const life = emitLifecycle(speck);
  if (life) sections.push(life);
  const agent = emitAgent(speck);
  if (agent) sections.push(agent);
  return sections.filter(Boolean).join('\n\n') + '\n';
}

function parseRuleExpr(src: string): IRExpr {
  // Invariants are not in the IR, so parse them here. A failure is an
  // untranslated placeholder, which the rule emitter reports.
  try {
    return parseStringToIRExpr(src);
  } catch {
    return { kind: 'bool_lit', value: false, parseFailed: true, source: src };
  }
}

function temporalKind(expr: IRExpr): 'state' | 'eventually' | 'other' {
  if (expr.kind === 'call' && /^always$/i.test(expr.fn)) return 'state';
  if (expr.kind === 'call' && /^eventually$/i.test(expr.fn)) return 'eventually';
  if (expr.kind === 'ident') return 'state';
  if (expr.kind === 'bool_lit' && expr.parseFailed) return 'other';
  return 'state';
}

function unwrapAlways(expr: IRExpr): IRExpr {
  if (expr.kind === 'call' && /^always$/i.test(expr.fn) && expr.args.length === 1) return expr.args[0];
  return expr;
}

function rejectUnsupported(ctx: Ctx, ast: SpeckNode | undefined): void {
  let source = '';
  try {
    source = fs.readFileSync(ctx.speck.sourcePath, 'utf-8');
  } catch {
    source = '';
  }
  const imports = (ast?.members ?? []).filter((m) => m.type === 'import');
  if (imports.length > 0 || /^\s*import\s+/m.test(source)) {
    const first = imports[0] as { path?: string } | undefined;
    ctx.fail(`cannot map import${first?.path ? ` ${first.path}` : ''}: cross-spec imports are not resolved, so the Effect module would silently miss them`);
  }
  if ((ast?.members ?? []).some((m) => m.type === 'oneof') || /^\s*oneof\s+/m.test(source)) {
    ctx.fail('cannot map oneof: a tagged union of payload variants is not lowered into the IR, and emitting the surrounding records without it would drop the discriminator');
  }
  if ((ast?.members ?? []).some((m) => m.type === 'transition') || /^\s*transition\s+/m.test(source)) {
    ctx.fail('cannot map transition: the envelope is a wire-format construct this target does not lower');
  }
  if (ctx.speck.facets.validation.rules.size > 0) {
    ctx.fail('cannot map validation rules: the IR carried field rules and this target has no Schema filter for them yet');
  }
  for (const svc of (ast?.members ?? []).filter((m): m is ServiceNode => m.type === 'service')) {
    for (const rpc of svc.rpcs) {
      if (rpc.clientStreaming || rpc.serverStreaming) {
        const which = [rpc.clientStreaming ? 'client' : '', rpc.serverStreaming ? 'server' : ''].filter(Boolean).join(' and ');
        ctx.fail(`cannot map streaming RPC ${svc.name}.${rpc.name}: ${which} streaming has no Effect mapping yet (refusing to drop the stream)`);
      }
    }
  }
}

function header(speck: IRSpeck): string {
  return `// Generated by speckl from ${jsDoc(speck.name)}. Do not edit.
// Effect ${EFFECT_VERSION}. Import \`effect\` yourself; this file only typechecks against it.
//
// Schemas are the values other components decode. Decisions and rules
// return Effect. The capability is a Context.Tag; the Live layer is the
// adapter that holds state in a Ref. Anything this target cannot translate
// fails with SpecklUntranslated (or EffectTargetError at generation time)
// instead of emitting a guess.
import * as $$effect from "effect";`;
}

function helpers(): string {
  return `const $$specklNat = $$effect.Schema.Number.pipe($$effect.Schema.int(), $$effect.Schema.nonNegative());
const $$specklInt = $$effect.Schema.Number.pipe($$effect.Schema.int());
const $$specklReal = $$effect.Schema.Finite;

/** Unix time in seconds. Speckl \`now()\` is a Nat of seconds, matching the other backends. */
const $$specklNow = (): number => Math.floor(Date.now() / 1000);

const $$specklShow = (value: unknown): string => (typeof value === "string" ? value : String(value));

/** Structural equality for records, lists, and Effect collections. Numbers and strings already use ===. */
const $$specklEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
  }
  if ($$effect.HashSet.isHashSet(left) || $$effect.HashSet.isHashSet(right)) {
    return $$effect.HashSet.isHashSet(left) && $$effect.HashSet.isHashSet(right) && $$effect.Equal.equals(left, right);
  }
  if ($$effect.HashMap.isHashMap(left) || $$effect.HashMap.isHashMap(right)) {
    return $$effect.HashMap.isHashMap(left) && $$effect.HashMap.isHashMap(right) && $$effect.Equal.equals(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!$$specklEqual(left[i], right[i])) return false;
    return true;
  }
  const lk = Object.keys(left).sort();
  const rk = Object.keys(right).sort();
  if (lk.length !== rk.length) return false;
  for (let i = 0; i < lk.length; i++) {
    if (lk[i] !== rk[i]) return false;
    if (!$$specklEqual((left as Record<string, unknown>)[lk[i]], (right as Record<string, unknown>)[rk[i]])) return false;
  }
  return true;
};

const $$specklIncludes = <A>(list: ReadonlyArray<A>, item: A): boolean => list.some((candidate) => $$specklEqual(candidate, item));

/** A missing key is a defect: an expression has no typed error channel to fail into. */
const $$specklMapGet = <K, V>(map: $$effect.HashMap.HashMap<K, V>, key: K): V => {
  const got = $$effect.HashMap.get(map, key);
  if ($$effect.Option.isNone(got)) {
    throw new Error("SPECKL: missing map key");
  }
  return got.value;
};

const $$specklListGet = <A>(list: ReadonlyArray<A>, index: number): A => {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    throw new Error("SPECKL: list index out of range");
  }
  return list[index];
};`;
}

function errorClasses(): string {
  const decl = (cls: string, tag: string, fields: string) =>
    `export class ${cls} extends $$effect.Schema.TaggedError<${cls}>()(${JSON.stringify(tag)}, {\n${fields}\n}) {}`;
  return [
    decl('$$GuardFailed', 'GuardFailed', '  action: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$PreconditionFailed', 'PreconditionFailed', '  action: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$PostconditionFailed', 'PostconditionFailed', '  action: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$InvariantViolated', 'InvariantViolated', '  name: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$Untranslated', 'Untranslated', '  where: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$IndexOutOfRange', 'IndexOutOfRange', '  action: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
    decl('$$AdapterUnimplemented', 'AdapterUnimplemented', '  service: $$effect.Schema.String,\n  method: $$effect.Schema.String,'),
    decl('$$SchemaViolation', 'SchemaViolation', '  where: $$effect.Schema.String,\n  detail: $$effect.Schema.String,'),
  ].join('\n\n');
}

function emitNamedSchemas(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const [name, variants] of ctx.enums) {
    const t: ET = { k: 'literal', name, values: variants };
    out.push(`/** Enum ${name}. */\nexport const ${name} = ${schemaExpr(t)};\nexport type ${name} = $$effect.Schema.Schema.Type<typeof ${name}>;`);
  }
  for (const [name, t] of ctx.aliasResolved) {
    if (ctx.enums.has(name) || ctx.records.has(name)) continue;
    const expr = t.k === 'literal' ? schemaExpr(t) : schemaRef(ctx, t);
    out.push(`/** Alias ${name} = ${jsDoc(ctx.aliases.get(name) ?? '')}. */\nexport const ${name} = ${expr};\nexport type ${name} = $$effect.Schema.Schema.Type<typeof ${name}>;`);
  }
  for (const [name, why] of ctx.opaque) {
    out.push(`/** SPECKL-UNRESOLVED: ${jsDoc(why)}. Values are \`unknown\` and generated code does not construct them. */\nexport const ${name} = $$effect.Schema.Unknown;\nexport type ${name} = unknown;`);
  }
  // Interfaces first so recursive records can name each other, then schemas.
  const iface: string[] = [];
  const schemas: string[] = [];
  for (const [name, fields] of ctx.records) {
    const doc = ctx.events.has(name) ? `Event ${name}.` : `Record ${name}.`;
    iface.push(emitIface(name, fields, doc));
    schemas.push(emitSchemaConst(ctx, name, fields));
  }
  if (iface.length) out.push(iface.join('\n\n'));
  if (schemas.length) out.push(schemas.join('\n\n'));
  return out;
}

function emitIface(name: string, fields: RecField[], doc: string): string {
  const body = fields.map((f) => `  readonly ${propKey(f.name)}${f.optional ? '?' : ''}: ${tsType(f.type)};`).join('\n');
  return `/** ${jsDoc(doc)} */\nexport interface ${name} {\n${body}\n}`;
}

function emitSchemaConst(ctx: Ctx, name: string, fields: RecField[]): string {
  const body = fields.map((f) => `  ${propKey(f.name)}: ${fieldSchema(ctx, f)},`).join('\n');
  return `export const ${name}: $$effect.Schema.Schema<${name}> = $$effect.Schema.Struct({\n${body}\n});`;
}

function emitStruct(ctx: Ctx, name: string, fields: RecField[], doc: string): string {
  return `${emitIface(name, fields, doc)}\n\n${emitSchemaConst(ctx, name, fields)}`;
}

function emitEventUnion(ctx: Ctx, eventName: string): string {
  const names = [...ctx.events];
  if (names.length === 0) {
    return `/** This speck declares no events. */\nexport const ${eventName} = $$effect.Schema.Never;\nexport type ${eventName} = never;`;
  }
  return `/** Every event the decision log can record. */\nexport const ${eventName} = $$effect.Schema.Union(${names.join(', ')});\nexport type ${eventName} = $$effect.Schema.Schema.Type<typeof ${eventName}>;`;
}

function emitMachineTypes(machine: string, state: string, event: string, decision: string): string {
  return `export interface ${machine} {
  readonly state: ${state};
  readonly decisionLog: ReadonlyArray<${event}>;
}

export interface ${decision}<A> {
  readonly state: ${state};
  readonly decisionLog: ReadonlyArray<${event}>;
  readonly value: A;
}`;
}

function stateReads(expr: IRExpr | undefined, names: Set<string>, out: Set<string> = new Set()): Set<string> {
  if (!expr || typeof expr !== 'object' || !('kind' in expr)) return out;
  switch (expr.kind) {
    case 'ident':
      if (names.has(expr.name)) out.add(expr.name);
      return out;
    case 'field':
      if (expr.target.kind === 'ident' && expr.target.name === 'this' && names.has(expr.field)) out.add(expr.field);
      else stateReads(expr.target, names, out);
      return out;
    case 'index':
      stateReads(expr.target, names, out);
      stateReads(expr.index, names, out);
      return out;
    case 'unop':
      return stateReads(expr.operand, names, out);
    case 'binop':
      stateReads(expr.left, names, out);
      stateReads(expr.right, names, out);
      return out;
    case 'call':
      if (expr.fn !== 'old') for (const a of expr.args) stateReads(a, names, out);
      return out;
    default:
      return out;
  }
}

function emitBoot(ctx: Ctx, stateName: string, machineName: string): string {
  const env = new Env(ctx);
  const failures: string[] = [];
  const names = new Set(ctx.stateVars.keys());
  const fromSource = ctx.sourceInits;
  const items = (fromSource ?? ctx.speck.facets.behavior.init.map((a) => ({
    name: a.target,
    expr: a.expr,
    raw: `init ${a.target} := ${exprSource(a.expr)}`,
  }))).map((a) => ({ ...a }));
  // Evaluate an initializer only after every other initializer it reads.
  const pending = items.slice();
  const ordered: typeof items = [];
  while (pending.length > 0) {
    const idx = pending.findIndex((it, i) => [...stateReads(it.expr, names)].every(
      (r) => !pending.some((p, j) => j !== i && p.name === r),
    ));
    if (idx < 0) {
      failures.push(...pending.map((p) => p.raw));
      pending.length = 0;
      break;
    }
    ordered.push(pending.splice(idx, 1)[0]);
  }
  const assigned = new Set<string>();
  const writes: string[] = [];
  let schema = false;
  for (const a of ordered) {
    const t = ctx.stateVars.get(a.name);
    if (!t) { failures.push(a.raw); continue; }
    const v = translate(a.expr, env, t);
    const code = v && coerce(v, t);
    if (code == null) { failures.push(a.raw); continue; }
    assigned.add(a.name);
    const held = constrain(env, t, code, a.name, new Set());
    if (held.lines.length > 0) schema = true;
    writes.push(...held.lines, `$$state = { ...$$state, ${propKey(a.name)}: ${held.value} };`);
  }
  const literal: string[] = [];
  for (const [name, t] of ctx.stateVars) {
    if (t.k === 'unknown' && !assigned.has(name)) {
      failures.push(`init ${name}: unresolved type has no value`);
      literal.push(`${propKey(name)}: undefined as unknown`);
      continue;
    }
    literal.push(`${propKey(name)}: ${assigned.has(name) ? defaultValue(ctx, t) : defaultValue(ctx, t)}`);
  }
  const lines: string[] = [];
  if (failures.length > 0) {
    const detail = `${ctx.speck.name} init: ${failures.length} untranslated assignment${failures.length === 1 ? '' : 's'}, first: ${oneLine(failures[0])}`;
    lines.push(...failures.map((f) => `// SPECKL-UNTRANSLATED: ${jsDoc(f)}`));
    lines.push(`return ${failExpr(ERRORS.bad, { where: JSON.stringify('init'), detail: JSON.stringify(detail) })};`);
  }
  lines.push(`let $$state: ${stateName} = { ${literal.join(', ')} };`);
  lines.push(...writes);
  lines.push(`return { state: $$state, decisionLog: [] };`);
  const errs = [failures.length > 0 ? '$$Untranslated' : '', schema ? '$$SchemaViolation' : ''].filter(Boolean);
  ctx.bootErr = errs.length > 0 ? errs.join(' | ') : 'never';
  return `/** A machine in its initial state. An initializer that cannot be translated fails the effect. \`name == expr\` is an initializer. */
export const $$boot: $$effect.Effect.Effect<${machineName}, ${ctx.bootErr}> = $$effect.Effect.gen(function* () {
  ${lines.join('\n  ')}
});`;
}

function emitActionFn(ctx: Ctx, action: ActionEmit, machine: string, decision: string, guards: string[]): string {
  const params = [`$$machine: ${machine}`, ...action.params.map((p) => `${p.js}: ${tsType(p.t)}`)];
  const errParts = [...action.errors];
  if (guards.length > 0 && !errParts.includes(ERRORS.inv)) errParts.push(ERRORS.inv);
  const err = errParts.length > 0 ? errParts.join(' | ') : 'never';
  const retTs = action.ret.k === 'unit' ? 'undefined' : tsType(action.ret);
  const bodyLines = action.body.flatMap((line) => (
    line.startsWith('return { state: $$state') ? [...guards, line] : [line]
  ));
  const body = [
    `const $$specklOld = { ...$$machine.state };`,
    `let $$state = { ...$$machine.state };`,
    `let $$log = $$machine.decisionLog;`,
    ...bodyLines,
  ];
  void ctx;
  return `/** Decision ${jsDoc(action.name)}. */
export const ${action.exportName} = (${params.join(', ')}): $$effect.Effect.Effect<${decision}<${retTs}>, ${err}> =>
  $$effect.Effect.gen(function* () {
    ${body.join('\n    ')}
  });`;
}

function emitRuleFn(ctx: Ctx, rule: RuleEmit, stateName: string, inputName: string, outputName: string): string {
  const params = [`machine: { readonly state: ${stateName} }`];
  if (rule.needsOld) params.push(`$$specklOld: ${stateName}`);
  if (inputName) params.push(`$$input: ${inputName}`);
  if (outputName) params.push(`$$output: ${outputName}`);
  const err = rule.errors.join(' | ') || 'never';
  const body = [
    `const $$state = machine.state;`,
    ...rule.body,
  ];
  // $$log is only there so a rule that mentions the decision log typechecks.
  // Rules do not take the log today; the binding keeps old() off the table.
  void ctx;
  return `/** Rule ${jsDoc(rule.specName)}: ${jsDoc(rule.source)} */
export const ${rule.exportName} = (${params.join(', ')}): $$effect.Effect.Effect<void, ${err}> =>
  $$effect.Effect.gen(function* () {
    ${body.join('\n    ')}
  });`;
}

function emitCapability(
  ctx: Ctx,
  capName: string,
  liveName: string,
  machineName: string,
  stateName: string,
  actions: ActionEmit[],
  rules: RuleEmit[],
  inputName: string,
  outputName: string,
): string {
  const shape: string[] = [];
  shape.push(`readonly getState: $$effect.Effect.Effect<${stateName}>`);
  for (const a of actions) {
    const args = a.params.map((p) => `${p.js}: ${tsType(p.t)}`).join(', ');
    const err = a.errors.length > 0 ? a.errors.join(' | ') : 'never';
    const ret = a.ret.k === 'unit' ? 'undefined' : tsType(a.ret);
    shape.push(`readonly ${a.exportName}: (${args}) => $$effect.Effect.Effect<${ret}, ${err}>`);
  }
  for (const r of rules) {
    const extra = [
      r.needsOld ? `previous: ${stateName}` : '',
      inputName ? `input: ${inputName}` : '',
      outputName ? `output: ${outputName}` : '',
    ].filter(Boolean).join(', ');
    const err = r.errors.join(' | ') || 'never';
    shape.push(`readonly ${r.exportName}: (${extra}) => $$effect.Effect.Effect<void, ${err}>`);
  }
  const id = `@speckl/${ctx.speck.name}`;
  const bootErr = ctx.bootErr;
  const methods = [
    `getState: $$effect.Effect.map($$effect.Ref.get($$held), ($$machine) => $$machine.state),`,
    ...actions.map((a) => {
      const args = a.params.map((p) => p.js).join(', ');
      const params = a.params.map((p) => `${p.js}: ${tsType(p.t)}`).join(', ');
      const call = args ? `$$current, ${args}` : '$$current';
      return `${a.exportName}: (${params}) => $$effect.Effect.gen(function* () {
        const $$current = yield* $$effect.Ref.get($$held);
        const decided = yield* ${a.exportName}(${call});
        yield* $$effect.Ref.set($$held, { state: decided.state, decisionLog: decided.decisionLog });
        return decided.value;
      }),`;
    }),
    ...rules.map((r) => {
      const params = [
        r.needsOld ? `previous: ${stateName}` : '',
        inputName ? `input: ${inputName}` : '',
        outputName ? `output: ${outputName}` : '',
      ].filter(Boolean).join(', ');
      const extraArgs = [
        r.needsOld ? 'previous' : '',
        inputName ? 'input' : '',
        outputName ? 'output' : '',
      ].filter(Boolean);
      return `${r.exportName}: (${params}) => $$effect.Effect.flatMap($$effect.Ref.get($$held), ($$machine) => ${r.exportName}($$machine${extraArgs.length ? ', ' + extraArgs.join(', ') : ''})),`;
    }),
  ];
  return `/** Capability other components depend on. Methods are the decisions and rules. */
export class ${capName} extends $$effect.Context.Tag(${JSON.stringify(id)})<${capName}, {
  ${shape.join('\n  ')}
}>() {}

/** Adapter: runs the decisions against a Ref of the machine. */
export const ${liveName}: $$effect.Layer.Layer<${capName}, ${bootErr}> = $$effect.Layer.effect(
  ${capName},
  $$effect.Effect.gen(function* () {
    const initial = yield* $$boot;
    const $$held = yield* $$effect.Ref.make<${machineName}>(initial);
    return {
      ${methods.join('\n      ')}
    };
  }),
);`;
}

function emitServices(ctx: Ctx): string[] {
  return ctx.servicePlans.map((svc) => {
    const cls = exportIdent(pascal(svc.name), ctx.usedExports, true);
    const layer = exportIdent(`${camel(svc.name)}Unimplemented`, ctx.usedExports);
    const used = new Set<string>();
    const specs = svc.rpcs.map((rpc) => {
      const exportName = exportIdent(camel(rpc.rpc) || 'call', used);
      return { exportName, rpc: rpc.rpc, req: rpc.req, res: rpc.res };
    });
    const shape = specs.map((m) => `readonly ${m.exportName}: (request: ${tsType(m.req)}) => $$effect.Effect.Effect<${tsType(m.res)}, $$AdapterUnimplemented>`).join('\n  ');
    const body = specs.map((m) => `${m.exportName}: (_request: ${tsType(m.req)}) => $$effect.Effect.fail(new $$AdapterUnimplemented({ service: ${JSON.stringify(svc.name)}, method: ${JSON.stringify(m.rpc)} })),`).join('\n      ');
    return `/** Service ${jsDoc(svc.name)}. The spec declares the capability and no adapter, so the layer fails closed. */
export class ${cls} extends $$effect.Context.Tag(${JSON.stringify(`@speckl/service/${svc.name}`)})<${cls}, {
  ${shape}
}>() {}

export const ${layer}: $$effect.Layer.Layer<${cls}> = $$effect.Layer.succeed(${cls}, {
      ${body}
    });`;
  });
}

function resolveServiceType(ctx: Ctx, name: string, hint: string): ET {
  if (!/^[A-Za-z_]\w*$/.test(name)) return unresolved(ctx, `${hint}: type ${name} is not an identifier`);
  // An undeclared request or response stays Schema.Unknown (SPECKL-UNRESOLVED)
  // and the adapter still fails closed. The module typechecks.
  return resolveIdent(ctx, name, hint, new Set());
}

function emitLifecycle(speck: IRSpeck): string | null {
  const life = speck.facets.resource_lifecycle;
  const status = life.status?.doc;
  if (life.conditions.length === 0 && life.finalizers.length === 0 && !life.ownerReferences && !status) return null;
  const value = {
    conditions: life.conditions,
    finalizers: life.finalizers,
    ownerReferences: life.ownerReferences,
    ...(status ? { statusText: status } : {}),
  };
  return `/** Resource lifecycle carried on the spec. statusText is the source text; it is not a parsed schema. */\nexport const lifecycle = ${JSON.stringify(value, null, 2)} as const;`;
}

function emitAgent(speck: IRSpeck): string | null {
  const agent = speck.facets.behavior.agent;
  if (!agent) return null;
  const value = JSON.stringify({
    stages: agent.stages ?? null,
    tools: agent.tools,
    awaits: agent.awaits,
    pendingTimeout: agent.pendingTimeout ?? null,
  }, (_k, v) => v === undefined ? null : v, 2);
  return `/** Agent block, as data. Rails (hooks, harness adapters) stay on the agent target; this is the declared configuration so it is not dropped. */\nexport const agentConfig = ${value} as const;`;
}

function packageJson(name: string): string {
  const pkg = snake(name) || 'speck';
  return JSON.stringify({
    name: `speckl-${pkg}`,
    private: true,
    type: 'module',
    description: `Generated by speckl from ${name}. Depends on effect ${EFFECT_VERSION}.`,
    dependencies: { effect: EFFECT_VERSION },
  }, null, 2) + '\n';
}

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
      noEmit: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src'],
  }, null, 2) + '\n';
}

function snake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Generate an Effect module for every speck. `ast` supplies invariants,
 * services, and the original type expressions (so `Set` stays a HashSet
 * and inline unions are visible). The IR supplies expression trees.
 */
export function generateEffect(ir: IR, outputDir: string, ast?: AST): void {
  for (const speck of ir.specks) {
    const astSpeck = ast?.specks.find((s) => s.name === speck.name);
    const code = emitModule(speck, astSpeck);
    const dir = path.join(outputDir, speck.name);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const file = path.join(srcDir, 'index.ts');
    fs.writeFileSync(file, code);
    fs.writeFileSync(path.join(dir, 'package.json'), packageJson(speck.name));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), tsconfig());
    console.log(`Generated Effect module: ${file}`);
  }
}
