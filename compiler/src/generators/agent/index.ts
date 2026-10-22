// Agent target: AGENTS.md + tools.json + generic hook + signal verifiers.
// Output lands in <out>/agent/. The TypeScript machine (with synthetic
// __signal_* actions) is generated alongside so the hook can drive it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import {
  AST, SpeckNode, ActionNode, AgentMemberNode, StateNode,
} from '../../parser.js';
import { generateTypeScriptStateMachine } from '../typescript-state-machine.js';
import { injectSignalActions, isSignalActionName, signalActionName } from './inject-signals.js';
import { emitHookMjs } from './hook-template.js';
import { emitSignalMjs } from './signal-template.js';
import { emitCliVerifier, emitFileDropVerifier } from './verifier-templates.js';
import { stripTypes } from './strip-types.js';
import { emitStateIntegrityMjs } from './state-integrity-template.js';
import { emitAdapterMjs } from './adapter-template.js';
import { buildHarnessHooks, harnessConfigFile, harnessProtectedDirs, hermesYaml, pluginFiles, clineScripts, HarnessRule } from './harness-runtime.js';

/** Default for `pending timeout` when the spec does not declare one. */
export const DEFAULT_PENDING_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_PENDING_TIMEOUT_TEXT = '10m';

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
  fs.writeFileSync(path.join(agentDir, 'state-integrity.mjs'), emitStateIntegrityMjs());
  fs.writeFileSync(path.join(agentDir, 'verifiers', 'cli.mjs'), emitCliVerifier());
  fs.writeFileSync(path.join(agentDir, 'verifiers', 'file-drop.mjs'), emitFileDropVerifier());
  fs.writeFileSync(path.join(agentDir, 'README.md'), buildAgentReadme(speck.name, agent));
  if (config.harness) emitHarnessFiles(speck.name, agentDir, config.harness);

  // Make hook/signal executable-ish
  for (const bin of ['hook.mjs', 'signal.mjs']) {
    try { fs.chmodSync(path.join(agentDir, bin), 0o755); } catch { /* ignore */ }
  }

  console.log(`Generated agent target: ${agentDir}/`);
}

/** Actions whose generated body declares `// FIXME: parser dropped` placeholders. */
export function untranslatedActions(js: string): { action: string; names: string[] }[] {
  const out: { action: string; names: string[] }[] = [];
  let current = '';
  for (const line of js.split('\n')) {
    const head = line.match(/^ {2}(\w+)\([^)]*\)\s*\{\s*$/);
    if (head) current = head[1];
    const m = line.match(/^\s*const (\w+)\b.*\/\/ FIXME: parser dropped/);
    if (m) {
      const last = out[out.length - 1];
      if (last && last.action === current) last.names.push(m[1]);
      else out.push({ action: current || '(unknown)', names: [m[1]] });
    }
  }
  return out;
}

/**
 * Emit the machine as plain JavaScript so `-t agent` needs no TypeScript at
 * compile time or runtime. The result is syntax-checked with the running
 * Node so an unsupported construct fails the compile, not the hook.
 */
export function transpileTsToMjs(tsPath: string, mjsPath: string): void {
  const js = stripTypes(fs.readFileSync(tsPath, 'utf-8'));
  // Fail closed: a placeholder stands in for an identifier the TS generator
  // could not translate (a dropped let/forall). A guard reading it is not the
  // spec's guard, so refuse to emit rails rather than enforce the wrong rule.
  const dropped = untranslatedActions(js);
  if (dropped.length > 0) {
    throw new Error('-t agent: the generated machine has untranslated identifiers in '
      + dropped.map(d => `${d.action} (${d.names.join(', ')})`).join('; ')
      + '; its guards would not match the spec, so no rails were emitted');
  }
  fs.writeFileSync(mjsPath, js);
  const r = spawnSync(process.execPath, ['--check', mjsPath], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`-t agent: emitted JavaScript machine failed a syntax check (${mjsPath}):\n${r.stderr}`);
  }
}

