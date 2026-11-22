// -t n8n: importable workflow JSON, approval gates, verify script, no secrets.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSpec, type CompileOptions } from '../compile.js';
import { disposition } from '../conservation.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = path.resolve(compilerDir, '..');
const examplesDir = join(repoDir, 'examples');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const DISCLAIMER = 'Not for regulated data without your own review';
const SECRET = [/sk-[A-Za-z0-9]/, /ghp_/, /xoxb-/, /Bearer /, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function compile(file: string, target: CompileOptions['target'] = 'n8n'): string {
  const out = mkdtempSync(join(tmpdir(), 'speckl-n8n-'));
  compileSpec(file, { outputDir: out, target, bomFormat: 'both', verifyDepth: 4 });
  return out;
}

function writeSpec(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-n8n-src-'));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  }).sort();
}

function loadWorkflow(out: string, speck: string) {
  return JSON.parse(readFileSync(join(out, 'n8n', `${speck}.workflow.json`), 'utf8'));
}

function outgoing(workflow: { connections: Record<string, { main?: { node: string }[][] }> }, name: string): string[] {
  const main = workflow.connections[name]?.main ?? [];
  const out: string[] = [];
  for (const slot of main) for (const edge of slot ?? []) if (edge?.node) out.push(edge.node);
  return out;
}

function reaches(workflow: { connections: Record<string, { main?: { node: string }[][] }> }, start: string, goal: string, block = new Set<string>()): boolean {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || block.has(name)) continue;
    seen.add(name);
    if (name === goal) return true;
    for (const next of outgoing(workflow, name)) queue.push(next);
  }
  return false;
}

function runScript(out: string, speck: string) {
  return spawnSync(process.execPath, [join(out, 'n8n', `${speck}.verify.mjs`)], { encoding: 'utf-8' });
}

function assertDisclaimer(text: string): void {
  expect(text).toContain(DISCLAIMER);
  expect(text).toMatch(/general-purpose/);
  expect(text).toMatch(/not HIPAA-certified/);
  expect(text).toMatch(/You are responsible/);
  expect(text).toMatch(/does not guarantee zero data retention/);
  expect(text).not.toMatch(/ZDR is guaranteed/i);
  expect(text).not.toMatch(/zero data retention is guaranteed/i);
}

describe('n8n conservation', () => {
  it('emits approval and verify members and rejects wire constructs', () => {
    expect(disposition('n8n', 'agent')).toBe('emit');
    expect(disposition('n8n', 'verify')).toBe('emit');
    expect(disposition('n8n', 'invariant')).toBe('emit');
    expect(disposition('n8n', 'action')).toBe('emit');
    expect(disposition('n8n', 'oneof')).toBe('reject');
    expect(disposition('n8n', 'transition')).toBe('reject');
  });
});

