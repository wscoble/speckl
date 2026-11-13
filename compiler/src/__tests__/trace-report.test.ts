// Offline completion-signal report.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonical, checkDecisionHead, checkGenesis, checkMacs, decisionGenesis, formatTraceReport,
  readDecisionLog, runTrace, type TraceLine,
} from '../trace-report.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const fix = join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trace');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function brokenReason(text: string): string {
  const got = readDecisionLog(text);
  if (got.ok) throw new Error('expected a broken decision log');
  return got.reason;
}

function chain(bodies: Record<string, unknown>[], genesis = 'g'.repeat(64), key?: Buffer): string {
  let prev = genesis;
  const lines = bodies.map((body, i) => {
    const full = { ...body, seq: i, prev };
    const hash = sha(canonical(full));
    prev = hash;
    const line: Record<string, unknown> = { ...full, hash };
    if (key) line.mac = crypto.createHmac('sha256', key).update(hash).digest('hex');
    return JSON.stringify(line);
  });
  return lines.join('\n') + (lines.length ? '\n' : '');
}

const baseLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: '2026-01-01T00:00:00.000Z',
  phase: 'pre',
  tool: 'note',
  call_id: 'c',
  action: 'Note',
  verdict: 'deny',
  reason: 'no',
  input_sha256: 'ab',
  ...over,
});

