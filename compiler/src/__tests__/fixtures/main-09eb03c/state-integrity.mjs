/**
 * Speckl state integrity (generated). See docs/agent-signals.md, "Tamper-evident state".
 *
 * Key: a file holding 32 random bytes as hex, created by `signal.mjs init --key <file>`.
 * Resolve order: --key <file>, then env SPECKL_STATE_KEY_FILE. Deploy the key
 * where the hook and signal tooling can read it and the agent cannot.
 *
 * Decision record: <state>.decisions/log.jsonl is a second hash chain, HMAC'd
 * with the same key, holding every hook allow and deny. It is not replayed
 * into the machine. signal.mjs verify walks the whole chain.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/**
 * sha256 of the canonical spec call the hook will see: spec tool name plus
 * the mapped arguments object. Object keys are sorted at every depth, array
 * order is kept, and nothing is truncated. Harnesses differ only in how they
 * map onto this object; the digest is of the mapped call.
 */
export function callDigest(tool, input) {
  if (typeof tool !== 'string' || tool.length === 0) throw new Error('call digest needs a tool name');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('call digest needs an arguments object');
  }
  return sha(canonical({ tool, input }));
}

export function keyPathFrom(argKey) {
  if (typeof argKey === 'string' && argKey) return argKey;
  const env = process.env.SPECKL_STATE_KEY_FILE;
  return env ? env : null;
}

export function readKey(keyPath) {
  if (!keyPath) return null;
  if (!fs.existsSync(keyPath)) throw new Error('state key not found: ' + keyPath);
  const text = fs.readFileSync(keyPath, 'utf-8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error('state key must be 32 bytes as 64 hex chars: ' + keyPath);
  return Buffer.from(text, 'hex');
}

/** Create a key file (0600) if missing; return the key. */
export function ensureKey(keyPath) {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(path.resolve(keyPath)), { recursive: true });
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  }
  return readKey(keyPath);
}

export const keyIdOf = key => sha(key).slice(0, 16);

export function genesis(state) {
  // initialSigners is hashed in when the field exists, so editing the set
  // the run started with breaks the chain. Omitted when absent (canonical
  // drops undefined): states created before signer pinning keep this genesis.
  // The current set is not hashed here. A rotation is a log entry, replayed
  // below, the same way the machine is.
  return sha('speckl-state-v1:' + canonical({
    run: state.runId, spec: state.specHash, dev: state.dev === true, keyId: state.keyId || null,
    initialSigners: state.initialSigners === undefined ? undefined : sha(canonical(state.initialSigners)),
  }));
}

/** Append a hash-chained entry and move the head. */
export function append(state, entry) {
  const prev = state.head || genesis(state);
  const seq = state.log.length;
  const body = { ...entry, seq, prev };
  const hash = sha(canonical(body));
  state.log.push({ ...body, hash });
  state.head = hash;
}

export function mac(state, key) {
  const { mac: _m, ...rest } = state;
  return crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
}

export function sign(state, key) {
  if (key) state.mac = mac(state, key);
  else delete state.mac;
  return state;
}

