// src/generators/z3-from-ir.ts
//
// IR-driven Z3 SMT-LIB2 generator. Consumes the IR's `formal_spec` facet
// (constraints, verifies) and `behavior` facet (state vars, init, actions).
//
// This is a focused translator for the IR's typed expression trees. The
// AST-based z3.ts still exists for the state-machine + transition parts
// that depend on raw-source re-parsing. The IR-based version is
// preferred for formal_spec because it walks typed trees — no string
// re-parsing, no brittle regex matching.
//
// Architecture:
//   - State variables → Z3 sort declarations and const declarations
//   - Constraints → Z3 assert statements
//   - Verifies → bounded model checking with N copies of state
//   - Expressions → walk IRExpr tree, emit SMT-LIB2
//
// The IR's IRExpr variants (IRBoolLit, IRIntLit, IRStringLit, IRIdent,
// IRBinOp, IRUnOp, IRCall, IRFieldAccess, IRIndexExpr) are translated
// directly. No string manipulation.

import * as fs from 'fs';
import * as path from 'path';
import { sanitizeSMT } from './smt-sanitize.js';
import {
  IR, IRSpeck, IRConstraint, IRVerify, IRStateVar, IRExpr, IRBinOp,
  IRFieldDef, IRTypeRef, IRBoolLit
} from '../ir/types.js';

export interface Z3FromIROptions {
  verifyDepth: number;
  /** Output directory. */
  outputDir: string;
}

const DEFAULT_OPTIONS = { verifyDepth: 10 };

/**
 * Generate Z3 SMT-LIB2 from an IR, focusing on the formal_spec facet.
 * The output includes:
 *   - Sort declarations for state variables
 *   - Constant declarations for state variables
 *   - Init assertions
 *   - One assert per constraint (the "always holds" invariants)
 *   - Bounded model checking for verifies (unrolled N times)
 */
export function generateZ3FromIR(ir: IR, options: Partial<Z3FromIROptions> = {}): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!opts.outputDir) {
    throw new Error('generateZ3FromIR requires outputDir');
  }

  for (const speck of ir.specks) {
    const raw = emitSMT(speck, opts.verifyDepth);
    const sanitized = sanitizeSMT(raw);
    const filename = path.join(opts.outputDir, `${speck.name}.ir.smt2`);
    fs.writeFileSync(filename, sanitized.text);
    if (sanitized.dropped.length > 0) {
      console.log(
        `  note: skipped ${sanitized.dropped.length} untranslatable form(s) in ${speck.name}.ir.smt2`
      );
    }
    console.log(`Generated Z3 (from IR): ${filename}`);
  }
}

/** True if the expression tree contains a parse-failure placeholder. */
function containsParseFailure(e: IRExpr): boolean {
  if (e.kind === 'bool_lit' && (e as IRBoolLit).parseFailed) return true;
  const kids: IRExpr[] = [];
  const node = e as unknown as Record<string, unknown>;
  for (const key of ['left', 'right', 'operand', 'target', 'index']) {
    if (node[key]) kids.push(node[key] as IRExpr);
  }
  if (node['args']) kids.push(...(node['args'] as IRExpr[]));
  return kids.some(containsParseFailure);
}

/** Collect all named (ident) type references in a type tree. */
function collectIdentTypeNames(t: IRTypeRef): string[] {
  const names: string[] = [];
  if (t.kind === 'ident' && t.name) {
    names.push(t.name);
  } else if (t.kind === 'list' || t.kind === 'set') {
    if (t.elementType) names.push(...collectIdentTypeNames(t.elementType));
  } else if (t.kind === 'map') {
    if (t.keyType) names.push(...collectIdentTypeNames(t.keyType));
    if (t.valueType) names.push(...collectIdentTypeNames(t.valueType));
  }
  return names;
}

