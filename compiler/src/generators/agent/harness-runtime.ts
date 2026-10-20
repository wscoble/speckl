// Harness adapter runtime: pure functions that turn a real agent harness's
// hook payload (Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot CLI,
// Goose, Hermes Agent, Pi, OpenCode, OpenClaw, Cline) into a call to the generic
// hook.mjs, and hook.mjs's verdict back into the harness's expected output.
// Pi, OpenCode and OpenClaw have in-process plugin APIs instead of command
// hooks; `install` writes a small generated plugin (pluginSource) that pipes
// each event to this adapter and blocks unless it answers an explicit allow.
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
  /** Write a file (creating directories); `mode` (e.g. 0o755) also chmods it. */
  writeFile(p: string, text: string, mode?: number): void;
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
  const contentKeys = ['content', 'new_string', 'old_string', 'new_source', 'description', 'prompt', 'edits', 'file_text', 'new_str', 'old_str', 'before', 'after', 'oldString', 'newString', 'old_text', 'new_text'];
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
  // Copilot CLI denies on exit 2 whatever stdout says; the JSON carries the
  // reason in both the CLI shape and the VS Code-compatible shape.
  if (harness === 'copilot') {
    if (allow) return { code: 0, stdout: '', stderr: '' };
    return {
      code: 2,
      stdout: JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: message,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
      }) + '\n',
      stderr: message + '\n',
    };
  }
  // Goose and Hermes: exit 2 denies (reason from stderr), and so does a
  // {"decision":"block"} line on stdout; exit 0 with empty stdout allows.
  if (harness === 'goose' || harness === 'hermes') {
    if (allow) return { code: 0, stdout: '', stderr: '' };
    return { code: 2, stdout: JSON.stringify({ decision: 'block', reason: message }) + '\n', stderr: message + '\n' };
  }
  // Pi, OpenCode, OpenClaw: the generated plugin allows only on exit 0 with
  // a {"decision":"allow"} line; anything else blocks with the reason.
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    if (allow) return { code: 0, stdout: JSON.stringify({ decision: 'allow' }) + '\n', stderr: '' };
    return { code: 2, stdout: JSON.stringify({ decision: 'block', reason: message }) + '\n', stderr: message + '\n' };
  }
  // Cline file hooks: only a {"cancel":true} JSON line on stdout blocks
  // (the exit code is ignored); the generated wrapper script turns anything
  // but an exact {"cancel":false} into a cancel.
  if (harness === 'cline') {
    if (allow) return { code: 0, stdout: JSON.stringify({ cancel: false }) + '\n', stderr: '' };
    return { code: 2, stdout: JSON.stringify({ cancel: true, errorMessage: message }) + '\n', stderr: message + '\n' };
  }
  // Gemini CLI parses stdout as JSON on exit 0; `{}` is "no decision".
  if (harness === 'gemini') {
    if (allow) return { code: 0, stdout: '{}\n', stderr: '' };
    return { code: 2, stdout: '', stderr: message + '\n' };
  }
  // Claude Code and Codex: exit 0 with no output leaves the normal permission
  // flow in charge (Speckl never auto-approves); exit 2 blocks and shows stderr.
  if (allow) return { code: 0, stdout: '', stderr: '' };
  return { code: 2, stdout: '', stderr: message + '\n' };
}

/** Post-tool result in the harness's format; a problem is surfaced to the agent. */
export function formatPost(harness: string, problem: string | null): AdapterOutput {
  if (harness === 'cursor') {
    if (!problem) return { code: 0, stdout: '{}\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ additional_context: problem }) + '\n', stderr: problem + '\n' };
  }
  // Codex / Gemini: exit 2 on a post hook replaces or hides the tool result,
  // so problems go to the agent as additionalContext with exit 0.
  if (harness === 'codex' || harness === 'gemini') {
    const ev = harness === 'codex' ? 'PostToolUse' : 'AfterTool';
    if (!problem) return { code: 0, stdout: harness === 'gemini' ? '{}\n' : '', stderr: '' };
    return {
      code: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: problem } }) + '\n',
      stderr: problem + '\n',
    };
  }
  // Copilot CLI appends additionalContext to the tool result the model sees.
  if (harness === 'copilot') {
    if (!problem) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ additionalContext: problem }) + '\n', stderr: problem + '\n' };
  }
  // Pi and OpenCode plugins append additionalContext to the tool result the
  // model sees; OpenClaw's after_tool_call is an observer, so its plugin logs it.
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    if (!problem) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ additionalContext: problem }) + '\n', stderr: problem + '\n' };
  }
  // Cline PostToolUse: contextModification is added to the conversation;
  // a cancel would stop the whole task, so a post problem never cancels.
  if (harness === 'cline') {
    const body: Record<string, unknown> = { cancel: false };
    if (problem) body.contextModification = problem;
    return { code: 0, stdout: JSON.stringify(body) + '\n', stderr: problem ? problem + '\n' : '' };
  }
  // Goose and Hermes post hooks are observers: their output is ignored, so
  // a problem is logged on stderr and the hook exits 0.
  if (harness === 'goose' || harness === 'hermes') {
    return { code: 0, stdout: '', stderr: problem ? problem + '\n' : '' };
  }
  if (!problem) return { code: 0, stdout: '', stderr: '' };
  return { code: 2, stdout: '', stderr: problem + '\n' };
}

