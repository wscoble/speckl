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
  InputNode, OutputNode, AgentMemberNode, InvariantMemberNode,
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
import { maskSource } from '../source-scan.js';

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
  const sourceLines = rawSource.split('\n');
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
  reportUnknownTypes(speck, rawSource, declaredTypeNames(ast, rawSource), diagnostics);
  const behavior = lowerBehavior(speck, rawStatementsByAction, diagnostics, sourceLines);
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

  // Each action's body is located from the parser's own line range for that
  // action node, so the IR sees exactly the actions the AST has. A raw-source
  // scan for `action Name(` used to miss parameterless actions
  // (`action Approve {`), which then lowered with no statements at all.
  for (const m of speck.members) {
    if (m.type !== 'action') continue;
    const { startLine, endLine } = m as { startLine?: number; endLine?: number };
    if (!startLine || !endLine) continue;
    const body = actionBodyEntries(lines, startLine, endLine);
    out.set((m as ActionNode).name, parseActionStatements(body.map(e => e.text), body.map(e => e.line)));
  }

  return out;
}

/**
 * Body lines of an action spanning 1-based source lines [startLine, endLine]:
 * everything after the opening `{` and before the closing `}`.
 */
function actionCode(text: string): string {
  return maskSource(text, { unclosed: 'blank', blankStringBraces: false }).trim();
}

