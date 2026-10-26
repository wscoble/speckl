// Domain budget obligation.
//
// One tick is one step of the domain: each member stutters (cost 0) or
// takes one action from its `next` relation. The cost of the tick is the
// sum of those costs. Members are independent state machines, so each
// member's witness is its own state reachable within the BMC depth, not a
// shared step index.
//
// The solver is asked whether any such sum is greater than the budget.
// unsat proves the bound inside the depth, under the model below. sat is a
// counterexample: the model carries per-step state, `Member_choice`
// (0 = stutter, then the next-actions in order), and `tick_cost`.
//
// Action parameters are not one symbol for the member. Each transition
// step of each action gets its own symbols (`Member__Action__p_name_step`),
// and the tick's enabledness check gets another set
// (`Member__Action__e_name_step`). Sharing them made two firings use one
// value, which hid ticks that are actually over budget.
//
// When the tick cannot be lowered (no next, a next action with no cost, a
// state sort or guard this encoding does not translate, an if/let block),
// the file is a `speckl-unchecked` marker and nothing else. Unchecked is
// never a proof. This file does not emit a runtime throttle.

import * as fs from 'fs';
import * as path from 'path';
import type { AST, ActionNode, SpeckNode, StateNode, InitNode, TypeExpr } from '../parser.js';
import type { IRDomain } from '../ir/types.js';
import { parseStringToIRExpr } from '../ir/lower.js';
import { containsParseFailure, translateExpr } from './z3-from-ir.js';
import { sanitizeSMT } from './smt-sanitize.js';
import { nextRelation } from './z3.js';
import { budgetKey, uncheckedBudget } from './budget-marker.js';

export { budgetKey, uncheckedBudget };

const SORTS = new Set(['Nat', 'Int', 'Bool', 'Real']);

/** A lowered budget query, or an unchecked marker when the query was dropped. */
export function sealBudgetSmt(text: string, key: string): string {
  const sanitized = sanitizeSMT(text);
  if (sanitized.dropped.length > 0) {
    const why = sanitized.dropped.map(d => d.reason.replace(/:\s/g, ' - ')).join('; ');
    return uncheckedBudget(key, `lowered form was dropped (${why})`);
  }
  return sanitized.text.endsWith('\n') ? sanitized.text : `${sanitized.text}\n`;
}

/**
 * Write one `<Domain>.budget.smt2` per domain that declares `budget`.
 * Domains without a budget contribute no file, so specs that do not use
 * the clause keep the same Z3 output as before.
 */
export function generateDomainBudgets(ast: AST, domains: IRDomain[], outputDir: string, depth: number): void {
  for (const domain of domains) {
    if (domain.budgetPerTick === undefined) continue;
    const key = budgetKey(domain.name);
    const built = buildBudget(ast, domain, depth);
    const text = built.ok ? sealBudgetSmt(built.text, key) : uncheckedBudget(key, built.reason);
    fs.writeFileSync(path.join(outputDir, `${domain.name}.budget.smt2`), text);
  }
}

type Built = { ok: true; text: string } | { ok: false; reason: string };

