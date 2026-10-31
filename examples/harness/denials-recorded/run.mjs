#!/usr/bin/env node
// Compiles examples/ClaudeCodePolicy.speckdl with the built compiler and
// drives the generated adapter for all 13 harnesses. Each adapter-stage
// denial (unmapped, shell metacharacters, protected path, bad payload)
// must add one decision-record line with that class. An allowed call must
// not. A tampered state must still deny and must not extend the chain.
// Exits 1 on any mismatch. No network, no model, no extra packages.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const compiler = join(root, 'compiler', 'dist', 'index.js');
const spec = join(root, 'examples', 'ClaudeCodePolicy.speckdl');
const node = process.execPath;

const HARNESSES = [
  'claude-code', 'cursor', 'codex', 'gemini', 'copilot', 'goose', 'hermes',
  'pi', 'opencode', 'openclaw', 'cline', 'kiro', 'windsurf',
];
const SHELL = {
  'claude-code': 'Bash', cursor: 'Shell', codex: 'Bash', gemini: 'run_shell_command',
  copilot: 'bash', goose: 'shell', hermes: 'terminal', pi: 'bash', opencode: 'bash',
  openclaw: 'exec', cline: 'run_commands', kiro: 'shell', windsurf: 'run_command',
};
const PRE = {
  'claude-code': 'PreToolUse', cursor: 'preToolUse', codex: 'PreToolUse', gemini: 'BeforeTool',
  copilot: 'preToolUse', goose: 'PreToolUse', hermes: 'pre_tool_call', pi: 'tool_call',
  opencode: 'tool.execute.before', openclaw: 'before_tool_call', cline: 'PreToolUse',
  kiro: 'PreToolUse', windsurf: 'pre_tool',
};
const POST = {
  'claude-code': 'PostToolUse', cursor: 'postToolUse', codex: 'PostToolUse', gemini: 'AfterTool',
  copilot: 'postToolUse', goose: 'PostToolUse', hermes: 'post_tool_call', pi: 'tool_result',
  opencode: 'tool.execute.after', openclaw: 'after_tool_call', cline: 'PostToolUse',
  kiro: 'PostToolUse', windsurf: 'post_tool',
};

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function run(file, args, input) {
  const r = spawnSync(node, [file, ...args], { input, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function linesOf(state) {
  const log = state + '.decisions/log.jsonl';
  if (!existsSync(log)) return [];
  const text = readFileSync(log, 'utf-8');
  if (!text.trim()) return [];
  return text.trimEnd().split('\n').map(l => JSON.parse(l));
}

function payload(event, tool, input, id, project) {
  return JSON.stringify({
    hook_event_name: event, tool_name: tool, tool_input: input,
    tool_use_id: id, session_id: 'sess-denials', cwd: project,
  });
}

if (!existsSync(compiler)) {
  console.error('missing ' + compiler + ' (build the compiler first: cd compiler && npm ci && npm run build)');
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), 'speckl-denials-recorded-'));
const compiled = run(compiler, [spec, '-t', 'agent', '-o', out]);
if (compiled.status !== 0) {
  console.error(compiled.stderr || compiled.stdout);
  process.exit(1);
}
const agent = join(out, 'agent');
const project = mkdtempSync(join(tmpdir(), 'speckl-denials-proj-'));
const key = join(mkdtempSync(join(tmpdir(), 'speckl-denials-key-')), 'state.key');
mkdirSync(join(project, '.speckl'), { recursive: true });
const state = join(project, '.speckl', 'state.json');
const init = run(join(agent, 'signal.mjs'), ['init', '--state', state, '--key', key]);
if (init.status !== 0) {
  console.error(init.stderr);
  process.exit(1);
}

function call(harness, event, stdin) {
  return run(join(agent, 'adapter.mjs'), [harness, event, '--project', project, '--state', state, '--key', key], stdin);
}

const stateBefore = readFileSync(state);
for (const harness of HARNESSES) {
  const shell = SHELL[harness];
  const start = linesOf(state).length;
  const cases = [
    ['unmapped', 'pre', payload(PRE[harness], 'WebFetch', { url: 'https://example.com' }, harness + '-u', project)],
    ['metachar', 'pre', payload(PRE[harness], shell, { command: 'npm test; echo pwned' }, harness + '-m', project)],
    ['protected-path', 'pre', payload(PRE[harness], shell, { command: 'cat .claude/settings.json' }, harness + '-p', project)],
    ['bad-payload', 'pre', '{'],
  ];
  for (const [cls, event, stdin] of cases) {
    const r = call(harness, event, stdin);
    check(r.status === 2, harness + ' ' + cls + ' exit ' + r.status + ' stderr ' + r.stderr.slice(0, 200));
  }
  const added = linesOf(state).slice(start);
  check(added.map(l => l.class).join(',') === 'unmapped,metachar,protected-path,bad-payload',
    harness + ' classes ' + added.map(l => l.class).join(','));
  check(added.every(l => l.verdict === 'deny' && l.phase === 'pre'), harness + ' verdict/phase');
}

check(readFileSync(state).equals(stateBefore), 'denials rewrote state.json');
check(JSON.parse(readFileSync(state, 'utf-8')).log.length === 0, 'denials advanced the spec log');

const verify = run(join(agent, 'signal.mjs'), ['verify', '--state', state, '--key', key]);
check(verify.status === 0, 'verify failed: ' + verify.stderr);
if (verify.status === 0) {
  check(JSON.parse(verify.stdout).decisions === HARNESSES.length * 4, 'decision count ' + verify.stdout);
}

const allowStdout = {};
for (const harness of HARNESSES) {
  const shell = SHELL[harness];
  const before = linesOf(state).length;
  const allowed = call(harness, 'pre', payload(PRE[harness], shell, { command: 'git status' }, harness + '-ok', project));
  check(allowed.status === 0 && allowed.stderr === '', harness + ' allow ' + allowed.status + ' ' + allowed.stderr.slice(0, 180));
  const line = linesOf(state).at(-1);
  check(line && line.verdict === 'allow' && line.class === undefined && line.tool === 'inspect',
    harness + ' allow line ' + JSON.stringify(line && { verdict: line.verdict, class: line.class, tool: line.tool }));
  check(linesOf(state).length === before + 1, harness + ' allow added ' + (linesOf(state).length - before) + ' lines');
  allowStdout[harness] = allowed.stdout;
  const post = call(harness, 'post', payload(POST[harness], shell, { command: 'git status' }, harness + '-ok', project));
  const postOk = harness === 'windsurf' ? post.status === 2 && post.stderr.includes('not successful') : post.status === 0;
  check(postOk, harness + ' post ' + post.status + ' ' + post.stderr.slice(0, 180));
  check(JSON.parse(readFileSync(state, 'utf-8')).pending === null, harness + ' pending left set');
  const repeat = call(harness, 'pre', payload(PRE[harness], shell, { command: 'git status' }, harness + '-ok2', project));
  check(repeat.status === 0 && repeat.stdout === allowStdout[harness] && repeat.stderr === '',
    harness + ' repeat allow changed');
  const clear = call(harness, 'post', payload(POST[harness], shell, { command: 'git status' }, harness + '-ok2', project));
  const clearOk = harness === 'windsurf' ? clear.status === 2 : clear.status === 0;
  check(clearOk, harness + ' clear ' + clear.status + ' ' + clear.stderr.slice(0, 180));
  check(JSON.parse(readFileSync(state, 'utf-8')).pending === null, harness + ' clear left pending');
}

const logBefore = readFileSync(state + '.decisions/log.jsonl');
const flipped = Buffer.from(readFileSync(state));
flipped[flipped.length - 2] ^= 0x1;
writeFileSync(state, flipped);
const tampered = call('claude-code', 'pre', payload(PRE['claude-code'], 'WebFetch', {}, 'tampered', project));
check(tampered.status === 2 && tampered.stderr.includes('unmapped harness tool "WebFetch"'),
  'tampered state did not deny: ' + tampered.status + ' ' + tampered.stderr.slice(0, 200));
check(readFileSync(state + '.decisions/log.jsonl').equals(logBefore), 'tampered state extended the decision record');

rmSync(out, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  console.error(failures.length + ' failure(s)');
  process.exit(1);
}
console.log('denials-recorded: ' + HARNESSES.length + ' harnesses, chain verified, tampered state still denies');
