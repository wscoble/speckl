// rust.ts — Rust target.
//
// Emits one crate per speck: <outputDir>/<Speck>/Cargo.toml and src/lib.rs
// with
//
//   - an enum per interface-as-enum, a struct per record type,
//   - a struct per event (in `mod events`) and a `<Speck>Event` union,
//   - `<Speck>Machine`: the state as struct fields plus a decision log,
//   - `new()` built from the init block,
//   - one method per action, returning Result<_, String> (a failed
//     require/precondition/postcondition is an Err),
//   - `check_*` methods for invariants and constraints, `verify_*` for
//     temporal properties.
//
// Every generated crate must compile (`cargo check`; see
// `npm run test:compile`). The generator works from the IR and translates
// expressions with their types. Anything it cannot type, or that has no
// Rust form yet, fails closed instead of being emitted as invalid Rust or
// skipped:
//
//   - an action with an untranslated statement returns
//     Err("SPECKL-UNTRANSLATED: ...") before it reads or writes state;
//   - an untranslated init, invariant or temporal property panics via
//     speckl_untranslated("<source>") when it is evaluated;
//   - a type the spec uses but does not declare becomes an opaque
//     placeholder struct (marked SPECKL-UNRESOLVED) whose values cannot be
//     constructed by generated code.

import * as fs from 'fs';
import * as path from 'path';
import type { AST, InvariantMemberNode } from '../parser.js';
import { guardAst, guardIr } from '../conservation.js';
import { parseStringToIRExpr } from '../ir/lower.js';
import type {
  IR,
  IRSpeck,
  IRTypeRef,
  IRFieldDef,
  IRAction,
  IRStmt,
  IRExpr,
  IRType,
} from '../ir/types.js';

/**
 * Generate a Rust crate for every speck in the IR. `ast` supplies the
 * invariant blocks, which the IR does not carry yet.
 */
