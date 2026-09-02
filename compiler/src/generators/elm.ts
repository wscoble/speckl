import { AST, SpeckNode, MemberNode, StateNode, ActionNode, ConstraintNode, EventNode } from '../parser.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate Elm from a SpeckDL spec.
 *
 * Outputs a complete Elm application under <outputDir>/<pkg>-elm/:
 *   - elm.json
 *   - src/Types.elm   — record aliases + JSON codecs derived from spec records
 *   - src/Prelude.elm — helpers (Nat keys, guards)
 *   - src/Machine.elm — pure state machine: Model from state vars, Msg from
 *                       actions, update with guards translated from `require`
 *                       exprs and transitions from assignments
 *   - src/Main.elm    — HTTP wiring to the compiled Go server (optimistic
 *                       update + refetch; server is source of truth)
 *   - index.html
 *
 * Behavior mapping (same spec that compiles to Go compiles to Elm):
 *   require exprs     → guard chain in update (client-side, immediate feedback)
 *   dict/list assigns → Dict.insert / record update / list prepend
 *   emits             → event log append (client-side mirror)
 * Guards the translator cannot express are left to the Go server (commented).
 *
 * Clean-room: generated from the SpeckDL specification only.
 */

// ─── naming ─────────────────────────────────────────────────────────

/** snake_case for HTTP routes (matches the Go generator's routes) */
function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** lowerCamelCase — Elm identifiers keep first letter lowercase */
function elmName(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9_]/g, '');
  return clean.charAt(0).toLowerCase() + clean.slice(1);
}

/** UpperCamelCase — Elm type/constructor names */
function ElmName(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9_]/g, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Go JSON field name for a record field (Go marshals exported Go field names) */
function goFieldName(s: string): string {
  return ElmName(s);
}

// ─── type mapping ───────────────────────────────────────────────────

function elmType(t: any, recordTypes: Map<string, any[]>): string {
  if (!t) return '()';
  if (t.type === 'primitive') {
    const n = (t.name || '').toLowerCase();
    if (n === 'string') return 'String';
    if (n === 'nat' || n === 'int' || n === 'integer') return 'Int';
    if (n === 'bool' || n === 'boolean') return 'Bool';
    if (n === 'float' || n === 'number') return 'Float';
    return 'String';
  }
  if (t.type === 'ident') {
    const raw = (t.name || '').replace(/\[\]/g, '');
    const lower = raw.toLowerCase();
    if (lower === 'string') return 'String';
    if (lower === 'nat' || lower === 'int' || lower === 'integer') return 'Int';
    if (lower === 'bool' || lower === 'boolean') return 'Bool';
    if (lower === 'float' || lower === 'number') return 'Float';
    // Map<K, V> ident form
    const mapMatch = raw.match(/^Map\s*<\s*(.+?)\s*,\s*(.+?)\s*>$/);
    if (mapMatch) {
      return `Dict.Dict String ${elmType({ type: 'ident', name: mapMatch[2] }, recordTypes)}`;
    }
    if (recordTypes.has(raw)) return ElmName(raw);
    return ElmName(raw);
  }
  if (t.type === 'list' || t.type === 'set') {
    const el = elmType(t.elementType, recordTypes);
    return t.type === 'set' ? `List ${el}` : `List ${el}`;
  }
  if (t.type === 'map') {
    const key = elmType(t.keyType, recordTypes) === 'Int' ? 'String' : elmType(t.keyType, recordTypes);
    return `Dict.Dict ${key} ${elmType(t.valueType, recordTypes)}`;
  }
  if (t.type === 'record') {
    return ElmName(t.name || 'Record');
  }
  return 'String';
}

/** Elm type for a Map state var: JSON keys are always strings */
function elmStateType(t: any, recordTypes: Map<string, any[]>): string {
  if (t?.type === 'map') {
    return `Dict.Dict String ${elmType(t.valueType, recordTypes)}`;
  }
  if (t?.type === 'ident') {
    const m = (t.name || '').match(/^Map\s*<\s*(.+?)\s*,\s*(.+?)\s*>$/);
    if (m) return `Dict.Dict String ${elmType({ type: 'ident', name: m[2] }, recordTypes)}`;
  }
  return elmType(t, recordTypes);
}

/** Elm type for action params (wire types, not state types) */
function elmParamType(t: any): string {
  if (!t) return 'String';
  if (t.type === 'primitive') {
    const n = (t.name || '').toLowerCase();
    if (n === 'string') return 'String';
    if (n === 'nat' || n === 'int' || n === 'integer') return 'Int';
    if (n === 'bool' || n === 'boolean') return 'Bool';
    if (n === 'float' || n === 'number') return 'Float';
    return 'String';
  }
  if (t.type === 'ident') {
    const lower = (t.name || '').toLowerCase();
    if (lower === 'string') return 'String';
    if (lower === 'nat' || lower === 'int' || lower === 'integer') return 'Int';
    if (lower === 'bool' || lower === 'boolean') return 'Bool';
    if (lower === 'float' || lower === 'number') return 'Float';
    return 'String';
  }
  return 'String';
}

// ─── expression translation (subset) ────────────────────────────────

/**
 * Translate a SpeckDL expression to Elm. Handles:
 *   ==, !=, >=, <=, >, <, or/and/||/&&, not, implies(a,b), in {...},
 *   x.has(k), length(x), string/number/bool literals, x[k].field,
 *   field access chains.
 * Returns null when the expression cannot be translated (caller falls back
 * to server-side enforcement).
 */
function translateExpr(expr: string, ctx: ExprCtx): string | null {
  let e = expr.trim();
  if (!e) return null;

  // implies(a, b) — balanced-paren split on top-level comma
  const impliesM = e.match(/^implies\s*\(/);
  if (impliesM) {
    const inner = e.slice(e.indexOf('(') + 1, e.lastIndexOf(')'));
    const parts = splitTopLevel(inner);
    if (parts.length === 2) {
      const a = translateExpr(parts[0], ctx);
      const b = translateExpr(parts[1], ctx);
      if (a && b) return `(if ${a} then ${b} else True)`;
    }
    return null;
  }

  // in { ... } — set membership of literals
  const inM = e.match(/^(.+?)\s+in\s+\{(.+)\}$/);
  if (inM) {
    const lhs = translateExpr(inM[1], ctx);
    if (lhs) {
      const lits = inM[2].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      return `List.member ${lhs} [${lits.map(l => `"${l}"`).join(', ')}]`;
    }
    return null;
  }

  // top-level or / and (word form)
  const orParts = splitWordOp(e, ' or ');
  if (orParts) {
    const l = translateExpr(orParts[0], ctx);
    const r = translateExpr(orParts[1], ctx);
    if (l && r) return `(${l} || ${r})`;
    return null;
  }
  const andParts = splitWordOp(e, ' and ');
  if (andParts) {
    const l = translateExpr(andParts[0], ctx);
    const r = translateExpr(andParts[1], ctx);
    if (l && r) return `(${l} && ${r})`;
    return null;
  }

  // binary comparisons (outside parens/strings, first match at top level)
  for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
    const parts = splitTopLevelOp(e, op);
    if (parts) {
      const l = translateExpr(parts[0], ctx);
      const r = translateExpr(parts[1], ctx);
      if (l && r) {
        const elOp = op === '!=' ? '/=' : op;
        return `(${l} ${elOp} ${r})`;
      }
      return null;
    }
  }

  // not X
  const notM = e.match(/^not\s+(.+)$/);
  if (notM) {
    const inner = translateExpr(notM[1], ctx);
    if (inner) return `(not ${inner})`;
    return null;
  }

  // length(x)
  const lenM = e.match(/^length\s*\(\s*(.+?)\s*\)$/);
  if (lenM) {
    const inner = lenM[1].trim();
    // strings → String.length; lists → List.length; decide by state/param type
    if (ctx.isStringVar(inner)) return `(String.length ${translateIdent(inner, ctx)})`;
    return `(List.length ${translateIdent(inner, ctx)})`;
  }

  // x.has(k) → Dict.member
  const hasM = e.match(/^(\w+)\.has\s*\(\s*(.+?)\s*\)$/);
  if (hasM) {
    const dict = elmName(hasM[1]);
    const key = translateKeyExpr(hasM[2].trim(), ctx);
    if (key) return `(Dict.member ${key} model.${dict})`;
    return null;
  }

  // x[k].field == ... handled by comparison; bare x[k].field → accessor chain
  const idxFieldM = e.match(/^(\w+)\[(.+?)\]\.(\w+)$/);
  if (idxFieldM) {
    return translateDictField(idxFieldM[1], idxFieldM[2], idxFieldM[3], ctx);
  }

  // literals first (true/false must not hit the ident branch)
  if (e === 'true') return 'True';
  if (e === 'false') return 'False';
  if (/^".*"$/.test(e)) return e;
  if (/^\d+(\.\d+)?$/.test(e)) return e;

  // bare identifier / param
  if (/^\w+$/.test(e)) {
    return translateIdent(e, ctx);
  }

  return null;
}

