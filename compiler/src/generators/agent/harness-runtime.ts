// Harness adapter runtime: pure functions that turn a real agent harness's
// hook payload (Claude Code, Cursor) into a call to the generic hook.mjs, and
// hook.mjs's verdict back into the harness's expected output.
//
// These functions are emitted verbatim into <out>/agent/adapter.mjs with
// Function.prototype.toString (see adapter-template.ts), so the code tested
// here in-process is the code the harness runs. Rules for this file:
//   - every exported function is self-contained: it may call other functions
//     listed in ADAPTER_FUNCTIONS and use its parameters, nothing else
//     (no imports, no module-level constants, no classes);
//   - I/O goes through the `deps` parameter.
//
// Fail closed: anything unexpected (unknown tool, malformed payload, hook
// error, missing call id) denies the call.

/** One compiled `map` rule (agent-config.json → harness.<name>.rules). */
export interface HarnessRule {
  tools: string[];
  field?: string;
  pattern?: string;
  target: string;
  /** Every parameter of the target action, with the tool_input field it reads. */
  inputs: { param: string; field: string }[];
}

export interface AdapterConfig {
  harness?: Record<string, { rules: HarnessRule[] }>;
}

export interface HookResult { status: number | null; stdout: string; stderr: string }

export interface AdapterDeps {
  /** Run hook.mjs `pre` | `post` with the generic JSON message. */
  runHook(cmd: 'pre' | 'post', msg: Record<string, unknown>, statePath: string, keyPath: string | null): HookResult;
  /** Absolute path of a path relative to a base directory. */
  resolvePath(base: string, p: string): string;
  /** path.relative(from, to). */
  relativePath(from: string, to: string): string;
  dirname(p: string): string;
  /** Current working directory of the adapter process. */
  cwd: string;
  /** Absolute path of the adapter's own directory (<out>/agent). */
  agentDir: string;
  readFile(p: string): string | null;
  writeFile(p: string, text: string): void;
}

export interface AdapterOutput { code: number; stdout: string; stderr: string }

export type MapResult =
  | { ok: true; tool: string; input: Record<string, unknown>; rule: number }
  | { ok: false; reason: string };

/** True when a matched value could chain a second command or redirect. */
export function hasShellControl(value: string): boolean {
  return /[;&|`$<>\r\n]/.test(value);
}

/** tool_input as an object. Strings must hold JSON objects (Cursor MCP); missing means {}. */
export function parseToolInput(raw: unknown): { ok: true; input: Record<string, unknown> } | { ok: false; reason: string } {
  let v: unknown = raw;
  if (v === undefined || v === null) v = {};
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { ok: false, reason: 'tool_input is a string that is not JSON' }; }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, reason: 'tool_input must be a JSON object' };
  }
  return { ok: true, input: v as Record<string, unknown> };
}

/**
 * Map a harness tool call onto a spec tool. First matching rule wins; a
 * pattern must match the whole field value; no match is a deny.
 */
export function mapHarnessCall(rules: HarnessRule[], toolName: unknown, input: Record<string, unknown>): MapResult {
  if (typeof toolName !== 'string' || toolName === '') {
    return { ok: false, reason: 'payload has no tool_name' };
  }
  let chained = '';
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule.tools.includes(toolName)) continue;
    if (rule.field !== undefined) {
      const value = input[rule.field];
      if (typeof value !== 'string') continue;
      if (hasShellControl(value)) chained = rule.field;
      let re: RegExp;
      try { re = new RegExp('^(?:' + (rule.pattern ?? '') + ')$'); } catch { return { ok: false, reason: 'map rule ' + (i + 1) + ' has an invalid pattern' }; }
      if (!re.test(value)) continue;
      if (hasShellControl(value)) {
        return { ok: false, reason: rule.field + ' contains shell control characters (; & | ` $ < > or a newline); run one plain command per call' };
      }
    }
    const out: Record<string, unknown> = {};
    for (const m of rule.inputs) {
      if (!Object.prototype.hasOwnProperty.call(input, m.field)) {
        return { ok: false, reason: rule.target + ' needs ' + m.param + ' but tool_input has no ' + m.field };
      }
      out[m.param] = input[m.field];
    }
    return { ok: true, tool: rule.target, input: out, rule: i };
  }
  if (chained) {
    return { ok: false, reason: chained + ' contains shell control characters (; & | ` $ < > or a newline) and matches no map line; run one plain command per call' };
  }
  return {
    ok: false,
    reason: 'unmapped harness tool ' + JSON.stringify(toolName) + ' (fail closed): no map line in the spec\'s harness block matches this call',
  };
}