function emitSMT(speck: IRSpeck, verifyDepth: number): string {
  const lines: string[] = [];
  lines.push(`; SMT-LIB2 generated from Speckl IR for ${speck.name}`);
  lines.push(`; Speckl v0.3 — IR-driven Z3 backend`);
  lines.push(';');

  // 1. Declare sorts for state variables and types
  lines.push('; --- Sorts ---');
  const stateVars = speck.facets.behavior.stateVars;

  const recordTypes = collectRecordTypes(speck);
  const knownRecordNames = new Set(recordTypes.keys());

  // Collect every named (ident) type referenced by state variables AND by
  // record fields — nested references like `Term` inside `LogEntry` need
  // declarations too. Non-record idents become uninterpreted sorts; garbage
  // (unparseable inline types) is left for the sanitizer to skip.
  const aliasNames = new Set<string>();
  const isBuiltinSort = (id: string) =>
    ['Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set', 'Nat', 'Integer'].includes(id);
  for (const v of stateVars) {
    for (const name of collectIdentTypeNames(v.type)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !knownRecordNames.has(name) && !isBuiltinSort(name)) {
        aliasNames.add(name);
      }
    }
  }
  for (const [, fields] of recordTypes) {
    for (const sortText of fields.values()) {
      for (const id of sortText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        if (!isBuiltinSort(id) && !knownRecordNames.has(id)) {
          aliasNames.add(id);
        }
      }
    }
  }

  // Declaration order matters: alias sorts must precede the datatypes that
  // reference them, and both must precede the constants that use them.
  // Datatypes may reference each other (BuildStep → EnvVar → EnvVarSource),
  // so emit them in dependency order: repeatedly emit datatypes whose field
  // sorts are all already declared.
  for (const name of aliasNames) {
    lines.push(`(declare-sort ${name} 0)`);
  }
  const knownSortNames = new Set<string>(['Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set', ...aliasNames]);
  // Collection constructor constants (X.empty sugar) — unconstrained Ints;
  // present so `Map.empty` / `List.empty` references resolve.
  lines.push('(declare-const speckl_empty_Map Int)');
  lines.push('(declare-const speckl_empty_List Int)');
  lines.push('(declare-const speckl_empty_Set Int)');
  const pending = [...recordTypes.entries()];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const [name, fields] = pending[i];
      const sortIds = [...fields.values()].flatMap(s => s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      const allKnown = sortIds.every(id => knownSortNames.has(id));
      if (!allKnown) continue;
      lines.push(`(declare-datatypes ((${name} 0)) ((${mkConstructor(name, fields)})))`);
      knownSortNames.add(name);
      pending.splice(i, 1);
      progress = true;
    }
  }
  // Datatypes with unresolvable dependencies — declare the missing sorts as
  // opaque, then emit; the sanitizer drops anything still invalid.
  const leftoverSorts = new Set<string>();
  for (const [, fields] of pending) {
    for (const sortText of fields.values()) {
      for (const id of sortText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        if (!['Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set', 'Nat', 'Integer'].includes(id) && !knownSortNames.has(id)) {
          leftoverSorts.add(id);
        }
      }
    }
  }
  for (const id of leftoverSorts) {
    lines.push(`(declare-sort ${id} 0)`);
    knownSortNames.add(id);
  }
  for (const [name, fields] of pending) {
    lines.push(`(declare-datatypes ((${name} 0)) ((${mkConstructor(name, fields)})))`);
  }
  for (const v of stateVars) {
    lines.push(`(declare-const ${v.name} ${z3Sort(v.type)})`);
  }

  // 2. Declarative specs (v0.2 style) have no state block — their constraints
  // range over input/output fields. Declare those as free constants so the
  // formal contract is checkable.
  const formal = speck.facets.formal_spec;
  const ioFields = [...formal.inputs, ...formal.outputs];
  if (ioFields.length > 0) {
    lines.push('');
    lines.push('; --- Inputs / Outputs (declarative spec free variables) ---');
    for (const f of ioFields) {
      lines.push(`(declare-const ${f.name} ${z3Sort(f.type)})`);
    }
  }

  lines.push('');

  // 3. Init assertions
  lines.push('; --- Init ---');
  for (const assign of speck.facets.behavior.init) {
    // Skip parse-failure placeholders (bool_lit false emitted by parseExprSafe
    // when the source expression couldn't be parsed — already reported as a
    // warning diagnostic). Asserting them would make the spec spuriously UNSAT.
    if (containsParseFailure(assign.expr)) {
      lines.push(`; skipped init ${assign.target}: expression failed to parse`);
      continue;
    }
    lines.push(`(assert (= ${assign.target} ${translateExpr(assign.expr)}))`);
  }

  lines.push('');

  // 4. Constraints (the "always holds" invariants)
  lines.push('; --- Invariants (formal_spec.constraints) ---');
  for (const c of speck.facets.formal_spec.constraints) {
    // Skip expressions containing parse-failure placeholders — asserting
    // them would make the spec spuriously UNSAT.
    if (containsParseFailure(c.expr)) {
      lines.push(`; skipped constraint: expression failed to parse`);
      continue;
    }
    const label = c.name ? ` ; ${c.name}` : '';
    lines.push(`(assert ${translateExpr(c.expr)})${label}`);
  }

  lines.push('');

  // 5. Verifies (bounded model checking)
  if (speck.facets.formal_spec.verifies.length > 0) {
    lines.push(`; --- Verifies (BMC, depth=${verifyDepth}) ---`);
    const declaredSteps = new Set<string>();
    for (const v of speck.facets.formal_spec.verifies) {
      emitBMC(lines, v, stateVars, verifyDepth, declaredSteps);
    }
  }

  // 6. Check sat
  lines.push('');
  lines.push('; --- Check ---');
  // Init + constraints + (degenerate, stuttering) BMC are asserted positively:
  // sat means the spec is internally consistent, unsat means contradictory
  // constraints (or a generator bug).
  lines.push('; speckl-expect: sat');
  lines.push('(check-sat)');
  lines.push('(get-model)');

  return lines.join('\n') + '\n';
}

