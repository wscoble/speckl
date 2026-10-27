// Offline completion-signal report.
//
// `speckl trace report` reads a decision log and prints, per priority,
// drain latency, completion-signal lag, and queue depth. It does not run
// the hook and it does not enforce a queue. Durations are a throughput
// signal, not a risk signal.
//
// The hash chain is checked. The HMAC is checked only when a key is passed.
// That HMAC is a shared-key seal. It proves nothing to an outside auditor.

import crypto from 'node:crypto';
import fs from 'node:fs';

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export interface TraceLine {
  seq: number;
  prev: string;
  ts: string;
  phase: string;
  call_id: string | null;
  verdict: string;
  hash: string;
  mac?: string;
  signal?: string;
  trace_id?: string;
  branch_id?: string;
  parent_branch_id?: string | null;
  priority?: string | null;
  trace_flagged?: boolean;
  ok?: boolean;
  kpis?: string[];
  [key: string]: unknown;
}

export function decisionGenesis(state: { runId?: unknown; specHash?: unknown; keyId?: unknown }): string {
  return sha256('speckl-decision-v1:' + canonical({
    run: state.runId, spec: state.specHash, keyId: state.keyId || null,
  }));
}

function traceShapeError(body: Record<string, unknown>): string | null {
  const has = body.trace_id !== undefined || body.branch_id !== undefined || body.signal !== undefined
    || body.parent_branch_id !== undefined || body.priority !== undefined || body.trace_flagged !== undefined
    || body.kpis !== undefined || body.ok !== undefined;
  if (!has) return null;
  if (body.signal !== undefined && body.signal !== 'prime') return 'signal';
  if (typeof body.trace_id !== 'string' || body.trace_id.length === 0) return 'trace_id';
  if (typeof body.branch_id !== 'string' || body.branch_id.length === 0) return 'branch_id';
  if (!(body.parent_branch_id === null || typeof body.parent_branch_id === 'string')) return 'parent_branch_id';
  if (!(body.priority === null || typeof body.priority === 'string')) return 'priority';
  if (typeof body.trace_flagged !== 'boolean') return 'trace_flagged';
  if (body.signal === 'prime') {
    if (typeof body.ok !== 'boolean') return 'ok';
    if (!Array.isArray(body.kpis) || body.kpis.some(k => typeof k !== 'string')) return 'kpis';
    return null;
  }
  if (body.ok !== undefined || body.kpis !== undefined) return 'signal';
  return null;
}

export type ReadLog = { ok: true; lines: TraceLine[] } | { ok: false; reason: string };

/** Hash chain only. A torn file, a bad link, or a bad completion-signal shape fails. HMAC is not checked. */
export function readDecisionLog(text: string): ReadLog {
  if (text === '') return { ok: true, lines: [] };
  if (!text.endsWith('\n')) return { ok: false, reason: 'decision record is torn' };
  const parts = text.slice(0, -1).split('\n');
  const lines: TraceLine[] = [];
  for (const p of parts) {
    if (p === '') return { ok: false, reason: 'blank line in decision record' };
    let line: unknown;
    try { line = JSON.parse(p); }
    catch { return { ok: false, reason: 'decision record line is not JSON' }; }
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      return { ok: false, reason: 'decision record line is not an object' };
    }
    lines.push(line as TraceLine);
  }
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as unknown as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(line)) {
      if (k !== 'hash' && k !== 'mac') body[k] = line[k];
    }
    if (body.seq !== i) return { ok: false, reason: 'decision chain broken at seq ' + i + ' (seq)' };
    if (typeof body.prev !== 'string' || (prev !== null && body.prev !== prev)) {
      return { ok: false, reason: 'decision chain broken at seq ' + i + ' (prev)' };
    }
    if (sha256(canonical(body)) !== line.hash) {
      return { ok: false, reason: 'decision chain broken at seq ' + i + ' (hash)' };
    }
    if (body.verdict !== 'allow' && body.verdict !== 'deny') {
      return { ok: false, reason: 'decision chain broken at seq ' + i + ' (verdict)' };
    }
    if (body.verdict === 'allow' && body.reason !== null) {
      return { ok: false, reason: 'decision chain broken at seq ' + i + ' (reason)' };
    }
    const shape = traceShapeError(body);
    if (shape) return { ok: false, reason: 'decision chain broken at seq ' + i + ' (' + shape + ')' };
    prev = String(line.hash);
  }
  return { ok: true, lines };
}

/** Empty log matches any state. Otherwise the first prev must be this state's decision genesis. */
export function checkGenesis(lines: TraceLine[], state: { runId?: unknown; specHash?: unknown; keyId?: unknown }): string | null {
  if (lines.length === 0) return null;
  if (lines[0].prev !== decisionGenesis(state)) return 'decision chain does not match this state';
  return null;
}

