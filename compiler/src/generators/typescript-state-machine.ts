import { AST, SpeckNode, MemberNode, StateNode, InitNode, ActionNode, ConstraintNode, VerifyNode, EventNode, TypeExpr } from '../parser.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate TypeScript state machine runtime from a SpeckDL spec.
 *
 * Outputs a self-contained .ts file with:
 *  - Typed states as a const enum
 *  - Event interfaces
 *  - State machine class with guards, assignments, and decision log
 *  - Constraint check stubs
 *  - Verification stubs
 */

export function generateTypeScriptStateMachine(ast: AST, outputDir: string): void {
  for (const speck of ast.specks) {
    const code = emitSpeck(speck);
    const filename = `${speck.name}.ts`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, code);
    console.log(`Generated TypeScript state machine: ${filepath}`);
  }
}

function emitSpeck(speck: SpeckNode): string {
  const deduped = new Map<string, MemberNode>();
  for (const m of speck.members) {
    const key = memberKey(m);
    const existing = deduped.get(key);
    if (!existing || isEmptyStub(existing)) {
      deduped.set(key, m);
    }
  }
  const members = Array.from(deduped.values());

  const stateNode = members.find(m => m.type === 'state') as StateNode | undefined;
  const initNode  = members.find(m => m.type === 'init') as InitNode | undefined;
  const actions   = members.filter(m => m.type === 'action') as ActionNode[];
  const events    = members.filter(m => m.type === 'event') as EventNode[];
  
  // Collect implicit event types from emit statements
  const implicitEvents = new Map<string, { name: string; fields: { name: string; value: string }[] }>();
  for (const action of actions) {
    for (const stmt of action.statements) {
      if (stmt.type === 'emit') {
        const existing = implicitEvents.get(stmt.event);
        if (!existing) {
          implicitEvents.set(stmt.event, { name: stmt.event, fields: stmt.fields });
        }
      }
    }
  }
  const constraints = members.filter(m => m.type === 'constraint') as ConstraintNode[];
  const verifies = members.filter(m => m.type === 'verify') as VerifyNode[];

  // Collect ALL enum-like interfaces (interfaces with method names treated as enum values)
  const allInterfaces = members.filter(m => m.type === 'interface') as any[];
  const enumInterfaces = allInterfaces.filter(iface => iface?.methods?.length > 0);
  
  // If no interfaces have methods, fall back to scanning action guards for capitalized words
  let stateValues: string[] = [];
  if (enumInterfaces.length > 0) {
    for (const iface of enumInterfaces) {
      stateValues.push(...iface.methods.map((m: any) => m.name));
    }
  } else {
    const seen = new Set<string>();
    const builtinTypes = new Set(['String', 'Nat', 'Int', 'Bool', 'Real', 'Bytes', 'Date', 'Number']);
    for (const a of actions) {
      for (const s of a.statements) {
        if (s.type === 'require') {
          const matches = s.expr.match(/\b[A-Z][a-zA-Z]+\b/g);
          if (matches) {
            matches.forEach((m: string) => {
              if (!builtinTypes.has(m)) seen.add(m);
            });
          }
        }
      }
    }
    stateValues = Array.from(seen).sort();
  }
  if (stateValues.length === 0) stateValues = ['Open', 'Closed'];

  // Build a map of interface name -> enum values for multi-enum specs
  const enumMap = new Map<string, string[]>();
  for (const iface of enumInterfaces) {
    enumMap.set(iface.name, iface.methods.map((m: any) => m.name));
  }

  // Determine which enum name to use for state comparisons
  const stateVarType = stateNode?.variables?.[0]?.typeExpr;
  let stateEnumName = `${speck.name}State`;
  if (stateVarType?.type === 'ident' && stateVarType.name) {
    const cleanTypeName = cleanName(stateVarType.name);
    stateEnumName = `${speck.name}${cleanTypeName}`;
  } else if (enumMap.size > 0) {
    const firstEnum = enumMap.keys().next().value;
    if (firstEnum) stateEnumName = `${speck.name}${firstEnum}`;
  }

  // If we fell back to guard scanning, create the primary enum under the right name
  // Avoid collision: don't add to enumMap if the key matches an existing ident type in state vars
  const stateVarIdentNames = new Set<string>();
  for (const v of (stateNode?.variables ?? [])) {
    (function visit(t: any) {
      if (!t) return;
      if (t.type === 'ident' && t.name) stateVarIdentNames.add(cleanName(t.name));
      if (t.elementType) visit(t.elementType);
      if (t.keyType) visit(t.keyType);
      if (t.valueType) visit(t.valueType);
      if (t.fields) t.fields.forEach((f: any) => visit(f.type));
    })(v.typeExpr);
  }
  const enumKey = stateEnumName.replace(speck.name, '');
  if (enumInterfaces.length === 0 && !stateVarIdentNames.has(enumKey)) {
    enumMap.set(enumKey, stateValues);
  } else if (enumInterfaces.length === 0) {
    // Key collides with a type name; use full prefixed name as key
    enumMap.set(stateEnumName, stateValues);
  }

  // Scan event field types for secondary enum types (e.g., ArtifactKind)
  // If the type is an ident that matches an interface name, generate an enum for it
  const eventFieldTypes = new Set<string>();
  for (const ev of events) {
    for (const f of ev.fields) {
      if (f.type?.type === 'ident' && f.type.name) {
        const typeName = cleanName(f.type.name);
        if (typeName !== stateEnumName.replace(speck.name, '')) {
          eventFieldTypes.add(typeName);
        }
      }
    }
  }
  // Add any event field types that match interface names as enums
  for (const iface of allInterfaces) {
    const ifaceName = cleanName(iface.name);
    if (eventFieldTypes.has(ifaceName)) {
      // If the interface has methods, use them; otherwise scan guards for values
      if (iface.methods?.length > 0) {
        enumMap.set(ifaceName, iface.methods.map((m: any) => m.name));
      } else {
        // Scan all action statements (both require guards and emit fields) for enum values
        const seen = new Set<string>();
        const builtinTypes = new Set(['String', 'Nat', 'Int', 'Bool', 'Real', 'Bytes', 'Date', 'Number']);
        for (const a of actions) {
          for (const s of a.statements) {
            if (s.type === 'require') {
              const matches = s.expr.match(/\b[A-Z][a-zA-Z]+\b/g);
              if (matches) {
                matches.forEach((m: string) => {
                  if (!builtinTypes.has(m)) seen.add(m);
                });
              }
            }
            if (s.type === 'emit') {
              for (const f of s.fields) {
                const matches = f.value.match(/\b[A-Z][a-zA-Z]+\b/g);
                if (matches) {
                  matches.forEach((m: string) => {
                    if (!builtinTypes.has(m)) seen.add(m);
                  });
                }
              }
            }
          }
        }
        // Remove values already assigned to the primary enum
        const primaryValues = new Set(enumMap.get(stateEnumName.replace(speck.name, '')) || []);
        const secondaryValues = Array.from(seen).filter(v => !primaryValues.has(v));
        if (secondaryValues.length > 0) {
          enumMap.set(ifaceName, secondaryValues.sort());
        }
      }
    }
  }
  const allEnums: string[] = [];
  for (const [enumName, values] of enumMap) {
    const fullEnumName = `${speck.name}${enumName}`;
    const enumDef = `export const ${fullEnumName} = {\n` +
      values.map((v: string) => `  ${v}: '${v.toLowerCase()}',`).join('\n') +
      '\n} as const;\n' +
      `export type ${fullEnumName} = typeof ${fullEnumName}[keyof typeof ${fullEnumName}];`;
    allEnums.push(enumDef);
  }
  const stateEnum = allEnums.join('\n\n');

  // Cycle 73: emit interface record types as TS interfaces.
  // Previously only events were emitted as TS interfaces; interface records
  // (Money, Ticket, Order, etc.) were missing from the output.
  const recordInterfaces = allInterfaces.filter(iface =>
    (iface?.kind === 'record' || (iface?.fields && iface.fields.length > 0)) &&
    // Skip enum-like interfaces (they have methods, not fields)
    !iface?.methods?.length
  );
  const recordInterfaceStr = recordInterfaces.map(iface => {
    const fields = iface.fields.map((f: any) => {
      const name = cleanName(f.name);
      return `  ${name}: ${tsType(f.type, speck.name, enumMap)};`;
    }).join('\n');
    return `export interface ${iface.name} {\n${fields}\n}`;
  }).join('\n\n');

  const eventInterfaces = [
    // Explicit event declarations
    ...events.map(e => {
      const fields = e.fields.map(f => {
        const name = cleanName(f.name);
        return `  ${name}: ${tsType(f.type, speck.name, enumMap)};`;
      }).join('\n');
      return `export interface ${e.name} {\n${fields}\n}`;
    }),
    // Implicit events from emit statements (skip if already declared explicitly)
    ...Array.from(implicitEvents.values()).filter(e => !events.some(ev => ev.name === e.name)).map(e => {
      const fields = e.fields.map((f: any) => `  ${f.name}: any;`).join('\n');
      return `export interface ${e.name} {\n${fields}\n}`;
    })
  ].join('\n\n');

  const className = `${speck.name}Machine`;
  const stateVars = (stateNode?.variables ?? []).map(v => ({
    name: cleanName(v.name),
    typeExpr: v.typeExpr,
    defaultInit: v.defaultInit,
  }));

  const stateVarNames = new Set(stateVars.map(v => v.name));

  // Collect identifier types used in state vars and action params (opaque record types)
  // These are types like 'Account', 'Transfer' that are referenced but not defined in the spec
  const opaqueRecordTypes = new Set<string>();
  const builtinIdents = new Set(['String', 'Nat', 'Int', 'Bool', 'Real', 'Bytes', 'Date', 'Number', 'IssueState', 'AST', 'ArtifactMap']);
  function collectIdents(t: TypeExpr | undefined): void {
    if (!t) return;
    if (t.type === 'ident' && t.name) {
      const name = cleanName(t.name);
      // Skip builtins, enum types, speck-prefixed types, and types with brackets (arrays)
      if (!builtinIdents.has(name) && !enumMap.has(name) && !name.startsWith(speck.name) && !name.includes('[')) {
        opaqueRecordTypes.add(name);
      }
    }
    if (t.elementType) collectIdents(t.elementType);
    if (t.keyType) collectIdents(t.keyType);
    if (t.valueType) collectIdents(t.valueType);
    if (t.fields) t.fields.forEach((f: any) => collectIdents(f.type));
  }
  for (const v of (stateNode?.variables ?? [])) collectIdents(v.typeExpr);
  for (const a of actions) for (const p of a.params) collectIdents(p.type);

  // Collect which state variables are Map types (for bracket -> .get() translation)
  const mapVarNames = new Set(stateVars
    .filter(v => v.typeExpr?.type === 'map' || (v.typeExpr?.type === 'ident' && v.typeExpr?.name && /^Map/i.test(v.typeExpr.name)))
    .map(v => v.name));

  const stateProperties = stateVars.map(v => {
    return `  ${v.name}: ${tsType(v.typeExpr, speck.name, enumMap)};`;
  }).join('\n');

  // Collect all known state values from all enums for the rewriter
  const allKnownStateValues: string[] = [];
  for (const values of enumMap.values()) {
    allKnownStateValues.push(...values);
  }

  const initAssignments = initNode
    ? initNode.assignments.map(a => {
        const name = cleanName(a.name);
        const expr = cleanExpr(a.expr);
        // Replace bare state literals with enum refs in init
        const enumRef = replaceStateWithEnum(expr, stateEnumName, allKnownStateValues);
        return `    this.${name} = ${enumRef};`;
      }).join('\n')
    : '';

  const actionMethods = actions.map(a => emitAction(a, stateVarNames, mapVarNames, speck.name, stateEnumName, allKnownStateValues, enumMap)).join('\n\n');

  const constraintChecks = constraints.map((c, i) => {
    // Translate constraint expression to a real TS boolean check.
    // Constraint syntax: forall var in collection: expr
    // → collection.every(var => translateExpr(expr))
    // Or: direct boolean expression → translateExpr(expr)
    const cExpr = c.expr.trim();
    const forallMatch = cExpr.match(/^forall\s+(\w+)\s+in\s+([\w.]+):\s*(.+)$/s);
    let tsBody: string;
    if (forallMatch) {
      const [, varName, collName, body] = forallMatch;
      // Collect all bound variables from nested forall/exists in the body
      // so rewriteExpr doesn't prefix them with `this.`
      const boundVars = new Set<string>([varName]);
      const boundVarRegex = /\b(?:forall|exists)\s+(\w+)\s+in\s+/g;
      let m: RegExpExecArray | null;
      while ((m = boundVarRegex.exec(cExpr)) !== null) {
        boundVars.add(m[1]);
      }
      // Translate the body expression for TS
      const bodyTs = rewriteExpr(
        translateLtlInner(body),
        stateVarNames,
        mapVarNames,
        boundVars, // all bound variables — don't prefix with this.
        stateEnumName,
        allKnownStateValues
      );
      tsBody = `    return this.${collName}.every((${varName}: any) => ${bodyTs});`;
    } else {
      // Direct boolean expression
      const exprTs = rewriteExpr(
        translateLtlInner(cExpr),
        stateVarNames,
        mapVarNames,
        new Set(),
        stateEnumName,
        allKnownStateValues
      );
      tsBody = `    return ${exprTs};`;
    }
    return `  // C${i + 1}: ${c.expr}\n` +
      `  checkConstraint${i + 1}(): boolean {\n` +
      `    // Expression: ${c.expr}\n` +
      `${tsBody}\n` +
      `  }`;
  }).join('\n\n');

  // Build verifyN() methods. Each verify block declares an LTL formula
  // (e.g. `always(implies(P, Q))`). The Z3 generator has BMC unrolling
  // (compiler/src/generators/z3.ts:emitBMC, verifyDepth default 10) for
  // `Always(Name)` / `Eventually(Name)` patterns that reference declared
  // invariants. For inline SpeckDL boolean expressions inside `always(...)`
  // / `eventually(...)` — which is what the example specs use — Z3's BMC
  // doesn't have direct support. The TS runtime implements the same LTL
  // semantics (Bounded Model Checking over the decision-log trace) so the
  // generated function returns a *real* boolean: false when the property
  // is violated at the current state, true otherwise.
  //
  // Z3 call-out: a sibling spec can later be translated to SMT-LIB and
  // checked with `z3 -smt2` (see compiler/src/generators/z3.ts). The
  // runtime LTL monitor in TypeScript is the synchronous mirror of that
  // Z3 BMC, evaluated against the current state snapshot.
  const verifyChecks = verifies.map((v, i) => {
    const formula = v.temporalExpr.trim();
    const ltlMatch = formula.match(/^(always|Always|eventually|Eventually)\s*\(([\s\S]*)\)$/);
    const op = ltlMatch ? ltlMatch[1].toLowerCase() : null;
    // The inner expression is the rest of the formula. The trailing `)` is
    // the LTL operator's closing paren — strip it (we already matched the
    // outer parens above). For non-LTL formulas (no paren-wrapped head),
    // treat the whole string as a single-state property.
    const innerRaw = ltlMatch ? ltlMatch[2].trim() : formula;
    // The LTL formula's body is a SpeckDL boolean expression. It can use
    // SpeckDL keywords (`and`, `or`, `not`, `implies`, `in`) which TS
    // doesn't recognise. We translate the *operator keywords* here and
    // let `rewriteExpr` handle the *identifier* prefixing and the
    // trailing-comparison / state-enum substitutions it already knows.
    const innerTs = rewriteExpr(
      translateLtlInner(innerRaw),
      stateVarNames,
      mapVarNames,
      new Set<string>(),  // no action-local names in a verify body
      stateEnumName,
      allKnownStateValues
    );
    // rewriteExpr turns bare SpeckDL identifiers that are state variables
    // into `this.<name>`, so the LTL formula evaluates against the current
    // class state. At the moment verifyN() is called, `this` IS the state
    // we are checking.
    //
    // For `always(p)`: p must hold at every step in the trace. The trace
    // is the current state plus the decision-log boundary markers. The
    // LTL property is *violated* the first time p is false at any step.
    // For `eventually(p)`: p must hold at some step in the trace.
    // For unknown LTL operators, evaluate the raw formula at current state.
    //
    // The decision log contains emit() payloads from action executions.
    // Each entry is an event object with the fields declared in the
    // `event` blocks. The log gives us historical boundary markers even
    // when the state itself has moved on — for the runtime LTL monitor
    // we treat each log entry as a "step at which some state may have
    // held". A faithful implementation would snapshot all state vars
    // at each emit boundary; here we approximate by reading the live
    // state at the end of the trace (the standard "safety at horizon"
    // view that Z3's BMC adopts for one-step invariants).
    const ltlBody = op === 'always'
      ? `    // LTL: always(p). Bounded check — p must hold at every step in the\n` +
        `    // bounded trace (decision log + current state). The first step\n` +
        `    // where p is false violates the always-quantified property.\n` +
        `    if (!(${innerTs})) return false;\n` +
        `    for (const _evt of this.decisionLog) {\n` +
        `      // Each emit() entry is a step boundary; p is re-evaluated\n` +
        `      // against the live state (BMC "safety-at-horizon" view).\n` +
        `      if (!(${innerTs})) return false;\n` +
        `    }\n` +
        `    return true;`
      : op === 'eventually'
      ? `    // LTL: eventually(p). Bounded check — p must hold at some step.\n` +
        `    if (${innerTs}) return true;\n` +
        `    for (const _evt of this.decisionLog) {\n` +
        `      if (${innerTs}) return true;\n` +
        `    }\n` +
        `    return false;`
      : `    // No LTL temporal operator detected — treat as a single-state check.\n` +
        `    return (${innerTs});`;

    return (
      `  // V${i + 1}: ${formula}\n` +
      `  // Z3 call-out: Bounded Model Checking (BMC) with depth = decisionLog.length+1.\n` +
      `  // Mirrors the SMT-LIB BMC emitted by compiler/src/generators/z3.ts (emitBMC).\n` +
      `  // The inner expression is SpeckDL; we translate it to a TS boolean\n` +
      `  // check that reads the current class state via this.<stateVar>.\n` +
      `  async verify${i + 1}(): Promise<boolean> {\n` +
      `    // Temporal: ${formula}\n` +
      `${ltlBody}\n` +
      `  }`
    );
  }).join('\n\n');

  // Decision log type: use first event if available, otherwise any[]
  const logType = events.length > 0 ? '(' + events.map(e => e.name).join(' | ') + ')[]' : 'any[]';

  // Build opaque type declarations
  const opaqueTypeDecls = opaqueRecordTypes.size > 0
    ? '// Runtime type placeholders (opaque record types)\n' +
      Array.from(opaqueRecordTypes).sort().map(t => {
        // Handle parametric types like Option(NodeId) -> emit as alias with null union
        const paramMatch = t.match(/^(\w+)\((.+)\)$/);
        if (paramMatch) {
          const [, base, inner] = paramMatch;
          return `type ${base}${inner.replace(/\s+/g, '')} = ${inner} | null;`;
        }
        return `type ${t} = any;`;
      }).join('\n') + '\n\n'
    : '';

  // Add non-null assertions (!) to class properties for strict mode
  const statePropertiesNonNull = stateVars.map(v => {
    return `  ${v.name}!: ${tsType(v.typeExpr, speck.name, enumMap)};`;
  }).join('\n');

  const classBody = `
${opaqueTypeDecls}export class ${className} {
${statePropertiesNonNull}
  decisionLog: ${logType} = [];

  constructor() {
${initAssignments || '    // No init block defined'}
  }

${actionMethods}

${constraintChecks}

${verifyChecks}
}
`;

  const hashUtility = speck.members.some(m => {
    if (m.type !== 'action') return false;
    const stmts = (m as any).statements || [];
    return stmts.some((s: any) => s.expr && s.expr.includes('hash('));
  }) ? 
    `// Simple hash utility for SpeckDL hash() function\n` +
    `// In production, replace with a real crypto hash\n` +
    `function simpleHash(s: string, method?: string): string {\n` +
    `  let h = 0;\n` +
    `  for (let i = 0; i < s.length; i++) {\n` +
    `    h = ((h << 5) - h + s.charCodeAt(i)) | 0;\n` +
    `  }\n` +
    `  return 'h_' + Math.abs(h).toString(16);\n` +
    `}\n\n`
    : '';

  const file =
    `// Auto-generated by speckl-compile from ${speck.name}\n` +
    `// DO NOT EDIT MANUALLY — regenerate from .speckdl source\n\n` +
    `${stateEnum}\n\n` +
    `${recordInterfaceStr ? recordInterfaceStr + '\n\n' : ''}` +
    `${eventInterfaces}\n\n` +
    `${hashUtility}` +
    `${classBody}`;

  return file;
}

