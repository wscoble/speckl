// examples/Pundit.speckdl: grounded-take or skip, Clef retry budget,
// and no publish without the scott_review approval signal.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import ts from 'typescript';
import { canonical, useStateKey } from './helpers/agent-state.js';

// Loaded at runtime. A static import would pull examples/pundit/ports.ts
// into the compiler tsconfig, which only allows files under compiler/src.
type Ports = {
  CLEF_URL: string;
  CLEF_MODEL: string;
  CLEF_API_KEY_ENV: string;
  CLEF_QUESTION: string;
  CLEF_PASS_MILLI: number;
  YOUTUBE_CONTAINS_SYNTHETIC_MEDIA: string;
  scoreMilli(score: { noul: number }): number;
  clefDecision(score: { noul: number }, retries: number): 'pass' | 'retry' | 'fail';
  clefSystemOneRequest(apiKey: string, script: string, take: { text: string; citations: { locator: string }[] }): {
    url: string;
    headers: { Authorization: string };
    body: { model: string; questions: { passes: { type: string } } };
  };
  noulFromSystemOne(payload: unknown): { noul: number };
  perspectiveDecision(take: { text: string; citations: { locator: string }[] } | null): 'record' | 'skip';
};
let ports: Ports;

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'Pundit.speckdl');
const hasZ3 = spawnSync('z3', ['--version']).status === 0;
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };

function compile(spec: string, target: string, out: string): void {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), spec, '-t', target, '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr || r.stdout}`);
}

function z3Verdicts(smtFile: string): string[] {
  const r = spawnSync('z3', [smtFile], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`z3 exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout.split('\n').map(l => l.trim()).filter(l => /^(un)?sat$/.test(l));
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

useStateKey();
let out = '';
let agentDir = '';
let Machine: any;
let AgentMachine: any;
let n = 0;

function loadMachine(tsPath: string, mjsPath: string): Promise<any> {
  const src = readFileSync(tsPath, 'utf-8');
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  writeFileSync(mjsPath, js);
  return import(pathToFileURL(mjsPath).href).then(m => m.PunditMachine);
}

function run(script: string, args: string[], input?: unknown): R {
  const r = spawnSync(process.execPath, [join(agentDir, script), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
const pre = (state: string, tool: string, input: unknown, id: string) =>
  run('hook.mjs', ['pre', '--state', state], { tool, input, call_id: id });
const post = (state: string, tool: string, input: unknown, id: string, ok: boolean) =>
  run('hook.mjs', ['post', '--state', state], { tool, input, call_id: id, ok });

function init(): string {
  const state = join(mkdtempSync(join(tmpdir(), 'speckl-pundit-')), 'state.json');
  const r = run('signal.mjs', ['init', '--state', state, '--signer', 'reviewer=' + pubHex]);
  expect(r.status, r.stderr).toBe(0);
  return state;
}

const story = { headline: 'Fed holds rates', sourceUrls: ['https://example.test/fed'], facts: ['The rate is unchanged.'] };
const take = { text: 'Rates staying put punishes savers.', citations: [{ locator: 'vault/rates.md' }] };
const render = { scriptDigest: 'script-sha256' };
const disclosure = { flag: 'status.containsSyntheticMedia' };
const video = { videoDigest: 'video-sha256' };

function step(state: string, tool: string, input: unknown): void {
  expect(pre(state, tool, input, tool).status, tool).toBe(0);
  expect(post(state, tool, input, tool, true).status, tool).toBe(0);
}

function toAwaiting(state: string): void {
  step(state, 'ingest_story', { headline: story.headline });
  expect(ports.perspectiveDecision(take)).toBe('record');
  step(state, 'record_perspective', { citations: take.citations.length });
  step(state, 'draft_script', { trendSignal: 'question-hook' });
  expect(ports.clefDecision({ noul: 0.8 }, 0)).toBe('pass');
  step(state, 'pass_clef', { scoreMilli: ports.scoreMilli({ noul: 0.8 }) });
  expect(read(state).machine.state.stage).toBe(4);
}

function approve(state: string, call: string | undefined, outcome: 'approve' | 'reject' = 'approve'): R {
  const body: Record<string, unknown> = {
    signal: 'scott_review', outcome, claims: { reviewer: 'scott' },
    run: read(state).runId, expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(),
  };
  if (call !== undefined) body.call = call;
  const file = join(path.dirname(state), `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(body));
  writeFileSync(file, buf);
  writeFileSync(file + '.sig', crypto.sign(null, buf, privateKey));
  return run('signal.mjs', ['apply', '--state', state, '--verifier', 'file-drop', '--file', file, '--signer', 'reviewer']);
}

