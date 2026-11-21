import { ActionNode, AuthorNode, DerivesNode, EventNode, ImportNode, InitNode, InterfaceNode, OneofNode, ProvenanceNode, SatisfiesNode, SourceNode, TransitionNode, TypeExpr } from './speck-part0.js';
import { isExpressionComplete, maskCode } from './speck-part1.js';

export function parseInitBlock(inner: string): InitNode {
  const assignments: { name: string; expr: string }[] = [];
  if (!inner.trim()) return { type: 'init', assignments };

  const assignStrs = inner.split(/;|\n/).map(s => s.trim()).filter(Boolean);

  for (let idx = 0; idx < assignStrs.length; idx++) {
    const match = assignStrs[idx].match(/^(\w+)\s*:=\s*(.+)$/);
    if (!match) continue;
    let expr = match[2].trim();
    // Multi-line expressions: record/map literals span several lines in the
    // init block; join until braces/parens/brackets balance.
    while (!isExpressionComplete(expr) && idx + 1 < assignStrs.length) {
      idx++;
      expr += ' ' + assignStrs[idx];
    }
    // A trailing comma is the declaration separator, not part of the value.
    expr = expr.replace(/,\s*$/, '').trim();
    assignments.push({ name: match[1], expr });
  }

  return { type: 'init', assignments };
}

export function parseActionHeader(line: string): ActionNode | null {
  // Greedy param capture: params may contain parenthesized types like
  // List(BuildStep), so `[^)]*` (first-paren truncation) is wrong.
  // Strip a `returns (...)` clause before param parsing, otherwise the
  // greedy paren capture swallows it into the parameter list.
  line = line.replace(/\s+returns\s*\([^)]*\)/g, '');
  // Strip a `: Type` return annotation (`action Foo(x: Nat): Bool {`).
  line = line.replace(/\)\s*:\s*[A-Za-z][\w<>\[\]| ]*\s*\{\s*$/, ') {');
  const match = line.match(/^action\s+(\w+)\s*(?:\((.*)\))?\s*\{/);
  if (!match) return null;

  const name = match[1];
  const paramsStr = match[2] || '';
  const params: { name: string; type: TypeExpr }[] = [];

  if (paramsStr.trim()) {
    const paramPairs = paramsStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of paramPairs) {
      const pMatch = p.match(/^(\w+)\s*:\s*(.+)$/);
      if (pMatch) {
        params.push({ name: pMatch[1], type: parseTypeExpr(pMatch[2].trim()) });
      }
    }
  }

  return { type: 'action', name, params, statements: [] };
}

export function parseImportStatement(line: string): ImportNode {
  const match = line.match(/^import\s+(['"])(.+?)\1(?:\s+as\s+(\w+))?(?:\s+version\s+(['"])(.+?)\4)?(?:\s+hash\s+(['"])(.+?)\6)?/);
  if (!match) {
    throw new Error(`Failed to parse import statement: ${line}`);
  }
  
  const [, , path, , alias, , version, , hash] = match;
  
  return {
    type: 'import',
    path,
    alias,
    version: version || undefined,
    hash: hash || undefined,
  };
}

/**
 * Split a string on commas at bracket depth 0 (respecting <>, {}, () nesting).
 * Used by the interface parser to handle type expressions like Map<String, Nat>
 * whose internal commas should not be split.
 */
