import { explainAdapterDeny as explainAdapterDenyImpl, redactSecrets, scrubDenyText as scrubDenyTextImpl } from './deny-reason.js';

// runAdapter is pasted into adapter.mjs via Function#toString. A call to an
// imported binding is rewritten by the test bundler (and would throw in the
// generated file). This local wrapper is what the in-process tests run; the
// emitted file gets explainAdapterDenyImpl, whose source calls nothing imported.
function explainAdapterDeny(reason: string, secrets: string[]): string {
  return explainAdapterDenyImpl(reason, secrets);
}
function scrubDenyText(text: string, secrets: string[]): string {
  return scrubDenyTextImpl(text, secrets);
}

// Harness adapter runtime: pure functions that turn a real agent harness's
// hook payload (Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot CLI,
// Goose, Hermes Agent, Pi, OpenCode, OpenClaw, Cline, Kiro, Windsurf) into a call to the generic
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
  /** Present in agent-config.json; status/doctor use them to name the stage. */
  stageVariable?: string;
  stages?: Record<string, number>;
  awaits?: { state: string; stateValue: number; signal: string; mode: string }[];
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
  /**
   * fs.realpathSync. Optional so a test double can omit it. Throws when the
   * path cannot be resolved; the caller then adds nothing.
   */
  realpath?(p: string): string;
  /**
   * Remove one regular file this tooling created. Never recursive, never a
   * symlink. Returns false when the path is missing or cannot be removed.
   * The generated adapter always provides it; without it uninstall refuses.
   */
  removeFile?(p: string): boolean;
  /**
   * Run an installed hook command with `stdin`. `env` is merged over the
   * process environment (harness project-dir variables). status null means
   * the command did not finish (missing binary, timeout, signal). The
   * generated adapter always provides it; without it doctor refuses.
   */
  runCommand?(command: string, stdin: string, cwd: string, env: Record<string, string>): HookResult;
  /**
   * 'file', 'dir', 'symlink', 'missing', or 'other'. Does not follow symlinks.
   * Uninstall refuses when this is absent.
   */
  lstatKind?(p: string): string;
  /** Canonical path, or null if it cannot be resolved. Follows symlinks. */
  realPath?(p: string): string | null;
  /**
   * HMAC-SHA256 hex of `text` under a 64-hex state key, or null if the key
   * is not 64 hex characters. Used to authenticate the install record.
   */
  mac?(keyText: string, text: string): string | null;
}

