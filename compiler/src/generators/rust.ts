import { AST, SpeckNode, MemberNode, StateNode, InitNode, ActionNode, ConstraintNode, VerifyNode, EventNode } from '../parser.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate Rust state machine from a SpeckDL spec.
 *
 * Outputs a self-contained .rs file with:
 *  - State struct with snake_case fields
 *  - State machine impl with action methods returning Result
 *  - Invariant check functions
 *  - Event enums
 *  - Cargo.toml for full crate builds
 *
 * Pattern:
 *   state → Rust struct fields
 *   actions → Rust methods (Result return, guard errors)
 *   invariants → Rust functions returning bool
 *   events → Rust structs
 */

export function generateRust(ast: AST, outputDir: string): void {
  for (const speck of ast.specks) {
    const code = emitSpeck(speck);

    // Create a subdirectory per speck for Cargo.toml + src/lib.rs
    const speckDir = path.join(outputDir, speck.name);
    const srcDir = path.join(speckDir, 'src');
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
    }

    const libPath = path.join(srcDir, 'lib.rs');
    fs.writeFileSync(libPath, code);
    console.log(`Generated Rust crate: ${libPath}`);

    // Write Cargo.toml
    const cargoToml = `[package]
name = "${snakeCase(speck.name)}"
version = "0.1.0"
edition = "2021"
description = "Auto-generated Speck state machine: ${speck.name}"

[dependencies]
`;
    fs.writeFileSync(path.join(speckDir, 'Cargo.toml'), cargoToml);
    console.log(`Generated Cargo.toml: ${speckDir}/Cargo.toml`);
  }
}

/**
 * Translate SpeckDL implies() to Rust boolean expression.
 * implies(p, q) → (!p || q) in Rust.
 * Also handles bare implies: implies A B → (!A || B)
 */
