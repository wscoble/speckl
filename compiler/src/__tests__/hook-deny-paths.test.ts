// Deny paths of the generated hook.mjs that no other test reached.
//
// The hook runs as a child process of the harness, so line coverage cannot
// see it; these tests drive the real generated file and check both the
// decision (exit 2, {"decision":"deny"}) and that the state was not advanced.
import { describe, it, expect, beforeAll, vi } from 'vitest';
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

/** Compile AgentPolicy with `edit` applied to the source; returns the agent dir. */
function build(edit: (src: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-hookdeny-'));
  const spec = join(dir, 'AgentPolicy.speckdl');
  writeFileSync(spec, edit(readFileSync(example, 'utf-8')));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    compileSpec(spec, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'both', verifyDepth: 10 });
  } finally { log.mockRestore(); }
  return join(dir, 'out', 'agent');
}

function hook(agentDir: string, cmd: 'pre' | 'post', state: string, msg: object) {
  const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), cmd, '--state', state], { input: JSON.stringify(msg), encoding: 'utf-8' });
  const out = (r.stdout || '').trim();
  return { status: r.status, body: out ? JSON.parse(out.split('\n').pop()!) : null, stderr: r.stderr || '' };
}

const stateOf = (f: string) => JSON.parse(readFileSync(f, 'utf-8'));
/** A new state file, initialised the way an operator would (signal.mjs init). */
function freshState(agentDir: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'speckl-hookstate-')), 'state.json');
  const r = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), 'init', '--state', f], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return f;
}

/** Allow run_tests then request_review, leaving the machine in AwaitingReview. */
function toAwaitingReview(agentDir: string, state: string) {
  for (const [i, tool] of ['run_tests', 'request_review'].entries()) {
    expect(hook(agentDir, 'pre', state, { tool, input: {}, call_id: `c${i}` }).status).toBe(0);
    expect(hook(agentDir, 'post', state, { tool, call_id: `c${i}`, ok: true }).status).toBe(0);
  }
}

describe('generated hook: malformed calls are denied', () => {
  let agentDir = '';
  beforeAll(() => { agentDir = build(s => s); }, 60_000);

  for (const msg of [{ tool: 'run_tests', input: {} }, { tool: 'run_tests', input: {}, call_id: '' }, { input: {}, call_id: '1' }]) {
    it(`pre ${JSON.stringify(msg)} → deny, nothing pending`, () => {
      const state = freshState(agentDir);
      const r = hook(agentDir, 'pre', state, msg);
      expect(r.status).toBe(2);
      expect(r.body).toEqual({ decision: 'deny', reason: 'pre: tool and call_id are required' });
      // The deny happened before any state was recorded for the call.
      const after = hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: 'ok' });
      expect(after.status).toBe(0);
    });
  }

  it('post without call_id → deny, pending call kept', () => {
    const state = freshState(agentDir);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const r = hook(agentDir, 'post', state, { tool: 'run_tests', ok: true });
    expect(r.status).toBe(2);
    expect(r.body.reason).toBe('post: tool and call_id are required');
    expect(stateOf(state).pending.call_id).toBe('1');
  });

  it('post naming a different tool than the pending call → deny, machine not advanced', () => {
    const state = freshState(agentDir);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const before = stateOf(state).machine;
    const r = hook(agentDir, 'post', state, { tool: 'request_review', call_id: '1', ok: true });
    expect(r.status).toBe(2);
    expect(r.body.reason).toBe('post: tool does not match pending');
    expect(stateOf(state).machine).toEqual(before);
    expect(stateOf(state).pending.tool).toBe('run_tests');
  });
});

describe('generated hook: mode in (human in the loop)', () => {
  let agentDir = '';
  beforeAll(() => { agentDir = build(s => s.replace('mode near', 'mode in')); }, 60_000);

  it('refuses every tool, observe ones included, while awaiting the signal', () => {
    const state = freshState(agentDir);
    toAwaitingReview(agentDir, state);
    const r = hook(agentDir, 'pre', state, { tool: 'read_file', input: { path: 'README.md' }, call_id: 'r1' });
    expect(r.status).toBe(2);
    expect(r.body.reason).toBe('HITL: no tools while awaiting signal review');
    expect(stateOf(state).pending).toBeNull();
  });
});

describe('generated hook: pending timeout', () => {
  let agentDir = '';
  beforeAll(() => {
    agentDir = build(s => s.replace('        await AwaitingReview {', '        pending timeout 1s\n\n        await AwaitingReview {'));
  }, 60_000);

  it('a post after the pending call expired is denied and does not advance the machine', async () => {
    const state = freshState(agentDir);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    const before = stateOf(state).machine;
    await new Promise(r => setTimeout(r, 1300));
    const r = hook(agentDir, 'post', state, { tool: 'run_tests', call_id: '1', ok: true });
    expect(r.status).toBe(2);
    expect(r.body.reason).toBe('post: pending call expired; cleared as failed (state not advanced)');
    const after = stateOf(state);
    expect(after.pending).toBeNull();
    expect(after.machine).toEqual(before);
    // The same tool can be tried again from the unchanged state.
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '2' }).status).toBe(0);
  }, 20_000);

  it('a new pre after expiry clears the stale call and is judged fresh', async () => {
    const state = freshState(agentDir);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '2' }).body.reason).toMatch(/already pending \(1\); it clears as failed after 1s/);
    await new Promise(r => setTimeout(r, 1300));
    // run_tests is still allowed (stage 0), request_review is not: the expired call did not advance.
    expect(hook(agentDir, 'pre', state, { tool: 'request_review', input: {}, call_id: '3' }).body.reason).toMatch(/^can\(\) refused/);
    expect(hook(agentDir, 'pre', state, { tool: 'run_tests', input: {}, call_id: '4' }).status).toBe(0);
  }, 20_000);
});