/**
 * First protected path that a tool input mentions, or null. Checks every
 * string except free-text content fields: substrings of absolute and
 * project-relative protected paths, and each token resolved against cwd.
 */
export function findProtectedMention(
  input: unknown,
  protectedPaths: { abs: string; rel: string }[],
  cwd: string,
  resolvePath: (base: string, p: string) => string,
): string | null {
  const contentKeys = ['content', 'new_string', 'old_string', 'new_source', 'description', 'prompt', 'edits'];
  const norm = (p: string) => p.replace(/\\/g, '/');
  const prots = protectedPaths.map(p => ({ abs: norm(p.abs), rel: norm(p.rel) }));
  const checkString = (s: string): string | null => {
    const ns = norm(s);
    for (const p of prots) {
      if (p.abs && ns.includes(p.abs)) return p.abs;
      if (p.rel && p.rel !== '.' && !p.rel.startsWith('..')) {
        // Whole path segments only: `.claude/x` hits, `my.claude` does not.
        const esc = p.rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(^|[^A-Za-z0-9_.-])' + esc + '($|[^A-Za-z0-9_.-])').test(ns)) return p.rel;
      }
    }
    for (const tok of ns.split(/[\s'"=,:()]+/)) {
      if (!tok) continue;
      const r = norm(resolvePath(cwd, tok));
      for (const p of prots) {
        if (p.abs && (r === p.abs || r.startsWith(p.abs))) return p.abs;
      }
    }
    return null;
  };
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 20) return '(input nested too deeply)';
    if (typeof v === 'string') return checkString(v);
    if (Array.isArray(v)) {
      for (const x of v) { const h = walk(x, depth + 1); if (h) return h; }
      return null;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (contentKeys.includes(k)) continue;
        const h = walk(x, depth + 1);
        if (h) return h;
      }
    }
    return null;
  };
  return walk(input, 0);
}

/**
 * hook.mjs result → allow / deny with a reason. Allow needs exit 0 AND a
 * well-formed {"decision":"allow"} line; a crash, a timeout (status null),
 * any other exit code or malformed output denies.
 */
export function interpretHook(r: HookResult): { allow: boolean; reason: string } {
  let reason = '';
  let decision = '';
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length > 0) {
    try {
      const body = JSON.parse(lines[lines.length - 1]);
      if (body && typeof body.reason === 'string') reason = body.reason;
      if (body && typeof body.decision === 'string') decision = body.decision;
    } catch { /* not JSON */ }
  }
  if (r.status === 0) {
    if (decision === 'allow') return { allow: true, reason: '' };
    return { allow: false, reason: 'speckl hook error: exit 0 without a well-formed allow decision' };
  }
  if (r.status === 2) return { allow: false, reason: reason || 'denied' };
  const detail = reason || (r.stderr || '').trim().split('\n')[0] || 'no output';
  return { allow: false, reason: 'speckl hook error (exit ' + String(r.status) + '): ' + detail };
}

/** Pre-tool verdict in the harness's format. */
export function formatPre(harness: string, allow: boolean, message: string): AdapterOutput {
  if (harness === 'cursor') {
    if (allow) return { code: 0, stdout: JSON.stringify({ permission: 'allow' }) + '\n', stderr: '' };
    return {
      code: 2,
      stdout: JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }) + '\n',
      stderr: message + '\n',
    };
  }
  // Claude Code: exit 0 with no output leaves the normal permission flow in
  // charge (Speckl never auto-approves); exit 2 blocks and shows stderr.
  if (allow) return { code: 0, stdout: '', stderr: '' };
  return { code: 2, stdout: '', stderr: message + '\n' };
}

