// src/ir/lower.ts
//
// AST → IR. The lower pass transforms the parser's AST into the IR
// (defined in src/ir/types.ts). The IR is the named union of facets,
// with lossless expression trees (no more Z3 raw-source re-parse).
//
// The lower pass:
//   1. Re-parses action bodies via parseActionStatements to get typed
//      expression trees (the main AST has string expressions).
//   2. Re-parses constraint/verify expressions via parseExpression.
//   3. Synthesizes a ProvenanceFacet from file metadata if the source
//      didn't declare one (provenance is non-optional in the IR).
//   4. Returns a fully-resolved IR ready for generator consumption.
//
// Generators should consume the IR, not the AST. The IR's contract:
//   - Every fact in the source is in the IR.
//   - Cross-spec references are resolved.
//   - Expressions are typed trees, not strings.
//   - Provenance is always populated.

import { exprToSource } from '../expr/print.js';
import { readFileSync } from 'fs';
import {
  AST, SpeckNode, MemberNode, StateNode, InitNode, ActionNode,
  EventNode, ConstraintNode, VerifyNode, InterfaceNode, ServiceNode,
  ProvenanceNode, ReviewNode, AuthorNode, SourceNode, DerivesNode,
  SatisfiesNode, BOMNode, TypeExpr, OneofNode, TransitionNode,
  InputNode, OutputNode, AgentMemberNode,
} from '../parser.js';
import {
  IR, IRSpeck, IRFacets, IRImport,
  TypedSchemaFacet, IRType, IRRecordType, IREnumType, IRAliasType,
  IRFieldDef, IRTypeRef, IRService, IRServiceMethod,
  BehaviorFacet, IRStateVar, IRAssign, IRAction, IRParam, IRStmt, IREvent,
  IRAgentConfig, IRAgentAwait,
  FormalSpecFacet, IRConstraint, IRVerify,
  IRExpr, IRBoolLit, IRIntLit, IRFloatLit, IRStringLit, IRIdent, IRBinOp, IRUnOp, IRCall, IRFieldAccess, IRIndexExpr,
  WireFormatFacet,
  ValidationFacet, ValidationRule,
  ResourceLifecycleFacet,
  ProvenanceFacet, ProvenanceClause, Author, Source, SourceKind, BOMMetadata,
  MetadataFacet,
  FileMetadata, IRDiagnostic,
} from './types.js';
import { Expr, ActionStatement } from '../expr/index.js';
import { parseActionStatements, parseExpression, parseExpressionComplete } from '../expr/index.js';

// ─────────────────────────────────────────────────────────────────────
// Lower: AST → IR
// ─────────────────────────────────────────────────────────────────────

export interface LowerOptions {
  /** Path to the source file. Used for file-level metadata. */
  filePath: string;
  /** If true, the lower pass will resolve imports by reading other files. */
  resolveImports: boolean;
  /** Root directory for resolving relative import paths. */
  rootDir?: string;
}

