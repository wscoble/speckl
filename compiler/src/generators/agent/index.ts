// Agent target: AGENTS.md + tools.json + generic hook + signal verifiers.
// Output lands in <out>/agent/. The TypeScript machine (with synthetic
// __signal_* actions) is generated alongside so the hook can drive it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import {
  AST, SpeckNode, ActionNode, AgentMemberNode, StateNode,
} from '../../parser.js';
import { generateTypeScriptStateMachine } from '../typescript-state-machine.js';
import { injectSignalActions, isSignalActionName, signalActionName } from './inject-signals.js';
import { emitHookMjs } from './hook-template.js';
import { emitSignalMjs } from './signal-template.js';
import { emitCliVerifier, emitFileDropVerifier } from './verifier-templates.js';

const require = createRequire(import.meta.url);

export interface AgentGenerateOptions {
  outputDir: string;
  /** Absolute path to the source .speckdl (for hashing). */
  sourcePath?: string;
}

export function generateAgent(ast: AST, options: AgentGenerateOptions): void {
  const injected = injectSignalActions(ast);
  for (const speck of injected.specks) {
    const agent = speck.members.find((m): m is AgentMemberNode => m.type === 'agent');
    if (!agent) {
      console.log(`  skip ${speck.name}: no agent { } block`);
      continue;
    }
    emitAgentForSpeck(speck, agent, options);
  }
}

function emitAgentForSpeck(
  speck: SpeckNode,
  agent: AgentMemberNode,
  options: AgentGenerateOptions,
): void {
  const agentDir = path.join(options.outputDir, 'agent');
  fs.mkdirSync(path.join(agentDir, 'verifiers'), { recursive: true });

  // Machine with synthetic signal actions (AST already injected).
  const single: AST = { specks: [speck] };
  generateTypeScriptStateMachine(single, agentDir);

  const tsPath = path.join(agentDir, `${speck.name}.ts`);
  const mjsPath = path.join(agentDir, `${speck.name}.mjs`);
  transpileTsToMjs(tsPath, mjsPath);

  const sourceText = options.sourcePath && fs.existsSync(options.sourcePath)
    ? fs.readFileSync(options.sourcePath, 'utf-8')
    : '';
  const specHash = crypto.createHash('sha256').update(sourceText || JSON.stringify(speck)).digest('hex');
  fs.writeFileSync(path.join(agentDir, 'spec.sha256'), specHash + '\n');

  const actions = speck.members.filter((m): m is ActionNode => m.type === 'action');
  const state = speck.members.find((m): m is StateNode => m.type === 'state');
  const config = buildConfig(speck, agent, actions, state, specHash);
  fs.writeFileSync(path.join(agentDir, 'agent-config.json'), JSON.stringify(config, null, 2) + '\n');

  fs.writeFileSync(path.join(agentDir, 'tools.json'), JSON.stringify(buildToolsJson(agent, actions), null, 2) + '\n');
  fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), buildAgentsMd(speck, agent, config, specHash));
  fs.writeFileSync(path.join(agentDir, 'hook.mjs'), emitHookMjs(speck.name));
  fs.writeFileSync(path.join(agentDir, 'signal.mjs'), emitSignalMjs(speck.name));
  fs.writeFileSync(path.join(agentDir, 'verifiers', 'cli.mjs'), emitCliVerifier());
  fs.writeFileSync(path.join(agentDir, 'verifiers', 'file-drop.mjs'), emitFileDropVerifier());
  fs.writeFileSync(path.join(agentDir, 'README.md'), buildAgentReadme(speck.name, agent));

  // Make hook/signal executable-ish
  for (const bin of ['hook.mjs', 'signal.mjs']) {
    try { fs.chmodSync(path.join(agentDir, bin), 0o755); } catch { /* ignore */ }
  }

  console.log(`Generated agent target: ${agentDir}/`);
}

function transpileTsToMjs(tsPath: string, mjsPath: string): void {
  // typescript is a devDependency of the compiler package, so a published
  // install may not have it. Fail with an actionable message, not a stack.
  let ts: typeof import('typescript');
  try {
    ts = require('typescript') as typeof import('typescript');
  } catch {
    throw new Error('-t agent needs the "typescript" package to emit the .mjs machine; run: npm i typescript');
  }
  const src = fs.readFileSync(tsPath, 'utf-8');
  const js = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  fs.writeFileSync(mjsPath, js);
}