/** Post-tool result in the harness's format; a problem is surfaced to the agent. */
export function formatPost(harness: string, problem: string | null): AdapterOutput {
  if (harness === 'cursor') {
    if (!problem) return { code: 0, stdout: '{}\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ additional_context: problem }) + '\n', stderr: problem + '\n' };
  }
  if (!problem) return { code: 0, stdout: '', stderr: '' };
  return { code: 2, stdout: '', stderr: problem + '\n' };
}

/** Did the tool succeed? Only an explicit success counts (post-failure, interrupts and non-zero exits do not). */
export function postSucceeded(harness: string, event: string, payload: Record<string, unknown>): boolean {
  if (event !== 'post') return false;
  let out: unknown = harness === 'cursor' ? payload.tool_output : payload.tool_response;
  if (typeof out === 'string') {
    try { out = JSON.parse(out); } catch { return true; }
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string, unknown>;
    if (o.interrupted === true || o.is_error === true || o.isError === true) return false;
    if (typeof o.exitCode === 'number' && o.exitCode !== 0) return false;
  }
  return true;
}

/** Hook event name each harness sends for each adapter event. */
export function harnessEventName(harness: string, event: string): string | null {
  const names: Record<string, Record<string, string>> = {
    'claude-code': { pre: 'PreToolUse', post: 'PostToolUse', 'post-failure': 'PostToolUseFailure', batch: 'PostToolBatch' },
    cursor: { pre: 'preToolUse', post: 'postToolUse', 'post-failure': 'postToolUseFailure' },
  };
  const h = names[harness];
  return h && h[event] ? h[event] : null;
}

/** Parse `--state x --key y --project z` flags. */
export function parseAdapterFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) out[a.slice(2)] = args[i + 1] ?? '';
    if (a.startsWith('--')) i++;
  }
  return out;
}

/** Shell-quote one argument for a hook command line. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./${}:@%+=-]+$/.test(s) ? s : '"' + s.replace(/(["\\`])/g, '\\$1') + '"';
}

/**
 * Hook entries for one harness. Paths are either absolute or
 * project-relative; Claude Code commands use ${CLAUDE_PROJECT_DIR}, Cursor
 * project hooks run from the project root.
 */
export function buildHarnessHooks(
  harness: string,
  paths: { adapter: string; state: string; key: string | null; relative: boolean },
): Record<string, unknown> {
  const pfx = (p: string) => (paths.relative && harness === 'claude-code' ? '${CLAUDE_PROJECT_DIR}/' + p : p);
  const cmd = (event: string) => {
    const parts = ['node', shellQuote(pfx(paths.adapter)), harness, event, '--state', shellQuote(pfx(paths.state))];
    if (paths.key) parts.push('--key', shellQuote(paths.key));
    return parts.join(' ');
  };
  if (harness === 'cursor') {
    const h = (event: string) => [{ command: cmd(event), timeout: 30, failClosed: true }];
    return {
      version: 1,
      hooks: { preToolUse: h('pre'), postToolUse: h('post'), postToolUseFailure: h('post-failure') },
    };
  }
  const group = (event: string, extra: Record<string, unknown>, matcher: boolean) => {
    const g: Record<string, unknown> = {};
    if (matcher) g.matcher = '*';
    g.hooks = [{ type: 'command', command: cmd(event), timeout: 30, ...extra }];
    return [g];
  };
  return {
    hooks: {
      PreToolUse: group('pre', { onFailure: 'block' }, true),
      PostToolUse: group('post', {}, true),
      PostToolUseFailure: group('post-failure', {}, true),
      PostToolBatch: group('batch', {}, false),
    },
  };
}

/** Merge Speckl's hook entries into an existing settings object, replacing older Speckl entries. */
export function mergeHarnessSettings(harness: string, existing: Record<string, unknown>, ours: Record<string, unknown>): Record<string, unknown> {
  const isOurs = (entry: unknown): boolean => {
    const e = entry as Record<string, unknown>;
    const cmds: string[] = [];
    if (e && typeof e.command === 'string') cmds.push(e.command);
    if (e && Array.isArray(e.hooks)) {
      for (const h of e.hooks as Record<string, unknown>[]) if (h && typeof h.command === 'string') cmds.push(h.command);
    }
    return cmds.some(c => c.includes('adapter.mjs') && c.includes(' ' + harness + ' '));
  };
  const merged: Record<string, unknown> = { ...existing };
  if (harness === 'cursor') merged.version = (existing.version as number) || 1;
  const hooks: Record<string, unknown[]> = { ...((existing.hooks as Record<string, unknown[]>) || {}) };
  const add = (ours.hooks || {}) as Record<string, unknown[]>;
  for (const ev of Object.keys(add)) {
    const prev = Array.isArray(hooks[ev]) ? hooks[ev].filter(e => !isOurs(e)) : [];
    hooks[ev] = [...prev, ...add[ev]];
  }
  merged.hooks = hooks;
  return merged;
}

