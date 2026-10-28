// Inject synthetic `__signal_<signal>_<outcome>` actions into the AST so the
// AST-driven Z3 BMC and TypeScript machine cover human-response edges.
// These actions are never exposed as tools (the agent generator filters them).

import {
  AST, SpeckNode, ActionNode, AgentMemberNode, NextMemberNode, MemberNode,
} from '../../parser.js';

export const SIGNAL_ACTION_PREFIX = '__signal_';

export function isSignalActionName(name: string): boolean {
  return name.startsWith(SIGNAL_ACTION_PREFIX);
}

export function signalActionName(signal: string, outcome: string): string {
  return `${SIGNAL_ACTION_PREFIX}${signal}_${outcome}`;
}

/**
 * Return a deep-enough copy of the AST with synthetic signal actions added
 * to every speck that has an `agent { }` block, and those actions appended
 * to `next:`. The original AST is not mutated.
 */
export function injectSignalActions(ast: AST): AST {
  return {
    specks: ast.specks.map(injectSpeck),
    imports: ast.imports ?? [],
    domains: ast.domains ?? [],
  };
}

function injectSpeck(speck: SpeckNode): SpeckNode {
  const agent = speck.members.find((m): m is AgentMemberNode => m.type === 'agent');
  if (!agent || !agent.stages || agent.awaits.length === 0) {
    return speck;
  }

  const labelToValue = new Map(agent.stages.labels.map(l => [l.name, l.value]));
  const stageVar = agent.stages.variable;
  const synthetics: ActionNode[] = [];

  for (const a of agent.awaits) {
    const awaitValue = labelToValue.get(a.state);
    if (awaitValue === undefined) continue;
    for (const o of a.on) {
      const targetValue = labelToValue.get(o.target);
      if (targetValue === undefined) continue;
      synthetics.push({
        type: 'action',
        name: signalActionName(a.signal, o.outcome),
        params: [],
        statements: [
          { type: 'require', expr: `${stageVar} == ${awaitValue}` },
          { type: 'assign', target: stageVar, expr: String(targetValue) },
        ],
      });
    }
  }

  if (synthetics.length === 0) return speck;

  const members: MemberNode[] = [];
  let nextPatched = false;
  for (const m of speck.members) {
    if (m.type === 'next' && !m.anyAction) {
      members.push({
        ...m,
        actions: [...m.actions, ...synthetics.map(s => s.name)],
      } as NextMemberNode);
      nextPatched = true;
    } else {
      members.push(m);
    }
  }
  // Insert synthetics after the last real action (or before next:/verify).
  const lastActionIdx = (() => {
    let idx = -1;
    for (let i = 0; i < members.length; i++) {
      if (members[i].type === 'action') idx = i;
    }
    return idx;
  })();
  if (lastActionIdx >= 0) {
    members.splice(lastActionIdx + 1, 0, ...synthetics);
  } else {
    members.push(...synthetics);
  }

  if (!nextPatched) {
    // Spec had next: { } (anyAction) or no next — leave as-is; IR lower warns.
  }

  return { ...speck, members };
}