/**
 * Emit bounded model checking for a verify block.
 * Unrolls the state machine to depth N and asserts the temporal property
 * must hold.
 */
function emitBMC(
  lines: string[],
  verify: IRVerify,
  stateVars: IRStateVar[],
  depth: number,
  declaredSteps: Set<string> = new Set()
): void {
  lines.push(`; verify "${verify.name}"`);
  for (let i = 0; i <= depth; i++) {
    // At each step, assert the postcondition of some action
    // (this is a simplified BMC — the full version would unroll
    // actions; here we just check the invariant holds at step i)
    for (const v of stateVars) {
      const prev = i > 0 ? `${v.name}_${i - 1}` : v.name;
      const curr = `${v.name}_${i}`;
      // Multiple verify blocks unroll the same steps — declare once.
      if (!declaredSteps.has(curr)) {
        declaredSteps.add(curr);
        lines.push(`(declare-const ${curr} ${z3Sort(v.type)})`);
      }
      // Frame: if not transitioning, state stays the same
      if (i > 0) {
        lines.push(`(assert (= ${prev} ${curr}))`);
      }
    }
  }
  // The verify property must hold at depth N
  const finalState = translateExpr(verify.temporalExpr).replace(
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g,
    (_match, name) => {
      if (stateVars.some((v) => v.name === name)) {
        return `${name}_${depth}`;
      }
      return name;
    }
  );
  lines.push(`(assert ${finalState})`);
}

/**
 * Translate an IR expression tree to SMT-LIB2 s-expression form.
 * Walks the tree directly — no string manipulation.
 */
function translateExpr(expr: IRExpr): string {
  switch (expr.kind) {
    case 'bool_lit':
      return expr.value ? 'true' : 'false';
    case 'int_lit':
      return String(expr.value);
    case 'float_lit':
      return String(expr.value);
    case 'string_lit':
      return `"${expr.value.replace(/"/g, '""')}"`;
    case 'ident':
      return expr.name;
    case 'field':
      // Field access — only valid on record sorts; emit as a select
      return `(select ${translateExpr(expr.target)} "${expr.field}")`;
    case 'index':
      return `(select ${translateExpr(expr.target)} ${translateExpr(expr.index)})`;
    case 'binop':
      return translateBinOp(expr);
    case 'unop':
      return translateUnOp(expr);
    case 'call':
      return translateCall(expr);
    default:
      return 'undefined';
  }
}