/** `adapter.mjs install <harness> --project <dir> --state <file> [--key <file>]`. */
export function installHarness(harness: string, flags: Record<string, string>, deps: AdapterDeps): AdapterOutput {
  if (!flags.project || !flags.state) {
    return { code: 1, stdout: '', stderr: 'usage: adapter.mjs install ' + harness + ' --project <dir> --state <file> [--key <file>]\n' };
  }
  const project = deps.resolvePath(deps.cwd, flags.project);
  const stateAbs = deps.resolvePath(deps.cwd, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(deps.cwd, flags.key) : null;
  const rel = (p: string) => deps.relativePath(project, p).replace(/\\/g, '/');
  const inside = (p: string) => !rel(p).startsWith('..') && !/^[A-Za-z]:|^\//.test(rel(p));
  const relative = inside(deps.agentDir) && inside(stateAbs);
  const ours = buildHarnessHooks(harness, {
    adapter: relative ? rel(deps.resolvePath(deps.agentDir, 'adapter.mjs')) : deps.resolvePath(deps.agentDir, 'adapter.mjs'),
    state: relative ? rel(stateAbs) : stateAbs,
    key: keyAbs,
    relative,
  });
  const target = harness === 'cursor'
    ? deps.resolvePath(project, '.cursor/hooks.json')
    : deps.resolvePath(project, '.claude/settings.json');
  const text = deps.readFile(target);
  let existing: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    try { existing = JSON.parse(text); } catch {
      return { code: 1, stdout: '', stderr: target + ' is not valid JSON; not touching it\n' };
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { code: 1, stdout: '', stderr: target + ' is not a JSON object; not touching it\n' };
    }
  }
  const merged = mergeHarnessSettings(harness, existing, ours);
  deps.writeFile(target, JSON.stringify(merged, null, 2) + '\n');
  let warn = '';
  if (keyAbs && inside(keyAbs)) warn = 'WARN: the state key is inside the project; keep it where the agent cannot read it\n';
  if (!keyAbs) warn = 'WARN: no --key; hooks will use SPECKL_STATE_KEY_FILE from the harness environment\n';
  return { code: 0, stdout: 'Speckl ' + harness + ' hooks written to ' + target + '\n', stderr: warn };
}

/**
 * Adapter entry point: `<harness> pre|post|post-failure|batch --state <file> [--key <file>]`
 * or `install <harness> ...`. Returns what the process should print and its exit code.
 */