export function splitOnTopLevelCommas(s: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  const masked = maskCode(s).text;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '<' || c === '{' || c === '(') depth++;
    else if (c === '>' || c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      tokens.push(s.substring(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(s.substring(start).trim());
  return tokens.filter(Boolean);
}

export function parseTypeExpr(expr: string): TypeExpr {
  expr = expr.trim();

  // Tolerate mismatched generic closers (`List<Foo]`, `Map(K, V]`): specs in
  // the wild occasionally close a `(`/`<` generic with `]`. Repair before
  // dispatching so these parse as the intended generic, not an ident.
  const mismatched = expr.match(/^(List|Map|Set)\s*[(<]([\s\S]*)\]$/);
  if (mismatched) expr = `${mismatched[1]}(${mismatched[2]})`;
  // A stray trailing comma (state-block separator) must not turn a generic
  // into an ident.
  expr = expr.replace(/,\s*$/, '').trim();

  // Primitive types
  const primitives = ['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes'];
  if (primitives.includes(expr)) {
    return { type: 'primitive', name: expr };
  }
  
  // List<T>
  if (expr.startsWith('List<') && expr.endsWith('>')) {
    const inner = expr.substring(5, expr.length - 1).trim();
    return { type: 'list', elementType: parseTypeExpr(inner) };
  }

  // Set<T>
  if (expr.startsWith('Set<') && expr.endsWith('>')) {
    const inner = expr.substring(4, expr.length - 1).trim();
    return { type: 'set', elementType: parseTypeExpr(inner) };
  }

  // Map<K, V>
  if (expr.startsWith('Map<') && expr.endsWith('>')) {
    const inner = expr.substring(4, expr.length - 1);
    // Find the first-level comma (not inside nested generics or record literals)
    let depth = 0;
    let braceDepth = 0;
    let commaIdx = -1;
    const maskedInner = maskCode(inner).text;
    for (let i = 0; i < maskedInner.length; i++) {
      if (maskedInner[i] === '<' || maskedInner[i] === '(') depth++;
      else if (maskedInner[i] === '>' || maskedInner[i] === ')') depth--;
      else if (maskedInner[i] === '{') braceDepth++;
      else if (maskedInner[i] === '}') braceDepth--;
      else if (maskedInner[i] === ',' && depth === 0 && braceDepth === 0) {
        commaIdx = i;
        break;
      }
    }
    if (commaIdx !== -1) {
      const keyStr = inner.substring(0, commaIdx).trim();
      const valStr = inner.substring(commaIdx + 1).trim();
      return { type: 'map', keyType: parseTypeExpr(keyStr), valueType: parseTypeExpr(valStr) };
    }
    // Fallback: treat as ident if malformed
    return { type: 'ident', name: expr };
  }

  // List(T) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('List(') && expr.endsWith(')')) {
    const inner = expr.substring(5, expr.length - 1).trim();
    return { type: 'list', elementType: parseTypeExpr(inner) };
  }

  // Set(T) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('Set(') && expr.endsWith(')')) {
    const inner = expr.substring(4, expr.length - 1).trim();
    return { type: 'set', elementType: parseTypeExpr(inner) };
  }

  // Map(K, V) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('Map(') && expr.endsWith(')')) {
    const inner = expr.substring(4, expr.length - 1);
    let depth = 0;
    let braceDepth = 0;
    let commaIdx = -1;
    const maskedInner = maskCode(inner).text;
    for (let i = 0; i < maskedInner.length; i++) {
      if (maskedInner[i] === '(' || maskedInner[i] === '<') depth++;
      else if (maskedInner[i] === ')' || maskedInner[i] === '>') depth--;
      else if (maskedInner[i] === '{') braceDepth++;
      else if (maskedInner[i] === '}') braceDepth--;
      else if (maskedInner[i] === ',' && depth === 0 && braceDepth === 0) {
        commaIdx = i;
        break;
      }
    }
    if (commaIdx !== -1) {
      const keyStr = inner.substring(0, commaIdx).trim();
      const valStr = inner.substring(commaIdx + 1).trim();
      return { type: 'map', keyType: parseTypeExpr(keyStr), valueType: parseTypeExpr(valStr) };
    }
    // Fallback: treat as ident if malformed
    return { type: 'ident', name: expr };
  }
  
  // List type: [T]
  if (expr.startsWith('[') && expr.endsWith(']')) {
    const elementType = parseTypeExpr(expr.substring(1, expr.length - 1));
    return { type: 'list', elementType };
  }
  
  // Record type: { ... }
  if (expr.startsWith('{') && expr.endsWith('}')) {
    const content = expr.substring(1, expr.length - 1).trim();
    const fields: { name: string; type: TypeExpr }[] = [];
    
    if (content) {
      // Split by comma and parse each field
      const fieldStrs = content.split(',').map(s => s.trim());
      for (const fieldStr of fieldStrs) {
        const fieldMatch = fieldStr.match(/^(\w+)\s*:\s*(.+)$/);
        if (fieldMatch) {
          const [, name, typeStr] = fieldMatch;
          fields.push({ name, type: parseTypeExpr(typeStr.trim()) });
        }
      }
    }
    
    return { type: 'record', fields };
  }
  
  // Nullable type: T | null — must be checked before the ident fallback.
  // Detects a top-level `| null` (with optional surrounding whitespace)
  // and recurses on the left side. Sets the `nullable` flag on the result.
  //   "String | null"          → { type: 'primitive', name: 'String', nullable: true }
  //   "List<String> | null"    → { type: 'list', elementType: {...}, nullable: true }
  //   "CustomerStatus | null"  → { type: 'ident', name: 'CustomerStatus', nullable: true }
  if (expr.includes('|')) {
    // Find the first top-level `|`. Don't split inside `<...>`, `(...)`,
    // `{...}` since those may be generic/record/parenthetical forms.
    let depth = 0;
    let braceDepth = 0;
    let pipeIdx = -1;
    const maskedExpr = maskCode(expr).text;
    for (let i = 0; i < maskedExpr.length; i++) {
      const c = maskedExpr[i];
      if (c === '<' || c === '(') depth++;
      else if (c === '>' || c === ')') depth--;
      else if (c === '{') braceDepth++;
      else if (c === '}') braceDepth--;
      else if (c === '|' && depth === 0 && braceDepth === 0) {
        pipeIdx = i;
        break;
      }
    }
    if (pipeIdx !== -1) {
      const left = expr.substring(0, pipeIdx).trim();
      const right = expr.substring(pipeIdx + 1).trim();
      if (right === 'null') {
        const inner = parseTypeExpr(left);
        inner.nullable = true;
        return inner;
      }
    }
  }

  // Identifier (for interface references, etc.)
  return { type: 'ident', name: expr };
}