/** Did the tool succeed? Only an explicit success counts (post-failure, interrupts and non-zero exits do not). */
export function postSucceeded(harness: string, event: string, payload: Record<string, unknown>): boolean {
  if (event !== 'post') return false;
  const toolName = payload.tool_name;
  let out: unknown = harness === 'cursor' ? payload.tool_output : payload.tool_response;
  if (harness === 'codex') {
    // Codex hands PostToolUse the Bash command's output text only, without
    // its exit status, so a shell call can never count as a success.
    if (toolName === 'Bash') return false;
    if (toolName === 'apply_patch') return typeof out === 'string' && /^Exit code: 0(\n|$)/.test(out);
  }
  if (harness === 'copilot') {
    // postToolUse fires for successful calls only, with toolResult
    // {resultType: "success", textResultForLlm}. A shell result ends with
    // `<exited with exit code N>`; anything else (async, detached) is not a success.
    const tr = (payload.toolResult ?? payload.tool_result) as Record<string, unknown> | undefined;
    if (!tr || typeof tr !== 'object' || Array.isArray(tr)) return false;
    if ((tr.resultType ?? tr.result_type) !== 'success') return false;
    if (toolName === 'bash' || toolName === 'powershell') {
      const text = tr.textResultForLlm ?? tr.text_result_for_llm;
      return typeof text === 'string' && /<exited with exit code 0>\s*$/.test(text);
    }
    return true;
  }
  // Goose fires PostToolUse only when the tool result is not an error (a
  // non-zero shell exit or a timeout is an error) and PostToolUseFailure otherwise.
  if (harness === 'goose') return true;
  if (harness === 'hermes') {
    // post_tool_call fires for every outcome; extra.status is "ok" only when
    // the result carries no error. A terminal call also needs exit_code 0.
    const extra = payload.extra as Record<string, unknown> | undefined;
    if (!extra || typeof extra !== 'object' || extra.status !== 'ok') return false;
    let res: unknown = extra.result;
    if (typeof res === 'string') {
      try { res = JSON.parse(res); } catch { return toolName !== 'terminal'; }
    }
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      const o = res as Record<string, unknown>;
      if (o.success === false) return false;
      if (toolName === 'terminal') return o.exit_code === 0 && (o.error === undefined || o.error === null || o.error === '');
      return true;
    }
    return toolName !== 'terminal';
  }
  if (harness === 'pi') {
    // tool_result fires for every executed call; isError is true for a
    // thrown tool and for a non-zero shell exit. A shell result must also
    // carry structuredContent.exit_code 0.
    if (payload.isError !== false) return false;
    if (toolName === 'bash' || toolName === 'powershell') {
      const sc = payload.structuredContent as Record<string, unknown> | undefined;
      return !!sc && typeof sc === 'object' && !Array.isArray(sc) && sc.exit_code === 0;
    }
    return true;
  }
  if (harness === 'opencode') {
    // tool.execute.after fires only when the tool returned (a thrown tool
    // reaches the plugin as a message.part.updated error, post-failure). A
    // shell result needs metadata.exit 0 (null on timeout or abort).
    const o = payload.output as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    if (toolName === 'bash') {
      const md = o.metadata as Record<string, unknown> | undefined;
      return !!md && typeof md === 'object' && md.exit === 0;
    }
    return true;
  }
  if (harness === 'openclaw') {
    // after_tool_call carries an optional result and error; both missing is
    // not a success. exec needs details {status: "completed", exitCode: 0}
    // (a yielded command reports status "running").
    const ev = payload.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev !== 'object') return false;
    if (ev.error !== undefined && ev.error !== null && ev.error !== '') return false;
    const res = ev.result as Record<string, unknown> | undefined;
    if (!res || typeof res !== 'object' || Array.isArray(res)) return false;
    if (res.isError === true) return false;
    const d = res.details as Record<string, unknown> | undefined;
    if (d && typeof d === 'object' && (d.status === 'error' || d.status === 'failed')) return false;
    if (toolName === 'exec' || toolName === 'bash') {
      return !!d && typeof d === 'object' && d.status === 'completed' && d.exitCode === 0;
    }
    return true;
  }
  if (harness === 'cline') {
    // CLI: tool_result {output, error}; a failed run_commands entry is
    // {success: false, error} inside output without a tool error, so every
    // entry must say success: true. VS Code: postToolUse {result, success}
    // where result is String(output) ("[object Object]" for run_commands,
    // so a shell call there never counts as a success).
    const ok = (o: unknown): boolean => {
      if (Array.isArray(o)) return o.length > 0 && o.every(e => !!e && typeof e === 'object' && !Array.isArray(e) && (e as Record<string, unknown>).success === true);
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        if (r.success === false || r.isError === true) return false;
        if (r.error !== undefined && r.error !== null && r.error !== '') return false;
        return true;
      }
      return toolName !== 'run_commands';
    };
    const tr = payload.tool_result as Record<string, unknown> | undefined;
    if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
      if (tr.error !== undefined && tr.error !== null && tr.error !== '') return false;
      return ok(tr.output);
    }
    const pt = payload.postToolUse as Record<string, unknown> | undefined;
    if (!pt || typeof pt !== 'object' || pt.success !== true) return false;
    let res: unknown = pt.result;
    if (typeof res === 'string') {
      try { res = JSON.parse(res); } catch { return toolName !== 'run_commands'; }
    }
    return ok(res);
  }
  if (harness === 'gemini') {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return false;
    const r = out as Record<string, unknown>;
    if (r.error !== undefined && r.error !== null && r.error !== false) return false;
    if (toolName === 'run_shell_command') {
      const text = typeof r.llmContent === 'string' ? r.llmContent : '';
      if (!/^Output:/.test(text)) return false;
      if (/^(Exit Code|Signal|Error):/m.test(text)) return false;
    }
    return true;
  }
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
    codex: { pre: 'PreToolUse', post: 'PostToolUse', 'turn-end': 'Stop' },
    gemini: { pre: 'BeforeTool', post: 'AfterTool', 'turn-end': 'AfterAgent' },
    copilot: { pre: 'preToolUse', post: 'postToolUse', 'post-failure': 'postToolUseFailure', 'turn-end': 'agentStop' },
    goose: { pre: 'PreToolUse', post: 'PostToolUse', 'post-failure': 'PostToolUseFailure', 'turn-end': 'Stop' },
    hermes: { pre: 'pre_tool_call', post: 'post_tool_call', 'turn-end': 'on_session_end' },
    pi: { pre: 'tool_call', post: 'tool_result', 'turn-end': 'agent_end' },
    opencode: { pre: 'tool.execute.before', post: 'tool.execute.after', 'post-failure': 'message.part.updated', 'turn-end': 'session.idle' },
    openclaw: { pre: 'before_tool_call', post: 'after_tool_call', 'turn-end': 'session_end' },
    cline: { pre: 'PreToolUse', post: 'PostToolUse', 'turn-end': 'TaskComplete' },
  };
  const h = names[harness];
  return h && h[event] ? h[event] : null;
}

/**
 * Harness-specific additions to tool_input before mapping. Codex and Copilot
 * apply_patch carry the whole patch in one string; expose the files it
 * touches as `files` and the first one as `path`.
 */
export function normalizeToolInput(harness: string, toolName: unknown, input: Record<string, unknown>): Record<string, unknown> {
  // Copilot CLI apply_patch carries the same patch format in `input` (or
  // `patch`), OpenClaw in `input`, OpenCode in `patchText`.
  const patch = harness === 'codex' ? input.command
    : harness === 'copilot' ? (input.input ?? input.patch)
      : harness === 'openclaw' ? input.input
        : harness === 'opencode' ? input.patchText : undefined;
  if (harness === 'cline' && toolName === 'run_commands') {
    // {commands: ["npm test"]} (or command / cmd): a single plain command is
    // exposed as `command`; several commands, or structured {command, args}
    // entries, leave `command` unset so no command map line matches.
    const out: Record<string, unknown> = { ...input };
    delete out.command;
    const list = Array.isArray(input.commands) ? input.commands
      : typeof input.commands === 'string' ? [input.commands]
        : typeof input.command === 'string' ? [input.command]
          : typeof input.cmd === 'string' ? [input.cmd] : [];
    if (list.length === 1 && typeof list[0] === 'string') out.command = list[0];
    return out;
  }
  const clinePatch = harness === 'cline' ? input.input : undefined;
  if (toolName === 'apply_patch' && typeof (patch ?? clinePatch) === 'string') {
    const text = (patch ?? clinePatch) as string;
    const files: string[] = [];
    const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) files.push(m[1].trim());
    const out: Record<string, unknown> = { ...input, files };
    if (files.length > 0) out.path = files[0];
    return out;
  }
  return input;
}

/**
 * The call id hook.mjs pairs pre and post with. Gemini CLI and Copilot CLI
 * send none, so one is derived from the session and tool name (the same on
 * the pre and post event; hook.mjs holds a single pending call, so it cannot
 * collide). Goose and Hermes ids arrive as tool_use_id via normalizePayload.
 */
export function harnessCallId(harness: string, payload: Record<string, unknown>): string | null {
  const given = payload.tool_use_id;
  if (harness === 'copilot' && typeof given === 'string' && given !== '') return given;
  if (harness === 'cline' && typeof given === 'string' && given !== '') return given;
  if (harness === 'gemini' || harness === 'copilot' || harness === 'cline') {
    if (typeof payload.tool_name !== 'string' || payload.tool_name === '') return null;
    const text = String(payload.session_id ?? '') + '\u0000' + payload.tool_name;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return harness + '-' + h.toString(16).padStart(8, '0');
  }
  return typeof given === 'string' && given !== '' ? given : null;
}