export function runAdapter(
  argv: string[],
  env: Record<string, string | undefined>,
  stdinText: string,
  config: AdapterConfig,
  deps: AdapterDeps,
): AdapterOutput {
  const harnesses = config.harness || {};
  if (argv[0] === 'install') {
    const h = argv[1] || '';
    if (!harnesses[h]) {
      return { code: 1, stdout: '', stderr: 'unknown or undeclared harness ' + JSON.stringify(h) + ' (declared: ' + (Object.keys(harnesses).join(', ') || 'none') + ')\n' };
    }
    return installHarness(h, parseAdapterFlags(argv.slice(2)), deps);
  }
  const harness = argv[0] || '';
  const event = argv[1] || '';
  const flags = parseAdapterFlags(argv.slice(2));
  const isPre = event === 'pre';
  const fail = (reason: string): AdapterOutput => {
    const msg = 'Speckl: ' + reason;
    if (event === 'batch') return { code: 0, stdout: '', stderr: msg + '\n' };
    if (isPre || harnessEventName(harness, event) === null) {
      return { code: 2, stdout: harness === 'cursor' ? formatPre('cursor', false, msg).stdout : '', stderr: msg + '\n' };
    }
    return formatPost(harness, msg);
  };
  if (!harnesses[harness]) {
    return fail('harness ' + JSON.stringify(harness) + ' is not declared in the spec (declared: ' + (Object.keys(harnesses).join(', ') || 'none') + ')');
  }
  const expected = harnessEventName(harness, event);
  if (!expected) return fail('unknown event ' + JSON.stringify(event) + ' for ' + harness);
  const rules = harnesses[harness].rules;

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdinText || '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('hook payload is not a JSON object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return fail('hook payload is not JSON');
  }
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== expected) {
    return fail('payload is ' + JSON.stringify(payload.hook_event_name) + ' but this hook is wired as ' + expected);
  }
  if (!flags.state) return fail('missing --state');

  const projectDir = flags.project
    || (harness === 'cursor' ? env.CURSOR_PROJECT_DIR : env.CLAUDE_PROJECT_DIR)
    || (typeof payload.cwd === 'string' ? payload.cwd : '')
    || deps.cwd;
  const stateAbs = deps.resolvePath(projectDir, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(projectDir, flags.key) : null;
  const callCwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : projectDir;

  const protectedAbs = [deps.agentDir, stateAbs];
  if (keyAbs) protectedAbs.push(keyAbs);
  if (env.SPECKL_STATE_KEY_FILE) protectedAbs.push(deps.resolvePath(projectDir, env.SPECKL_STATE_KEY_FILE));
  const stateDir = deps.dirname(stateAbs);
  if (stateDir !== projectDir && deps.resolvePath(stateDir, '.') !== deps.resolvePath(projectDir, '.')) protectedAbs.push(stateDir);
  protectedAbs.push(deps.resolvePath(projectDir, '.claude'), deps.resolvePath(projectDir, '.cursor'));
  const protectedPaths = protectedAbs.map(abs => {
    const r = deps.relativePath(projectDir, abs).replace(/\\/g, '/');
    return { abs, rel: r.startsWith('..') ? '' : r };
  });

  if (event === 'batch') {
    const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls as Record<string, unknown>[] : [];
    let cleared = 0;
    for (const c of calls) {
      if (!c || typeof c !== 'object' || typeof c.tool_use_id !== 'string') continue;
      const pin = parseToolInput(c.tool_input);
      if (!pin.ok) continue;
      const m = mapHarnessCall(rules, c.tool_name, pin.input);
      if (!m.ok) continue;
      const r = deps.runHook('post', { tool: m.tool, input: m.input, call_id: c.tool_use_id, ok: false }, stateAbs, keyAbs);
      if (r.status === 0) cleared++;
    }
    if (cleared === 0) return { code: 0, stdout: '', stderr: '' };
    const note = 'Speckl cleared ' + cleared + ' tool call(s) that never reported a result (declined or interrupted); they were recorded as failed and did not advance the policy.';
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: note } }) + '\n', stderr: '' };
  }

  const toolName = payload.tool_name;
  const callId = payload.tool_use_id;
  const pin = parseToolInput(payload.tool_input);
  if (!pin.ok) return fail(pin.reason);
  const label = typeof toolName === 'string' ? toolName : '(no tool_name)';

  if (isPre) {
    const hit = findProtectedMention(pin.input, protectedPaths, callCwd, deps.resolvePath);
    if (hit) return fail(label + ' touches a Speckl-protected path (' + hit + '); the agent may not read or change its own rails');
  }
  const m = mapHarnessCall(rules, toolName, pin.input);
  if (!m.ok) {
    if (isPre) return fail(m.reason);
    return fail(label + ' ran without a Speckl mapping (' + m.reason + '); its pre hook should have denied it');
  }
  if (typeof callId !== 'string' || callId === '') return fail('payload has no tool_use_id');

  if (isPre) {
    const r = interpretHook(deps.runHook('pre', { tool: m.tool, input: m.input, call_id: callId }, stateAbs, keyAbs));
    if (r.allow) return formatPre(harness, true, '');
    return formatPre(harness, false, 'Speckl denied ' + label + ' (spec tool ' + m.tool + '): ' + r.reason);
  }
  const ok = postSucceeded(harness, event, payload);
  const r = interpretHook(deps.runHook('post', { tool: m.tool, input: m.input, call_id: callId, ok }, stateAbs, keyAbs));
  if (r.allow) return formatPost(harness, null);
  return formatPost(harness, 'Speckl could not record ' + label + ' (spec tool ' + m.tool + '): ' + r.reason);
}

/** Functions emitted into adapter.mjs, in order. */
export const ADAPTER_FUNCTIONS = [
  hasShellControl, parseToolInput, mapHarnessCall, findProtectedMention, interpretHook,
  formatPre, formatPost, postSucceeded, harnessEventName, parseAdapterFlags, shellQuote,
  buildHarnessHooks, mergeHarnessSettings, installHarness, runAdapter,
];