/** Replay the log from a fresh machine; returns the derived fields. */
function derive(state, Machine, config) {
  const machine = new Machine();
  let pending = null;
  let boundCall = null;
  const usedNonces = [];
  const appliedEvidence = [];
  // Undefined means a legacy state (no pin). An array, possibly empty, is
  // the set recorded at init, then replaced by each `signers` entry.
  let signers = state.initialSigners === undefined ? undefined : state.initialSigners.map(s => ({ name: s.name, key: s.key }));
  const toolByName = new Map(config.tools.map(t => [t.name, t]));
  const signalAction = (signal, outcome) => {
    for (const a of config.awaits) if (a.signal === signal) {
      const on = a.on.find(o => o.outcome === outcome);
      if (on) return on.action;
    }
    return null;
  };
  for (const e of state.log) {
    switch (e.kind) {
      case 'pre':
        if (pending) throw new Error('pre while pending');
        pending = { call_id: e.call_id, tool: e.tool, action: e.action, input: e.input };
        break;
      case 'post': {
        if (!pending || pending.call_id !== e.call_id) throw new Error('post without pending');
        if (e.ok) {
          // Consumed only by the successful post of the matching call. A
          // different post is an in-flight call from before the sign-off
          // (an observe tool, in near mode); it does not consume the binding.
          if (boundCall) {
            let digest = null;
            try { digest = callDigest(pending.tool, pending.input); } catch { digest = null; }
            if (digest === boundCall.hash) boundCall = null;
          }
          const b = toolByName.get(pending.tool);
          if (!b || b.action !== pending.action) throw new Error('unknown tool in log');
          const params = (Machine.ACTIONS || {})[b.action] || [];
          machine[b.action](...params.map(p => (pending.input || {})[p]));
        }
        pending = null;
        break;
      }
      case 'expire':
      case 'clear':
        if (!pending || pending.call_id !== e.call_id) throw new Error(e.kind + ' without pending');
        pending = null;
        break;
      case 'signal':
      case 'timeout': {
        const act = signalAction(e.signal, e.outcome);
        if (!act) throw new Error('unknown signal outcome in log');
        machine[act]();
        if (e.kind === 'timeout' || e.call === undefined) {
          boundCall = null;
        } else if (typeof e.call === 'string' && /^[0-9a-f]{64}$/.test(e.call)) {
          boundCall = { hash: e.call };
        } else {
          throw new Error('signal call hash is not 64 hex chars');
        }
        break;
      }
      case 'signers': {
        if (!Array.isArray(e.signers)) throw new Error('signers entry missing set');
        const next = [];
        for (const s of e.signers) {
          if (!s || typeof s.name !== 'string' || typeof s.key !== 'string') throw new Error('signers entry is malformed');
          next.push({ name: s.name, key: s.key });
        }
        signers = next;
        break;
      }
      default:
        throw new Error('unknown log entry ' + e.kind);
    }
    if (e.evidence !== undefined) appliedEvidence.push(e.evidence);
    if (e.nonce !== undefined) usedNonces.push(e.nonce);
  }
  return { machine: machine.serialize(), pending, usedNonces, appliedEvidence, signers, boundCall };
}

/**
 * Verify a loaded state. Returns { ok: true, warnings } or { ok: false, reason }.
 * keyPath may be null; a configured key always makes the MAC mandatory.
 */
export function verifyState(state, { keyPath, Machine, config }) {
  const warnings = [];
  if (!state || typeof state !== 'object') return { ok: false, reason: 'state is not an object' };
  if (!Array.isArray(state.log) || typeof state.runId !== 'string') {
    return { ok: false, reason: 'state file predates tamper-evident state (no log/run id); re-create it with: node signal.mjs init --state <file> --key <keyfile>' };
  }
  let key = null;
  try { key = readKey(keyPath); } catch (e) { return { ok: false, reason: e.message }; }
  const dev = state.dev === true;
  if (!key) {
    if (!dev) return { ok: false, reason: 'missing state key: pass --key <file> or set SPECKL_STATE_KEY_FILE (non-dev states are signed)' };
    warnings.push('DEV state: no state key configured; MAC not checked (hand edits are only caught by the log chain)');
  } else {
    if (typeof state.mac !== 'string') {
      return { ok: false, reason: dev ? 'state signature missing (a key is configured, so the state must be signed)' : 'state signature missing' };
    }
    if (state.keyId && state.keyId !== keyIdOf(key)) return { ok: false, reason: 'state was signed with a different key' };
    const want = mac(state, key);
    const a = Buffer.from(want, 'hex');
    const b = Buffer.from(state.mac, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'state signature mismatch (state.json was modified outside the hook/signal tooling)' };
  }
  // Chain links.
  let prev = genesis(state);
  for (let i = 0; i < state.log.length; i++) {
    const { hash, ...body } = state.log[i];
    if (body.seq !== i || body.prev !== prev || sha(canonical(body)) !== hash) {
      return { ok: false, reason: 'log chain broken at entry ' + i };
    }
    prev = hash;
  }
  if ((state.head || genesis(state)) !== prev) return { ok: false, reason: 'log chain head mismatch (log truncated or extended)' };
  // Derived fields.
  let d;
  try { d = derive(state, Machine, config); } catch (e) { return { ok: false, reason: 'log replay failed: ' + e.message }; }
  if (canonical(d.machine) !== canonical(state.machine)) return { ok: false, reason: 'machine state does not match the log' };
  const p = state.pending ? { call_id: state.pending.call_id, tool: state.pending.tool, action: state.pending.action, input: state.pending.input } : null;
  if (canonical(d.pending) !== canonical(p)) return { ok: false, reason: 'pending call does not match the log' };
  if (canonical(d.usedNonces) !== canonical(state.usedNonces || [])) return { ok: false, reason: 'used nonces do not match the log' };
  if (canonical(d.appliedEvidence) !== canonical(state.appliedEvidence || [])) return { ok: false, reason: 'applied evidence does not match the log' };
  if (canonical(d.signers) !== canonical(state.signers)) return { ok: false, reason: 'pinned signers do not match the log' };
  // Absent on state files written before call-bound sign-offs: that is unbound.
  const storedBound = state.boundCall == null ? null : state.boundCall;
  if (canonical(d.boundCall) !== canonical(storedBound)) return { ok: false, reason: 'bound call does not match the log' };
  return { ok: true, warnings, key };
}