interface ExprCtx {
  isStringVar: (name: string) => boolean;
  natParams: Set<string>; // params of type Nat (need keyStr when used as map keys)
  mapVars: Set<string>;
}

function translateIdent(name: string, ctx: ExprCtx): string {
  return name; // action params and state vars share names with Elm bindings
}

/** map key: Nat params become strings via String.fromInt; strings stay */
function translateKeyExpr(expr: string, ctx: ExprCtx): string | null {
  const t = translateExpr(expr, ctx);
  if (!t) return null;
  if (/^\d+$/.test(expr)) return `"${expr}"`;
  if (ctx.natParams.has(expr.trim())) return `(String.fromInt ${t})`;
  return t;
}

/**
 * x[k].field in guard position. Elm needs a Maybe-aware lookup; we emit a
 * call to the generated helper `getField<Dict><Field>` produced per usage.
 * Simpler universal helper: `dictField x k .field default` — we instead emit
 * `maybeField model.x (key) .field` returning Maybe, and wrap comparisons
 * with `maybeEq`. To keep guards readable we emit:
 *   (fieldOf model.x key .field == Just "lit")  — no; use helper:
 *   (fieldEq model.cards key .column "FiguringItOut")
 */
function translateDictField(dictVar: string, keyExpr: string, field: string, ctx: ExprCtx): string | null {
  const key = translateKeyExpr(keyExpr, ctx);
  if (!key) return null;
  const dict = elmName(dictVar);
  const fty = fieldElmType(dictVar, field);
  const def = fty === 'Bool' ? 'False' : fty === 'Int' ? '0' : fty === 'Float' ? '0' : '\"\"';
  return `(Maybe.withDefault ${def} (fieldOf model.${dict} ${key} .${elmName(field)}))`;
}

// record field types for the current speck (module-level, set in generateElm)
let currentFieldTypes: Map<string, string> = new Map();

function fieldElmType(dictVar: string, field: string): string {
  // dictVar's record type: find a record whose Elm-ish name matches the singular
  // of dictVar (cards -> CardRecord) — we instead search all records for the field
  // and prefer the one whose lowercase name starts with the dict stem.
  const stem = dictVar.replace(/s$/, '');
  let best: string | undefined = undefined;
  for (const [recName, fields] of Object.entries(currentRecordFields)) {
    const fmap = fields as any;
    if (fmap[field] !== undefined) {
      if (recName.toLowerCase().startsWith(stem.toLowerCase())) {
        best = fmap[field];
        break;
      }
      if (best === undefined) best = fmap[field];
    }
  }
  return best || 'String';
}

// record name (original) -> field name -> Elm type
let currentRecordFields: Record<string, Record<string, string>> = {};

/** split on a top-level (outside parens/strings) word operator */
function splitWordOp(e: string, op: string): [string, string] | null {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < e.length - op.length + 1; i++) {
    const c = e[i];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && e.startsWith(op, i)) {
      return [e.slice(0, i).trim(), e.slice(i + op.length).trim()];
    }
  }
  return null;
}

/** split on a top-level symbol operator (first occurrence, left-assoc) */
function splitTopLevelOp(e: string, op: string): [string, string] | null {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < e.length - op.length + 1; i++) {
    const c = e[i];
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && e.startsWith(op, i)) {
      // avoid matching inside longer ops (>= vs >, == vs =)
      if (op === '>' && (e[i + 1] === '=' )) continue;
      if (op === '<' && (e[i + 1] === '=' )) continue;
      if (op === '=' ) continue;
      return [e.slice(0, i).trim(), e.slice(i + op.length).trim()];
    }
  }
  return null;
}