function buildBudget(ast: AST, domain: IRDomain, depthIn: number): Built {
  const depth = Number.isFinite(depthIn) && depthIn >= 1 ? Math.floor(depthIn) : 1;
  const budget = domain.budgetPerTick;
  if (budget === undefined || !Number.isSafeInteger(budget) || budget < 0) {
    return { ok: false, reason: `budget is not a non-negative integer` };
  }
  const key = budgetKey(domain.name);
  const members: MemberPlan[] = [];
  for (const name of domain.members) {
    const speck = ast.specks.find(s => s.name === name);
    if (!speck) return { ok: false, reason: `member ${name} is not in this compilation` };
    const plan = planMember(speck, depth);
    if (!plan.ok) return plan;
    members.push(plan.member);
  }

  const lines: string[] = [];
  lines.push(`; SpeckDL domain ${domain.name} — budget obligation`);
  lines.push(`; worst-case sum of action costs reachable in one tick <= ${budget}`);
  lines.push(`; Bounded model checking depth: ${depth}`);
  lines.push('; One tick: each member stutters (choice 0, cost 0) or takes one enabled next action.');
  lines.push('; Members are independent. Nothing here limits a running system.');
  lines.push('');
  lines.push('(set-logic ALL)');
  lines.push('(set-option :produce-models true)');
  lines.push('');

  for (const m of members) {
    lines.push(`; ${m.name}_choice: 0 = stutter (cost 0)${m.actions.map((a, i) => `, ${i + 1} = ${a.name} (cost ${a.cost})`).join('')}`);
    for (const v of m.state) {
      for (let i = 0; i <= depth; i++) lines.push(`(declare-const ${stateSym(m.prefix, v.name)}_${i} ${v.sort})`);
    }
    for (const a of m.actions) {
      for (const p of a.params) {
        for (let i = 0; i < depth; i++) {
          lines.push(`(declare-const ${stepParamSym(m.prefix, a.name, p.name, i)} ${p.sort})`);
        }
        for (let i = 0; i <= depth; i++) {
          lines.push(`(declare-const ${enabledParamSym(m.prefix, a.name, p.name, i)} ${p.sort})`);
        }
      }
    }
    lines.push(`(declare-const ${m.prefix}_choice Int)`);
    for (let i = 0; i <= depth; i++) lines.push(`(declare-const ${m.prefix}_choice_${i} Int)`);
  }
  lines.push('(declare-const tick_cost Int)');
  for (let i = 0; i <= depth; i++) lines.push(`(declare-const tick_cost_${i} Int)`);
  lines.push('');

  for (const m of members) {
    if (m.init.length > 0 || m.natFloor.length > 0) {
      lines.push('(assert');
      lines.push('  (and');
      for (const a of m.init) lines.push(`    ${a}`);
      for (const v of m.natFloor) lines.push(`    (>= ${stateSym(m.prefix, v)}_0 0)`);
      lines.push('  )');
      lines.push(')');
    }
    for (const a of m.actions) {
      for (const p of a.params) {
        if (!p.nat) continue;
        for (let i = 0; i < depth; i++) {
          lines.push(`(assert (>= ${stepParamSym(m.prefix, a.name, p.name, i)} 0))`);
        }
        for (let i = 0; i <= depth; i++) {
          lines.push(`(assert (>= ${enabledParamSym(m.prefix, a.name, p.name, i)} 0))`);
        }
      }
    }
    for (let i = 0; i < depth; i++) {
      lines.push(`(assert ; ${m.name} step ${i}`);
      lines.push('  (or');
      lines.push('    (and');
      if (m.state.length === 0) lines.push('      true');
      for (const v of m.state) {
        lines.push(`      (= ${stateSym(m.prefix, v.name)}_${i + 1} ${stateSym(m.prefix, v.name)}_${i})`);
      }
      lines.push('    )');
      for (const a of m.actions) {
        lines.push(`    (and ; ${a.name}`);
        lines.push(`      ${a.guards[i]}`);
        for (const asg of a.assigns) lines.push(`      ${asg[i]}`);
        for (const v of m.state) {
          if (!a.writes.has(v.name)) {
            lines.push(`      (= ${stateSym(m.prefix, v.name)}_${i + 1} ${stateSym(m.prefix, v.name)}_${i})`);
          }
        }
        if (m.state.length === 0 && a.assigns.length === 0) lines.push('      true');
        lines.push('    )');
      }
      lines.push('  )');
      lines.push(')');
    }
    lines.push(`(assert (and (>= ${m.prefix}_choice 0) (<= ${m.prefix}_choice ${m.actions.length})))`);
    lines.push('(assert');
    lines.push('  (or');
    lines.push(`    (= ${m.prefix}_choice 0)`);
    m.actions.forEach((a, idx) => {
      const enabled = a.always ? 'true' : `(or ${a.enabledAt.join(' ')})`;
      lines.push(`    (and (= ${m.prefix}_choice ${idx + 1}) ${enabled})`);
    });
    lines.push('  )');
    lines.push(')');
    for (let i = 0; i <= depth; i++) {
      lines.push(`(assert (= ${m.prefix}_choice_${i} ${m.prefix}_choice))`);
    }
  }

  const parts = members.map(m => m.costExpr);
  const sum = parts.length === 0 ? '0' : parts.length === 1 ? parts[0] : `(+ ${parts.join(' ')})`;
  lines.push(`(assert (= tick_cost ${sum}))`);
  for (let i = 0; i <= depth; i++) lines.push(`(assert (= tick_cost_${i} tick_cost))`);
  lines.push(`(assert (> tick_cost ${budget}))`);
  lines.push('');
  lines.push(`(echo "Checking: ${key}")`);
  lines.push(`; speckl-obligation: ${key}`);
  lines.push('; speckl-expect: unsat');
  lines.push('(check-sat)');
  lines.push('');
  return { ok: true, text: lines.join('\n') };
}