/** Shared-key HMAC check. A match is not proof to an outside auditor. */
export function checkMacs(lines: TraceLine[], key: Buffer): string | null {
  for (let i = 0; i < lines.length; i++) {
    const mac = lines[i].mac;
    if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return 'decision line ' + i + ' has no mac';
    const want = crypto.createHmac('sha256', key).update(String(lines[i].hash)).digest('hex');
    const a = Buffer.from(want, 'hex');
    const b = Buffer.from(mac, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'decision line ' + i + ' mac does not match';
  }
  return null;
}

function epoch(ts: string): number | null {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function priorityOf(line: TraceLine): string {
  return typeof line.priority === 'string' ? line.priority : '(none)';
}

function isPrime(line: TraceLine): boolean {
  return line.signal === 'prime';
}

function earliest(cands: TraceLine[]): TraceLine | null {
  let best: TraceLine | null = null;
  for (const line of cands) {
    if (!best) { best = line; continue; }
    const a = epoch(line.ts);
    const b = epoch(best.ts);
    if (a === null) continue;
    if (b === null || a < b || (a === b && line.seq < best.seq)) best = line;
  }
  return best;
}

function drainLines(lines: TraceLine[], priority: string): string[] {
  const primes = lines.filter(l => isPrime(l) && priorityOf(l) === priority && typeof l.trace_id === 'string' && typeof l.branch_id === 'string');
  const traces = [...new Set(primes.map(l => l.trace_id as string))].sort((a, b) => a.localeCompare(b));
  const out: string[] = [];
  for (const traceId of traces) {
    const group = lines.filter(l => l.trace_id === traceId);
    const leaves = primes.filter(l => l.trace_id === traceId && !group.some(g => g.parent_branch_id === l.branch_id));
    if (leaves.length === 0) continue;
    let last = leaves[0];
    for (const leaf of leaves.slice(1)) {
      const a = epoch(leaf.ts);
      const b = epoch(last.ts);
      if (a === null) continue;
      if (b === null || a > b || (a === b && leaf.seq > last.seq)) last = leaf;
    }
    const pres = group.filter(l => l.phase === 'pre' && l.verdict === 'allow');
    const ingress = earliest(pres) ?? earliest(group);
    const flagged = group.some(l => l.trace_flagged === true) ? 'true' : 'false';
    const inMs = ingress ? epoch(ingress.ts) : null;
    const leafMs = epoch(last.ts);
    if (!ingress || inMs === null || leafMs === null) {
      out.push('  trace ' + traceId + ' unparsed flagged ' + flagged);
      continue;
    }
    out.push('  trace ' + traceId + ' ' + (leafMs - inMs) + ' ms ingress ' + ingress.ts + ' last_leaf ' + last.ts + ' flagged ' + flagged);
  }
  return out;
}

function lagLines(lines: TraceLine[], priority: string): string[] {
  const used = new Set<number>();
  const out: string[] = [];
  for (const line of lines) {
    if (!isPrime(line) || priorityOf(line) !== priority) continue;
    const call = line.call_id == null ? '' : String(line.call_id);
    const pre = lines.find(p =>
      !used.has(p.seq)
      && p.phase === 'pre'
      && p.verdict === 'allow'
      && p.call_id === line.call_id
      && p.call_id != null
      && p.seq < line.seq,
    );
    if (!pre) {
      out.push('  call ' + call + ' unmatched');
      continue;
    }
    used.add(pre.seq);
    const a = epoch(pre.ts);
    const b = epoch(line.ts);
    if (a === null || b === null) {
      out.push('  call ' + call + ' unparsed');
      continue;
    }
    out.push('  call ' + call + ' ' + (b - a) + ' ms');
  }
  return out;
}

function queueLines(lines: TraceLine[], priority: string): string[] {
  const open = new Map<string, number>();
  let depth = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (priorityOf(line) !== priority) continue;
    const id = line.call_id == null ? '' : String(line.call_id);
    if (line.phase === 'pre' && line.verdict === 'allow' && typeof line.trace_id === 'string') {
      open.set(id, (open.get(id) ?? 0) + 1);
      depth += 1;
      out.push('  ' + line.ts + ' ' + depth);
      continue;
    }
    if (isPrime(line)) {
      const n = open.get(id) ?? 0;
      if (n <= 0) continue;
      open.set(id, n - 1);
      depth -= 1;
      out.push('  ' + line.ts + ' ' + depth);
    }
  }
  return out;
}

function section(rows: string[]): string[] {
  return rows.length === 0 ? ['  none'] : rows;
}

/**
 * Per priority: drain latency (ingress to the last leaf completion),
 * completion-signal lag (allow pre to prime), and queue depth after each
 * pre that has no post yet. KPI-tagged primes are listed back to their trace.
 * A priority of null is printed as `(none)`.
 */
export function formatTraceReport(lines: TraceLine[]): string {
  const priorities = new Set<string>();
  for (const line of lines) {
    if (typeof line.trace_id === 'string' || line.signal === 'prime') priorities.add(priorityOf(line));
  }
  const out: string[] = ['speckl trace report'];
  const names = [...priorities].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) out.push('priority', '  none');
  for (const priority of names) {
    out.push('priority ' + priority);
    out.push('drain');
    out.push(...section(drainLines(lines, priority)));
    out.push('lag');
    out.push(...section(lagLines(lines, priority)));
    out.push('queue_depth');
    out.push(...section(queueLines(lines, priority)));
  }
  const kpis = new Set<string>();
  for (const line of lines) {
    if (!isPrime(line) || !Array.isArray(line.kpis)) continue;
    for (const k of line.kpis) if (typeof k === 'string' && k) kpis.add(k);
  }
  const kpiNames = [...kpis].sort((a, b) => a.localeCompare(b));
  if (kpiNames.length === 0) out.push('kpi', '  none');
  for (const name of kpiNames) {
    out.push('kpi ' + name);
    for (const line of lines) {
      if (!isPrime(line) || !Array.isArray(line.kpis) || !line.kpis.includes(name)) continue;
      out.push(
        '  trace ' + (typeof line.trace_id === 'string' ? line.trace_id : '')
        + ' call ' + (line.call_id == null ? '' : String(line.call_id))
        + ' branch ' + (typeof line.branch_id === 'string' ? line.branch_id : '')
        + ' ok ' + (line.ok === true ? 'true' : 'false')
        + ' priority ' + priorityOf(line)
        + ' flagged ' + (line.trace_flagged === true ? 'true' : 'false'),
      );
    }
  }
  return out.join('\n') + '\n';
}

