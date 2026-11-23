// n8n.ts — n8n workflow target.
// `n8n import:workflow` accepts this JSON. The test is
// `imports every generated example workflow with n8n import:workflow`
// in compiler/src/__tests__/n8n-live.test.ts.
//
// `speckl <file> -t n8n` writes <outputDir>/n8n/<Speck>.workflow.json,
// <Speck>.verify.mjs, and n8n/README.md.
//
// The workflow is standard n8n import JSON. Node ids and positions come from
// the speck, so a second compile into another directory is byte-identical.
// No clock, no random id, and no host path is written.
//
// An `agent { await }` block becomes one webhook Wait node, a Resume code
// node, and an If gate. The Wait's Limit Wait Time is the timeout. There is
// no second timer. The live runs are
// `posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit`,
// `posts reject and the run ends at Stop and Error`, and
// `a short timeout ends at Stop and Error`.
// A posted approve arrives at body, Resume keeps the pre-wait fields, and
// the run stays successful after the Wait limit. A reject and a timeout
// both end at Stop and Error. A timeout resumes with the pre-wait item,
// which has no webhook headers, so body is empty. The If reads
// $json.body.outcome. Outcomes marked `!` connect only to Stop and Error.
// A reject target that the spec sends back to an earlier stage still stops
// here. The workflow does not loop.
//
// An expression this file cannot translate fails the compile. No n8n file
// is written. `oneof` and `transition` are rejected by the conservation
// table before any file is written.
//
// The verify script is a straight-line trace check. It does not run n8n.
// It is not a model check. It does not check signal signatures or
// `bind call` digests.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardAst, guardIr } from '../conservation.js';
import { parseStringToIRExpr } from '../ir/lower.js';
import type { AST, InvariantMemberNode } from '../parser.js';
import type {
  IR,
  IRAction,
  IRAgentAwait,
  IRExpr,
  IRSpeck,
  IRStmt,
  IRVerify,
} from '../ir/types.js';

export const N8N_DISCLAIMER = 'Not for regulated data without your own review';

/** Raised when an expression cannot be translated. No n8n file has been written. */
export class N8nTranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'N8nTranslateError';
  }
}

const DISCLAIMER_NOTE = [
  'Not for regulated data without your own review.',
  'Speckl compiled this workflow as a general-purpose tool. It is not HIPAA-certified. You are responsible for your own compliance review.',
  'This output does not guarantee zero data retention (ZDR).',
].join('\n');

/** Patterns that must never appear in emitted files. The scan runs before write. */
const SECRET_RES: readonly RegExp[] = [
  /sk-[A-Za-z0-9]/,
  /ghp_/,
  /xoxb-/,
  /xoxp-/,
  /xoxa-/,
  /Bearer /,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

export interface N8nOptions {
  outputDir: string;
  /** Supplies invariant blocks, which the IR does not carry yet. */
  ast?: AST;
}

interface Step {
  op: 'require' | 'post' | 'assign' | 'let' | 'emit' | 'return';
  js?: string;
  target?: string;
  name?: string;
  event?: string;
  fields?: { name: string; js: string }[];
}

interface Check {
  name: string;
  js: string | null;
}

interface ActionModel {
  name: string;
  steps: Step[] | null;
  stages: number[];
  index: number;
}

interface AcceptOutcome {
  outcome: string;
  stage: number;
}

/**
 * Named transitions, compiled. An await whose accepting outcomes route to
 * distinct stage values does not run one shared post chain: each landing
 * stage gets its own Stage node and its own sub-chain of actions, ordered
 * by stage value, ending at Done. Actions with no stage require are
 * stage-agnostic and run on every branch. Single-landing-stage awaits
 * keep the shared chain emit; that shape has always compiled.
 */
interface Landing {
  stage: number;
  branch: ActionModel[];
}

interface GateModel {
  signal: string;
  state: string;
  wait: string;
  resume: string;
  /** Node whose item is the state before this Wait. Resume reads it back. */
  prior: string;
  gate: string;
  stop: string;
  limit: { amount: number; unit: 'days' | 'hours' | 'minutes' | 'seconds' };
  acceptStages: number[];
  rejectStages: number[];
  acceptOutcomes: AcceptOutcome[];
}

interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
}

interface Workflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }>;
  settings: { executionOrder: 'v1' };
  pinData: Record<string, never>;
  meta: { templateCredsSetupCompleted: false };
  active: false;
}

interface Ctx {
  labels: Map<string, number>;
  locals: Set<string>;
}

export function generateN8n(ir: IR, options: N8nOptions): void {
  if (options.ast) guardAst('n8n', options.ast);
  else guardIr('n8n', ir);

  const agentErrors = ir.diagnostics.filter(d => d.level === 'error' && d.message.startsWith('agent'));
  if (agentErrors.length > 0) {
    throw new Error('n8n backend: agent block is invalid:\n' + agentErrors.map(d => d.message).join('\n'));
  }

  for (const speck of ir.specks) {
    const types = speck.sourceMemberTypes;
    if (!types) {
      throw new Error(`n8n backend cannot check member types: sourceMemberTypes is missing on speck "${speck.name}"`);
    }
    if (types.includes('invariant') && !options.ast) {
      throw new Error(`n8n backend: invariant members on "${speck.name}" require the AST so a guard is not dropped`);
    }
  }

  const readmeSpecs: string[] = [];
  const allFiles: { rel: string; text: string; stageVar: string | null }[] = [];
  for (const speck of ir.specks) {
    const built = buildSpeck(speck, options.ast);
    allFiles.push({ rel: `${speck.name}.workflow.json`, text: built.workflow, stageVar: built.stageVar });
    allFiles.push({ rel: `${speck.name}.verify.mjs`, text: built.script, stageVar: null });
    readmeSpecs.push(speck.name);
  }
  allFiles.push({ rel: 'README.md', text: renderReadme(readmeSpecs), stageVar: null });

  for (const file of allFiles) {
    assertNoSecrets(file.text);
    if (file.rel.endsWith('.workflow.json') && file.stageVar) assertNoInjectedExpressions(file.text, file.stageVar);
  }

  const dir = path.join(options.outputDir, 'n8n');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of allFiles) {
    const dest = path.join(dir, file.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.text);
    console.log(`Generated n8n ${file.rel}`);
  }
}

function assertNoSecrets(text: string): void {
  for (const re of SECRET_RES) {
    if (re.test(text)) {
      throw new N8nTranslateError('n8n backend: refused to emit output that matched a secret pattern');
    }
  }
}

/**
 * The one parameter that is an n8n expression on purpose. The If node reads
 * the posted JSON. n8n's webhook resume puts that JSON at `$json.body`.
 */
export const ALLOWED_N8N_EXPR = '={{ $json.body.outcome }}';

/**
 * The one other expression this target emits, and only on a named fan-out.
 * A landing If reads the stage value the Stage node wrote. The stage
 * variable name is compiler-validated (it is a state field, checked at
 * parse time), and the number is a literal from the spec's own stage
 * labels. This expression never carries spec text.
 */
export function landingExpr(stageVar: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(stageVar)) {
    throw new N8nTranslateError(`n8n backend: stage variable ${JSON.stringify(stageVar)} cannot be read by a landing If`);
  }
  return `={{ $json.${stageVar} }}`;
}

function assertNoInjectedExpressions(workflowText: string, stageVar: string | null): void {
  const rest = workflowText
    .split(ALLOWED_N8N_EXPR).join('')
    .split(stageVar === null ? '' : landingExpr(stageVar)).join('');
  if (rest.includes('{{') || rest.includes('}}')) {
    throw new N8nTranslateError('n8n backend: refused to emit an n8n expression from spec text; refusing to write a partial workflow');
  }
}

