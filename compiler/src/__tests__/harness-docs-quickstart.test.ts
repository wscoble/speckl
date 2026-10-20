// docs/harness-adapters.md quickstart runs exactly as written.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = path.resolve(compilerDir, '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

describe('docs/harness-adapters.md quickstart', () => {
  it('runs as written', () => {
    const md = readFileSync(join(repoDir, 'docs', 'harness-adapters.md'), 'utf-8');
    const block = md.split('## Quickstart: Speckl + Claude Code')[1].match(/```bash\n([\s\S]*?)```/)![1];
    // The Copilot / Goose / Hermes quickstart continues in the same project.
    const block2 = md.split('## Quickstart: GitHub Copilot CLI, Goose and Hermes')[1].match(/```bash\n([\s\S]*?)```/)![1];
    // ... and so does the Pi / OpenCode / OpenClaw one.
    const block3 = md.split('## Quickstart: Pi, OpenCode and OpenClaw')[1].match(/```bash\n([\s\S]*?)```/)![1];
    const work = mkdtempSync(join(tmpdir(), 'speckl-quickstart-'));
    const home = mkdtempSync(join(tmpdir(), 'speckl-home-'));
    // speckl-compile is the repo compiler; curl serves the example from this
    // checkout (only for the raw.githubusercontent.com example URL).
    const prelude = `set -euo pipefail
speckl-compile() { "${process.execPath}" "${viteNode}" --root "${compilerDir}" "${join(compilerDir, 'src', 'index.ts')}" "$@"; }
curl() {
  local url="" out=""
  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
  case "$url" in https://raw.githubusercontent.com/wscoble/speckl/main/examples/*) cp "${repoDir}/examples/\${url##*/}" "$out";; *) return 22;; esac
}
`;
    const r = spawnSync('bash', ['-c', prelude + block + block2 + block3], {
      cwd: work, encoding: 'utf-8', env: { ...process.env, HOME: home, SPECKL_STATE_KEY_FILE: '' },
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toContain('Speckl denied Bash (spec tool open_pr)');
    expect(r.stderr).toContain('unmapped harness tool "WebFetch"');
    const proj = join(work, 'greet');
    const settings = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    expect(readFileSync(join(proj, 'CLAUDE.md'), 'utf-8')).toContain('@.speckl/agent/AGENTS.md');
    // Copilot, Goose and Hermes each denied the push.
    expect(r.stderr).toContain('Speckl denied bash (spec tool open_pr)');
    expect(r.stderr).toContain('Speckl denied shell (spec tool open_pr)');
    expect(r.stderr).toContain('Speckl denied terminal (spec tool open_pr)');
    const copilot = JSON.parse(readFileSync(join(proj, '.github', 'hooks', 'speckl.json'), 'utf-8'));
    expect(copilot.hooks.preToolUse[0].bash).toMatch(/\|\| exit 2$/);
    const goose = JSON.parse(readFileSync(join(proj, '.agents', 'plugins', 'speckl', 'hooks', 'hooks.json'), 'utf-8'));
    expect(goose.hooks.PreToolUse[0].hooks[0].on_failure).toBe('block');
    const hermes = readFileSync(join(home, '.hermes-greet', 'config.yaml'), 'utf-8');
    expect(hermes).toContain('fail_closed: true');
    const allow = JSON.parse(readFileSync(join(home, '.hermes-greet', 'shell-hooks-allowlist.json'), 'utf-8'));
    expect(allow.approvals).toHaveLength(3);
    // Pi, OpenCode and OpenClaw each denied the push; the plugins are written.
    expect(r.stderr.match(/Speckl denied bash \(spec tool open_pr\)/g)!.length).toBeGreaterThanOrEqual(3);
    expect(r.stderr).toContain('Speckl denied exec (spec tool open_pr)');
    expect(r.stdout).toContain('{"decision":"block"');
    expect(readFileSync(join(proj, '.pi', 'extensions', 'speckl.js'), 'utf-8')).toContain('export default function specklRails(pi)');
    expect(readFileSync(join(proj, '.opencode', 'plugins', 'speckl.js'), 'utf-8')).toContain('"tool.execute.before"');
    expect(JSON.parse(readFileSync(join(proj, '.openclaw', 'plugins', 'speckl', 'openclaw.plugin.json'), 'utf-8')).id).toBe('speckl');
    const state = JSON.parse(readFileSync(join(proj, '.speckl', 'state.json'), 'utf-8'));
    expect(state.pending.tool).toBe('run_tests');
  }, 90_000);
});
