// In-process tests for the agent generator and agent { } lowering
// diagnostics (the end-to-end suites drive the CLI as a subprocess).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { generateAgent } from '../generators/agent/index.js';
import { injectSignalActions, isSignalActionName, signalActionName } from '../generators/agent/inject-signals.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const SRC = readFileSync(example, 'utf-8');

function lowerSrc(src: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'speckl-low-')), 'x.speckdl');
  writeFileSync(file, src);
  return lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
}
function diags(src: string) {
  return lowerSrc(src).diagnostics;
}
function errors(src: string): string[] {
  return diags(src).filter(d => d.level === 'error').map(d => d.message);
}

describe('generateAgent (in process)', () => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-gen-'));
  generateAgent(parseSpeckContent(SRC, example), { outputDir: out, sourcePath: example });
  const dir = join(out, 'agent');

  it('writes AGENTS.md describing tools, the wait state and proof scope', () => {
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    expect(md).toContain('| `open_pr` | `OpenPR` | act |');
    expect(md).toContain('| `read_file` | `ReadFile` | observe |');
    expect(md).toContain('### `AwaitingReview` (stage == 2)');
    expect(md).toContain('HNTL');
    expect(md).toContain('Required claims: `reviewer: String`');
    expect(md).toContain('Timeout `24h` → `reject` (must be a `!`-marked reject outcome)');
    expect(md).toContain('Outcomes: `approve`, `reject` (reject)');
    expect(md).toContain('DEV ONLY');
    expect(md).toContain('approve its own work');
    expect(md).toContain('pending call older than `10m`');
    expect(md).not.toContain('__signal_review_approve`');
  });

  it('tools.json exposes only declared tools with closed JSON schemas', () => {
    const tools = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf-8')).tools;
    expect(tools.map((t: any) => t.name)).toEqual(['run_tests', 'request_review', 'open_pr', 'read_file']);
    const rf = tools.find((t: any) => t.name === 'read_file');
    expect(rf.inputSchema).toEqual({
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
    });
    expect(rf['x-speckl']).toEqual({ action: 'ReadFile', effect: 'observe' });
    for (const t of tools) expect(isSignalActionName(t['x-speckl'].action)).toBe(false);
  });

  it('agent-config and spec.sha256 agree with the source hash', () => {
    const cfg = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'));
    const hash = readFileSync(join(dir, 'spec.sha256'), 'utf-8').trim();
    expect(cfg.specHash).toBe(hash);
    expect(cfg.awaits[0]).toMatchObject({
      state: 'AwaitingReview', stateValue: 2, signal: 'review', mode: 'near',
      timeout: { durationMs: 24 * 3600_000, outcome: 'reject' },
    });
    expect(cfg.awaits[0].on.map((o: any) => o.action)).toEqual(['__signal_review_approve', '__signal_review_reject']);
    expect(cfg.awaits[0].bindCall).toEqual([]);
  });

  it('the emitted .mjs machine runs and exposes synthetic signal actions', async () => {
    const mod = await import(join(dir, 'AgentPolicy.mjs'));
    const m = new mod.AgentPolicyMachine();
    expect(m.can('OpenPR', {})).not.toBe(true);
    m.RunTests(); m.RequestReview();
    expect(m.can('__signal_review_approve', {})).toBe(true);
    m.__signal_review_approve();
    expect(m.can('OpenPR', {})).toBe(true);
  });

  it('generated scripts are syntactically valid', () => {
    for (const f of ['hook.mjs', 'signal.mjs', 'verifiers/cli.mjs', 'verifiers/file-drop.mjs']) {
      const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf-8' });
      expect(r.status, f + r.stderr).toBe(0);
    }
  });

  it('skips specks without an agent block', () => {
    const o = mkdtempSync(join(tmpdir(), 'speckl-gen-skip-'));
    generateAgent(parseSpeckContent('speck A {\n    state {\n        x: Nat\n    }\n}\n'), { outputDir: o });
    expect(existsSync(join(o, 'agent'))).toBe(false);
  });

  it('maps parameter types to JSON schema', () => {
    const src = SRC.replace('action ReadFile(path: String) {', 'action ReadFile(path: String, n: Nat, i: Int, r: Real, b: Bool, l: List<String>, k: Stage) {');
    const o = mkdtempSync(join(tmpdir(), 'speckl-gen-types-'));
    generateAgent(parseSpeckContent(src), { outputDir: o });
    const props = JSON.parse(readFileSync(join(o, 'agent', 'tools.json'), 'utf-8')).tools[3].inputSchema.properties;
    expect(props.n).toEqual({ type: 'integer' });
    expect(props.i).toEqual({ type: 'integer' });
    expect(props.r).toEqual({ type: 'number' });
    expect(props.b).toEqual({ type: 'boolean' });
    expect(props.l.type).toBe('array');
    expect(props.k.type).toBe('string');
  });
});