const ARGS: Record<string, Record<string, unknown>> = {
  IngestStory: { headline: story.headline },
  RecordPerspective: { citations: 1 },
  SkipNoPerspective: { reason: 'no grounded take' },
  DraftScript: { trendSignal: 'question-hook' },
  PassClef: { scoreMilli: 800 },
  RetryClef: { scoreMilli: 100 },
  FailClef: { scoreMilli: 100 },
  ApplyRejection: { notes: 'tighten the claim' },
  RenderShort: render,
  AcknowledgeDisclosure: disclosure,
  PublishShort: video,
  __signal_scott_review_approve: {},
  __signal_scott_review_reject: {},
};

/** Every enabled action, including the approval signal when the machine has it. */
function explore(Ctor: any): { states: number; published: number; publishedWithoutApproval: number } {
  type Node = { snap: unknown; approved: boolean };
  const seen = new Set<string>();
  const queue: Node[] = [{ snap: new Ctor().serialize(), approved: false }];
  let published = 0;
  let publishedWithoutApproval = 0;
  while (queue.length > 0) {
    if (seen.size > 200) throw new Error('exploration did not cover the reachable states');
    const { snap, approved } = queue.shift()!;
    const key = JSON.stringify(snap) + '|' + approved;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = Ctor.restore(JSON.parse(JSON.stringify(snap)));
    if (m.stage === 7) {
      published++;
      if (!approved) publishedWithoutApproval++;
    }
    for (const name of Object.keys(Ctor.ACTIONS) as string[]) {
      const args = ARGS[name];
      if (m.can(name, args) !== true) continue;
      const next = Ctor.restore(JSON.parse(JSON.stringify(m.serialize())));
      const params = (Ctor.ACTIONS as Record<string, string[]>)[name];
      next[name](...params.map(p => args[p]));
      queue.push({ snap: next.serialize(), approved: approved || name === '__signal_scott_review_approve' });
    }
  }
  return { states: seen.size, published, publishedWithoutApproval };
}

beforeAll(async () => {
  ports = await import(pathToFileURL(join(compilerDir, '..', 'examples', 'pundit', 'ports.ts')).href);
  out = mkdtempSync(join(tmpdir(), 'speckl-pundit-out-'));
  compile(example, 'all', out);
  agentDir = join(out, 'agent');
  Machine = await loadMachine(join(out, 'Pundit.ts'), join(out, 'Pundit.mjs'));
  AgentMachine = await loadMachine(join(agentDir, 'Pundit.ts'), join(out, 'Pundit.agent.mjs'));
}, 90_000);

