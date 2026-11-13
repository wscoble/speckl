// The generated hook writes completion-signal fields on an effect act tool.
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpec } from '../compile.js';
import { useStateKey } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');

useStateKey();

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-hook-signal-'));
  const spec = join(dir, 'AgentPolicy.speckdl');
  writeFileSync(spec, readFileSync(example, 'utf-8'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    compileSpec(spec, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'cdx', verifyDepth: 1 });
  } finally { log.mockRestore(); }
  return join(dir, 'out', 'agent');
}

function hook(agentDir: string, cmd: 'pre' | 'post', state: string, msg: object) {
  const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), cmd, '--state', state], {
    input: JSON.stringify(msg), encoding: 'utf-8',
  });
  const out = (r.stdout || '').trim();
  return { status: r.status, body: out ? JSON.parse(out.split('\n').pop()!) : null, stderr: r.stderr || '' };
}

function freshState(agentDir: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'speckl-hookstate-')), 'state.json');
  const r = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), 'init', '--state', f], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return f;
}

function lines(state: string): Record<string, unknown>[] {
  const text = readFileSync(state + '.decisions/log.jsonl', 'utf8').trim();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('generated hook completion signals', () => {
  const agentDir = build();

  it('stores the ingress trace on an allow pre and a prime signal on the matching post', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'c1', trace_id: 'root-1' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).toBe('root-1');
    expect(opened.signal).toBeUndefined();
    expect(opened.trace_flagged).toBe(false);
    expect(typeof opened.branch_id).toBe('string');

    const post = hook(agentDir, 'post', state, { tool: 'run_tests', call_id: 'c1', ok: true, trace_id: 'forged' });
    expect(post.status, post.stderr).toBe(0);
    const closed = lines(state).at(-1)!;
    expect(closed.signal).toBe('prime');
    expect(closed.ok).toBe(true);
    expect(closed.trace_id).toBe('root-1');
    expect(closed.kpis).toEqual([]);
  });

  it('replaces a bad trace id and still allows the call', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'c2', trace_id: 'has spaces' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).not.toBe('has spaces');
    expect(opened.trace_flagged).toBe(true);
    expect(opened.parent_branch_id).toBeNull();
  });

  it('denies a post with no matching pre and does not keep the caller trace', () => {
    const state = freshState(agentDir);
    const post = hook(agentDir, 'post', state, {
      tool: 'run_tests', call_id: 'missing', ok: true, trace_id: 'caller', kpis: ['forged'],
    });
    expect(post.status).toBe(2);
    expect(post.body.decision).toBe('deny');
    const denied = lines(state).at(-1)!;
    expect(denied.signal).toBe('prime');
    expect(denied.ok).toBe(false);
    expect(denied.kpis).toEqual([]);
    expect(denied.trace_id).not.toBe('caller');
    expect(denied.trace_flagged).toBe(true);
  });

  it('replaces an empty trace id and still allows the call', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'empty', trace_id: '' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).not.toBe('');
    expect(opened.trace_flagged).toBe(true);
    expect(opened.parent_branch_id).toBeNull();
  });

  it('replaces a trace id longer than 200 characters', () => {
    const state = freshState(agentDir);
    const long = 'a'.repeat(201);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'long', trace_id: long });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).not.toBe(long);
    expect(String(opened.trace_id).length).toBeLessThanOrEqual(200);
    expect(opened.trace_flagged).toBe(true);
  });

  it('replaces a trace id that contains a disallowed character', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'hash', trace_id: 'bad#id' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).not.toBe('bad#id');
    expect(opened.trace_flagged).toBe(true);
  });

  it('replaces a missing trace id and still allows the call', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'none' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(typeof opened.trace_id).toBe('string');
    expect(opened.trace_flagged).toBe(true);
    expect(opened.parent_branch_id).toBeNull();
  });

  it('flags a parent branch id that is not an id and clears it', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, {
      tool: 'run_tests', input: {}, call_id: 'badp', trace_id: 'root-bp', parent_branch_id: 'has space',
    });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).toBe('root-bp');
    expect(opened.parent_branch_id).toBeNull();
    expect(opened.trace_flagged).toBe(true);
  });

  it('an absent parent is a root and is not flagged', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'root', trace_id: 'root-plain' });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.trace_id).toBe('root-plain');
    expect(opened.parent_branch_id).toBeNull();
    expect(opened.trace_flagged).toBe(false);
  });

  it('an empty parent is a root and is not flagged', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, {
      tool: 'run_tests', input: {}, call_id: 'empty-parent', trace_id: 'root-ep', parent_branch_id: '',
    });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.parent_branch_id).toBeNull();
    expect(opened.trace_flagged).toBe(false);
  });

  it('does not keep a branch id equal to its parent', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, {
      tool: 'run_tests', input: {}, call_id: 'eq', trace_id: 'root-eq',
      parent_branch_id: 'parent-1', branch_id: 'parent-1',
    });
    expect(pre.status, pre.stderr).toBe(0);
    const opened = lines(state).at(-1)!;
    expect(opened.parent_branch_id).toBe('parent-1');
    expect(opened.branch_id).not.toBe('parent-1');
    expect(opened.trace_flagged).toBe(false);
  });

  it('an observe tool does not get the signal fields', () => {
    const state = freshState(agentDir);
    hook(agentDir, 'pre', state, { tool: 'read_file', input: {}, call_id: 'obs', trace_id: 'root-obs' });
    const opened = lines(state).at(-1)!;
    expect(opened.tool).toBe('read_file');
    expect(opened.trace_id).toBeUndefined();
    expect(opened.signal).toBeUndefined();
    expect(opened.kpis).toBeUndefined();
  });

  it('a matching post does not keep the caller kpis', () => {
    const state = freshState(agentDir);
    const pre = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'kpi', trace_id: 'root-kpi' });
    expect(pre.status, pre.stderr).toBe(0);
    const post = hook(agentDir, 'post', state, {
      tool: 'run_tests', call_id: 'kpi', ok: true, kpis: ['forged'], trace_id: 'forged',
    });
    expect(post.status, post.stderr).toBe(0);
    const closed = lines(state).at(-1)!;
    expect(closed.trace_id).toBe('root-kpi');
    expect(closed.kpis).toEqual([]);
    expect(closed.ok).toBe(true);
  });
});
