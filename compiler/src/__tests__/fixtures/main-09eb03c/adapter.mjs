#!/usr/bin/env node
/**
 * Speckl harness adapter. Generated for ClaudeCodePolicy; harnesses: claude-code, cursor, codex, gemini, copilot, goose, hermes, pi, opencode, openclaw, cline, kiro, windsurf.
 *
 *   node adapter.mjs <harness> pre|post|post-failure|batch --state <file> [--key <file>]
 *       stdin: the harness's own hook JSON. Maps the call through the spec's
 *       harness block, runs hook.mjs, and answers in the harness's format.
 *   node adapter.mjs install <harness> --project <dir> --state <file> [--key <file>]
 *       merges the hook wiring into .claude/settings.json, .cursor/hooks.json,
 *       .codex/hooks.json, .gemini/settings.json, .github/hooks/speckl.json
 *       (Copilot) or .agents/plugins/speckl/ (Goose); Hermes takes
 *       --hermes-home <profile dir> and writes its config.yaml hooks block.
 *       Pi, OpenCode and OpenClaw get a generated plugin in .pi/extensions/,
 *       .opencode/plugins/ or .openclaw/plugins/speckl/ that pipes each
 *       tool event to this adapter and blocks unless it answers allow.
 *
 * Fail closed: unmapped tools, malformed payloads, protected paths and hook
 * errors deny (exit 2 + stderr, plus the harness's own deny JSON).
 * Do not edit: regenerate with speckl-compile <spec> -t agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const agentDir = path.dirname(fileURLToPath(import.meta.url));

function hasShellControl(value) {
  return /[;&|`$<>\r\n]/.test(value);
}

function parseToolInput(raw) {
  let v = raw;
  if (v === void 0 || v === null) v = {};
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, reason: "tool_input is a string that is not JSON" };
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, reason: "tool_input must be a JSON object" };
  }
  return { ok: true, input: v };
}

function mapHarnessCall(rules, toolName, input) {
  if (typeof toolName !== "string" || toolName === "") {
    return { ok: false, reason: "payload has no tool_name" };
  }
  let chained = "";
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule.tools.includes(toolName)) continue;
    if (rule.field !== void 0) {
      const value = input[rule.field];
      if (typeof value !== "string") continue;
      if (hasShellControl(value)) chained = rule.field;
      let re;
      try {
        re = new RegExp("^(?:" + (rule.pattern ?? "") + ")$");
      } catch {
        return { ok: false, reason: "map rule " + (i + 1) + " has an invalid pattern" };
      }
      if (!re.test(value)) continue;
      if (hasShellControl(value)) {
        return { ok: false, reason: rule.field + " contains shell control characters (; & | ` $ < > or a newline); run one plain command per call" };
      }
    }
    const out = {};
    for (const m of rule.inputs) {
      if (!Object.prototype.hasOwnProperty.call(input, m.field)) {
        return { ok: false, reason: rule.target + " needs " + m.param + " but tool_input has no " + m.field };
      }
      out[m.param] = input[m.field];
    }
    return { ok: true, tool: rule.target, input: out, rule: i };
  }
  if (chained) {
    return { ok: false, reason: chained + " contains shell control characters (; & | ` $ < > or a newline) and matches no map line; run one plain command per call" };
  }
  return {
    ok: false,
    reason: "unmapped harness tool " + JSON.stringify(toolName) + " (fail closed): no map line in the spec's harness block matches this call"
  };
}

function findProtectedMention(input, protectedPaths, cwd, resolvePath) {
  const contentKeys = ["content", "new_string", "old_string", "new_source", "description", "prompt", "edits", "file_text", "new_str", "old_str", "before", "after", "oldString", "newString", "old_text", "new_text"];
  const norm = (p) => p.replace(/\\/g, "/");
  const prots = protectedPaths.map((p) => ({ abs: norm(p.abs), rel: norm(p.rel) }));
  const checkString = (s) => {
    const ns = norm(s);
    for (const p of prots) {
      if (p.abs && ns.includes(p.abs)) return p.abs;
      if (p.rel && p.rel !== "." && !p.rel.startsWith("..")) {
        const esc = p.rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp("(^|[^A-Za-z0-9_.-])" + esc + "($|[^A-Za-z0-9_.-])").test(ns)) return p.rel;
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
  const walk = (v, depth) => {
    if (depth > 20) return "(input nested too deeply)";
    if (typeof v === "string") return checkString(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const h = walk(x, depth + 1);
        if (h) return h;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (contentKeys.includes(k)) continue;
        const h = walk(x, depth + 1);
        if (h) return h;
      }
    }
    return null;
  };
  return walk(input, 0);
}

function interpretHook(r) {
  let reason = "";
  let decision = "";
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (lines.length > 0) {
    try {
      const body = JSON.parse(lines[lines.length - 1]);
      if (body && typeof body.reason === "string") reason = body.reason;
      if (body && typeof body.decision === "string") decision = body.decision;
    } catch {
    }
  }
  if (r.status === 0) {
    if (decision === "allow") return { allow: true, reason: "" };
    return { allow: false, reason: "speckl hook error: exit 0 without a well-formed allow decision" };
  }
  if (r.status === 2) return { allow: false, reason: reason || "denied" };
  const detail = reason || (r.stderr || "").trim().split("\n")[0] || "no output";
  return { allow: false, reason: "speckl hook error (exit " + String(r.status) + "): " + detail };
}

function formatPre(harness, allow, message) {
  if (harness === "cursor") {
    if (allow) return { code: 0, stdout: JSON.stringify({ permission: "allow" }) + "\n", stderr: "" };
    return {
      code: 2,
      stdout: JSON.stringify({ permission: "deny", user_message: message, agent_message: message }) + "\n",
      stderr: message + "\n"
    };
  }
  if (harness === "copilot") {
    if (allow) return { code: 0, stdout: "", stderr: "" };
    return {
      code: 2,
      stdout: JSON.stringify({
        permissionDecision: "deny",
        permissionDecisionReason: message,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message }
      }) + "\n",
      stderr: message + "\n"
    };
  }
  if (harness === "goose" || harness === "hermes") {
    if (allow) return { code: 0, stdout: "", stderr: "" };
    return { code: 2, stdout: JSON.stringify({ decision: "block", reason: message }) + "\n", stderr: message + "\n" };
  }
  if (harness === "pi" || harness === "opencode" || harness === "openclaw") {
    if (allow) return { code: 0, stdout: JSON.stringify({ decision: "allow" }) + "\n", stderr: "" };
    return { code: 2, stdout: JSON.stringify({ decision: "block", reason: message }) + "\n", stderr: message + "\n" };
  }
  if (harness === "kiro" || harness === "windsurf") {
    if (allow) return { code: 0, stdout: JSON.stringify({ decision: "allow" }) + "\n", stderr: "" };
    return { code: 2, stdout: "", stderr: message + "\n" };
  }
  if (harness === "cline") {
    if (allow) return { code: 0, stdout: JSON.stringify({ cancel: false }) + "\n", stderr: "" };
    return { code: 2, stdout: JSON.stringify({ cancel: true, errorMessage: message }) + "\n", stderr: message + "\n" };
  }
  if (harness === "gemini") {
    if (allow) return { code: 0, stdout: "{}\n", stderr: "" };
    return { code: 2, stdout: "", stderr: message + "\n" };
  }
  if (allow) return { code: 0, stdout: "", stderr: "" };
  return { code: 2, stdout: "", stderr: message + "\n" };
}

function formatPost(harness, problem) {
  if (harness === "cursor") {
    if (!problem) return { code: 0, stdout: "{}\n", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ additional_context: problem }) + "\n", stderr: problem + "\n" };
  }
  if (harness === "codex" || harness === "gemini") {
    const ev = harness === "codex" ? "PostToolUse" : "AfterTool";
    if (!problem) return { code: 0, stdout: harness === "gemini" ? "{}\n" : "", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: problem } }) + "\n",
      stderr: problem + "\n"
    };
  }
  if (harness === "copilot") {
    if (!problem) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ additionalContext: problem }) + "\n", stderr: problem + "\n" };
  }
  if (harness === "pi" || harness === "opencode" || harness === "openclaw") {
    if (!problem) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ additionalContext: problem }) + "\n", stderr: problem + "\n" };
  }
  if (harness === "cline") {
    const body = { cancel: false };
    if (problem) body.contextModification = problem;
    return { code: 0, stdout: JSON.stringify(body) + "\n", stderr: problem ? problem + "\n" : "" };
  }
  if (harness === "kiro") {
    if (!problem) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: problem + "\n" };
  }
  if (harness === "goose" || harness === "hermes") {
    return { code: 0, stdout: "", stderr: problem ? problem + "\n" : "" };
  }
  if (!problem) return { code: 0, stdout: "", stderr: "" };
  return { code: 2, stdout: "", stderr: problem + "\n" };
}

function postSucceeded(harness, event, payload) {
  if (event !== "post") return false;
  const toolName = payload.tool_name;
  let out = harness === "cursor" ? payload.tool_output : payload.tool_response;
  if (harness === "codex") {
    if (toolName === "Bash") return false;
    if (toolName === "apply_patch") return typeof out === "string" && /^Exit code: 0(\n|$)/.test(out);
  }
  if (harness === "copilot") {
    const tr = payload.toolResult ?? payload.tool_result;
    if (!tr || typeof tr !== "object" || Array.isArray(tr)) return false;
    if ((tr.resultType ?? tr.result_type) !== "success") return false;
    if (toolName === "bash" || toolName === "powershell") {
      const text = tr.textResultForLlm ?? tr.text_result_for_llm;
      return typeof text === "string" && /<exited with exit code 0>\s*$/.test(text);
    }
    return true;
  }
  if (harness === "goose") return true;
  if (harness === "hermes") {
    const extra = payload.extra;
    if (!extra || typeof extra !== "object" || extra.status !== "ok") return false;
    let res = extra.result;
    if (typeof res === "string") {
      try {
        res = JSON.parse(res);
      } catch {
        return toolName !== "terminal";
      }
    }
    if (res && typeof res === "object" && !Array.isArray(res)) {
      const o = res;
      if (o.success === false) return false;
      if (toolName === "terminal") return o.exit_code === 0 && (o.error === void 0 || o.error === null || o.error === "");
      return true;
    }
    return toolName !== "terminal";
  }
  if (harness === "pi") {
    if (payload.isError !== false) return false;
    if (toolName === "bash" || toolName === "powershell") {
      const sc = payload.structuredContent;
      return !!sc && typeof sc === "object" && !Array.isArray(sc) && sc.exit_code === 0;
    }
    return true;
  }
  if (harness === "opencode") {
    const o = payload.output;
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (toolName === "bash") {
      const md = o.metadata;
      return !!md && typeof md === "object" && md.exit === 0;
    }
    return true;
  }
  if (harness === "openclaw") {
    const ev = payload.event;
    if (!ev || typeof ev !== "object") return false;
    if (ev.error !== void 0 && ev.error !== null && ev.error !== "") return false;
    const res = ev.result;
    if (!res || typeof res !== "object" || Array.isArray(res)) return false;
    if (res.isError === true) return false;
    const d = res.details;
    if (d && typeof d === "object" && (d.status === "error" || d.status === "failed")) return false;
    if (toolName === "exec" || toolName === "bash") {
      return !!d && typeof d === "object" && d.status === "completed" && d.exitCode === 0;
    }
    return true;
  }
  if (harness === "windsurf") {
    return toolName !== "run_command" && typeof toolName === "string" && toolName !== "";
  }
  if (harness === "kiro") {
    const shell = ["execute_bash", "execute_pwsh", "execute_cmd", "shell"].includes(String(toolName));
    if (typeof out === "string") {
      if (shell) {
        const codes = out.match(/Exit (?:Code|Status):\s*(-?\d+)/gi);
        return !!codes && /:\s*0$/.test(codes[codes.length - 1]);
      }
      return out.trim() !== "" && !/^\s*(error|failed|failure|tool .* failed|cannot|could not|unable to)\b/i.test(out);
    }
    if (!out || typeof out !== "object" || Array.isArray(out)) return false;
    const o = out;
    if (o.success === false || o.is_error === true || o.isError === true) return false;
    if (o.error !== void 0 && o.error !== null && o.error !== "") return false;
    if (shell) {
      const code = o.exit_status !== void 0 ? o.exit_status : o.exit_code !== void 0 ? o.exit_code : o.exitCode;
      return code === 0 || code === "0";
    }
    return true;
  }
  if (harness === "cline") {
    const ok = (o) => {
      if (Array.isArray(o)) return o.length > 0 && o.every((e) => !!e && typeof e === "object" && !Array.isArray(e) && e.success === true);
      if (o && typeof o === "object") {
        const r = o;
        if (r.success === false || r.isError === true) return false;
        if (r.error !== void 0 && r.error !== null && r.error !== "") return false;
        return true;
      }
      return toolName !== "run_commands";
    };
    const tr = payload.tool_result;
    if (tr && typeof tr === "object" && !Array.isArray(tr)) {
      if (tr.error !== void 0 && tr.error !== null && tr.error !== "") return false;
      return ok(tr.output);
    }
    const pt = payload.postToolUse;
    if (!pt || typeof pt !== "object" || pt.success !== true) return false;
    let res = pt.result;
    if (typeof res === "string") {
      try {
        res = JSON.parse(res);
      } catch {
        return toolName !== "run_commands";
      }
    }
    return ok(res);
  }
  if (harness === "gemini") {
    if (!out || typeof out !== "object" || Array.isArray(out)) return false;
    const r = out;
    if (r.error !== void 0 && r.error !== null && r.error !== false) return false;
    if (toolName === "run_shell_command") {
      const text = typeof r.llmContent === "string" ? r.llmContent : "";
      if (!/^Output:/.test(text)) return false;
      if (/^(Exit Code|Signal|Error):/m.test(text)) return false;
    }
    return true;
  }
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      return true;
    }
  }
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const o = out;
    if (o.interrupted === true || o.is_error === true || o.isError === true) return false;
    if (typeof o.exitCode === "number" && o.exitCode !== 0) return false;
  }
  return true;
}

function harnessEventName(harness, event) {
  const names = {
    "claude-code": { pre: "PreToolUse", post: "PostToolUse", "post-failure": "PostToolUseFailure", batch: "PostToolBatch" },
    cursor: { pre: "preToolUse", post: "postToolUse", "post-failure": "postToolUseFailure" },
    codex: { pre: "PreToolUse", post: "PostToolUse", "turn-end": "Stop" },
    gemini: { pre: "BeforeTool", post: "AfterTool", "turn-end": "AfterAgent" },
    copilot: { pre: "preToolUse", post: "postToolUse", "post-failure": "postToolUseFailure", "turn-end": "agentStop" },
    goose: { pre: "PreToolUse", post: "PostToolUse", "post-failure": "PostToolUseFailure", "turn-end": "Stop" },
    hermes: { pre: "pre_tool_call", post: "post_tool_call", "turn-end": "on_session_end" },
    pi: { pre: "tool_call", post: "tool_result", "turn-end": "agent_end" },
    opencode: { pre: "tool.execute.before", post: "tool.execute.after", "post-failure": "message.part.updated", "turn-end": "session.idle" },
    openclaw: { pre: "before_tool_call", post: "after_tool_call", "turn-end": "session_end" },
    cline: { pre: "PreToolUse", post: "PostToolUse", "turn-end": "TaskComplete" },
    kiro: { pre: "PreToolUse", post: "PostToolUse", "turn-end": "Stop" },
    // pre_tool / post_tool stand for every pre_* / post_* tool event
    // (normalizePayload); turn-end runs on the next pre_user_prompt.
    windsurf: { pre: "pre_tool", post: "post_tool", "turn-end": "pre_user_prompt" }
  };
  const h = names[harness];
  return h && h[event] ? h[event] : null;
}

function normalizeToolInput(harness, toolName, input) {
  const patch = harness === "codex" ? input.command : harness === "copilot" ? input.input ?? input.patch : harness === "openclaw" ? input.input : harness === "opencode" ? input.patchText : void 0;
  if (harness === "cline" && toolName === "run_commands") {
    const out = { ...input };
    delete out.command;
    const list = Array.isArray(input.commands) ? input.commands : typeof input.commands === "string" ? [input.commands] : typeof input.command === "string" ? [input.command] : typeof input.cmd === "string" ? [input.cmd] : [];
    if (list.length === 1 && typeof list[0] === "string") out.command = list[0];
    return out;
  }
  const clinePatch = harness === "cline" ? input.input : void 0;
  if (toolName === "apply_patch" && typeof (patch ?? clinePatch) === "string") {
    const text = patch ?? clinePatch;
    const files = [];
    const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
    let m;
    while ((m = re.exec(text)) !== null) files.push(m[1].trim());
    const out = { ...input, files };
    if (files.length > 0) out.path = files[0];
    return out;
  }
  return input;
}

function harnessCallId(harness, payload) {
  const given = payload.tool_use_id;
  if (harness === "copilot" && typeof given === "string" && given !== "") return given;
  if (harness === "cline" && typeof given === "string" && given !== "") return given;
  if (harness === "gemini" || harness === "copilot" || harness === "cline" || harness === "kiro" || harness === "windsurf") {
    if (typeof payload.tool_name !== "string" || payload.tool_name === "") return null;
    const text = String(payload.session_id ?? "") + "\0" + payload.tool_name;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return harness + "-" + h.toString(16).padStart(8, "0");
  }
  return typeof given === "string" && given !== "" ? given : null;
}

function harnessConfigFile(harness) {
  const files = {
    "claude-code": ".claude/settings.json",
    cursor: ".cursor/hooks.json",
    codex: ".codex/hooks.json",
    gemini: ".gemini/settings.json",
    copilot: ".github/hooks/speckl.json",
    goose: ".agents/plugins/speckl/hooks/hooks.json",
    // Relative to the Hermes profile directory (--hermes-home), not the project.
    hermes: "config.yaml",
    // Generated plugins (pluginSource), not hook configs.
    pi: ".pi/extensions/speckl.js",
    opencode: ".opencode/plugins/speckl.js",
    openclaw: ".openclaw/plugins/speckl/index.js",
    // Executable hook scripts named after the event (clineScripts).
    cline: ".clinerules/hooks/PreToolUse",
    kiro: ".kiro/hooks/speckl.json",
    // install also writes the legacy .windsurf/hooks.json for older releases.
    windsurf: ".devin/hooks.json"
  };
  return files[harness] || "";
}

function harnessProtectedDirs(harnesses) {
  const dirs = [".claude", ".cursor", ".codex", ".gemini"];
  const extra = {
    copilot: [".github/hooks"],
    goose: [".agents/plugins", ".config/goose"],
    hermes: [".hermes"],
    pi: [".pi"],
    opencode: [".opencode", "opencode.json", "opencode.jsonc"],
    openclaw: [".openclaw"],
    cline: [".clinerules/hooks", ".cline"],
    kiro: [".kiro/hooks", ".kiro/agents", ".kiro/settings"],
    windsurf: [".devin", ".windsurf"]
  };
  for (const h of harnesses) for (const d of extra[h] || []) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

function normalizePayload(harness, payload) {
  const p = { ...payload };
  if (harness === "copilot") {
    if (p.tool_name === void 0 && p.toolName !== void 0) p.tool_name = p.toolName;
    if (p.tool_input === void 0 && p.toolArgs !== void 0) p.tool_input = p.toolArgs;
    if (p.session_id === void 0 && p.sessionId !== void 0) p.session_id = p.sessionId;
    const pascal = {
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      PostToolUseFailure: "postToolUseFailure",
      Stop: "agentStop"
    };
    if (typeof p.hook_event_name === "string" && pascal[p.hook_event_name]) p.hook_event_name = pascal[p.hook_event_name];
  }
  if (harness === "goose") {
    if (p.hook_event_name === void 0) p.hook_event_name = p.event === void 0 ? null : p.event;
    if (p.tool_use_id === void 0) p.tool_use_id = p.tool_call_id;
    if (p.cwd === void 0 && typeof p.working_dir === "string") p.cwd = p.working_dir;
  }
  if (harness === "hermes") {
    const extra = p.extra && typeof p.extra === "object" && !Array.isArray(p.extra) ? p.extra : {};
    if (p.tool_use_id === void 0) p.tool_use_id = extra.tool_call_id;
  }
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
  if (harness === "pi") {
    if (p.hook_event_name === void 0) p.hook_event_name = p.type === void 0 ? null : p.type;
    if (p.tool_name === void 0) p.tool_name = p.toolName;
    if (p.tool_input === void 0) p.tool_input = p.input;
    if (p.tool_use_id === void 0) p.tool_use_id = p.toolCallId;
  }
  if (harness === "opencode") {
    if (p.hook_event_name === void 0) p.hook_event_name = p.hook !== void 0 ? p.hook : p.type === void 0 ? null : p.type;
    if (p.hook_event_name === "message.part.updated") {
      const part = obj(obj(p.properties).part);
      if (p.tool_name === void 0) p.tool_name = part.tool;
      if (p.tool_input === void 0) p.tool_input = obj(part.state).input;
      if (p.tool_use_id === void 0) p.tool_use_id = part.callID;
      if (p.session_id === void 0) p.session_id = part.sessionID;
    } else {
      const inp = obj(p.input);
      if (p.tool_name === void 0) p.tool_name = inp.tool;
      if (p.tool_input === void 0) p.tool_input = p.hook_event_name === "tool.execute.before" ? obj(p.output).args : inp.args;
      if (p.tool_use_id === void 0) p.tool_use_id = inp.callID;
      if (p.session_id === void 0) p.session_id = inp.sessionID;
    }
    if (p.cwd === void 0 && typeof p.directory === "string") p.cwd = p.directory;
  }
  if (harness === "openclaw") {
    const ev = obj(p.event);
    const ctx = obj(p.ctx);
    if (p.hook_event_name === void 0) p.hook_event_name = p.hook === void 0 ? null : p.hook;
    if (p.tool_name === void 0) p.tool_name = ev.toolName;
    if (p.tool_input === void 0) p.tool_input = ev.params;
    if (p.tool_use_id === void 0) p.tool_use_id = ev.toolCallId !== void 0 ? ev.toolCallId : ctx.toolCallId;
    if (p.session_id === void 0) p.session_id = ctx.sessionId;
  }
  if (harness === "kiro") {
    const legacy = { preToolUse: "PreToolUse", postToolUse: "PostToolUse", stop: "Stop" };
    if (typeof p.hook_event_name === "string" && legacy[p.hook_event_name]) p.hook_event_name = legacy[p.hook_event_name];
  }
  if (harness === "windsurf") {
    const name = typeof p.agent_action_name === "string" ? p.agent_action_name : "";
    const kind = /^(pre|post)_(read_code|write_code|run_command|mcp_tool_use)$/.exec(name);
    if (p.hook_event_name === void 0) p.hook_event_name = kind ? kind[1] + "_tool" : name || null;
    const info = obj(p.tool_info);
    if (kind && p.tool_name === void 0) {
      if (kind[2] === "mcp_tool_use") {
        const server = typeof info.mcp_server_name === "string" ? info.mcp_server_name : "";
        const tool = typeof info.mcp_tool_name === "string" ? info.mcp_tool_name : "";
        p.tool_name = server && tool ? "mcp__" + server + "__" + tool : null;
      } else p.tool_name = kind[2];
    }
    if (kind && p.tool_input === void 0) {
      if (kind[2] === "mcp_tool_use") p.tool_input = info.mcp_tool_arguments === void 0 ? {} : info.mcp_tool_arguments;
      else if (kind[2] === "run_command") {
        const t = { ...info };
        delete t.command;
        if (typeof info.command_line === "string") t.command = info.command_line;
        p.tool_input = t;
      } else p.tool_input = p.tool_info;
    }
    if (p.session_id === void 0) p.session_id = p.trajectory_id;
  }
  if (harness === "cline") {
    const names = {
      tool_call: "PreToolUse",
      tool_result: "PostToolUse",
      agent_end: "TaskComplete",
      agent_abort: "TaskComplete",
      agent_error: "TaskComplete",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      TaskComplete: "TaskComplete",
      TaskCancel: "TaskComplete",
      TaskError: "TaskComplete"
    };
    if (p.hook_event_name === void 0) p.hook_event_name = typeof p.hookName === "string" ? names[p.hookName] || p.hookName : null;
    const call = obj(p.tool_call !== void 0 ? p.tool_call : p.tool_result);
    const legacy = obj(p.preToolUse !== void 0 ? p.preToolUse : p.postToolUse);
    if (p.tool_name === void 0) p.tool_name = call.name !== void 0 ? call.name : legacy.toolName;
    if (p.tool_input === void 0) {
      if (call.input !== void 0) p.tool_input = call.input;
      else if (legacy.parameters && typeof legacy.parameters === "object" && !Array.isArray(legacy.parameters)) {
        const params = {};
        for (const [k, v] of Object.entries(legacy.parameters)) {
          let x = v;
          if (typeof v === "string" && /^\s*[[{]/.test(v)) {
            try {
              x = JSON.parse(v);
            } catch {
              x = v;
            }
          }
          params[k] = x;
        }
        p.tool_input = params;
      }
    }
    if (p.tool_use_id === void 0 && typeof call.id === "string") p.tool_use_id = call.id;
    if (p.session_id === void 0) p.session_id = p.taskId;
    const roots = Array.isArray(p.workspaceRoots) ? p.workspaceRoots : [];
    if (p.cwd === void 0 && typeof roots[0] === "string") p.cwd = roots[0];
  }
  return p;
}

function parseAdapterFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) out[a.slice(2)] = args[i + 1] ?? "";
    if (a.startsWith("--")) i++;
  }
  return out;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./${}:@%+=-]+$/.test(s) ? s : '"' + s.replace(/(["\\`])/g, "\\$1") + '"';
}

function buildHarnessHooks(harness, paths) {
  const envDir = harness === "claude-code" ? "${CLAUDE_PROJECT_DIR}/" : harness === "gemini" ? "${GEMINI_PROJECT_DIR}/" : "";
  const pfx = (p) => paths.relative ? envDir + p : p;
  const cmd = (event) => {
    const parts = ["node", shellQuote(pfx(paths.adapter)), harness, event, "--state", shellQuote(pfx(paths.state))];
    if (paths.key) parts.push("--key", shellQuote(paths.key));
    if (paths.project) parts.push("--project", shellQuote(paths.project));
    if (paths.hermesHome) parts.push("--hermes-home", shellQuote(paths.hermesHome));
    if (paths.outsideAllow) parts.push("--outside", "allow");
    return parts.join(" ");
  };
  if (harness === "pi" || harness === "opencode" || harness === "openclaw") {
    const argv = [paths.adapter, "--state", paths.state];
    if (paths.key) argv.push("--key", paths.key);
    if (paths.project) argv.push("--project", paths.project);
    if (paths.outsideAllow) argv.push("--outside", "allow");
    return { plugin: harness, argv, relative: paths.relative };
  }
  if (harness === "windsurf") {
    const allowCmd = (event) => '[ "$(' + cmd(event) + `)" = '{"decision":"allow"}' ] || exit 2`;
    const winBlock = "[Console]::Error.WriteLine('Speckl: the generated Cascade hooks support macOS and Linux only; blocking.'); exit 2";
    const pre = [{ command: allowCmd("pre"), powershell: winBlock, show_output: false }];
    const post = [{ command: cmd("post"), show_output: false }];
    return {
      hooks: {
        pre_read_code: pre,
        pre_write_code: pre,
        pre_run_command: pre,
        pre_mcp_tool_use: pre,
        post_read_code: post,
        post_write_code: post,
        post_run_command: post,
        post_mcp_tool_use: post,
        pre_user_prompt: [{ command: cmd("turn-end") + " || true", show_output: false }]
      }
    };
  }
  if (harness === "kiro") {
    const h = (name, trigger, event, block) => ({
      name,
      description: "Speckl rails (generated by adapter.mjs install kiro; rerun install to change)",
      trigger,
      action: { type: "command", command: block ? '[ "$(' + cmd(event) + `)" = '{"decision":"allow"}' ] || exit 2` : cmd(event) },
      timeout: 30,
      enabled: true
    });
    return { version: "v1", hooks: [h("speckl-pre", "PreToolUse", "pre", true), h("speckl-post", "PostToolUse", "post", false), h("speckl-stop", "Stop", "turn-end", false)] };
  }
  if (harness === "cline") {
    return { commands: { pre: cmd("pre"), post: cmd("post"), "turn-end": cmd("turn-end") } };
  }
  if (harness === "copilot") {
    const h = (event, block) => [{ type: "command", bash: cmd(event) + (block ? " || exit 2" : ""), timeoutSec: 30 }];
    return {
      version: 1,
      hooks: { preToolUse: h("pre", true), postToolUse: h("post", false), postToolUseFailure: h("post-failure", false), agentStop: h("turn-end", false) }
    };
  }
  if (harness === "goose") {
    const hook = (event, block) => {
      const h = { type: "command", command: cmd(event) + (block ? " || exit 2" : ""), timeout: 30 };
      if (block) h.on_failure = "block";
      return h;
    };
    return {
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [hook("pre", true)] }],
        PostToolUse: [{ matcher: ".*", hooks: [hook("post", false)] }],
        PostToolUseFailure: [{ matcher: ".*", hooks: [hook("post-failure", false)] }],
        Stop: [{ hooks: [hook("turn-end", false)] }]
      }
    };
  }
  if (harness === "hermes") {
    return {
      hooks: {
        pre_tool_call: [{ command: cmd("pre"), timeout: 30, fail_closed: true }],
        post_tool_call: [{ command: cmd("post"), timeout: 30 }],
        on_session_end: [{ command: cmd("turn-end"), timeout: 30 }]
      }
    };
  }
  if (harness === "cursor") {
    const h = (event) => [{ command: cmd(event), timeout: 30, failClosed: true }];
    return {
      version: 1,
      hooks: { preToolUse: h("pre"), postToolUse: h("post"), postToolUseFailure: h("post-failure") }
    };
  }
  if (harness === "codex" || harness === "gemini") {
    const ms = harness === "gemini";
    const hook = (event, block) => {
      const h = { type: "command", command: cmd(event) + (block ? " || exit 2" : ""), timeout: ms ? 3e4 : 30 };
      if (ms) h.name = "speckl-" + event;
      return h;
    };
    const ev = harnessEventName;
    const any = ms ? ".*" : "*";
    return {
      hooks: {
        [ev(harness, "pre")]: [{ matcher: any, hooks: [hook("pre", true)] }],
        [ev(harness, "post")]: [{ matcher: any, hooks: [hook("post", false)] }],
        [ev(harness, "turn-end")]: [{ hooks: [hook("turn-end", false)] }]
      }
    };
  }
  const group = (event, extra, matcher) => {
    const g = {};
    if (matcher) g.matcher = "*";
    g.hooks = [{ type: "command", command: cmd(event), timeout: 30, ...extra }];
    return [g];
  };
  return {
    hooks: {
      PreToolUse: group("pre", { onFailure: "block" }, true),
      PostToolUse: group("post", {}, true),
      PostToolUseFailure: group("post-failure", {}, true),
      PostToolBatch: group("batch", {}, false)
    }
  };
}

function mergeHarnessSettings(harness, existing, ours) {
  const isOurs = (entry) => {
    const e = entry;
    const cmds = [];
    if (e && typeof e.command === "string") cmds.push(e.command);
    if (e && typeof e.bash === "string") cmds.push(e.bash);
    if (e && Array.isArray(e.hooks)) {
      for (const h of e.hooks) if (h && typeof h.command === "string") cmds.push(h.command);
    }
    return cmds.some((c) => c.includes("adapter.mjs") && c.includes(" " + harness + " "));
  };
  if (harness === "kiro") {
    const cmdOf = (e) => e && typeof e === "object" && e.action && typeof e.action === "object" ? e.action.command : void 0;
    const mine = (e) => {
      const c = cmdOf(e);
      return typeof c === "string" && c.includes("adapter.mjs") && c.includes(" kiro ");
    };
    const prev = Array.isArray(existing.hooks) ? existing.hooks.filter((e) => !mine(e)) : [];
    return { ...existing, version: "v1", hooks: [...prev, ...ours.hooks || []] };
  }
  const merged = { ...existing };
  if (harness === "cursor" || harness === "copilot") merged.version = existing.version || 1;
  const hooks = { ...existing.hooks || {} };
  const add = ours.hooks || {};
  for (const ev of Object.keys(add)) {
    const prev = Array.isArray(hooks[ev]) ? hooks[ev].filter((e) => !isOurs(e)) : [];
    hooks[ev] = [...prev, ...add[ev]];
  }
  merged.hooks = hooks;
  return merged;
}

function clineScripts(ours) {
  const cmds = ours.commands || {};
  const head = [
    "#!/bin/sh",
    "# Generated by speckl adapter.mjs install cline; do not edit (rerun install).",
    'T=""; command -v timeout >/dev/null 2>&1 && T="timeout 25"'
  ];
  const pre = [
    ...head,
    "# Anything other than an explicit allow from the adapter cancels the call.",
    "out=$($T " + cmds.pre + ")",
    "st=$?",
    'last=$(printf "%s\\n" "$out" | tail -n 1)',
    `if [ "$st" -eq 0 ] && [ "$last" = '{"cancel":false}' ]; then printf '%s\\n' '{"cancel":false}'; exit 0; fi`,
    `case "$last" in '{"cancel":true,'*) printf '%s\\n' "$last"; exit 0 ;; esac`,
    `printf '%s\\n' '{"cancel":true,"errorMessage":"Speckl: the adapter failed (exit '"$st"'), so the tool call is blocked. Check node and the .speckl files."}'`,
    "exit 0"
  ];
  const post = [
    ...head,
    "out=$($T " + cmds.post + ")",
    'last=$(printf "%s\\n" "$out" | tail -n 1)',
    `case "$last" in '{"cancel":false}'|'{"cancel":false,"contextModification":"'*'"}') printf '%s\\n' "$last"; exit 0 ;; esac`,
    `printf '%s\\n' '{"cancel":false,"contextModification":"Speckl: the adapter failed to record this tool result; the policy did not advance."}'`,
    "exit 0"
  ];
  const end = [...head, "$T " + cmds["turn-end"] + " >/dev/null", "exit 0"];
  const j = (l) => l.join("\n") + "\n";
  return { PreToolUse: j(pre), PostToolUse: j(post), TaskComplete: j(end), TaskCancel: j(end), TaskError: j(end) };
}

function pluginSource(harness, ours) {
  const argv = ours.argv || [];
  const relative = ours.relative === true;
  const up = { pi: "../../", opencode: "../../", openclaw: "../../../" };
  const pathAt = (i) => i === 0 || i > 0 && (argv[i - 1] === "--state" || argv[i - 1] === "--key");
  const lit = argv.map((a, i) => relative && pathAt(i) && !/^\//.test(a) ? "resolve(ROOT, " + JSON.stringify(a) + ")" : JSON.stringify(a));
  const L = [
    "// Generated by speckl adapter.mjs install " + harness + "; do not edit (rerun install).",
    "// Every tool call goes through the Speckl adapter before it runs. Anything",
    "// other than an explicit allow (a crash, a timeout, bad output, a missing",
    "// node) blocks the call.",
    "import { spawnSync } from 'node:child_process';"
  ];
  if (relative) {
    L.push("import { fileURLToPath } from 'node:url';", "import { resolve } from 'node:path';");
    L.push("const ROOT = fileURLToPath(new URL(" + JSON.stringify(up[harness] || "../../") + ", import.meta.url));");
  }
  L.push(
    "const ARGV = [" + lit.join(", ") + "];",
    "function speckl(event, payload) {",
    "  let input;",
    '  try { input = JSON.stringify(payload); } catch (e) { return { ok: false, reason: "Speckl: the hook payload could not be serialised (" + e + ")" }; }',
    '  if (typeof input !== "string") return { ok: false, reason: "Speckl: the hook payload could not be serialised" };',
    "  let r;",
    "  try {",
    '    r = spawnSync("node", [ARGV[0], ' + JSON.stringify(harness) + ', event, ...ARGV.slice(1)], { input, encoding: "utf-8", timeout: 25000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });',
    '  } catch (e) { return { ok: false, reason: "Speckl: could not run the adapter (" + e + ")" }; }',
    '  const lines = String(r.stdout || "").trim().split("\\n").filter(Boolean);',
    "  let body = null;",
    "  try { body = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { body = null; }",
    '  const err = String(r.stderr || "").trim();',
    "  if (r.error || r.status !== 0) {",
    '    const why = (body && typeof body.reason === "string" && body.reason) || err.split("\\n")[0]',
    '      || (r.error ? String(r.error.message || r.error) : r.signal ? "killed by " + r.signal : "exit " + r.status);',
    '    return { ok: false, reason: (/^Speckl/.test(why) ? "" : "Speckl adapter failed: ") + why };',
    "  }",
    "  return { ok: true, body };",
    "}",
    'function allowed(r) { return r.ok && !!r.body && typeof r.body === "object" && r.body.decision === "allow"; }',
    'function denial(r) { return r.ok ? "Speckl: the adapter gave no allow decision" : r.reason; }',
    'function note(r) { return !r.ok ? r.reason : r.body && typeof r.body.additionalContext === "string" ? r.body.additionalContext : ""; }'
  );
  if (harness === "pi") {
    L.push(
      "// Pi extension (.pi/extensions): tool_call can block; a handler that throws",
      "// also blocks (pi fail-safe). tool_result fires for every executed call.",
      "export default function specklRails(pi) {",
      '  pi.on("tool_call", async (event, ctx) => {',
      '    const r = speckl("pre", { ...event, cwd: ctx.cwd });',
      "    if (allowed(r)) return undefined;",
      "    return { block: true, reason: denial(r) };",
      "  });",
      '  pi.on("tool_result", async (event, ctx) => {',
      '    const text = note(speckl("post", { ...event, cwd: ctx.cwd }));',
      "    if (!text) return undefined;",
      '    const out = { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text }] };',
      "    if (event.structuredContent !== undefined) out.structuredContent = event.structuredContent;",
      "    return out;",
      "  });",
      '  pi.on("agent_end", async (event, ctx) => { speckl("turn-end", { type: "agent_end", cwd: ctx.cwd }); return undefined; });',
      "}"
    );
  } else if (harness === "opencode") {
    L.push(
      "// OpenCode plugin (.opencode/plugins): throwing in tool.execute.before stops",
      "// the call. A tool that throws never reaches tool.execute.after; its",
      "// message.part.updated error event is reported as post-failure.",
      "export const SpecklRails = async ({ directory }) => ({",
      '  "tool.execute.before": async (input, output) => {',
      '    const r = speckl("pre", { hook: "tool.execute.before", input, output: { args: output.args }, directory });',
      "    if (!allowed(r)) throw new Error(denial(r));",
      "  },",
      '  "tool.execute.after": async (input, output) => {',
      '    const text = note(speckl("post", { hook: "tool.execute.after", input, output: { title: output.title, output: output.output, metadata: output.metadata }, directory }));',
      '    if (text) output.output = (typeof output.output === "string" ? output.output + "\\n\\n" : "") + text;',
      "  },",
      "  event: async ({ event }) => {",
      '    if (!event || typeof event !== "object") return;',
      '    if (event.type === "message.part.updated") {',
      "      const part = event.properties && event.properties.part;",
      '      if (part && part.type === "tool" && part.state && part.state.status === "error") speckl("post-failure", { ...event, directory });',
      '    } else if (event.type === "session.idle") {',
      '      speckl("turn-end", { ...event, directory });',
      "    }",
      "  },",
      "});"
    );
  } else {
    L.push(
      "// OpenClaw native plugin: before_tool_call returns {block, blockReason}; a",
      "// handler that throws or times out blocks the call (host policy).",
      "const pick = (ctx) => ({ agentId: ctx && ctx.agentId, sessionKey: ctx && ctx.sessionKey, sessionId: ctx && ctx.sessionId, runId: ctx && ctx.runId, toolName: ctx && ctx.toolName, toolCallId: ctx && ctx.toolCallId });",
      "export default {",
      '  id: "speckl",',
      '  name: "Speckl rails",',
      '  description: "Checks every tool call against the compiled Speckl policy (fail closed).",',
      "  register(api) {",
      '    api.on("before_tool_call", (event, ctx) => {',
      '      const r = speckl("pre", { hook: "before_tool_call", event, ctx: pick(ctx) });',
      "      if (allowed(r)) return undefined;",
      "      return { block: true, blockReason: denial(r) };",
      "    }, { timeoutMs: 30000 });",
      '    api.on("after_tool_call", (event, ctx) => {',
      '      const text = note(speckl("post", { hook: "after_tool_call", event, ctx: pick(ctx) }));',
      '      if (text && api.logger && typeof api.logger.warn === "function") api.logger.warn(text);',
      "    }, { timeoutMs: 30000 });",
      '    api.on("session_end", (event, ctx) => { speckl("turn-end", { hook: "session_end", ctx: pick(ctx) }); });',
      "  },",
      "};"
    );
  }
  return L.join("\n") + "\n";
}

function pluginFiles(harness, ours) {
  const main = harness === "openclaw" ? "index.js" : "speckl.js";
  const files = { [main]: pluginSource(harness, ours) };
  if (harness === "openclaw") {
    const configSchema = { type: "object", additionalProperties: false, properties: {} };
    files["openclaw.plugin.json"] = JSON.stringify({ id: "speckl", name: "Speckl rails", description: "Checks every tool call against the compiled Speckl policy (fail closed).", configSchema }, null, 2) + "\n";
    files["package.json"] = JSON.stringify({ name: "speckl-openclaw-rails", version: "1.0.0", private: true, type: "module", openclaw: { extensions: ["./index.js"] } }, null, 2) + "\n";
  }
  return files;
}

function hermesYaml(ours) {
  const lines = ["# >>> speckl hermes hooks (generated by adapter.mjs install hermes; do not edit)", "hooks:"];
  const hooks = ours.hooks || {};
  for (const ev of Object.keys(hooks)) {
    lines.push("  " + ev + ":");
    for (const entry of hooks[ev]) {
      let first = true;
      for (const [k, v] of Object.entries(entry)) {
        lines.push((first ? "    - " : "      ") + k + ": " + JSON.stringify(v));
        first = false;
      }
    }
  }
  lines.push("# <<< speckl hermes hooks");
  return lines.join("\n") + "\n";
}

function installHermes(project, ours, hermesHome, deps) {
  const target = deps.resolvePath(hermesHome, "config.yaml");
  const block = hermesYaml(ours);
  const text = deps.readFile(target);
  const begin = "# >>> speckl hermes hooks";
  const end = "# <<< speckl hermes hooks";
  let next;
  if (text === null || text.trim() === "") {
    next = block;
  } else if (text.includes(begin) && text.includes(end)) {
    const a = text.indexOf(begin);
    const b = text.indexOf("\n", text.indexOf(end));
    next = text.slice(0, a) + block + (b === -1 ? "" : text.slice(b + 1));
  } else if (/^hooks\s*:/m.test(text)) {
    return {
      code: 1,
      stdout: block,
      stderr: target + " already has a hooks: block; not touching it. Merge the entries printed on stdout into it, then approve them (hermes hooks list).\n"
    };
  } else {
    next = text + (text.endsWith("\n") ? "" : "\n") + block;
  }
  const allowPath = deps.resolvePath(hermesHome, "shell-hooks-allowlist.json");
  const allowText = deps.readFile(allowPath);
  let allow = { approvals: [] };
  if (allowText !== null && allowText.trim() !== "") {
    try {
      allow = JSON.parse(allowText);
    } catch {
      return { code: 1, stdout: "", stderr: allowPath + " is not valid JSON; not touching it\n" };
    }
    if (!allow || typeof allow !== "object" || Array.isArray(allow) || !Array.isArray(allow.approvals)) {
      return { code: 1, stdout: "", stderr: allowPath + " has no approvals list; not touching it\n" };
    }
  }
  const isOurs = (e) => {
    const c = e && typeof e === "object" ? e.command : void 0;
    return typeof c === "string" && c.includes("adapter.mjs") && c.includes(" hermes ");
  };
  const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const approvals = allow.approvals.filter((e) => !isOurs(e));
  const hooks = ours.hooks || {};
  for (const ev of Object.keys(hooks)) {
    for (const h of hooks[ev]) approvals.push({ event: ev, command: h.command, approved_at: now, script_mtime_at_approval: null });
  }
  deps.writeFile(target, next);
  deps.writeFile(allowPath, JSON.stringify({ ...allow, approvals }, null, 2) + "\n");
  return {
    code: 0,
    stdout: "Speckl hermes hooks written to " + target + " for project " + project + "\nRecorded consent for these " + approvals.filter(isOurs).length + " hook commands in " + allowPath + " (revoke with: hermes hooks revoke <command>)\n",
    stderr: ""
  };
}

function installHarness(harness, flags, deps) {
  if (!flags.project || !flags.state || harness === "hermes" && !flags["hermes-home"]) {
    const extra = harness === "hermes" ? " --hermes-home <profile dir, e.g. ~/.hermes>" : "";
    return { code: 1, stdout: "", stderr: "usage: adapter.mjs install " + harness + " --project <dir> --state <file> [--key <file>]" + extra + "\n" };
  }
  const project = deps.resolvePath(deps.cwd, flags.project);
  const stateAbs = deps.resolvePath(deps.cwd, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(deps.cwd, flags.key) : null;
  const rel = (p) => deps.relativePath(project, p).replace(/\\/g, "/");
  const inside = (p) => !rel(p).startsWith("..") && !/^[A-Za-z]:|^\//.test(rel(p));
  const pinned = harness !== "claude-code" && harness !== "cursor";
  const relative = !pinned && inside(deps.agentDir) && inside(stateAbs);
  const hermesHome = harness === "hermes" ? deps.resolvePath(deps.cwd, flags["hermes-home"]) : void 0;
  const userScope = harness === "goose" || harness === "pi" || harness === "opencode";
  const pluginsDir = userScope && flags["plugins-dir"] ? deps.resolvePath(deps.cwd, flags["plugins-dir"]) : "";
  let pluginName = "speckl";
  if (pluginsDir) {
    let h = 2166136261;
    for (let i = 0; i < project.length; i++) {
      h ^= project.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    pluginName = "speckl-" + h.toString(16).padStart(8, "0");
  }
  const ours = buildHarnessHooks(harness, {
    adapter: relative ? rel(deps.resolvePath(deps.agentDir, "adapter.mjs")) : deps.resolvePath(deps.agentDir, "adapter.mjs"),
    state: relative ? rel(stateAbs) : stateAbs,
    key: keyAbs,
    relative,
    project: pinned ? project : void 0,
    hermesHome,
    outsideAllow: pluginsDir !== ""
  });
  let warn = "";
  if (keyAbs && inside(keyAbs)) warn = "WARN: the state key is inside the project; keep it where the agent cannot read it\n";
  if (!keyAbs) warn = "WARN: no --key; hooks will use SPECKL_STATE_KEY_FILE from the harness environment\n";
  if (hermesHome) {
    const r = installHermes(project, ours, hermesHome, deps);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr + (r.code === 0 ? warn : "") };
  }
  if (harness === "pi" || harness === "opencode" || harness === "openclaw") {
    const mainPath = pluginsDir ? deps.resolvePath(pluginsDir, pluginName + ".js") : deps.resolvePath(project, harnessConfigFile(harness));
    const dir = deps.dirname(mainPath);
    const files = pluginFiles(harness, ours);
    const mine = (t) => t === null || t.trim() === "" || t.includes("Generated by speckl adapter.mjs install " + harness);
    const mainText = deps.readFile(mainPath);
    if (!mine(mainText)) return { code: 1, stdout: "", stderr: mainPath + " exists and was not written by Speckl; not touching it\n" };
    if (mainText === null) {
      for (const name of Object.keys(files).slice(1)) {
        const t = deps.readFile(deps.resolvePath(dir, name));
        if (t !== null && t.trim() !== "") return { code: 1, stdout: "", stderr: deps.resolvePath(dir, name) + " exists and was not written by Speckl; not touching it\n" };
      }
    }
    const main = Object.keys(files)[0];
    for (const [name, text2] of Object.entries(files)) deps.writeFile(name === main ? mainPath : deps.resolvePath(dir, name), text2);
    const next = {
      pi: pluginsDir ? "Pi loads this user-level extension in every session; it judges calls made inside " + project + ".\n" : "Pi loads project extensions only for a trusted project: run /trust once, or pass --approve (or -e " + mainPath + ") in print/JSON/RPC mode. Untrusted, the extension is skipped and nothing is checked; --plugins-dir ~/.pi/agent/extensions avoids that.\n",
      opencode: "OpenCode loads " + (pluginsDir ? pluginsDir : ".opencode/plugins/") + " at startup; restart running sessions.\n",
      openclaw: 'Enable it in your OpenClaw config: plugins.load.paths += ["' + dir + '"], plugins.entries.speckl.enabled = true, and set the agent workspace (or `openclaw agent exec --cwd`) to ' + project + ".\n"
    };
    return { code: 0, stdout: "Speckl " + harness + " plugin written to " + mainPath + "\n" + next[harness], stderr: warn };
  }
  if (harness === "cline") {
    const dir = deps.dirname(deps.resolvePath(project, harnessConfigFile(harness)));
    const scripts = clineScripts(ours);
    for (const name of Object.keys(scripts)) {
      for (const n of [name, name + ".sh", name + ".js", name + ".mjs", name + ".py", name + ".ps1"]) {
        const t = deps.readFile(deps.resolvePath(dir, n));
        if (t !== null && t.trim() !== "" && !(n === name && t.includes("Generated by speckl adapter.mjs install cline"))) {
          return { code: 1, stdout: "", stderr: deps.resolvePath(dir, n) + " exists and was not written by Speckl; not touching it (Cline runs one " + name + " hook per directory)\n" };
        }
      }
    }
    for (const [name, text2] of Object.entries(scripts)) deps.writeFile(deps.resolvePath(dir, name), text2, 493);
    return {
      code: 0,
      stdout: "Speckl cline hooks written to " + dir + "/ (" + Object.keys(scripts).join(", ") + ")\nCline runs them while hooks are enabled (the default). A Speckl deny cancels the whole task, not only the call.\n",
      stderr: warn
    };
  }
  const pluginDir = pluginsDir ? deps.resolvePath(pluginsDir, pluginName) : deps.resolvePath(project, ".agents/plugins/speckl");
  const target = harness === "goose" ? deps.resolvePath(pluginDir, "hooks/hooks.json") : deps.resolvePath(project, harnessConfigFile(harness));
  const text = deps.readFile(target);
  let existing = {};
  if (text !== null && text.trim() !== "") {
    try {
      existing = JSON.parse(text);
    } catch {
      return { code: 1, stdout: "", stderr: target + " is not valid JSON; not touching it\n" };
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      return { code: 1, stdout: "", stderr: target + " is not a JSON object; not touching it\n" };
    }
  }
  const extraTargets = [];
  if (harness === "windsurf") {
    const legacy = deps.resolvePath(project, ".windsurf/hooks.json");
    const lt = deps.readFile(legacy);
    let le = {};
    if (lt !== null && lt.trim() !== "") {
      try {
        le = JSON.parse(lt);
      } catch {
        return { code: 1, stdout: "", stderr: legacy + " is not valid JSON; not touching it\n" };
      }
      if (!le || typeof le !== "object" || Array.isArray(le)) return { code: 1, stdout: "", stderr: legacy + " is not a JSON object; not touching it\n" };
    }
    extraTargets.push({ path: legacy, settings: mergeHarnessSettings(harness, le, ours) });
  }
  const merged = mergeHarnessSettings(harness, existing, ours);
  deps.writeFile(target, JSON.stringify(merged, null, 2) + "\n");
  for (const x of extraTargets) deps.writeFile(x.path, JSON.stringify(x.settings, null, 2) + "\n");
  if (harness === "goose") {
    const manifest = { name: pluginName, version: "1.0.0", description: "Speckl rails for " + project + ": every tool call is checked against the compiled policy (fail closed)." };
    deps.writeFile(deps.resolvePath(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  const also = extraTargets.length ? " and " + extraTargets.map((x) => x.path).join(", ") : "";
  const note = harness === "windsurf" ? "Cascade does not run hooks while the workspace is in Restricted Mode: trust the workspace.\n" : "";
  return { code: 0, stdout: "Speckl " + harness + " hooks written to " + target + also + "\n" + note, stderr: warn };
}

function runAdapter(argv, env, stdinText, config, deps) {
  const harnesses = config.harness || {};
  if (argv[0] === "install") {
    const h = argv[1] || "";
    if (!harnesses[h]) {
      return { code: 1, stdout: "", stderr: "unknown or undeclared harness " + JSON.stringify(h) + " (declared: " + (Object.keys(harnesses).join(", ") || "none") + ")\n" };
    }
    return installHarness(h, parseAdapterFlags(argv.slice(2)), deps);
  }
  const harness = argv[0] || "";
  const event = argv[1] || "";
  const flags = parseAdapterFlags(argv.slice(2));
  const isPre = event === "pre";
  const fail = (reason) => {
    const msg = "Speckl: " + reason;
    if (event === "batch") return { code: 0, stdout: "", stderr: msg + "\n" };
    if (event === "turn-end") return { code: 0, stdout: harness === "gemini" ? "{}\n" : "", stderr: msg + "\n" };
    if (isPre || harnessEventName(harness, event) === null) return formatPre(harness, false, msg);
    return formatPost(harness, msg);
  };
  if (!harnesses[harness]) {
    return fail("harness " + JSON.stringify(harness) + " is not declared in the spec (declared: " + (Object.keys(harnesses).join(", ") || "none") + ")");
  }
  const expected = harnessEventName(harness, event);
  if (!expected) return fail("unknown event " + JSON.stringify(event) + " for " + harness);
  const rules = harnesses[harness].rules;
  let payload;
  try {
    const parsed = JSON.parse(stdinText || "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("hook payload is not a JSON object");
    payload = normalizePayload(harness, parsed);
  } catch {
    return fail("hook payload is not JSON");
  }
  if (payload.hook_event_name !== void 0 && payload.hook_event_name !== expected) {
    return fail("payload is " + JSON.stringify(payload.hook_event_name) + " but this hook is wired as " + expected);
  }
  if (!flags.state) return fail("missing --state");
  const projectDir = flags.project || (harness === "cursor" ? env.CURSOR_PROJECT_DIR : harness === "gemini" ? env.GEMINI_PROJECT_DIR : harness === "claude-code" ? env.CLAUDE_PROJECT_DIR : void 0) || (typeof payload.cwd === "string" ? payload.cwd : "") || deps.cwd;
  const stateAbs = deps.resolvePath(projectDir, flags.state);
  const keyAbs = flags.key ? deps.resolvePath(projectDir, flags.key) : null;
  const callCwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : projectDir;
  const protectedAbs = [deps.agentDir, stateAbs];
  if (keyAbs) protectedAbs.push(keyAbs);
  if (env.SPECKL_STATE_KEY_FILE) protectedAbs.push(deps.resolvePath(projectDir, env.SPECKL_STATE_KEY_FILE));
  const stateDir = deps.dirname(stateAbs);
  if (stateDir !== projectDir && deps.resolvePath(stateDir, ".") !== deps.resolvePath(projectDir, ".")) protectedAbs.push(stateDir);
  for (const d of harnessProtectedDirs(Object.keys(harnesses))) protectedAbs.push(deps.resolvePath(projectDir, d));
  if (flags["hermes-home"]) protectedAbs.push(deps.resolvePath(projectDir, flags["hermes-home"]));
  const protectedPaths = protectedAbs.map((abs) => {
    const r2 = deps.relativePath(projectDir, abs).replace(/\\/g, "/");
    return { abs, rel: r2.startsWith("..") ? "" : r2 };
  });
  if (flags.outside === "allow" && event !== "turn-end") {
    const r2 = deps.relativePath(projectDir, callCwd).replace(/\\/g, "/");
    if (r2 === ".." || r2.startsWith("../") || /^[A-Za-z]:|^\//.test(r2)) {
      if (!isPre) return formatPost(harness, null);
      const pin2 = parseToolInput(payload.tool_input);
      if (!pin2.ok) return fail(pin2.reason);
      const hit = findProtectedMention(pin2.input, protectedPaths, callCwd, deps.resolvePath);
      if (hit) return fail(String(payload.tool_name) + " touches a Speckl-protected path (" + hit + "); the agent may not read or change its own rails");
      return formatPre(harness, true, "");
    }
  }
  if (event === "turn-end") {
    const quiet = harness === "gemini" ? "{}\n" : "";
    const text = deps.readFile(stateAbs);
    let pending = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === "object") pending = st.pending;
    } catch {
    }
    if (!pending || typeof pending.tool !== "string" || pending.call_id === void 0) return { code: 0, stdout: quiet, stderr: "" };
    const r2 = deps.runHook("post", { tool: pending.tool, input: pending.input || {}, call_id: pending.call_id, ok: false }, stateAbs, keyAbs);
    if (r2.status !== 0) return { code: 0, stdout: quiet, stderr: "Speckl: could not clear the pending call: " + interpretHook(r2).reason + "\n" };
    return { code: 0, stdout: quiet, stderr: "Speckl cleared pending call " + String(pending.call_id) + " (no result reported); recorded as failed\n" };
  }
  if (event === "batch") {
    const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
    let cleared = 0;
    for (const c of calls) {
      if (!c || typeof c !== "object" || typeof c.tool_use_id !== "string") continue;
      const pin2 = parseToolInput(c.tool_input);
      if (!pin2.ok) continue;
      const m2 = mapHarnessCall(rules, c.tool_name, pin2.input);
      if (!m2.ok) continue;
      const r2 = deps.runHook("post", { tool: m2.tool, input: m2.input, call_id: c.tool_use_id, ok: false }, stateAbs, keyAbs);
      if (r2.status === 0) cleared++;
    }
    if (cleared === 0) return { code: 0, stdout: "", stderr: "" };
    const note = "Speckl cleared " + cleared + " tool call(s) that never reported a result (declined or interrupted); they were recorded as failed and did not advance the policy.";
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: note } }) + "\n", stderr: "" };
  }
  const toolName = payload.tool_name;
  const callId = harnessCallId(harness, payload);
  if (harness === "hermes" && event === "post") {
    const extra = payload.extra;
    if (extra && typeof extra === "object" && extra.status === "blocked") {
      const text = deps.readFile(stateAbs);
      let pending = null;
      try {
        const st = text ? JSON.parse(text) : null;
        if (st && st.pending && typeof st.pending === "object") pending = st.pending;
      } catch {
      }
      if (!pending || callId === null || pending.call_id !== callId || typeof pending.tool !== "string") return formatPost(harness, null);
      const r2 = interpretHook(deps.runHook("post", { tool: pending.tool, input: pending.input || {}, call_id: callId, ok: false }, stateAbs, keyAbs));
      return formatPost(harness, r2.allow ? null : "Speckl could not record blocked call " + callId + ": " + r2.reason);
    }
  }
  const clawDetails = harness === "openclaw" && event === "post" && payload.event && typeof payload.event === "object" ? payload.event.result : void 0;
  const clawBlocked = !!clawDetails && typeof clawDetails === "object" && !!clawDetails.details && clawDetails.details.status === "blocked";
  if (harness === "opencode" && event === "post-failure" || clawBlocked) {
    const text = deps.readFile(stateAbs);
    let pending = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === "object") pending = st.pending;
    } catch {
    }
    if (!pending || callId === null || pending.call_id !== callId) return formatPost(harness, null);
  }
  const pin0 = parseToolInput(payload.tool_input);
  if (!pin0.ok) return fail(pin0.reason);
  if (harness === "kiro" && event === "post" && Object.keys(pin0.input).length === 0) {
    const text = deps.readFile(stateAbs);
    let pending = null;
    try {
      const st = text ? JSON.parse(text) : null;
      if (st && st.pending && typeof st.pending === "object") pending = st.pending;
    } catch {
    }
    if (pending && callId !== null && pending.call_id === callId && typeof pending.tool === "string") {
      const ok2 = postSucceeded(harness, event, payload);
      const r2 = interpretHook(deps.runHook("post", { tool: pending.tool, input: pending.input || {}, call_id: callId, ok: ok2 }, stateAbs, keyAbs));
      return formatPost(harness, r2.allow ? null : "Speckl could not record " + String(toolName) + " (spec tool " + pending.tool + "): " + r2.reason);
    }
  }
  const pin = { ok: true, input: normalizeToolInput(harness, toolName, pin0.input) };
  const label = typeof toolName === "string" ? toolName : "(no tool_name)";
  if (isPre) {
    const hit = findProtectedMention(pin.input, protectedPaths, callCwd, deps.resolvePath);
    if (hit) return fail(label + " touches a Speckl-protected path (" + hit + "); the agent may not read or change its own rails");
    const wdField = harness === "kiro" || harness === "windsurf" ? "cwd" : "workdir";
    const wd = pin.input[wdField];
    if ((harness === "opencode" || harness === "openclaw" || harness === "kiro" || harness === "windsurf") && wd !== void 0 && wd !== null && wd !== "") {
      if (typeof wd !== "string" || deps.resolvePath(callCwd, wd) !== deps.resolvePath(projectDir, ".")) {
        return fail(label + " sets " + wdField + " " + JSON.stringify(wd) + "; Speckl only accepts commands run in the project root (" + projectDir + ")");
      }
    }
  }
  const m = mapHarnessCall(rules, toolName, pin.input);
  if (!m.ok) {
    if (isPre) return fail(m.reason);
    return fail(label + " ran without a Speckl mapping (" + m.reason + "); its pre hook should have denied it");
  }
  if (callId === null) return fail("payload has no tool_use_id (the harness sent no tool call id)");
  if (isPre) {
    const r2 = interpretHook(deps.runHook("pre", { tool: m.tool, input: m.input, call_id: callId }, stateAbs, keyAbs));
    if (r2.allow) return formatPre(harness, true, "");
    return formatPre(harness, false, "Speckl denied " + label + " (spec tool " + m.tool + "): " + r2.reason);
  }
  const ok = postSucceeded(harness, event, payload);
  const r = interpretHook(deps.runHook("post", { tool: m.tool, input: m.input, call_id: callId, ok }, stateAbs, keyAbs));
  if (r.allow && harness === "windsurf" && toolName === "run_command") {
    return formatPost(harness, "Speckl recorded " + label + " (spec tool " + m.tool + ") as not successful: Cascade does not report a command's exit status, so a terminal command never advances the policy. Use the tool mapped for this step (an MCP tool) instead.");
  }
  if (r.allow && harness === "codex" && toolName === "Bash") {
    return formatPost(harness, "Speckl recorded " + label + " (spec tool " + m.tool + ") as not successful: Codex does not report a Bash exit status, so a shell call never advances the policy. Use the tool mapped for this step instead.");
  }
  if (r.allow) return formatPost(harness, null);
  return formatPost(harness, "Speckl could not record " + label + " (spec tool " + m.tool + "): " + r.reason);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

const deps = {
  runHook(cmd, msg, statePath, keyPath) {
    const args = [path.join(agentDir, 'hook.mjs'), cmd, '--state', statePath];
    if (keyPath) args.push('--key', keyPath);
    // Stay inside the harness's own hook timeout (30s in the generated
    // wiring) so a hung hook.mjs is answered with a deny, not a fail-open.
    const t = Number(process.env.SPECKL_HOOK_TIMEOUT_MS);
    const timeout = Number.isFinite(t) && t > 0 ? t : 20000;
    const r = spawnSync(process.execPath, args, { input: JSON.stringify(msg), encoding: 'utf-8', timeout, killSignal: 'SIGKILL' });
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'hook.mjs timed out after ' + timeout + 'ms' : String(r.error))
      : (r.signal ? 'hook.mjs killed by ' + r.signal : '');
    return { status: r.error || r.signal ? null : r.status, stdout: r.stdout || '', stderr: why || r.stderr || '' };
  },
  resolvePath: (base, p) => path.resolve(base, p),
  relativePath: (from, to) => path.relative(from, to),
  dirname: p => path.dirname(p),
  cwd: process.cwd(),
  agentDir,
  readFile(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
  writeFile(p, text, mode) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); if (mode) fs.chmodSync(p, mode); },
};

async function main() {
  const argv = process.argv.slice(2);
  let out;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent-config.json'), 'utf-8'));
    const stdinText = argv[0] === 'install' ? '' : await readStdin();
    out = runAdapter(argv, process.env, stdinText, config, deps);
  } catch (e) {
    const msg = 'Speckl adapter error: ' + (e instanceof Error ? e.message : String(e));
    // Fail closed. A batch or turn-end hook must not stop the agent loop.
    const quiet = argv[1] === 'batch' || argv[1] === 'turn-end';
    out = quiet ? { code: 0, stdout: argv[0] === 'gemini' ? '{}\n' : '', stderr: msg + '\n' } : { code: 2, stdout: '', stderr: msg + '\n' };
  }
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.code;
}

main();
