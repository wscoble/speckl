// Live n8n. Skipped unless SPECKL_N8N_LIVE=1, which the CI job sets.
// The image is pinned by digest so a moved tag cannot change the run.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as unflat } from 'flatted';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileSpec } from '../compile.js';

const LIVE = process.env.SPECKL_N8N_LIVE === '1';
const IMAGE = 'n8nio/n8n@sha256:fabce3e9678a07d2dde83bd8f5124017f3ec457d0a3fc6b63bb4cec465d63861';
const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const examplesDir = path.resolve(compilerDir, '..', 'examples');
const TRANSLATES = [
  'AgentPolicy.speckdl',
  'ClaudeCodePolicy.speckdl',
  'DeployGate.speckdl',
  'PodcastPublishing.speckdl',
  'ReviewGate.speckdl',
];

const GATE = [
  'speck GateLive {',
  '    state { stage: Nat; ticket: String }',
  '    init { stage := 0; ticket := "T-1" }',
  '    action Prepare {',
  '        require stage == 0',
  '        ticket := "T-1"',
  '    }',
  '    action Ship {',
  '        require stage == 2',
  '        ticket := ticket',
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
  '            timeout 2s -> reject',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function docker(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const ran = spawnSync('docker', args, { encoding: 'utf8', input });
  return { status: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url: string, cookie: string): Promise<any> {
  let last = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url, { headers: { cookie } });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await sleep(500);
    }
  }
  throw new Error(last);
}

