// Emits state-integrity.mjs — tamper evidence for the agent state file.
//
// Two layers, both checked by hook.mjs and signal.mjs before they act:
//  1. Hash-chained event log. Every state change appends an entry whose
//     hash covers the previous hash; the genesis hash covers run id, spec
//     hash, dev flag, key id and any pinned verifier plug-ins. The machine, the pending call, used nonces and
//     applied evidence are re-derived by replaying the log from init and
//     must match the stored copies.
//  2. HMAC-SHA256 over the whole canonical state with a key the agent
//     cannot read (--key <file> or SPECKL_STATE_KEY_FILE). Required for
//     non-dev states, and whenever a key is configured.

export function emitStateIntegrityMjs(): string {
  return `/**
 * Speckl state integrity (generated). See docs/agent-signals.md, "Tamper-evident state".
 *
 * Key: a file holding 32 random bytes as hex, created by \`signal.mjs init --key <file>\`.
 * Resolve order: --key <file>, then env SPECKL_STATE_KEY_FILE. Deploy the key
 * where the hook and signal tooling can read it and the agent cannot.
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
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex') + '\\n', { mode: 0o600, flag: 'wx' });
  }
  return readKey(keyPath);
}

export const keyIdOf = key => sha(key).slice(0, 16);

export function genesis(state) {
  // Pinned plug-ins (module sha256 + config) are part of the genesis, so the
  // chain breaks if they change. Omitted when there are none (canonical drops
  // undefined), which keeps states without plug-ins unchanged.
  return sha('speckl-state-v1:' + canonical({
    run: state.runId, spec: state.specHash, dev: state.dev === true, keyId: state.keyId || null,
    plugins: state.plugins === undefined ? undefined : sha(canonical(state.plugins)),
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
  const usedNonces = [];
  const appliedEvidence = [];
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
        break;
      }
      default:
        throw new Error('unknown log entry ' + e.kind);
    }
    if (e.evidence !== undefined) appliedEvidence.push(e.evidence);
    if (e.nonce !== undefined) usedNonces.push(e.nonce);
  }
  return { machine: machine.serialize(), pending, usedNonces, appliedEvidence };
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
  return { ok: true, warnings, key };
}
`;
}