/** split on top-level commas */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const c of s) {
    if (c === '"') { inStr = !inStr; cur += c; continue; }
    if (inStr) { cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ─── statement translation ──────────────────────────────────────────

interface TranslatedAction {
  guardElm: string[];      // lines of guard code (Result chain)
  unhandledGuards: string[]; // require exprs left to the server
  bodyElm: string[];       // state transition lines
  unhandledBody: string[]; // statements the translator can't express
}

function translateAction(action: ActionNode, ctx: ExprCtx, recordTypes: Map<string, any[]>, natParams: Set<string>): TranslatedAction {
  const out: TranslatedAction = { guardElm: [], unhandledGuards: [], bodyElm: [], unhandledBody: [] };

  for (const stmt of action.statements) {
    if (stmt.type === 'require' || (stmt as any).type === 'precondition') {
      const expr = (stmt as any).expr as string;
      const t = translateExpr(expr, ctx);
      if (t) {
        out.guardElm.push(`            |> guard "${expr.replace(/"/g, "'")}" (${t})`);
      } else {
        out.unhandledGuards.push(expr);
      }
    } else if (stmt.type === 'assign') {
      const line = translateAssign(stmt.target, stmt.expr, ctx, recordTypes);
      if (line) out.bodyElm.push(line);
      else out.unhandledBody.push(`${stmt.target} := ${stmt.expr}`);
    } else if (stmt.type === 'let') {
      // lets become intermediate bindings — most actions in our specs don't use them
      out.unhandledBody.push(`let ${(stmt as any).name} := ${(stmt as any).expr}`);
    } else if (stmt.type === 'emit') {
      // events are mirrored client-side as an event-log entry; server is authoritative
      out.bodyElm.push(`            |> logEvent "${(stmt as any).event}"`);
    } else {
      out.unhandledBody.push(JSON.stringify(stmt));
    }
  }
  return out;
}

/**
 * Translate assignments:
 *   x[k] := Record { ... }          → Dict.insert
 *   x[k].field := expr              → Dict.update with record update
 *   x := Record { ... } :: x        → list prepend
 *   x := expr                       → plain set (only for simple literals)
 */
function translateAssign(target: string, expr: string, ctx: ExprCtx, recordTypes: Map<string, any[]>): string | null {
  // dict field assign: cards[cardId].column := target
  const idxFieldM = target.match(/^(\w+)\[(.+?)\]\.(\w+)$/);
  if (idxFieldM) {
    const [, dictVar, keyExpr, field] = idxFieldM;
    const key = translateKeyExpr(keyExpr.trim(), ctx);
    if (!key) return null;
    const val = translateExpr(expr, ctx);
    if (!val) return null;
    return `            |> thenSet (\\m -> { m | ${elmName(dictVar)} = updateIn m.${elmName(dictVar)} ${key} (\\r -> { r | ${elmName(field)} = ${val} }) })`;
  }

  // dict insert: cards[cardId] := CardRecord { ... }
  const idxM = target.match(/^(\w+)\[(.+?)\]$/);
  if (idxM) {
    const [, dictVar, keyExpr] = idxM;
    const key = translateKeyExpr(keyExpr.trim(), ctx);
    if (!key) return null;
    const rec = translateRecordLiteral(expr, recordTypes);
    if (rec) {
      return `            |> thenSet (\\m -> { m | ${elmName(dictVar)} = Dict.insert ${key} (${rec}) m.${elmName(dictVar)} })`;
    }
    // literal insert: projects[projectId] := true
    if (/^".*"$/.test(expr) || /^\d+$/.test(expr) || expr === 'true' || expr === 'false') {
      const lit = translateExpr(expr, ctx);
      return `            |> thenSet (\\m -> { m | ${elmName(dictVar)} = Dict.insert ${key} (${lit}) m.${elmName(dictVar)} })`;
    }
    return null;
  }

  // list prepend: comments := CardComment { ... } :: comments
  const prependM = expr.match(/^(.+?)\s*::\s*(\w+)$/);
  if (prependM && target === prependM[2]) {
    const rec = translateRecordLiteral(prependM[1], recordTypes);
    if (!rec) return null;
    return `            |> thenSet (\\m -> { m | ${elmName(target)} = (${rec}) :: m.${elmName(target)} })`;
  }

  // plain literal set
  if (/^".*"$/.test(expr) || /^\d+$/.test(expr) || expr === 'true' || expr === 'false') {
    return `            |> thenSet (\\m -> { m | ${elmName(target)} = ${translateExpr(expr, ctx)} })`;
  }

  return null;
}

/** Record { k: v, ... } → Elm record ElmName { k = v, ... } */
function translateRecordLiteral(expr: string, recordTypes: Map<string, any[]>): string | null {
  const m = expr.match(/^(\w+)\s*\{(.+)\}\s*$/);
  if (!m) return null;
  const typeName = m[1];
  const body = m[2];
  // split fields on top-level commas
  const fields = splitTopLevel(body).map(f => {
    const fm = f.match(/^(\w+)\s*:\s*(.+)$/);
    if (!fm) return null;
    let val = fm[2].trim();
    // null → Nothing-ish; our specs use String | null rarely in client code
    if (val === 'null') val = '""';
    if (/^\d+$/.test(val)) return `${elmName(fm[1])} = ${val}`;
    if (/^".*"$/.test(val)) return `${elmName(fm[1])} = ${val}`;
    if (val === 'true') return `${elmName(fm[1])} = True`;
    if (val === 'false') return `${elmName(fm[1])} = False`;
    return `${elmName(fm[1])} = ${val}`; // param refs and idents share names
  });
  if (fields.some(f => f === null)) return null;
  // plain record literal — for a type alias, { fields } IS the record;
  // `Alias { fields }` would be the curried positional constructor (wrong)
  return `{ ${fields.join(', ')} }`;
}

// ─── view field classification ──────────────────────────────────────

/**
 * Classify record fields for element rendering:
 *   heading — first String field named title/name (strong text)
 *   body    — first String field named content/body/text/description/summary
 *   meta    — everything else (joined " · " line)
 */
function classifyFields(fields: any[]): {
  heading: any | null;
  body: any | null;
  meta: any[];
  fallback: string | null;
} {
  const headingNames = ['title', 'name'];
  const bodyNames = ['content', 'body', 'text', 'description', 'summary'];
  let heading: any | null = null;
  let body: any | null = null;
  const meta: any[] = [];
  for (const f of fields) {
    const n = f.name.toLowerCase();
    const isStr = elmType(f.type, new Map()) === 'String';
    if (!heading && isStr && headingNames.includes(n)) { heading = f; continue; }
    if (!body && isStr && bodyNames.includes(n)) { body = f; continue; }
    meta.push(f);
  }
  let fallback: string | null = null;
  if (!heading) {
    // promote the first meta field to heading
    if (meta.length > 0) {
      const f = meta.shift()!;
      fallback = metaExprFor(f, true);
    } else if (body) {
      fallback = `String.left 40 r.${elmName(body.name)}`;
    }
  }
  return { heading, body, meta, fallback };
}

/** Elm expression for one meta field value */
function metaExpr(f: any): string {
  return metaExprFor(f, false);
}

function metaExprFor(f: any, asHeading: boolean): string {
  const et = elmType(f.type, new Map());
  const ref = `r.${elmName(f.name)}`;
  if (et === 'String') return asHeading ? ref : ref;
  if (et === 'Int') return asHeading ? `("#" ++ String.fromInt ${ref})` : `(String.fromInt ${ref})`;
  if (et === 'Bool') return `(boolText ${ref})`;
  if (et === 'Float') return `(String.fromFloat ${ref})`;
  return `(Debug.toString ${ref})`;
}

// ─── main generator ─────────────────────────────────────────────────

export function generateElm(ast: AST, outputDir: string): void {
  for (const speck of ast.specks) {
    const pkg = snakeCase(speck.name);
    const dir = path.join(outputDir, `${pkg}-elm`);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // collect records (interfaces with fields, and `type X = {...}`)
    const recordTypes = new Map<string, any[]>();
    for (const m of speck.members) {
      if (m.type === 'interface' && (m as any).fields?.length > 0) {
        recordTypes.set((m as any).name, (m as any).fields.map((f: any) => ({ name: f.name, type: f.type })));
      }
      if ((m.type as any) === 'type' && (m as any).typeExpr?.type === 'record') {
        recordTypes.set((m as any).name, (m as any).typeExpr.fields);
      }
    }

    // explicit enum interfaces → Elm union types
    const enumTypes = new Map<string, string[]>();
    for (const m of speck.members) {
      if (m.type === 'interface' && (m as any).kind === 'enum' && (m as any).methods?.length > 0) {
        enumTypes.set((m as any).name, (m as any).methods.map((mm: any) => mm.name));
      }
    }

    // merge state nodes
    const stateNodes = speck.members.filter(m => m.type === 'state') as StateNode[];
    const stateVars = stateNodes.flatMap(n => n.variables as any[]);
    const actions = speck.members.filter(m => m.type === 'action') as ActionNode[];
    const events = speck.members.filter(m => m.type === 'event') as EventNode[];

    // map vars (need String keys in Elm/JSON)
    const mapVars = new Set<string>(
      stateVars
        .filter(v => v.typeExpr?.type === 'map' || (v.typeExpr?.type === 'ident' && /^Map/i.test(v.typeExpr?.name || '')))
        .map(v => elmName(v.name.replace(/\[\]/g, '')))
    );

    // per-action nat params (used as map keys)
    const natParams = new Set<string>();
    for (const a of actions) {
      for (const p of a.params) {
        const pt = (p.type as any);
        const pname = pt?.name?.toLowerCase?.() || '';
        if (pname === 'nat' || pname === 'int' || pname === 'integer' || (pt?.type === 'primitive' && pname !== 'string' && pname !== 'bool' && pname !== 'float')) {
          if (pname !== 'bool' && pname !== 'float' && pname !== 'number' && pname !== 'string') natParams.add(p.name);
        }
      }
    }

    // string vars (for length()) — state strings and String params
    const stringVars = new Set<string>();
    for (const v of stateVars) {
      if (elmStateType(v.typeExpr, recordTypes) === 'String') stringVars.add(elmName(v.name));
    }
    for (const a of actions) {
      for (const p of a.params) if (elmParamType(p.type) === 'String') stringVars.add(p.name);
    }

    const ctx: ExprCtx = {
      isStringVar: (n: string) => stringVars.has(n),
      natParams,
      mapVars,
    };

    // field type registry for dict-field access defaults
    currentRecordFields = {};
    for (const [recName, fields] of recordTypes) {
      const fmap: Record<string, string> = {};
      for (const f of fields) fmap[f.name] = elmType(f.type, recordTypes);
      currentRecordFields[recName] = fmap;
    }

    // View metadata: column order from the first `X in { ... }` guard literal set
    // (display ordering only — types are never inferred from literals).
    let columnOrder: string[] | null = null;
    for (const a of actions) {
      for (const stmt of a.statements) {
        if (stmt.type === 'require') {
          const m = (stmt as any).expr.match(/^\w+\s+in\s+\{(.+)\}$/);
          if (m) {
            columnOrder = m[1].split(',').map((x: string) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
            break;
          }
        }
      }
      if (columnOrder) break;
    }

    fs.writeFileSync(path.join(dir, 'elm.json'), elmJson());
    fs.writeFileSync(path.join(srcDir, 'Types.elm'), emitTypes(speck, recordTypes, enumTypes));
    fs.writeFileSync(path.join(srcDir, 'Prelude.elm'), emitPrelude());
    fs.writeFileSync(path.join(srcDir, `${ElmName(speck.name)}Machine.elm`), emitMachine(speck, stateVars, actions, ctx, recordTypes, mapVars));
    fs.writeFileSync(path.join(srcDir, 'Main.elm'), emitMain(speck, stateVars, actions, recordTypes, columnOrder));
    fs.writeFileSync(path.join(dir, 'index.html'), emitIndexHtml(speck.name));
    console.log(`Generated Elm app: ${dir} (Types + Prelude + Machine + Main + index.html)`);
  }
}

// ─── elm.json ───────────────────────────────────────────────────────

function elmJson(): string {
  return JSON.stringify({
      "type": "application",
      "source-directories": [
          "src"
      ],
      "elm-version": "0.19.2",
      "dependencies": {
          "direct": {
              "elm/browser": "1.0.2",
              "elm/core": "1.0.5",
              "elm/html": "1.0.1",
              "elm/http": "2.0.0",
              "elm/json": "1.1.4"
          },
          "indirect": {
              "elm/bytes": "1.0.8",
              "elm/file": "1.0.5",
              "elm/time": "1.0.0",
              "elm/url": "1.0.0",
              "elm/virtual-dom": "1.0.5"
          }
      },
      "test-dependencies": {
          "direct": {},
          "indirect": {}
      }
  }, null, 4);
}

// ─── Types.elm ──────────────────────────────────────────────────────

function emitTypes(speck: SpeckNode, recordTypes: Map<string, any[]>, enumTypes: Map<string, string[]>): string {
  const L: string[] = [];
  L.push(`-- Code generated by speckl (elm backend): types from ${speck.name}.speckdl.`);
  L.push(`-- Record aliases and JSON codecs matching the Go server's wire format.`);
  L.push(`module Types exposing (..)`);
  L.push(``);
  L.push(`import Dict exposing (Dict)`);
  L.push(`import Json.Decode as D`);
  L.push(`import Json.Encode as JE`);
  L.push(``);

  // enum union types
  for (const [name, variants] of enumTypes) {
    L.push(`type ${ElmName(name)}`);
    L.push(`    = ${variants.map(ElmName).join(' | ')}`);
    L.push(``);
    L.push(`all${ElmName(name)} : List ${ElmName(name)}`);
    L.push(`all${ElmName(name)} =`);
    L.push(`    [ ${variants.map(ElmName).join(', ')} ]`);
    L.push(``);
    L.push(`${elmName(name)}ToString : ${ElmName(name)} -> String`);
    L.push(`${elmName(name)}ToString v =`);
    L.push(`    case v of`);
    for (const v of variants) L.push(`        ${ElmName(v)} -> "${v}"`);
    L.push(``);
    L.push(`${elmName(name)}FromString : String -> Maybe ${ElmName(name)}`);
    L.push(`${elmName(name)}FromString s =`);
    L.push(`    case s of`);
    for (const v of variants) L.push(`        "${v}" -> Just ${ElmName(v)}`);
    L.push(`        _ -> Nothing`);
    L.push(``);
  }

  // record aliases + codecs
  for (const [name, fields] of recordTypes) {
    const tn = ElmName(name);
    L.push(`type alias ${tn} =`);
    L.push(`    { ${fields.map((f: any) => `${elmName(f.name)} : ${elmType(f.type, recordTypes)}`).join('\n    , ')} }`);
    L.push(``);

    // decoder (Go JSON field names)
    L.push(`${elmName(name)}Decoder : D.Decoder ${tn}`);
    L.push(`${elmName(name)}Decoder =`);
    L.push(`    D.map${fields.length} ${tn}`);
    for (const f of fields) {
      L.push(`        (D.field "${goFieldName(f.name)}" ${decoderFor(f.type, recordTypes)})`);
    }
    L.push(``);
    L.push(`${elmName(name)}DictDecoder : D.Decoder (Dict String ${tn})`);
    L.push(`${elmName(name)}DictDecoder =`);
    L.push(`    D.dict ${elmName(name)}Decoder`);
    L.push(``);
    L.push(`${elmName(name)}ListDecoder : D.Decoder (List ${tn})`);
    L.push(`${elmName(name)}ListDecoder =`);
    L.push(`    D.list ${elmName(name)}Decoder`);
    L.push(``);
    L.push(`encode${tn} : ${tn} -> JE.Value`);
    L.push(`encode${tn} r =`);
    L.push(`    JE.object`);
    L.push(`        [ ${fields.map((f: any) => `( "${goFieldName(f.name)}", ${encoderFor(elmName(f.name), f.type, recordTypes)} )`).join('\n        , ')}`);
    L.push(`        ]`);
    L.push(``);
  }
  return L.join('\n') + '\n';
}

function decoderFor(t: any, recordTypes: Map<string, any[]>): string {
  const et = elmType(t, recordTypes);
  if (et === 'String') return 'D.string';
  if (et === 'Int') return 'D.int';
  if (et === 'Bool') return 'D.bool';
  if (et === 'Float') return 'D.float';
  if (et.startsWith('Dict.Dict String ')) {
    const inner = et.replace('Dict.Dict String ', '');
    return `(D.dict ${innerDecoder(inner)})`;
  }
  if (et.startsWith('List ')) {
    return `(D.list ${innerDecoder(et.slice(5))})`;
  }
  return `(D.map (Maybe.withDefault "") (D.maybe D.string))`; // fallback
}

function innerDecoder(typeName: string): string {
  const tn = ElmName(typeName);
  return `${tn.toLowerCaseFirst()}Decoder`.replace(/^./, c => c.toLowerCase());
}

function encoderFor(fieldName: string, t: any, recordTypes: Map<string, any[]>): string {
  const et = elmType(t, recordTypes);
  if (et === 'String') return `JE.string r.${fieldName}`;
  if (et === 'Int') return `JE.int r.${fieldName}`;
  if (et === 'Bool') return `JE.bool r.${fieldName}`;
  if (et === 'Float') return `JE.float r.${fieldName}`;
  return `JE.string (Debug.toString r.${fieldName})`;
}

// ─── Prelude.elm ────────────────────────────────────────────────────

function emitPrelude(): string {
  return `-- Code generated by speckl (elm backend): spec machine helpers.

module Prelude exposing (Step, fieldOf, guard, logEvent, thenSet, updateIn)


import Dict exposing (Dict)


{-| One step of an action execution: the model plus a Result carrying either
the accumulated event log or the first failed guard message. -}
type alias Step model =
    ( model, Result String (List String) )


{-| Guard chain helper: fails the step with a message when the spec
require is violated. -}
guard : String -> Bool -> Step m -> Step m
guard msg ok ( m, r ) =
    case r of
        Err e ->
            ( m, Err e )

        Ok log ->
            if ok then
                ( m, Ok log )

            else
                ( m, Err ("guard failed: " ++ msg) )


{-| Apply a state transition to the model, threading the result. -}
thenSet : (m -> m) -> Step m -> Step m
thenSet f ( m, r ) =
    ( f m, r )


{-| Append a spec event to the client-side event log mirror. -}
logEvent : String -> Step m -> Step m
logEvent name ( m, r ) =
    ( m, Result.map (\\log -> name :: log) r )


{-| Read a field of a dict value as a Maybe (guard helper). -}
fieldOf : Dict String v -> String -> (v -> a) -> Maybe a
fieldOf dict key accessor =
    Maybe.map accessor (Dict.get key dict)


{-| Record-update inside a dict; no-op when the key is absent. -}
updateIn : Dict String v -> String -> (v -> v) -> Dict String v
updateIn dict key f =
    case Dict.get key dict of
        Just v ->
            Dict.insert key (f v) dict

        Nothing ->
            dict
`;
}

// ─── Machine.elm ────────────────────────────────────────────────────

function emitMachine(
  speck: SpeckNode,
  stateVars: any[],
  actions: ActionNode[],
  ctx: ExprCtx,
  recordTypes: Map<string, any[]>,
  mapVars: Set<string>,
): string {
  const L: string[] = [];
  const moduleName = `${ElmName(speck.name)}Machine`;
  L.push(`-- Code generated by speckl (elm backend): pure state machine from ${speck.name}.speckdl.`);
  L.push(`-- Model from state vars; Msg from actions; guards from require exprs.`);
  L.push(`module ${moduleName} exposing (Model, Msg(..), init, update)`);
  L.push(``);
  L.push(`import Dict exposing (Dict)`);
  L.push(`import Prelude exposing (..)`);
  L.push(`import Types exposing (..)`);
  L.push(``);

  // Model from state vars
  L.push(`type alias Model =`);
  if (stateVars.length > 0) {
    L.push(`    { ${stateVars.map((v: any) => `${elmName(v.name)} : ${elmStateType(v.typeExpr, recordTypes)}`).join('\n    , ')} }`);
  } else {
    L.push(`    { dummy : () }`);
  }
  L.push(``);
  L.push(`type alias EventLog =`);
  L.push(`    List String`);
  L.push(``);

  // Msg from actions — Elm union: first constructor after `=`, rest after `|`
  L.push(`type Msg`);
  if (actions.length > 0) {
    actions.forEach((a, i) => {
      const sep = i === 0 ? '=' : '|';
      if (a.params.length > 0) {
        L.push(`    ${sep} ${ElmName(a.name)} ${a.params.map(p => elmParamType(p.type)).join(' ')}`);
      } else {
        L.push(`    ${sep} ${ElmName(a.name)}`);
      }
    });
  } else {
    L.push(`    = NoOp`);
  }
  L.push(``);

  // init
  L.push(`init : Model`);
  L.push(`init =`);
  L.push(`    { ${stateVars.map((v: any) => `${elmName(v.name)} = ${elmDefault(v, recordTypes)}`).join('\n    , ')} }`);
  L.push(``);

  // update — one case per action
  L.push(``);
  L.push(`{-| Pure update compiled from the spec. Guards come from require exprs;
the Go server re-enforces them authoritatively. Returns the new model plus
a Result describing guard failure (Err) or success with the event log (Ok).
-}`);
  L.push(`update : Msg -> Model -> ( Model, Result String EventLog )`);
  L.push(`update msg model =`);
  L.push(`    case msg of`);
  if (actions.length === 0) {
    L.push(`        NoOp ->`);
    L.push(`            ( model, Ok [] )`);
  }
  for (const a of actions) {
    const params = a.params.map(p => p.name);
    const pattern = params.length > 0 ? `        ${ElmName(a.name)} ${params.join(' ')} ->` : `        ${ElmName(a.name)} ->`;
    L.push(pattern);
    const tr = translateAction(a, ctx, recordTypes, ctx.natParams);
    if (tr.unhandledGuards.length > 0) {
      for (const g of tr.unhandledGuards) {
        L.push(`            -- guard checked server-side: ${g.replace(/\n/g, ' ')}`);
      }
    }
    if (tr.unhandledBody.length > 0) {
      for (const b of tr.unhandledBody) {
        L.push(`            -- transition applied server-side: ${b.replace(/\n/g, ' ')}`);
      }
    }
    L.push(`            ( model, Ok [] )`);
    for (const g of tr.guardElm) L.push(g);
    for (const b of tr.bodyElm) L.push(b);
    L.push(``);
  }
  return L.join('\n') + '\n';
}

function elmDefault(v: any, recordTypes: Map<string, any[]>): string {
  const t = elmStateType(v.typeExpr, recordTypes);
  if (t.startsWith('Dict.Dict')) return 'Dict.empty';
  if (t.startsWith('List ')) return '[]';
  if (t === 'String') return '""';
  if (t === 'Int') return '0';
  if (t === 'Bool') return 'False';
  if (t === 'Float') return '0';
  return 'Dict.empty';
}

// ─── Main.elm ───────────────────────────────────────────────────────

function emitMain(speck: SpeckNode, stateVars: any[], actions: ActionNode[], recordTypes: Map<string, any[]>, columnOrder: string[] | null): string {
  const L: string[] = [];
  const machine = `${ElmName(speck.name)}Machine`;
  L.push(`-- Code generated by speckl (elm backend): HTTP front end for ${speck.name}.`);
  L.push(`-- Optimistic local update + authoritative refetch from the Go server.`);
  L.push(`module Main exposing (main)`);
  L.push(``);
  L.push(`import Browser`);
  L.push(`import Dict exposing (Dict)`);
  L.push(`import Html exposing (..)`);
  L.push(`import Html.Attributes exposing (..)`);
  L.push(`import Html.Events exposing (onClick, onInput)`);
  L.push(`import Http`);
  L.push(`import Json.Decode as D`);
  L.push(`import Json.Encode as JE`);
  L.push(`import Prelude exposing (..)`);
  L.push(`import Types exposing (..)`);
  L.push(`import ${machine} exposing (Model, Msg(..))`);
  L.push(``);
  L.push(``);
  L.push(`-- MODEL`);
  L.push(``);
  L.push(``);
  L.push(`type alias Page =`);
  L.push(`    { machine : Model`);
  L.push(`    , error : Maybe String`);
  L.push(`    , loading : Bool`);
  L.push(`    , inputs : Dict.Dict String String`);
  L.push(`    }`);
  L.push(``);
  L.push(``);
  L.push(`init : () -> ( Page, Cmd FrontMsg )`);
  L.push(`init () =`);
  L.push(`    ( { machine = ${machine}.init`);
  L.push(`      , error = Nothing`);
  L.push(`      , loading = True`);
  L.push(`      , inputs = Dict.empty`);
  L.push(`      }`);
  L.push(`    , fetchState`);
  L.push(`    )`);
  L.push(``);
  L.push(``);
  L.push(`-- STATE FETCH`);
  L.push(``);
  L.push(``);
  L.push(`fetchState : Cmd FrontMsg`);
  L.push(`fetchState =`);
  L.push(`    Http.get`);
  L.push(`        { url = "/state.json"`);
  L.push(`        , expect = Http.expectJson GotState stateDecoder`);
  L.push(`        }`);
  L.push(``);
  L.push(``);
  L.push(`{-| Decode the Go server's state.json. Go marshals exported field names;
map keys are strings. Uses a chain of D.map + tuple decode to support any
number of state vars.
-}`);
  L.push(`stateDecoder : D.Decoder Model`);
  if (stateVars.length === 0) {
    L.push(`stateDecoder =`);
    L.push(`    D.succeed Model`);
  } else if (stateVars.length <= 8) {
    L.push(`stateDecoder =`);
    L.push(`    D.map${stateVars.length} Model`);
    for (const v of stateVars) {
      const name = elmName(v.name);
      const t = elmStateType(v.typeExpr, recordTypes);
      L.push(`        (D.field "${goFieldName(v.name)}" ${stateVarDecoder(v, t, recordTypes)})`);
    }
  } else {
    // > 8 vars: decode as one big D.value then pick fields manually
    L.push(`stateDecoder =`);
    L.push(`    D.map ${elmName('fromRaw')} D.value`);
    L.push(``);
    L.push(``);
    L.push(`fromRaw : D.Value -> Model`);
    L.push(`fromRaw raw =`);
    for (const v of stateVars) {
      const name = elmName(v.name);
      const t = elmStateType(v.typeExpr, recordTypes);
      L.push(`    ${name} =`);
      L.push(`        case D.decodeValue (${stateVarDecoder(v, t, recordTypes)}) (rawField raw "${goFieldName(v.name)}") of`);
      L.push(`            Ok dv -> dv`);
      L.push(``);
      L.push(`            _ -> ${elmDefault(v, recordTypes)}`);
      L.push(``);
    }
    L.push(``);
    L.push(``);
    L.push(`rawField : D.Value -> String -> D.Value`);
    L.push(`rawField raw key =`);
    L.push(`    case D.decodeValue (D.at [ key ] D.value) raw of`);
    L.push(`        Ok v -> v`);
    L.push(``);
    L.push(`        _ -> D.null`);
  }
  L.push(``);

  L.push(``);
  L.push(`-- FRONT-END MESSAGE WRAPPER`);
  L.push(`-- The machine owns Msg; the front end wraps it with HTTP lifecycle.`);
  L.push(``);
  L.push(``);
  L.push(`type FrontMsg`);
  L.push(`    = FromMachine Msg`);
  L.push(`    | GotState (Result Http.Error Model)`);
  L.push(`    | ActionDone (Result Http.Error ())`);
  L.push(`    | SetInput String String`);
  L.push(``);
  L.push(``);
  L.push(`-- UPDATE`);
  L.push(``);
  L.push(``);
  L.push(`update : FrontMsg -> Page -> ( Page, Cmd FrontMsg )`);
  L.push(`update frontMsg page =`);
  L.push(`    case frontMsg of`);
  L.push(`        SetInput key value ->`);
  L.push(`            ( { page | inputs = Dict.insert key value page.inputs }, Cmd.none )`);
  L.push(``);
  L.push(`        GotState result ->`);
  L.push(`            case result of`);
  L.push(`                Ok newModel ->`);
  L.push(`                    ( { page | machine = newModel, loading = False, error = Nothing }, Cmd.none )`);
  L.push(``);
  L.push(`                Err e ->`);
  L.push(`                    ( { page | loading = False, error = Just (httpError e) }, Cmd.none )`);
  L.push(``);
  L.push(`        ActionDone result ->`);
  L.push(`            case result of`);
  L.push(`                Ok () ->`);
  L.push(`                    ( page, fetchState )`);
  L.push(``);
  L.push(`                Err e ->`);
  L.push(`                    ( { page | loading = False, error = Just (httpError e) }, fetchState )`);
  L.push(``);
  L.push(`        FromMachine msg ->`);
  L.push(`            let`);
  L.push(`                ( newModel, guardResult ) =`);
  L.push(`                    ${machine}.update msg page.machine`);
  L.push(`            in`);
  L.push(`            case guardResult of`);
  L.push(`                Err guardMsg ->`);
  L.push(`                    -- spec guard rejected the action client-side; server never sees it`);
  L.push(`                    ( { page | machine = newModel, error = Just guardMsg }, Cmd.none )`);
  L.push(``);
  L.push(`                Ok _ ->`);
  L.push(`                    ( { page | machine = newModel }`);
  L.push(`                    , postAction (actionRoute msg) (actionBody msg)`);
  L.push(`                    )`);
  L.push(``);
  L.push(``);
  L.push(`{-| Route per action, matching the Go handler paths. -}`);
  L.push(`actionRoute : Msg -> String`);
  L.push(`actionRoute msg =`);
  L.push(`    case msg of`);
// actionRoute/actionBody cases are emitted by the loop below (already in file after httpError? no — they were after). We append them here via the actions loop:

  for (const a of actions) {
    if (a.params.length === 0) {
      L.push(`        ${ElmName(a.name)} ->`);
      L.push(`            "${snakeCase(a.name)}"`);
      L.push(``);
    } else {
      L.push(`        ${ElmName(a.name)} ${a.params.map(p => p.name).join(' ')} ->`);
      L.push(`            "${snakeCase(a.name)}"`);
      L.push(``);
    }
  }
  L.push(``);
  L.push(`{-| JSON body per action, matching the Go wire format. -}`);
  L.push(`actionBody : Msg -> JE.Value`);
  L.push(`actionBody msg =`);
  L.push(`    case msg of`);
  for (const a of actions) {
    if (a.params.length === 0) {
      L.push(`        ${ElmName(a.name)} ->`);
      L.push(`            JE.object []`);
      L.push(``);
    } else {
      L.push(`        ${ElmName(a.name)} ${a.params.map(p => p.name).join(' ')} ->`);
      L.push(`            encode${ElmName(a.name)} ${a.params.map(p => p.name).join(' ')}`);
      L.push(``);
    }
  }
  L.push(``);

  L.push(`httpError : Http.Error -> String`);
  L.push(`httpError e =`);
  L.push(`    case e of`);
  L.push(`        Http.BadUrl s ->`);
  L.push(`            "bad url: " ++ s`);
  L.push(``);
  L.push(`        Http.Timeout ->`);
  L.push(`            "timeout"`);
  L.push(``);
  L.push(`        Http.NetworkError ->`);
  L.push(`            "network error"`);
  L.push(``);
  L.push(`        Http.BadStatus code ->`);
  L.push(`            "http " ++ String.fromInt code`);
  L.push(``);
  L.push(`        Http.BadBody s ->`);
  L.push(`            "bad body: " ++ s`);
  L.push(``);
  L.push(``);
  L.push(`-- ACTION ENCODERS (Go wire format: PascalCase keys, typed values)`);
  L.push(``);
  for (const a of actions) {
    if (a.params.length === 0) continue;
    L.push(`encode${ElmName(a.name)} : ${a.params.map(p => elmParamType(p.type)).join(' -> ')} -> JE.Value`);
    L.push(`encode${ElmName(a.name)} ${a.params.map(p => p.name).join(' ')} =`);
    L.push(`    JE.object`);
    L.push(`        [ ${a.params.map(p => {
      const pt = elmParamType(p.type);
      const enc = pt === 'String' ? 'JE.string' : pt === 'Int' ? 'JE.int' : pt === 'Bool' ? 'JE.bool' : 'JE.float';
      return `( "${goFieldName(p.name)}", ${enc} ${p.name} )`;
    }).join('\n        , ')}`);
    L.push(`        ]`);
    L.push(``);
  }
  L.push(`postAction : String -> JE.Value -> Cmd FrontMsg`);
  L.push(`postAction action body =`);
  L.push(`    Http.request`);
  L.push(`        { method = "POST"`);
  L.push(`        , url = "/actions/" ++ action`);
  L.push(`        , body = Http.jsonBody body`);
  L.push(`        , expect = Http.expectWhatever ActionDone`);
  L.push(`        , headers = []`);
  L.push(`        , tracker = Nothing`);
  L.push(`        , timeout = Nothing`);
  L.push(`        }`);
  L.push(``);

  // View: real element rendering driven by the spec — records as elements,
  // one section per state var, one command row per action. Style later.
  L.push(``);
  L.push(`-- VIEW`);
  L.push(``);
  L.push(``);
  L.push(`view : Page -> Browser.Document FrontMsg`);
  L.push(`view page =`);
  L.push(`    { title = "${ElmName(speck.name)}"`);
  L.push(`    , body =`);
  L.push(`        [ div [ class "gb-app", attribute "data-app" "${snakeCase(speck.name)}" ]`);
  L.push(`            [ header [ class "gb-header" ]`);
  L.push(`                [ span [ class "gb-logo" ] [ text "GB" ]`);
  L.push(`                , span [ class "gb-title" ] [ text "${ElmName(speck.name)}" ]`);
  L.push(`                ]`);
  L.push(`            , main_ [ class "gb-main" ]`);
  L.push(`                [ errorBar page`);
  L.push(`                , div [] (stateSections page.machine)`);
  L.push(`                , viewCommands page.inputs`);
  L.push(`                ]`);
  L.push(`            ]`);
  L.push(`        ]`);
  L.push(`    }`);
  L.push(``);
  L.push(``);
  L.push(`errorBar : Page -> Html FrontMsg`);
  L.push(`errorBar page =`);
  L.push(`    case page.error of`);
  L.push(`        Just e ->`);
  L.push(`            div [ class "gb-error", attribute "role" "alert" ] [ text ("error: " ++ e) ]`);
  L.push(``);
  L.push(`        Nothing ->`);
  L.push(`            div [] []`);
  L.push(``);
  L.push(``);
  L.push(`stateSections : Model -> List (Html FrontMsg)`);
  L.push(`stateSections model =`);
  L.push(`    [ ${stateVars.map((v: any) => `section "${goFieldName(v.name)}" (${sectionBodyFn(v, recordTypes)} model.${elmName(v.name)})`).join('\n    , ')} ]`);
  L.push(``);
  L.push(``);
  L.push(`section : String -> List (Html FrontMsg) -> Html FrontMsg`);
  L.push(`section title kids =`);
  L.push(`    div [ class "gb-section" ]`);
  L.push(`        (h2 [ class "gb-section-hdr" ] [ text title ] :: kids)`);
  L.push(``);
  L.push(``);
  L.push(`emptyNote : Html FrontMsg`);
  L.push(`emptyNote =`);
  L.push(`    em [ class "gb-empty" ] [ text "none" ]`);
  L.push(``);
  L.push(``);
  L.push(`row : String -> Html FrontMsg`);
  L.push(`row s =`);
  L.push(`    div [ class "gb-row" ] [ text s ]`);
  L.push(``);
  L.push(``);
  L.push(`boolText : Bool -> String`);
  L.push(`boolText b =`);
  L.push(`    if b then "true" else "false"`);
  L.push(``);
  // ── per-record element renderers (from spec record fields) ──
  for (const [recName, fields] of recordTypes) {
    const tn = ElmName(recName);
    const fieldInfos = classifyFields(fields);
    // heading expr
    let heading;
    if (fieldInfos.heading) heading = `r.${elmName(fieldInfos.heading.name)}`;
    else if (fieldInfos.fallback) heading = fieldInfos.fallback;
    else heading = `"${tn}"`;
    const metaParts = fieldInfos.meta.map((f: any) => metaExpr(f));
    const metaJoined = metaParts.length > 0 ? `String.join " · " [${metaParts.join(", ")}]` : null;
    L.push(`view${tn} : ${tn} -> Html FrontMsg`);
    L.push(`view${tn} r =`);
    L.push(`    div [ class "gb-card" ]`);
    if (metaJoined) {
      L.push(`        [ div [ class "gb-card-hdr" ]`);
      L.push(`            [ strong [ class "gb-card-title" ] [ text (${heading}) ]`);
      L.push(`            , span [ class "gb-card-meta" ] [ text (" · " ++ ${metaJoined}) ]`);
      L.push(`            ]`);
      if (fieldInfos.body) {
        L.push(`        , div [ class "gb-card-body" ] [ text r.${elmName(fieldInfos.body.name)} ]`);
      }
      L.push(`        ]`);
    } else {
      L.push(`        [ strong [ class "gb-card-title" ] [ text (${heading}) ]`);
      if (fieldInfos.body) {
        L.push(`        , div [ class "gb-card-body" ] [ text r.${elmName(fieldInfos.body.name)} ]`);
      }
      L.push(`        ]`);
    }
    L.push(``);
    L.push(``);
  }
  // ── per-state-var renderers ──
  for (const v of stateVars) {
    const t = elmStateType(v.typeExpr, recordTypes);
    const name = elmName(v.name);
    const fnName = sectionBodyFn(v, recordTypes);
    if (t.startsWith('Dict.Dict String ')) {
      const inner = t.replace('Dict.Dict String ', '');
      if (inner === 'Bool') {
        L.push(`view${goFieldName(v.name)} : Dict.Dict String Bool -> List (Html FrontMsg)`);
        L.push(`view${goFieldName(v.name)} dict =`);
        L.push(`    if Dict.isEmpty dict then`);
        L.push(`        [ emptyNote ]`);
        L.push(``);
        L.push(`    else`);
        L.push(`        List.map (\\( k, v ) -> row (k ++ (if v then " ✓" else " ✗"))) (Dict.toList dict)`);
        L.push(``);
        L.push(``);
      } else {
        const tn = ElmName(inner);
        const fields = recordTypes.get(inner) || [];
        const groupField = fields.find((f: any) => ['column', 'status'].includes(f.name.toLowerCase()));
        if (groupField && columnOrder) {
          const accessor = `.${elmName(groupField.name)}`;
          L.push(`view${goFieldName(v.name)} : Dict.Dict String ${tn} -> List (Html FrontMsg)`);
          L.push(`view${goFieldName(v.name)} dict =`);
          L.push(`    if Dict.isEmpty dict then`);
          L.push(`        [ emptyNote ]`);
          L.push(``);
          L.push(`    else`);
          L.push(`        List.map view${tn}Group (groupByColumn${tn} (Dict.values dict))`);
          L.push(``);
          L.push(``);
          L.push(`groupByColumn${tn} : List ${tn} -> List ( String, List ${tn} )`);
          L.push(`groupByColumn${tn} items =`);
          L.push(`    let`);
          L.push(`        grouped =`);
          L.push(`            groupByRecord ${accessor} items`);
          L.push(``);
          L.push(`        known =`);
          L.push(`            List.filterMap (\\col -> Maybe.map (\\l -> ( col, l )) (Dict.get col grouped)) columnOrder`);
          L.push(``);
          L.push(`        unknown =`);
          L.push(`            Dict.toList grouped`);
          L.push(`                |> List.filter (\\( col, _ ) -> not (List.member col columnOrder))`);
          L.push(`    in`);
          L.push(`    known ++ unknown`);
          L.push(``);
          L.push(``);
          L.push(`view${tn}Group : ( String, List ${tn} ) -> Html FrontMsg`);
          L.push(`view${tn}Group ( col, items ) =`);
          L.push(`    div [ class "gb-board-col" ]`);
          L.push(`        [ div [ class "gb-board-col-hdr" ]`);
          L.push(`            [ text col`);
          L.push(`            , span [ class "gb-board-col-count" ] [ text (String.fromInt (List.length items)) ]`);
          L.push(`            ]`);
          L.push(`        , div [ class "gb-board-col-items" ] (List.map view${tn} items)`);
          L.push(`        ]`);
          L.push(``);
          L.push(``);
        } else {
          L.push(`view${goFieldName(v.name)} : Dict.Dict String ${tn} -> List (Html FrontMsg)`);
          L.push(`view${goFieldName(v.name)} dict =`);
          L.push(`    if Dict.isEmpty dict then`);
          L.push(`        [ emptyNote ]`);
          L.push(``);
          L.push(`    else`);
          L.push(`        List.map view${tn} (Dict.values dict)`);
          L.push(``);
          L.push(``);
        }
      }
    } else if (t.startsWith('Dict.Dict ')) {
      // non-string-key dict (scalar) — show key/value rows
      const inner = t.replace('Dict.Dict ', '');
      L.push(`view${goFieldName(v.name)} : ${t} -> List (Html FrontMsg)`);
      L.push(`view${goFieldName(v.name)} dict =`);
      L.push(`    if Dict.isEmpty dict then`);
      L.push(`        [ emptyNote ]`);
      L.push(``);
      L.push(`    else`);
      L.push(`        List.map (\\( k, v ) -> row (k ++ ": " ++ Debug.toString v)) (Dict.toList dict)`);
      L.push(``);
      L.push(``);
    } else if (t.startsWith('List ')) {
      const inner = t.slice(5);
      const tn = ElmName(inner);
      L.push(`view${goFieldName(v.name)} : List ${tn} -> List (Html FrontMsg)`);
      L.push(`view${goFieldName(v.name)} items =`);
      L.push(`    if List.isEmpty items then`);
      L.push(`        [ emptyNote ]`);
      L.push(``);
      L.push(`    else`);
      L.push(`        List.map view${tn} items`);
      L.push(``);
      L.push(``);
    }
  }
  // ── board helpers ──
  if (columnOrder) {
    L.push(`columnOrder : List String`);
    L.push(`columnOrder =`);
    L.push(`    [ ${columnOrder.map(c => `"${c}"`).join(', ')} ]`);
    L.push(``);
    L.push(``);
    L.push(`groupByRecord : (r -> String) -> List r -> Dict.Dict String (List r)`);
    L.push(`groupByRecord f items =`);
    L.push(`    List.foldl`);
    L.push(`        (\\item acc -> Dict.update (f item) (\\l -> Just (item :: Maybe.withDefault [] l)) acc)`);
    L.push(`        Dict.empty`);
    L.push(`        items`);
    L.push(``);
    L.push(``);
  }

  // ── command rows: one input+button row per action ──
  L.push(`getString : Dict.Dict String String -> String -> String`);
  L.push(`getString inputs k =`);
  L.push(`    Maybe.withDefault "" (Dict.get k inputs)`);
  L.push(``);
  L.push(``);
  L.push(`getInt : Dict.Dict String String -> String -> Int`);
  L.push(`getInt inputs k =`);
  L.push(`    Maybe.withDefault 0 (String.toInt (getString inputs k))`);
  L.push(``);
  L.push(``);
  L.push(`inputField : String -> Dict.Dict String String -> Html FrontMsg`);
  L.push(`inputField k inputs =`);
  L.push(`    input`);
  L.push(`        [ class "gb-input"`);
  L.push(`        , placeholder k`);
  L.push(`        , attribute "aria-label" k`);
  L.push(`        , value (getString inputs k)`);
  L.push(`        , onInput (SetInput k)`);
  L.push(`        ]`);
  L.push(`        []`);
  L.push(``);
  L.push(``);
  for (const a of actions) {
    const an = ElmName(a.name);
    L.push(`command${an} : Dict.Dict String String -> Html FrontMsg`);
    L.push(`command${an} inputs =`);
    const argExprs = a.params.map((p: any) => elmParamType(p.type) === 'Int'
      ? `(getInt inputs "${an}.${p.name}")`
      : `(getString inputs "${an}.${p.name}")`).join(' ');
    const call = a.params.length > 0 ? `(FromMachine (${an} ${argExprs}))` : `(FromMachine ${an})`;
    L.push(`    div [ class "gb-cmd" ]`);
    L.push(`        [ span [ class "gb-cmd-name" ] [ text "${an}" ]`);
    for (const p of a.params) {
      L.push(`        , inputField "${an}.${p.name}" inputs`);
    }
    L.push(`        , button [ class "gb-btn", onClick ${call} ] [ text "run" ]`);
    L.push(`        ]`);
    L.push(``);
    L.push(``);
  }
  L.push(`viewCommands : Dict.Dict String String -> Html FrontMsg`);
  L.push(`viewCommands inputs =`);
  L.push(`    section "Commands"`);
  L.push(`        [ ${actions.map((a: any) => `command${ElmName(a.name)} inputs`).join('\n        , ')} ]`);
  L.push(``);
  function sectionBodyFn(v: any, recordTypes: Map<string, any[]>): string {
    const t = elmStateType(v.typeExpr, recordTypes);
    if (t.startsWith('Dict.Dict String ')) {
      const inner = t.replace('Dict.Dict String ', '');
      if (inner === 'Bool') return `boolDictSection`;
      return `view${goFieldName(v.name)}`;
    }
    if (t.startsWith('Dict.Dict ')) return `view${goFieldName(v.name)}`;
    if (t.startsWith('List ')) return `view${goFieldName(v.name)}`;
    return `\\x -> [ row (Debug.toString x) ]`;
  }
  L.push(`boolDictSection : Dict.Dict String Bool -> List (Html FrontMsg)`);
  L.push(`boolDictSection dict =`);
  L.push(`    if Dict.isEmpty dict then`);
  L.push(`        [ emptyNote ]`);
  L.push(``);
  L.push(`    else`);
  L.push(`        List.map (\\( k, v ) -> row (k ++ (if v then " ✓" else " ✗"))) (Dict.toList dict)`);
  L.push(``);
  L.push(`main : Program () Page FrontMsg`);
  L.push(`main =`);
  L.push(`    Browser.document`);
  L.push(`        { init = init`);
  L.push(`        , update = update`);
  L.push(`        , subscriptions = \\_ -> Sub.none`);
  L.push(`        , view = view`);
  L.push(`        }`);
  return L.join('\n') + '\n';
}

function stateVarDecoder(v: any, t: string, recordTypes: Map<string, any[]>): string {
  if (t.startsWith('Dict.Dict String ')) {
    const inner = t.replace('Dict.Dict String ', '');
    // records get generated <name>DictDecoder in Types.elm; Bool gets an inline dict decoder
    const isRecord = recordTypes.has(inner) || [...recordTypes.keys()].some(rn => ElmName(rn) === inner);
    if (isRecord) {
      const lower = inner.charAt(0).toLowerCase() + inner.slice(1);
      return `${lower}DictDecoder`;
    }
    if (inner === 'Bool') return '(D.dict D.bool)';
    if (inner === 'String') return '(D.dict D.string)';
    if (inner === 'Int') return '(D.dict D.int)';
    return 'D.value';
  }
  if (t.startsWith('List ')) {
    const inner = t.slice(5);
    const isRecord = recordTypes.has(inner) || [...recordTypes.keys()].some(rn => ElmName(rn) === inner);
    if (isRecord) {
      const lower = inner.charAt(0).toLowerCase() + inner.slice(1);
      return `${lower}ListDecoder`;
    }
    if (inner === 'Bool') return '(D.list D.bool)';
    if (inner === 'String') return '(D.list D.string)';
    if (inner === 'Int') return '(D.list D.int)';
    return 'D.value';
  }
  if (t === 'String') return 'D.string';
  if (t === 'Int') return 'D.int';
  if (t === 'Bool') return 'D.bool';
  return 'D.value';
}

function emitIndexHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ElmName(name)}</title>
<style>
/* speckl-generated: Basecamp-like defaults. Behavior from the spec; style here. */
:root {
  --gb-bg: #f6f5f2;
  --gb-card: #ffffff;
  --gb-border: #e5e2db;
  --gb-text: #2d2a26;
  --gb-text-2: #6f6a61;
  --gb-accent: #c0392b;
  --gb-accent-dark: #a93226;
  --gb-radius: 12px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--gb-bg);
  color: var(--gb-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}

/* header */
.gb-header {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--gb-card);
  border-bottom: 1px solid var(--gb-border);
  padding: 12px 24px;
}
.gb-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--gb-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.gb-title { font-size: 17px; font-weight: 700; }

.gb-main {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px 20px 64px;
}

/* sections */
.gb-section {
  background: var(--gb-card);
  border: 1px solid var(--gb-border);
  border-radius: var(--gb-radius);
  margin-bottom: 20px;
  overflow: hidden;
}
.gb-section-hdr {
  margin: 0;
  padding: 12px 20px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--gb-border);
}
.gb-section > :not(.gb-section-hdr) { padding: 8px 20px 14px; }
.gb-section > .gb-board-col { padding: 8px 0 0; }