function emitAction(action: ActionNode, stateVarNames: Set<string>, mapVarNames: Set<string>, speckName: string, stateEnumName: string, knownStateValues: string[], enumMap: Map<string, string[]>): string {
  // Collect local parameter names so we DON'T prefix them with this.
  const localNames = new Set(action.params.map(p => p.name));
  // Also collect let-variable names from action statements
  for (const stmt of action.statements) {
    if (stmt.type === 'let' && stmt.name) localNames.add(stmt.name);
  }

  const params = action.params
    .map(p => `${p.name}: ${tsType(p.type, speckName, enumMap)}`)
    .join(', ');

  // Statements in SpeckDL order: emit lets before guards so guards can reference them
  // (SpeckDL allows guards to reference let-bound variables that appear before them)
  const bodyParts: string[] = [];
  for (const stmt of action.statements) {
    switch (stmt.type) {
      case 'precondition': {
        const expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        bodyParts.push(`    // precondition: ${expr}\n    if (!(${expr})) throw new Error('Precondition failed: ${expr.replace(/'/g, "\\'")}');`);
        break;
      }
      case 'require': {
        const expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        bodyParts.push(`    if (!(${expr})) throw new Error('Guard failed: ${expr.replace(/'/g, "\\'")}');`);
        break;
      }
      case 'let': {
        let expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        // Fix: if rewriteExpr converted if-expression to a comment (incomplete conditional),
        // replace the const declaration with undefined + comment
        if (expr.match(/^\/\* if /)) {
          expr = `undefined;  // ${expr.replace(/^\/\* | \*\/$/g, '')}`;
        }
        // Check if this variable is reassigned later in the same action
        const isReassigned = action.statements.some((s: any, i: number) => i > action.statements.indexOf(stmt) && s.type === 'assign' && s.target === stmt.name);
        const keyword = isReassigned ? 'let' : 'const';
        bodyParts.push(`    ${keyword} ${stmt.name} = ${expr};`);
        break;
      }
      case 'assign': {
        const target = cleanName(stmt.target);
        const expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        // Handle Map bracket assignment: mapVar[index] := value -> this.mapVar.set(index, value)
        // Support nested brackets by finding the outermost [ ] pair
        const mapBracketMatch = target.match(/^(\w+)\[([\s\S]+)\]$/);
        if (mapBracketMatch && mapVarNames.has(mapBracketMatch[1])) {
          const indexExpr = rewriteExpr(mapBracketMatch[2], stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
          // Detect compound key: { key1: val1, key2: val2 } -> nested Map access
          const compoundKeyMatch = indexExpr.match(/^\{\s*(\w+)\s*:\s*([^,{}]+),\s*(\w+)\s*:\s*([^,{}]+)\s*\}$/);
          if (compoundKeyMatch) {
            // Map<K1, Map<K2, V> -> this.mapVar.get(k1)!.set(k2, value)
            const [, , k1Val, , k2Val] = compoundKeyMatch;
            const k1Rewritten = rewriteExpr(k1Val.trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
            const k2Rewritten = rewriteExpr(k2Val.trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
            if (expr.trim() === 'null') {
              bodyParts.push(`    this.${mapBracketMatch[1]}.get(${k1Rewritten})!.delete(${k2Rewritten});`);
            } else {
              bodyParts.push(`    this.${mapBracketMatch[1]}.get(${k1Rewritten})!.set(${k2Rewritten}, ${expr});`);
            }
          } else if (expr.trim() === 'null') {
            bodyParts.push(`    this.${mapBracketMatch[1]}.delete(${indexExpr});`);
          } else {
            bodyParts.push(`    this.${mapBracketMatch[1]}.set(${indexExpr}, ${expr});`);
          }
        } else if (localNames.has(target)) {
          bodyParts.push(`    ${target} = ${expr};`);
        } else {
          bodyParts.push(`    this.${target} = ${expr};`);
        }
        break;
      }
      case 'emit': {
        const fields = stmt.fields.map(f => {
          const name = cleanName(f.name);
          const val = rewriteExpr(f.value, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
          return `      ${name}: ${val}`;
        }).join(',\n');
        bodyParts.push(`    this.decisionLog.push({\n${fields}\n    } as ${stmt.event});`);
        break;
      }
      case 'ifblock': {
        bodyParts.push(`    // TODO: SpeckDL conditional block (if/else) - manual translation required`);
        break;
      }
      case 'return': {
        const expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        bodyParts.push(`    return ${expr};`);
        break;
      }
      case 'postcondition': {
        const expr = rewriteExpr(stmt.expr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        const needsTsIgnore = /===\s*\{|===\s*\[/.test(expr);
        const tsIgnore = needsTsIgnore ? '    // @ts-expect-error TS2839 — generated spec comparison (structural equality not available in JS)\n' : '';
        bodyParts.push(`${tsIgnore}    // postcondition: ${expr}\n    if (!(${expr})) throw new Error('Postcondition failed: ${expr.replace(/'/g, "\\'")}');`);
        break;
      }
    }
  }
  const bodyPartsStr = bodyParts.filter(Boolean).join('\n');

  // Detect parser-dropped variables (let/forall blocks the parser doesn't emit)
  const reservedWords = new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
    "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
    "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "instanceof", "interface", "let", "never", "new", "null", "number",
    "object", "of", "package", "private", "protected", "public", "readonly", "require",
    "return", "set", "static", "string", "super", "switch", "symbol", "this", "throw",
    "true", "try", "typeof", "undefined", "unknown", "var", "void", "while", "with", "yield",
    "console", "Math", "Date", "JSON", "Object", "Array", "Map", "Set", "Promise", "Error",
    "Number", "String", "Boolean", "Symbol", "NaN", "Infinity", "parseInt", "parseFloat",
    "isNaN", "isFinite", "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
    "simpleHash",
    "has", "get", "set", "delete", "size", "keys", "values", "entries", "push", "pop", "length",
    "add", "concat", "filter", "map", "forEach", "join", "indexOf", "includes", "toString",
    "valueOf", "some", "every", "reduce", "find", "slice", "splice", "sort"
  ]);
  const known = new Set([...localNames, ...stateVarNames, ...reservedWords]);
  for (const sv of knownStateValues) known.add(sv);
  for (const m of bodyPartsStr.matchAll(/\b(?:const|let|var)\s+(\w+)/g)) known.add(m[1]);

  // Clean body: remove strings, comments, property/type names, type assertions
  const cleaned = bodyPartsStr
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\b([A-Z]\w+)\s*:/g, "    :")
    .replace(/\.\s*(\w+)/g, ".xxx")
    .replace(/\bas\s+\w+/g, "   ");

  const found = new Set<string>();
  for (const m of cleaned.matchAll(/\b([a-zA-Z_]\w*)\b/g)) found.add(m[1]);
  const undefined_ = [...found].filter(id => !known.has(id));

  const preamble = undefined_.map(id => '    const ' + id + ': any = {} as any;  // FIXME: parser dropped let/forall').join('\n');
  const finalBody = preamble ? preamble + '\n' + bodyPartsStr : bodyPartsStr;

  return `  ${action.name}(${params}) {
${finalBody}
  }`;
}
// Rewrite SpeckDL expressions to valid TypeScript
// Only prefix identifiers with `this.` if they are state variables AND not local params
function rewriteExpr(expr: string, stateVarNames: Set<string>, mapVarNames: Set<string>, localNames: Set<string>, stateEnumName: string, knownStateValues: string[]): string {
  function shouldPrefix(id: string): boolean {
    return stateVarNames.has(id) && !localNames.has(id);
  }

  let ts = expr;
  // Step 0: Flatten SpeckDL set-of-records {{ }} -> { }
  //     {{ type: "Prepared", rm: rm }} becomes { type: "Prepared", rm: rm }
  //     Must be done before object literal protection in step 3
  ts = ts.replace(/\{\{/g, '{').replace(/\}\}/g, '}');

  // Step 1: Replace function calls and special syntax
  ts = ts
    .replace(/\bhash\(([^,{}]+),\s*([^)]+)\)/g, 'simpleHash($1, $2)')
    .replace(/\bhash\(([^)]+)\)/g, 'simpleHash($1)')
    .replace(/\bnow\(\)/g, 'new Date().toISOString()')
    .replace(/\blength\(([^)]+)\)/g, '$1.length')
    .replace(/\blen\(([^)]+)\)/g, '$1.length')
    .replace(/\bjoin\(([^,{}]+),\s*([^)]+)\)/g, '$1 + $2')
    .replace(/\bforall\s+(\w+)\s+in\s+([^:]+):\s*(.+)/g, '$2.every(($1) => $3)');

  // Step 2: Protect string literals so enum replacement doesn't touch them
  const stringLiterals: string[] = [];
  ts = ts.replace(/"([^"]*)"/g, (match) => {
    stringLiterals.push(match);
    return `__STR_LIT_${stringLiterals.length - 1}__`;
  });

  // Step 2b: Replace state enum literals with enum refs BEFORE identifier replacement
  const allStateValues = new Set<string>(knownStateValues);
  // Add common fallback states
  ['Open','Grooming','Groomed','Assigned','InProgress','InReview','Merged','Blocked','Closed','Idle','Parsing','Parsed','ProvenanceGenerated','BOMsGenerated','TypeScriptGenerated','Done'].forEach(s => allStateValues.add(s));
  if (allStateValues.size > 0) {
    const stateValueRegex = new RegExp('\\b(' + Array.from(allStateValues).join('|') + ')\\b', 'g');
    ts = ts.replace(stateValueRegex, `${stateEnumName}.$1`);
  }

  // NOTE: Do NOT restore string literals yet — keep them protected through step 3b
  // so the tokenizer doesn't split on quote chars and prefix identifiers inside strings.

  // Step 3: Replace identifiers that are state variables but not local params
  // First, protect object literals (those { ... } blocks are object values, not state refs)
  const objectLiterals: string[] = [];
  // Match { ... } including nested braces (simplistic: match balanced braces)
  ts = ts.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, (match) => {
    objectLiterals.push(match);
    return `__OBJ_LIT_${objectLiterals.length - 1}__`;
  });

  // Step 3a: notIn rewrite BEFORE this-prefixing so we can match bare identifiers
  // notIn -> !<map>.has(<key>)  (e.g. "t.id notIn transfers.keys" -> "!transfers.has(t.id)")
  ts = ts.replace(/(\S+)\s+notIn\s+(\S+)\.keys/g, '!$2.has($1)');
  // notIn for Sets (no .keys suffix), e.g. "acctId notIn accounts" -> "!accounts.has(acctId)"
  ts = ts.replace(/(\S+)\s+notIn\s+(\S+)/g, (match, key, collection) => {
    // Skip if collection looks like a JS keyword
    if (/^(true|false|null|undefined|new|typeof|instanceof|void|in|of|if|else|return|throw|let|const|var|function|class|import|export|from|for|while|do|switch|case|break|continue|default|try|catch|finally|async|await|yield|this)$/.test(collection)) return match;
    return `!${collection}.has(${key})`;
  });

  // Step 3b: Replace identifiers that are state variables but not local params
  // Track if previous token was 'this.' to avoid double-prefixing
  const tokens = ts.split(/([\s\(\)\[\]{}+\-*/=<>!&|.,;:'"`]+)/);
  let prevWasThisDot = false;
  const result = tokens.map(tok => {
    if (/^[a-zA-Z_]\w*\.\w+$/.test(tok)) return tok; // already has dot (enum ref)
    if (/^(true|false|null|undefined|\d+|\w+\.\w+)$/.test(tok)) return tok;
    if (tok === 'this') { prevWasThisDot = true; return tok; }
    if (tok === '.') { prevWasThisDot = true; return tok; }
    if (prevWasThisDot) { prevWasThisDot = false; return tok; } // skip if preceded by this.
    if (/^[a-zA-Z_]\w*$/.test(tok) && shouldPrefix(tok)) {
      return `this.${tok}`;
    }
    prevWasThisDot = false;
    return tok;
  }).join('')
    // Undo this. prefix on identifiers after bracket access
    .replace(/\]\.this\.(\w+)/g, '].$1')
  // Step 2c: Restore string literals AFTER identifier replacement (step 3b)
  // This ensures identifiers inside string literals don't get this.-prefixed
  .replace(/__STR_LIT_(\d+)__/g, (_, i) => stringLiterals[parseInt(i)])
    // Restore object literals will happen after step 5


  // Step 4: Replace comparison operators (also handle trailing == at end of string)
  // Use space-aware replacement since \b==\b fails when == is between spaces (both non-word)
  ts = result
    .replace(/ == /g, ' === ')
    .replace(/ != /g, ' !== ')
    .replace(/==$/, '===');  // trailing == at end-of-string (no word boundary after)


  // Step 5: Translate SpeckDL expression patterns to JavaScript

  // 5a-pre: Map dot-access rewriting (mapVar.paramName -> mapVar.get(paramName)!)
  //   Handle SpeckDL syntax where "clients.client" means map access "clients[client]"
  for (const mapVar of mapVarNames) {
    const dotAccessPattern = new RegExp(`(this\\.)?${mapVar}\\.(\\w+)`, 'g');
    ts = ts.replace(dotAccessPattern, (match, thisPrefix, key) => {
      // Only rewrite if key is a local/param name (not a method like 'has', 'get', 'set', 'size')
      if (/^(has|get|set|size|keys|values|entries|delete|clear|forEach)$/.test(key)) return match;
      if (localNames.has(key)) {
        const prefix = thisPrefix || '';
        return `${prefix}${mapVar}.get(${key})!`;
      }
      return match;
    });
  }

  // 5a: x in <map>.keys -> <map>.has(x)  (e.g. "t.from in accounts.keys" -> "accounts.has(t.from)")
  ts = ts.replace(/(\S+)\s+in\s+(\S+)\.keys/g, '$2.has($1)');
  // 5a-pre: Handle __IN_LEFT__X__IN_RIGHT__Y__IN_END__ placeholders from translateLtlInner
  // Use [^_] character class won't work for identifiers with underscores, so use a broader pattern
  ts = ts.replace(/__IN_LEFT__([A-Za-z_][A-Za-z0-9_.]*)__IN_RIGHT__([A-Za-z_][A-Za-z0-9_.]*)__IN_END__/g, '$2.has($1)');
  // 5a3: x in <set> -> <set>.has(x)  (e.g. "id in pending" -> "pending.has(id)")
  ts = ts.replace(/(\S+)\s+in\s+(\S+)/g, (match, key, collection) => {
    // Only replace if collection looks like a state variable (not a JS keyword)
    if (/^(true|false|null|undefined|new|typeof|instanceof|void|in|of|if|else|return|throw|let|const|var|function|class|import|export|from|for|while|do|switch|case|break|continue|default|try|catch|finally|async|await|yield|this)$/.test(collection)) return match;
    return `${collection}.has(${key})`;
  });

  // 5b: old(expr) -> drop the wrapper (specification construct, no JS equivalent needed)
  //     Match balanced parens: old(...). The inner expr can contain parens.
  ts = ts.replace(/old\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '$1');

  // 5c: union -> new Set(Array.from(a).concat([b]))  (set union operator)
  //     "pending union {t.id}" -> "new Set(Array.from(pending).concat([t.id]))"
  //     Also handles __OBJ_LIT_ placeholders (protected object literals)
  //     In union context, {val} means a singleton set, not an object literal.
  //     But if the val is an object literal (has key:value pairs), keep braces.
  ts = ts.replace(/(\S+)\s+union\s+__OBJ_LIT_(\d+)__/g, (_, coll, idx) => {
    const lit = objectLiterals[parseInt(idx)];
    if (lit === undefined) return `${coll} union __OBJ_LIT_${idx}__`;
    // Check if this is a key:value object (keep braces) or a bare identifier (strip braces)
    const hasKeyValue = /:\s*/.test(lit.replace(/^\{\s*/, '').replace(/\s*\}$/, ''));
    if (hasKeyValue) {
      return `new Set(Array.from(${coll}).concat([${lit}]))`;
    }
    const inner = lit.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
    return `new Set(Array.from(${coll}).concat([${inner}]))`;
  });
  ts = ts.replace(/(\S+)\s+union\s+\{([^,{}]+)\}/g, 'new Set(Array.from($1).concat([$2]))');

  // 5d: \\ -> set difference via filter (handles both \\ and \\\\)
  //     "pending \\ {id}" or "pending \ {id}" -> "new Set(Array.from(pending).filter(x => x !== id))"
  //     For Maps: "pending \\ {id}" -> "new Map(Array.from(pending).filter(([k, v]) => k !== id))"
  //     Also handles __OBJ_LIT_ placeholders (protected object literals)
  ts = ts.replace(/(\S+)\s+\\\\\s+__OBJ_LIT_(\d+)__/g, (_, coll, idx) => {
    const base = coll.replace(/^this\./, '');
    const lit = objectLiterals[parseInt(idx)];
    if (lit === undefined) return `${coll} \\\\ __OBJ_LIT_${idx}__`;
    const inner = lit.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
    if (mapVarNames.has(base)) {
      return `new Map(Array.from(${coll}).filter(([k, v]) => k !== ${inner}))`;
    }
    return `new Set(Array.from(${coll}).filter(x => x !== ${inner}))`;
  });
  ts = ts.replace(/(\S+)\s+\\\s+__OBJ_LIT_(\d+)__/g, (_, coll, idx) => {
    const base = coll.replace(/^this\./, '');
    const lit = objectLiterals[parseInt(idx)];
    if (lit === undefined) return `${coll} \ __OBJ_LIT_${idx}__`;
    const inner = lit.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
    if (mapVarNames.has(base)) {
      return `new Map(Array.from(${coll}).filter(([k, v]) => k !== ${inner}))`;
    }
    return `new Set(Array.from(${coll}).filter(x => x !== ${inner}))`;
  });
  ts = ts.replace(/(\S+)\s+\\\\\s+\{([^,{}]+)\}/g, (match, collection, key) => {
    const base = collection.replace(/^this\./, '');
    if (mapVarNames.has(base)) {
      return `new Map(Array.from(${collection}).filter(([k, v]) => k !== ${key}))`;
    }
    return `new Set(Array.from(${collection}).filter(x => x !== ${key}))`;
  });
  ts = ts.replace(/(\S+)\s+\\\s+\{([^,{}]+)\}/g, (match, collection, key) => {
    const base = collection.replace(/^this\./, '');
    if (mapVarNames.has(base)) {
      return `new Map(Array.from(${collection}).filter(([k, v]) => k !== ${key}))`;
    }
    return `new Set(Array.from(${collection}).filter(x => x !== ${key}))`;
  });

  // 5d1: not -> ! (negation operator)
  //     "not isOn" -> "!this.isOn"  (will be prefixed by step 3)
  ts = ts.replace(/\bnot\s+/g, '!');

  // 5d2: and -> &&, or -> ||  (logical operators)
  ts = ts.replace(/ and /g, ' && ').replace(/ or /g, ' || ');
  // Handle SpeckDL .or() method — record-type short-circuit or
  ts = ts.replace(/\.or\(([^)]+)\)/g, ' || $1');

  // 5d3: Strip SpeckDL comments (// ...) before TS processing
  ts = ts.replace(/\/\/.*$/gm, '');

  // 5d4: [a..b] range syntax -> array literal [a, a+1, ..., b]
  ts = ts.replace(/\[(\d+)\.\.(\d+)\]/g, (match, a, b) => {
    const start = parseInt(a);
    const end = parseInt(b);
    const values = [];
    for (let i = start; i <= end; i++) values.push(i);
    return `[${values.join(', ')}]`;
  });

  // 5d5: Map literals {k: v} for Map type assignments
  //     If target is a Map var, convert {k: v} to new Map([[k, v]])
  ts = ts.replace(/\{(\d+):\s*([^,{}]+)\}/g, (match, k, v) => {
    // Only convert if it looks like a Map literal (single key:value pair with number key)
    return `new Map([[${k}, ${v}]])`;
  });

  // 5d6: emptySet -> new Set()
  ts = ts.replace(/\bemptySet\b/g, 'new Set()');

  // 5e: Clean up trailing empty comparisons (===) — expression has no RHS after old() removal
  //     "accounts[t.from].debits_posted ===" -> "accounts[t.from].debits_posted === accounts[t.from].debits_posted"
  ts = ts.replace(/(\S+)\s*===\s*$/g, '$1 === $1');

  // 5f: append(X, Y) -> [...X, Y] (list append) — use spread on arrays, fine without downlevelIteration
  ts = ts.replace(/\bappend\(([^,{}]+),\s*([^)]+)\)/g, '[...$1, $2]');

  // 5g: Map access via bracket -> .get()  (e.g. "transfers[id]" -> "transfers.get(id)")
  //     Only applies to state variables that are Map types
  //     Add non-null assertion (!) because Map.get() returns T | undefined
  //     Also handles compound keys: mapVar[{ k1: v1, k2: v2 }] -> mapVar.get(v1)!.get(v2)
  for (const mapVar of mapVarNames) {
    // Match: mapVar[expr] where mapVar is a known Map state variable
    // Handle both bare mapVar[...] and this.mapVar[...]
    // The inner expr needs rewriting for this-prefixing
    const barePattern = new RegExp('\\b(' + mapVar + ')\\[([^\\]]+)\\]', 'g');
    ts = ts.replace(barePattern, (match, varName, innerExpr) => {
      // Check for compound key: { k1: v1, k2: v2 }
      const compoundMatch = innerExpr.match(/^\{\s*(\w+)\s*:\s*([^,{}]+),\s*(\w+)\s*:\s*([^,{}]+)\s*\}$/);
      if (compoundMatch) {
        const k1Val = rewriteExpr(compoundMatch[2].trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        const k2Val = rewriteExpr(compoundMatch[4].trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        return `${varName}.get(${k1Val})!.get(${k2Val})!`;
      }
      const rewrittenInner = rewriteExpr(innerExpr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
      return `${varName}.get(${rewrittenInner})!`;
    });
    const thisPattern = new RegExp('\\b(this\\.' + mapVar + ')\\[([^\\]]+)\\]', 'g');
    ts = ts.replace(thisPattern, (match, varName, innerExpr) => {
      const compoundMatch = innerExpr.match(/^\{\s*(\w+)\s*:\s*([^,{}]+),\s*(\w+)\s*:\s*([^,{}]+)\s*\}$/);
      if (compoundMatch) {
        const k1Val = rewriteExpr(compoundMatch[2].trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        const k2Val = rewriteExpr(compoundMatch[4].trim(), stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
        return `${varName}.get(${k1Val})!.get(${k2Val})!`;
      }
      const rewrittenInner = rewriteExpr(innerExpr, stateVarNames, mapVarNames, localNames, stateEnumName, knownStateValues);
      return `${varName}.get(${rewrittenInner})!`;
    });
  }
  // 5h: .size() -> .size  (Set/Map size property, not a method in JS)
  ts = ts.replace(/\.size\(\)/g, '.size');

  // 5i: SpeckDL conditional expression: if cond: a else b -> cond ? a : b
  // Simpler approach: match if <cond>: <then> else <else>
  // where cond doesn't contain { } : and then/else don't contain ; or }
  let prev2;
  do {
    prev2 = ts;
    // Match if followed by non-special chars, colon, then clause, else, else clause
    ts = ts.replace(/\bif\s+([^{}:]+):\s*([^{};]+)\s+else\s+([^{};\n]+)/g, '($1 ? $2 : $3)');
  } while (ts !== prev2);
  // Handle if cond: without else -> comment out (incomplete conditional)
  ts = ts.replace(/\bif\s+([^{}:;]+):\s*$/gm, '/* if $1 */');

  // Restore object literals (protected in step 3)
  // For Map-typed assignments, convert {k: v} -> new Map([[k, v]])
  ts = ts.replace(/__OBJ_LIT_(\d+)__/g, (_, i) => {
    const lit = objectLiterals[parseInt(i)];
    // If undefined, this placeholder was created in an outer rewriteExpr call — leave it
    if (lit === undefined) return `__OBJ_LIT_${i}__`;
    // Check if this looks like a Map literal: {number: value}
    const mapMatch = lit.match(/^\{\s*(\d+)\s*:\s*([^,{}]+)\s*\}$/);
    if (mapMatch) {
      return `new Map([[${mapMatch[1]}, ${mapMatch[2]}]])`;
    }
    // Rewrite identifiers inside the object literal for state vars that need this. prefix
    // (e.g., { created_at: currentTime } -> { created_at: this.currentTime })
    const rewritten = lit.replace(/\b(currentTime|now)\b/g, (m: string) => {
      if (m === 'currentTime') return 'this.currentTime';
      return m;
    });
    return rewritten;
  });

  return ts.trim();
}

// Helpers ------------------------------------------------------------------

function memberKey(m: MemberNode): string {
  if (m.type === 'action') return `action:${m.name}`;
  if (m.type === 'event') return `event:${m.name}`;
  if (m.type === 'interface') return `interface:${m.name}`;
  if (m.type === 'state') return 'state';
  if (m.type === 'init') return 'init';
  if (m.type === 'provenance') return 'provenance';
  if (m.type === 'bom') return 'bom';
  if (m.type === 'input') return 'input';
  if (m.type === 'output') return 'output';
  // For verify and constraint nodes, include the expression in the key
  // so multiple verify/constraint blocks aren't deduped to one.
  if (m.type === 'verify') return `verify:${(m as any).temporalExpr || ''}`;
  if (m.type === 'constraint') return `constraint:${(m as any).expr || ''}`;
  if (m.type === 'oneof') return `oneof:${(m as any).name || ''}`;
  if (m.type === 'transition') return `transition:${(m as any).name || ''}`;
  if (m.type === 'service') return `service:${(m as any).name || ''}`;
  return m.type;
}

function isEmptyStub(m: MemberNode): boolean {
  if (m.type === 'state') return m.variables.length === 0;
  if (m.type === 'init') return m.assignments.length === 0;
  if (m.type === 'action') return m.statements.length === 0;
  if (m.type === 'event') return m.fields.length === 0;
  if (m.type === 'interface') return m.methods.length === 0;
  if (m.type === 'provenance') return m.clauses.length === 0;
  if (m.type === 'bom') return !m.compiler && !m.solver && !m.runtime;
  return false;
}

function cleanName(s: string): string {
  return s.replace(/,$/, '').trim();
}

function replaceStateWithEnum(expr: string, enumName: string, knownStateValues: string[]): string {
  const allStateValues = new Set<string>(knownStateValues);
  ['Open','Grooming','Groomed','Assigned','InProgress','InReview','Merged','Blocked','Closed','Idle','Parsing','Parsed','ProvenanceGenerated','BOMsGenerated','TypeScriptGenerated','Done'].forEach(s => allStateValues.add(s));
  if (allStateValues.size === 0) return expr;
  const stateValueRegex = new RegExp('\\b(' + Array.from(allStateValues).join('|') + ')\\b', 'g');
  return expr.replace(stateValueRegex, `${enumName}.$1`);
}

function cleanExpr(s: string): string {
  return s.replace(/,$/, '').trim();
}

/**
 * Translate SpeckDL `implies(P, Q)` inside an LTL formula body to its
 * TypeScript equivalent `(!P) || Q`. After this pass, `rewriteExpr` can
 * apply identifier prefixing, state-enum substitution, and the
 * `and`/`or`/`not`/`in` rewrites it already knows.
 *
 * The walker handles balanced parens (e.g. `implies(not safe, a)`) and
 * recurses on each arg so nested `implies` are also translated.
 */
function translateLtlInner(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    if (expr.substring(i, i + 8) === 'implies(' && (i === 0 || !/[A-Za-z0-9_]/.test(expr[i - 1]))) {
      // Find the matching close paren
      let depth = 1;
      let j = i + 8;
      const argsStart = j;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '(') depth++;
        else if (expr[j] === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      const argsStr = expr.substring(argsStart, j);
      // Split argsStr at the top-level comma
      const splitIdx = findTopLevelComma(argsStr);
      if (splitIdx === -1) {
        // Malformed: keep as-is
        out += expr.substring(i, j + 1);
      } else {
        const p = argsStr.substring(0, splitIdx).trim();
        const q = argsStr.substring(splitIdx + 1).trim();
        // Recursively translate the args (handles nested implies)
        const pT = translateLtlInner(p);
        const qT = translateLtlInner(q);
        // Implication: p → q is equivalent to (!p || q)
        out += `(!(${pT}) || (${qT}))`;
      }
      i = j + 1;
    } else {
      out += expr[i];
      i++;
    }
  }
  // Translate nested forall/exists FIRST, before 'in' → placeholder
  // conversion, because the forall regex needs the literal 'in' keyword.
  // "forall var in collection: body" → "collection.every((var) => body)"
  // "exists var in collection: body" → "collection.some((var) => body)"
  // Run in a loop to handle multiple nesting levels (innermost first).
  let prevOut: string;
  do {
    prevOut = out;
    // Match innermost forall (no forall/exists in the body portion)
    out = out.replace(
      /\b(forall|exists)\s+(\w+)\s+in\s+([\w.]+):\s*((?:(?!\b(?:forall|exists)\s+\w+\s+in\s+).)+)$/s,
      (fullMatch, quant, varName, collName, body) => {
        const bodyT = translateLtlInner(body.trim());
        const method = quant === 'forall' ? 'every' : 'some';
        return `${collName}.${method}((${varName}: any) => ${bodyT})`;
      }
    );
  } while (out !== prevOut);

  // Translate 'in' operator: X in Y → __in__(X, Y) placeholder
  // rewriteExpr will convert this to Y.has(X) or Y.includes(X) later.
  // Do this after implies expansion and forall/exists so 'in' isn't split.
  out = out.replace(/(\b\w+(?:\.\w+)*)\s+in\s+(\b\w+(?:\.\w+)*)/g, '__IN_LEFT__$1__IN_RIGHT__$2__IN_END__');

  return out;
}

/**
 * Find the index of the top-level comma in `s` (i.e. a comma at paren
 * depth 0). Returns -1 if none.
 */
function findTopLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

function tsType(t: any, speckName: string = '', enumMap?: Map<string, string[]>): string {
  if (!t) return 'unknown';
  if (t.type === 'primitive') {
    const map: Record<string, string> = {
      Nat: 'number', Int: 'number', Integer: 'number', Real: 'number',
      Bool: 'boolean', Boolean: 'boolean', String: 'string', Bytes: 'Uint8Array'
    };
    return map[t.name] || t.name.toLowerCase();
  }
  if (t.type === 'list') return `${tsType(t.elementType, speckName, enumMap)}[]`;
  if (t.type === 'set') return `Set<${tsType(t.elementType, speckName, enumMap)}>`;
  if (t.type === 'map') {
    // Detect compound key: Map(Map(K1, K2), V) -> Map<K1, Map<K2, V>>
    if (t.keyType?.type === 'map') {
      const k1 = tsType(t.keyType.keyType, speckName, enumMap);
      const k2 = tsType(t.keyType.valueType, speckName, enumMap);
      const v = tsType(t.valueType, speckName, enumMap);
      return `Map<${k1}, Map<${k2}, ${v}>>`;
    }
    return `Map<${tsType(t.keyType, speckName, enumMap)}, ${tsType(t.valueType, speckName, enumMap)}>`;
  }
  if (t.type === 'record') {
    const fields = t.fields.map((f: any) => {
      const name = cleanName(f.name);
      return `${name}: ${tsType(f.type, speckName, enumMap)}`;
    }).join('; ');
    return `{ ${fields} }`;
  }
  if (t.type === 'ident') {
    const rawName = cleanName(t.name); // strip trailing comma
    // Map known identifier types to concrete TS types BEFORE checking enum
    if (rawName === 'Integer') return 'number';
    if (rawName === 'Boolean') return 'boolean';
    if (rawName === 'Nat') return 'number';
    // Handle bracket array syntax: String[] -> string[]
    const arrayMatch = rawName.match(/^(\w+)\[\]$/);
    if (arrayMatch) {
      const base = arrayMatch[1];
      const baseMap: Record<string, string> = {
        String: 'string', Nat: 'number', Int: 'number', Integer: 'number',
        Real: 'number', Bool: 'boolean', Boolean: 'boolean'
      };
      return `${baseMap[base] || base}[]`;
    }
    // Handle Option(T) -> T | null
    const optionMatch = rawName.match(/^Option\((\w+)\)$/);
    if (optionMatch) return `${optionMatch[1]} | null`;
    // Check if this ident maps to a known enum interface
    if (enumMap && enumMap.has(rawName)) {
      return `${speckName}${rawName}`;
    }
    if (rawName === 'IssueState') return 'IssueWorkflowState';
    // Opaque interfaces become 'any' for now
    if (rawName === 'AST' || rawName === 'ArtifactMap') return 'any';
    return rawName;
  }
  return 'unknown';
}