export interface AgentRuntimeConfig {
  speck: string;
  specHash: string;
  machineModule: string;
  machineExport: string;
  stageVariable: string;
  stages: Record<string, number>;
  tools: { name: string; action: string; effect: 'act' | 'observe' }[];
  awaits: {
    state: string;
    stateValue: number;
    signal: string;
    mode: 'near' | 'in';
    outcomes: string[];
    claims: { name: string; typeName: string }[];
    on: { outcome: string; target: string; targetValue: number; action: string }[];
    timeout?: { durationMs: number; durationText: string; outcome: string };
  }[];
}

function buildConfig(
  speck: SpeckNode,
  agent: AgentMemberNode,
  _actions: ActionNode[],
  _state: StateNode | undefined,
  specHash: string,
): AgentRuntimeConfig {
  const labels = new Map((agent.stages?.labels ?? []).map(l => [l.name, l.value]));
  const stageVariable = agent.stages?.variable ?? 'stage';
  const stages: Record<string, number> = {};
  for (const [k, v] of labels) stages[k] = v;

  return {
    speck: speck.name,
    specHash,
    machineModule: `./${speck.name}.mjs`,
    machineExport: `${speck.name}Machine`,
    stageVariable,
    stages,
    tools: agent.tools.map(t => ({ name: t.name, action: t.action, effect: t.effect })),
    awaits: agent.awaits.map(a => ({
      state: a.state,
      stateValue: labels.get(a.state) ?? -1,
      signal: a.signal,
      mode: a.mode,
      outcomes: [...a.outcomes],
      claims: a.claims.map(c => ({ ...c })),
      on: a.on.map(o => ({
        outcome: o.outcome,
        target: o.target,
        targetValue: labels.get(o.target) ?? -1,
        action: signalActionName(a.signal, o.outcome),
      })),
      timeout: a.timeout ? { ...a.timeout } : undefined,
    })),
  };
}

function buildToolsJson(agent: AgentMemberNode, actions: ActionNode[]) {
  const byName = new Map(actions.map(a => [a.name, a]));
  return {
    tools: agent.tools.map(t => {
      const action = byName.get(t.action);
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of action?.params ?? []) {
        properties[p.name] = typeToJsonSchema(p.type);
        required.push(p.name);
      }
      return {
        name: t.name,
        description: `SpeckDL action ${t.action} (${t.effect})`,
        inputSchema: {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        },
        'x-speckl': { action: t.action, effect: t.effect },
      };
    }),
  };
}

function typeToJsonSchema(t: { type: string; name?: string; elementType?: unknown }): Record<string, unknown> {
  switch (t.type) {
    case 'primitive':
      switch (t.name) {
        case 'String': return { type: 'string' };
        case 'Bool': return { type: 'boolean' };
        case 'Nat':
        case 'Int': return { type: 'integer' };
        case 'Real': return { type: 'number' };
        default: return { type: 'string' };
      }
    case 'list': return { type: 'array' };
    case 'ident': return { type: 'string', description: t.name };
    default: return {};
  }
}