describe('examples/Pundit.speckdl', () => {
  it('maps a Clef noul score at the 0.8 bar and refuses an uncited take', () => {
    expect(ports.CLEF_URL).toBe('https://ollama.com/v1/systemone');
    expect(ports.CLEF_MODEL).toBe('clef');
    expect(ports.CLEF_API_KEY_ENV).toBe('OLLAMA_API_KEY');
    const req = ports.clefSystemOneRequest('test-key', 'A short script.', take);
    expect(req.url).toBe(ports.CLEF_URL);
    expect(req.headers.Authorization).toBe('Bearer test-key');
    expect(req.body.model).toBe('clef');
    expect(req.body.questions.passes.type).toBe('noul');
    expect(ports.noulFromSystemOne({
      model: 'clef',
      answers: { passes: { type: 'noul', noul: 0.8 } },
    })).toEqual({ noul: 0.8 });
    expect(() => ports.clefSystemOneRequest('  ', 'A short script.', take)).toThrow(/OLLAMA_API_KEY/);
    expect(() => ports.noulFromSystemOne({ answers: {} })).toThrow(/answers\.passes\.noul/);
    expect(ports.YOUTUBE_CONTAINS_SYNTHETIC_MEDIA).toBe('status.containsSyntheticMedia');
    expect(ports.CLEF_PASS_MILLI).toBe(800);
    expect(ports.scoreMilli({ noul: 0.8 })).toBe(800);
    expect(ports.scoreMilli({ noul: 0.799 })).toBe(799);
    expect(ports.clefDecision({ noul: 0.8 }, 3)).toBe('pass');
    expect(ports.clefDecision({ noul: 0.799 }, 0)).toBe('retry');
    expect(ports.clefDecision({ noul: 0.799 }, 2)).toBe('retry');
    expect(ports.clefDecision({ noul: 0.799 }, 3)).toBe('fail');
    expect(ports.perspectiveDecision(null)).toBe('skip');
    expect(ports.perspectiveDecision({ text: 'A take.', citations: [] })).toBe('skip');
    expect(ports.perspectiveDecision({ text: 'A take.', citations: [{ locator: '  ' }] })).toBe('skip');
    expect(ports.perspectiveDecision(take)).toBe('record');
  });

  it.skipIf(!hasZ3)('Z3 proves publish needs the approval stage; rendering from review breaks that', () => {
    expect(z3Verdicts(join(out, 'Pundit.smt2'))).toEqual(['unsat', 'unsat', 'unsat', 'unsat', 'unsat', 'unsat', 'unsat']);
    const smt = readFileSync(join(out, 'Pundit.smt2'), 'utf-8');
    expect(smt).toContain('__signal_scott_review_approve');
    expect(smt).toContain('__signal_scott_review_reject');

    const dir = mkdtempSync(join(tmpdir(), 'speckl-pundit-weak-'));
    const weak = join(dir, 'Pundit.speckdl');
    const src = readFileSync(example, 'utf-8');
    const weakened = src.replace(
      'action RenderShort(scriptDigest: String) {\n        require stage == 5\n',
      'action RenderShort(scriptDigest: String) {\n        require stage == 4\n',
    );
    expect(weakened).not.toBe(src);
    writeFileSync(weak, weakened);
    compile(weak, 'z3', join(dir, 'out'));
    expect(z3Verdicts(join(dir, 'out', 'Pundit.smt2'))).toEqual(['unsat', 'unsat', 'sat', 'unsat', 'unsat', 'unsat', 'unsat']);
  }, 90_000);

  it.skipIf(!hasZ3)('publishing straight from review, without the approval flag, is a counterexample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-pundit-publish-weak-'));
    const weak = join(dir, 'Pundit.speckdl');
    const src = readFileSync(example, 'utf-8');
    const block = `action PublishShort(videoDigest: String) {
        require stage == 6
        require renderedFromApproval
        require disclosureAcknowledged
        publishedFromApproval := renderedFromApproval
        stage := 7
    }`;
    const loosened = `action PublishShort(videoDigest: String) {
        require stage == 4
        publishedFromApproval := renderedFromApproval
        stage := 7
    }`;
    expect(src).toContain(block);
    writeFileSync(weak, src.replace(block, loosened));
    compile(weak, 'z3', join(dir, 'out'));
    const verdicts = z3Verdicts(join(dir, 'out', 'Pundit.smt2'));
    expect(verdicts[0]).toBe('sat');
    expect(verdicts[1]).toBe('sat');
    expect(verdicts[2]).toBe('sat');
  }, 90_000);

  it('stops after three Clef retries and will not publish from Failed', () => {
    const m = new Machine();
    m.IngestStory(story.headline);
    m.RecordPerspective(take.citations.length);
    for (let i = 0; i < 3; i++) {
      m.DraftScript('question-hook');
      expect(m.can('FailClef', { scoreMilli: 100 })).toMatch(/^Guard failed: this.retries >= 3/);
      expect(ports.clefDecision({ noul: 0.5 }, m.retries)).toBe('retry');
      m.RetryClef(ports.scoreMilli({ noul: 0.5 }));
      expect(m.stage).toBe(2);
    }
    expect(m.retries).toBe(3);
    m.DraftScript('question-hook');
    expect(m.can('RetryClef', { scoreMilli: 100 })).toMatch(/^Guard failed: this.retries < 3/);
    expect(ports.clefDecision({ noul: 0.5 }, m.retries)).toBe('fail');
    m.FailClef(ports.scoreMilli({ noul: 0.5 }));
    expect(m.stage).toBe(9);
    expect(m.can('PublishShort', video)).toMatch(/^Guard failed/);
    expect(m.can('PassClef', { scoreMilli: 900 })).toMatch(/^Guard failed/);
    expect(m.can('RetryClef', { scoreMilli: 100 })).toMatch(/^Guard failed/);
    expect(m.can('DraftScript', { trendSignal: 'question-hook' })).toMatch(/^Guard failed/);
  });

  it('a pass on the draft after three failures still cannot publish', () => {
    const m = new Machine();
    m.IngestStory(story.headline);
    m.RecordPerspective(1);
    for (let i = 0; i < 3; i++) {
      m.DraftScript('hook');
      m.RetryClef(100);
    }
    m.DraftScript('hook');
    expect(ports.clefDecision({ noul: 0.91 }, m.retries)).toBe('pass');
    m.PassClef(ports.scoreMilli({ noul: 0.91 }));
    expect(m.stage).toBe(4);
    expect(m.clefPassed).toBe(true);
    expect(m.can('RenderShort', render)).toMatch(/^Guard failed: this.stage === 5/);
    expect(m.can('PublishShort', video)).toMatch(/^Guard failed: this.stage === 6/);
    expect(m.stage).toBe(4);
  });

  it('skips a story with no grounded take and does not publish it', () => {
    expect(ports.perspectiveDecision(null)).toBe('skip');
    const m = new Machine();
    m.IngestStory(story.headline);
    m.SkipNoPerspective('no grounded take');
    expect(m.stage).toBe(8);
    expect(m.hasCitations).toBe(false);
    for (const name of Object.keys(Machine.ACTIONS) as string[]) {
      expect(m.can(name, ARGS[name]), name).not.toBe(true);
    }
  });

  it('has no path to Published on the machine that lacks the approval signal', () => {
    expect(readFileSync(join(out, 'Pundit.ts'), 'utf-8')).not.toContain('__signal_');
    const reached = explore(Machine);
    expect(reached.published).toBe(0);
    expect(reached.publishedWithoutApproval).toBe(0);
    expect(reached.states).toBeGreaterThan(5);
  });

  it('reaches Published only on paths that took the approval signal', () => {
    const reached = explore(AgentMachine);
    expect(reached.published).toBeGreaterThan(0);
    expect(reached.publishedWithoutApproval).toBe(0);
  });

  it('a signed approval is the only hook path that lets publish run', () => {
    const state = init();
    toAwaiting(state);

    const early = pre(state, 'publish_short', video, 'pub0');
    expect(early.status).toBe(2);
    expect(read(state).machine.state.stage).toBe(4);

    const waiting = pre(state, 'render_short', render, 'r0');
    expect(waiting.status).toBe(2);
    const hint = waiting.stderr.match(/sign call ([0-9a-f]{64}) canonical (\S+)/);
    expect(hint, waiting.stderr).not.toBeNull();
    expect(hint![2]).toBe(canonical({ input: render, tool: 'render_short' }));
    const shown = JSON.parse(run('signal.mjs', ['digest'], { tool: 'render_short', input: render }).stdout);
    expect(hint![1]).toBe(shown.digest);

    const missing = approve(state, undefined);
    expect(missing.status).not.toBe(0);
    expect(read(state).machine.state.stage).toBe(4);

    const applied = approve(state, shown.digest);
    expect(applied.status, applied.stderr).toBe(0);
    expect(read(state).machine.state.stage).toBe(5);

    // The signed call is the render, not the upload.
    const uploadNow = pre(state, 'publish_short', video, 'pub1');
    expect(uploadNow.status).toBe(2);
    expect(read(state).machine.state.stage).toBe(5);

    expect(pre(state, 'render_short', render, 'r1').status).toBe(0);
    expect(post(state, 'render_short', render, 'r1', true).status).toBe(0);
    expect(read(state).machine.state.stage).toBe(6);
    expect(pre(state, 'publish_short', video, 'pub2').status).toBe(2);

    step(state, 'acknowledge_disclosure', disclosure);
    step(state, 'publish_short', video);
    expect(read(state).machine.state.stage).toBe(7);
    expect(read(state).machine.state.publishedFromApproval).toBe(true);
    expect(read(state).machine.state.disclosureAcknowledged).toBe(true);

    const again = pre(state, 'publish_short', video, 'pub3');
    expect(again.status).toBe(2);
  });

  it('rejection returns to scripting and still cannot publish', () => {
    const state = init();
    toAwaiting(state);
    const rejected = approve(state, undefined, 'reject');
    expect(rejected.status, rejected.stderr).toBe(0);
    expect(read(state).machine.state.stage).toBe(10);
    expect(pre(state, 'publish_short', video, 'pub').status).toBe(2);
    step(state, 'apply_rejection', { notes: 'cite the vault note' });
    expect(read(state).machine.state.stage).toBe(2);
    expect(read(state).machine.state.retries).toBe(0);
    expect(pre(state, 'publish_short', video, 'pub2').status).toBe(2);
  });

  it('the hook enforces the three-retry limit', () => {
    const state = init();
    step(state, 'ingest_story', { headline: story.headline });
    step(state, 'record_perspective', { citations: 2 });
    for (let i = 0; i < 3; i++) {
      step(state, 'draft_script', { trendSignal: 'hook' });
      expect(ports.clefDecision({ noul: 0.2 }, read(state).machine.state.retries)).toBe('retry');
      step(state, 'retry_clef', { scoreMilli: ports.scoreMilli({ noul: 0.2 }) });
    }
    expect(read(state).machine.state.retries).toBe(3);
    step(state, 'draft_script', { trendSignal: 'hook' });
    const fourth = pre(state, 'retry_clef', { scoreMilli: 100 }, 'retry-4');
    expect(fourth.status).toBe(2);
    expect(fourth.stderr).toContain('retries < 3');
    expect(read(state).machine.state.stage).toBe(3);
    step(state, 'fail_clef', { scoreMilli: 100 });
    expect(read(state).machine.state.stage).toBe(9);
    expect(pre(state, 'publish_short', video, 'pub').status).toBe(2);
    expect(pre(state, 'pass_clef', { scoreMilli: 900 }, 'pass').status).toBe(2);
  });

  it('generates one guarded HTTP route per action and no approval bypass', () => {
    const routes = readFileSync(join(out, 'camel', 'pundit', 'src', 'main', 'java', 'pundit', 'camel', 'PunditRoutes.java'), 'utf-8');
    const ids = [
      'IngestStory', 'RecordPerspective', 'SkipNoPerspective', 'DraftScript',
      'PassClef', 'RetryClef', 'FailClef', 'ApplyRejection', 'RenderShort',
      'AcknowledgeDisclosure', 'PublishShort',
    ];
    expect(routes.match(/routeId\("/g)).toHaveLength(ids.length);
    for (const id of ids) {
      expect(routes).toContain(`routeId("${id}")`);
      expect(routes).toContain(`from("platform-http:/${id.charAt(0).toLowerCase()}${id.slice(1)}")`);
    }
    expect(routes).not.toContain('timer:');
    expect(routes).not.toContain('__signal');

    const procDir = join(out, 'camel', 'pundit', 'src', 'main', 'java', 'pundit', 'camel', 'processor');
    const publish = readFileSync(join(procDir, 'PublishShortProcessor.java'), 'utf-8');
    expect(publish).toContain('getStage() == 6L');
    expect(publish).toContain('getRenderedFromApproval()');
    expect(publish).toContain('getDisclosureAcknowledged()');
    expect(publish).toContain('setStage(7L)');
    expect(publish).not.toContain('untranslated(');

    const pass = readFileSync(join(procDir, 'PassClefProcessor.java'), 'utf-8');
    expect(pass).toContain('getHeader("scoreMilli"');
    expect(pass).toContain('getStage() == 3L');
    expect(pass).not.toContain('800');
    expect(pass).not.toContain('untranslated(');

    const retry = readFileSync(join(procDir, 'RetryClefProcessor.java'), 'utf-8');
    expect(retry).toContain('getRetries() < 3L');
    const fail = readFileSync(join(procDir, 'FailClefProcessor.java'), 'utf-8');
    expect(fail).toContain('getRetries() >= 3L');
    const renderProc = readFileSync(join(procDir, 'RenderShortProcessor.java'), 'utf-8');
    expect(renderProc).toContain('getStage() == 5L');
    expect(renderProc).toContain('setRenderedFromApproval((punditState.getStage() == 5L))');
  });
});