interface StatePlan {
  name: string;
  sort: 'Int' | 'Bool' | 'Real';
  nat: boolean;
}

interface ParamPlan {
  name: string;
  sort: 'Int' | 'Bool' | 'Real';
  nat: boolean;
}

interface ActionPlan {
  name: string;
  cost: number;
  params: ParamPlan[];
  always: boolean;
  /** Guard SMT at each step 0..depth (inclusive), on enabledness symbols. */
  enabledAt: string[];
  /** Guard SMT at each pre-step 0..depth-1, on that step's transition symbols. */
  guards: string[];
  /** Assignment SMT per pre-step. */
  assigns: string[][];
  writes: Set<string>;
}

interface MemberPlan {
  name: string;
  prefix: string;
  state: StatePlan[];
  actions: ActionPlan[];
  init: string[];
  /** Nat state vars with no init assignment. */
  natFloor: string[];
  costExpr: string;
}

function planMember(speck: SpeckNode, depth: number): { ok: true; member: MemberPlan } | { ok: false; reason: string } {
  const actions = speck.members.filter((m): m is ActionNode => m.type === 'action');
  const nextMember = speck.members.find(m => m.type === 'next');
  if (!nextMember) {
    return { ok: false, reason: `member ${speck.name} has no next relation, so one tick is not determined` };
  }
  let next;
  try {
    next = nextRelation(speck, actions);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!next) {
    return { ok: false, reason: `member ${speck.name} has no next relation, so one tick is not determined` };
  }
  const byName = new Map(actions.map(a => [a.name, a]));
  const chosen: { action: ActionNode; cost: number }[] = [];
  for (const name of next.actions) {
    const action = byName.get(name);
    if (!action) return { ok: false, reason: `member ${speck.name} next action ${name} is not an action` };
    const cost = actionCost(action);
    if (!cost.ok) return { ok: false, reason: `action ${speck.name}.${name} ${cost.reason}` };
    chosen.push({ action, cost: cost.cost });
  }

  const stateNode = speck.members.find((m): m is StateNode => m.type === 'state');
  const state: StatePlan[] = [];
  for (const v of stateNode?.variables ?? []) {
    const sort = sortOf(v.typeExpr);
    if (!sort) {
      return { ok: false, reason: `state variable ${speck.name}.${v.name} has a sort the budget check does not lower` };
    }
    state.push({ name: v.name, sort: sort.sort, nat: sort.nat });
  }
  const stateNames = state.map(v => v.name);
  const prefix = speck.name;

  const initNode = speck.members.find((m): m is InitNode => m.type === 'init');
  const init: string[] = [];
  const inited = new Set<string>();
  for (const a of initNode?.assignments ?? []) {
    if (!stateNames.includes(a.name)) {
      return { ok: false, reason: `init of ${speck.name}.${a.name} is not a state variable` };
    }
    const smt = exprSmt(a.expr, prefix, stateNames, new Map(), '_0');
    if (!smt) return { ok: false, reason: `init of ${speck.name}.${a.name} cannot be lowered` };
    const v = state.find(s => s.name === a.name)!;
    init.push(`(= ${stateSym(prefix, a.name)}_0 ${smt})`);
    inited.add(a.name);
    void v;
  }
  const natFloor = state.filter(v => v.nat && !inited.has(v.name)).map(v => v.name);

  const params: ParamPlan[] = [];
  const seenParams = new Set<string>();
  const actionPlans: ActionPlan[] = [];
  for (const { action, cost } of chosen) {
    const actionParams: ParamPlan[] = [];
    for (const p of action.params) {
      if (stateNames.includes(p.name)) {
        return { ok: false, reason: `action ${speck.name}.${action.name} parameter ${p.name} collides with a state variable` };
      }
      const sort = sortOf(p.type);
      if (!sort) {
        return { ok: false, reason: `action ${speck.name}.${action.name} parameter ${p.name} has a sort the budget check does not lower` };
      }
      actionParams.push({ name: p.name, sort: sort.sort, nat: sort.nat });
    }
    for (const p of actionParams) {
      const prev = params.find(q => q.name === p.name);
      if (prev && (prev.sort !== p.sort || prev.nat !== p.nat)) {
        return { ok: false, reason: `parameter ${p.name} of ${speck.name}.${action.name} does not match an earlier parameter of the same name` };
      }
      if (!seenParams.has(p.name)) {
        seenParams.add(p.name);
        params.push(p);
      }
    }
    const guardsSrc: string[] = [];
    const assigns: { target: string; expr: string }[] = [];
    const writes = new Set<string>();
    for (const s of action.statements) {
      if (s.type === 'cost' || s.type === 'emit' || s.type === 'return' || s.type === 'postcondition') continue;
      if (s.type === 'require' || s.type === 'precondition') {
        guardsSrc.push(s.expr);
        continue;
      }
      if (s.type === 'assign') {
        if (!/^[A-Za-z_]\w*$/.test(s.target) || !stateNames.includes(s.target)) {
          return { ok: false, reason: `action ${speck.name}.${action.name} assignment to ${s.target} cannot be lowered` };
        }
        if (writes.has(s.target)) {
          return { ok: false, reason: `action ${speck.name}.${action.name} assigns ${s.target} more than once` };
        }
        writes.add(s.target);
        assigns.push({ target: s.target, expr: s.expr });
        continue;
      }
      return { ok: false, reason: `action ${speck.name}.${action.name} contains a statement the budget check cannot lower` };
    }
    const lowerGuards = (step: number, kind: 'step' | 'enabled'): string | null => {
      if (guardsSrc.length === 0) return 'true';
      const symbols = paramSymbols(prefix, action.name, actionParams, step, kind);
      const parts: string[] = [];
      for (const g of guardsSrc) {
        const smt = exprSmt(g, prefix, stateNames, symbols, `_${step}`);
        if (!smt) return null;
        parts.push(smt);
      }
      return parts.length === 1 ? parts[0] : `(and ${parts.join(' ')})`;
    };
    const enabledAt: string[] = [];
    const guards: string[] = [];
    for (let i = 0; i <= depth; i++) {
      const smt = lowerGuards(i, 'enabled');
      if (smt === null) return { ok: false, reason: `guard of ${speck.name}.${action.name} cannot be lowered` };
      enabledAt.push(smt);
    }
    for (let i = 0; i < depth; i++) {
      const smt = lowerGuards(i, 'step');
      if (smt === null) return { ok: false, reason: `guard of ${speck.name}.${action.name} cannot be lowered` };
      guards.push(smt);
    }
    const assignSteps: string[][] = assigns.map(() => []);
    for (let i = 0; i < depth; i++) {
      const symbols = paramSymbols(prefix, action.name, actionParams, i, 'step');
      for (let k = 0; k < assigns.length; k++) {
        const smt = exprSmt(assigns[k].expr, prefix, stateNames, symbols, `_${i}`);
        if (!smt) return { ok: false, reason: `assignment in ${speck.name}.${action.name} cannot be lowered` };
        assignSteps[k].push(`(= ${stateSym(prefix, assigns[k].target)}_${i + 1} ${smt})`);
      }
    }
    actionPlans.push({
      name: action.name,
      cost,
      params: actionParams,
      always: guardsSrc.length === 0,
      enabledAt,
      guards,
      assigns: assignSteps,
      writes,
    });
  }

  const costExpr = actionPlans.length === 0
    ? '0'
    : actionPlans.map((a, i) => `(ite (= ${prefix}_choice ${i + 1}) ${a.cost} 0)`).reduce((acc, part) => (acc === '' ? part : `(+ ${acc} ${part})`), '');

  return {
    ok: true,
    member: { name: speck.name, prefix, state, actions: actionPlans, init, natFloor, costExpr },
  };
}

