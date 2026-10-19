// Emits signal.mjs — init state + apply verified signals.

export function emitSignalMjs(speckName: string): string {
  return `#!/usr/bin/env node
/**
 * Speckl signal tooling for ${speckName}.
 *
 *   node signal.mjs init  --state <file> --key <keyfile> [--dev]   (key created if missing)
 *   All commands accept --key <keyfile> (or env SPECKL_STATE_KEY_FILE).
 *   node signal.mjs apply --state <file> --verifier file-drop|cli [verifier args...]
 *   node signal.mjs timeout --state <file>   # fire timeout → !-marked reject only
 *   node signal.mjs clear-pending --state <file> --verifier file-drop|cli [args...]
 *
 * This is the human channel; the agent must not be able to run it. The cli
 * verifier (and unsigned drops) trust whoever runs them, so they are refused
 * unless the state was created with --dev (DEV ONLY: self-approval risk).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyState, append, sign, keyPathFrom, ensureKey, keyIdOf, genesis } from './state-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-config.json'), 'utf-8'));

let lockHeld = null;

function releaseLock() {
  if (lockHeld) {
    try { fs.unlinkSync(lockHeld); } catch { /* ignore */ }
    lockHeld = null;
  }
}

function fail(msg, code = 1) {
  const err = new Error(msg);
  err.exitCode = code;
  throw err;
}

function parseArgs(argv) {
  const out = { cmd: argv[2] || '', state: '', verifier: '', rest: {} };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--verifier') out.verifier = argv[++i] || '';
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      out.rest[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function lockPath(s) { return s + '.lock'; }

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

async function loadMachine(state) {
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  if (!state.machine) return { Machine, machine: new Machine() };
  return { Machine, machine: Machine.restore(state.machine) };
}

function currentAwait(machine) {
  const stage = machine[config.stageVariable];
  return config.awaits.find(a => a.stateValue === stage) || null;
}

let stateKey = null;
function save(file, state) {
  sign(state, stateKey);
  atomicWrite(file, JSON.stringify(state, null, 2));
}

/** Read the state and refuse it unless spec hash, signature and log chain check out. */
async function loadVerified(args) {
  if (!fs.existsSync(args.state)) fail('state file missing: ' + args.state);
  const state = JSON.parse(fs.readFileSync(args.state, 'utf-8'));
  if (state.specHash !== config.specHash) fail('specHash mismatch', 2);
  const { Machine, machine } = await loadMachine(state);
  const v = verifyState(state, { keyPath: keyPathFrom(args.rest.key), Machine, config });
  if (!v.ok) fail('state integrity: ' + v.reason, 2);
  for (const w of v.warnings) process.stderr.write('WARN: ' + w + '\\n');
  stateKey = v.key;
  return { state, machine };
}

async function cmdInit(stateFile, dev, keyArg) {
  if (fs.existsSync(stateFile)) fail('state already exists: ' + stateFile);
  const keyPath = keyPathFrom(keyArg);
  if (!keyPath && !dev) {
    fail('init needs a state key: --key <file> or SPECKL_STATE_KEY_FILE (created if missing; keep it unreadable by the agent). Only --dev states may be unsigned.');
  }
  stateKey = keyPath ? ensureKey(keyPath) : null;
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  const machine = new Machine();
  const state = {
    specHash: config.specHash,
    speck: config.speck,
    runId: crypto.randomBytes(16).toString('hex'),
    dev: dev === true,
    keyId: stateKey ? keyIdOf(stateKey) : null,
    log: [],
    head: null,
    machine: machine.serialize(),
    pending: null,
    appliedEvidence: [],
    usedNonces: [],
    signalLog: [],
    pendingLog: [],
    awaitingSince: null,
  };
  state.head = genesis(state);
  if (currentAwait(machine)) state.awaitingSince = new Date().toISOString();
  save(stateFile, state);
  if (state.dev) {
    process.stderr.write('WARN: DEV state: the cli verifier and unsigned drops are accepted; anyone who can run signal.mjs can approve\\n');
    if (!stateKey) process.stderr.write('WARN: DEV state is unsigned (no state key); hand edits are only caught by the log chain\\n');
  }
  process.stdout.write(JSON.stringify({ ok: true, state: stateFile, run: state.runId, dev: state.dev, signed: !!stateKey }) + '\\n');
}

async function loadVerifier(kind) {
  if (kind === 'cli') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'cli.mjs')).href));
  }
  if (kind === 'file-drop') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'file-drop.mjs')).href));
  }
  fail('unknown verifier: ' + kind + ' (shipped: cli, file-drop; others are plug-ins)');
}

function verifierCtx(state) {
  return {
    runId: state.runId,
    dev: state.dev === true,
    now: Date.now(),
    usedNonces: state.usedNonces || [],
  };
}

/** Run a verifier with the dev gate and run/nonce/replay checks. */
async function verifySignal(args, state, expect) {
  if (args.verifier === 'cli' && state.dev !== true) {
    fail('cli verifier is DEV ONLY: create the state with signal.mjs init --dev, or use a signed verifier (self-approval risk)', 2);
  }
  const ver = await loadVerifier(args.verifier);
  const result = await ver.verify(args.rest, expect, verifierCtx(state));
  if (result.ok === false) fail('verifier rejected: ' + result.reason, 2);
  const vs = result.signal;
  // Defense in depth for any verifier that binds to a run / nonce.
  if (vs.run !== undefined && vs.run !== state.runId) fail('run mismatch', 2);
  if (vs.nonce !== undefined && (state.usedNonces || []).includes(vs.nonce)) fail('nonce already used: ' + vs.nonce, 2);
  if ((state.appliedEvidence || []).includes(vs.evidence)) {
    fail('replay: evidence already applied: ' + vs.evidence, 2);
  }
  return vs;
}

function recordSignal(state, vs) {
  state.appliedEvidence = state.appliedEvidence || [];
  state.appliedEvidence.push(vs.evidence);
  if (vs.nonce !== undefined) {
    state.usedNonces = state.usedNonces || [];
    state.usedNonces.push(vs.nonce);
  }
}

async function cmdApply(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');

  await acquireLock(args.state);
  try {
    const { state, machine } = await loadVerified(args);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);

    const vs = await verifySignal(args, state, waiting);
    if (vs.signal !== waiting.signal) fail('wrong signal: expected ' + waiting.signal + ' got ' + vs.signal, 2);
    if (!waiting.outcomes.includes(vs.outcome)) fail('disallowed outcome: ' + vs.outcome, 2);
    for (const c of waiting.claims) {
      if (vs.claims[c.name] === undefined || vs.claims[c.name] === null || vs.claims[c.name] === '') {
        fail('missing claim: ' + c.name, 2);
      }
    }
    const on = waiting.on.find(o => o.outcome === vs.outcome);
    if (!on) fail('no on-transition for outcome ' + vs.outcome, 2);

    const can = machine.can(on.action, {});
    if (can !== true) fail('synthetic transition refused: ' + can, 2);
    machine[on.action]();

    append(state, { kind: 'signal', signal: vs.signal, outcome: vs.outcome, evidence: vs.evidence, nonce: vs.nonce });
    recordSignal(state, vs);
    state.signalLog.push({ ...vs, at: vs.at || new Date().toISOString() });
    state.awaitingSince = null;
    // Leave state.pending alone: an in-flight observe tool (HNTL) still owns it.
    state.machine = machine.serialize();
    save(args.state, state);
    process.stdout.write(JSON.stringify({ ok: true, outcome: vs.outcome, evidence: vs.evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdTimeout(args) {
  if (!args.state) fail('missing --state');
  await acquireLock(args.state);
  try {
    const { state, machine } = await loadVerified(args);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);
    if (!waiting.timeout) fail('no timeout configured for this await', 2);

    const outcome = waiting.timeout.outcome;
    if (!(waiting.rejects || []).includes(outcome)) {
      fail('timeout may only resolve to a !-marked reject outcome', 2);
    }
    const since = Date.parse(state.awaitingSince || '');
    if (!Number.isFinite(since)) {
      // No recorded start (e.g. the machine began in the await state): start
      // the clock now instead of firing immediately.
      state.awaitingSince = new Date().toISOString();
      save(args.state, state);
      fail('timeout clock started now; not yet elapsed', 2);
    }
    const elapsed = Date.now() - since;
    if (elapsed < waiting.timeout.durationMs) {
      fail('timeout not yet elapsed (' + elapsed + 'ms < ' + waiting.timeout.durationMs + 'ms)', 2);
    }

    const on = waiting.on.find(o => o.outcome === outcome);
    if (!on) fail('no on-transition for timeout outcome ' + outcome, 2);
    const evidence = 'timeout:' + waiting.signal + ':' + state.awaitingSince;
    if ((state.appliedEvidence || []).includes(evidence)) fail('replay', 2);

    machine[on.action]();
    append(state, { kind: 'timeout', signal: waiting.signal, outcome, evidence });
    state.appliedEvidence = state.appliedEvidence || [];
    state.appliedEvidence.push(evidence);
    state.signalLog.push({
      signal: waiting.signal,
      outcome,
      claims: {},
      verifier: 'timeout',
      subject: 'system',
      at: new Date().toISOString(),
      evidence,
    });
    state.awaitingSince = null;
    state.machine = machine.serialize();
    save(args.state, state);
    process.stdout.write(JSON.stringify({ ok: true, outcome, evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdClearPending(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');
  await acquireLock(args.state);
  try {
    const { state } = await loadVerified(args);
    if (!state.pending) fail('no pending tool call', 2);
    const expect = { signal: 'clear-pending', outcomes: ['clear'], claims: [] };
    const vs = await verifySignal(args, state, expect);
    if (vs.signal !== 'clear-pending') fail('wrong signal: expected clear-pending got ' + vs.signal, 2);
    if (vs.outcome !== 'clear') fail('disallowed outcome: ' + vs.outcome, 2);
    if (vs.callId === undefined || String(vs.callId) !== String(state.pending.call_id)) {
      fail('call_id does not match the pending call (' + state.pending.call_id + ')', 2);
    }
    append(state, { kind: 'clear', call_id: state.pending.call_id, evidence: vs.evidence, nonce: vs.nonce });
    recordSignal(state, vs);
    state.pendingLog = state.pendingLog || [];
    state.pendingLog.push({
      call_id: state.pending.call_id,
      tool: state.pending.tool,
      since: state.pending.since,
      cleared: 'signal',
      verifier: vs.verifier,
      subject: vs.subject,
      evidence: vs.evidence,
      at: new Date().toISOString(),
    });
    const cleared = state.pending.call_id;
    // Cleared as failed: the machine is not advanced.
    state.pending = null;
    save(args.state, state);
    process.stdout.write(JSON.stringify({ ok: true, cleared, evidence: vs.evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.cmd === 'init') {
      if (!args.state) fail('missing --state');
      await cmdInit(args.state, args.rest.dev === true || args.rest.dev === 'true', args.rest.key);
    } else if (args.cmd === 'apply') await cmdApply(args);
    else if (args.cmd === 'timeout') await cmdTimeout(args);
    else if (args.cmd === 'clear-pending') await cmdClearPending(args);
    else fail('usage: signal.mjs init|apply|timeout|clear-pending --state <file> ...');
  } catch (e) {
    releaseLock();
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e && typeof e.exitCode === 'number') ? e.exitCode : 1;
    process.stderr.write(msg + '\\n');
    process.exit(code);
  }
}

main();
`;
}
