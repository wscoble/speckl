// Emits adapter.mjs — the harness adapter (Claude Code, Cursor, Codex, Gemini,
// Copilot, Goose, Hermes, Pi, OpenCode, OpenClaw) that sits in
// front of hook.mjs. The logic is harness-runtime.ts, emitted verbatim.

import { ADAPTER_FUNCTIONS } from './harness-runtime.js';

export function emitAdapterMjs(speckName: string, harnesses: string[]): string {
  const fns = ADAPTER_FUNCTIONS.map(f => f.toString()).join('\n\n');
  return `#!/usr/bin/env node
/**
 * Speckl harness adapter. Generated for ${speckName}; harnesses: ${harnesses.join(', ')}.
 *
 *   node adapter.mjs <harness> pre|post|post-failure|batch --state <file> [--key <file>]
 *       stdin: the harness's own hook JSON. Maps the call through the spec's
 *       harness block, runs hook.mjs, and answers in the harness's format.
 *   node adapter.mjs install <harness> --project <dir> --state <file> [--key <file>] [--dry-run]
 *       merges the hook wiring into .claude/settings.json, .cursor/hooks.json,
 *       .codex/hooks.json, .gemini/settings.json, .github/hooks/speckl.json
 *       (Copilot) or .agents/plugins/speckl/ (Goose); Hermes takes
 *       --hermes-home <profile dir> and writes its config.yaml hooks block.
 *       Pi, OpenCode and OpenClaw get a generated plugin in .pi/extensions/,
 *       .opencode/plugins/ or .openclaw/plugins/speckl/ that pipes each
 *       tool event to this adapter and blocks unless it answers allow.
 *       --dry-run prints the files it would create or change and writes nothing.
 *       A file install modifies is copied under .speckl/harness-install/backups/ first.
 *   node adapter.mjs status <harness> --project <dir> --state <file> [--key <file>]
 *       checks the installed config, the key file and the state file. It does not run the hook.
 *   node adapter.mjs doctor <harness> --project <dir> --state <file> [--key <file>]
 *       does what status does, then runs the installed pre hook on a tool the spec
 *       does not map and requires that hook to deny it. A missing hook or an allow is a failure.
 *   node adapter.mjs uninstall <harness> --project <dir>
 *       removes files this install created and restores backups. It will not delete
 *       or overwrite a file whose contents no longer match what install wrote.
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

${fns}

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
  removeFile(p) {
    try {
      if (!fs.lstatSync(p).isFile()) return false;
      fs.unlinkSync(p);
      return true;
    } catch { return false; }
  },
  runCommand(command, stdin, cwd, extraEnv) {
    const t = Number(process.env.SPECKL_HOOK_TIMEOUT_MS);
    const timeout = Number.isFinite(t) && t > 0 ? t : 20000;
    const env = { ...process.env, ...(extraEnv || {}) };
    // Shell wrappers (|| exit 2, $(...), $VAR) run under sh, which is how those
    // harnesses launch them. A plain argv is spawned directly so a missing
    // binary is reported rather than hidden by a shell.
    const shell = /[|&;<>$()]/.test(command) || command.indexOf('\\n') >= 0 || command.indexOf('\`') >= 0 || command.indexOf('[') >= 0;
    let r;
    if (shell) r = spawnSync('sh', ['-c', command], { input: stdin, encoding: 'utf-8', timeout, cwd, env, killSignal: 'SIGKILL' });
    else {
      const args = splitHookArgs(command);
      r = args.length
        ? spawnSync(args[0], args.slice(1), { input: stdin, encoding: 'utf-8', timeout, cwd, env, killSignal: 'SIGKILL' })
        : { error: new Error('empty command'), status: null, stdout: '', stderr: '', signal: null };
    }
    const err = r.error;
    return hookCommandResult(
      typeof r.status === 'number' ? r.status : null,
      err && err.code ? String(err.code) : '',
      err ? String(err) : '',
      r.signal ? String(r.signal) : '',
      r.stdout || '',
      r.stderr || '',
      timeout,
    );
  },
};

function splitHookArgs(command) {
  const args = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === '\\\\') { cur += command[++i] ?? ''; continue; }
      if (c === '"') { q = false; continue; }
      cur += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === ' ' || c === '\\t') { if (cur) { args.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  let out;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent-config.json'), 'utf-8'));
    const setupCmd = argv[0] === 'install' || argv[0] === 'uninstall' || argv[0] === 'status' || argv[0] === 'doctor';
    const stdinText = setupCmd ? '' : await readStdin();
    out = runAdapter(argv, process.env, stdinText, config, deps);
  } catch (e) {
    const msg = 'Speckl adapter error: ' + (e instanceof Error ? e.message : String(e));
    // Fail closed. A batch or turn-end hook must not stop the agent loop.
    const quiet = argv[1] === 'batch' || argv[1] === 'turn-end';
    out = quiet ? { code: 0, stdout: argv[0] === 'gemini' ? '{}\\n' : '', stderr: msg + '\\n' } : { code: 2, stdout: '', stderr: msg + '\\n' };
  }
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.code;
}

main();
`;
}