export interface AdapterOutput {
  code: number;
  stdout: string;
  stderr: string;
  /** Planned file contents. Set by install planning; hook verdicts omit it. */
  writes?: { path: string; text: string; mode?: number }[];
}

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
  // Kiro and Windsurf: exit 2 blocks and sends stderr to the model; stdout
  // is ignored. The generated command allows only when the adapter prints
  // exactly {"decision":"allow"}, so a broken adapter that exits 0 still blocks.
  if (harness === 'kiro' || harness === 'windsurf') {
    if (allow) return { code: 0, stdout: JSON.stringify({ decision: 'allow' }) + '\n', stderr: '' };
    return { code: 2, stdout: '', stderr: message + '\n' };
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
  // Kiro PostToolUse output never reaches the agent; a non-zero exit shows
  // stderr to the user as a warning (the tool already ran).
  if (harness === 'kiro') {
    if (!problem) return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: problem + '\n' };
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
  if (harness === 'windsurf') {
    // Cascade runs post_read_code / post_mcp_tool_use only after a
    // successful read or MCP call, and post_write_code after the write.
    // post_run_command carries the command line and cwd only, without an
    // exit status, so a terminal command never counts as a success.
    return toolName !== 'run_command' && typeof toolName === 'string' && toolName !== '';
  }
  if (harness === 'kiro') {
    // Kiro sends tool_response with no success flag: prose such as
    // "Output:\n...\nExit Code: 0", "Created the file." or "Replaced text in
    // src/a.js", or (CLI) an object. A shell call needs a final exit code 0;
    // any other tool counts unless the result reads as an error. Inferred
    // from the text: see docs/harness-adapters.md, Limits.
    const shell = ['execute_bash', 'execute_pwsh', 'execute_cmd', 'shell'].includes(String(toolName));
    if (typeof out === 'string') {
      if (shell) {
        const codes = out.match(/Exit (?:Code|Status):\s*(-?\d+)/gi);
        return !!codes && /:\s*0$/.test(codes[codes.length - 1]);
      }
      return out.trim() !== '' && !/^\s*(error|failed|failure|tool .* failed|cannot|could not|unable to)\b/i.test(out);
    }
    if (!out || typeof out !== 'object' || Array.isArray(out)) return false;
    const o = out as Record<string, unknown>;
    if (o.success === false || o.is_error === true || o.isError === true) return false;
    if (o.error !== undefined && o.error !== null && o.error !== '') return false;
    if (shell) {
      const code = o.exit_status !== undefined ? o.exit_status : o.exit_code !== undefined ? o.exit_code : o.exitCode;
      return code === 0 || code === '0';
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
    kiro: { pre: 'PreToolUse', post: 'PostToolUse', 'turn-end': 'Stop' },
    // pre_tool / post_tool stand for every pre_* / post_* tool event
    // (normalizePayload); turn-end runs on the next pre_user_prompt.
    windsurf: { pre: 'pre_tool', post: 'post_tool', 'turn-end': 'pre_user_prompt' },
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
  if (harness === 'gemini' || harness === 'copilot' || harness === 'cline' || harness === 'kiro' || harness === 'windsurf') {
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
    kiro: '.kiro/hooks/speckl.json',
    // install also writes the legacy .windsurf/hooks.json for older releases.
    windsurf: '.devin/hooks.json',
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
    kiro: ['.kiro/hooks', '.kiro/agents', '.kiro/settings'],
    windsurf: ['.devin', '.windsurf'],
  };
  for (const h of harnesses) for (const d of extra[h] || []) if (!dirs.includes(d)) dirs.push(d);
  // Install records, backups and saved copies. An agent that can write these
  // can point uninstall at a file it should not touch.
  dirs.push('.speckl/harness-install');
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
  if (harness === 'kiro') {
    // {hook_event_name, cwd, session_id, tool_name, tool_input[, tool_response]};
    // CLI 2.x agent hooks use camelCase event names.
    const legacy: Record<string, string> = { preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop' };
    if (typeof p.hook_event_name === 'string' && legacy[p.hook_event_name]) p.hook_event_name = legacy[p.hook_event_name];
  }
  if (harness === 'windsurf') {
    // {agent_action_name, trajectory_id, execution_id, timestamp, model_name,
    // tool_info}. Each event names one kind of action, so the tool name is
    // synthetic: read_code, write_code, run_command, or mcp__<server>__<tool>.
    const name = typeof p.agent_action_name === 'string' ? p.agent_action_name : '';
    const kind = /^(pre|post)_(read_code|write_code|run_command|mcp_tool_use)$/.exec(name);
    if (p.hook_event_name === undefined) p.hook_event_name = kind ? kind[1] + '_tool' : (name || null);
    const info = obj(p.tool_info);
    if (kind && p.tool_name === undefined) {
      if (kind[2] === 'mcp_tool_use') {
        const server = typeof info.mcp_server_name === 'string' ? info.mcp_server_name : '';
        const tool = typeof info.mcp_tool_name === 'string' ? info.mcp_tool_name : '';
        p.tool_name = server && tool ? 'mcp__' + server + '__' + tool : null;
      } else p.tool_name = kind[2];
    }
    if (kind && p.tool_input === undefined) {
      if (kind[2] === 'mcp_tool_use') p.tool_input = info.mcp_tool_arguments === undefined ? {} : info.mcp_tool_arguments;
      else if (kind[2] === 'run_command') {
        const t: Record<string, unknown> = { ...info };
        delete t.command;
        if (typeof info.command_line === 'string') t.command = info.command_line;
        p.tool_input = t;
      } else p.tool_input = p.tool_info;
    }
    if (p.session_id === undefined) p.session_id = p.trajectory_id;
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
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = args[i + 1];
    // --dry-run takes no value, so it must not swallow the next flag.
    // Every other flag still consumes the following argument, and a missing
    // one stays '' (`--project` at the end of the line).
    if (name === 'dry-run') out[name] = 'true';
    else { out[name] = next ?? ''; if (next !== undefined) i++; }
  }
  return out;
}

/**
 * What a spawn of the installed hook actually did.
 * EPIPE after the child has already exited means it closed stdin without
 * reading the probe; the exit code still counts. A timeout, a signal, or an
 * error with no exit code means the command did not finish.
 */
export function hookCommandResult(
  status: number | null, errorCode: string, errorText: string, signal: string,
  stdout: string, stderr: string, timeout: number,
): HookResult {
  const epipe = errorCode === 'EPIPE' && typeof status === 'number';
  const failed = ((!!errorCode || !!errorText) && !epipe) || !!signal;
  const why = !failed ? ''
    : errorCode === 'ETIMEDOUT' ? 'command timed out after ' + timeout + 'ms'
    : errorText ? errorText
    : signal ? 'command killed by ' + signal
    : errorCode;
  return { status: failed ? null : status, stdout: stdout || '', stderr: why || stderr || '' };
}

/**
 * Shell-quote one argument for a hook command line.
 * `$`, `{` and `}` are quoted too: an unquoted `${CLAUDE_PROJECT_DIR}`
 * word-splits when the project path contains a space. The `$` is not
 * escaped, so the double quotes still expand the variable as one word.
 */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : '"' + s.replace(/(["\\`])/g, '\\$1') + '"';
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
  if (harness === 'windsurf') {
    // Cascade hooks (.devin/hooks.json, legacy .windsurf/hooks.json): run
    // with `bash -c`; only exit 2 blocks a pre_* hook (stderr goes to the
    // agent), so the pre command exits 2 unless the adapter printed exactly
    // {"decision":"allow"}. On Windows Cascade runs `powershell` instead
    // (or `command` through PowerShell, where this sh syntax would fail
    // open), so the pre hooks' `powershell` command always blocks.
    const allowCmd = (event: string) => '[ "$(' + cmd(event) + ')" = \'{"decision":"allow"}\' ] || exit 2';
    const winBlock = "[Console]::Error.WriteLine('Speckl: the generated Cascade hooks support macOS and Linux only; blocking.'); exit 2";
    const pre = [{ command: allowCmd('pre'), powershell: winBlock, show_output: false }];
    const post = [{ command: cmd('post'), show_output: false }];
    return {
      hooks: {
        pre_read_code: pre, pre_write_code: pre, pre_run_command: pre, pre_mcp_tool_use: pre,
        post_read_code: post, post_write_code: post, post_run_command: post, post_mcp_tool_use: post,
        pre_user_prompt: [{ command: cmd('turn-end') + ' || true', show_output: false }],
      },
    };
  }
  if (harness === 'kiro') {
    // .kiro/hooks/speckl.json (IDE 1.x and CLI V3). Only exit 2 blocks a
    // PreToolUse call (stderr goes to the model); any other exit or a
    // timeout lets it run, so the pre command exits 2 unless the adapter
    // printed exactly {"decision":"allow"} (a crash, a missing node or an
    // empty exit 0 all block), and the adapter's own 20 s hook.mjs timeout stays
    // inside the 30 s hook timeout. No matcher: every tool, MCP included.
    // Stop must exit 0 with no output (exit 1 or a block decision asks
    // Kiro to keep going).
    const h = (name: string, trigger: string, event: string, block: boolean) => ({
      name, description: 'Speckl rails (generated by adapter.mjs install kiro; rerun install to change)', trigger,
      action: { type: 'command', command: block ? '[ "$(' + cmd(event) + ')" = \'{"decision":"allow"}\' ] || exit 2' : cmd(event) }, timeout: 30, enabled: true,
    });
    return { version: 'v1', hooks: [h('speckl-pre', 'PreToolUse', 'pre', true), h('speckl-post', 'PostToolUse', 'post', false), h('speckl-stop', 'Stop', 'turn-end', false)] };
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
  if (harness === 'kiro') {
    // v1 document: {version, hooks: [{name, trigger, action: {command}}]}.
    const cmdOf = (e: unknown) => (e && typeof e === 'object' && (e as Record<string, unknown>).action && typeof (e as Record<string, unknown>).action === 'object'
      ? ((e as Record<string, unknown>).action as Record<string, unknown>).command : undefined);
    const mine = (e: unknown) => { const c = cmdOf(e); return typeof c === 'string' && c.includes('adapter.mjs') && c.includes(' kiro '); };
    const prev = Array.isArray(existing.hooks) ? (existing.hooks as unknown[]).filter(e => !mine(e)) : [];
    return { ...existing, version: 'v1', hooks: [...prev, ...((ours.hooks || []) as unknown[])] };
  }
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
    '  try { input = JSON.stringify(payload); } catch { return { ok: false, reason: "Speckl: the hook payload could not be serialised" }; }',
    '  if (typeof input !== "string") return { ok: false, reason: "Speckl: the hook payload could not be serialised" };',
    '  let r;',
    '  try {',
    '    r = spawnSync("node", [ARGV[0], ' + JSON.stringify(harness) + ', event, ...ARGV.slice(1)], { input, encoding: "utf-8", timeout: 25000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });',
    '  } catch { return { ok: false, reason: "Speckl: could not run the adapter" }; }',
    '  const lines = String(r.stdout || "").trim().split("\\n").filter(Boolean);',
    '  let body = null;',
    '  try { body = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { body = null; }',
    '  const err = String(r.stderr || "").trim();',
    '  if (r.error || r.status !== 0) {',
    '    const why = (body && typeof body.reason === "string" && body.reason) || err.split("\\n")[0]',
    '      || (r.error ? "spawn " + String(r.error.code || "error") : r.signal ? "killed by " + r.signal : "exit " + r.status);',
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
  // installHarness commits these (backup, dry-run, install record). Nothing
  // is written here, so a later refusal cannot leave a half-applied profile.
  const writes = [
    { path: target, text: next },
    { path: allowPath, text: JSON.stringify({ ...allow, approvals }, null, 2) + '\n' },
  ];
  return {
    code: 0,
    stdout: 'Speckl hermes hooks written to ' + target + ' for project ' + project + '\n'
      + 'Recorded consent for these ' + approvals.filter(isOurs).length + ' hook commands in ' + allowPath + ' (revoke with: hermes hooks revoke <command>)\n',
    stderr: '',
    writes,
  };
}

/** `adapter.mjs install <harness> --project <dir> --state <file> [--key <file>] [--hermes-home <dir>]`. */
export function installHarness(harness: string, flags: Record<string, string>, deps: AdapterDeps): AdapterOutput {
  if (!flags.project || !flags.state || (harness === 'hermes' && !flags['hermes-home'])) {
    const extra = harness === 'hermes' ? ' --hermes-home <profile dir, e.g. ~/.hermes>' : '';
    return { code: 1, stdout: '', stderr: 'usage: adapter.mjs install ' + harness + ' --project <dir> --state <file> [--key <file>] [--dry-run]' + extra + '\n' };
  }
  const project = deps.resolvePath(deps.cwd, flags.project);
  const stateAbs = deps.resolvePath(deps.cwd, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(deps.cwd, flags.key) : null;
  // A --key that is missing or not 64 hex would produce an unsigned record.
  // Refuse before any write. Trailing whitespace (a final newline) is allowed.
  let keyText: string | null = null;
  if (keyAbs) {
    const kt = deps.readFile(keyAbs);
    if (kt === null) return { code: 1, stdout: '', stderr: 'refusing to install: --key file ' + keyAbs + ' is missing; the install record would be unsigned\n' };
    if (!/^[0-9a-fA-F]{64}\s*$/.test(kt)) return { code: 1, stdout: '', stderr: 'refusing to install: --key file ' + keyAbs + ' is not 64 hex characters; the install record would be unsigned\n' };
    keyText = kt.trim();
  }
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
  if (!keyAbs) {
    warn = 'WARN: no --key; hooks will use SPECKL_STATE_KEY_FILE from the harness environment\n';
    warn += 'WARN: the install record is unsigned; uninstall will not restore modified files from it without a matching mac\n';
  }
  const dry = flags['dry-run'] === 'true';
  const finish = (message: string, writes: { path: string; text: string; mode?: number }[]): AdapterOutput => {
    const c = commitInstallWrites(project, harness, writes, deps, dry, keyText);
    if (c.error) return { code: 1, stdout: '', stderr: c.error };
    if (dry) return { code: 0, stdout: c.note, stderr: warn, writes };
    return { code: 0, stdout: message + c.note, stderr: warn, writes };
  };
  if (hermesHome) {
    const r = installHermes(project, ours, hermesHome, deps);
    if (r.code !== 0) return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    return finish(r.stdout, r.writes || []);
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
    const pluginWrites: { path: string; text: string }[] = [];
    for (const [name, text] of Object.entries(files)) pluginWrites.push({ path: name === main ? mainPath : deps.resolvePath(dir, name), text });
    const next: Record<string, string> = {
      pi: pluginsDir ? 'Pi loads this user-level extension in every session; it judges calls made inside ' + project + '.\n'
        : 'Pi loads project extensions only for a trusted project: run /trust once, or pass --approve (or -e ' + mainPath + ') in print/JSON/RPC mode. Untrusted, the extension is skipped and nothing is checked; --plugins-dir ~/.pi/agent/extensions avoids that.\n',
      opencode: 'OpenCode loads ' + (pluginsDir ? pluginsDir : '.opencode/plugins/') + ' at startup; restart running sessions.\n',
      openclaw: 'Enable it in your OpenClaw config: plugins.load.paths += ["' + dir + '"], plugins.entries.speckl.enabled = true, and set the agent workspace (or `openclaw agent exec --cwd`) to ' + project + '.\n',
    };
    return finish('Speckl ' + harness + ' plugin written to ' + mainPath + '\n' + next[harness], pluginWrites);
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
    const clineWrites: { path: string; text: string; mode?: number }[] = [];
    for (const [name, text] of Object.entries(scripts)) clineWrites.push({ path: deps.resolvePath(dir, name), text, mode: 0o755 });
    return finish(
      'Speckl cline hooks written to ' + dir + '/ (' + Object.keys(scripts).join(', ') + ')\n'
        + 'Cline runs them while hooks are enabled (the default). A Speckl deny cancels the whole task, not only the call.\n',
      clineWrites,
    );
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
  const extraTargets: { path: string; settings: Record<string, unknown> }[] = [];
  if (harness === 'windsurf') {
    // Older Windsurf releases read only .windsurf/hooks.json; current ones read
    // it only when .devin/hooks.json is absent or empty, so both get the hooks.
    const legacy = deps.resolvePath(project, '.windsurf/hooks.json');
    const lt = deps.readFile(legacy);
    let le: Record<string, unknown> = {};
    if (lt !== null && lt.trim() !== '') {
      try { le = JSON.parse(lt); } catch { return { code: 1, stdout: '', stderr: legacy + ' is not valid JSON; not touching it\n' }; }
      if (!le || typeof le !== 'object' || Array.isArray(le)) return { code: 1, stdout: '', stderr: legacy + ' is not a JSON object; not touching it\n' };
    }
    extraTargets.push({ path: legacy, settings: mergeHarnessSettings(harness, le, ours) });
  }
  const merged = mergeHarnessSettings(harness, existing, ours);
  const jsonWrites: { path: string; text: string }[] = [{ path: target, text: JSON.stringify(merged, null, 2) + '\n' }];
  for (const x of extraTargets) jsonWrites.push({ path: x.path, text: JSON.stringify(x.settings, null, 2) + '\n' });
  if (harness === 'goose') {
    // The plugin manifest next to hooks/ makes the directory a Goose plugin.
    const manifest = { name: pluginName, version: '1.0.0', description: 'Speckl rails for ' + project + ': every tool call is checked against the compiled policy (fail closed).' };
    jsonWrites.push({ path: deps.resolvePath(pluginDir, 'plugin.json'), text: JSON.stringify(manifest, null, 2) + '\n' });
  }
  const also = extraTargets.length ? ' and ' + extraTargets.map(x => x.path).join(', ') : '';
  const note = harness === 'windsurf' ? 'Cascade does not run hooks while the workspace is in Restricted Mode: trust the workspace.\n' : '';
  return finish('Speckl ' + harness + ' hooks written to ' + target + also + '\n' + note, jsonWrites);
}

/** True when `p` is `root` or a path inside it. */
export function pathInside(root: string, p: string, deps: AdapterDeps): boolean {
  const rel = deps.relativePath(root, p).replace(/\\/g, '/');
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('../') && !/^[A-Za-z]:|^\//.test(rel);
}

/**
 * One hunk covering the changed middle of a file (shared prefix and suffix
 * kept). Identical texts return ''. A missing before is a create.
 */
export function unifiedDiff(filePath: string, before: string | null, after: string): string {
  const left = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const right = after.replace(/\n$/, '').split('\n');
  let s = 0;
  while (s < left.length && s < right.length && left[s] === right[s]) s++;
  let eL = left.length - 1;
  let eR = right.length - 1;
  while (eL >= s && eR >= s && left[eL] === right[eR]) { eL--; eR--; }
  if (before !== null && eL < s && eR < s) return '';
  const del = eL >= s ? eL - s + 1 : 0;
  const add = eR >= s ? eR - s + 1 : 0;
  const lines = [
    '--- ' + (before === null ? '/dev/null' : filePath),
    '+++ ' + filePath,
    '@@ -' + (del === 0 ? s : s + 1) + ',' + del + ' +' + (add === 0 ? s : s + 1) + ',' + add + ' @@',
  ];
  for (let i = s; i <= eL; i++) lines.push('-' + left[i]);
  for (let i = s; i <= eR; i++) lines.push('+' + right[i]);
  return lines.join('\n') + '\n';
}

/**
 * Paths `install` writes, in the same order and places as installHarness.
 * The first path is the one that holds the pre-tool hook.
 */
export function installFilePaths(
  harness: string,
  project: string,
  opts: { hermesHome: string; pluginsDir: string; pluginName: string },
  deps: AdapterDeps,
): string[] {
  if (harness === 'hermes') {
    return [deps.resolvePath(opts.hermesHome, 'config.yaml'), deps.resolvePath(opts.hermesHome, 'shell-hooks-allowlist.json')];
  }
  if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    const mainPath = opts.pluginsDir ? deps.resolvePath(opts.pluginsDir, opts.pluginName + '.js') : deps.resolvePath(project, harnessConfigFile(harness));
    const dir = deps.dirname(mainPath);
    const names = harness === 'openclaw' ? ['index.js', 'openclaw.plugin.json', 'package.json'] : ['speckl.js'];
    const out: string[] = [];
    for (let i = 0; i < names.length; i++) out.push(i === 0 ? mainPath : deps.resolvePath(dir, names[i]));
    return out;
  }
  if (harness === 'cline') {
    const dir = deps.dirname(deps.resolvePath(project, harnessConfigFile(harness)));
    return ['PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'TaskError'].map(n => deps.resolvePath(dir, n));
  }
  const pluginDir = opts.pluginsDir ? deps.resolvePath(opts.pluginsDir, opts.pluginName) : deps.resolvePath(project, '.agents/plugins/speckl');
  if (harness === 'goose') return [deps.resolvePath(pluginDir, 'hooks/hooks.json'), deps.resolvePath(pluginDir, 'plugin.json')];
  if (harness === 'windsurf') return [deps.resolvePath(project, '.devin/hooks.json'), deps.resolvePath(project, '.windsurf/hooks.json')];
  return [deps.resolvePath(project, harnessConfigFile(harness))];
}

/**
 * Compact JSON the install-record mac covers: `{v, harness, files}` only.
 * Not the pretty-printed file, and not the mac field itself.
 */
export function installRecordPayload(harness: string, files: unknown): string {
  return JSON.stringify({ v: 1, harness, files });
}

/**
 * Apply install's planned writes. Copies the previous contents of any file
 * it changes into `.speckl/harness-install/backups/` (keeping that original
 * on a later install) and records what it wrote. `--dry-run` only reports.
 * A record that is not ours, whose mac does not match the state key, or that
 * names a path this install is not rewriting, is left untouched.
 */
export function commitInstallWrites(
  project: string,
  harness: string,
  writes: { path: string; text: string; mode?: number }[],
  deps: AdapterDeps,
  dryRun: boolean,
  keyText: string | null = null,
): { note: string; error: string } {
  const root = deps.resolvePath(project, '.speckl/harness-install');
  const manifestPath = deps.resolvePath(root, harness + '.json');
  let prevFiles: { path: string; action: string; backup: string | null; written: string }[] = [];
  const raw = deps.readFile(manifestPath);
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      return { note: '', error: manifestPath + ' is not valid JSON; not touching it\n' };
    }
    const rec = parsed as { v?: unknown; harness?: unknown; files?: unknown; mac?: unknown };
    if (!rec || rec.v !== 1 || rec.harness !== harness || !Array.isArray(rec.files)) {
      return { note: '', error: manifestPath + ' is not a Speckl install record for ' + harness + '; not touching it\n' };
    }
    const recMac = typeof rec.mac === 'string' ? rec.mac : '';
    if (recMac || keyText) {
      if (!keyText) return { note: '', error: manifestPath + ' install-record mac does not match the state key; not touching it\n' };
      if (typeof deps.mac !== 'function') return { note: '', error: 'install record cannot be authenticated with this runtime; nothing was written\n' };
      const want = deps.mac(keyText, installRecordPayload(harness, rec.files));
      if (!want || want !== recMac) return { note: '', error: manifestPath + ' install-record mac does not match the state key; not touching it\n' };
    }
    prevFiles = rec.files as typeof prevFiles;
  }
  const byPath: Record<string, { path: string; action: string; backup: string | null; written: string }> = {};
  for (const f of prevFiles) if (f && typeof f.path === 'string') byPath[f.path] = f;
  const rewriting: Record<string, boolean> = {};
  for (const w of writes) rewriting[w.path] = true;
  for (const f of prevFiles) {
    if (!f || typeof f.path !== 'string' || !rewriting[f.path]) {
      const label = f && typeof f.path === 'string' ? f.path : 'an entry with no path';
      return { note: '', error: 'refusing to install: the install record has ' + label + ' and this install is not rewriting it\n' };
    }
  }
  const nextFiles: { path: string; action: string; backup: string | null; written: string }[] = [];
  const enc = (p: string) => p.replace(/[^A-Za-z0-9._-]/g, (c) => '_' + c.charCodeAt(0).toString(16));
  const lines: string[] = [];
  const planned: { path: string; text: string; mode?: number; action: string; backup: string | null; written: string; current: string | null }[] = [];
  for (const w of writes) {
    const current = deps.readFile(w.path);
    const old = byPath[w.path];
    if (current === w.text) {
      if (old && (old.action === 'create' || old.action === 'modify') && typeof old.written === 'string') nextFiles.push(old);
      if (dryRun) lines.push('unchanged ' + w.path);
      continue;
    }
    let action = 'create';
    let backup: string | null = null;
    if (current !== null) {
      if (old && old.action === 'create') action = 'create';
      else if (old && old.action === 'modify' && typeof old.backup === 'string' && old.backup) { action = 'modify'; backup = old.backup; }
      else { action = 'modify'; backup = deps.resolvePath(root, 'backups/' + harness + '/' + enc(w.path)); }
    }
    const written = old && typeof old.written === 'string' && pathInside(root, old.written, deps)
      ? old.written
      : deps.resolvePath(root, 'written/' + harness + '/' + enc(w.path));
    nextFiles.push({ path: w.path, action, backup, written });
    planned.push({ path: w.path, text: w.text, mode: w.mode, action, backup, written, current });
  }
  let recordMac = '';
  if (keyText) {
    if (typeof deps.mac !== 'function') return { note: '', error: 'install record cannot be authenticated with this runtime; nothing was written\n' };
    const m = deps.mac(keyText, installRecordPayload(harness, nextFiles));
    if (!m) return { note: '', error: 'could not authenticate the install record; nothing was written\n' };
    recordMac = m;
  }
  if (dryRun) {
    for (const p of planned) {
      lines.push((p.action === 'create' ? 'create ' : 'modify ') + p.path);
      if (p.action === 'modify' && p.backup) lines.push('backup ' + p.backup + (byPath[p.path] && byPath[p.path].backup === p.backup ? ' (keep existing)' : ''));
      if (p.action === 'create' || p.action === 'modify') lines.push('snapshot ' + p.written);
      const diff = unifiedDiff(p.path, p.current, p.text);
      if (diff) lines.push(diff.replace(/\n$/, ''));
    }
    if (planned.length > 0) lines.push('record ' + manifestPath);
    lines.push('dry-run: no files written');
    return { note: lines.join('\n') + '\n', error: '' };
  }
  let backups = 0;
  for (const p of planned) {
    if (p.action === 'modify') {
      if (!p.backup || !pathInside(root, p.backup, deps)) return { note: '', error: 'refusing to back up ' + p.path + ' outside ' + root + '\n' };
      if (deps.readFile(p.backup) === null && p.current !== null) {
        deps.writeFile(p.backup, p.current);
        backups++;
      }
    }
    if (!pathInside(root, p.written, deps)) return { note: '', error: 'refusing to record a copy of ' + p.path + ' outside ' + root + '\n' };
    deps.writeFile(p.path, p.text, p.mode);
    deps.writeFile(p.written, p.text);
  }
  if (planned.length > 0) {
    const body: { v: number; harness: string; files: typeof nextFiles; mac?: string } = { v: 1, harness, files: nextFiles };
    if (recordMac) body.mac = recordMac;
    deps.writeFile(manifestPath, JSON.stringify(body, null, 2) + '\n');
  }
  if (backups > 0) lines.push('backed up ' + backups + ' file(s) under ' + deps.resolvePath(root, 'backups/' + harness));
  return { note: lines.length ? lines.join('\n') + '\n' : '', error: '' };
}

/**
 * Remove what `install` recorded and put modified files back from their
 * backups. A path is touched only when it is one of the config paths
 * `install` writes for this harness, it is inside the project, its real
 * path stays inside the project, and neither it nor a parent is a symlink.
 * Anything else is left in place and kept in the record. A record that
 * carries a mac, or an uninstall that was given a key, is trusted only when
 * the mac matches that key. With no valid mac, a modify is not restored, and
 * a create is deleted only when its current bytes equal a fresh install plan
 * (pass --state, and --hermes-home for Hermes). Anything else asks for --key.
 */
export function uninstallHarness(harness: string, flags: Record<string, string>, deps: AdapterDeps): AdapterOutput {
  if (!flags.project) return { code: 1, stdout: '', stderr: 'usage: adapter.mjs uninstall ' + harness + ' --project <dir> [--key <file>]\n' };
  const project = deps.resolvePath(deps.cwd, flags.project);
  const root = deps.resolvePath(project, '.speckl/harness-install');
  const manifestPath = deps.resolvePath(root, harness + '.json');
  const text = deps.readFile(manifestPath);
  if (text === null) return { code: 1, stdout: '', stderr: 'no install record for ' + harness + ' at ' + manifestPath + '; refusing to delete anything\n' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { code: 1, stdout: '', stderr: manifestPath + ' is not valid JSON; refusing to delete anything\n' };
  }
  const rec = parsed as { v?: unknown; harness?: unknown; files?: unknown; mac?: unknown };
  if (!rec || rec.v !== 1 || rec.harness !== harness || !Array.isArray(rec.files)) {
    return { code: 1, stdout: '', stderr: manifestPath + ' is not a Speckl install record for ' + harness + '; refusing to delete anything\n' };
  }
  let keyText = '';
  if (flags.key) {
    const kt = deps.readFile(deps.resolvePath(deps.cwd, flags.key));
    if (kt !== null && /^[0-9a-fA-F]{64}\s*$/.test(kt)) keyText = kt.trim();
  }
  const recMac = typeof rec.mac === 'string' ? rec.mac : '';
  if (recMac || keyText || flags.key) {
    if (!keyText) return { code: 1, stdout: '', stderr: 'install record mac does not match the state key; nothing was changed\n' };
    if (typeof deps.mac !== 'function') return { code: 1, stdout: '', stderr: 'this runtime cannot check the install-record mac; nothing was changed\n' };
    const want = deps.mac(keyText, installRecordPayload(harness, rec.files));
    if (!want || want !== recMac) return { code: 1, stdout: '', stderr: 'install record mac does not match the state key; nothing was changed\n' };
  }
  // A matching mac authenticated this record. No mac and no --key did not.
  const authed = recMac !== '' && keyText !== '';
  if (typeof deps.removeFile !== 'function') return { code: 1, stdout: '', stderr: 'uninstall cannot remove files with this runtime; nothing was changed\n' };
  const remove = deps.removeFile;
  const userScope = harness === 'goose' || harness === 'pi' || harness === 'opencode';
  const pluginsDir = userScope && flags['plugins-dir'] ? deps.resolvePath(deps.cwd, flags['plugins-dir']) : '';
  let pluginName = 'speckl';
  if (pluginsDir) {
    let h = 0x811c9dc5;
    for (let i = 0; i < project.length; i++) { h ^= project.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    pluginName = 'speckl-' + h.toString(16).padStart(8, '0');
  }
  const hermesHome = harness === 'hermes' && flags['hermes-home'] ? deps.resolvePath(deps.cwd, flags['hermes-home']) : '';
  const allowed: Record<string, boolean> = {};
  for (const p of installFilePaths(harness, project, { hermesHome, pluginsDir, pluginName }, deps)) allowed[p] = true;
  // Recomputed install paths only. The record's own path is not consulted.
  // The project directory itself may be a symlink (macOS /tmp); a parent
  // between the file and the project may not.
  const owned = (target: string): string => {
    if (!allowed[target] || !pathInside(project, target, deps)) {
      if (!pathInside(project, target, deps)) return 'outside the project';
      return 'not a file install writes for this harness';
    }
    if (typeof deps.lstatKind !== 'function' || typeof deps.realPath !== 'function') return 'this runtime cannot resolve the path';
    const projectReal = deps.realPath(project);
    if (!projectReal) return 'the project cannot be resolved';
    const kind = deps.lstatKind(target);
    if (kind === 'symlink') return 'the path is a symlink';
    if (kind !== 'file' && kind !== 'missing') return 'not a regular file';
    let cur = deps.dirname(target);
    const stop = deps.resolvePath(project, '.');
    while (deps.resolvePath(cur, '.') !== stop) {
      const k = deps.lstatKind(cur);
      if (k === 'symlink') return 'a parent directory is a symlink';
      if (k !== 'dir') return 'a parent is not a directory';
      const parent = deps.dirname(cur);
      if (deps.resolvePath(parent, '.') === deps.resolvePath(cur, '.')) return 'outside the project';
      cur = parent;
    }
    const anchor = kind === 'missing' ? deps.dirname(target) : target;
    const real = deps.realPath(anchor);
    if (!real) return 'this runtime cannot resolve the path';
    if (!pathInside(projectReal, real, deps)) return 'resolves outside the project';
    const lexicalRel = deps.relativePath(project, anchor).replace(/\\/g, '/');
    const realRel = deps.relativePath(projectReal, real).replace(/\\/g, '/');
    if (lexicalRel !== realRel) return 'a parent directory is a symlink';
    return '';
  };
  // One dry-run install, shared by every unsigned create. The plan's texts
  // are what install would write now. The record's saved copy is not used.
  // A missing --state, or a plan that refuses, authorizes nothing.
  let planMap: Record<string, string> | null = null;
  const expectedText = (target: string): string | undefined => {
    if (!planMap) {
      const built: Record<string, string> = {};
      if (flags.state) {
        const plan = installHarness(harness, { ...flags, 'dry-run': 'true' }, deps);
        if (plan.code === 0 && plan.writes) {
          for (let i = 0; i < plan.writes.length; i++) built[plan.writes[i].path] = plan.writes[i].text;
        }
      }
      planMap = built;
    }
    return planMap[target];
  };
  const notes: string[] = [];
  const problems: string[] = [];
  // Entries that are not fully cleaned stay in the record. Finished ones are
  // dropped so a later uninstall can retry the rest without tripping over
  // files it has already removed.
  const remaining: { path?: unknown; action?: unknown; backup?: unknown; written?: unknown }[] = [];
  for (const f of rec.files as { path?: unknown; action?: unknown; backup?: unknown; written?: unknown }[]) {
    const keep = () => { remaining.push(f); };
    if (!f || typeof f.path !== 'string' || (f.action !== 'create' && f.action !== 'modify') || typeof f.written !== 'string') {
      problems.push('install record has an entry this uninstall does not understand; refusing to touch it');
      keep();
      continue;
    }
    const why = owned(f.path);
    if (why) {
      problems.push('refusing to touch ' + f.path + ': ' + why);
      keep();
      continue;
    }
    if (!authed) {
      // No backup is read. A modify can only be restored with a matching mac.
      if (f.action === 'modify') {
        problems.push('refusing to restore ' + f.path + ': the install record has no mac; re-run with --key');
        keep();
        continue;
      }
      const expected = expectedText(f.path);
      const current = deps.readFile(f.path);
      if (expected === undefined || current !== expected) {
        problems.push('refusing to remove ' + f.path + ': the install record has no mac; re-run with --key');
        keep();
        continue;
      }
      if (!remove(f.path)) { problems.push('could not remove ' + f.path); keep(); continue; }
      notes.push('removed ' + f.path + ' (created by install; matched the generated config)');
      if (pathInside(root, f.written, deps)) {
        if (!remove(f.written)) { problems.push('could not remove saved copy ' + f.written); keep(); continue; }
        notes.push('removed saved copy ' + f.written);
      }
      continue;
    }
    if (!pathInside(root, f.written, deps) || (typeof f.backup === 'string' && f.backup && !pathInside(root, f.backup, deps))) {
      problems.push('refusing to use a backup or saved copy outside ' + root);
      keep();
      continue;
    }
    const written = deps.readFile(f.written);
    const current = deps.readFile(f.path);
    if (f.action === 'modify') {
      // A file already put back can be finished on a retry, including when the
      // saved copy was removed but the backup is still there. A third set of
      // bytes is refused: uninstall will not overwrite edits made after install.
      // A missing backup is never treated as success (that would drop the
      // record while the installed hooks were still in place).
      if (typeof f.backup !== 'string' || !f.backup) { problems.push('no backup path for ' + f.path); keep(); continue; }
      const bak = deps.readFile(f.backup);
      if (bak === null) { problems.push('refusing to change ' + f.path + ': backup missing ' + f.backup); keep(); continue; }
      if (written === null && current !== bak) {
        problems.push('refusing to touch ' + f.path + ': the saved copy of what install wrote is missing (' + f.written + ')');
        keep();
        continue;
      }
      if (current !== null && current !== bak && written !== null && current !== written) {
        problems.push('refusing to restore ' + f.path + ': its contents no longer match what install wrote');
        keep();
        continue;
      }
      if (current !== bak) {
        deps.writeFile(f.path, bak);
        if (deps.readFile(f.path) !== bak) { problems.push('restore failed for ' + f.path); keep(); continue; }
        notes.push('restored ' + f.path + ' from ' + f.backup);
      } else notes.push('already restored ' + f.path);
      // The saved copy goes first. If it cannot be removed, the backup is
      // still there for the retry.
      let copyOk = true;
      if (written !== null) {
        if (!remove(f.written)) { problems.push('could not remove saved copy ' + f.written); copyOk = false; }
        else notes.push('removed saved copy ' + f.written);
      }
      if (!copyOk) { keep(); continue; }
      if (!remove(f.backup)) { problems.push('restored ' + f.path + ' but could not remove backup ' + f.backup); keep(); }
      else notes.push('removed backup ' + f.backup);
      continue;
    }
    if (written === null) {
      problems.push('refusing to touch ' + f.path + ': the saved copy of what install wrote is missing (' + f.written + ')');
      keep();
      continue;
    }
    if (current !== null && current !== written) {
      problems.push('refusing to remove ' + f.path + ': its contents no longer match what install wrote');
      keep();
      continue;
    } else if (current === null) {
      notes.push('already absent ' + f.path);
    } else if (!remove(f.path)) {
      problems.push('could not remove ' + f.path);
      keep();
      continue;
    } else notes.push('removed ' + f.path + ' (created by install)');
    if (!remove(f.written)) { problems.push('could not remove saved copy ' + f.written); keep(); }
    else notes.push('removed saved copy ' + f.written);
  }
  const stdout = notes.length ? notes.join('\n') + '\n' : '';
  if (problems.length) {
    const recOut: { v: number; harness: string; files: typeof remaining; mac?: string } = { v: 1, harness, files: remaining };
    if (keyText) {
      if (typeof deps.mac !== 'function') {
        return { code: 1, stdout, stderr: problems.join('\n') + '\ncould not authenticate the remaining install record; left the previous record in place\n' };
      }
      const m = deps.mac(keyText, installRecordPayload(harness, remaining));
      if (!m) {
        return { code: 1, stdout, stderr: problems.join('\n') + '\ncould not authenticate the remaining install record; left the previous record in place\n' };
      }
      recOut.mac = m;
    }
    deps.writeFile(manifestPath, JSON.stringify(recOut, null, 2) + '\n');
    return { code: 1, stdout, stderr: problems.join('\n') + '\ninstall record kept at ' + manifestPath + '\n' };
  }
  if (!remove(manifestPath)) return { code: 1, stdout, stderr: 'files restored but could not remove install record ' + manifestPath + '\n' };
  return { code: 0, stdout: stdout + 'removed install record ' + manifestPath + '\n', stderr: '' };
}

/** ARGV array baked into a generated Pi, OpenCode or OpenClaw plugin, in order. */
export function pluginArgv(source: string): string[] | null {
  const m = /const ARGV = \[([\s\S]*?)\];/.exec(source);
  if (!m) return null;
  const args: string[] = [];
  const re = /"(?:\\.|[^"\\])*"/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1]))) {
    try { args.push(JSON.parse(x[0])); } catch { return null; }
  }
  return args.length ? args : null;
}

/**
 * A pre-tool payload the spec cannot map, plus the deny text the adapter
 * prints for it. The tool name is chosen so it is not one of this spec's
 * map names. Windsurf's tool name is the synthetic mcp__server__tool form.
 */
export function doctorProbe(harness: string, project: string, rules: { tools: string[] }[]): { body: Record<string, unknown>; marker: string } {
  const used: Record<string, boolean> = {};
  for (const r of rules) for (const t of (r && r.tools) || []) used[t] = true;
  let n = 2;
  let raw = '__speckl_doctor__';
  while (used[raw]) { raw = '__speckl_doctor_' + n + '__'; n++; }
  if (harness === 'windsurf') {
    let server = raw;
    let tool = 'mcp__' + server + '__probe';
    while (used[tool]) { server = '__speckl_doctor_' + n + '__'; n++; tool = 'mcp__' + server + '__probe'; }
    return {
      body: {
        agent_action_name: 'pre_mcp_tool_use',
        tool_info: { mcp_server_name: server, mcp_tool_name: 'probe', mcp_tool_arguments: {} },
        trajectory_id: 'speckl-doctor',
        cwd: project,
      },
      marker: 'unmapped harness tool ' + JSON.stringify(tool),
    };
  }
  const id = 'speckl-doctor';
  const bodies: Record<string, Record<string, unknown>> = {
    'claude-code': { hook_event_name: 'PreToolUse', tool_name: raw, tool_input: {}, tool_use_id: id, cwd: project },
    cursor: { hook_event_name: 'preToolUse', tool_name: raw, tool_input: {}, tool_use_id: id, cwd: project },
    codex: { hook_event_name: 'PreToolUse', tool_name: raw, tool_input: {}, tool_use_id: id, cwd: project },
    gemini: { hook_event_name: 'BeforeTool', tool_name: raw, tool_input: {}, session_id: id, cwd: project },
    copilot: { hook_event_name: 'preToolUse', toolName: raw, toolArgs: {}, sessionId: id },
    goose: { event: 'PreToolUse', tool_name: raw, tool_input: {}, tool_call_id: id, working_dir: project },
    hermes: { hook_event_name: 'pre_tool_call', tool_name: raw, tool_input: {}, extra: { tool_call_id: id } },
    pi: { type: 'tool_call', toolName: raw, input: {}, toolCallId: id, cwd: project },
    opencode: { hook: 'tool.execute.before', input: { tool: raw, callID: id, sessionID: id }, output: { args: {} }, directory: project },
    openclaw: { hook: 'before_tool_call', event: { toolName: raw, params: {}, toolCallId: id }, ctx: { sessionId: id } },
    cline: { hookName: 'PreToolUse', preToolUse: { toolName: raw, parameters: {} }, taskId: id, workspaceRoots: [project] },
    kiro: { hook_event_name: 'PreToolUse', tool_name: raw, tool_input: {}, session_id: id, cwd: project },
  };
  return { body: bodies[harness] || { tool_name: raw }, marker: 'unmapped harness tool ' + JSON.stringify(raw) };
}

/**
 * What the installed pre hook did with a probe the spec forbids.
 * `open` means the harness would let that call run. An exit of 0 is a pass
 * only when the adapter's own unmapped-tool deny is present and the reply
 * carries that harness's block field (Cline `cancel: true`, Pi / OpenCode /
 * OpenClaw `decision: "block"`, Cursor `permission: "deny"`). Every other
 * exit 0 is fail-open, including deny text with the field missing or wrong.
 * Claude Code, Codex, Gemini, Copilot, Goose, Hermes, Kiro and Windsurf
 * block with exit 2, so exit 0 from them is fail-open. Anything that does
 * not show the adapter's own deny is not a pass.
 */
export function classifyProbe(harness: string, r: HookResult, marker: string): { kind: 'denied' | 'open' | 'missing' | 'unproved'; line: string } {
  const out = r.stdout || '';
  const err = r.stderr || '';
  const proved = (out + '\n' + err).includes(marker);
  let body: Record<string, unknown> | null = null;
  const lines = out.trim().split('\n').filter(Boolean);
  if (lines.length) {
    try {
      const b = JSON.parse(lines[lines.length - 1]);
      if (b && typeof b === 'object' && !Array.isArray(b)) body = b as Record<string, unknown>;
    } catch { body = null; }
  }
  if (r.status === 0) {
    let blocked = false;
    if (harness === 'cline') blocked = !!body && body.cancel === true;
    else if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') blocked = !!body && body.decision === 'block';
    else if (harness === 'cursor') blocked = !!body && body.permission === 'deny';
    if (blocked && proved) return { kind: 'denied', line: 'probe: denied (' + marker + '). The installed hook is wired and fail closed.' };
    if (blocked) {
      const detail = (err || out).trim().split('\n')[0] || 'no output';
      return {
        kind: 'unproved',
        line: 'probe: NOT PROVED — exit 0 without an unmapped-tool deny (' + detail + '). A wrapper can exit 0 while the adapter never ran, so this is not a pass.',
      };
    }
    return {
      kind: 'open',
      line: 'probe: FAIL OPEN — the installed hook would allow a tool the spec does not map (' + marker + '). That call must be denied.',
    };
  }
  if (proved) return { kind: 'denied', line: 'probe: denied (' + marker + '). The installed hook is wired and fail closed.' };
  if (r.status === null || /ENOENT|not found|No such file|cannot find/i.test(err)) {
    return { kind: 'missing', line: 'probe: HOOK MISSING — the installed command did not run (' + ((err || '').trim().split('\n')[0] || 'no output') + ').' };
  }
  const detail = (err || out).trim().split('\n')[0] || 'no output';
  return {
    kind: 'unproved',
    line: 'probe: NOT PROVED — exit ' + String(r.status) + ' without an unmapped-tool deny (' + detail + '). A wrapper can exit 2 while the adapter never ran, so this is not a pass.',
  };
}

/**
 * `status` reads the installed config, the key file and the state file.
 * `doctor` (probe true) also runs the installed pre hook on a tool the spec
 * does not map and requires the adapter's own deny. Neither writes, and
 * neither treats a missing or silent hook as success.
 */
export function inspectHarness(
  harness: string,
  flags: Record<string, string>,
  rules: { tools: string[] }[],
  config: AdapterConfig,
  deps: AdapterDeps,
  env: Record<string, string | undefined>,
  probe: boolean,
): AdapterOutput {
  const merged: Record<string, string> = {};
  for (const k of Object.keys(flags)) merged[k] = flags[k];
  if (!merged.key && env.SPECKL_STATE_KEY_FILE) merged.key = env.SPECKL_STATE_KEY_FILE;
  if (!merged.project || !merged.state || (harness === 'hermes' && !merged['hermes-home'])) {
    const extra = harness === 'hermes' ? ' --hermes-home <profile dir, e.g. ~/.hermes>' : '';
    return { code: 1, stdout: '', stderr: 'usage: adapter.mjs ' + (probe ? 'doctor' : 'status') + ' ' + harness + ' --project <dir> --state <file> [--key <file>]' + extra + '\n' };
  }
  const project = deps.resolvePath(deps.cwd, merged.project);
  const stateAbs = deps.resolvePath(deps.cwd, merged.state);
  const keyAbs = merged.key ? deps.resolvePath(deps.cwd, merged.key) : null;
  const userScope = harness === 'goose' || harness === 'pi' || harness === 'opencode';
  const pluginsDir = userScope && merged['plugins-dir'] ? deps.resolvePath(deps.cwd, merged['plugins-dir']) : '';
  let pluginName = 'speckl';
  if (pluginsDir) {
    let h = 0x811c9dc5;
    for (let i = 0; i < project.length; i++) { h ^= project.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    pluginName = 'speckl-' + h.toString(16).padStart(8, '0');
  }
  const hermesHome = harness === 'hermes' ? deps.resolvePath(deps.cwd, merged['hermes-home']) : '';
  const paths = installFilePaths(harness, project, { hermesHome, pluginsDir, pluginName }, deps);
  const lines: string[] = [];
  const problems: string[] = [];
  let warn = '';
  let dev = false;
  const stText = deps.readFile(stateAbs);
  if (stText === null) { problems.push('state'); lines.push('state: MISSING ' + stateAbs); }
  else {
    let st: Record<string, unknown> | null = null;
    try {
      const p = JSON.parse(stText);
      if (p && typeof p === 'object' && !Array.isArray(p)) st = p as Record<string, unknown>;
    } catch { st = null; }
    if (!st) { problems.push('state'); lines.push('state: not a JSON object ' + stateAbs); }
    else if (typeof st.runId !== 'string' || !Array.isArray(st.log) || !st.machine || typeof st.machine !== 'object' || Array.isArray(st.machine)) {
      problems.push('state');
      lines.push('state: missing runId, log or machine ' + stateAbs + ' (re-create it with signal.mjs init)');
    } else {
      dev = st.dev === true;
      const machine = st.machine as Record<string, unknown>;
      const sv = config.stageVariable || 'stage';
      const cur = machine[sv];
      let stage = sv + '=' + (cur === undefined ? '(absent)' : String(cur));
      if (typeof cur === 'number' && config.stages) {
        for (const name of Object.keys(config.stages)) if (config.stages[name] === cur) stage = sv + '=' + name + ' (' + String(cur) + ')';
      }
      let awaited = '';
      if (typeof cur === 'number' && config.awaits) {
        for (const a of config.awaits) if (a && a.stateValue === cur) { awaited = ' awaiting ' + a.signal + ' (' + a.mode + ')'; break; }
      }
      const pend = st.pending;
      const pending = pend && typeof pend === 'object' && !Array.isArray(pend) && typeof (pend as Record<string, unknown>).tool === 'string'
        ? String((pend as Record<string, unknown>).tool) : 'none';
      let mac = 'mac=absent';
      if (typeof st.mac === 'string' && /^[0-9a-fA-F]{64}$/.test(st.mac)) mac = 'mac=present (not replayed; hook.mjs checks it on a real call)';
      else if (!dev) { problems.push('mac'); mac = 'mac=MISSING on a non-dev state'; }
      lines.push('state: present ' + stateAbs + ' run=' + st.runId + ' ' + stage + awaited + ' pending=' + pending + ' ' + mac);
    }
  }
  if (!keyAbs) {
    if (dev) lines.push('key: none (dev state; the MAC is not checked)');
    else { problems.push('key'); lines.push('key: MISSING (pass --key or set SPECKL_STATE_KEY_FILE)'); }
  } else {
    const rel = deps.relativePath(project, keyAbs).replace(/\\/g, '/');
    const inside = rel !== '' && !rel.startsWith('..') && !rel.startsWith('../') && !/^[A-Za-z]:|^\//.test(rel);
    const keyText = deps.readFile(keyAbs);
    if (keyText === null) { problems.push('key'); lines.push('key: MISSING ' + keyAbs); }
    else if (!/^[0-9a-fA-F]{64}\s*$/.test(keyText)) { problems.push('key'); lines.push('key: not 64 hex characters ' + keyAbs + ' (contents not shown)'); }
    else if (inside) { warn = 'WARN: the state key is inside the project; keep it where the agent cannot read it\n'; lines.push('key: present ' + keyAbs + ' (inside the project)'); }
    else lines.push('key: present ' + keyAbs);
  }
  const walk = (v: unknown, acc: string[]): void => {
    if (typeof v === 'string') acc.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, acc);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, acc);
  };
  const jsonPre = (value: unknown): string | null => {
    const acc: string[] = [];
    walk(value, acc);
    const tag = ' ' + harness + ' pre';
    for (const s of acc) if (s.includes('adapter.mjs') && s.includes(tag)) return s;
    return null;
  };
  const hermesPre = (yaml: string): string | null => {
    const found: string[] = [];
    for (const line of yaml.split('\n')) {
      const m = /^\s*-?\s*command:\s*(.*)$/.exec(line);
      if (!m) continue;
      const raw = m[1].trim();
      let cmd = raw;
      if (raw.charAt(0) === '"') { try { cmd = JSON.parse(raw); } catch { cmd = raw; } }
      found.push(cmd);
    }
    for (const c of found) if (c.includes('adapter.mjs') && c.includes(' hermes pre')) return c;
    return null;
  };
  let command = '';
  let pluginNote = '';
  if (harness === 'hermes') {
    const yaml = deps.readFile(paths[0]);
    const got = yaml ? hermesPre(yaml) : null;
    if (!got) { problems.push('config'); lines.push('config: HOOK MISSING — ' + paths[0] + ' has no Speckl hermes pre command'); }
    else {
      let approved = false;
      const allowText = deps.readFile(paths[1]);
      if (allowText) {
        try {
          const allow = JSON.parse(allowText) as { approvals?: unknown };
          const list = allow && Array.isArray(allow.approvals) ? allow.approvals : [];
          for (const e of list) if (e && typeof e === 'object' && (e as Record<string, unknown>).command === got) approved = true;
        } catch { approved = false; }
      }
      if (!approved) {
        problems.push('config');
        lines.push('config: FAIL OPEN — the pre command is not in ' + paths[1] + ' (Hermes skips an unapproved hook and the call runs)');
      } else lines.push('config: ok ' + paths[0]);
      command = approved ? got : '';
    }
  } else if (harness === 'cline') {
    const script = deps.readFile(paths[0]);
    if (script === null || !script.includes('Generated by speckl adapter.mjs install cline') || !script.includes(' cline pre')) {
      problems.push('config');
      lines.push('config: HOOK MISSING ' + paths[0] + ' (Speckl PreToolUse script is not installed)');
    } else { command = 'sh ' + shellQuote(paths[0]); lines.push('config: ok ' + paths[0]); }
  } else if (harness === 'pi' || harness === 'opencode' || harness === 'openclaw') {
    const src = deps.readFile(paths[0]);
    const argv = src && src.includes('Generated by speckl adapter.mjs install ' + harness) ? pluginArgv(src) : null;
    if (!argv) {
      problems.push('config');
      lines.push('config: HOOK MISSING — ' + paths[0] + ' is not a Speckl ' + harness + ' plugin, or its adapter command could not be read');
    } else {
      const abs: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        // The same positions pluginSource resolves: the adapter, and the
        // values of --state and --key. Flags and other values stay literal
        // (`--state` is not a path, and neither is `--outside`'s `allow`).
        const pathArg = i === 0 || argv[i - 1] === '--state' || argv[i - 1] === '--key';
        const absolute = a.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(a);
        abs.push(pathArg && !absolute ? deps.resolvePath(project, a) : a);
      }
      const parts = ['node', shellQuote(abs[0]), harness, 'pre'];
      for (let i = 1; i < abs.length; i++) parts.push(shellQuote(abs[i]));
      command = parts.join(' ');
      lines.push('config: ok ' + paths[0]);
      pluginNote = 'plugin: ' + (probe ? 'ran' : 'found') + ' the adapter command stored in ' + paths[0]
        + '. This does not prove ' + harness + ' loaded the plugin (a plugin that fails to load is skipped and tool calls run unchecked).';
    }
  } else {
    let found = '';
    let foundAt = '';
    let bad = '';
    for (const p of paths) {
      const text = deps.readFile(p);
      if (text === null || text.trim() === '') continue;
      let obj: unknown;
      try { obj = JSON.parse(text); } catch { bad = p + ' is not valid JSON'; continue; }
      const cmd = jsonPre(obj);
      if (cmd) { found = cmd; foundAt = p; break; }
    }
    if (!found) {
      problems.push('config');
      lines.push('config: HOOK MISSING — ' + (bad || paths.join(' and ') + ' has no Speckl ' + harness + ' pre hook'));
    } else { command = found; lines.push('config: ok ' + foundAt); }
  }
  if (!probe) lines.push('probe: not run (status checks files only; doctor sends an unmapped tool through the installed hook)');
  else if (!command) lines.push('probe: not run (there is no installed hook command to test)');
  else if (typeof deps.runCommand !== 'function') {
    problems.push('probe');
    lines.push('probe: NOT RUN — this runtime cannot execute the installed hook');
  } else {
    const spec = doctorProbe(harness, project, rules);
    const extra: Record<string, string> = {};
    if (harness === 'claude-code') extra.CLAUDE_PROJECT_DIR = project;
    if (harness === 'gemini') extra.GEMINI_PROJECT_DIR = project;
    if (harness === 'cursor') extra.CURSOR_PROJECT_DIR = project;
    const ran = deps.runCommand(command, JSON.stringify(spec.body), project, extra);
    const verdict = classifyProbe(harness, ran, spec.marker);
    lines.push(verdict.line);
    if (verdict.kind !== 'denied') problems.push('probe');
  }
  if (pluginNote) lines.push(pluginNote);
  // The same key material a denial redacts. status and doctor print paths on
  // purpose; the key path is not one of them.
  const secrets: string[] = [];
  const remember = (p: unknown) => { if (typeof p === 'string' && p) secrets.push(p); };
  const canonical = (p: string): string | null => {
    if (typeof deps.realpath === 'function') {
      try {
        const real = deps.realpath(p);
        if (typeof real === 'string' && real) return real;
      } catch { /* try realPath */ }
    }
    if (typeof deps.realPath === 'function') {
      try {
        const real = deps.realPath(p);
        if (typeof real === 'string' && real) return real;
      } catch { /* add nothing */ }
    }
    return null;
  };
  const addPath = (p: unknown) => {
    if (typeof p !== 'string' || !p) return;
    remember(p);
    let abs = '';
    try {
      const resolved = deps.resolvePath(deps.cwd, p);
      if (typeof resolved === 'string' && resolved) { remember(resolved); abs = resolved; }
    } catch { /* resolution must not turn a status line into a throw */ }
    const real = canonical(p);
    if (real) {
      remember(real);
      const parent = deps.dirname(real);
      if (typeof parent === 'string' && parent && parent !== real) remember(parent);
    }
    if (abs && abs !== p) {
      const realAbs = canonical(abs);
      if (realAbs && realAbs !== real) {
        remember(realAbs);
        const parent = deps.dirname(realAbs);
        if (typeof parent === 'string' && parent && parent !== realAbs) remember(parent);
      }
    }
  };
  addPath(merged.key);
  addPath(env.SPECKL_STATE_KEY_FILE);
  const keyFiles: string[] = [];
  if (typeof merged.key === 'string' && merged.key) keyFiles.push(merged.key);
  if (typeof env.SPECKL_STATE_KEY_FILE === 'string' && env.SPECKL_STATE_KEY_FILE) keyFiles.push(env.SPECKL_STATE_KEY_FILE);
  for (const f of keyFiles) {
    let text: string | null = null;
    try { text = deps.readFile(f); } catch { text = null; }
    if (!text) {
      try {
        const abs = deps.resolvePath(deps.cwd, f);
        if (typeof abs === 'string' && abs) text = deps.readFile(abs);
      } catch { text = null; }
    }
    if (typeof text === 'string' && text) {
      remember(text);
      const trimmed = text.trim();
      if (trimmed) remember(trimmed);
    }
  }
  if (stText) {
    try {
      const parsed = JSON.parse(stText) as { signers?: unknown };
      const signers = parsed && parsed.signers;
      if (Array.isArray(signers)) {
        for (const s of signers) {
          if (s && typeof s === 'object' && typeof (s as { key?: unknown }).key === 'string') remember((s as { key: string }).key);
        }
      }
    } catch { /* unreadable state is not a reason to leak */ }
  }
  let stdout = scrubDenyText(lines.join('\n') + '\n', secrets);
  let stderrOut = warn ? scrubDenyText(warn, secrets) : warn;
  const shorts: string[] = [];
  for (const secret of secrets) {
    if (secret.length >= 2 && secret.length < 8 && (secret.indexOf('/') !== -1 || secret === merged.key || secret === env.SPECKL_STATE_KEY_FILE)) shorts.push(secret);
  }
  shorts.sort((a, b) => b.length - a.length);
  const hideShort = (text: string) => {
    let s = text;
    for (const p of shorts) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp('(^|[\\s"\'=:])' + esc + '($|[\\s"\'=:])', 'g'), '$1<keyfile>$2');
    }
    return s;
  };
  stdout = hideShort(stdout);
  stderrOut = hideShort(stderrOut);
  return { code: problems.length ? 1 : 0, stdout, stderr: stderrOut };
}