// --- Decision record -------------------------------------------------------
// A separate append-only chain for hook verdicts (allow and deny). It never
// shares state.log, so a denial cannot advance the machine or tear state.json.
// The open log is fully rechecked on every hook call while it is at most
// DECISION_FULL_CHECK_BYTES. Past that, the hook checks the keyed head and
// the tail (so a flood cannot make every call re-read the whole history);
// signal.mjs verify, and every signal.mjs state change, always walks it all.

const DECISION_FULL_CHECK_BYTES = 262144;
const DECISION_TAIL_BYTES = 65536;
const DECISION_REASON_MAX = 500;

export function decisionGenesis(state) {
  // The current signer set is intentionally absent. A rotate-signers entry
  // changes state.signers and is replayed by verifyState; hashing it here
  // would break this chain on a legitimate rotation. initialSigners stays in
  // the state genesis (above), omitted when the field is absent so a legacy
  // state keeps its previous genesis. A decision record created beside that
  // state stays valid: this hash is the run, the spec and the key id only.
  return sha('speckl-decision-v1:' + canonical({
    run: state.runId, spec: state.specHash, keyId: state.keyId || null,
  }));
}

export function decisionPaths(stateFile) {
  const dir = stateFile + '.decisions';
  return { dir, head: path.join(dir, 'head.json'), log: path.join(dir, 'log.jsonl') };
}

function freshDecisionHead(state) {
  const genesis = decisionGenesis(state);
  return {
    v: 1,
    runId: state.runId,
    specHash: state.specHash,
    keyId: state.keyId || null,
    genesis,
    seq: -1,
    hash: genesis,
  };
}

function decisionHeadMac(head, key) {
  const { mac: _m, ...rest } = head;
  return crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
}