describe.skipIf(!LIVE)('n8n live import and resume', () => {
  const name = `speckl-n8n-live-${process.pid}`;
  let base = '';
  let cookie = '';
  let gateId = '';
  let gateWorkflow: Record<string, unknown> | null = null;

  beforeAll(async () => {
    docker(['rm', '-f', name]);
    const pulled = docker(['pull', IMAGE]);
    if (pulled.status !== 0) throw new Error(`docker pull failed\n${pulled.stderr}`);
    const started = docker([
      'run', '-d', '--name', name,
      '-p', '127.0.0.1::5678',
      '-e', 'N8N_DIAGNOSTICS_ENABLED=false',
      '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
      '-e', 'N8N_TEMPLATES_ENABLED=false',
      '-e', 'N8N_SECURE_COOKIE=false',
      IMAGE,
    ]);
    if (started.status !== 0) throw new Error(`docker run failed\n${started.stderr}`);
    const mapped = docker(['port', name, '5678/tcp']);
    const hostPort = mapped.stdout.trim().split(':').pop();
    if (!hostPort) throw new Error(`no published port\n${mapped.stdout}\n${mapped.stderr}`);
    base = `http://127.0.0.1:${hostPort}`;
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/rest/settings`);
        if (res.ok) {
          const body = await res.json() as { data?: { userManagement?: unknown } };
          if (body.data?.userManagement) { ready = true; break; }
        }
      } catch { /* n8n is still starting */ }
      await sleep(500);
    }
    if (!ready) {
      const logs = docker(['logs', name]);
      throw new Error(`n8n did not become ready\n${logs.stdout}\n${logs.stderr}`);
    }
    const setup = await fetch(`${base}/rest/owner/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'speckl@example.com',
        firstName: 'Speckl',
        lastName: 'Test',
        password: 'Speckl-n8n-test-1',
      }),
    });
    const setCookie = setup.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/n8n-auth=([^;]+)/);
    if (!setup.ok || !match) throw new Error(`owner setup failed ${setup.status} ${await setup.text()}`);
    cookie = `n8n-auth=${match[1]}`;

    const dir = mkdtempSync(path.join(tmpdir(), 'speckl-n8n-live-gate-'));
    const spec = path.join(dir, 'GateLive.speckdl');
    writeFileSync(spec, GATE);
    const compiled = path.join(dir, 'out');
    compileSpec(spec, { outputDir: compiled, target: 'n8n', bomFormat: 'both', verifyDepth: 4 });
    const workflowFile = path.join(compiled, 'n8n', 'GateLive.workflow.json');
    const dest = '/tmp/GateLive.workflow.json';
    const copied = docker(['cp', workflowFile, `${name}:${dest}`]);
    if (copied.status !== 0) throw new Error(copied.stderr);
    const imported = docker(['exec', '-u', 'node', name, 'n8n', 'import:workflow', `--input=${dest}`]);
    if (imported.status !== 0 || !imported.stdout.includes('Successfully imported 1 workflow.')) {
      throw new Error(`${imported.stdout}\n${imported.stderr}`);
    }
    const listed = await fetch(`${base}/rest/workflows?limit=100`, { headers: { cookie } });
    const body = await listed.json() as { data?: Array<{ id: string; name: string }> };
    const found = (body.data ?? []).find(item => item.name === 'GateLive');
    if (!found) throw new Error('GateLive was not listed after import');
    gateId = found.id;
    const full = await fetch(`${base}/rest/workflows/${gateId}`, { headers: { cookie } });
    gateWorkflow = ((await full.json()) as { data: Record<string, unknown> }).data;
  }, 180_000);

  afterAll(() => {
    docker(['rm', '-f', name]);
  });

  function importWorkflow(file: string): { status: number; stdout: string; stderr: string } {
    const dest = `/tmp/${path.basename(file)}`;
    const copied = docker(['cp', file, `${name}:${dest}`]);
    if (copied.status !== 0) return copied;
    return docker(['exec', '-u', 'node', name, 'n8n', 'import:workflow', `--input=${dest}`]);
  }

  async function workflows(): Promise<Array<{ id: string; name: string }>> {
    const body = await getJson(`${base}/rest/workflows?limit=100`, cookie);
    return body.data ?? [];
  }

  async function startGate(): Promise<string> {
    if (!gateWorkflow) throw new Error('gate workflow was not loaded');
    const keep = ['id', 'name', 'nodes', 'connections', 'settings', 'pinData', 'active', 'versionId'];
    const workflowData: Record<string, unknown> = {};
    for (const key of keep) if (key in gateWorkflow) workflowData[key] = gateWorkflow[key];
    const res = await fetch(`${base}/rest/workflows/${gateId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ workflowData, triggerToStartFrom: { name: 'Start' } }),
    });
    const body = await res.json() as { data?: { executionId?: string } };
    if (!res.ok || !body.data?.executionId) throw new Error(JSON.stringify(body));
    return body.data.executionId;
  }

  async function execution(id: string): Promise<any> {
    const body = await getJson(`${base}/rest/executions/${id}?includeData=true`, cookie);
    return body.data;
  }

  function decoded(ex: any): any {
    return typeof ex.data === 'string' ? unflat(ex.data) : ex.data;
  }

  async function until(id: string, pred: (ex: any) => boolean, ms: number): Promise<any> {
    const deadline = Date.now() + ms;
    let ex: any;
    while (Date.now() < deadline) {
      ex = await execution(id);
      if (pred(ex)) return ex;
      await sleep(400);
    }
    throw new Error(`execution ${id} stayed ${ex?.status}`);
  }

  function nodeJson(data: any, node: string, output = 0): any {
    const runs = data?.resultData?.runData?.[node];
    if (!runs?.length) return undefined;
    return runs[runs.length - 1].data?.main?.[output]?.[0]?.json;
  }

  function ran(data: any, node: string): boolean {
    return Boolean(data?.resultData?.runData?.[node]?.length);
  }

  it('imports every generated example workflow with n8n import:workflow', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'speckl-n8n-live-examples-'));
    const files: string[] = [];
    for (const spec of TRANSLATES) {
      const dir = path.join(out, spec.replace(/\.speckdl$/, ''));
      compileSpec(path.join(examplesDir, spec), { outputDir: dir, target: 'n8n', bomFormat: 'both', verifyDepth: 4 });
      const found = readdirSync(path.join(dir, 'n8n')).filter(name => name.endsWith('.workflow.json'));
      expect(found.length, spec).toBeGreaterThan(0);
      files.push(...found.map(name => path.join(dir, 'n8n', name)));
    }
    for (const file of files) {
      const imported = importWorkflow(file);
      expect(imported.status, `${file}\n${imported.stdout}\n${imported.stderr}`).toBe(0);
      expect(imported.stdout, file).toContain('Successfully imported 1 workflow.');
      expect(imported.stdout, file).not.toContain('Skipped workflow');
    }
    const listed = await workflows();
    for (const spec of TRANSLATES) {
      const speck = spec.replace(/\.speckdl$/, '');
      expect(listed.some(item => item.name === speck), speck).toBe(true);
    }
  }, 180_000);

  it('posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit', async () => {
    const id = await startGate();
    const waiting = await until(id, ex => ex.status === 'waiting', 15_000);
    const data = decoded(waiting);
    const token = data.resumeToken as string;
    expect(token).toMatch(/^[a-f0-9]{16,}$/);
    const posted = await fetch(`${base}/webhook-waiting/${id}?signature=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'approve' }),
    });
    expect(posted.status).toBe(200);
    const done = await until(id, ex => ex.status === 'success', 20_000);
    const finished = decoded(done);
    expect(nodeJson(finished, 'Wait review')?.body?.outcome).toBe('approve');
    expect(typeof nodeJson(finished, 'Wait review')?.headers).toBe('object');
    expect(nodeJson(finished, 'Resume review')).toMatchObject({ ticket: 'T-1', body: { outcome: 'approve' } });
    expect(nodeJson(finished, 'Ship')).toMatchObject({ ticket: 'T-1', stage: 2 });
    expect(ran(finished, 'Stop review')).toBe(false);
    await sleep(20_000);
    const later = await execution(id);
    expect(later.status).toBe('success');
    expect(ran(decoded(later), 'Ship')).toBe(true);
    expect(ran(decoded(later), 'Stop review')).toBe(false);
  }, 90_000);

  it('posts reject and the run ends at Stop and Error', async () => {
    const id = await startGate();
    const waiting = await until(id, ex => ex.status === 'waiting' && decoded(ex).resumeToken, 15_000);
    const token = decoded(waiting).resumeToken as string;
    const posted = await fetch(`${base}/webhook-waiting/${id}?signature=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'reject' }),
    });
    expect(posted.status).toBe(200);
    const done = await until(id, ex => ex.status === 'error', 20_000);
    const data = decoded(done);
    expect(nodeJson(data, 'Resume review')).toMatchObject({ ticket: 'T-1', body: { outcome: 'reject' } });
    expect(nodeJson(data, 'Gate review', 1)).toMatchObject({ ticket: 'T-1' });
    expect(ran(data, 'Ship')).toBe(false);
    expect(data.resultData.error.message).toBe('Approval was rejected or timed out. This branch stops.');
    const stop = data.resultData.runData['Stop review'].at(-1);
    expect(stop.error.message).toBe('Approval was rejected or timed out. This branch stops.');
  }, 40_000);

  it('a short timeout ends at Stop and Error', async () => {
    const id = await startGate();
    await until(id, ex => ex.status === 'waiting', 15_000);
    const done = await until(id, ex => ex.status === 'error', 40_000);
    const data = decoded(done);
    expect(nodeJson(data, 'Wait review')).toMatchObject({ stage: 0, ticket: 'T-1' });
    expect(nodeJson(data, 'Wait review').headers).toBeUndefined();
    expect(nodeJson(data, 'Resume review')).toMatchObject({ ticket: 'T-1', body: {} });
    expect(ran(data, 'Ship')).toBe(false);
    expect(data.resultData.error.message).toBe('Approval was rejected or timed out. This branch stops.');
    expect(data.resultData.runData['Stop review'].at(-1).error.message).toBe('Approval was rejected or timed out. This branch stops.');
  }, 60_000);
});