export function generateRust(ir: IR, outputDir: string, ast?: AST): void {
  if (ast) guardAst('rust', ast);
  else guardIr('rust', ir);
  for (const speck of ir.specks) {
    const astSpeck = ast?.specks.find((s) => s.name === speck.name);
    const invariants = (astSpeck?.members ?? []).filter(
      (m): m is InvariantMemberNode => m.type === 'invariant',
    );
    const code = emitCrate(speck, invariants);

    const speckDir = path.join(outputDir, speck.name);
    const srcDir = path.join(speckDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const libPath = path.join(srcDir, 'lib.rs');
    fs.writeFileSync(libPath, code);
    console.log(`Generated Rust crate: ${libPath}`);

    const cargoToml = `[package]
name = "${crateName(speck.name)}"
version = "0.1.0"
edition = "2021"
description = "Auto-generated Speck state machine: ${tomlString(speck.name)}"

[dependencies]
`;
    fs.writeFileSync(path.join(speckDir, 'Cargo.toml'), cargoToml);
    console.log(`Generated Cargo.toml: ${speckDir}/Cargo.toml`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Rust types
// ─────────────────────────────────────────────────────────────────────

/** A resolved Rust-side type. `intlit` is an integer literal not yet given a type. */
type RT =
  | { k: 'bool' }
  | { k: 'u64' }
  | { k: 'i64' }
  | { k: 'f64' }
  | { k: 'intlit' }
  | { k: 'nil' }
  | { k: 'string' }
  | { k: 'bytes' }
  | { k: 'record'; name: string }
  | { k: 'enum'; name: string }
  | { k: 'opaque'; name: string }
  | { k: 'list'; elem: RT }
  | { k: 'set'; elem: RT }
  | { k: 'map'; key: RT; val: RT }
  | { k: 'option'; inner: RT };

const BOOL: RT = { k: 'bool' };
const U64: RT = { k: 'u64' };
const I64: RT = { k: 'i64' };
const F64: RT = { k: 'f64' };
const STRING: RT = { k: 'string' };

const PRIMITIVE_NAMES: Record<string, RT> = {
  Bool: BOOL, Boolean: BOOL,
  Nat: U64,
  Int: I64, Integer: I64, Long: I64,
  Real: F64, Float: F64, Double: F64, Number: F64,
  String: STRING, Str: STRING,
  Bytes: { k: 'bytes' },
  // Dates are Unix seconds (no chrono dependency).
  Date: U64, Timestamp: U64,
};

const isNum = (t: RT) => t.k === 'u64' || t.k === 'i64' || t.k === 'f64' || t.k === 'intlit';
const isCopy = (t: RT): boolean =>
  t.k === 'bool' || t.k === 'u64' || t.k === 'i64' || t.k === 'f64' || t.k === 'intlit' || t.k === 'enum' || t.k === 'nil';

/** Name used for a type that is referenced but cannot be named (e.g. `Map<String`). */
const UNPARSED_TYPE = 'SpecklUnparsedType';

class Ctx {
  readonly machine: string;
  readonly eventEnum: string;
  readonly types: Map<string, IRType>;
  /** Record structs to emit: IR records plus inline records, by Rust name. */
  readonly records = new Map<string, IRFieldDef[]>();
  readonly enums = new Map<string, string[]>();
  /** Undeclared type names → why. Emitted as opaque placeholder structs. */
  readonly opaque = new Map<string, string>();
  readonly stateVars = new Map<string, RT>();
  readonly variants = new Map<string, string[]>();
  /** Invariant name → Rust method name. */
  readonly invariants = new Map<string, string>();
  readonly events: Map<string, IRFieldDef[]>;

  constructor(readonly speck: IRSpeck) {
    this.machine = `${typeIdent(speck.name)}Machine`;
    this.eventEnum = `${typeIdent(speck.name)}Event`;
    this.types = speck.facets.typed_schema.types;
    for (const t of this.types.values()) {
      if (t.kind === 'enum') {
        this.enums.set(t.name, t.variants);
        for (const v of t.variants) this.variants.set(v, [...(this.variants.get(v) ?? []), t.name]);
      }
    }
    for (const t of this.types.values()) {
      if (t.kind === 'record') this.records.set(t.name, t.fields);
    }
    this.events = new Map(speck.facets.behavior.events.map((e) => [e.name, e.fields]));
    for (const sv of speck.facets.behavior.stateVars) {
      this.stateVars.set(sv.name, this.resolve(sv.type, pascal(sv.name)));
    }
  }

  /** Resolve an IR type. `hint` names an inline record struct if one is needed. */
  resolve(ref: IRTypeRef | undefined, hint: string, seen: Set<string> = new Set()): RT {
    const wrap = (t: RT): RT => (ref?.nullable && t.k !== 'option' ? { k: 'option', inner: t } : t);
    if (!ref || !ref.kind) return this.unresolved(UNPARSED_TYPE, 'a type the parser could not read');
    switch (ref.kind) {
      case 'primitive': {
        const p = PRIMITIVE_NAMES[ref.primitive ?? ''];
        return wrap(p ?? this.unresolved(typeIdent(ref.primitive ?? UNPARSED_TYPE), `primitive ${ref.primitive} has no Rust mapping`));
      }
      case 'list':
        return wrap({ k: 'list', elem: this.resolve(ref.elementType, `${hint}Item`, seen) });
      case 'set':
        return wrap({ k: 'set', elem: this.resolve(ref.elementType, `${hint}Item`, seen) });
      case 'map': {
        if (ref.fields && (!ref.keyType || !ref.valueType)) {
          // An inline record: give it a named struct.
          let name = typeIdent(`${hint}Record`);
          while (this.types.has(name) || (this.records.has(name) && this.records.get(name) !== ref.fields)) name += '_';
          if (!this.records.has(name)) {
            this.records.set(name, ref.fields);
            // Resolve the fields now so nested inline records get names.
            for (const f of ref.fields) this.resolve(f.type, `${name}${pascal(f.name)}`, seen);
          }
          return wrap({ k: 'record', name });
        }
        if (!ref.keyType || !ref.valueType) return wrap(this.unresolved(UNPARSED_TYPE, 'a map type without key or value type'));
        return wrap({ k: 'map', key: this.resolve(ref.keyType, `${hint}Key`, seen), val: this.resolve(ref.valueType, `${hint}Value`, seen) });
      }
      case 'ident': {
        const name = ref.name ?? '';
        const opt = name.match(/^Option\s*[(<]\s*(\w+)\s*[)>]$/);
        if (opt) return { k: 'option', inner: this.resolve({ kind: 'ident', name: opt[1] }, hint, seen) };
        const t = this.types.get(name);
        if (t?.kind === 'record') return wrap({ k: 'record', name });
        if (t?.kind === 'enum') return wrap({ k: 'enum', name });
        if (t?.kind === 'alias' && !seen.has(name)) return wrap(this.resolve(t.target, hint, new Set([...seen, name])));
        const p = PRIMITIVE_NAMES[name];
        if (p) return wrap(p);
        if (/^[A-Za-z_]\w*$/.test(name) && !this.events.has(name)) {
          return wrap(this.unresolved(typeIdent(name), `type ${name} is not declared in this spec (or is an alias the parser dropped)`));
        }
        if (this.events.has(name)) return wrap(this.unresolved(UNPARSED_TYPE, `event ${name} used as a type`));
        return wrap(this.unresolved(UNPARSED_TYPE, `type \`${name}\` could not be parsed`));
      }
    }
    return this.unresolved(UNPARSED_TYPE, 'a type the parser could not read');
  }

  private unresolved(name: string, why: string): RT {
    if (!this.opaque.has(name)) this.opaque.set(name, why);
    return { k: 'opaque', name };
  }

  rust(t: RT): string {
    switch (t.k) {
      case 'bool': return 'bool';
      case 'u64': return 'u64';
      case 'i64': case 'intlit': return 'i64';
      case 'f64': return 'f64';
      case 'nil': return 'Option<()>';
      case 'string': return 'String';
      case 'bytes': return 'Vec<u8>';
      case 'record': case 'enum': case 'opaque': return typeIdent(t.name);
      case 'list': return `Vec<${this.rust(t.elem)}>`;
      case 'set': return `HashSet<${this.rust(t.elem)}>`;
      case 'map': return `HashMap<${this.rust(t.key)}, ${this.rust(t.val)}>`;
      case 'option': return `Option<${this.rust(t.inner)}>`;
    }
  }

  /** Can values of t be HashMap keys / HashSet elements (Eq + Hash)? */
  hashable(t: RT, seen: Set<string> = new Set()): boolean {
    switch (t.k) {
      case 'f64': case 'set': case 'map': return false;
      case 'list': return this.hashable(t.elem, seen);
      case 'option': return this.hashable(t.inner, seen);
      case 'record': {
        if (seen.has(t.name)) return true;
        const fields = this.records.get(t.name) ?? [];
        const next = new Set([...seen, t.name]);
        return fields.every((f) => this.hashable(this.fieldType(t.name, f), next));
      }
      default: return true;
    }
  }

  /** Does t implement PartialEq (HashMap and HashSet need hashable keys for it)? */
  comparable(t: RT, seen: Set<string> = new Set()): boolean {
    switch (t.k) {
      case 'map': return this.hashable(t.key) && this.comparable(t.val, seen);
      case 'set': return this.hashable(t.elem);
      case 'list': return this.comparable(t.elem, seen);
      case 'option': return this.comparable(t.inner, seen);
      case 'record': {
        if (seen.has(t.name)) return true;
        const next = new Set([...seen, t.name]);
        return (this.records.get(t.name) ?? []).every((f) => this.comparable(this.fieldType(t.name, f), next));
      }
      default: return true;
    }
  }

  fieldType(record: string, f: IRFieldDef): RT {
    return this.resolve(f.type, `${record}${pascal(f.name)}`);
  }

  recordField(record: string, field: string): RT | undefined {
    const f = this.records.get(record)?.find((x) => x.name === field);
    return f ? this.fieldType(record, f) : undefined;
  }
}

function sameType(a: RT, b: RT): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'record': case 'enum': case 'opaque':
      return a.name === (b as { name: string }).name;
    case 'list': case 'set':
      return sameType(a.elem, (b as { elem: RT }).elem);
    case 'map':
      return sameType(a.key, (b as { key: RT }).key) && sameType(a.val, (b as { val: RT }).val);
    case 'option':
      return sameType(a.inner, (b as { inner: RT }).inner);
    default:
      return true;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Crate
// ─────────────────────────────────────────────────────────────────────

function emitCrate(speck: IRSpeck, invariants: InvariantMemberNode[]): string {
  const ctx = new Ctx(speck);
  const behavior = speck.facets.behavior;

  // Resolve every signature type up front so inline records and opaque
  // placeholders are known before the type section is written.
  for (const [name, fields] of [...ctx.records]) for (const f of fields) ctx.fieldType(name, f);
  for (const [name, fields] of ctx.events) for (const f of fields) ctx.resolve(f.type, `${name}${pascal(f.name)}`);
  for (const a of behavior.actions) for (const p of a.params) ctx.resolve(p.type, `${a.name}${pascal(p.name)}`);

  // Method names: invariants first so verify blocks can call them.
  const methodNames = new Set<string>(['new']);
  for (const a of behavior.actions) methodNames.add(fieldIdent(a.name));
  const uniqueMethod = (base: string) => {
    let n = base;
    for (let i = 2; methodNames.has(n); i++) n = `${base}_${i}`;
    methodNames.add(n);
    return n;
  };
  for (const inv of invariants) ctx.invariants.set(inv.name, uniqueMethod(`check_${snake(inv.name)}`));

  const sections: string[] = [];
  sections.push(header(speck.name));
  for (const [name, variants] of ctx.enums) sections.push(emitEnum(name, variants));

  const actions = behavior.actions.map((a) => emitAction(ctx, a));
  const ctor = emitConstructor(ctx);
  const checks = [
    ...invariants.map((inv) => emitPredicate(
      ctx, ctx.invariants.get(inv.name)!, `Invariant ${inv.name}: ${oneLine(inv.expr)}`,
      parseStringToIRExpr(inv.expr), oneLine(inv.expr),
    )),
    ...speck.facets.formal_spec.constraints.map((c, i) => emitPredicate(
      ctx, uniqueMethod(`check_invariant_${i + 1}`),
      `Constraint${c.name ? ` ${oneLine(c.name)}` : ''}: ${exprSource(c.expr)}`, c.expr, exprSource(c.expr),
    )),
  ];
  const verifies = speck.facets.formal_spec.verifies.map((v, i) => emitVerify(ctx, v.name, v.temporalExpr, uniqueMethod(`verify_${i + 1}`)));

  // Types last-resolved during expression translation are included too.
  for (const [name, fields] of ctx.records) sections.push(emitRecord(ctx, name, fields));
  for (const [name, why] of ctx.opaque) sections.push(emitOpaque(name, why));
  sections.push(emitEvents(ctx));
  sections.push(emitMachineStruct(ctx));
  sections.push(`impl ${ctx.machine} {\n${ctor}\n}`);
  if (actions.length > 0) sections.push(`// Actions: each returns Err when a guard, precondition or postcondition fails.\nimpl ${ctx.machine} {\n${actions.join('\n\n')}\n}`);
  if (checks.length > 0) sections.push(`// Invariants and constraints\nimpl ${ctx.machine} {\n${checks.join('\n\n')}\n}`);
  if (verifies.length > 0) sections.push(`// Temporal properties, checked on the current state\nimpl ${ctx.machine} {\n${verifies.join('\n\n')}\n}`);
  return sections.join('\n\n') + '\n';
}

function header(speckName: string): string {
  return `// Auto-generated by speckl-compile from ${oneLine(speckName)}
// DO NOT EDIT MANUALLY — regenerate from .speckdl source
//
// Anything the generator could not translate fails closed: an action
// returns Err("SPECKL-UNTRANSLATED: ...") before touching state, and an
// untranslated init, invariant or property panics when evaluated.
#![allow(dead_code, unused, unreachable_code, unused_mut, unused_comparisons, non_camel_case_types, non_snake_case)]

use std::collections::{HashMap, HashSet};

/// Spec source this target could not translate. Evaluating it panics.
fn speckl_untranslated(source: &str) -> ! {
    panic!("SPECKL-UNTRANSLATED: {}", source)
}

/// now(): Unix time in seconds.
fn speckl_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}`;
}

function emitEnum(name: string, variants: string[]): string {
  const ty = typeIdent(name);
  if (variants.length === 0) {
    return `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum ${ty} {}\n\nimpl std::fmt::Display for ${ty} {\n    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        match *self {}\n    }\n}`;
  }
  const lines = variants.map((v, i) => `${i === 0 ? '    #[default]\n' : ''}    ${variantIdent(v)},`).join('\n');
  const arms = variants.map((v) => `            ${ty}::${variantIdent(v)} => write!(f, "${rustString(snake(v) || v)}"),`).join('\n');
  return `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]\npub enum ${ty} {\n${lines}\n}\n\n` +
    `impl std::fmt::Display for ${ty} {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        match self {\n${arms}\n        }\n    }\n}`;
}

function emitRecord(ctx: Ctx, name: string, fields: IRFieldDef[]): string {
  const t: RT = { k: 'record', name };
  const derives = ['Debug', 'Clone', 'Default', ...(ctx.comparable(t) ? ['PartialEq'] : []), ...(ctx.hashable(t) ? ['Eq', 'Hash'] : [])];
  const body = fields.map((f) => `    pub ${fieldIdent(f.name)}: ${ctx.rust(ctx.fieldType(name, f))},`).join('\n');
  return `#[derive(${derives.join(', ')})]\npub struct ${typeIdent(name)} {\n${body}\n}`;
}

function emitOpaque(name: string, why: string): string {
  return `/// SPECKL-UNRESOLVED: ${oneLine(why)}.\n/// Generated code cannot construct values of this placeholder.\n` +
    `#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]\npub struct ${name}(());`;
}

function emitEvents(ctx: Ctx): string {
  let allComparable = true;
  const structs = [...ctx.events].map(([name, fields]) => {
    const types = fields.map((f) => ctx.resolve(f.type, `${name}${pascal(f.name)}`));
    const comparable = types.every((t) => ctx.comparable(t));
    if (!comparable) allComparable = false;
    const body = fields.map((f, i) => `        pub ${fieldIdent(f.name)}: ${ctx.rust(types[i])},`).join('\n');
    return `    #[derive(Debug, Clone${comparable ? ', PartialEq' : ''})]\n    pub struct ${typeIdent(name)} {\n${body}\n    }`;
  });
  const variants = [...ctx.events.keys()].map((n) => `    ${typeIdent(n)}(events::${typeIdent(n)}),`).join('\n');
  return `/// Event payloads (a module of their own, so their names cannot clash with types).\npub mod events {\n    use super::*;\n${structs.length ? '\n' + structs.join('\n\n') + '\n' : ''}}\n\n` +
    `/// Every event the machine can record in its decision log.\n#[derive(Debug, Clone${allComparable ? ', PartialEq' : ''})]\npub enum ${ctx.eventEnum} {\n${variants}\n}`;
}

function emitMachineStruct(ctx: Ctx): string {
  const fields = [...ctx.stateVars].map(([n, t]) => `    pub ${fieldIdent(n)}: ${ctx.rust(t)},`).join('\n');
  return `/// Speck state machine: ${oneLine(ctx.speck.name)}\n#[derive(Debug, Clone)]\npub struct ${ctx.machine} {\n${fields ? fields + '\n' : ''}` +
    `    /// Events emitted so far, in order.\n    pub decision_log: Vec<${ctx.eventEnum}>,\n}`;
}

function emitConstructor(ctx: Ctx): string {
  const init = ctx.speck.facets.behavior.init;
  const fieldValues = new Map<string, string>();
  const later: string[] = [];
  const failures: string[] = [];
  for (const a of init) {
    const t = ctx.stateVars.get(a.target);
    const src = `init ${a.target} := ${exprSource(a.expr)}`;
    if (!t) { failures.push(src); continue; }
    const env = new Env(ctx, 'm');
    const v = translate(a.expr, env, t);
    const code = v ? coerce(v, t, ctx) : null;
    if (code === null) { failures.push(src); continue; }
    if (env.touchedState || later.length > 0) later.push(`        m.${fieldIdent(a.target)} = ${code};`);
    else fieldValues.set(a.target, code);
  }
  const fields = [...ctx.stateVars].map(([n, t]) => `            ${fieldIdent(n)}: ${fieldValues.get(n) ?? defaultValue(ctx, t)},`);
  const lines: string[] = [];
  if (failures.length > 0) {
    lines.push(...failures.map((f) => `        // SPECKL-UNTRANSLATED: ${oneLine(f)}`));
    lines.push(`        speckl_untranslated("${rustString(`${ctx.speck.name} init: ${failures.length} untranslated assignment${failures.length === 1 ? '' : 's'}, first: ${oneLine(failures[0])}`)}");`);
  }
  lines.push(`        let mut m = Self {\n${fields.join('\n')}${fields.length ? '\n' : ''}            decision_log: Vec::new(),\n        };`);
  lines.push(...later);
  lines.push('        m');
  return `    /// A machine in its initial state.\n    pub fn new() -> Self {\n${lines.join('\n')}\n    }`;
}

/** The value a state variable starts with when init does not set it. */
function defaultValue(ctx: Ctx, t: RT): string {
  switch (t.k) {
    case 'bool': return 'false';
    case 'u64': case 'i64': return `0${t.k}`;
    case 'f64': return '0.0_f64';
    case 'string': return 'String::new()';
    case 'option': return 'None';
    case 'list': return `Vec::<${ctx.rust(t.elem)}>::new()`;
    case 'set': return `HashSet::<${ctx.rust(t.elem)}>::new()`;
    case 'map': return `HashMap::<${ctx.rust(t.key)}, ${ctx.rust(t.val)}>::new()`;
    default: return 'Default::default()';
  }
}

/** A bool-valued check on the current state. */
function emitPredicate(ctx: Ctx, method: string, doc: string, expr: IRExpr, source: string): string {
  const env = new Env(ctx, 'self');
  const v = translate(expr, env, BOOL);
  const body = v && v.t.k === 'bool'
    ? `        ${v.code}`
    : `        speckl_untranslated("${rustString(oneLine(source))}")`;
  return `    /// ${oneLine(doc)}\n    pub fn ${method}(&self) -> bool {\n${body}\n    }`;
}

function emitVerify(ctx: Ctx, name: string, expr: IRExpr, method: string): string {
  const src = exprSource(expr);
  let inner: IRExpr | undefined;
  if (expr.kind === 'call' && /^always$/i.test(expr.fn) && expr.args.length === 1) inner = expr.args[0];
  const doc = `Property ${name}: ${src}${inner ? ' (the state predicate, on the current state)' : ''}`;
  // eventually(p) and other temporal forms cannot be checked on one state.
  return emitPredicate(ctx, method, doc, inner ?? { kind: 'bool_lit', value: false, parseFailed: true, source: src }, src);
}

// ─────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────

class Env {
  locals = new Map<string, { rust: string; t: RT }>();
  postconditions: IRStmt[];
  failures: string[];
  /** Set when a translation read state (init values that read state run after the struct exists). */
  touchedState = false;
  usesOld = false;
  /** Return type, once known; undefined while discovering it. */
  returnType?: RT;
  discoveredReturn?: RT;

  constructor(readonly ctx: Ctx, readonly stateRef: string, readonly parent?: Env) {
    this.failures = parent ? parent.failures : [];
    this.postconditions = parent ? parent.postconditions : [];
    if (parent) {
      this.locals = new Map(parent.locals);
      this.returnType = parent.returnType;
    }
  }

  child(): Env {
    return new Env(this.ctx, this.stateRef, this);
  }

  root(): Env {
    return this.parent ? this.parent.root() : this;
  }

  declare(name: string, t: RT): string {
    const rust = localIdent(name);
    this.locals.set(name, { rust, t });
    return rust;
  }
}

function emitAction(ctx: Ctx, action: IRAction): string {
  const posts = action.statements.filter((s) => s.kind === 'postcondition');
  const body = action.statements.filter((s) => s.kind !== 'postcondition');
  const assigned = new Set<string>();
  const scan = (ss: IRStmt[]) => ss.forEach((s) => {
    if (s.kind === 'assign' && s.target) assigned.add(s.target);
    scan(s.thenBlock ?? []);
    scan(s.elseBlock ?? []);
  });
  scan(body);

  const run = (returnType: RT | undefined) => {
    const env = new Env(ctx, 'self');
    env.postconditions = posts;
    env.returnType = returnType;
    const params = action.params.map((p) => {
      const t = ctx.resolve(p.type, `${action.name}${pascal(p.name)}`);
      const rust = env.declare(p.name, t);
      return `${assigned.has(p.name) ? 'mut ' : ''}${rust}: ${ctx.rust(t)}`;
    });
    const out = stmtsToRust(body, env, '        ', true);
    return { env, params, lines: out.lines, returned: out.returned };
  };

  // First pass finds the return type (the first translatable return).
  const probe = run(undefined);
  const returnType: RT = probe.env.discoveredReturn ?? { k: 'nil' };
  const { env, params, lines, returned } = run(returnType);
  const unit = returnType.k === 'nil';
  const rustRet = unit ? '()' : ctx.rust(returnType);

  if (!returned) {
    lines.push(unit ? '        Ok(())' : `        Err("${rustString(`${action.name} ended without returning a value`)}".to_string())`);
  }
  if (env.usesOld) lines.unshift('        let old_state = self.clone();');
  if (env.failures.length > 0) {
    const n = env.failures.length;
    const msg = `SPECKL-UNTRANSLATED: ${action.name}: ${n} untranslated statement${n === 1 ? '' : 's'}, first: ${env.failures[0]}`;
    lines.unshift(
      '        // This action cannot run until every statement below is translated.',
      `        return Err("${rustString(msg)}".to_string());`,
    );
  }
  const doc = action.doc ? oneLine(action.doc) : `Action ${action.name}.`;
  return `    /// ${doc}\n    pub fn ${fieldIdent(action.name)}(&mut self${params.length ? ', ' + params.join(', ') : ''}) -> Result<${rustRet}, String> {\n${lines.join('\n')}\n    }`;
}

function stmtsToRust(stmts: IRStmt[], env: Env, indent: string, topLevel = false): { lines: string[]; returned: boolean } {
  const lines: string[] = [];
  for (const stmt of stmts) {
    const r = stmtToRust(stmt, env, indent);
    lines.push(r.code);
    // Anything after a return in the same block is unreachable.
    if (r.returns) return { lines, returned: true };
  }
  if (topLevel) lines.push(...postconditionLines(env, indent));
  return { lines, returned: false };
}

function postconditionLines(env: Env, indent: string): string[] {
  return env.postconditions.map((s) => {
    const src = exprSource(s.value ?? s.expr);
    const c = translate(s.value ?? s.expr, env, BOOL);
    if (!c || c.t.k !== 'bool') return untranslatedStmt(`postcondition: ${src}`, indent, env);
    return `${indent}// postcondition: ${oneLine(src)}\n${indent}if !(${c.code}) {\n${indent}    return Err("${rustString(`Postcondition failed: ${src}`)}".to_string());\n${indent}}`;
  });
}

function untranslatedStmt(source: string, indent: string, env: Env): string {
  const text = oneLine(source);
  env.failures.push(text);
  return `${indent}// SPECKL-UNTRANSLATED: ${text}`;
}

function stmtToRust(stmt: IRStmt, env: Env, indent: string): { code: string; returns?: boolean } {
  const ctx = env.ctx;
  const fail = () => ({ code: untranslatedStmt(stmtSource(stmt), indent, env) });
  const value = stmt.value ?? stmt.expr;

  switch (stmt.kind) {
    case 'assign': {
      if (!value || !stmt.target) return fail();
      if (stmt.target.endsWith('[...]')) {
        const base = lookupName(stmt.target.slice(0, -5), env);
        if (!base || !stmt.targetIndex) return fail();
        if (base.t.k === 'map' && ctx.hashable(base.t.key)) {
          const k = translate(stmt.targetIndex, env, base.t.key);
          const v = translate(value, env, base.t.val);
          const kc = k && coerce(k, base.t.key, ctx);
          const vc = v && coerce(v, base.t.val, ctx);
          if (kc == null || vc == null) return fail();
          return { code: `${indent}${base.code}.insert(${kc}, ${vc});` };
        }
        if (base.t.k === 'list') {
          const i = translate(stmt.targetIndex, env, U64);
          const v = translate(value, env, base.t.elem);
          const vc = v && coerce(v, base.t.elem, ctx);
          if (!i || !isNum(i.t) || i.t.k === 'f64' || vc == null) return fail();
          return { code: `${indent}${base.code}[(${i.code}) as usize] = ${vc};` };
        }
        return fail();
      }
      // `this.x := v` assigns the state variable x, even if a local is named x.
      const target = /^this\.\w+$/.test(stmt.target)
        ? lookupName(stmt.target.slice(5), new Env(ctx, env.stateRef))
        : lookupName(stmt.target, env);
      if (!target) return fail();
      const v = translate(value, env, target.t);
      const code = v && coerce(v, target.t, ctx);
      if (code == null) return fail();
      return { code: `${indent}${target.code} = ${code};` };
    }
    case 'let': {
      if (!value || !stmt.letName) return fail();
      const v = translate(value, env);
      if (!v || v.t.k === 'nil') return fail();
      const t: RT = v.t.k === 'intlit' ? I64 : v.t;
      const code = coerce(v, t, ctx);
      if (code == null) return fail();
      const rust = env.declare(stmt.letName, t);
      return { code: `${indent}let mut ${rust}: ${ctx.rust(t)} = ${code};` };
    }
    case 'require':
    case 'precondition': {
      const c = translate(value, env, BOOL);
      if (!c || c.t.k !== 'bool') return fail();
      const src = exprSource(value);
      const label = stmt.kind === 'require' ? 'Guard failed' : 'Precondition failed';
      return { code: `${indent}// ${stmt.kind}: ${oneLine(src)}\n${indent}if !(${c.code}) {\n${indent}    return Err("${rustString(`${label}: ${src}`)}".to_string());\n${indent}}` };
    }
    case 'emit': {
      const fields = stmt.event ? ctx.events.get(stmt.event) : undefined;
      if (!fields || !stmt.event) return fail();
      const given = new Map((stmt.fields ?? []).map((f) => [f.name, f.value]));
      if ([...given.keys()].some((k) => !fields.some((f) => f.name === k))) return fail();
      const inits: string[] = [];
      for (const f of fields) {
        const ft = ctx.resolve(f.type, `${stmt.event}${pascal(f.name)}`);
        const g = given.get(f.name);
        const v = g ? translate(g, env, ft) : null;
        const code = v && coerce(v, ft, ctx);
        if (code == null) return fail();
        inits.push(`${fieldIdent(f.name)}: ${code}`);
      }
      const ev = typeIdent(stmt.event);
      return { code: `${indent}// emit ${oneLine(stmt.event)}\n${indent}${env.stateRef}.decision_log.push(${ctx.eventEnum}::${ev}(events::${ev} { ${inits.join(', ')} }));` };
    }
    case 'return': {
      const root = env.root();
      let valueCode = '()';
      if (value) {
        const v = translate(value, env, env.returnType && env.returnType.k !== 'nil' ? env.returnType : undefined);
        if (!v || v.t.k === 'nil') return fail();
        const t: RT = v.t.k === 'intlit' ? I64 : v.t;
        if (!env.returnType) {
          if (!root.discoveredReturn) root.discoveredReturn = t;
          valueCode = coerce(v, root.discoveredReturn, ctx) ?? '()';
        } else {
          if (env.returnType.k === 'nil') return fail();
          const c = coerce(v, env.returnType, ctx);
          if (c == null) return fail();
          valueCode = c;
        }
      } else if (env.returnType && env.returnType.k !== 'nil') {
        return fail();
      }
      const posts = postconditionLines(env, indent + '    ');
      const retTy = env.returnType && env.returnType.k !== 'nil' ? `: ${ctx.rust(env.returnType)}` : '';
      return {
        code: `${indent}{\n${indent}    let result${retTy} = ${valueCode};\n${posts.length ? posts.join('\n') + '\n' : ''}${indent}    return Ok(result);\n${indent}}`,
        returns: true,
      };
    }
    case 'if': {
      if (!value) return fail();
      const c = translate(value, env, BOOL);
      if (!c || c.t.k !== 'bool') return fail();
      const inner = indent + '    ';
      const thenLines = stmtsToRust(stmt.thenBlock ?? [], env.child(), inner).lines;
      let code = `${indent}if ${c.code} {\n${thenLines.join('\n')}\n${indent}}`;
      if (stmt.elseBlock && stmt.elseBlock.length > 0) {
        const elseLines = stmtsToRust(stmt.elseBlock, env.child(), inner).lines;
        code += ` else {\n${elseLines.join('\n')}\n${indent}}`;
      }
      return { code };
    }
    default:
      return fail();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────

/**
 * A translated expression. `place` marks a readable location (a field, a
 * local, an index) that must be cloned to be used by value; `lit` marks a
 * bare integer literal.
 */
type TExpr = { code: string; t: RT; place?: boolean; lit?: boolean };

/** Owned Rust code for v as a value of type `target`, or null if it does not fit. */
function coerce(v: TExpr, target: RT, ctx: Ctx): string | null {
  const owned = () => (v.place && !isCopy(v.t) ? `${v.code}.clone()` : v.code);
  if (target.k === 'option') {
    if (v.t.k === 'nil') return 'None';
    if (v.t.k === 'option') return sameType(v.t, target) ? owned() : null;
    const inner = coerce(v, target.inner, ctx);
    return inner == null ? null : `Some(${inner})`;
  }
  if (sameType(v.t, target)) return owned();
  if (v.t.k === 'intlit') {
    if (target.k === 'u64' || target.k === 'i64' || target.k === 'f64') {
      return v.lit ? `${v.code}${target.k}` : `((${v.code}) as ${target.k})`;
    }
    return null;
  }
  if (v.t.k === 'u64' && target.k === 'i64') return `(${v.code} as i64)`;
  if ((v.t.k === 'u64' || v.t.k === 'i64') && target.k === 'f64') return `(${v.code} as f64)`;
  // A negative Int stored into a Nat is a spec violation: fail closed.
  if (v.t.k === 'i64' && target.k === 'u64') return `u64::try_from(${v.code}).expect("negative value for a Nat")`;
  return null;
}

/** A borrow of v as a `&target` argument (lookups), without cloning a place. */
function borrow(v: TExpr, target: RT, ctx: Ctx): string | null {
  if (v.place && sameType(v.t, target)) return `&${v.code}`;
  const c = coerce(v, target, ctx);
  return c == null ? null : `&${parenIfNeeded(c)}`;
}

function lookupName(name: string, env: Env): TExpr | null {
  const local = env.locals.get(name);
  if (local) return { code: local.rust, t: local.t, place: true };
  const st = env.ctx.stateVars.get(name);
  if (st) {
    env.root().touchedState = true;
    env.touchedState = true;
    return { code: `${env.stateRef}.${fieldIdent(name)}`, t: st, place: true };
  }
  return null;
}

/**
 * Translate an expression with its type, or return null when it has no
 * well-typed Rust form (the caller then fails closed). `expected` only
 * guides context-typed forms: empty collections, enum variants, nil.
 */
function translate(expr: IRExpr | undefined, env: Env, expected?: RT): TExpr | null {
  if (!expr || typeof expr !== 'object' || !expr.kind) return null;
  const ctx = env.ctx;
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) return null;
      return { code: String(expr.value), t: BOOL };
    case 'int_lit':
      if (!Number.isSafeInteger(expr.value)) return null;
      if (expected && (expected.k === 'u64' || expected.k === 'i64' || expected.k === 'f64')) {
        if (expected.k === 'u64' && expr.value < 0) return null;
        return { code: `${expr.value}${expected.k}`, t: expected };
      }
      return { code: String(expr.value), t: { k: 'intlit' }, lit: true };
    case 'float_lit': {
      if (!Number.isFinite(expr.value)) return null;
      const s = String(expr.value);
      return { code: /[.eE]/.test(s) ? `${s}_f64` : `${s}.0_f64`, t: F64 };
    }
    case 'string_lit':
      return { code: `String::from("${rustString(expr.value)}")`, t: STRING };
    case 'ident': {
      if (['nil', 'null', 'none', 'None'].includes(expr.name) && !lookupName(expr.name, env)) {
        return { code: 'None', t: { k: 'nil' } };
      }
      const n = lookupName(expr.name, env);
      if (n) return n;
      const owners = ctx.variants.get(expr.name);
      if (owners) {
        const exp = expected?.k === 'option' ? expected.inner : expected;
        const owner = exp?.k === 'enum' && owners.includes(exp.name) ? exp.name
          : owners.length === 1 ? owners[0] : undefined;
        if (owner) return { code: `${typeIdent(owner)}::${variantIdent(expr.name)}`, t: { k: 'enum', name: owner } };
      }
      // An invariant used as a predicate (verify blocks: Always(SomeInvariant)).
      const inv = ctx.invariants.get(expr.name);
      if (inv && env.stateRef === 'self') return { code: `self.${inv}()`, t: BOOL };
      return null;
    }
    case 'field': {
      if (expr.target.kind === 'ident' && expr.target.name === 'this') {
        return lookupName(expr.field, new Env(ctx, env.stateRef)) ?? null;
      }
      const target = translate(expr.target, env);
      if (!target) return null;
      if (target.t.k === 'record') {
        const ft = ctx.recordField(target.t.name, expr.field);
        return ft ? { code: `${target.code}.${fieldIdent(expr.field)}`, t: ft, place: true } : null;
      }
      if (target.t.k === 'map' && expr.field === 'keys' && ctx.hashable(target.t.key)) {
        return { code: `${target.code}.keys().cloned().collect::<HashSet<_>>()`, t: { k: 'set', elem: target.t.key } };
      }
      return null;
    }
    case 'index': {
      const target = translate(expr.target, env);
      if (!target) return null;
      if (target.t.k === 'map' && ctx.hashable(target.t.key)) {
        const k = translate(expr.index, env, target.t.key);
        const kc = k && borrow(k, target.t.key, ctx);
        if (kc == null) return null;
        // A missing key panics: reading an absent entry fails closed.
        return { code: `${target.code}[${kc}]`, t: target.t.val, place: true };
      }
      if (target.t.k === 'list') {
        const i = translate(expr.index, env, U64);
        if (!i || !isNum(i.t) || i.t.k === 'f64') return null;
        return { code: `${target.code}[(${i.code}) as usize]`, t: target.t.elem, place: true };
      }
      return null;
    }
    case 'unop': {
      const v = translate(expr.operand, env);
      if (!v) return null;
      if ((expr.op === '!' || expr.op === 'not') && v.t.k === 'bool') return { code: `(!${v.code})`, t: BOOL };
      if (expr.op === '-') {
        if (v.t.k === 'i64' || v.t.k === 'f64' || v.t.k === 'intlit') return { code: `(-${v.code})`, t: v.t };
        if (v.t.k === 'u64') return { code: `(-(${v.code} as i64))`, t: I64 };
      }
      return null;
    }
    case 'binop':
      return translateBinop(expr.op, expr.left, expr.right, env);
    case 'call':
      return translateCall(expr.fn, expr.args, env, expected);
  }
  return null;
}

/** The common numeric type of a and b. */
function numUnify(a: RT, b: RT): RT {
  if (a.k === 'f64' || b.k === 'f64') return F64;
  if (a.k === 'i64' || b.k === 'i64') return I64;
  if (a.k === 'u64' || b.k === 'u64') return U64;
  return { k: 'intlit' };
}

function numPair(l: TExpr, r: TExpr, ctx: Ctx): { l: string; r: string; t: RT } | null {
  const t = numUnify(l.t, r.t);
  if (t.k === 'intlit') return { l: l.code, r: r.code, t };
  const lc = coerce(l, t, ctx);
  const rc = coerce(r, t, ctx);
  return lc == null || rc == null ? null : { l: lc, r: rc, t };
}

function translateBinop(op: string, le: IRExpr, re: IRExpr, env: Env): TExpr | null {
  const ctx = env.ctx;
  if (op === 'in' || op === '!in' || op === 'notIn' || op === 'not in') {
    // x in m.keys is a key lookup, without building the key set.
    const keysOf = re.kind === 'field' && re.field === 'keys' ? translate(re.target, env) : null;
    const coll = keysOf?.t.k === 'map' ? keysOf : translate(re, env);
    if (!coll) return null;
    const elemT = coll.t.k === 'map' ? coll.t.key : coll.t.k === 'list' || coll.t.k === 'set' ? coll.t.elem : null;
    if (!elemT || (coll.t.k !== 'list' && !ctx.hashable(elemT))) return null;
    if (coll.t.k === 'list' && !ctx.comparable(elemT)) return null;
    const item = translate(le, env, elemT);
    const ic = item && borrow(item, elemT, ctx);
    if (ic == null) return null;
    const code = `${coll.code}.${coll.t.k === 'map' ? 'contains_key' : 'contains'}(${ic})`;
    return { code: op === 'in' ? code : `(!${code})`, t: BOOL };
  }

  const l0 = translate(le, env);
  const r = translate(re, env, l0?.t);
  const l = l0 ?? (r ? translate(le, env, r.t) : null);
  if (!l || !r) return null;
  const L = l.t;
  const R = r.t;

  switch (op) {
    case '&&': case 'and': case '||': case 'or':
      if (L.k !== 'bool' || R.k !== 'bool') return null;
      return { code: `(${l.code} ${op === '&&' || op === 'and' ? '&&' : '||'} ${r.code})`, t: BOOL };
    case 'implies': case '=>':
      if (L.k !== 'bool' || R.k !== 'bool') return null;
      return { code: `(!${l.code} || ${r.code})`, t: BOOL };
    case '+': {
      if (isNum(L) && isNum(R)) {
        const p = numPair(l, r, ctx);
        return p && { code: `(${p.l} + ${p.r})`, t: p.t };
      }
      const showable = (t: RT) => t.k === 'string' || t.k === 'enum' || t.k === 'bool' || isNum(t);
      if ((L.k === 'string' || R.k === 'string') && showable(L) && showable(R)) {
        return { code: `format!("{}{}", ${l.code}, ${r.code})`, t: STRING };
      }
      return null;
    }
    case '-': case '*': case '/': case '%': {
      if (!isNum(L) || !isNum(R)) return null;
      const p = numPair(l, r, ctx);
      return p && { code: `(${p.l} ${op} ${p.r})`, t: p.t };
    }
    case '<': case '<=': case '>': case '>=': {
      if (isNum(L) && isNum(R)) {
        const p = numPair(l, r, ctx);
        return p && { code: `(${p.l} ${op} ${p.r})`, t: BOOL };
      }
      if (L.k === 'string' && R.k === 'string') return { code: `(${l.code} ${op} ${r.code})`, t: BOOL };
      return null;
    }
    case '==': case '!=': {
      const neg = op === '!=';
      if (isNum(L) && isNum(R)) {
        const p = numPair(l, r, ctx);
        return p && { code: `(${p.l} ${op} ${p.r})`, t: BOOL };
      }
      // nil comparisons
      if (L.k === 'nil' || R.k === 'nil') {
        const other = L.k === 'nil' ? r : l;
        if (other.t.k !== 'option') return null;
        return { code: `${other.code}.${neg ? 'is_some' : 'is_none'}()`, t: BOOL };
      }
      if (L.k === 'option' && R.k !== 'option') {
        if (!ctx.comparable(L)) return null;
        const c = coerce(r, L, ctx);
        return c == null ? null : { code: `(${l.code} ${op} ${c})`, t: BOOL };
      }
      if (R.k === 'option' && L.k !== 'option') {
        if (!ctx.comparable(R)) return null;
        const c = coerce(l, R, ctx);
        return c == null ? null : { code: `(${c} ${op} ${r.code})`, t: BOOL };
      }
      if (!sameType(L, R) || !ctx.comparable(L)) return null;
      return { code: `(${l.code} ${op} ${r.code})`, t: BOOL };
    }
    default:
      // union, diff, intersect and other set algebra have no translation yet.
      return null;
  }
}

function translateCall(fn: string, argExprs: IRExpr[], env: Env, expected?: RT): TExpr | null {
  const ctx = env.ctx;
  if (['emptySet', 'emptyMap', 'emptyList', 'empty'].includes(fn)) {
    if (!expected || argExprs.length > 0) return null;
    const fits = fn === 'empty' || (fn === 'emptyMap' ? expected.k === 'map' : expected.k === 'list' || expected.k === 'set');
    if (!fits) return null;
    // Turbofish types, so the empty value is typed even where nothing else infers it.
    const ctor = expected.k === 'list' ? `Vec::<${ctx.rust(expected.elem)}>::new()`
      : expected.k === 'set' ? `HashSet::<${ctx.rust(expected.elem)}>::new()`
      : expected.k === 'map' ? `HashMap::<${ctx.rust(expected.key)}, ${ctx.rust(expected.val)}>::new()` : null;
    return ctor ? { code: ctor, t: expected } : null;
  }
  if (fn === 'now' && argExprs.length === 0) return { code: 'speckl_now()', t: U64 };
  if (fn === 'old' && argExprs.length === 1) {
    if (env.stateRef !== 'self') return null;
    const oldEnv = new Env(ctx, 'old_state');
    const v = translate(argExprs[0], oldEnv, expected);
    if (!v) return null;
    env.root().usesOld = true;
    return v;
  }
  if (/^always$/i.test(fn) && argExprs.length === 1 && env.stateRef === 'self') {
    // Inside a state predicate, always(p) is p on the current state.
    const v = translate(argExprs[0], env, BOOL);
    return v && v.t.k === 'bool' ? v : null;
  }
  const args: TExpr[] = [];
  for (const a of argExprs) {
    const v = translate(a, env);
    if (!v) return null;
    args.push(v);
  }
  const [a, b] = args;
  switch (fn) {
    case 'length': case 'len': case 'size': case 'count':
      if (args.length !== 1) return null;
      if (a.t.k === 'list' || a.t.k === 'set' || a.t.k === 'map' || a.t.k === 'bytes') return { code: `(${a.code}.len() as u64)`, t: U64 };
      if (a.t.k === 'string') return { code: `(${a.code}.chars().count() as u64)`, t: U64 };
      return null;
    case 'has': {
      if (args.length !== 2 || a.t.k !== 'map' || !ctx.hashable(a.t.key)) return null;
      const k = borrow(translate(argExprs[1], env, a.t.key) ?? b, a.t.key, ctx);
      return k == null ? null : { code: `${a.code}.contains_key(${k})`, t: BOOL };
    }
    case 'contains': {
      if (args.length !== 2) return null;
      if ((a.t.k === 'list' && ctx.comparable(a.t.elem)) || (a.t.k === 'set' && ctx.hashable(a.t.elem))) {
        const x = borrow(translate(argExprs[1], env, a.t.elem) ?? b, a.t.elem, ctx);
        return x == null ? null : { code: `${a.code}.contains(${x})`, t: BOOL };
      }
      if (a.t.k === 'string' && b.t.k === 'string') return { code: `${a.code}.contains(${b.code}.as_str())`, t: BOOL };
      return null;
    }
    case 'implies':
      if (args.length !== 2 || a.t.k !== 'bool' || b.t.k !== 'bool') return null;
      return { code: `(!${a.code} || ${b.code})`, t: BOOL };
    case 'min': case 'max': {
      if (args.length !== 2 || !isNum(a.t) || !isNum(b.t)) return null;
      const p = numPair(a, b, ctx);
      if (!p) return null;
      if (p.t.k === 'f64') return { code: `${p.l}.${fn}(${p.r})`, t: F64 };
      if (p.t.k === 'intlit') return null;
      return { code: `std::cmp::${fn}(${p.l}, ${p.r})`, t: p.t };
    }
    case 'append': {
      if (args.length !== 2 || a.t.k !== 'list') return null;
      const base = coerce(a, a.t, ctx)!;
      if (sameType(b.t, a.t)) return { code: `{ let mut v = ${base}; v.extend(${coerce(b, b.t, ctx)}); v }`, t: a.t };
      const item = coerce(translate(argExprs[1], env, a.t.elem) ?? b, a.t.elem, ctx);
      if (item == null) return null;
      return { code: `{ let mut v = ${base}; v.push(${item}); v }`, t: a.t };
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Source rendering (for messages and comments)
// ─────────────────────────────────────────────────────────────────────

function exprSource(expr: IRExpr | undefined): string {
  if (!expr || typeof expr !== 'object' || !expr.kind) return '<unknown expression>';
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) return expr.source ?? '<unknown expression>';
      return String(expr.value);
    case 'int_lit': case 'float_lit':
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
      return `${expr.op}${exprSource(expr.operand)}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(exprSource).join(', ')})`;
  }
  return '<unknown expression>';
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
      return `emit ${stmt.event}(${(stmt.fields ?? []).map((f) => `${f.name}: ${exprSource(f.value)}`).join(', ')})`;
    case 'return':
      return v ? `return ${exprSource(v)}` : 'return';
    case 'if':
      return `if ${exprSource(v)} { ... }`;
    default:
      return `${stmt.kind} ${exprSource(v)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Names and strings
// ─────────────────────────────────────────────────────────────────────

const RUST_KEYWORDS = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if',
  'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async',
  'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof',
  'unsized', 'virtual', 'yield', 'try', 'gen',
]);
/** Keywords that cannot be raw identifiers. */
const NOT_RAW = new Set(['crate', 'self', 'Self', 'super', '_']);

function sanitize(s: string): string {
  let out = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (!out || /^\d/.test(out)) out = `_${out}`;
  return out;
}

function keywordSafe(s: string): string {
  if (!RUST_KEYWORDS.has(s) && s !== '_') return s;
  return NOT_RAW.has(s) ? `${s}_` : `r#${s}`;
}

/** A struct field or method name: snake_case, keyword-safe. */
function fieldIdent(name: string): string {
  return keywordSafe(sanitize(snake(name) || name));
}

/** A local variable or parameter name. */
function localIdent(name: string): string {
  const id = fieldIdent(name);
  // Names the generated code itself uses.
  return ['m', 'v', 'result', 'old_state'].includes(id) ? `${id}_` : id;
}

/** A type name (struct, enum). */
function typeIdent(name: string): string {
  return keywordSafe(sanitize(name));
}

function variantIdent(name: string): string {
  return keywordSafe(sanitize(name));
}

function snake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([a-zA-Z])(\d)/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function pascal(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
}

function crateName(speckName: string): string {
  return snake(speckName) || 'speck';
}

/** Contents of a Rust string literal. */
function rustString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function tomlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Single-line text, safe in a line comment. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parenIfNeeded(code: string): string {
  return /^[\w.:]+(\(\))?$/.test(code) ? code : `(${code})`;
}