function macEqual(have, want) {
  if (typeof have !== 'string' || typeof want !== 'string') return false;
  if (!/^[0-9a-fA-F]{64}$/.test(have) || !/^[0-9a-fA-F]{64}$/.test(want)) return false;
  const a = Buffer.from(want, 'hex');
  const b = Buffer.from(have, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function atomicWriteFile(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function clipReason(reason) {
  if (reason == null) return null;
  const s = String(reason);
  return s.length > DECISION_REASON_MAX ? s.slice(0, DECISION_REASON_MAX) : s;
}

/** sha256 of the canonical input. The decision line stores this, not the input. */
export function digestInput(input) {
  return sha(canonical(input === undefined ? null : input));
}

function assertDecisionIdentity(head, state) {
  if (!head || head.v !== 1) throw new Error('decision head is not version 1');
  if (head.runId !== state.runId || head.specHash !== state.specHash || (head.keyId || null) !== (state.keyId || null)) {
    throw new Error('decision record belongs to a different state');
  }
  if (head.genesis !== decisionGenesis(state)) throw new Error('decision genesis mismatch');
  if (typeof head.seq !== 'number' || !Number.isInteger(head.seq) || typeof head.hash !== 'string') {
    throw new Error('decision head is missing seq or hash');
  }
}

function assertDecisionHeadMac(head, key) {
  if (key) {
    if (typeof head.mac !== 'string') throw new Error('decision head signature missing');
    if (!macEqual(head.mac, decisionHeadMac(head, key))) throw new Error('decision head signature mismatch');
  } else if (head.mac !== undefined) {
    throw new Error('decision head is signed but no state key is configured');
  }
}

function loadDecisionHead(paths, state, key) {
  const dirExists = fs.existsSync(paths.dir);
  const headExists = dirExists && fs.existsSync(paths.head);
  const logExists = dirExists && fs.existsSync(paths.log);
  if (!headExists && !logExists) {
    // A leftover head tmp from a crashed rename is not a record. Anything else
    // in the directory without a head or a log is not a chain we can extend.
    if (dirExists && fs.readdirSync(paths.dir).some(n => !n.includes('.tmp.'))) {
      throw new Error('decision head missing');
    }
    return { head: freshDecisionHead(state), buf: Buffer.alloc(0) };
  }
  if (!headExists) {
    // Append landed and the process died before the head was replaced.
    // The lines are an uncommitted suffix of a fresh chain; the next append
    // adopts them if they verify, and refuses them if they do not.
    return { head: freshDecisionHead(state), buf: fs.readFileSync(paths.log) };
  }
  let head;
  try { head = JSON.parse(fs.readFileSync(paths.head, 'utf-8')); }
  catch { throw new Error('decision head is not JSON'); }
  assertDecisionIdentity(head, state);
  assertDecisionHeadMac(head, key);
  return { head, buf: logExists ? fs.readFileSync(paths.log) : Buffer.alloc(0) };
}

/** Split a decision log. A final line without a newline is an uncommitted tear. */
function parseDecisionLog(buf) {
  if (buf.length === 0) return { lines: [], torn: false };
  const ends = buf[buf.length - 1] === 0x0a;
  const text = (ends ? buf : buf.subarray(0, buf.lastIndexOf(0x0a) + 1)).toString('utf-8');
  if (text === '') return { lines: [], torn: !ends };
  const parts = text.slice(0, -1).split('\n');
  const lines = [];
  for (const p of parts) {
    if (p === '') throw new Error('blank line in decision record');
    try { lines.push(JSON.parse(p)); }
    catch { throw new Error('decision record line is not JSON'); }
  }
  return { lines, torn: !ends };
}

function decisionLineError(line, seq, prev, key) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return 'not an object';
  const body = {};
  for (const k of Object.keys(line)) {
    if (k !== 'hash' && k !== 'mac') body[k] = line[k];
  }
  if (body.seq !== seq) return 'seq';
  if (body.prev !== prev) return 'prev';
  if (sha(canonical(body)) !== line.hash) return 'hash';
  if (key) {
    const want = crypto.createHmac('sha256', key).update(String(line.hash)).digest('hex');
    if (!macEqual(line.mac, want)) return 'mac';
  } else if (line.mac !== undefined) return 'unexpected mac';
  if (body.verdict !== 'allow' && body.verdict !== 'deny') return 'verdict';
  if (body.verdict === 'allow' && body.reason !== null) return 'reason';
  return null;
}

function walkDecisionLines(lines, genesis, key) {
  let prev = genesis;
  for (let i = 0; i < lines.length; i++) {
    const err = decisionLineError(lines[i], i, prev, key);
    if (err) throw new Error('decision chain broken at seq ' + i + ' (' + err + ')');
    prev = lines[i].hash;
  }
  return prev;
}

function tailDecisionLines(buf) {
  if (buf.length <= DECISION_TAIL_BYTES) return parseDecisionLog(buf);
  let start = buf.length - DECISION_TAIL_BYTES;
  const nl = buf.indexOf(0x0a, start);
  if (nl === -1 || nl === buf.length - 1) return null;
  return parseDecisionLog(buf.subarray(nl + 1));
}

function judgeDecisionLines(head, lines, key) {
  const end = walkDecisionLines(lines, head.genesis, key);
  if (lines.length === 0) {
    if (head.seq !== -1) throw new Error('decision record truncated');
    if (head.hash !== head.genesis) throw new Error('decision head hash mismatch');
    return { uncommitted: 0, adoptSeq: -1, adoptHash: head.genesis };
  }
  if (head.seq < -1 || head.seq >= lines.length) throw new Error('decision record truncated');
  if (head.seq === -1) {
    if (head.hash !== head.genesis) throw new Error('decision head hash mismatch');
    return { uncommitted: lines.length, adoptSeq: lines.length - 1, adoptHash: end };
  }
  if (lines[head.seq].hash !== head.hash) throw new Error('decision head hash mismatch');
  return { uncommitted: lines.length - 1 - head.seq, adoptSeq: lines.length - 1, adoptHash: end };
}

/**
 * Read the decision record. full=true always walks every line. Otherwise the
 * whole chain is walked while the log is within DECISION_FULL_CHECK_BYTES,
 * and only the tail after that.
 * Returns { head, uncommitted, adoptSeq, adoptHash, torn }. Throws on tamper.
 */
function evaluateDecisions(stateFile, key, state, full) {
  const paths = decisionPaths(stateFile);
  const loaded = loadDecisionHead(paths, state, key);
  const whole = parseDecisionLog(loaded.buf);
  const useFull = full || loaded.buf.length <= DECISION_FULL_CHECK_BYTES;
  if (useFull) {
    const judged = judgeDecisionLines(loaded.head, whole.lines, key);
    return { paths, head: loaded.head, torn: whole.torn, ...judged };
  }
  const tail = tailDecisionLines(loaded.buf);
  if (!tail || loaded.head.seq === -1) {
    const judged = judgeDecisionLines(loaded.head, whole.lines, key);
    return { paths, head: loaded.head, torn: whole.torn, ...judged };
  }
  // Prefix before the window is not re-read. The window itself is chained,
  // and the committed head line must sit inside it. If it does not (a torn
  // suffix longer than the window, or a truncated file), fall back to a full
  // walk so a valid suffix is adopted and a real break still denies.
  const fallback = () => {
    const judged = judgeDecisionLines(loaded.head, whole.lines, key);
    return { paths, head: loaded.head, torn: whole.torn, ...judged };
  };
  if (tail.lines.length === 0) return fallback();
  let prev = tail.lines[0].prev;
  for (let j = 0; j < tail.lines.length; j++) {
    const expect = tail.lines[0].seq + j;
    const err = decisionLineError(tail.lines[j], expect, prev, key);
    if (err) throw new Error('decision chain broken at seq ' + expect + ' (' + err + ')');
    prev = tail.lines[j].hash;
  }
  const idx = tail.lines.findIndex(l => l.seq === loaded.head.seq);
  if (idx === -1) return fallback();
  if (tail.lines[idx].hash !== loaded.head.hash) throw new Error('decision head hash mismatch');
  const last = tail.lines[tail.lines.length - 1];
  return {
    paths,
    head: loaded.head,
    torn: tail.torn,
    uncommitted: tail.lines.length - 1 - idx,
    adoptSeq: last.seq,
    adoptHash: last.hash,
  };
}

export function verifyDecisions(stateFile, key, state, opts) {
  try {
    const ev = evaluateDecisions(stateFile, key, state, !!(opts && opts.full));
    return {
      ok: true,
      count: ev.head.seq + 1,
      head: ev.head.hash,
      uncommitted: ev.uncommitted,
      genesis: ev.head.genesis,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function writeDecisionHead(file, head, key) {
  const out = {
    v: head.v,
    runId: head.runId,
    specHash: head.specHash,
    keyId: head.keyId,
    genesis: head.genesis,
    seq: head.seq,
    hash: head.hash,
  };
  if (key) out.mac = decisionHeadMac(out, key);
  atomicWriteFile(file, JSON.stringify(out) + '\n');
}

/**
 * Append one verdict. Caller holds the state lock. Throws if the chain is
 * untrustworthy or the write fails; does not touch state.json.
 */
export function appendDecision(stateFile, key, state, fields) {
  if (!state || (state.dev !== true && !key)) throw new Error('refusing to record a decision without a state key');
  if (fields.verdict !== 'allow' && fields.verdict !== 'deny') throw new Error('bad verdict');
  const ev = evaluateDecisions(stateFile, key, state, false);
  fs.mkdirSync(ev.paths.dir, { recursive: true });
  if (!fs.existsSync(ev.paths.log)) fs.writeFileSync(ev.paths.log, '');
  if (ev.torn) {
    const buf = fs.readFileSync(ev.paths.log);
    fs.truncateSync(ev.paths.log, buf.lastIndexOf(0x0a) + 1);
  }
  const head = ev.head;
  if (ev.uncommitted > 0) {
    head.seq = ev.adoptSeq;
    head.hash = ev.adoptHash;
  }
  const body = {
    seq: head.seq + 1,
    prev: head.hash,
    ts: new Date().toISOString(),
    phase: fields.phase === 'post' ? 'post' : 'pre',
    tool: fields.tool == null ? null : String(fields.tool),
    call_id: fields.call_id == null ? null : String(fields.call_id),
    action: fields.action == null ? null : String(fields.action),
    verdict: fields.verdict,
    reason: fields.verdict === 'deny' ? clipReason(fields.reason) : null,
    input_sha256: typeof fields.input_sha256 === 'string' ? fields.input_sha256 : digestInput(null),
  };
  const hash = sha(canonical(body));
  const line = { ...body, hash };
  if (key) line.mac = crypto.createHmac('sha256', key).update(hash).digest('hex');
  fs.appendFileSync(ev.paths.log, JSON.stringify(line) + '\n');
  const fd = fs.openSync(ev.paths.log, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  head.seq = body.seq;
  head.hash = hash;
  writeDecisionHead(ev.paths.head, head, key);
  return line;
}
