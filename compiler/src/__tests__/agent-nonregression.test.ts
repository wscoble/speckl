// Non-agent examples stay free of agent artifacts; outputs unchanged in shape.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const reviewGate = join(compilerDir, '..', 'examples', 'ReviewGate.speckdl');

describe('non-agent regression', () => {
  it('ReviewGate compile does not create agent/ or __signal_ actions', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-nongent-'));
    const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), reviewGate, '-t', 'all', '-o', out],
      { cwd: compilerDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'agent'))).toBe(false);
    const ts = readFileSync(join(out, 'ReviewGate.ts'), 'utf-8');
    expect(ts).not.toContain('__signal_');
    const smt = readFileSync(join(out, 'ReviewGate.smt2'), 'utf-8');
    expect(smt).toContain('; Next transition relation: RunTests | RequestReview | Approve | Merge');
    expect(smt).not.toContain('__signal_');
  }, 60_000);
});