function actionCost(action: ActionNode): { ok: true; cost: number } | { ok: false; reason: string } {
  const costs = action.statements.filter(s => s.type === 'cost');
  if (costs.length === 0) return { ok: false, reason: 'has no cost' };
  if (costs.length > 1) return { ok: false, reason: 'declares cost more than once' };
  const amount = costs[0].type === 'cost' ? costs[0].amount : undefined;
  if (amount === undefined || !Number.isSafeInteger(amount) || amount < 0) {
    return { ok: false, reason: 'cost is not a non-negative integer' };
  }
  return { ok: true, cost: amount };
}

/** State symbol before the BMC step suffix: `Book__n` + `_0`. */
function stateSym(prefix: string, name: string): string {
  return `${prefix}__${name}`;
}

/** Transition parameter at one step: `Meter__Inc__p_x_0`. */
function stepParamSym(prefix: string, action: string, name: string, step: number): string {
  return `${prefix}__${action}__p_${name}_${step}`;
}

/** Enabledness parameter, not the symbol the transition uses: `Meter__Inc__e_x_0`. */
function enabledParamSym(prefix: string, action: string, name: string, step: number): string {
  return `${prefix}__${action}__e_${name}_${step}`;
}

function paramSymbols(
  prefix: string,
  action: string,
  params: ParamPlan[],
  step: number,
  kind: 'step' | 'enabled',
): Map<string, string> {
  const sym = kind === 'step' ? stepParamSym : enabledParamSym;
  return new Map(params.map(p => [p.name, sym(prefix, action, p.name, step)]));
}