describe('n8n workflow import shape', () => {
  const out = compile(join(examplesDir, 'AgentPolicy.speckdl'));
  const wf = loadWorkflow(out, 'AgentPolicy');
  const readme = readFileSync(join(out, 'n8n', 'README.md'), 'utf8');
  const files = walk(out).map(f => relative(out, f));

  it('writes only the n8n directory for -t n8n', () => {
    expect(files.every(f => f.startsWith('n8n/'))).toBe(true);
    expect(files).toContain('n8n/AgentPolicy.workflow.json');
    expect(files).toContain('n8n/AgentPolicy.verify.mjs');
    expect(files).toContain('n8n/README.md');
    expect(files.some(f => f.endsWith('.prov.jsonld'))).toBe(false);
  });

  it('matches the n8n import object', () => {
    expect(wf.name).toBe('AgentPolicy');
    expect(wf.nodes.length).toBeGreaterThanOrEqual(3);
    expect(wf.settings).toEqual({ executionOrder: 'v1' });
    expect(wf.pinData).toEqual({});
    expect(wf.meta).toEqual({ templateCredsSetupCompleted: false });
    expect(wf.active).toBe(false);
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const node of wf.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(ids.has(node.id)).toBe(false);
      ids.add(node.id);
      expect(names.has(node.name)).toBe(false);
      names.add(node.name);
      expect(node.type).toMatch(/^n8n-nodes-base\./);
      expect(typeof node.typeVersion).toBe('number');
      expect(node.position).toHaveLength(2);
      expect(typeof node.position[0]).toBe('number');
      expect(typeof node.position[1]).toBe('number');
      expect(node.parameters).toBeTypeOf('object');
      expect(node.credentials).toBeUndefined();
    }
    for (const [from, conn] of Object.entries(wf.connections) as [string, { main: { node: string; type: string; index: number }[][] }][]) {
      expect(names.has(from)).toBe(true);
      expect(Array.isArray(conn.main)).toBe(true);
      for (const slot of conn.main) {
        expect(Array.isArray(slot)).toBe(true);
        for (const edge of slot) {
          expect(names.has(edge.node)).toBe(true);
          expect(edge.type).toBe('main');
          expect(edge.index).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('puts the approval Wait and If before OpenPR, and stops reject and timeout', () => {
    const wait = wf.nodes.find((n: { name: string }) => n.name === 'Wait review');
    const timeout = wf.nodes.find((n: { name: string }) => n.name === 'Timeout review');
    const gate = wf.nodes.find((n: { name: string }) => n.name === 'Gate review');
    const stop = wf.nodes.find((n: { name: string }) => n.name === 'Stop review');
    expect(wait.type).toBe('n8n-nodes-base.wait');
    expect(wait.parameters.resume).toBe('webhook');
    expect(timeout.type).toBe('n8n-nodes-base.wait');
    expect(timeout.parameters.resume).toBe('timeInterval');
    expect(gate.type).toBe('n8n-nodes-base.if');
    expect(stop.type).toBe('n8n-nodes-base.stopAndError');
    const rights = gate.parameters.conditions.conditions.map((c: { rightValue: string; operator: { operation: string } }) => c.rightValue);
    expect(rights).toEqual(['approve']);
    expect(gate.parameters.conditions.conditions[0].operator.operation).toBe('equals');
    expect(outgoing(wf, 'Stop review')).toEqual([]);
    expect(reaches(wf, 'Start', 'OpenPR')).toBe(true);
    expect(reaches(wf, 'Start', 'OpenPR', new Set(['Wait review']))).toBe(false);
    expect(reaches(wf, 'Timeout review', 'OpenPR')).toBe(false);
    const falseSlot = wf.connections['Gate review'].main[1] as { node: string }[];
    expect(falseSlot.map(e => e.node)).toEqual(['Stop review']);
    for (const edge of falseSlot) expect(reaches(wf, edge.node, 'OpenPR')).toBe(false);
    expect(reaches(wf, 'Stop review', 'RunTests')).toBe(false);
  });

  it('carries the regulated-data disclaimer and no secret material', () => {
    const sticky = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.stickyNote');
    assertDisclaimer(String(sticky.parameters.content));
    assertDisclaimer(readme);
    expect(readme.startsWith(DISCLAIMER)).toBe(true);
    const blob = walk(out).map(f => readFileSync(f, 'utf8')).join('\n');
    for (const re of SECRET) expect(blob).not.toMatch(re);
    expect(blob).not.toMatch(/ZDR is guaranteed/i);
    expect(blob).not.toMatch(/zero data retention is guaranteed/i);
    expect(blob).not.toContain('Date.now');
    expect(blob).not.toContain('Math.random');
  });

  it('runs the AgentPolicy verify script', () => {
    const ran = runScript(out, 'AgentPolicy');
    expect(ran.status, ran.stderr).toBe(0);
  });
});

describe('n8n determinism and fail-closed checks', () => {
  it('recompiles to the same bytes in two directories', () => {
    const spec = join(examplesDir, 'AgentPolicy.speckdl');
    const a = compile(spec);
    const b = compile(spec);
    const filesA = walk(a).map(f => relative(a, f));
    expect(walk(b).map(f => relative(b, f))).toEqual(filesA);
    for (const rel of filesA) {
      const left = createHash('sha256').update(readFileSync(join(a, rel))).digest('hex');
      const right = createHash('sha256').update(readFileSync(join(b, rel))).digest('hex');
      expect(left, rel).toBe(right);
    }
  });

  it('matches a CLI compile of the same spec', () => {
    const spec = join(examplesDir, 'DeployGate.speckdl');
    const inproc = compile(spec);
    const cli = mkdtempSync(join(tmpdir(), 'speckl-n8n-cli-'));
    const ran = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', 'n8n', '-o', cli], {
      cwd: compilerDir,
      encoding: 'utf-8',
    });
    expect(ran.status, ran.stderr).toBe(0);
    const files = walk(inproc).map(f => relative(inproc, f));
    expect(walk(cli).map(f => relative(cli, f))).toEqual(files);
    for (const rel of files) {
      expect(readFileSync(join(cli, rel), 'utf8'), rel).toBe(readFileSync(join(inproc, rel), 'utf8'));
    }
    const wf = loadWorkflow(cli, 'DeployGate');
    expect(reaches(wf, 'Start', 'Deploy')).toBe(true);
    expect(reaches(wf, 'Start', 'Deploy', new Set(['Wait approval']))).toBe(false);
    expect(reaches(wf, 'Timeout approval', 'Deploy')).toBe(false);
    const rights = wf.nodes.find((n: { name: string }) => n.name === 'Gate approval').parameters.conditions.conditions
      .map((c: { rightValue: string }) => c.rightValue);
    expect(rights).toEqual(['approve']);
    expect(runScript(cli, 'DeployGate').status).toBe(0);
  }, 60_000);

  it('exits 1 when an invariant fails on the initial state', () => {
    const file = writeSpec('Bad.speckdl', [
      'speck Bad {',
      '    state { n: Nat }',
      '    init { n := 1 }',
      '    invariant Zero { n == 0 }',
      '    action Stay { require n == 1 }',
      '    verify Always(Zero) { depth 2 }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const ran = runScript(out, 'Bad');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/invariant failed: Zero/);
  });

  it('exits 1 when an expression cannot be translated', () => {
    const file = writeSpec('Odd.speckdl', [
      'speck Odd {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    invariant Odd { mystery(n) }',
      '    action Go { n := n + 1 }',
      '    verify Always(Odd) { depth 2 }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const ran = runScript(out, 'Odd');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/untranslated/);
    const blob = walk(out).map(f => readFileSync(f, 'utf8')).join('\n');
    expect(blob).not.toMatch(/mystery\(n\)/);
  });

  it('does not emit a secret-like literal', () => {
    const file = writeSpec('Secretish.speckdl', [
      'speck Secretish {',
      '    state { note: String }',
      '    init { note := "sk-live-abcdefghijklmnopqrst" }',
      '    action Go { note := note }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const blob = walk(out).map(f => readFileSync(f, 'utf8')).join('\n');
    for (const re of SECRET) expect(blob).not.toMatch(re);
    expect(runScript(out, 'Secretish').status).toBe(1);
  });

  it('rejects oneof instead of dropping it', () => {
    const file = writeSpec('Wire.speckdl', [
      'speck Wire {',
      '    oneof Payload {',
      '        tick: Ticked',
      '    }',
      '}',
      '',
    ].join('\n'));
    expect(() => compile(file)).toThrow(/n8n backend rejects AST node type "oneof"/);
  });

  it('keeps ReviewGate checks passing without an await block', () => {
    const out = compile(join(examplesDir, 'ReviewGate.speckdl'));
    const wf = loadWorkflow(out, 'ReviewGate');
    expect(wf.nodes.some((n: { type: string }) => n.type === 'n8n-nodes-base.wait')).toBe(false);
    expect(wf.nodes.length).toBeGreaterThanOrEqual(3);
    expect(runScript(out, 'ReviewGate').status).toBe(0);
  });
});

describe('n8n examples and docs', () => {
  const names = readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort();

  it('compiles every example and the verify script parses', () => {
    for (const name of names) {
      const out = compile(join(examplesDir, name));
      const scripts = walk(join(out, 'n8n')).filter(f => f.endsWith('.verify.mjs'));
      expect(scripts.length, name).toBeGreaterThan(0);
      for (const script of scripts) {
        const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf-8' });
        expect(checked.status, `${name} ${checked.stderr}`).toBe(0);
      }
      const readme = readFileSync(join(out, 'n8n', 'README.md'), 'utf8');
      expect(readme.startsWith(DISCLAIMER)).toBe(true);
    }
  }, 120_000);

  it('runs the agent-team verify scripts', () => {
    for (const speck of ['AgentPolicy', 'DeployGate', 'ClaudeCodePolicy', 'PodcastPublishing']) {
      const out = compile(join(examplesDir, `${speck}.speckdl`));
      const ran = runScript(out, speck);
      expect(ran.status, `${speck}\n${ran.stderr}`).toBe(0);
    }
  }, 60_000);

  it('documents the target without forbidden claims', () => {
    const doc = readFileSync(join(repoDir, 'docs', 'n8n-target.md'), 'utf8');
    const changelog = readFileSync(join(repoDir, 'CHANGELOG.md'), 'utf8');
    assertDisclaimer(doc);
    expect(doc).toContain('`-t n8n`');
    expect(doc).toContain('`-t all`');
    expect(doc).toContain('bind call');
    expect(doc).toContain('not a bounded model check');
    expect(doc).toContain('oneof');
    expect(doc).toContain('{{ $env.NAME }}');
    expect(doc).not.toMatch(/npm install -g speckl(?![-.\w])/);
    expect(changelog).toContain('n8n compile target');
    expect(changelog).not.toMatch(/ZDR is guaranteed/);
    const help = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), '--help'], {
      cwd: compilerDir,
      encoding: 'utf-8',
    });
    expect(help.stdout).toContain('n8n');
  }, 30_000);
});