function actionBodyEntries(lines: string[], startLine: number, endLine: number): { text: string; line: number }[] {
  const scan = maskSource(lines.join('\n')).split('\n');
  let open = startLine - 1;
  while (open < endLine - 1 && !(scan[open] ?? '').includes('{')) open++;
  const close = endLine - 1;
  const entries: { text: string; line: number }[] = [];
  const openIdx = (scan[open] ?? '').indexOf('{');
  if (open >= close) {
    // Single-line action: `action Name { stmt }`. The `}` in a comment is not the close.
    const l = lines[open] ?? '';
    const closeIdx = (scan[open] ?? '').lastIndexOf('}');
    const body = actionCode(l.slice(openIdx + 1, closeIdx >= 0 ? closeIdx : undefined));
    if (body) entries.push({ text: body, line: open + 1 });
    return entries;
  }
  // Text after `{` on the header line, body lines, text before `}` on the close.
  const head = actionCode((lines[open] ?? '').slice(openIdx + 1));
  if (head) entries.push({ text: head, line: open + 1 });
  for (let idx = open + 1; idx < close; idx++) {
    entries.push({ text: lines[idx] ?? '', line: idx + 1 });
  }
  const closeIdx = (scan[close] ?? '').lastIndexOf('}');
  const tail = actionCode(closeIdx >= 0 ? (lines[close] ?? '').slice(0, closeIdx) : (lines[close] ?? ''));
  if (tail) entries.push({ text: tail, line: close + 1 });
  return entries;
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
  sourceLines: string[],
): BehaviorFacet {
  const stateVars: IRStateVar[] = [];
  let init: IRAssign[] = [];
  const actions: IRAction[] = [];
  const events: IREvent[] = [];
  const stateNames = new Set<string>();
  for (const m of speck.members) {
    if (m.type === 'state') {
      for (const v of (m as StateNode).variables) stateNames.add(v.name);
    }
  }
  const baseEnv = valueEnv(speck, sourceLines, diagnostics);
  const seenActions = new Set<string>();

  for (const m of speck.members) {
    if (m.type === 'state') {
      const s = m as StateNode;
      for (const v of s.variables) {
        if (v.defaultInit) {
          checkBinding(v.name, v.defaultInit, baseEnv, lineOfBinding(sourceLines, v.name));
        }
        stateVars.push({
          name: v.name,
          type: lowerTypeExpr(v.typeExpr),
          defaultInit: v.defaultInit ? parseExprSafe(v.defaultInit, diagnostics, speck.name, baseEnv.constants) : undefined,
        });
      }
    } else if (m.type === 'init') {
      const i = m as InitNode;
      const initLine = (i as InitNode & { startLine?: number }).startLine;
      const initEnd = (i as InitNode & { endLine?: number }).endLine;
      init = i.assignments.map(a => {
        const line = lineOfBinding(sourceLines, a.name, initLine, initEnd);
        checkBinding(a.name, a.expr, baseEnv, line);
        return {
          target: a.name,
          expr: parseExprSafe(a.expr, diagnostics, speck.name, baseEnv.constants),
        };
      });
    } else if (m.type === 'action') {
      const a = m as ActionNode;
      if (seenActions.has(a.name)) {
        diagnostics.push({
          level: 'error',
          message: `duplicate action "${a.name}"`,
          line: (a as ActionNode & { startLine?: number }).startLine,
          speck: speck.name,
        });
      }
      seenActions.add(a.name);
      const rawStmts = rawStatementsByAction.get(a.name) || [];
      // No caller lowers a signal-injected AST: the agent block's synthetic
      // __signal_* actions are added to the IR below, from the agent block.
      const scope = new Set(baseEnv.scope);
      const types = new Map(baseEnv.types);
      const constants = new Map(baseEnv.constants);
      for (const p of a.params) {
        scope.add(p.name);
        constants.delete(p.name);
        const kind = primitiveKind(p.type);
        if (kind) types.set(p.name, kind);
        else types.delete(p.name);
      }
      const env: ExprEnv = {
        ...baseEnv,
        scope, types, constants, diagnostics, speckName: speck.name, lines: sourceLines, seen: baseEnv.seen,
      };
      const stmts: IRStmt[] = rawStmts.map(s => lowerStatement(s, env));
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

  for (const m of speck.members) {
    if (m.type !== 'invariant') continue;
    const inv = m as InvariantMemberNode;
    const line = (m as InvariantMemberNode & { startLine?: number }).startLine;
    checkSourceExpr(inv.expr, { ...baseEnv, line });
  }

  const agentMember = speck.members.find((m): m is AgentMemberNode & { startLine?: number } => m.type === 'agent');
  if (agentMember) {
    behavior.agent = lowerAgent(agentMember, behavior, speck.name, diagnostics, sourceLines);
  }
  return behavior;
}

/**
 * Validate and lower an `agent { }` block. Injects synthetic `__signal_*`
 * actions into behavior.actions / behavior.next so Z3 BMC covers the
 * human-response edges; those actions are never exposed as tools.
 */
function lowerAgent(
  agent: AgentMemberNode & { startLine?: number; endLine?: number },
  behavior: BehaviorFacet,
  speckName: string,
  diagnostics: IRDiagnostic[],
  sourceLines: string[],
): IRAgentConfig {
  const note = (level: 'error' | 'warning', message: string, token?: string) => {
    const where = locateInRange(sourceLines, agent.startLine, agent.endLine, token);
    diagnostics.push({ level, message, line: where.line, column: where.column, speck: speckName });
  };
  const actionNames = new Set(behavior.actions.map(a => a.name));
  const stateVarNames = new Set(behavior.stateVars.map(v => v.name));
  const labelToValue = new Map<string, number>();
  let stageVar = 'stage';

  if (agent.stages) {
    stageVar = agent.stages.variable;
    if (!stateVarNames.has(stageVar)) {
      note('error', `agent stages: unknown state variable "${stageVar}"`, stageVar);
    }
    for (const l of agent.stages.labels) {
      if (labelToValue.has(l.name)) {
        note('error', `agent stages: duplicate label "${l.name}"`, l.name);
      }
      labelToValue.set(l.name, l.value);
    }
  }

  const tools = [];
  const seenToolNames = new Set<string>();
  for (const t of agent.tools) {
    if (seenToolNames.has(t.name)) {
      note('error', `agent: duplicate tool "${t.name}"`, t.name);
    }
    seenToolNames.add(t.name);
    if (!actionNames.has(t.action)) {
      note('error', `agent tool ${t.name}: unknown action "${t.action}"`, t.action);
    }
    if (t.effect !== 'act' && t.effect !== 'observe') {
      note('error', `agent tool ${t.name}: effect must be act or observe`, t.name);
    }
    tools.push({ name: t.name, action: t.action, effect: t.effect });
  }

  validateHarnesses(agent, behavior, speckName, diagnostics, sourceLines);

  const awaits: IRAgentAwait[] = [];
  const syntheticNames: string[] = [];

  if (agent.pendingTimeout && agent.pendingTimeout.durationMs <= 0) {
    note('error', `agent: pending timeout must be greater than zero (got ${agent.pendingTimeout.durationText})`, 'timeout');
  }

  for (const a of agent.awaits) {
    if (!labelToValue.has(a.state)) {
      note('error', `agent await ${a.state}: unknown stage label (declare it in stages)`, a.state);
      continue;
    }
    const awaitValue = labelToValue.get(a.state)!;
    const rejectOutcomes = new Set(a.rejects ?? []);
    for (const o of a.outcomes) {
      if (/reject|deny|denied|decline/i.test(o) && !rejectOutcomes.has(o)) {
        note('warning', `agent await ${a.state}: outcome "${o}" looks like a rejection but is not marked; write "${o}!" in require outcome in {...} to make it a reject outcome`, o);
      }
    }
    if (a.timeout) {
      if (!a.outcomes.includes(a.timeout.outcome)) {
        note('error', `agent await ${a.state}: timeout outcome "${a.timeout.outcome}" not in require outcome in {...}`, a.timeout.outcome);
      } else if (!rejectOutcomes.has(a.timeout.outcome)) {
        // A timeout may only resolve to an outcome explicitly marked reject.
        note('error', `agent await ${a.state}: timeout may only resolve to a reject outcome marked with ! (got "${a.timeout.outcome}"; write "${a.timeout.outcome}!" in require outcome in {...} if it really rejects)`, a.timeout.outcome);
      }
    }
    // A reject outcome must not lead where an accepting outcome leads, or a
    // timeout (or any reject) could approve by another name.
    for (const r of rejectOutcomes) {
      const rTarget = a.on.find(o => o.outcome === r)?.target;
      const accepting = a.on.filter(o => !rejectOutcomes.has(o.outcome)).map(o => o.target);
      if (rTarget !== undefined && accepting.includes(rTarget)) {
        note('error', `agent await ${a.state}: reject outcome "${r}" leads to ${rTarget}, which a non-reject outcome also reaches`, rTarget);
      }
    }
    if (rejectOutcomes.size === a.outcomes.length && a.outcomes.length > 0) {
      note('warning', `agent await ${a.state}: every outcome is marked reject; nothing can approve`, a.state);
    }

    const syntheticActions: IRAgentAwait['syntheticActions'] = [];
    for (const o of a.on) {
      if (!labelToValue.has(o.target)) {
        const hint = suggestKnownType(o.target, new Set(labelToValue.keys()));
        const suggest = hint ? `. Did you mean \`${hint}\`?` : '';
        note('error', `agent await ${a.state}: on ${o.outcome} -> ${o.target}: unknown target stage${suggest}`, o.target);
        continue;
      }
      const actionName = `__signal_${a.signal}_${o.outcome}`;
      if (syntheticNames.includes(actionName)) {
        note('error', `agent: duplicate synthetic action "${actionName}"`, o.target);
        continue;
      }
      if (actionNames.has(actionName) && !actionName.startsWith('__signal_')) {
        note('error', `agent: synthetic action name collides with declared action "${actionName}"`, actionName);
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
      bindCall: [...a.bindCall],
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
      note('warning', 'agent: next: is missing; synthetic signal actions will not be covered by BMC', 'next');
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
  agent: AgentMemberNode & { startLine?: number; endLine?: number },
  behavior: BehaviorFacet,
  speckName: string,
  diagnostics: IRDiagnostic[],
  sourceLines: string[] = [],
): void {
  const err = (message: string, token?: string) => {
    const where = locateInRange(sourceLines, agent.startLine, agent.endLine, token);
    diagnostics.push({ level: 'error', message, line: where.line, column: where.column, speck: speckName });
  };
  const toolToAction = new Map(agent.tools.map(t => [t.name, t.action]));
  const paramsOf = new Map(behavior.actions.map(a => [a.name, a.params.map(p => p.name)]));
  const seen = new Set<string>();
  for (const h of agent.harnesses ?? []) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(h.name)) {
      err(`agent harness ${h.name}: unknown harness (supported: ${SUPPORTED_HARNESSES.join(', ')})`, h.name);
    }
    if (seen.has(h.name)) err(`agent harness ${h.name}: declared twice`, h.name);
    seen.add(h.name);
    if (h.rules.length === 0) {
      const where = locateInRange(sourceLines, agent.startLine, agent.endLine, h.name);
      diagnostics.push({
        level: 'warning',
        message: `agent harness ${h.name}: no map lines; every tool call will be denied`,
        line: where.line,
        column: where.column,
        speck: speckName,
      });
    }
    for (const r of h.rules) {
      const where = `agent harness ${h.name} map ${r.tools.join('|')}`;
      const action = toolToAction.get(r.target);
      if (!action) {
        err(`${where}: -> ${r.target} is not a declared tool`, r.target);
        continue;
      }
      const params = paramsOf.get(action) ?? [];
      const seenParams = new Set<string>();
      for (const p of r.params) {
        if (!params.includes(p.param)) {
          err(`${where}: ${p.param} is not a parameter of ${action} (has: ${params.join(', ') || 'none'})`, p.param);
        }
        if (seenParams.has(p.param)) err(`${where}: ${p.param} is mapped twice`, p.param);
        seenParams.add(p.param);
      }
      if (r.pattern !== undefined) {
        try {
          new RegExp('^(?:' + r.pattern + ')$');
        } catch (e) {
          err(`${where}: pattern "${r.pattern}" is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`, r.pattern);
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


function lowerStatement(
  s: ActionStatement,
  env: ExprEnv,
): IRStmt {
  const diagnostics = env.diagnostics;
  const speckName = env.speckName;
  switch (s.type) {
    case 'assign': {
      const name = s.target.kind === 'plain' ? s.target.name : s.target.mapName;
      if (!env.scope.has(name)) reportUndeclared(env, name, s.line);
      env.line = s.line;
      if (s.target.kind === 'map_index') checkExpr(s.target.index, env);
      checkExpr(s.expr, env);
      if (s.target.kind === 'plain') checkAssignLiteral(env, name, s.expr, s.line);
      return {
        kind: 'assign',
        target: s.target.kind === 'plain' ? s.target.name : `${s.target.mapName}[...]`,
        ...(s.target.kind === 'map_index' ? { targetIndex: lowerExpr(s.target.index, diagnostics, speckName, env.constants) } : {}),
        value: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    }
    case 'let':
      env.line = s.line;
      if (s.badEquals) {
        const lineText = env.lines[(s.line ?? 1) - 1] ?? '';
        const eq = lineText.indexOf('=');
        diagnostics.push({
          level: 'error',
          message: `let ${s.name} uses \`=\`. Use \`:=\`.`,
          line: s.line,
          column: eq >= 0 ? eq + 1 : undefined,
          speck: speckName,
        });
      }
      checkExpr(s.expr, env);
      env.scope.add(s.name);
      return {
        kind: 'let',
        letName: s.name,
        value: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    case 'require':
      env.line = s.line;
      checkExpr(s.expr, env);
      checkBoolExpr(env, s.expr, s.line, 'require');
      return {
        kind: 'require',
        value: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    case 'precondition':
      env.line = s.line;
      checkExpr(s.expr, env);
      checkBoolExpr(env, s.expr, s.line, 'precondition');
      return {
        kind: 'precondition',
        value: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    case 'postcondition':
      env.line = s.line;
      checkExpr(s.expr, env);
      checkBoolExpr(env, s.expr, s.line, 'postcondition');
      return {
        kind: 'postcondition',
        value: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    case 'emit':
      env.line = s.line;
      for (const f of s.fields) checkExpr(f.value, env);
      return {
        kind: 'emit',
        event: s.event,
        fields: s.fields.map(f => ({
          name: f.name,
          value: lowerExpr(f.value, diagnostics, speckName, env.constants),
        })),
      };
    case 'return':
      env.line = s.line;
      checkExpr(s.expr, env);
      return {
        kind: 'return',
        expr: lowerExpr(s.expr, diagnostics, speckName, env.constants),
      };
    case 'ifblock': {
      // `if` / `forall` / `for` stay raw. A binder still names the statements
      // that follow it (`forall s in ...` then `use s`), which are separate
      // statements in this parser.
      const bound = /^(?:forall|for)\s+([A-Za-z_]\w*)\b/.exec(s.raw.trim());
      if (bound) env.scope.add(bound[1]);
      diagnostics.push({
        level: 'info',
        message: `statement preserved as raw text in IR, not lowered: ${s.raw}`,
        speck: speckName,
      });
      return { kind: 'if', expr: undefined, raw: s.raw };
    }
    case 'unrecognized': {
      const hint = s.suggestion ? ` Did you mean \`${s.suggestion}\`?` : '';
      const word = s.raw.match(/[A-Za-z_]\w*/)?.[0];
      const at = locateName(env.lines, s.line, word);
      diagnostics.push({
        level: 'error',
        message: `unrecognized statement "${s.raw}".${hint}`,
        line: at.line ?? s.line,
        column: at.column,
        speck: speckName,
      });
      return { kind: 'if', expr: undefined, raw: s.raw };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Names and obvious literal types
// ─────────────────────────────────────────────────────────────────────

type ValueKind = 'bool' | 'nat' | 'int' | 'real' | 'string';

interface ExprEnv {
  scope: Set<string>;
  types: Map<string, ValueKind>;
  /** Stage label → Nat value. An ident lowers to that number. */
  constants: Map<string, number>;
  stageVar?: string;
  stageValues?: Set<number>;
  stageLabels?: { name: string; value: number }[];
  diagnostics: IRDiagnostic[];
  speckName: string;
  lines: string[];
  line?: number;
  seen: Set<string>;
}

/** Functions and constants the expression language already knows. */
const EXPR_BUILTINS = new Set([
  'abs', 'add', 'always', 'Always', 'and', 'append', 'card', 'ceil', 'concat', 'old',
  'contains', 'count', 'delete', 'diff', 'disjoint', 'dom', 'empty', 'emptyList',
  'emptyMap', 'emptySet', 'Err', 'eventually', 'Eventually', 'filter', 'first',
  'floor', 'fold', 'get', 'has', 'hash', 'head', 'implies', 'insert', 'isEmpty',
  'isNone', 'isSome', 'keys', 'last', 'length', 'List', 'lookup', 'Map', 'map',
  'max', 'member', 'min', 'nil', 'None', 'not', 'Ok', 'or', 'pop', 'push', 'range',
  'remove', 'round', 'Set', 'size', 'Some', 'subset', 'sum', 'tail', 'update',
  'values',
]);

const COMPARE_OPS = new Set(['eq', 'neq', 'lt', 'gt', 'lte', 'gte']);

function valueEnv(speck: SpeckNode, lines: string[], diagnostics: IRDiagnostic[]): ExprEnv {
  const scope = new Set<string>(EXPR_BUILTINS);
  scope.add('this');
  const types = new Map<string, ValueKind>();
  const constants = new Map<string, number>();
  let stageVar: string | undefined;
  const stageValues = new Set<number>();
  const stageLabels: { name: string; value: number }[] = [];
  for (const m of speck.members) {
    if (m.type === 'state') {
      for (const v of (m as StateNode).variables) {
        scope.add(v.name);
        const kind = primitiveKind(v.typeExpr);
        if (kind) types.set(v.name, kind);
      }
    } else if (m.type === 'invariant') {
      scope.add((m as InvariantMemberNode).name);
    } else if (m.type === 'interface') {
      const iface = m as InterfaceNode;
      const enumLike = iface.kind === 'enum' || (iface.methods.length > 0 && iface.fields.length === 0 && iface.methods.every(method => method.params.length === 0));
      if (enumLike) for (const method of iface.methods) scope.add(method.name);
    }
  }
  // After state, so a variable keeps its declared type if a label reuses the name.
  for (const m of speck.members) {
    if (m.type !== 'agent') continue;
    const agent = m as AgentMemberNode;
    if (!agent.stages) continue;
    stageVar = agent.stages.variable;
    for (const label of agent.stages.labels) {
      scope.add(label.name);
      stageValues.add(label.value);
      stageLabels.push({ name: label.name, value: label.value });
      if (!types.has(label.name)) {
        types.set(label.name, 'nat');
        constants.set(label.name, label.value);
      }
    }
  }
  for (const variant of unionVariants(lines)) scope.add(variant);
  return {
    scope, types, constants, stageVar, stageValues, stageLabels,
    diagnostics, speckName: speck.name, lines, seen: new Set(),
  };
}

function unionVariants(lines: string[]): string[] {
  const names: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const match = /^type\s+\w+\s*=\s*([A-Za-z_]\w*(?:\s*\|\s*[A-Za-z_]\w*)+)\s*$/.exec(line);
    if (!match) continue;
    for (const part of match[1].split('|')) {
      const name = part.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function primitiveKind(t: TypeExpr | undefined): ValueKind | undefined {
  if (!t || (t.type !== 'primitive' && t.type !== 'ident')) return undefined;
  if (t.name === 'Bool' || t.name === 'Boolean') return 'bool';
  if (t.name === 'Nat') return 'nat';
  if (t.name === 'Int') return 'int';
  if (t.name === 'Real') return 'real';
  if (t.name === 'String') return 'string';
  return undefined;
}

function lineOfBinding(lines: string[], name: string, start?: number, end?: number): number | undefined {
  const from = start ? start - 1 : 0;
  const to = end ?? lines.length;
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  for (let i = from; i < to && i < lines.length; i++) {
    if (re.test(lines[i]) && lines[i].includes(':=')) return i + 1;
  }
  return start;
}

function checkBinding(name: string, src: string, env: ExprEnv, line?: number): void {
  if (!env.scope.has(name)) reportUndeclared(env, name, line);
  let parsed: Expr;
  try {
    parsed = parseExpressionComplete(src);
  } catch {
    return;
  }
  const saved = env.line;
  env.line = line;
  checkExpr(parsed, env);
  checkAssignLiteral(env, name, parsed, line);
  env.line = saved;
}

function checkSourceExpr(src: string, env: ExprEnv): void {
  let parsed: Expr;
  try {
    parsed = parseExpressionComplete(src);
  } catch {
    return;
  }
  checkExpr(parsed, env);
}

function reportUndeclared(env: ExprEnv, name: string, line?: number): void {
  const at = locateName(env.lines, line ?? env.line, name);
  const key = `undeclared|${name}|${at.line ?? ''}|${at.column ?? ''}`;
  if (env.seen.has(key)) return;
  env.seen.add(key);
  env.diagnostics.push({
    level: 'error',
    message: `undeclared variable "${name}"`,
    line: at.line,
    column: at.column,
    speck: env.speckName,
  });
}

/** A token between two source lines (inclusive, 1-based), or the start line. */
function locateInRange(
  lines: string[],
  start: number | undefined,
  end: number | undefined,
  name?: string,
): { line?: number; column?: number } {
  if (!start) return {};
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length, end ?? lines.length);
  if (name) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    for (let i = from; i < to; i++) {
      const match = re.exec(lines[i] ?? '');
      if (match) return { line: i + 1, column: match.index + 1 };
    }
  }
  return locateName(lines, start, undefined);
}

function locateName(lines: string[], line: number | undefined, name: string | undefined): { line?: number; column?: number } {
  if (!line) return {};
  if (name) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    const last = Math.min(lines.length, line + 12);
    for (let i = line - 1; i < last; i++) {
      if (i < 0) continue;
      const match = re.exec(lines[i] ?? '');
      if (match) return { line: i + 1, column: match.index + 1 };
    }
  }
  const text = lines[line - 1] ?? '';
  const word = /\S/.exec(text);
  return { line, column: word ? word.index + 1 : 1 };
}

interface LiteralSide {
  kind: ValueKind;
  /** True when this side is a written literal, not a named variable. */
  literal: boolean;
  /** True when the literal is a negative number. */
  negative: boolean;
  name?: string;
}

function literalSide(e: Expr, types: Map<string, ValueKind>): LiteralSide | undefined {
  if (e.kind === 'parens') return literalSide(e.expr, types);
  if (e.kind === 'unary' && e.op === 'neg' && e.operand.kind === 'literal' && e.operand.type === 'number') {
    const n = Number(e.operand.value);
    if (!Number.isFinite(n)) return undefined;
    return { kind: Number.isInteger(n) ? 'int' : 'real', literal: true, negative: true };
  }
  if (e.kind === 'literal') {
    if (e.type === 'bool') return { kind: 'bool', literal: true, negative: false };
    if (e.type === 'string') return { kind: 'string', literal: true, negative: false };
    if (e.type === 'number') {
      const n = Number(e.value);
      if (!Number.isFinite(n)) return undefined;
      if (!Number.isInteger(n)) return { kind: 'real', literal: true, negative: n < 0 };
      if (n < 0) return { kind: 'int', literal: true, negative: true };
      return { kind: 'nat', literal: true, negative: false };
    }
    return undefined;
  }
  if (e.kind === 'ident') {
    const kind = types.get(e.name);
    if (!kind) return undefined;
    return { kind, literal: false, negative: false, name: e.name };
  }
  return undefined;
}

function kindsClash(left: LiteralSide, right: LiteralSide): boolean {
  if (left.kind === 'bool' || right.kind === 'bool') return left.kind !== right.kind;
  if (left.kind === 'string' || right.kind === 'string') return left.kind !== right.kind;
  if (left.kind === 'nat' && right.negative) return true;
  if (right.kind === 'nat' && left.negative) return true;
  if ((left.kind === 'nat' || left.kind === 'int') && right.kind === 'real' && right.literal) return true;
  if ((right.kind === 'nat' || right.kind === 'int') && left.kind === 'real' && left.literal) return true;
  return false;
}

function describeFocus(e: Expr): string | undefined {
  if (e.kind === 'parens') return describeFocus(e.expr);
  if (e.kind === 'ident') return e.name;
  return undefined;
}

function describeSide(side: LiteralSide): string {
  if (side.negative) return 'a negative number';
  if (side.kind === 'bool') return side.name ? `Bool variable "${side.name}"` : 'a boolean';
  if (side.kind === 'string') return side.name ? `String variable "${side.name}"` : 'a string';
  if (side.kind === 'real' && side.literal) return 'a non-integer number';
  if (side.name) {
    const label = side.kind === 'nat' ? 'Nat' : side.kind === 'int' ? 'Int' : side.kind === 'real' ? 'Real' : side.kind;
    return `${label} variable "${side.name}"`;
  }
  return 'a number';
}

function kindLabel(kind: ValueKind): string {
  if (kind === 'nat') return 'Nat';
  if (kind === 'int') return 'Int';
  if (kind === 'real') return 'Real';
  if (kind === 'bool') return 'Bool';
  return 'String';
}

/** A computed right-hand side names the expression and the value that widened it. */
function describeAssigned(expr: Expr, got: LiteralSide, types: Map<string, ValueKind>): string {
  if (got.negative || got.literal || got.name) return describeSide(got);
  const src = expr.kind === 'parens' ? exprToSource(expr.expr) : exprToSource(expr);
  const notes: string[] = [];
  const seen = new Set<string>();
  const walk = (e: Expr): void => {
    if (e.kind === 'ident') {
      const k = types.get(e.name);
      if (k === got.kind && !seen.has(e.name)) {
        seen.add(e.name);
        notes.push(`${e.name} is ${kindLabel(k)}`);
      }
      return;
    }
    if (e.kind === 'parens') walk(e.expr);
    else if (e.kind === 'unary') walk(e.operand);
    else if (e.kind === 'binary') {
      walk(e.left);
      walk(e.right);
    }
  };
  walk(expr);
  const detail = notes.length > 0 ? `${src}; ${notes.join(', ')}` : src;
  return `${kindLabel(got.kind)} expression (${detail})`;
}

function numericKind(kind: ValueKind): boolean {
  return kind === 'nat' || kind === 'int' || kind === 'real';
}

/**
 * Nat accepts Nat only. Int accepts Int and Nat. Real accepts Real, Int, and
 * Nat. Bool and String accept only themselves. A negative or fractional
 * literal is not a Nat.
 */
function assignable(dest: ValueKind, src: LiteralSide): boolean {
  if (src.negative && dest === 'nat') return false;
  if (src.literal && src.kind === 'real' && (dest === 'nat' || dest === 'int')) return false;
  if (dest === src.kind) return true;
  if (dest === 'int' && src.kind === 'nat') return true;
  if (dest === 'real' && numericKind(src.kind)) return true;
  return false;
}

function checkAssignLiteral(env: ExprEnv, name: string, expr: Expr, line?: number): void {
  const expected = env.types.get(name);
  const got = literalSide(expr, env.types) ?? sideFromKind(expr, env.types);
  if (expected && got && !assignable(expected, got)) {
    const dest: LiteralSide = { kind: expected, literal: false, negative: false, name };
    const message = `type mismatch: cannot assign ${describeAssigned(expr, got, env.types)} to ${describeSide(dest)}`;
    pushTypeError(env, message, line, name);
  }
  checkStageLiteral(env, name, expr, line);
}

function sideFromKind(expr: Expr, types: Map<string, ValueKind>): LiteralSide | undefined {
  const kind = valueKind(expr, types);
  if (!kind) return undefined;
  if (expr.kind === 'ident') return { kind, literal: false, negative: false, name: expr.name };
  if (expr.kind === 'parens') return sideFromKind(expr.expr, types);
  return { kind, literal: false, negative: false };
}

function literalInt(expr: Expr): number | undefined {
  if (expr.kind === 'parens') return literalInt(expr.expr);
  if (expr.kind === 'literal' && expr.type === 'number') {
    const n = Number(expr.value);
    return Number.isInteger(n) ? n : undefined;
  }
  if (expr.kind === 'unary' && expr.op === 'neg' && expr.operand.kind === 'literal' && expr.operand.type === 'number') {
    const n = Number(expr.operand.value);
    return Number.isInteger(n) ? -n : undefined;
  }
  return undefined;
}

function checkStageLiteral(env: ExprEnv, name: string, expr: Expr, line?: number): void {
  if (!env.stageVar || name !== env.stageVar || !env.stageValues || env.stageValues.size === 0) return;
  const n = literalInt(expr);
  if (n === undefined || env.stageValues.has(n)) return;
  const labels = (env.stageLabels ?? []).map((l) => `${l.name} = ${l.value}`).join(', ');
  pushTypeError(env, `stage value ${n} is not a declared stage (${labels})`, line, name);
}

function pushTypeError(env: ExprEnv, message: string, line: number | undefined, focus?: string): void {
  const at = locateName(env.lines, line ?? env.line, focus);
  const key = `${message}|${at.line ?? ''}`;
  if (env.seen.has(key)) return;
  env.seen.add(key);
  env.diagnostics.push({
    level: 'error',
    message,
    line: at.line,
    column: at.column,
    speck: env.speckName,
  });
}

function checkBoolExpr(env: ExprEnv, expr: Expr, line: number | undefined, keyword: string): void {
  const kind = valueKind(expr, env.types);
  if (!kind || kind === 'bool') return;
  pushTypeError(env, `type mismatch: ${keyword} expects a Bool, got ${describeKind(kind, expr)}`, line, keyword);
}

function describeKind(kind: ValueKind, expr: Expr): string {
  if (expr.kind === 'ident') {
    const label = kind === 'nat' ? 'Nat' : kind === 'int' ? 'Int' : kind === 'real' ? 'Real' : kind === 'bool' ? 'Bool' : 'String';
    return `${label} variable "${expr.name}"`;
  }
  if (expr.kind === 'parens') return describeKind(kind, expr.expr);
  if (kind === 'bool') return 'a boolean';
  if (kind === 'string') return 'a string';
  if (kind === 'nat') return 'a Nat';
  if (kind === 'int') return 'an Int';
  return 'a Real';
}

/** Type of an expression built from declared names and literals. Unknown shapes are skipped. */
function valueKind(e: Expr, types: Map<string, ValueKind>): ValueKind | undefined {
  if (e.kind === 'parens') return valueKind(e.expr, types);
  const side = literalSide(e, types);
  if (side) return side.kind;
  if (e.kind === 'unary' && e.op === 'not') {
    return valueKind(e.operand, types) === 'bool' ? 'bool' : undefined;
  }
  if (e.kind === 'unary' && e.op === 'neg') {
    const k = valueKind(e.operand, types);
    if (k === 'real') return 'real';
    if (k === 'nat' || k === 'int') return 'int';
    return undefined;
  }
  if (e.kind !== 'binary') return undefined;
  const left = valueKind(e.left, types);
  const right = valueKind(e.right, types);
  if (!left || !right) return undefined;
  if (COMPARE_OPS.has(e.op)) {
    const ls = literalSide(e.left, types);
    const rs = literalSide(e.right, types);
    if (ls && rs && kindsClash(ls, rs)) return undefined;
    if ((left === 'bool') !== (right === 'bool')) return undefined;
    if ((left === 'string') !== (right === 'string')) return undefined;
    if ((numericKind(left) && !numericKind(right)) || (!numericKind(left) && numericKind(right))) return undefined;
    return 'bool';
  }
  if (e.op === 'and' || e.op === 'or' || e.op === 'implies') {
    return left === 'bool' && right === 'bool' ? 'bool' : undefined;
  }
  if (e.op === 'add' && left === 'string' && right === 'string') return 'string';
  if ((e.op === 'add' || e.op === 'sub' || e.op === 'mul' || e.op === 'div' || e.op === 'mod') && numericKind(left) && numericKind(right)) {
    if (left === 'real' || right === 'real') return 'real';
    if (left === 'int' || right === 'int') return 'int';
    return 'nat';
  }
  return undefined;
}

function checkExpr(e: Expr | undefined, env: ExprEnv): void {
  if (!e) return;
  switch (e.kind) {
    case 'literal':
      return;
    case 'unparsed':
      reportUnexpected(env, e);
      return;
    case 'ident':
      if (!env.scope.has(e.name) && !EXPR_BUILTINS.has(e.name)) reportUndeclared(env, e.name, env.line);
      return;
    case 'unary':
      checkExpr(e.operand, env);
      if (e.op === 'not') {
        const kind = valueKind(e.operand, env.types);
        if (kind && kind !== 'bool') {
          pushTypeError(env, `type mismatch: not expects a Bool, got ${describeKind(kind, e.operand)}`, env.line, describeFocus(e.operand));
        }
      }
      return;
    case 'binary': {
      checkExpr(e.left, env);
      checkExpr(e.right, env);
      const leftKind = valueKind(e.left, env.types);
      const rightKind = valueKind(e.right, env.types);
      if (COMPARE_OPS.has(e.op)) {
        const left = literalSide(e.left, env.types);
        const right = literalSide(e.right, env.types);
        if (!left || !right || !kindsClash(left, right)) return;
        const focus = left.name ?? right.name;
        pushTypeError(env, `type mismatch: cannot compare ${describeSide(left)} with ${describeSide(right)}`, env.line, focus);
        return;
      }
      if ((e.op === 'and' || e.op === 'or' || e.op === 'implies') && leftKind && rightKind) {
        if (leftKind !== 'bool') pushTypeError(env, `type mismatch: ${e.op} expects a Bool, got ${describeKind(leftKind, e.left)}`, env.line, describeFocus(e.left));
        if (rightKind !== 'bool') pushTypeError(env, `type mismatch: ${e.op} expects a Bool, got ${describeKind(rightKind, e.right)}`, env.line, describeFocus(e.right));
        return;
      }
      if ((e.op === 'add' || e.op === 'sub' || e.op === 'mul' || e.op === 'div' || e.op === 'mod') && leftKind && rightKind) {
        const concat = e.op === 'add' && leftKind === 'string' && rightKind === 'string';
        const numeric = numericKind(leftKind) && numericKind(rightKind);
        if (!concat && !numeric) {
          pushTypeError(
            env,
            `type mismatch: arithmetic only applies to numbers (got ${describeKind(leftKind, e.left)} and ${describeKind(rightKind, e.right)})`,
            env.line,
            describeFocus(e.left) ?? describeFocus(e.right),
          );
        }
      }
      return;
    }
    case 'call':
      if (e.token?.value !== '.' && !env.scope.has(e.callee) && !EXPR_BUILTINS.has(e.callee)) {
        reportUndeclared(env, e.callee, env.line);
      }
      for (const arg of e.args) checkExpr(arg, env);
      return;
    case 'member':
      checkExpr(e.object, env);
      return;
    case 'index':
      checkExpr(e.object, env);
      checkExpr(e.index, env);
      return;
    case 'parens':
      checkExpr(e.expr, env);
      return;
    case 'if':
      checkExpr(e.condition, env);
      checkExpr(e.thenBranch, env);
      checkExpr(e.elseBranch ?? undefined, env);
      return;
    case 'object':
      if (e.spread) checkExpr(e.spread, env);
      for (const field of e.fields) checkExpr(field.value, env);
      return;
    case 'set':
      for (const el of e.elements) checkExpr(el, env);
      return;
    case 'map':
      for (const entry of e.entries) {
        checkExpr(entry.key, env);
        checkExpr(entry.value, env);
      }
      return;
    case 'range':
      checkExpr(e.end, env);
      return;
    default:
      return;
  }
}

const BUILTIN_TYPES = ['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes', 'Void'];
const GENERIC_WRAPPER = /^(Option|Maybe|Result)\(([\s\S]*)\)$/;

function declaredTypeNames(ast: AST, source: string): Set<string> {
  const names = new Set<string>(BUILTIN_TYPES);
  for (const speck of ast.specks) {
    for (const m of speck.members) {
      if (m.type === 'interface' || m.type === 'event' || m.type === 'oneof' || m.type === 'service') {
        const name = (m as { name?: string }).name;
        if (name) names.add(name);
      }
    }
  }
  for (const match of source.matchAll(/^\s*(?:type|interface|event|oneof|service)\s+([A-Za-z_]\w*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

function reportUnknownTypes(
  speck: SpeckNode,
  source: string,
  known: Set<string>,
  diagnostics: IRDiagnostic[],
): void {
  const seen = new Set<string>();
  const report = (typeName: string, field?: string, suggestion?: string) => {
    const line = field ? lineOfFieldType(source, field, typeName) : lineOfType(source, typeName);
    const key = `${typeName}|${line ?? ''}|${field ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hint = suggestion ? ` Did you mean \`${suggestion}\`?` : '';
    const column = line ? columnOfType(source, line, typeName) : undefined;
    diagnostics.push({
      level: 'error',
      message: `unknown type "${typeName}".${hint}`,
      line,
      column,
      speck: speck.name,
    });
  };
  const walk = (t: TypeExpr | undefined, field?: string) => {
    if (!t) return;
    if ((t.type === 'ident' || t.type === 'primitive') && t.name) {
      checkTypeName(t.name, known, (n, suggestion) => report(n, field, suggestion));
    }
    if (t.type === 'list' || t.type === 'set') walk(t.elementType, field);
    if (t.type === 'map') {
      walk(t.keyType, field);
      walk(t.valueType, field);
    }
    if (t.type === 'record') {
      for (const f of t.fields ?? []) walk(f.type, f.name);
    }
  };

  for (const m of speck.members) {
    if (m.type === 'state') {
      for (const v of (m as StateNode).variables) walk(v.typeExpr, v.name);
    } else if (m.type === 'action') {
      for (const p of (m as ActionNode).params) walk(p.type, p.name);
    } else if (m.type === 'event') {
      for (const f of (m as EventNode).fields) walk(f.type, f.name);
    } else if (m.type === 'interface') {
      const iface = m as InterfaceNode;
      for (const f of iface.fields ?? []) walk(f.type, f.name);
      for (const method of iface.methods ?? []) {
        walk(method.returnType, method.name);
        for (const p of method.params ?? []) walk(p.type, p.name);
      }
    } else if (m.type === 'oneof') {
      for (const v of (m as OneofNode).variants) {
        if (v.typeName) checkTypeName(v.typeName, known, (n, suggestion) => report(n, v.fieldName, suggestion));
      }
    } else if (m.type === 'transition') {
      for (const f of (m as TransitionNode).fields) walk(f.type, f.name);
    }
  }
}

function checkTypeName(name: string, known: Set<string>, report: (name: string, suggestion?: string) => void): void {
  const generic = GENERIC_WRAPPER.exec(name);
  if (generic) {
    for (const part of splitTypeArgs(generic[2])) checkTypeName(part, known, report);
    return;
  }
  if (known.has(name)) return;
  // A type is a builtin, or a name introduced by `type`, `interface`, `event`,
  // `oneof`, or `service`. `Boolean` is the usual misspelling of `Bool`.
  if (!/^[A-Za-z_]\w*$/.test(name)) return;
  const alias = name === 'Boolean' || name === 'boolean' ? 'Bool' : undefined;
  if (alias && known.has(alias)) {
    report(name, alias);
    return;
  }
  report(name, suggestKnownType(name, known));
}

function suggestKnownType(name: string, known: Set<string>): string | undefined {
  let best: { n: string; d: number } | undefined;
  for (const candidate of known) {
    if (!/^[A-Za-z_]\w*$/.test(candidate)) continue;
    const d = typeEditDistance(name, candidate);
    if (d === 0) continue;
    const limit = Math.max(name.length, candidate.length) >= 6 ? 2 : 1;
    if (d <= limit && (!best || d < best.d)) best = { n: candidate, d };
  }
  return best?.n;
}

function typeEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    let rowMin = next[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
      if (next[j] < rowMin) rowMin = next[j];
    }
    if (rowMin > 2) return 3;
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

function splitTypeArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '<' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function lineOfFieldType(source: string, field: string, typeName: string): number | undefined {
  const lines = source.split('\n');
  const re = new RegExp(`\\b${escapeRegExp(field)}\\b[^\\n]*\\b${escapeRegExp(typeName)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return lineOfType(source, typeName);
}

function columnOfType(source: string, line: number, typeName: string): number | undefined {
  const text = source.split('\n')[line - 1] ?? '';
  const at = text.indexOf(typeName);
  return at >= 0 ? at + 1 : undefined;
}

function reportUnexpected(env: ExprEnv, expr: Expr): void {
  const hex = /Unexpected character U\+([0-9A-F]+)/i.exec(expr.kind === 'unparsed' ? (expr.error ?? '') : '');
  if (!hex) return;
  const glyph = String.fromCodePoint(parseInt(hex[1], 16));
  const line = env.line;
  let column: number | undefined;
  if (line) {
    const at = (env.lines[line - 1] ?? '').indexOf(glyph);
    if (at >= 0) column = at + 1;
  }
  const message = `unexpected character U+${hex[1].toUpperCase()}`;
  const key = `${message}|${line ?? ''}|${column ?? ''}`;
  if (env.seen.has(key)) return;
  env.seen.add(key);
  env.diagnostics.push({ level: 'error', message, line, column, speck: env.speckName });
}

function lineOfType(source: string, typeName: string): number | undefined {
  const lines = source.split('\n');
  const re = new RegExp(`\\b${escapeRegExp(typeName)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────
// Expression lower (Expr → IRExpr)
// ─────────────────────────────────────────────────────────────────────

function lowerExpr(
  e: Expr | undefined,
  diagnostics: IRDiagnostic[],
  speckName: string,
  constants?: ReadonlyMap<string, number>,
): IRExpr {
  const go = (inner: Expr | undefined) => lowerExpr(inner, diagnostics, speckName, constants);
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
    case 'ident': {
      const value = constants?.get(e.name);
      if (value !== undefined) return { kind: 'int_lit', value };
      return { kind: 'ident', name: e.name };
    }
    case 'unary':
      return {
        kind: 'unop',
        op: e.op === 'not' ? '!' : '-',
        operand: go(e.operand),
      };
    case 'binary':
      // Infix `a implies b` lowers to the same node as the call form
      // `implies(a, b)`, which the IR backends already understand.
      if (e.op === 'implies') {
        return {
          kind: 'call',
          fn: 'implies',
          args: [go(e.left), go(e.right)],
        };
      }
      return {
        kind: 'binop',
        op: lowerBinOp(e.op),
        left: go(e.left),
        right: go(e.right),
      };
    case 'call':
      return {
        kind: 'call',
        fn: e.callee,
        args: e.args.map(a => go(a)),
      };
    case 'member':
      return {
        kind: 'field',
        target: go(e.object),
        field: e.property,
      };
    case 'index':
      return {
        kind: 'index',
        target: go(e.object),
        index: go(e.index),
      };
    case 'parens':
      // Parenthesized grouping - transparent in the IR.
      return go(e.expr);
    case 'unparsed':
      if (!/Unexpected character U\+/.test(e.error ?? '')) {
        diagnostics.push({
          level: 'warning',
          message: `expression not parsed in full (${e.error}); carried as an untranslated placeholder: ${e.source}`,
          speck: speckName,
        });
      }
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
  constants?: ReadonlyMap<string, number>,
): IRExpr {
  // The whole string must parse; a prefix parse used to drop the tail
  // silently (`P implies Q` read as `P`, `forall x in c: body` as `forall`).
  try {
    const parsed = parseExpressionComplete(src);
    return lowerExpr(parsed, diagnostics, speckName, constants);
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