export const TRACE_USAGE = [
  'usage: speckl trace report (--log <file> | --state <file>) [--key <file>]',
  '',
  'Read a decision log offline. For each priority print drain latency',
  '(ingress to the last leaf completion), completion-signal lag (pre to',
  'post), and queue depth (an allow pre of that priority with no matching',
  'completion yet). A produced event tagged kpi "<name>" is attributed',
  'back to the trace of each completion that emitted it.',
  '',
  '--log <file>     decision log (log.jsonl)',
  '--state <file>   state.json; the log is <file>.decisions/log.jsonl',
  '--key <file>     also check HMAC-SHA256 macs with this state key',
  '',
  'The hash chain is always checked. The HMAC is checked only with --key.',
  'That seal is a shared-key HMAC. It proves nothing to an outside auditor:',
  'anyone who can read the key can forge a line, and someone without the',
  'key cannot check the mac.',
  '',
  'This command does not run the agent and does not enforce a queue.',
  'The durations are a throughput signal, not a risk signal.',
  'A missing log next to --state is an empty record. A missing --log file',
  'is an error. Exit 0 prints the report. Exit 1 is a bad log or a bad chain.',
].join('\n');

export function runTrace(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(TRACE_USAGE);
    return 0;
  }
  if (argv[0] !== 'report') {
    console.error(TRACE_USAGE);
    return 1;
  }
  let logPath = '';
  let statePath = '';
  let keyPath = '';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') logPath = argv[++i] || '';
    else if (a === '--state') statePath = argv[++i] || '';
    else if (a === '--key') keyPath = argv[++i] || '';
    else {
      console.error('unknown argument: ' + a);
      console.error(TRACE_USAGE);
      return 1;
    }
  }
  if ((logPath && statePath) || (!logPath && !statePath)) {
    console.error('speckl trace report: pass exactly one of --log or --state');
    return 1;
  }
  if (!logPath) logPath = statePath + '.decisions/log.jsonl';
  let text = '';
  if (fs.existsSync(logPath)) {
    try { text = fs.readFileSync(logPath, 'utf8'); }
    catch {
      console.error('speckl trace report: decision record could not be read');
      return 1;
    }
  } else if (statePath) {
    text = '';
  } else {
    console.error('speckl trace report: decision log not found');
    return 1;
  }
  const read = readDecisionLog(text);
  if (!read.ok) {
    console.error('speckl trace report: ' + read.reason);
    return 1;
  }
  if (statePath) {
    let raw: string;
    try { raw = fs.readFileSync(statePath, 'utf8'); }
    catch {
      console.error('speckl trace report: state file could not be read');
      return 1;
    }
    let state: unknown;
    try { state = JSON.parse(raw); }
    catch {
      console.error('speckl trace report: state file is not JSON');
      return 1;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      console.error('speckl trace report: state file is not an object');
      return 1;
    }
    const why = checkGenesis(read.lines, state as { runId?: unknown; specHash?: unknown; keyId?: unknown });
    if (why) {
      console.error('speckl trace report: ' + why);
      return 1;
    }
  }
  if (keyPath) {
    let key: Buffer;
    try {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('bad key');
      key = Buffer.from(hex, 'hex');
    } catch {
      console.error('speckl trace report: state key could not be read');
      return 1;
    }
    const why = checkMacs(read.lines, key);
    if (why) {
      console.error('speckl trace report: ' + why);
      return 1;
    }
  }
  process.stdout.write(formatTraceReport(read.lines));
  return 0;
}
