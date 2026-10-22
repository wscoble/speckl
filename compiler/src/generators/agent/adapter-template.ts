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
    const why = r.error
      ? (r.error.code === 'ETIMEDOUT' ? 'hook.mjs timed out after ' + timeout + 'ms' : 'hook.mjs could not be started')
      : (r.signal ? 'hook.mjs killed by ' + r.signal : '');
    return { status: r.error || r.signal ? null : r.status, stdout: r.stdout || '', stderr: why || r.stderr || '' };
  },
  resolvePath: (base, p) => path.resolve(base, p),
  relativePath: (from, to) => path.relative(from, to),
  dirname: p => path.dirname(p),
  realpath(p) { return fs.realpathSync(p); },
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
  } catch {
    // The exception text can carry a key path or key bytes, so it is not printed.
    // A batch or turn-end hook must not stop the agent loop.
    const msg = 'Speckl adapter error: the adapter failed closed. The call stays denied.';
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