describe('trace report', () => {
  const lines = JSON.parse(readFileSync(join(fix, 'report-lines.json'), 'utf8')) as TraceLine[];

  it('matches the golden report, including an empty log', () => {
    expect(formatTraceReport(lines)).toBe(readFileSync(join(fix, 'report.txt'), 'utf8'));
    expect(formatTraceReport([])).toBe(readFileSync(join(fix, 'empty.txt'), 'utf8'));
  });

  it('drops a parent from the drain, keeps a null priority, and skips a deny pre in the queue', () => {
    const onlyParent: TraceLine[] = [
      { seq: 1, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: 'a', verdict: 'allow', hash: 'h', trace_id: 't', branch_id: 'parent', parent_branch_id: null, priority: 'P0', trace_flagged: false },
      { seq: 0, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: 'early', verdict: 'allow', hash: 'h', trace_id: 't', branch_id: 'other', parent_branch_id: null, priority: 'P0', trace_flagged: false },
      { seq: 2, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: 'b', verdict: 'allow', hash: 'h', trace_id: 't', branch_id: 'child', parent_branch_id: 'parent', priority: 'P0', trace_flagged: false },
      { seq: 4, prev: 'p', ts: '2026-01-01T00:00:02.000Z', phase: 'post', call_id: 'a', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 't', branch_id: 'parent', parent_branch_id: null, priority: 'P0', trace_flagged: false, ok: true, kpis: [] },
      { seq: 3, prev: 'p', ts: '2026-01-01T00:00:01.000Z', phase: 'post', call_id: 'b', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 't', branch_id: 'child', parent_branch_id: 'parent', priority: 'P0', trace_flagged: false, ok: true, kpis: [] },
      { seq: 4, prev: 'p', ts: 'not-a-time', phase: 'pre', call_id: 'd', verdict: 'deny', hash: 'h', trace_id: 't', branch_id: 'd', parent_branch_id: null, priority: null, trace_flagged: false },
      { seq: 5, prev: 'p', ts: '2026-01-01T00:00:05.000Z', phase: 'post', call_id: 'u', verdict: 'deny', hash: 'h', signal: 'prime', trace_id: 't', branch_id: 'u', parent_branch_id: 'child', priority: 'P0', trace_flagged: true, ok: true, kpis: ['forged'] },
    ];
    const text = formatTraceReport(onlyParent);
    expect(text).toContain('macs not checked');
    const drain = text.split('priority P0')[1].split('\nlag\n')[0];
    expect(drain).toContain('trace t 1000 ms ingress 2026-01-01T00:00:00.000Z last_leaf 2026-01-01T00:00:01.000Z flagged false');
    expect(drain).not.toContain('2026-01-01T00:00:02.000Z');
    expect(drain).not.toContain('2026-01-01T00:00:05.000Z');
    expect(text.match(/trace t /g)?.length).toBe(1);
    expect(text).not.toContain('kpi forged');
    expect(text).not.toContain('2026-01-01T00:00:05.000Z');
    expect(text).toContain('call u unmatched');
    expect(text).toContain('priority (none)');
    const depth = text.split('queue_depth')[1];
    expect(depth).not.toContain('not-a-time');
    const held = formatTraceReport([
      { seq: 0, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: 'c', verdict: 'allow', hash: 'h', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: 'P0', trace_flagged: false },
      { seq: 1, prev: 'p', ts: '2026-01-01T00:00:00.400Z', phase: 'post', call_id: 'c', verdict: 'deny', hash: 'h', signal: 'prime', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: 'P0', trace_flagged: false, ok: true, kpis: ['notes'] },
    ]);
    const heldDepth = held.split('queue_depth')[1];
    expect(heldDepth).toContain('2026-01-01T00:00:00.000Z 1');
    expect(heldDepth).not.toContain('2026-01-01T00:00:00.400Z');
    expect(held).not.toContain('kpi notes');
  });

  it('reports an unparsed lag when the pre timestamp is not a time', () => {
    const text = formatTraceReport([
      { seq: 0, prev: 'p', ts: 'nope', phase: 'pre', call_id: 'c', verdict: 'allow', hash: 'h', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: 'P0', trace_flagged: false },
      { seq: 1, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'post', call_id: 'c', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: 'P0', trace_flagged: false, ok: true, kpis: [] },
    ]);
    expect(text).toContain('call c unparsed');
    expect(text).toContain('trace t unparsed');
  });

  it('checks the hash chain and leaves the HMAC for a key', () => {
    expect(readDecisionLog('')).toEqual({ ok: true, lines: [] });
    expect(readDecisionLog('{"a":1}')).toMatchObject({ ok: false, reason: 'decision record is torn' });
    expect(readDecisionLog('\n')).toMatchObject({ ok: false, reason: 'blank line in decision record' });
    expect(readDecisionLog('not json\n')).toMatchObject({ ok: false, reason: 'decision record line is not JSON' });
    expect(readDecisionLog('null\n')).toMatchObject({ ok: false, reason: 'decision record line is not an object' });
    expect(readDecisionLog('[]\n')).toMatchObject({ ok: false, reason: 'decision record line is not an object' });
    const good = chain([baseLine()]);
    expect(readDecisionLog(good).ok).toBe(true);
    const brokenPrev = good.replace('"prev":"' + 'g'.repeat(64) + '"', '"prev":1');
    expect(readDecisionLog(brokenPrev).ok).toBe(false);
    const seq = chain([baseLine(), baseLine({ call_id: 'd' })]);
    const parsed = readDecisionLog(seq);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tweaked = seq.replace('"call_id":"d"', '"call_id":"e"');
    expect(brokenReason(tweaked)).toMatch(/hash/);
    const badSeq = seq.replace('"seq":1', '"seq":9');
    expect(brokenReason(badSeq)).toMatch(/seq/);
    const swapped = chain([baseLine(), baseLine({ call_id: 'd' })]).split('\n').filter(Boolean);
    const rejoined = [swapped[1], swapped[0]].join('\n') + '\n';
    expect(brokenReason(rejoined)).toMatch(/seq|prev/);
    const allow = chain([baseLine({ verdict: 'allow', reason: 'why' })]);
    expect(brokenReason(allow)).toMatch(/reason/);
    const verdict = chain([baseLine({ verdict: 'maybe' })]);
    expect(brokenReason(verdict)).toMatch(/verdict/);
    const prime = chain([baseLine({
      phase: 'post', verdict: 'deny', signal: 'prime', trace_id: 't', branch_id: 'b',
      parent_branch_id: null, priority: 'P0', trace_flagged: false, ok: false, kpis: [],
    })]);
    expect(readDecisionLog(prime).ok).toBe(true);
    const noOk = chain([baseLine({
      phase: 'post', signal: 'prime', trace_id: 't', branch_id: 'b',
      parent_branch_id: null, priority: 'P0', trace_flagged: false, kpis: [],
    })]);
    expect(brokenReason(noOk)).toMatch(/ok/);
    const badSignal = chain([baseLine({ signal: 'other', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: true })]);
    expect(brokenReason(badSignal)).toMatch(/signal/);
    const ingressOk = chain([baseLine({ trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: false, ok: true })]);
    expect(brokenReason(ingressOk)).toMatch(/signal/);
    const shapes: Record<string, unknown>[] = [
      { trace_id: '', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: false },
      { trace_id: 't', branch_id: '', parent_branch_id: null, priority: null, trace_flagged: false },
      { trace_id: 't', branch_id: 'b', parent_branch_id: 1, priority: null, trace_flagged: false },
      { trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: 1, trace_flagged: false },
      { trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: 'no' },
      { phase: 'post', signal: 'prime', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: false, ok: true, kpis: 'notes' },
      { phase: 'post', signal: 'prime', trace_id: 't', branch_id: 'b', parent_branch_id: null, priority: null, trace_flagged: false, ok: true, kpis: [1] },
    ];
    for (const extra of shapes) {
      const got = readDecisionLog(chain([baseLine(extra)]));
      expect(got.ok, JSON.stringify(extra)).toBe(false);
    }
    const cycle = formatTraceReport([
      { seq: 2, prev: 'p', ts: 'nope', phase: 'pre', call_id: 'late', verdict: 'allow', hash: 'h', trace_id: 'cycle', branch_id: 'a', parent_branch_id: 'b', priority: 'P9', trace_flagged: false },
      { seq: 1, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: null, verdict: 'allow', hash: 'h', trace_id: 'cycle', branch_id: 'b', parent_branch_id: 'a', priority: 'P9', trace_flagged: false },
      { seq: 3, prev: 'p', ts: '2026-01-01T00:00:01.000Z', phase: 'post', call_id: null, verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 'cycle', branch_id: 'a', parent_branch_id: 'b', priority: 'P9', trace_flagged: false, ok: true, kpis: [] },
      { seq: 4, prev: 'p', ts: 'nope', phase: 'post', call_id: 'z', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 'cycle', branch_id: 'b', parent_branch_id: 'a', priority: 'P9', trace_flagged: false, ok: false, kpis: [] },
      { seq: 5, prev: 'p', ts: 'nope', phase: 'pre', call_id: 'p1', verdict: 'allow', hash: 'h', trace_id: 'ord', branch_id: 'leaf', parent_branch_id: null, priority: 'P8', trace_flagged: false },
      { seq: 0, prev: 'p', ts: '2026-01-01T00:00:00.000Z', phase: 'pre', call_id: 'p2', verdict: 'allow', hash: 'h', trace_id: 'ord', branch_id: 'leaf2', parent_branch_id: null, priority: 'P8', trace_flagged: false },
      { seq: 9, prev: 'p', ts: 'zzz', phase: 'pre', call_id: 'p3', verdict: 'allow', hash: 'h', trace_id: 'ord', branch_id: 'onlypre', parent_branch_id: null, priority: 'P8', trace_flagged: false },
      { seq: 6, prev: 'p', ts: '2026-01-01T00:00:02.000Z', phase: 'post', call_id: 'p1', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 'ord', branch_id: 'leaf', parent_branch_id: null, priority: 'P8', trace_flagged: false, ok: true, kpis: [] },
      { seq: 7, prev: 'p', ts: 'nope', phase: 'post', call_id: 'p2', verdict: 'allow', hash: 'h', signal: 'prime', trace_id: 'ord', branch_id: 'leaf2', parent_branch_id: null, priority: 'P8', trace_flagged: false, ok: true, kpis: [] },
    ]);
    expect(cycle).toContain('priority P9');
    expect(cycle.split('priority P9')[1].split('lag')[0]).toContain('none');
    expect(cycle).toContain('call  unmatched');
    expect(cycle).toContain('2026-01-01T00:00:00.000Z 2');
    expect(cycle).toContain('trace ord 2000 ms');
    const state = { runId: 'run', specHash: 'spec', keyId: 'kid' };
    expect(checkGenesis([], state)).toBeNull();
    expect(checkGenesis(parsed.lines, state)).toMatch(/does not match/);
    const keyed = chain([baseLine()], decisionGenesis(state), Buffer.alloc(32, 3));
    const keyedLines = readDecisionLog(keyed);
    expect(keyedLines.ok).toBe(true);
    if (!keyedLines.ok) return;
    expect(checkGenesis(keyedLines.lines, state)).toBeNull();
    expect(checkMacs(keyedLines.lines, Buffer.alloc(32, 3))).toBeNull();
    expect(checkMacs(keyedLines.lines, Buffer.alloc(32, 4))).toMatch(/mac does not match/);
    expect(checkMacs(parsed.lines, Buffer.alloc(32, 3))).toMatch(/has no mac/);
    expect(decisionGenesis({ runId: 'run', specHash: 'spec' })).toBe(decisionGenesis({ runId: 'run', specHash: 'spec', keyId: '' }));
  });
});

