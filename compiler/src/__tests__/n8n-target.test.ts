// -t n8n: importable workflow JSON, approval gates, verify script, no secrets.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

function freshOut(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-n8n-'));
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

function reachableSet(workflow: { connections: Record<string, { main?: { node: string }[][] }> }, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of outgoing(workflow, name)) queue.push(next);
  }
  return seen;
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
    const later = wf.nodes
      .filter((n: { type: string; name: string }) => n.type === 'n8n-nodes-base.code' && n.name !== 'Init' && n.name !== 'Check invariants' && !n.name.startsWith('Stage '))
      .map((n: { name: string }) => n.name);
    for (const action of later) {
      expect(reaches(wf, 'Stop review', action), action).toBe(false);
      expect(reaches(wf, 'Timeout review', action), action).toBe(false);
    }
    expect(later).toContain('OpenPR');
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
    const dirs = [compile(spec), compile(spec), compile(spec)];
    const files = walk(dirs[0]).map(f => relative(dirs[0], f));
    expect(files.length).toBeGreaterThan(0);
    for (const dir of dirs.slice(1)) {
      expect(walk(dir).map(f => relative(dir, f))).toEqual(files);
    }
    for (const rel of files) {
      const bytes = dirs.map(dir => readFileSync(join(dir, rel)));
      expect(Buffer.compare(bytes[0], bytes[1]), rel).toBe(0);
      expect(Buffer.compare(bytes[0], bytes[2]), rel).toBe(0);
      const text = bytes[0].toString('utf8');
      expect(text, rel).not.toContain(dirs[0]);
      expect(text, rel).not.toContain('Date.now');
      expect(text, rel).not.toContain('Math.random');
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

  it('fails the compile when an expression cannot be translated and writes no file', () => {
    const file = writeSpec('Pair.speckdl', [
      'speck First {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Stay { n := n }',
      '}',
      'speck Odd {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    invariant Odd { mystery(n) }',
      '    action Go { n := n + 1 }',
      '    verify Always(Odd) { depth 2 }',
      '}',
      '',
    ].join('\n'));
    const out = freshOut();
    expect(() => compileSpec(file, { outputDir: out, target: 'n8n', bomFormat: 'both', verifyDepth: 4 }))
      .toThrow(/cannot translate invariant Odd on Odd; refusing to write a partial workflow/);
    expect(existsSync(join(out, 'n8n'))).toBe(false);
    expect(walk(out).some(f => f.endsWith('.workflow.json') || f.endsWith('.verify.mjs') || f.endsWith('README.md'))).toBe(false);

    const all = freshOut();
    compileSpec(file, { outputDir: all, target: 'all', bomFormat: 'both', verifyDepth: 4 });
    expect(existsSync(join(all, 'n8n'))).toBe(false);
    expect(walk(all).some(f => f.endsWith('.ts'))).toBe(true);
  });

  it('writes no workflow when a literal looks like a secret, and a real workflow has no credentials', () => {
    const file = writeSpec('Secretish.speckdl', [
      'speck Secretish {',
      '    state { note: String }',
      '    init { note := "sk-live-abcdefghijklmnopqrst" }',
      '    action Go { note := note }',
      '}',
      '',
    ].join('\n'));
    const out = freshOut();
    let message = '';
    try {
      compileSpec(file, { outputDir: out, target: 'n8n', bomFormat: 'both', verifyDepth: 4 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/cannot translate init on Secretish/);
    for (const re of SECRET) expect(message).not.toMatch(re);
    expect(existsSync(join(out, 'n8n'))).toBe(false);

    const policy = compile(join(examplesDir, 'AgentPolicy.speckdl'));
    const json = readFileSync(join(policy, 'n8n', 'AgentPolicy.workflow.json'), 'utf8');
    const wf = JSON.parse(json);
    expect(JSON.stringify(wf)).not.toMatch(/"credentials"/);
    for (const node of wf.nodes) expect(node.credentials).toBeUndefined();
    for (const re of SECRET) expect(json).not.toMatch(re);
    expect(wf.meta.templateCredsSetupCompleted).toBe(false);
  });

  it('keeps a reject and a timeout off every later action, including a reject back to an earlier stage', () => {
    const file = writeSpec('EarlyReject.speckdl', [
      'speck EarlyReject {',
      '    state { stage: Nat; ran: Bool }',
      '    init { stage := 0; ran := false }',
      '    action Before {',
      '        require stage == 0',
      '        ran := false',
      '    }',
      '    action After {',
      '        require stage == 2',
      '        ran := true',
      '    }',
      '    agent {',
      '        stages stage {',
      '            Idle = 0',
      '            Wait = 1',
      '            Approved = 2',
      '        }',
      '        await Wait {',
      '            signal review',
      '            mode near',
      '            require outcome in { approve, reject! }',
      '            on approve -> Approved',
      '            on reject -> Idle',
      '            timeout 1h -> reject',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const wf = loadWorkflow(out, 'EarlyReject');
    for (const start of ['Stop review', 'Timeout review']) {
      expect(reaches(wf, start, 'After'), start).toBe(false);
      expect(reaches(wf, start, 'Before'), start).toBe(false);
    }
    const falseSlot = wf.connections['Gate review'].main[1] as { node: string }[];
    expect(falseSlot.map(e => e.node)).toEqual(['Stop review']);
    expect(outgoing(wf, 'Timeout review')).toEqual(['Stop review']);
    expect(outgoing(wf, 'Stop review')).toEqual([]);

    const podcast = loadWorkflow(compile(join(examplesDir, 'PodcastPublishing.speckdl')), 'PodcastPublishing');
    for (const action of ['ApplyMetadata', 'FixMetadata', 'RequestFix']) {
      expect(reaches(podcast, 'Stop host_approval', action), action).toBe(false);
      expect(reaches(podcast, 'Timeout host_approval', action), action).toBe(false);
    }
  });

  it('a Wait node with no timeout fails the compile', () => {
    const file = writeSpec('NoTimeout.speckdl', [
      'speck NoTimeout {',
      '    state { stage: Nat }',
      '    init { stage := 0 }',
      '    action After {',
      '        require stage == 2',
      '        stage := 3',
      '    }',
      '    agent {',
      '        stages stage {',
      '            Idle = 0',
      '            Wait = 1',
      '            Approved = 2',
      '        }',
      '        await Wait {',
      '            signal review',
      '            mode near',
      '            require outcome in { approve, reject! }',
      '            on approve -> Approved',
      '            on reject -> Idle',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));
    const out = freshOut();
    expect(() => compileSpec(file, { outputDir: out, target: 'n8n', bomFormat: 'both', verifyDepth: 4 }))
      .toThrow(/Wait has no timeout; refusing to write a partial workflow/);
    expect(existsSync(join(out, 'n8n'))).toBe(false);
  });

  it('spec text is escaped and is not an n8n expression', () => {
    const payload = 'hello {{ $json.password }} ={{ 7*7 }}';
    const file = writeSpec('Inject.speckdl', [
      'speck Inject {',
      '    state { note: String }',
      '    init { note := "hello {{ $json.password }} ={{ 7*7 }}" }',
      '    action Go { note := note }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const raw = readFileSync(join(out, 'n8n', 'Inject.workflow.json'), 'utf8');
    expect(raw).not.toContain('{{ $json.password }}');
    expect(raw).not.toContain('={{ 7*7 }}');
    expect(raw.split('={{ $json.outcome }}').join('')).not.toContain('{{');
    const wf = JSON.parse(raw);
    const code = wf.nodes.find((n: { name: string }) => n.name === 'Init').parameters.jsCode as string;
    expect(code).not.toContain('{{');
    const lit = code.match(/__root__\["note"\] = \((.*)\);/);
    expect(lit).not.toBeNull();
    expect(eval(lit![1])).toBe(payload);
  });

  it('credential references are placeholders by name only', () => {
    const file = writeSpec('Cred.speckdl', [
      'speck Cred {',
      '    state { token: String }',
      '    init { token := "{{ $env.API_TOKEN }}" }',
      '    action Go { token := token }',
      '}',
      '',
    ].join('\n'));
    const out = compile(file);
    const raw = readFileSync(join(out, 'n8n', 'Cred.workflow.json'), 'utf8');
    const wf = JSON.parse(raw);
    expect(raw).not.toContain('{{ $env.API_TOKEN }}');
    expect(wf.meta.templateCredsSetupCompleted).toBe(false);
    for (const node of wf.nodes) {
      expect(node.credentials).toBeUndefined();
      expect(JSON.stringify(node.parameters)).not.toMatch(/"id"\s*:/);
    }
    const code = wf.nodes.find((n: { name: string }) => n.name === 'Init').parameters.jsCode as string;
    const lit = code.match(/__root__\["token"\] = \((.*)\);/);
    expect(lit).not.toBeNull();
    const value = eval(lit![1]) as string;
    expect(value).toBe('{{ $env.API_TOKEN }}');
    expect(value).toMatch(/^\{\{ \$env\.[A-Za-z_][A-Za-z0-9_]* \}\}$/);
  });

  it('rejected and timed-out branches have no path to a downstream action', () => {
    const cases: { file: string; speck: string; stop: string; timeout: string; downstream: string[] }[] = [
      { file: 'AgentPolicy.speckdl', speck: 'AgentPolicy', stop: 'Stop review', timeout: 'Timeout review', downstream: ['OpenPR'] },
      { file: 'DeployGate.speckdl', speck: 'DeployGate', stop: 'Stop approval', timeout: 'Timeout approval', downstream: ['Deploy'] },
      { file: 'PodcastPublishing.speckdl', speck: 'PodcastPublishing', stop: 'Stop host_approval', timeout: 'Timeout host_approval', downstream: ['ApplyMetadata', 'FixMetadata', 'RequestFix'] },
    ];
    for (const item of cases) {
      const wf = loadWorkflow(compile(join(examplesDir, item.file)), item.speck);
      const downstream = new Set(item.downstream);
      for (const start of [item.stop, item.timeout]) {
        const seen = reachableSet(wf, start);
        expect(seen.size, `${item.speck} ${start}`).toBeGreaterThan(0);
        for (const node of seen) {
          expect(downstream.has(node), `${item.speck} ${start} reaches ${node}`).toBe(false);
          for (const next of outgoing(wf, node)) {
            expect(downstream.has(next), `${item.speck} ${node} -> ${next}`).toBe(false);
          }
        }
      }
    }
  });

  it('node ids and names are stable and collision-free across specs with the same step name', () => {
    const file = writeSpec('Twins.speckdl', [
      'speck Alpha {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go { n := 1 }',
      '}',
      'speck Beta {',
      '    state { n: Nat }',
      '    init { n := 0 }',
      '    action Go { n := 2 }',
      '}',
      '',
    ].join('\n'));
    const first = compile(file);
    const second = compile(file);
    const goId = (dir: string, speck: string) => {
      const wf = loadWorkflow(dir, speck);
      const names = wf.nodes.map((n: { name: string }) => n.name);
      const ids = wf.nodes.map((n: { id: string }) => n.id);
      expect(new Set(names).size, speck).toBe(names.length);
      expect(new Set(ids).size, speck).toBe(ids.length);
      return wf.nodes.find((n: { name: string }) => n.name === 'Go').id as string;
    };
    const alpha = goId(first, 'Alpha');
    const beta = goId(first, 'Beta');
    expect(alpha).not.toBe(beta);
    expect(goId(second, 'Alpha')).toBe(alpha);
    expect(goId(second, 'Beta')).toBe(beta);
    expect(readFileSync(join(first, 'n8n', 'Alpha.workflow.json'), 'utf8'))
      .toBe(readFileSync(join(second, 'n8n', 'Alpha.workflow.json'), 'utf8'));
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

  it('compiles every example, or stops with no n8n file when an expression does not translate', () => {
    const translates = new Set(['AgentPolicy.speckdl', 'ClaudeCodePolicy.speckdl', 'DeployGate.speckdl', 'PodcastPublishing.speckdl', 'ReviewGate.speckdl']);
    for (const name of names) {
      const out = freshOut();
      if (!translates.has(name)) {
        expect(() => compileSpec(join(examplesDir, name), { outputDir: out, target: 'n8n', bomFormat: 'both', verifyDepth: 4 }), name)
          .toThrow(/cannot translate/);
        expect(existsSync(join(out, 'n8n')), name).toBe(false);
        continue;
      }
      compileSpec(join(examplesDir, name), { outputDir: out, target: 'n8n', bomFormat: 'both', verifyDepth: 4 });
      const scripts = walk(join(out, 'n8n')).filter(f => f.endsWith('.verify.mjs'));
      expect(scripts.length, name).toBeGreaterThan(0);
      for (const script of scripts) {
        const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf-8' });
        expect(checked.status, `${name} ${checked.stderr}`).toBe(0);
      }
      const readme = readFileSync(join(out, 'n8n', 'README.md'), 'utf8');
      expect(readme.startsWith(DISCLAIMER)).toBe(true);
      expect(readme).toContain('does not run n8n');
      expect(readme).toContain('is not a model check');
      expect(readme).not.toMatch(/sandbox/i);
      expect(readme).not.toMatch(/telemetry/i);
      expect(readme).not.toMatch(/network/i);
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
    expect(doc).toContain('does not run n8n');
    expect(doc).toContain('is not a model check');
    expect(doc).toContain('oneof');
    expect(doc).toContain('{{ $env.NAME }}');
    expect(doc).toContain('writes no file');
    expect(doc).not.toMatch(/sandbox/i);
    expect(doc).not.toMatch(/telemetry/i);
    expect(doc).not.toMatch(/network/i);
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