export interface AgentRuntimeConfig {
  speck: string;
  specHash: string;
  machineModule: string;
  machineExport: string;
  stageVariable: string;
  stages: Record<string, number>;
  tools: { name: string; action: string; effect: 'act' | 'observe' }[];
  /** In-flight tool calls older than this are cleared as failed. */
  pendingTimeout: { durationMs: number; durationText: string };
  /** Compiled `harness` blocks; present only when the spec declares one. */
  harness?: Record<string, { rules: HarnessRule[] }>;
  awaits: {
    state: string;
    stateValue: number;
    signal: string;
    mode: 'near' | 'in';
    outcomes: string[];
    /** `!`-marked reject outcomes; the only legal timeout targets. */
    rejects: string[];
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

  const config: AgentRuntimeConfig = {
    speck: speck.name,
    specHash,
    machineModule: `./${speck.name}.mjs`,
    machineExport: `${speck.name}Machine`,
    stageVariable,
    stages,
    tools: agent.tools.map(t => ({ name: t.name, action: t.action, effect: t.effect })),
    pendingTimeout: agent.pendingTimeout
      ? { ...agent.pendingTimeout }
      : { durationMs: DEFAULT_PENDING_TIMEOUT_MS, durationText: DEFAULT_PENDING_TIMEOUT_TEXT },
    awaits: agent.awaits.map(a => ({
      state: a.state,
      stateValue: labels.get(a.state) ?? -1,
      signal: a.signal,
      mode: a.mode,
      outcomes: [...a.outcomes],
      rejects: [...(a.rejects ?? [])],
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
  if (agent.harnesses && agent.harnesses.length > 0) {
    config.harness = compileHarnesses(agent, _actions);
  }
  return config;
}

/**
 * Resolve each map rule's inputs: every parameter of the target action reads
 * the tool_input field named in `{ param = field }`, else the same name.
 */
export function compileHarnesses(
  agent: AgentMemberNode,
  actions: ActionNode[],
): Record<string, { rules: HarnessRule[] }> {
  const toolToAction = new Map(agent.tools.map(t => [t.name, t.action]));
  const paramsOf = new Map(actions.map(a => [a.name, (a.params ?? []).map(p => p.name)]));
  const out: Record<string, { rules: HarnessRule[] }> = {};
  for (const h of agent.harnesses ?? []) {
    out[h.name] = {
      rules: h.rules.map(r => {
        const params = paramsOf.get(toolToAction.get(r.target) ?? '') ?? [];
        const rule: HarnessRule = {
          tools: [...r.tools],
          target: r.target,
          inputs: params.map(p => ({ param: p, field: r.params.find(x => x.param === p)?.field ?? p })),
        };
        if (r.field !== undefined) {
          rule.field = r.field;
          rule.pattern = r.pattern ?? '';
        }
        return rule;
      }),
    };
  }
  return out;
}

/**
 * adapter.mjs plus reference hook wiring for each declared harness. The
 * wiring assumes the compile ran from the project root and the state file
 * sits next to agent/ (`-o .speckl` → .speckl/state.json);
 * `adapter.mjs install` writes wiring for any layout.
 */
function emitHarnessFiles(speckName: string, agentDir: string, harness: Record<string, { rules: HarnessRule[] }>): void {
  const names = Object.keys(harness);
  const adapterPath = path.join(agentDir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, emitAdapterMjs(speckName, names));
  const r = spawnSync(process.execPath, ['--check', adapterPath], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`-t agent: emitted adapter failed a syntax check (${adapterPath}):\n${r.stderr}`);
  }
  try { fs.chmodSync(adapterPath, 0o755); } catch { /* ignore */ }
  const rel = path.relative(process.cwd(), agentDir).split(path.sep).join('/');
  const relative = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const adapter = relative ? `${rel}/adapter.mjs` : adapterPath;
  const state = relative ? path.posix.join(rel, '..', 'state.json') : path.join(agentDir, '..', 'state.json');
  for (const name of names) {
    const dir = path.join(agentDir, 'harness', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.posix.basename(harnessConfigFile(name));
    const hooks = buildHarnessHooks(name, { adapter, state, key: null, relative });
    if (name === 'pi' || name === 'opencode' || name === 'openclaw') {
      // Reference copy of the plugin `install` writes (with absolute paths and
      // --project); relative paths here resolve from the plugin's install location.
      for (const [f, text] of Object.entries(pluginFiles(name, hooks))) fs.writeFileSync(path.join(dir, f), text);
      continue;
    }
    if (name === 'cline') {
      // Reference copies of the executable .clinerules/hooks/ scripts.
      for (const [f, text] of Object.entries(clineScripts(hooks))) fs.writeFileSync(path.join(dir, f), text, { mode: 0o755 });
      continue;
    }
    fs.writeFileSync(path.join(dir, file), name === 'hermes' ? hermesYaml(hooks) : JSON.stringify(hooks, null, 2) + '\n');
  }
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(words: string[]): string {
  return words.length <= 2 ? words.join(' and ') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
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
      lines.push(`- Outcomes: ${a.outcomes.map(o => `\`${o}\`${(a.rejects ?? []).includes(o) ? ' (reject)' : ''}`).join(', ')}`);
      if (a.claims.length) {
        lines.push(`- Required claims: ${a.claims.map(c => `\`${c.name}: ${c.typeName}\``).join(', ')}`);
      }
      for (const o of a.on) {
        lines.push(`- On \`${o.outcome}\` → \`${o.target}\``);
      }
      if (a.timeout) {
        lines.push(`- Timeout \`${a.timeout.durationText}\` → \`${a.timeout.outcome}\` (must be a \`!\`-marked reject outcome)`);
      }
      lines.push('');
    }
  }
  if (config.harness) {
    lines.push('## Harness wiring');
    lines.push('');
    lines.push('Each harness tool call is mapped onto a tool above (first match wins).');
    lines.push('Calls that match no line are **denied**. A matched command must be one plain');
    lines.push('command: `;`, `&`, `|`, backticks, `$`, `<`, `>` and newlines are refused.');
    const dirs = harnessProtectedDirs(Object.keys(config.harness));
    if (dirs.length === 4) {
      lines.push('The rails themselves (this directory, the state file, its key, `.claude/`,');
      lines.push('`.cursor/`, `.codex/`, `.gemini/`) are off limits to every tool. Make one tool');
      lines.push('call at a time.');
    } else {
      lines.push('The rails themselves (this directory, the state file, its key and the harness');
      lines.push(`config ${dirs.some(d => /\.jsonc?$/.test(d)) ? 'paths' : 'directories'} ${listWords(dirs.map(d => '`' + d + (/\.jsonc?$/.test(d) ? '' : '/') + '`'))})`);
      lines.push('are off limits to every tool. Make one tool call at a time.');
    }
    lines.push('');
    for (const [name, h] of Object.entries(config.harness)) {
      lines.push(`### ${name}`);
      lines.push('');
      lines.push('| Harness tool | When | Tool |');
      lines.push('| --- | --- | --- |');
      for (const r of h.rules) {
        const when = r.field !== undefined ? `\`${r.field}\` matches \`${(r.pattern ?? '').replace(/\|/g, '\\|')}\`` : 'always';
        lines.push(`| ${r.tools.map(t => `\`${t}\``).join(', ')} | ${when} | \`${r.target}\` |`);
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
  lines.push('node hook.mjs pre  --state <file> [--key <file>]   # stdin: {tool,input,call_id}');
  lines.push('node hook.mjs post --state <file> [--key <file>]   # stdin: {tool,input,call_id,ok}');
  lines.push('```');
  lines.push('');
  lines.push('- exit 0 allow · exit 2 deny · exit 1 error (=deny)');
  lines.push('- A deny reason names why, then the next step: not allowed in this stage; waiting on a');
  lines.push('  sign-off (the signal name and the `signal.mjs apply` command a human runs — `--signer`');
  lines.push('  for a pinned state, `--pubkey <pubkey>` only when the state has no pins); a failed');
  lines.push('  precondition; or an internal error (fail closed). It does not include the state key,');
  lines.push('  the key path, or the state contents. If the reason cannot be built, the call is still denied.');
  lines.push('- State advances only on `post` with `ok: true` and a matching pending call_id.');
  lines.push('- Spec-hash mismatch denies.');
  lines.push(`- A pending call older than \`${config.pendingTimeout.durationText}\` is cleared as failed (state not advanced);`);
  lines.push('  `signal.mjs clear-pending` clears one sooner, through a verified signal.');
  lines.push('');
  lines.push('## Tamper-evident state');
  lines.push('');
  lines.push('The state file is not trusted as written. Every change is appended to a');
  lines.push('hash-chained log; on load the hook and `signal.mjs` replay the log and check');
  lines.push('that the machine, pending call, used nonces and applied evidence match it, and');
  lines.push('verify an HMAC-SHA256 over the whole state. The key file (`--key` or');
  lines.push('`SPECKL_STATE_KEY_FILE`) must be readable by the hook and signal tooling and');
  lines.push('**not by the agent**. Any mismatch, a missing signature or a missing key denies');
  lines.push('(exit 2). Editing `state.json` by hand (e.g. setting the stage) is refused.');
  lines.push('');
  lines.push('## Who may record a signal');
  lines.push('');
  lines.push('Signals are recorded with `signal.mjs`, never by the agent. Production must use a');
  lines.push('**signed** verifier (`file-drop` or a plug-in); a signed drop is bound to this');
  lines.push('run (`run`), expires (`expires`) and is single-use (`nonce`).');
  lines.push('');
  lines.push('`signal.mjs init --signer name=pubkey` (repeatable) pins the ed25519 keys that');
  lines.push('`file-drop` will accept. The set is sealed into the state at init. A signature');
  lines.push('from any other key is refused, including a `--pubkey` passed on the command');
  lines.push('line. `rotate-signers` replaces the set; only a current pinned key can authorize it.');
  lines.push('');
  lines.push('> **DEV ONLY — `cli` verifier.** `--verifier cli` (and unsigned file drops) are');
  lines.push('> refused unless the state file was created with `signal.mjs init --dev`. Anyone');
  lines.push('> who can run a shell command can use them, so an agent with shell access could');
  lines.push('> approve its own work. Never use `--dev` where the agent can run `signal.mjs`.');
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
# The reason says which of these happened, then what to do: not allowed in this
# stage; waiting on a sign-off (the signal and the exact signal.mjs apply
# command). A pinned state names the signer and does not offer --pubkey.
# A state with no pins still says --pubkey <pubkey>. A failed precondition
# or an internal error (fail closed) has its own next step.
# It does not include the state key, signer key material, or the state contents.
# See docs/agent-signals.md.

# After the tool finishes:
echo '{"tool":"run_tests","input":{},"call_id":"1","ok":true}' \\
  | node hook.mjs post --state ./state.json
\`\`\`

Initialize state once (prints the run id signed drops must carry):

\`\`\`
# production: signed state + signed verifiers only. The key file is created if
# missing; keep it (and SPECKL_STATE_KEY_FILE) out of the agent's reach.
# --signer (repeatable) pins the ed25519 public keys that may sign file-drop
# approvals. The set is sealed into this state; apply cannot choose another.
node signal.mjs init --state ./state.json --key /etc/speckl/state.key \\
  --signer carol=./keys/carol.pub
# DEV ONLY: also allows the cli verifier; without --key the state is unsigned
node signal.mjs init --state ./state.json --dev

# Pass the same key to every hook/signal call (or set SPECKL_STATE_KEY_FILE):
export SPECKL_STATE_KEY_FILE=/etc/speckl/state.key
\`\`\`

## Signals (HITL / HNTL)

The spec never names a human action. It waits for a **verified signal**.

\`\`\`
# File-drop verifier (ed25519-signed JSON; evidence = file sha256).
# The signature must be from a key pinned at init. --pubkey is optional and,
# if passed, must be one of those keys — it does not add a trust anchor.
node signal.mjs apply --state ./state.json --verifier file-drop \\
  --file ./inbox/review.json
# The signed JSON names its signal and is bound to this run:
#   {"signal":"${first?.signal ?? 'review'}","outcome":"...","claims":{...},
#    "run":"<run id from init>","expires":"<ISO-8601>","nonce":"<unique>"}

# CLI verifier — DEV ONLY (state must be created with init --dev). Whoever can
# run this can approve, including an agent with shell access.
node signal.mjs apply --state ./state.json --verifier cli \\
  --outcome ${outcome} --as alice${claimFlags}
\`\`\`

To replace the pinned set, a current signer signs a \`rotate-signers\` drop
(\`{"signal":"rotate-signers","outcome":"rotate","signers":[{"name":"…","key":"<hex>"}], …}\`)
and someone runs \`signal.mjs rotate-signers --verifier file-drop --file <drop>\`.
Any one pinned key can sign; this is not a threshold. See \`docs/agent-signals.md\`.

## Stuck tool calls

A \`pre\` with no matching \`post\` (e.g. the tool crashed) blocks later calls
until it is cleared. It clears itself as failed after the pending timeout
(state is not advanced), or sooner through a verified signal:

\`\`\`
node signal.mjs clear-pending --state ./state.json --verifier file-drop \\
  --file ./inbox/clear.json
#   {"signal":"clear-pending","call_id":"<pending id>","run":"...","expires":"...","nonce":"..."}
\`\`\`

Plug-in verifiers (JWT, OAuth, signed API, webhook) implement the same
\`SignalVerifier\` interface — see \`verifiers/\` and \`docs/agent-signals.md\`.

## Adapters

${(agent.harnesses ?? []).length > 0
    ? `\`adapter.mjs\` wires this hook into ${listWords((agent.harnesses ?? []).map(h => h.name))}:

\`\`\`
node adapter.mjs install <harness> --project <dir> --state <file> [--key <file>]
\`\`\`

Reference wiring is in \`harness/<name>/\`. See \`docs/harness-adapters.md\`.`
    : `Declare a \`harness claude-code { ... }\` or \`harness cursor { ... }\` block in the
spec's \`agent { }\` to generate an adapter (\`adapter.mjs\`) that maps that
harness's hook JSON onto this contract. See \`docs/harness-adapters.md\`.`}
`;
}