describe('agent { } lowering', () => {
  it('the example lowers cleanly and records agent metadata in IR', () => {
    const ir = lowerSrc(SRC);
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const beh = (ir.specks[0].facets as any).behavior;
    expect(beh.agent.tools).toHaveLength(4);
    expect(beh.agent.awaits[0].syntheticActions.map((s: any) => [s.actionName, s.awaitValue, s.targetValue]))
      .toEqual([['__signal_review_approve', 2, 3], ['__signal_review_reject', 2, 4]]);
    expect(beh.next).toContain('__signal_review_reject');
  });

  it.each([
    ['duplicate tool', s => s.replace('tool read_file      -> ReadFile', 'tool open_pr -> ReadFile'), /duplicate tool "open_pr"/],
    ['unknown stage variable', s => s.replace('stages stage {', 'stages phase {'), /unknown state variable "phase"/],
    ['duplicate stage label', s => s.replace('Rejected = 4', 'Approved = 4'), /duplicate label "Approved"/],
    ['await on unknown stage', s => s.replace('await AwaitingReview {', 'await Limbo {'), /await Limbo: unknown stage label/],
    ['on → unknown target', s => s.replace('on reject  -> Rejected', 'on reject  -> Nowhere'), /unknown target stage/],
    ['timeout to accept', s => s.replace('timeout 24h -> reject', 'timeout 24h -> approve'), /reject outcome marked with !/],
    ['reject that approves', s => s.replace('on reject  -> Rejected', 'on reject  -> Approved'), /non-reject outcome also reaches/],
  ] as [string, (s: string) => string, RegExp][])('diagnoses %s', (_n, edit, re) => {
    expect(errors(edit(SRC)).some(m => re.test(m)), errors(edit(SRC)).join('\n')).toBe(true);
  });

  it('warns when next: is missing so signal edges are not BMC-covered', () => {
    const src = SRC.replace(/\n    next: .*\n/, '\n');
    expect(diags(src).some(d => d.level === 'warning' && /next: is missing/.test(d.message))).toBe(true);
  });

  it('the CLI refuses to emit rails for an invalid agent block', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'speckl-bad-')), 'Bad.speckdl');
    writeFileSync(bad, SRC.replace('-> OpenPR ', '-> NoSuch '));
    const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
    const out = join(path.dirname(bad), 'out');
    const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), bad, '-t', 'agent', '-o', out],
      { cwd: compilerDir, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown action "NoSuch"');
    expect(existsSync(join(out, 'agent', 'hook.mjs'))).toBe(false);
  }, 30_000);
});

describe('agent { } parser errors', () => {
  it.each([
    ['bad stage line', s => s.replace('Idle = 0', 'Idle 0'), /expected Name = n/],
    ['missing signal', s => s.replace('signal review\n', ''), /missing signal/],
    ['missing mode', s => s.replace('mode near\n', ''), /missing mode/],
    ['missing outcomes', s => s.replace('require outcome in { approve, reject! }\n', ''), /missing require outcome|not in require outcome/],
    ['missing on', s => s.replace(/ *on approve -> Approved\n *on reject  -> Rejected\n/, ''), /missing on/],
    ['on outside outcomes', s => s.replace('on reject  -> Rejected', 'on maybe -> Rejected'), /on maybe is not in require outcome/],
    ['timeout outside outcomes', s => s.replace('timeout 24h -> reject', 'timeout 24h -> later'), /timeout outcome later/],
    ['bad duration', s => s.replace('timeout 24h', 'timeout soon'), /duration/],
    ['bad claim', s => s.replace('reviewer: String', 'reviewer'), /claim must be name: Type/],
    ['junk in await', s => s.replace('mode near', 'mode near\n            frobnicate'), /unexpected line/],
    ['junk in agent', s => s.replace('agent {', 'agent {\n        frobnicate'), /unexpected line/],
  ] as [string, (s: string) => string, RegExp][])('%s', (_n, edit, re) => {
    expect(() => parseSpeckContent(edit(SRC))).toThrow(re);
  });

  it('mode in round-trips and the printer is stable', () => {
    const src = SRC.replace('mode near', 'mode in');
    const once = printAST(parseSpeckContent(src));
    expect(once).toContain('mode in');
    expect(printAST(parseSpeckContent(once))).toBe(once);
  });

  it('inject helpers', () => {
    expect(signalActionName('review', 'approve')).toBe('__signal_review_approve');
    const noAgent = parseSpeckContent('speck A {\n    state {\n        x: Nat\n    }\n}\n');
    expect(injectSignalActions(noAgent).specks[0]).toBe(noAgent.specks[0]);
  });
});