/**
 * Adapter entry point: `<harness> pre|post|post-failure|batch --state <file> [--key <file>]`,
 * `install`, `uninstall`, `status` or `doctor`. Returns what the process should print and its exit code.
 */
export function runAdapter(
  argv: string[],
  env: Record<string, string | undefined>,
  stdinText: string,
  config: AdapterConfig,
  deps: AdapterDeps,
): AdapterOutput {
  const harnesses = config.harness || {};
  if (argv[0] === 'install' || argv[0] === 'uninstall' || argv[0] === 'status' || argv[0] === 'doctor') {
    const h = argv[1] || '';
    if (!harnesses[h]) {
      return { code: 1, stdout: '', stderr: 'unknown or undeclared harness ' + JSON.stringify(h) + ' (declared: ' + (Object.keys(harnesses).join(', ') || 'none') + ')\n' };
    }
    const flags = parseAdapterFlags(argv.slice(2));
    if (argv[0] === 'install') return installHarness(h, flags, deps);
    if (argv[0] === 'uninstall') return uninstallHarness(h, flags, deps);
    return inspectHarness(h, flags, harnesses[h].rules || [], config, deps, env, argv[0] === 'doctor');
  }
  const harness = argv[0] || '';
  const event = argv[1] || '';
  const flags = parseAdapterFlags(argv.slice(2));
  const isPre = event === 'pre';
  const envDir = harness === 'cursor' ? env.CURSOR_PROJECT_DIR
    : harness === 'gemini' ? env.GEMINI_PROJECT_DIR
      : harness === 'claude-code' ? env.CLAUDE_PROJECT_DIR : undefined;
  let projectDir = flags.project || envDir || deps.cwd;
  const secretsFor = (): string[] => {
    const secrets: string[] = [];
    const addReal = (p: string) => {
      if (typeof deps.realpath !== 'function') return;
      try {
        const real = deps.realpath(p);
        if (typeof real !== 'string' || !real) return;
        secrets.push(real);
        const parent = deps.dirname(real);
        if (typeof parent === 'string' && parent && parent !== real) secrets.push(parent);
      } catch { /* realpath failed: add nothing */ }
    };
    const addPath = (p: unknown) => {
      if (typeof p !== 'string' || !p) return;
      secrets.push(p);
      let abs = '';
      try {
        const resolved = deps.resolvePath(projectDir, p);
        if (typeof resolved === 'string' && resolved) { secrets.push(resolved); abs = resolved; }
      } catch { /* resolution must not turn a deny into a throw */ }
      try {
        const fromCwd = deps.resolvePath(deps.cwd, p);
        if (typeof fromCwd === 'string' && fromCwd) secrets.push(fromCwd);
      } catch { /* ignore */ }
      addReal(p);
      if (abs && abs !== p) addReal(abs);
    };
    addPath(flags.key);
    addPath(env.SPECKL_STATE_KEY_FILE);
    const files: string[] = [];
    if (typeof flags.key === 'string' && flags.key) files.push(flags.key);
    if (typeof env.SPECKL_STATE_KEY_FILE === 'string' && env.SPECKL_STATE_KEY_FILE) files.push(env.SPECKL_STATE_KEY_FILE);
    for (const f of files) {
      let text: string | null = null;
      try { text = deps.readFile(f); } catch { text = null; }
      if (!text) {
        try {
          const abs = deps.resolvePath(projectDir, f);
          if (typeof abs === 'string' && abs) text = deps.readFile(abs);
        } catch { text = null; }
      }
      if (typeof text === 'string' && text) {
        secrets.push(text);
        const trimmed = text.trim();
        if (trimmed) secrets.push(trimmed);
      }
    }
    if (flags.state) {
      try {
        const raw = deps.readFile(deps.resolvePath(projectDir, flags.state));
        const st = raw ? JSON.parse(raw) : null;
        const signers = st && st.signers;
        if (Array.isArray(signers)) {
          for (const s of signers) {
            if (s && typeof s.key === 'string' && s.key) secrets.push(s.key);
          }
        }
      } catch { /* unreadable state is not a reason to leak */ }
    }
    return secrets;
  };
  const shortKeyPath = 'Speckl denied (internal error, fail closed): the state key path is shorter than 8 characters, so it cannot be redacted. Next: the call stays denied. Use a longer key path. Do not retry this call.';
  const keyPathTooShort = (p: unknown): boolean => {
    if (typeof p !== 'string' || p.length === 0) return false;
    if (p.length < 8) return true;
    const bases = [projectDir, deps.cwd];
    for (let i = 0; i < bases.length; i++) {
      try {
        const abs = deps.resolvePath(bases[i], p);
        if (typeof abs === 'string' && abs.length < 8) return true;
      } catch { /* a path that will not resolve is not treated as short */ }
    }
    return false;
  };
  const emitDeny = (msg: string): AdapterOutput => {
    if (event === 'batch') return { code: 0, stdout: '', stderr: msg + '\n' };
    // A turn-end hook never blocks: on Gemini exit 2 would force a retry turn.
    if (event === 'turn-end') return { code: 0, stdout: harness === 'gemini' ? '{}\n' : '', stderr: msg + '\n' };
    if (isPre || harnessEventName(harness, event) === null) return formatPre(harness, false, msg);
    return formatPost(harness, msg);
  };
  if (keyPathTooShort(flags.key) || keyPathTooShort(env.SPECKL_STATE_KEY_FILE)) return emitDeny(shortKeyPath);
  const fail = (reason: string): AdapterOutput => emitDeny(explainAdapterDeny(reason, secretsFor()));
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
  if (!flags.project && !envDir && typeof payload.cwd === 'string' && payload.cwd) projectDir = payload.cwd;
  if (keyPathTooShort(flags.key) || keyPathTooShort(env.SPECKL_STATE_KEY_FILE)) return emitDeny(shortKeyPath);
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== expected) {
    return fail('payload is ' + JSON.stringify(payload.hook_event_name) + ' but this hook is wired as ' + expected);
  }
  if (!flags.state) return fail('missing --state');

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
    if (r.status !== 0) return { code: 0, stdout: quiet, stderr: scrubDenyText('Speckl: could not clear the pending call: ' + interpretHook(r).reason, secretsFor()) + '\n' };
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
      return formatPost(harness, r.allow ? null : scrubDenyText('Speckl could not record blocked call ' + callId + ': ' + r.reason, secretsFor()));
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
  if (harness === 'kiro' && event === 'post' && Object.keys(pin0.input).length === 0) {
    // Kiro IDE often sends PostToolUse with an empty tool_input. The pending
    // call carries the spec tool and input its pre hook mapped; the derived
    // call id (session + tool name) ties the two together.
    const text = deps.readFile(stateAbs);
    let pending: Record<string, unknown> | null = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === 'object') pending = st.pending as Record<string, unknown>;
    } catch { /* hook.mjs reports a broken state on the next call */ }
    if (pending && callId !== null && pending.call_id === callId && typeof pending.tool === 'string') {
      const ok = postSucceeded(harness, event, payload);
      const r = interpretHook(deps.runHook('post', { tool: pending.tool, input: pending.input || {}, call_id: callId, ok }, stateAbs, keyAbs));
      return formatPost(harness, r.allow ? null : scrubDenyText('Speckl could not record ' + String(toolName) + ' (spec tool ' + pending.tool + '): ' + r.reason, secretsFor()));
    }
  }
  const pin = { ok: true, input: normalizeToolInput(harness, toolName, pin0.input) };
  const label = typeof toolName === 'string' ? toolName : '(no tool_name)';

  if (isPre) {
    const hit = findProtectedMention(pin.input, protectedPaths, callCwd, deps.resolvePath);
    if (hit) return fail(label + ' touches a Speckl-protected path (' + hit + '); the agent may not read or change its own rails');
    // OpenCode bash and OpenClaw exec take a workdir, Kiro shell tools a cwd: a mapped command run
    // elsewhere (`npm test` in another checkout) would advance the policy
    // on someone else's result, so only the project root is accepted.
    const wdField = harness === 'kiro' || harness === 'windsurf' ? 'cwd' : 'workdir';
    const wd = pin.input[wdField];
    if ((harness === 'opencode' || harness === 'openclaw' || harness === 'kiro' || harness === 'windsurf') && wd !== undefined && wd !== null && wd !== '') {
      if (typeof wd !== 'string' || deps.resolvePath(callCwd, wd) !== deps.resolvePath(projectDir, '.')) {
        return fail(label + ' sets ' + wdField + ' ' + JSON.stringify(wd) + '; Speckl only accepts commands run in the project root (' + projectDir + ')');
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
    return formatPre(harness, false, scrubDenyText('Speckl denied ' + label + ' (spec tool ' + m.tool + '): ' + r.reason, secretsFor()));
  }
  const ok = postSucceeded(harness, event, payload);
  const r = interpretHook(deps.runHook('post', { tool: m.tool, input: m.input, call_id: callId, ok }, stateAbs, keyAbs));
  if (r.allow && harness === 'windsurf' && toolName === 'run_command') {
    return formatPost(harness, 'Speckl recorded ' + label + ' (spec tool ' + m.tool + ') as not successful: Cascade does not report a command\'s exit status, so a terminal command never advances the policy. Use the tool mapped for this step (an MCP tool) instead.');
  }
  if (r.allow && harness === 'codex' && toolName === 'Bash') {
    return formatPost(harness, 'Speckl recorded ' + label + ' (spec tool ' + m.tool + ') as not successful: Codex does not report a Bash exit status, so a shell call never advances the policy. Use the tool mapped for this step instead.');
  }
  if (r.allow) return formatPost(harness, null);
  return formatPost(harness, scrubDenyText('Speckl could not record ' + label + ' (spec tool ' + m.tool + '): ' + r.reason, secretsFor()));
}

/** Functions emitted into adapter.mjs, in order. */
export const ADAPTER_FUNCTIONS = [
  redactSecrets, scrubDenyTextImpl, explainAdapterDenyImpl,
  hasShellControl, parseToolInput, mapHarnessCall, findProtectedMention, interpretHook,
  formatPre, formatPost, postSucceeded, harnessEventName, normalizeToolInput, harnessCallId,
  harnessConfigFile, harnessProtectedDirs, normalizePayload, parseAdapterFlags, hookCommandResult, shellQuote,
  buildHarnessHooks, mergeHarnessSettings, clineScripts, pluginSource, pluginFiles, hermesYaml, installHermes, installHarness,
  pathInside, unifiedDiff, installFilePaths, installRecordPayload, commitInstallWrites, uninstallHarness, pluginArgv, doctorProbe, classifyProbe, inspectHarness,
  runAdapter,
];