/** Where `install` writes each harness's wiring, relative to the project. */
export function harnessConfigFile(harness: string): string {
  const files: Record<string, string> = {
    'claude-code': '.claude/settings.json',
    cursor: '.cursor/hooks.json',
    codex: '.codex/hooks.json',
    gemini: '.gemini/settings.json',
    copilot: '.github/hooks/speckl.json',
    goose: '.agents/plugins/speckl/hooks/hooks.json',
    // Relative to the Hermes profile directory (--hermes-home), not the project.
    hermes: 'config.yaml',
    // Generated plugins (pluginSource), not hook configs.
    pi: '.pi/extensions/speckl.js',
    opencode: '.opencode/plugins/speckl.js',
    openclaw: '.openclaw/plugins/speckl/index.js',
    // Executable hook scripts named after the event (clineScripts).
    cline: '.clinerules/hooks/PreToolUse',
  };
  return files[harness] || '';
}

/** Harness config directories no tool may touch: the base four plus those of each declared harness. */
export function harnessProtectedDirs(harnesses: string[]): string[] {
  const dirs = ['.claude', '.cursor', '.codex', '.gemini'];
  const extra: Record<string, string[]> = {
    copilot: ['.github/hooks'],
    goose: ['.agents/plugins', '.config/goose'],
    hermes: ['.hermes'],
    pi: ['.pi'],
    opencode: ['.opencode', 'opencode.json', 'opencode.jsonc'],
    openclaw: ['.openclaw'],
    cline: ['.clinerules/hooks', '.cline'],
  };
  for (const h of harnesses) for (const d of extra[h] || []) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

/**
 * Bring a harness payload to the shape the rest of the adapter reads
 * (hook_event_name, tool_name, tool_input, tool_use_id, cwd). Copilot CLI
 * camelCase payloads use toolName/toolArgs/sessionId; its VS Code-compatible
 * payloads use PascalCase event names. Goose sends `event`, `tool_call_id`
 * and `working_dir`; Hermes puts the call id in `extra.tool_call_id`.
 */
export function normalizePayload(harness: string, payload: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...payload };
  if (harness === 'copilot') {
    if (p.tool_name === undefined && p.toolName !== undefined) p.tool_name = p.toolName;
    if (p.tool_input === undefined && p.toolArgs !== undefined) p.tool_input = p.toolArgs;
    if (p.session_id === undefined && p.sessionId !== undefined) p.session_id = p.sessionId;
    const pascal: Record<string, string> = {
      PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', PostToolUseFailure: 'postToolUseFailure', Stop: 'agentStop',
    };
    if (typeof p.hook_event_name === 'string' && pascal[p.hook_event_name]) p.hook_event_name = pascal[p.hook_event_name];
  }
  if (harness === 'goose') {
    if (p.hook_event_name === undefined) p.hook_event_name = p.event === undefined ? null : p.event;
    if (p.tool_use_id === undefined) p.tool_use_id = p.tool_call_id;
    if (p.cwd === undefined && typeof p.working_dir === 'string') p.cwd = p.working_dir;
  }
  if (harness === 'hermes') {
    const extra = p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra) ? p.extra as Record<string, unknown> : {};
    if (p.tool_use_id === undefined) p.tool_use_id = extra.tool_call_id;
  }
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  if (harness === 'pi') {
    // The plugin forwards pi's event ({type, toolName, toolCallId, input, ...}) plus ctx.cwd.
    if (p.hook_event_name === undefined) p.hook_event_name = p.type === undefined ? null : p.type;
    if (p.tool_name === undefined) p.tool_name = p.toolName;
    if (p.tool_input === undefined) p.tool_input = p.input;
    if (p.tool_use_id === undefined) p.tool_use_id = p.toolCallId;
  }
  if (harness === 'opencode') {
    // tool.execute.*: {hook, input: {tool, sessionID, callID[, args]}, output, directory};
    // bus events: {type, properties, directory}.
    if (p.hook_event_name === undefined) p.hook_event_name = p.hook !== undefined ? p.hook : p.type === undefined ? null : p.type;
    if (p.hook_event_name === 'message.part.updated') {
      const part = obj(obj(p.properties).part);
      if (p.tool_name === undefined) p.tool_name = part.tool;
      if (p.tool_input === undefined) p.tool_input = obj(part.state).input;
      if (p.tool_use_id === undefined) p.tool_use_id = part.callID;
      if (p.session_id === undefined) p.session_id = part.sessionID;
    } else {
      const inp = obj(p.input);
      if (p.tool_name === undefined) p.tool_name = inp.tool;
      if (p.tool_input === undefined) p.tool_input = p.hook_event_name === 'tool.execute.before' ? obj(p.output).args : inp.args;
      if (p.tool_use_id === undefined) p.tool_use_id = inp.callID;
      if (p.session_id === undefined) p.session_id = inp.sessionID;
    }
    if (p.cwd === undefined && typeof p.directory === 'string') p.cwd = p.directory;
  }
  if (harness === 'openclaw') {
    // {hook, event: {toolName, params, toolCallId, ...}, ctx: {sessionId, toolCallId, ...}}
    const ev = obj(p.event);
    const ctx = obj(p.ctx);
    if (p.hook_event_name === undefined) p.hook_event_name = p.hook === undefined ? null : p.hook;
    if (p.tool_name === undefined) p.tool_name = ev.toolName;
    if (p.tool_input === undefined) p.tool_input = ev.params;
    if (p.tool_use_id === undefined) p.tool_use_id = ev.toolCallId !== undefined ? ev.toolCallId : ctx.toolCallId;
    if (p.session_id === undefined) p.session_id = ctx.sessionId;
  }
  if (harness === 'cline') {
    // CLI / SDK: {hookName: "tool_call"|"tool_result"|"agent_end"|..., taskId,
    // workspaceRoots, tool_call|tool_result: {id, name, input, ...},
    // preToolUse|postToolUse: {toolName, parameters}}. VS Code: hookName
    // "PreToolUse"|"PostToolUse"|..., preToolUse|postToolUse only, with every
    // parameter value as a string (JSON for non-strings).
    const names: Record<string, string> = {
      tool_call: 'PreToolUse', tool_result: 'PostToolUse', agent_end: 'TaskComplete', agent_abort: 'TaskComplete', agent_error: 'TaskComplete',
      PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', TaskComplete: 'TaskComplete', TaskCancel: 'TaskComplete', TaskError: 'TaskComplete',
    };
    if (p.hook_event_name === undefined) p.hook_event_name = typeof p.hookName === 'string' ? (names[p.hookName] || p.hookName) : null;
    const call = obj(p.tool_call !== undefined ? p.tool_call : p.tool_result);
    const legacy = obj(p.preToolUse !== undefined ? p.preToolUse : p.postToolUse);
    if (p.tool_name === undefined) p.tool_name = call.name !== undefined ? call.name : legacy.toolName;
    if (p.tool_input === undefined) {
      if (call.input !== undefined) p.tool_input = call.input;
      else if (legacy.parameters && typeof legacy.parameters === 'object' && !Array.isArray(legacy.parameters)) {
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(legacy.parameters as Record<string, unknown>)) {
          let x: unknown = v;
          if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { x = JSON.parse(v); } catch { x = v; } }
          params[k] = x;
        }
        p.tool_input = params;
      }
    }
    if (p.tool_use_id === undefined && typeof call.id === 'string') p.tool_use_id = call.id;
    if (p.session_id === undefined) p.session_id = p.taskId;
    const roots = Array.isArray(p.workspaceRoots) ? p.workspaceRoots : [];
    if (p.cwd === undefined && typeof roots[0] === 'string') p.cwd = roots[0];
  }
  return p;
}

