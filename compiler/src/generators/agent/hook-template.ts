// Emits hook.mjs — runtime-agnostic pre/post tool gate.

export function emitHookMjs(speckName: string): string {
  return `#!/usr/bin/env node
/**
 * Speckl agent hook (generic). Generated for ${speckName}.
 *
 *   node hook.mjs pre  --state <file>   # stdin JSON {tool,input,call_id}
 *   node hook.mjs post --state <file>   # stdin JSON {tool,input,call_id,ok}
 *   [--key <file>]  state key (or env SPECKL_STATE_KEY_FILE); keep it unreadable by the agent
 *
 * exit 0 allow · exit 2 deny · exit 1 error (=deny)
 *
 * The hook never records human answers; signal.mjs does, through a verifier.
 * Keep signal.mjs and any signing key out of the agent's reach: the cli
 * verifier (DEV ONLY, state created with init --dev) trusts whoever runs it,
 * so an agent with shell access could approve its own work.
 *
 * A pending call (pre without post) older than the pending timeout is
 * cleared as failed and the state is not advanced.
 *
 * The state file is tamper-evident: every change is appended to a
 * hash-chained log that is replayed and checked on load, and the whole
 * state is HMAC-signed with a key the agent must not be able to read.
 * Any mismatch, a missing signature or a missing key (non-dev) denies.
 *
 * A call-bound sign-off (await \`bind call\`) allows one later call whose
 * digest matches the signed \`call\` hash, and only once that call's post
 * succeeds. Any other call is denied. The hash is sha256 of the canonical
 * spec tool name and mapped arguments (see state-integrity.mjs callDigest).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyState, append, sign, keyPathFrom, callDigest, canonical } from './state-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-config.json'), 'utf-8'));

let lockHeld = null;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

function releaseLock() {
  if (lockHeld) {
    try { fs.unlinkSync(lockHeld); } catch { /* ignore */ }
    lockHeld = null;
  }
}

function respond(decision, reason, code) {
  const body = reason ? { decision, reason } : { decision };
  process.stdout.write(JSON.stringify(body) + '\\n');
  if (decision === 'deny' && reason) process.stderr.write(reason + '\\n');
  releaseLock();
  process.exit(code);
}

function allow() { respond('allow', undefined, 0); }
function deny(reason) { respond('deny', reason, 2); }
function error(reason) { respond('deny', reason, 1); }

function parseArgs(argv) {
  const out = { cmd: '', state: '', key: '' };
  out.cmd = argv[2] || '';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--state') out.state = argv[++i] || '';
    else if (argv[i] === '--key') out.key = argv[++i] || '';
  }
  return out;
}

function lockPath(stateFile) { return stateFile + '.lock'; }

async function acquireLock(stateFile) {
  const lp = lockPath(stateFile);
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.closeSync(fd);
      lockHeld = lp;
      return;
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      // Break a lock left behind by a crashed holder (older than 30s).
      try {
        if (Date.now() - fs.statSync(lp).mtimeMs > 30000) { fs.unlinkSync(lp); continue; }
      } catch { /* raced with release; retry */ }
      if (Date.now() - start > 5000) throw new Error('state lock timeout');
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    throw new Error('state file missing; run: node signal.mjs init --state ' + stateFile);
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

function pendingTimeoutMs() {
  const t = config.pendingTimeout && config.pendingTimeout.durationMs;
  return typeof t === 'number' && t > 0 ? t : 600000;
}

/** 'expired' | 'live' | 'unstamped' for state.pending. */
function pendingStatus(pending, now) {
  const since = Date.parse(pending.since || '');
  if (!Number.isFinite(since)) return 'unstamped';
  return now - since >= pendingTimeoutMs() ? 'expired' : 'live';
}

let stateKey = null;
function save(file, state) {
  sign(state, stateKey);
  atomicWrite(file, JSON.stringify(state, null, 2));
}

function clearPendingAsFailed(state, reason) {
  append(state, { kind: 'expire', call_id: state.pending.call_id });
  state.pendingLog = state.pendingLog || [];
  state.pendingLog.push({
    call_id: state.pending.call_id,
    tool: state.pending.tool,
    since: state.pending.since,
    cleared: reason,
    at: new Date().toISOString(),
  });
  state.pending = null;
}

// Guard text in spec terms: "this.stage === 3" becomes "stage == Approved", plus
// where the machine is now, using the agent block's stage labels.
function describeGuard(reason, machine, cfg) {
  const labels = cfg.stages || {};
  const nameOf = {};
  for (const [name, v] of Object.entries(labels)) nameOf[String(v)] = name;
  const sv = cfg.stageVariable;
  let text = reason.replace(/\\bthis\\.(\\w+)\\s*(===|!==)\\s*(-?\\d+)\\b/g, (m, v, op, n) => {
    const eq = op === '===' ? '==' : '!=';
    return v === sv && nameOf[n] !== undefined ? v + ' ' + eq + ' ' + nameOf[n] : v + ' ' + eq + ' ' + n;
  });
  text = text.replace(/\\bthis\\.(\\w+)/g, '$1').replace(/ === /g, ' == ').replace(/ !== /g, ' != ');
  if (sv && machine && machine[sv] !== undefined) {
    const now = machine[sv];
    text += ' (' + sv + ' is ' + (nameOf[String(now)] !== undefined ? nameOf[String(now)] : String(now)) + ')';
  }
  return text;
}

function currentAwait(machine, cfg) {
  const stage = machine[cfg.stageVariable];
  return cfg.awaits.find(a => a.stateValue === stage) || null;
}

/** Digest of the call the hook will judge. input is already coerced (null/missing → {}). */
function describeCall(tool, input) {
  try {
    return { ok: true, digest: callDigest(tool, input), canonical: canonical({ tool, input }) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function callBoundHint(tool, input) {
  const d = describeCall(tool, input);
  if (!d.ok) return '; call-bound sign-off refused: ' + d.reason;
  return '; call-bound sign-off: sign call ' + d.digest + ' canonical ' + d.canonical;
}

async function loadMachine(state) {
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  if (!Machine) throw new Error('missing export ' + config.machineExport);
  if (!state.machine) return { Machine, machine: new Machine() };
  return { Machine, machine: Machine.restore(state.machine) };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.cmd !== 'pre' && args.cmd !== 'post') {
    error('usage: hook.mjs pre|post --state <file>');
  }
  if (!args.state) error('missing --state');

  let raw;
  try { raw = await readStdin(); }
  catch (e) { error('stdin read failed: ' + e.message); }
  let msg;
  try { msg = JSON.parse(raw || '{}'); }
  catch { error('stdin is not JSON'); }

  try {
    await acquireLock(args.state);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
  }

  try {
    const state = loadState(args.state);
    if (state.specHash !== config.specHash) {
      deny('specHash mismatch: state is stale relative to compiled spec');
    }
    const { Machine, machine } = await loadMachine(state);
    const v = verifyState(state, { keyPath: keyPathFrom(args.key), Machine, config });
    if (!v.ok) deny('state integrity: ' + v.reason);
    for (const w of v.warnings) process.stderr.write('WARN: ' + w + '\\n');
    stateKey = v.key;
    const toolByName = new Map(config.tools.map(t => [t.name, t]));

    if (args.cmd === 'pre') {
      const tool = msg.tool;
      const input = msg.input || {};
      const callId = msg.call_id;
      if (!tool || callId === undefined || callId === null || callId === '') {
        deny('pre: tool and call_id are required');
      }
      const binding = toolByName.get(tool);
      if (!binding) deny('unknown tool: ' + tool);
      if (state.pending) {
        const st = pendingStatus(state.pending, Date.now());
        if (st === 'expired') {
          // The earlier call never posted (crash/hang): clear it as failed
          // without advancing, persist that, then judge this call fresh.
          clearPendingAsFailed(state, 'timeout');
          save(args.state, state);
        } else {
          if (st === 'unstamped') {
            // Pending from an older state file: start its clock now.
            state.pending.since = new Date().toISOString();
            save(args.state, state);
          }
          deny('another tool call is already pending (' + state.pending.call_id + '); it clears as failed after '
            + (config.pendingTimeout ? config.pendingTimeout.durationText : '10m') + ' or via signal.mjs clear-pending');
        }
      }

      const waiting = currentAwait(machine, config);
      if (waiting) {
        const suffix = (waiting.bindCall || []).length > 0 ? callBoundHint(tool, input) : '';
        if (waiting.mode === 'in') {
          deny('HITL: no tools while awaiting signal ' + waiting.signal + suffix);
        }
        if (binding.effect === 'act') {
          deny('HNTL: act tool refused while awaiting signal ' + waiting.signal + suffix);
        }
      }

      // Outstanding call-bound sign-off: only the matching call may proceed.
      // A mismatch is denied and the approval is kept. It is consumed on post ok.
      if (state.boundCall != null) {
        if (typeof state.boundCall.hash !== 'string') deny('call-bound sign-off is malformed');
        const d = describeCall(tool, input);
        if (!d.ok) deny('call-bound sign-off refused: ' + d.reason);
        if (d.digest !== state.boundCall.hash) {
          deny('call-bound sign-off does not cover this call (denied): want ' + state.boundCall.hash
            + ' got ' + d.digest + ' canonical ' + d.canonical);
        }
      }

      const can = machine.can(binding.action, input);
      if (can !== true) deny('can() refused: ' + describeGuard(String(can), machine, config));

      append(state, { kind: 'pre', call_id: callId, tool, action: binding.action, input });
      state.pending = { call_id: callId, tool, action: binding.action, input, since: new Date().toISOString() };
      state.machine = machine.serialize();
      save(args.state, state);
      allow();
    }

    // post
    const tool = msg.tool;
    const callId = msg.call_id;
    const ok = msg.ok === true;
    if (!tool || callId === undefined || callId === null || callId === '') {
      deny('post: tool and call_id are required');
    }
    if (!state.pending || state.pending.call_id !== callId) {
      deny('post: no matching pending call_id');
    }
    if (state.pending.tool !== tool) {
      deny('post: tool does not match pending');
    }
    if (pendingStatus(state.pending, Date.now()) === 'expired') {
      clearPendingAsFailed(state, 'timeout');
      save(args.state, state);
      deny('post: pending call expired; cleared as failed (state not advanced)');
    }

    if (!ok) {
      append(state, { kind: 'post', call_id: callId, ok: false });
      state.pending = null;
      state.machine = machine.serialize();
      save(args.state, state);
      allow();
      return;
    }

    const binding = toolByName.get(tool);
    if (!binding) deny('unknown tool: ' + tool);
    if (state.boundCall != null) {
      if (typeof state.boundCall.hash !== 'string') deny('call-bound sign-off is malformed');
      // Only the matching call consumes the approval. A different pending
      // call was allowed before the sign-off (observe, while waiting) and
      // must be able to finish; the binding stays for the approved call.
      let digest = null;
      try { digest = callDigest(state.pending.tool, state.pending.input); } catch { digest = null; }
      if (digest === state.boundCall.hash) state.boundCall = null;
    }
    const params = (machine.constructor.ACTIONS || {})[binding.action] || [];
    const argsList = params.map(p => (state.pending.input || {})[p]);
    machine[binding.action](...argsList);
    append(state, { kind: 'post', call_id: callId, ok: true });
    state.pending = null;
    const waitingAfter = currentAwait(machine, config);
    state.awaitingSince = waitingAfter ? (state.awaitingSince || new Date().toISOString()) : null;
    state.machine = machine.serialize();
    save(args.state, state);
    allow();
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
  }
}

main();
`;
}
