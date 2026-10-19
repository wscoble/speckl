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
    const block = md.split('## Quickstart')[1].match(/```bash\n([\s\S]*?)```/)![1];
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
    const r = spawnSync('bash', ['-c', prelude + block], {
      cwd: work, encoding: 'utf-8', env: { ...process.env, HOME: home, SPECKL_STATE_KEY_FILE: '' },
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toContain('Speckl denied Bash (spec tool open_pr)');
    expect(r.stderr).toContain('unmapped harness tool "WebFetch"');
    const proj = join(work, 'greet');
    const settings = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    expect(readFileSync(join(proj, 'CLAUDE.md'), 'utf-8')).toContain('@.speckl/agent/AGENTS.md');
    const state = JSON.parse(readFileSync(join(proj, '.speckl', 'state.json'), 'utf-8'));
    expect(state.pending.tool).toBe('run_tests');
  }, 90_000);
});
