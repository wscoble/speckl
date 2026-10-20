// src/printer.ts
//
// Renders a parsed SpeckDL AST back to SpeckDL source text.
//
// Used by the round-trip property test: parse → print → parse must yield a
// structurally identical AST. The printer is faithful to what the parser
// captures — comments and original formatting are not preserved (the AST
// does not contain them), as are `next:` relations (parsed separately from
// raw source) and `type` aliases (not captured as members).

import { AST, SpeckNode, MemberNode, TypeExpr } from './parser.js';

/** Render a parsed AST back to SpeckDL source. */
export function printAST(ast: AST): string {
  return ast.specks.map(printSpeck).join('\n') + '\n';
}

function printSpeck(speck: SpeckNode): string {
  const lines: string[] = [`speck ${speck.name} {`];
  // Top-of-file directives captured as speck metadata — print them inside the
  // speck so the parser recaptures them.
  if (speck.author) lines.push(`    author: "${speck.author}"`);
  if (speck.version) lines.push(`    version: "${speck.version}"`);
  if (speck.license) lines.push(`    license: "${speck.license}"`);
  if (speck.protoPackage) lines.push(`    proto_package: "${speck.protoPackage}"`);
  if (speck.goPackage) lines.push(`    go_package: "${speck.goPackage}"`);
  if (speck.eventSuffix) lines.push(`    event_suffix: "${speck.eventSuffix}"`);
  if (speck.k8sGroup) lines.push(`    k8s_group: "${speck.k8sGroup}"`);
  if (speck.k8sVersion) lines.push(`    k8s_version: "${speck.k8sVersion}"`);
  for (const member of speck.members) {
    for (const line of printMember(member)) {
      lines.push(`    ${line}`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

function printMember(member: MemberNode): string[] {
  switch (member.type) {
    case 'import': {
      let s = `import "${member.path}"`;
      if (member.alias) s += ` as ${member.alias}`;
      if (member.version) s += ` version "${member.version}"`;
      if (member.hash) s += ` hash "${member.hash}"`;
      return [s];
    }
    case 'input':
      return printIO('input', member.typeExpr);
    case 'output':
      return printIO('output', member.typeExpr);
    case 'constraint': {
      // Bare-word names use the colon form; names with spaces use the quoted
      // form the parser supports.
      if (member.name && /^\w+$/.test(member.name)) {
        return [`constraint ${member.name}: ${member.expr}`];
      }
      if (member.name) {
        return [`constraint "${member.name}" : ${member.expr}`];
      }
      return [`constraint: ${member.expr}`];
    }
    case 'invariant':
      return [`invariant ${member.name} {`, `    ${member.expr}`, `}`];
    case 'verify':
      return [printVerify(member)];
    case 'state':
      return printState(member);
    case 'init':
      return printInit(member);
    case 'action':
      return printAction(member);
    case 'next':
      return [member.anyAction ? 'next: { }' : `next: ${member.actions.join(' | ')}`];
    case 'agent':
      return printAgent(member);
    case 'event': {
      const lines = [`event ${member.name} {`];
      for (const f of member.fields) lines.push(`    ${f.name}: ${printType(f.type)}`);
      lines.push('}');
      return lines;
    }
    case 'interface':
      return printInterface(member);
    case 'service': {
      const lines = [`service ${member.name} {`];
      for (const rpc of member.rpcs) {
        lines.push(`    rpc ${rpc.name}(${rpc.requestType}) returns (${rpc.responseType});`);
      }
      lines.push('}');
      return lines;
    }
    case 'oneof': {
      const lines = [`oneof ${member.name} {`];
      for (const v of member.variants) lines.push(`    ${v.typeName} ${v.fieldName}`);
      lines.push('}');
      return lines;
    }
    case 'transition': {
      const lines = [`transition ${member.name} {`];
      for (const f of member.fields) lines.push(`    ${f.name}: ${printType(f.type)}`);
      lines.push('}');
      return lines;
    }
    case 'provenance': {
      // Clause format the parser understands: `<type> "<value>" :: "<location>"`.
      const lines = ['provenance {'];
      for (const c of member.clauses) {
        lines.push(`    ${c.type} "${c.value}"${c.location ? ` :: "${c.location}"` : ''}`);
      }
      lines.push('}');
      return lines;
    }
    case 'review':
      return [`review: ${member.kind}`];
    case 'derives':
      return [member.via
        ? `derives from ${member.from} via "${member.via}"`
        : `derives from ${member.from}`];
    case 'satisfies':
      return [member.clause
        ? `satisfies ${member.requirement} clause "${member.clause}"`
        : `satisfies ${member.requirement}`];
    case 'author':
      return [member.email
        ? `author: "${member.name}" <"${member.email}">`
        : `author: "${member.name}"`];
    case 'source':
      return [member.ref
        ? `source: ${member.kind} ref "${member.ref}"`
        : `source: ${member.kind}`];
    case 'bom': {
      const lines = ['bom {'];
      if (member.compiler) lines.push(`    compiler: "${member.compiler.name}"${member.compiler.version ? ` version "${member.compiler.version}"` : ''}`);
      if (member.solver) lines.push(`    solver: "${member.solver.name}"${member.solver.version ? ` version "${member.solver.version}"` : ''}`);
      if (member.runtime) lines.push(`    runtime: "${member.runtime.name}"${member.runtime.version ? ` version "${member.runtime.version}"` : ''}`);
      if (member.license) lines.push(`    license: "${member.license}"`);
      if (member.hash) lines.push(`    hash: "${member.hash}"`);
      lines.push('}');
      return lines;
    }
    default: {
      // lifecycle_metadata (top-of-speck `key: value` directives) and any
      // future member kinds print so the parser recaptures them; otherwise a
      // comment surfaces the gap to round-trip tests.
      const lm = member as unknown as { type: string; key?: string; value?: unknown };
      if (lm.type === 'lifecycle_metadata') {
        // The parser captures the raw text after `key:` — print strings as-is
        // (re-quoted only for arrays/objects via JSON), everything else raw.
        const v = lm.value;
        const text = Array.isArray(v) ? JSON.stringify(v) : String(v);
        return [`${lm.key}: ${text}`];
      }
      return [`// unprinted member: ${lm.type}`];
    }
  }
}

function printVerify(v: { name: string; temporalExpr: string; depth?: number }): string {
  // Space form (with optional depth) for invariant references — the form the
  // original specs use; colon form for arbitrary expressions, which only the
  // colon parser handles.
  if (v.depth) return `verify ${v.temporalExpr} { depth ${v.depth} }`;
  if (/^(?:always|Always|eventually|Eventually)\(\w+\)$/.test(v.temporalExpr)) {
    return `verify ${v.temporalExpr}`;
  }
  return `verify: ${v.temporalExpr}`;
}

/**
 * input/output declarations. Record types print multi-line — the line-
 * oriented parser captures multi-field records that way.
 */
function printIO(kind: 'input' | 'output', t: TypeExpr): string[] {
  if (t.type === 'record' && (t.fields?.length ?? 0) > 0) {
    const lines = [`${kind}: {`];
    for (const f of t.fields!) {
      const comma = f === t.fields![t.fields!.length - 1] ? '' : ',';
      lines.push(`    ${f.name}: ${printType(f.type)}${comma}`);
    }
    lines.push('}');
    return lines;
  }
  return [`${kind}: ${printType(t)}`];
}

function printState(node: { variables: { name: string; typeExpr: TypeExpr; defaultInit?: string }[] }): string[] {
  const lines = ['state {'];
  for (const v of node.variables) {
    lines.push(`    ${v.name}: ${printType(v.typeExpr)}`);
  }
  lines.push('}');
  return lines;
}

function printInit(node: { assignments: { name: string; expr: string }[] }): string[] {
  const lines = ['init {'];
  for (const a of node.assignments) {
    // `:=` is the assignment form parseInitBlock understands; the `==` source
    // form is not captured as assignments by the parser (see parseInitBlock).
    lines.push(`    ${a.name} := ${a.expr}`);
  }
  lines.push('}');
  return lines;
}

type PrintableStatement = { type: string; [k: string]: unknown };

function printAction(action: { name: string; params: { name: string; type: TypeExpr }[]; statements: PrintableStatement[] }): string[] {
  const params = action.params.map(p => `${p.name}: ${printType(p.type)}`).join(', ');
  return [`action ${action.name}(${params}) {`, ...printStatements(action.statements, '    '), '}'];
}

/** Action statements; structured if/for blocks are printed nested, one keyword per line. */
function printStatements(statements: PrintableStatement[], indent: string): string[] {
  const lines: string[] = [];
  for (const stmt of statements) {
    switch (stmt.type) {
      case 'assign':
        lines.push(`${indent}${stmt.target} := ${stmt.expr}`);
        break;
      case 'let':
        lines.push(`${indent}let ${stmt.name} := ${stmt.expr}`);
        break;
      case 'require':
        lines.push(`${indent}require ${stmt.expr}`);
        break;
      case 'precondition':
        lines.push(`${indent}precondition: ${stmt.expr}`);
        break;
      case 'postcondition':
        lines.push(`${indent}postcondition: ${stmt.expr}`);
        break;
      case 'emit': {
        const fields = (stmt.fields as { name: string; value: string }[] | undefined) ?? [];
        const fieldText = fields.map(f => `${f.name}: ${f.value}`).join(', ');
        lines.push(`${indent}emit ${stmt.event} { ${fieldText} }`);
        break;
      }
      case 'return':
        lines.push(stmt.expr ? `${indent}return ${stmt.expr}` : `${indent}return`);
        break;
      case 'ifblock': {
        const branches = stmt.branches as { cond: string | null; body: PrintableStatement[] }[] | undefined;
        if (!branches) { lines.push(`${indent}${stmt.raw}`); break; }
        branches.forEach((b, k) => {
          const head = b.cond === null ? 'else' : `if ${b.cond}`;
          lines.push(k === 0 ? `${indent}${head} {` : `${indent}} ${b.cond === null ? 'else' : `else if ${b.cond}`} {`);
          lines.push(...printStatements(b.body, indent + '    '));
        });
        lines.push(`${indent}}`);
        break;
      }
      case 'forblock': {
        const loop = stmt.loop as { variable: string; from?: string; to?: string; collection?: string; body: PrintableStatement[] } | undefined;
        if (!loop) { lines.push(`${indent}${stmt.raw}`); break; }
        const range = loop.collection !== undefined ? `in ${loop.collection}` : `from ${loop.from} to ${loop.to}`;
        lines.push(`${indent}for ${loop.variable} ${range} {`, ...printStatements(loop.body, indent + '    '), `${indent}}`);
        break;
      }
      case 'unparsed':
        lines.push(`${indent}${stmt.raw}`);
        break;
      default:
        lines.push(`${indent}// unprinted statement: ${stmt.type}`);
    }
  }
  return lines;
}

function printInterface(node: { name: string; kind: string; methods: { name: string; params: { name: string; type: TypeExpr }[]; returnType: TypeExpr }[]; fields: { name: string; type: TypeExpr }[] }): string[] {
  const lines = [`interface ${node.name} {`];
  if (node.kind === 'enum') {
    for (const m of node.methods) lines.push(`    ${m.name}`);
  } else if (node.kind === 'record') {
    for (const f of node.fields) lines.push(`    ${f.name}: ${printType(f.type)}`);
  } else if (node.kind === 'service') {
    for (const m of node.methods) {
      const params = m.params.map(p => `${p.name}: ${printType(p.type)}`).join(', ');
      lines.push(`    ${m.name}(${params}): ${printType(m.returnType)}`);
    }
  } else {
    // mixed: emit both forms the AST captured
    for (const m of node.methods) lines.push(`    ${m.name}`);
    for (const f of node.fields) lines.push(`    ${f.name}: ${printType(f.type)}`);
  }
  lines.push('}');
  return lines;
}

function printType(t: TypeExpr | undefined): string {
  if (!t) return 'Unknown';
  switch (t.type) {
    case 'primitive':
      return (t.name ?? 'Unknown') + (t.nullable ? ' | null' : '');
    case 'ident':
      return (t.name ?? 'Unknown') + (t.nullable ? ' | null' : '');
    case 'record':
      return '{ '
        + (t.fields ?? []).map(f => `${f.name}: ${printType(f.type)}`).join(', ')
        + ' }';
    case 'list':
      return `List(${printType(t.elementType)})` + (t.nullable ? ' | null' : '');
    case 'set':
      return `Set(${printType(t.elementType)})` + (t.nullable ? ' | null' : '');
    case 'map':
      return `Map(${printType(t.keyType)}, ${printType(t.valueType)})` + (t.nullable ? ' | null' : '');
    case 'record':
      return printType({ ...t, nullable: t.nullable });
    default:
      return 'Unknown';
  }
}
function printAgent(member: Extract<MemberNode, { type: 'agent' }>): string[] {
  const lines: string[] = ['agent {'];
  if (member.stages) {
    lines.push(`    stages ${member.stages.variable} {`);
    for (const l of member.stages.labels) {
      lines.push(`        ${l.name} = ${l.value}`);
    }
    lines.push('    }');
  }
  for (const t of member.tools) {
    lines.push(`    tool ${t.name} -> ${t.action} effect ${t.effect}`);
  }
  if (member.pendingTimeout) {
    lines.push(`    pending timeout ${member.pendingTimeout.durationText}`);
  }
  for (const a of member.awaits) {
    lines.push(`    await ${a.state} {`);
    lines.push(`        signal ${a.signal}`);
    lines.push(`        mode ${a.mode}`);
    lines.push(`        require outcome in { ${a.outcomes.map(o => (a.rejects ?? []).includes(o) ? `${o}!` : o).join(', ')} }`);
    if (a.claims.length > 0) {
      const body = a.claims.map(c => `${c.name}: ${c.typeName}`).join(', ');
      lines.push(`        require claims { ${body} }`);
    }
    for (const o of a.on) {
      lines.push(`        on ${o.outcome} -> ${o.target}`);
    }
    if (a.timeout) {
      lines.push(`        timeout ${a.timeout.durationText} -> ${a.timeout.outcome}`);
    }
    lines.push('    }');
  }
  for (const h of member.harnesses ?? []) {
    lines.push(`    harness ${h.name} {`);
    for (const r of h.rules) {
      let l = `        map ${r.tools.join('|')}`;
      if (r.field !== undefined) l += ` ${r.field} ~ "${(r.pattern ?? '').replace(/"/g, '\\"')}"`;
      l += ` -> ${r.target}`;
      if (r.params.length > 0) l += ` { ${r.params.map(p => `${p.param} = ${p.field}`).join(', ')} }`;
      lines.push(l);
    }
    lines.push('    }');
  }
  lines.push('}');
  return lines;
}
