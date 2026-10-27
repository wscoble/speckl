// Offline completion-signal report.
//
// `speckl trace report` reads a decision log and prints, per priority,
// drain latency, completion-signal lag, and queue depth. Drain and KPI
// lines count only an allow post that matched an allow pre. It does not
// run the hook and it does not enforce a queue. Durations are a throughput
// signal, not a risk signal.
//
// The hash chain of the bytes read is checked. With --state, head.json is
// required whenever <state>.decisions/ exists. A shortened or deleted log
// fails when that head is still there. --log does not know the head. The
// HMAC is checked only when a key is passed and the log has a line, and
// the report says so. An empty log prints "macs not checked". That HMAC
// is a shared-key seal. It proves nothing to an outside auditor. An older
// log and its matching head from the same run still verify: there is no
// anchor outside this directory.

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

/** An allow completion whose call_id matches an earlier allow pre. */
function matchedAllowPrime(lines: TraceLine[], line: TraceLine): boolean {
  if (!isPrime(line) || line.verdict !== 'allow' || line.call_id == null) return false;
  return lines.some(p =>
    p.phase === 'pre' && p.verdict === 'allow' && p.call_id === line.call_id && p.seq < line.seq,
  );
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
  const primes = lines.filter(l =>
    matchedAllowPrime(lines, l) && priorityOf(l) === priority
    && typeof l.trace_id === 'string' && typeof l.branch_id === 'string',
  );
  const traces = [...new Set(primes.map(l => l.trace_id as string))].sort((a, b) => a.localeCompare(b));
  const out: string[] = [];
  for (const traceId of traces) {
    // Deny lines are not parents and cannot flip the flag or set ingress.
    const counted = lines.filter(l =>
      l.trace_id === traceId && (
        (l.phase === 'pre' && l.verdict === 'allow') || matchedAllowPrime(lines, l)
      ),
    );
    const leaves = primes.filter(l => l.trace_id === traceId && !counted.some(g => g.parent_branch_id === l.branch_id));
    if (leaves.length === 0) continue;
    let last = leaves[0];
    for (const leaf of leaves.slice(1)) {
      const a = epoch(leaf.ts);
      const b = epoch(last.ts);
      if (a === null) continue;
      if (b === null || a > b || (a === b && leaf.seq > last.seq)) last = leaf;
    }
    const pres = counted.filter(l => l.phase === 'pre' && l.verdict === 'allow');
    const ingress = earliest(pres);
    const flagged = counted.some(l => l.trace_flagged === true) ? 'true' : 'false';
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
    // A deny must not consume an allow pre, and it is not a measured lag.
    if (line.verdict !== 'allow') {
      out.push('  call ' + call + ' unmatched');
      continue;
    }
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
    if (isPrime(line) && line.verdict === 'allow') {
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
 * Per priority: drain latency (ingress to the last matched allow leaf),
 * completion-signal lag (allow pre to an allow prime), and queue depth
 * after each allow pre that no allow prime has closed. KPI lines are those
 * same matched allow posts, and each line shows the verdict. A deny post
 * is not a drain leaf and is not a KPI line. A priority of null is printed
 * as `(none)`. The second line says whether HMAC macs were checked.
 */
export function formatTraceReport(lines: TraceLine[], macsChecked = false): string {
  const priorities = new Set<string>();
  for (const line of lines) {
    if (typeof line.trace_id === 'string' || line.signal === 'prime') priorities.add(priorityOf(line));
  }
  const out: string[] = ['speckl trace report', macsChecked ? 'macs checked' : 'macs not checked'];
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
    if (!matchedAllowPrime(lines, line) || !Array.isArray(line.kpis)) continue;
    for (const k of line.kpis) if (typeof k === 'string' && k) kpis.add(k);
  }
  const kpiNames = [...kpis].sort((a, b) => a.localeCompare(b));
  if (kpiNames.length === 0) out.push('kpi', '  none');
  for (const name of kpiNames) {
    out.push('kpi ' + name);
    for (const line of lines) {
      if (!matchedAllowPrime(lines, line) || !Array.isArray(line.kpis) || !line.kpis.includes(name)) continue;
      out.push(
        '  trace ' + (typeof line.trace_id === 'string' ? line.trace_id : '')
        + ' call ' + (line.call_id == null ? '' : String(line.call_id))
        + ' branch ' + (typeof line.branch_id === 'string' ? line.branch_id : '')
        + ' ok ' + (line.ok === true ? 'true' : 'false')
        + ' priority ' + priorityOf(line)
        + ' flagged ' + (line.trace_flagged === true ? 'true' : 'false')
        + ' verdict ' + line.verdict,
      );
    }
  }
  return out.join('\n') + '\n';
}

function macEqual(have: string, want: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(have) || !/^[0-9a-fA-F]{64}$/.test(want)) return false;
  const a = Buffer.from(want, 'hex');
  const b = Buffer.from(have, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Compare the log to a decision head, the same seq and hash rules as
 * `judgeDecisionLines`. The head mac is checked only when `key` is passed.
 * A log longer than the head is an uncommitted suffix and is accepted.
 */
export function checkDecisionHead(
  lines: TraceLine[],
  head: Record<string, unknown>,
  state: { runId?: unknown; specHash?: unknown; keyId?: unknown },
  key?: Buffer,
): string | null {
  if (!head || head.v !== 1) return 'decision head is not version 1';
  if (head.runId !== state.runId || head.specHash !== state.specHash || (head.keyId || null) !== (state.keyId || null)) {
    return 'decision record belongs to a different state';
  }
  const genesis = decisionGenesis(state);
  if (head.genesis !== genesis) return 'decision genesis mismatch';
  if (typeof head.seq !== 'number' || !Number.isInteger(head.seq) || typeof head.hash !== 'string') {
    return 'decision head is missing seq or hash';
  }
  if (key) {
    if (typeof head.mac !== 'string') return 'decision head signature missing';
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(head)) {
      if (k !== 'mac') rest[k] = head[k];
    }
    const want = crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
    if (!macEqual(String(head.mac), want)) return 'decision head signature mismatch';
  }
  if (lines.length === 0) {
    if (head.seq !== -1) return 'decision record truncated';
    if (head.hash !== genesis) return 'decision head hash mismatch';
    return null;
  }
  if (head.seq < -1 || head.seq >= lines.length) return 'decision record truncated';
  if (head.seq === -1) {
    if (head.hash !== genesis) return 'decision head hash mismatch';
    return null;
  }
  if (lines[head.seq].hash !== head.hash) return 'decision head hash mismatch';
  return null;
}

export const TRACE_USAGE = [
  'usage: speckl trace report (--log <file> | --state <file>) [--key <file>]',
  '',
  'Read a decision log offline. For each priority print drain latency',
  '(ingress to the last leaf allow completion), completion-signal lag',
  '(allow pre to allow post), and queue depth (an allow pre of that',
  'priority that no allow post has closed). A KPI line is an allow post',
  'that matched an allow pre and whose straight-line emits carry',
  'kpi "<name>". Each KPI line shows the verdict. A deny post is not a',
  'drain leaf and is not a KPI line.',
  '',
  '--log <file>     decision log (log.jsonl). Does not read a decision head.',
  '--state <file>   state.json; the log is <file>.decisions/log.jsonl and',
  '                 the head, when present, is <file>.decisions/head.json',
  '--key <file>     check HMAC-SHA256 macs on each line, and on the head',
  '                 when --state is used',
  '',
  'The hash chain of the bytes read is always checked. A line with no',
  'trailing newline is torn and fails. With --state, if head.json exists',
  'it is checked for seq and hash (and its mac with --key). A log shorter',
  'than that head, or a missing log when the head is not empty, fails.',
  'A log longer than the head is an uncommitted suffix and is accepted.',
  'If <state>.decisions/ exists and head.json does not, the report fails.',
  'If that directory is absent, there is no record. --log cannot see a',
  'head, so a shortened prefix that still hashes can pass.',
  '',
  'The report prints "macs checked" only when --key was passed and at',
  'least one line was MAC-verified. Otherwise it prints "macs not checked",',
  'including an empty log. A chain rebuilt without the key can have a',
  'valid hash. That is not a verified seal. Replacing the log and head',
  'with an older pair from the same run is accepted: there is no anchor',
  'outside this directory. The HMAC is a shared-key seal.',
  'It proves nothing to an outside auditor: anyone who can read the key',
  'can forge a line, and someone without the key cannot check the mac.',
  '',
  'This command does not run the agent and does not enforce a queue.',
  'The durations are a throughput signal, not a risk signal.',
  'A missing --log file is an error. Exit 0 prints the report. Exit 1 is',
  'a bad log, a bad chain, or a head that does not match.',
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
  let stateObj: { runId?: unknown; specHash?: unknown; keyId?: unknown } | null = null;
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
    stateObj = state as { runId?: unknown; specHash?: unknown; keyId?: unknown };
    const why = checkGenesis(read.lines, stateObj);
    if (why) {
      console.error('speckl trace report: ' + why);
      return 1;
    }
  }
  let key: Buffer | undefined;
  if (keyPath) {
    try {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('bad key');
      key = Buffer.from(hex, 'hex');
    } catch {
      console.error('speckl trace report: state key could not be read');
      return 1;
    }
  }
  if (stateObj) {
    const dirPath = statePath + '.decisions';
    const headPath = dirPath + '/head.json';
    const dirExists = fs.existsSync(dirPath);
    const headExists = fs.existsSync(headPath);
    if (dirExists && !headExists) {
      console.error('speckl trace report: decision head missing');
      return 1;
    }
    if (headExists) {
      let headRaw: string;
      try { headRaw = fs.readFileSync(headPath, 'utf8'); }
      catch {
        console.error('speckl trace report: decision head could not be read');
        return 1;
      }
      let head: unknown;
      try { head = JSON.parse(headRaw); }
      catch {
        console.error('speckl trace report: decision head is not JSON');
        return 1;
      }
      if (!head || typeof head !== 'object' || Array.isArray(head)) {
        console.error('speckl trace report: decision head is not version 1');
        return 1;
      }
      const why = checkDecisionHead(read.lines, head as Record<string, unknown>, stateObj, key);
      if (why) {
        console.error('speckl trace report: ' + why);
        return 1;
      }
    }
  }
  if (key) {
    const why = checkMacs(read.lines, key);
    if (why) {
      console.error('speckl trace report: ' + why);
      return 1;
    }
  }
  const macsChecked = key !== undefined && read.lines.length > 0;
  process.stdout.write(formatTraceReport(read.lines, macsChecked));
  return 0;
}