/**
 * n8n evaluates a parameter that starts with `=` and evaluates `{{` `}}`
 * inside a parameter. Every string except ALLOWED_N8N_EXPR must be data.
 */
export function assertSafeN8nText(value: string, slot: string, stageVar: string | null = null): void {
  if (value === ALLOWED_N8N_EXPR) return;
  if (stageVar !== null && value === landingExpr(stageVar)) return;
  if (value.startsWith('=') || value.includes('{{') || value.includes('}}')) {
    throw new N8nTranslateError(
      `n8n backend: parameter ${slot} would be an n8n expression; refusing to write a partial workflow`,
    );
  }
}

function assertSafeValue(value: unknown, slot: string, stageVar: string | null = null): void {
  if (typeof value === 'string') {
    assertSafeN8nText(value, slot, stageVar);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${slot}[${index}]`, stageVar));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertSafeValue(child, `${slot}.${key}`, stageVar);
  }
}

/** A JS string literal. `{{` and `}}` are unicode escapes so n8n does not evaluate them. */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/\{\{/g, '\\u007b\\u007b').replace(/\}\}/g, '\\u007d\\u007d');
}

function buildSpeck(speck: IRSpeck, ast: AST | undefined): { workflow: string; script: string; stageVar: string | null } {
  const behavior = speck.facets.behavior;
  for (const field of behavior.stateVars) {
    if (field.name === 'headers') {
      throw new N8nTranslateError(
        `n8n backend: state field "headers" on ${speck.name} would be read as a webhook item; refusing to write a partial workflow`,
      );
    }
  }
  const agent = behavior.agent;
  const awaits = agent?.awaits ?? [];
  const labels = new Map<string, number>();
  for (const label of agent?.stages?.labels ?? []) labels.set(label.name, label.value);
  const stageVar = agent?.stages?.variable ?? null;
  if (awaits.length > 0 && !stageVar) {
    throw new Error(`n8n backend: ${speck.name} has an await and no stages variable`);
  }
  for (const aw of awaits) assertAwaitSafe(speck.name, aw);

  const ctx = (): Ctx => ({ labels, locals: new Set() });
  const invariantChecks: Check[] = invariantsOf(ast, speck.name).map(inv => ({
    name: inv.name,
    js: translate(parseStringToIRExpr(inv.expr), ctx()),
  }));
  const constraintChecks: Check[] = speck.facets.formal_spec.constraints.map((c, i) => ({
    name: c.name || `constraint ${i + 1}`,
    js: translate(c.expr, ctx()),
  }));
  const checks = [...invariantChecks, ...constraintChecks];
  const initSteps = stepsFrom(behavior.init.map(a => ({ kind: 'assign' as const, target: a.target, value: a.expr })), ctx());
  const actions: ActionModel[] = behavior.actions.map((action, index) => ({
    name: action.name,
    steps: stepsFrom(action.statements, ctx()),
    stages: stageVar ? stagesOf(action, stageVar, labels) : [],
    index,
  }));

  const approved = new Set<number>();
  const gates: GateModel[] = [];
  const awaitValues: number[] = [];
  for (const aw of awaits) {
    const value = awaitStageValue(aw, labels);
    awaitValues.push(value);
    const rejects = new Set(aw.rejects);
    const acceptStages: number[] = [];
    const rejectStages: number[] = [];
    const acceptOutcomes: AcceptOutcome[] = [];
    for (const outcome of aw.on) {
      const stage = targetStage(aw, outcome.outcome);
      if (rejects.has(outcome.outcome)) rejectStages.push(stage);
      else {
        acceptStages.push(stage);
        acceptOutcomes.push({ outcome: outcome.outcome, stage });
        approved.add(stage);
      }
    }
    const timeout = aw.timeout ? targetStage(aw, aw.timeout.outcome) : null;
    if (timeout !== null && !rejectStages.includes(timeout)) rejectStages.push(timeout);
    gates.push({
      signal: aw.signal,
      state: aw.state,
      wait: '',
      resume: '',
      prior: '',
      gate: '',
      stop: '',
      limit: timeoutAmount(aw.timeout?.durationMs ?? 0),
      acceptStages: uniqueNums(acceptStages),
      rejectStages: uniqueNums(rejectStages),
      acceptOutcomes,
    });
  }
  const firstAwait = awaitValues.length ? Math.min(...awaitValues) : null;
  const pre: ActionModel[] = [];
  const post: ActionModel[] = [];
  for (const action of actions) {
    if (firstAwait !== null && isPost(action.stages, approved, firstAwait)) post.push(action);
    else pre.push(action);
  }
  sortPre(pre);
  post.sort((a, b) => minOr(a.stages) - minOr(b.stages) || a.index - b.index);

  // Every stage-agnostic action runs on each named branch. An action whose
  // stage requires name a landing stage runs on that branch alone. A post
  // action no landing stage names cannot run on any branch and fails the
  // compile where the shared chain would have thrown at run time. The
  // placement guard fires only when the fan-out is real (more than one
  // landing stage): with one landing stage the shared chain keeps the
  // flowing-item semantics the existing examples rely on.
  const landings: Landing[] = [];
  const seenLanded = new Set<number>();
  for (const gate of gates) {
    for (const pair of gate.acceptOutcomes) {
      if (!seenLanded.has(pair.stage)) {
        seenLanded.add(pair.stage);
        landings.push({ stage: pair.stage, branch: [] });
      }
    }
  }
  const branchIssues: string[] = [];
  for (const action of post) {
    if (action.stages.length === 0) {
      for (const landing of landings) landing.branch.push(action);
      continue;
    }
    let placed = false;
    for (const landing of landings) {
      if (action.stages.includes(landing.stage)) {
        landing.branch.push(action);
        placed = true;
      }
    }
    if (!placed) branchIssues.push(`action ${action.name}`);
  }
  if (landings.length > 1 && branchIssues.length > 0) {
    throw new N8nTranslateError(
      `n8n backend: cannot translate ${branchIssues.join(', ')} on ${speck.name}; no accepting outcome routes to a stage its require names, so the action has no named branch`,
    );
  }
  for (const landing of landings) {
    landing.branch.sort((a, b) => minOr(a.stages) - minOr(b.stages) || a.index - b.index);
  }


  const verifies = speck.facets.formal_spec.verifies.map(v => verifyModel(v, new Set(invariantsOf(ast, speck.name).map(i => i.name)), ctx()));
  const problems: string[] = [];
  if (!initSteps) problems.push('init');
  for (const action of actions) if (!action.steps) problems.push(`action ${action.name}`);
  for (const check of invariantChecks) if (!check.js) problems.push(`invariant ${check.name}`);
  for (const check of constraintChecks) if (!check.js) problems.push(`constraint ${check.name}`);
  for (const v of verifies) {
    if (v.kind !== 'always' && v.kind !== 'expr') problems.push(`verify ${v.name}`);
    else if (v.kind === 'expr' && !v.js) problems.push(`verify ${v.name}`);
  }
  if (problems.length > 0) {
    throw new N8nTranslateError(
      `n8n backend: cannot translate ${problems.join(', ')} on ${speck.name}; refusing to write a partial workflow`,
    );
  }

  const names = new Set<string>();
  const claim = (name: string): string => {
    if (names.has(name)) throw new Error(`n8n backend: node name "${name}" is not unique on ${speck.name}`);
    names.add(name);
    return name;
  };
  for (const action of actions) claim(action.name);
  const start = claim('Start');
  const init = claim('Init');
  const disclaimer = claim('Disclaimer');
  const check = claim('Check invariants');
  const done = claim('Done');
  const stage = gates.length ? claim(`Stage ${gates[gates.length - 1].signal}`) : null;
  for (const gate of gates) {
    gate.wait = claim(`Wait ${gate.signal}`);
    gate.resume = claim(`Resume ${gate.signal}`);
    gate.gate = claim(`Gate ${gate.signal}`);
    gate.stop = claim(`Stop ${gate.signal}`);
  }

  const wf = assemble({
    speck,
    awaits,
    start,
    init,
    disclaimer,
    check,
    done,
    stage,
    stageVar,
    gates,
    pre,
    post,
    landings,
    claim,
    checks,
    initSteps,
  });
  assertWorkflow(wf, landings.length > 1 ? stageVar : null);

  const accepting = post.filter(a => a.stages.some(s => approved.has(s))).map(a => a.name);
  const model = {
    speck: speck.name,
    disclaimer: N8N_DISCLAIMER,
    stageVar,
    init: initSteps,
    invariants: invariantChecks.map(c => ({ name: c.name, js: c.js })),
    constraints: constraintChecks.map(c => ({ name: c.name, js: c.js })),
    verifies,
    actions: actions.map(a => ({ name: a.name, steps: a.steps })),
    pre: pre.map(a => a.name),
    post: post.map(a => a.name),
    accepting,
    acceptStages: uniqueNums(gates.flatMap(g => g.acceptStages)),
    rejectStages: uniqueNums(gates.flatMap(g => g.rejectStages)),
    landings: landings.map(l => ({ stage: l.stage, branch: l.branch.map(a => a.name) })),
    gates: gates.map(g => ({
      signal: g.signal,
      wait: g.wait,
      resume: g.resume,
      prior: g.prior,
      gate: g.gate,
      stop: g.stop,
      limitAmount: g.limit.amount,
      limitUnit: g.limit.unit,
    })),
  };
  const script = renderScript(`${speck.name}.workflow.json`, {
    ...model,
    // The landings key exists only when the fan-out is real, so a spec
    // with one landing stage recompiles to the byte-identical script an
    // older n8n generation wrote.
    landings: landings.length > 1 ? model.landings : undefined,
  });
  return {
    workflow: JSON.stringify(wf, null, 2) + '\n',
    script,
    stageVar: landings.length > 1 ? stageVar : null,
  };
}

function assemble(input: {
  speck: IRSpeck;
  awaits: IRAgentAwait[];
  start: string;
  init: string;
  disclaimer: string;
  check: string;
  done: string;
  stage: string | null;
  stageVar: string | null;
  gates: GateModel[];
  pre: ActionModel[];
  post: ActionModel[];
  landings: Landing[];
  claim: (name: string) => string;
  checks: Check[];
  initSteps: Step[] | null;
}): Workflow {
  const nodes: N8nNode[] = [];
  const ids = new Set<string>();
  const connections: Workflow['connections'] = {};  let col = 0;
  const add = (name: string, type: string, typeVersion: number, parameters: Record<string, unknown>, y = 320): void => {
    const position: [number, number] = [240 + col * 280, y];
    col += 1;
    nodes.push({
      parameters,
      id: nodeId(input.speck.name, name, ids),
      name,
      type,
      typeVersion,
      position,
    });
  };
  const addAt = (name: string, type: string, typeVersion: number, parameters: Record<string, unknown>, x: number, y: number): void => {
    nodes.push({
      parameters,
      id: nodeId(input.speck.name, name, ids),
      name,
      type,
      typeVersion,
      position: [x, y],
    });
  };

  addAt(input.disclaimer, 'n8n-nodes-base.stickyNote', 1, {
    content: sticky(input.speck, input.awaits),
    height: 560,
    width: 520,
    color: 4,
  }, 240, 40);
  add(input.start, 'n8n-nodes-base.manualTrigger', 1, {});
  add(input.init, 'n8n-nodes-base.code', 2, codeParams(renderInit(input.initSteps, input.checks)));
  let priorName = input.init;
  for (const action of input.pre) {
    add(action.name, 'n8n-nodes-base.code', 2, codeParams(renderAction(action.name, action.steps, input.checks)));
    priorName = action.name;
  }
  for (const gate of input.gates) {
    gate.prior = priorName;
    const x = 240 + col * 280;
    col += 1;
    addAt(gate.wait, 'n8n-nodes-base.wait', 1.1, {
      resume: 'webhook',
      httpMethod: 'POST',
      incomingAuthentication: 'none',
      limitWaitTime: true,
      limitType: 'afterTimeInterval',
      resumeAmount: gate.limit.amount,
      resumeUnit: gate.limit.unit,
      options: {},
    }, x, 320);
    const rx = 240 + col * 280;
    col += 1;
    addAt(gate.resume, 'n8n-nodes-base.code', 2, codeParams(renderResume(gate.prior)), rx, 320);
    const gx = 240 + col * 280;
    col += 1;
    addAt(gate.gate, 'n8n-nodes-base.if', 2.2, ifParams(gate, input.speck.name, ids), gx, 320);
    addAt(gate.stop, 'n8n-nodes-base.stopAndError', 1, {
      errorMessage: 'Approval was rejected or timed out. This branch stops.',
      options: {},
    }, gx, 560);
    priorName = gate.gate;
  }
  if (input.stage && input.stageVar) {
    const last = input.gates[input.gates.length - 1];
    add(input.stage, 'n8n-nodes-base.code', 2, codeParams(renderStage(input.stageVar, last)));
  }
  add(input.check, 'n8n-nodes-base.code', 2, codeParams(renderCheck(input.checks)));
  for (const action of input.post) {
    add(action.name, 'n8n-nodes-base.code', 2, codeParams(renderAction(action.name, action.steps, input.checks)));
  }
  // Landing Ifs exist only for a named fan-out (more than one landing
  // stage). Each reads the stage the Stage node set and routes that
  // stage's post actions. n8n If nodes take conditions on one node, so
  // one If per landing chained on the false output picks its stage.
  const landingIfs: { stage: number; name: string }[] = [];
  if (multipleLandings(input.landings) && input.stageVar) {
    for (const landing of input.landings) {
      const name = input.claim(`Land ${input.stageVar} ${landing.stage}`);
      landingIfs.push({ stage: landing.stage, name });
      addAt(name, 'n8n-nodes-base.if', 2.2, landParams(input.stageVar, landing, input.speck.name, ids), 240 + landingIfs.length * 280, 560);
    }
  }
  add(input.done, 'n8n-nodes-base.noOp', 1, {});

  const link = (from: string, to: string, output = 0): void => {
    if (!connections[from]) connections[from] = { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  };

  link(input.start, input.init);
  let prev = input.init;
  for (const action of input.pre) {
    link(prev, action.name);
    prev = action.name;
  }
  if (input.gates.length === 0) {
    link(prev, input.check);
  } else {
    link(prev, input.gates[0].wait);
    for (let i = 0; i < input.gates.length; i++) {
      const gate = input.gates[i];
      link(gate.wait, gate.resume);
      link(gate.resume, gate.gate);
      link(gate.gate, gate.stop, 1);
      const next = i + 1 < input.gates.length ? input.gates[i + 1] : null;
      if (gate.acceptOutcomes.length === 0) {
        link(gate.gate, gate.stop, 0);
      } else if (next) {
        link(gate.gate, next.wait, 0);
      } else if (input.stage) {
        link(gate.gate, input.stage, 0);
        link(input.stage, input.check);
      } else {
        link(gate.gate, input.check, 0);
      }
    }
  }
  if (landingIfs.length > 1 && input.stage) {
    // Named fan-out. Stage-agnostic post actions stay on the shared
    // prefix every branch runs: Check, then those actions in order.
    // Then one If per landing stage chained on the false output; true
    // runs that stage's post actions in stage order and ends at Done.
    // The last If's false output ends at Done: no landing names a
    // remaining stage, so nothing stage-keyed may run.
    const shared = input.post.filter(a => a.stages.length === 0).map(a => a.name);
    let sharedPrev: string = input.check;
    for (const name of shared) {
      link(sharedPrev, name);
      sharedPrev = name;
    }
    let ifPrev = sharedPrev;
    for (let i = 0; i < landingIfs.length; i++) {
      const landingIf = landingIfs[i];
      // The false output of the previous landing chains to this one; the
      // first landing is fed by the node before it (Check or the last
      // shared post action).
      link(ifPrev, landingIf.name, i === 0 ? 0 : 1);
      const branch = input.landings.find(l => l.stage === landingIf.stage)!.branch
        .filter(a => a.stages.length > 0).map(a => a.name);
      let bprev = landingIf.name;
      for (const name of branch) {
        link(bprev, name);
        bprev = name;
      }
      link(bprev, input.done);
      ifPrev = landingIf.name;
    }
    link(ifPrev, input.done, 1);
  } else {
    prev = input.check;
    for (const action of input.post) {
      link(prev, action.name);
      prev = action.name;
    }
    link(prev, input.done);
  }

  return {
    name: input.speck.name,
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    active: false,
  };
}

/** True when one fan-out must pick between more than one landing stage. */
function multipleLandings(landings: Landing[]): boolean {
  return landings.length > 1;
}

function landParams(stageVar: string, landing: Landing, speck: string, ids: Set<string>): Record<string, unknown> {
  // The Stage node has already written the landing stage into <stageVar>
  // from the posted outcome, so the landing If reads that state field as
  // literal data. This is data the compiler wrote, not a spec expression.
  return {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: nodeId(speck, `Land ${stageVar} ${landing.stage}`, ids),
          leftValue: landingExpr(stageVar),
          rightValue: landing.stage,
          operator: { type: 'number', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  };
}

function sticky(speck: IRSpeck, awaits: IRAgentAwait[]): string {
  const lines = [DISCLAIMER_NOTE, '', `Spec: ${speck.name}`];
  for (const aw of awaits) {
    const rejects = new Set(aw.rejects);
    const accept = aw.on.filter(o => !rejects.has(o.outcome)).map(o => o.outcome);
    const reject = aw.on.filter(o => rejects.has(o.outcome)).map(o => `${o.outcome}!`);
    lines.push(
      `Await ${aw.state} signal ${aw.signal} mode ${aw.mode}. Accept: ${accept.join(', ') || 'none'}. Reject: ${reject.join(', ') || 'none'}. Timeout: ${aw.timeout ? aw.timeout.durationText + ' -> ' + aw.timeout.outcome : 'none'}.`,
    );
    if (aw.claims.length) lines.push(`Claims: ${aw.claims.map(c => `${c.name}: ${c.typeName}`).join(', ')}.`);
    if (aw.bindCall.length) {
      lines.push('This workflow does not enforce call-digest binding. Sign-off stays a manual step in n8n.');
    }
  }
  lines.push('Post the JSON {"outcome":"<name>"} to the Wait resume URL. The If reads $json.body.outcome.');
  lines.push('An accepting outcome continues. Resume copies the item from before the Wait, so later nodes still have those fields.');
  lines.push('A reject ends at Stop and Error. A timeout ends at Stop and Error. A timeout resumes with the item from before the Wait. That item has no webhook headers, so body is empty and the If takes the false output.');
  lines.push('Limit Wait Time is on that same Wait. There is no second timer node.');
  lines.push('incomingAuthentication is none. This file does not contain a credential. After import, set Authentication on the Wait node to Basic Auth, Header Auth, or JWT Auth and attach a credential you create in n8n.');
  lines.push('A string in the spec is literal data. It is not an n8n env binding.');
  lines.push('A check that fails stops that n8n run. Signal signatures are not checked.');
  lines.push("Speckl's CI tests its bundled examples, not this specific workflow.");
  return lines.join('\n');
}

function renderResume(prior: string): string {
  const quoted = prior.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    `const prior = $('${quoted}').item.json;`,
    'const incoming = $input.item.json;',
    'const webhook = incoming && typeof incoming.headers === "object" && incoming.headers !== null;',
    'const raw = webhook ? incoming.body : undefined;',
    'const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};',
    'const __root__ = {};',
    'for (const key of Object.keys(prior)) __root__[key] = prior[key];',
    '__root__.body = body;',
    '__root__.outcome = Object.prototype.hasOwnProperty.call(body, "outcome") ? body.outcome : undefined;',
    'return __root__;',
  ].join('\n');
}

function codeParams(jsCode: string): Record<string, unknown> {
  return { mode: 'runOnceForEachItem', language: 'javaScript', jsCode };
}

function renderInit(steps: Step[] | null, checks: Check[]): string {
  if (!steps) return `throw new Error(${JSON.stringify('speckl-n8n: untranslated init')});`;
  return renderAction('Init', steps, checks);
}

function renderCheck(checks: Check[]): string {
  return renderAction('Check invariants', [], checks);
}

function renderAction(name: string, steps: Step[] | null, checks: Check[]): string {
  const missing = checks.filter(c => !c.js);
  if (!steps || missing.length > 0) {
    const why = !steps ? `untranslated action ${name}` : `untranslated check ${missing[0].name}`;
    return `throw new Error(${JSON.stringify('speckl-n8n: ' + why)});`;
  }
  const lines = ['const __root__ = $input.item.json;', 'const locals = {};'];
  for (const step of steps) lines.push(renderStep(name, step));
  for (const check of checks) {
    lines.push(`if (!(${check.js})) throw new Error(${JSON.stringify('speckl-n8n: check failed: ' + check.name)});`);
  }
  lines.push('return __root__;');
  return lines.join('\n');
}

function renderStep(action: string, step: Step): string {
  if (step.op === 'require' || step.op === 'post') {
    return `if (!(${step.js})) throw new Error(${JSON.stringify('speckl-n8n: require failed in ' + action)});`;
  }
  if (step.op === 'assign' && step.target && step.js) {
    return `__root__[${JSON.stringify(step.target)}] = (${step.js});`;
  }
  if (step.op === 'let' && step.name && step.js) {
    return `locals[${JSON.stringify(step.name)}] = (${step.js});`;
  }
  if (step.op === 'emit' && step.event && step.fields) {
    const fields = step.fields.map(f => `${JSON.stringify(f.name)}: (${f.js})`).join(', ');
    return `__root__.__events = Array.isArray(__root__.__events) ? __root__.__events : [];\n__root__.__events.push({ event: ${JSON.stringify(step.event)}, fields: { ${fields} } });`;
  }
  if (step.op === 'return' && step.js) {
    return `__root__.__result = (${step.js});`;
  }
  return `throw new Error(${JSON.stringify('speckl-n8n: untranslated action ' + action)});`;
}

function renderStage(stageVar: string, gate: GateModel): string {
  const lines = ['const __root__ = $input.item.json;'];
  const stages = uniqueNums(gate.acceptOutcomes.map(o => o.stage));
  if (stages.length === 1) {
    lines.push(`__root__[${JSON.stringify(stageVar)}] = ${stages[0]};`);
  } else if (gate.acceptOutcomes.length === 0) {
    lines.push(`throw new Error(${JSON.stringify('speckl-n8n: accept outcome was not recognized')});`);
  } else {
    lines.push('const outcome = String(__root__.body && __root__.body.outcome != null ? __root__.body.outcome : "");');
    gate.acceptOutcomes.forEach((pair, i) => {
      const word = i === 0 ? 'if' : 'else if';
      lines.push(`${word} (outcome === ${JSON.stringify(pair.outcome)}) __root__[${JSON.stringify(stageVar)}] = ${pair.stage};`);
    });
    lines.push(`else throw new Error(${JSON.stringify('speckl-n8n: accept outcome was not recognized')});`);
  }
  lines.push('return __root__;');
  return lines.join('\n');
}

function ifParams(gate: GateModel, speck: string, ids: Set<string>): Record<string, unknown> {
  // True only for an accepting outcome. A reject name is not a true condition,
  // so n8n sends it down main[1] to Stop.
  const outcomes = gate.acceptOutcomes.length
    ? gate.acceptOutcomes
    : [{ outcome: '', stage: -1 }];
  const conditions = outcomes.map((pair, i) => ({
    id: nodeId(speck, `${gate.gate} ${pair.outcome || 'none'} ${i}`, ids),
    leftValue: ALLOWED_N8N_EXPR,
    rightValue: pair.outcome,
    operator: { type: 'string', operation: 'equals' },
  }));
  return {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions,
      combinator: conditions.length > 1 ? 'or' : 'and',
    },
    options: {},
  };
}

function timeoutAmount(ms: number): { amount: number; unit: 'days' | 'hours' | 'minutes' | 'seconds' } {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error('n8n backend: timeout duration must be a positive finite number');
  }
  const units: { div: number; unit: 'days' | 'hours' | 'minutes' | 'seconds' }[] = [
    { div: 86_400_000, unit: 'days' },
    { div: 3_600_000, unit: 'hours' },
    { div: 60_000, unit: 'minutes' },
    { div: 1000, unit: 'seconds' },
  ];
  for (const u of units) {
    if (ms % u.div === 0) return { amount: ms / u.div, unit: u.unit };
  }
  return { amount: Math.max(1, Math.round(ms / 1000)), unit: 'seconds' };
}

function assertWorkflow(wf: Workflow, stageVar: string | null): void {
  if (!wf.name || wf.nodes.length < 3) throw new Error('n8n backend: workflow needs a name and at least 3 nodes');
  if (!wf.settings || wf.settings.executionOrder !== 'v1') throw new Error('n8n backend: executionOrder must be v1');
  if (wf.active !== false) throw new Error('n8n backend: workflow must be inactive');
  if (wf.meta.templateCredsSetupCompleted !== false) throw new Error('n8n backend: credentials must be unset');
  const names = new Set<string>();
  const ids = new Set<string>();
  let sawDisclaimer = false;
  for (const node of wf.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error(`n8n backend: node id is missing or repeated (${node.name})`);
    ids.add(node.id);
    if (!node.name || names.has(node.name)) throw new Error(`n8n backend: node name is missing or repeated (${node.name})`);
    names.add(node.name);
    if (!node.type.startsWith('n8n-nodes-base.')) throw new Error(`n8n backend: ${node.name} has a bad type`);
    if (typeof node.typeVersion !== 'number') throw new Error(`n8n backend: ${node.name} has a bad typeVersion`);
    if (!Array.isArray(node.position) || node.position.length !== 2) throw new Error(`n8n backend: ${node.name} has a bad position`);
    if (!node.parameters || typeof node.parameters !== 'object') throw new Error(`n8n backend: ${node.name} has no parameters`);
    assertSafeN8nText(node.name, 'name', stageVar);
    assertSafeValue(node.parameters, 'parameters', stageVar);
    if (node.type === 'n8n-nodes-base.stickyNote' && String(node.parameters.content ?? '').includes(N8N_DISCLAIMER)) {
      sawDisclaimer = true;
    }
  }
  if (!sawDisclaimer) throw new Error('n8n backend: disclaimer sticky is missing');
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!names.has(from)) throw new Error(`n8n backend: connection from unknown node ${from}`);
    conn.main.forEach((slot, index) => {
      if (!Array.isArray(slot)) throw new Error(`n8n backend: ${from} main[${index}] is not a list`);
      for (const edge of slot) {
        if (!names.has(edge.node) || edge.type !== 'main' || typeof edge.index !== 'number' || edge.index < 0) {
          throw new Error(`n8n backend: ${from} has a bad edge`);
        }
      }
    });
  }
}

/** 16 hex chars, the leading prefix of sha256(speck name, node name). */
export function allocateNodeId(speck: string, name: string, used: Set<string>): string {
  const hash = createHash('sha256').update(`speckl-n8n\0${speck}\0${name}`).digest('hex').slice(0, 16);
  const base = `${slug(speck)}-${slug(name)}-${hash}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function nodeId(speck: string, name: string, used: Set<string>): string {
  return allocateNodeId(speck, name, used);
}

function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'node';
}

function stepsFrom(stmts: IRStmt[], ctx: Ctx): Step[] | null {
  const steps: Step[] = [];
  for (const stmt of stmts) {
    if (stmt.kind === 'require' || stmt.kind === 'precondition' || stmt.kind === 'postcondition') {
      if (!stmt.value) return null;
      const js = translate(stmt.value, ctx);
      if (!js) return null;
      steps.push({ op: stmt.kind === 'postcondition' ? 'post' : 'require', js });
    } else if (stmt.kind === 'assign') {
      if (!stmt.target || !isIdent(stmt.target) || stmt.targetIndex || !stmt.value) return null;
      const js = translate(stmt.value, ctx);
      if (!js) return null;
      steps.push({ op: 'assign', target: stmt.target, js });
    } else if (stmt.kind === 'let') {
      if (!stmt.letName || !isIdent(stmt.letName) || !stmt.value) return null;
      const js = translate(stmt.value, ctx);
      if (!js) return null;
      ctx.locals.add(stmt.letName);
      steps.push({ op: 'let', name: stmt.letName, js });
    } else if (stmt.kind === 'emit') {
      if (!stmt.event || !isIdent(stmt.event)) return null;
      const fields: { name: string; js: string }[] = [];
      for (const field of stmt.fields ?? []) {
        if (!isIdent(field.name)) return null;
        const js = translate(field.value, ctx);
        if (!js) return null;
        fields.push({ name: field.name, js });
      }
      steps.push({ op: 'emit', event: stmt.event, fields });
    } else if (stmt.kind === 'return') {
      if (!stmt.expr) return null;
      const js = translate(stmt.expr, ctx);
      if (!js) return null;
      steps.push({ op: 'return', js });
    } else {
      return null;
    }
  }
  return steps;
}

function translate(expr: IRExpr, ctx: Ctx): string | null {
  if (expr.kind === 'bool_lit' && expr.parseFailed) return null;
  switch (expr.kind) {
    case 'bool_lit':
      return expr.value ? 'true' : 'false';
    case 'int_lit':
      return Number.isFinite(expr.value) ? String(expr.value) : null;
    case 'float_lit':
      return Number.isFinite(expr.value) ? String(expr.value) : null;
    case 'string_lit':
      return looksLikeSecret(expr.value) ? null : jsString(expr.value);
    case 'ident':
      return identJs(expr.name, ctx);
    case 'unop': {
      const inner = translate(expr.operand, ctx);
      if (!inner) return null;
      if (expr.op === '!') return `(!${inner})`;
      if (expr.op === '-') return `(-${inner})`;
      return null;
    }
    case 'binop': {
      const left = translate(expr.left, ctx);
      const right = translate(expr.right, ctx);
      if (!left || !right) return null;
      const op = binOp(expr.op);
      if (!op) return null;
      return `(${left} ${op} ${right})`;
    }
    case 'call':
      return callJs(expr.fn, expr.args, ctx);
    case 'field': {
      const target = translate(expr.target, ctx);
      if (!target || !isIdent(expr.field)) return null;
      return `(${target}[${JSON.stringify(expr.field)}])`;
    }
    case 'index': {
      const target = translate(expr.target, ctx);
      const index = translate(expr.index, ctx);
      if (!target || !index) return null;
      return `(${target}[${index}])`;
    }
    default:
      return null;
  }
}

function identJs(name: string, ctx: Ctx): string | null {
  if (name === 'true') return 'true';
  if (name === 'false') return 'false';
  if (!isIdent(name)) return null;
  if (ctx.labels.has(name)) return String(ctx.labels.get(name));
  if (ctx.locals.has(name)) return `locals[${JSON.stringify(name)}]`;
  return `__root__[${JSON.stringify(name)}]`;
}

function binOp(op: string): string | null {
  switch (op) {
    case '==': return '===';
    case '!=': return '!==';
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return op;
    case '&&':
    case 'and':
      return '&&';
    case '||':
    case 'or':
      return '||';
    default:
      return null;
  }
}

function callJs(fn: string, args: IRExpr[], ctx: Ctx): string | null {
  const parts: string[] = [];
  for (const arg of args) {
    const js = translate(arg, ctx);
    if (!js) return null;
    parts.push(js);
  }
  if ((fn === 'not' || fn === '!') && parts.length === 1) return `(!${parts[0]})`;
  if ((fn === 'implies' || fn === '=>') && parts.length === 2) return `(!${parts[0]} || ${parts[1]})`;
  if ((fn === 'and' || fn === '&&') && parts.length === 2) return `(${parts[0]} && ${parts[1]})`;
  if ((fn === 'or' || fn === '||') && parts.length === 2) return `(${parts[0]} || ${parts[1]})`;
  return null;
}

function looksLikeSecret(value: string): boolean {
  return SECRET_RES.some(re => re.test(value));
}

function isIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function stagesOf(action: IRAction, stageVar: string, labels: Map<string, number>): number[] {
  const found: number[] = [];
  for (const stmt of action.statements) {
    if ((stmt.kind === 'require' || stmt.kind === 'precondition') && stmt.value) {
      collectStages(stmt.value, stageVar, labels, found);
    }
  }
  return uniqueNums(found);
}

function collectStages(expr: IRExpr, stageVar: string, labels: Map<string, number>, out: number[]): void {
  if (expr.kind === 'binop' && (expr.op === '&&' || expr.op === '||' || expr.op === 'and' || expr.op === 'or')) {
    collectStages(expr.left, stageVar, labels, out);
    collectStages(expr.right, stageVar, labels, out);
    return;
  }
  if (expr.kind === 'binop' && (expr.op === '==' || expr.op === '===')) {
    const n = stageConst(expr.left, expr.right, stageVar, labels) ?? stageConst(expr.right, expr.left, stageVar, labels);
    if (n !== null) out.push(n);
  }
}

function stageConst(left: IRExpr, right: IRExpr, stageVar: string, labels: Map<string, number>): number | null {
  if (left.kind !== 'ident' || left.name !== stageVar) return null;
  if (right.kind === 'int_lit' && Number.isFinite(right.value)) return right.value;
  if (right.kind === 'ident' && labels.has(right.name)) return labels.get(right.name) ?? null;
  return null;
}

function isPost(stages: number[], approved: Set<number>, awaitValue: number): boolean {
  return stages.some(s => approved.has(s) || s > awaitValue);
}

function sortPre(actions: ActionModel[]): void {
  const open = actions.filter(a => a.stages.length === 0).sort((a, b) => a.index - b.index);
  const staged = actions.filter(a => a.stages.length > 0).sort((a, b) => minOr(a.stages) - minOr(b.stages) || a.index - b.index);
  actions.splice(0, actions.length, ...open, ...staged);
}

function minOr(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}

function uniqueNums(values: number[]): number[] {
  const out: number[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

function assertAwaitSafe(speck: string, aw: IRAgentAwait): void {
  const rejects = new Set(aw.rejects);
  if (!aw.timeout) {
    throw new N8nTranslateError(
      `n8n backend: await ${aw.state} on ${speck}: Wait has no timeout; refusing to write a partial workflow`,
    );
  }
  if (!rejects.has(aw.timeout.outcome)) {
    throw new N8nTranslateError(`n8n backend: await ${aw.state}: timeout outcome "${aw.timeout.outcome}" is not a reject outcome`);
  }
  const acceptTargets = new Set(aw.on.filter(o => !rejects.has(o.outcome)).map(o => o.target));
  for (const reject of rejects) {
    const target = aw.on.find(o => o.outcome === reject)?.target;
    if (target !== undefined && acceptTargets.has(target)) {
      throw new Error(`n8n backend: await ${aw.state}: reject outcome "${reject}" reaches ${target}, which an accepting outcome also reaches`);
    }
  }
}

function awaitStageValue(aw: IRAgentAwait, labels: Map<string, number>): number {
  if (aw.syntheticActions.length > 0) return aw.syntheticActions[0].awaitValue;
  const value = labels.get(aw.state);
  if (value === undefined) throw new Error(`n8n backend: await ${aw.state} has no stage value`);
  return value;
}

function targetStage(aw: IRAgentAwait, outcome: string): number {
  const found = aw.syntheticActions.find(s => s.outcome === outcome);
  if (!found) throw new Error(`n8n backend: await ${aw.state} outcome "${outcome}" has no target stage`);
  return found.targetValue;
}

function invariantsOf(ast: AST | undefined, speck: string): InvariantMemberNode[] {
  const node = ast?.specks.find(s => s.name === speck);
  return (node?.members ?? []).filter((m): m is InvariantMemberNode => m.type === 'invariant');
}

function verifyModel(v: IRVerify, names: Set<string>, ctx: Ctx): { name: string; kind: string; target?: string; js?: string | null } {
  const expr = v.temporalExpr;
  if (expr.kind === 'call' && /^always$/i.test(expr.fn) && expr.args.length === 1) {
    const arg = expr.args[0];
    if (arg.kind === 'ident' && names.has(arg.name)) return { name: v.name, kind: 'always', target: arg.name };
    return { name: v.name, kind: 'expr', js: translate(arg, ctx) };
  }
  if (expr.kind === 'call' && /^eventually$/i.test(expr.fn)) return { name: v.name, kind: 'eventually' };
  if (expr.kind === 'bool_lit' && expr.parseFailed) return { name: v.name, kind: 'untranslated' };
  return { name: v.name, kind: 'expr', js: translate(expr, ctx) };
}

function renderReadme(specks: string[]): string {
  const files = specks.flatMap(name => [
    `- \`${name}.workflow.json\``,
    `- \`${name}.verify.mjs\` — \`node ${name}.verify.mjs\` (exit 0 when the checks hold, exit 1 when a check fails)`,
  ]);
  return [
    N8N_DISCLAIMER,
    '',
    'This directory is generated by Speckl, a general-purpose compiler. It is not HIPAA-certified. You are responsible for your own compliance review. This output does not guarantee zero data retention (ZDR).',
    '',
    'Import each `*.workflow.json` in n8n with Workflows → Import from File. `active` is false. `meta.templateCredsSetupCompleted` is false. These files contain no live keys and no credentials object. A string in the spec is literal data. It is not an n8n env binding.',
    '',
    '## Files',
    '',
    ...files,
    '',
    '## Approval',
    '',
    'An `agent { await ... }` block becomes one `n8n-nodes-base.wait` node (webhook resume, Limit Wait Time), a Resume code node, and an `n8n-nodes-base.if` gate. The If reads $json.body.outcome. Outcomes marked `!` use the If false output, which connects only to `n8n-nodes-base.stopAndError`. The timeout is Limit Wait Time on that same Wait. There is no second timer node. That false output has no path to a later action.',
    '',
    'An accepting outcome continues. Resume copies the item from before the Wait, so later nodes still have those fields. A reject ends at Stop and Error. A timeout ends at Stop and Error. A timeout resumes with the item from before the Wait. That item has no webhook headers, so body is empty and the If takes the false output.',
    '',
    '## Limits',
    '',
    'This file is an n8n workflow you import and run on your own n8n. Speckl does not run it after import and does not watch it after import. Speckl\'s CI tests its bundled examples, not this specific workflow.',
    '',
    'The trace check supports state, init, straight-line actions (`require`, `precondition`, `postcondition`, `let`, assign, `emit`, `return`), `constraint` and `invariant` boolean expressions, and `verify Always(Name)` when that expression translates. Those checks run only in the nodes and the verify script this compile wrote. They do not run anywhere else.',
    '',
    'Each of these fails `-t n8n` and writes no n8n file: `oneof`, `transition`, an `if` body, `for`, `forall`, `in`, `Eventually`, an unknown call, an await with no timeout, a timeout outcome that is not a reject, a string that looks like a live key, a parameter that would be an n8n expression, a state field named `headers`, and any other expression this target cannot translate.',
    '',
    'Compared with main, `-t all` and `-t all-ir` still stop when any backend other than n8n rejects the spec. `oneof` and `transition` do that, the process exits 1, and no n8n file is written. An n8n-only failure is the exception: the log line is `Skipped backend: n8n`, the other targets are still written, and the process exits 0. If that skip would write no file, the process exits 1. `-t n8n` exits 1 and writes no n8n file. No partial n8n file is written.',
    '',
    'A string from the spec is literal data. The characters `{{` and `}}` in that string are unicode escapes in the code node, and a parameter value is not allowed to start with `=`, except the If left value that reads $json.body.outcome. The workflow has no credential id and no credential value.',
    '',
    'The generated Wait sets incomingAuthentication to none. This file does not contain a credential. After import, set Authentication on the Wait node to Basic Auth, Header Auth, or JWT Auth and attach the matching credential in n8n.',
    '',
    'This workflow does not check signal signatures and does not enforce `bind call` digests. It does not schedule every legal `next:` order. Actions before the first await are chained, then the gates, then later actions. A `require` that does not hold stops that n8n run. A reject outcome that names an earlier stage still stops.',
    '',
    'Each node id ends with 16 hex characters. Those 16 characters are the first 16 characters of sha256 of the speck name and the node name. If that id is already used, the compiler appends -2, then -3, and so on, until the id is new.',
    '',
    'The verify script is a straight-line trace check. It does not run n8n. It is not a model check. A recorded `depth` does not change the check.',
    '',
  ].join('\n');
}

function renderScript(workflowFile: string, model: unknown): string {
  const header = [
    '#!/usr/bin/env node',
    '// Generated by speckl -t n8n. Recompiling the same spec is byte-identical.',
    `// ${N8N_DISCLAIMER}`,
    '// Speckl is a general-purpose compiler. This check is not HIPAA-certified. You are responsible for your own compliance review.',
    '// This output does not guarantee zero data retention (ZDR).',
    '// Straight-line trace check. This script does not run n8n. It is not a model check.',
    '// A recorded depth does not change the check. A failed check exits 1.',
    '',
  ].join('\n');
  return header + SCRIPT_RUNTIME
    .replace('__WORKFLOW_FILE__', JSON.stringify(workflowFile))
    .replace('__MODEL__', JSON.stringify(model, null, 2));
}

const SCRIPT_RUNTIME = `
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowFile = __WORKFLOW_FILE__;
const model = __MODEL__;

const here = dirname(fileURLToPath(import.meta.url));
const workflow = JSON.parse(readFileSync(join(here, workflowFile), 'utf8'));
let failed = 0;

function fail(msg) {
  console.error(msg);
  failed = 1;
}

function evalJs(js, state, locals) {
  return new Function('__root__', 'locals', 'return (' + js + ');')(state, locals);
}

function outgoing(name) {
  const conn = workflow.connections && workflow.connections[name];
  if (!conn || !Array.isArray(conn.main)) return [];
  const out = [];
  for (const slot of conn.main) {
    if (!Array.isArray(slot)) continue;
    for (const edge of slot) if (edge && typeof edge.node === 'string') out.push(edge.node);
  }
  return out;
}

function reaches(start, goal, block) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || block.has(name)) continue;
    seen.add(name);
    if (name === goal) return true;
    for (const next of outgoing(name)) queue.push(next);
  }
  return false;
}

function structural() {
  if (workflow.name !== model.speck) fail('workflow name');
  if (workflow.active !== false) fail('active is not false');
  if (!workflow.settings || workflow.settings.executionOrder !== 'v1') fail('executionOrder');
  if (!workflow.pinData || JSON.stringify(workflow.pinData) !== '{}') fail('pinData');
  if (!workflow.meta || workflow.meta.templateCredsSetupCompleted !== false) fail('templateCredsSetupCompleted');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 3) fail('nodes');
  const names = new Set();
  const ids = new Set();
  let sticky = '';
  for (const node of workflow.nodes) {
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail('node id');
    ids.add(node.id);
    if (typeof node.name !== 'string' || names.has(node.name)) fail('node name');
    names.add(node.name);
    if (typeof node.type !== 'string' || node.type.indexOf('n8n-nodes-base.') !== 0) fail('node type ' + node.name);
    if (typeof node.typeVersion !== 'number') fail('typeVersion ' + node.name);
    if (!Array.isArray(node.position) || node.position.length !== 2) fail('position ' + node.name);
    if (!node.parameters || typeof node.parameters !== 'object') fail('parameters ' + node.name);
    if (node.type === 'n8n-nodes-base.stickyNote') sticky += String(node.parameters.content || '');
  }
  if (sticky.indexOf(model.disclaimer) === -1) fail('disclaimer missing from workflow');
  const connections = workflow.connections || {};
  for (const from of Object.keys(connections)) {
    if (!names.has(from)) fail('connection from unknown node ' + from);
    const main = connections[from].main;
    if (!Array.isArray(main)) fail('main missing on ' + from);
    for (let i = 0; i < main.length; i++) {
      const slot = main[i];
      if (!Array.isArray(slot)) fail('main slot ' + from);
      for (const edge of slot) {
        if (!edge || !names.has(edge.node) || edge.type !== 'main' || typeof edge.index !== 'number' || edge.index < 0) {
          fail('bad edge from ' + from);
        }
      }
    }
  }
  const waits = new Set(model.gates.map(g => g.wait));
  for (const node of workflow.nodes) {
    if (node.parameters && node.parameters.resume === 'timeInterval') fail('a second timer is present');
  }
  for (const gate of model.gates) {
    const wait = workflow.nodes.find(n => n.name === gate.wait);
    const resume = workflow.nodes.find(n => n.name === gate.resume);
    const iff = workflow.nodes.find(n => n.name === gate.gate);
    const stop = workflow.nodes.find(n => n.name === gate.stop);
    if (!wait || wait.type !== 'n8n-nodes-base.wait') fail('missing wait ' + gate.wait);
    if (!resume || resume.type !== 'n8n-nodes-base.code') fail('missing resume ' + gate.resume);
    if (!iff || iff.type !== 'n8n-nodes-base.if') fail('missing gate ' + gate.gate);
    if (!stop || stop.type !== 'n8n-nodes-base.stopAndError') fail('missing stop ' + gate.stop);
    if (wait.parameters.resume !== 'webhook') fail('wait is not a webhook');
    if (wait.parameters.httpMethod !== 'POST') fail('wait method');
    if (wait.parameters.incomingAuthentication !== 'none') fail('wait auth');
    if (wait.parameters.limitWaitTime !== true) fail('limit wait time');
    if (wait.parameters.limitType !== 'afterTimeInterval') fail('limit type');
    if (wait.parameters.resumeAmount !== gate.limitAmount) fail('limit amount');
    if (wait.parameters.resumeUnit !== gate.limitUnit) fail('limit unit');
    if (wait.credentials) fail('wait credentials');
    const waitOut = outgoing(gate.wait);
    if (waitOut.length !== 1 || waitOut[0] !== gate.resume) fail('wait output');
    const resumeOut = outgoing(gate.resume);
    if (resumeOut.length !== 1 || resumeOut[0] !== gate.gate) fail('resume output');
    const code = String((resume.parameters && resume.parameters.jsCode) || '');
    if (code.indexOf("$('" + gate.prior + "')") === -1) fail('resume does not read ' + gate.prior);
    if (code.indexOf('incoming.body') === -1) fail('resume does not read body');
    const conditions = (((iff.parameters || {}).conditions || {}).conditions) || [];
    if (!conditions.length) fail('if conditions');
    for (let c = 0; c < conditions.length; c++) {
      if (conditions[c].leftValue !== '={{ $json.body.outcome }}') fail('outcome path');
    }
    if (outgoing(gate.stop).length !== 0) fail(gate.stop + ' has an outgoing edge');
    const falseSlot = (((connections[gate.gate] || {}).main) || [])[1] || [];
    for (const edge of falseSlot) {
      for (const name of model.post) {
        if (edge.node === name || reaches(edge.node, name, new Set())) fail('reject reaches ' + name);
      }
    }
    for (const name of model.post) {
      if (!reaches('Start', name, new Set())) fail(name + ' is not reachable from Start');
      if (reaches('Start', name, waits)) fail(name + ' is reachable without the approval wait');
      if (reaches(gate.stop, name, new Set())) fail('stop reaches ' + name);
    }
  }
}

function check(state) {
  for (const inv of model.invariants) {
    if (!inv.js) throw new Error('speckl-n8n: untranslated invariant ' + inv.name);
    if (!evalJs(inv.js, state, {})) fail('invariant failed: ' + inv.name);
  }
  for (const c of model.constraints) {
    if (!c.js) throw new Error('speckl-n8n: untranslated constraint ' + c.name);
    if (!evalJs(c.js, state, {})) fail('constraint failed: ' + c.name);
  }
  for (const v of model.verifies) {
    if (v.kind === 'always') {
      const inv = model.invariants.find(i => i.name === v.target);
      if (!inv) throw new Error('speckl-n8n: verify ' + v.name + ' names a missing invariant');
      if (!inv.js) throw new Error('speckl-n8n: untranslated invariant ' + inv.name);
      if (!evalJs(inv.js, state, {})) fail('verify failed: ' + v.name);
    } else if (v.kind === 'expr') {
      if (!v.js) throw new Error('speckl-n8n: untranslated verify ' + v.name);
      if (!evalJs(v.js, state, {})) fail('verify failed: ' + v.name);
    } else {
      throw new Error('speckl-n8n: untranslated verify ' + v.name);
    }
  }
}

function leadingGuardsHold(state, action) {
  const locals = {};
  for (const step of action.steps) {
    if (step.op === 'let') locals[step.name] = evalJs(step.js, state, locals);
    else if (step.op === 'require') {
      if (!evalJs(step.js, state, locals)) return false;
    } else return true;
  }
  return true;
}

function applyAction(state, action) {
  const locals = {};
  for (const step of action.steps) {
    if (step.op === 'require' || step.op === 'post') {
      if (!evalJs(step.js, state, locals)) throw new Error('speckl-n8n: require failed in ' + action.name);
    } else if (step.op === 'assign') state[step.target] = evalJs(step.js, state, locals);
    else if (step.op === 'let') locals[step.name] = evalJs(step.js, state, locals);
    else if (step.op === 'emit') {
      const fields = {};
      for (const field of step.fields) fields[field.name] = evalJs(field.js, state, locals);
      state.__events = Array.isArray(state.__events) ? state.__events : [];
      state.__events.push({ event: step.event, fields });
    } else if (step.op === 'return') {
      state.__result = evalJs(step.js, state, locals);
      break;
    } else throw new Error('speckl-n8n: untranslated action step in ' + action.name);
  }
}

function tryApply(state, action) {
  if (!action.steps) throw new Error('speckl-n8n: untranslated action ' + action.name);
  if (!leadingGuardsHold(state, action)) return false;
  applyAction(state, action);
  return true;
}

function byName(name) {
  const action = model.actions.find(a => a.name === name);
  if (!action) throw new Error('speckl-n8n: missing action ' + name);
  return action;
}

function runInit(state) {
  if (!model.init) throw new Error('speckl-n8n: untranslated init');
  const locals = {};
  for (const step of model.init) {
    if (step.op !== 'assign') throw new Error('speckl-n8n: untranslated init');
    state[step.target] = evalJs(step.js, state, locals);
  }
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function simulate() {
  for (const action of model.actions) {
    if (!action.steps) throw new Error('speckl-n8n: untranslated action ' + action.name);
  }
  const state = {};
  runInit(state);
  check(state);
  if (model.gates.length === 0) {
    const cap = Math.max(1, model.actions.length * 2);
    for (let n = 0; n < cap; n++) {
      let progressed = false;
      for (const action of model.actions) {
        if (tryApply(state, action)) {
          check(state);
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }
    return;
  }
  if (!model.stageVar) throw new Error('speckl-n8n: await has no stage variable');
  for (const name of model.pre) {
    if (tryApply(state, byName(name))) check(state);
  }
  const base = clone(state);
  let ran = false;
  const landings = model.landings && model.landings.length
    ? model.landings
    : [{ stage: null, branch: model.post }];
  for (const landing of landings) {
    const stages = landing.stage === null ? (model.acceptStages.length ? model.acceptStages : [base[model.stageVar]]) : [landing.stage];
    for (const stage of stages) {
      const branch = clone(base);
      branch[model.stageVar] = stage;
      // The branch runs the shared checks, then its own actions.
      check(branch);
      for (const name of landing.branch) {
        if (tryApply(branch, byName(name))) {
          if (model.accepting.indexOf(name) !== -1) ran = true;
          check(branch);
        }
      }
    }
  }
  if (model.accepting.length && !ran) fail('no accepting action ran on the approval path');
  for (const stage of model.rejectStages) {
    const branch = clone(base);
    branch[model.stageVar] = stage;
    check(branch);
  }
}

structural();
try {
  simulate();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
if (failed) process.exit(1);
`;