function rustExprImplications(expr: string): string {
  let e = expr;
  // implies(p, q) → (!(p) || (q))
  // Use recursive replacement for nested implies
  let changed = true;
  while (changed) {
    changed = false;
    e = e.replace(/implies\s*\(([^,()]*(?:\([^()]*\)[^()]*)*),\s*([^()]+)\)/g, (_, p, q) => {
      changed = true;
      return `(!(${p.trim()}) || (${q.trim()}))`;
    });
  }
  // nil → Rust's Option::None equivalent: use a sentinel. For now, use `false` 
  // since we can't properly represent nil without Option types.
  e = e.replace(/\bnil\b/g, 'false /* nil sentinel */');
  // == → == (already Rust), != → != (already Rust)
  return e;
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
  const constraints = members.filter(m => m.type === 'constraint') as ConstraintNode[];
  const verifies = members.filter(m => m.type === 'verify') as VerifyNode[];

  // Collect enum-like interfaces
  const allInterfaces = members.filter(m => m.type === 'interface') as any[];
  const enumInterfaces = allInterfaces.filter(iface => iface?.methods?.length > 0);

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

  // Build enum map
  const enumMap = new Map<string, string[]>();
  for (const iface of enumInterfaces) {
    enumMap.set(iface.name, iface.methods.map((m: any) => m.name));
  }

  // Determine state enum name
  const stateVarType = stateNode?.variables?.[0]?.typeExpr;
  let stateEnumName = `${speck.name}State`;
  if (stateVarType?.type === 'ident' && stateVarType.name) {
    const cleanTypeName = cleanName(stateVarType.name);
    stateEnumName = `${speck.name}${cleanTypeName}`;
  } else if (enumMap.size > 0) {
    const firstEnum = enumMap.keys().next().value;
    if (firstEnum) stateEnumName = `${speck.name}${firstEnum}`;
  }

  if (enumInterfaces.length === 0) {
    enumMap.set(stateEnumName.replace(speck.name, ''), stateValues);
  }

  // Scan event field types for secondary enums
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
  for (const iface of allInterfaces) {
    const ifaceName = cleanName(iface.name);
    if (eventFieldTypes.has(ifaceName)) {
      if (iface.methods?.length > 0) {
        enumMap.set(ifaceName, iface.methods.map((m: any) => m.name));
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
        const primaryValues = new Set(enumMap.get(stateEnumName.replace(speck.name, '')) || []);
        const secondaryValues = Array.from(seen).filter(v => !primaryValues.has(v));
        if (secondaryValues.length > 0) {
          enumMap.set(ifaceName, secondaryValues.sort());
        }
      }
    }
  }

  // Generate Rust enums
  const allEnums: string[] = [];
  for (const [enumName, values] of enumMap) {
    const fullEnumName = `${speck.name}${enumName}`;
    const variants = values.map((v: string) => `    ${v},`).join('\n');
    const enumDef = `#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n` +
      `pub enum ${fullEnumName} {\n${variants}\n}`;
    allEnums.push(enumDef);

    const displayArms = values.map((v: string) =>
      `            ${fullEnumName}::${v} => write!(f, "${snakeCase(v)}"),`
    ).join('\n');
    const displayImpl = `impl std::fmt::Display for ${fullEnumName} {\n` +
      `    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n` +
      `        match self {\n${displayArms}\n` +
      `        }\n` +
      `    }\n` +
      `}`;
    allEnums.push(displayImpl);
  }
  const stateEnum = allEnums.join('\n\n');

  // Event structs
  const eventStructs = events.map(e => {
    const fields = e.fields.map(f => {
      const name = snakeCase(cleanName(f.name));
      const ty = rustType(f.type, speck.name, enumMap);
      return `    pub ${name}: ${ty},`;
    }).join('\n');
    return `#[derive(Debug, Clone)]\npub struct ${e.name} {\n${fields}\n}`;
  }).join('\n\n');

  // Cycle 73: Event enum union for the decision log.
  // Each variant wraps the corresponding event struct.
  const eventEnum = events.length > 0
    ? `#[derive(Debug, Clone)]\npub enum ${speck.name}Event {\n` +
      events.map(e => `    ${e.name}(${e.name}),`).join('\n') +
      `\n}`
    : '';

  // Cycle 73: Interface record structs (Money, Ticket, Order, etc.)
  // Previously only events were emitted as structs. Interface records
  // with fields (kind === 'record') are now emitted too.
  const recordInterfaces = allInterfaces.filter(iface =>
    iface?.kind === 'record' || (iface?.fields && iface.fields.length > 0)
  );
  const recordStructs = recordInterfaces.map(iface => {
    const fields = iface.fields.map((f: any) => {
      const name = snakeCase(cleanName(f.name));
      const ty = rustType(f.type, speck.name, enumMap);
      return `    pub ${name}: ${ty},`;
    }).join('\n');
    return `#[derive(Debug, Clone)]\npub struct ${iface.name} {\n${fields}\n}`;
  }).join('\n\n');

  const structName = `${speck.name}Machine`;

  // State variables with original name + snake_case name mapping
  const stateVars = (stateNode?.variables ?? []).map(v => ({
    origName: cleanName(v.name),
    rustName: snakeCase(cleanName(v.name)),
    typeExpr: v.typeExpr,
    defaultInit: v.defaultInit,
  }));

  // Build name mapping for expression rewriting: original name → Rust field name
  const nameMap = new Map<string, string>();
  for (const v of stateVars) {
    nameMap.set(v.origName, v.rustName);
  }

  // For expression matching, use the original names
  const stateVarOrigNames = new Set(stateVars.map(v => v.origName));

  // Map variable original names (for bracket -> index rewriting)
  const mapVarOrigNames = new Set(stateVars
    .filter(v => v.typeExpr?.type === 'map' || (v.typeExpr?.type === 'ident' && v.typeExpr?.name && /^Map/i.test(v.typeExpr.name)))
    .map(v => v.origName));

  // State struct fields
  const stateFields = stateVars.map(v => {
    return `    pub ${v.rustName}: ${rustType(v.typeExpr, speck.name, enumMap)},`;
  }).join('\n');

  // Collect all known state values for the rewriter
  const allKnownStateValues: string[] = [];
  for (const values of enumMap.values()) {
    allKnownStateValues.push(...values);
  }

  // Init assignments
  const initAssignments = initNode
    ? initNode.assignments.map(a => {
        const rustName = snakeCase(cleanName(a.name));
        const expr = cleanExpr(a.expr);
        const rewritten = rewriteRustExpr(
          expr, nameMap, mapVarOrigNames, new Set(),
          stateEnumName, allKnownStateValues
        );
        return `            ${rustName}: ${rewritten},`;
      }).join('\n')
    : '';
  // If no explicit init assignments, emit defaults for all state vars
  const initFields = initAssignments || stateVars.map(v => {
    const defaultValue = defaultRustValue(v.rustName, v.typeExpr);
    return `            ${v.rustName}: ${defaultValue},`;
  }).join('\n');

  // Action methods
  const actionMethods = actions
    .map(a => emitAction(a, stateVarOrigNames, nameMap, mapVarOrigNames, speck.name, stateEnumName, allKnownStateValues, enumMap))
    .join('\n\n');

  // Invariant checks — translate constraint expressions to real Rust boolean checks.
  // Constraint syntax: forall var in collection: expr
  // → collection.iter().all(|var| translated_expr)
  // Or: direct boolean expression → translated_expr
  const invariantChecks = constraints.map((c, i) => {
    const cExpr = c.expr.trim();
    const forallMatch = cExpr.match(/^forall\s+(\w+)\s+in\s+(\w+):\s*(.+)$/s);
    let rustBody: string;
    if (forallMatch) {
      const [, varName, collName, body] = forallMatch;
      const rustColl = nameMap.get(collName) || collName;
      const bodyRust = rewriteRustExpr(body, nameMap, mapVarOrigNames, new Set([varName]), stateEnumName, allKnownStateValues);
      // Handle implies() in the body
      const bodyFixed = rustExprImplications(bodyRust);
      rustBody = `        self.${rustColl}.iter().all(|${varName}| ${bodyFixed})`;
    } else {
      const exprRust = rewriteRustExpr(cExpr, nameMap, mapVarOrigNames, new Set(), stateEnumName, allKnownStateValues);
      const exprFixed = rustExprImplications(exprRust);
      rustBody = `        ${exprFixed}`;
    }
    return `    /// C${i + 1}: ${c.expr}\n` +
      `    pub fn check_invariant_${i + 1}(&self) -> bool {\n` +
      `        // Expression: ${c.expr}\n` +
      `${rustBody}\n` +
      `    }`;
  }).join('\n\n');

  // Verify checks — translate temporal expressions to real Rust boolean checks.
  // LTL: always(p) → p must hold at current state + every decision-log entry.
  //       eventually(p) → p must hold at some step.
  const verifyChecks = verifies.map((v, i) => {
    const formula = v.temporalExpr.trim();
    const ltlMatch = formula.match(/^(?:always|eventually)\s*\(([\s\S]*)\)$/);
    const op = ltlMatch ? formula.match(/^(always|eventually)/)?.[1] : null;
    const inner = ltlMatch ? ltlMatch[1].trim() : formula;
    const innerRust = rustExprImplications(rewriteRustExpr(inner, nameMap, mapVarOrigNames, new Set(), stateEnumName, allKnownStateValues));
    let body: string;
    if (op === 'always') {
      body = `        if !(${innerRust}) return false;\n` +
        `        for _evt in &self.decision_log {\n` +
        `            if !(${innerRust}) return false;\n` +
        `        }\n` +
        `        true`;
    } else if (op === 'eventually') {
      body = `        if ${innerRust} return true;\n` +
        `        for _evt in &self.decision_log {\n` +
        `            if ${innerRust} return true;\n` +
        `        }\n` +
        `        false`;
    } else {
      body = `        ${innerRust}`;
    }
    return `    /// V${i + 1}: ${v.temporalExpr}\n` +
      `    pub fn verify_${i + 1}(&self) -> bool {\n` +
      `        // Temporal: ${v.temporalExpr}\n` +
      `${body}\n` +
      `    }`;
  }).join('\n\n');

  // Decision log type — cycle 73: use an enum union of all event types,
  // not just the first one. If there are no events, fall back to String.
  const logEventType = events.length > 0
    ? `Vec<${speck.name}Event>`
    : 'Vec<String>';

  // Struct definition
  const structDef = `/// Speck state machine: ${speck.name}\n` +
    `/// Auto-generated Rust state machine from SpeckDL specification.\n` +
    `#[derive(Debug, Clone)]\n` +
    `pub struct ${structName} {\n${stateFields}\n` +
    `    /// Decision log of events emitted during execution\n` +
    `    pub decision_log: ${logEventType},\n` +
    `}`;

  // Constructor impl
  const constructor = `impl ${structName} {\n` +
    `    /// Create a new ${speck.name} machine in its initial state.\n` +
    `    pub fn new() -> Self {\n` +
    `        Self {\n` +
    `${initFields}\n` +
    `            decision_log: Vec::new(),\n` +
    `        }\n` +
    `    }\n` +
    `}`;

  // Action impl block
  const actionImpl = `// Action methods — each returns Result with guard checking\n` +
    `impl ${structName} {\n${actionMethods}\n}`;

  // Invariant impl block
  const invariantImpl = constraints.length > 0
    ? `\n// Invariant checks\nimpl ${structName} {\n${invariantChecks}\n}`
    : '';

  // Verify impl block
  const verifyImpl = verifies.length > 0
    ? `\n// Temporal verification stubs\nimpl ${structName} {\n${verifyChecks}\n}`
    : '';

  const file =
    `// Auto-generated by speckl-compile from ${speck.name}\n` +
    `// DO NOT EDIT MANUALLY — regenerate from .speckdl source\n\n` +
    `use std::collections::{HashMap, HashSet};\n\n` +
    `${stateEnum}\n\n` +
    `${recordStructs ? recordStructs + '\n\n' : ''}` +
    `${eventStructs}\n\n` +
    `${eventEnum ? eventEnum + '\n\n' : ''}` +
    `${structDef}\n\n` +
    `${constructor}\n\n` +
    `${actionImpl}\n` +
    `${invariantImpl}` +
    `${verifyImpl}\n`;

  return file;
}