function buildAgentsMd(
  speck: SpeckNode,
  agent: AgentMemberNode,
  config: AgentRuntimeConfig,
  specHash: string,
): string {
  const lines: string[] = [];
  lines.push(`# AGENTS.md — ${speck.name}`);
  lines.push('');
  lines.push('Rails compiled from SpeckDL. The **hooks** enforce what the agent may do;');
  lines.push('this file is the readable surface. Do not edit by hand — regenerate with');
  lines.push('`speckl-compile <spec> -t agent`.');
  lines.push('');
  lines.push(`- Spec hash: \`${specHash.slice(0, 16)}…\``);
  lines.push(`- Stage variable: \`${config.stageVariable}\``);
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  lines.push('| Tool | Action | Effect |');
  lines.push('| --- | --- | --- |');
  for (const t of agent.tools) {
    lines.push(`| \`${t.name}\` | \`${t.action}\` | ${t.effect} |`);
  }
  lines.push('');
  lines.push('Unlisted actions are **refused** (fail closed).');
  lines.push('');
  lines.push('## Wait states (HITL / HNTL)');
  lines.push('');
  if (agent.awaits.length === 0) {
    lines.push('_No await blocks._');
  } else {
    for (const a of agent.awaits) {
      const val = config.stages[a.state];
      lines.push(`### \`${a.state}\` (${config.stageVariable} == ${val})`);
      lines.push('');
      lines.push(`- Signal: \`${a.signal}\``);
      lines.push(`- Mode: **${a.mode}** (${a.mode === 'near' ? 'HNTL — observe tools allowed while waiting' : 'HITL — no tools while waiting'})`);
      lines.push(`- Outcomes: ${a.outcomes.map(o => `\`${o}\``).join(', ')}`);
      if (a.claims.length) {
        lines.push(`- Required claims: ${a.claims.map(c => `\`${c.name}: ${c.typeName}\``).join(', ')}`);
      }
      for (const o of a.on) {
        lines.push(`- On \`${o.outcome}\` → \`${o.target}\``);
      }
      if (a.timeout) {
        lines.push(`- Timeout \`${a.timeout.durationText}\` → \`${a.timeout.outcome}\` (reject-class only)`);
      }
      lines.push('');
    }
  }
  lines.push('## Stages');
  lines.push('');
  for (const [name, value] of Object.entries(config.stages)) {
    lines.push(`- \`${name}\` = ${value}`);
  }
  lines.push('');
  lines.push('## Proof scope');
  lines.push('');
  lines.push('Z3 BMC covers every `next:` action, including synthetic `__signal_*`');
  lines.push('transitions for verified signal outcomes. It does **not** prove the');
  lines.push('runtime verifier, the model, or the outside world.');
  lines.push('');
  lines.push('## Hook contract');
  lines.push('');
  lines.push('```');
  lines.push('node hook.mjs pre  --state <file>   # stdin: {tool,input,call_id}');
  lines.push('node hook.mjs post --state <file>   # stdin: {tool,input,call_id,ok}');
  lines.push('```');
  lines.push('');
  lines.push('- exit 0 allow · exit 2 deny · exit 1 error (=deny)');
  lines.push('- State advances only on `post` with `ok: true` and a matching pending call_id.');
  lines.push('- Spec-hash mismatch denies.');
  lines.push('');
  return lines.join('\n');
}

function buildAgentReadme(speckName: string, agent: AgentMemberNode): string {
  const first = agent.awaits[0];
  const outcome = first?.outcomes[0] ?? 'approve';
  const claimFlags = (first?.claims ?? []).map(c => ` --claim_${c.name} alice`).join('');
  return `# Agent runtime wiring (${speckName})

This directory is produced by \`speckl-compile <spec> -t agent\`.

## Generic hook

Any agent runtime that can run a subprocess before/after a tool call can use
the hook. Contract (runtime-agnostic):

\`\`\`
# Before the tool runs:
echo '{"tool":"run_tests","input":{},"call_id":"1"}' \\
  | node hook.mjs pre --state ./state.json
# exit 0 → allow; exit 2 → deny (JSON reason on stdout + stderr); exit 1 → error/deny

# After the tool finishes:
echo '{"tool":"run_tests","input":{},"call_id":"1","ok":true}' \\
  | node hook.mjs post --state ./state.json
\`\`\`

Initialize state once:

\`\`\`
node signal.mjs init --state ./state.json
\`\`\`

## Signals (HITL / HNTL)

The spec never names a human action. It waits for a **verified signal**.

\`\`\`
# CLI verifier (low-assurance; evidence = local user + timestamp)
node signal.mjs apply --state ./state.json --verifier cli \\
  --outcome ${outcome} --as alice${claimFlags}

# File-drop verifier (ed25519-signed JSON; evidence = file sha256)
node signal.mjs apply --state ./state.json --verifier file-drop \\
  --file ./inbox/review.json --pubkey ./keys/reviewer.pub
# The signed JSON must name its signal: {"signal":"${first?.signal ?? 'review'}","outcome":"...","claims":{...}}
\`\`\`

Plug-in verifiers (JWT, OAuth, signed API, webhook) implement the same
\`SignalVerifier\` interface — see \`verifiers/\` and \`docs/agent-signals.md\`.

## Adapters

Claude Code / Cursor / etc. adapters are thin wrappers that translate their
native hook JSON into this stdin contract. Speckl does not ship runtime-specific
flags; keep adapters outside the compiler.
`;
}