/**
 * Cline hook scripts for `.clinerules/hooks/`, by file name. Cline runs a
 * file named after the event and blocks only on a {"cancel": true} JSON line
 * (a crash, a timeout or a non-zero exit lets the call through), so the
 * PreToolUse wrapper prints {"cancel":false} only when the adapter exits 0
 * with exactly that, passes the adapter's own cancel through, and cancels on
 * anything else. `timeout 25` (when available) keeps the adapter inside
 * Cline's own hook timeout (30 s in VS Code, 120 s in the CLI).
 */
export function clineScripts(ours: Record<string, unknown>): Record<string, string> {
  const cmds = (ours.commands || {}) as Record<string, string>;
  const head = [
    '#!/bin/sh',
    '# Generated by speckl adapter.mjs install cline; do not edit (rerun install).',
    'T=""; command -v timeout >/dev/null 2>&1 && T="timeout 25"',
  ];
  const pre = [
    ...head,
    '# Anything other than an explicit allow from the adapter cancels the call.',
    'out=$($T ' + cmds.pre + ')',
    'st=$?',
    'last=$(printf "%s\\n" "$out" | tail -n 1)',
    'if [ "$st" -eq 0 ] && [ "$last" = \'{"cancel":false}\' ]; then printf \'%s\\n\' \'{"cancel":false}\'; exit 0; fi',
    'case "$last" in \'{"cancel":true,\'*) printf \'%s\\n\' "$last"; exit 0 ;; esac',
    'printf \'%s\\n\' \'{"cancel":true,"errorMessage":"Speckl: the adapter failed (exit \'"$st"\'), so the tool call is blocked. Check node and the .speckl files."}\'',
    'exit 0',
  ];
  const post = [
    ...head,
    'out=$($T ' + cmds.post + ')',
    'last=$(printf "%s\\n" "$out" | tail -n 1)',
    'case "$last" in \'{"cancel":false}\'|\'{"cancel":false,"contextModification":"\'*\'"}\') printf \'%s\\n\' "$last"; exit 0 ;; esac',
    'printf \'%s\\n\' \'{"cancel":false,"contextModification":"Speckl: the adapter failed to record this tool result; the policy did not advance."}\'',
    'exit 0',
  ];
  const end = [...head, '$T ' + cmds['turn-end'] + ' >/dev/null', 'exit 0'];
  const j = (l: string[]) => l.join('\n') + '\n';
  return { PreToolUse: j(pre), PostToolUse: j(post), TaskComplete: j(end), TaskCancel: j(end), TaskError: j(end) };
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
 * project-relative; Claude Code commands use ${CLAUDE_PROJECT_DIR}, Gemini
 * ${GEMINI_PROJECT_DIR}; Cursor project hooks run from the project root.
 * Codex and Gemini run hooks from the session cwd, so `install` writes
 * absolute paths for them.
 */
export function buildHarnessHooks(
  harness: string,
  paths: { adapter: string; state: string; key: string | null; relative: boolean; project?: string; hermesHome?: string; outsideAllow?: boolean },
): Record<string, unknown> {
  const envDir = harness === 'claude-code' ? '${CLAUDE_PROJECT_DIR}/' : harness === 'gemini' ? '${GEMINI_PROJECT_DIR}/' : '';
  const pfx = (p: string) => (paths.relative ? envDir + p : p);
  const cmd = (event: string) => {
    const parts = ['node', shellQuote(pfx(paths.adapter)), harness, event, '--state', shellQuote(pfx(paths.state))];
    if (paths.key) parts.push('--key', shellQuote(paths.key));
    // Pin the project root when the harness only reports the session cwd.
    if (paths.project) parts.push('--project', shellQuote(paths.project));
    if (paths.hermesHome) parts.push('--hermes-home', shellQuote(paths.hermesHome));
    // A user-scope Goose plugin sees every session; calls from sessions
    // outside the project are not this spec's to judge.
    if (paths.outsideAllow) parts.push('--outside', 'allow');
    return parts.join(' ');
  };
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    // In-process plugin harnesses: the generated plugin (pluginSource) runs
    // `node <argv[0]> <harness> <event> <argv[1..]>`. With `relative`, the
    // adapter and state paths are resolved against the project root the
    // plugin file sits in.
    const argv = [paths.adapter, '--state', paths.state];
    if (paths.key) argv.push('--key', paths.key);
    if (paths.project) argv.push('--project', paths.project);
    if (paths.outsideAllow) argv.push('--outside', 'allow');
    return { plugin: harness, argv, relative: paths.relative };
  }
  if (harness === 'cline') {
    // Command lines for the hook scripts clineScripts writes; stdin passes through.
    return { commands: { pre: cmd('pre'), post: cmd('post'), 'turn-end': cmd('turn-end') } };
  }
  if (harness === 'copilot') {
    // Copilot CLI / cloud agent: .github/hooks/*.json, camelCase events.
    // preToolUse denies on exit 2, a crash or any other non-zero exit; only a
    // timeout lets the call through, so the adapter's own hook.mjs timeout
    // (20s) stays well inside timeoutSec. `|| exit 2` also covers node missing.
    const h = (event: string, block: boolean) => [{ type: 'command', bash: cmd(event) + (block ? ' || exit 2' : ''), timeoutSec: 30 }];
    return {
      version: 1,
      hooks: { preToolUse: h('pre', true), postToolUse: h('post', false), postToolUseFailure: h('post-failure', false), agentStop: h('turn-end', false) },
    };
  }
  if (harness === 'goose') {
    // Goose plugin hooks/hooks.json. on_failure "block" turns a spawn error,
    // timeout, signal or undecodable output on PreToolUse into a deny; the
    // matcher is a regex (a bare "*" is invalid and skips the rule).
    const hook = (event: string, block: boolean) => {
      const h: Record<string, unknown> = { type: 'command', command: cmd(event) + (block ? ' || exit 2' : ''), timeout: 30 };
      if (block) h.on_failure = 'block';
      return h;
    };
    return {
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [hook('pre', true)] }],
        PostToolUse: [{ matcher: '.*', hooks: [hook('post', false)] }],
        PostToolUseFailure: [{ matcher: '.*', hooks: [hook('post-failure', false)] }],
        Stop: [{ hooks: [hook('turn-end', false)] }],
      },
    };
  }
  if (harness === 'hermes') {
    // Hermes config.yaml `hooks:` block. Commands are split without a shell,
    // so there is no `|| exit 2`; fail_closed on pre_tool_call blocks on a
    // missing command, a timeout, a non-zero exit without a directive and
    // non-JSON stdout instead.
    return {
      hooks: {
        pre_tool_call: [{ command: cmd('pre'), timeout: 30, fail_closed: true }],
        post_tool_call: [{ command: cmd('post'), timeout: 30 }],
        on_session_end: [{ command: cmd('turn-end'), timeout: 30 }],
      },
    };
  }
  if (harness === 'cursor') {
    const h = (event: string) => [{ command: cmd(event), timeout: 30, failClosed: true }];
    return {
      version: 1,
      hooks: { preToolUse: h('pre'), postToolUse: h('post'), postToolUseFailure: h('post-failure') },
    };
  }
  if (harness === 'codex' || harness === 'gemini') {
    // Neither harness has a fail-closed switch: any exit other than 2 lets
    // the call through. `|| exit 2` turns a failure to start the adapter
    // (node missing, exit 127) into a block.
    const ms = harness === 'gemini';
    const hook = (event: string, block: boolean) => {
      const h: Record<string, unknown> = { type: 'command', command: cmd(event) + (block ? ' || exit 2' : ''), timeout: ms ? 30000 : 30 };
      if (ms) h.name = 'speckl-' + event;
      return h;
    };
    const ev = harnessEventName;
    // Gemini matchers are regular expressions; Codex also accepts "*".
    const any = ms ? '.*' : '*';
    return {
      hooks: {
        [ev(harness, 'pre') as string]: [{ matcher: any, hooks: [hook('pre', true)] }],
        [ev(harness, 'post') as string]: [{ matcher: any, hooks: [hook('post', false)] }],
        [ev(harness, 'turn-end') as string]: [{ hooks: [hook('turn-end', false)] }],
      },
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
    if (e && typeof e.bash === 'string') cmds.push(e.bash);
    if (e && Array.isArray(e.hooks)) {
      for (const h of e.hooks as Record<string, unknown>[]) if (h && typeof h.command === 'string') cmds.push(h.command);
    }
    return cmds.some(c => c.includes('adapter.mjs') && c.includes(' ' + harness + ' '));
  };
  const merged: Record<string, unknown> = { ...existing };
  if (harness === 'cursor' || harness === 'copilot') merged.version = (existing.version as number) || 1;
  const hooks: Record<string, unknown[]> = { ...((existing.hooks as Record<string, unknown[]>) || {}) };
  const add = (ours.hooks || {}) as Record<string, unknown[]>;
  for (const ev of Object.keys(add)) {
    const prev = Array.isArray(hooks[ev]) ? hooks[ev].filter(e => !isOurs(e)) : [];
    hooks[ev] = [...prev, ...add[ev]];
  }
  merged.hooks = hooks;
  return merged;
}