function sortOf(t: TypeExpr | undefined): { sort: 'Int' | 'Bool' | 'Real'; nat: boolean } | null {
  if (!t || t.nullable) return null;
  const name = t.type === 'primitive' || t.type === 'ident' ? t.name : undefined;
  if (!name || !SORTS.has(name)) return null;
  if (name === 'Bool') return { sort: 'Bool', nat: false };
  if (name === 'Real') return { sort: 'Real', nat: false };
  return { sort: 'Int', nat: name === 'Nat' };
}

/**
 * Translate one expression at a BMC step. Returns null when the translation
 * is not total: a dropped guard would make an action look enabled, and a
 * dropped assignment would make a transition look like stutter.
 */
function exprSmt(
  src: string,
  prefix: string,
  stateNames: string[],
  paramSymbolsForStep: Map<string, string>,
  suffix: string,
): string | null {
  if (/['".[\]]/.test(src)) return null;
  let tree;
  try {
    tree = parseStringToIRExpr(src);
  } catch {
    return null;
  }
  if (containsParseFailure(tree)) return null;
  const locals = new Set(stateNames);
  const rename = (n: string) => (locals.has(n) ? stateSym(prefix, n) : paramSymbolsForStep.get(n) ?? n);
  const prefixed = new Set([...locals].map(n => stateSym(prefix, n)));
  const smt = translateExpr(tree, { stateVars: prefixed, suffix, rename });
  if (!smt || smt.includes('undefined')) return null;
  const declared = [
    ...stateNames.map(n => `(declare-const ${stateSym(prefix, n)}${suffix} Int)`),
    ...[...paramSymbolsForStep.values()].map(n => `(declare-const ${n} Int)`),
  ];
  const probe = `${declared.join('\n')}\n(assert ${smt})\n`;
  if (sanitizeSMT(probe).dropped.length > 0) return null;
  return smt;
}