export function lower(ast: AST, options: LowerOptions): IR {
  const fileMetadata = extractFileMetadata(ast, options);
  const diagnostics: IRDiagnostic[] = [];

  const specks: IRSpeck[] = ast.specks.map((speck) =>
    lowerSpeck(speck, ast, options, diagnostics)
  );

  return {
    specks,
    fileMetadata,
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-speck lower
// ─────────────────────────────────────────────────────────────────────

function lowerSpeck(
  speck: SpeckNode,
  ast: AST,
  options: LowerOptions,
  diagnostics: IRDiagnostic[],
): IRSpeck {
  // Read the raw source for expression re-parsing.
  // The main AST has string expressions; the IR needs typed trees.
  const rawSource = readFileSync(options.filePath, 'utf-8');
  const rawStatementsByAction = extractActionStatements(rawSource, speck);

  // Resolve imports. (For now: no-op if resolveImports is false. Future:
  // a real resolver that reads the imported file, lowers it, and merges.)
  const imports: IRImport[] = [];
  if (options.resolveImports) {
    for (const m of speck.members) {
      if (m.type === 'import') {
        diagnostics.push({
          level: 'warning',
          message: 'import resolution not yet implemented in lower pass',
          speck: speck.name,
        });
      }
    }
  }

  // Build the eight facets.
  const typed_schema = lowerTypedSchema(speck, ast, diagnostics);
  const behavior = lowerBehavior(speck, rawStatementsByAction, diagnostics);
  const formal_spec = lowerFormalSpec(speck, ast, diagnostics);
  const wire_format = lowerWireFormat(speck);
  const validation: ValidationFacet = { rules: new Map() };
  const resource_lifecycle = lowerResourceLifecycle(speck);
  const provenance = lowerProvenance(speck, options.filePath, diagnostics);
  const metadata = lowerMetadata(speck);

  return {
    name: speck.name,
    sourcePath: options.filePath,
    imports,
    facets: {
      typed_schema,
      behavior,
      formal_spec,
      wire_format,
      validation,
      resource_lifecycle,
      provenance,
      metadata,
    },
    // Speck-level metadata propagated to targets that need it
    protoPackage: (speck as any).protoPackage,
    goPackage: (speck as any).goPackage,
    eventSuffix: (speck as any).eventSuffix,
    k8sGroup: (speck as any).k8sGroup,
    k8sVersion: (speck as any).k8sVersion,
    metadataVersion: (speck as any).version,
    metadataAuthor: (speck as any).author,
    metadataLicense: (speck as any).license,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Action body extraction (raw-source re-parse for typed statements)
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract each action's body lines from the raw source, parse them into
 * typed ActionStatement[]. Returns a map from action name to statements.
 *
 * The main AST stores action statements as `{ type: 'assign'; target: string; expr: string }`
 * etc. — strings for expressions. The IR needs typed Expr trees. So we
 * re-parse the action body from the raw source using parseActionStatements.
 *
 * Future: when the main parser is updated to call parseActionStatements
 * directly, this function becomes a no-op.
 */
function extractActionStatements(
  rawSource: string,
  speck: SpeckNode,
): Map<string, ActionStatement[]> {
  const lines = rawSource.split('\n');
  const out = new Map<string, ActionStatement[]>();

  // Find each `action Name(...) { ... }` block.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(/^action\s+(\w+)\s*\(/);
    if (m) {
      const name = m[1];
      // Find the opening brace.
      let j = i;
      while (j < lines.length && !lines[j].includes('{')) j++;
      if (j >= lines.length) { i++; continue; }
      // Collect lines until the matching closing brace.
      const bodyLines: string[] = [];
      j++;
      let depth = 1;
      while (j < lines.length && depth > 0) {
        const l = lines[j];
        if (l.includes('{')) depth++;
        if (l.includes('}')) {
          depth--;
          if (depth === 0) break;
        }
        bodyLines.push(l);
        j++;
      }
      // Parse the body.
      const stmts = parseActionStatements(bodyLines);
      out.set(name, stmts);
      i = j + 1;
    } else {
      i++;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Facet lowers
// ─────────────────────────────────────────────────────────────────────

function lowerTypedSchema(
  speck: SpeckNode,
  ast: AST,
  diagnostics: IRDiagnostic[],
): TypedSchemaFacet {
  const types = new Map<string, IRType>();
  const services: IRService[] = [];

  for (const m of speck.members) {
    switch (m.type) {
      case 'interface': {
        const iface = m as InterfaceNode;
        if (iface.kind === 'record' || (iface.fields && iface.fields.length > 0 && (!iface.methods || iface.methods.length === 0))) {
          // Record type.
          types.set(iface.name, {
            kind: 'record',
            name: iface.name,
            fields: iface.fields.map(f => ({
              name: f.name,
              type: lowerTypeExpr(f.type),
              optional: false,
            })),
          });
        } else if (iface.kind === 'enum' || (iface.methods && iface.methods.length > 0)) {
          // Enum type (methods become variants).
          types.set(iface.name, {
            kind: 'enum',
            name: iface.name,
            variants: iface.methods.map(v => v.name),
          });
        } else {
          diagnostics.push({
            level: 'warning',
            message: `interface ${iface.name} has unrecognized kind: ${iface.kind}`,
            speck: speck.name,
          });
        }
        break;
      }
      case 'event': {
        const ev = m as EventNode;
        types.set(ev.name, {
          kind: 'record',
          name: ev.name,
          fields: ev.fields.map(f => ({
            name: f.name,
            type: lowerTypeExpr(f.type),
            optional: false,
          })),
        });
        break;
      }
      case 'service': {
        const svc = m as ServiceNode;
        services.push({
          name: svc.name,
          methods: svc.rpcs.map(r => ({
            name: r.name,
            requestType: r.requestType,
            responseType: r.responseType,
            clientStreaming: r.clientStreaming || false,
            serverStreaming: r.serverStreaming || false,
          })),
        });
        break;
      }
      // 'oneof', 'transition' are wire-format concepts; handled in lowerWireFormat.
    }
  }

  return { types, services };
}

function lowerBehavior(
  speck: SpeckNode,
  rawStatementsByAction: Map<string, ActionStatement[]>,
  diagnostics: IRDiagnostic[],
): BehaviorFacet {
  const stateVars: IRStateVar[] = [];
  let init: IRAssign[] = [];
  const actions: IRAction[] = [];
  const events: IREvent[] = [];

  for (const m of speck.members) {
    if (m.type === 'state') {
      const s = m as StateNode;
      for (const v of s.variables) {
        stateVars.push({
          name: v.name,
          type: lowerTypeExpr(v.typeExpr),
          defaultInit: v.defaultInit ? parseExprSafe(v.defaultInit, diagnostics, speck.name) : undefined,
        });
      }
    } else if (m.type === 'init') {
      const i = m as InitNode;
      init = i.assignments.map(a => ({
        target: a.name,
        expr: parseExprSafe(a.expr, diagnostics, speck.name),
      }));
    } else if (m.type === 'action') {
      const a = m as ActionNode;
      const rawStmts = rawStatementsByAction.get(a.name) || [];
      let stmts: IRStmt[];
      if (rawStmts.length === 0 && a.name.startsWith('__signal_')) {
        // Synthetic __signal_* actions (injected AST) carry parser-shaped
        // statements with string expressions. Real actions keep the
        // raw-statement path so existing backend output is unchanged.
        stmts = a.statements.map(s => lowerParserActionStatement(s, diagnostics, speck.name));
      } else {
        stmts = rawStmts.map(s => lowerStatement(s, diagnostics, speck.name));
      }
      actions.push({
        name: a.name,
        params: a.params.map(p => ({ name: p.name, type: lowerTypeExpr(p.type) })),
        statements: stmts,
      });
    } else if (m.type === 'event') {
      const e = m as EventNode;
      events.push({
        name: e.name,
        fields: e.fields.map(f => ({
          name: f.name,
          type: lowerTypeExpr(f.type),
          optional: false,
        })),
      });
    }
  }

  const behavior: BehaviorFacet = { stateVars, init, actions, events };
  const nextMember = speck.members.find(m => m.type === 'next');
  if (nextMember && nextMember.type === 'next') {
    const known = new Set(actions.map(a => a.name));
    const names = nextMember.anyAction ? actions.map(a => a.name) : nextMember.actions;
    for (const name of names) {
      if (!known.has(name)) {
        diagnostics.push({
          level: 'error',
          message: `next: references unknown action "${name}"`,
          line: nextMember.startLine,
          speck: speck.name,
        });
      }
    }
    behavior.next = [...names];
  }

  const agentMember = speck.members.find((m): m is AgentMemberNode & { startLine?: number } => m.type === 'agent');
  if (agentMember) {
    behavior.agent = lowerAgent(agentMember, behavior, speck.name, diagnostics);
  }
  return behavior;
}

/**
 * Validate and lower an `agent { }` block. Injects synthetic `__signal_*`
 * actions into behavior.actions / behavior.next so Z3 BMC covers the
 * human-response edges; those actions are never exposed as tools.
 */
function lowerAgent(
  agent: AgentMemberNode & { startLine?: number },
  behavior: BehaviorFacet,
  speckName: string,
  diagnostics: IRDiagnostic[],
): IRAgentConfig {
  const actionNames = new Set(behavior.actions.map(a => a.name));
  const stateVarNames = new Set(behavior.stateVars.map(v => v.name));
  const labelToValue = new Map<string, number>();
  let stageVar = 'stage';

  if (agent.stages) {
    stageVar = agent.stages.variable;
    if (!stateVarNames.has(stageVar)) {
      diagnostics.push({
        level: 'error',
        message: `agent stages: unknown state variable "${stageVar}"`,
        line: agent.startLine,
        speck: speckName,
      });
    }
    for (const l of agent.stages.labels) {
      if (labelToValue.has(l.name)) {
        diagnostics.push({
          level: 'error',
          message: `agent stages: duplicate label "${l.name}"`,
          line: agent.startLine,
          speck: speckName,
        });
      }
      labelToValue.set(l.name, l.value);
    }
  }

  const tools = [];
  const seenToolNames = new Set<string>();
  for (const t of agent.tools) {
    if (seenToolNames.has(t.name)) {
      diagnostics.push({ level: 'error', message: `agent: duplicate tool "${t.name}"`, line: agent.startLine, speck: speckName });
    }
    seenToolNames.add(t.name);
    if (!actionNames.has(t.action)) {
      diagnostics.push({
        level: 'error',
        message: `agent tool ${t.name}: unknown action "${t.action}"`,
        line: agent.startLine,
        speck: speckName,
      });
    }
    if (t.effect !== 'act' && t.effect !== 'observe') {
      diagnostics.push({ level: 'error', message: `agent tool ${t.name}: effect must be act or observe`, line: agent.startLine, speck: speckName });
    }
    tools.push({ name: t.name, action: t.action, effect: t.effect });
  }

  validateHarnesses(agent, behavior, speckName, diagnostics);

  const awaits: IRAgentAwait[] = [];
  const syntheticNames: string[] = [];

  if (agent.pendingTimeout && agent.pendingTimeout.durationMs <= 0) {
    diagnostics.push({
      level: 'error',
      message: `agent: pending timeout must be greater than zero (got ${agent.pendingTimeout.durationText})`,
      line: agent.startLine,
      speck: speckName,
    });
  }

  for (const a of agent.awaits) {
    if (!labelToValue.has(a.state)) {
      diagnostics.push({
        level: 'error',
        message: `agent await ${a.state}: unknown stage label (declare it in stages)`,
        line: agent.startLine,
        speck: speckName,
      });
      continue;
    }
    const awaitValue = labelToValue.get(a.state)!;
    const rejectOutcomes = new Set(a.rejects ?? []);
    for (const o of a.outcomes) {
      if (/reject|deny|denied|decline/i.test(o) && !rejectOutcomes.has(o)) {
        diagnostics.push({
          level: 'warning',
          message: `agent await ${a.state}: outcome "${o}" looks like a rejection but is not marked; write "${o}!" in require outcome in {...} to make it a reject outcome`,
          line: agent.startLine,
          speck: speckName,
        });
      }
    }
    if (a.timeout) {
      if (!a.outcomes.includes(a.timeout.outcome)) {
        diagnostics.push({
          level: 'error',
          message: `agent await ${a.state}: timeout outcome "${a.timeout.outcome}" not in require outcome in {...}`,
          line: agent.startLine,
          speck: speckName,
        });
      } else if (!rejectOutcomes.has(a.timeout.outcome)) {
        // A timeout may only resolve to an outcome explicitly marked reject.
        diagnostics.push({
          level: 'error',
          message: `agent await ${a.state}: timeout may only resolve to a reject outcome marked with ! (got "${a.timeout.outcome}"; write "${a.timeout.outcome}!" in require outcome in {...} if it really rejects)`,
          line: agent.startLine,
          speck: speckName,
        });
      }
    }
    // A reject outcome must not lead where an accepting outcome leads, or a
    // timeout (or any reject) could approve by another name.
    for (const r of rejectOutcomes) {
      const rTarget = a.on.find(o => o.outcome === r)?.target;
      const accepting = a.on.filter(o => !rejectOutcomes.has(o.outcome)).map(o => o.target);
      if (rTarget !== undefined && accepting.includes(rTarget)) {
        diagnostics.push({
          level: 'error',
          message: `agent await ${a.state}: reject outcome "${r}" leads to ${rTarget}, which a non-reject outcome also reaches`,
          line: agent.startLine,
          speck: speckName,
        });
      }
    }
    if (rejectOutcomes.size === a.outcomes.length && a.outcomes.length > 0) {
      diagnostics.push({
        level: 'warning',
        message: `agent await ${a.state}: every outcome is marked reject; nothing can approve`,
        line: agent.startLine,
        speck: speckName,
      });
    }

    const syntheticActions: IRAgentAwait['syntheticActions'] = [];
    for (const o of a.on) {
      if (!labelToValue.has(o.target)) {
        diagnostics.push({
          level: 'error',
          message: `agent await ${a.state}: on ${o.outcome} -> ${o.target}: unknown target stage`,
          line: agent.startLine,
          speck: speckName,
        });
        continue;
      }
      const actionName = `__signal_${a.signal}_${o.outcome}`;
      if (syntheticNames.includes(actionName)) {
        diagnostics.push({
          level: 'error',
          message: `agent: duplicate synthetic action "${actionName}"`,
          line: agent.startLine,
          speck: speckName,
        });
        continue;
      }
      if (actionNames.has(actionName) && !actionName.startsWith('__signal_')) {
        diagnostics.push({
          level: 'error',
          message: `agent: synthetic action name collides with declared action "${actionName}"`,
          line: agent.startLine,
          speck: speckName,
        });
        continue;
      }
      const targetValue = labelToValue.get(o.target)!;
      syntheticActions.push({ outcome: o.outcome, actionName, targetValue, awaitValue });
      syntheticNames.push(actionName);
      // Synthetic bodies live on the AST (injectSignalActions) for Z3/TS agent
      // machines. The IR only records metadata + next: membership so other
      // backends (camel/go/…) do not grow __signal_* processors.
    }

    awaits.push({
      state: a.state,
      signal: a.signal,
      mode: a.mode,
      outcomes: [...a.outcomes],
      rejects: [...(a.rejects ?? [])],
      claims: a.claims.map(c => ({ name: c.name, typeName: c.typeName })),
      on: a.on.map(o => ({ outcome: o.outcome, target: o.target })),
      timeout: a.timeout ? { ...a.timeout } : undefined,
      syntheticActions,
    });
  }

  // Append synthetic actions to next: so BMC covers signal edges (skip if
  // the AST inject pass already extended next:).
  if (syntheticNames.length > 0) {
    if (behavior.next) {
      const have = new Set(behavior.next);
      const missing = syntheticNames.filter(n => !have.has(n));
      if (missing.length > 0) behavior.next = [...behavior.next, ...missing];
    } else {
      diagnostics.push({
        level: 'warning',
        message: 'agent: next: is missing; synthetic signal actions will not be covered by BMC',
        line: agent.startLine,
        speck: speckName,
      });
    }
  }

  return {
    stages: agent.stages
      ? { variable: agent.stages.variable, labels: agent.stages.labels.map(l => ({ ...l })) }
      : undefined,
    tools,
    awaits,
    ...(agent.pendingTimeout ? { pendingTimeout: { ...agent.pendingTimeout } } : {}),
  };
}

/** Harness ids with a generated adapter (see generators/agent/harness-runtime.ts). */
export const SUPPORTED_HARNESSES = ['claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'goose', 'hermes', 'pi', 'opencode', 'openclaw', 'cline', 'kiro', 'windsurf'] as const;

/**
 * Check `harness <name> { map ... }` blocks: known harness, declared target
 * tools, real action parameters, compilable patterns. Errors here stop
 * `-t agent` (index.ts refuses diagnostics that start with "agent").
 */
function validateHarnesses(
  agent: AgentMemberNode & { startLine?: number },
  behavior: BehaviorFacet,
  speckName: string,
  diagnostics: IRDiagnostic[],
): void {
  const err = (message: string) => diagnostics.push({ level: 'error', message, line: agent.startLine, speck: speckName });
  const toolToAction = new Map(agent.tools.map(t => [t.name, t.action]));
  const paramsOf = new Map(behavior.actions.map(a => [a.name, a.params.map(p => p.name)]));
  const seen = new Set<string>();
  for (const h of agent.harnesses ?? []) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(h.name)) {
      err(`agent harness ${h.name}: unknown harness (supported: ${SUPPORTED_HARNESSES.join(', ')})`);
    }
    if (seen.has(h.name)) err(`agent harness ${h.name}: declared twice`);
    seen.add(h.name);
    if (h.rules.length === 0) {
      diagnostics.push({
        level: 'warning',
        message: `agent harness ${h.name}: no map lines; every tool call will be denied`,
        line: agent.startLine,
        speck: speckName,
      });
    }
    for (const r of h.rules) {
      const where = `agent harness ${h.name} map ${r.tools.join('|')}`;
      const action = toolToAction.get(r.target);
      if (!action) {
        err(`${where}: -> ${r.target} is not a declared tool`);
        continue;
      }
      const params = paramsOf.get(action) ?? [];
      const seenParams = new Set<string>();
      for (const p of r.params) {
        if (!params.includes(p.param)) {
          err(`${where}: ${p.param} is not a parameter of ${action} (has: ${params.join(', ') || 'none'})`);
        }
        if (seenParams.has(p.param)) err(`${where}: ${p.param} is mapped twice`);
        seenParams.add(p.param);
      }
      if (r.pattern !== undefined) {
        try {
          new RegExp('^(?:' + r.pattern + ')$');
        } catch (e) {
          err(`${where}: pattern "${r.pattern}" is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
  }
}

function lowerFormalSpec(
  speck: SpeckNode,
  ast: AST,
  diagnostics: IRDiagnostic[],
): FormalSpecFacet {
  const constraints: IRConstraint[] = [];
  const verifies: IRVerify[] = [];
  const inputs: IRFieldDef[] = [];
  const outputs: IRFieldDef[] = [];

  for (const m of speck.members) {
    if (m.type === 'constraint') {
      const c = m as ConstraintNode;
      constraints.push({
        name: c.name,
        expr: parseExprSafe(c.expr, diagnostics, speck.name),
      });
    } else if (m.type === 'verify') {
      const v = m as VerifyNode;
      verifies.push({
        name: v.name,
        temporalExpr: parseExprSafe(v.temporalExpr, diagnostics, speck.name),
        depth: v.depth,
      });
    } else if (m.type === 'input' || m.type === 'output') {
      // Declarative-spec free variables. Flatten record types to named
      // fields so generators can declare them as constants.
      const typeExpr = (m as InputNode | OutputNode).typeExpr;
      const target = m.type === 'input' ? inputs : outputs;
      if (typeExprRecordFields(typeExpr)) {
        for (const f of typeExprRecordFields(typeExpr)!) {
          target.push({ name: f.name, type: lowerTypeExpr(f.type), optional: false });
        }
      } else {
        diagnostics.push({
          level: 'warning',
          message: `${m.type} type is not a record; fields cannot be named for formal verification — skipped`,
          speck: speck.name,
        });
      }
    }
  }

  return { constraints, verifies, inputs, outputs };
}

/** Return the fields of a record TypeExpr, or null for other shapes. */
function typeExprRecordFields(t: TypeExpr): { name: string; type: TypeExpr }[] | null {
  return t.type === 'record' ? t.fields ?? null : null;
}

function lowerWireFormat(speck: SpeckNode): WireFormatFacet {
  const wf: WireFormatFacet = { defaultFormat: 'protobuf' };
  if (speck.protoPackage) wf.protoPackage = speck.protoPackage;
  if (speck.goPackage) wf.goPackage = speck.goPackage;
  if (speck.eventSuffix) wf.eventSuffix = speck.eventSuffix;

  for (const m of speck.members) {
    if (m.type === 'state') {
      const s = m as StateNode;
      if (s.messageName) wf.stateMessageName = s.messageName;
    }
  }
  return wf;
}

function lowerProvenance(
  speck: SpeckNode,
  filePath: string,
  diagnostics: IRDiagnostic[],
): ProvenanceFacet {
  // First pass: collect declared provenance members.
  let clauses: ProvenanceClause[] = [];
  let review: 'manual' | 'auto' | 'hybrid' = 'manual';
  let authors: Author[] = [];
  let sources: Source[] = [];
  let derives: { from: string; via?: string } | undefined;
  let satisfies: { requirement: string; clause?: string } | undefined;
  let bom: BOMMetadata | undefined;
  let synthesized = false;

  for (const m of speck.members) {
    if (m.type === 'provenance') {
      const p = m as ProvenanceNode;
      for (const c of p.clauses) {
        // AST uses `type`, IR uses `kind`. Normalize.
        clauses.push({ kind: c.type as any, value: c.value, location: c.location });
      }
    } else if (m.type === 'review') {
      review = (m as ReviewNode).kind;
    } else if (m.type === 'author') {
      const a = m as AuthorNode;
      authors.push({ name: a.name, email: a.email });
    } else if (m.type === 'source') {
      const s = m as SourceNode;
      sources.push({ kind: s.kind, ref: s.ref });
    } else if (m.type === 'derives') {
      const d = m as DerivesNode;
      derives = { from: d.from, via: d.via };
    } else if (m.type === 'satisfies') {
      const s = m as SatisfiesNode;
      satisfies = { requirement: s.requirement, clause: s.clause };
    } else if (m.type === 'bom') {
      const b = m as BOMNode;
      bom = {
        compiler: b.compiler,
        solver: b.solver,
        runtime: b.runtime,
        license: b.license,
        hash: b.hash,
      };
    }
  }

  // Synthesize missing provenance from file metadata and speck-level
  // metadata directives (version/author/license on SpeckNode).
  // Provenance is non-optional: if the source didn't declare authors, derive
  // from speck.author. If no review was declared, default to 'manual'.
  //
  // The `synthesized` flag is true ONLY when clauses were synthesized —
  // i.e., the source spec had no provenance block at all. If clauses are
  // explicit but authors are derived from speck-level metadata, that's
  // "author augmentation" not "provenance synthesis". Tests that assert
  // "synthesized=false" for specs with explicit provenance blocks rely
  // on this distinction.
  if (authors.length === 0 && speck.author) {
    authors.push({ name: speck.author });
  }
  if (clauses.length === 0) {
    synthesized = true;
  }

  return {
    clauses,
    review,
    authors,
    sources,
    derives,
    satisfies,
    bom,
    synthesized,
  };
}

function lowerMetadata(speck: SpeckNode): MetadataFacet {
  // The parser stores version/author/license as members (AuthorNode, etc.)
  // for backward compatibility, NOT on SpeckNode directly. The lower pass
  // walks the members and synthesizes the metadata facet.
  let version = speck.version;
  let author = speck.author;
  let license = speck.license;

  for (const m of speck.members) {
    if (m.type === 'author' && !author) {
      author = (m as AuthorNode).name;
    }
    if (m.type === 'bom') {
      const b = m as BOMNode;
      if (b.license && !license) license = b.license;
      if (b.compiler?.version && !version) version = b.compiler.version;
    }
  }

  return {
    version,
    author,
    license,
  };
}

function lowerResourceLifecycle(speck: SpeckNode): ResourceLifecycleFacet {
  // The K8s-style resource lifecycle fields are single-line members with
  // a `lifecycle_metadata` member type set by the parser. We collect them
  // into the IR's resource_lifecycle facet.
  const rl: ResourceLifecycleFacet = {
    conditions: [],
    finalizers: [],
    ownerReferences: false,
  };

  for (const m of speck.members) {
    const any = m as any;
    if (any.type === 'lifecycle_metadata') {
      const key = any.key;
      const value = any.value;
      if (key === 'conditions') {
        rl.conditions = value as string[];
      } else if (key === 'finalizers') {
        rl.finalizers = value as string[];
      } else if (key === 'ownerReferences') {
        rl.ownerReferences = value as boolean;
      } else if (key === 'status') {
        // Status subresource — the value is a string like "{ ready: Bool, itemCount: Nat }"
        // We capture the raw text; the K8s CRD target interprets it.
        rl.status = { kind: 'record', name: 'Status', fields: [], doc: value as string } as any;
      }
    }
  }

  return rl;
}

// ─────────────────────────────────────────────────────────────────────
// Type expression lower
// ─────────────────────────────────────────────────────────────────────

function lowerTypeExpr(t: TypeExpr): IRTypeRef {
  if (t.type === 'primitive') {
    return { kind: 'primitive', primitive: t.name, ...(t.nullable ? { nullable: true } : {}) };
  }
  if (t.type === 'list' || t.type === 'set') {
    return {
      kind: 'list',
      elementType: t.elementType ? lowerTypeExpr(t.elementType) : { kind: 'primitive', primitive: 'Unknown' },
      ...(t.nullable ? { nullable: true } : {}),
    };
  }
  if (t.type === 'map') {
    return {
      kind: 'map',
      keyType: t.keyType ? lowerTypeExpr(t.keyType) : { kind: 'primitive', primitive: 'Unknown' },
      valueType: t.valueType ? lowerTypeExpr(t.valueType) : { kind: 'primitive', primitive: 'Unknown' },
      ...(t.nullable ? { nullable: true } : {}),
    };
  }
  if (t.type === 'ident') {
    return { kind: 'ident', name: t.name, ...(t.nullable ? { nullable: true } : {}) };
  }
  if (t.type === 'record') {
    return {
      kind: 'map',  // Will be normalized later if needed.
      fields: t.fields?.map(f => ({
        name: f.name,
        type: lowerTypeExpr(f.type),
        optional: false,
      })),
      ...(t.nullable ? { nullable: true } : {}),
    };
  }
  return { kind: 'primitive', primitive: 'Unknown', ...(t.nullable ? { nullable: true } : {}) };
}

// ─────────────────────────────────────────────────────────────────────
// Statement lower
// ─────────────────────────────────────────────────────────────────────


/** Lower a parser-shaped ActionStatement (string exprs) into IR. */
function lowerParserActionStatement(
  s: { type: string; target?: string; expr?: string; name?: string; event?: string; fields?: { name: string; value: string }[]; raw?: string },
  diagnostics: IRDiagnostic[],
  speckName: string,
): IRStmt {
  switch (s.type) {
    case 'assign':
      return {
        kind: 'assign',
        target: s.target || '',
        value: parseExprSafe(s.expr || '0', diagnostics, speckName),
      };
    case 'require':
    case 'precondition':
    case 'postcondition':
      return {
        kind: s.type as 'require' | 'precondition' | 'postcondition',
        value: parseExprSafe(s.expr || 'true', diagnostics, speckName),
      };
    case 'let':
      return {
        kind: 'let',
        letName: s.name,
        value: parseExprSafe(s.expr || '0', diagnostics, speckName),
      };
    case 'return':
      return {
        kind: 'return',
        expr: parseExprSafe(s.expr || 'true', diagnostics, speckName),
      };
    default:
      diagnostics.push({
        level: 'warning',
        message: `unsupported synthetic statement type: ${s.type}`,
        speck: speckName,
      });
      return { kind: 'require', value: { kind: 'bool_lit', value: true } };
  }
}

function lowerStatement(
  s: ActionStatement,
  diagnostics: IRDiagnostic[],
  speckName: string,
): IRStmt {
  switch (s.type) {
    case 'assign':
      return {
        kind: 'assign',
        target: s.target.kind === 'plain' ? s.target.name : `${s.target.mapName}[...]`,
        value: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'let':
      return {
        kind: 'let',
        letName: s.name,
        value: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'require':
      return {
        kind: 'require',
        value: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'precondition':
      return {
        kind: 'precondition',
        value: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'postcondition':
      return {
        kind: 'postcondition',
        value: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'emit':
      return {
        kind: 'emit',
        event: s.event,
        fields: s.fields.map(f => ({
          name: f.name,
          value: lowerExpr(f.value, diagnostics, speckName),
        })),
      };
    case 'return':
      return {
        kind: 'return',
        expr: lowerExpr(s.expr, diagnostics, speckName),
      };
    case 'ifblock':
      // Future: lower the ifblock properly. For now, keep as a synthetic
      // statement that the generators can choose to ignore.
      diagnostics.push({
        level: 'info',
        message: `statement preserved as raw text in IR, not lowered: ${s.raw}`,
        speck: speckName,
      });
      return { kind: 'if', expr: undefined, raw: s.raw };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Expression lower (Expr → IRExpr)
// ─────────────────────────────────────────────────────────────────────

function lowerExpr(
  e: Expr | undefined,
  diagnostics: IRDiagnostic[],
  speckName: string,
): IRExpr {
  if (!e) {
    return { kind: 'bool_lit', value: false, parseFailed: true };
  }
  switch (e.kind) {
    case 'literal': {
      if (e.type === 'bool') return { kind: 'bool_lit', value: e.value === 'true' };
      if (e.type === 'string') return { kind: 'string_lit', value: e.value };
      if (e.type === 'number') {
        const n = Number(e.value);
        if (Number.isInteger(n)) return { kind: 'int_lit', value: n };
        return { kind: 'float_lit', value: n };
      }
      // `null` has no IR literal.
      return { kind: 'bool_lit', value: false, parseFailed: true, source: e.value || 'null' };
    }
    case 'ident':
      return { kind: 'ident', name: e.name };
    case 'unary':
      return {
        kind: 'unop',
        op: e.op === 'not' ? '!' : '-',
        operand: lowerExpr(e.operand, diagnostics, speckName),
      };
    case 'binary':
      // Infix `a implies b` lowers to the same node as the call form
      // `implies(a, b)`, which the IR backends already understand.
      if (e.op === 'implies') {
        return {
          kind: 'call',
          fn: 'implies',
          args: [lowerExpr(e.left, diagnostics, speckName), lowerExpr(e.right, diagnostics, speckName)],
        };
      }
      return {
        kind: 'binop',
        op: lowerBinOp(e.op),
        left: lowerExpr(e.left, diagnostics, speckName),
        right: lowerExpr(e.right, diagnostics, speckName),
      };
    case 'call':
      return {
        kind: 'call',
        fn: e.callee,
        args: e.args.map(a => lowerExpr(a, diagnostics, speckName)),
      };
    case 'member':
      return {
        kind: 'field',
        target: lowerExpr(e.object, diagnostics, speckName),
        field: e.property,
      };
    case 'index':
      return {
        kind: 'index',
        target: lowerExpr(e.object, diagnostics, speckName),
        index: lowerExpr(e.index, diagnostics, speckName),
      };
    case 'parens':
      // Parenthesized grouping - transparent in the IR.
      return lowerExpr(e.expr, diagnostics, speckName);
    case 'unparsed':
      diagnostics.push({
        level: 'warning',
        message: `expression not parsed in full (${e.error}); carried as an untranslated placeholder: ${e.source}`,
        speck: speckName,
      });
      return { kind: 'bool_lit', value: false, parseFailed: true, source: e.source };
    default:
      diagnostics.push({
        level: 'info',
        message: `expression kind ${e.kind} not yet lowered; emitting bool_lit false placeholder: ${exprToSource(e)}`,
        speck: speckName,
      });
      return { kind: 'bool_lit', value: false, parseFailed: true, source: exprToSource(e) };
  }
}

function lowerBinOp(op: string): string {
  switch (op) {
    case 'eq': return '==';
    case 'neq': return '!=';
    case 'lt': return '<';
    case 'gt': return '>';
    case 'lte': return '<=';
    case 'gte': return '>=';
    case 'add': return '+';
    case 'sub': return '-';
    case 'mul': return '*';
    case 'div': return '/';
    case 'mod': return '%';
    case 'and': return '&&';
    case 'or': return '||';
    case 'in': return 'in';
    case 'notin': return '!in';
    case 'union': return 'union';
    case 'concat': return '+';
    default: return op;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Expression parser (string → Expr) with diagnostics
// ─────────────────────────────────────────────────────────────────────

function parseExprSafe(
  src: string,
  diagnostics: IRDiagnostic[],
  speckName: string,
): IRExpr {
  // The whole string must parse; a prefix parse used to drop the tail
  // silently (`P implies Q` read as `P`, `forall x in c: body` as `forall`).
  try {
    const parsed = parseExpressionComplete(src);
    return lowerExpr(parsed, diagnostics, speckName);
  } catch (e) {
    diagnostics.push({
      level: 'warning',
      message: `expression parse failed: ${(e as Error).message}; carried as an untranslated placeholder: ${src}`,
      speck: speckName,
    });
    return { kind: 'bool_lit', value: false, parseFailed: true, source: src };
  }
}

/**
 * Parse a source expression string into a typed IRExpr, for callers outside
 * the lower pass (e.g. the Z3 state-machine generator). Parse failure yields
 * a bool_lit placeholder with parseFailed: true - callers should check
 * containsParseFailure and fall back. Leftover input is a parse failure.
 */
export function parseStringToIRExpr(src: string): IRExpr {
  // The whole string must parse. A prefix parse (`P implies Q` read as `P`)
  // looked like success and let the Z3 backend prove the wrong property.
  try {
    return lowerExpr(parseExpressionComplete(src), [], '(inline)');
  } catch {
    return { kind: 'bool_lit', value: false, parseFailed: true, source: src };
  }
}

// ─────────────────────────────────────────────────────────────────────
// File metadata extraction
// ─────────────────────────────────────────────────────────────────────

function extractFileMetadata(ast: AST, options: LowerOptions): FileMetadata {
  // The first speck's top-level directives are the file-level metadata,
  // by Speckl convention. We also walk all specks for author/license
  // (the parser stores them as members, not on SpeckNode directly, so
  // the lower pass has to do the collection).
  const first = ast.specks[0];
  let author = first?.author;
  let license = first?.license;
  let version = first?.version;

  if (!author) {
    for (const s of ast.specks) {
      const authorMember = s.members.find(m => m.type === 'author') as any;
      if (authorMember) { author = authorMember.name; break; }
    }
  }
  if (!license) {
    for (const s of ast.specks) {
      const bom = s.members.find(m => m.type === 'bom') as any;
      if (bom && bom.license) { license = bom.license; break; }
    }
  }

  return {
    filePath: options.filePath,
    version,
    author,
    license,
  };
}