/**
 * The generated plugin for Pi, OpenCode or OpenClaw, from buildHarnessHooks's
 * {argv, relative}. It pipes every tool event to adapter.mjs with
 * spawnSync('node', ...) and allows a call only when the adapter exits 0
 * with {"decision":"allow"}; a crash, a timeout, a signal, a missing node,
 * unparsable output or an unserialisable payload blocks it. The plugin
 * imports only node:child_process (and node:url/node:path when relative), so
 * it has nothing that can fail to load besides itself.
 */
export function pluginSource(harness: string, ours: Record<string, unknown>): string {
  const argv = (ours.argv || []) as string[];
  const relative = ours.relative === true;
  const up: Record<string, string> = { pi: '../../', opencode: '../../', openclaw: '../../../' };
  const pathAt = (i: number) => i === 0 || (i > 0 && (argv[i - 1] === '--state' || argv[i - 1] === '--key'));
  const lit = argv.map((a, i) => (relative && pathAt(i) && !/^\//.test(a) ? 'resolve(ROOT, ' + JSON.stringify(a) + ')' : JSON.stringify(a)));
  const L: string[] = [
    '// Generated by speckl adapter.mjs install ' + harness + '; do not edit (rerun install).',
    '// Every tool call goes through the Speckl adapter before it runs. Anything',
    '// other than an explicit allow (a crash, a timeout, bad output, a missing',
    '// node) blocks the call.',
    "import { spawnSync } from 'node:child_process';",
  ];
  if (relative) {
    L.push("import { fileURLToPath } from 'node:url';", "import { resolve } from 'node:path';");
    L.push('const ROOT = fileURLToPath(new URL(' + JSON.stringify(up[harness] || '../../') + ', import.meta.url));');
  }
  L.push(
    'const ARGV = [' + lit.join(', ') + '];',
    'function speckl(event, payload) {',
    '  let input;',
    '  try { input = JSON.stringify(payload); } catch (e) { return { ok: false, reason: "Speckl: the hook payload could not be serialised (" + e + ")" }; }',
    '  if (typeof input !== "string") return { ok: false, reason: "Speckl: the hook payload could not be serialised" };',
    '  let r;',
    '  try {',
    '    r = spawnSync("node", [ARGV[0], ' + JSON.stringify(harness) + ', event, ...ARGV.slice(1)], { input, encoding: "utf-8", timeout: 25000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });',
    '  } catch (e) { return { ok: false, reason: "Speckl: could not run the adapter (" + e + ")" }; }',
    '  const lines = String(r.stdout || "").trim().split("\\n").filter(Boolean);',
    '  let body = null;',
    '  try { body = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { body = null; }',
    '  const err = String(r.stderr || "").trim();',
    '  if (r.error || r.status !== 0) {',
    '    const why = (body && typeof body.reason === "string" && body.reason) || err.split("\\n")[0]',
    '      || (r.error ? String(r.error.message || r.error) : r.signal ? "killed by " + r.signal : "exit " + r.status);',
    '    return { ok: false, reason: (/^Speckl/.test(why) ? "" : "Speckl adapter failed: ") + why };',
    '  }',
    '  return { ok: true, body };',
    '}',
    'function allowed(r) { return r.ok && !!r.body && typeof r.body === "object" && r.body.decision === "allow"; }',
    'function denial(r) { return r.ok ? "Speckl: the adapter gave no allow decision" : r.reason; }',
    'function note(r) { return !r.ok ? r.reason : r.body && typeof r.body.additionalContext === "string" ? r.body.additionalContext : ""; }',
  );
  if (harness === 'pi') {
    L.push(
      '// Pi extension (.pi/extensions): tool_call can block; a handler that throws',
      '// also blocks (pi fail-safe). tool_result fires for every executed call.',
      'export default function specklRails(pi) {',
      '  pi.on("tool_call", async (event, ctx) => {',
      '    const r = speckl("pre", { ...event, cwd: ctx.cwd });',
      '    if (allowed(r)) return undefined;',
      '    return { block: true, reason: denial(r) };',
      '  });',
      '  pi.on("tool_result", async (event, ctx) => {',
      '    const text = note(speckl("post", { ...event, cwd: ctx.cwd }));',
      '    if (!text) return undefined;',
      '    const out = { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text }] };',
      '    if (event.structuredContent !== undefined) out.structuredContent = event.structuredContent;',
      '    return out;',
      '  });',
      '  pi.on("agent_end", async (event, ctx) => { speckl("turn-end", { type: "agent_end", cwd: ctx.cwd }); return undefined; });',
      '}',
    )
  } else if (harness === 'opencode') {
    L.push(
      '// OpenCode plugin (.opencode/plugins): throwing in tool.execute.before stops',
      '// the call. A tool that throws never reaches tool.execute.after; its',
      '// message.part.updated error event is reported as post-failure.',
      'export const SpecklRails = async ({ directory }) => ({',
      '  "tool.execute.before": async (input, output) => {',
      '    const r = speckl("pre", { hook: "tool.execute.before", input, output: { args: output.args }, directory });',
      '    if (!allowed(r)) throw new Error(denial(r));',
      '  },',
      '  "tool.execute.after": async (input, output) => {',
      '    const text = note(speckl("post", { hook: "tool.execute.after", input, output: { title: output.title, output: output.output, metadata: output.metadata }, directory }));',
      '    if (text) output.output = (typeof output.output === "string" ? output.output + "\\n\\n" : "") + text;',
      '  },',
      '  event: async ({ event }) => {',
      '    if (!event || typeof event !== "object") return;',
      '    if (event.type === "message.part.updated") {',
      '      const part = event.properties && event.properties.part;',
      '      if (part && part.type === "tool" && part.state && part.state.status === "error") speckl("post-failure", { ...event, directory });',
      '    } else if (event.type === "session.idle") {',
      '      speckl("turn-end", { ...event, directory });',
      '    }',
      '  },',
      '});',
    )
  } else {
    L.push(
      '// OpenClaw native plugin: before_tool_call returns {block, blockReason}; a',
      '// handler that throws or times out blocks the call (host policy).',
      'const pick = (ctx) => ({ agentId: ctx && ctx.agentId, sessionKey: ctx && ctx.sessionKey, sessionId: ctx && ctx.sessionId, runId: ctx && ctx.runId, toolName: ctx && ctx.toolName, toolCallId: ctx && ctx.toolCallId });',
      'export default {',
      '  id: "speckl",',
      '  name: "Speckl rails",',
      '  description: "Checks every tool call against the compiled Speckl policy (fail closed).",',
      '  register(api) {',
      '    api.on("before_tool_call", (event, ctx) => {',
      '      const r = speckl("pre", { hook: "before_tool_call", event, ctx: pick(ctx) });',
      '      if (allowed(r)) return undefined;',
      '      return { block: true, blockReason: denial(r) };',
      '    }, { timeoutMs: 30000 });',
      '    api.on("after_tool_call", (event, ctx) => {',
      '      const text = note(speckl("post", { hook: "after_tool_call", event, ctx: pick(ctx) }));',
      '      if (text && api.logger && typeof api.logger.warn === "function") api.logger.warn(text);',
      '    }, { timeoutMs: 30000 });',
      '    api.on("session_end", (event, ctx) => { speckl("turn-end", { hook: "session_end", ctx: pick(ctx) }); });',
      '  },',
      '};',
    )
  }
  return L.join('\n') + '\n';
}

/** Files of the generated plugin, by name relative to the plugin file's directory. */
export function pluginFiles(harness: string, ours: Record<string, unknown>): Record<string, string> {
  const main = harness === 'openclaw' ? 'index.js' : 'speckl.js';
  const files: Record<string, string> = { [main]: pluginSource(harness, ours) };
  if (harness === 'openclaw') {
    const configSchema = { type: 'object', additionalProperties: false, properties: {} };
    files['openclaw.plugin.json'] = JSON.stringify({ id: 'speckl', name: 'Speckl rails', description: 'Checks every tool call against the compiled Speckl policy (fail closed).', configSchema }, null, 2) + '\n';
    files['package.json'] = JSON.stringify({ name: 'speckl-openclaw-rails', version: '1.0.0', private: true, type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2) + '\n';
  }
  return files;
}

/**
 * The Hermes `hooks:` block as YAML, between marker comments so `install`
 * can replace it later. Strings are JSON-quoted (valid YAML double-quoted
 * scalars), so no YAML library is needed.
 */
export function hermesYaml(ours: Record<string, unknown>): string {
  const lines = ['# >>> speckl hermes hooks (generated by adapter.mjs install hermes; do not edit)', 'hooks:'];
  const hooks = (ours.hooks || {}) as Record<string, Record<string, unknown>[]>;
  for (const ev of Object.keys(hooks)) {
    lines.push('  ' + ev + ':');
    for (const entry of hooks[ev]) {
      let first = true;
      for (const [k, v] of Object.entries(entry)) {
        lines.push((first ? '    - ' : '      ') + k + ': ' + JSON.stringify(v));
        first = false;
      }
    }
  }
  lines.push('# <<< speckl hermes hooks');
  return lines.join('\n') + '\n';
}

/**
 * `install hermes --hermes-home <profile dir> ...`: writes the hooks block
 * into <profile>/config.yaml and records first-use consent for exactly these
 * commands in <profile>/shell-hooks-allowlist.json (an unapproved hook is
 * skipped by Hermes, which would leave the agent without rails). Refuses to
 * touch a config.yaml that already has a `hooks:` key of its own.
 */
export function installHermes(project: string, ours: Record<string, unknown>, hermesHome: string, deps: AdapterDeps): AdapterOutput {
  const target = deps.resolvePath(hermesHome, 'config.yaml');
  const block = hermesYaml(ours);
  const text = deps.readFile(target);
  const begin = '# >>> speckl hermes hooks';
  const end = '# <<< speckl hermes hooks';
  let next: string;
  if (text === null || text.trim() === '') {
    next = block;
  } else if (text.includes(begin) && text.includes(end)) {
    const a = text.indexOf(begin);
    const b = text.indexOf('\n', text.indexOf(end));
    next = text.slice(0, a) + block + (b === -1 ? '' : text.slice(b + 1));
  } else if (/^hooks\s*:/m.test(text)) {
    return {
      code: 1,
      stdout: block,
      stderr: target + ' already has a hooks: block; not touching it. Merge the entries printed on stdout into it, then approve them (hermes hooks list).\n',
    };
  } else {
    next = text + (text.endsWith('\n') ? '' : '\n') + block;
  }
  const allowPath = deps.resolvePath(hermesHome, 'shell-hooks-allowlist.json');
  const allowText = deps.readFile(allowPath);
  let allow: Record<string, unknown> = { approvals: [] };
  if (allowText !== null && allowText.trim() !== '') {
    try { allow = JSON.parse(allowText); } catch {
      return { code: 1, stdout: '', stderr: allowPath + ' is not valid JSON; not touching it\n' };
    }
    if (!allow || typeof allow !== 'object' || Array.isArray(allow) || !Array.isArray(allow.approvals)) {
      return { code: 1, stdout: '', stderr: allowPath + ' has no approvals list; not touching it\n' };
    }
  }
  const isOurs = (e: unknown): boolean => {
    const c = e && typeof e === 'object' ? (e as Record<string, unknown>).command : undefined;
    return typeof c === 'string' && c.includes('adapter.mjs') && c.includes(' hermes ');
  };
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const approvals = (allow.approvals as unknown[]).filter(e => !isOurs(e));
  const hooks = (ours.hooks || {}) as Record<string, { command: string }[]>;
  for (const ev of Object.keys(hooks)) {
    for (const h of hooks[ev]) approvals.push({ event: ev, command: h.command, approved_at: now, script_mtime_at_approval: null });
  }
  deps.writeFile(target, next);
  deps.writeFile(allowPath, JSON.stringify({ ...allow, approvals }, null, 2) + '\n');
  return {
    code: 0,
    stdout: 'Speckl hermes hooks written to ' + target + ' for project ' + project + '\n'
      + 'Recorded consent for these ' + approvals.filter(isOurs).length + ' hook commands in ' + allowPath + ' (revoke with: hermes hooks revoke <command>)\n',
    stderr: '',
  };
}

/** `adapter.mjs install <harness> --project <dir> --state <file> [--key <file>] [--hermes-home <dir>]`. */
export function installHarness(harness: string, flags: Record<string, string>, deps: AdapterDeps): AdapterOutput {
  if (!flags.project || !flags.state || (harness === 'hermes' && !flags['hermes-home'])) {
    const extra = harness === 'hermes' ? ' --hermes-home <profile dir, e.g. ~/.hermes>' : '';
    return { code: 1, stdout: '', stderr: 'usage: adapter.mjs install ' + harness + ' --project <dir> --state <file> [--key <file>]' + extra + '\n' };
  }
  const project = deps.resolvePath(deps.cwd, flags.project);
  const stateAbs = deps.resolvePath(deps.cwd, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(deps.cwd, flags.key) : null;
  const rel = (p: string) => deps.relativePath(project, p).replace(/\\/g, '/');
  const inside = (p: string) => !rel(p).startsWith('..') && !/^[A-Za-z]:|^\//.test(rel(p));
  // Codex runs hooks from the session cwd and Gemini sets GEMINI_PROJECT_DIR
  // to it, so both get absolute paths (a session may start in a subdirectory);
  // so do Copilot, Goose and Hermes, which do not pin the project root at all.
  const pinned = harness !== 'claude-code' && harness !== 'cursor';
  const relative = !pinned && inside(deps.agentDir) && inside(stateAbs);
  const hermesHome = harness === 'hermes' ? deps.resolvePath(deps.cwd, flags['hermes-home']) : undefined;
  // Goose loads project plugins only when it starts in the project root;
  // --plugins-dir ~/.agents/plugins installs a user-scope plugin that also
  // covers sessions started in a subdirectory.
  // Pi (~/.pi/agent/extensions) and OpenCode (~/.config/opencode/plugins)
  // take --plugins-dir too: a user-level plugin loads without Pi's project
  // trust and wherever the session starts, and judges only calls whose cwd
  // is inside the project (the rails are protected from every session).
  const userScope = harness === 'goose' || harness === 'pi' || harness === 'opencode';
  const pluginsDir = userScope && flags['plugins-dir'] ? deps.resolvePath(deps.cwd, flags['plugins-dir']) : '';
  let pluginName = 'speckl';
  if (pluginsDir) {
    let h = 0x811c9dc5;
    for (let i = 0; i < project.length; i++) { h ^= project.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    pluginName = 'speckl-' + h.toString(16).padStart(8, '0');
  }
  const ours = buildHarnessHooks(harness, {
    adapter: relative ? rel(deps.resolvePath(deps.agentDir, 'adapter.mjs')) : deps.resolvePath(deps.agentDir, 'adapter.mjs'),
    state: relative ? rel(stateAbs) : stateAbs,
    key: keyAbs,
    relative,
    project: pinned ? project : undefined,
    hermesHome,
    outsideAllow: pluginsDir !== '',
  });
  let warn = '';
  if (keyAbs && inside(keyAbs)) warn = 'WARN: the state key is inside the project; keep it where the agent cannot read it\n';
  if (!keyAbs) warn = 'WARN: no --key; hooks will use SPECKL_STATE_KEY_FILE from the harness environment\n';
  if (hermesHome) {
    const r = installHermes(project, ours, hermesHome, deps);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr + (r.code === 0 ? warn : '') };
  }
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    // A plugin file Speckl did not write is never overwritten.
    const mainPath = pluginsDir ? deps.resolvePath(pluginsDir, pluginName + '.js') : deps.resolvePath(project, harnessConfigFile(harness));
    const dir = deps.dirname(mainPath);
    const files = pluginFiles(harness, ours);
    const mine = (t: string | null) => t === null || t.trim() === '' || t.includes('Generated by speckl adapter.mjs install ' + harness);
    const mainText = deps.readFile(mainPath);
    if (!mine(mainText)) return { code: 1, stdout: '', stderr: mainPath + ' exists and was not written by Speckl; not touching it\n' };
    if (mainText === null) {
      for (const name of Object.keys(files).slice(1)) {
        const t = deps.readFile(deps.resolvePath(dir, name));
        if (t !== null && t.trim() !== '') return { code: 1, stdout: '', stderr: deps.resolvePath(dir, name) + ' exists and was not written by Speckl; not touching it\n' };
      }
    }
    const main = Object.keys(files)[0];
    for (const [name, text] of Object.entries(files)) deps.writeFile(name === main ? mainPath : deps.resolvePath(dir, name), text);
    const next: Record<string, string> = {
      pi: pluginsDir ? 'Pi loads this user-level extension in every session; it judges calls made inside ' + project + '.\n'
        : 'Pi loads project extensions only for a trusted project: run /trust once, or pass --approve (or -e ' + mainPath + ') in print/JSON/RPC mode. Untrusted, the extension is skipped and nothing is checked; --plugins-dir ~/.pi/agent/extensions avoids that.\n',
      opencode: 'OpenCode loads ' + (pluginsDir ? pluginsDir : '.opencode/plugins/') + ' at startup; restart running sessions.\n',
      openclaw: 'Enable it in your OpenClaw config: plugins.load.paths += ["' + dir + '"], plugins.entries.speckl.enabled = true, and set the agent workspace (or `openclaw agent exec --cwd`) to ' + project + '.\n',
    };
    return { code: 0, stdout: 'Speckl ' + harness + ' plugin written to ' + mainPath + '\n' + next[harness], stderr: warn };
  }
  if (harness === 'cline') {
    // .clinerules/hooks/ is read by both the Cline CLI and the VS Code
    // extension. A hook file Speckl did not write is never overwritten.
    const dir = deps.dirname(deps.resolvePath(project, harnessConfigFile(harness)));
    const scripts = clineScripts(ours);
    for (const name of Object.keys(scripts)) {
      for (const n of [name, name + '.sh', name + '.js', name + '.mjs', name + '.py', name + '.ps1']) {
        const t = deps.readFile(deps.resolvePath(dir, n));
        if (t !== null && t.trim() !== '' && !(n === name && t.includes('Generated by speckl adapter.mjs install cline'))) {
          return { code: 1, stdout: '', stderr: deps.resolvePath(dir, n) + ' exists and was not written by Speckl; not touching it (Cline runs one ' + name + ' hook per directory)\n' };
        }
      }
    }
    for (const [name, text] of Object.entries(scripts)) deps.writeFile(deps.resolvePath(dir, name), text, 0o755);
    return {
      code: 0,
      stdout: 'Speckl cline hooks written to ' + dir + '/ (' + Object.keys(scripts).join(', ') + ')\n'
        + 'Cline runs them while hooks are enabled (the default). A Speckl deny cancels the whole task, not only the call.\n',
      stderr: warn,
    };
  }
  const pluginDir = pluginsDir ? deps.resolvePath(pluginsDir, pluginName) : deps.resolvePath(project, '.agents/plugins/speckl');
  const target = harness === 'goose' ? deps.resolvePath(pluginDir, 'hooks/hooks.json') : deps.resolvePath(project, harnessConfigFile(harness));
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
  if (harness === 'goose') {
    // The plugin manifest next to hooks/ makes the directory a Goose plugin.
    const manifest = { name: pluginName, version: '1.0.0', description: 'Speckl rails for ' + project + ': every tool call is checked against the compiled policy (fail closed).' };
    deps.writeFile(deps.resolvePath(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
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
    // A turn-end hook never blocks: on Gemini exit 2 would force a retry turn.
    if (event === 'turn-end') return { code: 0, stdout: harness === 'gemini' ? '{}\n' : '', stderr: msg + '\n' };
    if (isPre || harnessEventName(harness, event) === null) return formatPre(harness, false, msg);
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
    payload = normalizePayload(harness, parsed as Record<string, unknown>);
  } catch {
    return fail('hook payload is not JSON');
  }
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== expected) {
    return fail('payload is ' + JSON.stringify(payload.hook_event_name) + ' but this hook is wired as ' + expected);
  }
  if (!flags.state) return fail('missing --state');

  const projectDir = flags.project
    || (harness === 'cursor' ? env.CURSOR_PROJECT_DIR
      : harness === 'gemini' ? env.GEMINI_PROJECT_DIR
        : harness === 'claude-code' ? env.CLAUDE_PROJECT_DIR : undefined)
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
  for (const d of harnessProtectedDirs(Object.keys(harnesses))) protectedAbs.push(deps.resolvePath(projectDir, d));
  if (flags['hermes-home']) protectedAbs.push(deps.resolvePath(projectDir, flags['hermes-home']));
  const protectedPaths = protectedAbs.map(abs => {
    const r = deps.relativePath(projectDir, abs).replace(/\\/g, '/');
    return { abs, rel: r.startsWith('..') ? '' : r };
  });

  if (flags.outside === 'allow' && event !== 'turn-end') {
    // A session outside the project is not this spec's to judge, except
    // that no session may touch the rails.
    const r = deps.relativePath(projectDir, callCwd).replace(/\\/g, '/');
    if (r === '..' || r.startsWith('../') || /^[A-Za-z]:|^\//.test(r)) {
      if (!isPre) return formatPost(harness, null);
      const pin = parseToolInput(payload.tool_input);
      if (!pin.ok) return fail(pin.reason);
      const hit = findProtectedMention(pin.input, protectedPaths, callCwd, deps.resolvePath);
      if (hit) return fail(String(payload.tool_name) + ' touches a Speckl-protected path (' + hit + '); the agent may not read or change its own rails');
      return formatPre(harness, true, '');
    }
  }

  if (event === 'turn-end') {
    // End of turn (Codex Stop, Gemini AfterAgent): a call that passed pre but
    // never reported (declined, cancelled) is recorded as failed so the next
    // call is not refused as parallel. hook.mjs re-verifies the state.
    const quiet = harness === 'gemini' ? '{}\n' : '';
    const text = deps.readFile(stateAbs);
    let pending: Record<string, unknown> | null = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === 'object') pending = st.pending as Record<string, unknown>;
    } catch { /* hook.mjs reports a broken state on the next call */ }
    if (!pending || typeof pending.tool !== 'string' || pending.call_id === undefined) return { code: 0, stdout: quiet, stderr: '' };
    const r = deps.runHook('post', { tool: pending.tool, input: pending.input || {}, call_id: pending.call_id, ok: false }, stateAbs, keyAbs);
    if (r.status !== 0) return { code: 0, stdout: quiet, stderr: 'Speckl: could not clear the pending call: ' + interpretHook(r).reason + '\n' };
    return { code: 0, stdout: quiet, stderr: 'Speckl cleared pending call ' + String(pending.call_id) + ' (no result reported); recorded as failed\n' };
  }

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
  const callId = harnessCallId(harness, payload);
  if (harness === 'hermes' && event === 'post') {
    // Hermes also reports calls a pre_tool_call hook blocked. Ours never
    // reached hook.mjs; another hook's block leaves our pending call open,
    // which is recorded as failed.
    const extra = payload.extra as Record<string, unknown> | undefined;
    if (extra && typeof extra === 'object' && extra.status === 'blocked') {
      const text = deps.readFile(stateAbs);
      let pending: Record<string, unknown> | null = null;
      try {
        const st = text ? JSON.parse(text) : null;
        if (st && st.pending && typeof st.pending === 'object') pending = st.pending as Record<string, unknown>;
      } catch { /* hook.mjs reports a broken state on the next call */ }
      if (!pending || callId === null || pending.call_id !== callId || typeof pending.tool !== 'string') return formatPost(harness, null);
      const r = interpretHook(deps.runHook('post', { tool: pending.tool, input: pending.input || {}, call_id: callId, ok: false }, stateAbs, keyAbs));
      return formatPost(harness, r.allow ? null : 'Speckl could not record blocked call ' + callId + ': ' + r.reason);
    }
  }
  const clawDetails = harness === 'openclaw' && event === 'post' && payload.event && typeof payload.event === 'object'
    ? ((payload.event as Record<string, unknown>).result as Record<string, unknown> | undefined) : undefined;
  const clawBlocked = !!clawDetails && typeof clawDetails === 'object' && !!clawDetails.details
    && (clawDetails.details as Record<string, unknown>).status === 'blocked';
  if ((harness === 'opencode' && event === 'post-failure') || clawBlocked) {
    // Every failed OpenCode tool part, and every OpenClaw call a
    // before_tool_call hook blocked, arrives here, including calls our pre
    // hook denied (never pending); only our pending call is recorded as failed.
    const text = deps.readFile(stateAbs);
    let pending: Record<string, unknown> | null = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === 'object') pending = st.pending as Record<string, unknown>;
    } catch { /* hook.mjs reports a broken state on the next call */ }
    if (!pending || callId === null || pending.call_id !== callId) return formatPost(harness, null);
  }
  const pin0 = parseToolInput(payload.tool_input);
  if (!pin0.ok) return fail(pin0.reason);
  const pin = { ok: true, input: normalizeToolInput(harness, toolName, pin0.input) };
  const label = typeof toolName === 'string' ? toolName : '(no tool_name)';

  if (isPre) {
    const hit = findProtectedMention(pin.input, protectedPaths, callCwd, deps.resolvePath);
    if (hit) return fail(label + ' touches a Speckl-protected path (' + hit + '); the agent may not read or change its own rails');
    // OpenCode bash and OpenClaw exec take a workdir: a mapped command run
    // elsewhere (`npm test` in another checkout) would advance the policy
    // on someone else's result, so only the project root is accepted.
    const wd = pin.input.workdir;
    if ((harness === 'opencode' || harness === 'openclaw') && wd !== undefined && wd !== null && wd !== '') {
      if (typeof wd !== 'string' || deps.resolvePath(callCwd, wd) !== deps.resolvePath(projectDir, '.')) {
        return fail(label + ' sets workdir ' + JSON.stringify(wd) + '; Speckl only accepts commands run in the project root (' + projectDir + ')');
      }
    }
  }
  const m = mapHarnessCall(rules, toolName, pin.input);
  if (!m.ok) {
    if (isPre) return fail(m.reason);
    return fail(label + ' ran without a Speckl mapping (' + m.reason + '); its pre hook should have denied it');
  }
  if (callId === null) return fail('payload has no tool_use_id (the harness sent no tool call id)');

  if (isPre) {
    const r = interpretHook(deps.runHook('pre', { tool: m.tool, input: m.input, call_id: callId }, stateAbs, keyAbs));
    if (r.allow) return formatPre(harness, true, '');
    return formatPre(harness, false, 'Speckl denied ' + label + ' (spec tool ' + m.tool + '): ' + r.reason);
  }
  const ok = postSucceeded(harness, event, payload);
  const r = interpretHook(deps.runHook('post', { tool: m.tool, input: m.input, call_id: callId, ok }, stateAbs, keyAbs));
  if (r.allow && harness === 'codex' && toolName === 'Bash') {
    return formatPost(harness, 'Speckl recorded ' + label + ' (spec tool ' + m.tool + ') as not successful: Codex does not report a Bash exit status, so a shell call never advances the policy. Use the tool mapped for this step instead.');
  }
  if (r.allow) return formatPost(harness, null);
  return formatPost(harness, 'Speckl could not record ' + label + ' (spec tool ' + m.tool + '): ' + r.reason);
}

/** Functions emitted into adapter.mjs, in order. */
export const ADAPTER_FUNCTIONS = [
  hasShellControl, parseToolInput, mapHarnessCall, findProtectedMention, interpretHook,
  formatPre, formatPost, postSucceeded, harnessEventName, normalizeToolInput, harnessCallId,
  harnessConfigFile, harnessProtectedDirs, normalizePayload, parseAdapterFlags, shellQuote,
  buildHarnessHooks, mergeHarnessSettings, clineScripts, pluginSource, pluginFiles, hermesYaml, installHermes, installHarness, runAdapter,
];