describe('speckl trace report', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function run(args: string[]): { code: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
    vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m) + '\n'); });
    vi.spyOn(console, 'error').mockImplementation((m) => { err.push(String(m)); });
    const code = runTrace(args);
    return { code, out: out.join(''), err: err.join('\n') };
  }

  it('prints usage and refuses a missing or ambiguous path', async () => {
    expect(run(['--help']).out).toContain('proves nothing to an outside auditor');
    expect(run(['--help']).out).toContain('macs not checked');
    expect(run(['--help']).out).toContain('head.json');
    expect(run([]).code).toBe(1);
    expect(run(['nope']).code).toBe(1);
    expect(run(['report']).err).toMatch(/exactly one/);
    expect(run(['report', '--log', 'a', '--state', 'b']).err).toMatch(/exactly one/);
    expect(run(['report', '--bogus']).err).toMatch(/unknown argument/);
    expect(run(['report', '--log']).err).toMatch(/exactly one/);
  });

  it('prints the golden report for a chained log and fails closed on a bad one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-trace-cli-'));
    const bodies = (JSON.parse(readFileSync(join(fix, 'report-lines.json'), 'utf8')) as Record<string, unknown>[]).map(row => baseLine({
      ...row,
      tool: 'note',
      action: 'Note',
      reason: row.verdict === 'allow' ? null : 'no',
      input_sha256: 'ab',
    }));
    const key = Buffer.alloc(32, 9);
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, chain(bodies, 'g'.repeat(64), key));
    const ok = run(['report', '--log', log, '--key', join(dir, 'missing')]);
    expect(ok.code).toBe(1);
    expect(ok.err).toMatch(/state key could not be read/);
    writeFileSync(join(dir, 'k'), key.toString('hex') + '\n');
    const printed = run(['report', '--log', log, '--key', join(dir, 'k')]);
    expect(printed.code, printed.err).toBe(0);
    expect(printed.out).toBe(readFileSync(join(fix, 'report.txt'), 'utf8').replace('macs not checked', 'macs checked'));
    const unchecked = run(['report', '--log', log]);
    expect(unchecked.code, unchecked.err).toBe(0);
    expect(unchecked.out.split('\n')[1]).toBe('macs not checked');
    writeFileSync(join(dir, 'bad'), 'abcd');
    expect(run(['report', '--log', log, '--key', join(dir, 'bad')]).err).toMatch(/state key/);
    writeFileSync(log, readFileSync(log, 'utf8').replace('"ok":true', '"ok":false'));
    const tampered = run(['report', '--log', log]);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toBe('');
    expect(tampered.err).toMatch(/hash|ok/);
    expect(run(['report', '--log', join(dir, 'nope')]).err).toMatch(/not found/);
    expect(run(['report', '--log', dir]).err).toMatch(/could not be read/);
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ runId: 'run', specHash: 'spec', keyId: null }));
    expect(run(['report', '--state', state]).out).toBe(readFileSync(join(fix, 'empty.txt'), 'utf8'));
    writeFileSync(state, '[]');
    expect(run(['report', '--state', state]).err).toMatch(/not an object/);
    writeFileSync(state, '{');
    expect(run(['report', '--state', state]).err).toMatch(/not JSON/);
    expect(run(['report', '--state', join(dir, 'absent')]).err).toMatch(/could not be read/);
    writeFileSync(state, JSON.stringify({ runId: 'other', specHash: 'spec', keyId: null }));
    mkdirSync(state + '.decisions');
    writeFileSync(state + '.decisions/log.jsonl', chain([baseLine()], decisionGenesis({ runId: 'run', specHash: 'spec', keyId: null })));
    expect(run(['report', '--state', state]).err).toMatch(/does not match/);
  });

  it('fails closed when --state log is shorter than the decision head or gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-trace-head-'));
    const stateObj = { runId: 'run', specHash: 'spec', keyId: null as string | null };
    const key = Buffer.alloc(32, 7);
    const prime = (call: string, ts: string) => baseLine({
      phase: 'post', verdict: 'allow', reason: null, call_id: call, ts,
      signal: 'prime', trace_id: 'tr', branch_id: 'b' + call, parent_branch_id: null,
      priority: 'P0', trace_flagged: false, ok: true, kpis: ['notes'],
    });
    const bodies = [
      baseLine({ verdict: 'allow', reason: null, call_id: 'c1', ts: '2026-01-01T00:00:00.000Z', trace_id: 'tr', branch_id: 'bc1', parent_branch_id: null, priority: 'P0', trace_flagged: false }),
      prime('c1', '2026-01-01T00:00:00.100Z'),
      baseLine({ verdict: 'allow', reason: null, call_id: 'c2', ts: '2026-01-01T00:00:00.200Z', trace_id: 'tr', branch_id: 'bc2', parent_branch_id: 'bc1', priority: 'P0', trace_flagged: false }),
      prime('c2', '2026-01-01T00:00:00.300Z'),
    ];
    const text = chain(bodies, decisionGenesis(stateObj), key);
    const parsed = readDecisionLog(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const genesis = decisionGenesis(stateObj);
    const last = parsed.lines[parsed.lines.length - 1];
    const head: Record<string, unknown> = {
      v: 1, runId: stateObj.runId, specHash: stateObj.specHash, keyId: null,
      genesis, seq: last.seq, hash: last.hash,
    };
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(head)) rest[k] = head[k];
    head.mac = crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify(stateObj));
    mkdirSync(state + '.decisions');
    const log = state + '.decisions/log.jsonl';
    writeFileSync(log, text);
    writeFileSync(state + '.decisions/head.json', JSON.stringify(head));
    writeFileSync(join(dir, 'k'), key.toString('hex'));
    const full = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(full.code, full.err).toBe(0);
    expect(full.out).toContain('macs checked');
    const short = text.trimEnd().split('\n').slice(0, -2).join('\n') + '\n';
    writeFileSync(log, short);
    const truncated = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(truncated.code).toBe(1);
    expect(truncated.err).toMatch(/decision record truncated/);
    expect(truncated.out).toBe('');
    unlinkSync(log);
    const gone = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(gone.code).toBe(1);
    expect(gone.err).toMatch(/decision record truncated/);
    expect(gone.out).toBe('');
    writeFileSync(log, text);
    const noKey = run(['report', '--state', state]);
    expect(noKey.code, noKey.err).toBe(0);
    expect(noKey.out).toContain('macs not checked');
    const forgedBodies = bodies.map((b, i) => i === 1 ? { ...b, ok: false } : b);
    const forged = chain(forgedBodies, decisionGenesis(stateObj));
    const forgedLog = join(dir, 'forged.jsonl');
    writeFileSync(forgedLog, forged);
    const rehashed = run(['report', '--log', forgedLog]);
    expect(rehashed.code, rehashed.err).toBe(0);
    expect(rehashed.out.split('\n')[1]).toBe('macs not checked');
    expect(rehashed.out).toContain('ok false');
    writeFileSync(state + '.decisions/head.json', '{');
    expect(run(['report', '--state', state]).err).toMatch(/decision head is not JSON/);
    writeFileSync(state + '.decisions/head.json', '[]');
    expect(run(['report', '--state', state]).err).toMatch(/not version 1/);
    const bare = { ...head };
    delete bare.mac;
    writeFileSync(state + '.decisions/head.json', JSON.stringify(bare));
    writeFileSync(log, text);
    expect(run(['report', '--state', state, '--key', join(dir, 'k')]).err).toMatch(/signature missing/);
    bare.mac = 'ab';
    writeFileSync(state + '.decisions/head.json', JSON.stringify(bare));
    expect(run(['report', '--state', state, '--key', join(dir, 'k')]).err).toMatch(/signature mismatch/);
    bare.mac = head.mac;
    bare.seq = -1;
    bare.hash = genesis;
    const restOpen: Record<string, unknown> = {};
    for (const k of Object.keys(bare)) if (k !== 'mac') restOpen[k] = bare[k];
    bare.mac = crypto.createHmac('sha256', key).update(canonical(restOpen)).digest('hex');
    writeFileSync(state + '.decisions/head.json', JSON.stringify(bare));
    const open = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(open.code, open.err).toBe(0);
    unlinkSync(state + '.decisions/head.json');
    const missingHead = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(missingHead.code).toBe(1);
    expect(missingHead.err).toMatch(/decision head missing/);
    expect(missingHead.out).toBe('');
    const other = { ...head, runId: 'nope' };
    expect(checkDecisionHead(parsed.lines, other, stateObj, key)).toMatch(/different state/);
    expect(checkDecisionHead(parsed.lines, { ...head, genesis: 'nope' }, stateObj, key)).toMatch(/genesis mismatch/);
    expect(checkDecisionHead(parsed.lines, { ...head, seq: 1.5 }, stateObj, key)).toMatch(/missing seq or hash/);
    expect(checkDecisionHead([], { ...head, seq: -1, hash: 'nope' }, stateObj)).toMatch(/hash mismatch/);
    expect(checkDecisionHead(parsed.lines, { ...head, seq: -1, hash: 'nope' }, stateObj)).toMatch(/hash mismatch/);
    expect(checkDecisionHead(parsed.lines, { ...head, hash: 'f'.repeat(64) }, stateObj)).toMatch(/hash mismatch/);
    expect(checkDecisionHead([], { ...head, seq: -1, hash: genesis }, stateObj)).toBeNull();
    expect(checkDecisionHead(parsed.lines, { ...head, v: 2 }, stateObj)).toMatch(/version 1/);
    expect(checkDecisionHead(parsed.lines, { ...head, seq: -2 }, stateObj)).toMatch(/truncated/);
    expect(checkDecisionHead(parsed.lines, { ...head, keyId: 'other' }, stateObj)).toMatch(/different state/);
  });

  it('fails when a log or decisions dir has no head, and does not claim macs on an empty record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-trace-nohead-'));
    const stateObj = { runId: 'run', specHash: 'spec', keyId: null as string | null };
    const key = Buffer.alloc(32, 5);
    const genesis = decisionGenesis(stateObj);
    const text = chain([
      baseLine({ verdict: 'allow', reason: null, call_id: 'c1', trace_id: 'tr', branch_id: 'b1', parent_branch_id: null, priority: 'P0', trace_flagged: false }),
      baseLine({ phase: 'post', signal: 'prime', verdict: 'allow', reason: null, call_id: 'c1', ok: true, ts: '2026-01-01T00:00:01.000Z', trace_id: 'tr', branch_id: 'b1', parent_branch_id: null, priority: 'P0', trace_flagged: false, kpis: ['notes'] }),
    ], genesis, key);
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify(stateObj));
    writeFileSync(join(dir, 'k'), key.toString('hex'));
    const sign = (seq: number, hash: string) => {
      const row: Record<string, unknown> = {
        v: 1, runId: stateObj.runId, specHash: stateObj.specHash, keyId: null, genesis, seq, hash,
      };
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(row)) rest[k] = row[k];
      row.mac = crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
      return JSON.stringify(row);
    };
    mkdirSync(state + '.decisions');
    const log = state + '.decisions/log.jsonl';
    writeFileSync(log, text);
    const parsed = readDecisionLog(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const last = parsed.lines[parsed.lines.length - 1];
    writeFileSync(state + '.decisions/head.json', sign(last.seq, last.hash));
    const present = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(present.code, present.err).toBe(0);
    expect(present.out.split('\n')[1]).toBe('macs checked');

    unlinkSync(state + '.decisions/head.json');
    const noHead = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(noHead.code).toBe(1);
    expect(noHead.err).toMatch(/decision head missing/);
    expect(noHead.out).toBe('');

    writeFileSync(log, text.trimEnd().split('\n').slice(0, 1).join('\n') + '\n');
    const shortened = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(shortened.code).toBe(1);
    expect(shortened.err).toMatch(/decision head missing/);
    expect(shortened.out).toBe('');

    unlinkSync(log);
    const logGone = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(logGone.code).toBe(1);
    expect(logGone.err).toMatch(/decision head missing/);

    rmSync(state + '.decisions', { recursive: true });
    const dirGone = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(dirGone.code, dirGone.err).toBe(0);
    expect(dirGone.out.split('\n')[1]).toBe('macs not checked');

    mkdirSync(state + '.decisions');
    writeFileSync(state + '.decisions/head.json', sign(-1, genesis));
    const empty = run(['report', '--state', state, '--key', join(dir, 'k')]);
    expect(empty.code, empty.err).toBe(0);
    expect(empty.out.split('\n')[1]).toBe('macs not checked');
  });

  it('the CLI entry prints the same report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-trace-bin-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), 'trace', 'report', '--log', log], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(join(fix, 'empty.txt'), 'utf8'));
  }, 60_000);
});