export function parseInterface(line: string): InterfaceNode {
  // interface Name {
  const match = line.match(/^interface\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse interface: ${line}`);
  }

  const name = match[1];

  // Header-only; parseInterfaceBlockMultiline fills in methods/fields/kind
  // by scanning the lines inside the { ... } block.
  return {
    type: 'interface',
    name,
    kind: 'mixed',
    methods: [],
    fields: [],
  };
}

export function parseEvent(line: string): EventNode {
  // event Name {   or   event Name external {
  const match = line.match(/^event\s+(\w+)(?:\s+external)?\s*\{/);
  if (!match) {
    throw new Error(`Failed to parse event: ${line}`);
  }

  const name = match[1];
  const external = /^event\s+\w+\s+external\b/.test(line.trim());

  return {
    type: 'event',
    name,
    fields: [],
    ...(external ? { external: true } : {}),
  };
}

// Cycle 57: parse `oneof Name {` (header only; parseOneofBlockMultiline fills variants).
export function parseOneof(line: string): OneofNode {
  // oneof Name {
  const match = line.match(/^oneof\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse oneof: ${line}`);
  }
  return {
    type: 'oneof',
    name: match[1],
    variants: [],
  };
}

// Cycle 58: parse `transition Name {` (header only; parseTransitionBlockMultiline fills fields + payload-oneof).
export function parseTransition(line: string): TransitionNode {
  // transition Name {
  const match = line.match(/^transition\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse transition: ${line}`);
  }
  return {
    type: 'transition',
    name: match[1],
    fields: [],
  };
}

export function parseProvenanceBlock(lines: string[], line: string): ProvenanceNode {
  // This is a simplified parser - in a real implementation, we'd parse the full block
  return {
    type: 'provenance',
    clauses: [],
  };
}

export function parseDerives(line: string): DerivesNode {
  // derives from Name via "rationale"
  const match = line.match(/^derives\s+from\s+(\w+(?:-\w+)*)(?:\s+via\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse derives statement: ${line}`);
    return { type: 'derives', from: 'unknown' };
  }
  
  const [, from, , via] = match;
  
  return {
    type: 'derives',
    from,
    via: via || undefined,
  };
}

export function parseSatisfies(line: string): SatisfiesNode {
  // satisfies Name [clause "X.Y.Z"]
  // e.g., satisfies RESILIENCE-REQ-01 clause "3.1.2"
  // e.g., satisfies RESILIENCE-REQ-02
  const match = line.match(/^satisfies\s+([\w-]+(?:-[\w]+)*)(?:\s+clause\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse satisfies statement: ${line}`);
    return { type: 'satisfies', requirement: 'unknown' };
  }
  
  const [, requirement, , clause] = match;
  
  return {
    type: 'satisfies',
    requirement,
    clause: clause || undefined,
  };
}

export function parseAuthor(line: string): AuthorNode {
  // author: "Name" <"email">
  // e.g., author: "Scott Scoble" <"scott@scoble.me">
  const match = line.match(/^author:\s+(['"])(.+?)\1(?:\s+<(['"])(.+?)\3>)?/);
  if (!match) {
    // Try without angle brackets or with different format
    console.warn(`Failed to parse author statement: ${line}`);
    return { type: 'author', name: 'unknown' };
  }
  
  const [, , name, , email] = match;
  
  return {
    type: 'author',
    name,
    email: email || undefined,
  };
}

export function parseSource(line: string): SourceNode {
  // source: kind ref "identifier"
  // e.g., source: architecture_review ref "AR-2024-0215"
  const match = line.match(/^source:\s+(\w+)(?:\s+ref\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse source statement: ${line}`);
    return { type: 'source', kind: 'document' };
  }
  
  const [, kind, , ref] = match;
  const validKinds = [
    'conversation', 'meeting', 'document', 'regulation',
    'architecture_review', 'threat_model', 'compliance_audit'
  ];
  
  if (!validKinds.includes(kind)) {
    console.warn(`Invalid source kind: ${kind}, defaulting to document`);
    return { type: 'source', kind: 'document', ref: ref || undefined };
  }
  
  return {
    type: 'source',
    kind: kind as any,
    ref: ref || undefined,
  };
}