function translateBinOp(expr: IRBinOp): string {
  const op = expr.op;
  const l = translateExpr(expr.left);
  const r = translateExpr(expr.right);
  switch (op) {
    case '+': return `(+ ${l} ${r})`;
    case '-': return `(- ${l} ${r})`;
    case '*': return `(* ${l} ${r})`;
    case '/': return `(div ${l} ${r})`;
    case '%': return `(mod ${l} ${r})`;
    case '==': return `(= ${l} ${r})`;
    case '!=': return `(not (= ${l} ${r}))`;
    case '<': return `(< ${l} ${r})`;
    case '<=': return `(<= ${l} ${r})`;
    case '>': return `(> ${l} ${r})`;
    case '>=': return `(>= ${l} ${r})`;
    case '&&': return `(and ${l} ${r})`;
    case '||': return `(or ${l} ${r})`;
    case 'in': return `(contains ${r} ${l})`;
    default: return `(${op} ${l} ${r})`;
  }
}

function translateUnOp(expr: { op: string; operand: IRExpr }): string {
  const inner = translateExpr(expr.operand);
  switch (expr.op) {
    case '!': return `(not ${inner})`;
    case '-': return `(- ${inner})`;
    default: return `(${expr.op} ${inner})`;
  }
}

function translateCall(expr: { fn: string; args: IRExpr[] }): string {
  const args = expr.args.map(translateExpr).join(' ');
  return `(${expr.fn} ${args})`;
}

/**
 * Map an IR type to a Z3 sort.
 * Records → (Record name)
 * Lists → (Seq ElemType)
 * Maps → (Array KeyType ValueType)
 * Primitives → Int, Real, Bool, String
 */
function z3Sort(t: IRTypeRef): string {
  if (t.nullable) {
    // Optional<T> in SMT is (Option T) — for simplicity, lift the underlying
    return z3Sort({ ...t, nullable: false });
  }
  if (t.kind === 'primitive') {
    switch (t.primitive) {
      case 'String': return 'String';
      case 'Nat':
      case 'Int': return 'Int';
      case 'Real': return 'Real';
      case 'Bool': return 'Bool';
      case 'Bytes': return 'String';  // bytes as String
      case 'Date': return 'String';   // ISO 8601 as String
      default: return 'String';
    }
  }
  if (t.kind === 'list' || t.kind === 'set') {
    return `(Seq ${z3Sort(t.elementType || { kind: 'primitive', primitive: 'Unknown' })})`;
  }
  if (t.kind === 'map') {
    return `(Array ${z3Sort(t.keyType || { kind: 'primitive', primitive: 'String' })} ${z3Sort(t.valueType || { kind: 'primitive', primitive: 'Unknown' })})`;
  }
  if (t.kind === 'ident') {
    const name = t.name || 'Unknown';
    // Primitive-named idents (from unresolved unions) map to builtin sorts.
    if (name === 'Nat' || name === 'Integer') return 'Int';
    if (['Bool', 'Real', 'String'].includes(name)) return name;
    return name;
  }
  return 'Unknown';
}

/**
 * Collect record-type definitions from the IR for sort declarations.
 * Returns Map<typeName, Map<fieldName, fieldTypeStr>>
 */
function collectRecordTypes(speck: IRSpeck): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const [name, type] of speck.facets.typed_schema.types) {
    if (type.kind === 'record') {
      const fields = new Map<string, string>();
      for (const f of type.fields) {
        fields.set(f.name, z3Sort(f.type));
      }
      result.set(name, fields);
    }
  }
  return result;
}

function mkConstructor(name: string, fields: Map<string, string>): string {
  const parts: string[] = [`(mk-${name}`];
  for (const [fname, ftype] of fields) {
    // Qualify field names with the constructor name — datatype accessors share
    // a global namespace in SMT, and unqualified names like `totalDelay` would
    // collide with free constants of the same name (ambiguous reference).
    parts.push(`(${name}_${fname} ${ftype})`);
  }
  parts.push(')');
  return parts.join(' ');
}