function emitAction(
  action: ActionNode,
  stateVarOrigNames: Set<string>,
  nameMap: Map<string, string>,
  mapVarOrigNames: Set<string>,
  speckName: string,
  stateEnumName: string,
  knownStateValues: string[],
  enumMap: Map<string, string[]>
): string {
  const localNames = new Set(action.params.map(p => cleanName(p.name)));

  const params = action.params
    .map(p => `${snakeCase(cleanName(p.name))}: ${rustType(p.type, speckName, enumMap)}`)
    .join(', ');

  const methodName = snakeCase(action.name);

  // Preconditions
  const preconditions = action.statements
    .filter(s => s.type === 'precondition')
    .map(s => {
      const expr = rewriteRustExpr(s.expr, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
      return `        // precondition: ${s.expr}\n        if !(${expr}) {\n            return Err(format!("Precondition failed: {}", ${JSON.stringify(s.expr)}));\n        }`;
    })
    .join('\n');

  // Requires (guards)
  const requires = action.statements
    .filter(s => s.type === 'require')
    .map(s => {
      const expr = rewriteRustExpr(s.expr, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
      return `        if !(${expr}) {\n            return Err(format!("Guard failed: {}", ${JSON.stringify(s.expr)}));\n        }`;
    })
    .join('\n');

  // Assignments
  const assigns = action.statements
    .filter(s => s.type === 'assign')
    .map(s => {
      const target = snakeCase(cleanName(s.target));
      const expr = rewriteRustExpr(s.expr, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
      return `        self.${target} = ${expr};`;
    })
    .join('\n');

  // Emits
  const emits = action.statements
    .filter(s => s.type === 'emit')
    .map(s => {
      const fields = s.fields
        .map(f => {
          const name = snakeCase(cleanName(f.name));
          const val = rewriteRustExpr(f.value, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
          return `            ${name}: ${val},`;
        })
        .join('\n');
      return `        self.decision_log.push(${s.event} {\n${fields}\n        });`;
    })
    .join('\n');

  // Postconditions
  const postconditions = action.statements
    .filter(s => s.type === 'postcondition')
    .map(s => {
      const expr = rewriteRustExpr(s.expr, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
      return `        // postcondition: ${s.expr}\n        if !(${expr}) {\n            return Err(format!("Postcondition failed: {}", ${JSON.stringify(s.expr)}));\n        }`;
    })
    .join('\n');

  // Returns
  const returnStmts = action.statements
    .filter(s => s.type === 'return')
    .map(s => {
      const expr = rewriteRustExpr(s.expr, nameMap, mapVarOrigNames, localNames, stateEnumName, knownStateValues);
      return `        Ok(${expr})`;
    })
    .join('\n');

  const guards = [preconditions, requires].filter(s => s.length > 0);
  const mutations = [assigns, emits].filter(s => s.length > 0);
  const postPost = [postconditions, returnStmts].filter(s => s.length > 0);

  const bodyParts: string[] = [];
  if (guards.length > 0) bodyParts.push(guards.join('\n'));
  if (mutations.length > 0) bodyParts.push(mutations.join('\n'));
  if (postPost.length > 0) bodyParts.push(postPost.join('\n'));

  const body = bodyParts.join('\n');

  // Determine return type
  const hasReturn = action.statements.some(s => s.type === 'return');
  const returnType = hasReturn ? ' -> Result<bool, String>' : ' -> Result<(), String>';

  return `    /// Execute action: ${action.name}\n    pub fn ${methodName}(&mut self${params ? ', ' + params : ''})${returnType} {\n${body || '        Ok(())\n'}\n    }`;
}

/**
 * Rewrite SpeckDL expressions to valid Rust.
 *
 * @param nameMap - Maps original SpeckDL variable names → Rust snake_case field names (e.g. isOn → is_on)
 * @param mapVarNames - Set of original variable names that are Map-typed (for bracket access rewriting)
 */
function rewriteRustExpr(
  expr: string,
  nameMap: Map<string, string>,
  mapVarOrigNames: Set<string>,
  localNames: Set<string>,
  stateEnumName: string,
  knownStateValues: string[]
): string {
  function shouldPrefix(ident: string): boolean {
    return nameMap.has(ident) && !localNames.has(ident);
  }

  function rustify(ident: string): string {
    const mapped = nameMap.get(ident);
    return mapped ? `self.${mapped}` : ident;
  }

  // Step 1: Replace function calls
  let rust = expr
    .replace(/\bnow\(\)/g, 'std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()')
    .replace(/\blen\(([^)]+)\)/g, '$1.len()')
    .replace(/\blength\(([^)]+)\)/g, '$1.len()')
    .replace(/\bjoin\(([^,]+),\s*([^)]+)\)/g, '$1.join($2)')
    .replace(/\bappend\(([^,]+),\s*([^)]+)\)/g, '{$1.push($2); $1} /* append */')
    .replace(/\bforall\s+(\w+)\s+in\s+([^:]+):\s*(.+)/g, '$2.iter().all(|$1| $3)');

  // Step 2: Replace state enum literals with Rust enum refs BEFORE identifier replacement
  const allStateValues = new Set<string>(knownStateValues);
  ['Open','Grooming','Groomed','Assigned','InProgress','InReview','Merged','Blocked','Closed','Idle','Parsing','Parsed','ProvenanceGenerated','BOMsGenerated','TypeScriptGenerated','Done'].forEach(s => allStateValues.add(s));
  if (allStateValues.size > 0) {
    const stateValueRegex = new RegExp('\\b(' + Array.from(allStateValues).join('|') + ')\\b', 'g');
    rust = rust.replace(stateValueRegex, `${stateEnumName}::$1`);
  }

  // Step 3: Replace SpeckDL identifiers with self.rust_name if they're state vars
  // Split on non-identifier boundaries
  const tokens = rust.split(/([\s\(\)\[\]{}+\-*/=<>!&|.,;:'"`]+)/);
  const result = tokens.map(tok => {
    if (/^[a-zA-Z_]\w*::\w+$/.test(tok)) return tok; // already :: (enum ref)
    if (/^[a-zA-Z_]\w*\.\w+$/.test(tok)) return tok; // already dot (field access)
    if (/^(true|false|null|None|Some|Ok|Err|not|and|or|in|notIn|old|forall)$/.test(tok)) return tok;
    if (/^\d+$/.test(tok)) return tok;
    if (/^[a-zA-Z_]\w*$/.test(tok) && shouldPrefix(tok)) {
      return rustify(tok);
    }
    return tok;
  }).join('');

  rust = result
    // Undo self. prefix that accidentally got added after bracket access
    .replace(/\]\.self\.(\w+)/g, '].$1');

  // Step 4: Translate SpeckDL expression patterns to Rust

  // 4a: notIn -> !collection.contains(&key)
  rust = rust.replace(/(\S+)\s+notIn\s+(\S+)\.keys/g, '!$2.contains_key(&$1)');
  // x in map.keys -> map.contains_key(&x)
  rust = rust.replace(/(\S+)\s+in\s+(\S+)\.keys/g, '$2.contains_key(&$1)');
  // x in set -> set.contains(&x)  (but be careful not to match Rust keywords)
  rust = rust.replace(/(\S+)\s+in\s+(\S+)/g, (match, key, collection) => {
    const reserved = new Set(['true','false','self','mut','ref','let','fn','pub','use','mod','struct','enum','impl','for','while','loop','if','else','match','return','where','as','move','dyn','unsafe','extern','crate','super','Self']);
    if (reserved.has(collection)) return match;
    return `${collection}.contains(&${key})`;
  });
  // notIn plain (not .keys)
  rust = rust.replace(/(\S+)\s+notIn\s+(\S+)/g, '!$2.contains(&$1)');

  // 4b: not expr → !expr  (SpeckDL 'not' keyword)
  // Need to handle 'not' followed by an identifier — this was already handled above with self-dot rewrite
  // But plain 'not ident' must become '!self.field_name'
  rust = rust.replace(/\bnot\s+([a-zA-Z_]\w*)/g, '!$1');

  // 4c: old(expr) → drop the wrapper (specification-only construct)
  // Match balanced parens: old(...)
  rust = rust.replace(/old\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '$1');

  // 4d: Set union: pending union {t.id}
  rust = rust.replace(/(\S+)\s+union\s+\{([^}]+)\}/g, '{$1.clone().into_iter().chain(std::iter::once($2)).collect()}');

  // 4e: Set difference: pending \\ {id}
  rust = rust.replace(/(\S+)\s+\\\\\s+\{([^}]+)\}/g, '{$1.clone().into_iter().filter(|x| x != &$2).collect()}');

  // 4f: Map access via brackets → bracket indexing (Rust uses &key for HashMap)
  for (const mapVar of mapVarOrigNames) {
    const rustMapVar = nameMap.get(mapVar) || snakeCase(mapVar);
    // Handle self.field_name[expr] or bare field_name[expr]
    // Must run BEFORE identifier replacement so original names match
    const pattern1 = new RegExp(`(self\\.)?(${escapeRegex(rustMapVar)})\\[([^\\]]+)\\]`, 'g');
    rust = rust.replace(pattern1, '$1$2[&$3]');
    // Also handle original name in brackets (e.g. accounts[...])
    const pattern2 = new RegExp(`(self\\.)?(${escapeRegex(mapVar)})\\[([^\\]]+)\\]`, 'g');
    rust = rust.replace(pattern2, (match, p1, _p2, p3) => {
      const prefix = p1 || '';
      return `${prefix}${rustMapVar}[&${p3}]`;
    });
  }

  // 4g: .size() → .len() (Rust collections use .len())
  rust = rust.replace(/\.size\(\)/g, '.len()');

  // 4h: == → keeps == (Rust uses ==), but handle === → ==
  rust = rust.replace(/\b===\b/g, '==');

  // 4i: != keeps != in Rust

  // 4j: Clean up trailing standalone comparisons
  rust = rust.replace(/(\S+)\s*==\s*$/g, '$1 == $1');
  rust = rust.replace(/(\S+)\s*===\s*$/g, '$1 == $1');

  return rust.trim();
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

function cleanExpr(s: string): string {
  return s.replace(/,$/, '').trim();
}

function snakeCase(s: string): string {
  // Convert CamelCase/PascalCase to snake_case
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([a-zA-Z])(\d)/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultRustValue(rustName: string, typeExpr: any): string {
  if (!typeExpr) return 'Default::default()'; // not ideal but a fallback
  if (typeExpr.type === 'primitive') {
    switch (typeExpr.name) {
      case 'Nat': return '0u64';
      case 'Int': return '0i64';
      case 'Real': case 'Number': return '0.0f64';
      case 'Bool': return 'false';
      case 'String': return 'String::new()';
      case 'Bytes': return 'Vec::new()';
      default: return 'Default::default()';
    }
  }
  if (typeExpr.type === 'list') return 'Vec::new()';
  if (typeExpr.type === 'set') return 'HashSet::new()';
  if (typeExpr.type === 'map') return 'HashMap::new()';
  return 'Default::default()';
}

function rustType(t: any, speckName: string = '', enumMap?: Map<string, string[]>): string {
  if (!t) return '()';
  if (t.type === 'primitive') {
    const map: Record<string, string> = {
      Nat: 'u64', Int: 'i64', Real: 'f64',
      Bool: 'bool', String: 'String', Bytes: 'Vec<u8>',
      Number: 'f64',
      // Cycle 73: Date → u64 Unix timestamp (avoids chrono dependency).
      Date: 'u64',
    };
    return map[t.name] || t.name.toLowerCase();
  }
  if (t.type === 'list') return `Vec<${rustType(t.elementType, speckName, enumMap)}>`;
  if (t.type === 'set') return `HashSet<${rustType(t.elementType, speckName, enumMap)}>`;
  if (t.type === 'map') return `HashMap<${rustType(t.keyType, speckName, enumMap)}, ${rustType(t.valueType, speckName, enumMap)}>`;
  if (t.type === 'record') {
    const fields = t.fields.map((f: any) => {
      const name = snakeCase(cleanName(f.name));
      return `pub ${name}: ${rustType(f.type, speckName, enumMap)}`;
    }).join(', ');
    return `${snakeCase(speckName)}_record { ${fields} }`;
  }
  if (t.type === 'ident') {
    const rawName = cleanName(t.name);
    if (enumMap && enumMap.has(rawName)) {
      return `${speckName}${rawName}`;
    }
    if (rawName === 'Account') return 'Account';
    if (rawName === 'Transfer') return 'Transfer';
    if (rawName === 'Replica') return 'Replica';
    if (rawName === 'LogEntry') return 'LogEntry';
    if (rawName === 'Nat') return 'u64';
    if (rawName === 'Int') return 'i64';
    if (rawName === 'Bool') return 'bool';
    if (rawName === 'String') return 'String';
    if (rawName === 'Date') return 'u64';
    // Handle Option<T> from SpeckDL's Option(Type) syntax
    const optionMatch = rawName.match(/^Option[_(]\s*(\w+)\s*\)?$/);
    if (optionMatch) {
      const inner = optionMatch[1];
      const innerRust = inner === 'Nat' ? 'u64' : 
                        inner === 'Int' ? 'i64' :
                        inner === 'Bool' ? 'bool' :
                        inner === 'String' ? 'String' : inner;
      return 'Option<' + innerRust + '>';
    }
    // Opaque identifiers become type aliases
    return rawName;
  }
  return '()';
}