/* rows / cards */
.gb-row { padding: 4px 0; font-size: 14px; color: var(--gb-text-2); }
.gb-empty { color: #9b968c; font-size: 14px; font-style: italic; }
.gb-card {
  border: 1px solid var(--gb-border);
  border-radius: 8px;
  background: #fff;
  padding: 8px 12px;
  margin: 8px 0;
}
.gb-card-hdr { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.gb-card-title { font-size: 14px; font-weight: 600; }
.gb-card-meta { font-size: 12px; color: var(--gb-text-2); }
.gb-card-body { font-size: 13px; color: var(--gb-text-2); margin-top: 2px; }

/* board columns */
.gb-board-col { display: block; border-top: 1px solid var(--gb-border); }
.gb-board-col:first-of-type { border-top: none; }
.gb-board-col-hdr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px 2px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--gb-text-2);
}
.gb-board-col-count {
  background: var(--gb-bg);
  border-radius: 10px;
  padding: 0 8px;
  font-size: 11px;
}
.gb-board-col-items { padding: 0 20px 8px; }

/* error */
.gb-error {
  background: #fdf0ee;
  border: 1px solid #f2c9c3;
  color: var(--gb-accent-dark);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

/* commands */
.gb-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 0;
  border-bottom: 1px solid #f0ede7;
}
.gb-cmd:last-child { border-bottom: none; }
.gb-cmd-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--gb-text-2);
  min-width: 180px;
}
.gb-input {
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--gb-border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  background: #fff;
  color: var(--gb-text);
  min-width: 140px;
}
.gb-input:focus { outline: 2px solid var(--gb-accent); outline-offset: 1px; }
.gb-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: var(--gb-accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.gb-btn:hover { background: var(--gb-accent-dark); }
.gb-btn:focus { outline: 2px solid var(--gb-accent-dark); outline-offset: 2px; }

/* a11y: visible focus for keyboard nav */
a:focus-visible, button:focus-visible, input:focus-visible {
  outline: 2px solid var(--gb-accent);
  outline-offset: 2px;
}
</style>
</head>
<body>
<div id="app"></div>
<script src="/static/app.js"></script>
<script>
Elm.Main.init({ node: document.getElementById("app"), flags: null });
</script>
</body>
</html>
`;
}

// small string helper (ElmName used above)
declare global {
  interface String {
    toLowerCaseFirst(): string;
  }
}
String.prototype.toLowerCaseFirst = function () {
  return this.charAt(0).toLowerCase() + this.slice(1);
};